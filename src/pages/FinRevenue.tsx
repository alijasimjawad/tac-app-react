import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { isAtpAccepted, findImpColIdx, findAtpColIdx, PROJ_NAMES, SEC_LABELS } from './NetworkScopes';
import { ensureSectionsLoaded, getSections, invalidateSections } from '../lib/sectionsCache';
import { ensureProjectsLoaded, getProjectNames, getProjectNameToKeyMap } from '../lib/projectsCache';
import { logActivity } from '../lib/activityLog';
import { sendPushToRoles } from '../lib/pushNotify';
import {
  type StageDone, loadStageMap as loadStageMapShared, stagePct, stuckAtLabel,
  CLEARANCE_COL_NAME, FINAL_ATP_COL_NAME,
  findDeliveryColIdx, findInstallColIdx, findIntegrationColIdx, findClearanceColIdx, findFinalAtpColIdx,
} from '../lib/revenueStages';
import styles from './FinPages.module.css';

const FIN_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const REVENUE_CUTOFF_DATE = new Date('2026-07-01T00:00:00');

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
  const [backfilling, setBackfilling] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [FIN_PROJECTS, setFinProjects] = useState<string[]>([]);
  const [NAME_TO_KEY, setNameToKey] = useState<Record<string, string>>({});
  const [stageMap, setStageMap] = useState<Record<string, StageDone>>({});
  const [stageMapLoading, setStageMapLoading] = useState(false);
  const [incompleteOnly, setIncompleteOnly] = useState(false);
  const [pctSort, setPctSort] = useState<'asc' | 'desc' | null>(null);

  function showToast(msg: string) {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 3200);
  }

  useEffect(() => {
    ensureProjectsLoaded().then(() => {
      setFinProjects(getProjectNames());
      setNameToKey(getProjectNameToKeyMap());
    });
  }, []);

  useEffect(() => {
    if (hasPerm('view_fin_revenue')) { loadData(); loadStageMap(); }
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

  /** Builds the project|||site_id -> StageDone lookup from live Network Scopes data. */
  async function loadStageMap() {
    setStageMapLoading(true);
    try {
      setStageMap(await loadStageMapShared());
    } catch {
      // Non-fatal — Current Revenue just falls back to 0/unknown for this session.
    } finally {
      setStageMapLoading(false);
    }
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
        void sendPushToRoles(['admin'], 'Revenue Updated', `Revenue updated for ${form.proj}`);
        logActivity({
          userFullName: currentUser?.full_name ?? currentUser?.username,
          action: 'Edited Revenue',
          projectName: form.proj,
          details: `Edited Revenue: ${form.proj} ${iqd(amt)}`,
        });
      } else {
        const { data, error } = await supabase.from('revenue').insert(payload).select('id').single();
        if (error) throw error;
        setRows(prev => [{ id: (data as { id: string }).id, ...payload } as RevRow, ...prev]);
        showToast('Revenue added');
        void sendPushToRoles(['admin'], 'Revenue Added', `Revenue entry added for ${form.proj}`);
        logActivity({
          userFullName: currentUser?.full_name ?? currentUser?.username,
          action: 'Added Revenue',
          projectName: form.proj,
          details: `Added Revenue: ${form.proj} ${iqd(amt)}`,
        });
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
    const r = rows.find(x => x.id === delId);
    const { error } = await supabase.from('revenue').delete().eq('id', delId);
    if (error) { showToast('Error: ' + error.message); setDelSaving(false); return; }
    setRows(prev => prev.filter(r => r.id !== delId));
    setDelId(null); setDelSaving(false);
    showToast('Deleted');
    void sendPushToRoles(['admin'], 'Revenue Deleted', `Revenue entry removed for ${r?.project_name || 'a project'}`);
    logActivity({
      userFullName: currentUser?.full_name ?? currentUser?.username,
      action: 'Deleted Revenue',
      projectName: r?.project_name,
      details: `Deleted Revenue: ${r?.project_name || ''} ${iqd(r?.amount)} (Site: ${r?.site_id || '—'})`,
    });
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

  /** One-click backfill: adds any missing of the 6 pipeline-stage columns
   *  (Delivery, Installation, Integration Status, ATP Status, Clearance & Tools,
   *  Final ATP) to every section, so Current Revenue can track all stages —
   *  including older/empty sections created before the default template
   *  was updated to include them. */
  async function handleBackfillStageColumns() {
    setBackfilling(true);
    try {
      await ensureSectionsLoaded();
      const allSecs = getSections().filter(s => !s.is_deleted);
      if (!allSecs.length) { showToast('No sections found'); return; }
      let updatedSections = 0;
      for (const sec of allSecs) {
        const headers = sec.columns || [];
        const missing: string[] = [];
        if (findDeliveryColIdx(headers) < 0) missing.push('Delivery');
        if (findInstallColIdx(headers) < 0) missing.push('Installation');
        if (findIntegrationColIdx(headers) < 0) missing.push('Integration Status');
        if (findClearanceColIdx(headers) < 0) missing.push(CLEARANCE_COL_NAME);
        if (findFinalAtpColIdx(headers) < 0) missing.push(FINAL_ATP_COL_NAME);
        if (!missing.length) continue;
        const newCols = [...headers, ...missing];
        const newCustomCols = [...(sec.custom_columns || []), ...missing];
        const { error } = await supabase.from('sections')
          .update({ columns: newCols, custom_columns: newCustomCols })
          .eq('id', sec.id);
        if (error) throw error;
        updatedSections++;
      }
      invalidateSections();
      showToast(updatedSections === 0
        ? 'All sections already have the stage columns'
        : `Added stage columns to ${updatedSections} section${updatedSections === 1 ? '' : 's'}`);
      logActivity({
        userFullName: currentUser?.full_name ?? currentUser?.username,
        action: 'Backfilled Revenue Stage Columns',
        details: `Added missing pipeline-stage columns to ${updatedSections} section(s)`,
      });
      await loadStageMap();
    } catch (e: unknown) { showToast('Backfill failed: ' + (e instanceof Error ? e.message : String(e))); }
    finally { setBackfilling(false); }
  }

  async function handleExport() {
    const data = filteredRows();
    if (!data.length) { showToast('No data to export'); return; }
    try {
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('revenue');
      ws.addRow(['Date', 'Project', 'Site ID', 'Amount (IQD)', 'Current Revenue (IQD)', 'Outstanding (IQD)', '% Complete', 'Status', 'Notes', 'Added By']);
      for (const r of data) ws.addRow([r.invoice_date, r.project_name, r.site_id, r.amount, Math.round(currentRevenueOf(r)), Math.round(outstandingOf(r)), Math.round(pctOf(r) * 100), r.status, r.notes, r.added_by]);
      const buf = await wb.xlsx.writeBuffer();
      const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      Object.assign(document.createElement('a'), { href: url, download: `Finance_revenue_${new Date().toISOString().slice(0,10)}.xlsx` }).click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) { showToast('Export failed: ' + (e instanceof Error ? e.message : String(e))); }
  }

  function currentRevenueOf(r: RevRow): number {
    if (!r.site_id) return 0;
    const sd = stageMap[`${r.project_name}|||${r.site_id}`];
    return (+r.amount || 0) * stagePct(sd);
  }

  /** Amount invoiced but not yet earned (not yet recognized as Current Revenue). */
  function outstandingOf(r: RevRow): number {
    return (+r.amount || 0) - currentRevenueOf(r);
  }

  function pctOf(r: RevRow): number {
    return stagePct(r.site_id ? stageMap[`${r.project_name}|||${r.site_id}`] : undefined);
  }

  const baseFiltered = filteredRows();
  const incompleteCount = baseFiltered.filter(r => pctOf(r) < 1).length;
  let filtered = incompleteOnly ? baseFiltered.filter(r => pctOf(r) < 1) : baseFiltered;
  if (pctSort) {
    filtered = [...filtered].sort((a, b) => pctSort === 'asc' ? pctOf(a) - pctOf(b) : pctOf(b) - pctOf(a));
  }
  const total = filtered.reduce((s, r) => s + (+r.amount || 0), 0);
  const totalCurrentRevenue = filtered.reduce((s, r) => s + currentRevenueOf(r), 0);
  const totalOutstanding = filtered.reduce((s, r) => s + outstandingOf(r), 0);
  const years = getYears();

  // KPI strip always reflects the Project/Month/Year filters only, not the
  // "Incomplete only" toggle — otherwise the summary numbers would shift
  // under you every time you flip that toggle.
  const fullyRevenuedCount = baseFiltered.length - incompleteCount;
  const totalCurrentRevenueAll = baseFiltered.reduce((s, r) => s + currentRevenueOf(r), 0);
  const totalOutstandingAll = baseFiltered.reduce((s, r) => s + outstandingOf(r), 0);
  const overallPct = baseFiltered.length ? Math.round((fullyRevenuedCount / baseFiltered.length) * 100) : 0;

  return (
    <div className={styles.page}>
      {!loading && baseFiltered.length > 0 && (
        <div className={styles.kpiRow}>
          <div className={styles.kpiCard}>
            <div className={styles.kpiLabel}>Sites Fully Revenued</div>
            <div className={`${styles.kpiValue} ${styles.kpiGreen}`}>{fullyRevenuedCount} / {baseFiltered.length}</div>
            <div className={styles.kpiSub}>{overallPct}% of filtered sites</div>
          </div>
          <div className={styles.kpiCard}>
            <div className={styles.kpiLabel}>Incomplete Sites</div>
            <div className={`${styles.kpiValue} ${incompleteCount > 0 ? styles.kpiAmber : styles.kpiGreen}`}>{incompleteCount}</div>
            <div className={styles.kpiSub}>not yet fully revenued</div>
          </div>
          <div className={styles.kpiCard}>
            <div className={styles.kpiLabel}>Total Outstanding</div>
            <div className={`${styles.kpiValue} ${totalOutstandingAll > 0 ? styles.kpiRed : styles.kpiGreen}`}>{iqd(totalOutstandingAll)}</div>
            <div className={styles.kpiSub}>invoiced but not yet earned</div>
          </div>
          <div className={styles.kpiCard}>
            <div className={styles.kpiLabel}>Total Current Revenue</div>
            <div className={`${styles.kpiValue} ${styles.kpiBlue}`}>{iqd(totalCurrentRevenueAll)}</div>
            <div className={styles.kpiSub}>recognized to date</div>
          </div>
        </div>
      )}
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
        <button
          className={styles.btnGhost}
          style={incompleteOnly ? { background: '#fef3c7', borderColor: '#f59e0b', color: '#92400e', fontWeight: 600 } : undefined}
          onClick={() => setIncompleteOnly(v => !v)}
          title="Show only sites that aren't fully revenued yet"
        >
          {incompleteOnly ? '✓ ' : ''}Incomplete only{incompleteCount > 0 ? ` (${incompleteCount})` : ''}
        </button>
        <div className={styles.spacer} />
        <button className={styles.btnGhost} onClick={() => { loadData(); loadStageMap(); }}>↺ Refresh</button>
        {hasPerm('fin_revenue_sync') && (
          <button className={styles.btnGhost} onClick={handleSync} disabled={syncing}>
            {syncing ? 'Syncing…' : '↑ Sync Revenue'}
          </button>
        )}
        {hasPerm('fin_revenue_fix_sections') && (
          <button className={styles.btnGhost} onClick={handleFixSections} disabled={fixing}>
            {fixing ? 'Fixing…' : '✎ Fix Sections'}
          </button>
        )}
        {hasPerm('fin_revenue_sync') && (
          <button className={styles.btnGhost} onClick={handleBackfillStageColumns} disabled={backfilling}
            title="Adds 'Clearance & Tools' and 'Final ATP' columns to any section missing them">
            {backfilling ? 'Adding…' : '+ Add Stage Columns'}
          </button>
        )}
        {hasPerm('fin_revenue_export') && (
          <button className={styles.btnGhost} onClick={handleExport}>Export</button>
        )}
        {hasPerm('fin_revenue_add') && (
          <button className={styles.btnAccent} onClick={() => openModal(null)}>+ Add Revenue</button>
        )}
      </div>

      {loading && <div className={styles.loadingBar}>Loading…</div>}
      {loadError && <div className={styles.errorMsg}>{loadError}</div>}

      {!loading && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Date</th><th>Project</th><th>Section</th><th>Site ID</th>
                <th className={styles.num}>Amount (IQD)</th>
                <th
                  className={styles.num}
                  style={{ cursor: 'pointer', userSelect: 'none' }}
                  onClick={() => setPctSort(s => s === 'asc' ? 'desc' : s === 'desc' ? null : 'asc')}
                  title="Click to sort by % complete"
                >
                  Current Revenue (IQD){stageMapLoading ? ' …' : ''}
                  {pctSort === 'asc' ? ' ▲' : pctSort === 'desc' ? ' ▼' : ''}
                </th>
                <th className={styles.num}>Outstanding (IQD)</th>
                <th>Status</th>
                <th>Added By</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0
                ? <tr><td colSpan={10} className={styles.empty}>No revenue records.</td></tr>
                : filtered.map(r => {
                  const sdForStatus = r.site_id ? stageMap[`${r.project_name}|||${r.site_id}`] : undefined;
                  const finalAtpStatus = sdForStatus?.finalAtpStatus || '';
                  const isAcc = isAtpAccepted(finalAtpStatus);
                  const isRej = /^rejected$/i.test(finalAtpStatus.trim());
                  const isPend = !isAcc && !isRej;
                  const pctRow = stagePct(sdForStatus);
                  const isIncomplete = pctRow < 1;
                  return (
                    <tr key={r.id} style={isAcc ? { background: '#dcfce7' } : isRej ? { background: '#fee2e2' } : isPend ? { background: '#fefce8' } : undefined}>
                      <td style={{ whiteSpace: 'nowrap', borderLeft: isIncomplete ? '4px solid #f59e0b' : undefined }}
                        title={isIncomplete ? 'Not fully revenued yet' : undefined}>
                        {r.invoice_date || ''}
                      </td>
                      <td>{r.project_name || ''}</td>
                      <td style={{ color: 'var(--slate-500)', fontSize: 12 }}>{r.section_name || '—'}</td>
                      <td>{r.site_id || ''}</td>
                      <td className={styles.num}>
                        <input
                          type="number" min={0}
                          key={`${r.id}_${r.amount}`}
                          defaultValue={r.amount ?? 0}
                          className={styles.amtInput}
                          disabled={!hasPerm('fin_revenue_edit')}
                          onBlur={e => { const v = parseFloat(e.target.value); updateAmount(r.id, isNaN(v) ? 0 : v); }}
                          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                        />
                      </td>
                      <td className={styles.num}>
                        {(() => {
                          const sd = r.site_id ? stageMap[`${r.project_name}|||${r.site_id}`] : undefined;
                          if (!sd) return <span style={{ color: 'var(--slate-400)', fontSize: 12 }}>—</span>;
                          const pct = stagePct(sd);
                          const pctColor = pct >= 1 ? '#16a34a' : pct >= 0.5 ? '#d97706' : '#dc2626';
                          return (
                            <div>
                              <div>{iqd(currentRevenueOf(r))}</div>
                              <div style={{ color: pctColor, fontSize: 11, fontWeight: pct < 1 ? 700 : 500 }}>
                                {pct >= 1 ? '✓ 100% complete' : `${Math.round(pct * 100)}% complete`}
                              </div>
                              {pct < 1 && stuckAtLabel(sd) && (
                                <div style={{ color: 'var(--slate-500)', fontSize: 10, marginTop: 1 }}>
                                  Stuck at: {stuckAtLabel(sd)}
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                      <td className={styles.num}>
                        {(() => {
                          const out = outstandingOf(r);
                          if (out <= 0) return <span style={{ color: 'var(--slate-400)', fontSize: 12 }}>—</span>;
                          return <span style={{ color: '#dc2626', fontWeight: 600 }}>{iqd(out)}</span>;
                        })()}
                      </td>
                      <td>
                        {isAcc ? <span className={`${styles.badge} ${styles.badgeGreen}`}>Accepted</span>
                          : isRej ? <span className={`${styles.badge} ${styles.badgeRed}`}>Rejected</span>
                          : <span className={`${styles.badge} ${styles.badgeAmber}`}>{finalAtpStatus || 'Pending ATP'}</span>}
                      </td>
                      <td style={{ color: 'var(--slate-500)', whiteSpace: 'nowrap' }}>{r.added_by || ''}</td>
                      <td>
                        <div className={styles.actions}>
                          {hasPerm('fin_revenue_edit') && (
                            <button className={styles.actBtn} onClick={() => openModal(r.id)} title="Edit"><PenIcon /></button>
                          )}
                          {hasPerm('fin_revenue_delete') && (
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
                <td colSpan={4}><strong>Total (filtered)</strong></td>
                <td className={styles.num} style={{ color: '#16a34a' }}><strong>{iqd(total)}</strong></td>
                <td className={styles.num} style={{ color: '#2563eb' }}><strong>{iqd(totalCurrentRevenue)}</strong></td>
                <td className={styles.num} style={{ color: '#dc2626' }}><strong>{iqd(totalOutstanding)}</strong></td>
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
