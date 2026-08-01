import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
  Legend,
} from 'chart.js';
import { Doughnut } from 'react-chartjs-2';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { ensureSectionsLoaded, getSections, invalidateSections } from '../lib/sectionsCache';
import type { SectionMeta } from '../lib/sectionsCache';
import { ensureProjectsLoaded, getProjectKeys } from '../lib/projectsCache';
import { isAtpAccepted, findImpColIdx, findAtpColIdx, PROJ_NAMES, SEC_LABELS } from './NetworkScopes';
import styles from './Dashboard.module.css';

ChartJS.register(ArcElement, Tooltip, Legend);

// ── Constants (mirrored from NetworkScopes.tsx — must stay in sync) ───────────

// Note: 'Delivery' and 'Installation' were removed from this set — they're
// now part of the official default column template (see Sidebar.tsx
// DEFAULT_HEADERS) used for Current Revenue stage tracking, and must stay
// visible. Keep this list mirrored with NetworkScopes.tsx.
const LEGACY_DEFAULT_COLS = new Set([
  'RFTI',
  'Status of Integration', 'Integration date', 'Integration Date',
  'TDD', 'Subcon',
]);

const DEFAULT_SECTIONS: Record<string, string[]> = {
  zain:   ['ftk', 'tdd', 'addsector'],
  nokia:  ['ftk', 'tdd', 'addsector'],
  huawei: ['ftk', 'tdd', 'addsector'],
  ipt:    ['tdd'],
  moj:    ['ftk', 'tdd', 'addsector'],
};

const PROJ_COLORS: Record<string, string> = {
  zain: '#3B82F6', nokia: '#10B981', huawei: '#EF4444', ipt: '#F43F5E', moj: '#8B5CF6',
};

const PROJ_INITIALS: Record<string, string> = {
  zain: 'ZP', nokia: 'NP', huawei: 'HP', ipt: 'IP', moj: 'MJ',
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface SecStats {
  key: string;
  label: string;
  total: number;
  installed: number;
  atpAccepted: number;
  atpRejected: number;
  atpPending: number;
}

interface ProjData {
  proj: string;
  sections: SecStats[];
}

interface AttentionItem {
  kind: 'warning' | 'info';
  msg: string;
  to: string | null;
}

// ── Pure helpers (calculations identical to original) ─────────────────────────

function getSectionsForProj(
  proj: string,
  allSections: SectionMeta[],
): Array<{ key: string; label: string; meta: SectionMeta | null }> {
  const dbSecs = allSections.filter(s => s.project_name === proj && !s.is_deleted);
  const dbMap  = new Map(dbSecs.map(s => [s.section_name, s]));
  const result: Array<{ key: string; label: string; meta: SectionMeta | null }> = [];

  for (const key of DEFAULT_SECTIONS[proj] ?? []) {
    const deleted = allSections.find(
      s => s.project_name === proj && s.section_name === key && s.is_deleted,
    );
    if (deleted) continue;
    const dbSec = dbMap.get(key);
    result.push({ key, label: dbSec?.section_label ?? SEC_LABELS[key] ?? key, meta: dbSec ?? null });
  }

  for (const s of dbSecs) {
    if (s.is_custom) {
      result.push({ key: s.section_name, label: s.section_label, meta: s });
    }
  }

  return result;
}

function computeSecStats(
  meta: SectionMeta,
  rowDataArr: Record<string, string>[],
  key: string,
  label: string,
): SecStats {
  const customCols = new Set(meta.custom_columns || []);
  const headers    = (meta.columns || []).filter(c => !LEGACY_DEFAULT_COLS.has(c) || customCols.has(c));
  const impIdx     = findImpColIdx(headers);
  const atpIdx     = findAtpColIdx(headers);

  let installed = 0, atpAccepted = 0, atpRejected = 0;
  for (const data of rowDataArr) {
    const cells = headers.map(h => data[h] ?? '');
    if (impIdx >= 0 && (cells[impIdx] ?? '').trim()) installed++;
    if (atpIdx >= 0) {
      const v = (cells[atpIdx] ?? '').trim();
      if (isAtpAccepted(v)) atpAccepted++;
      else if (/^rejected$/i.test(v)) atpRejected++;
    }
  }

  const total = rowDataArr.length;
  return { key, label, total, installed, atpAccepted, atpRejected, atpPending: total - atpAccepted - atpRejected };
}

function calcPct(count: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((count / total) * 100)) : 0;
}

