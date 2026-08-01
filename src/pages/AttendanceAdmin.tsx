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

type LocVerify = 'verified' | 'unverified' | 'none';

function locVerifyStatus(lat: number | null | undefined, lng: number | null | undefined, sites: CachedSite[]): LocVerify {
  if (lat == null || lng == null) return 'none';
  return nearestSiteWithin(sites, lat, lng, NEAREST_SITE_KM) ? 'verified' : 'unverified';
}

/** How long ago the daily late-cutoff passed, formatted "Xh Ym" — used for the
 *  "Overdue by …" subtext under not-clocked-in employees. */
function overdueSince(cutoffHour: number): string {
  const now = new Date();
  const cutoff = new Date();
  cutoff.setHours(cutoffHour, 0, 0, 0);
  const ms = now.getTime() - cutoff.getTime();
  if (ms <= 0) return '';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** How late a given clock-in was relative to the cutoff, formatted "Xh Ym late". */
function lateBy(clockInIso: string | null, cutoffHour: number): string | null {
  if (!clockInIso) return null;
  const d = new Date(clockInIso);
  const cutoff = new Date(d);
  cutoff.setHours(cutoffHour, 0, 0, 0);
  const ms = d.getTime() - cutoff.getTime();
  if (ms <= 0) return null;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m late` : `${m}m late`;
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

function RowStatusBadge({ row, isOverdue }: { row: AttRow | null; isOverdue: boolean }) {
  if (!row?.clock_in) {
    return isOverdue
      ? <span className={`${styles.badge} ${styles.badgeOverdue}`}>Not Clocked In</span>
      : <span className={`${styles.badge} ${styles.badgeNotIn}`}>Not Clocked In</span>;
  }
  if (!row.clock_out) {
    return <span className={`${styles.badge} ${styles.badgeLate}`}>Clocked In</span>;
  }
  return <StatusBadge s={row.status} />;
}

function LocPrimary({ row, sites }: { row: AttRow | null; sites: CachedSite[] }) {
  if (!row) return <span className={styles.dimVal}>—</span>;
  const lat = row.clock_in_lat ?? row.clock_out_lat;
  const lng = row.clock_in_lng ?? row.clock_out_lng;
  if (lat == null) return <span className={styles.dimVal}>—</span>;
  const near = nearSummary(lat, lng, sites);
  return (
    <a
      className={styles.locLink}
      href={`https://www.google.com/maps?q=${lat},${lng}`}
      target="_blank" rel="noopener noreferrer"
    >
      <MapPinIcon /> {near ?? 'View map'}
    </a>
  );
}

function VerifyBadge({ status }: { status: LocVerify }) {
  if (status === 'none') return <span className={styles.dimVal}>—</span>;
  return status === 'verified'
    ? <span className={`${styles.badge} ${styles.badgeVerified}`}>Verified</span>
    : <span className={`${styles.badge} ${styles.badgeUnverified}`}>Unverified</span>;
}

type DrawerTab = 'overview' | 'timeline' | 'location' | 'notes';

