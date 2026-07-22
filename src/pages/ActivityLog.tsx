import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import css from './ActivityLog.module.css';

interface LogRow {
  id: string;
  created_at: string;
  user_full_name: string | null;
  action: string | null;
  project_name: string | null;
  section_name: string | null;
  details: string | null;
}

interface Filters {
  user: string;
  project: string;
  site: string;
  action: string;
  dateFrom: string;
  dateTo: string;
}

const EMPTY_FILTERS: Filters = { user: '', project: '', site: '', action: '', dateFrom: '', dateTo: '' };
const PAGE_SIZE = 20;

// Deterministic color from user name — exact copy of _alUserColor
const AVATAR_COLORS = ['#3b82f6','#8b5cf6','#ec4899','#f97316','#10b981','#06b6d4','#f59e0b','#ef4444'];
function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < (name || '').length; i++) h = (h * 31 + (name || '').charCodeAt(i)) & 0xfffffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

// Relative time — exact copy of _alRelTime
function relTime(ts: string | null): string {
  if (!ts) return '';
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60)     return 'just now';
  if (s < 3600)   return `${Math.floor(s / 60)}m ago`;
  if (s < 86400)  return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

// 4-way action classification — exact copy of _alBadge logic
type BadgeKind = 'add' | 'edit' | 'delete' | 'other';
function classifyAction(action: string | null): BadgeKind {
  if (!action) return 'other';
  const u = action.toLowerCase();
  if (/added|created|approved|submitted/.test(u)) return 'add';
  if (/edited|updated|changed|renamed/.test(u))   return 'edit';
  if (/deleted|rejected|cleared|removed/.test(u)) return 'delete';
  return 'other';
}

function ActionBadge({ action }: { action: string | null }) {
  const kind = classifyAction(action);
  const cls = kind === 'add' ? css.badgeAdd : kind === 'edit' ? css.badgeEdit : kind === 'delete' ? css.badgeDelete : css.badgeOther;
  const icon = kind === 'add'
    ? <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ flexShrink: 0 }}><polyline points="20 6 9 17 4 12"/></svg>
    : kind === 'edit'
    ? <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ flexShrink: 0 }}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
    : kind === 'delete'
    ? <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ flexShrink: 0 }}><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
    : <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}><circle cx="12" cy="12" r="6"/></svg>;
  return <span className={`${css.badge} ${cls}`}>{icon}{action || ''}</span>;
}

// Filter predicate — exact copy of _alGetFiltered
function applyFilters(rows: LogRow[], f: Filters): LogRow[] {
  const dateFrom = f.dateFrom ? (() => { const d = new Date(f.dateFrom); d.setHours(0, 0, 0, 0); return d; })() : null;
  const dateTo   = f.dateTo   ? (() => { const d = new Date(f.dateTo);   d.setHours(23, 59, 59, 999); return d; })() : null;
  const siteLower = f.site.toLowerCase();
  return rows.filter(r => {
    if (f.user    && r.user_full_name !== f.user)    return false;
    if (f.project && r.project_name  !== f.project)  return false;
    if (siteLower && !(r.details || '').toLowerCase().includes(siteLower)) return false;
    if (dateFrom && new Date(r.created_at) < dateFrom) return false;
    if (dateTo   && new Date(r.created_at) > dateTo)   return false;
    if (f.action) {
      const u = (r.action || '').toLowerCase();
      if (f.action === 'add'    && !/added|created|approved|submitted/.test(u)) return false;
      if (f.action === 'edit'   && !/edited|updated|changed|renamed/.test(u))   return false;
      if (f.action === 'delete' && !/deleted|rejected|cleared|removed/.test(u)) return false;
      if (f.action === 'other'  && /added|created|approved|submitted|edited|updated|changed|renamed|deleted|rejected|cleared|removed/.test(u)) return false;
    }
    return true;
  });
}

