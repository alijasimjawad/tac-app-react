import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { isAtpAccepted, findImpColIdx, findAtpColIdx, PROJ_NAMES, SEC_LABELS } from './NetworkScopes';
import styles from './Dashboard.module.css';

ChartJS.register(ArcElement, Tooltip, Legend);

// ── Constants (mirrored from NetworkScopes.tsx — must stay in sync) ───────────

const LEGACY_DEFAULT_COLS = new Set([
  'RFTI', 'Delivery', 'Installation',
  'Status of Integration', 'Integration date', 'Integration Date',
  'TDD', 'Subcon',
]);

const DEFAULT_SECTIONS: Record<string, string[]> = {
  zain:   ['ftk', 'tdd', 'addsector'],
  nokia:  ['ftk', 'tdd', 'addsector'],
  huawei: ['ftk', 'tdd', 'addsector'],
  ipt:    ['tdd'],
};

const PROJECTS = ['zain', 'nokia', 'huawei', 'ipt'] as const;

const PROJ_COLORS: Record<string, string> = {
  zain: '#3B82F6', nokia: '#10B981', huawei: '#EF4444', ipt: '#F43F5E',
};

const PROJ_INITIALS: Record<string, string> = {
  zain: 'ZP', nokia: 'NP', huawei: 'HP', ipt: 'IP',
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

function getProjStatus(projTotal: number, projInstalled: number, projRejected: number) {
  if (projTotal === 0)                            return { label: 'No Data',        cls: styles.badgeGray  };
  if (projInstalled >= projTotal)                 return { label: 'Complete',       cls: styles.badgeGreen };
  if (projTotal > 0 && projRejected / projTotal > 0.1) return { label: 'High Rejection', cls: styles.badgeRed   };
  return                                                 { label: 'In Progress',    cls: styles.badgeBlue  };
}

function formatRelativeTime(d: Date): string {
  const mins = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (mins < 1)  return 'just now';
  if (mins === 1) return '1 minute ago';
  if (mins < 60) return `${mins} minutes ago`;
  const h = Math.floor(mins / 60);
  return h === 1 ? '1 hour ago' : `${h} hours ago`;
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
}

function KpiCard({ label, value, support, Icon, accentBg, accentColor }: KpiCardProps) {
  return (
    <div className={styles.kpiCard}>
      <div className={styles.kpiTop}>
        <div className={styles.kpiIconWrap} style={{ background: accentBg, color: accentColor }}>
          <Icon />
        </div>
        <span className={styles.kpiLabel}>{label}</span>
      </div>
      <div className={styles.kpiValue} style={{ color: accentColor }}>{value}</div>
      <div className={styles.kpiSupport}>{support}</div>
    </div>
  );
}

// ── Overall Progress Card (donut + segmented bar) ─────────────────────────────

const DONUT_OPTIONS = {
  cutout: '72%',
  plugins: {
    legend: { display: false },
    tooltip: { enabled: true },
  },
  animation: { duration: 600 },
} as const;

function OverallProgressCard({ total, installed, accepted, rejected, remaining }: {
  total: number; installed: number; accepted: number; rejected: number; remaining: number;
}) {
  const atpPct       = calcPct(accepted, total);
  const acceptedPct  = calcPct(accepted, total);
  const rejectedPct  = calcPct(rejected, total);
  const remainingPct = calcPct(remaining, total);
  const installedPct = calcPct(installed, total);

  const donutData = {
    datasets: [{
      data: total > 0 ? [accepted, rejected, remaining] : [1],
      backgroundColor: total > 0
        ? ['#16A34A', '#DC2626', '#E2E8F0']
        : ['#E2E8F0'],
      borderWidth: 0,
      hoverOffset: 4,
    }],
    labels: total > 0 ? ['ATP Accepted', 'Rejected', 'Pending'] : ['No Data'],
  };

  return (
    <div className={styles.analyticsCard}>
      <h3 className={styles.analyticsTitle}>Overall Delivery Progress</h3>
      <div className={styles.overallBody}>

        {/* Donut */}
        <div className={styles.donutWrap}>
          <div className={styles.donutChart}>
            <Doughnut
              data={donutData}
              options={{
                ...DONUT_OPTIONS,
                plugins: {
                  ...DONUT_OPTIONS.plugins,
                  tooltip: {
                    callbacks: {
                      label: (ctx) => `${ctx.label}: ${ctx.parsed}`,
                    },
                  },
                },
              }}
              aria-label={`Overall ATP acceptance: ${atpPct}%`}
            />
            <div className={styles.donutCenter} aria-hidden="true">
              <span className={styles.donutPct}>{atpPct}%</span>
              <span className={styles.donutCenterLabel}>ATP</span>
            </div>
          </div>
          <div className={styles.donutStat}>
            <span className={styles.donutStatValue}>{accepted}</span>
            <span className={styles.donutStatLabel}>of {total} sites accepted</span>
          </div>
        </div>

        {/* Right: segmented bar + legend + installed row */}
        <div className={styles.deliveryDetails}>
          <div
            className={styles.segBar}
            role="img"
            aria-label={`Delivery breakdown: ${acceptedPct}% accepted, ${rejectedPct}% rejected, ${remainingPct}% pending`}
          >
            {total > 0 ? (
              <>
                {accepted > 0 && <div className={styles.segGreen} style={{ width: `${acceptedPct}%` }} />}
                {rejected > 0 && <div className={styles.segRed}   style={{ width: `${rejectedPct}%` }} />}
                {remaining > 0 && <div className={styles.segAmber} style={{ width: `${remainingPct}%` }} />}
              </>
            ) : (
              <div className={styles.segEmpty} style={{ width: '100%' }} />
            )}
          </div>

          <div className={styles.segLegend}>
            <span className={styles.segLegendItem}>
              <span className={styles.dotGreen} aria-hidden="true" />
              ATP Accepted
              <strong className={styles.segCount}>{accepted}</strong>
            </span>
            {rejected > 0 && (
              <span className={styles.segLegendItem}>
                <span className={styles.dotRed} aria-hidden="true" />
                Rejected
                <strong className={styles.segCount}>{rejected}</strong>
              </span>
            )}
            <span className={styles.segLegendItem}>
              <span className={styles.dotAmber} aria-hidden="true" />
              Pending
              <strong className={styles.segCount}>{remaining}</strong>
            </span>
          </div>

          <div className={styles.dividerLine} aria-hidden="true" />

          <div className={styles.installedRow}>
            <span className={styles.installedLabel}>
              <span className={styles.dotBlue} aria-hidden="true" />
              Installed
            </span>
            <span className={styles.installedVal}>
              {installed} / {total}
              <span className={styles.installedPct}>{installedPct}%</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Project Status Overview Card ──────────────────────────────────────────────

function ProjectStatusCard({ projData }: { projData: ProjData[] }) {
  const counts = { complete: 0, inProgress: 0, highRejection: 0, noData: 0 };

  for (const { sections } of projData) {
    const pTotal     = sections.reduce((s, x) => s + x.total, 0);
    const pInstalled = sections.reduce((s, x) => s + x.installed, 0);
    const pRejected  = sections.reduce((s, x) => s + x.atpRejected, 0);
    const { label }  = getProjStatus(pTotal, pInstalled, pRejected);
    if (label === 'Complete')       counts.complete++;
    else if (label === 'In Progress') counts.inProgress++;
    else if (label === 'High Rejection') counts.highRejection++;
    else counts.noData++;
  }

  const statusRows = [
    { label: 'Complete',       count: counts.complete,       dot: styles.dotGreen, text: '#16A34A', bg: '#F0FDF4' },
    { label: 'In Progress',    count: counts.inProgress,     dot: styles.dotBlue,  text: '#1D4ED8', bg: '#EFF6FF' },
    { label: 'High Rejection', count: counts.highRejection,  dot: styles.dotRed,   text: '#DC2626', bg: '#FEF2F2' },
    { label: 'No Data',        count: counts.noData,         dot: styles.dotGray,  text: '#64748B', bg: '#F8FAFC' },
  ].filter(r => r.count > 0 || r.label === 'No Data');

  return (
    <div className={styles.analyticsCard}>
      <h3 className={styles.analyticsTitle}>Project Status Overview</h3>
      <div className={styles.statusBody}>

        <div className={styles.statusTotalRow}>
          <span className={styles.statusTotal}>{projData.length}</span>
          <span className={styles.statusTotalLabel}>total projects</span>
        </div>

        <div className={styles.statusList} role="list">
          {statusRows.map(row => (
            <div key={row.label} className={styles.statusItem} role="listitem">
              <span className={row.dot} aria-hidden="true" />
              <span className={styles.statusLabel}>{row.label}</span>
              <span className={styles.statusCount} style={{ color: row.text, background: row.bg }}>
                {row.count}
              </span>
            </div>
          ))}
        </div>

        {/* Visual stacked bar */}
        <div className={styles.statusBar} role="img" aria-label="Project status distribution">
          {counts.complete > 0      && <div className={styles.statusBarGreen} style={{ flex: counts.complete }} />}
          {counts.inProgress > 0    && <div className={styles.statusBarBlue}  style={{ flex: counts.inProgress }} />}
          {counts.highRejection > 0 && <div className={styles.statusBarRed}   style={{ flex: counts.highRejection }} />}
          {counts.noData > 0        && <div className={styles.statusBarGray}  style={{ flex: counts.noData }} />}
        </div>
      </div>
    </div>
  );
}

// ── Project Summary Card ──────────────────────────────────────────────────────

function ProjectSummaryCard({ data }: { data: ProjData }) {
  const navigate = useNavigate();
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
  const atpPct        = calcPct(projAccepted, projTotal);
  const { label: badgeLabel, cls: badgeCls } = getProjStatus(projTotal, projInstalled, projRejected);

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
            {sections.length} section{sections.length !== 1 ? 's' : ''}
          </div>
        </div>
        <span className={`${styles.badge} ${badgeCls}`} aria-label={`Status: ${badgeLabel}`}>
          {badgeLabel}
        </span>
      </div>

      {/* No-data state */}
      {!hasData ? (
        <div className={styles.noDataBody}>
          <div className={styles.noDataIcon}><IconDatabase /></div>
          <p className={styles.noDataText}>No delivery data available yet.</p>
          <p className={styles.noDataSub}>Sections are configured and ready for updates.</p>
        </div>
      ) : (
        <div className={styles.cardBody}>

          {/* Summary metric grid */}
          <div className={styles.metricRow}>
            <div className={styles.metric}>
              <span className={styles.metricLabel}>Installed</span>
              <span className={styles.metricValue}>
                {projInstalled}
                <span className={styles.metricOf}>/{projTotal}</span>
              </span>
            </div>
            <div className={styles.metric}>
              <span className={styles.metricLabel}>ATP Accepted</span>
              <span className={styles.metricValue} style={{ color: '#16A34A' }}>
                {projAccepted}
                <span className={styles.metricOf} style={{ color: '#94A3B8' }}>/{projTotal}</span>
              </span>
            </div>
            <div className={styles.metric}>
              <span className={styles.metricLabel}>Pending</span>
              <span className={styles.metricValue} style={{ color: '#D97706' }}>{projPending}</span>
            </div>
            {projRejected > 0 && (
              <div className={styles.metric}>
                <span className={styles.metricLabel}>Rejected</span>
                <span className={styles.metricValue} style={{ color: '#DC2626' }}>{projRejected}</span>
              </div>
            )}
          </div>

          {/* ATP progress bar */}
          <div className={styles.atpProgressWrap}>
            <div
              className={styles.atpProgressBar}
              role="progressbar"
              aria-valuenow={atpPct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`ATP accepted ${atpPct}%`}
            >
              <div className={styles.atpProgressFill} style={{ width: `${atpPct}%` }} />
            </div>
            <span className={styles.atpPct}>{atpPct}%</span>
          </div>

          {/* Section breakdown disclosure */}
          {secsWithData.length > 1 && (
            <div className={styles.disclosureWrap}>
              <button
                className={styles.disclosureToggle}
                onClick={() => setBreakdownOpen(v => !v)}
                aria-expanded={breakdownOpen}
                aria-controls={`breakdown-${proj}`}
              >
                <span>{breakdownOpen ? 'Hide' : 'View'} section breakdown</span>
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
                        <span className={styles.bdKey}>Inst</span>
                        {sec.installed}/{sec.total}
                      </span>
                      <span className={`${styles.bdStat} ${styles.bdStatGreen}`}>
                        <span className={styles.bdKey}>Acc</span>
                        {sec.atpAccepted}
                      </span>
                      <span className={`${styles.bdStat} ${styles.bdStatAmber}`}>
                        <span className={styles.bdKey}>Pend</span>
                        {sec.atpPending}
                      </span>
                      {sec.atpRejected > 0 && (
                        <span className={`${styles.bdStat} ${styles.bdStatRed}`}>
                          <span className={styles.bdKey}>Rej</span>
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
          Open Project
          <IconArrow />
        </button>
      </div>
    </article>
  );
}

// ── Attention Panel ───────────────────────────────────────────────────────────

function AttentionPanel({ items }: { items: AttentionItem[] }) {
  const navigate = useNavigate();
  return (
    <section className={styles.attentionSection} aria-labelledby="attention-heading">
      <h2 id="attention-heading" className={styles.sectionTitle}>Attention Required</h2>
      {items.length === 0 ? (
        <div className={styles.attentionOk}>
          <IconOk />
          <span>No critical issues detected.</span>
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
  return (
    <div className={styles.errorState}>
      <div className={styles.errorIconWrap}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
      </div>
      <h3 className={styles.errorTitle}>Unable to load dashboard</h3>
      <p className={styles.errorMsg}>There was a problem fetching project data. Please try again.</p>
      <button className={styles.retryBtn} onClick={onRetry}>Try again</button>
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { hasPerm }   = useAuth();

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
      await ensureSectionsLoaded();
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
      for (const proj of PROJECTS) {
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
        <div className={styles.placeholder}>You don't have permission to view this page.</div>
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
          <h1 className={styles.pageTitle}>Dashboard</h1>
          <p className={styles.pageSubtitle}>Network Scope Delivery Overview</p>
        </div>
        <div className={styles.headerRight}>
          {lastUpdated && (
            <span className={styles.lastUpdated}>
              Updated {formatRelativeTime(lastUpdated)}
            </span>
          )}
          <div className={styles.headerActions}>
            <button
              className={styles.exportBtn}
              onClick={() => showToast('Open a project section to export data', false)}
            >
              <IconExport />
              Export
            </button>
            <button
              className={styles.refreshBtn}
              onClick={() => loadData(true)}
              disabled={loading}
            >
              <IconRefresh />
              {loading ? 'Loading…' : 'Refresh'}
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
              label="Total Target"
              value={grandTotal}
              support={`Across ${projData.length} network projects`}
              Icon={IconTarget}
              accentBg="#EFF6FF"
              accentColor="#1D4ED8"
            />
            <KpiCard
              label="Installed"
              value={grandInstalled}
              support={`${calcPct(grandInstalled, grandTotal)}% of total target`}
              Icon={IconInstall}
              accentBg="#EFF6FF"
              accentColor="#2563EB"
            />
            <KpiCard
              label="ATP Accepted"
              value={grandAccepted}
              support={`${grandAtpPct}% acceptance rate`}
              Icon={IconCheck}
              accentBg="#F0FDF4"
              accentColor="#16A34A"
            />
            <KpiCard
              label="Remaining"
              value={grandRemaining}
              support={grandRejected > 0 ? `Including ${grandRejected} rejected` : 'Pending acceptance'}
              Icon={IconClock}
              accentBg="#FFFBEB"
              accentColor="#D97706"
            />
            <KpiCard
              label="Overall ATP %"
              value={`${grandAtpPct}%`}
              support={`${grandAccepted} of ${grandTotal} sites accepted`}
              Icon={IconPercent}
              accentBg={grandAtpPct >= 100 ? '#F0FDF4' : '#F0FDFA'}
              accentColor={grandAtpPct >= 100 ? '#16A34A' : '#0D9488'}
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
              <div>
                <h2 id="projects-heading" className={styles.sectionTitle}>Network Scope Projects</h2>
                <p className={styles.sectionMeta}>
                  {projData.length} total · {activeProjs} active · {noDataProjs} no data
                </p>
              </div>
            </div>
            <div className={styles.projectGrid}>
              {projData.map(pd => (
                <ProjectSummaryCard key={pd.proj} data={pd} />
              ))}
            </div>
          </section>

          {/* ── Attention panel ──────────────────────────────────────────────── */}
          <AttentionPanel items={uniqueAttention} />
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
