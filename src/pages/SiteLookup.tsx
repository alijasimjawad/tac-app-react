import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { ensureSectionsLoaded, getSections } from '../lib/sectionsCache';
import { PROJ_NAMES, SEC_LABELS } from './NetworkScopes';
import styles from './SiteLookup.module.css';

// ── Label / value alias maps ──────────────────────────────────────────────────

const SL_LABEL_ALIASES: Record<string, string> = {
  'subcon': 'Subcontractor', 'subc': 'Subcontractor', 'sub con': 'Subcontractor', 'sub contractor': 'Subcontractor',
  'gov': 'Governorate', 'governate': 'Governorate', 'governorate': 'Governorate',
  'imp date': 'Implementation Date', 'implementation date': 'Implementation Date',
  'installation date': 'Installation Date', 'installation': 'Installation Date',
  'modified scope': 'Modified Scope',
  'site code': 'Site Code', 'site id': 'Site Code',
  'integration': 'Integration Status',
  'hw status': 'Hardware Status', 'atp status': 'ATP Status', 'atp': 'ATP Status',
};

const SL_VALUE_ALIASES: Record<string, string> = {
  'integrated': 'Integrated',
  'tac': 'TAC',
  'done': 'Done',
  'complete': 'Complete',
  'completed': 'Completed',
  'pending': 'Pending',
  'in progress': 'In Progress',
  'in-progress': 'In Progress',
  'not started': 'Not Started',
  'scheduled': 'Scheduled',
};

// ── Helper functions ──────────────────────────────────────────────────────────

function slLabelKey(h: string): string {
  return String(h).trim().toLowerCase().replace(/\.+/g, '').replace(/\s+/g, ' ').trim();
}