type TFn = (key: string, opts?: Record<string, unknown>) => string;

function getProjStatus(projTotal: number, projInstalled: number, projRejected: number) {
  if (projTotal === 0)                                   return { statusKey: 'dash_projStatus_noData',   cls: styles.badgeGray  };
  if (projInstalled >= projTotal)                        return { statusKey: 'dash_projStatus_complete', cls: styles.badgeGreen };
  if (projTotal > 0 && projRejected / projTotal > 0.1)  return { statusKey: 'dash_projStatus_highRej',  cls: styles.badgeRed   };
  return                                                        { statusKey: 'dash_projStatus_inProg',   cls: styles.badgeBlue  };
}

function formatRelativeTime(d: Date, t: TFn): string {
  const mins = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (mins < 1)   return t('dash_justNow');
  if (mins === 1)  return t('dash_minuteAgo');
  if (mins < 60)  return t('dash_minutesAgo', { count: mins });
  const h = Math.floor(mins / 60);
  return h === 1 ? t('dash_hourAgo') : t('dash_hoursAgo', { count: h });
}

// ── Icons ─────────────────────────────────────────────────────────────────────

const IconTarget = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>
  </svg>
);
const IconInstall = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
  </svg>
);
const IconCheck = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
  </svg>
);
const IconClock = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
  </svg>
);
const IconPercent = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>
  </svg>
);
const IconRefresh = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
    <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
  </svg>
);
const IconExport = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
  </svg>
);
const IconArrow = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h14M12 5l7 7-7 7"/>
  </svg>
);
const IconAlert = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
  </svg>
);
const IconInfo = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
  </svg>
);
const IconDatabase = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
  </svg>
);
const IconOk = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
  </svg>
);

// ── KPI Card ──────────────────────────────────────────────────────────────────

interface KpiCardProps {
  label: string;
  value: number | string;
  support: string;
  Icon: () => React.ReactElement;
  accentBg: string;
  accentColor: string;
  valueColor?: string;
}

function KpiCard({ label, value, support, Icon, accentBg, accentColor, valueColor }: KpiCardProps) {
  return (
    <div className={styles.kpiCard} style={{ borderBottomColor: accentColor }}>
      <div className={styles.kpiTop}>
        <div className={styles.kpiIconWrap} style={{ background: accentBg, color: accentColor }}>
          <Icon />
        </div>
        <span className={styles.kpiLabel}>{label}</span>
      </div>
      <div className={styles.kpiValue} style={{ color: valueColor ?? accentColor }}>{value}</div>
      <div className={styles.kpiSupport}>{support}</div>
    </div>
  );
}

// ── Overall Progress Card (donut + vertical legend) ──────────────────────────

const DONUT_BASE_OPTIONS = {
  cutout: '72%',
  plugins: { legend: { display: false }, tooltip: { enabled: false } },
  animation: { duration: 600 },
} as const;