function DetailsDrawer({
  data, sites, onClose, onEdit, canEdit,
}: {
  data: { member: Member; row: AttRow | null };
  sites: CachedSite[];
  onClose: () => void;
  onEdit: (id: string) => void;
  canEdit: boolean;
}) {
  const [tab, setTab] = useState<DrawerTab>('overview');

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { member, row } = data;
  const inNear  = row ? nearSummary(row.clock_in_lat,  row.clock_in_lng,  sites) : null;
  const outNear = row ? nearSummary(row.clock_out_lat, row.clock_out_lng, sites) : null;
  const inVerify  = row ? locVerifyStatus(row.clock_in_lat,  row.clock_in_lng,  sites) : 'none';
  const outVerify = row ? locVerifyStatus(row.clock_out_lat, row.clock_out_lng, sites) : 'none';
  const late = row ? lateBy(row.clock_in, LATE_CUTOFF_HOUR) : null;
  const mapLat = row ? row.clock_in_lat ?? row.clock_out_lat : null;
  const mapLng = row ? row.clock_in_lng ?? row.clock_out_lng : null;

  const tabs: { id: DrawerTab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'timeline', label: 'Timeline' },
    { id: 'location', label: 'Location' },
    { id: 'notes', label: 'Notes' },
  ];

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

        {row && (
          <div className={styles.drawerTabs}>
            {tabs.map(t => (
              <button
                key={t.id}
                className={`${styles.drawerTabBtn} ${tab === t.id ? styles.drawerTabBtnActive : ''}`}
                onClick={() => setTab(t.id)}
              >{t.label}</button>
            ))}
          </div>
        )}

        <div className={styles.drawerBody}>
          {!row ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}>📋</div>
              <div className={styles.emptyTitle}>No record for this date</div>
              <div className={styles.emptySub}>{member.full_name} has not clocked in.</div>
            </div>
          ) : tab === 'overview' ? (
            <>
              <div className={styles.drawerSection}>
                <div className={styles.drawerSectTitle}>Today's Summary</div>
                <div className={styles.drawerFields}>
                  <div className={styles.drawerField}>
                    <div className={styles.drawerFieldLbl}>Date</div>
                    <div className={styles.drawerFieldVal}>{fmtDateNav(row.date)}</div>
                  </div>
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
                    <div className={styles.drawerFieldLbl}>Worked Hours</div>
                    <div className={styles.drawerFieldVal}>{fmtHours(row.hours_worked)}</div>
                  </div>
                  <div className={styles.drawerField}>
                    <div className={styles.drawerFieldLbl}>Status</div>
                    <div className={styles.drawerFieldVal}><StatusBadge s={row.status} /></div>
                  </div>
                  <div className={styles.drawerField}>
                    <div className={styles.drawerFieldLbl}>Late</div>
                    <div className={late ? styles.drawerFieldVal : styles.drawerFieldMuted}>{late ?? 'On time'}</div>
                  </div>
                </div>
              </div>

              <div className={styles.drawerSection}>
                <div className={styles.drawerSectTitle}>Location Verification</div>
                {row.clock_in_lat == null && row.clock_out_lat == null ? (
                  <div className={styles.drawerFieldMuted}>No location recorded.</div>
                ) : (
                  <div className={styles.drawerLocBlock}>
                    {row.clock_in_lat != null && (
                      <div className={styles.drawerVerifyRow}>
                        <span className={styles.drawerVerifyLabel}>Check-in: <MapPinIcon /> {inNear ?? 'Unknown location'}</span>
                        <VerifyBadge status={inVerify} />
                      </div>
                    )}
                    {row.clock_out_lat != null && (
                      <div className={styles.drawerVerifyRow}>
                        <span className={styles.drawerVerifyLabel}>Check-out: <MapPinIcon /> {outNear ?? 'Unknown location'}</span>
                        <VerifyBadge status={outVerify} />
                      </div>
                    )}
                    {(inVerify === 'verified' || outVerify === 'verified') && (
                      <div className={styles.drawerGeofence}>Geofence: Within allowed area</div>
                    )}
                  </div>
                )}
              </div>

              <div className={styles.drawerSection}>
                <div className={styles.drawerSectTitle}>Additional Information</div>
                <div className={styles.drawerFields}>
                  <div className={styles.drawerField}>
                    <div className={styles.drawerFieldLbl}>Department</div>
                    <div className={styles.drawerFieldVal}>{member.role ?? '—'}</div>
                  </div>
                  <div className={styles.drawerField}>
                    <div className={styles.drawerFieldLbl}>Recorded By</div>
                    <div className={styles.drawerFieldVal}>{row.updated_by || 'Employee (self clock-in)'}</div>
                  </div>
                  <div className={styles.drawerField}>
                    <div className={styles.drawerFieldLbl}>Last Updated</div>
                    <div className={styles.drawerFieldVal}>
                      {row.updated_at
                        ? new Date(row.updated_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
                        : '—'}
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : tab === 'timeline' ? (
            <div className={styles.drawerSection}>
              <div className={styles.drawerSectTitle}>Timeline</div>
              {!row.clock_in && !row.clock_out ? (
                <div className={styles.drawerFieldMuted}>No events recorded.</div>
              ) : (
                <div className={styles.timeline}>
                  {row.clock_in && (
                    <div className={styles.timelineItem}>
                      <div className={styles.timelineDot} style={{ background: '#16a34a' }} />
                      <div>
                        <div className={styles.timelineLbl}>Clocked In</div>
                        <div className={styles.timelineTime}>{fmtTime(row.clock_in)}{late ? ` · ${late}` : ''}</div>
                      </div>
                    </div>
                  )}
                  {row.clock_in && !row.clock_out && (
                    <div className={styles.timelineItem}>
                      <div className={styles.timelineDot} style={{ background: '#f59e0b' }} />
                      <div>
                        <div className={styles.timelineLbl}>Still Active</div>
                        <div className={styles.timelineTime}>Awaiting clock-out</div>
                      </div>
                    </div>
                  )}
                  {row.clock_out && (
                    <div className={styles.timelineItem}>
                      <div className={styles.timelineDot} style={{ background: '#64748b' }} />
                      <div>
                        <div className={styles.timelineLbl}>Clocked Out</div>
                        <div className={styles.timelineTime}>{fmtTime(row.clock_out)}</div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : tab === 'location' ? (
            <div className={styles.drawerSection}>
              <div className={styles.drawerSectTitle}>Location</div>
              {row.clock_in_lat == null && row.clock_out_lat == null ? (
                <div className={styles.drawerFieldMuted}>No location recorded.</div>
              ) : (
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
                      <VerifyBadge status={inVerify} />
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
                      <VerifyBadge status={outVerify} />
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className={styles.drawerSection}>
              <div className={styles.drawerSectTitle}>Notes</div>
              {row.notes
                ? <div className={styles.drawerNotes}>{row.notes}</div>
                : <div className={styles.drawerFieldMuted}>No notes for this entry.</div>}
              {(row.updated_by || row.updated_at) && (
                <div className={styles.drawerMeta}>
                  Last updated
                  {row.updated_by ? ` by ${row.updated_by}` : ' by Employee (self clock-in)'}
                  {row.updated_at
                    ? ` · ${new Date(row.updated_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`
                    : ''}
                </div>
              )}
            </div>
          )}
        </div>

        {row && (
          <div className={styles.drawerFooter}>
            {canEdit && (
              <button
                className={styles.drawerEditBtn}
                onClick={() => { onEdit(row.id); onClose(); }}
              >
                <PencilIcon /> Edit Attendance
              </button>
            )}
            {mapLat != null && (
              <a
                className={styles.drawerMapBtn}
                href={`https://www.google.com/maps?q=${mapLat},${mapLng}`}
                target="_blank" rel="noopener noreferrer"
              >
                <MapPinIcon /> View on Map
              </a>
            )}
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

  const [deptFilter,       setDeptFilter]       = useState('All');
  const [locFilter,        setLocFilter]        = useState('All');
  const [onlyFlagged,      setOnlyFlagged]      = useState(false);
  const [moreFiltersOpen,  setMoreFiltersOpen]  = useState(false);
  const [attentionExpanded, setAttentionExpanded] = useState(false);
  const [rosterPage,     setRosterPage]     = useState(1);
  const [rosterPageSize, setRosterPageSize] = useState(10);

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

  const departmentOptions = [...new Set(
    activeMembers.map(m => m.role).filter(Boolean) as string[]
  )].sort();

  const rosterRows = allRosterRows.filter(r => {
    if (filterStatus === 'Active' && !(r.row?.clock_in && !r.row?.clock_out)) return false;
    if (filterStatus === 'Done'   && !(r.row?.clock_in && r.row?.clock_out))  return false;
    if (filterStatus === 'Not In' && r.row?.clock_in)                        return false;
    if (filterStatus === 'Late'   && r.row?.status !== 'Late')               return false;
    if (deptFilter !== 'All' && (r.member.role ?? '') !== deptFilter) return false;
    if (locFilter !== 'All') {
      const verify = r.row
        ? locVerifyStatus(r.row.clock_in_lat ?? r.row.clock_out_lat, r.row.clock_in_lng ?? r.row.clock_out_lng, sites)
        : 'none';
      if (locFilter === 'Verified'   && verify !== 'verified')   return false;
      if (locFilter === 'Unverified' && verify !== 'unverified') return false;
    }
    if (onlyFlagged && !(r.status === 'overdue' || r.status === 'missing-out' || r.status === 'late')) return false;
    return true;
  });

  const attentionItems = allRosterRows.filter(r => r.status === 'overdue' || r.status === 'missing-out');

  const anyRosterFilter = filterStatus !== 'All' || deptFilter !== 'All' || locFilter !== 'All'
    || onlyFlagged || !!filters.search;

  const rosterPageCount = Math.max(1, Math.ceil(rosterRows.length / rosterPageSize));
  const rosterPageSafe  = Math.min(rosterPage, rosterPageCount);
  const pagedRoster = rosterRows.slice((rosterPageSafe - 1) * rosterPageSize, rosterPageSafe * rosterPageSize);
  const rosterRangeStart = rosterRows.length === 0 ? 0 : (rosterPageSafe - 1) * rosterPageSize + 1;
  const rosterRangeEnd   = Math.min(rosterPageSafe * rosterPageSize, rosterRows.length);

  useEffect(() => { setRosterPage(1); }, [filterStatus, deptFilter, locFilter, onlyFlagged, filters.search, rosterDate, rosterPageSize]);

  function clearRosterFilters() {
    setFilterStatus('All');
    setDeptFilter('All');
    setLocFilter('All');
    setOnlyFlagged(false);
    setFilters(f => ({ ...f, search: '' }));
  }

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
              ? "Monitor today's attendance, working hours, and location verification."
              : `${filteredHistory.length} record${filteredHistory.length !== 1 ? 's' : ''}`}
          </div>
        </div>
        <div className={styles.headerRight}>
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
              <div className={styles.kpiSub}>{kpiPresent + kpiActive} of {activeMembers.length} employees</div>
            </div>
          </div>
          <div className={`${styles.kpiCard} ${styles.kpiSlate}`}>
            <div className={styles.kpiIcon}><PersonXIcon /></div>
            <div className={styles.kpiContent}>
              <div className={styles.kpiValue}>{kpiNotIn}</div>
              <div className={styles.kpiLabel}>Not Clocked In</div>
              {kpiNotIn > 0 && <div className={styles.kpiSub}>Requires review</div>}
            </div>
          </div>
          <div className={`${styles.kpiCard} ${kpiLate > 0 ? styles.kpiAmber : styles.kpiNeutral}`}>
            <div className={styles.kpiIcon}><ClockWarningIcon /></div>
            <div className={styles.kpiContent}>
              <div className={styles.kpiValue}>{kpiLate}</div>
              <div className={styles.kpiLabel}>Late</div>
              <div className={styles.kpiSub}>Today</div>
            </div>
          </div>
          <div className={`${styles.kpiCard} ${kpiActive > 0 ? styles.kpiRed : styles.kpiNeutral}`}>
            <div className={styles.kpiIcon}><MissingIcon /></div>
            <div className={styles.kpiContent}>
              <div className={styles.kpiValue}>{kpiActive}</div>
              <div className={styles.kpiLabel}>Missing Clock-Out</div>
              {kpiActive > 0 && <div className={styles.kpiSub}>Requires action</div>}
            </div>
          </div>
          <div className={`${styles.kpiCard} ${styles.kpiBlue}`}>
            <div className={styles.kpiIcon}><TeamIcon /></div>
            <div className={styles.kpiContent}>
              <div className={styles.kpiValue}>{activeMembers.length}</div>
              <div className={styles.kpiLabel}>Total Employees</div>
              <div className={styles.kpiSub}>Active employees</div>
            </div>
          </div>
        </div>
      )}

      {/* Date nav + view tabs */}
      <div className={styles.controlBar}>
        {view === 'roster' && (
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
        )}
        <div className={styles.viewTabs}>
          <button
            className={`${styles.viewTabBtn} ${view === 'roster' ? styles.viewTabBtnActive : ''}`}
            onClick={() => setView('roster')}
          >Today's Roster</button>
          <button
            className={`${styles.viewTabBtn} ${view === 'history' ? styles.viewTabBtnActive : ''}`}
            onClick={() => setView('history')}
          >History</button>
        </div>
      </div>

      {/* Roster filters */}
      {view === 'roster' && (
        <div className={styles.filterBarWrap}>
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
            <select
              className={styles.filterSelect}
              value={deptFilter}
              onChange={e => setDeptFilter(e.target.value)}
            >
              <option value="All">All Departments</option>
              {departmentOptions.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
            <select
              className={styles.filterSelect}
              value={locFilter}
              onChange={e => setLocFilter(e.target.value)}
            >
              <option value="All">Location Verification</option>
              <option value="Verified">Verified</option>
              <option value="Unverified">Unverified</option>
            </select>
            <button
              className={`${styles.moreFiltersBtn} ${moreFiltersOpen ? styles.moreFiltersBtnActive : ''}`}
              onClick={() => setMoreFiltersOpen(v => !v)}
            >
              <FilterIcon /> More Filters
            </button>
            {anyRosterFilter && (
              <button className={styles.clearBtn} onClick={clearRosterFilters}>Clear Filters</button>
            )}
          </div>
          {moreFiltersOpen && (
            <div className={styles.moreFiltersPanel}>
              <label className={styles.flaggedCheck}>
                <input
                  type="checkbox"
                  checked={onlyFlagged}
                  onChange={e => setOnlyFlagged(e.target.checked)}
                />
                Only show flagged (not clocked in / late / missing clock-out)
              </label>
            </div>
          )}
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
      {view === 'roster' && !loading && (kpiNotIn + kpiLate + kpiActive) > 0 && (
        <div className={styles.attentionPanel}>
          <div className={styles.attentionTitle}>
            <WarningIcon /> Attention Required
          </div>
          <div className={styles.attentionStats}>
            <div className={styles.attentionStat}>
              <PersonXIcon />
              <div>
                <div className={styles.attentionStatValue}>{kpiNotIn} employee{kpiNotIn !== 1 ? 's' : ''}</div>
                <div className={styles.attentionStatLabel}>Not clocked in yet</div>
              </div>
            </div>
            <div className={styles.attentionStat}>
              <ClockWarningIcon />
              <div>
                <div className={styles.attentionStatValue}>{kpiLate} employee{kpiLate !== 1 ? 's' : ''}</div>
                <div className={styles.attentionStatLabel}>Late today</div>
              </div>
            </div>
            <div className={styles.attentionStat}>
              <MissingIcon />
              <div>
                <div className={styles.attentionStatValue}>{kpiActive} employee{kpiActive !== 1 ? 's' : ''}</div>
                <div className={styles.attentionStatLabel}>Missing clock-out</div>
              </div>
            </div>
          </div>
          {attentionItems.length === 0 ? null : !attentionExpanded ? (
            <button className={styles.attentionToggle} onClick={() => setAttentionExpanded(true)}>
              View All ({attentionItems.length}) →
            </button>
          ) : (
            <>
              <div className={styles.attentionItems}>
                {attentionItems.map(({ member, row, status }) => (
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
              </div>
              <button className={styles.attentionToggle} onClick={() => setAttentionExpanded(false)}>
                Collapse
              </button>
            </>
          )}
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
                    <th>Worked Hours</th>
                    <th>Status</th>
                    <th>Location</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRoster.length === 0 ? (
                    <tr><td colSpan={7} className={styles.tdEmpty}>No employees match the current filter.</td></tr>
                  ) : pagedRoster.map(({ member, row, status }) => (
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
                            ? <div className={styles.notInStack}>
                                <span className={styles.notInText}>Not clocked in</span>
                                <span className={styles.overdueSub}>Overdue by {overdueSince(LATE_CUTOFF_HOUR)}</span>
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
                        <RowStatusBadge row={row} isOverdue={status === 'overdue'} />
                      </td>
                      <td>
                        <div className={styles.locCell}>
                          <LocPrimary row={row} sites={sites} />
                          {row && (row.clock_in_lat != null || row.clock_out_lat != null) && (
                            <VerifyBadge
                              status={locVerifyStatus(
                                row.clock_in_lat ?? row.clock_out_lat,
                                row.clock_in_lng ?? row.clock_out_lng,
                                sites
                              )}
                            />
                          )}
                        </div>
                      </td>
                      <td className={styles.actionsCell}>
                        {row ? (
                          <>
                            <button
                              className={styles.iconBtn}
                              title="View details"
                              onClick={() => setDrawerData({ member, row })}
                            ><EyeIcon /></button>
                            {hasPerm('attendance_admin_edit') && (
                              <button
                                className={styles.iconBtn}
                                title="Edit"
                                onClick={() => openModal(row.id)}
                              ><PencilIcon /></button>
                            )}
                          </>
                        ) : (
                          hasPerm('attendance_admin_add') && (
                            <button
                              className={styles.iconBtn}
                              title="Add entry"
                              onClick={() => openModal(null, member.id, rosterDate)}
                            ><PlusIcon /></button>
                          )
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile cards */}
          <div className={styles.mobileList}>
            {pagedRoster.map(({ member, row, status }) => (
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
            {pagedRoster.length === 0 && (
              <div className={styles.emptyState}>
                <div className={styles.emptyTitle}>No employees match the current filter.</div>
              </div>
            )}
          </div>

          {rosterRows.length > 0 && (
            <div className={styles.rosterPagination}>
              <div className={styles.rosterPageInfo}>
                Showing {rosterRangeStart} to {rosterRangeEnd} of {rosterRows.length} employee{rosterRows.length !== 1 ? 's' : ''}
              </div>
              <div className={styles.rosterPageControls}>
                <label className={styles.rowsPerPageLbl}>
                  Rows per page:
                  <select
                    className={styles.rowsPerPageSelect}
                    value={rosterPageSize}
                    onChange={e => setRosterPageSize(Number(e.target.value))}
                  >
                    <option value={10}>10</option>
                    <option value={20}>20</option>
                    <option value={50}>50</option>
                  </select>
                </label>
                <div className={styles.pageNumNav}>
                  <button
                    className={styles.pageNumBtn}
                    disabled={rosterPageSafe <= 1}
                    onClick={() => setRosterPage(p => Math.max(1, p - 1))}
                  >←</button>
                  {Array.from({ length: rosterPageCount }, (_, i) => i + 1)
                    .filter(n => n === 1 || n === rosterPageCount || Math.abs(n - rosterPageSafe) <= 1)
                    .reduce<number[]>((acc, n) => {
                      if (acc.length > 0 && n - acc[acc.length - 1] > 1) acc.push(-1);
                      acc.push(n);
                      return acc;
                    }, [])
                    .map((n, i) => n === -1 ? (
                      <span key={`gap-${i}`} className={styles.pageNumGap}>…</span>
                    ) : (
                      <button
                        key={n}
                        className={`${styles.pageNumBtn} ${n === rosterPageSafe ? styles.pageNumBtnActive : ''}`}
                        onClick={() => setRosterPage(n)}
                      >{n}</button>
                    ))}
                  <button
                    className={styles.pageNumBtn}
                    disabled={rosterPageSafe >= rosterPageCount}
                    onClick={() => setRosterPage(p => Math.min(rosterPageCount, p + 1))}
                  >→</button>
                </div>
              </div>
            </div>
          )}
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
                    <th>Worked Hours</th>
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

function TeamIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
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