function slNormalizeLabel(h: string): string {
  const key = slLabelKey(h);
  if (SL_LABEL_ALIASES[key]) return SL_LABEL_ALIASES[key];
  return String(h).toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function slDisplayValue(val: string): string {
  const raw = String(val ?? '');
  const key = raw.trim().toLowerCase();
  if (SL_VALUE_ALIASES[key]) return SL_VALUE_ALIASES[key];
  return raw;
}

function slBadgeText(h: string, val: string): string {
  const norm = slNormalizeLabel(h);
  const short = norm.replace(/\s*Status\s*$/i, '').trim();
  const v = slDisplayValue(val).trim();
  if (short && v.toLowerCase().includes(short.toLowerCase().slice(0, 6))) return v;
  return short ? `${short} ${v}` : v;
}

function slStatClass(val: string): string {
  const v = String(val ?? '').trim().toLowerCase();
  if (/^(done|complete|completed|pass|passed|approved|ok|active|yes|integrated)$/.test(v)) return styles.badgeGreen;
  if (/^(pending|progress|in progress|in-progress|hold|on hold|scheduled)$/.test(v)) return styles.badgeAmber;
  if (/^(fail|failed|rejected|cancelled|canceled|no|blocked)$/.test(v)) return styles.badgeRed;
  return styles.badgeSlate;
}

function slWorkTypeAccentClass(secName: string): string {
  const s = String(secName || '').trim().toLowerCase();
  if (/tdd/.test(s))          return styles.cardAccentBlue;
  if (/add\s*sector/.test(s)) return styles.cardAccentPurple;
  if (/swap/.test(s))         return styles.cardAccentOrange;
  if (/new\s*site/.test(s))   return styles.cardAccentGreen;
  return styles.cardAccentNeutral;
}

function slPriority(h: string): number {
  const s = String(h);
  if (/install/i.test(s))                  return 0;
  if (/imp.*date|implementation/i.test(s)) return 1;
  if (/integrat/i.test(s))                 return 2;
  if (/\bgov/i.test(s))                    return 3;
  if (/\batp\b/i.test(s))                  return 4;
  return 100;
}

function slRecordText(result: MatchResult, q: string): string {
  const lines = [`Site ${q} — ${PROJ_NAMES[result.proj] || result.proj} / ${result.secLabel}`];
  result.headers.forEach(h => {
    const val = (result.rowData[h] ?? '').trim();
    if (/^site.{0,3}(id|code)$/i.test(h) || val === '') return;
    lines.push(`${slNormalizeLabel(h)}: ${val}`);
  });
  return lines.join('\n');
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface MatchResult {
  proj: string;
  sec: string;
  secLabel: string;
  headers: string[];
  rowData: Record<string, string>;
}

// ── Skeleton card ─────────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className={styles.skeletonCard}>
      <div className={styles.skeletonHead}>
        <div className={`${styles.skeletonPulse} ${styles.skeletonIconPh}`} />
        <div className={styles.skeletonHeadInfo}>
          <div className={`${styles.skeletonPulse} ${styles.skeletonTitlePh}`} />
          <div className={`${styles.skeletonPulse} ${styles.skeletonSubPh}`} />
        </div>
      </div>
      <div className={styles.skeletonBody}>
        {[0, 1, 2, 3].map(i => (
          <div key={i} className={styles.skeletonField}>
            <div className={`${styles.skeletonPulse} ${styles.skeletonFieldK}`} />
            <div className={`${styles.skeletonPulse} ${styles.skeletonFieldV}`} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Site card (with expand/collapse) ─────────────────────────────────────────

function SiteCard({
  result,
  lastQuery,
  onShare,
  onExport,
}: {
  result: MatchResult;
  lastQuery: string;
  onShare: () => void;
  onExport: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const available: Array<{ h: string; val: string; p: number; i: number }> = [];
  result.headers.forEach((h, i) => {
    const val = (result.rowData[h] ?? '').trim();
    if (/^site.{0,3}(id|code)$/i.test(h) || val === '') return;
    available.push({ h, val, p: slPriority(h), i });
  });
  available.sort((a, b) => a.p - b.p || a.i - b.i);

  const statFields  = available.filter(f => /status|atp|integrat/i.test(f.h));
  const plainFields = available.filter(f => !/status|atp|integrat/i.test(f.h));

  const COLLAPSED = 4;
  const visible   = expanded ? plainFields : plainFields.slice(0, COLLAPSED);
  const hasMore   = plainFields.length > COLLAPSED;

  const siteIdx   = result.headers.findIndex(h => /^site.{0,3}id$/i.test(h));
  const siteHdr   = siteIdx >= 0 ? result.headers[siteIdx] : result.headers[0] ?? '';
  const siteId    = (result.rowData[siteHdr] ?? lastQuery).trim() || lastQuery;

  return (
    <div className={`${styles.card} ${slWorkTypeAccentClass(result.secLabel)}`}>
      <div className={styles.cardHead}>
        <div className={styles.cardIconWrap}>
          <BuildingIcon />
        </div>
        <div className={styles.cardHeadTxt}>
          <span className={styles.cardTitle}>Site {siteId}</span>
          <div className={styles.cardBreadcrumb}>
            <span className={styles.cardProj}>{PROJ_NAMES[result.proj] || result.proj}</span>
            <span className={styles.cardBreadSep}>›</span>
            <span className={styles.cardSec}>{result.secLabel}</span>
          </div>
        </div>
        <div className={styles.cardActions}>
          {statFields.length > 0 && (
            <div className={styles.badges}>
              {statFields.map(({ h, val }) => (
                <span key={h} className={`${styles.badge} ${slStatClass(val)}`}>
                  {slBadgeText(h, val)}
                </span>
              ))}
            </div>
          )}
          <button
            className={styles.actBtn}
            title="Copy to clipboard"
            aria-label="Share site record"
            onClick={onShare}
          >
            <ShareIcon />
          </button>
          <button
            className={styles.actBtn}
            title="Download as .txt"
            aria-label="Download site report"
            onClick={onExport}
          >
            <DownloadIcon />
          </button>
        </div>
      </div>

      {visible.length > 0 && (
        <div className={styles.cardBody}>
          {visible.map(({ h, val }) => (
            <div key={h} className={styles.field}>
              <span className={styles.fieldK}>{slNormalizeLabel(h)}</span>
              <span className={styles.fieldV}>{slDisplayValue(val)}</span>
            </div>
          ))}
        </div>
      )}

      {hasMore && (
        <button className={styles.expandBtn} onClick={() => setExpanded(e => !e)}>
          {expanded ? (
            <><ChevronUpIcon /> Show less</>
          ) : (
            <><ChevronDownIcon /> Show {plainFields.length - COLLAPSED} more fields</>
          )}
        </button>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SiteLookup() {
  const { hasPerm } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);

  const [query,           setQuery]           = useState('');
  const [searching,       setSearching]       = useState(false);
  const [results,         setResults]         = useState<MatchResult[] | null>(null);
  const [lastQuery,       setLastQuery]       = useState('');
  const [projFilter,      setProjFilter]      = useState<string | null>(null);
  const [error,           setError]           = useState<string | null>(null);
  const [recentSearches,  setRecentSearches]  = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('tac_sl_recent') ?? '[]') as string[]; }
    catch { return []; }
  });
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  function saveRecent(q: string) {
    const updated = [q, ...recentSearches.filter(r => r !== q)].slice(0, 5);
    setRecentSearches(updated);
    localStorage.setItem('tac_sl_recent', JSON.stringify(updated));
  }

  function clearRecent() {
    setRecentSearches([]);
    localStorage.removeItem('tac_sl_recent');
  }

  async function runSearch(searchQuery?: string) {
    const q = (searchQuery !== undefined ? searchQuery : query).trim();
    if (!q) return;

    if (searchQuery !== undefined) setQuery(searchQuery);
    setSearching(true);
    setLastQuery(q);
    setError(null);
    setProjFilter(null);

    try {
      await ensureSectionsLoaded();
      const sections = getSections().filter(s => !s.is_deleted && hasPerm(`view_${s.project_name}`));
      const sectionIds = sections.map(s => s.id).filter(Boolean);

      const rowsBySecId: Record<string, Record<string, string>[]> = {};
      if (sectionIds.length > 0) {
        const { data, error: dbErr } = await supabase
          .from('rows')
          .select('section_id, data')
          .in('section_id', sectionIds);
        if (dbErr) throw dbErr;
        for (const r of data ?? []) {
          if (!rowsBySecId[r.section_id]) rowsBySecId[r.section_id] = [];
          rowsBySecId[r.section_id].push(r.data as Record<string, string>);
        }
      }

      const ql = q.toLowerCase();
      const matches: MatchResult[] = [];

      for (const meta of sections) {
        const headers = meta.columns || [];
        let siteIdx = headers.findIndex(h => /^site.{0,3}id$/i.test(h));
        if (siteIdx < 0) siteIdx = 0;
        const siteHeader = headers[siteIdx] ?? '';
        const govHeader  = headers.find(h => /\bgov/i.test(h)) ?? '';

        for (const rowData of rowsBySecId[meta.id] ?? []) {
          const siteVal  = (rowData[siteHeader] ?? '').trim().toLowerCase();
          const govVal   = govHeader ? (rowData[govHeader] ?? '').trim().toLowerCase() : '';
          const projName = (PROJ_NAMES[meta.project_name] ?? meta.project_name).toLowerCase();

          if (siteVal.includes(ql) || (govVal && govVal.includes(ql)) || projName.includes(ql)) {
            matches.push({
              proj: meta.project_name,
              sec: meta.section_name,
              secLabel: meta.section_label ?? SEC_LABELS[meta.section_name] ?? meta.section_name,
              headers,
              rowData,
            });
          }
        }
      }

      setResults(matches);
      saveRecent(q);
    } catch {
      setError('Search failed. Please check your connection and try again.');
      setResults(null);
    } finally {
      setSearching(false);
    }
  }

  function shareRecord(result: MatchResult) {
    const text = slRecordText(result, lastQuery);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => showToast('Record copied to clipboard', true))
        .catch(() => showToast('Could not copy to clipboard', false));
    } else {
      showToast('Clipboard not available', false);
    }
  }

  function exportRecord(result: MatchResult) {
    const text = slRecordText(result, lastQuery);
    const blob = new Blob([text], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `site-${lastQuery}-${result.proj}-${result.sec}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Record exported', true);
  }

  // Derived state
  const availableProjects = results ? [...new Set(results.map(r => r.proj))] : [];
  const filteredResults   = (results ?? []).filter(r => projFilter === null || r.proj === projFilter);
  const showRecent        = results === null && !searching && recentSearches.length > 0;

  // ── Permission gate ──────────────────────────────────────────────────────────

  if (!hasPerm('view_site_lookup')) {
    return (
      <div className={styles.page}>
        <div className={styles.placeholder}>You don't have permission to view this page.</div>
      </div>
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className={styles.page}>

      <div className={styles.pageHead}>
        <h1 className={styles.pageTitle}>Site Lookup</h1>
        <p className={styles.pageSub}>Search site records across all projects by site ID, governorate, or project name.</p>
      </div>

      {/* Search card */}
      <div className={styles.searchCard}>
        <div className={styles.searchRow}>
          <div className={styles.searchBox}>
            <span className={styles.searchIcon}>
              <SearchIcon />
            </span>
            <input
              ref={inputRef}
              className={styles.searchInput}
              type="text"
              placeholder="Search by site ID, governorate, or project…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } }}
              aria-label="Search sites"
            />
          </div>
          <button className={styles.searchBtn} onClick={() => runSearch()} disabled={searching}>
            {searching ? 'Searching…' : 'Search'}
          </button>
        </div>

        {showRecent && (
          <div className={styles.recentRow}>
            <span className={styles.recentLabel}>Recent</span>
            <div className={styles.recentChips}>
              {recentSearches.map(r => (
                <button key={r} className={styles.recentChip} onClick={() => runSearch(r)}>
                  <ClockIcon />
                  {r}
                </button>
              ))}
            </div>
            <button className={styles.clearRecentBtn} onClick={clearRecent}>Clear</button>
          </div>
        )}
      </div>

      {/* Results area */}
      <div className={styles.resultsArea}>
        {searching ? (
          <div className={styles.results}>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        ) : error ? (
          <div className={styles.stateBox}>
            <div className={styles.stateIcon}><ErrorIcon /></div>
            <div className={`${styles.stateTitle} ${styles.stateTitleErr}`}>Search failed</div>
            <div className={styles.stateSub}>{error}</div>
          </div>
        ) : results === null ? (
          <div className={styles.stateBox}>
            <div className={styles.stateIcon}><SearchBigIcon /></div>
            <div className={styles.stateTitle}>Search for a site</div>
            <div className={styles.stateSub}>Enter a site ID, governorate, or project name to find matching records.</div>
          </div>
        ) : results.length === 0 ? (
          <div className={styles.stateBox}>
            <div className={styles.stateIcon}><EmptyIcon /></div>
            <div className={styles.stateTitle}>No results found</div>
            <div className={styles.stateSub}>
              No site records matched <strong>"{lastQuery}"</strong>. Try a different search term.
            </div>
          </div>
        ) : (
          <>
            <div className={styles.resultsHeader}>
              <span className={styles.resultsSummary}>
                {filteredResults.length} record{filteredResults.length === 1 ? '' : 's'}
                {projFilter ? ` in ${PROJ_NAMES[projFilter] || projFilter}` : ''} for "{lastQuery}"
              </span>
              {availableProjects.length > 1 && (
                <div className={styles.filterChips}>
                  <button
                    className={`${styles.filterChip} ${projFilter === null ? styles.filterChipActive : ''}`}
                    onClick={() => setProjFilter(null)}
                  >
                    All
                    <span className={styles.filterChipCount}>{results.length}</span>
                  </button>
                  {availableProjects.map(proj => {
                    const count = results.filter(r => r.proj === proj).length;
                    return (
                      <button
                        key={proj}
                        className={`${styles.filterChip} ${projFilter === proj ? styles.filterChipActive : ''}`}
                        onClick={() => setProjFilter(p => p === proj ? null : proj)}
                      >
                        {PROJ_NAMES[proj] || proj}
                        <span className={styles.filterChipCount}>{count}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className={styles.results}>
              {filteredResults.map((result, idx) => (
                <SiteCard
                  key={idx}
                  result={result}
                  lastQuery={lastQuery}
                  onShare={() => shareRecord(result)}
                  onExport={() => exportRecord(result)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {toast && (
        <div className={`${styles.toast} ${toast.ok ? styles.toastOk : styles.toastErr}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  );
}

function SearchBigIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  );
}

function BuildingIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 21h18"/>
      <path d="M5 21V7l7-4 7 4v14"/>
      <path d="M9 9h1M9 13h1M14 9h1M14 13h1"/>
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="18" cy="5" r="3"/>
      <circle cx="6" cy="12" r="3"/>
      <circle cx="18" cy="19" r="3"/>
      <line x1="8.6" y1="10.6" x2="15.4" y2="6.4"/>
      <line x1="8.6" y1="13.4" x2="15.4" y2="17.6"/>
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3v12"/>
      <path d="M7 10l5 5 5-5"/>
      <path d="M4 21h16"/>
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10"/>
      <polyline points="12 6 12 12 16 14"/>
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  );
}

function ChevronUpIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="18 15 12 9 6 15"/>
    </svg>
  );
}

function EmptyIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="10"/>
      <line x1="8" y1="12" x2="16" y2="12"/>
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="12"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  );
}

// Exported so Sidebar can import it for the nav icon
export function SiteLookupIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  );
}
