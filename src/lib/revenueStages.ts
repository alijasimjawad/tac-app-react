// Shared "Current Revenue" (percentage-of-completion) logic — used by
// FinRevenue.tsx (the Revenue table itself) and FinReport.tsx (the Monthly
// Report), so both pages recognize revenue the same way: staged as each
// site progresses through the network rollout pipeline, not just the raw
// invoiced amount.
import { supabase } from './supabase';
import { isAtpAccepted, findAtpColIdx, PROJ_NAMES } from '../pages/NetworkScopes';
import { ensureSectionsLoaded, getSections } from './sectionsCache';

export const CLEARANCE_COL_NAME = 'Clearance & Tools';
export const FINAL_ATP_COL_NAME = 'Final ATP';

const STAGE_WEIGHTS = {
  delivery: 0.15,
  installation: 0.50,
  integration: 0.10,
  atp: 0.10,
  clearance: 0.05,
  finalAtp: 0.10,
} as const;

export interface StageDone {
  delivery: boolean;
  installation: boolean;
  integration: boolean;
  atp: boolean;
  clearance: boolean;
  finalAtp: boolean;
  /** Raw text of the site's Final ATP cell (e.g. "Accepted", "Rejected", "Pending"),
   *  used to drive live status displays from Network Scopes. */
  finalAtpStatus: string;
}

// Fixed pipeline order. A site can't reach a later stage without having
// already passed through every earlier one, so if a later stage is marked
// done, every earlier stage is treated as done too — even if its own column
// is still blank (e.g. someone updates Integration but never went back to
// fill in the Delivery/Installation cells for that site).
export type StageKey = 'delivery' | 'installation' | 'integration' | 'atp' | 'clearance' | 'finalAtp';
export const STAGE_ORDER: StageKey[] = ['delivery', 'installation', 'integration', 'atp', 'clearance', 'finalAtp'];

export const STAGE_LABELS: Record<StageKey, string> = {
  delivery: 'Delivery',
  installation: 'Installation',
  integration: 'Integration',
  atp: 'ATP',
  clearance: 'Clearance & Tools',
  finalAtp: 'Final ATP',
};

export function findDeliveryColIdx(headers: string[]): number {
  return headers.findIndex(h => /delivery/i.test(h));
}
export function findInstallColIdx(headers: string[]): number {
  return headers.findIndex(h => /^install(ation)?$/i.test(h.trim()) || /install.*date/i.test(h));
}
export function findIntegrationColIdx(headers: string[]): number {
  return headers.findIndex(h => /status.*integrat/i.test(h) || /integrat.*status/i.test(h));
}
export function findClearanceColIdx(headers: string[]): number {
  return headers.findIndex(h => h.trim().toLowerCase() === CLEARANCE_COL_NAME.toLowerCase());
}
export function findFinalAtpColIdx(headers: string[]): number {
  return headers.findIndex(h => h.trim().toLowerCase() === FINAL_ATP_COL_NAME.toLowerCase());
}

export function cascadeStages(sd: StageDone): StageDone {
  let lastDoneIdx = -1;
  STAGE_ORDER.forEach((key, i) => { if (sd[key]) lastDoneIdx = i; });
  const result = { ...sd };
  STAGE_ORDER.forEach((key, i) => { if (i <= lastDoneIdx) result[key] = true; });
  return result;
}

/** Reads the 6 pipeline stages for one site row against its section's headers. */
export function readStageDone(headers: string[], cells: string[]): StageDone {
  const cell = (idx: number) => (idx >= 0 ? (cells[idx] ?? '').trim() : '');
  const deliveryIdx = findDeliveryColIdx(headers);
  const installIdx = findInstallColIdx(headers);
  const integrationIdx = findIntegrationColIdx(headers);
  const atpIdx = findAtpColIdx(headers);
  const clearanceIdx = findClearanceColIdx(headers);
  const finalAtpIdx = findFinalAtpColIdx(headers);
  const raw: StageDone = {
    delivery: !!cell(deliveryIdx),
    installation: !!cell(installIdx),
    integration: /^integrated$/i.test(cell(integrationIdx)),
    atp: isAtpAccepted(cell(atpIdx)),
    clearance: !!cell(clearanceIdx),
    finalAtp: isAtpAccepted(cell(finalAtpIdx)),
    finalAtpStatus: cell(finalAtpIdx),
  };
  return cascadeStages(raw);
}

/** Weighted completion fraction (0..1) from a StageDone snapshot. */
export function stagePct(sd: StageDone | undefined): number {
  if (!sd) return 0;
  let pct = 0;
  if (sd.delivery) pct += STAGE_WEIGHTS.delivery;
  if (sd.installation) pct += STAGE_WEIGHTS.installation;
  if (sd.integration) pct += STAGE_WEIGHTS.integration;
  if (sd.atp) pct += STAGE_WEIGHTS.atp;
  if (sd.clearance) pct += STAGE_WEIGHTS.clearance;
  if (sd.finalAtp) pct += STAGE_WEIGHTS.finalAtp;
  return pct;
}

/** The first pipeline stage that isn't done yet — i.e. what's blocking a site
 *  from being fully revenued. Returns null once every stage is complete. */
export function stuckAtLabel(sd: StageDone | undefined): string | null {
  if (!sd) return STAGE_LABELS[STAGE_ORDER[0]];
  for (const key of STAGE_ORDER) {
    if (!sd[key]) return STAGE_LABELS[key];
  }
  return null;
}

/** Builds the project|||site_id -> StageDone lookup from live Network Scopes data. */
export async function loadStageMap(): Promise<Record<string, StageDone>> {
  await ensureSectionsLoaded();
  const allSecs = getSections().filter(s => !s.is_deleted);
  const secIds = allSecs.map(s => s.id).filter(Boolean);
  if (!secIds.length) return {};
  const { data: allRows } = await supabase.from('rows').select('section_id, data').in('section_id', secIds);
  const bySec: Record<string, { data: Record<string, unknown> }[]> = {};
  for (const row of (allRows || []) as { section_id: string; data: Record<string, unknown> }[]) {
    (bySec[row.section_id] ??= []).push(row);
  }
  const map: Record<string, StageDone> = {};
  for (const sec of allSecs) {
    const projName = PROJ_NAMES[sec.project_name as keyof typeof PROJ_NAMES] || sec.project_name;
    if (!projName) continue;
    const headers: string[] = sec.columns || [];
    const siteCol = headers.find(h => /^site.{0,3}id$/i.test(h)) || headers[0] || '';
    if (!siteCol) continue;
    for (const row of bySec[sec.id] || []) {
      const siteId = String(row.data[siteCol] || '').trim();
      if (!siteId) continue;
      const cells = headers.map(h => String(row.data[h] ?? ''));
      map[`${projName}|||${siteId}`] = readStageDone(headers, cells);
    }
  }
  return map;
}

/** Recognized ("earned") revenue for one invoiced amount, given its site's stage completion. */
export function currentRevenueFor(amount: number | null | undefined, sd: StageDone | undefined): number {
  return (+(amount ?? 0) || 0) * stagePct(sd);
}
