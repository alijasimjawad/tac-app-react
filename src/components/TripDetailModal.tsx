import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { supabase } from '../lib/supabase';
import { haversineKm } from '../lib/sitesNearest';
import {
  type FieldTrip,
  type TripParticipant,
  fmtDate,
  fmtTime,
  initials,
  getGps,
  buildTimeline,
} from '../lib/tripTypes';
import type { UserProfile } from '../context/AuthContext';
import styles from './TripDetailModal.module.css';

interface Props {
  tripId: string;
  memberId: string | null;
  currentUser: UserProfile | null;
  onClose: () => void;
  onTripUpdated?: () => void;
}

const REFRESH_MS = 14000;

export default function TripDetailModal({ tripId, memberId, currentUser, onClose, onTripUpdated }: Props) {
  const [detailTrip, setDetailTrip] = useState<FieldTrip | null>(null);
  const [participants, setParticipants] = useState<TripParticipant[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionErr, setActionErr] = useState('');
  const [acting, setActing] = useState(false);

  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const participantMarkersRef = useRef<L.Marker[]>([]);
  const siteMarkerRef = useRef<L.Marker | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const memberIdRef = useRef<string | null>(memberId);
  useEffect(() => { memberIdRef.current = memberId; }, [memberId]);

  const isAdmin = currentUser?.role === 'admin';

  // ── fetch ──
  async function fetchDetail() {
    setLoading(true);
    const [{ data: trip, error }, { data: pp }] = await Promise.all([
      supabase.from('field_trips').select('*').eq('id', tripId).single(),
      supabase.from('trip_participants').select('*').eq('trip_id', tripId).order('member_name'),
    ]);
    if (error || !trip) { setLoading(false); return; }
    setDetailTrip(trip as FieldTrip);
    setParticipants((pp as TripParticipant[]) ?? []);
    setLoading(false);
  }

  useEffect(() => { fetchDetail(); }, [tripId]);

  // ── Leaflet map ──
  useEffect(() => {
    if (!detailTrip) return;
    const t = setTimeout(async () => {
      if (!mapDivRef.current) return;
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
      participantMarkersRef.current = [];
      siteMarkerRef.current = null;

      const map = L.map(mapDivRef.current, { zoomControl: true }).setView([33.3, 44.4], 7);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OSM' }).addTo(map);
      mapRef.current = map;
      const bounds: [number, number][] = [];

      participants.forEach(p => {
        if (!p.last_lat || !p.last_lng) return;
        const icon = L.divIcon({
          className: '',
          html: `<div style="background:#2563eb;color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.25)">${initials(p.member_name)}</div>`,
          iconSize: [28, 28], iconAnchor: [14, 14],
        });
        const m = L.marker([p.last_lat, p.last_lng], { icon })
          .bindPopup(`${p.member_name || p.member_id}<br>${p.status || 'pending'}`)
          .addTo(map);
        participantMarkersRef.current.push(m);
        bounds.push([p.last_lat, p.last_lng]);
      });

      if (detailTrip.site_id) {
        const { data: siteRow } = await supabase
          .from('sites').select('latitude, longitude').eq('site_code', detailTrip.site_id).single();
        if (siteRow?.latitude && siteRow?.longitude) {
          const siteIcon = L.divIcon({
            className: '',
            html: `<div style="background:#16a34a;color:#fff;border-radius:6px;padding:2px 6px;font-size:10px;font-weight:700;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.25);white-space:nowrap">${detailTrip.site_id}</div>`,
            iconSize: undefined, iconAnchor: [0, 0],
          });
          siteMarkerRef.current = L.marker([siteRow.latitude, siteRow.longitude], { icon: siteIcon })
            .bindPopup(`Site: ${detailTrip.site_id}`).addTo(map);
          bounds.push([siteRow.latitude, siteRow.longitude]);
        }
      }

      if (bounds.length > 1) map.fitBounds(bounds, { padding: [30, 30] });
      else if (bounds.length === 1) map.setView(bounds[0], 13);
      setTimeout(() => mapRef.current?.invalidateSize(), 200);
    }, 100);
    return () => clearTimeout(t);
  }, [detailTrip]);

  // ── cleanup on unmount ──
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
    };
  }, []);

  // ── marker refresh ──
  function refreshMapMarkers(pp: TripParticipant[]) {
    if (!mapRef.current) return;
    participantMarkersRef.current.forEach(m => mapRef.current!.removeLayer(m));
    participantMarkersRef.current = [];
    pp.forEach(p => {
      if (!p.last_lat || !p.last_lng || !mapRef.current) return;
      const icon = L.divIcon({
        className: '',
        html: `<div style="background:#2563eb;color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.25)">${initials(p.member_name)}</div>`,
        iconSize: [28, 28], iconAnchor: [14, 14],
      });
      const m = L.marker([p.last_lat, p.last_lng], { icon })
        .bindPopup(`${p.member_name || p.member_id}<br>${p.status || 'pending'}`)
        .addTo(mapRef.current);
      participantMarkersRef.current.push(m);
    });
  }

  // ── 14-second participant refresh ──
  const refreshParticipants = useCallback(async () => {
    const { data: pp } = await supabase
      .from('trip_participants').select('*').eq('trip_id', tripId).order('member_name');
    if (!pp) return;
    const fresh = pp as TripParticipant[];
    setParticipants(fresh);
    refreshMapMarkers(fresh);
    const mid = memberIdRef.current;
    if (!mid) return;
    const myPp = fresh.find(p => p.member_id === mid);
    if (myPp && ['joined', 'departed'].includes(myPp.status)) {
      navigator.geolocation?.getCurrentPosition(
        pos => {
          supabase.from('trip_participants').update({
            last_lat: pos.coords.latitude, last_lng: pos.coords.longitude, last_location_at: new Date().toISOString(),
          }).eq('id', myPp.id).then(() => {});
        },
        () => {},
        { timeout: 8000, enableHighAccuracy: true },
      );
    }
  }, [tripId]);

  useEffect(() => {
    const id = setInterval(refreshParticipants, REFRESH_MS);
    intervalRef.current = id;
    return () => clearInterval(id);
  }, [refreshParticipants]);

  // ── actions ──
  async function handleAction(action: string) {
    setActionErr('');
    setActing(true);
    try {
      if (action === 'start') {
        const { data: freshTrip } = await supabase.from('field_trips').select('*').eq('id', tripId).single();
        if (!freshTrip || freshTrip.status !== 'pending') {
          setActionErr(freshTrip?.started_by_name ? `Already started by ${freshTrip.started_by_name}` : 'Trip already started');
          await fetchDetail(); return;
        }
        let lat: number | null = null, lng: number | null = null;
        try { const pos = await getGps(); lat = pos.coords.latitude; lng = pos.coords.longitude; } catch {}
        const nowIso = new Date().toISOString();
        const myName = currentUser?.full_name || currentUser?.username || '';
        await supabase.from('field_trips').update({ status: 'active', started_at: nowIso, started_by: memberId, started_by_name: myName }).eq('id', tripId);
        const myPp = participants.find(p => p.member_id === memberId);
        if (myPp) {
          const locFields = lat !== null ? { last_lat: lat, last_lng: lng, last_location_at: nowIso } : {};
          await supabase.from('trip_participants').update({ status: 'joined', joined_at: nowIso, delay_minutes: 0, ...locFields }).eq('id', myPp.id);
        }

      } else if (action === 'join') {
        let myLat: number, myLng: number;
        try { const pos = await getGps(); myLat = pos.coords.latitude; myLng = pos.coords.longitude; }
        catch { setActionErr('Could not get your location — please enable GPS and retry.'); return; }
        const { data: trip } = await supabase.from('field_trips').select('*').eq('id', tripId).single();
        const starterPp = trip?.started_by ? participants.find(p => p.member_id === trip.started_by) : null;
        if (starterPp?.last_lat && starterPp?.last_lng) {
          const distM = haversineKm(myLat, myLng, starterPp.last_lat, starterPp.last_lng) * 1000;
          if (distM > 100) { setActionErr(`You're ${Math.round(distM)}m from the group — get closer to join`); return; }
        }
        const nowIso = new Date().toISOString();
        let delayMin = 0;
        if (trip?.started_at) delayMin = Math.max(0, Math.round((Date.now() - new Date(trip.started_at).getTime()) / 60000));
        const myPp = participants.find(p => p.member_id === memberId);
        if (myPp) {
          await supabase.from('trip_participants').update({ status: 'joined', joined_at: nowIso, delay_minutes: delayMin, last_lat: myLat, last_lng: myLng, last_location_at: nowIso }).eq('id', myPp.id);
        }

      } else if (action === 'depart') {
        const { data: tripCheck } = await supabase.from('field_trips').select('started_by').eq('id', tripId).single();
        if (tripCheck?.started_by !== memberId) { setActionErr('Only the trip starter can mark departure'); return; }
        await supabase.from('field_trips').update({ status: 'departed', departed_at: new Date().toISOString() }).eq('id', tripId);

      } else if (action === 'reached') {
        const { data: tripCheck } = await supabase.from('field_trips').select('started_by').eq('id', tripId).single();
        if (tripCheck?.started_by !== memberId) { setActionErr('Only the trip starter can mark reached'); return; }
        await supabase.from('field_trips').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', tripId);

      } else if (action === 'complete') {
        await supabase.from('field_trips').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', tripId);
      }

      await fetchDetail();
      onTripUpdated?.();
    } finally {
      setActing(false);
    }
  }

  function badgeCls(s: string) {
    if (s === 'active') return styles.badgeActive;
    if (s === 'departed') return styles.badgeDeparted;
    if (s === 'completed') return styles.badgeCompleted;
    return styles.badgePending;
  }

  const iAmStarter = detailTrip && memberId && detailTrip.started_by === memberId;
  const myPp = participants.find(p => p.member_id === memberId);
  const myStatus = myPp?.status ?? null;

  return (
    <div className={styles.overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.modal}>
        {loading || !detailTrip ? (
          <div className={styles.loading}>Loading trip…</div>
        ) : (
          <>
            <div className={styles.header}>
              <div>
                <div className={styles.title}>
                  {detailTrip.project || '—'}
                  {detailTrip.site_id && <span className={styles.site}> · {detailTrip.site_id}</span>}
                </div>
                <div className={styles.meta}>
                  {fmtDate(detailTrip.date)}
                  {detailTrip.governate && ` · ${detailTrip.governate}`}
                  {detailTrip.notes && ` · ${detailTrip.notes}`}
                </div>
                {detailTrip.started_by_name && (
                  <div className={styles.startedBy}>
                    Started by <strong>{detailTrip.started_by_name}</strong>
                    {detailTrip.started_at && ` at ${fmtTime(detailTrip.started_at)}`}
                  </div>
                )}
              </div>
              <div className={styles.headerRight}>
                <span className={`${styles.badge} ${badgeCls(detailTrip.status)}`}>{detailTrip.status}</span>
                <button className={styles.closeBtn} onClick={onClose}>✕</button>
              </div>
            </div>

            <div className={styles.mapWrap} ref={mapDivRef} />

            {/* Actions */}
            {(() => {
              const btns: { label: string; action: string; cls: string }[] = [];
              if (detailTrip.status === 'pending' && (isAdmin || myStatus === 'pending'))
                btns.push({ label: 'Start Trip', action: 'start', cls: styles.btnGreen });
              if (detailTrip.status === 'active' && myStatus === 'pending')
                btns.push({ label: 'Join Trip', action: 'join', cls: styles.btnBlue });
              if (iAmStarter && detailTrip.status === 'active')
                btns.push({ label: 'Mark Departure', action: 'depart', cls: styles.btnOrange });
              if (iAmStarter && detailTrip.status === 'departed')
                btns.push({ label: 'Mark Reached', action: 'reached', cls: styles.btnBlue });
              if (isAdmin && (detailTrip.status === 'active' || detailTrip.status === 'departed'))
                btns.push({ label: 'Mark Complete', action: 'complete', cls: styles.btnSlate });
              return btns.length > 0 ? (
                <div className={styles.actions}>
                  {btns.map(b => (
                    <button key={b.action} className={`${styles.actionBtn} ${b.cls}`} disabled={acting} onClick={() => handleAction(b.action)}>
                      {acting ? '…' : b.label}
                    </button>
                  ))}
                </div>
              ) : null;
            })()}

            {actionErr && <div className={styles.actionErr}>{actionErr}</div>}

            {/* Timeline */}
            {(() => {
              const events = buildTimeline(detailTrip, participants);
              return events.length > 0 ? (
                <div className={styles.timeline}>
                  <div className={styles.timelineHdr}>Timeline</div>
                  <ul className={styles.tlList}>
                    {events.map((e, i) => (
                      <li key={i} className={styles.tlItem}>
                        <span className={styles.tlLabel}>{e.label}</span>
                        <span className={styles.tlTime}>{e.time}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null;
            })()}

            {/* Participants */}
            <div className={styles.participants}>
              <div className={styles.participantsHdr}>Participants ({participants.length})</div>
              {participants.length === 0 ? (
                <div className={styles.ppEmpty}>No participants yet.</div>
              ) : participants.map(p => (
                <div key={p.id} className={styles.ppRow}>
                  <div className={styles.ppAvatar}>{initials(p.member_name)}</div>
                  <div className={styles.ppName}>{p.member_name || p.member_id}</div>
                  <span className={`${styles.ppStatus} ${p.status === 'joined' ? styles.ppJoined : styles.ppPending}`}>
                    {p.status || 'pending'}
                    {(p.delay_minutes ?? 0) > 0 && <span className={styles.ppDelay}> +{p.delay_minutes}min</span>}
                  </span>
                  {p.last_lat && p.last_lng && (
                    <span className={styles.ppCoords}>{p.last_lat.toFixed(4)},{p.last_lng.toFixed(4)}</span>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
