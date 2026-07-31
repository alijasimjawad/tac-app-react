import { useState, useEffect, useCallback } from 'react';
import { Chart as ChartJS, ArcElement, Tooltip, Legend } from 'chart.js';
import { Doughnut } from 'react-chartjs-2';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { FIN_MONTHS, iqd, getYears } from '../lib/finHelpers';
import css from './FinPerformance.module.css';

ChartJS.register(ArcElement, Tooltip, Legend);

const CHART_COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6','#f97316','#64748b','#84cc16'];

const DOUGHNUT_OPTS = {
  responsive: true,
  maintainAspectRatio: true,
  plugins: {
    legend: { position: 'bottom' as const, labels: { font: { size: 11 }, boxWidth: 12 } },
  },
};

// ── Types ──────────────────────────────────────────────────────────────────────

interface TeamMember {
  id: string;
  full_name: string;
  role: string | null;
  monthly_salary: number | null;
  is_active: boolean | null;
  activated_at: string | null;
  deactivated_at: string | null;
}

interface SalAdj {
  member_id: string;
  month: number;
  year: number;
  adjusted_amount: number;
  adj_type: string;
  reason: string | null;
}

interface ActiveMember extends TeamMember {
  daysActive: number;
  totalCalDays: number;
  proratedSalary: number;
  effectiveSalary: number;
  isAdjusted: boolean;
  adjType: string;
  adjAmount: number;
  adjReason: string;
}

interface AttRow {
  member_id: string;
  date: string;
  clock_in: string | null;
  clock_out: string | null;
  hours_worked: number | null;
}

interface ActivityRow {
  date: string;
  project: string | null;
  team_member_ids: string[] | null;
}

interface FieldTripRow {
  id: string;
  date: string;
  project: string | null;
  team_member_ids: string[] | null;
}

interface ProjAttrib {
  project: string;
  days: number;
  cost: number;
}

interface PerfRow extends ActiveMember {
  daysWorked: number;
  hoursWorked: number;
  dailyRate: number;
  projAttribs: ProjAttrib[];
  attRows: AttRow[];
}

type SortCol = 'name' | 'daysWorked' | 'hoursWorked' | 'dailyRate' | 'cost';

// ── Helpers ────────────────────────────────────────────────────────────────────

// Exact copy of buildTeamWithSalary from FinReport.tsx — keeps numbers in sync.
function buildTeamWithSalary(
  team: TeamMember[],
  adjs: SalAdj[],
  month: number,
  year: number,
): ActiveMember[] {
  const dFirst    = new Date(year, month - 1, 1);
  const dLast     = new Date(year, month, 0);
  const dFirstStr = `${year}-${String(month).padStart(2, '0')}-01`;
  const dLastStr  = `${year}-${String(month).padStart(2, '0')}-${String(dLast.getDate()).padStart(2, '0')}`;
  const totalCalDays = dLast.getDate();

  return team.filter(t => {
    if (!t.activated_at) return t.is_active !== false;
    const act = new Date(t.activated_at + 'T00:00:00');
    if (act > dLast) return false;
    if (t.deactivated_at) {
      const deact = new Date(t.deactivated_at + 'T00:00:00');
      if (deact < dFirst) return false;
    }
    return true;
  }).map(t => {
    const actStr   = (t.activated_at && t.activated_at > dFirstStr) ? t.activated_at : dFirstStr;
    const deactStr = (t.deactivated_at && t.deactivated_at < dLastStr) ? t.deactivated_at : dLastStr;
    const daysActive     = Math.round((new Date(deactStr + 'T00:00:00').getTime() - new Date(actStr + 'T00:00:00').getTime()) / 86400000) + 1;
    const proratedSalary = Math.round((+(t.monthly_salary ?? 0)) / totalCalDays * daysActive);
    const adj            = adjs.find(a => a.member_id === t.id);
    const adjType        = adj?.adj_type || 'override';
    const adjAmount      = adj ? +adj.adjusted_amount : 0;
    let effectiveSalary  = proratedSalary;
    if (adj) {
      if (adjType === 'bonus')          effectiveSalary = proratedSalary + adjAmount;
      else if (adjType === 'deduction') effectiveSalary = Math.max(0, proratedSalary - adjAmount);
      else                              effectiveSalary = adjAmount;
    }
    return { ...t, daysActive, totalCalDays, proratedSalary, effectiveSalary, isAdjusted: !!adj, adjType, adjAmount, adjReason: adj?.reason || '' };
  });
}

