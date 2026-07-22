import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import styles from './FinPages.module.css';

const FIN_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const GE_CATS = ['Rent', 'Office', 'Utilities', 'Communication', 'Other'];

function iqd(n: number | null | undefined): string {
  if (n == null) return '—';
  const v = Math.round(+n);
  return isNaN(v) ? '—' : v.toLocaleString('en-US') + ' IQD';
}

function getYears(): number[] {
  const y = new Date().getFullYear();
  return [y - 2, y - 1, y, y + 1];
}

interface GenExpRow {
  id: string;
  description: string | null;
  category: string | null;
  amount: number;
  expense_date: string | null;
  month: number | null;
  year: number | null;
  notes: string | null;
  added_by: string | null;
}

interface FormState {
  desc: string; cat: string; amount: string; date: string; notes: string;
}

function emptyForm(): FormState {
  return { desc: '', cat: '', amount: '', date: new Date().toISOString().slice(0, 10), notes: '' };
}

export default function FinGenExp() {
  const { hasPerm, currentUser } = useAuth();
  const [rows, setRows] = useState<GenExpRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fCat, setFCat] = useState('');
  const [fMonth, setFMonth] = useState(new Date().getMonth() + 1);
  const [fYear, setFYear] = useState(new Date().getFullYear());
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [modalOpen, setModalOpen] = useState(false);
  const [modalSaving, setModalSaving] = useState(false);
  const [modalErr, setModalErr] = useState<string | null>(null);
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
    if (hasPerm('view_fin_genexp')) loadData();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!hasPerm('view_fin_genexp')) {
    return <div className={styles.placeholder}>You don't have permission to view General Expenses.</div>;
  }

  async function loadData() {
    setLoading(true); setLoadError(null);
    try {
      const { data, error } = await supabase.from('general_expenses').select('*').order('expense_date', { ascending: false });
      if (error) throw error;
      setRows((data as GenExpRow[]) || []);
    } catch (e: unknown) { setLoadError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }

  function filteredRows(): GenExpRow[] {
    return rows.filter(r =>
      (!fCat   || r.category === fCat) &&
      (!fMonth || r.month === fMonth) &&
      (!fYear  || r.year  === fYear)
    );
  }

  function openModal(id: string | null) {
    setEditId(id); setModalErr(null);
    if (id) {
      const r = rows.find(x => x.id === id);
      if (!r) return;
      setForm({ desc: r.description || '', cat: r.category || '',
        amount: String(r.amount ?? ''), date: r.expense_date || '', notes: r.notes || '' });
    } else {
      setForm(emptyForm());
    }
    setModalOpen(true);
  }

  async function saveModal() {
    setModalErr(null);
    const desc = form.desc.trim();
    const amt = +form.amount;
    if (!desc) { setModalErr('Description required.'); return; }
    if (!amt || amt < 0) { setModalErr('Valid amount required.'); return; }
    const dateObj = form.date ? new Date(form.date) : new Date();
    const payload = {
      description: desc, category: form.cat || null, amount: amt,
      expense_date: form.date || null, month: dateObj.getMonth() + 1, year: dateObj.getFullYear(),
      notes: form.notes.trim() || null, added_by: currentUser?.full_name || '',
    };
    setModalSaving(true);
    try {
      if (editId) {
        const { error } = await supabase.from('general_expenses').update(payload).eq('id', editId);
        if (error) throw error;
        setRows(prev => prev.map(r => r.id === editId ? { ...r, ...payload } : r));
        showToast('Updated');
      } else {
        const { data, error } = await supabase.from('general_expenses').insert(payload).select('id').single();
        if (error) throw error;
        setRows(prev => [{ id: (data as { id: string }).id, ...payload } as GenExpRow, ...prev]);
        showToast('Added');
      }
      setModalOpen(false);
    } catch (e: unknown) { setModalErr(e instanceof Error ? e.message : String(e)); }
    finally { setModalSaving(false); }
  }

  function openDelModal(id: string) {
    const r = rows.find(x => x.id === id);
    setDelMsg(r ? `Delete "${r.description || '—'}" — ${iqd(r.amount)}?` : 'Delete expense?');
    setDelId(id);
  }

  async function confirmDelete() {
    if (!delId) return;
    setDelSaving(true);
    const { error } = await supabase.from('general_expenses').delete().eq('id', delId);
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
      const ws = wb.addWorksheet('genexp');
      ws.addRow(['Date', 'Description', 'Category', 'Amount (IQD)', 'Notes', 'Added By']);
      for (const r of data) ws.addRow([r.expense_date, r.description, r.category, r.amount, r.notes, r.added_by]);
      const buf = await wb.xlsx.writeBuffer();
      const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      Object.assign(document.createElement('a'), { href: url, download: `Finance_genexp_${new Date().toISOString().slice(0,10)}.xlsx` }).click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) { showToast('Export failed: ' + (e instanceof Error ? e.message : String(e))); }
  }

  const filtered = filteredRows();
  const total = filtered.reduce((s, r) => s + (+r.amount || 0), 0);
  const years = getYears();

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <select className={styles.sel} value={fCat} onChange={e => setFCat(e.target.value)}>
          <option value="">All Categories</option>
          {GE_CATS.map(c => <option key={c} value={c}>{c}</option>)}
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
                <th>Date</th><th>Description</th><th>Category</th>
                <th className={styles.num}>Amount (IQD)</th><th>Notes</th><th>Added By</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0
                ? <tr><td colSpan={7} className={styles.empty}>No general expenses.</td></tr>
                : filtered.map(r => (
                  <tr key={r.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.expense_date || ''}</td>
                    <td>{r.description || ''}</td>
                    <td>{r.category || ''}</td>
                    <td className={styles.num} style={{ color: '#dc2626' }}>{iqd(r.amount)}</td>
                    <td className={styles.noteCell}>{r.notes || ''}</td>
                    <td style={{ color: 'var(--slate-500)', whiteSpace: 'nowrap' }}>{r.added_by || ''}</td>
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
                <td colSpan={3}><strong>Total (filtered)</strong></td>
                <td className={styles.num} style={{ color: '#dc2626' }}><strong>{iqd(total)}</strong></td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Add/Edit modal */}
      {modalOpen && createPortal(
        <div className={styles.overlay} onClick={() => !modalSaving && setModalOpen(false)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalTitle}>{editId ? 'Edit General Expense' : 'Add General Expense'}</div>
            {modalErr && <div className={styles.modalErr}>{modalErr}</div>}
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Description</label>
              <input className={styles.formInput} placeholder="Description" value={form.desc} autoFocus
                onChange={e => setForm(f => ({ ...f, desc: e.target.value }))} />
            </div>
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Category</label>
              <select className={styles.formSel} value={form.cat} onChange={e => setForm(f => ({ ...f, cat: e.target.value }))}>
                <option value="">— Select category —</option>
                {GE_CATS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Amount (IQD)</label>
              <input type="number" min={0} className={styles.formInput} value={form.amount}
                onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
            </div>
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Date</label>
              <input type="date" className={styles.formInput} value={form.date}
                onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
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
