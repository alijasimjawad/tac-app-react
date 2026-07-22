import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { iqd, FIN_PROJECTS, FIN_MONTHS } from '../lib/finHelpers';
import css from './FinExpClaims.module.css';

interface TeamMember { id: string; full_name: string; }

interface ExpClaim {
  id: string;
  member_id: string;
  project_name: string | null;
  site_id: string | null;
  governorate: string | null;
  description: string | null;
  activity_date: string | null;
  submitted_at: string | null;
  transport_amount: number | null;
  food_amount: number | null;
  accommodation: string | null;
  total_amount: number | null;
  status: string | null;
  rejection_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  notes: string | null;
  employee_ids: string | null;
  extra_categories: string | null;
}

interface DailyActivity {
  date: string;
  site_id: string | null;
  team_member_ids: string[] | null;
}

interface Filters {
  member: string;
  project: string;
  status: string;
  month: number;
  year: number;
  search: string;
}

const EMPTY_FILTERS: Filters = { member: '', project: '', status: '', month: 0, year: 0, search: '' };

const DESC_OPTIONS = ['Delivery', 'Installation', 'Integration', 'ATP', 'Clearance', 'Other'];
const ACCOM_OPTIONS = ['', 'Returned Home', 'Hotel'];

interface EditForm {
  project_name: string;
  site_id: string;
  governorate: string;
  description: string;
  activity_date: string;
  transport_amount: number;
  accommodation: string;
  food_amount: number;
}

