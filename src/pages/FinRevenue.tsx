import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { isAtpAccepted, findImpColIdx, findAtpColIdx, PROJ_NAMES, SEC_LABELS } from './NetworkScopes';
import { ensureSectionsLoaded, getSections } from '../lib/sectionsCache';
import styles from './FinPages.module.css';

const FIN_PROJECTS = ['Zain Project', 'Nokia Project', 'Huawei Project', 'IPT Project', 'General'];
const FIN_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const REVENUE_CUTOFF_DATE = new Date('2026-07-01T00:00:00');
const NAME_TO_KEY: Record<string, string> = {
  'Zain Project': 'zain', 'Nokia Project': 'nokia',
  'Huawei Project': 'huawei', 'IPT Project': 'ipt',
};

function iqd(n: number | null | undefined): string {
  if (n == null) return '—';
  const v = Math.round(+n);
  return isNaN(v) ? '—' : v.toLocaleString('en-US') + ' IQD';
}

function getYears(): number[] {
  const y = new Date().getFullYear();
  return [y - 2, y - 1, y, y + 1];
}

interface RevRow {
  id: string;
  project_name: string | null;
  section_name: string | null;
  site_id: string | null;
  amount: number;
  invoice_date: string | null;
  month: number | null;
  year: number | null;
  status: string | null;
  notes: string | null;
  added_by: string | null;
}

interface FormState {
  proj: string; section: string; sectionId: string;
  siteId: string; amount: string; date: string;
  status: string; notes: string;
}

interface SectionOpt { id: string; label: string; }

function emptyForm(): FormState {
  return { proj: '', section: '', sectionId: '', siteId: '', amount: '',
    date: new Date().toISOString().slice(0, 10),
    status: 'Implemented - Pending ATP', notes: '' };
}

