import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useTranslation } from 'react-i18next';
import styles from './MyAttendance.module.css';

const LATE_CUTOFF_HOUR = 9;

interface AttendanceRow {
  id: string;
  member_id: string;
  date: string;
  clock_in: string | null;
  clock_out: string | null;
  hours_worked: number | null;
  status: string | null;
  clock_in_lat?: number | null;
  clock_in_lng?: number | null;
  clock_out_lat?: number | null;
  clock_out_lng?: number | null;
}

function fmtDate(iso: string) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
  });
}

function fmtDateLong(iso: string) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

function fmtTime(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtHours(h: number | null): string {
  if (h == null || h === 0) return h === 0 ? '0h' : '—';
  const hrs = Math.floor(h);
  const mins = Math.round((h - hrs) * 60);
  if (hrs === 0) return `${mins}m`;
  if (mins === 0) return `${hrs}h`;
  return `${hrs}h ${mins}m`;
}

/** Rejects on failure — used to hard-gate clock-in/out on a successful GPS fix. */
function getGpsRequired(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('unavailable')); return; }
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      err => reject(err),
      { timeout: 8000, enableHighAccuracy: true },
    );
  });
}

function gpsErrorMessage(err: unknown): string {
  const code = (err as { code?: number } | null)?.code;
  if (code === 1) return 'Location permission denied. Please enable location access and try again.';
  if (code === 2) return 'Could not determine your location. Please check GPS/network and try again.';
  if (code === 3) return 'Location request timed out. Please try again.';
  return 'Could not verify your location. Please enable location services and try again.';
}

// ── Backgrounding resilience ────────────────────────────────────────────────
// If the phone/OS freezes or kills the tab right after Clock In/Out is tapped
// (e.g. the user immediately switches apps), the in-flight write can be
// abandoned silently — no error, no confirmation, and the user has no way to
// know whether it actually saved. We drop a small marker in localStorage the
// instant a write starts and clear it the instant the write settles; if the
// marker is still there next time attendance data loads, we know that attempt
// never completed and can tell the user to retry instead of leaving them
// guessing.
const PENDING_CLOCK_KEY = 'tac_pending_clock';

interface PendingClock {
  action: 'in' | 'out';
  memberId: string;
  date: string;
  startedAt: number;
}

function writePendingClock(p: PendingClock) {
  try { localStorage.setItem(PENDING_CLOCK_KEY, JSON.stringify(p)); } catch { /* storage unavailable — degrade silently */ }
}
function clearPendingClock() {
  try { localStorage.removeItem(PENDING_CLOCK_KEY); } catch { /* storage unavailable */ }
}
function readPendingClock(): PendingClock | null {
  try {
    const raw = localStorage.getItem(PENDING_CLOCK_KEY);
    return raw ? (JSON.parse(raw) as PendingClock) : null;
  } catch { return null; }
}

/** Checks a leftover pending marker against freshly-loaded rows. Returns
 *  whether that earlier attempt actually failed to save, or null if there's
 *  nothing to report (no marker, stale/unrelated marker, or still within the
 *  normal completion window so it may just be genuinely in flight). */
function checkPendingClock(memberId: string, today: string, freshRows: AttendanceRow[]): { action: 'in' | 'out'; failed: boolean } | null {
  const pending = readPendingClock();
  if (!pending || pending.memberId !== memberId) return null;
  if (pending.date !== today) { clearPendingClock(); return null; } // leftover from a previous day — irrelevant
  if (Date.now() - pending.startedAt < 15000) return null; // give a genuinely in-flight write a chance to finish
  const row = freshRows.find(r => r.date === pending.date);
  const succeeded = pending.action === 'in' ? !!row?.clock_in : !!row?.clock_out;
  clearPendingClock();
  return { action: pending.action, failed: !succeeded };
}

