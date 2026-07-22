import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import styles from './FinPages.module.css';

const FIN_PROJECTS = ['Zain Project', 'Nokia Project', 'Huawei Project', 'IPT Project', 'General'];
const FIN_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const PE_CATS = ['Materials', 'Transport', 'Equipment', 'Accommodation', 'Food', 'Maintenance', 'Other'];
const FPE_DESC_PRESETS = ['Delivery', 'Installation', 'Integration', 'ATP', 'Clearance', 'Other'];

function iqd(n: number | null | undefined): string {
  if (n == null) return '—';
  const v = Math.round(+n);
  return isNaN(v) ? '—' : v.toLocaleString('en-US') + ' IQD';
}

function getYears(): number[] {
  const y = new Date().getFullYear();
  return [y - 2, y - 1, y, y + 1];
}

interface ProjExpRow {
  id: string;
  project_name: string | null;
  description: string | null;
  category: string | null;
  site_id: string | null;
  amount: number;
  expense_date: string | null;
  activity_date: string | null;
  month: number | null;
  year: number | null;
  notes: string | null;
  submitted_by: string | null;
  approved_by: string | null;
  employee_ids: string | null;
  accommodation: string | null;
  added_by: string | null;
}

interface TeamMember { id: string; full_name: string; is_active: boolean | null; }

interface FormState {
  proj: string;
  descSel: string;   // preset value or 'Other'
  descOther: string; // free text when descSel === 'Other'
  cat: string;
  siteId: string;
  amount: string;
  amtLocked: boolean;
  accom: string;
  date: string;
  notes: string;
  empIds: string[];
}

function emptyForm(): FormState {
  return {
    proj: '', descSel: '', descOther: '', cat: '', siteId: '',
    amount: '', amtLocked: false, accom: '',
    date: new Date().toISOString().slice(0, 10),
    notes: '', empIds: [],
  };
}

