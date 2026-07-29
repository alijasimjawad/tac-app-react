import { useState, useEffect, useRef, useCallback } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import { invalidateSections } from '../lib/sectionsCache';
import { invalidateCache as invalidateSitesCache } from '../lib/sitesCache';
import styles from './AppLayout.module.css';

const PAGE_TITLES: Record<string, string> = {
  '/attendance':        'My Attendance',
  '/dashboard':         'Dashboard',
  '/my-work':           'My Work',
  '/my-profile':        'My Profile',
  '/my-expenses':       'My Expenses',
  '/my-trips':          'Field Trips',
  '/live-trips':        'Live Trips',
  '/route-planner':     'Route Planner',
  '/daily-activities':  'Daily Activities',
  '/sites-db':          'Sites Database',
  '/hr-profiles':       'HR Profiles',
  '/attendance-admin':  'Attendance',
  '/network-scopes':    'Network Scopes',
  '/site-lookup':       'Site Lookup',
  '/activity-log':      'Activity Log',
  '/user-management':   'User Management',
  '/backup-restore':    'Backup & Restore',
};

const PAGE_SUBTITLES: Record<string, string> = {
  '/attendance':        'Track your working hours, attendance history, and field check-ins.',
  '/daily-activities':  'Plan, assign and track field activities',
  '/route-planner':     'Paste a site list, split across teams, and get a day-by-day itinerary. Distances refine to real road routes once loaded.',
  '/sites-db':          'Manage, search, map, and review telecom site records.',
};

// ── Pull-to-refresh / resume-refresh tuning ─────────────────────────────────
const PULL_THRESHOLD = 70;   // px of pull needed before releasing triggers a refresh
const MAX_PULL = 110;        // rubber-band cap so it can't be dragged forever
const PULL_RESISTANCE = 0.5; // finger moves 2px -> indicator moves 1px
// Only auto-refresh when the installed app is brought back to the foreground
// if it was actually backgrounded for a while — avoids remounting the page
// (and losing scroll position/open dropdowns) on a quick alt-tab or glance
// at a notification.
const RESUME_REFRESH_AFTER_MS = 20_000;

export default function AppLayout() {
  const { pathname } = useLocation();
  const title = PAGE_TITLES[pathname] ?? 'TAC Network';
  const subtitle = PAGE_SUBTITLES[pathname];
  const [mobileOpen, setMobileOpen] = useState(false);

  // Slim top progress bar shown whenever the route changes (i.e. switching
  // between sidebar pages). Time-based, like GitHub/YouTube's nav loader —
  // we don't have a real "page finished loading" signal from each page, so
  // it just ramps up and completes on a fixed schedule to give a clear
  // loading cue instead of an abrupt blank-then-content swap.
  const [navProgress, setNavProgress] = useState(0);
  const [navVisible, setNavVisible] = useState(false);
  const navTimersRef = useRef<number[]>([]);

  // Bumping this remounts the routed page below, which re-runs its own
  // mount-time data fetch — a fast, in-app "refresh" of just the current
  // page's data, without reloading the whole app shell/bundle.
  const [refreshKey, setRefreshKey] = useState(0);
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const contentRef = useRef<HTMLDivElement>(null);
  const hiddenAtRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const pullingRef = useRef(false);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    navTimersRef.current.forEach(id => window.clearTimeout(id));
    navTimersRef.current = [
      window.setTimeout(() => setNavProgress(55), 120),
      window.setTimeout(() => setNavProgress(82), 280),
      window.setTimeout(() => setNavProgress(100), 420),
      window.setTimeout(() => { setNavVisible(false); setNavProgress(0); }, 620),
    ];
    setNavVisible(true);
    setNavProgress(20);
    return () => navTimersRef.current.forEach(id => window.clearTimeout(id));
  }, [pathname]);

  const triggerRefresh = useCallback(() => {
    setRefreshing(true);
    // These caches (sections, sites) live outside React as module-level
    // singletons, so remounting via `key` alone doesn't force them to
    // refetch — invalidate them here so the remount below actually pulls
    // fresh data from Supabase instead of serving stale in-memory arrays.
    invalidateSections();
    invalidateSitesCache();
    setRefreshKey(k => k + 1);
    // Keep the indicator visible just long enough to read as "refreshed",
    // then collapse it — the newly-mounted page shows its own loading
    // state underneath if it has one.
    window.setTimeout(() => {
      setRefreshing(false);
      setPullDistance(0);
    }, 500);
  }, []);

  // Resume-from-background refresh: e.g. phone was locked, or the user
  // switched to another app and came back after a while.
  useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState === 'hidden') {
        hiddenAtRef.current = Date.now();
        return;
      }
      const hiddenAt = hiddenAtRef.current;
      hiddenAtRef.current = null;
      if (hiddenAt && Date.now() - hiddenAt >= RESUME_REFRESH_AFTER_MS) {
        triggerRefresh();
      }
    }
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [triggerRefresh]);

  // Pull-to-refresh: touch-only gesture on the scrollable content area.
  // Attached as a native (non-passive) listener so we can preventDefault()
  // while dragging — otherwise the browser's own overscroll/back gesture
  // would fight with ours.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    function onTouchStart(e: TouchEvent) {
      if (el!.scrollTop <= 0 && !refreshing) {
        touchStartYRef.current = e.touches[0].clientY;
        pullingRef.current = true;
      } else {
        touchStartYRef.current = null;
        pullingRef.current = false;
      }
    }

    function onTouchMove(e: TouchEvent) {
      if (!pullingRef.current || touchStartYRef.current == null) return;
      const delta = e.touches[0].clientY - touchStartYRef.current;
      if (delta <= 0 || el!.scrollTop > 0) {
        pullingRef.current = false;
        setPullDistance(0);
        return;
      }
      e.preventDefault();
      setPullDistance(Math.min(delta * PULL_RESISTANCE, MAX_PULL));
    }

    function onTouchEnd() {
      if (!pullingRef.current) return;
      pullingRef.current = false;
      touchStartYRef.current = null;
      setPullDistance(current => {
        if (current >= PULL_THRESHOLD) {
          triggerRefresh();
          return current;
        }
        return 0;
      });
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [refreshing, triggerRefresh]);

  const indicatorVisible = pullDistance > 0 || refreshing;
  const indicatorProgress = Math.min(pullDistance / PULL_THRESHOLD, 1);
  const indicatorTranslateY = Math.min(pullDistance, 40) - 40; // slides in from -40px to 0

  return (
    <div className={styles.shell}>
      {navVisible && (
        <div
          className={styles.navProgress}
          style={{ width: `${navProgress}%`, opacity: navProgress >= 100 ? 0 : 1 }}
        />
      )}
      <Sidebar key={refreshKey} mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
      <div className={styles.main}>
        <Topbar title={title} subtitle={subtitle} onMenuOpen={() => setMobileOpen(true)} onRefresh={triggerRefresh} refreshing={refreshing} />
        <div className={styles.content} ref={contentRef}>
          {indicatorVisible && (
            <div
              className={styles.pullIndicator}
              style={{ transform: `translate(-50%, ${indicatorTranslateY}px)`, opacity: indicatorProgress }}
            >
              <span
                className={`${styles.pullSpinner} ${refreshing ? styles.pullSpinnerActive : ''}`}
                style={!refreshing ? { transform: `rotate(${indicatorProgress * 360}deg)` } : undefined}
              />
            </div>
          )}
          <Outlet key={refreshKey} />
        </div>
      </div>
    </div>
  );
}
