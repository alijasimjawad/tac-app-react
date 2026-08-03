import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useTranslation } from 'react-i18next';
import { ensureProjectsLoaded, getProjectNames, getProjectNameToKeyMap } from '../lib/projectsCache';
import styles from './MyExpenses.module.css';

const QUICK_CATEGORIES = [
  'Accommodation', 'Fuel', 'Tools & Materials', 'Communication', 'Parking',
  'Refreshments', 'Equipment Rental', 'Other',
];

const PAGE_SIZES = [10, 25, 50];

const ACTIVITY_TYPES = ['Installation', 'Integration', 'Clearance', 'Photo Reports', 'Other'];

interface SectionRow {
  id: string;
  section_label: string | null;
  section_name: string | null;
}

interface ExpenseClaim {
  id: string;
  member_id: string;
  activity_date: string;
  submitted_at: string;
  project_name: string | null;
  site_id: string | null;
  section_id: string | null;
  section_label: string | null;
  description: string | null;
  transport_amount: number | null;
  food_amount: number | null;
  extra_categories: ExtraRow[] | string | null;
  employee_ids: string[] | string | null;
  notes: string | null;
  status: string;
  total_amount: number | null;
  rejection_reason: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

interface ExtraRow { category: string; amount: number | string; }
interface TeamMember { id: string; full_name: string; username: string; is_active: boolean | null; }

function today() { return new Date().toISOString().split('T')[0]; }

function fmtDate(iso: string) {
  const [yr, mo, dy] = iso.split('-');
  return `${dy}/${mo}/${yr}`;
}

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function fmtAmt(n: number | null | undefined) { return (n ?? 0).toLocaleString('en-US'); }

function parseExtra(raw: ExtraRow[] | string | null): ExtraRow[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

function parseEmployeeIds(raw: string[] | string | null): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

function claimRef(allClaims: ExpenseClaim[], claim: ExpenseClaim): string {
  const year = new Date(claim.submitted_at).getFullYear();
  const sorted = [...allClaims]
    .filter(c => new Date(c.submitted_at).getFullYear() === year)
    .sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));
  const idx = sorted.findIndex(c => c.id === claim.id);
  return `EXP-${year}-${String(idx + 1).padStart(4, '0')}`;
}

function monthKey(iso: string) { return iso.slice(0, 7); }