function useLiveElapsed(clockInIso: string | null, active: boolean): string {
  const [display, setDisplay] = useState('');
  useEffect(() => {
    if (!clockInIso || !active) { setDisplay(''); return; }
    const tick = () => {
      const ms = Date.now() - new Date(clockInIso).getTime();
      if (ms < 0) { setDisplay('00:00:00'); return; }
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      setDisplay(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [clockInIso, active]);
  return display;
}

export default function MyAttendance() {
  const { currentUser, hasPerm } = useAuth();
  const { t } = useTranslation();
  const [memberId, setMemberId] = useState<string | null>(null);
  const [rows, setRows] = useState<AttendanceRow[]>([]);
  const [monthFilter, setMonthFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [clocking, setClocking] = useState(false);
  const [gpsPhase, setGpsPhase] = useState<'idle' | 'locating' | 'saving'>('idle');
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [detailRow, setDetailRow] = useState<AttendanceRow | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  useEffect(() => {
    if (!currentUser) return;
    async function resolve() {
      const { data } = await supabase
        .from('team_members')
        .select('id, full_name, username')
        .order('full_name');
      if (!data) { setLoading(false); return; }
      const name = (currentUser?.full_name || '').trim().toLowerCase();
      const uname = (currentUser?.username || '').trim().toLowerCase();
      const match = data.find((m: { id: string; full_name?: string; username?: string }) =>
        (name && m.full_name?.trim().toLowerCase() === name) ||
        (uname && m.username?.trim().toLowerCase() === uname),
      );
      setMemberId(match?.id ?? null);
    }
    resolve();
  }, [currentUser]);

  useEffect(() => {
    if (!memberId) { setLoading(false); return; }
    loadAttendance();
  }, [memberId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadAttendance() {
    if (!memberId) return;
    setLoading(true);
    const { data } = await supabase
      .from('attendance')
      .select('*')
      .eq('member_id', memberId)
      .order('date', { ascending: false })
      .limit(60);
    setRows(data || []);
    setLoading(false);
    const _now = new Date();
    const _today = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;
    const pendingResult = checkPendingClock(memberId, _today, data || []);
    if (pendingResult?.failed) {
      showToast(
        pendingResult.action === 'in'
          ? 'Your last clock-in may not have saved (app was interrupted). Please try again.'
          : 'Your last clock-out may not have saved (app was interrupted). Please try again.',
        false,
      );
    }
  }

  const _d = new Date();
  const today = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`;
  const todayRow = rows.find(r => r.date === today);

  const isActive = !!(todayRow?.clock_in && !todayRow?.clock_out);
  const isDone = !!(todayRow?.clock_in && todayRow?.clock_out);
  const liveElapsed = useLiveElapsed(todayRow?.clock_in ?? null, isActive);

  async function clockIn() {
    if (!memberId) { showToast('Could not find your team member record.', false); return; }
    setClocking(true);
    setGpsPhase('locating');
    let gps: { lat: number; lng: number };
    try {
      gps = await getGpsRequired();
    } catch (err) {
      setGpsPhase('idle');
      setClocking(false);
      showToast(gpsErrorMessage(err), false);
      return;
    }
    setGpsPhase('saving');
    const now = new Date().toISOString();
    const status = new Date().getHours() >= LATE_CUTOFF_HOUR ? 'Late' : 'Present';
    const payload: Record<string, unknown> = {
      member_id: memberId, date: today, clock_in: now, status,
      clock_in_lat: gps.lat, clock_in_lng: gps.lng,
    };
    writePendingClock({ action: 'in', memberId, date: today, startedAt: Date.now() });
    const { error } = await supabase
      .from('attendance')
      .upsert(payload, { onConflict: 'member_id,date' });
    clearPendingClock();
    setGpsPhase('idle');
    setClocking(false);
    if (error) { showToast(error.message, false); return; }
    showToast(`Clocked in successfully at ${fmtTime(now)}`, true);
    await loadAttendance();
  }

  async function clockOut() {
    if (!memberId || !todayRow?.id || !todayRow.clock_in) return;
    setClocking(true);
    setGpsPhase('locating');
    let gps: { lat: number; lng: number };
    try {
      gps = await getGpsRequired();
    } catch (err) {
      setGpsPhase('idle');
      setClocking(false);
      showToast(gpsErrorMessage(err), false);
      return;
    }
    setGpsPhase('saving');
    const now = new Date().toISOString();
    const hours = Math.round((+new Date(now) - +new Date(todayRow.clock_in)) / 3600000 * 100) / 100;
    const payload: Record<string, unknown> = {
      clock_out: now, hours_worked: hours,
      clock_out_lat: gps.lat, clock_out_lng: gps.lng,
    };
    writePendingClock({ action: 'out', memberId, date: today, startedAt: Date.now() });
    const { error } = await supabase.from('attendance').update(payload).eq('id', todayRow.id);
    clearPendingClock();
    setGpsPhase('idle');
    setClocking(false);
    if (error) { showToast(error.message, false); return; }
    showToast(`Clocked out at ${fmtTime(now)} · ${fmtHours(hours)} worked`, true);
    await loadAttendance();
  }

  function handleClockAction() {
    if (!todayRow?.clock_in) return clockIn();
    if (isActive) return clockOut();
  }

  function getClockBtnLabel() {
    if (gpsPhase === 'locating') return t('att_verifyingLoc');
    if (gpsPhase === 'saving') return isActive ? t('att_clockingOut') : t('att_clockingIn');
    if (!todayRow?.clock_in) return t('att_clockIn');
    if (isActive) return t('att_clockOut');
    return t('att_clockIn');
  }

  // Filters
  const months = [...new Set(rows.map(r => r.date?.slice(0, 7)).filter(Boolean))].sort().reverse();
  const allStatuses = [...new Set(rows.map(r => r.status).filter(Boolean) as string[])].sort();
  let filtered = monthFilter ? rows.filter(r => r.date?.startsWith(monthFilter)) : rows;
  if (statusFilter) filtered = filtered.filter(r => r.status === statusFilter);

  // Monthly summary (always current calendar month)
  const currentMonth = today.slice(0, 7);
  const monthRows = rows.filter(r => r.date?.startsWith(currentMonth));
  const presentDays = monthRows.filter(r => ['Present', 'Late'].includes(r.status ?? '')).length;
  const lateArrivals = monthRows.filter(r => r.status === 'Late').length;
  const totalHours = monthRows.reduce((a, r) => a + (r.hours_worked ?? 0), 0);
  const missingClockOut = monthRows.filter(r => r.clock_in && !r.clock_out && r.date !== today).length;
  const daysElapsed = _d.getDate();
  const attendanceRate = daysElapsed > 0 ? Math.round((presentDays / daysElapsed) * 100) : 0;

  // Today status pill
  function getTodayStatus(): { label: string; variant: 'active' | 'done' | 'late' | 'idle' } {
    if (!todayRow?.clock_in) return { label: 'Not Clocked In', variant: 'idle' };
    if (isActive) return { label: 'Active', variant: 'active' };
    if (todayRow.status === 'Late') return { label: 'Late', variant: 'late' };
    return { label: todayRow.status ?? 'Present', variant: 'done' };
  }

  // Average clock-in time this month
  const clockInTimesMs = monthRows
    .filter(r => r.clock_in)
    .map(r => {
      const d = new Date(r.clock_in!);
      return d.getHours() * 3600000 + d.getMinutes() * 60000;
    });
  const avgClockInDisplay = (() => {
    if (!clockInTimesMs.length) return null;
    const avg = clockInTimesMs.reduce((a, b) => a + b, 0) / clockInTimesMs.length;
    const h = Math.floor(avg / 3600000);
    const m = Math.floor((avg % 3600000) / 60000);
    const d = new Date(); d.setHours(h, m, 0, 0);
    return fmtTime(d.toISOString());
  })();

  // Export CSV
  function exportCSV() {
    const header = 'Date,Clock In,Clock Out,Hours Worked,Status\n';
    const body = filtered.map(r =>
      `${r.date},${fmtTime(r.clock_in)},${fmtTime(r.clock_out)},${r.hours_worked ?? ''},${r.status ?? ''}`
    ).join('\n');
    const blob = new Blob([header + body], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `attendance-${currentMonth}.csv`;
    a.click();
  }

  function statusBadge(s: string | null) {
    const map: Record<string, [string, string]> = {
      Present:    [styles.badgePresent,  '✓'],
      Late:       [styles.badgeLate,     '⏱'],
      Absent:     [styles.badgeAbsent,   '✕'],
      'On Leave': [styles.badgeLeave,    '◉'],
      'Half-day': [styles.badgeHalfDay,  '◑'],
    };
    const [cls, icon] = map[s || ''] ?? [styles.badgePending, '·'];
    return (
      <span className={`${styles.badge} ${cls}`}>
        <span className={styles.badgeIcon}>{icon}</span>
        {s || 'Pending'}
      </span>
    );
  }

  if (!hasPerm('view_my_attendance')) {
    return (
      <div className={styles.page}>
        <p style={{ color: 'var(--text-muted)', marginTop: 40 }}>You do not have permission to view this page.</p>
      </div>
    );
  }

  const todayStatus = getTodayStatus();
  const todayHasGps = !!(todayRow?.clock_in_lat);

  return (
    <div className={styles.page}>
      {toast && (
        <div className={`${styles.toast} ${toast.ok ? styles.toastOk : styles.toastErr}`} role="status" aria-live="polite">
          {toast.msg}
        </div>
      )}


      {/* ── Today's Attendance Card ── */}
      {loading ? (
        <div className={styles.todayCardSkel} />
      ) : (
        <div className={styles.todayCard}>
          <div className={styles.todayTopRow}>
            <div className={styles.todayStatusGroup}>
              <span className={`${styles.todayPill} ${styles[`todayPill_${todayStatus.variant}`]}`}>
                {todayStatus.variant === 'active' && <span className={styles.pulseDot} aria-hidden="true" />}
                {todayStatus.label}
              </span>
              <span className={styles.todayDateStr}>{fmtDateLong(today)}</span>
            </div>
          </div>

          <div className={styles.todayMain}>
            {/* Clock times */}
            <div className={styles.todayTimesRow}>
              <div className={styles.todayTimeBlock}>
                <span className={styles.todayTimeLabel}>{t('att_clockIn')}</span>
                <span className={styles.todayTimeBig}>{fmtTime(todayRow?.clock_in ?? null)}</span>
              </div>
              {isActive && liveElapsed ? (
                <div className={styles.todayTimeBlock}>
                  <span className={styles.todayTimeLabel}>{t('att_totalHours')}</span>
                  <span className={`${styles.todayTimeBig} ${styles.liveTimer}`} aria-label={`Worked today: ${liveElapsed}`}>
                    {liveElapsed}
                  </span>
                </div>
              ) : isDone ? (
                <div className={styles.todayTimeBlock}>
                  <span className={styles.todayTimeLabel}>{t('att_totalHours')}</span>
                  <span className={styles.todayTimeBig}>{fmtHours(todayRow?.hours_worked ?? null)}</span>
                </div>
              ) : null}
              <div className={styles.todayTimeBlock}>
                <span className={styles.todayTimeLabel}>{t('att_clockOut')}</span>
                <span className={styles.todayTimeBig}>{fmtTime(todayRow?.clock_out ?? null)}</span>
              </div>
            </div>

            {/* Location */}
            <div className={styles.todayMeta}>
              {todayRow ? (
                <div className={styles.todayMetaItem}>
                  <IcLocation />
                  <span className={styles.todayMetaText}>
                    {todayHasGps
                      ? <><span className={styles.gpsOk}>GPS recorded</span> · verified</>
                      : 'Location not recorded'}
                  </span>
                </div>
              ) : (
                <div className={styles.todayMetaItem}>
                  <IcLocation />
                  <span className={styles.todayMetaText} style={{ color: 'var(--text-muted)' }}>
                    Location will be recorded on clock-in
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Primary action */}
          {!isDone && (
            <div className={styles.todayAction}>
              {gpsPhase !== 'idle' && (
                <p className={styles.todayActionStatus} aria-live="polite">
                  <IcSpinner />
                  {gpsPhase === 'locating' ? t('att_verifyingLoc') : isActive ? t('att_clockingOut') : t('att_clockingIn')}
                </p>
              )}
              <button
                className={`${styles.todayClockBtn} ${!todayRow?.clock_in ? styles.todayClockIn : styles.todayClockOut}`}
                onClick={handleClockAction}
                disabled={clocking}
                aria-label={getClockBtnLabel()}
              >
                {!todayRow?.clock_in ? <IcClockIn /> : <IcClockOut />}
                {!todayRow?.clock_in ? t('att_clockIn') : t('att_clockOut')}
              </button>
            </div>
          )}
          {isDone && (
            <div className={styles.todayDoneBar}>
              <IcCheck />
              Done for today · {fmtHours(todayRow?.hours_worked ?? null)} worked
            </div>
          )}
        </div>
      )}

      {/* ── Monthly Summary Cards ── */}
      <div className={styles.summaryGrid}>
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <div key={i} className={styles.summaryCardSkel} />)
        ) : (
          <>
            <div className={styles.summaryCard}>
              <div className={styles.summaryIconWrap} style={{ background: '#dcfce7' }}>
                <IcCheckCircle color="#15803d" />
              </div>
              <div className={styles.summaryBody}>
                <span className={styles.summaryLabel}>{t('att_presentDays')}</span>
                <span className={`${styles.summaryVal} ${styles.summaryGreen}`}>{presentDays}</span>
                <span className={styles.summarySub}>{t('att_thisMonth')}</span>
              </div>
            </div>
            <div className={styles.summaryCard}>
              <div className={styles.summaryIconWrap} style={{ background: '#fef3c7' }}>
                <IcClockCircle color="#d97706" />
              </div>
              <div className={styles.summaryBody}>
                <span className={styles.summaryLabel}>{t('att_lateArrivals')}</span>
                <span className={`${styles.summaryVal} ${styles.summaryAmber}`}>{lateArrivals}</span>
                <span className={styles.summarySub}>{t('att_thisMonth')}</span>
              </div>
            </div>
            <div className={styles.summaryCard}>
              <div className={styles.summaryIconWrap} style={{ background: '#dbeafe' }}>
                <IcHoursCircle color="#2563eb" />
              </div>
              <div className={styles.summaryBody}>
                <span className={styles.summaryLabel}>{t('att_totalHours')}</span>
                <span className={`${styles.summaryVal} ${styles.summaryBlue} ${styles.summaryValSm}`}>
                  {fmtHours(totalHours) || '0h'}
                </span>
                <span className={styles.summarySub}>{t('att_thisMonth')}</span>
              </div>
            </div>
            <div className={styles.summaryCard}>
              <div className={styles.summaryIconWrap} style={{ background: '#ccfbf1' }}>
                <IcRateCircle color="#0f766e" />
              </div>
              <div className={styles.summaryBody}>
                <span className={styles.summaryLabel}>{t('att_attendanceRate')}</span>
                <span className={`${styles.summaryVal} ${styles.summaryTeal}`}>{attendanceRate}%</span>
                <span className={styles.summarySub}>{t('att_ofDaysPresent')}</span>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Filter Toolbar ── */}
      <div className={styles.filterToolbar}>
        <div className={styles.filterLeft}>
          <select className={styles.filterSelect} value={monthFilter} onChange={e => setMonthFilter(e.target.value)}>
            <option value="">All months</option>
            {months.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <select className={styles.filterSelect} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="">All Statuses</option>
            {allStatuses.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          {(monthFilter || statusFilter) && (
            <button className={styles.clearFiltersBtn} onClick={() => { setMonthFilter(''); setStatusFilter(''); }}>
              <IcX /> {t('att_clearFilters')}
            </button>
          )}
        </div>
        <div className={styles.filterRight}>
          <span className={styles.recordCount}>{filtered.length} attendance record{filtered.length !== 1 ? 's' : ''}</span>
          <button className={styles.exportBtn} onClick={exportCSV} aria-label="Export as CSV">
            <IcExport /> {t('att_export')}
          </button>
        </div>
      </div>

      {/* ── Attendance History Card ── */}
      <div className={styles.historyCard}>
        <div className={styles.historyHdr}>
          <div className={styles.historyHdrTitle}>{t('att_history')}</div>
          <div className={styles.historyHdrSub}>{t('att_historySub')}</div>
        </div>

        {/* Desktop table */}
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t('att_date')}</th>
                <th>{t('att_clockInCol')}</th>
                <th>{t('att_clockOutCol')}</th>
                <th className={styles.thRight}>{t('att_hours')}</th>
                <th>{t('att_location')}</th>
                <th>{t('att_statusCol')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {loading
                ? Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i} className={styles.skelRow}>
                      {Array.from({ length: 7 }).map((_, j) => (
                        <td key={j}><div className={styles.skelCell} style={{ width: j === 6 ? 28 : '70%' }} /></td>
                      ))}
                    </tr>
                  ))
                : filtered.length === 0
                ? (
                  <tr><td colSpan={7}><EmptyState monthFilter={monthFilter} onClockIn={todayRow ? undefined : clockIn} /></td></tr>
                )
                : filtered.map(r => (
                  <tr key={r.id} className={styles.tableRow} onClick={() => setDetailRow(r)}>
                    <td className={styles.dateCell}>{fmtDate(r.date)}</td>
                    <td className={styles.timeCell}>{fmtTime(r.clock_in)}</td>
                    <td className={styles.timeCell}>{fmtTime(r.clock_out)}</td>
                    <td className={`${styles.timeCell} ${styles.tdRight}`}>{fmtHours(r.hours_worked)}</td>
                    <td>
                      {r.clock_in_lat != null
                        ? <span className={styles.gpsTag}><IcGps /> GPS</span>
                        : <span className={styles.noGps}>—</span>}
                    </td>
                    <td>{statusBadge(r.status)}</td>
                    <td className={styles.tdActions} onClick={e => e.stopPropagation()}>
                      <button className={styles.rowViewBtn} onClick={() => setDetailRow(r)} aria-label="View attendance details">
                        <IcEye />
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        {/* Mobile cards */}
        <div className={styles.mobileCards}>
          {loading
            ? Array.from({ length: 3 }).map((_, i) => <div key={i} className={styles.mobileSkelCard} />)
            : filtered.length === 0
            ? <EmptyState monthFilter={monthFilter} onClockIn={todayRow ? undefined : clockIn} />
            : filtered.map(r => (
              <div key={r.id} className={styles.mobileCard} onClick={() => setDetailRow(r)}>
                <div className={styles.mobileCardTop}>
                  <span className={styles.mobileCardDate}>{fmtDate(r.date)}</span>
                  {statusBadge(r.status)}
                </div>
                <div className={styles.mobileCardRow}>
                  <span className={styles.mobileLabel}>Clock In</span>
                  <span className={styles.mobileVal}>{fmtTime(r.clock_in)}</span>
                </div>
                <div className={styles.mobileCardRow}>
                  <span className={styles.mobileLabel}>Clock Out</span>
                  <span className={styles.mobileVal}>{fmtTime(r.clock_out)}</span>
                </div>
                <div className={styles.mobileCardRow}>
                  <span className={styles.mobileLabel}>Hours</span>
                  <span className={styles.mobileVal}>{fmtHours(r.hours_worked)}</span>
                </div>
                <button className={styles.mobileViewBtn} onClick={() => setDetailRow(r)}>View Details</button>
              </div>
            ))}
        </div>
      </div>

      {/* ── Attendance Insights ── */}
      {!loading && rows.length > 0 && (
        <div className={styles.insightsCard}>
          <div className={styles.insightsTitle}>Attendance Insights</div>
          <div className={styles.insightsList}>
            {missingClockOut > 0 && (
              <div className={`${styles.insightItem} ${styles.insightRed}`}>
                <IcAlert />
                <span><strong>{missingClockOut}</strong> missing clock-out{missingClockOut !== 1 ? 's' : ''} — requires attention</span>
              </div>
            )}
            {lateArrivals > 0 && (
              <div className={`${styles.insightItem} ${styles.insightAmberItem}`}>
                <IcClockSm />
                <span><strong>{lateArrivals}</strong> late arrival{lateArrivals !== 1 ? 's' : ''} this month</span>
              </div>
            )}
            {avgClockInDisplay && (
              <div className={`${styles.insightItem} ${styles.insightBlueItem}`}>
                <IcClockSm />
                <span>Average clock-in: <strong>{avgClockInDisplay}</strong></span>
              </div>
            )}
            {missingClockOut === 0 && lateArrivals === 0 && (
              <div className={`${styles.insightItem} ${styles.insightGreenItem}`}>
                <IcCheck />
                <span>Your attendance is up to date.</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Detail Drawer ── */}
      {detailRow && (
        <>
          <div className={styles.drawerOverlay} onClick={() => setDetailRow(null)} />
          <div className={styles.drawer} role="dialog" aria-modal="true" aria-label="Attendance record details">
            <div className={styles.drawerHdr}>
              <div className={styles.drawerHdrLeft}>
                <div className={styles.drawerDate}>{fmtDateLong(detailRow.date)}</div>
                {statusBadge(detailRow.status)}
              </div>
              <button className={styles.drawerCloseBtn} onClick={() => setDetailRow(null)} aria-label="Close details">
                <IcXLg />
              </button>
            </div>
            <div className={styles.drawerBody}>
              <div className={styles.drawerSection}>
                <div className={styles.drawerSectionTitle}>Time</div>
                <div className={styles.drawerGrid}>
                  <div className={styles.drawerField}>
                    <span className={styles.drawerFieldLabel}>Clock In</span>
                    <span className={styles.drawerFieldVal}>{fmtTime(detailRow.clock_in)}</span>
                  </div>
                  <div className={styles.drawerField}>
                    <span className={styles.drawerFieldLabel}>Clock Out</span>
                    <span className={styles.drawerFieldVal}>{fmtTime(detailRow.clock_out)}</span>
                  </div>
                  <div className={styles.drawerField}>
                    <span className={styles.drawerFieldLabel}>Hours Worked</span>
                    <span className={styles.drawerFieldVal}>{fmtHours(detailRow.hours_worked)}</span>
                  </div>
                  <div className={styles.drawerField}>
                    <span className={styles.drawerFieldLabel}>Status</span>
                    <span className={styles.drawerFieldVal}>{detailRow.status ?? '—'}</span>
                  </div>
                </div>
              </div>
              <div className={styles.drawerSection}>
                <div className={styles.drawerSectionTitle}>Location Verification</div>
                <div className={styles.drawerGrid}>
                  <div className={styles.drawerField}>
                    <span className={styles.drawerFieldLabel}>Clock-in GPS</span>
                    <span className={styles.drawerFieldVal}>
                      {detailRow.clock_in_lat != null
                        ? <span className={styles.gpsOk}><IcCheck /> Verified</span>
                        : 'Not recorded'}
                    </span>
                  </div>
                  <div className={styles.drawerField}>
                    <span className={styles.drawerFieldLabel}>Clock-out GPS</span>
                    <span className={styles.drawerFieldVal}>
                      {detailRow.clock_out_lat != null
                        ? <span className={styles.gpsOk}><IcCheck /> Verified</span>
                        : 'Not recorded'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
            <div className={styles.drawerFooter}>
              <button className={styles.drawerClosePillBtn} onClick={() => setDetailRow(null)}>Close</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ── Empty state ── */
function EmptyState({ monthFilter, onClockIn }: { monthFilter: string; onClockIn?: () => void }) {
  return (
    <div className={styles.emptyState}>
      <div className={styles.emptyIcon}><IcCalendar /></div>
      <div className={styles.emptyTitle}>
        {monthFilter ? 'No records for this month' : 'No attendance records yet'}
      </div>
      <div className={styles.emptyDesc}>
        {monthFilter
          ? 'No attendance entries found for the selected month.'
          : 'Your attendance entries will appear here after you clock in.'}
      </div>
      {!monthFilter && onClockIn && (
        <button className={styles.emptyClockBtn} onClick={onClockIn}>
          <IcClockIn /> Clock In Now
        </button>
      )}
    </div>
  );
}

/* ── Icon components ── */
function IcClockIn() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
}
function IcClockOut() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>;
}
function IcCheck() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>;
}
function IcLocation() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>;
}
function IcSpinner() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ animation: 'spin 0.8s linear infinite' }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>;
}
function IcExport() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>;
}
function IcX() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>;
}
function IcXLg() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>;
}
function IcEye() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>;
}
function IcGps() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>;
}
function IcAlert() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m10.29 3.86-8.34 14.42A2 2 0 0 0 3.66 21H20.34a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>;
}
function IcClockSm() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
}
function IcCalendar() {
  return <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>;
}
function IcCheckCircle({ color }: { color: string }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>;
}
function IcClockCircle({ color }: { color: string }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
}
function IcHoursCircle({ color }: { color: string }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>;
}
function IcRateCircle({ color }: { color: string }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>;
}
