import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { cacheOk, getAllSites, ensureFullLoad } from '../lib/sitesCache';
import type { CachedSite } from '../lib/sitesCache';
import { nearestSiteWithin } from '../lib/sitesNearest';
import styles from './AttendanceAdmin.module.css';

// ── Constants ─────────────────────────────────────────────────────────────────

const LATE_CUTOFF_HOUR = 9;
const NEAREST_SITE_KM = 0.5;
const STATUS_OPTIONS = ['Present', 'Late', 'Absent', 'On Leave', 'Half-day'] as const;
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

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
}

interface Member {
  id: string;
  full_name: string;
  role: string | null;
  is_active: boolean;
}

type AdminView = 'roster' | 'history';

interface Filters {
  member: string;
  monthYear: string; // '' | 'YYYY-MM'
  search: string;
}

interface ModalForm {
  member_id: string;
  date: string;
  clock_in: string;  // HH:MM
  clock_out: string; // HH:MM
  status: string;
  notes: string;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

function localDateStr(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayIso(): string {
  return localDateStr();
}

function fmtDateLong(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
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

function LocCell({
  lat, lng, label, sites,
}: {
  lat: number | null;
  lng: number | null;
  label: string;
  sites: CachedSite[];
}) {
  if (lat == null || lng == null) {
    return <span className={styles.notShared}>Not shared</span>;
  }
  const near = nearestSiteWithin(sites, lat, lng, NEAREST_SITE_KM);
  const nearText = near
    ? `≈ ${near.row.site_code || near.row.site_name || 'site'} (${near.km < 1 ? Math.round(near.km * 1000) + 'm' : near.km.toFixed(1) + 'km'})`
    : null;
  return (
    <div>
      <a
        className={styles.locLink}
        href={`https://www.google.com/maps?q=${lat},${lng}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        <MapPinIcon /> {label}
      </a>
      {nearText && <div className={styles.locSub}>{nearText}</div>}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AttendanceAdmin() {
  const { currentUser } = useAuth();
  const isAdmin = currentUser?.role === 'admin';

  const [attendance, setAttendance] = useState<AttRow[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [sites, setSites] = useState<CachedSite[]>([]);

  const [view, setView] = useState<AdminView>('roster');
  const [rosterDate, setRosterDate] = useState(todayIso());
  const [filters, setFilters] = useState<Filters>({ member: '', monthYear: '', search: '' });

  const [modalOpen, setModalOpen] = useState(false);
  const [modalEditId, setModalEditId] = useState<string | null>(null);
  const [modalForm, setModalForm] = useState<ModalForm>({
    member_id: '', date: todayIso(), clock_in: '', clock_out: '', status: 'Present', notes: '',
  });
  const [modalErr, setModalErr] = useState('');
  const [saving, setSaving] = useState(false);

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
        date: r.date,
        clock_in: toTimeValue(r.clock_in),
        clock_out: toTimeValue(r.clock_out),
        status: r.status ?? 'Present',
        notes: r.notes ?? '',
      });
    } else {
      setModalForm({
        member_id: prefillMemberId ?? '',
        date: prefillDate ?? todayIso(),
        clock_in: '',
        clock_out: '',
        status: 'Present',
        notes: '',
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
    setModalOpen(false);
    await loadAll();
  }

  // ── Permission gate ───────────────────────────────────────────────────────

  if (!isAdmin) {
    return (
      <div className={styles.page}>
        <div className={styles.denied}>You don't have permission to view this page.</div>
      </div>
    );
  }

  // ── Derived data ──────────────────────────────────────────────────────────

  const activeMembers = members.filter(m => m.is_active !== false);
  const today = todayIso();
  const isToday = rosterDate === today;
  const nowHour = new Date().getHours();
  const overdueCutoff = isToday && nowHour >= LATE_CUTOFF_HOUR;

  const dayRows = attendance.filter(r => r.date === rosterDate);
  const rosterSearch = filters.search.toLowerCase();
  const rosterRows = activeMembers
    .filter(m => !rosterSearch || (m.full_name || '').toLowerCase().includes(rosterSearch))
    .map(m => {
      const row = dayRows.find(x => x.member_id === m.id) ?? null;
      return { member: m, row, isOverdue: overdueCutoff && !row?.clock_in };
    });

  const presentCount = rosterRows.filter(r => r.row?.clock_in).length;
  const notInCount = rosterRows.length - presentCount;

  const filteredHistory = attendance.filter(r => {
    const mn = (members.find(t => t.id === r.member_id)?.full_name ?? '').toLowerCase();
    if (filters.member && mn !== filters.member.toLowerCase()) return false;
    if (filters.monthYear) {
      const [ys, ms] = filters.monthYear.split('-');
      const d = new Date(r.date + 'T00:00:00');
      if (isNaN(d.getTime()) || d.getMonth() + 1 !== +ms || d.getFullYear() !== +ys) return false;
    }
    if (filters.search) {
      const q = filters.search.toLowerCase();
      if (!mn.includes(q) && !(r.date || '').includes(q) && !(r.notes || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const memberNames = [...new Set(
    attendance.map(r => members.find(t => t.id === r.member_id)?.full_name).filter(Boolean) as string[]
  )].sort();

  const histYears = [...new Set(
    attendance.map(r => r.date ? new Date(r.date + 'T00:00:00').getFullYear() : null).filter(Boolean) as number[]
  )].sort((a, b) => b - a);
  if (!histYears.includes(new Date().getFullYear())) histYears.unshift(new Date().getFullYear());

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
              ? `${presentCount} clocked in · ${notInCount} not clocked in`
              : `${filteredHistory.length} record${filteredHistory.length !== 1 ? 's' : ''}`}
          </div>
        </div>
        <div className={styles.headerRight}>
          <div className={styles.tabBar}>
            <button
              className={`${styles.tabBtn} ${view === 'roster' ? styles.tabBtnActive : styles.tabBtnInactive}`}
              onClick={() => setView('roster')}
            >
              <CalendarIcon /> Today's Roster
            </button>
            <button
              className={`${styles.tabBtn} ${view === 'history' ? styles.tabBtnActive : styles.tabBtnInactive}`}
              onClick={() => setView('history')}
            >
              <HistoryIcon /> History
            </button>
          </div>
          <button className={styles.addBtn} onClick={() => openModal(null)}>+ Manual Entry</button>
        </div>
      </div>

      {/* Roster controls */}
      {view === 'roster' && (
        <div className={styles.rosterControls}>
          <div className={styles.dateNav}>
            <button className={styles.dateNavBtn} onClick={() => setRosterDate(d => offsetDate(d, -1))}>◀</button>
            <span className={styles.dateLabel}>{fmtDateLong(rosterDate)}</span>
            <button className={styles.dateNavBtn} onClick={() => setRosterDate(d => offsetDate(d, 1))}>▶</button>
            {rosterDate !== today && (
              <button className={styles.todayBtn} onClick={() => setRosterDate(today)}>Today</button>
            )}
          </div>
          <input
            className={styles.searchInput}
            type="text"
            placeholder="Search name…"
            value={filters.search}
            onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
          />
        </div>
      )}

      {/* History filters */}
      {view === 'history' && (
        <div className={styles.historyFilters}>
          <select
            className={styles.filterSelect}
            value={filters.member}
            onChange={e => setFilters(f => ({ ...f, member: e.target.value }))}
          >
            <option value="">All employees</option>
            {memberNames.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
          <select
            className={styles.filterSelect}
            value={filters.monthYear}
            onChange={e => setFilters(f => ({ ...f, monthYear: e.target.value }))}
          >
            <option value="">All months</option>
            {histYears.flatMap(y =>
              Array.from({ length: 12 }, (_, i) => i + 1).map(m => {
                const val = `${y}-${String(m).padStart(2, '0')}`;
                return <option key={val} value={val}>{MONTHS[m - 1]} {y}</option>;
              })
            )}
          </select>
          <input
            className={styles.searchInput}
            type="text"
            placeholder="Search name…"
            value={filters.search}
            onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
          />
        </div>
      )}

      {/* Tables */}
      {loading ? (
        <div className={styles.empty}>Loading…</div>
      ) : view === 'roster' ? (
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
                <tr><td colSpan={7} className={styles.tdEmpty}>No active employees found.</td></tr>
              ) : rosterRows.map(({ member, row, isOverdue }) => (
                <tr key={member.id} className={isOverdue ? styles.overdueRow : undefined}>
                  <td className={styles.nameCell}>{member.full_name}</td>
                  <td>
                    {row?.clock_in
                      ? <span className={styles.timeVal}>{fmtTime(row.clock_in)}</span>
                      : isOverdue
                        ? <span className={styles.overdueCell}>
                            <span className={styles.overdueText}>Not clocked in</span>
                            <span className={styles.overdueBadge}>Overdue</span>
                          </span>
                        : <span className={styles.dimVal}>Not clocked in</span>}
                  </td>
                  <td>
                    {row?.clock_out
                      ? <span className={styles.timeVal}>{fmtTime(row.clock_out)}</span>
                      : <span className={styles.dimVal}>—</span>}
                  </td>
                  <td>{row?.hours_worked != null ? row.hours_worked : <span className={styles.dimVal}>—</span>}</td>
                  <td>{row?.status ? <StatusBadge s={row.status} /> : <span className={styles.dimVal}>—</span>}</td>
                  <td>
                    {row ? (
                      <div className={styles.locStack}>
                        <LocCell lat={row.clock_in_lat ?? null} lng={row.clock_in_lng ?? null} label="In" sites={sites} />
                        <LocCell lat={row.clock_out_lat ?? null} lng={row.clock_out_lng ?? null} label="Out" sites={sites} />
                      </div>
                    ) : <span className={styles.dimVal}>—</span>}
                  </td>
                  <td>
                    {row
                      ? <button className={styles.rowBtn} onClick={() => openModal(row.id)}>Edit</button>
                      : <button className={`${styles.rowBtn} ${styles.rowBtnAdd}`} onClick={() => openModal(null, member.id, rosterDate)}>Add</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
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
              {filteredHistory.length === 0 ? (
                <tr><td colSpan={8} className={styles.tdEmpty}>No attendance records match the current filters.</td></tr>
              ) : filteredHistory.map(r => {
                const empName = members.find(t => t.id === r.member_id)?.full_name ?? '—';
                return (
                  <tr key={r.id}>
                    <td className={styles.nameCell}>{empName}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDateShort(r.date)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtTime(r.clock_in)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtTime(r.clock_out)}</td>
                    <td>{r.hours_worked != null ? r.hours_worked : <span className={styles.dimVal}>—</span>}</td>
                    <td><StatusBadge s={r.status} /></td>
                    <td>
                      <div className={styles.locStack}>
                        <LocCell lat={r.clock_in_lat ?? null} lng={r.clock_in_lng ?? null} label="In" sites={sites} />
                        <LocCell lat={r.clock_out_lat ?? null} lng={r.clock_out_lng ?? null} label="Out" sites={sites} />
                      </div>
                    </td>
                    <td>
                      <button className={styles.rowBtn} onClick={() => openModal(r.id)}>Edit</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Edit / Add modal */}
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
                <label>Employee *</label>
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
                <label>Date *</label>
                <input
                  type="date"
                  value={modalForm.date}
                  onChange={e => setModalForm(f => ({ ...f, date: e.target.value }))}
                />
              </div>
              <div className={styles.modalField}>
                <label>Clock In (local time)</label>
                <input
                  type="time"
                  value={modalForm.clock_in}
                  onChange={e => setModalForm(f => ({ ...f, clock_in: e.target.value }))}
                />
              </div>
              <div className={styles.modalField}>
                <label>Clock Out (local time)</label>
                <input
                  type="time"
                  value={modalForm.clock_out}
                  onChange={e => setModalForm(f => ({ ...f, clock_out: e.target.value }))}
                />
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
