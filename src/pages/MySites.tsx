import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useTranslation } from 'react-i18next';
import styles from './MySites.module.css';

interface SiteRecord {
  site_id: string;
  project: string;
  activity_type: string | null;
  status: string | null;
  date: string;
  governate: string | null;
}

function daysAgoISO(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function fmtDate(iso: string) {
  const [yr, mo, dy] = iso.split('-');
  return `${dy}/${mo}/${yr}`;
}

function statusCls(s: string | null, styles: Record<string, string>) {
  const v = (s || '').toLowerCase();
  if (v === 'in progress') return styles.badgeAmber;
  if (v === 'completed')   return styles.badgeGreen;
  if (v === 'blocked')     return styles.badgeRed;
  return styles.badgeSlate;
}

export default function MySites() {
  const { currentUser } = useAuth();
  const { t } = useTranslation();

  const [sites,          setSites]          = useState<SiteRecord[]>([]);
  const [loading,        setLoading]        = useState(true);
  const [error,          setError]          = useState<string | null>(null);
  const [search,         setSearch]         = useState('');
  const [projFilter,     setProjFilter]     = useState('All');

  useEffect(() => {
    if (!currentUser) return;
    load();
  }, [currentUser]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      // Resolve member ID
      const { data: members } = await supabase
        .from('team_members')
        .select('id, full_name, username')
        .order('full_name');

      const name  = (currentUser?.full_name || '').trim().toLowerCase();
      const uname = (currentUser?.username  || '').trim().toLowerCase();
      const match = (members ?? []).find((m: { id: string; full_name?: string; username?: string }) =>
        (name  && m.full_name?.trim().toLowerCase() === name) ||
        (uname && m.username?.trim().toLowerCase()  === uname),
      );
      const memberId = match?.id ?? null;

      if (!memberId) { setLoading(false); return; }

      // Load activities from last 180 days
      const from180 = daysAgoISO(180);
      const { data: acts, error: actErr } = await supabase
        .from('daily_activities')
        .select('site_id, project, activity_type, status, date, governate, team_member_ids')
        .gte('date', from180)
        .order('date', { ascending: false })
        .limit(500);

      if (actErr) throw actErr;

      // Filter to user's activities and extract unique sites
      const myActs = (acts ?? []).filter(
        (a: { team_member_ids: string[] | null }) =>
          Array.isArray(a.team_member_ids) && a.team_member_ids.includes(memberId),
      );

      const siteMap = new Map<string, SiteRecord>();
      for (const a of myActs as Array<{ site_id: string | null; project: string; activity_type: string | null; status: string | null; date: string; governate: string | null }>) {
        if (!a.site_id) continue;
        if (!siteMap.has(a.site_id)) {
          siteMap.set(a.site_id, {
            site_id:       a.site_id,
            project:       a.project,
            activity_type: a.activity_type,
            status:        a.status,
            date:          a.date,
            governate:     a.governate,
          });
        }
      }

      setSites(Array.from(siteMap.values()));
    } catch {
      setError('Unable to load your sites. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  // Derive available projects from actual sites
  const availableProjects = ['All', ...Array.from(new Set(sites.map(s => s.project).filter(Boolean)))];

  const filtered = sites.filter(s => {
    const q = search.toLowerCase();
    const matchSearch = !q ||
      s.site_id.toLowerCase().includes(q) ||
      s.project.toLowerCase().includes(q) ||
      (s.governate || '').toLowerCase().includes(q) ||
      (s.activity_type || '').toLowerCase().includes(q);
    const matchProj = projFilter === 'All' || s.project === projFilter;
    return matchSearch && matchProj;
  });

  const sortedFiltered = [...filtered].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div className={styles.page}>

      <div className={styles.pageHead}>
        <h1 className={styles.pageTitle}>{t('mySites_title')}</h1>
        <p className={styles.pageSub}>{t('mySites_subtitle')}</p>
      </div>

      {/* Search + filters */}
      <div className={styles.searchCard}>
        <div className={styles.searchRow}>
          <div className={styles.searchBox}>
            <span className={styles.searchIcon}><SearchIcon /></span>
            <input
              className={styles.searchInput}
              type="text"
              placeholder={t('mySites_searchPh')}
              value={search}
              onChange={e => setSearch(e.target.value)}
              aria-label="Search sites"
            />
          </div>
          {availableProjects.length > 2 && (
            <select
              className={styles.projSelect}
              value={projFilter}
              onChange={e => setProjFilter(e.target.value)}
              aria-label="Filter by project"
            >
              {availableProjects.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Status / count */}
      {!loading && !error && (
        <div className={styles.resultsMeta}>
          {sortedFiltered.length} site{sortedFiltered.length !== 1 ? 's' : ''}
          {search || projFilter !== 'All' ? ' matching filters' : ' in your activities'}
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className={styles.siteGrid}>
          {[0, 1, 2, 3, 4, 5].map(i => (
            <div key={i} className={styles.skCard}>
              <div className={`${styles.skPulse} ${styles.skTitle}`} />
              <div className={`${styles.skPulse} ${styles.skLine}`} />
              <div className={`${styles.skPulse} ${styles.skLine}`} />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className={styles.stateBox}>
          <ErrorIcon />
          <p className={styles.stateTitle}>{t('mySites_error')}</p>
          <p className={styles.stateSub}>{error}</p>
          <button className={styles.retryBtn} onClick={load}>Try again</button>
        </div>
      ) : sortedFiltered.length === 0 ? (
        <div className={styles.stateBox}>
          <EmptyIcon />
          <p className={styles.stateTitle}>{search || projFilter !== 'All' ? t('mySites_noMatch') : t('mySites_noSites')}</p>
          <p className={styles.stateSub}>
            {search || projFilter !== 'All'
              ? 'Try adjusting your search or filters.'
              : 'Sites will appear here once you are included in field activities.'}
          </p>
        </div>
      ) : (
        <div className={styles.siteGrid}>
          {sortedFiltered.map(s => (
            <div key={s.site_id} className={styles.siteCard}>
              <div className={styles.cardTop}>
                <div className={styles.siteIconWrap}><MapPinIcon /></div>
                <div className={styles.cardTopInfo}>
                  <div className={styles.siteId}>Site {s.site_id}</div>
                  <div className={styles.siteProjSec}>{s.project}</div>
                </div>
                <span className={`${styles.statusBadge} ${statusCls(s.status, styles)}`}>
                  {s.status || '—'}
                </span>
              </div>
              <div className={styles.cardFields}>
                {s.activity_type && (
                  <div className={styles.field}>
                    <span className={styles.fieldK}>{t('mySites_lastAct')}</span>
                    <span className={styles.fieldV}>{s.activity_type}</span>
                  </div>
                )}
                {s.governate && (
                  <div className={styles.field}>
                    <span className={styles.fieldK}>{t('mySites_gov')}</span>
                    <span className={styles.fieldV}>{s.governate}</span>
                  </div>
                )}
                <div className={styles.field}>
                  <span className={styles.fieldK}>{t('mySites_lastSeen')}</span>
                  <span className={styles.fieldV}>{fmtDate(s.date)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

    </div>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  );
}

function MapPinIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
      <circle cx="12" cy="10" r="3"/>
    </svg>
  );
}

function EmptyIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
      <circle cx="12" cy="10" r="3"/>
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  );
}

// Export so it can be used as nav icon in Sidebar
export function MySitesIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
      <circle cx="12" cy="10" r="3"/>
    </svg>
  );
}

