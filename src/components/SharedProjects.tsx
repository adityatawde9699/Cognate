/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/components/SharedProjects.tsx (Act 3)
   The multiplayer surface: share a project (mint a capability + invite), join
   one from an invite, see the roster, grant roles, and sync. Each share is its
   own end-to-end-encrypted CRDT doc — the relay only ever sees ciphertext.
   Rendered as a section inside Settings.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { publicIdentity } from '../services/identity';
import type { Member, Role } from '../services/collab';
import type { ActivityEntry } from '../services/activity';
import {
  listShares, createShare, joinShare, syncShare, grantRole, removeMember,
  removeShare, inviteFor, getRoster, getActivity, getShare,
  planTeamForShare, applyTeamAssignments, type ShareMeta,
} from '../services/shareService';
import type { TeamPlanResult } from '../services/teamPlanService';
import { fmtClock } from '../services/planService';
import { getPresence, type Presence } from '../services/presenceService';
import { exportRecoveryKit, importRecoveryKit } from '../services/recoveryService';
import { loadAllTasks } from '../services/taskService';
import { toast } from '../utils/toast';

const ROLES: Role[] = ['viewer', 'commenter', 'editor', 'owner'];

export function SharedProjects() {
  const projects = useStore((s) => s.projects);
  const [shares, setShares] = useState<ShareMeta[]>([]);
  const [rosters, setRosters] = useState<Record<string, Member[]>>({});
  const [presence, setPresence] = useState<Record<string, Presence[]>>({});
  const [activity, setActivity] = useState<Record<string, ActivityEntry[]>>({});
  const [showFeed, setShowFeed] = useState<Record<string, boolean>>({});
  const [teamPlan, setTeamPlan] = useState<Record<string, TeamPlanResult>>({});
  const [me, setMe] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const [newProject, setNewProject] = useState('');
  const [newName, setNewName] = useState('');
  const [joinToken, setJoinToken] = useState('');
  const [recoveryPass, setRecoveryPass] = useState('');
  const [recoveryKit, setRecoveryKit] = useState('');

  const refresh = async () => {
    const list = await listShares();
    setShares(list);
    setMe((await publicIdentity()).actor);
    const r: Record<string, Member[]> = {};
    const a: Record<string, ActivityEntry[]> = {};
    const p: Record<string, Presence[]> = {};
    for (const s of list) {
      r[s.id] = await getRoster(s.id);
      a[s.id] = await getActivity(s.id, 12);
      const full = await getShare(s.id);
      if (full) p[s.id] = await getPresence(full).catch(() => []);
    }
    setRosters(r);
    setActivity(a);
    setPresence(p);
  };

  useEffect(() => { void refresh(); }, []);

  const copyInvite = async (id: string) => {
    try {
      const token = await inviteFor(id);
      await navigator.clipboard.writeText(token);
      toast('🔗 Invite copied — share it over a secure channel');
    } catch {
      toast('⚠️ Could not copy the invite');
    }
  };

  const handleCreate = async () => {
    if (!newProject) { setMsg('Pick a project to share.'); return; }
    setBusy(true); setMsg('');
    try {
      const proj = projects.find((p) => p.id === newProject);
      const { invite } = await createShare(newProject, newName.trim() || proj?.name || 'Shared project');
      await navigator.clipboard.writeText(invite).catch(() => {});
      setNewName('');
      await refresh();
      setMsg('Share created — invite copied to your clipboard. Send it to a teammate securely.');
      toast('👥 Project shared');
    } catch (e: any) {
      setMsg(e?.message || 'Could not create the share.');
    } finally { setBusy(false); }
  };

  const handleJoin = async () => {
    if (!joinToken.trim()) { setMsg('Paste an invite token to join.'); return; }
    setBusy(true); setMsg('');
    try {
      const share = await joinShare(joinToken.trim());
      const res = await syncShare(share.id);
      setJoinToken('');
      await refresh();
      await loadAllTasks('all');
      setMsg(`Joined "${share.name}" — pulled ${res.upserts} task${res.upserts === 1 ? '' : 's'}. You're a ${res.myRole}.`);
      toast('👥 Joined shared project');
    } catch (e: any) {
      setMsg(e?.message || 'Could not join — is the invite token valid?');
    } finally { setBusy(false); }
  };

  const handleSync = async (id: string) => {
    setBusy(true); setMsg('');
    try {
      const r = await syncShare(id);
      await refresh();
      await loadAllTasks('all');
      setMsg(`Synced. ${r.admitted} accepted, ${r.rejected} rejected · ${r.upserts} updated, ${r.deletes} removed.`);
    } catch (e: any) {
      setMsg(e?.message || 'Sync failed (offline or relay unreachable).');
    } finally { setBusy(false); }
  };

  const handleGrant = async (shareId: string, actor: string, role: Role) => {
    setBusy(true);
    try {
      await grantRole(shareId, actor, role);
      await syncShare(shareId).catch(() => {});
      await refresh();
      toast(`Role updated to ${role}`);
    } catch (e: any) {
      setMsg(e?.message || 'Could not update role.');
    } finally { setBusy(false); }
  };

  const handleRemoveMember = async (shareId: string, actor: string) => {
    setBusy(true);
    try {
      await removeMember(shareId, actor);
      await syncShare(shareId).catch(() => {});
      await refresh();
    } finally { setBusy(false); }
  };

  const handleLeave = async (id: string) => {
    await removeShare(id);
    await refresh();
    setMsg('Removed locally. Existing copies on other devices are unaffected.');
  };

  const handleTeamPlan = async (id: string) => {
    setBusy(true); setMsg('');
    try {
      const today = new Date().toISOString().slice(0, 10);
      const plan = await planTeamForShare(id, today);
      setTeamPlan((t) => ({ ...t, [id]: plan }));
    } catch (e: any) {
      setMsg(e?.message || 'Could not build a team plan.');
    } finally { setBusy(false); }
  };

  const handleApplyAssignments = async (id: string) => {
    const plan = teamPlan[id];
    if (!plan?.assignments.length) return;
    setBusy(true);
    try {
      await applyTeamAssignments(id, plan.assignments);
      await refresh();
      await loadAllTasks('all');
      setMsg(`Applied ${plan.assignments.length} assignment${plan.assignments.length === 1 ? '' : 's'}.`);
      toast('🤝 Workload balanced');
    } catch (e: any) {
      setMsg(e?.message || 'Could not apply assignments.');
    } finally { setBusy(false); }
  };

  const handleExportKit = async () => {
    if (!recoveryPass.trim()) { setMsg('Choose a recovery passphrase first.'); return; }
    setBusy(true);
    try {
      const kit = await exportRecoveryKit(recoveryPass);
      await navigator.clipboard.writeText(kit);
      toast('🔐 Recovery kit copied — store it safely');
      setMsg('Recovery kit copied to clipboard. Keep it somewhere safe (e.g. a password manager).');
    } catch (e: any) {
      setMsg(e?.message || 'Could not export recovery kit.');
    } finally { setBusy(false); }
  };

  const handleImportKit = async () => {
    if (!recoveryKit.trim() || !recoveryPass.trim()) { setMsg('Paste a kit and its recovery passphrase.'); return; }
    setBusy(true);
    try {
      const res = await importRecoveryKit(recoveryKit.trim(), recoveryPass);
      setRecoveryKit('');
      await refresh();
      await loadAllTasks('all');
      setMsg(`Restored ${res.shares} shared project${res.shares === 1 ? '' : 's'}${res.relay ? ' and live sync' : ''}.`);
      toast('🔐 Recovery kit restored');
    } catch (e: any) {
      setMsg(e?.message || 'Could not restore — wrong passphrase or invalid kit.');
    } finally { setBusy(false); }
  };

  const myRole = (id: string): Role =>
    (rosters[id] || []).find((m) => m.actor === me)?.role ?? shares.find((s) => s.id === id)?.role ?? 'viewer';

  const isOnline = (shareId: string, actor: string) =>
    (presence[shareId] || []).some((p) => p.actor === actor && p.online);
  const onlineCount = (shareId: string) => (presence[shareId] || []).filter((p) => p.online).length;

  return (
    <div className="settings-section">
      <h3>Shared projects <span className="opt-tag">end-to-end encrypted</span></h3>

      {/* Create */}
      <div className="form-group">
        <label>Share a project</label>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <select value={newProject} onChange={(e) => setNewProject(e.target.value)} style={{ flex: '1 1 140px' }}>
            <option value="">Choose a project…</option>
            {(projects || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input
            type="text" value={newName} placeholder="Share name (optional)"
            onChange={(e) => setNewName(e.target.value)} style={{ flex: '1 1 140px' }}
          />
          <button className="btn-soft" onClick={handleCreate} disabled={busy}>
            <i className={`fa-solid ${busy ? 'fa-spinner fa-spin' : 'fa-user-plus'}`}></i> Share
          </button>
        </div>
        <small className="form-hint">
          You become the owner. The invite contains a secret key — it grants read access, so send it over a
          secure channel. Set a relay URL under <strong>Live sync</strong> first.
        </small>
      </div>

      {/* Join */}
      <div className="form-group">
        <label>Join with an invite</label>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            type="text" value={joinToken} placeholder="Paste an invite token…"
            onChange={(e) => setJoinToken(e.target.value)} style={{ flex: 1 }}
          />
          <button className="btn-soft" onClick={handleJoin} disabled={busy}>
            <i className="fa-solid fa-right-to-bracket"></i> Join
          </button>
        </div>
      </div>

      {/* Existing shares */}
      {shares.length > 0 && (
        <div className="form-group">
          <label>Your shared projects</label>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {shares.map((s) => {
              const role = myRole(s.id);
              const isOwner = role === 'owner';
              const roster = rosters[s.id] || [];
              return (
                <li key={s.id} style={{ border: '1px solid var(--border)', borderRadius: '10px', padding: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                    <strong style={{ flex: 1 }}>{s.name}</strong>
                    {onlineCount(s.id) > 0 && (
                      <span style={{ fontSize: '.72rem', color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: 'var(--accent)', display: 'inline-block' }}></span>
                        {onlineCount(s.id)} online
                      </span>
                    )}
                    <span className="opt-tag">{role}</span>
                    <button className="btn-ghost" title="Activity" onClick={() => setShowFeed((f) => ({ ...f, [s.id]: !f[s.id] }))}>
                      <i className="fa-solid fa-clock-rotate-left"></i>
                    </button>
                    <button className="btn-ghost" title="Sync now" onClick={() => handleSync(s.id)} disabled={busy}>
                      <i className="fa-solid fa-rotate"></i>
                    </button>
                    <button className="btn-ghost" title="Copy invite" onClick={() => copyInvite(s.id)}>
                      <i className="fa-solid fa-link"></i>
                    </button>
                    <button className="btn-ghost is-danger" title="Remove locally" onClick={() => handleLeave(s.id)}>
                      <i className="fa-solid fa-xmark"></i>
                    </button>
                  </div>

                  {roster.length > 0 && (
                    <ul style={{ listStyle: 'none', padding: '8px 0 0', margin: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {roster.map((m) => (
                        <li key={m.actor} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '.8rem' }}>
                          <span
                            title={isOnline(s.id, m.actor) ? 'Online' : 'Offline'}
                            style={{ width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0, background: isOnline(s.id, m.actor) ? 'var(--accent)' : 'var(--text-d)' }}
                          ></span>
                          <span style={{ flex: 1, fontFamily: 'monospace', opacity: m.actor === me ? 1 : 0.8 }}>
                            {m.actor.slice(0, 8)}{m.actor === me ? ' (you)' : ''}
                          </span>
                          {isOwner && m.actor !== me ? (
                            <>
                              <select
                                value={m.role}
                                onChange={(e) => handleGrant(s.id, m.actor, e.target.value as Role)}
                                disabled={busy}
                              >
                                {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                              </select>
                              <button className="btn-ghost is-danger" title="Remove member" onClick={() => handleRemoveMember(s.id, m.actor)} disabled={busy}>
                                <i className="fa-solid fa-user-minus"></i>
                              </button>
                            </>
                          ) : (
                            <span className="opt-tag">{m.role}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}

                  {showFeed[s.id] && (
                    <div style={{ marginTop: '10px', borderTop: '1px solid var(--border)', paddingTop: '8px' }}>
                      <div style={{ fontSize: '.68rem', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text-d)', marginBottom: '6px' }}>Activity</div>
                      {(activity[s.id] || []).length === 0 ? (
                        <small className="form-hint">No activity yet.</small>
                      ) : (
                        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          {(activity[s.id] || []).map((e) => (
                            <li key={e.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '.78rem' }}>
                              <span style={{ color: 'var(--text-m)' }}>{e.summary}</span>
                              <span style={{ color: 'var(--text-d)', flexShrink: 0 }}>
                                {new Date(e.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  {(role === 'owner' || role === 'editor') && (
                    <div style={{ marginTop: '10px', borderTop: '1px solid var(--border)', paddingTop: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: '.68rem', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text-d)', flex: 1 }}>
                          Team plan <span className="opt-tag">today</span>
                        </span>
                        <button className="btn-soft" onClick={() => handleTeamPlan(s.id)} disabled={busy}>
                          <i className="fa-solid fa-people-arrows"></i> Balance workload
                        </button>
                      </div>

                      {teamPlan[s.id] && (
                        <div style={{ marginTop: '8px' }}>
                          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            {teamPlan[s.id].loads.map((l) => {
                              const pct = l.capacity_min > 0 ? Math.min(100, Math.round((l.scheduled_min / l.capacity_min) * 100)) : 0;
                              return (
                                <li key={l.actor} style={{ fontSize: '.78rem' }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                                    <span style={{ fontFamily: 'monospace' }}>{l.actor.slice(0, 8)}{l.actor === me ? ' (you)' : ''}</span>
                                    <span style={{ color: l.overloaded ? 'var(--danger)' : 'var(--text-d)' }}>
                                      {Math.round(l.scheduled_min / 60 * 10) / 10}h scheduled{l.unscheduled > 0 ? ` · ${l.unscheduled} won't fit` : ''}
                                    </span>
                                  </div>
                                  <div style={{ height: '6px', borderRadius: '3px', background: 'var(--surface)', overflow: 'hidden' }}>
                                    <div style={{ width: `${pct}%`, height: '100%', background: l.overloaded ? 'var(--danger)' : 'var(--accent)' }}></div>
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                          {teamPlan[s.id].assignments.length > 0 && (
                            <button className="btn-soft" style={{ marginTop: '8px' }} onClick={() => handleApplyAssignments(s.id)} disabled={busy}>
                              <i className="fa-solid fa-check"></i> Apply {teamPlan[s.id].assignments.length} assignment{teamPlan[s.id].assignments.length === 1 ? '' : 's'}
                            </button>
                          )}
                          <small className="form-hint" style={{ display: 'block', marginTop: '4px' }}>
                            Teammates use standard hours until calendar sharing lands. {fmtClock(9 * 60)}–{fmtClock(17 * 60)} default.
                          </small>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Recovery kit — escrow share secrets + relay config under a passphrase */}
      <div className="form-group">
        <label>Recovery kit</label>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <input
            type="password" value={recoveryPass} placeholder="Recovery passphrase"
            onChange={(e) => setRecoveryPass(e.target.value)} style={{ flex: '1 1 160px' }}
          />
          <button className="btn-soft" onClick={handleExportKit} disabled={busy}>
            <i className="fa-solid fa-file-shield"></i> Export
          </button>
        </div>
        <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
          <input
            type="text" value={recoveryKit} placeholder="Paste a recovery kit to restore…"
            onChange={(e) => setRecoveryKit(e.target.value)} style={{ flex: 1 }}
          />
          <button className="btn-soft" onClick={handleImportKit} disabled={busy}>
            <i className="fa-solid fa-rotate-left"></i> Restore
          </button>
        </div>
        <small className="form-hint">
          Encrypts every share secret + your relay passphrase under the recovery passphrase. The kit is
          ciphertext — safe to store in a password manager. Restore it on a new device to regain access.
        </small>
      </div>

      {msg && <small className="form-hint">{msg}</small>}
      <small className="form-hint">
        The relay stores only ciphertext. Edits are signed; only roster members with a sufficient role can write —
        unauthorized edits are dropped on every device.
      </small>
    </div>
  );
}
