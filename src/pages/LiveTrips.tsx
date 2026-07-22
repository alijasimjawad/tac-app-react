import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { type FieldTrip, type TripParticipant, fmtDate, fmtTime, initials, buildTimeline } from '../lib/tripTypes';
import TripDetailModal from '../components/TripDetailModal';
import styles from './LiveTrips.module.css';

interface TripWithPP extends FieldTrip {
  trip_participants: TripParticipant[];
}

export default function LiveTrips() {
  const { currentUser } = useAuth();
  const [activeTrips, setActiveTrips] = useState<TripWithPP[]>([]);
  const [completedTrips, setCompletedTrips] = useState<TripWithPP[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailTripId, setDetailTripId] = useState<string | null>(null);
  const [completing, setCompleting] = useState<string | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const isAdmin = currentUser?.role === 'admin';

  function showToast(msg: string, ok: boolean) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }

  async function loadData() {
    setLoading(true);
    const [{ data: active, error: e1 }, { data: completed }] = await Promise.all([
      supabase
        .from('field_trips')
        .select('*,trip_participants(*)')
        .in('status', ['active', 'departed'])
        .order('started_at', { ascending: false }),
      supabase
        .from('field_trips')
        .select('*,trip_participants(*)')
        .eq('status', 'completed')
        .order('completed_at', { ascending: false })
        .limit(20),
    ]);
    if (e1) showToast('Failed to load trips: ' + e1.message, false);
    setActiveTrips((active as TripWithPP[]) ?? []);
    setCompletedTrips((completed as TripWithPP[]) ?? []);
    setLoading(false);
  }

  useEffect(() => { loadData(); }, []);

  async function forceComplete(tripId: string) {
    setCompleting(tripId);
    const { error } = await supabase
      .from('field_trips')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', tripId);
    setCompleting(null);
    if (error) { showToast('Force complete failed: ' + error.message, false); return; }
    showToast('Trip marked complete.', true);
    loadData();
  }

  function toggleRow(id: string) {
    setExpandedRows(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  if (!isAdmin) {
    return (
      <div className={styles.page}>
        <div className={styles.denied}>You don't have permission to view this page.</div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Live Trips</h1>
        <button className={styles.refreshBtn} onClick={loadData} disabled={loading}>
          <RefreshIcon /> {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* Active / Departed section */}
      <div className={styles.sectionLabel}>
        Active ({activeTrips.length})
      </div>

      {loading ? (
        <div className={styles.empty}>Loading…</div>
      ) : activeTrips.length === 0 ? (
        <div className={styles.empty} style={{ marginBottom: 24 }}>No active trips right now.</div>
      ) : (
        <div className={styles.liveGrid}>
          {activeTrips.map(t => (
            <LiveTripCard
              key={t.id}
              trip={t}
              isCompleting={completing === t.id}
              onView={() => setDetailTripId(t.id)}
              onForceComplete={() => forceComplete(t.id)}
            />
          ))}
        </div>
      )}

      {/* Completed history table */}
      {!loading && (
        <>
          <div className={styles.sectionLabel} style={{ marginTop: 24 }}>
            Recent Completed Trips
          </div>
          {completedTrips.length === 0 ? (
            <div className={styles.empty}>No completed trips yet.</div>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Project</th>
                    <th>Site</th>
                    <th>Governate</th>
                    <th>Team</th>
                    <th>Max Delay</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {completedTrips.map(t => {
                    const pp = t.trip_participants || [];
                    const maxDelay = pp.reduce((mx, p) => Math.max(mx, p.delay_minutes || 0), 0);
                    const events = buildTimeline(t, pp);
                    const expanded = expandedRows.has(t.id);
                    return (
                      <>
                        <tr key={t.id} className={styles.histRow} onClick={() => toggleRow(t.id)}>
                          <td>{t.date ? fmtDate(t.date) : '—'}</td>
                          <td>{t.project || '—'}</td>
                          <td>{t.site_id || '—'}</td>
                          <td>{t.governate || '—'}</td>
                          <td>{pp.length}</td>
                          <td>{maxDelay ? `${maxDelay}min` : '—'}</td>
                          <td className={styles.histActions}>
                            <button
                              className={styles.viewBtn}
                              onClick={e => { e.stopPropagation(); setDetailTripId(t.id); }}
                            >
                              View
                            </button>
                            <span className={styles.chevron}>{expanded ? '▴' : '▾'}</span>
                          </td>
                        </tr>
                        {expanded && (
                          <tr key={`${t.id}-tl`} className={styles.tlRow}>
                            <td colSpan={7}>
                              {events.length === 0 ? (
                                <span className={styles.tlEmpty}>No timeline events yet.</span>
                              ) : (
                                <ul className={styles.inlineTl}>
                                  {events.map((e, i) => (
                                    <li key={i} className={styles.inlineTlItem}>
                                      <span>{e.label}</span>
                                      <span className={styles.inlineTlTime}>{e.time}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {detailTripId && (
        <TripDetailModal
          tripId={detailTripId}
          memberId={null}
          currentUser={currentUser}
          onClose={() => setDetailTripId(null)}
          onTripUpdated={loadData}
        />
      )}

      {toast && (
        <div className={`${styles.toast} ${toast.ok ? styles.toastOk : styles.toastErr}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ── Mini live-trip card with its own Leaflet map ──
function LiveTripCard({
  trip,
  isCompleting,
  onView,
  onForceComplete,
}: {
  trip: TripWithPP;
  isCompleting: boolean;
  onView: () => void;
  onForceComplete: () => void;
}) {
  const pp = trip.trip_participants || [];
  const joined = pp.filter(p => p.status === 'joined').length;
  const events = buildTimeline(trip, pp);
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      if (!mapDivRef.current || mapRef.current) return;
      const map = L.map(mapDivRef.current, { zoomControl: false, attributionControl: false }).setView([33.3, 44.4], 7);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
      mapRef.current = map;
      const bounds: [number, number][] = [];
      pp.forEach(p => {
        if (!p.last_lat || !p.last_lng) return;
        const icon = L.divIcon({
          className: '',
          html: `<div style="background:#2563eb;color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;border:2px solid #fff;box-shadow:0 2px 4px rgba(0,0,0,.2)">${initials(p.member_name)}</div>`,
          iconSize: [24, 24], iconAnchor: [12, 12],
        });
        L.marker([p.last_lat, p.last_lng], { icon }).addTo(map);
        bounds.push([p.last_lat, p.last_lng]);
      });
      if (bounds.length > 1) map.fitBounds(bounds, { padding: [20, 20] });
      else if (bounds.length === 1) map.setView(bounds[0], 13);
      setTimeout(() => map.invalidateSize(), 150);
    }, 150);
    return () => {
      clearTimeout(t);
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
    };
  }, []);

  const badgeCls = trip.status === 'active' ? styles.badgeActive : styles.badgeDeparted;

  return (
    <div className={styles.liveCard}>
      <div className={styles.liveCardTitle}>
        {trip.project || '—'}
        {trip.site_id && <span className={styles.liveCardSite}> · {trip.site_id}</span>}
        <span className={`${styles.badge} ${badgeCls}`}>{trip.status}</span>
      </div>
      <div className={styles.liveCardSub}>
        {trip.date ? fmtDate(trip.date) : '—'}
        {trip.governate && ` · ${trip.governate}`}
        {trip.started_by_name && (
          <span> · Started by <strong>{trip.started_by_name}</strong>
            {trip.started_at && ` at ${fmtTime(trip.started_at)}`}
          </span>
        )}
      </div>

      {/* Mini map */}
      <div className={styles.miniMap} ref={mapDivRef} />

      <div className={styles.pSummary}>
        {joined}/{pp.length} joined
        {pp.length > 0 && ` · ${pp.filter(p => p.status === 'pending').length} pending`}
      </div>

      {/* Mini timeline */}
      {events.length > 0 && (
        <ul className={styles.miniTl}>
          {events.map((e, i) => (
            <li key={i} className={styles.miniTlItem}>
              <span>{e.label}</span>
              <span className={styles.miniTlTime}>{e.time}</span>
            </li>
          ))}
        </ul>
      )}

      <div className={styles.liveCardActions}>
        <button className={styles.viewBtn} onClick={onView}>View Detail</button>
        <button className={styles.completeBtn} disabled={isCompleting} onClick={onForceComplete}>
          {isCompleting ? '…' : 'Force Complete'}
        </button>
      </div>
    </div>
  );
}

function RefreshIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}
