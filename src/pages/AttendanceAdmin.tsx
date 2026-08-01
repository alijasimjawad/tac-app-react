import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { logActivity } from '../lib/activityLog';
import { cacheOk, getAllSites, ensureFullLoad } from '../lib/sitesCache';
import type { CachedSite } from '../lib/sitesCache';
import { nearestSiteWithin } from '../lib/sitesNearest';
import styles from './AttendanceAdmin.module.css';

// ── Constants ─────────────────────────────────────────────────────────────────

const LATE_CUTOFF_HOUR = 9;
const NEAREST_SITE_KM = 0.5;
const STATUS_OPTIONS = ['Present', 'Late', 'Absent', 'On Leave', 'Half-day'] as const;
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const HIST_PAGE_SIZE = 50;

const AVATAR_COLORS: [string, string][] = [
  ['#dbeafe', '#1d4ed8'], ['#dcfce7', '#15803d'], ['#fef3c7', '#92400e'],
  ['#ede9fe', '#6d28d9'], ['#fce7f3', '#9d174d'], ['#e0f2fe', '#075985'],
];

// ── Types ─────────────────────────────────────────────────────────────────────

interface AttRow {
  id: string;
  member_id: string;
  date: string;
  clock_in: string | null;
  clock_out: string | null;
  hours_worked: number | null;
  status: string | null;
  notes: string | null;
  clock_in_lat: number | null;
  clock_in_lng: number | null;
  clock_out_lat: number | null;
  clock_out_lng: number | null;
  updated_by?: string | null;
  updated_at?: string | null;
}

interface Member {
  id: string;
  full_name: string;
  role: string | null;
  is_active: boolean;
}

type AdminView = 'roster' | 'history';
type RowStatus = 'present' | 'late' | 'missing-out' | 'overdue' | 'not-in' | 'leave' | 'absent' | 'halfday';

interface Filters {
  member: string;
  monthYear: string;
  search: string;
}

