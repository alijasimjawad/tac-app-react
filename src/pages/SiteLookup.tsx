import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { ensureSectionsLoaded, getSections, type SectionMeta } from '../lib/sectionsCache';
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
  if (/^(done|complete|completed|pass|passed|approved|ok|active|yes|integrated|accepted)$/.test(v)) return styles.badgeGreen;
  if (/^(pending|progress|in progress|in-progress|hold|on hold|scheduled)$/.test(v)) return styles.badgeAmber;
  if (/^(fail|failed|rejected|cancelled|canceled|no|blocked|not integrated)$/.test(v)) return styles.badgeRed;
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

function slGetSiteId(result: MatchResult, fallback: string): string {
  const idx = result.headers.findIndex(h => /^site.{0,3}id$/i.test(h));
  const hdr = idx >= 0 ? result.headers[idx] : result.headers[0] ?? '';
  return (result.rowData[hdr] ?? fallback).trim() || fallback;
}

function slGetGov(result: MatchResult): string {
  const h = result.headers.find(h => /\bgov/i.test(h));
  const v = h ? (result.rowData[h] ?? '').trim() : '';
  return v || '—';
}

function slGetFields(result: MatchResult) {
  const available: Array<{ h: string; val: string; p: number; i: number }> = [];
  result.headers.forEach((h, i) => {
    const val = (result.rowData[h] ?? '').trim();
    if (/^site.{0,3}(id|code)$/i.test(h) || val === '') return;
    available.push({ h, val, p: slPriority(h), i });
  });
  available.sort((a, b) => a.p - b.p || a.i - b.i);
  const statFields  = available.filter(f => /status|atp|integrat/i.test(f.h));
  const plainFields = available.filter(f => !/status|atp|integrat/i.test(f.h));
  return { available, statFields, plainFields };
}

