/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/collab.ts — shared documents & access control (Act 3)
   ──────────────────────────────────────────────────────
   Multiplayer "falls out of the spine": a shared project is just the Act-2
   CRDT op-log, scoped to its own key + room (see crypto.ts), with two things
   layered on:

     1. AUTHENTICITY — every op is wrapped in a SignedOp {op, pub, sig}. Peers
        verify the ECDSA signature before trusting the op, so a malicious relay
        (or anyone who merely holds the read key) cannot forge or tamper.

     2. AUTHORIZATION (RBAC) — a signed, owner-gated member roster maps each
        actor to a role (viewer < commenter < editor < owner). `applyAccess
        Control` folds verified ops in causal order and admits each only if its
        signer is a bound roster member whose role permits that op. Read access
        is the key; WRITE access is the roster.

   Pure data → data (no DB / network / React), exactly like oplog.ts — so the
   security-critical logic is exhaustively unit-testable. See collab.test.ts.

   THREAT MODEL (explicit, slice 1):
     • Defended: relay tampering/forgery (signatures); read-scoping across
       projects (per-share keys); a read-key holder who is not a roster member
       writing anything (rejected — no bound member entry); a viewer/commenter
       exceeding their role (rejected by rank).
     • Out of scope (documented, not yet built): Byzantine-resistant roster
       consensus against a *malicious owner-key holder*, key rotation/forward
       secrecy, and revoking a member's ability to read data they already
       decrypted. Owners are mutually trusted (TOFU on the genesis owner).
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { hlcCompare, type Op } from './oplog';
import { importPublicKey, signBytes, verifyBytes } from './crypto';

// ── Roles ────────────────────────────────────────────────

export type Role = 'viewer' | 'commenter' | 'editor' | 'owner';
const RANK: Record<Role, number> = { viewer: 0, commenter: 1, editor: 2, owner: 3 };

export interface Member {
  actor: string; // the CRDT actor id (op.hlc.actor) this membership binds
  pub: string;   // base64 public key bound to that actor — signatures must match
  role: Role;
  // Self-declared scheduling capacity (Act 3 follow-up) — used by team planning.
  work_start_min?: number;
  work_end_min?: number;
}

/** Member fields a member may set on THEIR OWN entry without being an owner:
 *  their public key (identity) and their own working hours (self-info). Role
 *  and other members' entries always require an owner. */
const SELF_FIELDS = new Set(['pub', 'work_start', 'work_end']);

/** A signed op as it travels in a shared doc: the op, the signer's public key,
 *  and an ECDSA signature over the op's canonical bytes. */
export interface SignedOp {
  op: Op;
  pub: string;
  sig: string;
}

/** An op whose signature has been cryptographically verified against `pub`. */
export interface VerifiedOp {
  op: Op;
  pub: string;
}

// ── Canonical op bytes (security-critical) ───────────────
// A signature must verify byte-identically on every device, so the bytes we
// sign cannot depend on JS object key order or whitespace. Sort keys deeply.

const _enc = new TextEncoder();

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

/** Deterministic byte encoding of an op — the exact input to sign/verify. */
export function opBytes(op: Op): Uint8Array {
  return _enc.encode(canonical(op));
}

// ── Signing & verification ───────────────────────────────

export async function signOp(priv: CryptoKey, pub: string, op: Op): Promise<SignedOp> {
  return { op, pub, sig: await signBytes(priv, opBytes(op)) };
}
export async function signOps(priv: CryptoKey, pub: string, ops: Op[]): Promise<SignedOp[]> {
  return Promise.all(ops.map((o) => signOp(priv, pub, o)));
}

/** Verify one signed op. Returns the verified op, or null if the signature is
 *  invalid / malformed (never throws — an untrusted op is simply dropped). */
export async function verifySignedOp(s: SignedOp): Promise<VerifiedOp | null> {
  if (!s || !s.op || !s.pub || !s.sig) return null;
  try {
    const pubKey = await importPublicKey(s.pub);
    const ok = await verifyBytes(pubKey, s.sig, opBytes(s.op));
    return ok ? { op: s.op, pub: s.pub } : null;
  } catch {
    return null;
  }
}
export async function verifySignedOps(list: SignedOp[]): Promise<VerifiedOp[]> {
  const out: VerifiedOp[] = [];
  for (const s of list) {
    const v = await verifySignedOp(s);
    if (v) out.push(v);
  }
  return out;
}

// ── Capability classification ────────────────────────────
// What an op is *trying to do*, derived from the entity/field it targets, and
// the minimum role required. Entities are namespaced by prefix in a shared doc.

export const MEMBER_PREFIX = 'member:';
export const COMMENT_PREFIX = 'comment:';

export type Capability = 'admin' | 'comment' | 'assign' | 'content';

export function capabilityOf(op: Op): Capability {
  if (op.entity.startsWith(MEMBER_PREFIX)) return 'admin';
  if (op.entity.startsWith(COMMENT_PREFIX)) return 'comment';
  if (op.kind === 'set' && op.field === 'assignee') return 'assign';
  return 'content';
}

