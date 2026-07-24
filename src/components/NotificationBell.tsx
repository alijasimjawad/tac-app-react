import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import styles from './NotificationBell.module.css';

// ── Types ──────────────────────────────────────────────────────────────────────

type NotifKind = 'add' | 'edit' | 'delete' | 'other';

interface NotifItem {
  id: string;   // "al_{uuid}" for activity_log  |  "ec_{uuid}_{status}" for expense_claims
  msg: string;
  ts: string;
  kind: NotifKind;
}

// ── Pure helpers ───────────────────────────────────────────────────────────────

// Relative time — same logic as ActivityLog.tsx relTime (ported from _notifRelTime)
function relTime(ts: string): string {
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60)     return 'just now';
  if (s < 3600)   return `${Math.floor(s / 60)}m ago`;
  if (s < 86400)  return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

// Icon kind — ported from old app's _notifIconClass logic
function classifyAction(action: string | null): NotifKind {
  if (!action) return 'other';
  const u = action.toLowerCase();
  if (/added|approved|integrated/.test(u))  return 'add';
  if (/deleted|rejected|removed/.test(u))   return 'delete';
  if (/edited|updated|bulk|import/.test(u)) return 'edit';
  return 'other';
}

function fmtDate(iso: string): string {
  const [yr, mo, dy] = iso.split('-');
  return `${dy}/${mo}/${yr}`;
}

// Convert VAPID public key (URL-safe base64) → Uint8Array<ArrayBuffer> for pushManager.subscribe.
// Uses explicit ArrayBuffer to satisfy TS5 strict typing (Uint8Array<ArrayBufferLike> ≠ BufferSource).
function urlBase64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const buf  = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return view;
}

function kindClass(k: NotifKind): string {
  return { add: styles.iconAdd, delete: styles.iconDelete, edit: styles.iconEdit, other: styles.iconOther }[k];
}

// ── SVG primitives ─────────────────────────────────────────────────────────────

const BellSvg = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
    <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
  </svg>
);