interface ModalForm {
  member_id: string;
  date: string;
  clock_in: string;
  clock_out: string;
  status: string;
  notes: string;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

function localDateStr(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayIso(): string { return localDateStr(); }

function fmtDateNav(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

function fmtDateShort(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtHours(h: number | null): string {
  if (h == null) return '—';
  const hrs = Math.floor(h);
  const mins = Math.round((h - hrs) * 60);
  return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
}

function toTimeValue(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function toIso(date: string, t: string): string | null {
  if (!t) return null;
  return new Date(`${date}T${t}:00`).toISOString();
}

function calcHours(inIso: string | null, outIso: string | null): number | null {
  if (!inIso || !outIso) return null;
  return Math.round((+new Date(outIso) - +new Date(inIso)) / 3600000 * 100) / 100;
}

function offsetDate(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return localDateStr(d);
}

function initials(name: string): string {
  if (!name || name === '—') return '?';
  return name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}

function avatarStyle(name: string): { background: string; color: string } {
  if (!name) return { background: '#f1f5f9', color: '#94a3b8' };
  const idx = name.charCodeAt(0) % AVATAR_COLORS.length;
  return { background: AVATAR_COLORS[idx][0], color: AVATAR_COLORS[idx][1] };
}

function nearSummary(lat: number | null, lng: number | null, sites: CachedSite[]): string | null {
  if (lat == null || lng == null) return null;
  const near = nearestSiteWithin(sites, lat, lng, NEAREST_SITE_KM);
  if (!near) return null;
  const code = near.row.site_code || near.row.site_name || 'site';
  const dist = near.km < 1 ? `${Math.round(near.km * 1000)}m` : `${near.km.toFixed(1)}km`;
  return `${code} · ${dist}`;
}

function getRowStatus(row: AttRow | null, isOverdue: boolean): RowStatus {
  if (!row?.clock_in) return isOverdue ? 'overdue' : 'not-in';
  if (row.clock_in && !row.clock_out) return 'missing-out';
  const s = row.status;
  if (s === 'Late')     return 'late';
  if (s === 'Absent')   return 'absent';
  if (s === 'On Leave') return 'leave';
  if (s === 'Half-day') return 'halfday';
  return 'present';
}

function rowBorderClass(status: RowStatus): string {
  switch (status) {
    case 'present':     return styles.rowPresent;
    case 'late':        return styles.rowLate;
    case 'missing-out': return styles.rowMissingOut;
    case 'overdue':     return styles.rowOverdue;
    case 'not-in':      return styles.rowNotIn;
    case 'leave':       return styles.rowLeave;
    case 'absent':      return styles.rowAbsent;
    case 'halfday':     return styles.rowHalfday;
    default:            return '';
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusBadge({ s }: { s: string | null }) {
  const cls = s === 'Present'  ? styles.badgePresent
            : s === 'Late'     ? styles.badgeLate
            : s === 'Absent'   ? styles.badgeAbsent
            : s === 'On Leave' ? styles.badgeLeave
            : s === 'Half-day' ? styles.badgeHalfday
            : styles.badgePending;
  return <span className={`${styles.badge} ${cls}`}>{s || '—'}</span>;
}

function LocCompact({
  inLat, inLng, outLat, outLng, sites,
}: {
  inLat: number | null; inLng: number | null;
  outLat: number | null; outLng: number | null;
  sites: CachedSite[];
}) {
  if (inLat == null && outLat == null) return <span className={styles.dimVal}>—</span>;
  const inNear  = nearSummary(inLat,  inLng,  sites);
  const outNear = nearSummary(outLat, outLng, sites);
  return (
    <div className={styles.locStack}>
      {inLat != null && (
        <div>
          <span className={styles.locLabel}>In</span>
          <a
            className={styles.locLink}
            href={`https://www.google.com/maps?q=${inLat},${inLng}`}
            target="_blank" rel="noopener noreferrer"
          >
            <MapPinIcon /> {inNear ?? 'View map'}
          </a>
        </div>
      )}
      {outLat != null && (
        <div>
          <span className={styles.locLabel}>Out</span>
          <a
            className={styles.locLink}
            href={`https://www.google.com/maps?q=${outLat},${outLng}`}
            target="_blank" rel="noopener noreferrer"
          >
            <MapPinIcon /> {outNear ?? 'View map'}
          </a>
        </div>
      )}
    </div>
  );
}

function DetailsDrawer({
  data, sites, onClose, onEdit, canEdit,
}: {
  data: { member: Member; row: AttRow | null };
  sites: CachedSite[];
  onClose: () => void;
  onEdit: (id: string) => void;
  canEdit: boolean;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { member, row } = data;
  const inNear  = row ? nearSummary(row.clock_in_lat,  row.clock_in_lng,  sites) : null;
  const outNear = row ? nearSummary(row.clock_out_lat, row.clock_out_lng, sites) : null;

  return (
    <>
      <div className={styles.drawerOverlay} onClick={onClose} />
      <aside className={styles.drawer}>
        <div className={styles.drawerHeader}>
          <div className={styles.drawerAvatarWrap}>
            <div className={styles.drawerAvatar} style={avatarStyle(member.full_name)}>
              {initials(member.full_name)}
            </div>
            <div>
              <div className={styles.drawerName}>{member.full_name}</div>
              <div className={styles.drawerRole}>{member.role ?? 'Team Member'}</div>
            </div>
          </div>
          <button className={styles.drawerCloseBtn} onClick={onClose}>×</button>
        </div>

        {row && (
          <div className={styles.drawerDate}>
            {fmtDateNav(row.date)}&nbsp;·&nbsp;<StatusBadge s={row.status} />
          </div>
        )}

        <div className={styles.drawerBody}>
          {row ? (
            <>
              <div className={styles.drawerSection}>
                <div className={styles.drawerSectTitle}>Times</div>
                <div className={styles.drawerFields}>
                  <div className={styles.drawerField}>
                    <div className={styles.drawerFieldLbl}>Clock In</div>
                    <div className={styles.drawerFieldVal}>{fmtTime(row.clock_in)}</div>
                  </div>
                  <div className={styles.drawerField}>
                    <div className={styles.drawerFieldLbl}>Clock Out</div>
                    <div className={row.clock_out ? styles.drawerFieldVal : styles.drawerFieldMuted}>
                      {fmtTime(row.clock_out)}
                    </div>
                  </div>
                  <div className={styles.drawerField}>
                    <div className={styles.drawerFieldLbl}>Hours Worked</div>
                    <div className={styles.drawerFieldVal}>{fmtHours(row.hours_worked)}</div>
                  </div>
                </div>
              </div>

              {(row.clock_in_lat != null || row.clock_out_lat != null) && (
                <div className={styles.drawerSection}>
                  <div className={styles.drawerSectTitle}>Location</div>
                  <div className={styles.drawerLocBlock}>
                    {row.clock_in_lat != null && (
                      <div className={styles.drawerLocRow}>
                        <span className={styles.locLabel}>In</span>
                        <a
                          className={styles.drawerLocLink}
                          href={`https://www.google.com/maps?q=${row.clock_in_lat},${row.clock_in_lng}`}
                          target="_blank" rel="noopener noreferrer"
                        >
                          <MapPinIcon /> {inNear ?? 'View on map'}
                        </a>
                        <div className={styles.drawerLocCoords}>
                          {row.clock_in_lat.toFixed(5)}, {(row.clock_in_lng ?? 0).toFixed(5)}
                        </div>
                      </div>
                    )}
                    {row.clock_out_lat != null && (
                      <div className={styles.drawerLocRow}>
                        <span className={styles.locLabel}>Out</span>
                        <a
                          className={styles.drawerLocLink}
                          href={`https://www.google.com/maps?q=${row.clock_out_lat},${row.clock_out_lng}`}
                          target="_blank" rel="noopener noreferrer"
                        >
                          <MapPinIcon /> {outNear ?? 'View on map'}
                        </a>
                        <div className={styles.drawerLocCoords}>
                          {row.clock_out_lat.toFixed(5)}, {(row.clock_out_lng ?? 0).toFixed(5)}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {row.notes && (
                <div className={styles.drawerSection}>
                  <div className={styles.drawerSectTitle}>Notes</div>
                  <div className={styles.drawerNotes}>{row.notes}</div>
                </div>
              )}

              {(row.updated_by || row.updated_at) && (
                <div className={styles.drawerSection}>
                  <div className={styles.drawerMeta}>
                    Last updated
                    {row.updated_by ? ` by ${row.updated_by}` : ''}
                    {row.updated_at
                      ? ` · ${new Date(row.updated_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`
                      : ''}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}>📋</div>
              <div className={styles.emptyTitle}>No record for this date</div>
              <div className={styles.emptySub}>{member.full_name} has not clocked in.</div>
            </div>
          )}
        </div>

        {row && canEdit && (
          <div className={styles.drawerFooter}>
            <button
              className={styles.drawerEditBtn}
              onClick={() => { onEdit(row.id); onClose(); }}
            >
              <PencilIcon /> Edit Attendance
            </button>
          </div>
        )}
      </aside>
    </>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AttendanceAdmin() {
  const { currentUser, hasPerm } = useAuth();

  const [attendance, setAttendance] = useState<AttRow[]>([]);
  const [members,    setMembers]    = useState<Member[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [sites,      setSites]      = useState<CachedSite[]>([]);

  const [view,         setView]         = useState<AdminView>('roster');
  const [rosterDate,   setRosterDate]   = useState(todayIso());
  const [filterStatus, setFilterStatus] = useState('All');
  const [filters,      setFilters]      = useState<Filters>({ member: '', monthYear: '', search: '' });
  const [histStatus,   setHistStatus]   = useState('All');
  const [histPage,     setHistPage]     = useState(1);

  const [drawerData, setDrawerData] = useState<{ member: Member; row: AttRow | null } | null>(null);

  const [modalOpen,   setModalOpen]   = useState(false);
  const [modalEditId, setModalEditId] = useState<string | null>(null);
  const [modalForm,   setModalForm]   = useState<ModalForm>({
    member_id: '', date: todayIso(), clock_in: '', clock_out: '', status: 'Present', notes: '',
  });
  const [modalErr, setModalErr] = useState('');
  const [saving,   setSaving]   = useState(false);

  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  async function loadAll() {
    setLoading(true);
    const [attRes, membRes] = await Promise.all([
      supabase.from('attendance').select('*').order('date', { ascending: false }),
      supabase.from('team_members').select('id, full_name, role, is_active').order('full_name'),
    ]);
    setAttendance((attRes.data ?? []) as AttRow[]);
    setMembers((membRes.data ?? []) as Member[]);
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
    if (cacheOk()) {
      setSites(getAllSites() as CachedSite[]);
    } else {
      ensureFullLoad(() => setSites(getAllSites() as CachedSite[]));
    }
  }, []);

  // ── Modal open ────────────────────────────────────────────────────────────

  function openModal(id: string | null, prefillMemberId?: string, prefillDate?: string) {
    const r = id ? attendance.find(x => x.id === id) : null;
    setModalEditId(id);
    setModalErr('');
    if (r) {
      setModalForm({
        member_id: r.member_id,
        date:      r.date,
        clock_in:  toTimeValue(r.clock_in),
        clock_out: toTimeValue(r.clock_out),
        status:    r.status ?? 'Present',
        notes:     r.notes ?? '',
      });
    } else {
      setModalForm({
        member_id: prefillMemberId ?? '',
        date:      prefillDate ?? todayIso(),
        clock_in:  '',
        clock_out: '',
        status:    'Present',
        notes:     '',
      });
    }
    setModalOpen(true);
  }

  // ── Save ──────────────────────────────────────────────────────────────────

  async function handleSave() {
    setModalErr('');
    if (!modalForm.member_id || !modalForm.date) {
      setModalErr('Employee and date are required.');
      return;
    }
    const clockInIso  = toIso(modalForm.date, modalForm.clock_in);
    const clockOutIso = toIso(modalForm.date, modalForm.clock_out);
    const hours = calcHours(clockInIso, clockOutIso);

    const payload: Record<string, unknown> = {
      member_id:    modalForm.member_id,
      date:         modalForm.date,
      status:       modalForm.status,
      notes:        modalForm.notes.trim() || null,
      clock_in:     clockInIso,
      clock_out:    clockOutIso,
      hours_worked: hours,
      updated_by:   currentUser?.full_name ?? currentUser?.username ?? '',
      updated_at:   new Date().toISOString(),
    };

    setSaving(true);
    let error;
    if (modalEditId) {
      ({ error } = await supabase.from('attendance').update(payload).eq('id', modalEditId));
    } else {
      ({ error } = await supabase.from('attendance').upsert(payload, { onConflict: 'member_id,date' }));
    }
    setSaving(false);

    if (error) { setModalErr(error.message); return; }
    showToast(modalEditId ? 'Attendance updated.' : 'Entry saved.', true);
    if (modalEditId) {
      const empName = members.find(m => m.id === modalForm.member_id)?.full_name ?? 'employee';
      logActivity({
        userFullName: currentUser?.full_name ?? currentUser?.username,
        action: 'Edited Attendance',
        details: `Edited attendance for ${empName} — ${modalForm.date} (${modalForm.status})`,
      });
    }
    setModalOpen(false);
    await loadAll();
  }

  // ── Permission gate ───────────────────────────────────────────────────────

  if (!hasPerm('view_attendance_admin')) {
    return (
      <div className={styles.page}>
        <div className={styles.denied}>You don't have permission to view this page.</div>
      </div>
    );
  }

  // ── Derived data ──────────────────────────────────────────────────────────

  const activeMembers  = members.filter(m => m.is_active !== false);
  const today          = todayIso();
  const isToday        = rosterDate === today;
  const nowHour        = new Date().getHours();
  const overdueCutoff  = isToday && nowHour >= LATE_CUTOFF_HOUR;

  const dayRows      = attendance.filter(r => r.date === rosterDate);
  const rosterSearch = filters.search.toLowerCase();

  const allRosterRows = activeMembers
    .filter(m => !rosterSearch || (m.full_name || '').toLowerCase().includes(rosterSearch))
    .map(m => {
      const row       = dayRows.find(x => x.member_id === m.id) ?? null;
      const isOverdue = overdueCutoff && !row?.clock_in;
      const status    = getRowStatus(row, isOverdue);
      return { member: m, row, isOverdue, status };
    });

  const kpiPresent = allRosterRows.filter(r => r.row?.clock_in && r.row?.clock_out).length;
  const kpiActive  = allRosterRows.filter(r => r.row?.clock_in && !r.row?.clock_out).length;
  const kpiNotIn   = allRosterRows.filter(r => !r.row?.clock_in).length;
  const kpiLate    = allRosterRows.filter(r => r.row?.status === 'Late').length;

  const rosterRows = filterStatus === 'All'
    ? allRosterRows
    : allRosterRows.filter(r => {
        if (filterStatus === 'Active')  return r.row?.clock_in && !r.row?.clock_out;
        if (filterStatus === 'Done')    return r.row?.clock_in && r.row?.clock_out;
        if (filterStatus === 'Not In')  return !r.row?.clock_in;
        if (filterStatus === 'Late')    return r.row?.status === 'Late';
        return true;
      });

  const attentionItems = allRosterRows.filter(r => r.status === 'overdue' || r.status === 'missing-out');

  // History
  const filteredHistory = attendance.filter(r => {
    const mn = (members.find(t => t.id === r.member_id)?.full_name ?? '').toLowerCase();
    if (filters.member && mn !== filters.member.toLowerCase()) return false;
    if (filters.monthYear) {
      const [ys, ms] = filters.monthYear.split('-');
      const d = new Date(r.date + 'T00:00:00');
      if (isNaN(d.getTime()) || d.getMonth() + 1 !== +ms || d.getFullYear() !== +ys) return false;
    }
    if (histStatus !== 'All' && r.status !== histStatus) return false;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      if (!mn.includes(q) && !(r.date || '').includes(q) && !(r.notes || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const histPageCount = Math.ceil(filteredHistory.length / HIST_PAGE_SIZE);
  const pagedHistory  = filteredHistory.slice((histPage - 1) * HIST_PAGE_SIZE, histPage * HIST_PAGE_SIZE);

  const memberNames = [...new Set(
    attendance.map(r => members.find(t => t.id === r.member_id)?.full_name).filter(Boolean) as string[]
  )].sort();

  const histYears = [...new Set(
    attendance.map(r => r.date ? new Date(r.date + 'T00:00:00').getFullYear() : null).filter(Boolean) as number[]
  )].sort((a, b) => b - a);
  if (!histYears.includes(new Date().getFullYear())) histYears.unshift(new Date().getFullYear());

  const anyHistFilter = filters.member || filters.monthYear || filters.search || histStatus !== 'All';

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className={styles.page}>
      {toast && (
        <div className={`${styles.toast} ${toast.ok ? styles.toastOk : styles.toastErr}`}>{toast.msg}</div>
      )}

      {/* Header */}
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Attendance</h1>
          <div className={styles.subtitle}>
            {view === 'roster'
              ? `${kpiPresent + kpiActive} clocked in · ${kpiNotIn} not clocked in · ${fmtDateShort(rosterDate)}`
              : `${filteredHistory.length} record${filteredHistory.length !== 1 ? 's' : ''}`}
          </div>
        </div>
        <div className={styles.headerRight}>
          <div className={styles.segmented}>
            <button
              className={`${styles.segBtn} ${view === 'roster' ? styles.segBtnActive : ''}`}
              onClick={() => setView('roster')}
            >
              <CalendarIcon /> Roster
            </button>
            <button
              className={`${styles.segBtn} ${view === 'history' ? styles.segBtnActive : ''}`}
              onClick={() => setView('history')}
            >
              <HistoryIcon /> History
            </button>
          </div>
          {hasPerm('attendance_admin_add') && (
            <button className={styles.addBtn} onClick={() => openModal(null)}>
              <PlusIcon /> Manual Entry
            </button>
          )}
        </div>
      </div>

      {/* KPI cards — roster only */}
      {view === 'roster' && !loading && (
        <div className={styles.kpiGrid}>
          <div className={`${styles.kpiCard} ${styles.kpiGreen}`}>
            <div className={styles.kpiIcon}><PersonCheckIcon /></div>
            <div className={styles.kpiContent}>
              <div className={styles.kpiValue}>{kpiPresent + kpiActive}</div>
              <div className={styles.kpiLabel}>Clocked In</div>
              {kpiActive > 0 && <div className={styles.kpiSub}>{kpiActive} still active</div>}
            </div>
          </div>
          <div className={`${styles.kpiCard} ${styles.kpiSlate}`}>
            <div className={styles.kpiIcon}><PersonXIcon /></div>
            <div className={styles.kpiContent}>
              <div className={styles.kpiValue}>{kpiNotIn}</div>
              <div className={styles.kpiLabel}>Not Clocked In</div>
              {overdueCutoff && kpiNotIn > 0 && <div className={styles.kpiSub}>Past 9:00 AM</div>}
            </div>
          </div>
          <div className={`${styles.kpiCard} ${kpiLate > 0 ? styles.kpiAmber : styles.kpiNeutral}`}>
            <div className={styles.kpiIcon}><ClockWarningIcon /></div>
            <div className={styles.kpiContent}>
              <div className={styles.kpiValue}>{kpiLate}</div>
              <div className={styles.kpiLabel}>Late Arrivals</div>
            </div>
          </div>
          <div className={`${styles.kpiCard} ${kpiActive > 0 ? styles.kpiRed : styles.kpiNeutral}`}>
            <div className={styles.kpiIcon}><MissingIcon /></div>
            <div className={styles.kpiContent}>
              <div className={styles.kpiValue}>{kpiActive}</div>
              <div className={styles.kpiLabel}>Missing Clock-Out</div>
            </div>
          </div>
        </div>
      )}

      {/* Roster controls */}
      {view === 'roster' && (
        <div className={styles.controlBar}>
          <div className={styles.dateNav}>
            <button className={styles.dateNavBtn} onClick={() => setRosterDate(d => offsetDate(d, -1))}>
              <ChevronLeftIcon />
            </button>
            <span className={styles.dateLabel}>{fmtDateNav(rosterDate)}</span>
            <button
              className={styles.dateNavBtn}
              onClick={() => setRosterDate(d => offsetDate(d, 1))}
              disabled={rosterDate >= today}
            >
              <ChevronRightIcon />
            </button>
            {!isToday && (
              <button className={styles.todayBtn} onClick={() => setRosterDate(today)}>Today</button>
            )}
          </div>
          <div className={styles.filterBar}>
            <div className={styles.searchWrap}>
              <span className={styles.searchIcon}><SearchIcon /></span>
              <input
                className={styles.searchInput}
                type="text"
                placeholder="Search name…"
                value={filters.search}
                onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
              />
            </div>
            <select
              className={styles.filterSelect}
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
            >
              <option value="All">All</option>
              <option value="Active">Active</option>
              <option value="Done">Clocked Out</option>
              <option value="Not In">Not In</option>
              <option value="Late">Late</option>
            </select>
          </div>
        </div>
      )}

      {/* History controls */}
      {view === 'history' && (
        <div className={styles.histFilters}>
          <div className={styles.searchWrap}>
            <span className={styles.searchIcon}><SearchIcon /></span>
            <input
              className={styles.searchInput}
              type="text"
              placeholder="Search name, date, notes…"
              value={filters.search}
              onChange={e => { setFilters(f => ({ ...f, search: e.target.value })); setHistPage(1); }}
            />
          </div>
          <select
            className={styles.filterSelect}
            value={filters.member}
            onChange={e => { setFilters(f => ({ ...f, member: e.target.value })); setHistPage(1); }}
          >
            <option value="">All employees</option>
            {memberNames.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
          <select
            className={styles.filterSelect}
            value={filters.monthYear}
            onChange={e => { setFilters(f => ({ ...f, monthYear: e.target.value })); setHistPage(1); }}
          >
            <option value="">All months</option>
            {histYears.flatMap(y =>
              Array.from({ length: 12 }, (_, i) => i + 1).map(m => {
                const val = `${y}-${String(m).padStart(2, '0')}`;
                return <option key={val} value={val}>{MONTHS[m - 1]} {y}</option>;
              })
            )}
          </select>
          <select
            className={styles.filterSelect}
            value={histStatus}
            onChange={e => { setHistStatus(e.target.value); setHistPage(1); }}
          >
            <option value="All">All statuses</option>
            {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          {anyHistFilter && (
            <button
              className={styles.clearBtn}
              onClick={() => { setFilters({ member: '', monthYear: '', search: '' }); setHistStatus('All'); setHistPage(1); }}
            >Clear</button>
          )}
          <span className={styles.resultCount}>{filteredHistory.length} records</span>
        </div>
      )}

      {/* Attention panel */}
      {view === 'roster' && !loading && attentionItems.length > 0 && (
        <div className={styles.attentionPanel}>
          <div className={styles.attentionTitle}>
            <WarningIcon /> Needs Attention ({attentionItems.length})
          </div>
          <div className={styles.attentionItems}>
            {attentionItems.slice(0, 5).map(({ member, row, status }) => (
              <div key={member.id} className={styles.attentionItem}>
                <div
                  className={styles.attentionDot}
                  style={{ background: status === 'overdue' ? '#f59e0b' : '#ef4444' }}
                />
                <div className={styles.attentionText}>
                  <strong>{member.full_name}</strong>{' — '}
                  {status === 'overdue' ? 'not clocked in past 9:00 AM' : 'clocked in, missing clock-out'}
                </div>
                {hasPerm('attendance_admin_add') && (
                  <button
                    className={styles.attentionAction}
                    onClick={() => openModal(row ? row.id : null, member.id, rosterDate)}
                  >
                    {row ? 'Edit' : 'Add Entry'}
                  </button>
                )}
              </div>
            ))}
            {attentionItems.length > 5 && (
              <div style={{ fontSize: 12, color: '#92400e', paddingLeft: 16 }}>
                +{attentionItems.length - 5} more
              </div>
            )}
          </div>
        </div>
      )}

      {/* Main content */}
      {loading ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyTitle}>Loading…</div>
        </div>
      ) : view === 'roster' ? (
        <>
          {/* Desktop table */}
          <div className={styles.tableCard}>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Clock In</th>
                    <th>Clock Out</th>
                    <th>Hours</th>
                    <th>Status</th>
                    <th>Location</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rosterRows.length === 0 ? (
                    <tr><td colSpan={7} className={styles.tdEmpty}>No employees match the current filter.</td></tr>
                  ) : rosterRows.map(({ member, row, status }) => (
                    <tr key={member.id} className={`${styles.tableRow} ${rowBorderClass(status)}`}>
                      <td>
                        <div className={styles.empCell}>
                          <div className={styles.avatar} style={avatarStyle(member.full_name)}>
                            {initials(member.full_name)}
                          </div>
                          <div>
                            <div className={styles.empName}>{member.full_name}</div>
                            {member.role && <div className={styles.empRole}>{member.role}</div>}
                          </div>
                        </div>
                      </td>
                      <td>
                        {row?.clock_in
                          ? <span className={styles.timeVal}>{fmtTime(row.clock_in)}</span>
                          : status === 'overdue'
                            ? <div className={styles.notInCell}>
                                <span className={styles.notInText}>Not clocked in</span>
                                <span className={styles.overduePill}>Overdue</span>
                              </div>
                            : <span className={styles.dimVal}>—</span>}
                      </td>
                      <td>
                        {row?.clock_out
                          ? <span className={styles.timeVal}>{fmtTime(row.clock_out)}</span>
                          : row?.clock_in
                            ? <span className={styles.missingOutPill}>Missing</span>
                            : <span className={styles.dimVal}>—</span>}
                      </td>
                      <td>
                        {row?.hours_worked != null
                          ? <span className={styles.durationVal}>{fmtHours(row.hours_worked)}</span>
                          : <span className={styles.dimVal}>—</span>}
                      </td>
                      <td>
                        {row?.status
                          ? <StatusBadge s={row.status} />
                          : <span className={styles.dimVal}>—</span>}
                      </td>
                      <td>
                        {row
                          ? <LocCompact
                              inLat={row.clock_in_lat}   inLng={row.clock_in_lng}
                              outLat={row.clock_out_lat} outLng={row.clock_out_lng}
                              sites={sites}
                            />
                          : <span className={styles.dimVal}>—</span>}
                      </td>
                      <td className={styles.actionsCell}>
                        <button
                          className={styles.iconBtn}
                          title="View details"
                          onClick={() => setDrawerData({ member, row })}
                        ><EyeIcon /></button>
                        {row
                          ? (hasPerm('attendance_admin_edit') && (
                              <button
                                className={styles.iconBtn}
                                title="Edit"
                                onClick={() => openModal(row.id)}
                              ><PencilIcon /></button>
                            ))
                          : (hasPerm('attendance_admin_add') && (
                              <button
                                className={styles.addEntryBtn}
                                onClick={() => openModal(null, member.id, rosterDate)}
                              ><PlusIcon /> Add</button>
                            ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile cards */}
          <div className={styles.mobileList}>
            {rosterRows.map(({ member, row, status }) => (
              <div key={member.id} className={`${styles.mobileCard} ${rowBorderClass(status)}`}>
                <div className={styles.mobileCardHeader}>
                  <div className={styles.mobileCardLeft}>
                    <div className={styles.avatar} style={avatarStyle(member.full_name)}>
                      {initials(member.full_name)}
                    </div>
                    <div>
                      <div className={styles.empName}>{member.full_name}</div>
                      {member.role && <div className={styles.empRole}>{member.role}</div>}
                    </div>
                  </div>
                  <StatusBadge s={row?.status ?? null} />
                </div>
                <div className={styles.mobileCardStats}>
                  <div className={styles.mobileStat}>
                    <div className={styles.mobileStatLabel}>In</div>
                    <div className={styles.mobileStatValue}>{fmtTime(row?.clock_in ?? null)}</div>
                  </div>
                  <div className={styles.mobileStat}>
                    <div className={styles.mobileStatLabel}>Out</div>
                    <div className={styles.mobileStatValue}>{fmtTime(row?.clock_out ?? null)}</div>
                  </div>
                  <div className={styles.mobileStat}>
                    <div className={styles.mobileStatLabel}>Hours</div>
                    <div className={styles.mobileStatValue}>{fmtHours(row?.hours_worked ?? null)}</div>
                  </div>
                </div>
                <div className={styles.mobileCardActions}>
                  <button
                    className={styles.mobileActionBtn}
                    onClick={() => setDrawerData({ member, row })}
                  >View</button>
                  {row
                    ? (hasPerm('attendance_admin_edit') && (
                        <button
                          className={styles.mobileActionBtnPrimary}
                          onClick={() => openModal(row.id)}
                        >Edit</button>
                      ))
                    : (hasPerm('attendance_admin_add') && (
                        <button
                          className={styles.mobileActionBtnPrimary}
                          onClick={() => openModal(null, member.id, rosterDate)}
                        >Add Entry</button>
                      ))}
                </div>
              </div>
            ))}
            {rosterRows.length === 0 && (
              <div className={styles.emptyState}>
                <div className={styles.emptyTitle}>No employees match the current filter.</div>
              </div>
            )}
          </div>
        </>
      ) : (
        /* History view */
        <>
          <div className={styles.tableCard}>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Date</th>
                    <th>Clock In</th>
                    <th>Clock Out</th>
                    <th>Hours</th>
                    <th>Status</th>
                    <th>Location</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedHistory.length === 0 ? (
                    <tr><td colSpan={8} className={styles.tdEmpty}>No attendance records match the current filters.</td></tr>
                  ) : pagedHistory.map(r => {
                    const emp     = members.find(t => t.id === r.member_id);
                    const empName = emp?.full_name ?? '—';
                    return (
                      <tr key={r.id} className={styles.tableRow}>
                        <td>
                          <div className={styles.empCell}>
                            <div className={styles.avatar} style={avatarStyle(empName)}>
                              {initials(empName)}
                            </div>
                            <div>
                              <div className={styles.empName}>{empName}</div>
                              {emp?.role && <div className={styles.empRole}>{emp.role}</div>}
                            </div>
                          </div>
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>{fmtDateShort(r.date)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{fmtTime(r.clock_in)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{fmtTime(r.clock_out)}</td>
                        <td>
                          {r.hours_worked != null
                            ? <span className={styles.durationVal}>{fmtHours(r.hours_worked)}</span>
                            : <span className={styles.dimVal}>—</span>}
                        </td>
                        <td><StatusBadge s={r.status} /></td>
                        <td>
                          <LocCompact
                            inLat={r.clock_in_lat}   inLng={r.clock_in_lng}
                            outLat={r.clock_out_lat} outLng={r.clock_out_lng}
                            sites={sites}
                          />
                        </td>
                        <td className={styles.actionsCell}>
                          {emp && (
                            <button
                              className={styles.iconBtn}
                              title="View details"
                              onClick={() => setDrawerData({ member: emp, row: r })}
                            ><EyeIcon /></button>
                          )}
                          {hasPerm('attendance_admin_edit') && (
                            <button
                              className={styles.iconBtn}
                              title="Edit"
                              onClick={() => openModal(r.id)}
                            ><PencilIcon /></button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {histPageCount > 1 && (
            <div className={styles.pagination}>
              <button
                className={styles.pageBtn}
                disabled={histPage <= 1}
                onClick={() => setHistPage(p => p - 1)}
              >← Prev</button>
              <span className={styles.pageInfo}>Page {histPage} of {histPageCount}</span>
              <button
                className={styles.pageBtn}
                disabled={histPage >= histPageCount}
                onClick={() => setHistPage(p => p + 1)}
              >Next →</button>
            </div>
          )}
        </>
      )}

      {/* Details drawer */}
      {drawerData && (
        <DetailsDrawer
          data={drawerData}
          sites={sites}
          onClose={() => setDrawerData(null)}
          onEdit={(id) => openModal(id)}
          canEdit={hasPerm('attendance_admin_edit')}
        />
      )}

      {/* Add / Edit modal */}
      {modalOpen && (
        <div
          className={styles.modalOverlay}
          onClick={e => { if (e.target === e.currentTarget) setModalOpen(false); }}
        >
          <div className={styles.modal}>
            <div className={styles.modalHeader}>
              <div className={styles.modalTitle}>{modalEditId ? 'Edit Attendance' : 'Add Attendance'}</div>
              <button className={styles.modalClose} onClick={() => setModalOpen(false)}>×</button>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.modalField}>
                <label>Employee <span className={styles.req}>*</span></label>
                <select
                  value={modalForm.member_id}
                  onChange={e => setModalForm(f => ({ ...f, member_id: e.target.value }))}
                >
                  <option value="">— Select employee —</option>
                  {activeMembers.map(m => (
                    <option key={m.id} value={m.id}>{m.full_name}</option>
                  ))}
                </select>
              </div>
              <div className={styles.modalField}>
                <label>Date <span className={styles.req}>*</span></label>
                <input
                  type="date"
                  value={modalForm.date}
                  onChange={e => setModalForm(f => ({ ...f, date: e.target.value }))}
                />
              </div>
              <div className={styles.modalFieldRow}>
                <div className={styles.modalField}>
                  <label>Clock In</label>
                  <input
                    type="time"
                    value={modalForm.clock_in}
                    onChange={e => setModalForm(f => ({ ...f, clock_in: e.target.value }))}
                  />
                </div>
                <div className={styles.modalField}>
                  <label>Clock Out</label>
                  <input
                    type="time"
                    value={modalForm.clock_out}
                    onChange={e => setModalForm(f => ({ ...f, clock_out: e.target.value }))}
                  />
                </div>
              </div>
              <div className={styles.modalField}>
                <label>Status</label>
                <select
                  value={modalForm.status}
                  onChange={e => setModalForm(f => ({ ...f, status: e.target.value }))}
                >
                  {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className={styles.modalField}>
                <label>Notes</label>
                <textarea
                  rows={2}
                  placeholder="Optional…"
                  maxLength={400}
                  value={modalForm.notes}
                  onChange={e => setModalForm(f => ({ ...f, notes: e.target.value }))}
                />
              </div>
              {modalErr && <div className={styles.modalErr}>{modalErr}</div>}
            </div>
            <div className={styles.modalFooter}>
              <button className={styles.modalCancelBtn} onClick={() => setModalOpen(false)}>Cancel</button>
              <button className={styles.modalSaveBtn} onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function CalendarIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="4" width="18" height="18" rx="2"/>
      <line x1="16" y1="2" x2="16" y2="6"/>
      <line x1="8" y1="2" x2="8" y2="6"/>
      <line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10"/>
      <polyline points="12 6 12 12 16 14"/>
    </svg>
  );
}

function MapPinIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
      <circle cx="12" cy="10" r="3"/>
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <line x1="12" y1="5" x2="12" y2="19"/>
      <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <polyline points="15 18 9 12 15 6"/>
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <polyline points="9 18 15 12 9 6"/>
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/>
      <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  );
}

function PersonCheckIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="8.5" cy="7" r="4"/>
      <polyline points="17 11 19 13 23 9"/>
    </svg>
  );
}

function PersonXIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="8.5" cy="7" r="4"/>
      <line x1="18" y1="8" x2="23" y2="13"/>
      <line x1="23" y1="8" x2="18" y2="13"/>
    </svg>
  );
}

function ClockWarningIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10"/>
      <polyline points="12 6 12 12 16 14"/>
    </svg>
  );
}

function MissingIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="12"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  );
}

export function AttendanceAdminIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="4" width="18" height="18" rx="2"/>
      <line x1="16" y1="2" x2="16" y2="6"/>
      <line x1="8" y1="2" x2="8" y2="6"/>
      <line x1="3" y1="10" x2="21" y2="10"/>
      <path d="M8 14l2 2 4-4"/>
    </svg>
  );
}
