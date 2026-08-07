// ── CartonScanBuffer — pure (DOM-free) bidirectional logic ─────────────────────
//
// Nokia carton labels carry PN and SN in separate linear barcodes in addition
// to the DataMatrix that encodes both. Either barcode may be decoded first —
// the camera has no control over which ZXing resolves first. This module
// provides the pure logic for aggregating them into one pending carton slot
// regardless of arrival order.
//
// None of these functions touch the DOM, React state, or timers — all
// side-effectful coordination lives in WarehouseReceive.tsx.

export const CARTON_WINDOW_MS = 2000; // ms — empirically safe for rapid scanning

export interface PendingCarton {
  readonly localId:      string;   // stable UUID pre-assigned for the eventual ScanEntry
  readonly manufacturer: 'Nokia';
  partNumber:   string | null;     // set when PN barcode arrives (may be null if SN-first)
  serialNumber: string | null;     // set when SN barcode arrives (may be null if PN-first)
  readonly firstSeenAt: number;
  lastSeenAt:   number;            // updated on each component scan
  readonly expiresAt:   number;    // absolute ms: firstSeenAt + CARTON_WINDOW_MS
}

/** Create a pending carton from whichever component barcode arrived first. */
export function createPendingCarton(
  fields:  { partNumber?: string | null; serialNumber?: string | null },
  localId: string,
  now = Date.now(),
): PendingCarton {
  return {
    localId,
    manufacturer: 'Nokia',
    partNumber:   fields.partNumber   ?? null,
    serialNumber: fields.serialNumber ?? null,
    firstSeenAt:  now,
    lastSeenAt:   now,
    expiresAt:    now + CARTON_WINDOW_MS,
  };
}

/** True once both PN and SN are present — carton is ready to finalize. */
export function isCartonComplete(
  p: PendingCarton,
): p is PendingCarton & { partNumber: string; serialNumber: string } {
  return p.partNumber !== null && p.serialNumber !== null;
}

/** Whether the aggregation window has expired. */
export function isPendingExpired(p: PendingCarton, now = Date.now()): boolean {
  return now >= p.expiresAt;
}

// Whether an incoming PN is compatible with the pending carton's PN.
//   pendingPn null   → SN-first carton; any incoming PN is accepted
//   incomingPn null  → SN-only barcode; no PN to compare; always compatible
//   both non-null    → must match (case-insensitive) to prevent cross-carton pairing
export function isPnCompatible(pendingPn: string | null, incomingPn: string | null): boolean {
  if (pendingPn === null || incomingPn === null) return true;
  return incomingPn.toUpperCase() === pendingPn.toUpperCase();
}

// Whether an incoming SN is compatible with the pending carton's SN.
//   pendingSN null   → PN-first carton; any incoming SN is accepted
//   incomingSN null  → PN-only barcode; no SN to pair; returns false
//   both non-null    → must match (case-insensitive)
export function isSnCompatible(pendingSN: string | null, incomingSN: string | null): boolean {
  if (pendingSN === null) return true;
  if (incomingSN === null) return false;
  return incomingSN.toUpperCase() === pendingSN.toUpperCase();
}
