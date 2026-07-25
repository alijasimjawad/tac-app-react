import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import styles from './MyWork.module.css';

// ── Interfaces ────────────────────────────────────────────────────────────────

interface DailyActivity {
  id: string;
  date: string;
  project: string;
  site_id: string | null;
  governate: string | null;
  activity_type: string | null;
  status: string | null;
  team_member_ids: string[] | null;
  team_member_names: string[] | null;
  created_by: string | null;
  created_at: string;
}

interface AttendanceRow {
  id: string;
  member_id: string;
  date: string;
  clock_in: string | null;
  clock_out: string | null;
  hours_worked: number | null;
  status: string | null;
}

interface FieldTrip {
  id: string;
  date: string;
  project: string | null;
  site_id: string | null;
  team_member_ids: string[] | null;
  team_member_names: string[] | null;
  status: string;
  started_at: string | null;
  started_by_name: string | null;
  departed_at: string | null;
}

interface ExpenseClaim {
  id: string;
  member_id: string;
  activity_date: string;
  submitted_at: string;
  project_name: string | null;
  site_id: string | null;
  description: string | null;
  status: string;
  total_amount: number | null;
  rejection_reason: string | null;
}

interface WorkAlert {
  id: string;
  type: 'error' | 'warning';
  text: string;
  sub: string;
  to: string;
}

