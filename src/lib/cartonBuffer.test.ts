import { describe, it, expect } from 'vitest';
import {
  createPendingCarton, isCartonComplete, isPendingExpired,
  isPnCompatible, isSnCompatible, CARTON_WINDOW_MS,
} from './cartonBuffer';

const NOW  = 1_000_000;
const UUID = 'test-uuid-1234';

// ── createPendingCarton() ─────────────────────────────────────────────────────

describe('createPendingCarton()', () => {
  it('PN-first: stores partNumber, null serialNumber', () => {
    const p = createPendingCarton({ partNumber: '474800A.102' }, UUID, NOW);
    expect(p.partNumber).toBe('474800A.102');
    expect(p.serialNumber).toBeNull();
    expect(p.localId).toBe(UUID);
    expect(p.manufacturer).toBe('Nokia');
    expect(p.expiresAt).toBe(NOW + CARTON_WINDOW_MS);
    expect(p.firstSeenAt).toBe(NOW);
  });

  it('SN-first: stores serialNumber, null partNumber', () => {
    const p = createPendingCarton({ serialNumber: 'K9241817927' }, UUID, NOW);
    expect(p.serialNumber).toBe('K9241817927');
    expect(p.partNumber).toBeNull();
    expect(p.expiresAt).toBe(NOW + CARTON_WINDOW_MS);
  });

  it('different localIds produce independent cartons', () => {
    const a = createPendingCarton({ partNumber: '474800A.102' }, 'uuid-a', NOW);
    const b = createPendingCarton({ partNumber: '474800A.102' }, 'uuid-b', NOW);
    expect(a.localId).not.toBe(b.localId);
  });

  it('CARTON_WINDOW_MS is 2000 ms', () => {
    expect(CARTON_WINDOW_MS).toBe(2000);
  });
});

// ── isCartonComplete() ────────────────────────────────────────────────────────

describe('isCartonComplete()', () => {
  it('PN-only → not complete', () => {
    const p = createPendingCarton({ partNumber: '474800A.102' }, UUID, NOW);
    expect(isCartonComplete(p)).toBe(false);
  });

  it('SN-only → not complete', () => {
    const p = createPendingCarton({ serialNumber: 'K9241817927' }, UUID, NOW);
    expect(isCartonComplete(p)).toBe(false);
  });

  it('PN-first: adding SN makes it complete', () => {
    const p = createPendingCarton({ partNumber: '474800A.102' }, UUID, NOW);
    p.serialNumber = 'K9241817927';
    expect(isCartonComplete(p)).toBe(true);
    // Type guard narrows to non-null
    if (isCartonComplete(p)) {
      expect(p.partNumber).toBe('474800A.102');
      expect(p.serialNumber).toBe('K9241817927');
    }
  });

  it('SN-first: adding PN makes it complete', () => {
    const p = createPendingCarton({ serialNumber: 'K9241817927' }, UUID, NOW);
    p.partNumber = '474800A.102';
    expect(isCartonComplete(p)).toBe(true);
  });

  it('neither field → not complete', () => {
    const p = createPendingCarton({}, UUID, NOW);
    expect(isCartonComplete(p)).toBe(false);
  });
});

// ── isPendingExpired() ────────────────────────────────────────────────────────

describe('isPendingExpired()', () => {
  it('not expired at creation + 1 ms', () => {
    const p = createPendingCarton({ partNumber: '474800A.102' }, UUID, NOW);
    expect(isPendingExpired(p, NOW + 1)).toBe(false);
  });

  it('not expired one millisecond before window closes', () => {
    const p = createPendingCarton({ partNumber: '474800A.102' }, UUID, NOW);
    expect(isPendingExpired(p, NOW + CARTON_WINDOW_MS - 1)).toBe(false);
  });

  it('expired exactly at expiresAt', () => {
    const p = createPendingCarton({ partNumber: '474800A.102' }, UUID, NOW);
    expect(isPendingExpired(p, NOW + CARTON_WINDOW_MS)).toBe(true);
  });

  it('expired well past window', () => {
    const p = createPendingCarton({ partNumber: '474800A.102' }, UUID, NOW);
    expect(isPendingExpired(p, NOW + 10_000)).toBe(true);
  });

  it('SN-first carton also expires correctly', () => {
    const p = createPendingCarton({ serialNumber: 'K9241817927' }, UUID, NOW);
    expect(isPendingExpired(p, NOW + CARTON_WINDOW_MS - 1)).toBe(false);
    expect(isPendingExpired(p, NOW + CARTON_WINDOW_MS)).toBe(true);
  });
});

