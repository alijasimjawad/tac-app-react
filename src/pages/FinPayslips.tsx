import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { FIN_MONTHS, iqd, getYears } from '../lib/finHelpers';
import css from './FinPayslips.module.css';

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

interface ExpClaim {
  id: string;
  member_id: string;
  activity_date: string | null;
  total_amount: number | null;
  transport_amount: number | null;
  food_amount: number | null;
  extra_categories: unknown;
  project_name: string | null;
  site_id: string | null;
}

interface ExtraRow { category: string; amount: number | string; }

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

interface PayslipRow extends ActiveMember {
  expenseTotal: number;
  netPay: number;
  claims: ExpClaim[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// Exact copy of buildTeamWithSalary from FinReport.tsx — keeps payslip numbers
// in sync with the Monthly Report.
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

function parseExtra(raw: unknown): ExtraRow[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as ExtraRow[];
  if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

function fmtDMY(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [yr, mo, dy] = iso.split('-');
  return `${dy}/${mo}/${yr}`;
}

// ── Print helper ───────────────────────────────────────────────────────────────

function printPayslip(row: PayslipRow, month: number, year: number) {
  const periodLabel = FIN_MONTHS[month - 1] + ' ' + year;
  const fmt = (v: number | null | undefined) => (+(v ?? 0)).toLocaleString('en-US') + ' IQD';
  const e   = (s: string | null | undefined) =>
    String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const isFullMonth = row.daysActive === row.totalCalDays;

  const earningsRows = [
    `<tr><td>Base Monthly Salary</td><td style="text-align:right">${fmt(row.monthly_salary)}</td></tr>`,
    ...(isFullMonth ? [] : [
      `<tr style="background:#f8fafc"><td style="color:#64748b">Days Active (${row.daysActive} of ${row.totalCalDays} calendar days)</td><td style="text-align:right;color:#64748b">${fmt(row.proratedSalary)}</td></tr>`,
    ]),
    ...(row.isAdjusted && row.adjType === 'bonus' ? [
      `<tr><td style="color:#16a34a">Bonus${row.adjReason ? ' — ' + e(row.adjReason) : ''}</td><td style="text-align:right;color:#16a34a;font-weight:700">+ ${fmt(row.adjAmount)}</td></tr>`,
    ] : []),
  ].join('');

  const deductionSection = row.isAdjusted && row.adjType === 'deduction'
    ? `<div class="section-title">Deductions</div>
       <table><thead><tr><th>Description</th><th style="text-align:right">Amount</th></tr></thead>
       <tbody><tr><td style="color:#dc2626">Deduction${row.adjReason ? ' — ' + e(row.adjReason) : ''}</td>
       <td style="text-align:right;color:#dc2626;font-weight:700">− ${fmt(row.adjAmount)}</td></tr></tbody></table>`
    : '';

  const overrideNote = row.isAdjusted && row.adjType === 'override'
    ? `<p style="font-size:11px;color:#d97706;margin-top:-16px;margin-bottom:20px">⚠ Salary overridden to ${fmt(row.effectiveSalary)}${row.adjReason ? ' — ' + e(row.adjReason) : ''}.</p>`
    : '';

  const expRows = row.claims.length === 0
    ? '<tr><td colspan="4" style="text-align:center;color:#94a3b8;padding:14px">No approved expense claims this period.</td></tr>'
    : row.claims.map((c, i) => {
        const extras = parseExtra(c.extra_categories);
        const otherTotal = extras.reduce((s, r) => s + (parseFloat(r.amount as string) || 0), 0);
        const breakdown = [
          (+(c.transport_amount ?? 0)) > 0 ? 'Transport: ' + fmt(c.transport_amount) : '',
          (+(c.food_amount ?? 0)) > 0 ? 'Food: ' + fmt(c.food_amount) : '',
          otherTotal > 0 ? 'Other: ' + fmt(otherTotal) : '',
        ].filter(Boolean).join(' · ') || '—';
        return `<tr style="background:${i % 2 === 0 ? '#fff' : '#f8fafc'}">
          <td>${e(fmtDMY(c.activity_date))}</td>
          <td>${e(c.project_name)}${c.site_id ? ' / <strong>' + e(c.site_id) + '</strong>' : ''}</td>
          <td style="color:#64748b;font-size:12px">${e(breakdown)}</td>
          <td style="text-align:right;font-weight:700">${fmt(c.total_amount)}</td>
        </tr>`;
      }).join('');

  const expFooter = row.claims.length > 0
    ? `<tfoot><tr style="background:#f1f5f9"><td colspan="3"><strong>Reimbursements Total</strong></td><td style="text-align:right"><strong>${fmt(row.expenseTotal)}</strong></td></tr></tfoot>`
    : '';

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>Payslip — ${e(row.full_name)} — ${e(periodLabel)}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size:13px; color:#1e293b; background:#fff; padding:32px; }
    @media print { body { padding:16px; } @page { margin:12mm; } }
    .header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:32px; padding-bottom:20px; border-bottom:2px solid #e2e8f0; }
    .brand { font-size:22px; font-weight:900; color:#2563eb; letter-spacing:-0.5px; }
    .brand-sub { font-size:11px; color:#94a3b8; margin-top:2px; }
    .doc-meta { text-align:right; }
    .doc-title { font-size:20px; font-weight:800; color:#1e293b; }
    .doc-period { font-size:13px; color:#64748b; margin-top:4px; }
    .grid-2 { display:grid; grid-template-columns:1fr 1fr; gap:24px; margin-bottom:28px; }
    .info-box h4 { font-size:10px; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:.8px; margin-bottom:6px; }
    .info-box p { font-size:13px; color:#334155; line-height:1.7; }
    .info-box strong { color:#1e293b; font-weight:700; }
    table { width:100%; border-collapse:collapse; margin-bottom:24px; }
    th { background:#f1f5f9; font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase; letter-spacing:.5px; padding:8px 12px; text-align:left; border-bottom:1px solid #e2e8f0; }
    td { padding:9px 12px; border-bottom:1px solid #f1f5f9; color:#334155; }
    .section-title { font-size:11px; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:.6px; margin-bottom:8px; margin-top:20px; }
    .totals-box { background:#1e293b; border-radius:8px; padding:16px 20px; display:flex; justify-content:space-between; align-items:center; margin-top:8px; gap:16px; }
    .tot-item { text-align:center; }
    .tot-label { font-size:10px; color:#94a3b8; margin-bottom:3px; text-transform:uppercase; letter-spacing:.5px; font-weight:700; }
    .tot-value { font-size:16px; font-weight:800; color:#f1f5f9; }
    .tot-value-big { font-size:22px; font-weight:900; color:#4ade80; }
    .footer { margin-top:36px; padding-top:14px; border-top:1px solid #e2e8f0; font-size:11px; color:#94a3b8; text-align:center; }
  </style></head><body>
  <div class="header">
    <div><div class="brand">TAC Network</div><div class="brand-sub">Telecom Infrastructure Management</div></div>
    <div class="doc-meta">
      <div class="doc-title">PAYSLIP</div>
      <div class="doc-period">${e(periodLabel)}</div>
    </div>
  </div>
  <div class="grid-2">
    <div class="info-box">
      <h4>Employee</h4>
      <p><strong>${e(row.full_name)}</strong><br>${e(row.role || '—')}</p>
    </div>
    <div class="info-box" style="text-align:right">
      <h4>Pay Period</h4>
      <p><strong>${e(periodLabel)}</strong><br>Days Active: <strong>${row.daysActive} / ${row.totalCalDays}</strong></p>
    </div>
  </div>
  <div class="section-title">Earnings</div>
  <table>
    <thead><tr><th>Description</th><th style="text-align:right">Amount</th></tr></thead>
    <tbody>${earningsRows}</tbody>
    <tfoot><tr style="background:#f1f5f9"><td><strong>Salary Total</strong></td><td style="text-align:right"><strong>${fmt(row.effectiveSalary)}</strong></td></tr></tfoot>
  </table>
  ${overrideNote}
  ${deductionSection}
  <div class="section-title">Reimbursements (Approved Expense Claims)</div>
  <table>
    <thead><tr><th>Date</th><th>Project / Site</th><th>Breakdown</th><th style="text-align:right">Amount</th></tr></thead>
    <tbody>${expRows}</tbody>
    ${expFooter}
  </table>
  <div class="totals-box">
    <div class="tot-item"><div class="tot-label">Effective Salary</div><div class="tot-value">${fmt(row.effectiveSalary)}</div></div>
    <div class="tot-item"><div class="tot-label">Reimbursements</div><div class="tot-value" style="color:#60a5fa">${fmt(row.expenseTotal)}</div></div>
    <div class="tot-item"><div class="tot-label">Net Pay</div><div class="tot-value-big">${fmt(row.netPay)}</div></div>
  </div>
  <div class="footer">Generated by TAC Network Tracker &nbsp;·&nbsp; ${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
  <script>window.onload = function(){ window.print(); }<\/script>
  </body></html>`;
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
}

// ── PayslipDetail ──────────────────────────────────────────────────────────────

function PayslipDetail({ row, month, year, canDownload, onCollapse }: {
  row: PayslipRow;
  month: number;
  year: number;
  canDownload: boolean;
  onCollapse: () => void;
}) {
  const isFullMonth = row.daysActive === row.totalCalDays;

  return (
    <div className={css.detailPanel}>
      <div className={css.detailGrid}>
        {/* Earnings */}
        <div className={css.detailSection}>
          <div className={css.detailSectionTitle}>Earnings</div>
          <table className={css.detailTable}>
            <tbody>
              <tr><td>Base Monthly Salary</td><td>{iqd(row.monthly_salary)}</td></tr>
              {!isFullMonth && (
                <tr>
                  <td style={{ color: '#64748b' }}>Prorated ({row.daysActive}/{row.totalCalDays} days)</td>
                  <td style={{ color: '#64748b' }}>{iqd(row.proratedSalary)}</td>
                </tr>
              )}
              {row.isAdjusted && row.adjType === 'bonus' && (
                <tr>
                  <td className={css.adjBonus}>Bonus{row.adjReason ? ` — ${row.adjReason}` : ''}</td>
                  <td className={css.adjBonus}>+{iqd(row.adjAmount)}</td>
                </tr>
              )}
              {row.isAdjusted && row.adjType === 'override' && (
                <tr>
                  <td className={css.adjOverride}>Override{row.adjReason ? ` — ${row.adjReason}` : ''}</td>
                  <td className={css.adjOverride}>{iqd(row.adjAmount)}</td>
                </tr>
              )}
            </tbody>
            <tfoot className={css.detailTableFoot}>
              <tr><td>Salary Total</td><td>{iqd(row.effectiveSalary)}</td></tr>
            </tfoot>
          </table>
        </div>

        {/* Deductions */}
        <div className={css.detailSection}>
          <div className={css.detailSectionTitle}>Deductions</div>
          <table className={css.detailTable}>
            <tbody>
              {row.isAdjusted && row.adjType === 'deduction' ? (
                <tr>
                  <td className={css.adjDeduction}>Deduction{row.adjReason ? ` — ${row.adjReason}` : ''}</td>
                  <td className={css.adjDeduction}>−{iqd(row.adjAmount)}</td>
                </tr>
              ) : (
                <tr><td colSpan={2} style={{ color: '#94a3b8', textAlign: 'center', padding: '16px 14px' }}>No deductions</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Expense Claims */}
        <div className={`${css.detailSection} ${css.fullWidth}`}>
          <div className={css.detailSectionTitle}>
            Reimbursements — Approved Expense Claims ({row.claims.length})
          </div>
          <table className={css.detailTable}>
            <thead className={css.detailTableHead}>
              <tr>
                <th>Date</th>
                <th>Project</th>
                <th>Site ID</th>
                <th>Transport</th>
                <th>Food & Meals</th>
                <th>Other</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {row.claims.length === 0 ? (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: '#94a3b8', padding: '16px 14px' }}>No approved expense claims this period.</td></tr>
              ) : (
                row.claims.map(c => {
                  const extras = parseExtra(c.extra_categories);
                  const otherTotal = extras.reduce((s, r) => s + (parseFloat(r.amount as string) || 0), 0);
                  return (
                    <tr key={c.id}>
                      <td>{fmtDMY(c.activity_date)}</td>
                      <td>{c.project_name || '—'}</td>
                      <td><span style={{ fontFamily: 'monospace', fontSize: 12 }}>{c.site_id || '—'}</span></td>
                      <td className={css.num}>{(+(c.transport_amount ?? 0)) > 0 ? iqd(c.transport_amount) : '—'}</td>
                      <td className={css.num}>{(+(c.food_amount ?? 0)) > 0 ? iqd(c.food_amount) : '—'}</td>
                      <td className={css.num}>{otherTotal > 0 ? iqd(otherTotal) : '—'}</td>
                      <td className={css.num}><strong>{iqd(c.total_amount)}</strong></td>
                    </tr>
                  );
                })
              )}
            </tbody>
            {row.claims.length > 0 && (
              <tfoot className={css.detailTableFoot}>
                <tr>
                  <td colSpan={6}>Reimbursements Total</td>
                  <td style={{ textAlign: 'right' }}>{iqd(row.expenseTotal)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* Net Pay bar */}
      <div className={css.netPayBar}>
        <div className={css.netPayItem}>
          <div className={css.netPayLabel}>Effective Salary</div>
          <div className={css.netPayValue}>{iqd(row.effectiveSalary)}</div>
        </div>
        <div className={css.netPayDivider} />
        <div className={css.netPayItem}>
          <div className={css.netPayLabel}>Reimbursements</div>
          <div className={css.netPayValue}>{iqd(row.expenseTotal)}</div>
        </div>
        <div className={css.netPayDivider} />
        <div className={css.netPayItem}>
          <div className={css.netPayLabel}>Net Pay</div>
          <div className={css.netPayValueBig}>{iqd(row.netPay)}</div>
        </div>
      </div>

      {/* Actions */}
      <div className={css.detailActions}>
        {canDownload && (
          <button className={css.btnPdf} onClick={() => printPayslip(row, month, year)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>
            </svg>
            Download PDF
          </button>
        )}
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

export default function FinPayslips() {
  const { hasPerm } = useAuth();

  if (!hasPerm('view_fin_payslips')) {
    return <div className={css.errorMsg}>Access denied.</div>;
  }

  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year,  setYear]  = useState(now.getFullYear());

  const [team,   setTeam]   = useState<TeamMember[]>([]);
  const [adjs,   setAdjs]   = useState<SalAdj[]>([]);
  const [claims, setClaims] = useState<ExpClaim[]>([]);

  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Fetch team members (current salary/status), adjustments, and approved claims
  // together so every field on the payslip — base salary, bonuses/deductions,
  // and reimbursements — is always pulled fresh, never stale/cached.
  const loadAll = useCallback(async (m: number, y: number) => {
    setLoading(true);
    const dLast = new Date(y, m, 0);
    const first = `${y}-${String(m).padStart(2, '0')}-01`;
    const last  = `${y}-${String(m).padStart(2, '0')}-${String(dLast.getDate()).padStart(2, '0')}`;
    const [teamRes, adjRes, claimRes] = await Promise.all([
      supabase.from('team_members')
        .select('id,full_name,role,monthly_salary,is_active,activated_at,deactivated_at')
        .order('full_name'),
      supabase.from('salary_adjustments').select('*').eq('month', m).eq('year', y),
      supabase.from('expense_claims')
        .select('id,member_id,activity_date,total_amount,transport_amount,food_amount,extra_categories,project_name,site_id')
        .eq('status', 'approved')
        .or('is_car_trip.is.null,is_car_trip.eq.false')
        .gte('activity_date', first)
        .lte('activity_date', last),
    ]);
    if (teamRes.error) { setError('Failed to load team members.'); setLoading(false); return; }
    setTeam(teamRes.data || []);
    setAdjs(adjRes.data || []);
    setClaims(claimRes.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(month, year); }, [month, year, loadAll]);

  // ── Computed rows ──────────────────────────────────────────────
  const teamWithSalary = buildTeamWithSalary(team, adjs, month, year);
  const rows: PayslipRow[] = teamWithSalary.map(m => {
    const memberClaims = claims.filter(c => c.member_id === m.id);
    const expenseTotal = memberClaims.reduce((s, c) => s + (+(c.total_amount ?? 0)), 0);
    return { ...m, expenseTotal, netPay: m.effectiveSalary + expenseTotal, claims: memberClaims };
  });

  const totalEffective  = rows.reduce((s, r) => s + r.effectiveSalary, 0);
  const totalExpenses   = rows.reduce((s, r) => s + r.expenseTotal, 0);
  const totalNetPay     = rows.reduce((s, r) => s + r.netPay, 0);
  const mLabel          = FIN_MONTHS[month - 1] + ' ' + year;
  const years           = getYears();

  function toggleExpand(id: string) {
    setExpandedId(prev => (prev === id ? null : id));
  }

  // ── Render ─────────────────────────────────────────────────────
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
        <button className={css.btnGhost} onClick={() => loadAll(month, year)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
          Refresh
        </button>
      </div>

      <h2 className={css.heading}>{mLabel} — Payslips</h2>

      {error ? (
        <div className={css.errorMsg}>{error}</div>
      ) : loading ? (
        <div className={css.empty}>Loading…</div>
      ) : (
        <>
          {/* KPI summary */}
          <div className={css.kpiRow}>
            <div className={css.kpiCard}>
              <div className={css.kpiLabel}>Active Employees</div>
              <div className={css.kpiValue}>{rows.length}</div>
              <div className={css.kpiSub}>for {mLabel}</div>
            </div>
            <div className={css.kpiCard}>
              <div className={css.kpiLabel}>Total Salary Budget</div>
              <div className={`${css.kpiValue} ${css.kpiAmber}`}>{iqd(totalEffective)}</div>
              <div className={css.kpiSub}>after adjustments</div>
            </div>
            <div className={css.kpiCard}>
              <div className={css.kpiLabel}>Total Reimbursements</div>
              <div className={`${css.kpiValue} ${css.kpiBlue}`}>{iqd(totalExpenses)}</div>
              <div className={css.kpiSub}>approved expense claims</div>
            </div>
            <div className={css.kpiCard}>
              <div className={css.kpiLabel}>Total Net Pay</div>
              <div className={`${css.kpiValue} ${css.kpiGreen}`}>{iqd(totalNetPay)}</div>
              <div className={css.kpiSub}>salary + reimbursements</div>
            </div>
          </div>

          {/* Payslip table */}
          {rows.length === 0 ? (
            <div className={css.empty}>No active team members for {mLabel}.</div>
          ) : (
            <div className={css.tableWrap}>
              <table className={css.table}>
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Role</th>
                    <th className={css.num}>Base Salary</th>
                    <th className={css.num}>Days</th>
                    <th className={css.num}>Prorated</th>
                    <th className={css.num}>Adjustment</th>
                    <th className={css.num}>Expenses</th>
                    <th className={css.num}>Net Pay</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.flatMap(row => {
                    const isExpanded = expandedId === row.id;
                    const adjCell = !row.isAdjusted
                      ? <span style={{ color: '#94a3b8' }}>—</span>
                      : row.adjType === 'bonus'
                        ? <span className={css.adjBonus}>+{iqd(row.adjAmount)}</span>
                        : row.adjType === 'deduction'
                          ? <span className={css.adjDeduction}>−{iqd(row.adjAmount)}</span>
                          : <span className={css.adjOverride}>{iqd(row.adjAmount)} (override)</span>;
                    return [
                      <tr
                        key={row.id}
                        className={`${css.tableRow} ${isExpanded ? css.tableRowExpanded : ''}`}
                        onClick={() => toggleExpand(row.id)}
                      >
                        <td><strong>{row.full_name}</strong></td>
                        <td style={{ color: '#64748b' }}>{row.role || '—'}</td>
                        <td className={css.num}>{iqd(row.monthly_salary)}</td>
                        <td className={css.num} style={{ color: '#64748b' }}>{row.daysActive}/{row.totalCalDays}</td>
                        <td className={css.num}>{iqd(row.proratedSalary)}</td>
                        <td className={css.num}>{adjCell}</td>
                        <td className={css.num}>{row.expenseTotal > 0 ? <span style={{ color: '#2563eb' }}>{iqd(row.expenseTotal)}</span> : <span style={{ color: '#94a3b8' }}>—</span>}</td>
                        <td className={css.num}><strong style={{ color: '#16a34a' }}>{iqd(row.netPay)}</strong></td>
                      </tr>,
                      ...(isExpanded ? [
                        <tr key={`${row.id}-detail`}>
                          <td colSpan={8} className={css.expandCell}>
                            <PayslipDetail
                              row={row}
                              month={month}
                              year={year}
                              canDownload={hasPerm('fin_payslips_download_pdf')}
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
                    <td colSpan={4}>TOTAL — {rows.length} employee{rows.length !== 1 ? 's' : ''}</td>
                    <td className={css.num}>{iqd(rows.reduce((s, r) => s + r.proratedSalary, 0))}</td>
                    <td className={css.num}></td>
                    <td className={css.num} style={{ color: '#2563eb' }}>{iqd(totalExpenses)}</td>
                    <td className={css.num} style={{ color: '#16a34a' }}>{iqd(totalNetPay)}</td>
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
