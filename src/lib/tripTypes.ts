export interface FieldTrip {
  id: string;
  daily_activity_id: string | null;
  date: string;
  project: string | null;
  site_id: string | null;
  governate: string | null;
  notes: string | null;
  team_member_ids: string[] | null;
  team_member_names: string[] | null;
  status: string;
  created_by: string | null;
  started_at: string | null;
  started_by: string | null;
  started_by_name: string | null;
  departed_at: string | null;
  completed_at: string | null;
}

export interface TripParticipant {
  id: string;
  trip_id: string;
  member_id: string;
  member_name: string | null;
  status: string;
  joined_at: string | null;
  delay_minutes: number | null;
  last_lat: number | null;
  last_lng: number | null;
  last_location_at: string | null;
}

export interface TimelineEvent {
  ts: Date;
  label: string;
  time: string;
}

export function fmtDate(iso: string): string {
  const [yr, mo, dy] = iso.split('-');
  return `${dy}/${mo}/${yr}`;
}

export function fmtTime(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function initials(name: string | null): string {
  return (name || '?').trim().split(/\s+/).map(w => w[0] || '').join('').toUpperCase().slice(0, 2);
}

export function getGps(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) =>
    navigator.geolocation
      ? navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 8000, enableHighAccuracy: true })
      : reject(new Error('Geolocation not available')),
  );
}

export function buildTimeline(trip: FieldTrip, pp: TripParticipant[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  if (trip.started_at) {
    events.push({ ts: new Date(trip.started_at), label: `Trip started · ${trip.started_by_name || '—'}`, time: fmtTime(trip.started_at) });
  }
  pp.forEach(p => {
    if (p.joined_at) {
      const del = (p.delay_minutes ?? 0) > 0 ? ` · +${p.delay_minutes}min` : '';
      events.push({ ts: new Date(p.joined_at), label: `${p.member_name || p.member_id} joined${del}`, time: fmtTime(p.joined_at) });
    }
  });
  if (trip.departed_at) {
    events.push({ ts: new Date(trip.departed_at), label: `Departure marked · ${trip.started_by_name || '—'}`, time: fmtTime(trip.departed_at) });
  }
  if (trip.completed_at) {
    events.push({ ts: new Date(trip.completed_at), label: `Trip completed · ${trip.started_by_name || '—'}`, time: fmtTime(trip.completed_at) });
  }
  return events.sort((a, b) => a.ts.getTime() - b.ts.getTime());
}