function KindIcon({ kind }: { kind: NotifKind }) {
  if (kind === 'add') return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
  if (kind === 'delete') return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  );
  if (kind === 'edit') return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>
  );
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
    </svg>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function NotificationBell() {
  const { currentUser } = useAuth();

  const [open,          setOpen]          = useState(false);
  const [notifs,        setNotifs]        = useState<NotifItem[]>([]);
  const [readIds,       setReadIds]       = useState<Set<string>>(new Set());
  const [pushEnabled,   setPushEnabled]   = useState<boolean | null>(null);
  const [pushSupported, setPushSupported] = useState(true);
  const [loadingPush,   setLoadingPush]   = useState(false);
  const [pushError,     setPushError]     = useState<string | null>(null);

  const wrapRef      = useRef<HTMLDivElement>(null);
  const markTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref mirror so the 3-sec timer closure always reads current readIds
  const readIdsRef   = useRef(readIds);
  readIdsRef.current = readIds;

  const storageKey = currentUser ? `tac_notif_read_${currentUser.id}` : null;

  // ── Load read IDs from localStorage on mount ─────────────────────────────────
  useEffect(() => {
    if (!storageKey) return;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) setReadIds(new Set(JSON.parse(raw) as string[]));
    } catch { /* corrupted — start fresh */ }
  }, [storageKey]);

  // ── Load notifications ───────────────────────────────────────────────────────
  const loadNotifs = useCallback(async () => {
    if (!currentUser) return;
    const role  = currentUser.role?.toLowerCase();
    const items: NotifItem[] = [];

    if (role === 'admin') {
      const { data } = await supabase
        .from('activity_log')
        .select('id, user_full_name, action, project_name, section_name, details, created_at')
        .order('created_at', { ascending: false })
        .limit(15);
      for (const row of data ?? []) {
        const msg =
          `${row.user_full_name || 'Someone'} ${row.action || 'did something'}` +
          `${row.project_name  ? ' in ' + row.project_name : ''}` +
          `${row.section_name  ? ' (' + row.section_name + ')' : ''}` +
          `${row.details       ? ' — ' + row.details : ''}`;
        items.push({ id: `al_${row.id}`, msg, ts: row.created_at, kind: classifyAction(row.action) });
      }

    } else if (role === 'technician' || role === 'engineer') {
      // Resolve member_id — same pattern as MyExpenses.tsx lines 119-131
      const { data: members } = await supabase
        .from('team_members')
        .select('id, full_name, username, is_active');
      const name  = (currentUser.full_name  || '').trim().toLowerCase();
      const uname = (currentUser.username   || '').trim().toLowerCase();
      const match = (members ?? []).find(
        (m: { id: string; full_name: string; username: string }) =>
          (name  && m.full_name?.trim().toLowerCase()  === name) ||
          (uname && m.username?.trim().toLowerCase() === uname),
      );
      if (match) {
        const { data } = await supabase
          .from('expense_claims')
          .select('id, project_name, activity_date, status, rejection_reason, submitted_at')
          .eq('member_id', match.id)
          .order('submitted_at', { ascending: false })
          .limit(15);
        for (const row of data ?? []) {
          const date = row.activity_date ? fmtDate(row.activity_date) : '';
          const proj = row.project_name || 'a project';
          const st   = (row.status || '').toLowerCase();
          let msg: string;
          let kind: NotifKind;
          if (st === 'approved') {
            msg  = `Your claim for ${proj} on ${date} was approved ✓`;
            kind = 'add';
          } else if (st === 'rejected') {
            msg  = `Your claim for ${proj} on ${date} was rejected ✗${row.rejection_reason ? ' — ' + row.rejection_reason : ''}`;
            kind = 'delete';
          } else {
            msg  = `Your claim for ${proj} on ${date} is pending review`;
            kind = 'other';
          }
          items.push({ id: `ec_${row.id}_${row.status}`, msg, ts: row.submitted_at, kind });
        }
      }
    }
    // Other roles → empty list

    setNotifs(items);
  }, [currentUser]);

  // Load on mount
  useEffect(() => { void loadNotifs(); }, [loadNotifs]);

  // ── Push state check ─────────────────────────────────────────────────────────
  const checkPushState = useCallback(async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setPushSupported(false); return;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      setPushEnabled((await reg.pushManager.getSubscription()) !== null);
    } catch { setPushEnabled(false); }
  }, []); // setState refs are stable — no deps needed

  // Reload data + refresh push state each time dropdown opens
  useEffect(() => {
    if (!open) return;
    void loadNotifs();
    void checkPushState();
    setPushError(null);
  }, [open, loadNotifs, checkPushState]);

  // 3-second auto-mark-read on open — matches old app's _notifMarkReadTimer
  useEffect(() => {
    if (!open || notifs.length === 0 || !storageKey) return;
    if (markTimerRef.current) clearTimeout(markTimerRef.current);
    markTimerRef.current = setTimeout(() => {
      const merged = [...new Set([...readIdsRef.current, ...notifs.map(n => n.id)])];
      localStorage.setItem(storageKey, JSON.stringify(merged));
      setReadIds(new Set(merged));
    }, 3000);
    return () => { if (markTimerRef.current) clearTimeout(markTimerRef.current); };
  }, [open, notifs, storageKey]); // readIds accessed via readIdsRef to avoid timer reset loop

  // Outside-click to close
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // ── Push subscribe / unsubscribe ─────────────────────────────────────────────

  async function subscribePush() {
    if (!currentUser) return;
    setLoadingPush(true);
    setPushError(null);
    try {
      const vapidKey = (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) ?? '';
      if (!vapidKey) {
        const msg = 'Push isn\'t configured on this deployment (missing VAPID key). Contact the admin.';
        console.error('[Push] VITE_VAPID_PUBLIC_KEY not set');
        setPushError(msg); setLoadingPush(false); return;
      }
      const reg  = await navigator.serviceWorker.register('/sw.js');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        setPushError(
          perm === 'denied'
            ? 'Notifications are blocked for this site. Enable them in your browser\'s site settings and try again.'
            : 'Notification permission was dismissed. Click Enable again to retry.',
        );
        setLoadingPush(false);
        return;
      }
      const sub  = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
      const { error: upsertErr } = await supabase.from('push_subscriptions').upsert(
        { user_id: currentUser.id, subscription: sub.toJSON() },
        { onConflict: 'user_id' },
      );
      if (upsertErr) {
        console.error('[Push] saving subscription failed:', upsertErr);
        setPushError(`Couldn't save subscription: ${upsertErr.message}`);
        setLoadingPush(false);
        return;
      }
      setPushEnabled(true);
    } catch (err) {
      console.error('[Push] subscribe failed:', err);
      setPushError(err instanceof Error ? `Enable failed: ${err.message}` : 'Enable failed. See console for details.');
    }
    setLoadingPush(false);
  }

  async function unsubscribePush() {
    if (!currentUser) return;
    setLoadingPush(true);
    setPushError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      await sub?.unsubscribe();
      await supabase.from('push_subscriptions').delete().eq('user_id', currentUser.id);
      setPushEnabled(false);
    } catch (err) {
      console.error('[Push] unsubscribe failed:', err);
      setPushError(err instanceof Error ? `Disable failed: ${err.message}` : 'Disable failed. See console for details.');
    }
    setLoadingPush(false);
  }

  // ⚠️  Temporary test button — sends a real push to yourself.
  //     Remove or keep after manual end-to-end verification (noted in Phase 13 summary).
  async function sendTestPush() {
    if (!currentUser) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return;
      await fetch('/api/send-push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscription: sub.toJSON(),
          title: 'TAC — test push',
          body: `Push working for ${currentUser.full_name || currentUser.username}`,
          url: '/',
        }),
      });
    } catch (err) {
      console.error('[Push] test send failed:', err);
    }
  }

  // ── Mark all read ────────────────────────────────────────────────────────────

  function markAllRead() {
    if (!storageKey || notifs.length === 0) return;
    const merged = [...new Set([...readIds, ...notifs.map(n => n.id)])];
    localStorage.setItem(storageKey, JSON.stringify(merged));
    setReadIds(new Set(merged));
  }

  // ── Derived counts ───────────────────────────────────────────────────────────

  const unreadCount = notifs.filter(n => !readIds.has(n.id)).length;
  const badgeText   = unreadCount > 99 ? '99+' : String(unreadCount);

  if (!currentUser) return null;

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className={styles.wrap} ref={wrapRef}>

      {/* Bell trigger */}
      <button
        type="button"
        className={styles.bellBtn}
        onClick={() => setOpen(v => !v)}
        aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
        aria-expanded={open}
        aria-haspopup="true"
      >
        <BellSvg />
        {unreadCount > 0 && (
          <span className={styles.badge} aria-hidden="true">{badgeText}</span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className={styles.dropdown} role="dialog" aria-label="Notifications panel">

          {/* Header */}
          <div className={styles.dropHeader}>
            <span className={styles.dropTitle}>Notifications</span>
            {unreadCount > 0 && (
              <button type="button" className={styles.markReadBtn} onClick={markAllRead}>
                Mark all as read
              </button>
            )}
          </div>

          {/* Push toggle row */}
          <div className={styles.pushRow}>
            {!pushSupported ? (
              <span className={styles.pushNote}>Push not supported on this device</span>
            ) : pushEnabled === null ? (
              <span className={styles.pushNote}>Checking…</span>
            ) : (
              <>
                <span className={styles.pushLabel}>
                  {pushEnabled ? '🔔 Enabled on this device' : '🔕 Push disabled'}
                </span>
                <div className={styles.pushActions}>
                  <button
                    type="button"
                    className={pushEnabled ? styles.pushBtnOff : styles.pushBtnOn}
                    onClick={pushEnabled ? unsubscribePush : subscribePush}
                    disabled={loadingPush}
                  >
                    {loadingPush ? '…' : pushEnabled ? 'Disable' : 'Enable'}
                  </button>
                  {/* ⚠️ Temporary — remove after verifying end-to-end push delivery */}
                  {pushEnabled && (
                    <button type="button" className={styles.testBtn} onClick={sendTestPush}>
                      Test
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
          {pushError && (
            <div className={styles.pushRow} style={{ color: '#c0392b', fontSize: '0.8rem', paddingTop: 0 }}>
              {pushError}
            </div>
          )}

          {/* Notification list */}
          <div className={styles.list} role="list">
            {notifs.length === 0 ? (
              <div className={styles.empty}>No notifications yet</div>
            ) : notifs.map(n => {
              const unread = !readIds.has(n.id);
              return (
                <div key={n.id} role="listitem" className={`${styles.item} ${unread ? styles.itemUnread : ''}`}>
                  <span className={`${styles.notifIcon} ${kindClass(n.kind)}`}>
                    <KindIcon kind={n.kind} />
                  </span>
                  <div className={styles.itemBody}>
                    <span className={styles.itemMsg}>{n.msg}</span>
                    <span className={styles.itemTime}>{relTime(n.ts)}</span>
                  </div>
                  {unread && <span className={styles.unreadDot} aria-hidden="true" />}
                </div>
              );
            })}
          </div>

        </div>
      )}
    </div>
  );
}
