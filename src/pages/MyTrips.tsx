import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { type FieldTrip, fmtDate } from '../lib/tripTypes';
import TripDetailModal from '../components/TripDetailModal';
import styles from './MyTrips.module.css';

export default function MyTrips() {
  const { currentUser, hasPerm } = useAuth();
  const [memberId, setMemberId] = useState<string | null>(null);
  const [memberResolved, setMemberResolved] = useState(false);
  const [trips, setTrips] = useState<FieldTrip[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailTripId, setDetailTripId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const isAdmin = currentUser?.role === 'admin';

  function showToast(msg: string, ok: boolean) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }

  // ── member resolution ──
  useEffect(() => {
    if (!currentUser) return;
    async function resolve() {
      const { data } = await supabase
        .from('team_members')
        .select('id, full_name, username')
        .order('full_name');
      if (!data) { setLoading(false); setMemberResolved(true); return; }
      const name = (currentUser?.full_name || '').trim().toLowerCase();
      const uname = (currentUser?.username || '').trim().toLowerCase();
      const match = data.find((m: { id: string; full_name?: string; username?: string }) =>
        (name && m.full_name?.trim().toLowerCase() === name) ||
        (uname && m.username?.trim().toLowerCase() === uname),
      );
      setMemberId(match?.id ?? null);
      setMemberResolved(true);
    }
    resolve();
  }, [currentUser]);

  // ── load trips ──
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

  const myTrips = isAdmin
    ? trips
    : trips.filter(t => Array.isArray(t.team_member_ids) && t.team_member_ids.some(id => id === memberId));

  const sections = [
    { label: 'Active',    list: myTrips.filter(t => t.status === 'active') },
    { label: 'Departed',  list: myTrips.filter(t => t.status === 'departed') },
    { label: 'Pending',   list: myTrips.filter(t => t.status === 'pending') },
    { label: 'Completed', list: myTrips.filter(t => t.status === 'completed') },
  ];

  if (!hasPerm('view_my_expenses')) {
    return (
      <div className={styles.page}>
        <p style={{ color: 'var(--text-muted)', marginTop: 40 }}>
          You do not have permission to view this page.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Field Trips</h1>
        {!loading && <span className={styles.count}>{myTrips.length} total</span>}
      </div>

      {memberResolved && !memberId && !isAdmin && (
        <div className={styles.notLinked}>
          <strong>Account not linked to a team member profile.</strong>
          <p>Field trip tracking is for field engineers and technicians. Your account doesn't have a linked team member profile.</p>
        </div>
      )}

      {loading ? (
        <div className={styles.empty}>Loading…</div>
      ) : myTrips.length === 0 && (memberId || isAdmin) ? (
        <div className={styles.empty}>No field trips yet. They appear automatically when a Daily Activity is saved.</div>
      ) : (
        <>
          {sections.map(({ label, list }) => list.length > 0 && (
            <div key={label}>
              <div className={styles.sectionLabel}>{label} ({list.length})</div>
              {list.map(t => (
                <TripCard key={t.id} trip={t} onView={() => setDetailTripId(t.id)} />
              ))}
            </div>
          ))}
        </>
      )}

      {detailTripId && (
        <TripDetailModal
          tripId={detailTripId}
          memberId={memberId}
          currentUser={currentUser}
          onClose={() => setDetailTripId(null)}
          onTripUpdated={loadTrips}
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

function TripCard({ trip, onView }: { trip: FieldTrip; onView: () => void }) {
  const d = trip.date ? fmtDate(trip.date) : '—';
  const names = Array.isArray(trip.team_member_names) ? trip.team_member_names.join(', ') : (trip.team_member_names || '—');
  const badgeCls = trip.status === 'active' ? styles.badgeActive
    : trip.status === 'departed' ? styles.badgeDeparted
    : trip.status === 'completed' ? styles.badgeCompleted
    : styles.badgePending;
  return (
    <div className={styles.card} onClick={onView}>
      <div className={styles.cardTop}>
        <div>
          <div className={styles.cardTitle}>
            {trip.project || '—'}
            {trip.site_id && <span className={styles.cardSite}> · {trip.site_id}</span>}
          </div>
          <div className={styles.cardSub}>{d}{trip.governate && ` · ${trip.governate}`}</div>
        </div>
        <span className={`${styles.badge} ${badgeCls}`}>{trip.status || 'pending'}</span>
      </div>
      <div className={styles.cardMembers}>
        <UsersIcon />
        {names}
      </div>
    </div>
  );
}

function UsersIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ verticalAlign: '-1px', flexShrink: 0 }}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

