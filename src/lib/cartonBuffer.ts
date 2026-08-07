// ── CartonScanBuffer — pure (DOM-free) logic ──────────────────────────────────
//
// Nokia carton labels carry PN and SN in separate linear barcodes in addition
// to the DataMatrix that encodes both. When the camera decodes the individual
// linear barcodes instead of the DataMatrix, they arrive as two separate scan
// events. This module provides the pure logic for aggregating them into one
// pending carton slot before a ScanEntry is committed.
//
// None of these functions touch the DOM, React state, or timers — all
// side-effectful coordination lives in WarehouseReceive.tsx.

export const CARTON_WINDOW_MS = 2000; // ms — empirically safe for rapid scanning

export interface PendingCarton {
  readonly localId:    string;  // stable UUID pre-assigned for the eventual ScanEntry
  readonly partNumber: string;  // Nokia PN, DI-stripped (e.g. '474800A.102')
  readonly expiresAt:  number;  // absolute ms timestamp: Date.now() + CARTON_WINDOW_MS
}

/** Create a pending carton slot for a Nokia PN barcode component. */
export function createPendingCarton(
  partNumber: string,
  localId: string,
  now = Date.now(),
): PendingCarton {
  return { localId, partNumber, expiresAt: now + CARTON_WINDOW_MS };
}

/** Whether the aggregation window has expired (SN took too long to arrive). */
export function isPendingExpired(p: PendingCarton, now = Date.now()): boolean {
  return now >= p.expiresAt;
}

// Whether an incoming PN from the SN barcode scan is compatible with the
// pending carton's PN.
//   null  → SN-only barcode (no PN context) — always compatible
//   match → same carton confirmed from both barcodes — compatible
//   diff  → different carton — incompatible, do not cross-pair
export function isPnCompatible(pendingPn: string, incomingPn: string | null): boolean {
  if (incomingPn === null) return true;
  return incomingPn.toUpperCase() === pendingPn.toUpperCase();
}
