import { createPortal } from 'react-dom';
import { Fragment, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { logActivity } from '../lib/activityLog';
import { sendPushToUser, getMemberUserId } from '../lib/pushNotify';
import { FIN_MONTHS, iqd } from '../lib/finHelpers';
import {
  type Advance, type AdvanceDistribution,
  fetchAdvances, fetchAdvanceDistributions, distributeAdvance, deleteDistribution,
  getDistributedTotal, getHolderLeftover,
} from '../lib/advances';
import styles from './FinPages.module.css';

interface TeamMember { id: string; full_name: string; username: string; is_active: boolean | null; }

export default function MyAdvances() {
  const { currentUser } = useAuth();

  const [memberId, setMemberId] = useState<string | null>(null);
  const [memberResolved, setMemberResolved] = useState(false);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [advances, setAdvances] = useState<Advance[]>([]);
  const [dists, setDists] = useState<AdvanceDistribution[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [distAdvanceId, setDistAdvanceId] = useState<string | null>(null);
  const [distRecipient, setDistRecipient] = useState('');
  const [distAmount, setDistAmount] = useState('');
  const [distNotes, setDistNotes] = useState('');
  const [distSaving, setDistSaving] = useState(false);
  const [distErr, setDistErr] = useState<string | null>(null);

  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(msg: string) {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 3200);
  }

  // Resolve the logged-in user to a team_members row — same approach as
  // MyExpenses.tsx / MyTrips.tsx (match by username, fall back to full_name).
  useEffect(() => {
    if (!currentUser) return;
    (async () => {
      const { data } = await supabase.from('team_members').select('id, full_name, username, is_active').order('full_name');
      if (!data) { setLoading(false); setMemberResolved(true); return; }
      setTeam((data as TeamMember[]).filter(m => m.is_active !== false));
      const name = (currentUser?.full_name || '').trim().toLowerCase();
      const uname = (currentUser?.username || '').trim().toLowerCase();
      const match = (data as TeamMember[]).find(m =>
        (name && m.full_name?.trim().toLowerCase() === name) ||
        (uname && m.username?.trim().toLowerCase() === uname),
      );
      setMemberId(match?.id ?? null);
      setMemberResolved(true);
    })();
  }, [currentUser]);

  useEffect(() => {
    if (!memberResolved) return;
    if (!memberId) { setLoading(false); return; }
    loadData();
  }, [memberResolved, memberId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadData() {
    setLoading(true); setLoadError(null);
    try {
      const [advRes, distRes] = await Promise.all([fetchAdvances(), fetchAdvanceDistributions()]);
      setAdvances(advRes);
      setDists(distRes);
    } catch (e: unknown) { setLoadError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }

  if (!memberResolved || loading) {
    return <div className={styles.page}><div className={styles.loadingBar}>Loading…</div></div>;
  }
  if (!memberId) {
    return <div className={styles.page}><div className={styles.placeholder}>No matching team member profile found.</div></div>;
  }
  if (loadError) {
    return <div className={styles.page}><div className={styles.errorMsg}>{loadError}</div></div>;
  }

  const myAdvances = advances.filter(a => a.holder_member_id === memberId && a.status !== 'cancelled');
  const received = dists.filter(d => d.recipient_member_id === memberId);
  const recipientOptions = team.filter(t => t.id !== memberId);

  function openDistribute(advanceId: string) {
    setDistAdvanceId(advanceId); setDistRecipient(''); setDistAmount(''); setDistNotes(''); setDistErr(null);
  }

  async function submitDistribute() {
    setDistErr(null);
    const advance = advances.find(a => a.id === distAdvanceId);
    if (!advance) return;
    const recipient = team.find(t => t.id === distRecipient);
    const amt = +distAmount;
    const leftover = getHolderLeftover(advance, dists);
    if (!distRecipient) { setDistErr('Choose a teammate to give this to.'); return; }
    if (!amt || amt <= 0) { setDistErr('Enter a valid amount.'); return; }
    if (amt > leftover) { setDistErr(`Amount can't exceed the undistributed balance (${iqd(leftover)}).`); return; }

    setDistSaving(true);
    try {
      await distributeAdvance(advance.id, distRecipient, recipient?.full_name || '', amt, distNotes);
      showToast('Distributed');
      logActivity({
        userFullName: currentUser?.full_name ?? currentUser?.username,
        action: 'Distributed Salary Advance',
        details: `${currentUser?.full_name || 'Employee'} gave ${iqd(amt)} of their advance to ${recipient?.full_name || ''} (settles ${FIN_MONTHS[advance.settlement_month - 1]} ${advance.settlement_year})`,
      });
      const recipientUserId = await getMemberUserId(recipient?.full_name);
      if (recipientUserId) {
        void sendPushToUser(recipientUserId, 'Salary Advance Assigned', `${currentUser?.full_name || 'A teammate'} gave you ${iqd(amt)} — it will be deducted from your next payslip.`);
      }
      setDistAdvanceId(null);
      await loadData();
    } catch (e: unknown) { setDistErr(e instanceof Error ? e.message : String(e)); }
    finally { setDistSaving(false); }
  }

  async function undoDistribution(id: string) {
    try {
      await deleteDistribution(id);
      showToast('Removed');
      await loadData();
    } catch (e: unknown) { showToast('Error: ' + (e instanceof Error ? e.message : String(e))); }
  }

  const distAdvance = distAdvanceId ? advances.find(a => a.id === distAdvanceId) : null;
  const distLeftover = distAdvance ? getHolderLeftover(distAdvance, dists) : 0;

  return (
    <div className={styles.page}>
      <h1 style={{ fontSize: 17, fontWeight: 800, color: '#1e293b', margin: '0 0 16px' }}>My Advances</h1>

      {/* ── Advances I hold ─────────────────────────────────────────── */}
      <div className={styles.tableWrap} style={{ marginBottom: 24 }}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Date Given</th><th className={styles.num}>Amount</th>
              <th>Settlement Period</th>
              <th className={styles.num}>Distributed</th><th className={styles.num}>Your Leftover</th>
              <th>Status</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {myAdvances.length === 0
              ? <tr><td colSpan={7} className={styles.empty}>You haven't been given any advances.</td></tr>
              : myAdvances.map(a => {
                const distributed = getDistributedTotal(a.id, dists);
                const leftover = getHolderLeftover(a, dists);
                const myDists = dists.filter(d => d.advance_id === a.id);
                const badgeClass = a.status === 'pending' ? styles.badgeAmber : styles.badgeGreen;
                return (
                  <Fragment key={a.id}>
                    <tr>
                      <td style={{ whiteSpace: 'nowrap' }}>{a.date_given || ''}</td>
                      <td className={styles.num}>{iqd(a.amount)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{FIN_MONTHS[a.settlement_month - 1]} {a.settlement_year}</td>
                      <td className={styles.num} style={{ color: '#16a34a' }}>{iqd(distributed)}</td>
                      <td className={styles.num} style={{ color: leftover > 0 ? '#dc2626' : undefined }}>{iqd(leftover)}</td>
                      <td><span className={`${styles.badge} ${badgeClass}`}>{a.status}</span></td>
                      <td>
                        {a.status === 'pending' && leftover > 0 && (
                          <button className={styles.btnGhost2} style={{ height: 28, padding: '0 10px', fontSize: 12 }} onClick={() => openDistribute(a.id)}>
                            Give to teammate
                          </button>
                        )}
                      </td>
                    </tr>
                    {myDists.length > 0 && (
                      <tr>
                        <td colSpan={7} style={{ background: '#f8fafc', padding: '8px 14px 12px' }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>
                            Given to teammates
                          </div>
                          {myDists.map(d => (
                            <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, padding: '3px 0' }}>
                              <span style={{ flex: 1 }}>{d.recipient_member_name}</span>
                              <span style={{ fontWeight: 700 }}>{iqd(d.amount)}</span>
                              {a.status === 'pending' && (
                                <button className={styles.btnGhost2} style={{ height: 24, padding: '0 8px', fontSize: 11 }} onClick={() => undoDistribution(d.id)}>Undo</button>
                              )}
                            </div>
                          ))}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            }
          </tbody>
        </table>
      </div>

      {/* ── Portions I've received from teammates ──────────────────── */}
      {received.length > 0 && (
        <>
          <h2 style={{ fontSize: 13, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.4px', margin: '0 0 10px' }}>
            Received from teammates
          </h2>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr><th>From</th><th className={styles.num}>Amount</th><th>Deducted On</th></tr>
              </thead>
              <tbody>
                {received.map(d => {
                  const parent = advances.find(a => a.id === d.advance_id);
                  return (
                    <tr key={d.id}>
                      <td>{parent?.holder_member_name || '—'}</td>
                      <td className={styles.num} style={{ color: '#dc2626' }}>−{iqd(d.amount)}</td>
                      <td>{parent ? `${FIN_MONTHS[parent.settlement_month - 1]} ${parent.settlement_year}` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Distribute modal */}
      {distAdvanceId && distAdvance && createPortal(
        <div className={styles.overlay} onClick={() => !distSaving && setDistAdvanceId(null)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalTitle}>Give a Portion to a Teammate</div>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
              Undistributed balance: <strong>{iqd(distLeftover)}</strong> — this will be deducted from your own payslip unless you give it out.
            </div>
            {distErr && <div className={styles.modalErr}>{distErr}</div>}
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Teammate</label>
              <select className={styles.formSel} value={distRecipient} onChange={e => setDistRecipient(e.target.value)}>
                <option value="">— Select teammate —</option>
                {recipientOptions.map(t => <option key={t.id} value={t.id}>{t.full_name}</option>)}
              </select>
            </div>
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Amount (IQD)</label>
              <input type="number" min={0} max={distLeftover} className={styles.formInput} value={distAmount}
                onChange={e => setDistAmount(e.target.value)} />
            </div>
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Notes</label>
              <textarea className={styles.formTextarea} rows={2} value={distNotes} onChange={e => setDistNotes(e.target.value)} />
            </div>
            <div className={styles.modalActions}>
              <button className={styles.btnPrimary} disabled={distSaving} onClick={submitDistribute}>
                {distSaving ? 'Saving…' : 'Give Amount'}
              </button>
              <button className={styles.btnGhost2} disabled={distSaving} onClick={() => setDistAdvanceId(null)}>Cancel</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {toastMsg && createPortal(<div className={styles.toast}>{toastMsg}</div>, document.body)}
    </div>
  );
}