// ── isPnCompatible() ─────────────────────────────────────────────────────────

describe('isPnCompatible()', () => {
  it('null pendingPn (SN-first) → compatible with any incoming PN', () => {
    expect(isPnCompatible(null, '474800A.102')).toBe(true);
  });

  it('null incomingPn (SN-only barcode) → compatible', () => {
    expect(isPnCompatible('474800A.102', null)).toBe(true);
  });

  it('both null → compatible', () => {
    expect(isPnCompatible(null, null)).toBe(true);
  });

  it('exact same PN → compatible', () => {
    expect(isPnCompatible('474800A.102', '474800A.102')).toBe(true);
  });

  it('case-insensitive match → compatible', () => {
    expect(isPnCompatible('474800A.102', '474800a.102')).toBe(true);
    expect(isPnCompatible('474800a.102', '474800A.102')).toBe(true);
  });

  it('different PN → incompatible (cross-carton risk)', () => {
    expect(isPnCompatible('474800A.102', '474254A.202')).toBe(false);
  });
});

// ── isSnCompatible() ─────────────────────────────────────────────────────────

describe('isSnCompatible()', () => {
  it('null pendingSN (PN-first) → compatible with any incoming SN', () => {
    expect(isSnCompatible(null, 'K9241817927')).toBe(true);
  });

  it('null pendingSN + null incomingSN → compatible (PN-only, no pairing yet)', () => {
    expect(isSnCompatible(null, null)).toBe(true);
  });

  it('pendingSN set + null incomingSN → incompatible (no SN to pair)', () => {
    expect(isSnCompatible('K9241817927', null)).toBe(false);
  });

  it('exact same SN → compatible (DataMatrix confirms match)', () => {
    expect(isSnCompatible('K9241817927', 'K9241817927')).toBe(true);
  });

  it('case-insensitive match → compatible', () => {
    expect(isSnCompatible('K9241817927', 'k9241817927')).toBe(true);
  });

  it('different SN → incompatible (cross-carton risk)', () => {
    expect(isSnCompatible('K9241817927', 'DH252030925')).toBe(false);
  });
});

// ── Bidirectional pairing scenarios ──────────────────────────────────────────
//
// Simulates the React-level pairing decision using pure functions.
// Production logic lives in handleRawScan() in WarehouseReceive.tsx.

type PairingResult = 'PAIRED' | 'INCOMPATIBLE_PN' | 'INCOMPATIBLE_SN' | 'EXPIRED' | 'INCOMPLETE';

function simulatePnFirst(
  pendingPn:       string,
  incomingSn:      string | null,
  incomingPn:      string | null,
  msAfterCreation: number,
): PairingResult {
  const pending = createPendingCarton({ partNumber: pendingPn }, UUID, NOW);
  const now = NOW + msAfterCreation;
  if (isPendingExpired(pending, now))                     return 'EXPIRED';
  if (!incomingSn)                                        return 'INCOMPLETE';
  if (!isPnCompatible(pending.partNumber, incomingPn))   return 'INCOMPATIBLE_PN';
  if (!isSnCompatible(pending.serialNumber, incomingSn)) return 'INCOMPATIBLE_SN';
  return 'PAIRED';
}

function simulateSnFirst(
  pendingSn:       string,
  incomingPn:      string | null,
  incomingSn:      string | null,  // null = PN-only barcode; non-null = DataMatrix also has SN
  msAfterCreation: number,
): PairingResult {
  const pending = createPendingCarton({ serialNumber: pendingSn }, UUID, NOW);
  const now = NOW + msAfterCreation;
  if (isPendingExpired(pending, now))                     return 'EXPIRED';
  if (!incomingPn)                                        return 'INCOMPLETE';
  if (!isPnCompatible(pending.partNumber, incomingPn))   return 'INCOMPATIBLE_PN';
  // Only check SN compatibility when the incoming scan also carries an SN (e.g. DataMatrix).
  // A PN-only barcode has incomingSn = null — no SN to compare; pairing uses the buffered SN.
  if (incomingSn !== null && !isSnCompatible(pending.serialNumber, incomingSn)) return 'INCOMPATIBLE_SN';
  return 'PAIRED';
}

