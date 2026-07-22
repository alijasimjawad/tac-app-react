import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { ensureSectionsLoaded, getSections, invalidateSections } from '../lib/sectionsCache';
import styles from './NetworkScopes.module.css';

// ── Constants ─────────────────────────────────────────────────────────────────

export const PROJ_NAMES: Record<string, string> = {
  zain: 'Zain Project', nokia: 'Nokia Project', huawei: 'Huawei Project', ipt: 'IPT Project',
};
export const SEC_LABELS: Record<string, string> = { ftk: 'FTK', tdd: 'TDD', addsector: 'Add Sector' };

const LEGACY_DEFAULT_COLS = new Set([
  'RFTI', 'Delivery', 'Installation',
  'Status of Integration', 'Integration date', 'Integration Date',
  'TDD', 'Subcon',
]);

const DEFAULT_PAGE_SIZE = 50;

const STATUS_OPTIONS  = ['', 'Integrated', 'Reachable', 'Not Integrated', 'Pending'];
const SUBCON_OPTIONS  = ['', 'ATC', 'IPT', 'KCT', 'MFC', 'MRC', 'Metco', 'Oraxel', 'SPTECH', 'Shabakat', 'TAC', 'horizon'];
const ATP_OPTIONS     = ['Pending', 'Accepted', 'Rejected'];
const DATE_KEYWORDS   = ['date', 'rfti', 'delivery', 'installation', 'imp date', 'imp_date'];

// ── Types ─────────────────────────────────────────────────────────────────────

interface GridRow {
  id: string;
  cells: string[];
}

interface DdState {
  colIdx: number;
  pos: { top: number; left: number };
  search: string;
  allValues: string[];
  countMap: Record<string, number>;
}

interface ModalState {
  rowId: string | null;
  cells: string[];
}

interface ImportPending {
  headers: string[];
  rows: string[][];
  fileName: string;
}

// ── KPI helpers ───────────────────────────────────────────────────────────────

export function isAtpAccepted(val: string): boolean {
  const v = val.trim();
  return (
    /^accepted$/i.test(v) ||
    /^accepted[\s._-]*wcl$/i.test(v) ||
    /^waiting[\s._-]*cl$/i.test(v) ||
    /^wcl$/i.test(v) ||
    /^accepted[\s._-]*waiting[\s._-]*cl$/i.test(v)
  );
}

export function findImpColIdx(headers: string[]): number {
  return headers.findIndex(
    h => /imp.*date/i.test(h) || /^install(ation)?$/i.test(h.trim()) ||
         /install/i.test(h)   || /integrat\w*[\s._-]*date/i.test(h),
  );
}