function formatMonth(ym: string) {
  const [y, m] = ym.split('-');
  return new Date(parseInt(y), parseInt(m) - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' });
}

export default function MyExpenses() {
  const { t } = useTranslation();
  const { currentUser, hasPerm } = useAuth();
  const [memberId, setMemberId] = useState<string | null>(null);
  const [memberResolved, setMemberResolved] = useState(false);
  const [claims, setClaims] = useState<ExpenseClaim[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  // drawer state
  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [detailClaim, setDetailClaim] = useState<ExpenseClaim | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  // form fields
  const [fProject, setFProject] = useState('');
  const [fSiteId, setFSiteId] = useState('');
  const [fActivityType, setFActivityType] = useState('');
  const [fOtherDesc, setFOtherDesc] = useState('');
  const [fDate, setFDate] = useState(today());
  const [fTransport, setFTransport] = useState<string>('');
  const [fFood, setFFood] = useState<string>('');
  const [fExtra, setFExtra] = useState<ExtraRow[]>([]);
  const [fNotes, setFNotes] = useState('');
  const [fEmployeeIds, setFEmployeeIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState('');
  const [quickOpen, setQuickOpen] = useState(false);
  const [empDropOpen, setEmpDropOpen] = useState(false);
  const empDropRef = useRef<HTMLDivElement>(null);
  const [sections, setSections] = useState<SectionRow[]>([]);
  const [fSectionId, setFSectionId] = useState('');
  const pendingSectionRef = useRef<string | null>(null);
  const [fieldErrs, setFieldErrs] = useState<Record<string, string>>({});
  const [projectNames, setProjectNames] = useState<string[]>([]);
  const [nameToKey, setNameToKey] = useState<Record<string, string>>({});

  // filters
  const [searchQ, setSearchQ] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterProject, setFilterProject] = useState('');
  const [filterMonth, setFilterMonth] = useState('');

  // pagination
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);

  function showToast(msg: string, ok: boolean) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }

  useEffect(() => {
    ensureProjectsLoaded().then(() => {
      setProjectNames(getProjectNames());
      setNameToKey(getProjectNameToKeyMap());
    });
  }, []);

  useEffect(() => {
    if (!currentUser) return;
    async function resolve() {
      const { data } = await supabase.from('team_members').select('id, full_name, username, is_active').order('full_name');
      if (!data) { setLoading(false); setMemberResolved(true); return; }
      setTeamMembers(data.filter((m: TeamMember) => m.is_active !== false));
      const name = (currentUser?.full_name || '').trim().toLowerCase();
      const uname = (currentUser?.username || '').trim().toLowerCase();
      const match = data.find((m: TeamMember) =>
        (name && m.full_name?.trim().toLowerCase() === name) ||
        (uname && m.username?.trim().toLowerCase() === uname),
      );
      setMemberId(match?.id ?? null);
      setMemberResolved(true);
    }
    resolve();
  }, [currentUser]);

  useEffect(() => {
    if (!memberResolved) return;
    if (!memberId) { setLoading(false); return; }
    loadClaims();
  }, [memberResolved, memberId]);

  async function loadClaims() {
    if (!memberId) return;
    setLoading(true);
    const { data } = await supabase
      .from('expense_claims').select('*')
      .eq('member_id', memberId)
      .or('is_car_trip.is.null,is_car_trip.eq.false')
      .order('submitted_at', { ascending: false });
    setClaims((data as ExpenseClaim[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (empDropRef.current && !empDropRef.current.contains(e.target as Node)) setEmpDropOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (formOpen) { setFormOpen(false); return; }
      if (detailClaim) { setDetailClaim(null); return; }
      if (deleteId) setDeleteId(null);
    }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [formOpen, detailClaim, deleteId]);

  useEffect(() => {
    setSections([]);
    const restoreId = pendingSectionRef.current;
    pendingSectionRef.current = null;
    setFSectionId(restoreId || '');
    if (!fProject) return;
    const projKey = nameToKey[fProject];
    if (!projKey) return;
    supabase.from('sections').select('id,section_label,section_name')
      .eq('project_name', projKey).neq('is_deleted', true)
      .order('created_at', { ascending: true })
      .then(({ data }) => setSections((data as SectionRow[]) || []));
  }, [fProject, nameToKey]);

  const summary = useMemo(() => {
    const approved = claims.filter(c => c.status === 'approved');
    const pending  = claims.filter(c => c.status === 'pending');
    const rejected = claims.filter(c => c.status === 'rejected');
    return {
      totalAmt:    claims.reduce((s, c) => s + (c.total_amount ?? 0), 0),
      totalCount:  claims.length,
      approvedAmt: approved.reduce((s, c) => s + (c.total_amount ?? 0), 0), approvedCount: approved.length,
      pendingAmt:  pending.reduce((s, c) => s + (c.total_amount ?? 0), 0),  pendingCount:  pending.length,
      rejectedAmt: rejected.reduce((s, c) => s + (c.total_amount ?? 0), 0), rejectedCount: rejected.length,
    };
  }, [claims]);

  const availableMonths = useMemo(() => {
    const set = new Set(claims.map(c => monthKey(c.activity_date)));
    return [...set].sort().reverse();
  }, [claims]);

  const filteredClaims = useMemo(() => claims.filter(c => {
    if (searchQ) {
      const q = searchQ.toLowerCase();
      if (!((c.site_id ?? '').toLowerCase().includes(q) ||
            (c.project_name ?? '').toLowerCase().includes(q) ||
            (c.description ?? '').toLowerCase().includes(q))) return false;
    }
    if (filterStatus && c.status !== filterStatus) return false;
    if (filterProject && c.project_name !== filterProject) return false;
    if (filterMonth && !c.activity_date?.startsWith(filterMonth)) return false;
    return true;
  }), [claims, searchQ, filterStatus, filterProject, filterMonth]);

  const filtersActive = !!(searchQ || filterStatus || filterProject || filterMonth);
  const totalPages = Math.ceil(filteredClaims.length / pageSize);
  const pagedClaims = filteredClaims.slice(page * pageSize, (page + 1) * pageSize);

  function clearFilters() { setSearchQ(''); setFilterStatus(''); setFilterProject(''); setFilterMonth(''); setPage(0); }

  function calcTotal() {
    return (parseFloat(fTransport) || 0) + (parseFloat(fFood) || 0) +
      fExtra.reduce((s, r) => s + (parseFloat(r.amount as string) || 0), 0);
  }

  function openNew() {
    pendingSectionRef.current = null;
    setEditId(null); setFProject(''); setFSiteId(''); setFDate(today());
    setFTransport(''); setFFood(''); setFExtra([]); setFNotes(''); setFEmployeeIds([]);
    setSections([]); setFSectionId('');
    setFActivityType(''); setFOtherDesc('');
    setFormErr(''); setFieldErrs({}); setQuickOpen(false); setEmpDropOpen(false);
    setDetailClaim(null); setFormOpen(true);
  }

  function openEdit(c: ExpenseClaim) {
    pendingSectionRef.current = c.section_id ?? null;
    setEditId(c.id); setFProject(c.project_name ?? ''); setFSiteId(c.site_id ?? '');
    setFDate(c.activity_date ?? today());
    setFTransport(c.transport_amount != null ? String(c.transport_amount) : '');
    setFFood(c.food_amount != null ? String(c.food_amount) : '');
    setFExtra(parseExtra(c.extra_categories)); setFNotes(c.notes ?? '');
    setFEmployeeIds(parseEmployeeIds(c.employee_ids));
    setFSectionId(c.section_id ?? '');
    const desc = c.description ?? '';
    const knownTypes = ACTIVITY_TYPES.filter(t => t !== 'Other');
    if (knownTypes.includes(desc)) {
      setFActivityType(desc); setFOtherDesc('');
    } else {
      setFActivityType(desc ? 'Other' : ''); setFOtherDesc(desc);
    }
    setFormErr(''); setFieldErrs({}); setQuickOpen(false); setEmpDropOpen(false);
    setDetailClaim(null); setFormOpen(true);
  }

  function addExtraRow() { setFExtra(prev => [...prev, { category: '', amount: '' }]); }
  function removeExtraRow(i: number) { setFExtra(prev => prev.filter((_, idx) => idx !== i)); }
  function updateExtraRow(i: number, field: 'category' | 'amount', val: string) {
    setFExtra(prev => prev.map((r, idx) => idx === i ? { ...r, [field]: val } : r));
  }
  function applyQuickAdd(cat: string) { setFExtra(prev => [...prev, { category: cat, amount: '' }]); setQuickOpen(false); }
  function toggleEmployee(id: string) { setFEmployeeIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]); }
  function getEmpName(id: string) { return teamMembers.find(m => m.id === id)?.full_name ?? id; }

  async function saveClaim() {
    const errs: Record<string, string> = {};
    if (!fProject) errs.project = 'Select a project.';
    if (nameToKey[fProject] && !fSectionId) errs.section = 'Select a section.';
    if (!fActivityType) errs.activityType = 'Select an activity type.';
    if (fActivityType === 'Other' && !fOtherDesc.trim()) errs.otherDesc = 'Describe the activity.';
    if (!fSiteId.trim()) errs.siteId = 'Enter a Site ID.';
    if (!fDate) errs.date = 'Select an activity date.';
    setFieldErrs(errs);
    if (Object.keys(errs).length > 0) return;
    const finalDesc = fActivityType === 'Other' ? fOtherDesc.trim() : fActivityType;
    const selectedSection = sections.find(s => s.id === fSectionId);
    const finalSectionLabel = selectedSection ? (selectedSection.section_label || selectedSection.section_name || '') : null;
    setFormErr('');
    if (!editId) {
      const dup = claims.find(c => c.site_id === fSiteId.trim() && c.activity_date === fDate && c.status !== 'rejected');
      if (dup) { setFormErr('A claim for this site and date already exists (non-rejected).'); return; }
    }
    setSaving(true);
    const payload = {
      member_id: memberId, project_name: fProject, site_id: fSiteId.trim(),
      section_id: fSectionId || null, section_label: finalSectionLabel,
      description: finalDesc, activity_date: fDate,
      transport_amount: parseFloat(fTransport) || 0,
      food_amount: parseFloat(fFood) || 0,
      extra_categories: fExtra.filter(r => r.category.trim()),
      employee_ids: fEmployeeIds, notes: fNotes.trim() || null,
      total_amount: calcTotal(), status: 'pending',
    };
    let error: { message: string } | null = null;
    if (editId) {
      const res = await supabase.from('expense_claims').update(payload).eq('id', editId);
      error = res.error;
    } else {
      const res = await supabase.from('expense_claims').insert({ ...payload, submitted_at: new Date().toISOString() });
      error = res.error;
    }
    setSaving(false);
    if (error) { setFormErr('Unable to submit the expense claim. Please check the required fields and try again.'); return; }
    setFormOpen(false);
    showToast(editId ? 'Claim resubmitted successfully.' : 'Expense claim submitted successfully.', true);
    loadClaims();
  }

  async function confirmDelete() {
    if (!deleteId) return;
    const { error } = await supabase.from('expense_claims').delete().eq('id', deleteId);
    setDeleteId(null);
    if (error) { showToast('Delete failed: ' + error.message, false); return; }
    showToast('Claim deleted.', true);
    setClaims(prev => prev.filter(c => c.id !== deleteId));
  }

  if (!hasPerm('view_my_expenses')) {
    return (
      <div className={styles.page}>
        <p className={styles.denied}>You do not have permission to view this page.</p>
      </div>
    );
  }

  const drawerOpen = formOpen || !!detailClaim;

  return (
    <div className={styles.page}>
      {/* ── Header ── */}
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>{t('exp_title')}</h1>
          <p className={styles.pageSubtitle}>{t('exp_subtitle')}</p>
        </div>
        {memberResolved && memberId && hasPerm('mywork_expenses_add') && (
          <button className={styles.newBtn} onClick={openNew}><PlusIcon /> {t('exp_newClaim')}</button>
        )}
      </div>

      {/* ── Not linked ── */}
      {memberResolved && !memberId && (
        <div className={styles.notLinked}>
          <strong>Account not linked to a team member profile.</strong>
          <p>Personal expense claims are for field engineers and technicians. Your admin account doesn't have a linked team member profile, so claims cannot be submitted or listed here.</p>
        </div>
      )}

      {memberId && (
        <>
          {/* ── Summary cards ── */}
          <div className={styles.summaryGrid}>
            <SummaryCard label={t('exp_statTotalClaimed')} amount={summary.totalAmt} count={summary.totalCount} color="blue" icon={<WalletIcon />} />
            <SummaryCard label={t('exp_statApproved')} amount={summary.approvedAmt} count={summary.approvedCount} color="green" icon={<CheckCircleIcon />} />
            <SummaryCard label={t('exp_statPending')} amount={summary.pendingAmt} count={summary.pendingCount} color="amber" icon={<ClockCircleIcon />} />
            <SummaryCard label={t('exp_statRejected')} amount={summary.rejectedAmt} count={summary.rejectedCount} color="red" icon={<XCircleIcon />} />
          </div>

          {/* ── Content row ── */}
          <div className={`${styles.contentRow} ${drawerOpen ? styles.contentRowOpen : ''}`}>
            <div className={styles.claimsArea}>
              {/* Filters */}
              <div className={styles.filterCard}>
                <div className={styles.filterRow}>
                  <div className={styles.filterSearch}>
                    <SearchIcon />
                    <input
                      className={styles.filterInput}
                      placeholder={t('exp_searchPlaceholder')}
                      value={searchQ}
                      onChange={e => { setSearchQ(e.target.value); setPage(0); }}
                    />
                  </div>
                  <select className={styles.filterSelect} value={filterStatus} onChange={e => { setFilterStatus(e.target.value); setPage(0); }}>
                    <option value="">{t('exp_allStatuses')}</option>
                    <option value="pending">{t('exp_optPending')}</option>
                    <option value="approved">{t('exp_optApproved')}</option>
                    <option value="rejected">{t('exp_optRejected')}</option>
                  </select>
                  <select className={styles.filterSelect} value={filterProject} onChange={e => { setFilterProject(e.target.value); setPage(0); }}>
                    <option value="">{t('exp_allProjects')}</option>
                    {projectNames.map(p => <option key={p}>{p}</option>)}
                  </select>
                  <select className={styles.filterSelect} value={filterMonth} onChange={e => { setFilterMonth(e.target.value); setPage(0); }}>
                    <option value="">{t('exp_allMonths')}</option>
                    {availableMonths.map(m => <option key={m} value={m}>{formatMonth(m)}</option>)}
                  </select>
                  {filtersActive && (
                    <button className={styles.clearFiltersBtn} onClick={clearFilters}>{t('exp_clearFilters')}</button>
                  )}
                </div>
                <div className={styles.filterCount}>{t('exp_filterCount', { count: filteredClaims.length })}</div>
              </div>

              {/* Claims card */}
              <div className={styles.claimsCard}>
                <div className={styles.claimsCardHeader}>
                  <div className={styles.claimsCardTitle}>{t('exp_claimsTitle')}</div>
                  <div className={styles.claimsCardSub}>{t('exp_claimsSubtitle')}</div>
                </div>

                {loading ? (
                  <div className={styles.emptyState}>
                    <div className={styles.emptyTitle}>Loading…</div>
                  </div>
                ) : claims.length === 0 ? (
                  <div className={styles.emptyState}>
                    <div className={styles.emptyIcon}><ReceiptEmptyIcon /></div>
                    <div className={styles.emptyTitle}>{t('exp_noExpenses')}</div>
                    <div className={styles.emptySub}>{t('exp_startFirst')}</div>
                    {hasPerm('mywork_expenses_add') && (
                      <button className={styles.newBtn} onClick={openNew} style={{ marginTop: 18 }}><PlusIcon /> {t('exp_newClaim')}</button>
                    )}
                  </div>
                ) : filteredClaims.length === 0 ? (
                  <div className={styles.emptyState}>
                    <div className={styles.emptyIcon}><SearchEmptyIcon /></div>
                    <div className={styles.emptyTitle}>{t('exp_noFilterMatch')}</div>
                    <div className={styles.emptySub}>{t('exp_filterAdjust')}</div>
                    <div className={styles.emptyActions}>
                      <button className={styles.outlineBtn} onClick={clearFilters}>{t('exp_clearFilters')}</button>
                      {hasPerm('mywork_expenses_add') && (
                        <button className={styles.newBtn} onClick={openNew}><PlusIcon /> {t('exp_newClaim')}</button>
                      )}
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Desktop table */}
                    <div className={styles.tableWrap}>
                      <table className={styles.table}>
                        <thead>
                          <tr>
                            <th>{t('exp_date')}</th>
                            <th>{t('exp_colClaimId')}</th>
                            <th>{t('exp_siteId')}</th>
                            <th>{t('exp_project')}</th>
                            <th>{t('exp_section')}</th>
                            <th>{t('exp_colDesc')}</th>
                            <th className={styles.thRight}>{t('exp_colAmount')}</th>
                            <th>{t('exp_status')}</th>
                            <th>{t('exp_colSubmitted')}</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {pagedClaims.map(c => (
                            <tr key={c.id} className={styles.tableRow} onClick={() => setDetailClaim(c)}>
                              <td className={styles.tdDate}>{fmtDate(c.activity_date)}</td>
                              <td className={styles.tdRef}>{claimRef(claims, c)}</td>
                              <td><span className={styles.siteCode}>{c.site_id}</span></td>
                              <td className={styles.tdProject}>{c.project_name}</td>
                              <td className={styles.tdProject}>{c.section_label ?? '—'}</td>
                              <td className={styles.tdDesc} title={c.description ?? ''}>{c.description}</td>
                              <td className={styles.tdAmt}>{fmtAmt(c.total_amount)} IQD</td>
                              <td><StatusBadge status={c.status} /></td>
                              <td className={styles.tdSub}>{fmtDateTime(c.submitted_at)}</td>
                              <td className={styles.tdActions} onClick={e => e.stopPropagation()}>
                                <button className={styles.viewBtn} onClick={() => setDetailClaim(c)} aria-label="View details" title="View Details"><EyeIcon /></button>
                                {c.status === 'rejected' && hasPerm('mywork_expenses_edit') && (
                                  <button className={styles.editRowBtn} onClick={() => openEdit(c)} aria-label="Edit and resubmit" title="Edit & Resubmit"><EditIcon /></button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* Mobile cards */}
                    <div className={styles.mobileCards}>
                      {pagedClaims.map(c => (
                        <MobileClaimCard
                          key={c.id} claim={c} claimId={claimRef(claims, c)}
                          onView={() => setDetailClaim(c)}
                          onEdit={c.status === 'rejected' && hasPerm('mywork_expenses_edit') ? () => openEdit(c) : undefined}
                        />
                      ))}
                    </div>

                    {/* Pagination */}
                    <div className={styles.pagination}>
                      <span className={styles.pgInfo}>
                        {t('exp_showing', { from: page * pageSize + 1, to: Math.min((page + 1) * pageSize, filteredClaims.length), total: filteredClaims.length })}
                      </span>
                      <div className={styles.pgControls}>
                        <span className={styles.pgLabel}>{t('exp_rowsPerPage')}</span>
                        <select className={styles.pgSelect} value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(0); }}>
                          {PAGE_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                        <button className={styles.pgBtn} disabled={page === 0} onClick={() => setPage(p => p - 1)} aria-label="Previous page">‹</button>
                        <button className={styles.pgBtn} disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)} aria-label="Next page">›</button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* ── Detail drawer ── */}
            {detailClaim && (
              <>
                <div className={styles.drawerOverlay} onClick={() => setDetailClaim(null)} />
                <div className={styles.drawer} role="dialog" aria-label={t('exp_claimDetails')}>
                  <div className={styles.drawerHeader}>
                    <div>
                      <div className={styles.drawerClaimId}>{claimRef(claims, detailClaim)}</div>
                      <div className={styles.drawerTitle}>{t('exp_claimDetails')}</div>
                    </div>
                    <div className={styles.drawerHeaderRight}>
                      <StatusBadge status={detailClaim.status} />
                      <button className={styles.drawerClose} onClick={() => setDetailClaim(null)} aria-label="Close">✕</button>
                    </div>
                  </div>
                  <div className={styles.drawerBody}>
                    <div className={styles.drawerSection}>
                      <div className={styles.drawerSectionTitle}>{t('exp_claimInformation')}</div>
                      <div className={styles.detailGrid}>
                        <div className={styles.detailItem}><span className={styles.detailKey}>{t('exp_date')}</span><span className={styles.detailVal}>{fmtDate(detailClaim.activity_date)}</span></div>
                        <div className={styles.detailItem}><span className={styles.detailKey}>{t('exp_colSubmitted')}</span><span className={styles.detailVal}>{fmtDateTime(detailClaim.submitted_at)}</span></div>
                        <div className={styles.detailItem}><span className={styles.detailKey}>{t('exp_project')}</span><span className={styles.detailVal}>{detailClaim.project_name ?? '—'}</span></div>
                        <div className={styles.detailItem}><span className={styles.detailKey}>{t('exp_section')}</span><span className={styles.detailVal}>{detailClaim.section_label ?? '—'}</span></div>
                        <div className={styles.detailItem}><span className={styles.detailKey}>{t('exp_siteId')}</span><span className={`${styles.detailVal} ${styles.siteCode}`}>{detailClaim.site_id ?? '—'}</span></div>
                      </div>
                      <div className={styles.detailItemFull}><span className={styles.detailKey}>{t('exp_colDesc')}</span><span className={styles.detailVal}>{detailClaim.description ?? '—'}</span></div>
                    </div>

                    <div className={styles.drawerSection}>
                      <div className={styles.drawerSectionTitle}>{t('exp_amount')}</div>
                      {(detailClaim.transport_amount ?? 0) > 0 && (
                        <div className={styles.amtRow}><span>{t('exp_transport')}</span><span>{fmtAmt(detailClaim.transport_amount)} IQD</span></div>
                      )}
                      {(detailClaim.food_amount ?? 0) > 0 && (
                        <div className={styles.amtRow}><span>{t('exp_foodMeals')}</span><span>{fmtAmt(detailClaim.food_amount)} IQD</span></div>
                      )}
                      {parseExtra(detailClaim.extra_categories).map((r, i) => (
                        <div key={i} className={styles.amtRow}><span>{r.category}</span><span>{fmtAmt(parseFloat(r.amount as string) || 0)} IQD</span></div>
                      ))}
                      <div className={styles.amtTotal}><span>{t('exp_drawerTotal')}</span><span>{fmtAmt(detailClaim.total_amount)} IQD</span></div>
                    </div>

                    {parseEmployeeIds(detailClaim.employee_ids).length > 0 && (
                      <div className={styles.drawerSection}>
                        <div className={styles.drawerSectionTitle}>{t('exp_teamMembersSection')}</div>
                        <div className={styles.empTags}>
                          {parseEmployeeIds(detailClaim.employee_ids).map(id => (
                            <span key={id} className={styles.empTag}>{getEmpName(id)}</span>
                          ))}
                        </div>
                      </div>
                    )}

                    {detailClaim.notes && (
                      <div className={styles.drawerSection}>
                        <div className={styles.drawerSectionTitle}>{t('exp_notes')}</div>
                        <p className={styles.notesText}>{detailClaim.notes}</p>
                      </div>
                    )}

                    <div className={styles.drawerSection}>
                      <div className={styles.drawerSectionTitle}>{t('exp_statusInformation')}</div>
                      <div className={styles.statusInfo}>
                        <div className={styles.statusInfoRow}><span className={styles.detailKey}>{t('exp_status')}</span><StatusBadge status={detailClaim.status} /></div>
                        <div className={styles.statusInfoRow}><span className={styles.detailKey}>{t('exp_colSubmitted')}</span><span className={styles.detailVal}>{fmtDateTime(detailClaim.submitted_at)}</span></div>
                        {detailClaim.reviewed_at && (
                          <div className={styles.statusInfoRow}><span className={styles.detailKey}>{t('exp_detailReviewed')}</span><span className={styles.detailVal}>{fmtDateTime(detailClaim.reviewed_at)}</span></div>
                        )}
                        {detailClaim.reviewed_by && (
                          <div className={styles.statusInfoRow}><span className={styles.detailKey}>{t('exp_detailReviewedBy')}</span><span className={styles.detailVal}>{detailClaim.reviewed_by}</span></div>
                        )}
                        {detailClaim.rejection_reason && (
                          <div className={styles.rejBlock}>
                            <span className={styles.detailKey}>{t('exp_detailRejectionReason')}</span>
                            <span className={styles.rejText}>{detailClaim.rejection_reason}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className={styles.drawerFooter}>
                    {detailClaim.status === 'rejected' && hasPerm('mywork_expenses_edit') && (
                      <button className={styles.editClaimBtn} onClick={() => openEdit(detailClaim)}><EditIcon /> {t('exp_editClaim')}</button>
                    )}
                    {detailClaim.status === 'rejected' && hasPerm('mywork_expenses_delete') && (
                      <button className={styles.cancelClaimBtn} onClick={() => { setDeleteId(detailClaim.id); setDetailClaim(null); }}>{t('exp_cancelClaim')}</button>
                    )}
                    <button className={styles.closeDrawerBtn} onClick={() => setDetailClaim(null)}>{t('exp_close')}</button>
                  </div>
                </div>
              </>
            )}

            {/* ── Form drawer ── */}
            {formOpen && (
              <>
                <div className={styles.drawerOverlay} onClick={() => setFormOpen(false)} />
                <div className={styles.drawer} role="dialog" aria-label={editId ? 'Edit Claim' : 'New Expense Claim'}>
                  <div className={styles.drawerHeader}>
                    <div className={styles.drawerTitle}>{editId ? t('exp_resubmit') : t('exp_newClaim')}</div>
                    <button className={styles.drawerClose} onClick={() => setFormOpen(false)} aria-label="Close">✕</button>
                  </div>
                  <div className={styles.drawerBody}>
                    <div className={styles.formSection}>{t('exp_activityInfo')}</div>
                    <div className={styles.formGrid2}>
                      <div className={styles.fieldGroup}>
                        <label className={styles.fieldLabel}>{t('exp_project')} <span className={styles.req}>*</span></label>
                        <select
                          className={`${styles.select} ${fieldErrs.project ? styles.inputErr : ''}`}
                          value={fProject}
                          onChange={e => { setFProject(e.target.value); setFieldErrs(p => ({ ...p, project: '' })); }}
                        >
                          <option value="">{t('exp_selectProject')}</option>
                          {projectNames.map(p => <option key={p}>{p}</option>)}
                        </select>
                        {fieldErrs.project && <span className={styles.fieldErrMsg}>{fieldErrs.project}</span>}
                      </div>
                      <div className={styles.fieldGroup}>
                        <label className={styles.fieldLabel}>{t('exp_date')} <span className={styles.req}>*</span></label>
                        <input
                          type="date"
                          className={`${styles.input} ${fieldErrs.date ? styles.inputErr : ''}`}
                          value={fDate}
                          onChange={e => { setFDate(e.target.value); setFieldErrs(p => ({ ...p, date: '' })); }}
                        />
                        {fieldErrs.date && <span className={styles.fieldErrMsg}>{fieldErrs.date}</span>}
                      </div>
                    </div>
                    <div className={styles.fieldGroup} style={{ marginBottom: 10 }}>
                      <label className={styles.fieldLabel}>{t('exp_section')} <span className={styles.req}>*</span></label>
                      <select
                        className={`${styles.select} ${fieldErrs.section ? styles.inputErr : ''}`}
                        value={fSectionId}
                        disabled={!fProject || !nameToKey[fProject]}
                        onChange={e => {
                          setFSectionId(e.target.value);
                          setFieldErrs(p => ({ ...p, section: '' }));
                        }}
                      >
                        <option value="">{!fProject || !nameToKey[fProject] ? t('exp_selectProjectFirst') : sections.length === 0 ? t('exp_loading') : t('exp_selectSection')}</option>
                        {sections.map(s => {
                          const lbl = s.section_label || s.section_name || '';
                          return <option key={s.id} value={s.id}>{lbl}</option>;
                        })}
                      </select>
                      {fieldErrs.section && <span className={styles.fieldErrMsg}>{fieldErrs.section}</span>}
                    </div>
                    <div className={styles.formGrid2}>
                      <div className={styles.fieldGroup}>
                        <label className={styles.fieldLabel}>{t('exp_siteId')} <span className={styles.req}>*</span></label>
                        <input
                          className={`${styles.input} ${fieldErrs.siteId ? styles.inputErr : ''}`}
                          placeholder={t('exp_siteIdPlaceholder')}
                          value={fSiteId}
                          onChange={e => { setFSiteId(e.target.value); setFieldErrs(p => ({ ...p, siteId: '' })); }}
                        />
                        {fieldErrs.siteId && <span className={styles.fieldErrMsg}>{fieldErrs.siteId}</span>}
                      </div>
                      <div className={styles.fieldGroup}>
                        <label className={styles.fieldLabel}>{t('exp_activityType')} <span className={styles.req}>*</span></label>
                        <select
                          className={`${styles.select} ${fieldErrs.activityType ? styles.inputErr : ''}`}
                          value={fActivityType}
                          onChange={e => { setFActivityType(e.target.value); setFieldErrs(p => ({ ...p, activityType: '', otherDesc: '' })); }}
                        >
                          <option value="">{t('exp_selectType')}</option>
                          {ACTIVITY_TYPES.map(atype => <option key={atype} value={atype}>{atype}</option>)}
                        </select>
                        {fieldErrs.activityType && <span className={styles.fieldErrMsg}>{fieldErrs.activityType}</span>}
                      </div>
                    </div>
                    {fActivityType === 'Other' && (
                      <div className={styles.fieldGroup} style={{ marginBottom: 10 }}>
                        <label className={styles.fieldLabel}>{t('exp_other')} <span className={styles.req}>*</span></label>
                        <input
                          className={`${styles.input} ${fieldErrs.otherDesc ? styles.inputErr : ''}`}
                          placeholder={t('exp_otherDesc')}
                          value={fOtherDesc}
                          onChange={e => { setFOtherDesc(e.target.value); setFieldErrs(p => ({ ...p, otherDesc: '' })); }}
                        />
                        {fieldErrs.otherDesc && <span className={styles.fieldErrMsg}>{fieldErrs.otherDesc}</span>}
                      </div>
                    )}

                    <div className={styles.formSection}>{t('exp_addlCosts')}</div>
                    <div className={styles.formGrid2}>
                      <div className={styles.fieldGroup}>
                        <label className={styles.fieldLabel}>{t('exp_transport')}</label>
                        <input type="number" min="0" inputMode="numeric" className={styles.input} placeholder="0" value={fTransport} onChange={e => setFTransport(e.target.value)} />
                      </div>
                      <div className={styles.fieldGroup}>
                        <label className={styles.fieldLabel}>{t('exp_foodMeals')}</label>
                        <input type="number" min="0" inputMode="numeric" className={styles.input} placeholder="0" value={fFood} onChange={e => setFFood(e.target.value)} />
                      </div>
                    </div>

                    {fExtra.length > 0 && (
                      <div className={styles.extraRows}>
                        {fExtra.map((row, i) => (
                          <div key={i} className={styles.extraCard}>
                            <div className={styles.fieldGroup}>
                              <label className={styles.fieldLabel}>{t('exp_category')}</label>
                              <input className={styles.input} placeholder="e.g. Accommodation" value={row.category} onChange={e => updateExtraRow(i, 'category', e.target.value)} />
                            </div>
                            <div className={styles.fieldGroup}>
                              <label className={styles.fieldLabel}>{t('exp_colAmount')}</label>
                              <input type="number" min="0" inputMode="numeric" className={styles.input} placeholder="0" value={row.amount} onChange={e => updateExtraRow(i, 'amount', e.target.value)} />
                            </div>
                            <button className={styles.removeRowBtn} onClick={() => removeExtraRow(i)} title="Remove">✕</button>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className={styles.extraRowActions}>
                      <button className={styles.addRowBtn} onClick={addExtraRow}>{t('exp_addCategory')}</button>
                      <button className={styles.addRowBtn} onClick={() => setQuickOpen(q => !q)}>{t('exp_quickAdd')}</button>
                    </div>

                    {quickOpen && (
                      <div className={styles.quickPanel}>
                        <div className={styles.quickTitle}>{t('exp_quickAddCategory')}</div>
                        <div className={styles.quickGrid}>
                          {QUICK_CATEGORIES.map(cat => (
                            <button key={cat} className={styles.quickChip} onClick={() => applyQuickAdd(cat)}>{cat}</button>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className={styles.totalBox}>
                      <span className={styles.totalLabel}>{t('exp_estimatedTotal')}</span>
                      <span className={styles.totalAmount}>{calcTotal().toLocaleString('en-US')} IQD</span>
                    </div>

                    <div className={styles.formSection}>{t('exp_teamMembersSection')} <span className={styles.optional}>{t('exp_optional')}</span></div>
                    <div className={styles.empWrap} ref={empDropRef}>
                      <div className={styles.empSelect} onClick={() => setEmpDropOpen(o => !o)}>
                        {fEmployeeIds.length === 0 && <span className={styles.empPlaceholder}>{t('exp_selectTeamMembers')}</span>}
                        {fEmployeeIds.map(id => (
                          <span key={id} className={styles.empPill}>
                            {getEmpName(id)}
                            <button className={styles.pillRemove} onClick={e => { e.stopPropagation(); toggleEmployee(id); }}>×</button>
                          </span>
                        ))}
                        <span className={styles.empChevron}>▾</span>
                      </div>
                      {empDropOpen && (
                        <div className={styles.empDropdown}>
                          {teamMembers.map(m => (
                            <div
                              key={m.id}
                              className={`${styles.empOption} ${fEmployeeIds.includes(m.id) ? styles.empOptionSelected : ''}`}
                              onClick={() => toggleEmployee(m.id)}
                            >
                              {fEmployeeIds.includes(m.id) && <span className={styles.empCheck}>✓</span>}
                              {m.full_name}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className={styles.formSection}>{t('exp_notes')} <span className={styles.optional}>{t('exp_optional')}</span></div>
                    <textarea className={styles.textarea} rows={3} placeholder={t('exp_notesPlaceholder')} value={fNotes} onChange={e => setFNotes(e.target.value)} />

                    {formErr && <div className={styles.formErr} role="alert">{formErr}</div>}
                  </div>
                  <div className={styles.drawerFooter}>
                    <button className={styles.cancelBtn} onClick={() => setFormOpen(false)}>{t('exp_cancel')}</button>
                    <button className={styles.submitBtn} onClick={saveClaim} disabled={saving}>
                      {saving ? t('exp_submitting') : editId ? t('exp_resubmit') : t('exp_submit')}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </>
      )}

      {/* ── Delete confirm ── */}
      {deleteId && (
        <div className={styles.overlay} onClick={e => { if (e.target === e.currentTarget) setDeleteId(null); }}>
          <div className={styles.confirmModal}>
            <h3 className={styles.confirmTitle}>{t('exp_deleteTitle')}</h3>
            <p className={styles.confirmText}>{t('exp_deleteText')}</p>
            <div className={styles.confirmActions}>
              <button className={styles.cancelBtn} onClick={() => setDeleteId(null)}>{t('exp_cancel')}</button>
              <button className={styles.dangerBtn} onClick={confirmDelete}>{t('exp_delete')}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Toast ── */}
      {toast && (
        <div className={`${styles.toast} ${toast.ok ? styles.toastOk : styles.toastErr}`} role="status" aria-live="polite">
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SummaryCard({ label, amount, count, color, icon }: {
  label: string; amount: number; count: number;
  color: 'blue' | 'green' | 'amber' | 'red'; icon: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.summaryCard}>
      <div className={`${styles.summaryIcon} ${styles[`summaryIcon_${color}` as keyof typeof styles]}`}>{icon}</div>
      <div className={styles.summaryContent}>
        <div className={styles.summaryLabel}>{label}</div>
        <div className={styles.summaryAmount}>{fmtAmt(amount)} IQD</div>
        <div className={styles.summaryCount}>{t('exp_summaryCount', { count })}</div>
      </div>
    </div>
  );
}

function MobileClaimCard({ claim, claimId, onView, onEdit }: {
  claim: ExpenseClaim; claimId: string;
  onView: () => void; onEdit?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.mobileCard}>
      <div className={styles.mobileCardTop}>
        <StatusBadge status={claim.status} />
        <span className={styles.mobileCardAmt}>{fmtAmt(claim.total_amount)} IQD</span>
      </div>
      <div className={styles.mobileCardMeta}>
        <span className={styles.mobileCardRef}>{claimId}</span>
        {claim.site_id && <span className={styles.siteCode}>{claim.site_id}</span>}
      </div>
      <div className={styles.mobileCardProject}>{claim.project_name}{claim.section_label ? ` · ${claim.section_label}` : ''}</div>
      <div className={styles.mobileCardDesc}>{claim.description}</div>
      <div className={styles.mobileCardDates}>
        <span>{t('exp_activityLabel')} {fmtDate(claim.activity_date)}</span>
        <span>{t('exp_submittedLabel')} {fmtDateTime(claim.submitted_at)}</span>
      </div>
      <div className={styles.mobileCardActions}>
        <button className={styles.mobileViewBtn} onClick={onView}>{t('exp_viewDetails')}</button>
        {onEdit && <button className={styles.mobileEditBtn} onClick={onEdit}>{t('exp_editResubmit')}</button>}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  const s = status?.toLowerCase();
  const cls = s === 'approved' ? styles.badgeApproved : s === 'rejected' ? styles.badgeRejected : styles.badgePending;
  const icon = s === 'approved' ? <CheckIcon /> : s === 'rejected' ? <AlertIcon /> : <ClockIcon />;
  const label = s === 'approved' ? t('exp_statusApproved') : s === 'rejected' ? t('exp_statusRejected') : t('exp_statusPending');
  return <span className={`${styles.badge} ${cls}`}>{icon}{label}</span>;
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function PlusIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>;
}
function WalletIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><line x1="12" y1="12" x2="12" y2="16"/><line x1="10" y1="14" x2="14" y2="14"/></svg>;
}
function CheckCircleIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>;
}
function ClockCircleIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
}
function XCircleIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>;
}
function SearchIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, color: 'var(--text-muted)' }}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>;
}
function EyeIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>;
}
function EditIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>;
}
function CheckIcon() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>;
}
function AlertIcon() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>;
}
function ClockIcon() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
}
function ReceiptEmptyIcon() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="2"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>;
}
function SearchEmptyIcon() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>;
}
