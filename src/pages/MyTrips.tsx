import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import {
  type FieldTrip,
  type TripParticipant,
  fmtDate,
  fmtTime,
  initials,
  buildTimeline,
} from '../lib/tripTypes';
import TripDetailModal from '../components/TripDetailModal';
import styles from './MyTrips.module.css';

// ── Trip phases ───────────────────────────────────────────────────────────────

const PHASES = [
  'Meeting Point',
  'Team Joining',
  'Travelling',
  'Site Arrival',
  'Work in Progress',
  'Completed',
] as const;

function phaseIndex(status: string): number {
  if (status === 'pending')   return 0;
  if (status === 'active')    return 1;
  if (status === 'departed')  return 2;
  if (status === 'completed') return 5;
  return 0;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtDateLong(iso: string): string {
  try {
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
  } catch { return fmtDate(iso); }
}

function fmtDuration(startIso: string | null, endIso?: string | null): string {
  if (!startIso) return '—';
  const ms = (endIso ? new Date(endIso).getTime() : Date.now()) - new Date(startIso).getTime();
  if (ms < 0) return '—';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── SVG Icons ─────────────────────────────────────────────────────────────────

const IcPlus     = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>;
const IcBriefcase= () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>;
const IcUsers    = ({ size=16 }:{ size?:number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>;
const IcClock    = ({ size=16 }:{ size?:number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
const IcCheck    = ({ size=14 }:{ size?:number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>;
const IcMap      = ({ size=14 }:{ size?:number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>;
const IcSearch   = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>;
const IcX        = ({ size=16 }:{ size?:number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>;
const IcPin      = ({ size=14 }:{ size?:number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>;
const IcExternal = ({ size=13 }:{ size?:number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>;
const IcActivity = ({ size=14 }:{ size?:number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>;

// ── Status Badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'active'    ? styles.badgeActive :
    status === 'departed'  ? styles.badgeDeparted :
    status === 'completed' ? styles.badgeCompleted :
    styles.badgePending;
  return <span className={`${styles.badge} ${cls}`}>{status}</span>;
}

// ── Phase Progress ─────────────────────────────────────────────────────────────

function PhaseProgress({ currentIndex }: { currentIndex: number }) {
  return (
    <div className={styles.phaseProgress} role="list" aria-label="Trip progress phases">
      {PHASES.map((phase, i) => {
        const done   = i < currentIndex;
        const active = i === currentIndex;
        const leftFilled  = i > 0 && i <= currentIndex;
        const rightFilled = i < currentIndex;
        return (
          <div key={phase} className={styles.phaseStep} role="listitem" aria-current={active ? 'step' : undefined}>
            <div className={styles.phaseDotRow}>
              <div className={`${styles.phaseConnector} ${leftFilled ? styles.phaseConnectorFilled : ''} ${i === 0 ? styles.phaseConnectorHidden : ''}`} />
              <div className={`${styles.phaseDot} ${done ? styles.phaseDotDone : active ? styles.phaseDotActive : ''}`}>
                {done ? <IcCheck size={9} /> : <span className={styles.phaseDotNum}>{i + 1}</span>}
              </div>
              <div className={`${styles.phaseConnector} ${rightFilled ? styles.phaseConnectorFilled : ''} ${i === PHASES.length - 1 ? styles.phaseConnectorHidden : ''}`} />
            </div>
            <div className={`${styles.phaseLabel} ${active ? styles.phaseLabelActive : done ? styles.phaseLabelDone : ''}`}>
              {phase}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Summary Card ──────────────────────────────────────────────────────────────

function SummaryCard({ icon, label, value, sub, iconCls }: {
  icon: ReactNode; label: string; value: string | number; sub?: string; iconCls: string;
}) {
  return (
    <div className={styles.summaryCard}>
      <div className={`${styles.summaryIcon} ${iconCls}`}>{icon}</div>
      <div className={styles.summaryValue}>{value}</div>
      <div className={styles.summaryLabel}>{label}</div>
      {sub && <div className={styles.summarySub}>{sub}</div>}
    </div>
  );
}

// ── Active Trip Hero ──────────────────────────────────────────────────────────

function ActiveTripHero({
  trip,
  onDetails,
  onFullModal,
  onLive,
}: {
  trip: FieldTrip;
  onDetails: () => void;
  onFullModal: () => void;
  onLive: () => void;
}) {
  const phase = phaseIndex(trip.status);
  const names = Array.isArray(trip.team_member_names) ? trip.team_member_names : [];
  const teamCount = trip.team_member_ids?.length ?? 0;

  return (
    <div className={styles.heroCard}>
      <div className={styles.heroTopRow}>
        <div className={styles.heroLiveLabel}>
          <span className={styles.heroPulse} />
          <span>ACTIVE TRIP</span>
        </div>
        <StatusBadge status={trip.status} />
      </div>

      <div className={styles.heroTitle}>
        {trip.project || '—'}
        {trip.site_id && <span className={styles.heroSite}> · {trip.site_id}</span>}
      </div>
      <div className={styles.heroMeta}>
        {trip.date ? fmtDateLong(trip.date) : '—'}
        {trip.governate && ` · ${trip.governate}`}
      </div>

      {/* Phase progress */}
      <PhaseProgress currentIndex={phase} />

      {/* Key stats */}
      <div className={styles.heroStats}>
        {trip.started_at && (
          <div className={styles.heroStat}>
            <div className={styles.heroStatLabel}>Started at</div>
            <div className={styles.heroStatValue}>{fmtTime(trip.started_at)}</div>
          </div>
        )}
        <div className={styles.heroStat}>
          <div className={styles.heroStatLabel}>Team joined</div>
          <div className={styles.heroStatValue}>{teamCount} member{teamCount !== 1 ? 's' : ''}</div>
        </div>
        {trip.started_at && (
          <div className={styles.heroStat}>
            <div className={styles.heroStatLabel}>Duration</div>
            <div className={styles.heroStatValue}>{fmtDuration(trip.started_at)}</div>
          </div>
        )}
        {trip.started_by_name && (
          <div className={styles.heroStat}>
            <div className={styles.heroStatLabel}>Started by</div>
            <div className={styles.heroStatValue}>{trip.started_by_name}</div>
          </div>
        )}
      </div>

      {/* Team avatars */}
      {names.length > 0 && (
        <div className={styles.heroTeam}>
          <div className={styles.heroAvatarRow}>
            {names.slice(0, 6).map((n, i) => (
              <div key={i} className={styles.heroAvatar} title={n}>{initials(n)}</div>
            ))}
          </div>
          <div className={styles.heroTeamNames}>{names.join(' · ')}</div>
        </div>
      )}

      {/* Actions */}
      <div className={styles.heroActions}>
        <button className={styles.heroBtnPrimary} onClick={onDetails}>
          <IcActivity /> Trip Details
        </button>
        <button className={styles.heroBtnSecondary} onClick={onFullModal}>
          <IcMap /> View Map
        </button>
        <button className={styles.heroBtnSecondary} onClick={onLive}>
          <IcExternal /> Live Trips
        </button>
      </div>
    </div>
  );
}

// ── Pending Trip Card ─────────────────────────────────────────────────────────

function PendingCard({
  trip,
  canStart,
  onDetails,
  onStart,
}: {
  trip: FieldTrip;
  canStart: boolean;
  onDetails: () => void;
  onStart: () => void;
}) {
  const teamCount = trip.team_member_ids?.length ?? 0;
  return (
    <div className={styles.pendingCard}>
      <div className={styles.pendingCardBody}>
        <div className={styles.pendingBadge}><IcClock size={10} /> Pending</div>
        <div className={styles.pendingTitle}>
          {trip.project || '—'}
          {trip.site_id && <span className={styles.pendingSite}> · {trip.site_id}</span>}
        </div>
        <div className={styles.pendingMeta}>
          {trip.date ? fmtDateLong(trip.date) : '—'}
          {trip.governate && ` · ${trip.governate}`}
        </div>
        <div className={styles.pendingTeam}>
          <IcUsers size={11} /> {teamCount} member{teamCount !== 1 ? 's' : ''}
        </div>
      </div>
      <div className={styles.pendingCardActions}>
        {canStart && (
          <button className={styles.startBtn} onClick={onStart}>
            <IcActivity size={12} /> Start Trip
          </button>
        )}
        <button className={styles.detailsLink} onClick={onDetails}>View Details</button>
      </div>
    </div>
  );
}

// ── Mobile Completed Card ─────────────────────────────────────────────────────

function MobileCard({ trip, onView }: { trip: FieldTrip; onView: () => void }) {
  return (
    <div className={styles.mobileCard} onClick={onView} role="button" tabIndex={0} onKeyDown={e => e.key === 'Enter' && onView()}>
      <div className={styles.mobileCardTop}>
        <StatusBadge status={trip.status} />
        <span className={styles.mobileCardDuration}>{fmtDuration(trip.started_at, trip.completed_at)}</span>
      </div>
      <div className={styles.mobileCardTitle}>
        {trip.project || '—'}{trip.site_id ? ` · ${trip.site_id}` : ''}
      </div>
      <div className={styles.mobileCardMeta}>
        {trip.date ? fmtDateLong(trip.date) : '—'}
        {trip.governate && ` · ${trip.governate}`}
      </div>
      <div className={styles.mobileCardMeta}>
        <IcUsers size={11} /> {trip.team_member_ids?.length ?? 0} team members
      </div>
      <button className={styles.mobileCardBtn}>View Details</button>
    </div>
  );
}

// ── Empty State ───────────────────────────────────────────────────────────────

function EmptyState({ hasFilter }: { hasFilter: boolean }) {
  return (
    <div className={styles.emptyState}>
      <div className={styles.emptyIcon}><IcBriefcase /></div>
      <div className={styles.emptyTitle}>
        {hasFilter ? 'No trips match your filters' : 'No field trips yet'}
      </div>
      <div className={styles.emptySub}>
        {hasFilter
          ? 'Try adjusting your search or filters to find trips.'
          : 'Field trips appear automatically when a Daily Activity is saved.'}
      </div>
    </div>
  );
}

// ── Trip Detail Drawer ────────────────────────────────────────────────────────

function TripDetailDrawer({
  loading,
  data,
  onClose,
  onFullModal,
}: {
  loading: boolean;
  data: { trip: FieldTrip; participants: TripParticipant[] } | null;
  onClose: () => void;
  onFullModal: () => void;
}) {
  const trip = data?.trip ?? null;
  const pp   = data?.participants ?? [];
  const timeline = trip ? buildTimeline(trip, pp) : [];
  const meetingPp = pp.find(p => p.last_lat && p.last_lng);

  return (
    <aside className={styles.drawer} aria-label="Trip details" role="complementary">
      <div className={styles.drawerHeader}>
        <div className={styles.drawerTitle}>Trip Details</div>
        <button className={styles.drawerClose} onClick={onClose} aria-label="Close drawer">
          <IcX />
        </button>
      </div>

      <div className={styles.drawerBody}>
        {loading ? (
          <div className={styles.drawerSkeletons}>
            {[1, 2, 3, 4].map(i => <div key={i} className={styles.drawerSkeleton} />)}
          </div>
        ) : !trip ? (
          <div className={styles.drawerEmpty}>Unable to load trip details. Please try again.</div>
        ) : (
          <>
            <div className={styles.drawerTripTitle}>
              {trip.project || '—'}
              {trip.site_id && <span className={styles.drawerTripSite}> · {trip.site_id}</span>}
            </div>
            <StatusBadge status={trip.status} />

            {/* Overview */}
            <div className={styles.drawerSection}>
              <div className={styles.drawerSectionTitle}>Trip Overview</div>
              <div className={styles.overviewGrid}>
                {trip.project   && <OverviewRow label="Project"     value={trip.project} />}
                {trip.site_id   && <OverviewRow label="Site ID"     value={trip.site_id} />}
                {trip.date      && <OverviewRow label="Date"        value={fmtDateLong(trip.date)} />}
                <OverviewRow label="Status" value={trip.status} />
                {trip.governate && <OverviewRow label="Governorate" value={trip.governate} />}
                {trip.notes     && <OverviewRow label="Notes"       value={trip.notes} />}
                {trip.started_at    && <OverviewRow label="Started"   value={fmtTime(trip.started_at)} />}
                {trip.departed_at   && <OverviewRow label="Departed"  value={fmtTime(trip.departed_at)} />}
                {trip.completed_at  && <OverviewRow label="Completed" value={fmtTime(trip.completed_at)} />}
                {trip.started_at && (
                  <OverviewRow label="Duration" value={fmtDuration(trip.started_at, trip.completed_at)} />
                )}
              </div>
            </div>

            {/* Team members */}
            {pp.length > 0 && (
              <div className={styles.drawerSection}>
                <div className={styles.drawerSectionTitle}>Team Members</div>
                {pp.map(p => (
                  <div key={p.id} className={styles.drawerMember}>
                    <div className={styles.drawerMemberAvatar}>{initials(p.member_name)}</div>
                    <div className={styles.drawerMemberInfo}>
                      <div className={styles.drawerMemberName}>{p.member_name || p.member_id}</div>
                      <div className={styles.drawerMemberSub}>
                        {p.status === 'joined'
                          ? `Joined${p.joined_at ? ` · ${fmtTime(p.joined_at)}` : ''}`
                          : p.status ?? 'pending'}
                        {(p.delay_minutes ?? 0) > 0 && (
                          <span className={styles.delayBadge}> +{p.delay_minutes}min</span>
                        )}
                      </div>
                    </div>
                    {p.last_lat && p.last_lng && (
                      <span className={styles.liveBadge}>Live</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Meeting point */}
            {meetingPp && (
              <div className={styles.drawerSection}>
                <div className={styles.drawerSectionTitle}>Meeting Point</div>
                <div className={styles.meetingPoint}>
                  <IcPin size={16} />
                  <div>
                    <div className={styles.meetingLabel}>Best Start Point</div>
                    <div className={styles.meetingCoords}>
                      {meetingPp.last_lat?.toFixed(5)}, {meetingPp.last_lng?.toFixed(5)}
                    </div>
                    {meetingPp.last_location_at && (
                      <div className={styles.meetingTime}>Updated {fmtTime(meetingPp.last_location_at)}</div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Timeline */}
            {timeline.length > 0 && (
              <div className={styles.drawerSection}>
                <div className={styles.drawerSectionTitle}>Timeline</div>
                <div className={styles.drawerTimeline}>
                  {timeline.map((e, i) => (
                    <div key={i} className={styles.drawerTlItem}>
                      <div className={styles.drawerTlDot} />
                      <span className={styles.drawerTlLabel}>{e.label}</span>
                      <span className={styles.drawerTlTime}>{e.time}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <button className={styles.fullDetailBtn} onClick={onFullModal}>
              <IcMap size={13} /> View Map &amp; Actions
            </button>
          </>
        )}
      </div>
    </aside>
  );
}

function OverviewRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className={styles.overviewRow}>
      <span className={styles.overviewLabel}>{label}</span>
      <span className={styles.overviewValue}>{value}</span>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function MyTrips() {
  const { currentUser, hasPerm } = useAuth();
  const navigate = useNavigate();

  // preserved state
  const [memberId, setMemberId]         = useState<string | null>(null);
  const [memberResolved, setMemberResolved] = useState(false);
  const [trips, setTrips]               = useState<FieldTrip[]>([]);
  const [loading, setLoading]           = useState(true);
  const [toast, setToast]               = useState<{ msg: string; ok: boolean } | null>(null);

  // drawer state
  const [drawerTripId, setDrawerTripId] = useState<string | null>(null);
  const [drawerData, setDrawerData]     = useState<{ trip: FieldTrip; participants: TripParticipant[] } | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);

  // full modal
  const [detailTripId, setDetailTripId] = useState<string | null>(null);

  // filters
  const [search, setSearch]             = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const isAdmin = currentUser?.role === 'admin';

  function showToast(msg: string, ok: boolean) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }

  // ── member resolution (preserved verbatim) ──
  useEffect(() => {
    if (!currentUser) return;
    async function resolve() {
      const { data } = await supabase
        .from('team_members')
        .select('id, full_name, username')
        .order('full_name');
      if (!data) { setLoading(false); setMemberResolved(true); return; }
      const name  = (currentUser?.full_name || '').trim().toLowerCase();
      const uname = (currentUser?.username  || '').trim().toLowerCase();
      const match = data.find((m: { id: string; full_name?: string; username?: string }) =>
        (name  && m.full_name?.trim().toLowerCase() === name) ||
        (uname && m.username?.trim().toLowerCase()  === uname),
      );
      setMemberId(match?.id ?? null);
      setMemberResolved(true);
    }
    resolve();
  }, [currentUser]);

  // ── load trips (preserved) ──
  useEffect(() => {
    if (!memberResolved) return;
    loadTrips();
  }, [memberResolved]);

  async function loadTrips() {
    setLoading(true);
    const { data, error } = await supabase
      .from('field_trips')
      .select('*')
      .order('date', { ascending: false });
    if (error) showToast('Failed to load trips: ' + error.message, false);
    setTrips((data as FieldTrip[]) ?? []);
    setLoading(false);
  }

  // ── drawer ──
  async function openDrawer(tripId: string) {
    setDrawerTripId(tripId);
    setDrawerData(null);
    setDrawerLoading(true);
    const [{ data: trip }, { data: pp }] = await Promise.all([
      supabase.from('field_trips').select('*').eq('id', tripId).single(),
      supabase.from('trip_participants').select('*').eq('trip_id', tripId).order('member_name'),
    ]);
    if (trip) setDrawerData({ trip: trip as FieldTrip, participants: (pp as TripParticipant[]) ?? [] });
    setDrawerLoading(false);
  }

  function closeDrawer() {
    setDrawerTripId(null);
    setDrawerData(null);
  }

  // Escape closes drawer
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDrawer(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ── derived data ──
  const myTrips = trips.filter(t =>
    Array.isArray(t.team_member_ids) && t.team_member_ids.some(id => id === memberId),
  );
  const displayTrips = isAdmin ? trips : myTrips;

  const filteredTrips = displayTrips.filter(t => {
    if (search) {
      const q = search.toLowerCase();
      const haystack = [t.project, t.site_id, t.governate, ...(t.team_member_names ?? [])].join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (filterStatus && t.status !== filterStatus) return false;
    return true;
  });

  const activeOrDeparted = filteredTrips.filter(t => ['active', 'departed'].includes(t.status));
  const pendingTrips     = filteredTrips.filter(t => t.status === 'pending');
  const completedTrips   = filteredTrips.filter(t => t.status === 'completed');

  // summary counts from displayTrips (reflects real totals)
  const totalCount     = displayTrips.length;
  const activeCount    = displayTrips.filter(t => ['active', 'departed'].includes(t.status)).length;
  const pendingCount   = displayTrips.filter(t => t.status === 'pending').length;
  const completedCount = displayTrips.filter(t => t.status === 'completed').length;
  const liveMemberCount = displayTrips
    .filter(t => ['active', 'departed'].includes(t.status))
    .reduce((s, t) => s + (t.team_member_ids?.length ?? 0), 0);

  const hasFilters = !!search || !!filterStatus;
  const showContent = memberId || isAdmin;

  if (!hasPerm('view_my_trips')) {
    return (
      <div className={styles.page}>
        <p className={styles.denied}>You do not have permission to view this page.</p>
      </div>
    );
  }

  return (
    <div className={styles.page}>

      {/* ── Page header (actions row) ── */}
      <div className={styles.pageHeader}>
        <div>
          <h2 className={styles.pageTitle}>Field Trips</h2>
          <p className={styles.pageSub}>Track active, upcoming, and completed field trips.</p>
        </div>
        {isAdmin && (
          <button
            className={styles.newTripBtn}
            onClick={() => showToast('Trips are created automatically from Daily Activities.', true)}
          >
            <IcPlus /> New Trip
          </button>
        )}
      </div>

      {/* ── Not linked notice ── */}
      {memberResolved && !memberId && !isAdmin && (
        <div className={styles.notLinked}>
          <strong>Account not linked to a team member profile.</strong>
          <p>Field trip tracking is for field engineers and technicians. Your account doesn&apos;t have a linked team member profile.</p>
        </div>
      )}

      {/* ── Summary cards ── */}
      {showContent && (
        <div className={styles.summaryGrid}>
          <SummaryCard icon={<IcBriefcase />} label="Total Trips"  value={loading ? '—' : totalCount}     sub="all time"       iconCls={styles.summaryIconSlate}  />
          <SummaryCard icon={<IcActivity size={16} />} label="Active" value={loading ? '—' : activeCount} sub="in progress"    iconCls={styles.summaryIconGreen}  />
          <SummaryCard icon={<IcClock />}   label="Pending"  value={loading ? '—' : pendingCount}          sub="upcoming"       iconCls={styles.summaryIconAmber}  />
          <SummaryCard icon={<IcCheck />}   label="Completed" value={loading ? '—' : completedCount}       sub="finished"       iconCls={styles.summaryIconBlue}   />
          {liveMemberCount > 0 && (
            <SummaryCard icon={<IcUsers />} label="Team Live" value={liveMemberCount}                       sub="members active" iconCls={styles.summaryIconPurple} />
          )}
        </div>
      )}

      {/* ── Filter toolbar ── */}
      {showContent && displayTrips.length > 0 && (
        <div className={styles.filterBar}>
          <div className={styles.searchWrap}>
            <IcSearch />
            <input
              className={styles.searchInput}
              placeholder="Search project, site, member…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              aria-label="Search trips"
            />
            {search && (
              <button className={styles.searchClear} onClick={() => setSearch('')} aria-label="Clear search">
                <IcX size={12} />
              </button>
            )}
          </div>
          <select
            className={styles.filterSel}
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            aria-label="Filter by status"
          >
            <option value="">All Statuses</option>
            <option value="active">Active</option>
            <option value="departed">Departed</option>
            <option value="pending">Pending</option>
            <option value="completed">Completed</option>
          </select>
          {hasFilters && (
            <button className={styles.clearBtn} onClick={() => { setSearch(''); setFilterStatus(''); }}>
              Clear
            </button>
          )}
          <span className={styles.resultCount}>
            {filteredTrips.length} result{filteredTrips.length !== 1 ? 's' : ''}
          </span>
        </div>
      )}

      {/* ── Content area ── */}
      <div className={`${styles.contentArea} ${drawerTripId ? styles.contentWithDrawer : ''}`}>
        <div className={styles.mainCol}>

          {/* Loading skeletons */}
          {loading && (
            <div className={styles.skeletonStack}>
              <div className={`${styles.skeleton} ${styles.skeletonHero}`} />
              <div className={`${styles.skeleton} ${styles.skeletonCard}`} />
              <div className={`${styles.skeleton} ${styles.skeletonCard}`} />
            </div>
          )}

          {/* Not linked, not admin */}
          {!loading && memberResolved && !memberId && !isAdmin && null}

          {/* Empty state */}
          {!loading && showContent && filteredTrips.length === 0 && displayTrips.length > 0 && (
            <EmptyState hasFilter />
          )}
          {!loading && showContent && displayTrips.length === 0 && (
            <EmptyState hasFilter={false} />
          )}

          {/* Trip content */}
          {!loading && showContent && filteredTrips.length > 0 && (
            <>
              {/* Active / departed hero */}
              {activeOrDeparted.length > 0 && (
                <ActiveTripHero
                  trip={activeOrDeparted[0]}
                  onDetails={() => openDrawer(activeOrDeparted[0].id)}
                  onFullModal={() => setDetailTripId(activeOrDeparted[0].id)}
                  onLive={() => navigate('/live-trips')}
                />
              )}

              {/* Pending trips */}
              {pendingTrips.length > 0 && (
                <section>
                  <div className={styles.sectionHdr}>
                    <span className={styles.sectionTitle}>Pending Trips</span>
                    <span className={styles.sectionCount}>{pendingTrips.length}</span>
                  </div>
                  <div className={styles.pendingList}>
                    {pendingTrips.map(t => (
                      <PendingCard
                        key={t.id}
                        trip={t}
                        canStart={isAdmin || !!(memberId && (t.team_member_ids ?? []).includes(memberId))}
                        onDetails={() => openDrawer(t.id)}
                        onStart={() => setDetailTripId(t.id)}
                      />
                    ))}
                  </div>
                </section>
              )}

              {/* Completed trips */}
              {completedTrips.length > 0 && (
                <section>
                  <div className={styles.sectionHdr}>
                    <span className={styles.sectionTitle}>Completed Trips</span>
                    <span className={styles.sectionCount}>{completedTrips.length}</span>
                  </div>

                  {/* Desktop table */}
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Project</th>
                          <th>Site</th>
                          <th>Governorate</th>
                          <th>Team</th>
                          <th>Start</th>
                          <th>Duration</th>
                          <th>Status</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {completedTrips.map(t => (
                          <tr key={t.id} className={styles.tableRow} onClick={() => openDrawer(t.id)}>
                            <td>{t.date ? fmtDate(t.date) : '—'}</td>
                            <td>{t.project || '—'}</td>
                            <td>{t.site_id || '—'}</td>
                            <td>{t.governate || '—'}</td>
                            <td>{t.team_member_ids?.length ?? 0}</td>
                            <td>{fmtTime(t.started_at)}</td>
                            <td>{fmtDuration(t.started_at, t.completed_at)}</td>
                            <td><StatusBadge status={t.status} /></td>
                            <td>
                              <button
                                className={styles.tableViewBtn}
                                onClick={e => { e.stopPropagation(); openDrawer(t.id); }}
                              >
                                Details
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Mobile cards */}
                  <div className={styles.mobileCards}>
                    {completedTrips.map(t => (
                      <MobileCard key={t.id} trip={t} onView={() => openDrawer(t.id)} />
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>

        {/* ── Trip detail drawer ── */}
        {drawerTripId && (
          <TripDetailDrawer
            loading={drawerLoading}
            data={drawerData}
            onClose={closeDrawer}
            onFullModal={() => { const id = drawerTripId; closeDrawer(); setDetailTripId(id); }}
          />
        )}
      </div>

      {/* ── Full TripDetailModal (map + actions) ── */}
      {detailTripId && (
        <TripDetailModal
          tripId={detailTripId}
          memberId={memberId}
          currentUser={currentUser}
          onClose={() => setDetailTripId(null)}
          onTripUpdated={loadTrips}
        />
      )}

      {/* ── Toast ── */}
      {toast && (
        <div className={`${styles.toast} ${toast.ok ? styles.toastOk : styles.toastErr}`} role="alert">
          {toast.msg}
        </div>
      )}
    </div>
  );
}
