import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { Bar } from 'react-chartjs-2';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { FIN_MONTHS, FIN_PROJECTS, iqd, getYears } from '../lib/finHelpers';
import css from './FinReport.module.css';

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

// ── Types ─────────────────────────────────────────────────────

interface TeamMember {
  id: string;
  full_name: string;
  role: string | null;
  monthly_salary: number | null;
  is_active: boolean | null;
  activated_at: string | null;
  deactivated_at: string | null;
}
interface RevRow    { project_name: string; amount: number | null; month: number; year: number; }
interface GenExpRow { amount: number | null; month: number; year: number; }
interface ProjExpRow {
  project_name: string | null;
  amount: number | null;
  month: number;
  year: number;
  activity_date: string | null;
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

interface ProjRow {
  proj: string;
  revenue: number;
  weight: number;
  salaryCost: number;
  projExp: number;
  netProfit: number;
  margin: number;
}

interface AdjPanelState {
  type: string;
  amount: string;
  reason: string;
}

interface AdjAllState {
  type: string;
  pct: string;
  reason: string;
}

// ── Helpers ───────────────────────────────────────────────────

function computeEffective(type: string, prorated: number, amt: number): number {
  if (type === 'bonus')     return prorated + amt;
  if (type === 'deduction') return Math.max(0, prorated - amt);
  return amt; // override
}

function fmtActFrom(activated_at: string | null): string {
  if (!activated_at) return '—';
  const [yr, mo, dy] = activated_at.split('-');
  return `${dy}/${mo}/${yr}`;
}

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

// ── Component ─────────────────────────────────────────────────

export default function FinReport() {
  const { hasPerm } = useAuth();
  const now = new Date();
  const [month, setMonth]     = useState(now.getMonth() + 1);
  const [year, setYear]       = useState(now.getFullYear());
  const [workDays, setWorkDays] = useState(22);

  const [team,    setTeam]    = useState<TeamMember[]>([]);
  const [allRev,  setAllRev]  = useState<RevRow[]>([]);
  const [allGen,  setAllGen]  = useState<GenExpRow[]>([]);
  const [allProj, setAllProj] = useState<ProjExpRow[]>([]);
  const [adjs,    setAdjs]    = useState<SalAdj[]>([]);

  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  const [openPanelId,  setOpenPanelId]  = useState<string | null>(null);
  const [panelStates,  setPanelStates]  = useState<Record<string, AdjPanelState>>({});
  const [showAdjAll,   setShowAdjAll]   = useState(false);
  const [adjAllState,  setAdjAllState]  = useState<AdjAllState>({ type: 'override', pct: '100', reason: '' });
  const [toast,        setToast]        = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!hasPerm('view_fin_report')) {
    return <div style={{ padding: 40, color: '#ef4444' }}>Access denied.</div>;
  }

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }

  // ── Fetch static data once ───────────────────────────────────
  useEffect(() => {
    (async () => {
      setLoading(true);
      setError('');
      const [t, r, g, p] = await Promise.all([
        supabase.from('team_members').select('id,full_name,role,monthly_salary,is_active,activated_at,deactivated_at').order('full_name'),
        supabase.from('revenue').select('project_name,amount,month,year'),
        supabase.from('general_expenses').select('amount,month,year'),
        supabase.from('project_expenses').select('project_name,amount,month,year,activity_date'),
      ]);
      if (t.error || r.error || g.error || p.error) { setError('Failed to load data.'); setLoading(false); return; }
      setTeam(t.data || []);
      setAllRev(r.data || []);
      setAllGen(g.data || []);
      setAllProj(p.data || []);
      setLoading(false);
    })();
  }, []);

  // ── Fetch adjustments when month/year changes ────────────────
  const loadAdjs = useCallback(async (m: number, y: number) => {
    const { data } = await supabase.from('salary_adjustments').select('*').eq('month', m).eq('year', y);
    setAdjs(data || []);
  }, []);

  useEffect(() => { loadAdjs(month, year); }, [month, year, loadAdjs]);

  if (loading) return <div style={{ padding: 40, color: '#94a3b8', fontSize: 14 }}>Loading…</div>;
  if (error)   return <div style={{ padding: 40, color: '#ef4444' }}>{error}</div>;

  // ── Calculations ─────────────────────────────────────────────
  const projRevMap: Record<string, number> = {};
  allRev.filter(r => r.month === month && r.year === year).forEach(r => {
    if (r.project_name) projRevMap[r.project_name] = (projRevMap[r.project_name] || 0) + (+(r.amount ?? 0));
  });
  const activeProjs: string[] = [
    ...FIN_PROJECTS.filter(p => (projRevMap[p] ?? 0) > 0),
    ...Object.keys(projRevMap).filter(p => !FIN_PROJECTS.includes(p) && projRevMap[p] > 0),
  ];
  const totalRevenue = activeProjs.reduce((s, p) => s + (projRevMap[p] || 0), 0);

  const teamWithSalary = buildTeamWithSalary(team, adjs, month, year);
  const totalSalaryBudget   = teamWithSalary.reduce((s, t) => s + t.effectiveSalary, 0);
  const activeEmployeeCount = teamWithSalary.length;

  const totalGenExp = allGen
    .filter(r => r.month === month && r.year === year)
    .reduce((s, r) => s + (+(r.amount ?? 0)), 0);

  const projExpMap: Record<string, number> = {};
  allProj.filter(r => {
    if (r.activity_date) { const d = new Date(r.activity_date); return d.getMonth() + 1 === month && d.getFullYear() === year; }
    return r.month === month && r.year === year;
  }).forEach(r => {
    const key = r.project_name || '__unassigned__';
    projExpMap[key] = (projExpMap[key] || 0) + (+(r.amount ?? 0));
  });
  const totalProjExp = (Object.values(projExpMap) as number[]).reduce((s, v) => s + v, 0);
  const companyNet   = totalRevenue - totalSalaryBudget - totalGenExp - totalProjExp;

  const projRows: ProjRow[] = activeProjs.map(proj => {
    const revenue    = projRevMap[proj] || 0;
    const weight     = totalRevenue > 0 ? revenue / totalRevenue : 0;
    const salaryCost = Math.round(totalSalaryBudget * weight);
    const projExp    = projExpMap[proj] || 0;
    const netProfit  = revenue - salaryCost - projExp;
    const margin     = revenue > 0 ? (netProfit / revenue * 100) : 0;
    return { proj, revenue, weight, salaryCost, projExp, netProfit, margin };
  });

  const hasAnyData = activeProjs.length > 0 || totalSalaryBudget > 0 || totalGenExp > 0 || totalProjExp > 0;
  const mLabel = FIN_MONTHS[month - 1] + ' ' + year;
  const years  = getYears();
  const pct    = (v: number) => v.toFixed(1) + '%';

  // ── Panel helpers ────────────────────────────────────────────
  function openPanel(member: ActiveMember) {
    const newId = openPanelId === member.id ? null : member.id;
    setOpenPanelId(newId);
    if (newId && !panelStates[newId]) {
      const defaultType = member.isAdjusted ? member.adjType : 'override';
      const defaultAmt  = member.isAdjusted ? String(member.adjAmount) : String(member.proratedSalary);
      setPanelStates(ps => ({ ...ps, [newId]: { type: defaultType, amount: defaultAmt, reason: member.adjReason } }));
    }
  }

  function updatePanel(id: string, patch: Partial<AdjPanelState>) {
    setPanelStates(ps => ({ ...ps, [id]: { ...ps[id], ...patch } }));
  }

  function getPanelPreview(id: string, prorated: number): number {
    const ps = panelStates[id];
    if (!ps) return prorated;
    return computeEffective(ps.type, prorated, +ps.amount || 0);
  }

  async function saveAdj(member: ActiveMember) {
    const ps = panelStates[member.id];
    if (!ps) return;
    const amt = +ps.amount;
    if (isNaN(amt) || amt < 0) { showToast('Enter a valid amount', false); return; }
    const { error: err } = await supabase.from('salary_adjustments').upsert(
      { member_id: member.id, month, year, adjusted_amount: amt, reason: ps.reason.trim() || null, adj_type: ps.type },
      { onConflict: 'member_id,month,year' }
    );
    if (err) { showToast(err.message, false); return; }
    await loadAdjs(month, year);
    setOpenPanelId(null);
    showToast('Adjustment saved', true);
  }

  async function removeAdj(member: ActiveMember) {
    const { error: err } = await supabase.from('salary_adjustments').delete()
      .eq('member_id', member.id).eq('month', month).eq('year', year);
    if (err) { showToast(err.message, false); return; }
    await loadAdjs(month, year);
    setOpenPanelId(null);
    showToast('Adjustment removed', true);
  }

  // ── Adjust All helpers ───────────────────────────────────────
  function adjAllPreview(): string {
    const pctVal = +adjAllState.pct;
    if (!teamWithSalary.length || isNaN(pctVal)) return 'Enter a percentage above to preview the result.';
    const examples = teamWithSalary.slice(0, 2).map(t => {
      const delta  = Math.round(t.proratedSalary * pctVal / 100);
      const result = computeEffective(adjAllState.type, t.proratedSalary, delta);
      return t.full_name.split(' ')[0] + ': ' + result.toLocaleString('en-US') + ' IQD';
    }).join(' · ');
    const typeLabel = adjAllState.type === 'bonus' ? 'Bonus' : adjAllState.type === 'deduction' ? 'Deduction' : 'Override';
    return `${typeLabel} @ ${pctVal}% — e.g. ${examples || '—'}`;
  }

  async function applyAdjAll() {
    const pctVal = +adjAllState.pct;
    if (isNaN(pctVal) || pctVal < 0) { showToast('Enter a valid percentage', false); return; }
    if (!teamWithSalary.length) { showToast('No team members for this period', false); return; }
    const upserts = teamWithSalary.map(t => {
      const delta           = Math.round(t.proratedSalary * pctVal / 100);
      const adjusted_amount = computeEffective(adjAllState.type, t.proratedSalary, delta);
      return { member_id: t.id, month, year, adjusted_amount, reason: adjAllState.reason.trim() || null, adj_type: adjAllState.type };
    });
    const { error: err } = await supabase.from('salary_adjustments').upsert(upserts, { onConflict: 'member_id,month,year' });
    if (err) { showToast(err.message, false); return; }
    setShowAdjAll(false);
    setAdjAllState({ type: 'override', pct: '100', reason: '' });
    await loadAdjs(month, year);
    showToast(`Applied ${pctVal}% ${adjAllState.type} to ${upserts.length} member${upserts.length !== 1 ? 's' : ''}`, true);
  }

  // ── Export ───────────────────────────────────────────────────
  async function handleExport() {
    const XLSX = (await import('xlsx')).default;
    // Recompute independently (old app behavior — no adjustments applied in export)
    const expRevMap: Record<string, number> = {};
    allRev.filter(r => r.month === month && r.year === year).forEach(r => {
      if (r.project_name) expRevMap[r.project_name] = (expRevMap[r.project_name] || 0) + (+(r.amount ?? 0));
    });
    const expProjs = [
      ...FIN_PROJECTS.filter(p => (expRevMap[p] ?? 0) > 0),
      ...Object.keys(expRevMap).filter(p => !FIN_PROJECTS.includes(p) && expRevMap[p] > 0),
    ];
    const expTotalRev = expProjs.reduce((s, p) => s + (expRevMap[p] || 0), 0);

    const exLast     = new Date(year, month, 0);
    const exFirstStr = `${year}-${String(month).padStart(2, '0')}-01`;
    const exLastStr  = `${year}-${String(month).padStart(2, '0')}-${String(exLast.getDate()).padStart(2, '0')}`;
    const totalCalDays = exLast.getDate();
    const exTeam = team.filter(t => {
      if (!t.activated_at) return t.is_active !== false;
      const act = new Date(t.activated_at + 'T00:00:00');
      if (act > exLast) return false;
      if (t.deactivated_at) { const deact = new Date(t.deactivated_at + 'T00:00:00'); if (deact < new Date(year, month - 1, 1)) return false; }
      return true;
    }).map(t => {
      const actStr   = (t.activated_at && t.activated_at > exFirstStr) ? t.activated_at : exFirstStr;
      const deactStr = (t.deactivated_at && t.deactivated_at < exLastStr) ? t.deactivated_at : exLastStr;
      const daysActive     = Math.round((new Date(deactStr + 'T00:00:00').getTime() - new Date(actStr + 'T00:00:00').getTime()) / 86400000) + 1;
      const proratedSalary = Math.round((+(t.monthly_salary ?? 0)) / totalCalDays * daysActive);
      return { ...t, daysActive, totalCalDays, proratedSalary };
    });
    const expTotalSal = exTeam.reduce((s, t) => s + t.proratedSalary, 0);

    const expTotalGenExp = allGen.filter(r => r.month === month && r.year === year).reduce((s, r) => s + (+(r.amount ?? 0)), 0);
    const expProjExpMap: Record<string, number> = {};
    allProj.filter(r => {
      if (r.activity_date) { const d = new Date(r.activity_date); return d.getMonth() + 1 === month && d.getFullYear() === year; }
      return r.month === month && r.year === year;
    }).forEach(r => { const k = r.project_name || '__unassigned__'; expProjExpMap[k] = (expProjExpMap[k] || 0) + (+(r.amount ?? 0)); });
    const expTotalProjExp = (Object.values(expProjExpMap) as number[]).reduce((s, v) => s + v, 0);
    const expCompanyNet = expTotalRev - expTotalSal - expTotalGenExp - expTotalProjExp;

    const expProjRows = expProjs.map(proj => {
      const revenue    = expRevMap[proj] || 0;
      const weight     = expTotalRev > 0 ? revenue / expTotalRev : 0;
      const salaryCost = Math.round(expTotalSal * weight);
      const projExp    = expProjExpMap[proj] || 0;
      const netProfit  = revenue - salaryCost - projExp;
      return { proj, revenue, weight, salaryCost, projExp, netProfit, margin: revenue > 0 ? (netProfit / revenue * 100) : 0 };
    });

    const rows: (string | number)[][] = [];
    rows.push([`Monthly Financial Report — ${FIN_MONTHS[month - 1]} ${year}`]);
    rows.push([]);
    rows.push(['COMPANY SUMMARY']);
    rows.push(['Total Revenue (IQD)',      expTotalRev]);
    rows.push(['Total Salary (IQD)',       expTotalSal]);
    rows.push(['General Expenses (IQD)',   expTotalGenExp]);
    rows.push(['Project Expenses (IQD)',   expTotalProjExp]);
    rows.push(['Net Profit (IQD)',         expCompanyNet]);
    rows.push([]);
    rows.push(['REVENUE BY PROJECT']);
    rows.push(['Project', 'Revenue (IQD)', 'Weight %']);
    expProjRows.forEach(r => rows.push([r.proj, r.revenue, pct(r.weight * 100)]));
    rows.push(['TOTAL', expTotalRev, '100.0%']);
    rows.push([]);
    rows.push(['SALARY DISTRIBUTION']);
    rows.push(['Project', 'Weight %', 'Salary Cost (IQD)']);
    expProjRows.forEach(r => rows.push([r.proj, pct(r.weight * 100), r.salaryCost]));
    rows.push(['TOTAL', '100.0%', expProjRows.reduce((s, r) => s + r.salaryCost, 0)]);
    rows.push([]);
    rows.push(['PER-PROJECT P&L']);
    rows.push(['Project', 'Revenue (IQD)', 'Salary Cost (IQD)', 'Project Expenses (IQD)', 'Net Profit (IQD)', 'Margin %']);
    expProjRows.forEach(r => rows.push([r.proj, r.revenue, r.salaryCost, r.projExp, r.netProfit, pct(r.margin)]));
    const tn = expProjRows.reduce((s, r) => s + r.netProfit, 0);
    rows.push(['TOTAL', expTotalRev, expProjRows.reduce((s, r) => s + r.salaryCost, 0), expTotalProjExp, tn, pct(expTotalRev > 0 ? tn / expTotalRev * 100 : 0)]);
    rows.push([]);
    rows.push([`TEAM MEMBER SALARIES (${workDays} working days)`]);
    rows.push(['Name', 'Role', 'Active From', 'Days Active', 'Actual Salary (IQD)']);
    exTeam.forEach(t => {
      rows.push([t.full_name, t.role || '—', fmtActFrom(t.activated_at), `${t.daysActive}/${workDays} days`, t.proratedSalary]);
    });
    rows.push(['TOTAL', '', '', '', expTotalSal]);

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [28, 20, 18, 20, 12].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, 'Monthly Report');
    XLSX.writeFile(wb, `Finance_Report_${FIN_MONTHS[month - 1]}_${year}.xlsx`);
  }

  // ── Pencil color ─────────────────────────────────────────────
  function pencilColor(m: ActiveMember): string {
    if (!m.isAdjusted) return '#94a3b8';
    if (m.adjType === 'bonus')     return '#16a34a';
    if (m.adjType === 'deduction') return '#dc2626';
    return '#d97706'; // override
  }

  // ── Render ────────────────────────────────────────────────────
  const adjCount = adjs.length;

  return (
    <div className={css.page}>
      {/* Toolbar */}
      <div className={css.toolbar}>
        <select className={css.sel} value={month} onChange={e => { setMonth(+e.target.value); setOpenPanelId(null); }}>
          {FIN_MONTHS.map((mn, i) => <option key={i} value={i + 1}>{mn}</option>)}
        </select>
        <select className={css.sel} value={year} onChange={e => { setYear(+e.target.value); setOpenPanelId(null); }}>
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <label className={css.wdLabel}>
          Working Days
          <input
            type="number" min={1} max={31} value={workDays} className={css.wdInput}
            onChange={e => setWorkDays(Math.max(1, +e.target.value || 22))}
          />
        </label>
        <div className={css.spacer} />
        <button className={css.btnGhost} onClick={() => loadAdjs(month, year)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
          Refresh
        </button>
        <button className={css.btnGreen} onClick={handleExport}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          Export Excel
        </button>
      </div>

      <h2 className={css.heading}>{mLabel} — Monthly Report</h2>

      {!hasAnyData ? (
        <div className={css.empty}>No financial data recorded for {mLabel}.</div>
      ) : (
        <>
          {/* KPI Cards */}
          <div className={css.kpiRow}>
            <div className={css.kpiCard}>
              <div className={css.kpiLabel}>Total Revenue</div>
              <div className={`${css.kpiValue} ${css.kpiPos}`}>{iqd(totalRevenue)}</div>
              <div className={css.kpiSub}>{activeProjs.length} project{activeProjs.length !== 1 ? 's' : ''}</div>
            </div>
            <div className={css.kpiCard}>
              <div className={css.kpiLabel}>Total Salary</div>
              <div className={`${css.kpiValue} ${css.kpiWarn}`}>{iqd(totalSalaryBudget)}</div>
              <div className={css.kpiSub}>{activeEmployeeCount} active employee{activeEmployeeCount !== 1 ? 's' : ''}</div>
            </div>
            <div className={css.kpiCard}>
              <div className={css.kpiLabel}>General Expenses</div>
              <div className={`${css.kpiValue} ${css.kpiNeg}`}>{iqd(totalGenExp)}</div>
              <div className={css.kpiSub}>Shared overhead</div>
            </div>
            <div className={css.kpiCard}>
              <div className={css.kpiLabel}>Project Expenses</div>
              <div className={`${css.kpiValue} ${css.kpiNeg}`}>{iqd(totalProjExp)}</div>
              <div className={css.kpiSub}>Direct project costs</div>
            </div>
            <div className={css.kpiCard}>
              <div className={css.kpiLabel}>Net Profit</div>
              <div className={`${css.kpiValue} ${companyNet >= 0 ? css.kpiPos : css.kpiNeg}`}>{iqd(companyNet)}</div>
              <div className={css.kpiSub}>Rev − Salary − Gen. Exp. − Proj. Exp.</div>
            </div>
          </div>

          {/* Revenue by Project */}
          <div className={css.sectionHdr}>Revenue by Project</div>
          {activeProjs.length === 0
            ? <div className={css.empty}>No revenue recorded for {mLabel}.</div>
            : <div className={css.tableWrap}>
                <table className={css.table}>
                  <thead><tr>
                    <th>Project</th>
                    <th className={css.num}>Revenue (IQD)</th>
                    <th className={css.num}>Weight %</th>
                  </tr></thead>
                  <tbody>
                    {projRows.map(r => (
                      <tr key={r.proj}>
                        <td><strong>{r.proj}</strong></td>
                        <td className={css.num} style={{ color: '#16a34a' }}>{iqd(r.revenue)}</td>
                        <td className={css.num}>
                          <div className={css.weightCell}>
                            <div className={css.weightBar}><div className={css.weightFill} style={{ width: (r.weight * 100).toFixed(1) + '%' }} /></div>
                            <span style={{ minWidth: 38, textAlign: 'right' }}>{pct(r.weight * 100)}</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr>
                    <td>TOTAL</td>
                    <td className={css.num}><strong style={{ color: '#16a34a' }}>{iqd(totalRevenue)}</strong></td>
                    <td className={css.num}><strong>100.0%</strong></td>
                  </tr></tfoot>
                </table>
              </div>
          }

          {/* Salary Distribution */}
          <div className={css.sectionHdr}>Salary Distribution</div>
          <p className={css.descPara}>
            Total monthly salary budget: <strong style={{ color: '#1e293b' }}>{iqd(totalSalaryBudget)}</strong>{' '}
            {activeProjs.length > 0
              ? 'distributed across projects by revenue weight'
              : "(no revenue recorded this month, so it can't be distributed by project)"}
            {' '}({activeEmployeeCount} active employee{activeEmployeeCount !== 1 ? 's' : ''}).
          </p>
          {activeProjs.length > 0 && (
            <div className={css.tableWrap}>
              <table className={css.table}>
                <thead><tr>
                  <th>Project</th>
                  <th className={css.num}>Revenue Weight %</th>
                  <th className={css.num}>Salary Cost (IQD)</th>
                </tr></thead>
                <tbody>
                  {projRows.map(r => (
                    <tr key={r.proj}>
                      <td><strong>{r.proj}</strong></td>
                      <td className={css.num}>{pct(r.weight * 100)}</td>
                      <td className={css.num} style={{ color: '#d97706' }}>{iqd(r.salaryCost)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr>
                  <td>TOTAL</td>
                  <td className={css.num}><strong>100.0%</strong></td>
                  <td className={css.num}><strong style={{ color: '#d97706' }}>{iqd(projRows.reduce((s, r) => s + r.salaryCost, 0))}</strong></td>
                </tr></tfoot>
              </table>
            </div>
          )}

          {/* Per-Project P&L */}
          <div className={css.sectionHdr}>Per-Project P&L</div>
          {activeProjs.length === 0
            ? <div className={css.empty}>No revenue recorded this month, so per-project P&L can't be computed.</div>
            : <div className={css.tableWrap}>
                <table className={css.table}>
                  <thead><tr>
                    <th>Project</th>
                    <th className={css.num}>Revenue (IQD)</th>
                    <th className={css.num}>Salary Cost (IQD)</th>
                    <th className={css.num}>Project Expenses (IQD)</th>
                    <th className={css.num}>Net Profit (IQD)</th>
                    <th className={css.num}>Margin %</th>
                  </tr></thead>
                  <tbody>
                    {projRows.map(r => (
                      <tr key={r.proj}>
                        <td><strong>{r.proj}</strong></td>
                        <td className={css.num} style={{ color: '#16a34a' }}>{iqd(r.revenue)}</td>
                        <td className={css.num} style={{ color: '#d97706' }}>{iqd(r.salaryCost)}</td>
                        <td className={`${css.num} ${css.kpiNeg}`}>{iqd(r.projExp)}</td>
                        <td className={`${css.num} ${r.netProfit >= 0 ? css.profitPos : css.profitNeg}`}>{iqd(r.netProfit)}</td>
                        <td className={`${css.num} ${r.margin >= 0 ? css.profitPos : css.profitNeg}`}>{pct(r.margin)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    {(() => {
                      const tn = projRows.reduce((s, r) => s + r.netProfit, 0);
                      const tm = totalRevenue > 0 ? (tn / totalRevenue * 100) : 0;
                      return (
                        <tr>
                          <td>TOTAL</td>
                          <td className={css.num}><strong style={{ color: '#16a34a' }}>{iqd(totalRevenue)}</strong></td>
                          <td className={css.num}><strong style={{ color: '#d97706' }}>{iqd(projRows.reduce((s, r) => s + r.salaryCost, 0))}</strong></td>
                          <td className={`${css.num} ${css.kpiNeg}`}><strong>{iqd(totalProjExp)}</strong></td>
                          <td className={`${css.num} ${tn >= 0 ? css.profitPos : css.profitNeg}`}><strong>{iqd(tn)}</strong></td>
                          <td className={`${css.num} ${tm >= 0 ? css.profitPos : css.profitNeg}`}><strong>{pct(tm)}</strong></td>
                        </tr>
                      );
                    })()}
                  </tfoot>
                </table>
              </div>
          }

          {/* Net Profit by Project chart */}
          {projRows.length > 0 && (
            <>
              <div className={css.sectionHdr}>Net Profit by Project</div>
              <div className={css.chartPanel}>
                <Bar
                  data={{
                    labels: projRows.map(r => r.proj.replace(' Project', '')),
                    datasets: [{
                      label: 'Net Profit (IQD)',
                      data: projRows.map(r => r.netProfit),
                      backgroundColor: projRows.map(r => r.netProfit >= 0 ? 'rgba(22,163,74,.8)' : 'rgba(220,38,38,.8)'),
                      borderRadius: 4,
                    }],
                  }}
                  options={{
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                      y: { ticks: { callback: (v: number | string) => (+v).toLocaleString() } },
                      x: { grid: { display: false } },
                    },
                  }}
                />
              </div>
            </>
          )}

          {/* Team Member Salaries */}
          <div className={css.salHdr}>
            <div className={css.salHdrLeft}>
              <span className={css.salHdrTitle}>Team Member Salaries</span>
              {adjCount > 0 && <span className={css.adjCountBadge}>{adjCount} adjusted</span>}
            </div>
            {teamWithSalary.length > 0 && (
              <button className={css.btnAdjAll} onClick={() => { setShowAdjAll(true); setAdjAllState({ type: 'override', pct: '100', reason: '' }); }}>
                Adjust All
              </button>
            )}
          </div>
          <p className={css.descPara}>
            Pro-rated salaries for <strong>{mLabel}</strong> ({workDays} calendar days). Click the pencil to adjust an individual salary.
          </p>
          {teamWithSalary.length === 0
            ? <div className={css.empty}>No active team members for this period.</div>
            : <div className={css.tableWrap}>
                <table className={css.table}>
                  <thead><tr>
                    <th>Name</th>
                    <th>Role</th>
                    <th className={css.num}>Active From</th>
                    <th className={css.num}>Days Active</th>
                    <th className={css.num}>Actual Salary (IQD)</th>
                  </tr></thead>
                  <tbody>
                    {teamWithSalary.map(t => {
                      const ps = panelStates[t.id];
                      const initPreview = t.isAdjusted
                        ? computeEffective(t.adjType, t.proratedSalary, t.adjAmount)
                        : t.proratedSalary;
                      return (
                        <>
                          <tr key={t.id}>
                            <td><strong>{t.full_name}</strong></td>
                            <td style={{ color: '#64748b' }}>{t.role || '—'}</td>
                            <td className={css.num}>{fmtActFrom(t.activated_at)}</td>
                            <td className={css.num}>{t.daysActive}/{t.totalCalDays} days</td>
                            <td className={css.num} style={{ color: '#d97706' }}>
                              {t.isAdjusted
                                ? <>
                                    <s style={{ color: '#94a3b8', fontWeight: 400 }}>{iqd(t.proratedSalary)}</s>{' '}
                                    <strong>{iqd(t.effectiveSalary)}</strong>
                                    <span className={`${css.adjBadge} ${t.adjType === 'bonus' ? css.adjBadgeBonus : t.adjType === 'deduction' ? css.adjBadgeDeduction : css.adjBadgeOverride}`}>
                                      {t.adjType === 'bonus' ? 'Bonus' : t.adjType === 'deduction' ? 'Deduction' : 'Override'}
                                    </span>
                                  </>
                                : iqd(t.effectiveSalary)
                              }
                              <button
                                className={css.pencilBtn}
                                style={{ color: pencilColor(t) }}
                                title="Adjust salary"
                                onClick={() => openPanel(t)}
                              >
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                                </svg>
                              </button>
                            </td>
                          </tr>
                          {openPanelId === t.id && (
                            <tr key={t.id + '_panel'}>
                              <td colSpan={5} style={{ padding: 0, borderBottom: '2px solid #6366f1' }}>
                                <div className={css.adjPanel}>
                                  <div className={css.adjPanelTitle}>Adjust Salary — {t.full_name}</div>
                                  <div className={css.adjFields}>
                                    <div className={css.adjField}>
                                      <label className={css.adjFieldLabel}>Adjustment Type</label>
                                      <select
                                        className={css.adjSel}
                                        value={ps?.type || 'override'}
                                        onChange={e => updatePanel(t.id, { type: e.target.value })}
                                      >
                                        <option value="override">Override</option>
                                        <option value="bonus">Bonus</option>
                                        <option value="deduction">Deduction</option>
                                      </select>
                                    </div>
                                    <div className={css.adjField}>
                                      <label className={css.adjFieldLabel}>
                                        {ps?.type === 'bonus' ? 'Bonus Amount (IQD)' : ps?.type === 'deduction' ? 'Deduction Amount (IQD)' : 'Override Amount (IQD)'}
                                      </label>
                                      <div className={css.adjQuickBtns}>
                                        {[25, 50, 75, 100].map(q => (
                                          <button key={q} className={css.adjQuickBtn} type="button"
                                            onClick={() => updatePanel(t.id, { amount: String(Math.round(t.proratedSalary * q / 100)) })}>
                                            {q}%
                                          </button>
                                        ))}
                                      </div>
                                      <input
                                        type="number" min={0} className={css.adjAmtInput}
                                        value={ps?.amount ?? (t.isAdjusted ? String(t.adjAmount) : String(t.proratedSalary))}
                                        onChange={e => updatePanel(t.id, { amount: e.target.value })}
                                      />
                                    </div>
                                    <div className={css.adjField}>
                                      <label className={css.adjFieldLabel}>Reason (optional)</label>
                                      <input
                                        type="text" className={css.adjReasonInput}
                                        placeholder="e.g. Ramadan bonus…"
                                        value={ps?.reason ?? t.adjReason}
                                        onChange={e => updatePanel(t.id, { reason: e.target.value })}
                                      />
                                    </div>
                                  </div>
                                  <div className={css.adjPreview}>
                                    Result:{' '}
                                    <strong className={css.adjPreviewAmt}>
                                      {(ps
                                        ? getPanelPreview(t.id, t.proratedSalary)
                                        : initPreview
                                      ).toLocaleString('en-US')} IQD
                                    </strong>
                                  </div>
                                  <div className={css.adjActions}>
                                    <button className={css.btnSave}   onClick={() => saveAdj(t)}>Save</button>
                                    {t.isAdjusted && <button className={css.btnRemove} onClick={() => removeAdj(t)}>Remove</button>}
                                    <button className={css.btnCancel} onClick={() => setOpenPanelId(null)}>Cancel</button>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </>
                      );
                    })}
                  </tbody>
                  <tfoot><tr>
                    <td colSpan={4}>TOTAL</td>
                    <td className={css.num}><strong style={{ color: '#d97706' }}>{iqd(totalSalaryBudget)}</strong></td>
                  </tr></tfoot>
                </table>
              </div>
          }

          {/* Company Summary */}
          <div className={css.sectionHdr}>Company Summary</div>
          <div className={`${css.tableWrap} ${css.summaryWrap}`}>
            <table className={css.table}>
              <tbody>
                <tr><td>Total Revenue</td>                        <td className={`${css.num} ${css.profitPos}`}><strong>{iqd(totalRevenue)}</strong></td></tr>
                <tr><td style={{ color: '#64748b' }}>− Total Salary Cost</td>  <td className={css.num} style={{ color: '#d97706' }}><strong>{iqd(totalSalaryBudget)}</strong></td></tr>
                <tr><td style={{ color: '#64748b' }}>− General Expenses</td>   <td className={`${css.num} ${css.kpiNeg}`}><strong>{iqd(totalGenExp)}</strong></td></tr>
                <tr><td style={{ color: '#64748b' }}>− Project Expenses</td>   <td className={`${css.num} ${css.kpiNeg}`}><strong>{iqd(totalProjExp)}</strong></td></tr>
                <tr style={{ borderTop: '2px solid #e2e8f0' }}>
                  <td><strong>Net Profit / Loss</strong></td>
                  <td className={`${css.num} ${companyNet >= 0 ? css.profitPos : css.profitNeg}`}>
                    <strong style={{ fontSize: 15 }}>{iqd(companyNet)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Adjust All Modal */}
      {showAdjAll && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget) setShowAdjAll(false); }}>
          <div className={css.modal}>
            <div className={css.modalTitle}>Adjust All Salaries</div>
            <div className={css.modalSub}>
              Applies to {teamWithSalary.length} team member{teamWithSalary.length !== 1 ? 's' : ''} for {mLabel}.
            </div>
            <div className={css.modalField}>
              <label className={css.modalLabel}>Quick %</label>
              <div className={css.quickPctRow}>
                {[25, 50, 75, 100].map(q => (
                  <button key={q} className={css.quickPctBtn} onClick={() => setAdjAllState(s => ({ ...s, pct: String(q) }))}>
                    {q}%
                  </button>
                ))}
              </div>
            </div>
            <div className={css.modalField}>
              <label className={css.modalLabel}>Adjustment Type</label>
              <select className={css.modalSel} value={adjAllState.type} onChange={e => setAdjAllState(s => ({ ...s, type: e.target.value }))}>
                <option value="override">Override — replace calculated salary</option>
                <option value="bonus">Bonus — add to calculated salary</option>
                <option value="deduction">Deduction — subtract from calculated salary</option>
              </select>
            </div>
            <div className={css.modalField}>
              <label className={css.modalLabel}>% of calculated salary</label>
              <input type="number" min={0} max={500} className={css.modalInput} value={adjAllState.pct}
                onChange={e => setAdjAllState(s => ({ ...s, pct: e.target.value }))} />
            </div>
            <div className={css.modalField}>
              <label className={css.modalLabel}>Reason (optional)</label>
              <input type="text" className={css.modalInput} placeholder="e.g. Ramadan bonus, deduction…"
                value={adjAllState.reason} onChange={e => setAdjAllState(s => ({ ...s, reason: e.target.value }))} />
            </div>
            <div className={css.modalPreview} dangerouslySetInnerHTML={{ __html: adjAllPreview().replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') }} />
            <div className={css.modalActions}>
              <button className={css.btnCancel} onClick={() => setShowAdjAll(false)}>Cancel</button>
              <button className={css.btnApply} onClick={applyAdjAll}>Apply to All</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Toast */}
      {toast && createPortal(
        <div className={`${css.toast} ${toast.ok ? css.toastOk : css.toastErr}`}>{toast.msg}</div>,
        document.body
      )}
    </div>
  );
}
