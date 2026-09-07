import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { logActivity } from '../lib/activityLog';
import { sendPushToRoles } from '../lib/pushNotify';
import { FIN_MONTHS, iqd, getYears } from '../lib/finHelpers';
import {
  type Advance, type AdvanceDistribution, type AdvanceFormInput,
  fetchAdvances, fetchAdvanceDistributions, createAdvance, updateAdvance,
  deleteAdvance, setAdvanceStatus, getDistributedTotal, getHolderLeftover,
} from '../lib/advances';
import styles from './FinPages.module.css';

interface TeamMember {
  id: string;
  full_name: string;
  role: string | null;
  is_active: boolean | null;
}

interface FormState {
  holderId: string;
  amount: string;
  dateGiven: string;
  settlementMonth: number;
  settlementYear: number;
  reason: string;
  notes: string;
}

function emptyForm(): FormState {
  const now = new Date();
  // Default settlement period is next month — matches "deducted on the
  // holder's/recipients' next payslip" from the business rule.
  let m = now.getMonth() + 2;
  let y = now.getFullYear();
  if (m > 12) { m = 1; y += 1; }
  return {
    holderId: '', amount: '', dateGiven: now.toISOString().slice(0, 10),
    settlementMonth: m, settlementYear: y,
    reason: '', notes: '',
  };
}