export default function FinRevenue() {
  const { hasPerm, currentUser } = useAuth();
  const [rows, setRows] = useState<RevRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fProj, setFProj] = useState('');
  const [fMonth, setFMonth] = useState(new Date().getMonth() + 1);
  const [fYear, setFYear] = useState(new Date().getFullYear());
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [modalOpen, setModalOpen] = useState(false);
  const [modalSecs, setModalSecs] = useState<SectionOpt[]>([]);
  const [modalSites, setModalSites] = useState<string[]>([]);
  const [modalSaving, setModalSaving] = useState(false);
  const [modalErr, setModalErr] = useState<string | null>(null);
  const [delId, setDelId] = useState<string | null>(null);
  const [delMsg, setDelMsg] = useState('');
  const [delSaving, setDelSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(msg: string) {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 3200);
  }

  useEffect(() => {
    if (hasPerm('view_fin_revenue')) loadData();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!hasPerm('view_fin_revenue')) {
    return <div className={styles.placeholder}>You don't have permission to view Revenue.</div>;
  }

  async function loadData() {
    setLoading(true); setLoadError(null);
    try {
      const { data, error } = await supabase.from('revenue').select('*').order('invoice_date', { ascending: false });
      if (error) throw error;
      setRows((data as RevRow[]) || []);
    } catch (e: unknown) { setLoadError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }

  function filteredRows(): RevRow[] {
    return rows.filter(r =>
      (!fProj  || r.project_name === fProj) &&
      (!fMonth || r.month === fMonth) &&
      (!fYear  || r.year  === fYear)
    );
  }

  async function updateAmount(id: string, val: number) {
    const amt = Math.max(0, isNaN(val) ? 0 : val);
    const { error } = await supabase.from('revenue').update({ amount: amt }).eq('id', id);
    if (error) { showToast('Error: ' + error.message); return; }
    setRows(prev => prev.map(r => r.id === id ? { ...r, amount: amt } : r));
    showToast('Amount updated');
  }

  async function handleModalProjChange(proj: string) {
    setForm(f => ({ ...f, proj, section: '', sectionId: '', siteId: '' }));
    setModalSecs([]); setModalSites([]);
    if (!proj || !NAME_TO_KEY[proj]) return;
    const { data } = await supabase.from('sections')
      .select('id, section_name, section_label')
      .eq('project_name', NAME_TO_KEY[proj])
      .neq('is_deleted', true)
      .order('section_label');
    setModalSecs((data || []).map((s: { id: string; section_name: string; section_label: string }) => ({
      id: s.id, label: s.section_label || s.section_name,
    })));
  }

  async function handleModalSecChange(label: string) {
    const sec = modalSecs.find(s => s.label === label);
    setForm(f => ({ ...f, section: label, sectionId: sec?.id || '', siteId: '' }));
    setModalSites([]);
    if (!sec) return;
    const { data: sd } = await supabase.from('sections').select('columns').eq('id', sec.id).single();
    const cols: string[] = (sd as { columns: string[] } | null)?.columns || [];
    const siteCol = cols[0] || 'Site ID';
    const { data: rd } = await supabase.from('rows').select('data').eq('section_id', sec.id).neq('is_deleted', true);
    const sites = [...new Set((rd || []).map((r: { data: Record<string, unknown> }) => String(r.data?.[siteCol] || '')).filter(Boolean))];
    setModalSites(sites);
  }

  function openModal(id: string | null) {
    setEditId(id); setModalErr(null); setModalSecs([]); setModalSites([]);
    if (id) {
      const r = rows.find(x => x.id === id);
      if (!r) return;
      setForm({ proj: r.project_name || '', section: r.section_name || '', sectionId: '',
        siteId: r.site_id || '', amount: String(r.amount ?? ''),
        date: r.invoice_date || '', status: r.status || 'Implemented - Pending ATP', notes: r.notes || '' });
      if (r.project_name && NAME_TO_KEY[r.project_name]) handleModalProjChange(r.project_name);
    } else {
      setForm(emptyForm());
    }
    setModalOpen(true);
  }

  async function saveModal() {
    setModalErr(null);
    const amt = parseFloat(form.amount);
    if (!form.proj) { setModalErr('Project is required.'); return; }
    if (isNaN(amt) || amt < 0) { setModalErr('Valid amount required.'); return; }
    const dateObj = form.date ? new Date(form.date) : new Date();
    const payload = {
      project_name: form.proj, section_name: form.section || null,
      site_id: form.siteId.trim() || null, amount: amt,
      invoice_date: form.date || null, month: dateObj.getMonth() + 1, year: dateObj.getFullYear(),
      status: form.status || 'Implemented - Pending ATP',
      notes: form.notes.trim() || null, added_by: currentUser?.full_name || '',
    };
    setModalSaving(true);
    try {
      if (editId) {
        const { error } = await supabase.from('revenue').update(payload).eq('id', editId);
        if (error) throw error;
        setRows(prev => prev.map(r => r.id === editId ? { ...r, ...payload } : r));
        showToast('Revenue updated');
      } else {
        const { data, error } = await supabase.from('revenue').insert(payload).select('id').single();
        if (error) throw error;
        setRows(prev => [{ id: (data as { id: string }).id, ...payload } as RevRow, ...prev]);
        showToast('Revenue added');
      }
      setModalOpen(false);
    } catch (e: unknown) { setModalErr(e instanceof Error ? e.message : String(e)); }
    finally { setModalSaving(false); }
  }

  function openDelModal(id: string) {
    const r = rows.find(x => x.id === id);
    setDelMsg(r ? `Delete revenue entry for ${r.project_name || '—'} — ${iqd(r.amount)}?` : 'Delete revenue entry?');
    setDelId(id);
  }

  async function confirmDelete() {
    if (!delId) return;
    setDelSaving(true);
    const { error } = await supabase.from('revenue').delete().eq('id', delId);
    if (error) { showToast('Error: ' + error.message); setDelSaving(false); return; }
    setRows(prev => prev.filter(r => r.id !== delId));
    setDelId(null); setDelSaving(false);
    showToast('Deleted');
  }

  async function handleSync() {
    setSyncing(true);
    try {
      await ensureSectionsLoaded();
      const allSecs = getSections().filter(s => !s.is_deleted);
      const { data: existingRev } = await supabase.from('revenue').select('project_name,site_id');
      const existing = new Set((existingRev || []).map((r: { project_name: string; site_id: string }) =>
        `${r.project_name}|||${r.site_id}`));
      const secIds = allSecs.map(s => s.id).filter(Boolean);
      if (!secIds.length) { showToast('No sections found'); return; }
      const { data: allRows } = await supabase.from('rows').select('section_id, data').in('section_id', secIds);
      const bySec: Record<string, { data: Record<string, unknown> }[]> = {};
      for (const row of (allRows || []) as { section_id: string; data: Record<string, unknown> }[]) {
        (bySec[row.section_id] ??= []).push(row);
      }
      type ToInsert = Omit<RevRow, 'id'>;
      const toInsert: ToInsert[] = [];
      for (const sec of allSecs) {
        const projName = PROJ_NAMES[sec.project_name as keyof typeof PROJ_NAMES] || sec.project_name;
        if (!projName) continue;
        const headers: string[] = sec.columns || [];
        const siteCol = headers.find(h => /^site.{0,3}id$/i.test(h)) || headers[0] || '';
        const impIdx = findImpColIdx(headers);
        const atpIdx = findAtpColIdx(headers);
        const impCol = impIdx >= 0 ? headers[impIdx] : null;
        const atpCol = atpIdx >= 0 ? headers[atpIdx] : null;
        const secLbl = sec.section_label || (SEC_LABELS as Record<string, string>)[sec.section_name] || sec.section_name;
        for (const row of bySec[sec.id] || []) {
          const siteId = siteCol ? String(row.data[siteCol] || '').trim() : '';
          const impDate = impCol ? String(row.data[impCol] || '').trim() : '';
          const atpStat = atpCol ? String(row.data[atpCol] || '').trim() : '';
          if (!siteId || !impDate) continue;
          const dateObj = new Date(impDate);
          if (isNaN(dateObj.getTime()) || dateObj < REVENUE_CUTOFF_DATE) continue;
          const key = `${projName}|||${siteId}`;
          if (existing.has(key)) continue;
          existing.add(key);
          toInsert.push({
            project_name: projName, section_name: secLbl || null, site_id: siteId,
            amount: 0, invoice_date: impDate, month: dateObj.getMonth() + 1, year: dateObj.getFullYear(),
            status: isAtpAccepted(atpStat) ? 'Accepted' : 'Implemented - Pending ATP',
            notes: atpStat || null, added_by: currentUser?.full_name || '',
          });
        }
      }
      if (!toInsert.length) { showToast('All up to date — no new entries needed'); return; }
      const newRows: RevRow[] = [];
      let inserted = 0;
      for (let i = 0; i < toInsert.length; i += 500) {
        const chunk = toInsert.slice(i, i + 500);
        const { data, error } = await supabase.from('revenue').insert(chunk).select('id');
        if (error) throw error;
        inserted += (data as { id: string }[])?.length || 0;
        (data as { id: string }[])?.forEach((r, j) => newRows.push({ id: r.id, ...chunk[j] } as RevRow));
      }
      setRows(prev => [...newRows, ...prev]);
      showToast(`Created ${inserted} new revenue entr${inserted === 1 ? 'y' : 'ies'}`);
    } catch (e: unknown) { showToast('Sync failed: ' + (e instanceof Error ? e.message : String(e))); }
    finally { setSyncing(false); }
  }

  async function handleFixSections() {
    setFixing(true);
    try {
      await ensureSectionsLoaded();
      const allSecs = getSections().filter(s => !s.is_deleted);
      const secIds = allSecs.map(s => s.id).filter(Boolean);
      if (!secIds.length) { showToast('No sections found'); return; }
      const { data: allRows } = await supabase.from('rows').select('section_id, data').in('section_id', secIds);
      const bySec: Record<string, { data: Record<string, unknown> }[]> = {};
      for (const row of (allRows || []) as { section_id: string; data: Record<string, unknown> }[]) {
        (bySec[row.section_id] ??= []).push(row);
      }
      const siteToSec: Record<string, string> = {};
      for (const sec of allSecs) {
        const projName = PROJ_NAMES[sec.project_name as keyof typeof PROJ_NAMES] || sec.project_name;
        if (!projName) continue;
        const headers: string[] = sec.columns || [];
        const siteCol = headers.find(h => /^site.{0,3}id$/i.test(h)) || headers[0] || '';
        const secLbl = sec.section_label || (SEC_LABELS as Record<string, string>)[sec.section_name] || sec.section_name;
        for (const row of bySec[sec.id] || []) {
          const siteId = siteCol ? String(row.data[siteCol] || '').trim() : '';
          if (siteId && secLbl) siteToSec[`${projName}|||${siteId}`] = secLbl;
        }
      }
      const { data: missing } = await supabase.from('revenue').select('id,project_name,site_id').is('section_name', null);
      if (!missing?.length) { showToast('No sections needed fixing'); return; }
      let updated = 0;
      for (const r of missing as { id: string; project_name: string; site_id: string }[]) {
        const lbl = siteToSec[`${r.project_name}|||${r.site_id}`];
        if (!lbl) continue;
        const { error } = await supabase.from('revenue').update({ section_name: lbl }).eq('id', r.id);
        if (error) throw error;
        setRows(prev => prev.map(x => x.id === r.id ? { ...x, section_name: lbl } : x));
        updated++;
      }
      showToast(updated === 0 ? 'No sections needed fixing'
        : `Fixed section for ${updated} entr${updated === 1 ? 'y' : 'ies'}`);
    } catch (e: unknown) { showToast('Fix sections failed: ' + (e instanceof Error ? e.message : String(e))); }
    finally { setFixing(false); }
  }

  async function handleExport() {
    const data = filteredRows();
    if (!data.length) { showToast('No data to export'); return; }
    try {
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('revenue');
      ws.addRow(['Date', 'Project', 'Site ID', 'Amount (IQD)', 'Status', 'Notes', 'Added By']);
      for (const r of data) ws.addRow([r.invoice_date, r.project_name, r.site_id, r.amount, r.status, r.notes, r.added_by]);
      const buf = await wb.xlsx.writeBuffer();
      const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      Object.assign(document.createElement('a'), { href: url, download: `Finance_revenue_${new Date().toISOString().slice(0,10)}.xlsx` }).click();
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
        <button className={styles.btnGhost} onClick={handleSync} disabled={syncing}>
          {syncing ? 'Syncing…' : '↑ Sync Revenue'}
        </button>
        <button className={styles.btnGhost} onClick={handleFixSections} disabled={fixing}>
          {fixing ? 'Fixing…' : '✎ Fix Sections'}
        </button>
        <button className={styles.btnGhost} onClick={handleExport}>Export</button>
        <button className={styles.btnAccent} onClick={() => openModal(null)}>+ Add Revenue</button>
      </div>

      {loading && <div className={styles.loadingBar}>Loading…</div>}
      {loadError && <div className={styles.errorMsg}>{loadError}</div>}

      {!loading && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Date</th><th>Project</th><th>Section</th><th>Site ID</th>
                <th className={styles.num}>Amount (IQD)</th><th>Status</th>
                <th>Notes</th><th>Added By</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0
                ? <tr><td colSpan={9} className={styles.empty}>No revenue records.</td></tr>
                : filtered.map(r => {
                  const isAcc = r.status === 'Accepted';
                  const isPend = r.status === 'Implemented - Pending ATP';
                  return (
                    <tr key={r.id} style={isAcc ? { background: '#dcfce7' } : isPend ? { background: '#fefce8' } : undefined}>
                      <td style={{ whiteSpace: 'nowrap' }}>{r.invoice_date || ''}</td>
                      <td>{r.project_name || ''}</td>
                      <td style={{ color: 'var(--slate-500)', fontSize: 12 }}>{r.section_name || '—'}</td>
                      <td>{r.site_id || ''}</td>
                      <td className={styles.num}>
                        <input
                          type="number" min={0}
                          key={`${r.id}_${r.amount}`}
                          defaultValue={r.amount ?? 0}
                          className={styles.amtInput}
                          onBlur={e => { const v = parseFloat(e.target.value); updateAmount(r.id, isNaN(v) ? 0 : v); }}
                          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                        />
                      </td>
                      <td>
                        {isAcc ? <span className={`${styles.badge} ${styles.badgeGreen}`}>Accepted</span>
                          : isPend ? <span className={`${styles.badge} ${styles.badgeAmber}`}>Pending ATP</span>
                          : <span style={{ color: 'var(--slate-400)', fontSize: 12 }}>{r.status || ''}</span>}
                      </td>
                      <td className={styles.noteCell}>{r.notes || ''}</td>
                      <td style={{ color: 'var(--slate-500)', whiteSpace: 'nowrap' }}>{r.added_by || ''}</td>
                      <td>
                        <div className={styles.actions}>
                          <button className={styles.actBtn} onClick={() => openModal(r.id)} title="Edit"><PenIcon /></button>
                          <button className={`${styles.actBtn} ${styles.actBtnDel}`} onClick={() => openDelModal(r.id)} title="Delete"><TrashIcon /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              }
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4}><strong>Total (filtered)</strong></td>
                <td className={styles.num} style={{ color: '#16a34a' }}><strong>{iqd(total)}</strong></td>
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
            <div className={styles.modalTitle}>{editId ? 'Edit Revenue' : 'Add Revenue'}</div>
            {modalErr && <div className={styles.modalErr}>{modalErr}</div>}
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Project</label>
              <select className={styles.formSel} value={form.proj} autoFocus
                onChange={e => handleModalProjChange(e.target.value)}>
                <option value="">— Select project —</option>
                {FIN_PROJECTS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Section</label>
              <select className={styles.formSel} value={form.section}
                onChange={e => handleModalSecChange(e.target.value)}>
                <option value="">— Select section —</option>
                {modalSecs.map(s => <option key={s.id} value={s.label}>{s.label}</option>)}
              </select>
            </div>
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Site ID</label>
              <input list="rev-sites-list" className={styles.formInput} placeholder="Site ID"
                value={form.siteId} onChange={e => setForm(f => ({ ...f, siteId: e.target.value }))} />
              <datalist id="rev-sites-list">
                {modalSites.map(s => <option key={s} value={s} />)}
              </datalist>
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
              <label className={styles.formLabel}>Status</label>
              <select className={styles.formSel} value={form.status}
                onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                <option value="Implemented - Pending ATP">Implemented - Pending ATP</option>
                <option value="Accepted">Accepted</option>
              </select>
            </div>
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Notes</label>
              <textarea className={styles.formTextarea} rows={2} value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </div>
            <div className={styles.modalActions}>
              <button className={styles.btnPrimary} disabled={modalSaving} onClick={saveModal}>
                {modalSaving ? 'Saving…' : editId ? 'Save Changes' : 'Add Revenue'}
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