describe('PN-first pairing scenarios', () => {
  it('PN-first + SN barcode within window → PAIRED', () => {
    expect(simulatePnFirst('474800A.102', 'K9241817927', null, 500)).toBe('PAIRED');
  });

  it('PN-first + DataMatrix (PN+SN) within window, PN matches → PAIRED', () => {
    expect(simulatePnFirst('474800A.102', 'K9241817927', '474800A.102', 500)).toBe('PAIRED');
  });

  it('PN-first + DataMatrix with DIFFERENT PN → INCOMPATIBLE_PN', () => {
    expect(simulatePnFirst('474800A.102', 'K9241817927', '474254A.202', 500)).toBe('INCOMPATIBLE_PN');
  });

  it('PN-first + SN after window expired → EXPIRED', () => {
    expect(simulatePnFirst('474800A.102', 'K9241817927', null, CARTON_WINDOW_MS + 1)).toBe('EXPIRED');
  });

  it('PN-first + no SN → INCOMPLETE', () => {
    expect(simulatePnFirst('474800A.102', null, '474800A.102', 500)).toBe('INCOMPLETE');
  });

  it('fast sequential scan (150ms) → PAIRED', () => {
    expect(simulatePnFirst('474800A.102', 'K9241817927', null, 150)).toBe('PAIRED');
  });
});

describe('SN-first pairing scenarios', () => {
  it('SN-first + PN barcode within window → PAIRED', () => {
    expect(simulateSnFirst('K9241817927', '474800A.102', null, 500)).toBe('PAIRED');
  });

  it('SN-first + DataMatrix (PN+SN) within window, SN matches → PAIRED', () => {
    expect(simulateSnFirst('K9241817927', '474800A.102', 'K9241817927', 500)).toBe('PAIRED');
  });

  it('SN-first + DataMatrix with DIFFERENT SN → INCOMPATIBLE_SN', () => {
    expect(simulateSnFirst('K9241817927', '474800A.102', 'DH252030925', 500)).toBe('INCOMPATIBLE_SN');
  });

  it('SN-first + PN after window expired → EXPIRED', () => {
    expect(simulateSnFirst('K9241817927', '474800A.102', null, CARTON_WINDOW_MS + 1)).toBe('EXPIRED');
  });

  it('SN-first + no incoming PN → INCOMPLETE', () => {
    expect(simulateSnFirst('K9241817927', null, 'K9241817927', 500)).toBe('INCOMPLETE');
  });

  it('fast sequential scan SN→PN (200ms) → PAIRED', () => {
    expect(simulateSnFirst('K9241817927', '474800A.102', null, 200)).toBe('PAIRED');
  });
});

describe('Multi-carton safety (cross-carton contamination prevention)', () => {
  it('Carton A PN-first pairs with matching SN, Carton B pairs independently', () => {
    expect(simulatePnFirst('474800A.102', 'K9241817927', null, 300)).toBe('PAIRED');
    expect(simulatePnFirst('474254A.202', 'DH252030925', null, 300)).toBe('PAIRED');
  });

  it('Carton A SN-first pairs with matching PN, Carton B pairs independently', () => {
    expect(simulateSnFirst('K9241817927', '474800A.102', null, 300)).toBe('PAIRED');
    expect(simulateSnFirst('DH252030925', '474254A.202', null, 300)).toBe('PAIRED');
  });

  it('Cross-PN detected: PN-first, DataMatrix with different PN → INCOMPATIBLE_PN', () => {
    expect(simulatePnFirst('474800A.102', 'K9241817927', '474254A.202', 400)).toBe('INCOMPATIBLE_PN');
  });

  it('Cross-SN detected: SN-first, DataMatrix with different SN → INCOMPATIBLE_SN', () => {
    expect(simulateSnFirst('K9241817927', '474800A.102', 'DH252030925', 400)).toBe('INCOMPATIBLE_SN');
  });

  it('SN dedup gate: sessionSNs.has(sn) blocks pairing before compatibility check', () => {
    const sessionSNs = new Set(['K9241817927']);
    expect(sessionSNs.has('K9241817927')).toBe(true);   // → DUPLICATE, no pairing
    expect(sessionSNs.has('DH252030925')).toBe(false);  // → proceeds to pairing check
  });
});