export default function ActivityLog() {
  const { hasPerm, currentUser } = useAuth();
  const [rows,    setRows]    = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page,    setPage]    = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [toast,   setToast]   = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!hasPerm('view_activity_log')) return <div className={css.errorMsg}>Access denied.</div>;

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }

  async function load() {
    setLoading(true);
    setError('');
    const { data, error: e } = await supabase
      .from('activity_log')
      .select('*')
      .order('created_at', { ascending: false });
    if (e) { setError(e.message); setLoading(false); return; }
    setRows(data || []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function setFilter(key: keyof Filters, val: string) {
    setFilters(f => ({ ...f, [key]: val }));
    setPage(1);
  }

  function toggleRow(id: string) {
    setExpanded(prev => prev === id ? null : id);
  }

  async function clearLog() {
    if (currentUser?.role !== 'admin') return;
    if (!window.confirm('Are you sure you want to clear the entire activity log? This action cannot be undone.')) return;
    const { error: e } = await supabase.from('activity_log').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (e) { showToast('Clear failed: ' + e.message, false); return; }
    setRows([]);
    setFilters(EMPTY_FILTERS);
    setPage(1);
    setExpanded(null);
    showToast('Activity log cleared', true);
  }

  async function exportLog() {
    const exportRows = applyFilters(rows, filters);
    const headers = ['Date/Time', 'User', 'Action', 'Project', 'Section', 'Details'];
    const data = [headers, ...exportRows.map(r => [
      r.created_at ? new Date(r.created_at).toLocaleString() : '',
      r.user_full_name || '',
      r.action || '',
      r.project_name || '',
      r.section_name || '',
      r.details || '',
    ])];
    const XLSX = await import('xlsx');
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Activity Log');
    XLSX.writeFile(wb, `activity_log_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  // ── Computed ───────────────────────────────────────────────────────────────
  const users    = [...new Set(rows.map(r => r.user_full_name).filter(Boolean) as string[])].sort();
  const projects = [...new Set(rows.map(r => r.project_name).filter(Boolean) as string[])].sort();

  const filtered   = applyFilters(rows, filters);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  const pageRows   = filtered.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);

  // Stat counts from filtered (not full list — matching old app behavior)
  const totalCount = filtered.length;
  const addCount   = filtered.filter(r => classifyAction(r.action) === 'add').length;
  const editCount  = filtered.filter(r => classifyAction(r.action) === 'edit').length;
  const delCount   = filtered.filter(r => classifyAction(r.action) === 'delete').length;

  if (loading) return <div className={css.placeholder}>Loading…</div>;
  if (error)   return <div className={css.errorMsg}>{error}</div>;

  return (
    <div className={css.page}>
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className={css.pageHdr}>
        <div className={css.pageTitle}>Activity Log</div>
        <div className={css.hdrActions}>
          <button className={css.btnGhost} onClick={load}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Refresh
          </button>
        </div>
      </div>

      {/* ── Stat cards ─────────────────────────────────────────── */}
      <div className={css.stats}>
        <div className={`${css.statCard} ${css.statTotal}`} onClick={() => setFilter('action', '')}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="3"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
          <div>
            <div className={css.statNum}>{totalCount.toLocaleString()}</div>
            <div className={css.statLabel}>Total Events</div>
          </div>
        </div>
        <div className={`${css.statCard} ${css.statAdd}`} onClick={() => setFilter('action', 'add')}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
          <div>
            <div className={css.statNum}>{addCount.toLocaleString()}</div>
            <div className={css.statLabel}>Created</div>
          </div>
        </div>
        <div className={`${css.statCard} ${css.statEdit}`} onClick={() => setFilter('action', 'edit')}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          <div>
            <div className={css.statNum}>{editCount.toLocaleString()}</div>
            <div className={css.statLabel}>Edited</div>
          </div>
        </div>
        <div className={`${css.statCard} ${css.statDel}`} onClick={() => setFilter('action', 'delete')}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          <div>
            <div className={css.statNum}>{delCount.toLocaleString()}</div>
            <div className={css.statLabel}>Deleted</div>
          </div>
        </div>
      </div>

      {/* ── Toolbar / Filters ──────────────────────────────────── */}
      <div className={css.toolbar}>
        <div className={css.filterWrap}>
          <svg className={css.filterIcon} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          <select className={css.filterSel} value={filters.user} onChange={e => setFilter('user', e.target.value)}>
            <option value="">All Users</option>
            {users.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
        <div className={css.filterWrap}>
          <svg className={css.filterIcon} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M3 7h18M6 12h12M9 17h6"/></svg>
          <select className={css.filterSel} value={filters.project} onChange={e => setFilter('project', e.target.value)}>
            <option value="">All Projects</option>
            {projects.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div className={css.filterWrap}>
          <svg className={css.filterIcon} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>
          <select className={css.filterSel} value={filters.action} onChange={e => setFilter('action', e.target.value)}>
            <option value="">All Actions</option>
            <option value="add">Added</option>
            <option value="edit">Edited</option>
            <option value="delete">Deleted</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div className={css.filterWrap}>
          <svg className={css.filterIcon} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input
            className={css.filterInp}
            type="text"
            placeholder="Site ID…"
            value={filters.site}
            onChange={e => setFilter('site', e.target.value)}
          />
        </div>
        <div className={css.filterWrap}>
          <svg className={css.filterIcon} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          <input className={css.filterDate} type="date" title="Date From" value={filters.dateFrom} onChange={e => setFilter('dateFrom', e.target.value)} />
        </div>
        <span className={css.dateSep}>to</span>
        <div className={css.filterWrap}>
          <svg className={css.filterIcon} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          <input className={css.filterDate} type="date" title="Date To" value={filters.dateTo} onChange={e => setFilter('dateTo', e.target.value)} />
        </div>
        <div className={css.toolbarSpacer} />
        <button className={css.btnGhost} onClick={exportLog}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Export
        </button>
        {currentUser?.role === 'admin' && (
          <button className={css.btnClear} onClick={clearLog}>Clear Log</button>
        )}
      </div>

      {/* ── Table ──────────────────────────────────────────────── */}
      <div className={css.tableWrap}>
        <table className={css.table}>
          <thead><tr>
            <th>Date / Time</th>
            <th>User</th>
            <th>Action</th>
            <th>Project</th>
            <th>Section</th>
            <th>Details</th>
            <th style={{ width: 24 }} />
          </tr></thead>
          <tbody>
            {pageRows.length === 0
              ? <tr><td colSpan={7} className={css.empty}>No activity records found.</td></tr>
              : pageRows.map((r, i) => {
                  const id       = r.id;
                  const dt       = r.created_at ? new Date(r.created_at).toLocaleString() : '—';
                  const rel      = relTime(r.created_at);
                  const name     = r.user_full_name || '—';
                  const initials = name === '—' ? '?' : name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
                  const color    = avatarColor(name);
                  const isOpen   = expanded === id;
                  return [
                    <tr
                      key={id}
                      className={`${css.dataRow} ${css.rowAnim} ${isOpen ? css.dataRowOpen : ''}`}
                      style={{ animationDelay: `${i * 30}ms` }}
                      onClick={() => toggleRow(id)}
                    >
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <div className={css.datePrimary}>{dt}</div>
                        <div className={css.dateRel}>{rel}</div>
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <span className={css.avatar} style={{ background: color }}>{initials}</span>
                        {name}
                      </td>
                      <td><ActionBadge action={r.action} /></td>
                      <td>{r.project_name || '—'}</td>
                      <td>{r.section_name || '—'}</td>
                      <td className={css.detailsCell}>{r.details || '—'}</td>
                      <td className={css.chevronCell}>
                        <span className={`${css.chevron} ${isOpen ? css.chevronOpen : ''}`}>›</span>
                      </td>
                    </tr>,
                    <tr key={`det-${id}`} className={css.detailTr}>
                      <td colSpan={7} style={{ padding: 0 }}>
                        <div className={`${css.detailPanel} ${isOpen ? css.detailPanelOpen : ''}`}>
                          <div className={css.detailGrid}>
                            <div>
                              <div className={css.detailFieldLbl}>User</div>
                              <div className={css.detailFieldVal} style={{ fontWeight: 600 }}>{name}</div>
                            </div>
                            <div>
                              <div className={css.detailFieldLbl}>Action</div>
                              <div className={css.detailFieldVal}><ActionBadge action={r.action} /></div>
                            </div>
                            <div>
                              <div className={css.detailFieldLbl}>Timestamp</div>
                              <div className={css.detailFieldVal}>{dt}</div>
                            </div>
                            <div>
                              <div className={css.detailFieldLbl}>Project</div>
                              <div className={css.detailFieldVal}>{r.project_name || '—'}</div>
                            </div>
                            <div>
                              <div className={css.detailFieldLbl}>Section</div>
                              <div className={css.detailFieldVal}>{r.section_name || '—'}</div>
                            </div>
                            <div>
                              <div className={css.detailFieldLbl}>Details</div>
                              <div className={css.detailFieldVal} style={{ fontSize: 12, color: '#475569' }}>{r.details || '—'}</div>
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>,
                  ];
                })
            }
          </tbody>
        </table>
      </div>

      {/* ── Pagination ─────────────────────────────────────────── */}
      {(totalPages > 1 || filtered.length > 0) && (
        <div className={css.pagination}>
          <span>{filtered.length.toLocaleString()} record{filtered.length !== 1 ? 's' : ''}</span>
          <div className={css.pageNav}>
            <button className={css.btnGhost} disabled={clampedPage <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>← Prev</button>
            <span className={css.pageLabel}>Page {clampedPage} of {totalPages}</span>
            <button className={css.btnGhost} disabled={clampedPage >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>Next →</button>
          </div>
        </div>
      )}

      {toast && createPortal(
        <div className={`${css.toast} ${toast.ok ? css.toastOk : css.toastErr}`}>{toast.msg}</div>,
        document.body
      )}
    </div>
  );
}
