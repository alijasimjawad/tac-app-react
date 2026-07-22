import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
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
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function fmtTime(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getGps(): Promise<{ lat: number; lng: number } | null> {
  return new Promise(resolve => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { timeout: 8000 },
    );
  });
}

export default function MyAttendance() {
  const { currentUser } = useAuth();
  const [memberId, setMemberId] = useState<string | null>(null);
  const [rows, setRows] = useState<AttendanceRow[]>([]);
  const [monthFilter, setMonthFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [clocking, setClocking] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  function showToast(msg: string, ok: boolean) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }

  // Resolve member_id once, same logic as _getMyMemberId in index.html
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

  // Load attendance whenever memberId is known
  useEffect(() => {
    if (!memberId) { setLoading(false); return; }
    loadAttendance();
  }, [memberId]);

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
  }

  const _d = new Date();
  const today = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`;
  const todayRow = rows.find(r => r.date === today);

  async function clockIn() {
    if (!memberId) { showToast('Could not find your team member record.', false); return; }
    setClocking(true);
    const gps = await getGps();
    const now = new Date().toISOString();
    const status = new Date().getHours() >= LATE_CUTOFF_HOUR ? 'Late' : 'Present';
    const payload: Record<string, unknown> = { member_id: memberId, date: today, clock_in: now, status };
    if (gps) { payload.clock_in_lat = gps.lat; payload.clock_in_lng = gps.lng; }
    const { error } = await supabase
      .from('attendance')
      .upsert(payload, { onConflict: 'member_id,date' });
    setClocking(false);
    if (error) { showToast(error.message, false); return; }
    showToast('Clocked in!', true);
    await loadAttendance();
  }

  async function clockOut() {
    if (!todayRow?.id || !todayRow.clock_in) return;
    setClocking(true);
    const gps = await getGps();
    const now = new Date().toISOString();
    const hours = Math.round((+new Date(now) - +new Date(todayRow.clock_in)) / 3600000 * 100) / 100;
    const payload: Record<string, unknown> = { clock_out: now, hours_worked: hours };
    if (gps) { payload.clock_out_lat = gps.lat; payload.clock_out_lng = gps.lng; }
    const { error } = await supabase.from('attendance').update(payload).eq('id', todayRow.id);
    setClocking(false);
    if (error) { showToast(error.message, false); return; }
    showToast(`Clocked out — ${hours} hrs worked.`, true);
    await loadAttendance();
  }

  const months = [...new Set(rows.map(r => r.date?.slice(0, 7)).filter(Boolean))].sort().reverse();
  const filtered = monthFilter ? rows.filter(r => r.date?.startsWith(monthFilter)) : rows;

  const statusBadge = (s: string | null) => {
    const map: Record<string, string> = {
      Present: styles.badgePresent,
      Late:    styles.badgeLate,
      Absent:  styles.badgeAbsent,
      'On Leave': styles.badgeLeave,
      'Half-day': styles.badgeHalfday,
    };
    return <span className={`${styles.badge} ${map[s || ''] ?? styles.badgePending}`}>{s || 'Pending'}</span>;
  };

  // Today's clock state UI
  let clockSection: React.ReactNode;
  if (!todayRow) {
    clockSection = (
      <button className={`${styles.clockBtn} ${styles.clockIn}`} onClick={clockIn} disabled={clocking}>
        {clocking ? 'Getting location…' : 'Clock In'}
      </button>
    );
  } else if (todayRow.clock_in && !todayRow.clock_out) {
    clockSection = (
      <>
        <span className={styles.clockedAt}>Clocked in at {fmtTime(todayRow.clock_in)}</span>
        <button className={`${styles.clockBtn} ${styles.clockOut}`} onClick={clockOut} disabled={clocking}>
          {clocking ? 'Getting location…' : 'Clock Out'}
        </button>
      </>
    );
  } else if (todayRow.clock_in && todayRow.clock_out) {
    clockSection = (
      <button className={`${styles.clockBtn} ${styles.clockDone}`} disabled>
        Done for today · {todayRow.hours_worked ?? '—'} hrs
      </button>
    );
  } else {
    clockSection = (
      <button className={`${styles.clockBtn} ${styles.clockIn}`} onClick={clockIn} disabled={clocking}>
        Clock In
      </button>
    );
  }

  return (
    <div className={styles.page}>
      {toast && (
        <div className={`${styles.toast} ${toast.ok ? styles.toastOk : styles.toastErr}`}>
          {toast.msg}
        </div>
      )}

      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>My Attendance</h2>
          <div className={styles.todayLabel}>Today: {today}</div>
        </div>
        <div className={styles.clockRow}>{clockSection}</div>
      </div>

      <div className={styles.filterRow}>
        <select
          className={styles.select}
          value={monthFilter}
          onChange={e => setMonthFilter(e.target.value)}
        >
          <option value="">All months</option>
          {months.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Clock In</th>
              <th>Clock Out</th>
              <th>Hours</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className={styles.empty}>Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={5} className={styles.empty}>No attendance records yet.</td></tr>
            ) : filtered.map(r => (
              <tr key={r.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.date)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtTime(r.clock_in)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtTime(r.clock_out)}</td>
                <td>{r.hours_worked ?? '—'}</td>
                <td>{statusBadge(r.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
