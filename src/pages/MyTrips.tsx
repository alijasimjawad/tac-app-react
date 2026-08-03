import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import L from 'leaflet';
import { addBaseLayer } from '../lib/mapboxTiles';
import 'leaflet/dist/leaflet.css';
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
  pickPrimaryPosition,
} from '../lib/tripTypes';
import { haversineKm } from '../lib/sitesNearest';
import { getRoadRoute } from '../lib/roadRouting';
import TripDetailModal from '../components/TripDetailModal';
import styles from './MyTrips.module.css';

// Only re-request a road route if the driver has moved at least this far
// since the last route we drew for the hero card map — same throttle used
// by the full trip detail modal, to keep ORS calls sane on a live poll.
const HERO_ROUTE_REDRAW_KM = 0.2;
// Hard floor between ORS network calls, independent of movement — protects
// the free-tier quota/rate-limit from being hammered by frequent polling
// across multiple open trip cards/modals at once.
const HERO_ROUTE_MIN_INTERVAL_MS = 30000;

// ── Trip phases ───────────────────────────────────────────────────────────────

const PHASES = [
  'Meeting Point',
  'Team Joining',
  'Travelling',
  'Site Arrival',
  'Work in Progress',
  'Completed',
] as const;

const PHASE_KEYS = [
  'trips_phase_meeting',
  'trips_phase_joining',
  'trips_phase_travelling',
  'trips_phase_arrival',
  'trips_phase_wip',
  'trips_phase_completed',
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

type TFn = (key: string, opts?: Record<string, unknown>) => string;

function fmtTimeAgo(isoStr: string | null, t: TFn): string {
  if (!isoStr) return '';
  const secs = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);
  if (secs < 5)   return t('trips_justNow');
  if (secs < 60)  return t('trips_secAgo', { n: secs });
  const mins = Math.floor(secs / 60);
  if (mins < 60)  return t('trips_minAgo', { n: mins });
  return t('trips_hrAgo', { n: Math.floor(mins / 60) });
}

// ── SVG Icons ─────────────────────────────────────────────────────────────────

