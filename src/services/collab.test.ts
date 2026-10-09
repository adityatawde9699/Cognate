import { describe, it, expect } from 'vitest';
import { Clock, setOp, delOp, hlcCompare, type Op, type HLC } from './oplog';
import { generateSigningKeypair, exportPublicKey } from './crypto';
import {
  opBytes,
  signOp,
  signOps,
  verifySignedOp,
  verifySignedOps,
  capabilityOf,
  authorize,
  type SignedOp,
} from './collab';

/** Highest HLC among a batch of signed ops — what a downstream actor "receives". */
function lastHlc(ops: SignedOp[]): HLC {
  return ops.reduce((m, s) => (hlcCompare(s.op.hlc, m) > 0 ? s.op.hlc : m), ops[0].op.hlc);
}

/** A self-contained signing actor: a CRDT clock + an ECDSA identity. */
async function makeActor(id: string) {
  const kp = await generateSigningKeypair();
  const pub = await exportPublicKey(kp.publicKey);
  const clock = new Clock(id, 1_000);
  return {
    id,
    pub,
    genesis: { actor: id, pub },
    content: (entity: string, field: string, value: any) => setOp(clock, entity, field, value),
    del: (entity: string) => delOp(clock, entity),
    /** Model causal delivery: fold in a remote HLC so our next ops are after it. */
    recv: (ops: SignedOp[]) => clock.receive(lastHlc(ops)),
    sign: (op: Op) => signOp(kp.privateKey, pub, op),
    signMany: (ops: Op[]) => signOps(kp.privateKey, pub, ops),
  };
}

describe('collab — op signing & authenticity', () => {
  it('round-trips sign → verify', async () => {
    const a = await makeActor('A');
    const s = await a.sign(a.content('task1', 'title', 'hello'));
    expect(await verifySignedOp(s)).toEqual({ op: s.op, pub: a.pub });
  });

  it('rejects a signature made by a different key (forgery)', async () => {
    const a = await makeActor('A');
    const b = await makeActor('B');
    const s = await a.sign(a.content('task1', 'title', 'x'));
    const forged: SignedOp = { ...s, pub: b.pub }; // claim B's key for A's signature
    expect(await verifySignedOp(forged)).toBeNull();
  });

  it('rejects an op tampered with after signing', async () => {
    const a = await makeActor('A');
    const s = await a.sign(a.content('task1', 'title', 'original'));
    const tampered: SignedOp = { ...s, op: { ...(s.op as any), value: 'malicious' } };
    expect(await verifySignedOp(tampered)).toBeNull();
  });

  it('canonical bytes are independent of object key order', async () => {
    const a = await makeActor('A');
    const op = a.content('task1', 'tags', { z: 1, a: 2 }) as any;
    const reordered = { value: op.value, field: op.field, entity: op.entity, kind: op.kind, hlc: op.hlc, id: op.id };
    expect(opBytes(op)).toEqual(opBytes(reordered as Op));
  });

  it('drops only the bad ops in a mixed batch', async () => {
    const a = await makeActor('A');
    const good = await a.sign(a.content('t', 'title', 'ok'));
    const bad: SignedOp = { ...good, sig: good.sig.slice(0, -2) + 'AA' };
    const verified = await verifySignedOps([good, bad]);
    expect(verified.map((v) => v.op.id)).toEqual([good.op.id]);
  });
});

describe('collab — capability classification', () => {
  it('maps entities/fields to capabilities', async () => {
    const a = await makeActor('A');
    expect(capabilityOf(a.content('member:B', 'role', 'editor'))).toBe('admin');
    expect(capabilityOf(a.content('comment:c1', 'body', 'hi'))).toBe('comment');
    expect(capabilityOf(a.content('task1', 'assignee', 'B'))).toBe('assign');
    expect(capabilityOf(a.content('task1', 'title', 'x'))).toBe('content');
  });
});