function OverallProgressCard({ total, installed, accepted, rejected, remaining }: {
  total: number; installed: number; accepted: number; rejected: number; remaining: number;
}) {
  const { t } = useTranslation();
  const atpPct       = calcPct(accepted, total);
  const installedPct = calcPct(installed, total);
  const acceptedPct  = calcPct(accepted, total);
  const pendingPct   = calcPct(remaining, total);
  const rejectedPct  = calcPct(rejected, total);

  const donutData = {
    datasets: [{
      data: total > 0 ? [accepted, rejected, remaining] : [1],
      backgroundColor: total > 0 ? ['#16A34A', '#DC2626', '#F59E0B'] : ['#E2E8F0'],
      borderWidth: 0,
      hoverOffset: 4,
    }],
    labels: total > 0
      ? [t('dash_legendAtpAcc'), t('dash_rejected'), t('dash_legendPending')]
      : [t('dash_projStatus_noData')],
  };

  const legendRows = [
    { dot: styles.dotBlue,  labelKey: 'dash_legendInstalled' as const, count: installed, pct: installedPct },
    { dot: styles.dotGreen, labelKey: 'dash_legendAtpAcc'    as const, count: accepted,  pct: acceptedPct  },
    { dot: styles.dotAmber, labelKey: 'dash_legendPending'   as const, count: remaining, pct: pendingPct   },
    ...(rejected > 0 ? [{ dot: styles.dotRed, labelKey: 'dash_legendAtpRej' as const, count: rejected, pct: rejectedPct }] : []),
  ];

  return (
    <div className={styles.analyticsCard}>
      <h3 className={styles.analyticsTitle}>{t('dash_overallProgress')}</h3>
      <div className={styles.analyticsBody}>

        {/* Left: Donut */}
        <div className={styles.donutWrap}>
          <div className={styles.donutChart}>
            <Doughnut
              data={donutData}
              options={{
                ...DONUT_BASE_OPTIONS,
                plugins: {
                  ...DONUT_BASE_OPTIONS.plugins,
                  tooltip: {
                    enabled: true,
                    callbacks: { label: (ctx) => `${ctx.label}: ${ctx.parsed}` },
                  },
                },
              }}
              aria-label={`Overall ATP acceptance: ${atpPct}%`}
            />
            <div className={styles.donutCenter} aria-hidden="true">
              <span className={styles.donutPct}>{atpPct}%</span>
              <span className={styles.donutCenterLabel}>
                {t('dash_atpCenterLabel').split('\n').map((line, i, arr) => (
                  <React.Fragment key={i}>{line}{i < arr.length - 1 && <br />}</React.Fragment>
                ))}
              </span>
            </div>
          </div>
        </div>

        {/* Right: Vertical legend list */}
        <div className={styles.analyticsList}>
          {legendRows.map((row, i) => (
            <React.Fragment key={row.labelKey}>
              <div className={styles.analyticsLegendRow}>
                <span className={row.dot} aria-hidden="true" />
                <span className={styles.legendLabel}>{t(row.labelKey)}</span>
                <span className={styles.legendValue}>
                {row.count} <span className={styles.legendPct}>({row.pct}%)</span>
              </span>
              </div>
              {i < legendRows.length - 1 && <div className={styles.legendDivider} aria-hidden="true" />}
            </React.Fragment>
          ))}
          <div className={styles.acceptedBadge}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <circle cx="6" cy="6" r="6" fill="#1D4ED8"/>
              <polyline points="3,6.5 5.2,8.5 9,3.8" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {t('dash_sitesAccepted', { accepted, total })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Project Status Overview Card (donut + vertical legend) ───────────────────

function ProjectStatusCard({ projData }: { projData: ProjData[] }) {
  const { t } = useTranslation();
  const counts = { complete: 0, active: 0, highRejection: 0, noData: 0 };

  for (const { sections } of projData) {
    const pTotal      = sections.reduce((s, x) => s + x.total, 0);
    const pInstalled  = sections.reduce((s, x) => s + x.installed, 0);
    const pRejected   = sections.reduce((s, x) => s + x.atpRejected, 0);
    const { statusKey } = getProjStatus(pTotal, pInstalled, pRejected);
    if (statusKey === 'dash_projStatus_complete')     counts.complete++;
    else if (statusKey === 'dash_projStatus_inProg')  counts.active++;
    else if (statusKey === 'dash_projStatus_highRej') counts.highRejection++;
    else counts.noData++;
  }

  const n = projData.length;

  const donutValues: number[] = [];
  const donutColors: string[] = [];
  if (counts.complete > 0)       { donutValues.push(counts.complete);       donutColors.push('#16A34A'); }
  if (counts.active > 0)         { donutValues.push(counts.active);         donutColors.push('#2563EB'); }
  if (counts.highRejection > 0)  { donutValues.push(counts.highRejection);  donutColors.push('#7C3AED'); }
  if (counts.noData > 0)         { donutValues.push(counts.noData);         donutColors.push('#CBD5E1'); }

  const statusDonutData = {
    datasets: [{
      data: donutValues.length > 0 ? donutValues : [1],
      backgroundColor: donutColors.length > 0 ? donutColors : ['#E2E8F0'],
      borderWidth: 0,
      hoverOffset: 4,
    }],
  };

  const legendRows = [
    { id: 'complete', dot: styles.dotGreen,  labelKey: 'dash_complete'   as const, count: counts.complete,      pct: calcPct(counts.complete, n) },
    { id: 'active',   dot: styles.dotBlue,   labelKey: 'dash_activeLabel' as const, count: counts.active,        pct: calcPct(counts.active, n) },
    { id: 'nodata',   dot: styles.dotGray,   labelKey: 'dash_noDataLabel' as const, count: counts.noData,        pct: calcPct(counts.noData, n) },
    { id: 'atrisk',   dot: styles.dotPurple, labelKey: 'dash_atRisk'      as const, count: counts.highRejection, pct: calcPct(counts.highRejection, n) },
  ];

  return (
    <div className={styles.analyticsCard}>
      <h3 className={styles.analyticsTitle}>{t('dash_title')}</h3>
      <div className={styles.analyticsBody}>

        {/* Left: Donut */}
        <div className={styles.donutWrap}>
          <div className={styles.donutChart}>
            <Doughnut
              data={statusDonutData}
              options={DONUT_BASE_OPTIONS}
              aria-label="Project status distribution"
            />
            <div className={styles.donutCenter} aria-hidden="true">
              <span className={styles.donutPct}>{n}</span>
              <span className={styles.donutCenterLabel}>{t('dash_projects')}</span>
            </div>
          </div>
        </div>

        {/* Right: Status legend — always render all four rows */}
        <div className={styles.analyticsList}>
          {legendRows.map((row, i) => (
            <React.Fragment key={row.id}>
              <div className={styles.analyticsLegendRow}>
                <span className={row.dot} aria-hidden="true" />
                <span className={styles.legendLabel}>{t(row.labelKey)}</span>
                <span className={styles.legendValue}>
                {row.count} <span className={styles.legendPct}>({row.pct}%)</span>
              </span>
              </div>
              {i < legendRows.length - 1 && <div className={styles.legendDivider} aria-hidden="true" />}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Project Summary Card ──────────────────────────────────────────────────────

function ProjectSummaryCard({ data }: { data: ProjData }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const { proj, sections } = data;

  const projTotal     = sections.reduce((s, x) => s + x.total, 0);
  const projInstalled = sections.reduce((s, x) => s + x.installed, 0);
  const projAccepted  = sections.reduce((s, x) => s + x.atpAccepted, 0);
  const projRejected  = sections.reduce((s, x) => s + x.atpRejected, 0);
  const projPending   = sections.reduce((s, x) => s + x.atpPending, 0);
  const firstKey      = sections[0]?.key ?? '';
  const hasData       = projTotal > 0;
  const secsWithData  = sections.filter(s => s.total > 0);
  const { statusKey, cls: badgeCls } = getProjStatus(projTotal, projInstalled, projRejected);

  const secLabelStr = (() => {
    const labels = sections.map(s => s.label);
    if (labels.length === 0) return '';
    const shown = labels.length <= 2
      ? labels.join(', ')
      : `${labels.slice(0, 2).join(', ')}, +${labels.length - 2} more`;
    return ` · ${shown}`;
  })();

  function goToProj() {
    if (firstKey) navigate(`/network-scopes/${proj}/${firstKey}`);
  }

  return (
    <article className={styles.projCard} aria-label={`${PROJ_NAMES[proj]} project summary`}>

      {/* Card header */}
      <div className={styles.cardHeader}>
        <div className={styles.projAvatar} style={{ background: PROJ_COLORS[proj] }}>
          {PROJ_INITIALS[proj]}
        </div>
        <div className={styles.cardHeaderText}>
          <div className={styles.projName}>{PROJ_NAMES[proj]}</div>
          <div className={styles.projSecSummary}>
            {sections.length} section{sections.length !== 1 ? 's' : ''}{secLabelStr}
          </div>
        </div>
        <span className={`${styles.badge} ${badgeCls}`} aria-label={`Status: ${t(statusKey)}`}>
          {t(statusKey)}
        </span>
      </div>

      {/* No-data state */}
      {!hasData ? (
        <div className={styles.noDataBody}>
          <div className={styles.noDataIcon}><IconDatabase /></div>
          <p className={styles.noDataText}>{t('dash_noDelivery')}</p>
          <p className={styles.noDataSub}>{t('dash_sectionsReady')}</p>
        </div>
      ) : (
        <div className={styles.cardBody}>

          {/* 4-row stat breakdown with per-row progress bars */}
          {([
            { labelKey: 'dash_installed',   count: projInstalled, color: '#2563EB' },
            { labelKey: 'dash_atpAccepted', count: projAccepted,  color: '#16A34A' },
            { labelKey: 'dash_pending',     count: projPending,   color: '#D97706' },
            { labelKey: 'dash_rejected',    count: projRejected,  color: '#DC2626' },
          ] as const).map(row => {
            const pct = calcPct(row.count, projTotal);
            return (
              <div key={row.labelKey} className={styles.statRow}>
                <div className={styles.statRowHeader}>
                  <span className={styles.statLabel}>{t(row.labelKey)}</span>
                  <span className={styles.statValue} style={{ color: row.color }}>
                    {row.count}/{projTotal}
                    <span className={styles.statPct}> ({pct}%)</span>
                  </span>
                </div>
                <div className={styles.statBarTrack}>
                  <div className={styles.statBarFill} style={{ width: `${pct}%`, background: row.color }} />
                </div>
              </div>
            );
          })}

          {/* Section breakdown disclosure */}
          {secsWithData.length > 1 && (
            <div className={styles.disclosureWrap}>
              <button
                className={styles.disclosureToggle}
                onClick={() => setBreakdownOpen(v => !v)}
                aria-expanded={breakdownOpen}
                aria-controls={`breakdown-${proj}`}
              >
                <span>{t(breakdownOpen ? 'dash_hideBreakdown' : 'dash_viewBreakdown')}</span>
                <svg
                  className={`${styles.disclosureChevron} ${breakdownOpen ? styles.disclosureChevronOpen : ''}`}
                  width="13" height="13" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </button>
              <div
                id={`breakdown-${proj}`}
                className={`${styles.disclosureBody} ${breakdownOpen ? styles.disclosureBodyOpen : ''}`}
              >
                {secsWithData.map(sec => (
                  <div key={sec.key} className={styles.bdRow}>
                    <span className={styles.bdLabel}>{sec.label}</span>
                    <div className={styles.bdStats}>
                      <span className={styles.bdStat}>
                        <span className={styles.bdKey}>{t('dash_instAbbr')}</span>
                        {sec.installed}/{sec.total}
                      </span>
                      <span className={`${styles.bdStat} ${styles.bdStatGreen}`}>
                        <span className={styles.bdKey}>{t('dash_accAbbr')}</span>
                        {sec.atpAccepted}
                      </span>
                      <span className={`${styles.bdStat} ${styles.bdStatAmber}`}>
                        <span className={styles.bdKey}>{t('dash_pendAbbr')}</span>
                        {sec.atpPending}
                      </span>
                      {sec.atpRejected > 0 && (
                        <span className={`${styles.bdStat} ${styles.bdStatRed}`}>
                          <span className={styles.bdKey}>{t('dash_rejAbbr')}</span>
                          {sec.atpRejected}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Card footer */}
      <div className={styles.cardFooter}>
        <button
          className={styles.openProjBtn}
          onClick={goToProj}
          disabled={!firstKey}
          aria-label={`Open ${PROJ_NAMES[proj]} project`}
        >
          {t('dash_openProject')}
          <IconArrow />
        </button>
      </div>
    </article>
  );
}

// ── Recent Activity Panel ─────────────────────────────────────────────────────

function RecentActivity() {
  const { t } = useTranslation();
  return (
    <section className={styles.recentActivitySection} aria-labelledby="activity-heading">
      <h2 id="activity-heading" className={styles.sectionTitle}>
        <span className={styles.titleIconBadge} style={{ background: '#DCFCE7', color: '#16A34A' }} aria-hidden="true">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
        </span>
        {t('dash_recentActivity')}
      </h2>
      <div className={styles.activityEmpty}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg>
        <p>{t('dash_noRecentActivity')}</p>
      </div>
    </section>
  );
}

// ── Attention Panel ───────────────────────────────────────────────────────────

function AttentionPanel({ items }: { items: AttentionItem[] }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  return (
    <section className={styles.attentionSection} aria-labelledby="attention-heading">
      <h2 id="attention-heading" className={styles.sectionTitle}>
        <span className={styles.titleIconBadge} style={{ background: '#FEF3C7', color: '#D97706' }} aria-hidden="true">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
        </span>
        {t('dash_attRequired')}
      </h2>
      {items.length === 0 ? (
        <div className={styles.attentionOk}>
          <IconOk />
          <span>{t('dash_noIssues')}</span>
        </div>
      ) : (
        <div className={styles.attentionList}>
          {items.map((item, i) => (
            <div
              key={i}
              className={`${styles.attentionItem} ${item.kind === 'warning' ? styles.attentionWarning : styles.attentionInfo}`}
              onClick={() => item.to && navigate(item.to)}
              role={item.to ? 'button' : undefined}
              tabIndex={item.to ? 0 : undefined}
              onKeyDown={item.to ? (e => e.key === 'Enter' && navigate(item.to!)) : undefined}
              style={{ cursor: item.to ? 'pointer' : 'default' }}
            >
              <span className={styles.attentionIconWrap}>
                {item.kind === 'warning' ? <IconAlert /> : <IconInfo />}
              </span>
              <span className={styles.attentionMsg}>{item.msg}</span>
              {item.to && (
                <span className={styles.attentionArrow}><IconArrow /></span>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── Skeleton Loader ───────────────────────────────────────────────────────────

function DashboardSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading dashboard data">
      <div className={styles.skKpiRow}>
        {[0,1,2,3,4].map(i => (
          <div key={i} className={styles.skKpiCard}>
            <div className={`${styles.sk} ${styles.skIcon}`} />
            <div className={`${styles.sk} ${styles.skH1}`} />
            <div className={`${styles.sk} ${styles.skH2}`} />
          </div>
        ))}
      </div>
      <div className={styles.skAnalyticsRow}>
        <div className={`${styles.sk} ${styles.skAnalCard}`} />
        <div className={`${styles.sk} ${styles.skAnalCardSm}`} />
      </div>
      <div className={styles.skProjRow}>
        {[0,1,2,3].map(i => (
          <div key={i} className={`${styles.sk} ${styles.skProjCard}`} />
        ))}
      </div>
    </div>
  );
}

// ── Error State ───────────────────────────────────────────────────────────────

function ErrorState({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className={styles.errorState}>
      <div className={styles.errorIconWrap}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
      </div>
      <h3 className={styles.errorTitle}>{t('dash_errorTitle')}</h3>
      <p className={styles.errorMsg}>{t('dash_errorDesc')}</p>
      <button className={styles.retryBtn} onClick={onRetry}>{t('dash_tryAgain')}</button>
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { hasPerm }   = useAuth();
  const navigate      = useNavigate();
  const { t }         = useTranslation();

  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string | null>(null);
  const [projData,    setProjData]    = useState<ProjData[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [toast,       setToast]       = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Update "last updated" text every minute
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    if (!lastUpdated) return;
    const id = setInterval(() => forceUpdate(n => n + 1), 60_000);
    return () => clearInterval(id);
  }, [lastUpdated]);

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  async function loadData(refresh = false) {
    setLoading(true);
    setError(null);
    if (refresh) invalidateSections();

    try {
      await Promise.all([ensureSectionsLoaded(), ensureProjectsLoaded()]);
      const allSections    = getSections();
      const activeSections = allSections.filter(s => !s.is_deleted);
      const sectionIds     = activeSections.map(s => s.id).filter(Boolean);
      const rowsBySecId: Record<string, Record<string, string>[]> = {};

      if (sectionIds.length > 0) {
        const { data: rowsData, error: rowsError } = await supabase
          .from('rows')
          .select('section_id, data')
          .in('section_id', sectionIds);

        if (rowsError) throw rowsError;

        for (const r of rowsData ?? []) {
          if (!rowsBySecId[r.section_id]) rowsBySecId[r.section_id] = [];
          rowsBySecId[r.section_id].push(r.data as Record<string, string>);
        }
      }

      const result: ProjData[] = [];
      for (const proj of getProjectKeys()) {
        if (!hasPerm(`view_${proj}`)) continue;
        const projSections = getSectionsForProj(proj, allSections);
        const secStats: SecStats[] = [];

        for (const { key, label, meta } of projSections) {
          if (meta) {
            const rows = rowsBySecId[meta.id] ?? [];
            secStats.push(computeSecStats(meta, rows, key, label));
          } else {
            secStats.push({ key, label, total: 0, installed: 0, atpAccepted: 0, atpRejected: 0, atpPending: 0 });
          }
        }

        result.push({ proj, sections: secStats });
      }

      setProjData(result);
      setLastUpdated(new Date());
    } catch (err) {
      console.error('[Dashboard] Data load failed:', err);
      setError('Failed to load dashboard data.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!hasPerm('view_dashboard')) { setLoading(false); return; }
    loadData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Permission gate ──────────────────────────────────────────────────────────

  if (!hasPerm('view_dashboard')) {
    return (
      <div className={styles.page}>
        <div className={styles.placeholder}>{t('dash_noPermission')}</div>
      </div>
    );
  }

  // ── Aggregates (identical calculations to original) ──────────────────────────

  const allSecs        = projData.flatMap(p => p.sections);
  const grandTotal     = allSecs.reduce((s, x) => s + x.total, 0);
  const grandInstalled = allSecs.reduce((s, x) => s + x.installed, 0);
  const grandAccepted  = allSecs.reduce((s, x) => s + x.atpAccepted, 0);
  const grandRejected  = allSecs.reduce((s, x) => s + x.atpRejected, 0);
  const grandRemaining = grandTotal - grandAccepted - grandRejected;
  const grandAtpPct    = grandTotal > 0 ? Math.round((grandAccepted / grandTotal) * 100) : 0;
  const activeProjs    = projData.filter(p => p.sections.some(s => s.total > 0)).length;
  const noDataProjs    = projData.filter(p => p.sections.every(s => s.total === 0)).length;

  // ── Attention items ──────────────────────────────────────────────────────────

  const attentionItems: AttentionItem[] = [];

  if (noDataProjs > 0) {
    attentionItems.push({
      kind: 'info',
      msg: `${noDataProjs} project${noDataProjs !== 1 ? 's' : ''} have no delivery data yet`,
      to: null,
    });
  }

  for (const { proj, sections } of projData) {
    for (const sec of sections) {
      if (sec.atpRejected > 0) {
        attentionItems.push({
          kind: 'warning',
          msg: `${sec.atpRejected} ATP record${sec.atpRejected !== 1 ? 's' : ''} rejected in ${PROJ_NAMES[proj]} — ${sec.label}`,
          to: `/network-scopes/${proj}/${sec.key}`,
        });
      }
    }
  }

  for (const { proj, sections } of projData) {
    for (const sec of sections) {
      if (sec.total > 0 && sec.atpPending > 50) {
        attentionItems.push({
          kind: 'info',
          msg: `${sec.atpPending} ATP items pending in ${PROJ_NAMES[proj]} — ${sec.label}`,
          to: `/network-scopes/${proj}/${sec.key}`,
        });
      }
    }
  }

  const uniqueAttention = attentionItems.slice(0, 5);

  return (
    <div className={styles.page}>

      {/* ── Page header ──────────────────────────────────────────────────────── */}
      <div className={styles.pageHeader}>
        <div className={styles.pageTitleBlock}>
          <h1 className={styles.pageTitle}>{t('dash_pageTitle')}</h1>
          <p className={styles.pageSubtitle}>{t('dash_subtitle')}</p>
        </div>
        <div className={styles.headerRight}>
          {lastUpdated && (
            <span className={styles.lastUpdated}>
              {t('dash_updatedAt', { time: formatRelativeTime(lastUpdated, t) })}
            </span>
          )}
          <div className={styles.headerActions}>
            <button
              className={styles.exportBtn}
              onClick={() => showToast(t('dash_exportToast'), false)}
            >
              <IconExport />
              {t('dash_export')}
            </button>
            <button
              className={styles.refreshBtn}
              onClick={() => loadData(true)}
              disabled={loading}
            >
              <IconRefresh />
              {loading ? t('ns_loading') : t('dash_refreshBtn')}
            </button>
          </div>
        </div>
      </div>

      {/* ── Content ──────────────────────────────────────────────────────────── */}
      {loading ? (
        <DashboardSkeleton />
      ) : error ? (
        <ErrorState onRetry={() => loadData(true)} />
      ) : (
        <>
          {/* ── KPI grid ─────────────────────────────────────────────────────── */}
          <div className={styles.kpiGrid}>
            <KpiCard
              label={t('dash_totalTarget')}
              value={grandTotal}
              support={t('dash_totalTargetSup')}
              Icon={IconTarget}
              accentBg="#EFF6FF"
              accentColor="#1D4ED8"
              valueColor="#0F172A"
            />
            <KpiCard
              label={t('dash_kpiInstalled')}
              value={grandInstalled}
              support={t('dash_kpiInstalledSup')}
              Icon={IconInstall}
              accentBg="#EFF6FF"
              accentColor="#2563EB"
            />
            <KpiCard
              label={t('dash_kpiAtpAcc')}
              value={grandAccepted}
              support={t('dash_kpiAtpAccSup')}
              Icon={IconCheck}
              accentBg="#F0FDF4"
              accentColor="#16A34A"
            />
            <KpiCard
              label={t('dash_kpiRemaining')}
              value={grandRemaining}
              support={t('dash_kpiRemainingSup')}
              Icon={IconClock}
              accentBg="#FFFBEB"
              accentColor="#D97706"
            />
            <KpiCard
              label={t('dash_kpiAtpPct')}
              value={`${grandAtpPct}%`}
              support={t('dash_kpiAtpPctSup')}
              Icon={IconPercent}
              accentBg="#F5F3FF"
              accentColor="#7C3AED"
            />
          </div>

          {/* ── Analytics row ────────────────────────────────────────────────── */}
          <div className={styles.analyticsRow}>
            <OverallProgressCard
              total={grandTotal}
              installed={grandInstalled}
              accepted={grandAccepted}
              rejected={grandRejected}
              remaining={grandRemaining}
            />
            <ProjectStatusCard projData={projData} />
          </div>

          {/* ── Projects section ─────────────────────────────────────────────── */}
          <section className={styles.projectsSection} aria-labelledby="projects-heading">
            <div className={styles.sectionHdr}>
              <div className={styles.sectionHdrLeft}>
                <h2 id="projects-heading" className={styles.sectionTitle}>{t('dash_projHeader')}</h2>
                <span className={styles.sectionMeta}>
                  {t('dash_projCount', { total: projData.length, active: activeProjs, noData: noDataProjs })}
                </span>
              </div>
              <button
                type="button"
                className={styles.sectionViewAll}
                onClick={() => navigate('/network-scopes')}
              >
                {t('dash_viewAllProjects')}
              </button>
            </div>
            <div className={styles.projectGrid}>
              {projData.map(pd => (
                <ProjectSummaryCard key={pd.proj} data={pd} />
              ))}
            </div>
          </section>

          {/* ── Bottom panel: Attention + Recent Activity ────────────────────── */}
          <div className={styles.bottomPanel}>
            <AttentionPanel items={uniqueAttention} />
            <RecentActivity />
          </div>
        </>
      )}

      {/* ── Toast ────────────────────────────────────────────────────────────── */}
      {toast && (
        <div className={`${styles.toast} ${toast.ok ? styles.toastOk : styles.toastErr}`} role="status">
          {toast.msg}
        </div>
      )}
    </div>
  );
}
