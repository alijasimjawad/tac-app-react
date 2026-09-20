// ── Customer SMR Receiving — pure (DOM-free) logic ─────────────────────────────
//
// Manages line-status computation, PN→item matching, scan aggregation, and
// receipt-payload building for the SMR reconcile workflow. All DB I/O and React
// state live in WarehouseSmr.tsx / WarehouseSmrReconcile.tsx; this module
// contains only pure logic so it can be unit tested without Supabase.
//
// Reuses normalizePn() from pnMapping.ts rather than duplicating PN-normalization
// logic — the same canonical UPPER(TRIM(...)) form is used everywhere PNs are
// compared or stored as map keys.

import { normalizePn } from './pnMapping';

export type SmrLineStatus = 'PENDING' | 'PARTIAL' | 'RECEIVED' | 'NOT_RECEIVED';
export type SmrMatchConfidence = 'EXACT' | 'LEARNED' | 'MANUAL' | 'UNMATCHED';

/** Tolerance for floating point comparisons of fractional quantities (e.g. 0.5, 0.3 on the SMR). */
const QTY_EPSILON = 1e-6;

// ── Line status ─────────────────────────────────────────────────────────────

/**
 * Derives a line's status from expected vs. received quantity.
 *   - markedNotReceived + nothing received  → NOT_RECEIVED (explicit user call)
 *   - nothing received yet                  → PENDING (not yet touched)
 *   - some but less than expected           → PARTIAL
 *   - meets or exceeds expected              → RECEIVED
 */
export function computeSmrLineStatus(
  expectedQty:       number,
  receivedQty:       number,
  markedNotReceived: boolean,
): SmrLineStatus {
  if (receivedQty <= QTY_EPSILON) {
    return markedNotReceived ? 'NOT_RECEIVED' : 'PENDING';
  }
  if (receivedQty + QTY_EPSILON >= expectedQty) return 'RECEIVED';
  return 'PARTIAL';
}

export interface SmrLineStatusSummary {
  total:       number;
  received:    number;
  partial:     number;
  notReceived: number;
  pending:     number;
}

/** Aggregate counts by status — drives the reconcile page's progress header. */
export function summarizeSmrLineStatuses(lines: Array<{ status: SmrLineStatus }>): SmrLineStatusSummary {
  const summary: SmrLineStatusSummary = { total: lines.length, received: 0, partial: 0, notReceived: 0, pending: 0 };
  for (const l of lines) {
    if (l.status === 'RECEIVED')      summary.received++;
    else if (l.status === 'PARTIAL')  summary.partial++;
    else if (l.status === 'NOT_RECEIVED') summary.notReceived++;
    else summary.pending++;
  }
  return summary;
}

/** True once every line has been explicitly resolved (no line left PENDING). */
export function isSmrReconciliationComplete(lines: Array<{ status: SmrLineStatus }>): boolean {
  return lines.length > 0 && lines.every(l => l.status !== 'PENDING');
}

// ── PN → item matching ────────────────────────────────────────────────────────

export interface MatchedItemRef {
  itemId:   string;
  itemCode: string;
  itemName: string;
}

export interface PnMatchResult {
  itemId:     string | null;
  itemCode:   string | null;
  itemName:   string | null;
  confidence: SmrMatchConfidence;
}

/**
 * Resolves a raw PN from the SMR PDF to an inventory item.
 *   1. Exact match against inventory_items.part_number → 'EXACT'.
 *   2. Fallback to a previously learned item_code_mappings entry → 'LEARNED'.
 *   3. No match → 'UNMATCHED' (user must resolve manually in the review step,
 *      which then carries confidence 'MANUAL' set directly by the caller).
 * Both maps must be keyed by normalizePn() form.
 */
export function matchPnToItem(
  pnRaw:       string | null,
  exactByPn:   Map<string, MatchedItemRef>,
  learnedByPn: Map<string, MatchedItemRef>,
): PnMatchResult {
  if (!pnRaw || !pnRaw.trim()) {
    return { itemId: null, itemCode: null, itemName: null, confidence: 'UNMATCHED' };
  }
  const key = normalizePn(pnRaw);

  const exact = exactByPn.get(key);
  if (exact) return { itemId: exact.itemId, itemCode: exact.itemCode, itemName: exact.itemName, confidence: 'EXACT' };

  const learned = learnedByPn.get(key);
  if (learned) return { itemId: learned.itemId, itemCode: learned.itemCode, itemName: learned.itemName, confidence: 'LEARNED' };

  return { itemId: null, itemCode: null, itemName: null, confidence: 'UNMATCHED' };
}

// ── Scan aggregation (SERIALIZED lines) ───────────────────────────────────────

export interface NormalizedScan {
  serialNumberNormalized: string;
}

/** Count of distinct serials scanned against a line — this becomes its received_qty. */
export function countUniqueScans(scans: NormalizedScan[]): number {
  return new Set(scans.map(s => s.serialNumberNormalized)).size;
}

/** True if this normalized serial has already been scanned against the line (reject as duplicate). */
export function isDuplicateScanForLine(existingScans: NormalizedScan[], normalizedSerial: string): boolean {
  return existingScans.some(s => s.serialNumberNormalized === normalizedSerial);
}

// ── Quantity → receipt conversion ─────────────────────────────────────────────
//
// goods_receipt_items.quantity is an integer column (migration 001), but SMR
// expected/received quantities are numeric because the source PDF can show
// fractional "Accepted Qty" values (cost-sharing allocations, e.g. 0.5, 0.3).
// The SMR tables keep the raw numeric value for audit; only at receipt-build
// time is it rounded to a postable integer unit count.

export function hasFractionalQuantity(qty: number): boolean {
  return Math.abs(qty - Math.round(qty)) > QTY_EPSILON;
}

export function toIntegerReceiptQuantity(qty: number): number {
  return Math.max(0, Math.round(qty));
}

export interface SmrLineForReceipt {
  matchedItemId: string | null;
  receivedQty:   number;
  partNumberRaw: string | null;
}

export interface ReceiptItemEntry {
  inventory_item_id: string;
  quantity:           number;
  part_number:        string | null;
}

/**
 * Builds the goods_receipt_items payload from reconciled SMR lines:
 *   - skips unmatched lines and lines with nothing received,
 *   - rounds each line's numeric receivedQty to a postable integer,
 *   - aggregates multiple SMR lines that resolved to the same inventory item.
 */
export function buildReceiptItemsFromSmrLines(lines: SmrLineForReceipt[]): ReceiptItemEntry[] {
  const byItem = new Map<string, ReceiptItemEntry>();

  for (const l of lines) {
    if (!l.matchedItemId) continue;
    const qty = toIntegerReceiptQuantity(l.receivedQty);
    if (qty <= 0) continue;

    const existing = byItem.get(l.matchedItemId);
    if (existing) {
      existing.quantity += qty;
    } else {
      byItem.set(l.matchedItemId, {
        inventory_item_id: l.matchedItemId,
        quantity:           qty,
        part_number:        l.partNumberRaw,
      });
    }
  }

  return Array.from(byItem.values());
}