const NEED: Record<Capability, number> = {
  admin: RANK.owner,
  comment: RANK.commenter,
  assign: RANK.editor,
  content: RANK.editor,
};

// ── Roster folding + access control (pure) ───────────────

/** The actor a `member:` entity refers to — the last `:`-segment, so this works
 *  for both a bare `member:<actor>` and a share-namespaced `member:<doc>:<actor>`. */
export function memberActor(entity: string): string {
  return entity.split(':').pop() ?? '';
}

function applyMemberOp(roster: Map<string, Member>, op: Op): void {
  const actor = memberActor(op.entity);
  if (!actor) return;
  if (op.kind === 'del') {
    roster.delete(actor);
    return;
  }
  const cur: Member = roster.get(actor) ?? { actor, pub: '', role: 'viewer' };
  if (op.field === 'removed' && op.value === true) {
    roster.delete(actor);
    return;
  }
  if (op.field === 'pub' && typeof op.value === 'string') cur.pub = op.value;
  if (op.field === 'role' && isRole(op.value)) cur.role = op.value;
  if (op.field === 'work_start' && typeof op.value === 'number') cur.work_start_min = op.value;
  if (op.field === 'work_end' && typeof op.value === 'number') cur.work_end_min = op.value;
  roster.set(actor, cur);
}

function isRole(v: unknown): v is Role {
  return v === 'viewer' || v === 'commenter' || v === 'editor' || v === 'owner';
}

export interface AccessResult {
  /** Content/comment/assign ops that passed authn + authz — safe to project. */
  admitted: Op[];
  /** Everything we incorporate into our trusted log: admitted content ops PLUS
   *  the roster (member) ops we accepted. The set safe to persist & re-share. */
  accepted: Op[];
  /** The final membership roster after folding all accepted admin ops. */
  roster: Map<string, Member>;
  /** Verified-but-rejected ops (wrong role / not a member) — for an audit/UI. */
  rejected: Op[];
}

/**
 * The heart of write-side RBAC. Given signature-VERIFIED ops and the genesis
 * owner (the share creator, trusted-on-first-use because they minted the share
 * secret), fold ops in causal (HLC) order:
 *
 *   • member (admin) ops mutate the roster, but ONLY if their signer is, at
 *     that moment, a bound owner — so no one can self-promote or rewrite roles.
 *   • every other op is admitted only if its signer is a bound roster member
 *     (pub matches) whose role rank meets the op's required capability.
 *
 * Deterministic and order-independent across devices (HLC total order), so all
 * peers compute the same admitted set and the same roster.
 */
export function applyAccessControl(
  verified: VerifiedOp[],
  genesis: { actor: string; pub: string }
): AccessResult {
  const ordered = [...verified].sort(
    (a, b) => hlcCompare(a.op.hlc, b.op.hlc) || (a.op.id < b.op.id ? -1 : 1)
  );

  const roster = new Map<string, Member>();
  roster.set(genesis.actor, { actor: genesis.actor, pub: genesis.pub, role: 'owner' });

  const admitted: Op[] = [];
  const adminOps: Op[] = [];
  const rejected: Op[] = [];

  for (const { op, pub } of ordered) {
    const author = op.hlc.actor;
    const me = roster.get(author);
    const cap = capabilityOf(op);

    // Authenticity binding: the signing key must be the one the roster records
    // for this actor. (Genesis owner is seeded above.) A signer not in the
    // roster, or one presenting a different key than recorded, is untrusted.
    const bound = !!me && me.pub === pub;

    if (cap === 'admin') {
      // Two ways a roster op is accepted:
      //  1. A bound OWNER may make any roster change (add/grant/remove others).
      //  2. Anyone may announce THEIR OWN public key (target == author, value ==
      //     the key they actually signed with) — how a joiner publishes their
      //     identity so an owner can later grant them a role. They cannot set
      //     their own role or touch anyone else's entry this way.
      const ownerBound = bound && me!.role === 'owner';
      // A member may self-declare their own identity/work-hours, but never their
      // role or another member's entry. `pub` must equal the key they signed with.
      const selfClaim =
        op.kind === 'set' &&
        memberActor(op.entity) === author &&
        SELF_FIELDS.has(op.field) &&
        (op.field !== 'pub' || op.value === pub);
      if (ownerBound || selfClaim) {
        applyMemberOp(roster, op);
        adminOps.push(op);
      } else rejected.push(op);
      continue;
    }

    if (bound && RANK[me!.role] >= NEED[cap]) admitted.push(op);
    else rejected.push(op);
  }

  return { admitted, accepted: [...admitted, ...adminOps], roster, rejected };
}

/** Convenience: verify signatures then apply access control in one step. */
export async function authorize(
  signed: SignedOp[],
  genesis: { actor: string; pub: string }
): Promise<AccessResult> {
  return applyAccessControl(await verifySignedOps(signed), genesis);
}
