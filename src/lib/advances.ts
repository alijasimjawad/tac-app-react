import { supabase } from './supabase';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Advance {
  id: string;
  member_id: string;
  member_name: string;
  amount: number;
  date_given: string | null;
  installments: number;
  start_month: number;
  start_year: number;
  reason: string | null;
  status: 'active' | 'completed' | 'cancelled';
  notes: string | null;
  added_by: string | null;
  created_at?: string;
}

export interface AdvanceDistribution {
  id: string;
  advance_id: string;
  member_id: string;
  member_name: string;
  month: number;
  year: number;
  amount: number;
}

export interface AdvanceFormInput {
  member_id: string;
  member_name: string;
  amount: number;
  date_given: string;
  installments: number;
  start_month: number;
  start_year: number;
  reason: string;
  notes: string;
  added_by: string;
}

// ── Distribution schedule ────────────────────────────────────────────────────

/** Splits `amount` evenly across `installments` consecutive months starting
 *  at start_month/start_year. If the amount doesn't divide evenly, the
 *  remainder is absorbed into the LAST installment so the schedule always
 *  sums to exactly `amount`. */
export function generateDistributionSchedule(
  amount: number,
  installments: number,
  startMonth: number,
  startYear: number,
): Array<{ month: number; year: number; amount: number }> {
  const n = Math.max(1, Math.floor(installments) || 1);
  const base = Math.floor(amount / n);
  const schedule: Array<{ month: number; year: number; amount: number }> = [];
  let month = startMonth;
  let year = startYear;
  let allocated = 0;
  for (let i = 0; i < n; i++) {
    const isLast = i === n - 1;
    const amt = isLast ? (amount - allocated) : base;
    allocated += amt;
    schedule.push({ month, year, amount: amt });
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return schedule;
}

async function writeDistributions(advanceId: string, input: AdvanceFormInput): Promise<void> {
  const schedule = generateDistributionSchedule(input.amount, input.installments, input.start_month, input.start_year);
  const rows = schedule.map(s => ({
    advance_id: advanceId,
    member_id: input.member_id,
    member_name: input.member_name,
    month: s.month,
    year: s.year,
    amount: s.amount,
  }));
  const { error } = await supabase.from('advance_distributions').insert(rows);
  if (error) throw error;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function fetchAdvances(): Promise<Advance[]> {
  const { data, error } = await supabase.from('advances').select('*').order('date_given', { ascending: false });
  if (error) throw error;
  return (data as Advance[]) || [];
}

export async function fetchAdvanceDistributions(): Promise<AdvanceDistribution[]> {
  const { data, error } = await supabase.from('advance_distributions').select('*').order('year').order('month');
  if (error) throw error;
  return (data as AdvanceDistribution[]) || [];
}

/** Scoped to one payroll period, across all members — used by
 *  FinPayslips.tsx's loadAll() alongside team/adjustments/claims. */
export async function fetchAdvanceDistributionsForMonth(month: number, year: number): Promise<AdvanceDistribution[]> {
  const { data, error } = await supabase.from('advance_distributions').select('*').eq('month', month).eq('year', year);
  if (error) throw error;
  return (data as AdvanceDistribution[]) || [];
}

export async function createAdvance(input: AdvanceFormInput): Promise<Advance> {
  const { data, error } = await supabase.from('advances').insert({
    member_id: input.member_id,
    member_name: input.member_name,
    amount: input.amount,
    date_given: input.date_given || null,
    installments: input.installments,
    start_month: input.start_month,
    start_year: input.start_year,
    reason: input.reason.trim() || null,
    notes: input.notes.trim() || null,
    added_by: input.added_by || null,
  }).select('*').single();
  if (error) throw error;
  const advance = data as Advance;
  await writeDistributions(advance.id, input);
  return advance;
}

/** Updates the advance row and regenerates its distribution schedule from
 *  scratch (delete + reinsert) — simplest way to keep the schedule correct
 *  whenever amount/installments/start period change. */
export async function updateAdvance(id: string, input: AdvanceFormInput): Promise<void> {
  const { error } = await supabase.from('advances').update({
    member_id: input.member_id,
    member_name: input.member_name,
    amount: input.amount,
    date_given: input.date_given || null,
    installments: input.installments,
    start_month: input.start_month,
    start_year: input.start_year,
    reason: input.reason.trim() || null,
    notes: input.notes.trim() || null,
  }).eq('id', id);
  if (error) throw error;

  const { error: delErr } = await supabase.from('advance_distributions').delete().eq('advance_id', id);
  if (delErr) throw delErr;
  await writeDistributions(id, input);
}

/** advance_distributions rows cascade-delete via the FK's ON DELETE CASCADE. */
export async function deleteAdvance(id: string): Promise<void> {
  const { error } = await supabase.from('advances').delete().eq('id', id);
  if (error) throw error;
}

export async function setAdvanceStatus(id: string, status: Advance['status']): Promise<void> {
  const { error } = await supabase.from('advances').update({ status }).eq('id', id);
  if (error) throw error;
}

// ── Derived helpers ───────────────────────────────────────────────────────────

/** Sums every advance_distributions row for one member in one month/year.
 *  This is the payroll hook: FinPayslips.tsx calls it once team/advances/
 *  advance_distributions are all loaded, mirroring how buildTeamWithSalary
 *  already looks up salary_adjustments per member for that same period. */
export function getTotalAdvanceDeductionForMonth(
  memberId: string,
  month: number,
  year: number,
  _advances: Advance[],
  advDists: AdvanceDistribution[],
): number {
  return advDists
    .filter(d => d.member_id === memberId && d.month === month && d.year === year)
    .reduce((sum, d) => sum + (+d.amount || 0), 0);
}

/** How much of one advance has already been deducted, as of refMonth/refYear
 *  (inclusive) — used by the Advances page to show progress instead of a
 *  flat, unchanging total. */
export function getAdvanceDeductedSoFar(
  advanceId: string,
  advDists: AdvanceDistribution[],
  refMonth: number,
  refYear: number,
): number {
  return advDists
    .filter(d => d.advance_id === advanceId && (d.year < refYear || (d.year === refYear && d.month <= refMonth)))
    .reduce((sum, d) => sum + (+d.amount || 0), 0);
}
