import { useState, useEffect } from 'react';
import {
  Chart as ChartJS,
  ArcElement,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import { Doughnut, Bar, Line } from 'react-chartjs-2';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { FIN_MONTHS, iqd, getYears, fmtK } from '../lib/finHelpers';
import css from './FinDashboard.module.css';

ChartJS.register(ArcElement, CategoryScale, LinearScale, BarElement, LineElement, PointElement, Title, Tooltip, Legend, Filler);

const CHART_COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6','#f97316','#64748b','#84cc16'];

interface TeamMember {
  id: string;
  full_name: string;
  monthly_salary: number | null;
  is_active: boolean | null;
  activated_at: string | null;
  deactivated_at: string | null;
}

interface RevRow { id: string; project_name: string; amount: number | null; month: number; year: number; }
interface GenExpRow { id: string; description: string; category: string; amount: number | null; month: number; year: number; }
interface ProjExpRow {
  id: string;
  description: string;
  project_name: string;
  category: string;
  amount: number | null;
  month: number;
  year: number;
  activity_date: string | null;
  employee_ids: string | null;
  site_id: string | null;
  accommodation: string | null;
}
interface SalAdj { member_id: string; adjusted_amount: number; }

interface ActiveMember extends TeamMember { effectiveSalary: number; }

interface TrendPoint { label: string; rev: number; exp: number; profit: number; }

export default function FinDashboard() {
  const { hasPerm } = useAuth();
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear]   = useState(now.getFullYear());

  const [team,    setTeam]    = useState<TeamMember[]>([]);
  const [allRev,  setAllRev]  = useState<RevRow[]>([]);
  const [allGen,  setAllGen]  = useState<GenExpRow[]>([]);
  const [allProj, setAllProj] = useState<ProjExpRow[]>([]);
  const [adjMap,  setAdjMap]  = useState<Record<string, SalAdj>>({});
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  if (!hasPerm('view_fin_dashboard')) {
    return <div className={css.errorMsg}>Access denied.</div>;
  }

  // Fetch all static data once
  useEffect(() => {
    (async () => {
      setLoading(true);
      setError('');
      const [t, r, g, p] = await Promise.all([
        supabase.from('team_members').select('id,full_name,monthly_salary,is_active,activated_at,deactivated_at').order('full_name'),
        supabase.from('revenue').select('id,project_name,amount,month,year'),
        supabase.from('general_expenses').select('id,description,category,amount,month,year'),
        supabase.from('project_expenses').select('id,description,project_name,category,amount,month,year,activity_date,employee_ids,site_id,accommodation'),
      ]);
      if (t.error || r.error || g.error || p.error) {
        setError('Failed to load data.');
        setLoading(false);
        return;
      }
      setTeam(t.data || []);
      setAllRev(r.data || []);
      setAllGen(g.data || []);
      setAllProj(p.data || []);
      setLoading(false);
    })();
  }, []);

  // Fetch salary adjustments whenever month/year changes
  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('salary_adjustments').select('*').eq('month', month).eq('year', year);
      const map: Record<string, SalAdj> = {};
      (data || []).forEach((a: SalAdj & { member_id: string }) => { map[a.member_id] = a; });
      setAdjMap(map);
    })();
  }, [month, year]);

  if (loading) return <div className={css.placeholder}>Loading…</div>;
  if (error)   return <div className={css.errorMsg}>{error}</div>;

  // ── Filter to selected month/year ────────────────────────────
  const rev     = allRev.filter(r => r.month === month && r.year === year);
  const genExp  = allGen.filter(r  => r.month === month && r.year === year);
  const projExp = allProj.filter(r => {
    if (r.activity_date) {
      const d = new Date(r.activity_date);
      return d.getMonth() + 1 === month && d.getFullYear() === year;
    }
    return r.month === month && r.year === year;
  });

  // ── Active team with proration ───────────────────────────────
  const dFirst    = new Date(year, month - 1, 1);
  const dLast     = new Date(year, month, 0);
  const dFirstStr = `${year}-${String(month).padStart(2,'0')}-01`;
  const dLastStr  = `${year}-${String(month).padStart(2,'0')}-${String(dLast.getDate()).padStart(2,'0')}`;
  const totalCalDays = dLast.getDate();

  const activeTeam: ActiveMember[] = team.filter(t => {
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
    const adj = adjMap[t.id];
    const effectiveSalary = adj ? +adj.adjusted_amount : proratedSalary;
    return { ...t, effectiveSalary };
  });

  // ── Totals ───────────────────────────────────────────────────
  const totalRev    = rev.reduce((s, r)    => s + (+(r.amount ?? 0)), 0);
  const totalProjEx = projExp.reduce((s, r) => s + (+(r.amount ?? 0)), 0);
  const totalGenEx  = genExp.reduce((s, r)  => s + (+(r.amount ?? 0)), 0);
  const totalSal    = activeTeam.reduce((s, t) => s + t.effectiveSalary, 0);
  const totalExp    = totalSal + totalGenEx + totalProjEx;
  const netProfit   = totalRev - totalExp;
  const margin      = totalRev > 0 ? (netProfit / totalRev * 100) : 0;

  // ── Per-project data ─────────────────────────────────────────
  const activeProjs = new Set<string>([
    ...rev.map(r => r.project_name),
    ...projExp.map(r => r.project_name),
  ].filter(Boolean));
  const projCount = activeProjs.size || 1;
  const genShare  = totalGenEx / projCount;

  interface ProjBucket { rev: number; projEx: number; salary: number; genShare: number; }
  const projData: Record<string, ProjBucket> = {};
  for (const p of activeProjs) projData[p] = { rev: 0, projEx: 0, salary: 0, genShare };
  rev.forEach(r     => { if (projData[r.project_name]) projData[r.project_name].rev    += +(r.amount ?? 0); });
  projExp.forEach(r => { if (projData[r.project_name]) projData[r.project_name].projEx += +(r.amount ?? 0); });
  for (const p of activeProjs) {
    const weight = totalRev > 0 ? (projData[p].rev / totalRev) : (1 / projCount);
    projData[p].salary = Math.round(totalSal * weight);
  }
  const projNames = Array.from(activeProjs);

  // ── 6-month trend (salary held constant at current month) ────
  const trend: TrendPoint[] = [];
  for (let i = 5; i >= 0; i--) {
    let tm = month - i, ty = year;
    while (tm <= 0) { tm += 12; ty--; }
    const tR  = allRev.filter(r => r.month === tm && r.year === ty).reduce((s, r) => s + (+(r.amount ?? 0)), 0);
    const tPE = allProj.filter(r => {
      if (r.activity_date) { const d = new Date(r.activity_date); return d.getMonth() + 1 === tm && d.getFullYear() === ty; }
      return r.month === tm && r.year === ty;
    }).reduce((s, r) => s + (+(r.amount ?? 0)), 0);
    const tGE = allGen.filter(r => r.month === tm && r.year === ty).reduce((s, r) => s + (+(r.amount ?? 0)), 0);
    const tS  = totalSal; // salary held constant at current month's value
    trend.push({ label: FIN_MONTHS[tm - 1].slice(0, 3) + ' ' + ty, rev: tR, exp: tPE + tGE + tS, profit: tR - tPE - tGE - tS });
  }

  const mLabel = FIN_MONTHS[month - 1] + ' ' + year;
  const years  = getYears();

  // ── Employee name lookup for project expenses ────────────────
  function empNames(row: ProjExpRow): string {
    try {
      const ids: string[] = JSON.parse(row.employee_ids || '[]');
      const names = ids.map(id => team.find(m => m.id === id)?.full_name).filter(Boolean) as string[];
      return names.length ? names.join(', ') : '—';
    } catch { return '—'; }
  }

  // ── Chart options ────────────────────────────────────────────
  const doughnutOpts = {
    responsive: true,
    plugins: { legend: { position: 'bottom' as const, labels: { font: { size: 11 }, boxWidth: 12 } } },
  };
  const yTickOpts = { font: { size: 10 }, callback: (v: number | string) => fmtK(+v) + ' IQD' };
  const barOpts = {
    responsive: true,
    plugins: { legend: { labels: { font: { size: 11 }, boxWidth: 12 } } },
    scales: {
      y: { ticks: yTickOpts, grid: { color: '#f1f5f9' } },
      x: { ticks: { font: { size: 10 } }, grid: { display: false } },
    },
  };
  const lineOpts = {
    responsive: true,
    plugins: { legend: { labels: { font: { size: 11 }, boxWidth: 12 } } },
    scales: {
      y: { ticks: yTickOpts, grid: { color: '#f1f5f9' } },
      x: { ticks: { font: { size: 10 } }, grid: { display: false } },
    },
  };

  return (
    <div className={css.page}>
      {/* Toolbar */}
      <div className={css.toolbar}>
        <div className={css.toolbarTitle}>Finance Dashboard</div>
        <div className={css.spacer} />
        <select className={css.sel} value={month} onChange={e => setMonth(+e.target.value)}>
          {FIN_MONTHS.map((mn, i) => <option key={i} value={i + 1}>{mn}</option>)}
        </select>
        <select className={css.sel} value={year} onChange={e => setYear(+e.target.value)}>
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      {/* KPI Cards */}
      <div className={css.kpiRow}>
        <div className={css.kpiCard}>
          <div className={css.kpiLabel}>Total Revenue</div>
          <div className={css.kpiValue}>{iqd(totalRev)}</div>
          <div className={css.kpiSub}>{rev.length} invoice{rev.length !== 1 ? 's' : ''} · {mLabel}</div>
        </div>
        <div className={css.kpiCard}>
          <div className={css.kpiLabel}>Total Expenses</div>
          <div className={css.kpiValue}>{iqd(totalExp)}</div>
          <div className={css.kpiSub}>Salary + Project + General</div>
        </div>
        <div className={css.kpiCard}>
          <div className={css.kpiLabel}>Net Profit</div>
          <div className={`${css.kpiValue} ${netProfit >= 0 ? css.kpiPos : css.kpiNeg}`}>{iqd(netProfit)}</div>
          <div className={css.kpiSub}>{mLabel}</div>
        </div>
        <div className={css.kpiCard}>
          <div className={css.kpiLabel}>Profit Margin</div>
          <div className={`${css.kpiValue} ${margin >= 0 ? css.kpiPos : css.kpiNeg}`}>{margin.toFixed(1)}%</div>
          <div className={css.kpiSub}>{activeProjs.size} active project{activeProjs.size !== 1 ? 's' : ''}</div>
        </div>
      </div>

      {/* Charts Row */}
      <div className={css.chartsGrid}>
        <div className={css.chartPanel}>
          <div className={css.chartTitle}>Revenue by Project</div>
          {projNames.some(p => projData[p].rev > 0)
            ? <Doughnut
                data={{ labels: projNames, datasets: [{ data: projNames.map(p => projData[p].rev), backgroundColor: CHART_COLORS.slice(0, projNames.length), borderWidth: 2 }] }}
                options={doughnutOpts}
              />
            : <div className={css.chartEmpty}>No revenue this month</div>
          }
        </div>
        <div className={css.chartPanel}>
          <div className={css.chartTitle}>Expense Breakdown</div>
          {totalSal + totalProjEx + totalGenEx > 0
            ? <Doughnut
                data={{ labels: ['Salary', 'Project Exp', 'General Exp'], datasets: [{ data: [totalSal, totalProjEx, totalGenEx], backgroundColor: ['#ef4444','#f97316','#f59e0b'], borderWidth: 2 }] }}
                options={doughnutOpts}
              />
            : <div className={css.chartEmpty}>No expenses this month</div>
          }
        </div>
        <div className={css.chartPanel}>
          <div className={css.chartTitle}>Revenue vs Expenses — 6 Months</div>
          <Bar
            data={{
              labels: trend.map(t => t.label),
              datasets: [
                { label: 'Revenue',  data: trend.map(t => t.rev), backgroundColor: '#3b82f6', borderRadius: 4, borderSkipped: false as const },
                { label: 'Expenses', data: trend.map(t => t.exp), backgroundColor: '#ef4444', borderRadius: 4, borderSkipped: false as const },
              ],
            }}
            options={barOpts}
          />
        </div>
      </div>

      {/* Project Performance Table */}
      <div className={css.projTableWrap}>
        <div className={css.chartTitle} style={{ fontSize: 14 }}>Project Performance — {mLabel}</div>
        <table className={css.projTable}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Project</th>
              <th>Revenue</th>
              <th>Project Exp</th>
              <th>General Share</th>
              <th>Salary Cost</th>
              <th>Net Profit</th>
              <th>Margin %</th>
            </tr>
          </thead>
          <tbody>
            {projNames.length === 0
              ? <tr><td colSpan={7} className={css.projTableEmpty}>No data for this period</td></tr>
              : projNames.map(name => {
                  const d  = projData[name];
                  const np = d.rev - d.projEx - d.genShare - d.salary;
                  const mg = d.rev > 0 ? (np / d.rev * 100) : 0;
                  return (
                    <tr key={name}>
                      <td>{name}</td>
                      <td>{iqd(d.rev)}</td>
                      <td>{iqd(d.projEx)}</td>
                      <td>{iqd(d.genShare)}</td>
                      <td>{iqd(d.salary)}</td>
                      <td className={np >= 0 ? css.profitPos : css.profitNeg}>{iqd(np)}</td>
                      <td className={mg >= 0 ? css.profitPos : css.profitNeg}>{mg.toFixed(1)}%</td>
                    </tr>
                  );
                })
            }
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td>{iqd(totalRev)}</td>
              <td>{iqd(totalProjEx)}</td>
              <td>{iqd(totalGenEx)}</td>
              <td>{iqd(totalSal)}</td>
              <td className={netProfit >= 0 ? css.profitPos : css.profitNeg}>{iqd(netProfit)}</td>
              <td className={margin    >= 0 ? css.profitPos : css.profitNeg}>{margin.toFixed(1)}%</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Bottom Row: General Expenses + Salary */}
      <div className={css.bottomRow}>
        <div className={css.panel}>
          <div className={css.panelTitle}>General Expenses — {mLabel}</div>
          {genExp.length === 0
            ? <div className={css.panelEmpty}>None this month</div>
            : <>
                {genExp.map(r => (
                  <div key={r.id} className={css.panelRow}>
                    <span>
                      {r.description}
                      {r.category ? <span style={{ color: '#94a3b8', fontSize: 11 }}> ({r.category})</span> : null}
                    </span>
                    <span style={{ fontWeight: 600 }}>{iqd(r.amount)}</span>
                  </div>
                ))}
                <div className={css.panelTotal}>
                  <span>Total</span>
                  <span>{iqd(totalGenEx)}</span>
                </div>
              </>
          }
        </div>
        <div className={css.panel}>
          <div className={css.panelTitle}>Salary Costs — {mLabel}</div>
          {activeTeam.length === 0
            ? <div className={css.panelEmpty}>No active team members</div>
            : <>
                {activeTeam.map(t => (
                  <div key={t.id} className={css.panelRow}>
                    <span style={{ fontWeight: 500 }}>{t.full_name}</span>
                    <span style={{ fontWeight: 600 }}>{iqd(t.effectiveSalary)}</span>
                  </div>
                ))}
                <div className={css.panelTotal}>
                  <span>Total ({activeTeam.length} members)</span>
                  <span>{iqd(totalSal)}</span>
                </div>
              </>
          }
        </div>
      </div>

      {/* Project Expenses Detail */}
      <div className={css.detailPanel}>
        <div className={css.panelTitle}>Project Expenses — {mLabel}</div>
        {projExp.length === 0
          ? <div className={css.panelEmpty}>No project expenses this month</div>
          : <table className={css.detailTable}>
              <thead>
                <tr>
                  <th>Description</th>
                  <th>Project</th>
                  <th>Category</th>
                  <th>Employee(s)</th>
                  <th>Site ID</th>
                  <th>Accommodation</th>
                  <th className={css.num}>Amount (IQD)</th>
                </tr>
              </thead>
              <tbody>
                {projExp.map(r => (
                  <tr key={r.id}>
                    <td>{r.description || ''}</td>
                    <td>{r.project_name || ''}</td>
                    <td>{r.category || ''}</td>
                    <td>{empNames(r)}</td>
                    <td>{r.site_id || '—'}</td>
                    <td>{r.accommodation || '—'}</td>
                    <td className={css.num}>{iqd(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={6}><strong>Total</strong></td>
                  <td className={css.num}><strong>{iqd(totalProjEx)}</strong></td>
                </tr>
              </tfoot>
            </table>
        }
      </div>

      {/* 6-Month Trend Line */}
      <div className={css.trendWrap}>
        <div className={css.chartTitle} style={{ fontSize: 14 }}>6-Month Financial Trend</div>
        <Line
          data={{
            labels: trend.map(t => t.label),
            datasets: [
              { label: 'Revenue',    data: trend.map(t => t.rev),    borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,.1)',  tension: 0.4, fill: false, pointRadius: 4 },
              { label: 'Expenses',   data: trend.map(t => t.exp),    borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,.08)',   tension: 0.4, fill: false, pointRadius: 4 },
              { label: 'Net Profit', data: trend.map(t => t.profit), borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,.12)', tension: 0.4, fill: true,  pointRadius: 4 },
            ],
          }}
          options={lineOpts}
        />
      </div>
    </div>
  );
}
