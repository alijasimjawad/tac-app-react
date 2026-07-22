import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import styles from './FinTeam.module.css';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TeamMember {
  id: string;
  full_name: string;
  monthly_salary: number | null;
  role: string | null;
  phone: string | null;
  notes: string | null;
  is_active: boolean;
  activated_at: string | null;
  deactivated_at: string | null;
  start_date: string | null;
}

interface BulkAddRow {
  full_name: string;
  monthly_salary: number;
  role: string | null;
  phone: string | null;
  notes: null;
  is_active: true;
  _dup: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TM_ROLE_COLORS: Record<string, { bg: string; text: string; avatar: string }> = {
  'Engineer':     { bg: '#dbeafe', text: '#1e40af', avatar: '#2563eb' },
  'Technician':   { bg: '#dcfce7', text: '#166534', avatar: '#16a34a' },
  'Team Leader':  { bg: '#ffedd5', text: '#9a3412', avatar: '#ea580c' },
  'PM':           { bg: '#ede9fe', text: '#5b21b6', avatar: '#7c3aed' },
  'CEO':          { bg: '#fee2e2', text: '#991b1b', avatar: '#dc2626' },
  'Engineer EHS': { bg: '#ccfbf1', text: '#134e4a', avatar: '#0d9488' },
};

const TBULK_FIELDS = [
  { key: 'monthly_salary', label: 'Monthly Salary' },
  { key: 'role',           label: 'Job Title' },
  { key: 'phone',          label: 'Phone' },
  { key: 'notes',          label: 'Notes' },
  { key: 'status',         label: 'Status' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmRoleColor(role: string | null) {
  return TM_ROLE_COLORS[role || ''] || { bg: '#f1f5f9', text: '#475569', avatar: '#64748b' };
}

function tmInitials(name: string): string {
  const p = (name || '').trim().split(/\s+/).filter(Boolean);
  return (p.length >= 2 ? p[0][0] + p[p.length - 1][0] : (p[0] || '?')[0]).toUpperCase();
}

function tmDaysAgo(dateStr: string): string {
  if (!dateStr) return '';
  const d = Math.round((Date.now() - new Date(dateStr + 'T00:00:00').getTime()) / 86400000);
  return d === 0 ? 'today' : d + ' day' + (d !== 1 ? 's' : '') + ' ago';
}

function tmWorkedDuration(fromStr: string, toStr: string): string {
  if (!fromStr || !toStr) return '';
  const d = Math.round((new Date(toStr + 'T00:00:00').getTime() - new Date(fromStr + 'T00:00:00').getTime()) / 86400000);
  return d + ' day' + (d !== 1 ? 's' : '') + ' worked';
}

function fmtDMY(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  const [yr, mo, dy] = dateStr.split('-');
  return `${dy}/${mo}/${yr}`;
}

function fmtIqd(n: number | null): string {
  if (n == null) return '—';
  const v = Math.round(n);
  return isNaN(v) ? '—' : v.toLocaleString('en-US') + ' IQD';
}

function getColVal(m: TeamMember, col: string): string {
  if (col === 'name')   return m.full_name || '';
  if (col === 'salary') return String(m.monthly_salary || 0);
  if (col === 'role')   return m.role || '';
  if (col === 'phone')  return m.phone || '';
  if (col === 'notes')  return m.notes || '';
  if (col === 'status') return m.is_active ? 'Active' : 'Inactive';
  return '';
}

function today(): string { return new Date().toISOString().split('T')[0]; }

// ── Main component ────────────────────────────────────────────────────────────

export default function FinTeam() {
  const { hasPerm } = useAuth();

  // Data
  const [members, setMembers]   = useState<TeamMember[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error,   setError]     = useState<string | null>(null);

  // Filter state
  const [statFilter,  setStatFilter]  = useState<string | null>(null);
  const [search,      setSearch]      = useState('');
  const [dropFilters, setDropFilters] = useState<Record<string, Set<string>>>({});

  // Column filter dropdown
  const [ddOpenCol, setDdOpenCol] = useState<string | null>(null);
  const [ddPos,     setDdPos]     = useState({ top: 0, left: 0 });
  const [ddSearch,  setDdSearch]  = useState('');
  const ddRef = useRef<HTMLDivElement>(null);

  // Edit/Add modal
  const [editModal, setEditModal] = useState<{
    id: string | null;
    name: string; salary: string; role: string; phone: string; notes: string;
    saving: boolean; error: string | null;
  } | null>(null);

  // Toggle (activate/deactivate) modal
  const [toggleModal, setToggleModal] = useState<{
    id: string; val: boolean; name: string; date: string; saving: boolean;
  } | null>(null);

  // Delete modal
  const [delModal, setDelModal] = useState<{
    id: string; name: string; isActive: boolean;
    saving: boolean; deactivateSaving: boolean; errMsg: string | null;
  } | null>(null);

  // Bulk update modal
  const [bulkOpen,    setBulkOpen]    = useState(false);
  const [bulkTab,     setBulkTab]     = useState<'same' | 'diff'>('same');
  const [bulkColSame, setBulkColSame] = useState('');
  const [bulkValSame, setBulkValSame] = useState('');
  const [bulkNames,   setBulkNames]   = useState('');
  const [bulkDiffCols, setBulkDiffCols] = useState<string[]>(['']);
  const [bulkDiffPaste, setBulkDiffPaste] = useState('');
  const [bulkSaving,  setBulkSaving]  = useState(false);

  // Bulk add modal
  const [bulkAddOpen,  setBulkAddOpen]  = useState(false);
  const [bulkAddPaste, setBulkAddPaste] = useState('');
  const [bulkAddRows,  setBulkAddRows]  = useState<BulkAddRow[]>([]);
  const [bulkAddCount, setBulkAddCount] = useState('');
  const [bulkAddErr,   setBulkAddErr]   = useState('');
  const [bulkAddSaving, setBulkAddSaving] = useState(false);

  // Toast
  const [toast,     setToast]     = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Permission gate ──────────────────────────────────────────────────────────

  if (!hasPerm('view_fin_team')) {
    return (
      <div className={styles.page}>
        <div className={styles.placeholder}>You don't have permission to view this page.</div>
      </div>
    );
  }

  // ── Data loading ─────────────────────────────────────────────────────────────

  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase
      .from('team_members')
      .select('id, full_name, monthly_salary, role, phone, notes, is_active, activated_at, deactivated_at, start_date')
      .order('full_name', { ascending: true });
    if (err) { setError(err.message); setLoading(false); return; }
    setMembers((data || []) as TeamMember[]);
    setLoading(false);
  }

  // ── Toast ────────────────────────────────────────────────────────────────────

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  // ── Filtering ────────────────────────────────────────────────────────────────

  function getStatRows(): TeamMember[] {
    if (!statFilter) return members;
    if (statFilter === 'active')   return members.filter(m => m.is_active);
    if (statFilter === 'inactive') return members.filter(m => !m.is_active);
    if (statFilter.startsWith('role:')) {
      const role = statFilter.slice(5);
      return members.filter(m => (m.role || '') === role);
    }
    return members;
  }

  function getFilteredRows(): TeamMember[] {
    let rows = getStatRows();
    Object.entries(dropFilters).forEach(([col, allowed]) => {
      rows = rows.filter(m => allowed.has(getColVal(m, col)));
    });
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(m =>
        (m.full_name || '').toLowerCase().includes(q) ||
        (m.role || '').toLowerCase().includes(q) ||
        (m.phone || '').toLowerCase().includes(q) ||
        (m.notes || '').toLowerCase().includes(q),
      );
    }
    return rows;
  }

  function handleStatFilter(key: string) {
    setStatFilter(prev => (!prev && key === 'all') || prev === key ? null : key);
    setDropFilters({});
    setSearch('');
  }

  // ── Column filter dropdown ───────────────────────────────────────────────────

  function getDdAllVals(col: string): string[] {
    return [...new Set(members.map(m => getColVal(m, col)))].sort((a, b) => {
      const na = Number(a), nb = Number(b);
      return (!isNaN(na) && !isNaN(nb)) ? na - nb : a.localeCompare(b);
    });
  }

  function getDdCounts(col: string): Record<string, number> {
    const statSet = new Set(getStatRows());
    const ctx = members.filter(m => {
      if (!statSet.has(m)) return false;
      return Object.entries(dropFilters).every(([c, allowed]) => c === col ? true : allowed.has(getColVal(m, c)));
    });
    const counts: Record<string, number> = {};
    ctx.forEach(m => { const v = getColVal(m, col); counts[v] = (counts[v] || 0) + 1; });
    return counts;
  }

  function openDd(col: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (ddOpenCol === col) { setDdOpenCol(null); return; }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDdPos({ top: rect.bottom + 4, left: Math.min(rect.left, window.innerWidth - 248) });
    setDdOpenCol(col);
    setDdSearch('');
  }

  function closeDd() { setDdOpenCol(null); }

  function ddToggleVal(col: string, val: string, checked: boolean) {
    setDropFilters(prev => {
      const next = { ...prev };
      const allVals = getDdAllVals(col);
      if (!next[col]) next[col] = new Set(allVals);
      const s = new Set(next[col]);
      if (checked) s.add(val); else s.delete(val);
      if (s.size >= allVals.length) delete next[col]; else next[col] = s;
      return next;
    });
  }

  function ddToggleAll(col: string, checked: boolean) {
    setDropFilters(prev => {
      const next = { ...prev };
      if (checked) delete next[col];
      else next[col] = new Set();
      return next;
    });
  }

  // Close dd on outside click
  useEffect(() => {
    if (!ddOpenCol) return;
    function onOutside(e: MouseEvent) {
      if (ddRef.current && !ddRef.current.contains(e.target as Node)) closeDd();
    }
    setTimeout(() => document.addEventListener('click', onOutside), 10);
    return () => document.removeEventListener('click', onOutside);
  }, [ddOpenCol]);

  // ── Add / Edit ───────────────────────────────────────────────────────────────

  function openEditModal(id: string | null) {
    const m = id ? members.find(x => x.id === id) : null;
    setEditModal({
      id,
      name:   m?.full_name || '',
      salary: m?.monthly_salary != null ? String(m.monthly_salary) : '',
      role:   m?.role || '',
      phone:  m?.phone || '',
      notes:  m?.notes || '',
      saving: false, error: null,
    });
  }

  async function saveEditModal() {
    if (!editModal) return;
    const name   = editModal.name.trim();
    const salary = parseFloat(editModal.salary);
    if (!name) { setEditModal(p => p && ({ ...p, error: 'Name is required.' })); return; }
    if (!editModal.salary || isNaN(salary) || salary < 0) {
      setEditModal(p => p && ({ ...p, error: 'Valid salary required.' })); return;
    }
    setEditModal(p => p && ({ ...p, saving: true, error: null }));
    const payload = {
      full_name: name,
      monthly_salary: salary,
      role:  editModal.role.trim()  || null,
      phone: editModal.phone.trim() || null,
      notes: editModal.notes.trim() || null,
    };
    if (editModal.id) {
      const { error } = await supabase.from('team_members').update(payload).eq('id', editModal.id);
      if (error) { setEditModal(p => p && ({ ...p, saving: false, error: error.message })); return; }
      showToast('Member updated', true);
    } else {
      const { error } = await supabase.from('team_members').insert({
        ...payload, is_active: true, activated_at: today(), deactivated_at: null,
      });
      if (error) { setEditModal(p => p && ({ ...p, saving: false, error: error.message })); return; }
      showToast('Member added', true);
    }
    setEditModal(null);
    loadData();
  }

  // ── Activate / Deactivate ────────────────────────────────────────────────────

  function openToggleModal(id: string, val: boolean) {
    const m = members.find(x => x.id === id);
    setToggleModal({ id, val, name: m?.full_name || 'this member', date: today(), saving: false });
  }

  async function confirmToggle() {
    if (!toggleModal) return;
    setToggleModal(p => p && ({ ...p, saving: true }));
    const upd: Record<string, unknown> = { is_active: toggleModal.val };
    if (toggleModal.val) { upd.activated_at = toggleModal.date; upd.deactivated_at = null; }
    else { upd.deactivated_at = toggleModal.date; }
    const { error } = await supabase.from('team_members').update(upd).eq('id', toggleModal.id);
    if (error) { showToast(error.message, false); setToggleModal(null); return; }
    showToast(toggleModal.val ? 'Member activated' : 'Member deactivated', true);
    setToggleModal(null);
    loadData();
  }

  // ── Delete ───────────────────────────────────────────────────────────────────

  function openDelModal(id: string) {
    const m = members.find(x => x.id === id);
    setDelModal({ id, name: m?.full_name || 'this member', isActive: m?.is_active ?? false, saving: false, deactivateSaving: false, errMsg: null });
  }

  async function confirmDelete() {
    if (!delModal) return;
    setDelModal(p => p && ({ ...p, saving: true, errMsg: null }));
    const { error } = await supabase.from('team_members').delete().eq('id', delModal.id);
    if (error) {
      const isFk = error.code === '23503' || (error.message || '').toLowerCase().includes('foreign key');
      setDelModal(p => p && ({
        ...p, saving: false,
        errMsg: isFk
          ? `Cannot delete "${delModal.name}" because they have related records. Please deactivate them instead.`
          : error.message,
      }));
      return;
    }
    showToast('Member deleted', true);
    setDelModal(null);
    loadData();
  }

  async function confirmDeactivate() {
    if (!delModal) return;
    setDelModal(p => p && ({ ...p, deactivateSaving: true }));
    const { error } = await supabase.from('team_members')
      .update({ is_active: false, deactivated_at: today() }).eq('id', delModal.id);
    if (error) { showToast(error.message, false); setDelModal(p => p && ({ ...p, deactivateSaving: false })); return; }
    showToast(`${delModal.name} deactivated`, true);
    setDelModal(null);
    loadData();
  }

  // ── Export ───────────────────────────────────────────────────────────────────

  async function handleExport() {
    if (!members.length) { showToast('No data to export', false); return; }
    try {
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Team Members');
      ws.columns = [
        { header: 'Full Name',      key: 'a', width: 28 },
        { header: 'Monthly Salary', key: 'b', width: 18 },
        { header: 'Job Title',      key: 'c', width: 20 },
        { header: 'Phone',          key: 'd', width: 16 },
        { header: 'Notes',          key: 'e', width: 30 },
        { header: 'Status',         key: 'f', width: 10 },
        { header: 'Active Since',   key: 'g', width: 14 },
        { header: 'Left On',        key: 'h', width: 12 },
      ];
      members.forEach(m => {
        ws.addRow({
          a: m.full_name,
          b: m.monthly_salary || 0,
          c: m.role || '',
          d: m.phone || '',
          e: m.notes || '',
          f: m.is_active ? 'Active' : 'Inactive',
          g: fmtDMY(m.activated_at || m.start_date),
          h: (!m.is_active && m.deactivated_at) ? fmtDMY(m.deactivated_at) : '—',
        });
      });
      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `Team_Members_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      showToast('Export ready', true);
    } catch (e) { showToast('Export failed: ' + (e as Error).message, false); }
  }

  // ── Bulk update — same value ─────────────────────────────────────────────────

  async function applyBulkSame() {
    if (!bulkColSame) return;
    const names = bulkNames.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    if (!names.length) return;
    let hit = 0, miss = 0;
    const updates: Array<{ id: string; payload: Record<string, unknown> }> = [];
    names.forEach(name => {
      const m = members.find(x => x.full_name.toLowerCase() === name.toLowerCase());
      if (!m) { miss++; return; }
      hit++;
      let payload: Record<string, unknown>;
      if (bulkColSame === 'status')
        payload = { is_active: bulkValSame === 'true' };
      else if (bulkColSame === 'monthly_salary')
        payload = { monthly_salary: +bulkValSame || 0 };
      else
        payload = { [bulkColSame]: bulkValSame || null };
      updates.push({ id: m.id, payload });
    });
    if (!hit) { showToast('No matching member names found', false); return; }
    setBulkSaving(true);
    try {
      await Promise.all(updates.map(u => supabase.from('team_members').update(u.payload).eq('id', u.id)));
      setBulkOpen(false);
      showToast(miss > 0 ? `Updated ${hit} · ${miss} not found` : `Updated ${hit} member${hit !== 1 ? 's' : ''}`, true);
      loadData();
    } catch (e) { showToast('Update failed: ' + (e as Error).message, false); }
    finally { setBulkSaving(false); }
  }

  // ── Bulk update — different values ───────────────────────────────────────────

  async function applyBulkDiff() {
    const cols = bulkDiffCols.filter(c => c !== '');
    if (!cols.length) return;
    if (!bulkDiffPaste.trim()) return;
    const entries = bulkDiffPaste.split('\n')
      .map(l => l.trim()).filter(Boolean)
      .map(line => {
        const parts = line.includes('\t') ? line.split('\t').map(p => p.trim()) : line.split(',').map(p => p.trim());
        return { name: parts[0] || '', vals: parts.slice(1) };
      }).filter(e => e.name);
    if (!entries.length) return;
    let hit = 0, miss = 0;
    const updates: Array<{ id: string; payload: Record<string, unknown> }> = [];
    entries.forEach(({ name, vals }) => {
      const m = members.find(x => x.full_name.toLowerCase() === name.toLowerCase());
      if (!m) { miss++; return; }
      hit++;
      const payload: Record<string, unknown> = {};
      cols.forEach((k, i) => {
        const v = (vals[i] ?? '').trim();
        if (v === '') return;
        if (k === 'status') payload.is_active = v.toLowerCase() === 'active';
        else if (k === 'monthly_salary') payload.monthly_salary = +v;
        else payload[k] = v || null;
      });
      if (Object.keys(payload).length) updates.push({ id: m.id, payload });
    });
    if (!hit) { showToast('No matching member names found', false); return; }
    setBulkSaving(true);
    try {
      await Promise.all(updates.map(u => supabase.from('team_members').update(u.payload).eq('id', u.id)));
      setBulkOpen(false);
      showToast(miss > 0 ? `Updated ${hit} · ${miss} not found` : `Updated ${hit} member${hit !== 1 ? 's' : ''}`, true);
      loadData();
    } catch (e) { showToast('Update failed: ' + (e as Error).message, false); }
    finally { setBulkSaving(false); }
  }

  // ── Bulk add — parse ─────────────────────────────────────────────────────────

  function parseBulkAdd() {
    const raw = bulkAddPaste.trim();
    setBulkAddErr('');
    if (!raw) { setBulkAddRows([]); setBulkAddCount(''); return; }

    const existingNames = new Set(members.map(m => m.full_name.toLowerCase()));

    function tokenize(line: string) {
      return line.split(/\t+| {2,}/).map(t => t.trim()).filter(Boolean);
    }
    function isSalaryToken(t: string) { return /^[\d,]+$/.test(t) && t.replace(/,/g, '').length > 0; }
    function isPhoneToken(t: string) { return /^\d{10,}$/.test(t.replace(/[\s\-\(\)\+]/g, '')); }

    const rows: BulkAddRow[] = [];
    for (const line of raw.split('\n').map(l => l.trim()).filter(Boolean)) {
      const tokens = tokenize(line);
      const pivotIdx = tokens.findIndex(isSalaryToken);
      if (pivotIdx < 0) continue;
      const name = tokens.slice(0, pivotIdx).join(' ').trim();
      if (!name) continue;
      const salary = parseInt(tokens[pivotIdx].replace(/,/g, ''), 10);
      let phone: string | null = null;
      const roleParts: string[] = [];
      for (const t of tokens.slice(pivotIdx + 1)) {
        if (!phone && isPhoneToken(t)) phone = t;
        else roleParts.push(t);
      }
      rows.push({
        full_name: name,
        monthly_salary: isNaN(salary) ? 0 : salary,
        role: roleParts.join(' ').trim() || null,
        phone,
        notes: null,
        is_active: true,
        _dup: existingNames.has(name.toLowerCase()),
      });
    }

    if (!rows.length) {
      setBulkAddRows([]);
      setBulkAddErr('No valid rows found. Each row needs a name then a salary number (e.g. 650,000).');
      return;
    }

    const dupCount = rows.filter(r => r._dup).length;
    const newCount = rows.length - dupCount;
    setBulkAddRows(rows);
    setBulkAddCount(
      `${rows.length} row${rows.length !== 1 ? 's' : ''} found` +
      (dupCount > 0 ? ` · ${dupCount} duplicate${dupCount !== 1 ? 's' : ''} will be skipped · ${newCount} will be imported` : ''),
    );
    if (newCount === 0) setBulkAddErr('All rows are duplicates — nothing new to import.');
  }

  async function importBulkAdd() {
    const toInsert = bulkAddRows.filter(r => !r._dup).map(({ _dup: _, ...r }) => ({ ...r, activated_at: today() }));
    if (!toInsert.length) return;
    setBulkAddSaving(true);
    setBulkAddErr('');
    let added = 0;
    const failures: string[] = [];
    try {
      const { data, error } = await supabase.from('team_members').insert(toInsert).select('*');
      if (error) throw error;
      added = (data || []).length;
    } catch {
      for (const member of toInsert) {
        try {
          const { data, error } = await supabase.from('team_members').insert(member).select('*');
          if (error) throw error;
          if (data?.[0]) added++;
        } catch (e) { failures.push(`${member.full_name}: ${(e as Error).message}`); }
      }
    }
    setBulkAddSaving(false);
    if (added === 0) {
      setBulkAddErr(failures.length ? 'Import failed — ' + failures[0] : 'No members were saved.'); return;
    }
    setBulkAddOpen(false);
    showToast(failures.length ? `Added ${added} · ${failures.length} failed` : `Added ${added} member${added !== 1 ? 's' : ''} successfully`, !failures.length);
    loadData();
  }

  // ── Render helpers ───────────────────────────────────────────────────────────

  const filteredRows = getFilteredRows();
  const roles = [...members.reduce((s, m) => { if (m.role) s.add(m.role); return s; }, new Set<string>())].sort();

  const colLabels: Record<string, string> = {
    name: 'Full Name', salary: 'Monthly Salary', role: 'Job Title', phone: 'Phone', notes: 'Notes', status: 'Status',
  };

  function ColTh({ col, label }: { col: string; label: string }) {
    const isOn = !!dropFilters[col];
    return (
      <th>
        <div className={styles.thInner}>
          <span>{label}</span>
          <button
            className={`${styles.ddBtn} ${isOn ? styles.ddBtnOn : ''}`}
            onClick={e => openDd(col, e)}
            title="Filter"
          >
            <FilterIcon />
          </button>
        </div>
      </th>
    );
  }

  function renderDd() {
    if (!ddOpenCol) return null;
    const col      = ddOpenCol;
    const allVals  = getDdAllVals(col);
    const counts   = getDdCounts(col);
    const selected = dropFilters[col] ?? null;
    const allOn    = !selected;
    const filtered = ddSearch
      ? allVals.filter(v => String(v).toLowerCase().includes(ddSearch.toLowerCase()))
      : allVals;

    return createPortal(
      <div ref={ddRef} className={styles.ddPortal} style={{ top: ddPos.top, left: ddPos.left }}>
        <div className={styles.ddHead}>
          <span className={styles.ddHeadName}>{colLabels[col] || col}</span>
          <span className={styles.ddHeadCount}>{allVals.length} values</span>
        </div>
        <div className={styles.ddSearchWrap}>
          <input
            className={styles.ddSearchInput}
            type="text"
            placeholder="Search values…"
            value={ddSearch}
            onChange={e => setDdSearch(e.target.value)}
            autoFocus
          />
        </div>
        <div className={styles.ddList}>
          <label className={`${styles.ddItem} ${styles.selectAll}`}>
            <input
              type="checkbox"
              checked={allOn}
              onChange={e => ddToggleAll(col, e.target.checked)}
            />
            <span className={styles.ddItemLabel}>Select All</span>
          </label>
          {filtered.map(v => {
            const chk = allOn || (selected?.has(v) ?? false);
            const lbl = col === 'salary' ? fmtIqd(Number(v)) : (v || <em style={{ opacity: .45 }}>Empty</em>);
            return (
              <label key={v} className={styles.ddItem}>
                <input type="checkbox" checked={chk} onChange={e => ddToggleVal(col, v, e.target.checked)} />
                <span className={styles.ddItemLabel}>{lbl}</span>
                <span className={styles.ddItemCount}>{counts[v] ?? 0}</span>
              </label>
            );
          })}
        </div>
        <div className={styles.ddFooter}>
          <span className={styles.ddFooterInfo}>
            {allOn ? allVals.length : (selected?.size ?? 0)} of {allVals.length}
          </span>
          <button className={styles.ddOk} onClick={closeDd}>Done</button>
        </div>
      </div>,
      document.body,
    );
  }

  // ── Main render ──────────────────────────────────────────────────────────────

  return (
    <div className={styles.page}>

      {/* ── Stat cards ──────────────────────────────────────────────────────── */}
      <div className={styles.statRow}>
        {[
          { key: 'all',      label: 'Total Members', value: members.length,                  color: '#2563eb' },
          { key: 'active',   label: 'Active',        value: members.filter(m => m.is_active).length,  color: '#16a34a' },
          { key: 'inactive', label: 'Inactive',      value: members.filter(m => !m.is_active).length, color: '#94a3b8' },
          ...roles.map(r => ({ key: `role:${r}`, label: r, value: members.filter(m => m.role === r).length, color: tmRoleColor(r).avatar })),
        ].map(({ key, label, value, color }) => {
          const isActive = statFilter === key || (!statFilter && key === 'all');
          return (
            <div
              key={key}
              className={`${styles.statCard} ${isActive ? styles.statCardActive : ''}`}
              style={isActive ? { borderColor: color, background: color + '18', color } : { color }}
              onClick={() => handleStatFilter(key)}
            >
              <div className={styles.statLabel}>{label}</div>
              <div className={styles.statValue} style={{ color }}>{value}</div>
            </div>
          );
        })}
      </div>

      {/* ── Search ──────────────────────────────────────────────────────────── */}
      <div className={styles.searchWrap}>
        <span className={styles.searchIcon}><SearchSm /></span>
        <input
          className={styles.searchInp}
          type="text"
          placeholder="Search by name, role, phone…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {search && (
          <button className={styles.searchClear} onClick={() => setSearch('')}>×</button>
        )}
      </div>

      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <div className={styles.toolbar}>
        <div className={styles.spacer} />
        <button className={`${styles.btn} ${styles.btnGhost}`} onClick={loadData} disabled={loading}>
          <RefreshIcon /> Refresh
        </button>
        <button className={`${styles.btn} ${styles.btnGhost}`} onClick={handleExport}>
          <DownloadIcon /> Export
        </button>
        <button className={`${styles.btn} ${styles.btnOrange}`} onClick={() => {
          setBulkTab('same'); setBulkColSame(''); setBulkValSame(''); setBulkNames('');
          setBulkDiffCols(['']); setBulkDiffPaste(''); setBulkOpen(true);
        }}>
          <EditIcon /> Bulk Update
        </button>
        <button className={`${styles.btn} ${styles.btnGreen}`} onClick={() => {
          setBulkAddPaste(''); setBulkAddRows([]); setBulkAddCount(''); setBulkAddErr('');
          setBulkAddOpen(true);
        }}>
          <UploadIcon /> Bulk Add
        </button>
        <button className={`${styles.btn} ${styles.btnAccent}`} onClick={() => openEditModal(null)}>
          + Add Member
        </button>
      </div>

      {/* ── Table ───────────────────────────────────────────────────────────── */}
      {loading ? (
        <div className={styles.loadingBar}>Loading…</div>
      ) : error ? (
        <div className={styles.errorMsg}>{error}</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <ColTh col="name"   label="Full Name" />
                <ColTh col="salary" label="Monthly Salary" />
                <ColTh col="role"   label="Job Title" />
                <ColTh col="status" label="Status" />
                <th><span className={styles.thPlain}>Active Since</span></th>
                <th><span className={styles.thPlain}>Left On</span></th>
                <th><span className={styles.thPlain}>Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 ? (
                <tr className={styles.emptyRow}>
                  <td colSpan={7}>No members match this filter.</td>
                </tr>
              ) : filteredRows.map(m => {
                const rc       = tmRoleColor(m.role);
                const actRaw   = m.activated_at || m.start_date;
                const actFmt   = fmtDMY(actRaw);
                const actSub   = (!m.is_active && m.deactivated_at && actRaw)
                  ? tmWorkedDuration(actRaw, m.deactivated_at)
                  : actRaw ? tmDaysAgo(actRaw) : '';
                const leftRaw  = (!m.is_active && m.deactivated_at) ? m.deactivated_at : null;
                return (
                  <tr key={m.id}>
                    <td>
                      <div className={styles.memberCell}>
                        <div className={styles.avatar} style={{ background: rc.avatar }}>
                          {tmInitials(m.full_name)}
                        </div>
                        <strong className={styles.memberName}>{m.full_name}</strong>
                      </div>
                    </td>
                    <td className={styles.numCell}>{fmtIqd(m.monthly_salary)}</td>
                    <td>
                      {m.role
                        ? <span className={styles.roleBadge} style={{ background: rc.bg, color: rc.text }}>{m.role}</span>
                        : <span style={{ color: 'var(--text-muted)' }}>—</span>
                      }
                    </td>
                    <td>
                      <span className={`${styles.statusBadge} ${m.is_active ? styles.statusBadgeActive : styles.statusBadgeInactive}`}>
                        <span className={`${styles.statusDot} ${m.is_active ? styles.statusDotActive : styles.statusDotInactive}`} />
                        {m.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td>
                      <div>{actFmt}</div>
                      {actSub && <div className={styles.dateSub}>{actSub}</div>}
                    </td>
                    <td style={{ color: 'var(--text-secondary)' }}>{fmtDMY(leftRaw)}</td>
                    <td>
                      <div className={styles.actGroup}>
                        <button className={styles.actBtn} title="Edit" onClick={() => openEditModal(m.id)}>
                          <EditIcon />
                        </button>
                        <button
                          className={`${styles.actBtn} ${m.is_active ? styles.actBtnDeactivate : styles.actBtnActivate}`}
                          title={m.is_active ? 'Deactivate' : 'Activate'}
                          onClick={() => openToggleModal(m.id, !m.is_active)}
                        >
                          <PowerIcon />
                        </button>
                        <button className={`${styles.actBtn} ${styles.actBtnDelete}`} title="Delete" onClick={() => openDelModal(m.id)}>
                          <TrashIcon />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Column filter dropdown portal ────────────────────────────────────── */}
      {renderDd()}

      {/* ── Add/Edit modal ───────────────────────────────────────────────────── */}
      {editModal && createPortal(
        <div className={styles.overlay} onClick={() => !editModal.saving && setEditModal(null)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalTitle}>{editModal.id ? 'Edit Team Member' : 'Add Team Member'}</div>
            <div className={styles.modalRow}>
              <label className={styles.modalLabel}>Full Name *</label>
              <input className={styles.modalInput} autoFocus value={editModal.name}
                onChange={e => setEditModal(p => p && ({ ...p, name: e.target.value }))}
                onKeyDown={e => e.key === 'Enter' && saveEditModal()} />
            </div>
            <div className={styles.modalRow}>
              <label className={styles.modalLabel}>Monthly Salary (IQD) *</label>
              <input className={styles.modalInput} type="number" min="0" value={editModal.salary}
                onChange={e => setEditModal(p => p && ({ ...p, salary: e.target.value }))} />
            </div>
            <div className={styles.modalRow}>
              <label className={styles.modalLabel}>Job Title</label>
              <select className={styles.modalSelect} value={editModal.role}
                onChange={e => setEditModal(p => p && ({ ...p, role: e.target.value }))}>
                <option value="">— Select role —</option>
                {Object.keys(TM_ROLE_COLORS).map(r => <option key={r} value={r}>{r}</option>)}
                {editModal.role && !TM_ROLE_COLORS[editModal.role] && <option value={editModal.role}>{editModal.role}</option>}
              </select>
            </div>
            <div className={styles.modalRow}>
              <label className={styles.modalLabel}>Phone</label>
              <input className={styles.modalInput} value={editModal.phone}
                onChange={e => setEditModal(p => p && ({ ...p, phone: e.target.value }))} />
            </div>
            <div className={styles.modalRow}>
              <label className={styles.modalLabel}>Notes</label>
              <textarea className={styles.modalTextarea} value={editModal.notes}
                onChange={e => setEditModal(p => p && ({ ...p, notes: e.target.value }))} />
            </div>
            {editModal.error && <div className={styles.modalError}>{editModal.error}</div>}
            <div className={styles.modalActions}>
              <button className={styles.btnPrimary} disabled={editModal.saving} onClick={saveEditModal}>
                {editModal.saving ? 'Saving…' : (editModal.id ? 'Save Changes' : 'Add Member')}
              </button>
              <button className={styles.btnGhostMd} disabled={editModal.saving} onClick={() => setEditModal(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* ── Toggle active modal ──────────────────────────────────────────────── */}
      {toggleModal && createPortal(
        <div className={styles.overlay} onClick={() => !toggleModal.saving && setToggleModal(null)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalTitle}>{toggleModal.val ? 'Activate' : 'Deactivate'} Team Member</div>
            <div className={styles.modalDesc}>
              Are you sure you want to {toggleModal.val ? 'activate' : 'deactivate'} {toggleModal.name}?
            </div>
            <div className={styles.modalRow}>
              <label className={styles.modalLabel}>{toggleModal.val ? 'Active Since' : 'Left On'}</label>
              <input className={styles.modalInput} type="date" value={toggleModal.date}
                onChange={e => setToggleModal(p => p && ({ ...p, date: e.target.value }))} />
            </div>
            <div className={styles.modalActions}>
              <button
                className={toggleModal.val ? styles.btnPrimary : styles.btnWarning}
                disabled={toggleModal.saving}
                onClick={confirmToggle}
              >
                {toggleModal.saving ? 'Saving…' : (toggleModal.val ? 'Activate' : 'Deactivate')}
              </button>
              <button className={styles.btnGhostMd} disabled={toggleModal.saving} onClick={() => setToggleModal(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* ── Delete modal ─────────────────────────────────────────────────────── */}
      {delModal && createPortal(
        <div className={styles.overlay} onClick={() => !delModal.saving && !delModal.deactivateSaving && setDelModal(null)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalTitle}>Delete Team Member</div>
            <div className={styles.modalDesc}>
              Are you sure you want to delete "{delModal.name}"? This action cannot be undone.
            </div>
            {delModal.errMsg && <div className={styles.modalError}>{delModal.errMsg}</div>}
            <div className={styles.modalActions}>
              <button className={styles.btnDanger} disabled={delModal.saving} onClick={confirmDelete}>
                {delModal.saving ? 'Deleting…' : 'Delete'}
              </button>
              {delModal.isActive && (
                <button className={styles.btnWarning} disabled={delModal.deactivateSaving} onClick={confirmDeactivate}>
                  {delModal.deactivateSaving ? 'Deactivating…' : 'Deactivate Instead'}
                </button>
              )}
              <button className={styles.btnGhostMd} disabled={delModal.saving || delModal.deactivateSaving} onClick={() => setDelModal(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* ── Bulk update modal ────────────────────────────────────────────────── */}
      {bulkOpen && createPortal(
        <div className={styles.overlay} onClick={() => !bulkSaving && setBulkOpen(false)}>
          <div className={`${styles.modal} ${styles.modalLg}`} onClick={e => e.stopPropagation()}>
            <div className={styles.modalTitle}>Bulk Update Team Members</div>
            <div className={styles.bulkTabs}>
              <button className={`${styles.bulkTab} ${bulkTab === 'same' ? styles.bulkTabActive : ''}`} onClick={() => setBulkTab('same')}>
                Apply Same Value
              </button>
              <button className={`${styles.bulkTab} ${bulkTab === 'diff' ? styles.bulkTabActive : ''}`} onClick={() => setBulkTab('diff')}>
                Apply Different Values
              </button>
            </div>

            {bulkTab === 'same' && (
              <div className={styles.bulkPane}>
                <div className={styles.bulkFieldRow}>
                  <label className={styles.modalLabel}>Column to update</label>
                  <select className={styles.modalSelect} value={bulkColSame}
                    onChange={e => { setBulkColSame(e.target.value); setBulkValSame(''); }}>
                    <option value="">— Select column —</option>
                    {TBULK_FIELDS.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                  </select>
                </div>
                <div className={styles.bulkFieldRow}>
                  <label className={styles.modalLabel}>New value</label>
                  {bulkColSame === 'status' ? (
                    <select className={styles.modalSelect} value={bulkValSame} onChange={e => setBulkValSame(e.target.value)}>
                      <option value="">— Select status —</option>
                      <option value="true">Active</option>
                      <option value="false">Inactive</option>
                    </select>
                  ) : (
                    <input className={styles.modalInput} type={bulkColSame === 'monthly_salary' ? 'number' : 'text'}
                      value={bulkValSame} onChange={e => setBulkValSame(e.target.value)} placeholder="Enter new value…" />
                  )}
                </div>
                <div className={styles.bulkFieldRow}>
                  <label className={styles.modalLabel}>Member names (one per line, or comma-separated)</label>
                  <textarea className={styles.modalTextarea} value={bulkNames}
                    onChange={e => setBulkNames(e.target.value)} placeholder="Ali Jasim&#10;Ahmed Hadi&#10;…" />
                </div>
              </div>
            )}

            {bulkTab === 'diff' && (
              <div className={styles.bulkPane}>
                <div className={styles.bulkFieldRow}>
                  <label className={styles.modalLabel}>Columns to update</label>
                  {bulkDiffCols.map((col, ci) => (
                    <div key={ci} className={styles.bulkDiffColRow}>
                      <select className={styles.bulkDiffColSel} value={col}
                        onChange={e => { const nc = [...bulkDiffCols]; nc[ci] = e.target.value; setBulkDiffCols(nc); }}>
                        <option value="">— Select column —</option>
                        {TBULK_FIELDS.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                      </select>
                      {bulkDiffCols.length > 1 && (
                        <button className={styles.bulkDiffDel} onClick={() => setBulkDiffCols(bulkDiffCols.filter((_, i) => i !== ci))}>×</button>
                      )}
                    </div>
                  ))}
                  <button className={styles.bulkAddColBtn} onClick={() => setBulkDiffCols([...bulkDiffCols, ''])}>+ Add column</button>
                </div>
                <div className={styles.bulkFieldRow}>
                  <div className={styles.bulkColHeader}>
                    {['Full Name', ...bulkDiffCols.filter(c => c).map(k => TBULK_FIELDS.find(f => f.key === k)?.label ?? k)].map((h, i) => (
                      <>
                        {i > 0 && <span key={`sep-${i}`} className={styles.bulkColSep}>›</span>}
                        <span key={h} className={`${styles.bulkColChip} ${i === 0 ? styles.bulkColChipId : ''}`}>{h}</span>
                      </>
                    ))}
                  </div>
                  <textarea className={styles.modalTextarea} value={bulkDiffPaste}
                    onChange={e => setBulkDiffPaste(e.target.value)}
                    style={{ minHeight: 120 }}
                    placeholder={`Paste data here — one row per line, tab or comma separated\n\ne.g.\nAli Jasim\t150000\nAhmed Hadi\t200000`} />
                </div>
              </div>
            )}

            <div className={styles.modalActions}>
              <button className={`${styles.btn} ${styles.btnOrange}`} disabled={bulkSaving}
                onClick={bulkTab === 'same' ? applyBulkSame : applyBulkDiff}>
                {bulkSaving ? 'Saving…' : 'Apply'}
              </button>
              <button className={styles.btnGhostMd} disabled={bulkSaving} onClick={() => setBulkOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* ── Bulk add modal ───────────────────────────────────────────────────── */}
      {bulkAddOpen && createPortal(
        <div className={styles.overlay} onClick={() => !bulkAddSaving && setBulkAddOpen(false)}>
          <div className={`${styles.modal} ${styles.modalLg}`} onClick={e => e.stopPropagation()}>
            <div className={styles.modalTitle}>Bulk Add Team Members</div>
            <div className={styles.modalDesc}>
              Paste member data below. Each row: <strong>Name · Salary · Phone (optional) · Job Title (optional)</strong>.<br />
              Separate by tabs or 2+ spaces. Duplicate names (matching existing members) will be skipped.
            </div>
            <textarea className={styles.modalTextarea} style={{ minHeight: 120 }} value={bulkAddPaste}
              autoFocus
              onChange={e => setBulkAddPaste(e.target.value)}
              placeholder={'Ali Jasim\t650,000\t07901234567\tEngineer\nAhmed Hadi\t500,000\tTechnician'} />
            <div className={styles.modalActions}>
              <button className={`${styles.btn} ${styles.btnGhost}`} onClick={parseBulkAdd}>Preview</button>
            </div>
            {bulkAddErr && <div className={styles.modalError}>{bulkAddErr}</div>}
            {bulkAddRows.length > 0 && (
              <>
                <div className={styles.previewWrap}>
                  <table className={styles.previewTable}>
                    <thead><tr>
                      <th>Full Name</th><th>Monthly Salary</th><th>Job Title</th><th>Phone</th><th>Status</th>
                    </tr></thead>
                    <tbody>
                      {bulkAddRows.map((r, i) => (
                        <tr key={i} style={r._dup ? { opacity: .4 } : undefined}>
                          <td>
                            <strong>{r.full_name}</strong>
                            {r._dup && <span className={styles.dupBadge}>duplicate</span>}
                          </td>
                          <td>{r.monthly_salary?.toLocaleString('en-US')} IQD</td>
                          <td>{r.role || ''}</td>
                          <td>{r.phone || ''}</td>
                          <td><span className={r.is_active ? styles.statusBadgeActive : styles.statusBadgeInactive} style={{ padding: '2px 7px', borderRadius: 999, fontSize: 11, fontWeight: 700, display: 'inline-flex' }}>{r.is_active ? 'Active' : 'Inactive'}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {bulkAddCount && <div className={styles.previewCount}>{bulkAddCount}</div>}
                {bulkAddRows.filter(r => !r._dup).length > 0 && (
                  <div className={styles.modalActions}>
                    <button className={`${styles.btn} ${styles.btnGreen}`} disabled={bulkAddSaving} onClick={importBulkAdd}>
                      {bulkAddSaving ? 'Saving…' : <><UploadIcon /> Import</>}
                    </button>
                    <button className={styles.btnGhostMd} disabled={bulkAddSaving} onClick={() => setBulkAddOpen(false)}>Cancel</button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>,
        document.body,
      )}

      {/* ── Toast ───────────────────────────────────────────────────────────── */}
      {toast && (
        <div className={`${styles.toast} ${toast.ok ? styles.toastOk : styles.toastErr}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function SearchSm() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>;
}
function FilterIcon() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>;
}
function RefreshIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>;
}
function DownloadIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>;
}
function EditIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>;
}
function UploadIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 5 17 10"/><line x1="12" y1="5" x2="12" y2="15"/></svg>;
}
function PowerIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>;
}
function TrashIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>;
}

// Exported so Sidebar can import it
export function FinanceIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>;
}
