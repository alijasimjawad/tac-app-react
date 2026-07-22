import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { ensureSectionsLoaded, getSections } from '../lib/sectionsCache';
import { PROJ_NAMES, SEC_LABELS } from './NetworkScopes';
import styles from './SiteLookup.module.css';

// ── Label / value alias maps (copied exactly from old app ~5381-5403) ─────────

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

// ── Helper functions (ported from old app ~5405-5445) ─────────────────────────

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
  if (/tdd/.test(s))         return styles.cardAccentBlue;
  if (/add\s*sector/.test(s)) return styles.cardAccentPurple;
  if (/swap/.test(s))        return styles.cardAccentOrange;
  if (/new\s*site/.test(s))  return styles.cardAccentGreen;
  return styles.cardAccentNeutral;
}

function slPriority(h: string): number {
  const s = String(h);
  if (/install/i.test(s))                return 0;
  if (/imp.*date|implementation/i.test(s)) return 1;
  if (/integrat/i.test(s))               return 2;
  if (/\bgov/i.test(s))                  return 3;
  if (/\batp\b/i.test(s))               return 4;
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

// ── Main component ────────────────────────────────────────────────────────────

export default function SiteLookup() {
  const { hasPerm } = useAuth();
  const inputRef  = useRef<HTMLInputElement>(null);

  const [query,     setQuery]     = useState('');
  const [searching, setSearching] = useState(false);
  const [results,   setResults]   = useState<MatchResult[] | null>(null);
  const [lastQuery, setLastQuery] = useState('');
  const [toast, setToast]         = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  async function runSearch() {
    const q = query.trim();
    if (!q) return;

    setSearching(true);
    setLastQuery(q);

    await ensureSectionsLoaded();
    const sections = getSections().filter(s => !s.is_deleted && hasPerm(`view_${s.project_name}`));
    const sectionIds = sections.map(s => s.id).filter(Boolean);

    const rowsBySecId: Record<string, Record<string, string>[]> = {};
    if (sectionIds.length > 0) {
      const { data } = await supabase
        .from('rows')
        .select('section_id, data')
        .in('section_id', sectionIds);
      for (const r of data ?? []) {
        if (!rowsBySecId[r.section_id]) rowsBySecId[r.section_id] = [];
        rowsBySecId[r.section_id].push(r.data as Record<string, string>);
      }
    }

    const ql = q.toLowerCase();
    const matches: MatchResult[] = [];

    for (const meta of sections) {
      // Use all columns (unfiltered) — same as old app iterating data[0] headers
      const headers = meta.columns || [];
      let siteIdx = headers.findIndex(h => /^site.{0,3}id$/i.test(h));
      if (siteIdx < 0) siteIdx = 0;
      const siteHeader = headers[siteIdx] ?? '';

      for (const rowData of rowsBySecId[meta.id] ?? []) {
        const siteVal = (rowData[siteHeader] ?? '').trim().toLowerCase();
        if (siteVal === ql) {
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
    setSearching(false);
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
        <p className={styles.pageSub}>Search and review site information across all projects.</p>
      </div>

      <div className={styles.searchPanel}>
        <div className={styles.searchBox}>
          <span className={styles.searchIcon}>
            <SearchIcon />
          </span>
          <input
            ref={inputRef}
            className={styles.searchInput}
            type="text"
            placeholder="Search by site ID…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } }}
            aria-label="Search by site ID"
          />
        </div>
        <button className={styles.searchBtn} onClick={runSearch} disabled={searching}>
          <SearchIcon />
          {searching ? 'Searching…' : 'Search'}
        </button>
      </div>

      {results !== null && !searching && (
        <div className={styles.summary}>
          {results.length > 0
            ? `${results.length} record${results.length === 1 ? '' : 's'} found for "${lastQuery}"`
            : ''}
        </div>
      )}

      <div className={styles.results}>
        {searching ? (
          <div className={styles.empty}>Searching…</div>
        ) : results === null ? (
          <div className={styles.empty}>Search for a site to view its project records.</div>
        ) : results.length === 0 ? (
          <div className={styles.empty}>No site records found for this search.</div>
        ) : (
          results.map((result, idx) => {
            // Build sorted field list (top 6 non-empty, excluding site ID)
            const available: Array<{ h: string; val: string; p: number; i: number }> = [];
            result.headers.forEach((h, i) => {
              const val = (result.rowData[h] ?? '').trim();
              if (/^site.{0,3}(id|code)$/i.test(h) || val === '') return;
              available.push({ h, val, p: slPriority(h), i });
            });
            available.sort((a, b) => a.p - b.p || a.i - b.i);
            const top = available.slice(0, 6);

            const statFields  = top.filter(f => /status|atp|integrat/i.test(f.h));
            const plainFields = top.filter(f => !/status|atp|integrat/i.test(f.h));

            return (
              <div
                key={idx}
                className={`${styles.card} ${slWorkTypeAccentClass(result.secLabel)}`}
              >
                <div className={styles.cardHead}>
                  <div className={styles.cardIcon}>
                    <BuildingIcon />
                  </div>
                  <div className={styles.cardHeadTxt}>
                    <span className={styles.cardTitle}>Site {lastQuery}</span>
                    <div className={styles.cardSub}>
                      <span className={styles.cardProj}>{PROJ_NAMES[result.proj] || result.proj}</span>
                      <span className={styles.cardProjSep}>›</span>
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
                      onClick={() => shareRecord(result)}
                    >
                      <ShareIcon />
                    </button>
                    <button
                      className={styles.actBtn}
                      title="Download as .txt"
                      aria-label="Download site report"
                      onClick={() => exportRecord(result)}
                    >
                      <DownloadIcon />
                    </button>
                  </div>
                </div>

                {plainFields.length > 0 && (
                  <div className={styles.cardBody}>
                    {plainFields.map(({ h, val }) => (
                      <div key={h} className={styles.field}>
                        <span className={styles.fieldK}>{slNormalizeLabel(h)}</span>
                        <span className={styles.fieldV}>{slDisplayValue(val)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
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

// Exported so Sidebar can import it for the nav icon
export function SiteLookupIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  );
}