describe('collab — RBAC access control', () => {
  it('admits the genesis owner’s content', async () => {
    const owner = await makeActor('owner');
    const signed = await owner.signMany([
      owner.content('t1', 'title', 'spec'),
      owner.content('t1', 'assignee', 'owner'),
    ]);
    const res = await authorize(signed, owner.genesis);
    expect(res.admitted).toHaveLength(2);
    expect(res.rejected).toHaveLength(0);
    expect(res.roster.get('owner')?.role).toBe('owner');
  });

  it('rejects writes from a signer who is not in the roster (has key, not membership)', async () => {
    const owner = await makeActor('owner');
    const intruder = await makeActor('intruder'); // could decrypt, but never invited
    const signed = await intruder.signMany([intruder.content('t1', 'title', 'pwned')]);
    const res = await authorize(signed, owner.genesis);
    expect(res.admitted).toHaveLength(0);
    expect(res.rejected).toHaveLength(1);
  });

  it('an owner can invite an editor, whose edits are then admitted', async () => {
    const owner = await makeActor('owner');
    const bob = await makeActor('bob');

    const ownerOps = await owner.signMany([
      owner.content(`member:${bob.id}`, 'pub', bob.pub),
      owner.content(`member:${bob.id}`, 'role', 'editor'),
    ]);
    bob.recv(ownerOps); // bob receives the doc (incl. his invite) before editing
    const bobOps = await bob.signMany([bob.content('t1', 'title', 'bob was here')]);

    const res = await authorize([...ownerOps, ...bobOps], owner.genesis);
    expect(res.roster.get('bob')).toMatchObject({ role: 'editor', pub: bob.pub });
    expect(res.admitted.map((o) => (o as any).value)).toContain('bob was here');
  });

  it('a non-owner cannot modify the roster (no self-promotion)', async () => {
    const owner = await makeActor('owner');
    const mallory = await makeActor('mallory');

    // Owner invites mallory as a mere viewer.
    const invite = await owner.signMany([
      owner.content(`member:${mallory.id}`, 'pub', mallory.pub),
      owner.content(`member:${mallory.id}`, 'role', 'viewer'),
    ]);
    mallory.recv(invite);
    // Mallory tries to promote herself to owner AND write content.
    const escalate = await mallory.signMany([
      mallory.content(`member:${mallory.id}`, 'role', 'owner'),
      mallory.content('t1', 'title', 'hijacked'),
    ]);

    const res = await authorize([...invite, ...escalate], owner.genesis);
    expect(res.roster.get('mallory')?.role).toBe('viewer'); // promotion ignored
    expect(res.admitted.map((o) => (o as any).value)).not.toContain('hijacked');
  });

  it('enforces the role hierarchy: viewer<commenter<editor', async () => {
    const owner = await makeActor('owner');
    const carol = await makeActor('carol'); // commenter

    const invite = await owner.signMany([
      owner.content(`member:${carol.id}`, 'pub', carol.pub),
      owner.content(`member:${carol.id}`, 'role', 'commenter'),
    ]);
    carol.recv(invite);
    const carolOps = await carol.signMany([
      carol.content('comment:c1', 'body', 'looks good'), // allowed (commenter)
      carol.content('t1', 'title', 'no'),                // denied (needs editor)
      carol.content('t1', 'assignee', 'carol'),          // denied (needs editor)
    ]);

    const res = await authorize([...invite, ...carolOps], owner.genesis);
    const admittedFields = res.admitted.map((o) => (o as any).entity);
    expect(admittedFields).toContain('comment:c1');
    expect(admittedFields).not.toContain('t1');
    expect(res.rejected).toHaveLength(2);
  });

  it('an owner can remove a member, revoking write access for later ops', async () => {
    const owner = await makeActor('owner');
    const dave = await makeActor('dave');

    const invite = await owner.signMany([
      owner.content(`member:${dave.id}`, 'pub', dave.pub),
      owner.content(`member:${dave.id}`, 'role', 'editor'),
    ]);
    dave.recv(invite);
    const daveEarly = await dave.signMany([dave.content('t1', 'title', 'early')]);
    // Owner observes dave's edit, then removes him (a strictly later HLC).
    owner.recv(daveEarly);
    const remove = await owner.signMany([owner.del(`member:${dave.id}`)]);
    dave.recv(remove);
    const daveLate = await dave.signMany([dave.content('t2', 'title', 'late')]);

    const res = await authorize([...invite, ...daveEarly, ...remove, ...daveLate], owner.genesis);
    const titles = res.admitted.filter((o) => (o as any).field === 'title').map((o) => (o as any).value);
    expect(titles).toContain('early'); // before removal
    expect(titles).not.toContain('late'); // after removal
    expect(res.roster.has('dave')).toBe(false);
  });

  it('lets a member self-declare work hours but never self-promote', async () => {
    const owner = await makeActor('owner');
    const bob = await makeActor('bob');
    const invite = await owner.signMany([
      owner.content(`member:${bob.id}`, 'pub', bob.pub),
      owner.content(`member:${bob.id}`, 'role', 'editor'),
    ]);
    bob.recv(invite);
    const bobOps = await bob.signMany([
      bob.content(`member:${bob.id}`, 'work_start', 600), // self-declared — allowed
      bob.content(`member:${bob.id}`, 'role', 'owner'),   // self-promotion — ignored
    ]);
    const res = await authorize([...invite, ...bobOps], owner.genesis);
    expect(res.roster.get('bob')?.work_start_min).toBe(600);
    expect(res.roster.get('bob')?.role).toBe('editor');
  });

  it('is deterministic regardless of op delivery order', async () => {
    const owner = await makeActor('owner');
    const eve = await makeActor('eve');
    const invite = await owner.signMany([
      owner.content(`member:${eve.id}`, 'pub', eve.pub),
      owner.content(`member:${eve.id}`, 'role', 'editor'),
    ]);
    eve.recv(invite);
    const eveOps = await eve.signMany([
      eve.content('t1', 'title', 'a'),
      eve.content('t2', 'title', 'b'),
    ]);
    const all = [...invite, ...eveOps];
    const inOrder = await authorize(all, owner.genesis);
    const shuffled = await authorize([...all].reverse(), owner.genesis);

    const ids = (r: typeof inOrder) => r.admitted.map((o) => o.id).sort();
    expect(ids(shuffled)).toEqual(ids(inOrder));
    expect([...shuffled.roster.keys()].sort()).toEqual([...inOrder.roster.keys()].sort());
  });
});