function initials(name: string): string {
  return name.split(' ').slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
}

function fmtTime(t: string | null | undefined): string {
  if (!t) return '—';
  return t.slice(0, 5);
}

function computeProjAttribs(
  memberId: string,
  activities: ActivityRow[],
  dailyRate: number,
): ProjAttrib[] {
  const memberActivities = activities.filter(a =>
    Array.isArray(a.team_member_ids) && a.team_member_ids.includes(memberId) && a.project,
  );

  // Group distinct projects by date, then split credit 1/N
  const byDate = new Map<string, Set<string>>();
  for (const a of memberActivities) {
    const proj = a.project!;
    const set = byDate.get(a.date) || new Set<string>();
    set.add(proj);
    byDate.set(a.date, set);
  }

  const projDays = new Map<string, number>();
  for (const projs of byDate.values()) {
    const n = projs.size;
    for (const p of projs) {
      projDays.set(p, (projDays.get(p) || 0) + 1 / n);
    }
  }

  return Array.from(projDays.entries())
    .map(([project, days]) => ({ project, days, cost: Math.round(days * dailyRate) }))
    .sort((a, b) => b.cost - a.cost);
}

function exportCsv(rows: PerfRow[], month: number, year: number) {
  const header = ['Name', 'Role', 'Days Active', 'Days Worked', 'Hours Worked', 'Daily Rate (IQD)', 'Salary Cost (IQD)', 'Top Project'];
  const data = rows.map(r => [
    r.full_name,
    r.role || '',
    r.daysActive,
    r.daysWorked,
    r.hoursWorked.toFixed(1),
    Math.round(r.dailyRate),
    r.effectiveSalary,
    r.projAttribs[0]?.project || '',
  ]);
  const csv = [header, ...data]
    .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `performance_${FIN_MONTHS[month - 1]}_${year}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── PerformanceDetail ──────────────────────────────────────────────────────────

function PerformanceDetail({ row, onCollapse }: {
  row: PerfRow;
  onCollapse: () => void;
}) {
  const n = Math.min(row.projAttribs.length, 10);
  const chartData = {
    labels: row.projAttribs.slice(0, n).map(p => p.project),
    datasets: [{
      data: row.projAttribs.slice(0, n).map(p => p.cost),
      backgroundColor: CHART_COLORS.slice(0, n),
      borderWidth: 2,
    }],
  };

  const totalAttribDays = row.projAttribs.reduce((s, p) => s + p.days, 0);
  const totalAttribCost = row.projAttribs.reduce((s, p) => s + p.cost, 0);

  return (
    <div className={css.detailPanel}>
      <div className={css.detailGrid}>

        {/* Attendance */}
        <div className={css.detailSection}>
          <div className={css.detailSectionTitle}>
            Attendance — {row.daysWorked} day{row.daysWorked !== 1 ? 's' : ''} · {row.hoursWorked.toFixed(1)}h total
          </div>
          <table className={css.detailTable}>
            <thead className={css.detailTableHead}>
              <tr>
                <th>Date</th>
                <th style={{ textAlign: 'right' }}>Clock In</th>
                <th style={{ textAlign: 'right' }}>Clock Out</th>
                <th style={{ textAlign: 'right' }}>Hours</th>
              </tr>
            </thead>
            <tbody>
              {row.attRows.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ textAlign: 'center', color: '#94a3b8', padding: '14px' }}>
                    No attendance records this period.
                  </td>
                </tr>
              ) : (
                row.attRows.map(a => (
                  <tr key={a.date}>
                    <td>{a.date.split('-').reverse().join('/')}</td>
                    <td style={{ textAlign: 'right', color: '#64748b' }}>{fmtTime(a.clock_in)}</td>
                    <td style={{ textAlign: 'right', color: '#64748b' }}>{fmtTime(a.clock_out)}</td>
                    <td style={{ textAlign: 'right' }}>{a.hours_worked != null ? a.hours_worked.toFixed(1) + 'h' : '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
            {row.attRows.length > 0 && (
              <tfoot className={css.detailTableFoot}>
                <tr>
                  <td colSpan={3}>Total Hours</td>
                  <td style={{ textAlign: 'right' }}>{row.hoursWorked.toFixed(1)}h</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {/* Project attribution */}
        <div className={css.detailSection}>
          <div className={css.detailSectionTitle}>
            Project Attribution ({row.projAttribs.length} project{row.projAttribs.length !== 1 ? 's' : ''})
          </div>
          {row.projAttribs.length === 0 ? (
            <div style={{ padding: '16px 14px', color: '#94a3b8', textAlign: 'center', fontSize: 13 }}>
              No activities recorded this period.
            </div>
          ) : (
            <>
              <div className={css.chartWrap}>
                <Doughnut data={chartData} options={DOUGHNUT_OPTS} />
              </div>
              <table className={css.detailTable}>
                <thead className={css.detailTableHead}>
                  <tr>
                    <th>Project</th>
                    <th style={{ textAlign: 'right' }}>Days</th>
                    <th style={{ textAlign: 'right' }}>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {row.projAttribs.map(p => (
                    <tr key={p.project}>
                      <td>{p.project}</td>
                      <td style={{ textAlign: 'right', color: '#64748b' }}>{p.days.toFixed(2)}</td>
                      <td style={{ textAlign: 'right' }}>{iqd(p.cost)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className={css.detailTableFoot}>
                  <tr>
                    <td>Total</td>
                    <td style={{ textAlign: 'right' }}>{totalAttribDays.toFixed(2)}</td>
                    <td style={{ textAlign: 'right' }}>{iqd(totalAttribCost)}</td>
                  </tr>
                </tfoot>
              </table>
            </>
          )}
        </div>
      </div>

      <div className={css.detailActions}>
        <button className={css.btnCollapse} onClick={onCollapse}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="18 15 12 9 6 15"/>
          </svg>
          Collapse
        </button>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function FinPerformance() {
  const { hasPerm } = useAuth();

  if (!hasPerm('view_fin_performance')) {
    return <div className={css.errorMsg}>Access denied.</div>;
  }

  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year,  setYear]  = useState(now.getFullYear());

  const [team,       setTeam]       = useState<TeamMember[]>([]);
  const [adjs,       setAdjs]       = useState<SalAdj[]>([]);
  const [attendance, setAttendance] = useState<AttRow[]>([]);
  const [activities, setActivities] = useState<ActivityRow[]>([]);

  const [teamLoading,   setTeamLoading]   = useState(true);
  const [periodLoading, setPeriodLoading] = useState(true);
  const [error,         setError]         = useState('');

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [sortCol,    setSortCol]    = useState<SortCol>('daysWorked');
  const [sortDir,    setSortDir]    = useState<'asc' | 'desc'>('desc');

  // Fetch team members once
  useEffect(() => {
    (async () => {
      setTeamLoading(true);
      const { data, error: err } = await supabase
        .from('team_members')
        .select('id,full_name,role,monthly_salary,is_active,activated_at,deactivated_at')
        .order('full_name');
      if (err) { setError('Failed to load team members.'); setTeamLoading(false); return; }
      setTeam(data || []);
      setTeamLoading(false);
    })();
  }, []);

  // Fetch period data (adjustments, attendance, activities)
  const loadPeriod = useCallback(async (m: number, y: number) => {
    setPeriodLoading(true);
    const dLast = new Date(y, m, 0);
    const first = `${y}-${String(m).padStart(2, '0')}-01`;
    const last  = `${y}-${String(m).padStart(2, '0')}-${String(dLast.getDate()).padStart(2, '0')}`;

    const [adjRes, attRes, daRes, ftRes] = await Promise.all([
      supabase.from('salary_adjustments').select('*').eq('month', m).eq('year', y),
      supabase.from('attendance')
        .select('member_id,date,clock_in,clock_out,hours_worked')
        .gte('date', first).lte('date', last),
      supabase.from('daily_activities')
        .select('date,project,team_member_ids')
        .gte('date', first).lte('date', last),
      supabase.from('field_trips')
        .select('id,date,project,team_member_ids')
        .gte('date', first).lte('date', last),
    ]);

    if (adjRes.error || attRes.error || daRes.error || ftRes.error) {
      setError('Failed to load period data.');
      setPeriodLoading(false);
      return;
    }

    // Resolve actual field-trip participants (status = 'joined' only).
    // Planned/assigned members in team_member_ids who never checked in must
    // not receive day credit — only people with a joined trip_participants row.
    const trips: FieldTripRow[] = ftRes.data || [];
    const tripIds = trips.map(t => t.id);

    const joinedByTrip = new Map<string, string[]>();
    if (tripIds.length > 0) {
      const ppRes = await supabase
        .from('trip_participants')
        .select('trip_id,member_id')
        .in('trip_id', tripIds)
        .eq('status', 'joined');
      for (const pp of (ppRes.data || [])) {
        const arr = joinedByTrip.get(pp.trip_id) || [];
        arr.push(pp.member_id);
        joinedByTrip.set(pp.trip_id, arr);
      }
    }

    // Replace each trip's team_member_ids with the joined-only list.
    // Trips where nobody has joined yet get an empty array → 0 days attributed.
    const tripActivities: ActivityRow[] = trips.map(t => ({
      date: t.date,
      project: t.project,
      team_member_ids: joinedByTrip.get(t.id) ?? [],
    }));

    setAdjs(adjRes.data || []);
    setAttendance(attRes.data || []);
    setActivities([...(daRes.data || []), ...tripActivities]);
    setPeriodLoading(false);
  }, []);

  useEffect(() => { loadPeriod(month, year); }, [month, year, loadPeriod]);

  // ── Compute rows ───────────────────────────────────────────
  const teamWithSalary = buildTeamWithSalary(team, adjs, month, year);
  const rows: PerfRow[] = teamWithSalary.map(member => {
    const memberAtt  = attendance.filter(a => a.member_id === member.id);
    const daysWorked = memberAtt.length;
    const hoursWorked = memberAtt.reduce((s, a) => s + (a.hours_worked ?? 0), 0);
    const dailyRate  = member.daysActive > 0 ? member.effectiveSalary / member.daysActive : 0;
    const projAttribs = computeProjAttribs(member.id, activities, dailyRate);
    const attRows = [...memberAtt].sort((a, b) => a.date.localeCompare(b.date));
    return { ...member, daysWorked, hoursWorked, dailyRate, projAttribs, attRows };
  });

  // ── Sort ───────────────────────────────────────────────────
  const sorted = [...rows].sort((a, b) => {
    let diff = 0;
    if      (sortCol === 'name')       diff = a.full_name.localeCompare(b.full_name);
    else if (sortCol === 'daysWorked') diff = a.daysWorked - b.daysWorked;
    else if (sortCol === 'hoursWorked')diff = a.hoursWorked - b.hoursWorked;
    else if (sortCol === 'dailyRate')  diff = a.dailyRate - b.dailyRate;
    else if (sortCol === 'cost')       diff = a.effectiveSalary - b.effectiveSalary;
    return sortDir === 'asc' ? diff : -diff;
  });

  function toggleSort(col: SortCol) {
    if (sortCol === col) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortCol(col); setSortDir('desc'); }
  }

  function sortArrow(col: SortCol) {
    if (sortCol !== col) return '';
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  }

  // ── KPI totals ─────────────────────────────────────────────
  const totalDaysWorked = rows.reduce((s, r) => s + r.daysWorked, 0);
  const totalHours      = rows.reduce((s, r) => s + r.hoursWorked, 0);
  const totalCost       = rows.reduce((s, r) => s + r.effectiveSalary, 0);

  const canExport = hasPerm('fin_performance_export');
  const loading   = teamLoading || periodLoading;
  const mLabel    = FIN_MONTHS[month - 1] + ' ' + year;
  const years     = getYears();

  return (
    <div className={css.page}>
      {/* Toolbar */}
      <div className={css.toolbar}>
        <select className={css.sel} value={month} onChange={e => { setMonth(+e.target.value); setExpandedId(null); }}>
          {FIN_MONTHS.map((mn, i) => <option key={i} value={i + 1}>{mn}</option>)}
        </select>
        <select className={css.sel} value={year} onChange={e => { setYear(+e.target.value); setExpandedId(null); }}>
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <div className={css.spacer} />
        <button className={css.btnGhost} onClick={() => loadPeriod(month, year)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
          Refresh
        </button>
        {canExport && !loading && rows.length > 0 && (
          <button className={css.btnExport} onClick={() => exportCsv(sorted, month, year)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Export CSV
          </button>
        )}
      </div>

      <h2 className={css.heading}>{mLabel} — Team Performance</h2>

      {error ? (
        <div className={css.errorMsg}>{error}</div>
      ) : loading ? (
        <div className={css.empty}>Loading…</div>
      ) : (
        <>
          {/* KPI cards */}
          <div className={css.kpiRow}>
            <div className={css.kpiCard}>
              <div className={css.kpiLabel}>Active Employees</div>
              <div className={css.kpiValue}>{rows.length}</div>
              <div className={css.kpiSub}>for {mLabel}</div>
            </div>
            <div className={css.kpiCard}>
              <div className={css.kpiLabel}>Total Days Worked</div>
              <div className={`${css.kpiValue} ${css.kpiBlue}`}>{totalDaysWorked}</div>
              <div className={css.kpiSub}>from attendance records</div>
            </div>
            <div className={css.kpiCard}>
              <div className={css.kpiLabel}>Total Hours Worked</div>
              <div className={`${css.kpiValue} ${css.kpiPurple}`}>{totalHours.toFixed(1)}h</div>
              <div className={css.kpiSub}>across all employees</div>
            </div>
            <div className={css.kpiCard}>
              <div className={css.kpiLabel}>Total Salary Cost</div>
              <div className={`${css.kpiValue} ${css.kpiAmber}`}>{iqd(totalCost)}</div>
              <div className={css.kpiSub}>after adjustments</div>
            </div>
          </div>

          {/* Performance table */}
          {sorted.length === 0 ? (
            <div className={css.empty}>No active team members for {mLabel}.</div>
          ) : (
            <div className={css.tableWrap}>
              <table className={css.table}>
                <thead>
                  <tr>
                    <th onClick={() => toggleSort('name')}>Employee{sortArrow('name')}</th>
                    <th>Role</th>
                    <th className={css.num} onClick={() => toggleSort('daysWorked')}>Days Worked{sortArrow('daysWorked')}</th>
                    <th className={css.num} onClick={() => toggleSort('hoursWorked')}>Hours{sortArrow('hoursWorked')}</th>
                    <th className={css.num} onClick={() => toggleSort('dailyRate')}>Daily Rate{sortArrow('dailyRate')}</th>
                    <th className={css.num} onClick={() => toggleSort('cost')}>Salary Cost{sortArrow('cost')}</th>
                    <th>Top Projects</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.flatMap(row => {
                    const isExpanded = expandedId === row.id;
                    return [
                      <tr
                        key={row.id}
                        className={`${css.tableRow} ${isExpanded ? css.tableRowExpanded : ''}`}
                        onClick={() => setExpandedId(prev => (prev === row.id ? null : row.id))}
                      >
                        <td>
                          <div className={css.empCell}>
                            <span className={css.avatar}>{initials(row.full_name)}</span>
                            <strong>{row.full_name}</strong>
                          </div>
                        </td>
                        <td style={{ color: '#64748b' }}>{row.role || '—'}</td>
                        <td className={css.num}>
                          {row.daysWorked}
                          <span style={{ color: '#94a3b8', fontSize: 11 }}>/{row.daysActive}</span>
                        </td>
                        <td className={css.num}>
                          {row.hoursWorked > 0
                            ? <span style={{ color: '#7c3aed' }}>{row.hoursWorked.toFixed(1)}h</span>
                            : <span style={{ color: '#94a3b8' }}>—</span>}
                        </td>
                        <td className={css.num} style={{ color: '#64748b' }}>{iqd(Math.round(row.dailyRate))}</td>
                        <td className={css.num}><strong style={{ color: '#d97706' }}>{iqd(row.effectiveSalary)}</strong></td>
                        <td>
                          <div className={css.projBadges}>
                            {row.projAttribs.length === 0
                              ? <span style={{ color: '#94a3b8', fontSize: 12 }}>—</span>
                              : row.projAttribs.slice(0, 3).map(p => (
                                  <span key={p.project} className={css.projBadge} title={p.project}>
                                    {p.project}
                                  </span>
                                ))}
                            {row.projAttribs.length > 3 && (
                              <span className={css.projBadge} style={{ background: '#f1f5f9', color: '#64748b' }}>
                                +{row.projAttribs.length - 3}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>,
                      ...(isExpanded ? [
                        <tr key={`${row.id}-detail`}>
                          <td colSpan={7} className={css.expandCell}>
                            <PerformanceDetail
                              row={row}
                              onCollapse={() => setExpandedId(null)}
                            />
                          </td>
                        </tr>,
                      ] : []),
                    ];
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={2}>TOTAL — {rows.length} employee{rows.length !== 1 ? 's' : ''}</td>
                    <td className={css.num}>{totalDaysWorked}</td>
                    <td className={css.num} style={{ color: '#7c3aed' }}>{totalHours.toFixed(1)}h</td>
                    <td></td>
                    <td className={css.num} style={{ color: '#d97706' }}>{iqd(totalCost)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
