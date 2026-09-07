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
  deleteAdvance, setAdvanceStatus, getAdvanceDeductedSoFar,
} from '../lib/advances';
import styles from './FinPages.module.css';

interface TeamMember {
  id: string;
  full_name: string;
  role: string | null;
  is_active: boolean | null;
}

interface FormState {
  memberId: string;
  amount: string;
  dateGiven: string;
  installments: string;
  startMonth: number;
  startYear: number;
  reason: string;
  notes: string;
}

function emptyForm(): FormState {
  const now = new Date();
  return {
    memberId: '', amount: '', dateGiven: now.toISOString().slice(0, 10),
    installments: '1', startMonth: now.getMonth() + 1, startYear: now.getFullYear(),
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

  const [scheduleId, setScheduleId] = useState<string | null>(null);

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
      (!fMember || r.member_id === fMember)
    );
  }

  function openModal(id: string | null) {
    setEditId(id); setModalErr(null);
    if (id) {
      const r = rows.find(x => x.id === id);
      if (!r) return;
      setForm({
        memberId: r.member_id, amount: String(r.amount ?? ''), dateGiven: r.date_given || '',
        installments: String(r.installments ?? 1), startMonth: r.start_month, startYear: r.start_year,
        reason: r.reason || '', notes: r.notes || '',
      });
    } else {
      setForm(emptyForm());
    }
    setModalOpen(true);
  }

  async function saveModal() {
    setModalErr(null);
    const member = team.find(t => t.id === form.memberId);
    const amt = +form.amount;
    const inst = Math.floor(+form.installments);
    if (!form.memberId) { setModalErr('Employee is required.'); return; }
    if (!amt || amt <= 0) { setModalErr('Valid amount required.'); return; }
    if (!inst || inst <= 0) { setModalErr('Valid number of installments required.'); return; }

    const input: AdvanceFormInput = {
      member_id: form.memberId,
      member_name: member?.full_name || '',
      amount: amt,
      date_given: form.dateGiven,
      installments: inst,
      start_month: form.startMonth,
      start_year: form.startYear,
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
          details: `Edited advance for ${input.member_name}: ${iqd(amt)} over ${inst} installment${inst !== 1 ? 's' : ''}`,
        });
      } else {
        await createAdvance(input);
        showToast('Added');
        void sendPushToRoles(['admin'], 'Salary Advance Added', `New advance for ${input.member_name}: ${iqd(amt)}`);
        logActivity({
          userFullName: currentUser?.full_name ?? currentUser?.username,
          action: 'Added Salary Advance',
          details: `Added advance for ${input.member_name}: ${iqd(amt)} over ${inst} installment${inst !== 1 ? 's' : ''}`,
        });
      }
      setModalOpen(false);
      await loadData();
    } catch (e: unknown) { setModalErr(e instanceof Error ? e.message : String(e)); }
    finally { setModalSaving(false); }
  }

  function openDelModal(id: string) {
    const r = rows.find(x => x.id === id);
    setDelMsg(r ? `Delete the ${iqd(r.amount)} advance for "${r.member_name}"? This also removes its remaining deduction schedule.` : 'Delete this advance?');
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
        details: `Deleted advance for ${r?.member_name || ''}: ${iqd(r?.amount)}`,
      });
      await loadData();
    } catch (e: unknown) { showToast('Error: ' + (e instanceof Error ? e.message : String(e))); }
    finally { setDelSaving(false); }
  }

  async function handleSetStatus(id: string, status: Advance['status']) {
    try {
      await setAdvanceStatus(id, status);
      setRows(prev => prev.map(r => r.id === id ? { ...r, status } : r));
      showToast(status === 'cancelled' ? 'Advance cancelled' : 'Marked completed');
    } catch (e: unknown) { showToast('Error: ' + (e instanceof Error ? e.message : String(e))); }
  }

  async function handleExport() {
    const data = filteredRows();
    if (!data.length) { showToast('No data to export'); return; }
    try {
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('advances');
      ws.addRow(['Employee', 'Amount (IQD)', 'Date Given', 'Installments', 'Start Period', 'Deducted So Far (IQD)', 'Remaining (IQD)', 'Status', 'Reason', 'Notes', 'Added By']);
      const now = new Date();
      for (const r of data) {
        const deducted = getAdvanceDeductedSoFar(r.id, dists, now.getMonth() + 1, now.getFullYear());
        ws.addRow([
          r.member_name, r.amount, r.date_given, r.installments,
          `${FIN_MONTHS[r.start_month - 1]} ${r.start_year}`,
          deducted, Math.max(0, r.amount - deducted), r.status, r.reason, r.notes, r.added_by,
        ]);
      }
      const buf = await wb.xlsx.writeBuffer();
      const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      Object.assign(document.createElement('a'), { href: url, download: `Finance_advances_${new Date().toISOString().slice(0, 10)}.xlsx` }).click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) { showToast('Export failed: ' + (e instanceof Error ? e.message : String(e))); }
  }

  const now = new Date();
  const filtered = filteredRows();
  const activeRows = rows.filter(r => r.status === 'active');
  const totalGiven = rows.reduce((s, r) => s + (+r.amount || 0), 0);
  const totalDeducted = activeRows.reduce((s, r) => s + getAdvanceDeductedSoFar(r.id, dists, now.getMonth() + 1, now.getFullYear()), 0);
  const totalOutstanding = activeRows.reduce((s, r) => {
    const deducted = getAdvanceDeductedSoFar(r.id, dists, now.getMonth() + 1, now.getFullYear());
    return s + Math.max(0, r.amount - deducted);
  }, 0);
  const years = getYears();
  const scheduleAdvance = scheduleId ? rows.find(r => r.id === scheduleId) : null;
  const scheduleRows = scheduleId ? dists.filter(d => d.advance_id === scheduleId).sort((a, b) => (a.year - b.year) || (a.month - b.month)) : [];

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <select className={styles.sel} value={fStatus} onChange={e => setFStatus(e.target.value)}>
          <option value="">All Statuses</option>
          <option value="active">Active</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <select className={styles.sel} value={fMember} onChange={e => setFMember(e.target.value)}>
          <option value="">All Employees</option>
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
              <div className={styles.kpiLabel}>Active Advances</div>
              <div className={styles.kpiValue}>{activeRows.length}</div>
              <div className={styles.kpiSub}>currently being deducted</div>
            </div>
            <div className={styles.kpiCard}>
              <div className={styles.kpiLabel}>Total Given</div>
              <div className={`${styles.kpiValue} ${styles.kpiAmber}`}>{iqd(totalGiven)}</div>
              <div className={styles.kpiSub}>all advances on record</div>
            </div>
            <div className={styles.kpiCard}>
              <div className={styles.kpiLabel}>Deducted So Far</div>
              <div className={`${styles.kpiValue} ${styles.kpiGreen}`}>{iqd(totalDeducted)}</div>
              <div className={styles.kpiSub}>from active advances</div>
            </div>
            <div className={styles.kpiCard}>
              <div className={styles.kpiLabel}>Outstanding</div>
              <div className={`${styles.kpiValue} ${styles.kpiRed}`}>{iqd(totalOutstanding)}</div>
              <div className={styles.kpiSub}>still to be deducted</div>
            </div>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Employee</th><th>Date Given</th>
                  <th className={styles.num}>Amount</th><th className={styles.num}>Installments</th>
                  <th>Start Period</th>
                  <th className={styles.num}>Deducted</th><th className={styles.num}>Remaining</th>
                  <th>Status</th><th>Reason</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0
                  ? <tr><td colSpan={10} className={styles.empty}>No advances.</td></tr>
                  : filtered.map(r => {
                    const deducted = getAdvanceDeductedSoFar(r.id, dists, now.getMonth() + 1, now.getFullYear());
                    const remaining = Math.max(0, r.amount - deducted);
                    const badgeClass = r.status === 'active' ? styles.badgeAmber : r.status === 'completed' ? styles.badgeGreen : styles.badgeRed;
                    return (
                      <tr key={r.id}>
                        <td><strong>{r.member_name}</strong></td>
                        <td style={{ whiteSpace: 'nowrap' }}>{r.date_given || ''}</td>
                        <td className={styles.num}>{iqd(r.amount)}</td>
                        <td className={styles.num}>
                          <button className={styles.btnGhost2} style={{ height: 26, padding: '0 8px', fontSize: 12 }} onClick={() => setScheduleId(r.id)}>
                            {r.installments}×
                          </button>
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>{FIN_MONTHS[r.start_month - 1]} {r.start_year}</td>
                        <td className={styles.num} style={{ color: '#16a34a' }}>{iqd(deducted)}</td>
                        <td className={styles.num} style={{ color: remaining > 0 ? '#dc2626' : undefined }}>{iqd(remaining)}</td>
                        <td><span className={`${styles.badge} ${badgeClass}`}>{r.status}</span></td>
                        <td className={styles.noteCell}>{r.reason || ''}</td>
                        <td>
                          <div className={styles.actions}>
                            {hasPerm('fin_advances_edit') && (
                              <button className={styles.actBtn} onClick={() => openModal(r.id)} title="Edit"><PenIcon /></button>
                            )}
                            {hasPerm('fin_advances_edit') && r.status === 'active' && (
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
                  <td colSpan={7} />
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
              <label className={styles.formLabel}>Employee</label>
              <select className={styles.formSel} value={form.memberId} disabled={!!editId}
                onChange={e => setForm(f => ({ ...f, memberId: e.target.value }))}>
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
              <label className={styles.formLabel}>Installments (months)</label>
              <input type="number" min={1} className={styles.formInput} value={form.installments}
                onChange={e => setForm(f => ({ ...f, installments: e.target.value }))} />
            </div>
            <div className={styles.formRow}>
              <label className={styles.formLabel}>First Deduction Period</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <select className={styles.formSel} value={form.startMonth}
                  onChange={e => setForm(f => ({ ...f, startMonth: +e.target.value }))}>
                  {FIN_MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
                <select className={styles.formSel} value={form.startYear}
                  onChange={e => setForm(f => ({ ...f, startYear: +e.target.value }))}>
                  {years.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
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

      {/* Deduction schedule */}
      {scheduleId && scheduleAdvance && createPortal(
        <div className={styles.overlay} onClick={() => setScheduleId(null)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalTitle}>Deduction Schedule — {scheduleAdvance.member_name}</div>
            <table className={styles.table}>
              <thead><tr><th>Period</th><th className={styles.num}>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {scheduleRows.map(d => {
                  const isPast = d.year < now.getFullYear() || (d.year === now.getFullYear() && d.month <= now.getMonth() + 1);
                  return (
                    <tr key={d.id}>
                      <td>{FIN_MONTHS[d.month - 1]} {d.year}</td>
                      <td className={styles.num}>{iqd(d.amount)}</td>
                      <td><span className={`${styles.badge} ${isPast ? styles.badgeGreen : styles.badgeAmber}`}>{isPast ? 'Deducted' : 'Upcoming'}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className={styles.modalActions}>
              <button className={styles.btnGhost2} onClick={() => setScheduleId(null)}>Close</button>
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