export default function FinProjExp() {
  const { hasPerm, currentUser } = useAuth();
  const [rows, setRows] = useState<ProjExpRow[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fProj, setFProj] = useState('');
  const [fCat, setFCat] = useState('');
  const [fMonth, setFMonth] = useState(new Date().getMonth() + 1);
  const [fYear, setFYear] = useState(new Date().getFullYear());
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [modalOpen, setModalOpen] = useState(false);
  const [modalSaving, setModalSaving] = useState(false);
  const [modalErr, setModalErr] = useState<string | null>(null);
  const [empDropOpen, setEmpDropOpen] = useState(false);
  const empWrapRef = useRef<HTMLDivElement>(null);
  const [delId, setDelId] = useState<string | null>(null);
  const [delMsg, setDelMsg] = useState('');
  const [delSaving, setDelSaving] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(msg: string) {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 3200);
  }

  useEffect(() => {
    if (hasPerm('view_fin_projexp')) { loadData(); loadTeam(); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Close employee dropdown on outside click
  useEffect(() => {
    if (!empDropOpen) return;
    function onOutside(e: MouseEvent) {
      if (empWrapRef.current && !empWrapRef.current.contains(e.target as Node)) {
        setEmpDropOpen(false);
      }
    }
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [empDropOpen]);

  if (!hasPerm('view_fin_projexp')) {
    return <div className={styles.placeholder}>You don't have permission to view Project Expenses.</div>;
  }

  async function loadData() {
    setLoading(true); setLoadError(null);
    try {
      const { data, error } = await supabase.from('project_expenses').select('*').order('expense_date', { ascending: false });
      if (error) throw error;
      setRows((data as ProjExpRow[]) || []);
    } catch (e: unknown) { setLoadError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }

  async function loadTeam() {
    const { data } = await supabase.from('team_members').select('id, full_name, is_active').order('full_name');
    setTeamMembers(((data || []) as TeamMember[]).filter(m => m.is_active !== false));
  }

  function filteredRows(): ProjExpRow[] {
    return rows.filter(r =>
      (!fProj  || r.project_name === fProj) &&
      (!fCat   || r.category === fCat) &&
      (!fMonth || r.month === fMonth) &&
      (!fYear  || r.year  === fYear)
    );
  }

  // Resolve description: preset or free-text from 'Other'
  function resolveDesc(f: FormState): string {
    return f.descSel === 'Other' ? f.descOther.trim() : f.descSel;
  }

  // Set description fields from a stored string
  function setDescFromValue(val: string): Pick<FormState, 'descSel' | 'descOther'> {
    if (!val) return { descSel: '', descOther: '' };
    if (FPE_DESC_PRESETS.includes(val)) return { descSel: val, descOther: '' };
    return { descSel: 'Other', descOther: val };
  }

  function handleCatChange(cat: string) {
    setForm(f => {
      const isFood = cat === 'Food';
      const wasFood = f.cat === 'Food';
      let empIds = f.empIds;
      let amtLocked = f.amtLocked;
      let accom = f.accom;
      let amount = f.amount;

      if (isFood) {
        amtLocked = true;
        // If switching TO food and more than 1 employee is selected, clear all
        if (!wasFood && f.empIds.length > 1) empIds = [];
        // Keep accom as-is; amount will be recalculated
        if (accom === 'Returned Home') amount = '10000';
        else if (accom === 'Hotel') amount = '15000';
        else amount = '';
      } else if (wasFood && !isFood) {
        // Switching AWAY from food
        accom = '';
        amtLocked = false;
        amount = '0';
      }
      return { ...f, cat, amtLocked, accom, amount, empIds };
    });
  }

  function handleAccomChange(accom: string) {
    setForm(f => {
      let amount = f.amount;
      if (f.cat === 'Food') {
        if (accom === 'Returned Home') amount = '10000';
        else if (accom === 'Hotel') amount = '15000';
        else amount = '';
      }
      return { ...f, accom, amount };
    });
  }

  function toggleEmployee(id: string) {
    setForm(f => {
      const isFood = f.cat === 'Food';
      const idx = f.empIds.indexOf(id);
      let empIds: string[];
      if (idx >= 0) {
        empIds = f.empIds.filter(x => x !== id);
      } else {
        empIds = isFood ? [id] : [...f.empIds, id];
      }
      return { ...f, empIds };
    });
  }

  function openModal(id: string | null) {
    setEditId(id); setModalErr(null); setEmpDropOpen(false);
    if (id) {
      const r = rows.find(x => x.id === id);
      if (!r) return;
      let parsedIds: string[] = [];
      try { parsedIds = JSON.parse(r.employee_ids || '[]'); } catch { parsedIds = []; }
      const isFood = r.category === 'Food';
      setForm({
        proj: r.project_name || '',
        ...setDescFromValue(r.description || ''),
        cat: r.category || '',
        siteId: r.site_id || '',
        amount: String(r.amount ?? ''),
        amtLocked: isFood,
        accom: isFood ? (r.accommodation || '') : '',
        date: r.activity_date || r.expense_date || '',
        notes: r.notes || '',
        empIds: parsedIds,
      });
    } else {
      setForm(emptyForm());
    }
    setModalOpen(true);
  }

  async function saveModal() {
    setModalErr(null);
    const desc = resolveDesc(form);
    const amt = +form.amount;
    if (!form.proj)               { setModalErr('Project required.'); return; }
    if (!form.descSel)            { setModalErr('Description required.'); return; }
    if (form.descSel === 'Other' && !form.descOther.trim()) { setModalErr('Please specify the description.'); return; }
    if (!amt || amt < 0)          { setModalErr('Valid amount required.'); return; }
    if (form.cat === 'Food' && !form.accom) { setModalErr('Accommodation required for Food category.'); return; }

    const dateObj = form.date ? new Date(form.date) : new Date();
    const empIds = form.empIds.length ? JSON.stringify(form.empIds) : null;
    const payload: Record<string, unknown> = {
      project_name: form.proj, description: desc, category: form.cat || null,
      amount: amt, expense_date: form.date || null, activity_date: form.date || null,
      month: dateObj.getMonth() + 1, year: dateObj.getFullYear(),
      site_id: form.siteId.trim() || null, employee_ids: empIds,
      accommodation: form.accom || null,
      notes: form.notes.trim() || null, added_by: currentUser?.full_name || '',
    };
    // On add only: set submitted_by / approved_by to current user
    if (!editId) {
      payload.submitted_by = currentUser?.full_name || null;
      payload.approved_by  = currentUser?.full_name || null;
    }

    setModalSaving(true);
    try {
      if (editId) {
        const { error } = await supabase.from('project_expenses').update(payload).eq('id', editId);
        if (error) throw error;
        setRows(prev => prev.map(r => r.id === editId ? { ...r, ...payload } as ProjExpRow : r));
        showToast('Updated');
      } else {
        const { data, error } = await supabase.from('project_expenses').insert(payload).select('id').single();
        if (error) throw error;
        setRows(prev => [{ id: (data as { id: string }).id, ...payload } as ProjExpRow, ...prev]);
        showToast('Added');
      }
      setModalOpen(false);
    } catch (e: unknown) { setModalErr(e instanceof Error ? e.message : String(e)); }
    finally { setModalSaving(false); }
  }

  function openDelModal(id: string) {
    const r = rows.find(x => x.id === id);
    setDelMsg(r ? `Delete "${r.description || '—'}" — ${r.project_name || '—'} — ${iqd(r.amount)}?` : 'Delete expense?');
    setDelId(id);
  }

  async function confirmDelete() {
    if (!delId) return;
    setDelSaving(true);
    const { error } = await supabase.from('project_expenses').delete().eq('id', delId);
    if (error) { showToast('Error: ' + error.message); setDelSaving(false); return; }
    setRows(prev => prev.filter(r => r.id !== delId));
    setDelId(null); setDelSaving(false);
    showToast('Deleted');
  }

  async function handleExport() {
    const data = filteredRows();
    if (!data.length) { showToast('No data to export'); return; }
    try {
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('projexp');
      ws.addRow(['Date', 'Project', 'Description', 'Category', 'Amount (IQD)', 'Notes']);
      for (const r of data) ws.addRow([r.expense_date, r.project_name, r.description, r.category, r.amount, r.notes]);
      const buf = await wb.xlsx.writeBuffer();
      const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      Object.assign(document.createElement('a'), { href: url, download: `Finance_projexp_${new Date().toISOString().slice(0,10)}.xlsx` }).click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) { showToast('Export failed: ' + (e instanceof Error ? e.message : String(e))); }
  }

  const filtered = filteredRows();
  const total = filtered.reduce((s, r) => s + (+r.amount || 0), 0);
  const years = getYears();

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <select className={styles.sel} value={fProj} onChange={e => setFProj(e.target.value)}>
          <option value="">All Projects</option>
          {FIN_PROJECTS.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select className={styles.sel} value={fCat} onChange={e => setFCat(e.target.value)}>
          <option value="">All Categories</option>
          {PE_CATS.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className={styles.sel} value={fMonth} onChange={e => setFMonth(+e.target.value)}>
          <option value={0}>All Months</option>
          {FIN_MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
        <select className={styles.sel} value={fYear} onChange={e => setFYear(+e.target.value)}>
          <option value={0}>All Years</option>
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <div className={styles.spacer} />
        <button className={styles.btnGhost} onClick={() => loadData()}>↺ Refresh</button>
        <button className={styles.btnGhost} onClick={handleExport}>Export</button>
        <button className={styles.btnAccent} onClick={() => openModal(null)}>+ Add Expense</button>
      </div>

      {loading && <div className={styles.loadingBar}>Loading…</div>}
      {loadError && <div className={styles.errorMsg}>{loadError}</div>}

      {!loading && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Date</th><th>Project</th><th>Description</th><th>Site ID</th>
                <th>Category</th><th className={styles.num}>Amount (IQD)</th>
                <th>Submitted By</th><th>Approved By</th><th>Notes</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0
                ? <tr><td colSpan={10} className={styles.empty}>No project expenses.</td></tr>
                : filtered.map(r => (
                  <tr key={r.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.activity_date || r.expense_date || ''}</td>
                    <td>{r.project_name || ''}</td>
                    <td>{r.description || ''}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.site_id || ''}</td>
                    <td>{r.category || ''}</td>
                    <td className={styles.num} style={{ color: '#dc2626' }}>{iqd(r.amount)}</td>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 13, color: 'var(--slate-600)' }}>
                      {r.submitted_by || <span style={{ color: 'var(--slate-400)' }}>—</span>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 13, color: 'var(--slate-600)' }}>
                      {r.approved_by || <span style={{ color: 'var(--slate-400)' }}>—</span>}
                    </td>
                    <td className={styles.noteCell}>{r.notes || ''}</td>
                    <td>
                      <div className={styles.actions}>
                        <button className={styles.actBtn} onClick={() => openModal(r.id)} title="Edit"><PenIcon /></button>
                        <button className={`${styles.actBtn} ${styles.actBtnDel}`} onClick={() => openDelModal(r.id)} title="Delete"><TrashIcon /></button>
                      </div>
                    </td>
                  </tr>
                ))
              }
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5}><strong>Total (filtered)</strong></td>
                <td className={styles.num} style={{ color: '#dc2626' }}><strong>{iqd(total)}</strong></td>
                <td colSpan={4} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Add/Edit modal */}
      {modalOpen && createPortal(
        <div className={styles.overlay} onClick={() => !modalSaving && setModalOpen(false)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalTitle}>{editId ? 'Edit Project Expense' : 'Add Project Expense'}</div>
            {modalErr && <div className={styles.modalErr}>{modalErr}</div>}

            <div className={styles.formRow}>
              <label className={styles.formLabel}>Project</label>
              <select className={styles.formSel} value={form.proj} autoFocus
                onChange={e => setForm(f => ({ ...f, proj: e.target.value }))}>
                <option value="">— Select project —</option>
                {FIN_PROJECTS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>

            <div className={styles.formRow}>
              <label className={styles.formLabel}>Category</label>
              <select className={styles.formSel} value={form.cat}
                onChange={e => handleCatChange(e.target.value)}>
                <option value="">— Select category —</option>
                {PE_CATS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            <div className={styles.formRow}>
              <label className={styles.formLabel}>Description</label>
              <select className={styles.formSel} value={form.descSel}
                onChange={e => setForm(f => ({ ...f, descSel: e.target.value, descOther: '' }))}>
                <option value="">— Select description —</option>
                {FPE_DESC_PRESETS.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
              {form.descSel === 'Other' && (
                <input className={styles.formInput} style={{ marginTop: 6 }} placeholder="Specify description…"
                  value={form.descOther} onChange={e => setForm(f => ({ ...f, descOther: e.target.value }))} />
              )}
            </div>

            <div className={styles.formRow}>
              <label className={styles.formLabel}>Site ID</label>
              <input className={styles.formInput} placeholder="Site ID (optional)"
                value={form.siteId} onChange={e => setForm(f => ({ ...f, siteId: e.target.value }))} />
            </div>

            {/* Food: Accommodation */}
            {form.cat === 'Food' && (
              <div className={styles.accomRow}>
                <label className={styles.formLabel}>Accommodation</label>
                <select className={styles.formSel} value={form.accom}
                  onChange={e => handleAccomChange(e.target.value)}>
                  <option value="">— Select accommodation —</option>
                  <option value="Returned Home">Returned Home</option>
                  <option value="Hotel">Hotel</option>
                </select>
              </div>
            )}

            <div className={styles.formRow}>
              <label className={styles.formLabel}>Amount (IQD)</label>
              <input type="number" min={0} className={styles.formInput}
                value={form.amount} readOnly={form.amtLocked}
                onChange={e => !form.amtLocked && setForm(f => ({ ...f, amount: e.target.value }))} />
            </div>

            <div className={styles.formRow}>
              <label className={styles.formLabel}>Date</label>
              <input type="date" className={styles.formInput} value={form.date}
                onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
            </div>

            {/* Employee multi-select */}
            <div className={styles.formRow}>
              <label className={styles.formLabel}>
                Employees {form.cat === 'Food' ? '(single-select for Food)' : '(optional)'}
              </label>
              <div className={styles.empWrap} ref={empWrapRef}>
                <div className={styles.empTags} onClick={() => setEmpDropOpen(o => !o)}>
                  {form.empIds.length === 0
                    ? <span className={styles.empPlaceholder}>Select employees…</span>
                    : form.empIds.map(id => {
                        const m = teamMembers.find(x => x.id === id);
                        return m ? (
                          <span key={id} className={styles.empPill}>
                            {m.full_name}
                            <span className={styles.empPillX}
                              onClick={e => { e.stopPropagation(); toggleEmployee(id); }}>×</span>
                          </span>
                        ) : null;
                      })
                  }
                </div>
                {empDropOpen && (
                  <div className={styles.empDropdown}>
                    {teamMembers.length === 0
                      ? <div style={{ padding: '10px 13px', fontSize: 13, color: 'var(--slate-400)' }}>No team members found.</div>
                      : teamMembers.map(m => (
                        <label key={m.id} className={styles.empItem}>
                          <input type="checkbox" checked={form.empIds.includes(m.id)}
                            onChange={() => toggleEmployee(m.id)} />
                          {m.full_name}
                        </label>
                      ))
                    }
                  </div>
                )}
              </div>
            </div>

            <div className={styles.formRow}>
              <label className={styles.formLabel}>Notes</label>
              <textarea className={styles.formTextarea} rows={2} value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </div>

            <div className={styles.modalActions}>
              <button className={styles.btnPrimary} disabled={modalSaving} onClick={saveModal}>
                {modalSaving ? 'Saving…' : editId ? 'Save Changes' : 'Add Expense'}
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
