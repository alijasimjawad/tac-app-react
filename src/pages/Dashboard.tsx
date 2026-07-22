import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { ensureSectionsLoaded, getSections, invalidateSections } from '../lib/sectionsCache';
import type { SectionMeta } from '../lib/sectionsCache';
import { isAtpAccepted, findImpColIdx, findAtpColIdx, PROJ_NAMES, SEC_LABELS } from './NetworkScopes';
import styles from './Dashboard.module.css';

// Mirrored from NetworkScopes.tsx — must stay in sync with that constant
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
  const headers = (meta.columns || []).filter(c => !LEGACY_DEFAULT_COLS.has(c) || customCols.has(c));
  const impIdx  = findImpColIdx(headers);
  const atpIdx  = findAtpColIdx(headers);

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

// ── Sub-components ────────────────────────────────────────────────────────────

function KPICard({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div className={styles.kpiCard}>
      <div className={styles.kpiValue} style={{ color }}>{value}</div>
      <div className={styles.kpiLabel}>{label}</div>
    </div>
  );
}

function ProgressBar({ label, count, total, color }: {
  label: string; count: number; total: number; color: string;
}) {
  const pct = total > 0 ? Math.min(100, Math.round((count / total) * 100)) : 0;
  return (
    <div className={styles.pbRow}>
      <div className={styles.pbMeta}>
        <span className={styles.pbLabel}>{label}</span>
        <span className={styles.pbCount}>
          {count} <span className={styles.pbPct}>({pct}%)</span>
        </span>
      </div>
      <div className={styles.pbTrack}>
        <div className={styles.pbFill} style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { hasPerm } = useAuth();
  const navigate    = useNavigate();

  const [loading,  setLoading]  = useState(true);
  const [projData, setProjData] = useState<ProjData[]>([]);
  const [toast, setToast]       = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  async function loadData(refresh = false) {
    setLoading(true);
    if (refresh) invalidateSections();
    await ensureSectionsLoaded();

    const allSections = getSections();
    const activeSections = allSections.filter(s => !s.is_deleted);

    // Batch-fetch all rows for all active DB sections in one query
    const sectionIds = activeSections.map(s => s.id).filter(Boolean);
    const rowsBySecId: Record<string, Record<string, string>[]> = {};

    if (sectionIds.length > 0) {
      const { data: rowsData } = await supabase
        .from('rows')
        .select('section_id, data')
        .in('section_id', sectionIds);

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
          // Built-in section not yet in DB (no data imported)
          secStats.push({ key, label, total: 0, installed: 0, atpAccepted: 0, atpRejected: 0, atpPending: 0 });
        }
      }

      result.push({ proj, sections: secStats });
    }

    setProjData(result);
    setLoading(false);
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

  // ── Aggregates ───────────────────────────────────────────────────────────────

  const allSecs       = projData.flatMap(p => p.sections);
  const grandTotal    = allSecs.reduce((s, x) => s + x.total, 0);
  const grandInstalled = allSecs.reduce((s, x) => s + x.installed, 0);
  const grandAccepted = allSecs.reduce((s, x) => s + x.atpAccepted, 0);
  const grandRejected = allSecs.reduce((s, x) => s + x.atpRejected, 0);
  const grandRemaining = grandTotal - grandAccepted - grandRejected;
  const grandAtpPct   = grandTotal > 0 ? Math.round((grandAccepted / grandTotal) * 100) : 0;

  const activeProjs  = projData.filter(p => p.sections.some(s => s.total > 0)).length;
  const noDataProjs  = projData.filter(p => p.sections.every(s => s.total === 0)).length;

  return (
    <div className={styles.page}>

      {/* ── Header ────────────────────────────────────────────────────────────── */}
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Dashboard</h1>
          <div className={styles.pageSubtitle}>Network Scope Delivery Overview</div>
        </div>
        <div className={styles.headerActions}>
          <button
            className={styles.exportBtn}
            onClick={() => showToast('Open a project section to export data', false)}
          >
            Export
          </button>
          <button
            className={styles.refreshBtn}
            onClick={() => loadData(true)}
            disabled={loading}
          >
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {loading ? (
        <div className={styles.loadingBar}>Loading dashboard data…</div>
      ) : (
        <>
          {/* ── KPI row ───────────────────────────────────────────────────────── */}
          <div className={styles.kpiRow}>
            <KPICard label="Total Target"  value={grandTotal}     color="var(--text-primary)" />
            <KPICard label="Installed"     value={grandInstalled} color="var(--accent)" />
            <KPICard label="ATP Accepted"  value={grandAccepted}  color="var(--green)" />
            <KPICard label="Remaining"     value={grandRemaining} color="var(--warning)" />
            <KPICard
              label="Overall ATP %"
              value={`${grandAtpPct}%`}
              color={grandAtpPct >= 100 ? 'var(--green)' : 'var(--accent)'}
            />
          </div>

          {/* ── Section sub-header ────────────────────────────────────────────── */}
          <div className={styles.sectionHdr}>
            <span className={styles.sectionHdrTitle}>Network Scope Projects</span>
            <span className={styles.sectionHdrMeta}>
              {projData.length} total · {activeProjs} active · {noDataProjs} no data
            </span>
          </div>

          {/* ── Project cards ─────────────────────────────────────────────────── */}
          <div className={styles.cardGrid}>
            {projData.map(({ proj, sections }) => {
              const projTotal     = sections.reduce((s, x) => s + x.total, 0);
              const projInstalled = sections.reduce((s, x) => s + x.installed, 0);
              const projAccepted  = sections.reduce((s, x) => s + x.atpAccepted, 0);
              const projRejected  = sections.reduce((s, x) => s + x.atpRejected, 0);
              const projPending   = sections.reduce((s, x) => s + x.atpPending, 0);

              const firstKey = sections[0]?.key ?? '';

              // Status badge
              let badgeLabel: string;
              let badgeCls: string;
              if (projTotal === 0) {
                badgeLabel = 'No Data'; badgeCls = styles.badgeGray;
              } else if (projInstalled >= projTotal) {
                badgeLabel = '✓ Complete'; badgeCls = styles.badgeGreen;
              } else if (projRejected / projTotal > 0.1) {
                badgeLabel = '● High Rejection'; badgeCls = styles.badgeRed;
              } else {
                badgeLabel = '● In Progress'; badgeCls = styles.badgeBlue;
              }

              // Section summary (e.g. "FTK, TDD, +1 more")
              const secLabels = sections.map(s => s.label);
              const secSummaryStr = sections.length <= 2
                ? secLabels.join(', ')
                : `${secLabels.slice(0, 2).join(', ')}, +${sections.length - 2} more`;

              // Per-section breakdown if more than one section has data
              const secsWithData = sections.filter(s => s.total > 0);
              const showPerSec   = secsWithData.length > 1;

              function goToProj() {
                if (firstKey) navigate(`/network-scopes/${proj}/${firstKey}`);
              }

              return (
                <div
                  key={proj}
                  className={styles.projCard}
                  onClick={goToProj}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && goToProj()}
                >
                  <div className={styles.cardHeader}>
                    <div className={styles.projAvatar} style={{ background: PROJ_COLORS[proj] }}>
                      {PROJ_INITIALS[proj]}
                    </div>
                    <div className={styles.cardHeaderText}>
                      <div className={styles.projName}>{PROJ_NAMES[proj]}</div>
                      <div className={styles.projSecSummary}>
                        {sections.length} section{sections.length !== 1 ? 's' : ''} · {secSummaryStr}
                      </div>
                    </div>
                    <span className={`${styles.badge} ${badgeCls}`}>{badgeLabel}</span>
                  </div>

                  {projTotal > 0 && (
                    <div className={styles.cardBody}>
                      {showPerSec ? (
                        secsWithData.map(sec => (
                          <div key={sec.key} className={styles.secBreakdown}>
                            <div className={styles.secBreakdownLabel}>{sec.label}</div>
                            <ProgressBar label="Installed"    count={sec.installed}    total={sec.total} color="var(--accent)" />
                            <ProgressBar label="ATP Accepted" count={sec.atpAccepted}  total={sec.total} color="var(--green)" />
                            {sec.atpRejected > 0 && (
                              <ProgressBar label="ATP Rejected" count={sec.atpRejected} total={sec.total} color="var(--red)" />
                            )}
                            <ProgressBar label="ATP Pending"  count={sec.atpPending}   total={sec.total} color="var(--warning)" />
                          </div>
                        ))
                      ) : (
                        <div>
                          <ProgressBar label="Installed"    count={projInstalled} total={projTotal} color="var(--accent)" />
                          <ProgressBar label="ATP Accepted" count={projAccepted}  total={projTotal} color="var(--green)" />
                          {projRejected > 0 && (
                            <ProgressBar label="ATP Rejected" count={projRejected} total={projTotal} color="var(--red)" />
                          )}
                          <ProgressBar label="ATP Pending"  count={projPending}   total={projTotal} color="var(--warning)" />
                        </div>
                      )}
                    </div>
                  )}

                  <div className={styles.cardFooter}>
                    <button
                      className={styles.openProjBtn}
                      onClick={e => { e.stopPropagation(); goToProj(); }}
                      disabled={!firstKey}
                    >
                      Open Project →
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ── Toast ─────────────────────────────────────────────────────────────── */}
      {toast && (
        <div className={`${styles.toast} ${toast.ok ? styles.toastOk : styles.toastErr}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
