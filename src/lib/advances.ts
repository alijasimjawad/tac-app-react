import { supabase } from './supabase';

// ── Model ────────────────────────────────────────────────────────────────────
//
// An admin/team leader gives ONE lump-sum cash advance to a "holder" team
// member (e.g. 150,000 IQD). The holder can then hand out portions of that
// lump sum to OTHER team members — each portion (an `AdvanceDistribution`)
// is deducted in FULL from the recipient's payslip for the advance's
// settlement_month/settlement_year. Whatever part of the lump sum the holder
// never redistributes ("leftover") is instead deducted from the HOLDER's own
// payslip for that same period. The leftover has no row of its own — it's
// always derived as amount − SUM(distributions for that advance).

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Advance {
  id: string;
  holder_member_id: string;
  holder_member_name: string;
  amount: number;
  date_given: string | null;
  settlement_month: number;
  settlement_year: number;
  reason: string | null;
  status: 'pending' | 'settled' | 'cancelled';
  notes: string | null;
  added_by: string | null;
  created_at?: string;
}

export interface AdvanceDistribution {
  id: string;
  advance_id: string;
  recipient_member_id: string;
  recipient_member_name: string;
  amount: number;
  notes: string | null;
  created_at?: string;
}

export interface AdvanceFormInput {
  holder_member_id: string;
  holder_member_name: string;
  amount: number;
  date_given: string;
  settlement_month: number;
  settlement_year: number;
  reason: string;
  notes: string;
  added_by: string;
}

// ── CRUD: advances ───────────────────────────────────────────────────────────

export async function fetchAdvances(): Promise<Advance[]> {
  const { data, error } = await supabase.from('advances').select('*').order('date_given', { ascending: false });
  if (error) throw error;
  return (data as Advance[]) || [];
}

export async function createAdvance(input: AdvanceFormInput): Promise<Advance> {
  const { data, error } = await supabase.from('advances').insert({
    holder_member_id: input.holder_member_id,
    holder_member_name: input.holder_member_name,
    amount: input.amount,
    date_given: input.date_given || null,
    settlement_month: input.settlement_month,
    settlement_year: input.settlement_year,
    reason: input.reason.trim() || null,
    notes: input.notes.trim() || null,
    added_by: input.added_by || null,
  }).select('*').single();
  if (error) throw error;
  return data as Advance;
}

/** Distributions are NOT touched here — editing the lump sum, holder, or
 *  settlement period doesn't change portions already handed out; the
 *  holder's leftover simply recomputes against the new amount/period. */
export async function updateAdvance(id: string, input: AdvanceFormInput): Promise<void> {
  const { error } = await supabase.from('advances').update({
    holder_member_id: input.holder_member_id,
    holder_member_name: input.holder_member_name,
    amount: input.amount,
    date_given: input.date_given || null,
    settlement_month: input.settlement_month,
    settlement_year: input.settlement_year,
    reason: input.reason.trim() || null,
    notes: input.notes.trim() || null,
  }).eq('id', id);
  if (error) throw error;
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

// ── CRUD: distributions (holder → teammate) ─────────────────────────────────

export async function fetchAdvanceDistributions(): Promise<AdvanceDistribution[]> {
  const { data, error } = await supabase.from('advance_distributions').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return (data as AdvanceDistribution[]) || [];
}

/** Called from the holder's My Advances page. Caller is responsible for
 *  capping `amount` at the holder's current leftover (see
 *  getHolderLeftover) — this function does not re-fetch to verify, so the
 *  caller should pass an up-to-date `distributions` array (from the same
 *  load) into getHolderLeftover right before calling this. */
export async function distributeAdvance(
  advanceId: string,
  recipientMemberId: string,
  recipientMemberName: string,
  amount: number,
  notes: string,
): Promise<AdvanceDistribution> {
  if (!(amount > 0)) throw new Error('Amount must be greater than zero.');
  const { data, error } = await supabase.from('advance_distributions').insert({
    advance_id: advanceId,
    recipient_member_id: recipientMemberId,
    recipient_member_name: recipientMemberName,
    amount,
    notes: notes.trim() || null,
  }).select('*').single();
  if (error) throw error;
  return data as AdvanceDistribution;
}

/** Lets a holder undo a distribution they made by mistake — the amount
 *  reverts to their leftover automatically since leftover is derived. */
export async function deleteDistribution(id: string): Promise<void> {
  const { error } = await supabase.from('advance_distributions').delete().eq('id', id);
  if (error) throw error;
}

// ── Derived helpers ───────────────────────────────────────────────────────────

export function getDistributedTotal(advanceId: string, distributions: AdvanceDistribution[]): number {
  return distributions
    .filter(d => d.advance_id === advanceId)
    .reduce((sum, d) => sum + (+d.amount || 0), 0);
}

/** The portion of the lump sum the holder hasn't handed out to anyone —
 *  this is what gets deducted from the HOLDER's own payslip. */
export function getHolderLeftover(advance: Advance, distributions: AdvanceDistribution[]): number {
  const leftover = advance.amount - getDistributedTotal(advance.id, distributions);
  return leftover > 0 ? leftover : 0;
}

/** The payroll hook: FinPayslips.tsx calls this once advances + distributions
 *  are loaded, mirroring how buildTeamWithSalary already looks up
 *  salary_adjustments per member for that same period. Combines two sources
 *  landing on the same payslip:
 *    (a) if `memberId` is the HOLDER of an advance settling this month/year —
 *        their undistributed leftover on that advance;
 *    (b) any portions `memberId` RECEIVED from advances settling this
 *        month/year (as a distribution recipient). */
export function getTotalAdvanceDeductionForMember(
  memberId: string,
  month: number,
  year: number,
  advances: Advance[],
  distributions: AdvanceDistribution[],
): number {
  let total = 0;
  for (const adv of advances) {
    if (adv.status === 'cancelled') continue;
    if (adv.settlement_month !== month || adv.settlement_year !== year) continue;

    if (adv.holder_member_id === memberId) {
      total += getHolderLeftover(adv, distributions);
    }

    total += distributions
      .filter(d => d.advance_id === adv.id && d.recipient_member_id === memberId)
      .reduce((sum, d) => sum + (+d.amount || 0), 0);
  }
  return total;
}