export default function FinExpClaims() {
  const { hasPerm, currentUser } = useAuth();
  const navigate = useNavigate();

  const [claims,     setClaims]     = useState<ExpClaim[]>([]);
  const [team,       setTeam]       = useState<TeamMember[]>([]);
  const [activities, setActivities] = useState<DailyActivity[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');
  const [filters,    setFilters]    = useState<Filters>({ ...EMPTY_FILTERS, month: new Date().getMonth() + 1, year: new Date().getFullYear() });

  // Inline reject state per row
  const [rejectOpen, setRejectOpen] = useState<Record<string, boolean>>({});
  const [rejectVal,  setRejectVal]  = useState<Record<string, string>>({});
  const [rejectErr,  setRejectErr]  = useState<Record<string, boolean>>({});

  // Detail modal
  const [detailId,   setDetailId]   = useState<string | null>(null);
  const [detailRejOpen,  setDetailRejOpen]  = useState(false);
  const [detailRejVal,   setDetailRejVal]   = useState('');
  const [detailRejErr,   setDetailRejErr]   = useState(false);
  const [editMode,   setEditMode]   = useState(false);
  const [editForm,   setEditForm]   = useState<EditForm>({ project_name: '', site_id: '', governorate: '', description: 'Delivery', activity_date: '', transport_amount: 0, accommodation: '', food_amount: 0 });
  const [editSaving, setEditSaving] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!hasPerm('view_exp_claims')) return <div className={css.errorMsg}>Access denied.</div>;

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }

  function memberName(mid: string): string {
    return team.find(t => t.id === mid)?.full_name || mid || '—';
  }

  async function load(force = false) {
    setLoading(true);
    setError('');
    const [clRes, tmRes, daRes] = await Promise.all([
      supabase.from('expense_claims').select('*').order('submitted_at', { ascending: false }),
      (team.length === 0 || force) ? supabase.from('team_members').select('id, full_name') : Promise.resolve({ data: team, error: null }),
      (activities.length === 0 || force) ? supabase.from('daily_activities').select('date, site_id, team_member_ids').order('date', { ascending: false }) : Promise.resolve({ data: activities, error: null }),
    ]);
    if (clRes.error) { setError(clRes.error.message); setLoading(false); return; }
    if (tmRes.error) console.warn('team_members fetch failed:', tmRes.error.message);
    setClaims(clRes.data || []);
    if (tmRes.data) setTeam(tmRes.data as TeamMember[]);
    if (daRes.data) setActivities(daRes.data as DailyActivity[]);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function getFiltered(): ExpClaim[] {
    const f = filters;
    return claims.filter(r => {
      const mn = (team.find(t => t.id === r.member_id)?.full_name || r.member_id || '').toLowerCase();
      if (f.member  && mn !== f.member.toLowerCase()) return false;
      if (f.project && r.project_name !== f.project) return false;
      if (f.status  && r.status !== f.status) return false;
      if (f.month && f.year) {
        const d = new Date(r.activity_date || r.submitted_at || '');
        if (isNaN(d.getTime()) || d.getMonth() + 1 !== f.month || d.getFullYear() !== f.year) return false;
      }
      if (f.search) {
        const q = f.search.toLowerCase();
        if (![mn, r.site_id || '', r.project_name || '', r.description || ''].join(' ').toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }

  function hasActivity(r: ExpClaim): boolean {
    return activities.some(a =>
      a.date === r.activity_date &&
      a.site_id === r.site_id &&
      Array.isArray(a.team_member_ids) && a.team_member_ids.includes(r.member_id)
    );
  }

  function fmtDate(s: string | null, time = false): string {
    if (!s) return '—';
    const d = new Date(s.includes('T') ? s : s + 'T00:00:00');
    if (isNaN(d.getTime())) return '—';
    if (time) return d.toLocaleString();
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  // ── Approve ────────────────────────────────────────────────────────────────
  async function approveClaim(id: string) {
    const claim = claims.find(x => x.id === id);
    if (!claim) return;
    setApprovingId(id);
    const dateObj = claim.activity_date ? new Date(claim.activity_date) : new Date();
    const projExpPayload = {
      project_name:  claim.project_name,
      description:   claim.description,
      category:      'Transport',
      amount:        claim.total_amount,
      expense_date:  claim.activity_date || null,
      activity_date: claim.activity_date || null,
      month:         dateObj.getMonth() + 1,
      year:          dateObj.getFullYear(),
      site_id:       claim.site_id || null,
      accommodation: claim.accommodation || null,
      notes:         `Expense claim from ${team.find(t => t.id === claim.member_id)?.full_name || 'team member'}. Governorate: ${claim.governorate || '—'}`,
      added_by:      currentUser?.full_name || '',
      submitted_by:  team.find(t => t.id === claim.member_id)?.full_name || null,
      approved_by:   currentUser?.full_name || currentUser?.username || '',
    };
    const { error: peErr } = await supabase.from('project_expenses').insert(projExpPayload);
    if (peErr) { showToast(peErr.message, false); setApprovingId(null); return; }
    const reviewedAt = new Date().toISOString();
    const reviewedBy = currentUser?.full_name || currentUser?.username || '';
    const { error: clErr } = await supabase.from('expense_claims')
      .update({ status: 'approved', rejection_reason: null, reviewed_by: reviewedBy, reviewed_at: reviewedAt })
      .eq('id', id);
    if (clErr) { showToast(clErr.message, false); setApprovingId(null); return; }
    setClaims(cs => cs.map(c => c.id === id ? { ...c, status: 'approved', reviewed_by: reviewedBy, reviewed_at: reviewedAt, rejection_reason: null } : c));
    // TODO(push): not yet implemented in React app — see old index.html approveExpClaim for the intended sendPushToUser/sendPushToRoles calls
    showToast('Claim approved and added to Project Expenses', true);
    setApprovingId(null);
    setDetailId(null);
  }

  // ── Inline reject (table row) ──────────────────────────────────────────────
  async function submitRowReject(id: string) {
    const reason = (rejectVal[id] || '').trim();
    if (!reason) { setRejectErr(e => ({ ...e, [id]: true })); return; }
    const rejAt = new Date().toISOString();
    const rejBy = currentUser?.full_name || currentUser?.username || '';
    const { error: e } = await supabase.from('expense_claims')
      .update({ status: 'rejected', rejection_reason: reason, reviewed_by: rejBy, reviewed_at: rejAt })
      .eq('id', id);
    if (e) { showToast(e.message, false); return; }
    setClaims(cs => cs.map(c => c.id === id ? { ...c, status: 'rejected', rejection_reason: reason, reviewed_by: rejBy, reviewed_at: rejAt } : c));
    setRejectOpen(v => ({ ...v, [id]: false }));
    setRejectVal(v => ({ ...v, [id]: '' }));
    setRejectErr(v => ({ ...v, [id]: false }));
    // TODO(push): not yet implemented in React app
    showToast('Claim rejected', true);
  }

  // ── Delete ─────────────────────────────────────────────────────────────────
  async function deleteClaim(id: string) {
    if (!window.confirm('Are you sure you want to delete this claim? This cannot be undone.')) return;
    const { error: e } = await supabase.from('expense_claims').delete().eq('id', id);
    if (e) { showToast(e.message, false); return; }
    setClaims(cs => cs.filter(c => c.id !== id));
    showToast('Claim deleted', true);
  }

  // ── Detail modal reject ────────────────────────────────────────────────────
  async function submitDetailReject() {
    const reason = detailRejVal.trim();
    if (!reason) { setDetailRejErr(true); return; }
    const id = detailId;
    if (!id) return;
    const rejAt = new Date().toISOString();
    const rejBy = currentUser?.full_name || currentUser?.username || '';
    const { error: e } = await supabase.from('expense_claims')
      .update({ status: 'rejected', rejection_reason: reason, reviewed_by: rejBy, reviewed_at: rejAt })
      .eq('id', id);
    if (e) { showToast(e.message, false); return; }
    setClaims(cs => cs.map(c => c.id === id ? { ...c, status: 'rejected', rejection_reason: reason, reviewed_by: rejBy, reviewed_at: rejAt } : c));
    // TODO(push): not yet implemented in React app
    showToast('Claim rejected', true);
    setDetailId(null);
  }

  // ── Edit form ──────────────────────────────────────────────────────────────
  function startEdit(r: ExpClaim) {
    setEditForm({
      project_name:     r.project_name   || '',
      site_id:          r.site_id        || '',
      governorate:      r.governorate    || '',
      description:      r.description   || 'Delivery',
      activity_date:    r.activity_date  || '',
      transport_amount: r.transport_amount ?? 0,
      accommodation:    r.accommodation  || '',
      food_amount:      r.food_amount    ?? 0,
    });
    setEditMode(true);
    setDetailRejOpen(false);
  }

  function onAccomChange(val: string) {
    let food = 0;
    if (val === 'Returned Home') food = 10000;
    else if (val === 'Hotel')    food = 15000;
    setEditForm(f => ({ ...f, accommodation: val, food_amount: food }));
  }

  async function saveEdit() {
    const id = detailId;
    if (!id) return;
    setEditSaving(true);
    const { project_name, site_id, governorate, description, activity_date, transport_amount, accommodation, food_amount } = editForm;
    const total_amount = transport_amount + food_amount;
    const { error: e } = await supabase.from('expense_claims').update({
      project_name, site_id: site_id.trim(), governorate: governorate.trim(),
      description, activity_date, transport_amount, accommodation, food_amount, total_amount,
    }).eq('id', id);
    if (e) { showToast(e.message, false); setEditSaving(false); return; }
    setClaims(cs => cs.map(c => c.id === id ? { ...c, project_name, site_id: site_id.trim(), governorate: governorate.trim(), description, activity_date, transport_amount, accommodation, food_amount, total_amount } : c));
    // TODO(activity-log): wire up once Admin suite / activity_log is built
    showToast('Claim updated', true);
    setEditSaving(false);
    setDetailId(null);
    setEditMode(false);
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  async function exportClaims() {
    const rows = getFiltered();
    const headers = ['Member', 'Project', 'Site ID', 'Date', 'Description', 'Total (IQD)', 'Status', 'Approved By', 'Action Date'];
    const data = [headers, ...rows.map(r => [
      memberName(r.member_id),
      r.project_name || '',
      r.site_id || '',
      r.activity_date || '',
      r.description || '',
      r.total_amount || 0,
      r.status || '',
      r.reviewed_by || '',
      r.reviewed_at ? r.reviewed_at.slice(0, 10) : '',
    ])];
    const XLSX = await import('xlsx');
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Expense Claims');
    XLSX.writeFile(wb, `ExpenseClaims_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  // ── Computed values ────────────────────────────────────────────────────────
  const totalCount    = claims.length;
  const pendingCount  = claims.filter(r => r.status === 'pending').length;
  const approvedCount = claims.filter(r => r.status === 'approved').length;
  const rejectedCount = claims.filter(r => r.status === 'rejected').length;

  const memberNames = [...new Set(claims.map(r => team.find(t => t.id === r.member_id)?.full_name).filter(Boolean) as string[])].sort();
  const projects    = [...new Set(claims.map(r => r.project_name).filter(Boolean) as string[])].sort();

  const curYear = new Date().getFullYear();
  const years = [...new Set(claims.map(r => {
    const d = new Date(r.activity_date || r.submitted_at || '');
    return isNaN(d.getTime()) ? null : d.getFullYear();
  }).filter(Boolean) as number[])].sort((a, b) => b - a);
  if (!years.includes(curYear)) years.unshift(curYear);

  const filtered = getFiltered();
  const totalApproved = filtered.filter(r => r.status === 'approved').reduce((s, r) => s + (r.total_amount || 0), 0);
  const hasApproved   = filtered.some(r => r.status === 'approved');

  const detailClaim = detailId ? claims.find(x => x.id === detailId) : null;

  // ── Status styles ──────────────────────────────────────────────────────────
  function badgeCls(status: string | null) {
    if (status === 'approved') return css.badgeApproved;
    if (status === 'rejected') return css.badgeRejected;
    return css.badgePending;
  }
  function statusLabel(status: string | null) {
    if (!status) return 'Pending';
    return status.charAt(0).toUpperCase() + status.slice(1);
  }

  if (loading) return <div className={css.placeholder}>Loading…</div>;
  if (error)   return <div className={css.errorMsg}>{error}</div>;

  return (
    <div className={css.page}>
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className={css.pageHdr}>
        <div className={css.pageTitle}>Expense Claims</div>
        <div className={css.hdrActions}>
          <button className={css.btnAccent} onClick={() => navigate('/my-expenses')}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
            My Claims
          </button>
          <button className={css.btnGhost} onClick={exportClaims}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Export Excel
          </button>
          <button className={css.btnGhost} onClick={() => load(true)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Refresh
          </button>
        </div>
      </div>

      {/* ── Stat cards ─────────────────────────────────────────── */}
      <div className={css.statCards}>
        {([
          { label: 'Total Claims', num: totalCount,    cls: css.statAll,  key: '' },
          { label: 'Pending',      num: pendingCount,  cls: css.statPend, key: 'pending' },
          { label: 'Approved',     num: approvedCount, cls: css.statAppr, key: 'approved' },
          { label: 'Rejected',     num: rejectedCount, cls: css.statRej,  key: 'rejected' },
        ] as const).map(s => (
          <div
            key={s.key}
            className={`${css.statCard} ${s.cls} ${filters.status === s.key ? css.statCardActive : ''}`}
            onClick={() => setFilters(f => ({ ...f, status: s.key }))}
          >
            <div className={css.statNum}>{s.num}</div>
            <div className={css.statLabel}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* ── Filters ────────────────────────────────────────────── */}
      <div className={css.filters}>
        <select className={css.filterSel} value={filters.member} onChange={e => setFilters(f => ({ ...f, member: e.target.value }))}>
          <option value="">All Members</option>
          {memberNames.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        <select className={css.filterSel} value={filters.project} onChange={e => setFilters(f => ({ ...f, project: e.target.value }))}>
          <option value="">All Projects</option>
          {projects.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select className={css.filterSel} value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}>
          <option value="">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
        <select className={css.filterSel} value={filters.month} onChange={e => setFilters(f => ({ ...f, month: +e.target.value }))}>
          <option value={0}>All Months</option>
          {FIN_MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
        </select>
        <select className={css.filterSel} value={filters.year} onChange={e => setFilters(f => ({ ...f, year: +e.target.value }))}>
          <option value={0}>All Years</option>
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <input
          className={css.searchInp}
          type="text"
          placeholder="Search member, site, project, description…"
          value={filters.search}
          onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
        />
      </div>

      {/* ── Table ──────────────────────────────────────────────── */}
      <div className={css.tableWrap}>
        <table className={css.table}>
          <thead><tr>
            <th>Member</th>
            <th>Project</th>
            <th>Site ID</th>
            <th>Activity Date</th>
            <th>Submitted</th>
            <th>Activity</th>
            <th>Description</th>
            <th className={css.num}>Total (IQD)</th>
            <th>Status</th>
            <th>Approved By</th>
            <th>Action Date</th>
            <th className={css.actionsCol}>Actions</th>
          </tr></thead>
          <tbody>
            {filtered.length === 0
              ? <tr><td colSpan={12} className={css.empty}>No claims match the current filters.</td></tr>
              : filtered.map(r => {
                  const isPending = r.status === 'pending';
                  const verified  = hasActivity(r);
                  const rejOpen   = rejectOpen[r.id] || false;
                  return (
                    <tr key={r.id}>
                      <td style={{ fontWeight: 600 }}>{memberName(r.member_id)}</td>
                      <td>{r.project_name || '—'}</td>
                      <td>{r.site_id || '—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.activity_date)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.submitted_at, true)}</td>
                      <td>
                        {verified
                          ? <span className={css.verifyOk}>
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                              Confirmed
                            </span>
                          : <span className={css.verifyWarn}>
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#b45309" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                              No Activity
                            </span>
                        }
                      </td>
                      <td>{r.description || '—'}</td>
                      <td className={css.num}>{iqd(r.total_amount)}</td>
                      <td>
                        <span className={`${css.badge} ${badgeCls(r.status)}`}>{statusLabel(r.status)}</span>
                        {r.status === 'rejected' && r.rejection_reason && (
                          <div className={css.rejReason}>{r.rejection_reason}</div>
                        )}
                      </td>
                      <td style={{ fontSize: 12, color: '#64748b' }}>{r.reviewed_by || '—'}</td>
                      <td style={{ whiteSpace: 'nowrap', fontSize: 12, color: '#94a3b8' }}>{fmtDate(r.reviewed_at)}</td>
                      <td className={css.actionsCol}>
                        <div className={css.actWrap}>
                          <button className={css.actBtn} onClick={() => { setDetailId(r.id); setDetailRejOpen(false); setDetailRejVal(''); setDetailRejErr(false); setEditMode(false); }}>
                            View
                          </button>
                          <button className={`${css.actBtn} ${css.actBtnDel}`} title="Delete" onClick={() => deleteClaim(r.id)}>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                          </button>
                          {isPending && (<>
                            <button
                              className={`${css.actBtn} ${css.actBtnApprove}`}
                              disabled={approvingId === r.id}
                              onClick={() => approveClaim(r.id)}
                            >
                              {approvingId === r.id ? '…' : 'Approve'}
                            </button>
                            <button
                              className={`${css.actBtn} ${css.actBtnReject}`}
                              onClick={() => setRejectOpen(v => ({ ...v, [r.id]: !v[r.id] }))}
                            >
                              Reject
                            </button>
                          </>)}
                        </div>
                        {isPending && rejOpen && (
                          <div className={css.rejWrap}>
                            <input
                              className={`${css.rejInp} ${rejectErr[r.id] ? css.rejInpErr : ''}`}
                              type="text"
                              placeholder="Rejection reason…"
                              value={rejectVal[r.id] || ''}
                              onChange={e => { setRejectVal(v => ({ ...v, [r.id]: e.target.value })); setRejectErr(v => ({ ...v, [r.id]: false })); }}
                              autoFocus
                            />
                            <button className={css.rejConfirmBtn} onClick={() => submitRowReject(r.id)}>Confirm Reject</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
            }
          </tbody>
        </table>
      </div>

      {hasApproved && (
        <div className={css.approvedBar}>
          <span className={css.approvedBarLabel}>Total Approved (filtered):</span>
          <span className={css.approvedBarAmt}>{iqd(totalApproved)}</span>
        </div>
      )}

      {/* ── Detail Modal ───────────────────────────────────────── */}
      {detailId && detailClaim && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget) { setDetailId(null); setEditMode(false); } }}>
          <div className={css.modal}>
            <div className={css.detailTopRow}>
              <div>
                <div className={css.detailTitle}>Expense Claim</div>
                <div className={css.detailMember}>{memberName(detailClaim.member_id)}</div>
              </div>
              <span className={`${css.badge} ${badgeCls(detailClaim.status)}`}>{statusLabel(detailClaim.status)}</span>
            </div>

            {/* Detail fields */}
            {!editMode && (
              <DetailGrid claim={detailClaim} team={team} fmtDate={fmtDate} css={css} />
            )}

            {/* Total bar */}
            {!editMode && (
              <div className={css.detailTotalBar}>
                <span className={css.detailTotalLabel}>Total Amount</span>
                <span className={css.detailTotalVal}>{iqd(detailClaim.total_amount)}</span>
              </div>
            )}

            {/* Timeline */}
            {!editMode && (
              <div className={css.timeline}>
                <div className={css.timelineTitle}>Status Timeline</div>
                <div className={css.tlItem}>
                  <span className={`${css.tlDot} ${css.tlDotDone}`} />
                  <div>
                    <div className={css.tlLabel}>Submitted</div>
                    <div className={css.tlMeta}>{fmtDate(detailClaim.submitted_at, true)}</div>
                  </div>
                </div>
                {detailClaim.status === 'approved' && (
                  <div className={css.tlItem}>
                    <span className={`${css.tlDot} ${css.tlDotDone}`} />
                    <div>
                      <div className={css.tlLabel}>Approved{detailClaim.reviewed_by ? ' by ' + detailClaim.reviewed_by : ''}</div>
                      <div className={css.tlMeta}>{fmtDate(detailClaim.reviewed_at, true)}</div>
                    </div>
                  </div>
                )}
                {detailClaim.status === 'rejected' && (
                  <div className={css.tlItem}>
                    <span className={`${css.tlDot} ${css.tlDotRejected}`} />
                    <div>
                      <div className={css.tlLabel}>Rejected{detailClaim.reviewed_by ? ' by ' + detailClaim.reviewed_by : ''}</div>
                      <div className={css.tlMeta}>{fmtDate(detailClaim.reviewed_at, true)}</div>
                      {detailClaim.rejection_reason && <div className={css.tlRejReason}>Reason: {detailClaim.rejection_reason}</div>}
                    </div>
                  </div>
                )}
                {(!detailClaim.status || detailClaim.status === 'pending') && (
                  <div className={css.tlItem}>
                    <span className={`${css.tlDot} ${css.tlDotPending}`} />
                    <div>
                      <div className={css.tlLabel}>Pending Review</div>
                      <div className={css.tlMeta}>Awaiting action</div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Rejection reason box */}
            {!editMode && detailClaim.status === 'rejected' && detailClaim.rejection_reason && (
              <div className={css.rejBox}>
                <div className={css.rejBoxTitle}>Rejection Reason</div>
                <div className={css.rejBoxText}>{detailClaim.rejection_reason}</div>
              </div>
            )}

            {/* Actions (pending only) */}
            {!editMode && detailClaim.status === 'pending' && (
              <div className={css.detailActions}>
                <div className={css.detailActionBtns}>
                  <button
                    className={css.btnApprove}
                    disabled={approvingId === detailId}
                    onClick={() => approveClaim(detailId)}
                  >
                    {approvingId === detailId ? 'Approving…' : 'Approve'}
                  </button>
                  <button className={css.btnReject} onClick={() => { setDetailRejOpen(v => !v); setDetailRejErr(false); }}>Reject</button>
                  {currentUser?.role === 'admin' && (
                    <button className={css.btnEdit} onClick={() => startEdit(detailClaim)}>&#9998; Edit</button>
                  )}
                </div>
                {detailRejOpen && (
                  <div className={css.detailRejWrap}>
                    <input
                      className={`${css.detailRejInp} ${detailRejErr ? css.detailRejInpErr : ''}`}
                      type="text"
                      placeholder="Rejection reason…"
                      value={detailRejVal}
                      autoFocus
                      onChange={e => { setDetailRejVal(e.target.value); setDetailRejErr(false); }}
                    />
                    <button className={css.detailRejConfirm} onClick={submitDetailReject}>Confirm</button>
                  </div>
                )}
              </div>
            )}

            {/* Edit form */}
            {editMode && (
              <div className={css.editSection}>
                <div className={css.editGrid}>
                  <div className={css.editField}>
                    <label className={css.editLabel}>Project</label>
                    <select className={css.editSel} value={editForm.project_name} onChange={e => setEditForm(f => ({ ...f, project_name: e.target.value }))}>
                      {FIN_PROJECTS.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>
                  <div className={css.editField}>
                    <label className={css.editLabel}>Site ID</label>
                    <input className={css.editInp} type="text" value={editForm.site_id} onChange={e => setEditForm(f => ({ ...f, site_id: e.target.value }))} />
                  </div>
                  <div className={css.editField}>
                    <label className={css.editLabel}>Governorate</label>
                    <input className={css.editInp} type="text" value={editForm.governorate} onChange={e => setEditForm(f => ({ ...f, governorate: e.target.value }))} />
                  </div>
                  <div className={css.editField}>
                    <label className={css.editLabel}>Description</label>
                    <select className={css.editSel} value={editForm.description} onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}>
                      {DESC_OPTIONS.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </div>
                  <div className={css.editField}>
                    <label className={css.editLabel}>Activity Date</label>
                    <input className={css.editInp} type="date" value={editForm.activity_date} onChange={e => setEditForm(f => ({ ...f, activity_date: e.target.value }))} />
                  </div>
                  <div className={css.editField}>
                    <label className={css.editLabel}>Transport Amount</label>
                    <input className={css.editInp} type="number" min="0" value={editForm.transport_amount}
                      onChange={e => setEditForm(f => ({ ...f, transport_amount: parseFloat(e.target.value) || 0 }))} />
                  </div>
                  <div className={css.editField}>
                    <label className={css.editLabel}>Accommodation</label>
                    <select className={css.editSel} value={editForm.accommodation} onChange={e => onAccomChange(e.target.value)}>
                      {ACCOM_OPTIONS.map(a => <option key={a} value={a}>{a || 'None'}</option>)}
                    </select>
                  </div>
                  <div className={css.editField}>
                    <label className={css.editLabel}>Food Amount</label>
                    <input className={css.editInp} type="number" min="0" value={editForm.food_amount}
                      onChange={e => setEditForm(f => ({ ...f, food_amount: parseFloat(e.target.value) || 0 }))} />
                  </div>
                  <div className={`${css.editField} ${css.full}`}>
                    <div className={css.editTotalBar}>
                      <span className={css.editTotalLabel}>Total Amount</span>
                      <span className={css.editTotalVal}>{iqd(editForm.transport_amount + editForm.food_amount)}</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Modal footer */}
            <div className={css.modalFooter}>
              <button className={css.btnClose} onClick={() => { setDetailId(null); setEditMode(false); }}>Close</button>
              {editMode && <>
                <button className={css.btnCancel} onClick={() => setEditMode(false)}>Cancel</button>
                <button className={css.btnSave} disabled={editSaving} onClick={saveEdit}>
                  {editSaving ? 'Saving…' : 'Save Changes'}
                </button>
              </>}
            </div>
          </div>
        </div>,
        document.body
      )}

      {toast && createPortal(
        <div className={`${css.toast} ${toast.ok ? css.toastOk : css.toastErr}`}>{toast.msg}</div>,
        document.body
      )}
    </div>
  );
}

// ── Detail grid sub-component ──────────────────────────────────────────────────

function DetailGrid({ claim, team, fmtDate, css: c }: {
  claim: ExpClaim;
  team: TeamMember[];
  fmtDate: (s: string | null, time?: boolean) => string;
  css: Record<string, string>;
}) {
  let empIds: string[] = [];
  try { empIds = JSON.parse(claim.employee_ids || '[]'); } catch (_) {}

  let cats: Array<{ category: string; amount: number }> = [];
  try { cats = JSON.parse(claim.extra_categories || '[]'); } catch (_) {}
  const validCats = cats.filter(cat => cat.category);

  return (
    <>
      <div className={c.detailGrid}>
        <div className={c.detailField}><span className={c.detailLbl}>Project</span><span className={c.detailVal}>{claim.project_name || '—'}</span></div>
        <div className={c.detailField}><span className={c.detailLbl}>Site ID</span><span className={c.detailVal}>{claim.site_id || '—'}</span></div>
        <div className={c.detailField}><span className={c.detailLbl}>Governorate</span><span className={c.detailVal}>{claim.governorate || '—'}</span></div>
        <div className={c.detailField}><span className={c.detailLbl}>Description</span><span className={c.detailVal}>{claim.description || '—'}</span></div>
        <div className={c.detailField}><span className={c.detailLbl}>Activity Date</span><span className={c.detailVal}>{fmtDate(claim.activity_date)}</span></div>
        <div className={`${c.detailField} ${c.full}`}>
          <span className={c.detailLbl}>Team Members</span>
          <span className={c.detailVal} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', marginTop: 2 }}>
            {empIds.length
              ? empIds.map(eid => {
                  const m = team.find(t => String(t.id) === String(eid));
                  const name = m ? (m.full_name || '—') : `#${eid}`;
                  return <span key={eid} className={c.teamPill}>{name}</span>;
                })
              : '—'
            }
          </span>
        </div>
        <div className={c.detailSep} />
        <div className={c.detailField}><span className={c.detailLbl}>Transport Amount</span><span className={c.detailVal}>{iqd(claim.transport_amount ?? 0)}</span></div>
        <div className={c.detailField}><span className={c.detailLbl}>Food Amount</span><span className={c.detailVal}>{iqd(claim.food_amount ?? 0)}</span></div>
        <div className={c.detailField}><span className={c.detailLbl}>Accommodation</span><span className={c.detailVal}>{claim.accommodation || '—'}</span></div>
        {claim.notes && <div className={`${c.detailField} ${c.full}`}><span className={c.detailLbl}>Notes</span><span className={c.detailVal}>{claim.notes}</span></div>}
      </div>

      {validCats.length > 0 && (
        <div className={c.catsSection}>
          <div className={c.catsSectionLbl}>Additional Categories</div>
          {validCats.map((cat, i) => (
            <div key={i} className={c.catRow}>
              <span>{cat.category}</span>
              <span className={c.catAmt}>{iqd(cat.amount || 0)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// Re-export ExpClaim type for external use
export type { ExpClaim };