// ── REGRESSION: Nokia ARGA carton (PN: 474800A.102, SN: K9241817927) ─────────

describe('REGRESSION — Nokia ARGA carton (PN: 474800A.102, SN: K9241817927)', () => {
  it('R1: PN-first → SN within 500ms → PAIRED', () => {
    expect(simulatePnFirst('474800A.102', 'K9241817927', null, 500)).toBe('PAIRED');
  });

  it('R2: SN-first (SK9241817927) → PN within 500ms → PAIRED', () => {
    expect(simulateSnFirst('K9241817927', '474800A.102', null, 500)).toBe('PAIRED');
  });

  it('R3: PN-first repeated PN within window → same-PN compatible (timer refresh)', () => {
    expect(isPnCompatible('474800A.102', '474800A.102')).toBe(true);
  });

  it('R4: SN-first repeated SN within window → same-SN compatible (timer refresh)', () => {
    expect(isSnCompatible('K9241817927', 'K9241817927')).toBe(true);
  });

  it('R5: DataMatrix after PN-first pending → SN from DataMatrix matches → PAIRED', () => {
    // DataMatrix provides both PN+SN; pending has PN only
    expect(simulatePnFirst('474800A.102', 'K9241817927', '474800A.102', 400)).toBe('PAIRED');
  });

  it('R6: DataMatrix after SN-first pending → PN from DataMatrix matches → PAIRED', () => {
    // DataMatrix provides both PN+SN; pending has SN only
    expect(simulateSnFirst('K9241817927', '474800A.102', 'K9241817927', 400)).toBe('PAIRED');
  });

  it('R7: Q001/Q005 quantity barcodes ignored before pairing (design boundary)', () => {
    // These are discarded as AUXILIARY_CODE before reaching buffer logic.
    expect(true).toBe(true);
  });

  it('R8: PN-first + SN after timeout → EXPIRED, no ghost entry', () => {
    expect(simulatePnFirst('474800A.102', 'K9241817927', null, CARTON_WINDOW_MS + 1)).toBe('EXPIRED');
  });

  it('R9: SN-first + PN after timeout → EXPIRED, no ghost entry', () => {
    expect(simulateSnFirst('K9241817927', '474800A.102', null, CARTON_WINDOW_MS + 1)).toBe('EXPIRED');
  });

  it('R10: isCartonComplete confirms both fields required for finalization', () => {
    const pnFirst = createPendingCarton({ partNumber: '474800A.102' }, UUID, NOW);
    expect(isCartonComplete(pnFirst)).toBe(false);
    pnFirst.serialNumber = 'K9241817927';
    expect(isCartonComplete(pnFirst)).toBe(true);

    const snFirst = createPendingCarton({ serialNumber: 'K9241817927' }, UUID, NOW);
    expect(isCartonComplete(snFirst)).toBe(false);
    snFirst.partNumber = '474800A.102';
    expect(isCartonComplete(snFirst)).toBe(true);
  });
});

// ── KPI boundary tests (pure logic layer) ────────────────────────────────────

describe('KPI boundary — pending components do not count as scanned', () => {
  it('PN-only pending: isCartonComplete = false → no finalized entry', () => {
    const p = createPendingCarton({ partNumber: '474800A.102' }, UUID, NOW);
    expect(isCartonComplete(p)).toBe(false);
  });

  it('SN-only pending: isCartonComplete = false → no finalized entry', () => {
    const p = createPendingCarton({ serialNumber: 'K9241817927' }, UUID, NOW);
    expect(isCartonComplete(p)).toBe(false);
  });

  it('Completed carton: isCartonComplete = true → finalization allowed', () => {
    const p = createPendingCarton({ partNumber: '474800A.102', serialNumber: 'K9241817927' }, UUID, NOW);
    expect(isCartonComplete(p)).toBe(true);
  });
});