export function findAtpColIdx(headers: string[]): number {
  return headers.findIndex(
    h => /^atp[\s._-]*status$/i.test(h.trim()) || /^atp$/i.test(h.trim()) ||
         (/atp/i.test(h) && /status/i.test(h)),
  );
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function parseToDateInput(v: string): string {
  if (!v) return '';
  const s = v.trim();
  if (!s || s === '—') return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const fmt = (d: Date) => {
    if (!d || isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const m1 = s.match(/^(\d{1,2})[\s\-/]([A-Za-z]+)[\s\-/](\d{2,4})$/);
  if (m1) {
    let yr = m1[3];
    if (yr.length === 2) yr = (parseInt(yr) >= 50 ? '19' : '20') + yr;
    return fmt(new Date(`${m1[2]} ${m1[1]}, ${yr}`));
  }
  const m2 = s.match(/^(\d{1,2})[\s\-/]([A-Za-z]+)$/);
  if (m2) return fmt(new Date(`${m2[2]} ${m2[1]}, ${new Date().getFullYear()}`));
  const m3 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m3) return fmt(new Date(`${m3[3]}-${m3[2].padStart(2, '0')}-${m3[1].padStart(2, '0')}`));
  const m4 = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m4) return fmt(new Date(`${m4[1]}-${m4[2].padStart(2, '0')}-${m4[3].padStart(2, '0')}`));
  return fmt(new Date(s));
}

// ── Main component ────────────────────────────────────────────────────────────

export default function NetworkScopes() {
  const { proj, sec } = useParams<{ proj: string; sec: string }>();
  const { hasPerm } = useAuth();

  // Grid data
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<GridRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [dropFilters, setDropFilters] = useState<Record<number, Set<string>>>({});
  const [chipFilters, setChipFilters] = useState<Set<string>>(new Set());
  const [secStatFilter, setSecStatFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Pagination
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number | 'all'>(DEFAULT_PAGE_SIZE);

  // Column dropdown
  const [ddState, setDdState] = useState<DdState | null>(null);
  const ddRef = useRef<HTMLDivElement>(null);

  // Site detail modal
  const [modal, setModal] = useState<ModalState | null>(null);
  const [modalSaving, setModalSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  // Import
  const [importPending, setImportPending] = useState<ImportPending | null>(null);
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  // Toast
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Column management
  const [colMenu, setColMenu] = useState<{ colIdx: number; pos: { top: number; left: number } } | null>(null);
  const colMenuRef = useRef<HTMLDivElement>(null);
  const [addColModal, setAddColModal] = useState(false);
  const [addColName, setAddColName] = useState('');
  const [renameColModal, setRenameColModal] = useState<{ colIdx: number; name: string } | null>(null);
  const [deleteColModal, setDeleteColModal] = useState<{ colIdx: number } | null>(null);
  const [colOpSaving, setColOpSaving] = useState(false);

  // Bulk update
  const [bulkModal, setBulkModal] = useState(false);
  const [bulkTab, setBulkTab] = useState<'same' | 'diff'>('same');
  const [bulkColIdx, setBulkColIdx] = useState(0);
  const [bulkValue, setBulkValue] = useState('');
  const [bulkSiteIds, setBulkSiteIds] = useState('');
  const [bulkDiffCols, setBulkDiffCols] = useState<number[]>([1]);
  const [bulkDiffData, setBulkDiffData] = useState('');
  const [bulkSaving, setBulkSaving] = useState(false);

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  // ── Load section data ──────────────────────────────────────────────────────

  const loadSection = useCallback(async () => {
    if (!proj || !sec) return;
    setLoading(true);
    setError(null);
    setColumns([]);
    setRows([]);

    await ensureSectionsLoaded();
    const sections = getSections();
    const secMeta = sections.find(
      s => s.project_name === proj && s.section_name === sec && !s.is_deleted,
    );

    if (!secMeta) { setLoading(false); return; }

    const customCols = new Set<string>(secMeta.custom_columns || []);
    const cols = (secMeta.columns || []).filter(
      c => !LEGACY_DEFAULT_COLS.has(c) || customCols.has(c),
    );

    const { data: rowData, error: rowErr } = await supabase
      .from('rows')
      .select('id, data, row_order')
      .eq('section_id', secMeta.id)
      .order('row_order', { ascending: true });

    if (rowErr) { setError(rowErr.message); setLoading(false); return; }

    const gridRows = (rowData ?? []).map(r => ({
      id: r.id as string,
      cells: cols.map(col => String((r.data as Record<string, unknown>)?.[col] ?? '')),
    }));

    setColumns(cols);
    setRows(gridRows);
    setLoading(false);
  }, [proj, sec]);

  useEffect(() => {
    setDropFilters({});
    setChipFilters(new Set());
    setSecStatFilter(null);
    setSearchQuery('');
    setPage(1);
    setPageSize(DEFAULT_PAGE_SIZE);
    setDdState(null);
    setColMenu(null);
    setModal(null);
    setDeleteConfirm(false);
    setImportPending(null);
    loadSection();
  }, [loadSection]);

  // Close column filter dropdown on outside click
  useEffect(() => {
    if (!ddState) return;
    function onOutside(e: MouseEvent) {
      if (ddRef.current && !ddRef.current.contains(e.target as Node)) setDdState(null);
    }
    setTimeout(() => document.addEventListener('click', onOutside), 10);
    return () => document.removeEventListener('click', onOutside);
  }, [ddState]);

  // Close column context menu on outside click
  useEffect(() => {
    if (!colMenu) return;
    function onOutside(e: MouseEvent) {
      if (colMenuRef.current && !colMenuRef.current.contains(e.target as Node)) setColMenu(null);
    }
    setTimeout(() => document.addEventListener('click', onOutside), 10);
    return () => document.removeEventListener('click', onOutside);
  }, [colMenu]);

  // ── Modal handlers ─────────────────────────────────────────────────────────

  function openAddModal() {
    setModal({ rowId: null, cells: columns.map(() => '') });
  }

  function openRowModal(row: GridRow) {
    setModal({ rowId: row.id, cells: [...row.cells] });
  }

  function updateModalCell(ci: number, value: string) {
    setModal(prev => {
      if (!prev) return null;
      const cells = [...prev.cells];
      cells[ci] = value;
      return { ...prev, cells };
    });
  }

  async function saveModal() {
    if (!modal || !proj || !sec) return;
    setModalSaving(true);

    await ensureSectionsLoaded();
    const secMeta = getSections().find(s => s.project_name === proj && s.section_name === sec && !s.is_deleted);
    if (!secMeta) { showToast('Section not found.', false); setModalSaving(false); return; }

    const data: Record<string, string> = {};
    columns.forEach((col, i) => { data[col] = modal.cells[i] ?? ''; });

    let saveErr: { message: string } | null = null;
    if (modal.rowId === null) {
      const { error } = await supabase.from('rows').insert({
        section_id: secMeta.id, data, row_order: rows.length,
      });
      saveErr = error;
    } else {
      const { error } = await supabase.from('rows')
        .update({ data, updated_at: new Date().toISOString() })
        .eq('id', modal.rowId);
      saveErr = error;
    }

    setModalSaving(false);
    if (saveErr) { showToast('Save failed: ' + saveErr.message, false); return; }
    const isNew = modal.rowId === null;
    setModal(null);
    showToast(isNew ? 'Site added' : 'Changes saved', true);
    await loadSection();
  }

  async function confirmDelete() {
    if (!modal?.rowId) return;
    setModalSaving(true);
    const { error } = await supabase.from('rows').delete().eq('id', modal.rowId);
    setModalSaving(false);
    if (error) { showToast('Delete failed: ' + error.message, false); return; }
    setDeleteConfirm(false);
    setModal(null);
    showToast('Site deleted', true);
    await loadSection();
  }

  // ── Import handlers ────────────────────────────────────────────────────────

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (importInputRef.current) importInputRef.current.value = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const wb = XLSX.read(ev.target!.result as ArrayBuffer, { type: 'array', cellDates: false });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, {
          header: 1, raw: false, dateNF: 'yyyy-mm-dd', defval: '',
        });

        if (!raw || raw.length < 1) { showToast('Excel file appears to be empty', false); return; }
        const impHeaders = (raw[0] as unknown[]).map(h => String(h ?? '').trim());
        if (impHeaders.every(h => h === '')) { showToast('No headers found in row 1', false); return; }

        const impRows: string[][] = (raw.slice(1) as unknown[][])
          .filter(r => (r as unknown[]).some(v => String(v ?? '').trim() !== ''))
          .map(r => impHeaders.map((_, i) => String((r as unknown[])[i] ?? '')));

        if (impRows.length === 0) { showToast('No data rows found in the file', false); return; }

        const pending: ImportPending = { headers: impHeaders, rows: impRows, fileName: file.name };

        if (rows.length > 0) {
          setImportPending(pending);
        } else {
          doImportWith(pending, 'replace');
        }
      } catch (err) {
        showToast('Failed to read Excel file: ' + (err as Error).message, false);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  async function doImportWith(pending: ImportPending, mode: 'replace' | 'append') {
    setImportPending(null);
    setImporting(true);

    const { headers: impHeaders, rows: impRows } = pending;

    await ensureSectionsLoaded();
    const secMeta = getSections().find(s => s.project_name === proj && s.section_name === sec && !s.is_deleted);
    if (!secMeta) {
      showToast('Section not found', false);
      setImporting(false);
      return;
    }

    let finalHeaders: string[];
    let allRowCells: string[][];

    if (mode === 'replace') {
      finalHeaders = impHeaders;
      allRowCells = impRows;
    } else {
      const existingHeaders = columns;
      const merged = [...existingHeaders];
      impHeaders.forEach(h => { if (!merged.includes(h)) merged.push(h); });

      const realigned = rows.map(r =>
        merged.map(h => {
          const idx = existingHeaders.indexOf(h);
          return idx >= 0 ? (r.cells[idx] ?? '') : '';
        }),
      );
      const incoming = impRows.map(row =>
        merged.map(h => {
          const idx = impHeaders.indexOf(h);
          return idx >= 0 ? (row[idx] ?? '') : '';
        }),
      );
      finalHeaders = merged;
      allRowCells = [...realigned, ...incoming];
    }

    const customCols = [...finalHeaders];

    try {
      const { error: colErr } = await supabase.from('sections')
        .update({ columns: finalHeaders, custom_columns: customCols })
        .eq('id', secMeta.id);
      if (colErr) throw new Error('Column update failed: ' + colErr.message);

      invalidateSections();

      const { error: delErr } = await supabase.from('rows').delete().eq('section_id', secMeta.id);
      if (delErr) throw new Error('Row delete failed: ' + delErr.message);

      const toInsert = allRowCells.map((cells, i) => ({
        section_id: secMeta.id,
        data: Object.fromEntries(finalHeaders.map((col, ci) => [col, cells[ci] ?? ''])),
        row_order: i,
      }));
      for (let i = 0; i < toInsert.length; i += 500) {
        const { error: insErr } = await supabase.from('rows').insert(toInsert.slice(i, i + 500));
        if (insErr) throw new Error('Row insert failed: ' + insErr.message);
      }

      const count = allRowCells.length;
      showToast(`${count} row${count !== 1 ? 's' : ''} imported (${finalHeaders.length} columns)`, true);
      await loadSection();
    } catch (err) {
      showToast('Import failed — ' + ((err as Error).message || 'Unknown error'), false);
      await loadSection();
    } finally {
      setImporting(false);
    }
  }

  // ── Export handler (ExcelJS styled workbook) ──────────────────────────────

  async function exportSection() {
    if (!hasPerm('export_excel')) return;
    if (filteredRows.length === 0) { showToast('No rows match current filters', false); return; }

    const sanitize = (s: string) =>
      s.replace(/[^a-zA-Z0-9\-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    const dateStr  = new Date().toISOString().slice(0, 10);
    const fname    = `${sanitize(PROJ_NAMES[proj!] || proj!)}_${sanitize(secLabel)}_${dateStr}_TAC.xlsx`;
    const titleText = `TAC Network Tracker  ·  ${PROJ_NAMES[proj!] || proj!}  ·  ${secLabel}     (Export: ${dateStr})`;

    const colTypes = columns.map((h, i) => {
      const hdr = h.toLowerCase();
      if (hdr.includes('date') || hdr.includes(' day')) return 'date';
      const vals = filteredRows.map(r => (r.cells[i] ?? '').trim()).filter(Boolean);
      if (vals.length > 0 && vals.every(v => !isNaN(Number(v)))) return 'number';
      return 'text';
    });

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    wb.creator = 'TAC Network Tracker';
    wb.created = new Date();

    const sheetName = secLabel.replace(/[^a-zA-Z0-9 _\-]/g, '').slice(0, 31) || 'Data';
    const ws = wb.addWorksheet(sheetName);
    const colCount = columns.length;

    ws.columns = columns.map((h, i) => ({
      width: Math.min(
        Math.max(h.length + 4, ...filteredRows.map(r => (r.cells[i] || '').length + 2), 12),
        50,
      ),
    }));

    ws.addRow([titleText]);
    if (colCount > 1) ws.mergeCells(1, 1, 1, colCount);
    const titleRow  = ws.getRow(1);
    titleRow.height = 26;
    const titleCell = ws.getCell('A1');
    titleCell.value     = titleText;
    titleCell.font      = { bold: true, size: 11, color: { argb: 'FF0F2038' } };
    titleCell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EDF5' } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'left' };

    ws.addRow(columns);
    const headerRow  = ws.getRow(2);
    headerRow.height = 28;
    for (let c = 1; c <= colCount; c++) {
      const cell     = headerRow.getCell(c);
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F2038' } };
      cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.alignment = { vertical: 'middle', horizontal: colTypes[c - 1] === 'number' ? 'right' : 'left' };
      cell.border    = { bottom: { style: 'medium', color: { argb: 'FF1A4060' } } };
    }

    ws.views = [{ state: 'frozen', ySplit: 2, showGridLines: true }];

    filteredRows.forEach((row, idx) => {
      const bgArgb = idx % 2 === 0 ? 'FFFFFFFF' : 'FFF4F6F8';
      const exRow  = ws.addRow(row.cells);
      exRow.height = 20;
      exRow.eachCell({ includeEmpty: true }, (cell, c) => {
        if (c > colCount) return;
        const type     = colTypes[c - 1];
        cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgArgb } };
        cell.font      = { color: { argb: 'FF111827' }, size: 10.5 };
        cell.border    = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } };
        cell.alignment = { vertical: 'middle', horizontal: type === 'number' ? 'right' : 'left' };
        if (type === 'number' && typeof cell.value === 'string' && cell.value !== '' && !isNaN(Number(cell.value))) {
          cell.value  = Number(cell.value);
          cell.numFmt = '#,##0.##';
        }
      });
    });

    const buffer = await wb.xlsx.writeBuffer();
    const blob   = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url    = URL.createObjectURL(blob);
    const a      = document.createElement('a');
    a.href = url; a.download = fname; a.click();
    URL.revokeObjectURL(url);

    const filtersOn = Object.keys(dropFilters).length > 0 || !!q || chipFilters.size > 0;
    showToast(
      `Exported ${filteredRows.length} row${filteredRows.length !== 1 ? 's' : ''} → ${fname}${filtersOn ? ' (filtered)' : ''}`,
      true,
    );
  }

  // ── Column management ──────────────────────────────────────────────────────

  function openColMenu(ci: number, e: React.MouseEvent) {
    e.stopPropagation();
    if (colMenu?.colIdx === ci) { setColMenu(null); return; }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDdState(null);
    setColMenu({ colIdx: ci, pos: { top: rect.bottom + 4, left: rect.left } });
  }

  async function confirmAddCol() {
    const name = addColName.trim();
    if (!name) return;
    if (columns.includes(name)) { showToast('Column already exists', false); return; }
    setColOpSaving(true);
    await ensureSectionsLoaded();
    const secMeta = getSections().find(s => s.project_name === proj && s.section_name === sec && !s.is_deleted);
    if (!secMeta) { showToast('Section not found', false); setColOpSaving(false); return; }
    const newCols       = [...(secMeta.columns || []), name];
    const newCustomCols = [...(secMeta.custom_columns || []), name];
    const { error } = await supabase.from('sections')
      .update({ columns: newCols, custom_columns: newCustomCols })
      .eq('id', secMeta.id);
    setColOpSaving(false);
    if (error) { showToast('Failed: ' + error.message, false); return; }
    invalidateSections();
    setAddColModal(false);
    setAddColName('');
    showToast(`Column "${name}" added`, true);
    await loadSection();
  }

  async function confirmRenameCol() {
    if (!renameColModal) return;
    const oldName = columns[renameColModal.colIdx];
    const newName = renameColModal.name.trim();
    if (!newName || newName === oldName) { setRenameColModal(null); return; }
    if (columns.includes(newName)) { showToast('Column name already exists', false); return; }
    setColOpSaving(true);
    await ensureSectionsLoaded();
    const secMeta = getSections().find(s => s.project_name === proj && s.section_name === sec && !s.is_deleted);
    if (!secMeta) { showToast('Section not found', false); setColOpSaving(false); return; }
    const newCols       = (secMeta.columns || []).map(c => c === oldName ? newName : c);
    const newCustomCols = (secMeta.custom_columns || []).map(c => c === oldName ? newName : c);
    const { error: colErr } = await supabase.from('sections')
      .update({ columns: newCols, custom_columns: newCustomCols })
      .eq('id', secMeta.id);
    if (colErr) { showToast('Failed: ' + colErr.message, false); setColOpSaving(false); return; }
    const { data: rowData, error: rowFetchErr } = await supabase
      .from('rows').select('id, data').eq('section_id', secMeta.id);
    if (rowFetchErr) { showToast('Row fetch failed: ' + rowFetchErr.message, false); setColOpSaving(false); return; }
    if (rowData && rowData.length > 0) {
      const updates = rowData.map(r => {
        const d = { ...(r.data as Record<string, unknown>) };
        if (oldName in d) { d[newName] = d[oldName]; delete d[oldName]; }
        return { id: r.id as string, data: d, updated_at: new Date().toISOString() };
      });
      for (let i = 0; i < updates.length; i += 500) {
        const { error: upErr } = await supabase.from('rows').upsert(updates.slice(i, i + 500));
        if (upErr) { showToast('Row update failed: ' + upErr.message, false); setColOpSaving(false); return; }
      }
    }
    invalidateSections();
    setRenameColModal(null);
    showToast(`Column renamed to "${newName}"`, true);
    setColOpSaving(false);
    await loadSection();
  }

  async function confirmDeleteCol() {
    if (!deleteColModal) return;
    const colName = columns[deleteColModal.colIdx];
    setColOpSaving(true);
    await ensureSectionsLoaded();
    const secMeta = getSections().find(s => s.project_name === proj && s.section_name === sec && !s.is_deleted);
    if (!secMeta) { showToast('Section not found', false); setColOpSaving(false); return; }
    const newCols       = (secMeta.columns || []).filter(c => c !== colName);
    const newCustomCols = (secMeta.custom_columns || []).filter(c => c !== colName);
    const { error: colErr } = await supabase.from('sections')
      .update({ columns: newCols, custom_columns: newCustomCols })
      .eq('id', secMeta.id);
    if (colErr) { showToast('Failed: ' + colErr.message, false); setColOpSaving(false); return; }
    const { data: rowData, error: rowFetchErr } = await supabase
      .from('rows').select('id, data').eq('section_id', secMeta.id);
    if (rowFetchErr) { showToast('Row fetch failed: ' + rowFetchErr.message, false); setColOpSaving(false); return; }
    if (rowData && rowData.length > 0) {
      const updates = rowData.map(r => {
        const d = { ...(r.data as Record<string, unknown>) };
        delete d[colName];
        return { id: r.id as string, data: d, updated_at: new Date().toISOString() };
      });
      for (let i = 0; i < updates.length; i += 500) {
        const { error: upErr } = await supabase.from('rows').upsert(updates.slice(i, i + 500));
        if (upErr) { showToast('Row update failed: ' + upErr.message, false); setColOpSaving(false); return; }
      }
    }
    invalidateSections();
    setDeleteColModal(null);
    showToast(`Column "${colName}" deleted`, true);
    setColOpSaving(false);
    await loadSection();
  }

  // ── Bulk update ────────────────────────────────────────────────────────────

  async function confirmBulkSame() {
    if (columns.length === 0) return;
    const raw = bulkSiteIds.trim();
    if (!raw) { showToast('No site IDs provided', false); return; }
    const siteIdSet = new Set(raw.split(/[\n,;\t ]+/).map(s => s.trim()).filter(Boolean));
    if (siteIdSet.size === 0) { showToast('No valid site IDs', false); return; }
    const matchingRows = rows.filter(r => siteIdSet.has(r.cells[0]?.trim()));
    if (matchingRows.length === 0) {
      showToast(`No rows matched ${siteIdSet.size} site ID${siteIdSet.size !== 1 ? 's' : ''}`, false);
      return;
    }
    const colName = columns[bulkColIdx];
    setBulkSaving(true);
    await ensureSectionsLoaded();
    const secMeta = getSections().find(s => s.project_name === proj && s.section_name === sec && !s.is_deleted);
    if (!secMeta) { showToast('Section not found', false); setBulkSaving(false); return; }
    const { data: rowData, error: fetchErr } = await supabase
      .from('rows').select('id, data').in('id', matchingRows.map(r => r.id));
    if (fetchErr) { showToast('Fetch failed: ' + fetchErr.message, false); setBulkSaving(false); return; }
    const updates = (rowData || []).map(r => ({
      id: r.id as string,
      data: { ...(r.data as Record<string, unknown>), [colName]: bulkValue },
      updated_at: new Date().toISOString(),
    }));
    for (let i = 0; i < updates.length; i += 500) {
      const { error: upErr } = await supabase.from('rows').upsert(updates.slice(i, i + 500));
      if (upErr) { showToast('Update failed: ' + upErr.message, false); setBulkSaving(false); return; }
    }
    setBulkSaving(false);
    setBulkModal(false);
    const n = matchingRows.length;
    const missed = siteIdSet.size - n;
    showToast(`Updated ${n} row${n !== 1 ? 's' : ''}${missed > 0 ? ` · ${missed} not found` : ''}`, true);
    await loadSection();
  }

  async function confirmBulkDiff() {
    if (columns.length === 0 || bulkDiffCols.length === 0) return;
    const raw = bulkDiffData.trim();
    if (!raw) { showToast('No data provided', false); return; }
    const dataRows = raw.split('\n')
      .map(line => (line.includes('\t') ? line.split('\t') : line.split(',')).map(p => p.trim()))
      .filter(r => r.some(c => c !== ''));
    if (dataRows.length === 0) { showToast('No valid data rows', false); return; }
    const updateMap = new Map<string, Record<string, string>>();
    for (const row of dataRows) {
      const siteId = row[0]?.trim();
      if (!siteId) continue;
      const upd: Record<string, string> = {};
      bulkDiffCols.forEach((ci, i) => {
        if (columns[ci] && row[i + 1] !== undefined) upd[columns[ci]] = row[i + 1];
      });
      updateMap.set(siteId, upd);
    }
    if (updateMap.size === 0) { showToast('No valid data', false); return; }
    const matchingRows = rows.filter(r => updateMap.has(r.cells[0]?.trim()));
    if (matchingRows.length === 0) { showToast('No matching rows found', false); return; }
    setBulkSaving(true);
    await ensureSectionsLoaded();
    const secMeta = getSections().find(s => s.project_name === proj && s.section_name === sec && !s.is_deleted);
    if (!secMeta) { showToast('Section not found', false); setBulkSaving(false); return; }
    const { data: rowData, error: fetchErr } = await supabase
      .from('rows').select('id, data').in('id', matchingRows.map(r => r.id));
    if (fetchErr) { showToast('Fetch failed: ' + fetchErr.message, false); setBulkSaving(false); return; }
    const updates = (rowData || []).map(r => {
      const mr = matchingRows.find(x => x.id === (r.id as string));
      const siteId = mr?.cells[0]?.trim() ?? '';
      return {
        id: r.id as string,
        data: { ...(r.data as Record<string, unknown>), ...(updateMap.get(siteId) ?? {}) },
        updated_at: new Date().toISOString(),
      };
    });
    for (let i = 0; i < updates.length; i += 500) {
      const { error: upErr } = await supabase.from('rows').upsert(updates.slice(i, i + 500));
      if (upErr) { showToast('Update failed: ' + upErr.message, false); setBulkSaving(false); return; }
    }
    setBulkSaving(false);
    setBulkModal(false);
    const n = matchingRows.length;
    const missed = updateMap.size - n;
    showToast(`Updated ${n} row${n !== 1 ? 's' : ''}${missed > 0 ? ` · ${missed} not found` : ''}`, true);
    await loadSection();
  }

  // ── Bulk value input renderer ──────────────────────────────────────────────

  function renderBulkValueInput(colIdx: number, value: string, onChange: (v: string) => void) {
    const h        = columns[colIdx] ?? '';
    const isStatus = h === 'Status of Integration';
    const isSubcon = h === 'Subcon';
    const isAtp    = /^atp.{0,8}status$/i.test(h);
    const isDate   = DATE_KEYWORDS.some(kw => h.toLowerCase().includes(kw));
    if (isStatus) return (
      <select className={styles.detailSelect} value={value} onChange={e => onChange(e.target.value)}>
        {STATUS_OPTIONS.map(o => <option key={o} value={o}>{o || '— Select status —'}</option>)}
      </select>
    );
    if (isSubcon) return (
      <select className={styles.detailSelect} value={value} onChange={e => onChange(e.target.value)}>
        {SUBCON_OPTIONS.map(o => <option key={o} value={o}>{o || '— Select subcon —'}</option>)}
      </select>
    );
    if (isAtp) return (
      <select className={styles.detailSelect} value={value || 'Pending'} onChange={e => onChange(e.target.value)}>
        {ATP_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    );
    if (isDate) return (
      <div className={styles.dateFieldWrap}>
        <input className={styles.detailInput} type="date" value={parseToDateInput(value)}
          onChange={e => onChange(e.target.value)} />
        <button type="button" className={styles.dateClearBtn} onClick={() => onChange('')}>✕</button>
      </div>
    );
    return (
      <input className={styles.detailInput} type="text" value={value}
        placeholder={h} onChange={e => onChange(e.target.value)} />
    );
  }

  // ── Permission gate ────────────────────────────────────────────────────────

  if (proj && !hasPerm(`view_${proj}`)) {
    return (
      <div className={styles.page}>
        <div className={styles.placeholder}>You don't have permission to view this project.</div>
      </div>
    );
  }

  if (!proj || !sec) {
    return (
      <div className={styles.page}>
        <div className={styles.placeholder}>Select a project section from the sidebar to begin.</div>
      </div>
    );
  }

  // ── Derived KPIs ──────────────────────────────────────────────────────────

  const statusColIdx = columns.indexOf('Status of Integration');
  const impColIdx    = findImpColIdx(columns);
  const atpColIdx    = findAtpColIdx(columns);

  const implemented = impColIdx >= 0 ? rows.filter(r => r.cells[impColIdx].trim() !== '').length : 0;
  const atpAccepted = atpColIdx >= 0 ? rows.filter(r => isAtpAccepted(r.cells[atpColIdx])).length : 0;
  const atpPending  = atpColIdx >= 0 ? rows.filter(r => /^pending$/i.test(r.cells[atpColIdx].trim())).length : 0;
  const atpRejected = atpColIdx >= 0 ? rows.filter(r => /^rejected$/i.test(r.cells[atpColIdx].trim())).length : 0;

  const statusCounts: Record<string, number> = {};
  if (statusColIdx >= 0) {
    rows.forEach(r => {
      const v = r.cells[statusColIdx].trim();
      if (v) statusCounts[v] = (statusCounts[v] || 0) + 1;
    });
  }

  // ── Filter application ────────────────────────────────────────────────────

  const q = searchQuery.toLowerCase().trim();
  const filteredRows = rows.filter(row => {
    const passDropFilters = Object.entries(dropFilters).every(([ciStr, allowed]) =>
      allowed.has(row.cells[+ciStr] ?? ''),
    );
    const passSearch = !q || row.cells.some(cell => cell.toLowerCase().includes(q));
    const statusVal  = statusColIdx >= 0 ? row.cells[statusColIdx].trim() : '';
    const passChip   = chipFilters.size === 0 || chipFilters.has(statusVal);
    let passStatCard = true;
    if (secStatFilter && secStatFilter !== 'all') {
      if (secStatFilter === 'implemented') {
        passStatCard = impColIdx >= 0 ? row.cells[impColIdx].trim() !== '' : true;
      } else if (secStatFilter.startsWith('atp:')) {
        const atpVal = secStatFilter.slice(4);
        if (atpColIdx >= 0) {
          const cellVal = row.cells[atpColIdx].trim();
          passStatCard = atpVal === 'Accepted' ? isAtpAccepted(cellVal) : cellVal === atpVal;
        }
      }
    }
    return passDropFilters && passSearch && passChip && passStatCard;
  });

  // ── Pagination ────────────────────────────────────────────────────────────

  const totalFiltered = filteredRows.length;
  const ps = pageSize === 'all' ? totalFiltered : pageSize;
  const totalPages = Math.max(1, ps > 0 ? Math.ceil(totalFiltered / ps) : 1);
  const clampedPage = Math.max(1, Math.min(page, totalPages));
  const startIdx = (clampedPage - 1) * (pageSize === 'all' ? totalFiltered : ps);
  const endIdx = pageSize === 'all' ? totalFiltered : Math.min(startIdx + ps, totalFiltered);
  const visibleRows = filteredRows.slice(startIdx, endIdx);

  // ── Event handlers ────────────────────────────────────────────────────────

  function openDropdown(ci: number, e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    if (ddState?.colIdx === ci) { setDdState(null); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    const raw = rows.map(r => r.cells[ci] ?? '');
    const allValues = [...new Set(raw)].sort((a, b) => {
      const na = Number(a), nb = Number(b);
      return (!isNaN(na) && !isNaN(nb)) ? na - nb : a.localeCompare(b);
    });
    const contextRows = rows.filter(row => {
      const passOtherFilters = Object.entries(dropFilters).every(([ciStr, allowed]) =>
        +ciStr === ci ? true : allowed.has(row.cells[+ciStr] ?? ''),
      );
      const passSearch = !q || row.cells.some(cell => cell.toLowerCase().includes(q));
      return passOtherFilters && passSearch;
    });
    const countMap: Record<string, number> = {};
    contextRows.forEach(row => { const v = row.cells[ci] ?? ''; countMap[v] = (countMap[v] || 0) + 1; });
    setColMenu(null);
    setDdState({
      colIdx: ci,
      pos: { top: rect.bottom + 4, left: Math.min(rect.left, window.innerWidth - 252) },
      search: '', allValues, countMap,
    });
  }

  function ddToggleVal(ci: number, value: string, checked: boolean) {
    const allVals = [...new Set(rows.map(r => r.cells[ci] ?? ''))];
    setDropFilters(prev => {
      const next = { ...prev };
      if (!next[ci]) next[ci] = new Set(allVals); else next[ci] = new Set(next[ci]);
      if (checked) next[ci].add(value); else next[ci].delete(value);
      if (next[ci].size >= allVals.length) delete next[ci];
      return next;
    });
    setPage(1);
  }

  function ddToggleAll(ci: number, checked: boolean) {
    setDropFilters(prev => {
      const next = { ...prev };
      if (checked) delete next[ci]; else next[ci] = new Set();
      return next;
    });
    setPage(1);
  }

  function toggleChip(status: string) {
    setChipFilters(prev => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status); else next.add(status);
      return next;
    });
    setPage(1);
  }

  function handleSecStatFilter(key: string) {
    setSecStatFilter(prev => prev === key ? null : key);
    setPage(1);
  }

  function clearAllFilters() {
    setDropFilters({}); setChipFilters(new Set()); setSecStatFilter(null);
    setSearchQuery(''); setPage(1); setDdState(null);
  }

  const hasActiveFilters = Object.keys(dropFilters).length > 0 || !!q;
  const secMeta = getSections().find(s => s.project_name === proj && s.section_name === sec);
  const secLabel = secMeta?.section_label || SEC_LABELS[sec] || sec;
  const projName = PROJ_NAMES[proj] || proj;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className={styles.page} onClick={() => { ddState && setDdState(null); colMenu && setColMenu(null); }}>

      {/* Breadcrumb */}
      <div className={styles.breadcrumb}>
        <span className={styles.bc}>Network Scopes</span>
        <span className={styles.bcSep}>›</span>
        <span className={styles.bc}>{projName}</span>
        <span className={styles.bcSep}>›</span>
        <span className={styles.bcCur}>{secLabel}</span>
      </div>

      {loading && <div className={styles.loadingBar}>Loading…</div>}
      {error   && <div className={styles.errorMsg}>Error: {error}</div>}

      {!loading && !error && columns.length === 0 && (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="3" y="3" width="18" height="18" rx="3"/>
              <line x1="3" y1="9" x2="21" y2="9"/>
              <line x1="9" y1="21" x2="9" y2="9"/>
            </svg>
          </div>
          <div className={styles.emptyTitle}>No data yet</div>
          <div className={styles.emptyDesc}>
            This section is empty.
            {hasPerm('add_rows') && ' Import an Excel file or use Add Site to get started.'}
          </div>
          {hasPerm('add_rows') && (
            <label className={styles.addSiteBtn} style={{ cursor: 'pointer', marginTop: 8 }}>
              <UploadIcon /> Import Excel
              <input
                ref={importInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                style={{ display: 'none' }}
                onChange={handleImportFile}
              />
            </label>
          )}
        </div>
      )}

      {!loading && !error && columns.length > 0 && (
        <>
          {/* Stat cards */}
          <div className={styles.statsBar}>
            {[
              { val: rows.length, label: 'Total Sites',   color: '#2563eb', key: 'all'          },
              { val: implemented, label: 'Implemented',   color: '#16a34a', key: 'implemented'  },
              { val: atpAccepted, label: 'ATP Accepted',  color: '#16a34a', key: 'atp:Accepted' },
              { val: atpPending,  label: 'ATP Pending',   color: '#d97706', key: 'atp:Pending'  },
              { val: atpRejected, label: 'ATP Rejected',  color: '#dc2626', key: 'atp:Rejected' },
            ].map(({ val, label, color, key }) => {
              const isActive = secStatFilter === key;
              return (
                <div
                  key={key}
                  className={`${styles.statCard} ${isActive ? styles.statCardActive : ''}`}
                  style={isActive ? { borderColor: color, boxShadow: `0 0 0 3px ${color}28` } : {}}
                  onClick={() => handleSecStatFilter(key)}
                >
                  <div className={styles.statVal} style={{ color }}>{val}</div>
                  <div className={styles.statLabel}>{label}</div>
                </div>
              );
            })}
            {secStatFilter && secStatFilter !== 'all' && (
              <button className={styles.statClearBtn} onClick={() => { setSecStatFilter(null); setPage(1); }}>
                ✕ Clear Filter
              </button>
            )}
          </div>

          {/* Status chips */}
          {Object.keys(statusCounts).length > 0 && (
            <div className={styles.chipRow}>
              {Object.entries(statusCounts).sort((a, b) => b[1] - a[1]).map(([status, count]) => {
                const isActive = chipFilters.has(status);
                const colorCls = status === 'Integrated' ? styles.chipGreen
                               : status === 'Reachable'  ? styles.chipAmber : '';
                return (
                  <div
                    key={status}
                    className={`${styles.chip} ${isActive ? styles.chipActive : ''} ${isActive ? colorCls : ''}`}
                    onClick={() => toggleChip(status)}
                  >
                    {status}
                    <span className={styles.chipCount}>{count}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Toolbar */}
          <div className={styles.tableWrap}>
            <div className={styles.toolbar}>
              <div className={styles.toolbarMeta}>
                <strong>{secLabel} Data</strong>
                <small>
                  {totalFiltered === rows.length
                    ? `${rows.length} rows · ${columns.length} columns`
                    : `${totalFiltered} of ${rows.length} rows · ${columns.length} columns`}
                </small>
              </div>
              <div className={styles.toolbarRight}>
                {hasPerm('add_rows') && (
                  <button className={styles.addSiteBtn} onClick={openAddModal}>
                    <PlusIcon /> Add Site
                  </button>
                )}
                {hasPerm('add_rows') && (
                  <label className={styles.importBtn} title="Import Excel file">
                    <UploadIcon /> Import
                    <input
                      ref={importInputRef}
                      type="file"
                      accept=".xlsx,.xls,.csv"
                      style={{ display: 'none' }}
                      onChange={handleImportFile}
                    />
                  </label>
                )}
                {hasPerm('export_excel') && (
                  <button className={styles.exportBtn} onClick={exportSection} title="Export to Excel">
                    <DownloadIcon /> Export
                  </button>
                )}
                {hasPerm('add_columns') && (
                  <button className={styles.addColBtn} onClick={() => { setAddColName(''); setAddColModal(true); }}>
                    <PlusIcon /> Add Column
                  </button>
                )}
                {hasPerm('edit_rows') && rows.length > 0 && (
                  <button className={styles.bulkBtn} onClick={() => {
                    setBulkTab('same');
                    setBulkColIdx(0);
                    setBulkValue('');
                    setBulkSiteIds('');
                    setBulkDiffCols([Math.min(1, columns.length - 1)]);
                    setBulkDiffData('');
                    setBulkModal(true);
                  }}>
                    <BulkIcon /> Bulk Update
                  </button>
                )}
                <div className={styles.searchWrap}>
                  <SearchIcon />
                  <input
                    className={styles.searchInput}
                    type="search"
                    placeholder="Search all columns…"
                    value={searchQuery}
                    onChange={e => { setSearchQuery(e.target.value); setPage(1); }}
                  />
                </div>
                {Object.keys(dropFilters).length > 0 && (
                  <span className={styles.filterBadge}>
                    {Object.keys(dropFilters).length} filter{Object.keys(dropFilters).length !== 1 ? 's' : ''} active
                  </span>
                )}
                {hasActiveFilters && (
                  <button className={styles.clearFiltersBtn} onClick={clearAllFilters}>
                    <XIcon /> Clear
                  </button>
                )}
                <button className={styles.refreshBtn} onClick={loadSection} title="Refresh">
                  <RefreshIcon />
                </button>
              </div>
            </div>

            {/* Table */}
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    {columns.map((h, ci) => (
                      <th key={ci}>
                        <div className={styles.thInner}>
                          <span>{h}</span>
                          <button
                            className={`${styles.ddBtn} ${dropFilters[ci] ? styles.ddBtnOn : ''}`}
                            onClick={e => openDropdown(ci, e)}
                            title="Filter"
                          >
                            <FilterIcon />
                          </button>
                          {hasPerm('add_columns') && (
                            <button
                              className={styles.colMenuBtn}
                              onClick={e => openColMenu(ci, e)}
                              title="Column options"
                            >
                              ⋮
                            </button>
                          )}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.length === 0 ? (
                    <tr>
                      <td colSpan={columns.length} className={styles.tdEmpty}>
                        {rows.length === 0 ? 'No data yet.' : 'No rows match the current filters.'}
                      </td>
                    </tr>
                  ) : visibleRows.map(row => {
                    const statusVal = statusColIdx >= 0 ? row.cells[statusColIdx].trim() : '';
                    return (
                      <tr
                        key={row.id}
                        data-status={statusVal}
                        className={styles.rowClickable}
                        onClick={() => openRowModal(row)}
                      >
                        {row.cells.map((cell, ci) => (
                          <td key={ci} className={ci === statusColIdx ? styles.statusCell : undefined}>
                            {cell}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className={styles.paginationBar}>
              <div className={styles.pagLeft}>
                <span className={styles.pagSizeLabel}>Rows per page</span>
                <select
                  className={styles.pagSizeSelect}
                  value={String(pageSize)}
                  onChange={e => { const v = e.target.value; setPageSize(v === 'all' ? 'all' : +v); setPage(1); }}
                >
                  <option value="10">10</option>
                  <option value="25">25</option>
                  <option value="50">50</option>
                  <option value="100">100</option>
                  <option value="all">All</option>
                </select>
                <span className={styles.pagInfo}>
                  {totalFiltered === 0
                    ? '0 rows match'
                    : totalFiltered < rows.length
                      ? `Showing ${startIdx + 1}–${endIdx} of ${totalFiltered} rows (${rows.length} total)`
                      : `Showing ${startIdx + 1}–${endIdx} of ${rows.length} rows`}
                </span>
              </div>
              <div className={styles.pagRight}>
                <button className={styles.pagBtn} onClick={() => setPage(p => Math.max(1, p - 1))} disabled={clampedPage <= 1}>
                  <ChevLeftIcon /> Previous
                </button>
                <button className={styles.pagBtn} onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={clampedPage >= totalPages}>
                  Next <ChevRightIcon />
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Column filter dropdown (fixed overlay) */}
      {ddState && (
        <div
          ref={ddRef}
          className={styles.ddPortal}
          style={{ top: ddState.pos.top, left: ddState.pos.left }}
          onClick={e => e.stopPropagation()}
        >
          <div className={styles.ddHead}>
            <span className={styles.ddHeadName}>{columns[ddState.colIdx]}</span>
            <span className={styles.ddHeadCount}>{ddState.allValues.length} values</span>
          </div>
          <div className={styles.ddSearchWrap}>
            <input
              className={styles.ddSearchInput}
              type="text"
              placeholder="Search values…"
              value={ddState.search}
              onChange={e => setDdState(s => s ? { ...s, search: e.target.value } : null)}
              autoFocus
            />
          </div>
          <div className={styles.ddList}>
            <label className={`${styles.ddItem} ${styles.ddItemAll}`}>
              <input type="checkbox" checked={!dropFilters[ddState.colIdx]}
                onChange={e => ddToggleAll(ddState.colIdx, e.target.checked)} />
              <span className={styles.ddItemLabel}>Select All</span>
            </label>
            {ddState.allValues
              .filter(v => !ddState.search || v.toLowerCase().includes(ddState.search.toLowerCase()))
              .map(v => {
                const selected = dropFilters[ddState.colIdx];
                const checked = !selected || selected.has(v);
                return (
                  <label key={v} className={styles.ddItem}>
                    <input type="checkbox" checked={checked}
                      onChange={e => ddToggleVal(ddState.colIdx, v, e.target.checked)} />
                    <span className={styles.ddItemLabel}>
                      {v === '' ? <em style={{ opacity: .45 }}>Empty</em> : v}
                    </span>
                    <span className={styles.ddItemCount}>{ddState.countMap[v] ?? 0}</span>
                  </label>
                );
              })}
          </div>
          <div className={styles.ddFooter}>
            <span className={styles.ddSelCount}>
              {!dropFilters[ddState.colIdx] ? ddState.allValues.length : dropFilters[ddState.colIdx].size}
              {' '}of {ddState.allValues.length}
            </span>
            <button className={styles.ddOkBtn} onClick={() => setDdState(null)}>Done</button>
          </div>
        </div>
      )}

      {/* Column context menu (fixed overlay) */}
      {colMenu && (
        <div
          ref={colMenuRef}
          className={styles.colMenuDropdown}
          style={{ top: colMenu.pos.top, left: colMenu.pos.left }}
          onClick={e => e.stopPropagation()}
        >
          <button className={styles.colMenuItem} onClick={() => {
            setRenameColModal({ colIdx: colMenu.colIdx, name: columns[colMenu.colIdx] });
            setColMenu(null);
          }}>
            Rename Column
          </button>
          <button className={`${styles.colMenuItem} ${styles.colMenuItemDanger}`} onClick={() => {
            setDeleteColModal({ colIdx: colMenu.colIdx });
            setColMenu(null);
          }}>
            Delete Column
          </button>
        </div>
      )}

      {/* ── Site detail modal ─────────────────────────────────────────────── */}
      {modal && (
        <div
          className={styles.detailOverlay}
          onClick={() => { if (!modalSaving) { setModal(null); setDeleteConfirm(false); } }}
        >
          <div className={styles.detailModal} onClick={e => e.stopPropagation()}>
            <div className={styles.detailHeader}>
              <button
                className={styles.detailBack}
                onClick={() => { setModal(null); setDeleteConfirm(false); }}
                disabled={modalSaving}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="15 18 9 12 15 6"/>
                </svg>
                Back
              </button>
              <div>
                <div className={styles.detailTitle}>
                  {modal.rowId === null ? 'New Site' : (`Site ${modal.cells[0] || ''}`).trim() || 'Edit Site'}
                </div>
                <div className={styles.detailSubtitle}>{projName} · {secLabel}</div>
              </div>
            </div>

            <div className={styles.detailCard}>
              <div className={styles.detailGrid}>
                {columns.map((h, ci) => {
                  const v       = modal.cells[ci] ?? '';
                  const isStatus = h === 'Status of Integration';
                  const isSubcon = h === 'Subcon';
                  const isAtp    = /^atp.{0,8}status$/i.test(h);
                  const isDate   = DATE_KEYWORDS.some(kw => h.toLowerCase().includes(kw));
                  const canEdit  = modal.rowId === null ? hasPerm('add_rows') : hasPerm('edit_rows');
                  const atpVal   = isAtp ? (ATP_OPTIONS.includes(v) ? v : 'Pending') : '';

                  return (
                    <div key={ci} className={styles.detailField}>
                      <div className={styles.detailLabel}>{h}</div>
                      {isStatus ? (
                        <select className={styles.detailSelect} value={v} disabled={!canEdit}
                          onChange={e => updateModalCell(ci, e.target.value)}>
                          {STATUS_OPTIONS.map(o => <option key={o} value={o}>{o || '— Select status —'}</option>)}
                          {!STATUS_OPTIONS.includes(v) && v && <option value={v}>{v}</option>}
                        </select>
                      ) : isSubcon ? (
                        <select className={styles.detailSelect} value={v} disabled={!canEdit}
                          onChange={e => updateModalCell(ci, e.target.value)}>
                          {SUBCON_OPTIONS.map(o => <option key={o} value={o}>{o || '— Select subcon —'}</option>)}
                          {!SUBCON_OPTIONS.includes(v) && v && <option value={v}>{v}</option>}
                        </select>
                      ) : isAtp ? (
                        <select className={styles.detailSelect} value={atpVal} disabled={!canEdit}
                          onChange={e => updateModalCell(ci, e.target.value)}>
                          {ATP_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : isDate ? (
                        <div className={styles.dateFieldWrap}>
                          <input className={styles.detailInput} type="date" value={parseToDateInput(v)}
                            disabled={!canEdit} onChange={e => updateModalCell(ci, e.target.value)} />
                          {canEdit && (
                            <button type="button" className={styles.dateClearBtn} title="Clear date"
                              onClick={() => updateModalCell(ci, '')}>✕</button>
                          )}
                        </div>
                      ) : (
                        <input className={styles.detailInput} type="text" value={v}
                          placeholder={h} disabled={!canEdit}
                          onChange={e => updateModalCell(ci, e.target.value)} />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className={styles.detailActions}>
              {(modal.rowId === null ? hasPerm('add_rows') : hasPerm('edit_rows')) && (
                <button className={styles.btnGreen} disabled={modalSaving} onClick={saveModal}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                  {modalSaving ? 'Saving…' : modal.rowId === null ? 'Add Site' : 'Save Changes'}
                </button>
              )}
              <button className={styles.btnGhost} disabled={modalSaving}
                onClick={() => { setModal(null); setDeleteConfirm(false); }}>
                Cancel
              </button>
              {modal.rowId !== null && hasPerm('delete_rows') && (
                <>
                  <div style={{ flex: 1 }} />
                  <button className={styles.btnDanger} disabled={modalSaving} onClick={() => setDeleteConfirm(true)}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3 6 5 6 21 6"/>
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                      <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
                    </svg>
                    Delete
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Delete row confirmation ───────────────────────────────────────── */}
      {deleteConfirm && (
        <div className={styles.detailOverlay} style={{ zIndex: 1100 }}
          onClick={() => { if (!modalSaving) setDeleteConfirm(false); }}>
          <div className={styles.deleteConfirmModal} onClick={e => e.stopPropagation()}>
            <div className={styles.deleteConfirmTitle}>Delete this site?</div>
            <div className={styles.deleteConfirmDesc}>
              This will permanently remove the row from the database. This action cannot be undone.
            </div>
            <div className={styles.deleteConfirmActions}>
              <button className={styles.btnDanger} disabled={modalSaving} onClick={confirmDelete}>
                {modalSaving ? 'Deleting…' : 'Delete'}
              </button>
              <button className={styles.btnGhost} disabled={modalSaving} onClick={() => setDeleteConfirm(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add Column modal ──────────────────────────────────────────────── */}
      {addColModal && (
        <div className={styles.detailOverlay} style={{ zIndex: 1300 }}
          onClick={() => !colOpSaving && setAddColModal(false)}>
          <div className={styles.deleteConfirmModal} onClick={e => e.stopPropagation()}>
            <div className={styles.deleteConfirmTitle}>Add Column</div>
            <div className={styles.deleteConfirmDesc}>
              The new column will be appended to the right of the grid.
            </div>
            <input
              className={styles.detailInput}
              placeholder="Column name"
              value={addColName}
              autoFocus
              onChange={e => setAddColName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && confirmAddCol()}
            />
            <div className={styles.deleteConfirmActions} style={{ marginTop: 20 }}>
              <button className={styles.btnGreen} disabled={colOpSaving} onClick={confirmAddCol}>
                {colOpSaving ? 'Adding…' : 'Add Column'}
              </button>
              <button className={styles.btnGhost} disabled={colOpSaving} onClick={() => setAddColModal(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Rename Column modal ───────────────────────────────────────────── */}
      {renameColModal && (
        <div className={styles.detailOverlay} style={{ zIndex: 1300 }}
          onClick={() => !colOpSaving && setRenameColModal(null)}>
          <div className={styles.deleteConfirmModal} onClick={e => e.stopPropagation()}>
            <div className={styles.deleteConfirmTitle}>Rename Column</div>
            <div className={styles.deleteConfirmDesc}>
              Renaming <strong>"{columns[renameColModal.colIdx]}"</strong> will also update the key in every existing row.
            </div>
            <input
              className={styles.detailInput}
              placeholder="New column name"
              value={renameColModal.name}
              autoFocus
              onChange={e => setRenameColModal(s => s ? { ...s, name: e.target.value } : null)}
              onKeyDown={e => e.key === 'Enter' && confirmRenameCol()}
            />
            <div className={styles.deleteConfirmActions} style={{ marginTop: 20 }}>
              <button className={styles.btnGreen} disabled={colOpSaving} onClick={confirmRenameCol}>
                {colOpSaving ? 'Saving…' : 'Rename'}
              </button>
              <button className={styles.btnGhost} disabled={colOpSaving} onClick={() => setRenameColModal(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Column confirmation ─────────────────────────────────────── */}
      {deleteColModal && (
        <div className={styles.detailOverlay} style={{ zIndex: 1300 }}
          onClick={() => !colOpSaving && setDeleteColModal(null)}>
          <div className={styles.deleteConfirmModal} onClick={e => e.stopPropagation()}>
            <div className={styles.deleteConfirmTitle}>Delete Column</div>
            <div className={styles.deleteConfirmDesc}>
              Delete column <strong>"{columns[deleteColModal.colIdx]}"</strong>?
              This removes it from all {rows.length} row{rows.length !== 1 ? 's' : ''} and cannot be undone.
            </div>
            <div className={styles.deleteConfirmActions}>
              <button className={styles.btnDanger} disabled={colOpSaving} onClick={confirmDeleteCol}>
                {colOpSaving ? 'Deleting…' : 'Delete Column'}
              </button>
              <button className={styles.btnGhost} disabled={colOpSaving} onClick={() => setDeleteColModal(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Bulk Update modal ─────────────────────────────────────────────── */}
      {bulkModal && (
        <div className={styles.detailOverlay} style={{ zIndex: 1200 }}
          onClick={() => !bulkSaving && setBulkModal(false)}>
          <div className={styles.bulkModal} onClick={e => e.stopPropagation()}>
            <div className={styles.detailHeader}>
              <button className={styles.detailBack} onClick={() => setBulkModal(false)} disabled={bulkSaving}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="15 18 9 12 15 6"/>
                </svg>
                Back
              </button>
              <div>
                <div className={styles.detailTitle}>Bulk Update</div>
                <div className={styles.detailSubtitle}>{projName} · {secLabel} · {rows.length} rows</div>
              </div>
            </div>

            <div className={styles.bulkTabs}>
              <button
                className={`${styles.bulkTab} ${bulkTab === 'same' ? styles.bulkTabActive : ''}`}
                onClick={() => setBulkTab('same')}
              >Apply Same Value</button>
              <button
                className={`${styles.bulkTab} ${bulkTab === 'diff' ? styles.bulkTabActive : ''}`}
                onClick={() => setBulkTab('diff')}
              >Apply Different Values</button>
            </div>

            {bulkTab === 'same' ? (
              <div className={styles.bulkForm}>
                <div className={styles.bulkField}>
                  <label className={styles.bulkLabel}>Column to update</label>
                  <select className={styles.detailSelect} value={bulkColIdx}
                    onChange={e => { setBulkColIdx(+e.target.value); setBulkValue(''); }}>
                    {columns.map((h, i) => <option key={i} value={i}>{h}</option>)}
                  </select>
                </div>
                <div className={styles.bulkField}>
                  <label className={styles.bulkLabel}>New value</label>
                  {renderBulkValueInput(bulkColIdx, bulkValue, setBulkValue)}
                </div>
                <div className={styles.bulkField}>
                  <label className={styles.bulkLabel}>
                    Site IDs — one per line, or comma / tab / space separated
                  </label>
                  <textarea
                    className={styles.bulkTextarea}
                    placeholder={'SITE001\nSITE002\nSITE003'}
                    value={bulkSiteIds}
                    onChange={e => setBulkSiteIds(e.target.value)}
                    rows={8}
                  />
                </div>
                <div className={styles.detailActions}>
                  <button className={styles.btnGreen} disabled={bulkSaving} onClick={confirmBulkSame}>
                    {bulkSaving ? 'Updating…' : 'Apply Update'}
                  </button>
                  <button className={styles.btnGhost} disabled={bulkSaving} onClick={() => setBulkModal(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className={styles.bulkForm}>
                <div className={styles.bulkField}>
                  <label className={styles.bulkLabel}>Columns (in paste order, after the Site ID column)</label>
                  {bulkDiffCols.map((ci, i) => (
                    <div key={i} className={styles.bulkDiffColRow}>
                      <span className={styles.bulkDiffColNum}>Col {i + 2}</span>
                      <select className={styles.detailSelect} value={ci}
                        onChange={e => {
                          const next = [...bulkDiffCols];
                          next[i] = +e.target.value;
                          setBulkDiffCols(next);
                        }}>
                        {columns.map((h, j) => <option key={j} value={j}>{h}</option>)}
                      </select>
                      {bulkDiffCols.length > 1 && (
                        <button className={styles.bulkDiffColRemove}
                          onClick={() => setBulkDiffCols(prev => prev.filter((_, idx) => idx !== i))}>
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                  <button className={styles.bulkAddColBtn}
                    onClick={() => setBulkDiffCols(prev => [...prev, 0])}>
                    + Add Column
                  </button>
                </div>
                <div className={styles.bulkField}>
                  <label className={styles.bulkLabel}>
                    Paste data — tab-separated: Site ID → Col 2 → Col 3 → …
                  </label>
                  <textarea
                    className={styles.bulkTextarea}
                    placeholder={'SITE001\tValue1\tValue2\nSITE002\tValue1\tValue2'}
                    value={bulkDiffData}
                    onChange={e => setBulkDiffData(e.target.value)}
                    rows={10}
                  />
                </div>
                <div className={styles.detailActions}>
                  <button className={styles.btnGreen} disabled={bulkSaving} onClick={confirmBulkDiff}>
                    {bulkSaving ? 'Updating…' : 'Apply Update'}
                  </button>
                  <button className={styles.btnGhost} disabled={bulkSaving} onClick={() => setBulkModal(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Import confirmation modal ─────────────────────────────────────── */}
      {importPending && (
        <div className={styles.detailOverlay} style={{ zIndex: 1200 }}
          onClick={() => setImportPending(null)}>
          <div className={styles.importConfirmModal} onClick={e => e.stopPropagation()}>
            <div className={styles.importConfirmTitle}>Import Excel</div>
            <div className={styles.importConfirmSub}>
              <strong>This will affect your existing data!</strong>
              <br /><br />
              Current rows: <strong>{rows.length}</strong>
              &nbsp;·&nbsp;
              Incoming rows: <strong>{importPending.rows.length}</strong>
              &nbsp;·&nbsp;
              File: <strong>{importPending.fileName}</strong>
            </div>
            <div className={styles.importConfirmBtns}>
              <button
                className={styles.btnDanger}
                onClick={() => doImportWith(importPending, 'replace')}
              >
                Replace — wipe &amp; replace all data
              </button>
              <button
                className={styles.btnGreen}
                onClick={() => doImportWith(importPending, 'append')}
              >
                Append — merge columns &amp; add rows
              </button>
              <button className={styles.btnGhost} onClick={() => setImportPending(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Import loading overlay ────────────────────────────────────────── */}
      {importing && (
        <div className={styles.importingOverlay}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"
            style={{ animation: 'nsSpinAnim 1s linear infinite' }}>
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
          </svg>
          <div className={styles.importingText}>Saving to database…</div>
        </div>
      )}

      {/* ── Toast ─────────────────────────────────────────────────────────── */}
      {toast && (
        <div className={`${styles.toast} ${toast.ok ? styles.toastOk : styles.toastErr}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function SearchIcon()   { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8b949e" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>; }
function FilterIcon()   { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>; }
function XIcon()        { return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>; }
function RefreshIcon()  { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>; }
function ChevLeftIcon() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>; }
function ChevRightIcon(){ return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>; }
function PlusIcon()     { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>; }
function UploadIcon()   { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>; }
function DownloadIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>; }
function BulkIcon()     { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>; }

export function NetworkScopesIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <line x1="3" y1="9" x2="21" y2="9"/>
      <line x1="9" y1="21" x2="9" y2="9"/>
    </svg>
  );
}