function slMatchesSiteTag(raw: string | null | undefined, siteId: string): boolean {
  const tags = String(raw ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return tags.includes(siteId.trim().toLowerCase());
}

function fmtDate(d?: string | null): string {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface MatchResult {
  proj: string;
  sec: string;
  secLabel: string;
  headers: string[];
  rowData: Record<string, string>;
}

interface SlActivity {
  id: string;
  date: string;
  activity_type: string;
  status: string;
  notes: string | null;
  team_member_names: string[] | null;
  created_by: string;
  site_id: string;
}

interface SlTrip {
  id: string;
  date: string;
  status: string;
  notes: string | null;
  team_member_names: string[] | null;
  created_by: string;
  site_id: string;
}

interface SlExpense {
  id: string;
  activity_date: string;
  description: string | null;
  total_amount: number | null;
  status: string;
  site_id: string | null;
}

type TabKey = 'overview' | 'activity' | 'technical' | 'trips' | 'expenses';

// ── Cross-reference data loader ─────────────────────────────────────────────

async function loadSiteCrossRefs(siteId: string, canViewExpenses: boolean) {
  const [actRes, tripRes, expRes] = await Promise.all([
    supabase.from('daily_activities').select('id, date, activity_type, status, notes, team_member_names, created_by, site_id').ilike('site_id', `%${siteId}%`),
    supabase.from('field_trips').select('id, date, status, notes, team_member_names, created_by, site_id').ilike('site_id', `%${siteId}%`),
    canViewExpenses
      ? supabase.from('expense_claims').select('id, activity_date, description, total_amount, status, site_id').ilike('site_id', `%${siteId}%`)
      : Promise.resolve({ data: [] as SlExpense[], error: null }),
  ]);

  const activities = ((actRes.data ?? []) as SlActivity[])
    .filter(a => slMatchesSiteTag(a.site_id, siteId))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const trips = ((tripRes.data ?? []) as SlTrip[])
    .filter(t => slMatchesSiteTag(t.site_id, siteId))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const expenses = ((expRes.data ?? []) as SlExpense[])
    .filter(e => slMatchesSiteTag(e.site_id, siteId))
    .sort((a, b) => (b.activity_date || '').localeCompare(a.activity_date || ''));

  return { activities, trips, expenses };
}

// ── Skeleton (summary) ───────────────────────────────────────────────────────

function SkeletonSummary() {
  return (
    <div className={styles.skeletonCard}>
      <div className={styles.skeletonHead}>
        <div className={`${styles.skeletonPulse} ${styles.skeletonIconPh}`} />
        <div className={styles.skeletonHeadInfo}>
          <div className={`${styles.skeletonPulse} ${styles.skeletonTitlePh}`} />
          <div className={`${styles.skeletonPulse} ${styles.skeletonSubPh}`} />
        </div>
      </div>
      <div className={styles.skeletonStats}>
        {[0, 1, 2, 3, 4].map(i => (
          <div key={i} className={`${styles.skeletonPulse} ${styles.skeletonStatPh}`} />
        ))}
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

// ── Stat mini-card ───────────────────────────────────────────────────────────

function StatMini({ icon, label, value, cls }: { icon: React.ReactNode; label: string; value: string; cls?: string }) {
  return (
    <div className={styles.statMini}>
      <div className={`${styles.statMiniIcon} ${cls ?? ''}`}>{icon}</div>
      <div className={styles.statMiniText}>
        <span className={styles.statMiniLabel}>{label}</span>
        <span className={styles.statMiniValue}>{value}</span>
      </div>
    </div>
  );
}

// ── Definition list (key/value grid) reused across tabs ──────────────────────

function FieldGrid({ fields }: { fields: Array<{ h: string; val: string }> }) {
  const { t } = useTranslation();
  if (fields.length === 0) {
    return <div className={styles.tabEmpty}>{t('sl_noAddlFields')}</div>;
  }
  return (
    <div className={styles.cardBody}>
      {fields.map(({ h, val }) => (
        <div key={h} className={styles.field}>
          <span className={styles.fieldK}>{slNormalizeLabel(h)}</span>
          <span className={styles.fieldV}>{slDisplayValue(val)}</span>
        </div>
      ))}
    </div>
  );
}

// ── Site summary (header + stats + tabs) ─────────────────────────────────────

function SiteSummary({
  result,
  lastQuery,
  onShare,
  onExport,
  onOpenProject,
}: {
  result: MatchResult;
  lastQuery: string;
  onShare: () => void;
  onExport: () => void;
  onOpenProject: () => void;
}) {
  const { hasPerm } = useAuth();
  const { t } = useTranslation();
  const canViewExpenses = hasPerm('view_my_expenses');

  const [activeTab, setActiveTab]     = useState<TabKey>('overview');
  const [detailsLoading, setDetailsLoading] = useState(true);
  const [activities, setActivities]   = useState<SlActivity[]>([]);
  const [trips, setTrips]             = useState<SlTrip[]>([]);
  const [expenses, setExpenses]       = useState<SlExpense[]>([]);

  const siteId = slGetSiteId(result, lastQuery);
  const { statFields, plainFields, available } = useMemo(() => slGetFields(result), [result]);
  const gov = slGetGov(result);

  useEffect(() => {
    let cancelled = false;
    setActiveTab('overview');
    setDetailsLoading(true);
    loadSiteCrossRefs(siteId, canViewExpenses)
      .then(r => { if (!cancelled) { setActivities(r.activities); setTrips(r.trips); setExpenses(r.expenses); } })
      .finally(() => { if (!cancelled) setDetailsLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, canViewExpenses]);

  const lastActivity = activities[0];
  const primaryStat = statFields[0];

  const TABS: Array<{ key: TabKey; label: string; show: boolean }> = [
    { key: 'overview',   label: t('sl_tabOverview'),   show: true },
    { key: 'activity',   label: t('sl_tabActivity'),   show: activities.length > 0 },
    { key: 'technical',  label: t('sl_tabTechnical'),  show: available.length > 0 },
    { key: 'trips',      label: t('sl_tabTrips'),      show: trips.length > 0 },
    { key: 'expenses',   label: t('sl_tabExpenses'),   show: canViewExpenses && expenses.length > 0 },
  ];
  const visibleTabs = TABS.filter(t => t.show);

  function onTabKeyDown(e: React.KeyboardEvent, idx: number) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const next = (idx + dir + visibleTabs.length) % visibleTabs.length;
    setActiveTab(visibleTabs[next].key);
    (document.getElementById(`sl-tab-${visibleTabs[next].key}`) as HTMLButtonElement | null)?.focus();
  }

  return (
    <div className={`${styles.summaryCard} ${slWorkTypeAccentClass(result.secLabel)}`}>
      <div className={styles.summaryHead}>
        <div className={styles.cardIconWrap}>
          <BuildingIcon />
        </div>
        <div className={styles.cardHeadTxt}>
          <span className={styles.cardTitle}>Site {siteId}</span>
          <div className={styles.cardBreadcrumb}>
            <span className={styles.cardProj}>{PROJ_NAMES[result.proj] || result.proj}</span>
            <span className={styles.cardBreadSep}>›</span>
            <span className={styles.cardSec}>{result.secLabel}</span>
            {primaryStat && (
              <span className={`${styles.badge} ${slStatClass(primaryStat.val)}`}>
                {slBadgeText(primaryStat.h, primaryStat.val)}
              </span>
            )}
          </div>
        </div>
        <div className={styles.summaryActions}>
          <button className={styles.primaryActBtn} onClick={onOpenProject}>
            <ExternalLinkIcon /> {t('sl_openProject')}
          </button>
          <button className={styles.actBtn} title="Copy to clipboard" aria-label="Share site record" onClick={onShare}>
            <ShareIcon />
          </button>
          <button className={styles.actBtn} title="Download as .txt" aria-label="Download site report" onClick={onExport}>
            <DownloadIcon />
          </button>
        </div>
      </div>

      <div className={styles.statRow}>
        <StatMini icon={<PinIcon />} label={t('sl_governorate')} value={gov} />
        {statFields.slice(0, 2).map(f => (
          <StatMini
            key={f.h}
            icon={<CheckCircleIcon />}
            cls={slStatClass(f.val)}
            label={slNormalizeLabel(f.h)}
            value={slDisplayValue(f.val)}
          />
        ))}
        <StatMini
          icon={<ClockIcon />}
          label={t('sl_lastActivity')}
          value={detailsLoading ? '…' : (lastActivity ? fmtDate(lastActivity.date) : t('sl_noActivityVal'))}
        />
        <StatMini
          icon={<TeamIcon />}
          label={t('sl_assignedTeam')}
          value={detailsLoading ? '…' : ((lastActivity?.team_member_names ?? []).join(', ') || '—')}
        />
      </div>

      <div className={styles.tabBar} role="tablist" aria-label="Site information">
        {visibleTabs.map((t, idx) => (
          <button
            key={t.key}
            id={`sl-tab-${t.key}`}
            role="tab"
            aria-selected={activeTab === t.key}
            aria-controls={`sl-panel-${t.key}`}
            tabIndex={activeTab === t.key ? 0 : -1}
            className={`${styles.tabBtn} ${activeTab === t.key ? styles.tabBtnActive : ''}`}
            onClick={() => setActiveTab(t.key)}
            onKeyDown={e => onTabKeyDown(e, idx)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className={styles.tabPanel} role="tabpanel" id={`sl-panel-${activeTab}`} aria-labelledby={`sl-tab-${activeTab}`}>
        {activeTab === 'overview' && (
          <div className={styles.overviewGrid}>
            <div className={styles.overviewCol}>
              <h3 className={styles.tabSectionTitle}>{t('sl_siteDetails')}</h3>
              <FieldGrid fields={plainFields} />
            </div>
            <div className={styles.overviewCol}>
              <h3 className={styles.tabSectionTitle}>{t('sl_deliveryStatus')}</h3>
              {statFields.length === 0 ? (
                <div className={styles.tabEmpty}>{t('sl_noStatusFields')}</div>
              ) : (
                <div className={styles.badges}>
                  {statFields.map(f => (
                    <span key={f.h} className={`${styles.badge} ${styles.badgeLg} ${slStatClass(f.val)}`}>
                      {slBadgeText(f.h, f.val)}
                    </span>
                  ))}
                </div>
              )}
              <h3 className={`${styles.tabSectionTitle} ${styles.tabSectionTitleSpaced}`}>{t('sl_assignment')}</h3>
              {detailsLoading ? (
                <div className={styles.tabEmpty}>{t('sl_loading')}</div>
              ) : lastActivity ? (
                <div className={styles.cardBody}>
                  <div className={styles.field}>
                    <span className={styles.fieldK}>{t('sl_lastTeam')}</span>
                    <span className={styles.fieldV}>{(lastActivity.team_member_names ?? []).join(', ') || '—'}</span>
                  </div>
                  <div className={styles.field}>
                    <span className={styles.fieldK}>{t('sl_lastActivityField')}</span>
                    <span className={styles.fieldV}>{lastActivity.activity_type || '—'}</span>
                  </div>
                  <div className={styles.field}>
                    <span className={styles.fieldK}>{t('sl_date')}</span>
                    <span className={styles.fieldV}>{fmtDate(lastActivity.date)}</span>
                  </div>
                  <div className={styles.field}>
                    <span className={styles.fieldK}>{t('sl_issuedBy')}</span>
                    <span className={styles.fieldV}>{lastActivity.created_by || '—'}</span>
                  </div>
                </div>
              ) : (
                <div className={styles.tabEmpty}>{t('sl_noActivityYet')}</div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'activity' && (
          <div className={styles.tableWrap}>
            <table className={styles.dataTable}>
              <thead>
                <tr>
                  <th>{t('sl_date')}</th><th>{t('sl_activity')}</th><th>{t('sl_status')}</th><th>{t('sl_team')}</th><th>{t('sl_issuedBy')}</th><th>{t('sl_notes')}</th>
                </tr>
              </thead>
              <tbody>
                {activities.map(a => (
                  <tr key={a.id}>
                    <td>{fmtDate(a.date)}</td>
                    <td>{a.activity_type || '—'}</td>
                    <td><span className={`${styles.badge} ${slStatClass(a.status)}`}>{a.status || '—'}</span></td>
                    <td>{(a.team_member_names ?? []).join(', ') || '—'}</td>
                    <td>{a.created_by || '—'}</td>
                    <td className={styles.notesCell}>{a.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'technical' && <FieldGrid fields={available} />}

        {activeTab === 'trips' && (
          <div className={styles.tableWrap}>
            <table className={styles.dataTable}>
              <thead>
                <tr><th>{t('sl_date')}</th><th>{t('sl_status')}</th><th>{t('sl_team')}</th><th>{t('sl_issuedBy')}</th><th>{t('sl_notes')}</th></tr>
              </thead>
              <tbody>
                {trips.map(t => (
                  <tr key={t.id}>
                    <td>{fmtDate(t.date)}</td>
                    <td><span className={`${styles.badge} ${slStatClass(t.status)}`}>{t.status || '—'}</span></td>
                    <td>{(t.team_member_names ?? []).join(', ') || '—'}</td>
                    <td>{t.created_by || '—'}</td>
                    <td className={styles.notesCell}>{t.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'expenses' && (
          <div className={styles.tableWrap}>
            <table className={styles.dataTable}>
              <thead>
                <tr><th>{t('sl_date')}</th><th>{t('sl_description')}</th><th>{t('sl_amount')}</th><th>{t('sl_status')}</th></tr>
              </thead>
              <tbody>
                {expenses.map(e => (
                  <tr key={e.id}>
                    <td>{fmtDate(e.activity_date)}</td>
                    <td>{e.description || '—'}</td>
                    <td>{typeof e.total_amount === 'number' ? e.total_amount.toLocaleString() : '—'}</td>
                    <td><span className={`${styles.badge} ${slStatClass(e.status)}`}>{e.status || '—'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Multi-match results table ────────────────────────────────────────────────

function ResultsTable({ results, onView }: { results: MatchResult[]; onView: (r: MatchResult) => void }) {
  const { t } = useTranslation();
  return (
    <div className={styles.tableWrap}>
      <table className={styles.dataTable}>
        <thead>
          <tr>
            <th>{t('sl_site')}</th><th>{t('sl_project')}</th><th>{t('sl_sectionCol')}</th><th>{t('sl_governorate')}</th><th>{t('sl_status')}</th><th></th>
          </tr>
        </thead>
        <tbody>
          {results.map((r, idx) => {
            const { statFields } = slGetFields(r);
            const primary = statFields[0];
            return (
              <tr key={idx}>
                <td className={styles.siteIdCell}>{slGetSiteId(r, '—')}</td>
                <td>{PROJ_NAMES[r.proj] || r.proj}</td>
                <td>{r.secLabel}</td>
                <td>{slGetGov(r)}</td>
                <td>
                  {primary ? (
                    <span className={`${styles.badge} ${slStatClass(primary.val)}`}>{slBadgeText(primary.h, primary.val)}</span>
                  ) : '—'}
                </td>
                <td>
                  <button className={styles.viewBtn} onClick={() => onView(r)}>{t('sl_view')}</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SiteLookup() {
  const { hasPerm } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);

  const [query,           setQuery]           = useState('');
  const [searching,       setSearching]       = useState(false);
  const [results,         setResults]         = useState<MatchResult[] | null>(null);
  const [lastQuery,       setLastQuery]       = useState('');
  const [projFilter,      setProjFilter]      = useState<string | null>(null);
  const [error,           setError]           = useState<string | null>(null);
  const [selected,        setSelected]        = useState<MatchResult | null>(null);
  const [sectionsMeta,    setSectionsMeta]    = useState<SectionMeta[]>([]);
  const [preProj,         setPreProj]         = useState<string>('');
  const [preSec,          setPreSec]          = useState<string>('');
  const [recentSearches,  setRecentSearches]  = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('tac_sl_recent') ?? '[]') as string[]; }
    catch { return []; }
  });
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { ensureSectionsLoaded().then(() => setSectionsMeta(getSections())); }, []);

  const permittedSections = useMemo(
    () => sectionsMeta.filter(s => !s.is_deleted && hasPerm(`view_${s.project_name}`)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sectionsMeta]
  );
  const projectOptions = useMemo(() => {
    const seen = new Set<string>();
    const list: Array<{ value: string; label: string }> = [];
    for (const s of permittedSections) {
      if (seen.has(s.project_name)) continue;
      seen.add(s.project_name);
      list.push({ value: s.project_name, label: PROJ_NAMES[s.project_name] || s.project_name });
    }
    return list.sort((a, b) => a.label.localeCompare(b.label));
  }, [permittedSections]);
  const sectionOptions = useMemo(() => {
    const seen = new Set<string>();
    const list: Array<{ value: string; label: string }> = [];
    for (const s of permittedSections) {
      if (preProj && s.project_name !== preProj) continue;
      if (seen.has(s.section_name)) continue;
      seen.add(s.section_name);
      list.push({ value: s.section_name, label: s.section_label ?? SEC_LABELS[s.section_name] ?? s.section_name });
    }
    return list.sort((a, b) => a.label.localeCompare(b.label));
  }, [permittedSections, preProj]);

  const filtersActive = preProj !== '' || preSec !== '';

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  function saveRecent(q: string) {
    setRecentSearches(prev => {
      const updated = [q, ...prev.filter(r => r !== q)].slice(0, 5);
      localStorage.setItem('tac_sl_recent', JSON.stringify(updated));
      return updated;
    });
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
    setSelected(null);

    try {
      await ensureSectionsLoaded();
      const sections = getSections().filter(s =>
        !s.is_deleted &&
        hasPerm(`view_${s.project_name}`) &&
        (!preProj || s.project_name === preProj) &&
        (!preSec || s.section_name === preSec)
      );
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
      if (matches.length === 1) setSelected(matches[0]);
      saveRecent(q);
    } catch {
      setError('Search failed. Please check your connection and try again.');
      setResults(null);
    } finally {
      setSearching(false);
    }
  }

  function clearSearch() {
    setQuery('');
    setResults(null);
    setSelected(null);
    setError(null);
    inputRef.current?.focus();
  }

  function resetFilters() {
    setPreProj('');
    setPreSec('');
  }

  function shareRecord(result: MatchResult) {
    const text = slRecordText(result, lastQuery);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => showToast(t('sl_copied'), true))
        .catch(() => showToast(t('sl_copyFailed'), false));
    } else {
      showToast(t('sl_clipboardNA'), false);
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
    showToast(t('sl_exported'), true);
  }

  function openProject(result: MatchResult) {
    navigate(`/network-scopes/${result.proj}/${result.sec}`);
  }

  // Derived state
  const availableProjects = results ? [...new Set(results.map(r => r.proj))] : [];
  const filteredResults   = (results ?? []).filter(r => projFilter === null || r.proj === projFilter);
  const showRecent        = results === null && !searching && recentSearches.length > 0;

  // ── Permission gate ──────────────────────────────────────────────────────────

  if (!hasPerm('view_site_lookup')) {
    return (
      <div className={styles.page}>
        <div className={styles.placeholder}>{t('sl_noPermission')}</div>
      </div>
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className={styles.page}>

      <div className={styles.pageHead}>
        <h1 className={styles.pageTitle}>{t('sl_title')}</h1>
        <p className={styles.pageSub}>{t('sl_subtitle')}</p>
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
              placeholder={t('sl_searchPh')}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } }}
              aria-label="Search sites"
            />
            {query && (
              <button className={styles.clearInputBtn} onClick={clearSearch} aria-label="Clear search">
                <XIcon />
              </button>
            )}
          </div>

          <select
            className={styles.filterSelect}
            value={preProj}
            onChange={e => { setPreProj(e.target.value); setPreSec(''); }}
            aria-label="Filter by project"
          >
            <option value="">{t('sl_allProjects')}</option>
            {projectOptions.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>

          <select
            className={styles.filterSelect}
            value={preSec}
            onChange={e => setPreSec(e.target.value)}
            aria-label="Filter by section"
            disabled={sectionOptions.length === 0}
          >
            <option value="">{t('sl_allSections')}</option>
            {sectionOptions.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>

          {filtersActive && (
            <button className={styles.clearFiltersBtn} onClick={resetFilters}>{t('sl_clearFilters')}</button>
          )}

          <button className={styles.searchBtn} onClick={() => runSearch()} disabled={searching}>
            {searching ? <><SpinnerIcon /> {t('sl_searching')}</> : t('sl_search')}
          </button>
        </div>

        {showRecent && (
          <div className={styles.recentRow}>
            <span className={styles.recentLabel}>{t('sl_recent')}</span>
            <div className={styles.recentChips}>
              {recentSearches.map(r => (
                <button key={r} className={styles.recentChip} onClick={() => runSearch(r)}>
                  <ClockIcon />
                  {r}
                </button>
              ))}
            </div>
            <button className={styles.clearRecentBtn} onClick={clearRecent}>{t('sl_clear')}</button>
          </div>
        )}
      </div>

      {/* Results area */}
      <div className={styles.resultsArea}>
        {searching ? (
          <SkeletonSummary />
        ) : error ? (
          <div className={styles.stateBox}>
            <div className={styles.stateIcon}><ErrorIcon /></div>
            <div className={`${styles.stateTitle} ${styles.stateTitleErr}`}>{t('sl_searchFailed')}</div>
            <div className={styles.stateSub}>{error}</div>
            <button className={styles.retryBtn} onClick={() => runSearch(lastQuery)}>{t('sl_retry')}</button>
          </div>
        ) : results === null ? (
          <div className={styles.stateBox}>
            <div className={styles.stateIconLg}><SearchBigIcon /></div>
            <div className={styles.stateTitleLg}>{t('sl_findSite')}</div>
            <div className={styles.stateSub}>{t('sl_findSiteDesc')}</div>
            {projectOptions.length > 0 && (
              <div className={styles.exampleChips}>
                {projectOptions.slice(0, 4).map(p => (
                  <button key={p.value} className={styles.exampleChip} onClick={() => runSearch(p.label)}>{p.label}</button>
                ))}
              </div>
            )}
          </div>
        ) : results.length === 0 ? (
          <div className={styles.stateBox}>
            <div className={styles.stateIcon}><EmptyIcon /></div>
            <div className={styles.stateTitle}>{t('sl_noResults')}</div>
            <div className={styles.stateSub}>
              No site records matched <strong>"{lastQuery}"</strong>. Try a different search term.
            </div>
            <div className={styles.noResultsActions}>
              <button className={styles.retryBtn} onClick={clearSearch}>{t('sl_clearSearch')}</button>
              {filtersActive && (
                <button className={styles.retryBtn} onClick={() => { resetFilters(); runSearch(lastQuery); }}>{t('sl_resetFilters')}</button>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className={styles.resultsHeader} aria-live="polite">
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
                    {t('sl_all')}
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

            {selected ? (
              <>
                {filteredResults.length > 1 && (
                  <button className={styles.backBtn} onClick={() => setSelected(null)}>
                    <ArrowLeftIcon /> {t('sl_backToResults')}
                  </button>
                )}
                <SiteSummary
                  result={selected}
                  lastQuery={lastQuery}
                  onShare={() => shareRecord(selected)}
                  onExport={() => exportRecord(selected)}
                  onOpenProject={() => openProject(selected)}
                />
              </>
            ) : (
              <ResultsTable results={filteredResults} onView={setSelected} />
            )}
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
    <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
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

function XIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg className={styles.spinner} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
      <circle cx="12" cy="12" r="9" opacity=".25"/>
      <path d="M21 12a9 9 0 0 0-9-9"/>
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
      <polyline points="15 3 21 3 21 9"/>
      <line x1="10" y1="14" x2="21" y2="3"/>
    </svg>
  );
}

function PinIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
      <circle cx="12" cy="10" r="3"/>
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10"/>
      <polyline points="8 12 11 15 16 9"/>
    </svg>
  );
}

function TeamIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  );
}

function ArrowLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="19" y1="12" x2="5" y2="12"/>
      <polyline points="12 19 5 12 12 5"/>
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
