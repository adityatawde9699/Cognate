import crypto from 'node:crypto';

/** Test relay with three independently switchable client stores. */
export class FakeBatchRelay {
  rooms = new Map<string, Map<string, any>>();
  roomMeta = new Map<string, { delete_token_hash?: string; soft_deleted_at?: number; frozen_at?: number }>();
  failBefore = false;
  loseAcknowledgement = false;
  uploads: string[] = [];

  handle(method: string, url: string, body?: string) {
    const parsed = new URL(url), parts = parsed.pathname.split('/').filter(Boolean), room = parts[2];
    const response = (status: number, value: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(value),
    });
    if (parts[0] !== 'v2') return response(404, { error: 'not found' });
    if (parts[1] === 'capabilities' && method === 'GET') {
      return response(200, {
        ok: true,
        protocol: 2,
        relay_version: '0.2.0',
        delete_supported: true,
        claim_supported: true,
        freeze_supported: true,
        max_body: 1048576,
        room_quota: 8388608,
        max_store: 33554432,
      });
    }

    if (!this.rooms.has(room)) this.rooms.set(room, new Map());
    if (!this.roomMeta.has(room)) this.roomMeta.set(room, {});
    const records = this.rooms.get(room)!;
    const meta = this.roomMeta.get(room)!;

    // Wire rules for token endpoints
    if (['delete', 'undelete', 'claim', 'freeze'].includes(parts[3])) {
      if (method !== 'POST') return response(405, { error: 'method not allowed; use POST' });
      if (parsed.search) return response(400, { error: 'query parameters not allowed' });
    }

    if (parts[3] === 'claim') {
      const parsedBody = body ? JSON.parse(body) : {};
      const hash = parsedBody.delete_token_hash;
      if (!hash || typeof hash !== 'string' || hash.length !== 64) {
        return response(400, { error: 'invalid delete_token_hash' });
      }
      if (meta.delete_token_hash) {
        return response(409, { error: 'room already claimed' });
      }
      meta.delete_token_hash = hash.toLowerCase();
      return response(200, { claimed: true, room });
    }

    if (parts[3] === 'freeze') {
      const parsedBody = body ? JSON.parse(body) : {};
      const token = parsedBody.delete_token || '';
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      if (!meta.delete_token_hash || meta.delete_token_hash !== tokenHash) {
        return response(403, { error: 'unauthorized' });
      }
      meta.frozen_at = Date.now();
      return response(200, { frozen: true, frozen_at: meta.frozen_at });
    }

    // Check soft delete status
    if (parts[3] === 'delete') {
      const parsedBody = body ? JSON.parse(body) : {};
      const token = parsedBody.delete_token || '';
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      if (!meta.delete_token_hash || meta.delete_token_hash !== tokenHash) {
        return response(403, { error: 'unauthorized' });
      }
      meta.soft_deleted_at = Date.now();
      return response(200, { soft_deleted: true, purge_after_seconds: 604800 });
    }

    if (parts[3] === 'undelete') {
      const parsedBody = body ? JSON.parse(body) : {};
      const token = parsedBody.delete_token || '';
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      if (!meta.delete_token_hash || meta.delete_token_hash !== tokenHash) {
        return response(403, { error: 'unauthorized' });
      }
      delete meta.soft_deleted_at;
      return response(200, { soft_deleted: false, undeleted: true });
    }

    if (meta.soft_deleted_at) {
      return response(410, { error: 'room is soft-deleted' });
    }

    if (method === 'PUT') {
      if (meta.frozen_at) {
        return response(409, { error: 'room is frozen' });
      }
      this.uploads.push(body!);
      if (this.failBefore) return response(503, {});
      const delHash = parsed.searchParams.get('delete_token_hash');
      if (delHash && !meta.delete_token_hash) {
        meta.delete_token_hash = delHash;
      }
      const id = parts[4], blob = JSON.parse(body!);
      if (records.has(id) && (records.get(id).ct !== blob.ct || records.get(id).nonce !== blob.nonce)) return response(409, {});
      if (!records.has(id)) records.set(id, { ...blob, batch_id: id, cursor: records.size + 1 });
      if (this.loseAcknowledgement) {
        this.loseAcknowledgement = false;
        throw new Error('connection lost after durable write');
      }
      return response(200, { batch_id: id, cursor: records.get(id).cursor, durable: true });
    }

    if (parts[3] === 'version' || parts[3] === 'poll') return response(200, { version: records.size });
    const after = Number(parsed.searchParams.get('after') ?? 0), batches = [...records.values()].filter(r => r.cursor > after).slice(0, 200);
    return response(200, { batches, cursor: batches[batches.length - 1]?.cursor ?? after });
  }
}

export class DeviceStorage {
  data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, String(value)); }
  removeItem(key: string) { this.data.delete(key); }
  clear() { this.data.clear(); }
}