const IcPlus      = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>;
const IcBriefcase = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>;
const IcUsers     = ({ size=16 }:{ size?:number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>;
const IcClock     = ({ size=16 }:{ size?:number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
const IcCheck     = ({ size=14 }:{ size?:number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>;
const IcMap       = ({ size=13 }:{ size?:number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>;
const IcSearch    = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>;
const IcX         = ({ size=16 }:{ size?:number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>;
const IcPin       = ({ size=14 }:{ size?:number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>;
const IcExternal  = ({ size=13 }:{ size?:number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>;
const IcActivity  = ({ size=13 }:{ size?:number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>;
const IcDotsH     = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>;

// ── Status Badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  const cls =
    status === 'active'    ? styles.badgeActive    :
    status === 'departed'  ? styles.badgeDeparted  :
    status === 'completed' ? styles.badgeCompleted :
    styles.badgePending;
  const label =
    status === 'active'    ? t('trips_statusActive')    :
    status === 'departed'  ? t('trips_statusDeparted')  :
    status === 'completed' ? t('trips_statusCompleted') :
    t('trips_statusPending');
  return <span className={`${styles.badge} ${cls}`}>{label}</span>;
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

// ── Phase Progress (compact) ──────────────────────────────────────────────────

function PhaseProgress({ currentIndex }: { currentIndex: number }) {
  const { t } = useTranslation();
  return (
    <div className={styles.phaseProgress} role="list" aria-label="Trip progress phases">
      {PHASES.map((phase, i) => {
        const done   = i < currentIndex;
        const active = i === currentIndex;
        return (
          <div key={phase} className={styles.phaseStep} role="listitem" aria-current={active ? 'step' : undefined}>
            <div className={styles.phaseDotRow}>
              <div className={`${styles.phaseConn} ${i > 0 && i <= currentIndex ? styles.phaseConnFilled : ''} ${i === 0 ? styles.phaseConnHide : ''}`} />
              <div className={`${styles.phaseDot} ${done ? styles.phaseDotDone : active ? styles.phaseDotActive : ''}`}>
                {done ? <IcCheck size={8} /> : <span className={styles.phaseDotNum}>{i + 1}</span>}
              </div>
              <div className={`${styles.phaseConn} ${i < currentIndex ? styles.phaseConnFilled : ''} ${i === PHASES.length - 1 ? styles.phaseConnHide : ''}`} />
            </div>
            <div className={`${styles.phaseLabel} ${active ? styles.phaseLabelActive : done ? styles.phaseLabelDone : ''}`}>
              {t(PHASE_KEYS[i])}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Active Trip Hero (2-column with map) ──────────────────────────────────────

function ActiveTripHero({
  trip,
  participants,
  onDetails,
  onFullModal,
  onLive,
}: {
  trip: FieldTrip;
  participants: TripParticipant[];
  onDetails: () => void;
  onFullModal: () => void;
  onLive: () => void;
}) {
  const mapDivRef       = useRef<HTMLDivElement>(null);
  const mapRef          = useRef<L.Map | null>(null);
  const markersRef      = useRef<L.Marker[]>([]);
  const siteMarkerRef   = useRef<L.Marker | null>(null);
  const siteCoordsRef   = useRef<{ lat: number; lng: number } | null>(null);
  const routeLineRef    = useRef<L.Polyline | null>(null);
  const routeOriginRef  = useRef<{ lat: number; lng: number } | null>(null);
  const lastRouteFetchAtRef = useRef<number>(0);

  const phase       = phaseIndex(trip.status);
  const joinedCount = participants.filter(p => p.status === 'joined').length;
  const ppCount     = participants.length;

  const latestLocAt = participants.reduce<string | null>((best, p) => {
    if (!p.last_location_at) return best;
    return !best || new Date(p.last_location_at) > new Date(best) ? p.last_location_at : best;
  }, null);
  const { t } = useTranslation();
  const liveActive     = !!latestLocAt && (Date.now() - new Date(latestLocAt).getTime()) < 120_000;
  const locationLabel  = liveActive ? t('trips_locationActive') : latestLocAt ? t('trips_locationLast') : t('trips_locationNA');
  const locationSubtxt = latestLocAt ? fmtTimeAgo(latestLocAt, t) : '';

  // init map once
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!mapDivRef.current || mapRef.current) return;
      const map = L.map(mapDivRef.current, { zoomControl: false, attributionControl: false }).setView([33.3, 44.4], 7);
      addBaseLayer(map, 'streets', { attributionControl: false });
      mapRef.current = map;
      setTimeout(() => map.invalidateSize(), 200);
    }, 150);
    return () => {
      clearTimeout(timer);
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
    };
  }, []);

  // fetch the site's coordinates once (or whenever the site changes)
  useEffect(() => {
    if (!trip.site_id) { siteCoordsRef.current = null; return; }
    let cancelled = false;
    supabase
      .from('sites').select('latitude, longitude').eq('site_code', trip.site_id).single()
      .then(({ data }) => {
        if (cancelled) return;
        siteCoordsRef.current = data?.latitude && data?.longitude ? { lat: data.latitude, lng: data.longitude } : null;
      });
    return () => { cancelled = true; };
  }, [trip.site_id]);

  // (re)draw the driving route from a live position to the site — mirrors the
  // logic in TripDetailModal.tsx so both maps behave the same way. Falls back
  // to a plain straight line if the real road route can't be fetched (e.g. no
  // ORS token configured), so a directional indicator is always shown.
  async function drawRouteToSite(lat: number, lng: number) {
    if (!mapRef.current || !siteCoordsRef.current) return;
    const prev = routeOriginRef.current;
    if (prev && haversineKm(prev.lat, prev.lng, lat, lng) < HERO_ROUTE_REDRAW_KM) return;
    if (Date.now() - lastRouteFetchAtRef.current < HERO_ROUTE_MIN_INTERVAL_MS) return;
    const site = siteCoordsRef.current;
    routeOriginRef.current = { lat, lng };
    lastRouteFetchAtRef.current = Date.now();

    const route = await getRoadRoute([
      { latitude: lat, longitude: lng },
      { latitude: site.lat, longitude: site.lng },
    ]);
    if (!mapRef.current) return;
    if (routeLineRef.current) { mapRef.current.removeLayer(routeLineRef.current); routeLineRef.current = null; }

    if (!route) {
      console.warn('[ActiveTripHero] getRoadRoute() returned null — falling back to straight line. Check VITE_MAPBOX_TOKEN is set for this environment.');
      routeLineRef.current = L.polyline([[lat, lng], [site.lat, site.lng]], {
        color: '#94a3b8', weight: 3, opacity: 0.7, dashArray: '4,8', lineCap: 'round',
      }).addTo(mapRef.current);
      return;
    }

    routeLineRef.current = L.polyline(route.geometry, {
      color: '#2563eb', weight: 4, opacity: 0.75, dashArray: '1,8', lineCap: 'round',
    }).addTo(mapRef.current);
  }

  // update markers (+ site marker + route) when participants change
  useEffect(() => {
    if (!mapRef.current) return;
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];

    const bounds: [number, number][] = [];
    participants.forEach(p => {
      if (!p.last_lat || !p.last_lng || !mapRef.current) return;
      const icon = L.divIcon({
        className: '',
        html: `<div style="background:#2563eb;color:#fff;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.2)">${initials(p.member_name)}</div>`,
        iconSize: [22, 22], iconAnchor: [11, 11],
      });
      const marker = L.marker([p.last_lat, p.last_lng], { icon }).addTo(mapRef.current);
      markersRef.current.push(marker);
      bounds.push([p.last_lat, p.last_lng]);
    });

    if (siteCoordsRef.current && mapRef.current) {
      const site = siteCoordsRef.current;
      if (siteMarkerRef.current) { mapRef.current.removeLayer(siteMarkerRef.current); siteMarkerRef.current = null; }
      const siteIcon = L.divIcon({
        className: '',
        html: `<div style="background:#16a34a;color:#fff;border-radius:6px;padding:2px 6px;font-size:10px;font-weight:700;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.25);white-space:nowrap">${trip.site_id || 'Site'}</div>`,
        iconSize: undefined, iconAnchor: [0, 0],
      });
      siteMarkerRef.current = L.marker([site.lat, site.lng], { icon: siteIcon })
        .bindPopup(`Site: ${trip.site_id || ''}`).addTo(mapRef.current);
      bounds.push([site.lat, site.lng]);
    }

    if (bounds.length > 1) mapRef.current.fitBounds(bounds, { padding: [20, 20] });
    else if (bounds.length === 1) mapRef.current.setView(bounds[0], 13);

    if (['active', 'departed'].includes(trip.status)) {
      const primary = pickPrimaryPosition(participants);
      if (primary) void drawRouteToSite(primary.lat, primary.lng);
    }
  }, [participants, trip.status, trip.site_id]);

  return (
    <div className={styles.heroCard}>
      {/* ── Top bar: LIVE + actions ── */}
      <div className={styles.heroTopBar}>
        <div className={styles.heroLiveLabel}>
          <span className={styles.heroPulse} />
          LIVE
        </div>
        <div className={styles.heroTopActions}>
          <button className={styles.heroBtnPrimary} onClick={onLive}>
            <IcExternal /> {t('trips_openLive')}
          </button>
          <button className={styles.heroBtnSecondary} onClick={onFullModal}>
            <IcMap /> {t('trips_viewMapOnly')}
          </button>
          <button className={styles.heroMoreBtn} onClick={onDetails} title="Trip details" aria-label="Trip details">
            <IcDotsH />
          </button>
        </div>
      </div>

      {/* ── Title + status ── */}
      <div className={styles.heroTitleRow}>
        <div>
          <div className={styles.heroTitle}>
            {trip.project || '—'}
            {trip.site_id && <span className={styles.heroSite}> · {trip.site_id}</span>}
          </div>
          <div className={styles.heroMeta}>
            {trip.date ? fmtDateLong(trip.date) : '—'}
            {trip.governate && ` · ${trip.governate}`}
            {trip.started_at && t('trips_startedInfo', { time: fmtTime(trip.started_at) })}
          </div>
        </div>
        <StatusBadge status={trip.status} />
      </div>

      {/* ── 2-column body ── */}
      <div className={styles.heroBody}>

        {/* Left: metrics + team members */}
        <div className={styles.heroLeft}>

          {/* 4 metric blocks */}
          <div className={styles.heroMetrics}>
            <div className={styles.heroMetric}>
              <div className={styles.heroMetricLabel}>{t('trips_currentPhase')}</div>
              <div className={styles.heroMetricValue}>{t(PHASE_KEYS[phase])}</div>
            </div>
            <div className={styles.heroMetricSep} />
            <div className={styles.heroMetric}>
              <div className={styles.heroMetricLabel}>{t('trips_teamJoined')}</div>
              <div className={styles.heroMetricValue}>
                {ppCount > 0 ? `${joinedCount} of ${ppCount}` : '—'}
              </div>
              {ppCount > 0 && (
                <div className={styles.heroMetricSub}>
                  {Math.round((joinedCount / ppCount) * 100)}%
                </div>
              )}
            </div>
            <div className={styles.heroMetricSep} />
            <div className={styles.heroMetric}>
              <div className={styles.heroMetricLabel}>{t('trips_meetingPoint')}</div>
              <div className={styles.heroMetricValue}>
                {trip.started_at ? t('trips_confirmed') : t('trips_pending')}
              </div>
            </div>
            <div className={styles.heroMetricSep} />
            <div className={styles.heroMetric}>
              <div className={styles.heroMetricLabel}>{t('trips_liveLocation')}</div>
              <div className={`${styles.heroMetricValue} ${liveActive ? styles.heroMetricGreen : ''}`}>
                {locationLabel}
              </div>
              {locationSubtxt && (
                <div className={styles.heroMetricSub}>{locationSubtxt}</div>
              )}
            </div>
          </div>

          {/* Team members */}
          {participants.length > 0 && (
            <div className={styles.heroTeamSection}>
              <div className={styles.heroTeamLabel}>{t('trips_teamMembers')}</div>
              <div className={styles.heroTeamList}>
                {participants.map(p => (
                  <div key={p.id} className={styles.heroMember}>
                    <div className={styles.heroMemberAvatar}>{initials(p.member_name)}</div>
                    <div className={styles.heroMemberInfo}>
                      <div className={styles.heroMemberName}>{p.member_name || p.member_id}</div>
                      <div className={styles.heroMemberSub}>
                        {p.status === 'joined'
                          ? t('trips_joinedAt', { time: p.joined_at ? fmtTime(p.joined_at) : '' })
                          : (p.status ?? 'pending')}
                        {(p.delay_minutes ?? 0) > 0 && (
                          <span className={styles.delayTag}> +{p.delay_minutes}min</span>
                        )}
                      </div>
                    </div>
                    {p.last_lat && p.last_lng && (
                      <span className={styles.liveTag}>{t('trips_live')}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: map */}
        <div className={styles.heroRight}>
          <div ref={mapDivRef} className={styles.heroMap} />
          <button className={styles.detailsDrawerBtn} onClick={onDetails}>
            <IcActivity /> {t('trips_tripDetails')}
          </button>
        </div>
      </div>

      {/* ── Phase stepper (compact, pinned to bottom of card) ── */}
      <div className={styles.heroPhaseWrap}>
        <PhaseProgress currentIndex={phase} />
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
  const { t } = useTranslation();
  const teamCount = trip.team_member_ids?.length ?? 0;
  return (
    <div className={styles.pendingCard}>
      <div className={styles.pendingCardBody}>
        <div className={styles.pendingBadge}><IcClock size={10} /> {t('trips_pending')}</div>
        <div className={styles.pendingTitle}>
          {trip.project || '—'}
          {trip.site_id && <span className={styles.pendingSite}> · {trip.site_id}</span>}
        </div>
        <div className={styles.pendingMeta}>
          {trip.date ? fmtDateLong(trip.date) : '—'}
          {trip.governate && ` · ${trip.governate}`}
        </div>
        <div className={styles.pendingTeam}>
          <IcUsers size={11} /> {t('trips_teamCount', { count: teamCount })}
        </div>
      </div>
      <div className={styles.pendingCardActions}>
        {canStart && (
          <button className={styles.startBtn} onClick={onStart}>
            <IcActivity size={12} /> {t('trips_startTrip')}
          </button>
        )}
        <button className={styles.detailsLink} onClick={onDetails}>{t('trips_viewDetails')}</button>
      </div>
    </div>
  );
}

// ── Mobile Completed Card ─────────────────────────────────────────────────────

function MobileCard({ trip, onView }: { trip: FieldTrip; onView: () => void }) {
  const { t } = useTranslation();
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
        {trip.date ? fmtDateLong(trip.date) : '—'}{trip.governate && ` · ${trip.governate}`}
      </div>
      <div className={styles.mobileCardMeta}>
        <IcUsers size={11} /> {t('trips_teamCount', { count: trip.team_member_ids?.length ?? 0 })}
      </div>
      <button className={styles.mobileCardBtn}>{t('trips_viewDetails')}</button>
    </div>
  );
}

// ── Empty State ───────────────────────────────────────────────────────────────

function EmptyState({ hasFilter }: { hasFilter: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={styles.emptyState}>
      <div className={styles.emptyIcon}><IcBriefcase /></div>
      <div className={styles.emptyTitle}>
        {hasFilter ? t('trips_noTripsMatch') : t('trips_noTripsYet')}
      </div>
      <div className={styles.emptySub}>
        {hasFilter ? t('trips_noTripsMatchDesc') : t('trips_noTripsYetDesc')}
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
  const { t }    = useTranslation();
  const trip     = data?.trip ?? null;
  const pp       = data?.participants ?? [];
  const timeline = trip ? buildTimeline(trip, pp) : [];
  const meetingPp = pp.find(p => p.last_lat && p.last_lng);

  return (
    <aside className={styles.drawer} aria-label="Trip details" role="complementary">
      <div className={styles.drawerHeader}>
        <div className={styles.drawerTitle}>{t('trips_tripDetails')}</div>
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
          <div className={styles.drawerEmpty}>{t('trips_unableLoad')}</div>
        ) : (
          <>
            <div className={styles.drawerTripTitle}>
              {trip.project || '—'}
              {trip.site_id && <span className={styles.drawerTripSite}> · {trip.site_id}</span>}
            </div>
            <StatusBadge status={trip.status} />

            <div className={styles.drawerSection}>
              <div className={styles.drawerSectionTitle}>{t('trips_tripOverview')}</div>
              <div className={styles.overviewGrid}>
                {trip.project    && <OverviewRow label="Project"     value={trip.project} />}
                {trip.site_id    && <OverviewRow label="Site ID"     value={trip.site_id} />}
                {trip.date       && <OverviewRow label="Date"        value={fmtDateLong(trip.date)} />}
                <OverviewRow label="Status" value={trip.status} />
                {trip.governate  && <OverviewRow label="Governorate" value={trip.governate} />}
                {trip.notes      && <OverviewRow label="Notes"       value={trip.notes} />}
                {trip.started_at    && <OverviewRow label="Started"   value={fmtTime(trip.started_at)} />}
                {trip.departed_at   && <OverviewRow label="Departed"  value={fmtTime(trip.departed_at)} />}
                {trip.completed_at  && <OverviewRow label="Completed" value={fmtTime(trip.completed_at)} />}
                {trip.started_at    && <OverviewRow label="Duration"  value={fmtDuration(trip.started_at, trip.completed_at)} />}
                {trip.started_by_name && <OverviewRow label="Trip Leader" value={trip.started_by_name} />}
              </div>
            </div>

            {pp.length > 0 && (
              <div className={styles.drawerSection}>
                <div className={styles.drawerSectionTitle}>{t('trips_teamMembers')}</div>
                {pp.map(p => (
                  <div key={p.id} className={styles.drawerMember}>
                    <div className={styles.drawerMemberAvatar}>{initials(p.member_name)}</div>
                    <div className={styles.drawerMemberInfo}>
                      <div className={styles.drawerMemberName}>{p.member_name || p.member_id}</div>
                      <div className={styles.drawerMemberSub}>
                        {p.status === 'joined'
                          ? t('trips_joinedAt', { time: p.joined_at ? fmtTime(p.joined_at) : '' })
                          : (p.status ?? 'pending')}
                        {(p.delay_minutes ?? 0) > 0 && (
                          <span className={styles.delayBadge}> +{p.delay_minutes}min</span>
                        )}
                      </div>
                    </div>
                    {p.last_lat && p.last_lng && <span className={styles.liveBadge}>{t('trips_live')}</span>}
                  </div>
                ))}
              </div>
            )}

            {meetingPp && (
              <div className={styles.drawerSection}>
                <div className={styles.drawerSectionTitle}>{t('trips_meetingPoint')}</div>
                <div className={styles.meetingPoint}>
                  <IcPin size={16} />
                  <div>
                    <div className={styles.meetingLabel}>{t('trips_bestStart')}</div>
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

            {timeline.length > 0 && (
              <div className={styles.drawerSection}>
                <div className={styles.drawerSectionTitle}>{t('trips_timeline')}</div>
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
              <IcMap size={13} /> {t('trips_viewMap')}
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
  const { t } = useTranslation();

  // preserved state
  const [memberId, setMemberId]             = useState<string | null>(null);
  const [memberResolved, setMemberResolved] = useState(false);
  const [trips, setTrips]                   = useState<FieldTrip[]>([]);
  const [loading, setLoading]               = useState(true);
  const [toast, setToast]                   = useState<{ msg: string; ok: boolean } | null>(null);

  // participants for the active trip hero
  const [activePp, setActivePp]             = useState<TripParticipant[]>([]);

  // drawer state
  const [drawerTripId, setDrawerTripId]     = useState<string | null>(null);
  const [drawerData, setDrawerData]         = useState<{ trip: FieldTrip; participants: TripParticipant[] } | null>(null);
  const [drawerLoading, setDrawerLoading]   = useState(false);

  // full modal (map + actions)
  const [detailTripId, setDetailTripId]     = useState<string | null>(null);

  // filters
  const [search, setSearch]                 = useState('');
  const [filterStatus, setFilterStatus]     = useState('');

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

  // ── derived data ──
  const myTrips = trips.filter(t =>
    Array.isArray(t.team_member_ids) && t.team_member_ids.some(id => id === memberId),
  );
  const displayTrips = isAdmin ? trips : myTrips;

  // ── fetch participants for the first active/departed trip, on a 10s poll,
  // plus push this viewer's own live GPS while they're joined/departed ──
  const activeTripId = displayTrips.find(t => ['active', 'departed'].includes(t.status))?.id ?? null;
  const refreshActivePp = useCallback(async () => {
    if (!activeTripId) { setActivePp([]); return; }
    const { data } = await supabase
      .from('trip_participants').select('*').eq('trip_id', activeTripId).order('member_name');
    const fresh = (data as TripParticipant[]) ?? [];
    setActivePp(fresh);

    // Keep the "meeting point" used by the 100m join-proximity check fresh
    // even when only the hero card (not the full trip detail modal) is open —
    // mirrors the same self-ping TripDetailModal already does.
    if (!memberId) return;
    const myPp = fresh.find(p => p.member_id === memberId);
    if (myPp && ['joined', 'departed'].includes(myPp.status)) {
      navigator.geolocation?.getCurrentPosition(
        pos => {
          const { latitude, longitude } = pos.coords;
          void supabase.from('trip_participants').update({
            last_lat: latitude, last_lng: longitude, last_location_at: new Date().toISOString(),
          }).eq('id', myPp.id);
        },
        () => {},
        { timeout: 8000, enableHighAccuracy: true },
      );
    }
  }, [activeTripId, memberId]);

  useEffect(() => {
    void refreshActivePp();
    if (!activeTripId) return;
    const id = setInterval(refreshActivePp, 10000);
    return () => clearInterval(id);
  }, [activeTripId, refreshActivePp]);

  // ── filters ──
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

  // summary counts from displayTrips
  const totalCount      = displayTrips.length;
  const activeCount     = displayTrips.filter(t => ['active', 'departed'].includes(t.status)).length;
  const pendingCount    = displayTrips.filter(t => t.status === 'pending').length;
  const completedCount  = displayTrips.filter(t => t.status === 'completed').length;
  const liveMemberCount = displayTrips
    .filter(t => ['active', 'departed'].includes(t.status))
    .reduce((s, t) => s + (t.team_member_ids?.length ?? 0), 0);

  const hasFilters  = !!search || !!filterStatus;
  const showContent = memberId || isAdmin;

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

  function closeDrawer() { setDrawerTripId(null); setDrawerData(null); }

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDrawer(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  if (!hasPerm('view_my_trips')) {
    return (
      <div className={styles.page}>
        <p className={styles.denied}>{t('trips_noPermission')}</p>
      </div>
    );
  }

  const summaryGridCls = `${styles.summaryGrid}${liveMemberCount > 0 ? ' ' + styles.summaryGrid5 : ''}`;

  return (
    <div className={styles.page}>

      {/* ── Page header ── */}
      <div className={styles.pageHeader}>
        <div>
          <h2 className={styles.pageTitle}>{t('trips_title')}</h2>
          <p className={styles.pageSub}>{t('trips_subtitle')}</p>
        </div>
        {isAdmin && (
          <button
            className={styles.newTripBtn}
            onClick={() => showToast(t('trips_autoFromDA'), true)}
          >
            <IcPlus /> {t('trips_newTrip')}
          </button>
        )}
      </div>

      {/* ── Not linked ── */}
      {memberResolved && !memberId && !isAdmin && (
        <div className={styles.notLinked}>
          <strong>{t('trips_noTeamProfile')}</strong>
          <p>Field trip tracking is for field engineers and technicians.</p>
        </div>
      )}

      {/* ── Summary cards ── */}
      {showContent && (
        <div className={summaryGridCls}>
          <SummaryCard icon={<IcBriefcase />} label={t('trips_totalTrips')}  value={loading ? '—' : totalCount}    sub={t('trips_allTime')}       iconCls={styles.summaryIconSlate}  />
          <SummaryCard icon={<IcActivity />}  label={t('trips_active')}       value={loading ? '—' : activeCount}   sub={t('trips_inProgress')}    iconCls={styles.summaryIconGreen}  />
          <SummaryCard icon={<IcClock />}     label={t('trips_pending')}      value={loading ? '—' : pendingCount}  sub={t('trips_upcoming')}       iconCls={styles.summaryIconAmber}  />
          <SummaryCard icon={<IcCheck />}     label={t('trips_completed')}    value={loading ? '—' : completedCount} sub={t('trips_finished')}      iconCls={styles.summaryIconBlue}   />
          {liveMemberCount > 0 && (
            <SummaryCard icon={<IcUsers />}   label={t('trips_teamLive')}    value={liveMemberCount}                sub={t('trips_membersActive')} iconCls={styles.summaryIconTeal}   />
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
              placeholder={t('trips_searchPh')}
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
            <option value="">{t('trips_allStatuses')}</option>
            <option value="active">{t('trips_filterActive')}</option>
            <option value="departed">{t('trips_filterDeparted')}</option>
            <option value="pending">{t('trips_filterPending')}</option>
            <option value="completed">{t('trips_filterCompleted')}</option>
          </select>
          {hasFilters && (
            <button className={styles.clearBtn} onClick={() => { setSearch(''); setFilterStatus(''); }}>
              {t('trips_clear')}
            </button>
          )}
          <span className={styles.resultCount}>
            {t('trips_results', { count: filteredTrips.length })}
          </span>
        </div>
      )}

      {/* ── Content area ── */}
      <div className={styles.mainCol}>
        {loading && (
          <div className={styles.skeletonStack}>
            <div className={`${styles.skeleton} ${styles.skeletonHero}`} />
            <div className={`${styles.skeleton} ${styles.skeletonCard}`} />
            <div className={`${styles.skeleton} ${styles.skeletonCard}`} />
          </div>
        )}

        {!loading && showContent && filteredTrips.length === 0 && displayTrips.length > 0 && <EmptyState hasFilter />}
        {!loading && showContent && displayTrips.length === 0 && <EmptyState hasFilter={false} />}

        {!loading && showContent && filteredTrips.length > 0 && (
          <>
            {/* Active / departed hero */}
            {activeOrDeparted.length > 0 && (
              <ActiveTripHero
                trip={activeOrDeparted[0]}
                participants={activePp}
                onDetails={() => openDrawer(activeOrDeparted[0].id)}
                onFullModal={() => setDetailTripId(activeOrDeparted[0].id)}
                onLive={() => navigate('/live-trips')}
              />
            )}

            {/* Pending trips */}
            {pendingTrips.length > 0 && (
              <section>
                <div className={styles.sectionHdr}>
                  <span className={styles.sectionTitle}>{t('trips_pendingSection')}</span>
                  <span className={styles.sectionCount}>{pendingTrips.length}</span>
                </div>
                <div className={styles.pendingList}>
                  {pendingTrips.map(pt => (
                    <PendingCard
                      key={pt.id}
                      trip={pt}
                      canStart={isAdmin || !!(memberId && (pt.team_member_ids ?? []).includes(memberId))}
                      onDetails={() => openDrawer(pt.id)}
                      onStart={() => setDetailTripId(pt.id)}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Completed trips */}
            {completedTrips.length > 0 && (
              <section>
                <div className={styles.sectionHdr}>
                  <span className={styles.sectionTitle}>{t('trips_completedSection')}</span>
                  <span className={styles.sectionCount}>{completedTrips.length}</span>
                </div>
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>{t('trips_dateCol')}</th>
                        <th>{t('trips_projectCol')}</th>
                        <th>{t('trips_siteCol')}</th>
                        <th>{t('trips_govCol')}</th>
                        <th>{t('trips_teamCol')}</th>
                        <th>{t('trips_startCol')}</th>
                        <th>{t('trips_endCol')}</th>
                        <th>{t('trips_durationCol')}</th>
                        <th>{t('trips_statusCol')}</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {completedTrips.map(ct => (
                        <tr key={ct.id} className={styles.tableRow} onClick={() => openDrawer(ct.id)}>
                          <td>{ct.date ? fmtDate(ct.date) : '—'}</td>
                          <td>{ct.project || '—'}</td>
                          <td>{ct.site_id || '—'}</td>
                          <td>{ct.governate || '—'}</td>
                          <td>{ct.team_member_ids?.length ?? 0}</td>
                          <td>{fmtTime(ct.started_at)}</td>
                          <td>{fmtTime(ct.completed_at)}</td>
                          <td>{fmtDuration(ct.started_at, ct.completed_at)}</td>
                          <td><StatusBadge status={ct.status} /></td>
                          <td>
                            <button
                              className={styles.tableViewBtn}
                              onClick={e => { e.stopPropagation(); openDrawer(ct.id); }}
                            >
                              {t('trips_detailsBtn')}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className={styles.mobileCards}>
                  {completedTrips.map(ct => (
                    <MobileCard key={ct.id} trip={ct} onView={() => openDrawer(ct.id)} />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>

      {/* ── Drawer ── */}
      {drawerTripId && (
        <TripDetailDrawer
          loading={drawerLoading}
          data={drawerData}
          onClose={closeDrawer}
          onFullModal={() => { const id = drawerTripId; closeDrawer(); setDetailTripId(id); }}
        />
      )}

      {/* ── Full modal (map + actions) ── */}
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