export default function Advances() {
  const { hasPerm, currentUser } = useAuth();

  const [team, setTeam] = useState<TeamMember[]>([]);
  const [rows, setRows] = useState<Advance[]>([]);
  const [dists, setDists] = useState<AdvanceDistribution[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [fStatus, setFStatus] = useState('');
  const [fMember, setFMember] = useState('');

  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [modalOpen, setModalOpen] = useState(false);
  const [modalSaving, setModalSaving] = useState(false);
  const [modalErr, setModalErr] = useState<string | null>(null);

  const [delId, setDelId] = useState<string | null>(null);
  const [delMsg, setDelMsg] = useState('');
  const [delSaving, setDelSaving] = useState(false);

  const [detailId, setDetailId] = useState<string | null>(null);

  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(msg: string) {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 3200);
  }

  useEffect(() => {
    if (hasPerm('view_fin_advances')) loadData();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!hasPerm('view_fin_advances')) {
    return <div className={styles.placeholder}>You don't have permission to view Advances.</div>;
  }

  async function loadData() {
    setLoading(true); setLoadError(null);
    try {
      const [teamRes, advRes, distRes] = await Promise.all([
        supabase.from('team_members').select('id,full_name,role,is_active').order('full_name'),
        fetchAdvances(),
        fetchAdvanceDistributions(),
      ]);
      if (teamRes.error) throw teamRes.error;
      setTeam((teamRes.data as TeamMember[]) || []);
      setRows(advRes);
      setDists(distRes);
    } catch (e: unknown) { setLoadError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }

  function filteredRows(): Advance[] {
    return rows.filter(r =>
      (!fStatus || r.status === fStatus) &&
      (!fMember || r.holder_member_id === fMember)
    );
  }

  function openModal(id: string | null) {
    setEditId(id); setModalErr(null);
    if (id) {
      const r = rows.find(x => x.id === id);
      if (!r) return;
      setForm({
        holderId: r.holder_member_id, amount: String(r.amount ?? ''), dateGiven: r.date_given || '',
        settlementMonth: r.settlement_month, settlementYear: r.settlement_year,
        reason: r.reason || '', notes: r.notes || '',
      });
    } else {
      setForm(emptyForm());
    }
    setModalOpen(true);
  }

  async function saveModal() {
    setModalErr(null);
    const holder = team.find(t => t.id === form.holderId);
    const amt = +form.amount;
    if (!form.holderId) { setModalErr('Holder is required.'); return; }
    if (!amt || amt <= 0) { setModalErr('Valid amount required.'); return; }

    const input: AdvanceFormInput = {
      holder_member_id: form.holderId,
      holder_member_name: holder?.full_name || '',
      amount: amt,
      date_given: form.dateGiven,
      settlement_month: form.settlementMonth,
      settlement_year: form.settlementYear,
      reason: form.reason,
      notes: form.notes,
      added_by: currentUser?.full_name || currentUser?.username || '',
    };

    setModalSaving(true);
    try {
      if (editId) {
        await updateAdvance(editId, input);
        showToast('Updated');
        logActivity({
          userFullName: currentUser?.full_name ?? currentUser?.username,
          action: 'Edited Salary Advance',
          details: `Edited advance for ${input.holder_member_name}: ${iqd(amt)}`,
        });
      } else {
        await createAdvance(input);
        showToast('Added');
        void sendPushToRoles(['admin'], 'Salary Advance Added', `New advance for ${input.holder_member_name}: ${iqd(amt)}`);
        logActivity({
          userFullName: currentUser?.full_name ?? currentUser?.username,
          action: 'Added Salary Advance',
          details: `Added advance for ${input.holder_member_name}: ${iqd(amt)}, settling ${FIN_MONTHS[input.settlement_month - 1]} ${input.settlement_year}`,
        });
      }
      setModalOpen(false);
      await loadData();
    } catch (e: unknown) { setModalErr(e instanceof Error ? e.message : String(e)); }
    finally { setModalSaving(false); }
  }

  function openDelModal(id: string) {
    const r = rows.find(x => x.id === id);
    setDelMsg(r ? `Delete the ${iqd(r.amount)} advance for "${r.holder_member_name}"? This also removes any portions they've distributed to teammates.` : 'Delete this advance?');
    setDelId(id);
  }

  async function confirmDelete() {
    if (!delId) return;
    setDelSaving(true);
    const r = rows.find(x => x.id === delId);
    try {
      await deleteAdvance(delId);
      setDelId(null);
      showToast('Deleted');
      logActivity({
        userFullName: currentUser?.full_name ?? currentUser?.username,
        action: 'Deleted Salary Advance',
        details: `Deleted advance for ${r?.holder_member_name || ''}: ${iqd(r?.amount)}`,
      });
      await loadData();
    } catch (e: unknown) { showToast('Error: ' + (e instanceof Error ? e.message : String(e))); }
    finally { setDelSaving(false); }
  }

  async function handleSetStatus(id: string, status: Advance['status']) {
    try {
      await setAdvanceStatus(id, status);
      setRows(prev => prev.map(r => r.id === id ? { ...r, status } : r));
      showToast(status === 'cancelled' ? 'Advance cancelled' : 'Marked settled');
    } catch (e: unknown) { showToast('Error: ' + (e instanceof Error ? e.message : String(e))); }
  }

  async function handleExport() {
    const data = filteredRows();
    if (!data.length) { showToast('No data to export'); return; }
    try {
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('advances');
      ws.addRow(['Holder', 'Amount (IQD)', 'Date Given', 'Settlement Period', 'Distributed (IQD)', 'Leftover to Holder (IQD)', 'Status', 'Reason', 'Notes', 'Added By']);
      for (const r of data) {
        const distributed = getDistributedTotal(r.id, dists);
        const leftover = getHolderLeftover(r, dists);
        ws.addRow([
          r.holder_member_name, r.amount, r.date_given,
          `${FIN_MONTHS[r.settlement_month - 1]} ${r.settlement_year}`,
          distributed, leftover, r.status, r.reason, r.notes, r.added_by,
        ]);
      }
      const buf = await wb.xlsx.writeBuffer();
      const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      Object.assign(document.createElement('a'), { href: url, download: `Finance_advances_${new Date().toISOString().slice(0, 10)}.xlsx` }).click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) { showToast('Export failed: ' + (e instanceof Error ? e.message : String(e))); }
  }

  const filtered = filteredRows();
  const pendingRows = rows.filter(r => r.status === 'pending');
  const totalGiven = rows.reduce((s, r) => s + (+r.amount || 0), 0);
  const totalDistributed = pendingRows.reduce((s, r) => s + getDistributedTotal(r.id, dists), 0);
  const totalLeftover = pendingRows.reduce((s, r) => s + getHolderLeftover(r, dists), 0);
  const years = getYears();
  const detailAdvance = detailId ? rows.find(r => r.id === detailId) : null;
  const detailDists = detailId ? dists.filter(d => d.advance_id === detailId) : [];

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <select className={styles.sel} value={fStatus} onChange={e => setFStatus(e.target.value)}>
          <option value="">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="settled">Settled</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <select className={styles.sel} value={fMember} onChange={e => setFMember(e.target.value)}>
          <option value="">All Holders</option>
          {team.map(t => <option key={t.id} value={t.id}>{t.full_name}</option>)}
        </select>
        <div className={styles.spacer} />
        <button className={styles.btnGhost} onClick={() => loadData()}>↺ Refresh</button>
        {hasPerm('fin_advances_export') && (
          <button className={styles.btnGhost} onClick={handleExport}>Export</button>
        )}
        {hasPerm('fin_advances_add') && (
          <button className={styles.btnAccent} onClick={() => openModal(null)}>+ Add Advance</button>
        )}
      </div>

      {loading && <div className={styles.loadingBar}>Loading…</div>}
      {loadError && <div className={styles.errorMsg}>{loadError}</div>}

      {!loading && !loadError && (
        <>
          <div className={styles.kpiRow}>
            <div className={styles.kpiCard}>
              <div className={styles.kpiLabel}>Pending Advances</div>
              <div className={styles.kpiValue}>{pendingRows.length}</div>
              <div className={styles.kpiSub}>awaiting settlement</div>
            </div>
            <div className={styles.kpiCard}>
              <div className={styles.kpiLabel}>Total Given</div>
              <div className={`${styles.kpiValue} ${styles.kpiAmber}`}>{iqd(totalGiven)}</div>
              <div className={styles.kpiSub}>all advances on record</div>
            </div>
            <div className={styles.kpiCard}>
              <div className={styles.kpiLabel}>Distributed So Far</div>
              <div className={`${styles.kpiValue} ${styles.kpiGreen}`}>{iqd(totalDistributed)}</div>
              <div className={styles.kpiSub}>handed to teammates (pending)</div>
            </div>
            <div className={styles.kpiCard}>
              <div className={styles.kpiLabel}>Leftover to Holders</div>
              <div className={`${styles.kpiValue} ${styles.kpiRed}`}>{iqd(totalLeftover)}</div>
              <div className={styles.kpiSub}>undistributed, charged to holder</div>
            </div>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Holder</th><th>Date Given</th>
                  <th className={styles.num}>Amount</th>
                  <th>Settlement Period</th>
                  <th className={styles.num}>Distributed</th><th className={styles.num}>Leftover</th>
                  <th>Status</th><th>Reason</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0
                  ? <tr><td colSpan={9} className={styles.empty}>No advances.</td></tr>
                  : filtered.map(r => {
                    const distributed = getDistributedTotal(r.id, dists);
                    const leftover = getHolderLeftover(r, dists);
                    const badgeClass = r.status === 'pending' ? styles.badgeAmber : r.status === 'settled' ? styles.badgeGreen : styles.badgeRed;
                    return (
                      <tr key={r.id}>
                        <td><strong>{r.holder_member_name}</strong></td>
                        <td style={{ whiteSpace: 'nowrap' }}>{r.date_given || ''}</td>
                        <td className={styles.num}>{iqd(r.amount)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button className={styles.btnGhost2} style={{ height: 26, padding: '0 8px', fontSize: 12 }} onClick={() => setDetailId(r.id)}>
                            {FIN_MONTHS[r.settlement_month - 1]} {r.settlement_year}
                          </button>
                        </td>
                        <td className={styles.num} style={{ color: '#16a34a' }}>{iqd(distributed)}</td>
                        <td className={styles.num} style={{ color: leftover > 0 ? '#dc2626' : undefined }}>{iqd(leftover)}</td>
                        <td><span className={`${styles.badge} ${badgeClass}`}>{r.status}</span></td>
                        <td className={styles.noteCell}>{r.reason || ''}</td>
                        <td>
                          <div className={styles.actions}>
                            {hasPerm('fin_advances_edit') && (
                              <button className={styles.actBtn} onClick={() => openModal(r.id)} title="Edit"><PenIcon /></button>
                            )}
                            {hasPerm('fin_advances_edit') && r.status === 'pending' && (
                              <button className={styles.actBtn} onClick={() => handleSetStatus(r.id, 'settled')} title="Mark settled"><CheckIcon /></button>
                            )}
                            {hasPerm('fin_advances_edit') && r.status === 'pending' && (
                              <button className={styles.actBtn} onClick={() => handleSetStatus(r.id, 'cancelled')} title="Cancel advance"><BanIcon /></button>
                            )}
                            {hasPerm('fin_advances_delete') && (
                              <button className={`${styles.actBtn} ${styles.actBtnDel}`} onClick={() => openDelModal(r.id)} title="Delete"><TrashIcon /></button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                }
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}><strong>Total (filtered)</strong></td>
                  <td className={styles.num}><strong>{iqd(filtered.reduce((s, r) => s + (+r.amount || 0), 0))}</strong></td>
                  <td colSpan={6} />
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}

      {/* Add/Edit modal */}
      {modalOpen && createPortal(
        <div className={styles.overlay} onClick={() => !modalSaving && setModalOpen(false)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalTitle}>{editId ? 'Edit Advance' : 'Add Advance'}</div>
            {modalErr && <div className={styles.modalErr}>{modalErr}</div>}
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Holder</label>
              <select className={styles.formSel} value={form.holderId} disabled={!!editId}
                onChange={e => setForm(f => ({ ...f, holderId: e.target.value }))}>
                <option value="">— Select employee —</option>
                {team.map(t => <option key={t.id} value={t.id}>{t.full_name}</option>)}
              </select>
            </div>
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Amount (IQD)</label>
              <input type="number" min={0} className={styles.formInput} value={form.amount}
                onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
            </div>
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Date Given</label>
              <input type="date" className={styles.formInput} value={form.dateGiven}
                onChange={e => setForm(f => ({ ...f, dateGiven: e.target.value }))} />
            </div>
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Settlement Period</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <select className={styles.formSel} value={form.settlementMonth}
                  onChange={e => setForm(f => ({ ...f, settlementMonth: +e.target.value }))}>
                  {FIN_MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
                <select className={styles.formSel} value={form.settlementYear}
                  onChange={e => setForm(f => ({ ...f, settlementYear: +e.target.value }))}>
                  {years.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                The payslip period where any distributed portions and the holder's leftover both get deducted.
              </div>
            </div>
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Reason</label>
              <input className={styles.formInput} placeholder="e.g. Emergency, Eid advance…" value={form.reason}
                onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} />
            </div>
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Notes</label>
              <textarea className={styles.formTextarea} rows={2} value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </div>
            <div className={styles.modalActions}>
              <button className={styles.btnPrimary} disabled={modalSaving} onClick={saveModal}>
                {modalSaving ? 'Saving…' : editId ? 'Save Changes' : 'Add Advance'}
              </button>
              <button className={styles.btnGhost2} disabled={modalSaving} onClick={() => setModalOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Delete confirm */}
      {delId && createPortal(
        <div className={styles.overlay} onClick={() => !delSaving && setDelId(null)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalTitle}>Confirm Delete</div>
            <p className={styles.delMsg}>{delMsg}</p>
            <div className={styles.modalActions}>
              <button className={styles.btnDanger} disabled={delSaving} onClick={confirmDelete}>
                {delSaving ? 'Deleting…' : 'Delete'}
              </button>
              <button className={styles.btnGhost2} disabled={delSaving} onClick={() => setDelId(null)}>Cancel</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Distribution detail */}
      {detailId && detailAdvance && createPortal(
        <div className={styles.overlay} onClick={() => setDetailId(null)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalTitle}>Distributions — {detailAdvance.holder_member_name}</div>
            <table className={styles.table}>
              <thead><tr><th>Recipient</th><th className={styles.num}>Amount</th></tr></thead>
              <tbody>
                {detailDists.length === 0 && (
                  <tr><td colSpan={2} className={styles.empty}>Nothing distributed yet.</td></tr>
                )}
                {detailDists.map(d => (
                  <tr key={d.id}>
                    <td>{d.recipient_member_name}</td>
                    <td className={styles.num}>{iqd(d.amount)}</td>
                  </tr>
                ))}
                <tr>
                  <td><strong>Leftover — charged to {detailAdvance.holder_member_name}</strong></td>
                  <td className={styles.num}><strong style={{ color: '#dc2626' }}>{iqd(getHolderLeftover(detailAdvance, dists))}</strong></td>
                </tr>
              </tbody>
            </table>
            <div className={styles.modalActions}>
              <button className={styles.btnGhost2} onClick={() => setDetailId(null)}>Close</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {toastMsg && createPortal(<div className={styles.toast}>{toastMsg}</div>, document.body)}
    </div>
  );
}

function PenIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>;
}
function TrashIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>;
}
function BanIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>;
}
function CheckIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="20 6 9 17 4 12"/></svg>;
}