interface TimelineEvent {
  id: string;
  iconType: 'clockIn' | 'clockOut' | 'activity' | 'expense' | 'trip';
  text: string;
  sub: string;
  time: string;
  sortKey: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysAgoISO(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function fmtTime(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(iso: string) {
  const [yr, mo, dy] = iso.split('-');
  return `${dy}/${mo}/${yr}`;
}

function fmtFullDate() {
  return new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function fmtIQD(n: number) {
  return n.toLocaleString() + ' IQD';
}

function fmtSynced(d: Date) {
  const diff = Date.now() - d.getTime();
  if (diff < 60000) return 'Just now';
  return `${Math.floor(diff / 60000)}m ago`;
}

function actStatusCls(s: string | null) {
  const v = (s || '').toLowerCase();
  if (v === 'in progress') return styles.badgeAmber;
  if (v === 'completed') return styles.badgeGreen;
  if (v === 'blocked') return styles.badgeRed;
  return styles.badgeSlate;
}

// ── Skeleton placeholder ──────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={`${styles.skPulse} ${styles.skH1}`} />
          <div className={`${styles.skPulse} ${styles.skLine}`} />
        </div>
      </div>
      <div className={styles.statusGrid}>
        {[0, 1, 2, 3].map(i => (
          <div key={i} className={styles.statusCard}>
            <div className={`${styles.skPulse} ${styles.skLine}`} />
            <div className={`${styles.skPulse} ${styles.skH2}`} />
            <div className={`${styles.skPulse} ${styles.skLineSm}`} />
          </div>
        ))}
      </div>
      <div className={styles.mainGrid}>
        <div className={styles.sectionCard} style={{ minHeight: 220 }}>
          <div className={`${styles.skPulse} ${styles.skH2}`} />
          {[0, 1, 2].map(i => <div key={i} className={`${styles.skPulse} ${styles.skWorkRow}`} />)}
        </div>
        <div className={styles.sectionCard} style={{ minHeight: 220 }}>
          <div className={`${styles.skPulse} ${styles.skH2}`} />
          <div className={`${styles.skPulse} ${styles.skBlock}`} />
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MyWork() {
  const { currentUser } = useAuth();
  const navigate = useNavigate();

  const [memberResolved, setMemberResolved] = useState(false);
  const [loading,        setLoading]        = useState(true);
  const [error,          setError]          = useState<string | null>(null);

  const [todayAtt,       setTodayAtt]       = useState<AttendanceRow | null>(null);
  const [yesterdayAtt,   setYesterdayAtt]   = useState<AttendanceRow | null>(null);
  const [todayActs,      setTodayActs]      = useState<DailyActivity[]>([]);
  const [recentActs,     setRecentActs]     = useState<DailyActivity[]>([]);
  const [activeTrip,     setActiveTrip]     = useState<FieldTrip | null>(null);
  const [pendingExp,     setPendingExp]     = useState({ count: 0, total: 0 });
  const [recentExps,     setRecentExps]     = useState<ExpenseClaim[]>([]);
  const [lastSynced,     setLastSynced]     = useState<Date | null>(null);

  const memberIdRef = useRef<string | null>(null);

  // ── Member resolution ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!currentUser) return;
    (async () => {
      const { data } = await supabase
        .from('team_members')
        .select('id, full_name, username')
        .order('full_name');
      if (data) {
        const name  = (currentUser.full_name || '').trim().toLowerCase();
        const uname = (currentUser.username  || '').trim().toLowerCase();
        const match = data.find((m: { id: string; full_name?: string; username?: string }) =>
          (name  && m.full_name?.trim().toLowerCase() === name) ||
          (uname && m.username?.trim().toLowerCase()  === uname),
        );
        memberIdRef.current = match?.id ?? null;
      }
      setMemberResolved(true);
    })();
  }, [currentUser]);

  // ── Data load ─────────────────────────────────────────────────────────────────
  async function loadAll() {
    setLoading(true);
    setError(null);
    const today     = todayISO();
    const yesterday = daysAgoISO(1);
    const from30    = daysAgoISO(30);
    const mid       = memberIdRef.current;

    try {
      const [attRes, actRes, tripRes, expRes] = await Promise.all([
        mid
          ? supabase.from('attendance').select('*').eq('member_id', mid).in('date', [today, yesterday])
          : Promise.resolve({ data: [] as AttendanceRow[], error: null }),

        supabase
          .from('daily_activities')
          .select('id,date,project,site_id,governate,activity_type,status,team_member_ids,team_member_names,created_by,created_at')
          .gte('date', from30)
          .order('date', { ascending: false })
          .limit(300),

        supabase
          .from('field_trips')
          .select('id,date,project,site_id,team_member_ids,team_member_names,status,started_at,started_by_name,departed_at')
          .in('status', ['active', 'departed', 'pending'])
          .order('started_at', { ascending: false })
          .limit(60),

        mid
          ? supabase
              .from('expense_claims')
              .select('id,member_id,activity_date,submitted_at,project_name,site_id,description,status,total_amount,rejection_reason')
              .eq('member_id', mid)
              .order('submitted_at', { ascending: false })
              .limit(20)
          : Promise.resolve({ data: [] as ExpenseClaim[], error: null }),
      ]);

      // Attendance
      const attRows = (attRes.data ?? []) as AttendanceRow[];
      setTodayAtt(    attRows.find(r => r.date === today)     ?? null);
      setYesterdayAtt(attRows.find(r => r.date === yesterday) ?? null);

      // Activities — filter client-side (matching MyTrips pattern)
      const allActs = (actRes.data ?? []) as DailyActivity[];
      const myActs  = mid
        ? allActs.filter(a => Array.isArray(a.team_member_ids) && a.team_member_ids.includes(mid))
        : [];
      setTodayActs( myActs.filter(a => a.date === today));
      setRecentActs(myActs);

      // Trips
      const allTrips = (tripRes.data ?? []) as FieldTrip[];
      const myTrips  = mid
        ? allTrips.filter(t => Array.isArray(t.team_member_ids) && t.team_member_ids.includes(mid))
        : [];
      setActiveTrip(myTrips.find(t => t.status === 'active' || t.status === 'departed') ?? null);

      // Expenses
      const exps    = (expRes.data ?? []) as ExpenseClaim[];
      const pending = exps.filter(e => e.status === 'pending' || e.status === 'submitted');
      setPendingExp({
        count: pending.length,
        total: pending.reduce((s, e) => s + (e.total_amount ?? 0), 0),
      });
      setRecentExps(exps);

      setLastSynced(new Date());
    } catch {
      setError('Unable to load your work overview. Please refresh and try again.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!memberResolved) return;
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberResolved]);

  // ── Derived ───────────────────────────────────────────────────────────────────

  const today     = todayISO();
  const yesterday = daysAgoISO(1);

  const activeAct = todayActs.find(a => a.status === 'In Progress') ?? todayActs[0] ?? null;

  // Unique sites from recent activities
  const siteMap = new Map<string, DailyActivity>();
  for (const a of recentActs) {
    if (a.site_id && !siteMap.has(a.site_id)) siteMap.set(a.site_id, a);
  }
  const assignedSites = Array.from(siteMap.values()).slice(0, 4);

  // Alerts
  const alerts: WorkAlert[] = [];
  recentExps.filter(e => e.status === 'rejected').slice(0, 2).forEach(e => {
    alerts.push({
      id:   'rej-' + e.id,
      type: 'error',
      text: 'Expense claim rejected',
      sub:  `${e.description || e.project_name || 'Claim'} · ${fmtDate(e.activity_date)}`,
      to:   '/my-expenses',
    });
  });
  if (yesterdayAtt?.clock_in && !yesterdayAtt?.clock_out) {
    alerts.push({
      id:   'miss-co',
      type: 'warning',
      text: 'Missing clock-out',
      sub:  `Yesterday (${fmtDate(yesterday)}) — clock-in recorded but no clock-out`,
      to:   '/attendance',
    });
  }

  // Recent timeline
  const events: TimelineEvent[] = [];
  if (todayAtt?.clock_in) {
    events.push({ id: 'att-in',  iconType: 'clockIn',  text: 'Clocked in',  sub: fmtFullDate(), time: fmtTime(todayAtt.clock_in),  sortKey: todayAtt.clock_in });
  }
  if (todayAtt?.clock_out) {
    events.push({ id: 'att-out', iconType: 'clockOut', text: 'Clocked out', sub: `${todayAtt.hours_worked ?? '—'} hrs worked`, time: fmtTime(todayAtt.clock_out), sortKey: todayAtt.clock_out });
  }
  recentActs.slice(0, 3).forEach(a => {
    events.push({ id: 'act-' + a.id, iconType: 'activity', text: `${a.activity_type || 'Activity'} · ${a.status || '—'}`, sub: [a.site_id, a.project].filter(Boolean).join(' · '), time: fmtDate(a.date), sortKey: a.created_at || a.date });
  });
  recentExps.slice(0, 2).forEach(e => {
    const lbl = e.status === 'approved' ? 'approved' : e.status === 'rejected' ? 'rejected' : 'submitted';
    events.push({ id: 'exp-' + e.id, iconType: 'expense', text: `Expense ${lbl}`, sub: `${e.project_name || '—'} · ${e.total_amount ? fmtIQD(e.total_amount) : '—'}`, time: fmtDate(e.activity_date), sortKey: e.submitted_at || e.activity_date });
  });
  events.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
  const shownEvents = events.slice(0, 6);

  // Attendance label
  const attLabel = !todayAtt ? 'Not Clocked In' : todayAtt.clock_out ? 'Clocked Out' : 'Clocked In';
  const attCls   = attLabel === 'Clocked In' ? styles.valGreen : attLabel === 'Clocked Out' ? styles.valSlate : styles.valAmber;

  const displayName = (currentUser?.full_name || currentUser?.username || '').split(' ')[0];

  const timelineIconBg: Record<TimelineEvent['iconType'], string> = {
    clockIn:  styles.tlBgGreen,
    clockOut: styles.tlBgSlate,
    activity: styles.tlBgBlue,
    expense:  styles.tlBgPurple,
    trip:     styles.tlBgAmber,
  };

  if (loading) return <Skeleton />;

  return (
    <div className={styles.page}>

      {/* ── Header ────────────────────────────────────────────────────────────── */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h1 className={styles.greeting}>{getGreeting()}, {displayName}</h1>
          <p className={styles.greetingSub}>Here is your work overview for {today === todayISO() ? 'today' : fmtDate(today)}.</p>
          <p className={styles.greetingDate}>{fmtFullDate()}</p>
        </div>
        <div className={styles.headerRight}>
          {lastSynced && <span className={styles.syncLabel}>Last synced: {fmtSynced(lastSynced)}</span>}
          <button className={styles.refreshBtn} onClick={loadAll} aria-label="Refresh">
            <RefreshIcon /> Refresh
          </button>
        </div>
      </div>

      {error && <div className={styles.errorBanner} role="alert" aria-live="polite"><InfoIcon /> {error}</div>}

      {/* ── Status cards ──────────────────────────────────────────────────────── */}
      <div className={styles.statusGrid} role="region" aria-label="Status summary">

        <button className={`${styles.statusCard} ${styles.scAttendance}`} onClick={() => navigate('/attendance')}>
          <div className={styles.scTop}>
            <span className={`${styles.scIcon} ${styles.scIconBlue}`}><ClockSIcon /></span>
            <span className={styles.scLabel}>Attendance</span>
            <ChevronRightSmIcon />
          </div>
          <div className={`${styles.scValue} ${attCls}`}>{attLabel}</div>
          {todayAtt?.clock_in && (
            <div className={styles.scSub}>
              In: {fmtTime(todayAtt.clock_in)}
              {todayAtt.clock_out ? ` · Out: ${fmtTime(todayAtt.clock_out)}` : ''}
            </div>
          )}
        </button>

        <button className={`${styles.statusCard} ${styles.scActivity}`} onClick={() => navigate('/daily-activities')}>
          <div className={styles.scTop}>
            <span className={`${styles.scIcon} ${styles.scIconGreen}`}><ActivitySIcon /></span>
            <span className={styles.scLabel}>Active Activity</span>
            <ChevronRightSmIcon />
          </div>
          {activeAct ? (
            <>
              <div className={styles.scValue}>{activeAct.activity_type || 'Activity'}</div>
              <div className={styles.scSub}>{activeAct.site_id ? `Site ${activeAct.site_id}` : activeAct.project || '—'}</div>
            </>
          ) : (
            <div className={`${styles.scValue} ${styles.valSlate}`}>No active activity</div>
          )}
        </button>

        <button className={`${styles.statusCard} ${styles.scTrip}`} onClick={() => navigate('/my-trips')}>
          <div className={styles.scTop}>
            <span className={`${styles.scIcon} ${styles.scIconPurple}`}><TripSIcon /></span>
            <span className={styles.scLabel}>Current Trip</span>
            <ChevronRightSmIcon />
          </div>
          {activeTrip ? (
            <>
              <div className={`${styles.scValue} ${styles.valGreen}`}>
                {activeTrip.status === 'active' ? 'In Progress' : activeTrip.status === 'departed' ? 'Departed' : 'Pending'}
              </div>
              <div className={styles.scSub}>
                {(activeTrip.team_member_names ?? []).length} member{(activeTrip.team_member_names ?? []).length !== 1 ? 's' : ''}
              </div>
            </>
          ) : (
            <div className={`${styles.scValue} ${styles.valSlate}`}>No active trip</div>
          )}
        </button>

        <button className={`${styles.statusCard} ${styles.scExpense}`} onClick={() => navigate('/my-expenses')}>
          <div className={styles.scTop}>
            <span className={`${styles.scIcon} ${styles.scIconAmber}`}><ExpenseSIcon /></span>
            <span className={styles.scLabel}>Pending Expenses</span>
            <ChevronRightSmIcon />
          </div>
          {pendingExp.count > 0 ? (
            <>
              <div className={`${styles.scValue} ${styles.valAmber}`}>
                {pendingExp.count} claim{pendingExp.count !== 1 ? 's' : ''}
              </div>
              <div className={styles.scSub}>{fmtIQD(pendingExp.total)}</div>
            </>
          ) : (
            <div className={`${styles.scValue} ${styles.valGreen}`}>No pending claims</div>
          )}
        </button>

      </div>

      {/* ── Quick Actions ──────────────────────────────────────────────────────── */}
      <section className={styles.qaSection}>
        <h2 className={styles.sectionTitle}>Quick Actions</h2>
        <div className={styles.qaGrid}>

          <button className={`${styles.qaCard} ${styles.qaBlue}`} onClick={() => navigate('/attendance')}>
            <span className={styles.qaIcon}><ClockQIcon /></span>
            <span className={styles.qaLabel}>{attLabel === 'Clocked In' ? 'Clock Out' : 'Clock In'}</span>
            <ChevronRightSmIcon />
          </button>

          <button className={`${styles.qaCard} ${styles.qaGreen}`} onClick={() => navigate('/daily-activities')}>
            <span className={styles.qaIcon}><ActivityQIcon /></span>
            <span className={styles.qaLabel}>{activeAct ? 'Open Activity' : 'Start Activity'}</span>
            <ChevronRightSmIcon />
          </button>

          <button className={`${styles.qaCard} ${styles.qaPurple}`} onClick={() => navigate('/my-trips')}>
            <span className={styles.qaIcon}><TripQIcon /></span>
            <span className={styles.qaLabel}>{activeTrip ? 'Open Trip' : 'Start a Trip'}</span>
            <ChevronRightSmIcon />
          </button>

          <button className={`${styles.qaCard} ${styles.qaAmber}`} onClick={() => navigate('/my-expenses')}>
            <span className={styles.qaIcon}><ExpenseQIcon /></span>
            <span className={styles.qaLabel}>New Expense</span>
            <ChevronRightSmIcon />
          </button>

        </div>
      </section>

      {/* ── Main two-col grid ─────────────────────────────────────────────────── */}
      <div className={styles.mainGrid}>

        {/* My Work Today */}
        <section className={styles.sectionCard} aria-labelledby="wt-title">
          <div className={styles.scardHeader}>
            <h2 className={styles.scardTitle} id="wt-title">My Work Today</h2>
            <span className={styles.countBadge}>{todayActs.length}</span>
          </div>

          {todayActs.length === 0 ? (
            <div className={styles.emptyState}>
              <EmptyWorkIcon />
              <p>No work assigned for today.</p>
            </div>
          ) : (
            <>
              <div className={styles.workList} role="list">
                {todayActs.slice(0, 5).map(a => (
                  <div key={a.id} className={styles.workItem} role="listitem">
                    <div className={`${styles.workDot} ${actStatusCls(a.status)}`} aria-hidden="true" />
                    <div className={styles.workBody}>
                      <div className={styles.workTitle}>{a.activity_type || '—'}</div>
                      <div className={styles.workMeta}>
                        {a.site_id && <span>Site {a.site_id}</span>}
                        {a.project && <span className={styles.metaDot}>·</span>}
                        {a.project && <span>{a.project}</span>}
                      </div>
                      {(a.team_member_names ?? []).length > 0 && (
                        <div className={styles.workTeam}>
                          <UsersSmIcon />
                          {(a.team_member_names ?? []).length} member{(a.team_member_names ?? []).length !== 1 ? 's' : ''}
                        </div>
                      )}
                    </div>
                    <span className={`${styles.statusBadge} ${actStatusCls(a.status)}`}>
                      {a.status || '—'}
                    </span>
                  </div>
                ))}
              </div>
              <button className={styles.viewAllBtn} onClick={() => navigate('/daily-activities')}>
                View all activities <ChevronRightSmIcon />
              </button>
            </>
          )}
        </section>

        {/* Current Field Trip */}
        <section className={styles.sectionCard} aria-labelledby="ct-title">
          <div className={styles.scardHeader}>
            <h2 className={styles.scardTitle} id="ct-title">Current Field Trip</h2>
            {activeTrip && (
              <span className={`${styles.countBadge} ${styles.badgeGreenBg}`}>
                {activeTrip.status === 'active' ? 'Active' : activeTrip.status === 'departed' ? 'Departed' : 'Pending'}
              </span>
            )}
          </div>

          {!activeTrip ? (
            <div className={styles.emptyState}>
              <EmptyTripIcon />
              <p>No active field trip.</p>
              <button className={styles.emptyActionBtn} onClick={() => navigate('/my-trips')}>
                View trips
              </button>
            </div>
          ) : (
            <div className={styles.tripDetail}>
              <div className={styles.tripHdr}>
                <div className={styles.tripIconCircle}><TripDetailIcon /></div>
                <div>
                  <div className={styles.tripName}>{activeTrip.project || 'Field Trip'}</div>
                  {activeTrip.site_id && <div className={styles.tripSite}>Site {activeTrip.site_id}</div>}
                </div>
              </div>
              {activeTrip.started_at && (
                <div className={styles.tripTimeLine}>
                  <ClockSmIcon /> Started at {fmtTime(activeTrip.started_at)}
                </div>
              )}
              <div className={styles.tripMemberRow}>
                <UsersSmIcon />
                <span>{(activeTrip.team_member_names ?? []).length} member{(activeTrip.team_member_names ?? []).length !== 1 ? 's' : ''} on team</span>
              </div>
              {(activeTrip.team_member_names ?? []).length > 0 && (
                <div className={styles.memberPills}>
                  {(activeTrip.team_member_names ?? []).slice(0, 5).map((n, i) => (
                    <span key={i} className={styles.memberPill}>{n.split(' ')[0]}</span>
                  ))}
                  {(activeTrip.team_member_names ?? []).length > 5 && (
                    <span className={styles.memberPill}>+{(activeTrip.team_member_names ?? []).length - 5}</span>
                  )}
                </div>
              )}
              <button className={styles.openTripBtn} onClick={() => navigate('/my-trips')}>
                Open Trip <ChevronRightSmIcon />
              </button>
            </div>
          )}
        </section>

      </div>

      {/* ── Second two-col grid ───────────────────────────────────────────────── */}
      <div className={styles.secondGrid}>

        {/* My Assigned Sites */}
        <section className={styles.sectionCard} aria-labelledby="as-title">
          <div className={styles.scardHeader}>
            <h2 className={styles.scardTitle} id="as-title">My Assigned Sites</h2>
            <button className={styles.viewAllLink} onClick={() => navigate('/my-sites')}>View all</button>
          </div>

          {assignedSites.length === 0 ? (
            <div className={styles.emptyState}>
              <EmptySiteIcon />
              <p>No sites found in recent activities.</p>
            </div>
          ) : (
            <div className={styles.siteList} role="list">
              {assignedSites.map(a => (
                <div key={a.site_id} className={styles.siteItem} role="listitem">
                  <div className={styles.siteIconWrap}><MapPinIcon /></div>
                  <div className={styles.siteBody}>
                    <div className={styles.siteId}>Site {a.site_id}</div>
                    <div className={styles.siteMeta}>{a.project || '—'}</div>
                  </div>
                  <span className={`${styles.statusBadge} ${actStatusCls(a.status)}`}>
                    {a.status || '—'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Attention Required */}
        <section className={styles.sectionCard} aria-labelledby="ar-title">
          <div className={styles.scardHeader}>
            <h2 className={styles.scardTitle} id="ar-title">Attention Required</h2>
            {alerts.length > 0 && (
              <span className={`${styles.countBadge} ${styles.badgeRedBg}`}>{alerts.length}</span>
            )}
          </div>

          {alerts.length === 0 ? (
            <div className={`${styles.emptyState} ${styles.emptyStateCaughtUp}`}>
              <CaughtUpIcon />
              <p>You're all caught up.</p>
            </div>
          ) : (
            <div className={styles.alertList} role="list">
              {alerts.map(al => (
                <button
                  key={al.id}
                  className={`${styles.alertItem} ${al.type === 'error' ? styles.alertError : styles.alertWarning}`}
                  onClick={() => navigate(al.to)}
                  role="listitem"
                >
                  <span className={styles.alertIcon}>
                    {al.type === 'error' ? <AlertRedIcon /> : <AlertAmberIcon />}
                  </span>
                  <span className={styles.alertBody}>
                    <span className={styles.alertText}>{al.text}</span>
                    <span className={styles.alertSub}>{al.sub}</span>
                  </span>
                  <ChevronRightSmIcon />
                </button>
              ))}
            </div>
          )}
        </section>

      </div>

      {/* ── Recent Activity ───────────────────────────────────────────────────── */}
      <section className={styles.sectionCard} aria-labelledby="ra-title">
        <div className={styles.scardHeader}>
          <h2 className={styles.scardTitle} id="ra-title">Recent Activity</h2>
        </div>

        {shownEvents.length === 0 ? (
          <div className={styles.emptyState}><p>No recent activity available.</p></div>
        ) : (
          <div className={styles.timeline} role="list">
            {shownEvents.map(e => (
              <div key={e.id} className={styles.tlItem} role="listitem">
                <div className={`${styles.tlIconWrap} ${timelineIconBg[e.iconType]}`}>
                  <TimelineIconComp type={e.iconType} />
                </div>
                <div className={styles.tlBody}>
                  <div className={styles.tlText}>{e.text}</div>
                  <div className={styles.tlSub}>{e.sub}</div>
                </div>
                <div className={styles.tlTime}>{e.time}</div>
              </div>
            ))}
          </div>
        )}
      </section>

    </div>
  );
}

// ── Icon components ───────────────────────────────────────────────────────────

function RefreshIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  );
}

function ChevronRightSmIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <polyline points="9 18 15 12 9 6"/>
    </svg>
  );
}

function ClockSIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
    </svg>
  );
}

function ActivitySIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>
      <rect x="9" y="3" width="6" height="4" rx="2"/>
      <line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/>
    </svg>
  );
}

function TripSIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="1" y="11" width="22" height="9" rx="2"/>
      <path d="M5 11V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4"/>
      <circle cx="7.5" cy="17.5" r="1.5"/><circle cx="16.5" cy="17.5" r="1.5"/>
    </svg>
  );
}

function ExpenseSIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 2v20l3-2 2 2 2-2 2 2 2-2 3 2V2z"/>
      <line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="15" y2="13"/>
    </svg>
  );
}

function ClockQIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
    </svg>
  );
}

function ActivityQIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>
      <rect x="9" y="3" width="6" height="4" rx="2"/>
      <line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/>
    </svg>
  );
}

function TripQIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="1" y="11" width="22" height="9" rx="2"/>
      <path d="M5 11V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4"/>
      <circle cx="7.5" cy="17.5" r="1.5"/><circle cx="16.5" cy="17.5" r="1.5"/>
    </svg>
  );
}

function ExpenseQIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="1" x2="12" y2="23"/>
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
    </svg>
  );
}

function EmptyWorkIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>
      <rect x="9" y="3" width="6" height="4" rx="2"/>
      <line x1="9" y1="12" x2="15" y2="12"/>
    </svg>
  );
}

function EmptyTripIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1" y="11" width="22" height="9" rx="2"/>
      <path d="M5 11V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4"/>
      <circle cx="7.5" cy="17.5" r="1.5"/><circle cx="16.5" cy="17.5" r="1.5"/>
    </svg>
  );
}

function EmptySiteIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
      <circle cx="12" cy="10" r="3"/>
    </svg>
  );
}

function CaughtUpIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
      <polyline points="22 4 12 14.01 9 11.01"/>
    </svg>
  );
}

function TripDetailIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="1" y="11" width="22" height="9" rx="2"/>
      <path d="M5 11V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4"/>
      <circle cx="7.5" cy="17.5" r="1.5"/><circle cx="16.5" cy="17.5" r="1.5"/>
    </svg>
  );
}

function MapPinIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
      <circle cx="12" cy="10" r="3"/>
    </svg>
  );
}

function UsersSmIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  );
}

function ClockSmIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
    </svg>
  );
}

function AlertRedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  );
}

function AlertAmberIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  );
}

function TimelineIconComp({ type }: { type: TimelineEvent['iconType'] }) {
  if (type === 'clockIn' || type === 'clockOut') return <ClockSIcon />;
  if (type === 'activity') return <ActivitySIcon />;
  if (type === 'expense') return <ExpenseSIcon />;
  return <TripSIcon />;
}