it('rejects cross-project and foreign roster writes even when signed by an owner',async()=>{
  const owner=await makeActor('owner');
  const ops=await owner.signMany([
    owner.content('other-task','title','attacked'),
    owner.content('other-task','project_id','project'),
    owner.content('project:other','name','attacked'),
    owner.content('member:foreign:editor','role','owner'),
    owner.content('allowed','title','valid'),
  ]);
  const result=await authorize(ops,owner.genesis,{shareId:'share',projectId:'project',taskIds:new Set(['allowed']),forbiddenTaskIds:new Set(['other-task'])});
  expect(result.accepted.map(op=>op.entity)).toEqual(['allowed']);
  expect(result.rejected).toHaveLength(4);
});
it('does not let another key self-claim an already bound actor',async()=>{
  const owner=await makeActor('owner');const attacker=await makeActor('owner');
  const result=await authorize([await attacker.sign(attacker.content('member:owner','pub',attacker.pub))],owner.genesis);
  expect(result.accepted).toHaveLength(0);
  expect(result.roster.get('owner')?.pub).toBe(owner.pub);
});

it('admits availability only from the bound member, even when another signer is owner',async()=>{
 const owner=await makeActor('owner'),bob=await makeActor('bob'),impostor=await makeActor('bob');
 const invite=await owner.signMany([owner.content('member:bob','pub',bob.pub),owner.content('member:bob','role','editor')]);
 bob.recv(invite);impostor.recv(invite);owner.recv(invite);
 const availability={version:1,date:'2026-10-09',published_at:'2026-10-09T12:00:00Z',work_start_min:540,work_end_min:1020,busy:[]};
 const valid=await bob.sign(bob.content('member:bob','availability',availability));
 impostor.recv([valid]);
 const forged=await impostor.sign(impostor.content('member:bob','availability',availability));
 const onBehalf=await owner.sign(owner.content('member:bob','availability',availability));
 bob.recv([forged]);
 const malformed=await bob.sign(bob.content('member:bob','availability',{...availability,busy:[{start_min:600,end_min:540}]}));
 const result=await authorize([...invite,valid,forged,onBehalf,malformed],owner.genesis);
 expect(result.rejected.map(o=>o.id)).toEqual(expect.arrayContaining([forged.op.id,onBehalf.op.id,malformed.op.id]));
 expect(result.accepted.map(o=>o.id)).toContain(valid.op.id);
});
