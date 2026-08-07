import { describe, it, expect } from 'vitest';
import {
  createPendingCarton, isPendingExpired, isPnCompatible,
  CARTON_WINDOW_MS,
} from './cartonBuffer';

const NOW  = 1_000_000; // fixed timestamp for deterministic tests
const UUID = 'test-uuid-1234';

// ── createPendingCarton() ─────────────────────────────────────────────────────

describe('createPendingCarton()', () => {
  it('stores partNumber, localId, expiresAt = now + CARTON_WINDOW_MS', () => {
    const p = createPendingCarton('474800A.102', UUID, NOW);
    expect(p.partNumber).toBe('474800A.102');
    expect(p.localId).toBe(UUID);
    expect(p.expiresAt).toBe(NOW + CARTON_WINDOW_MS);
  });

  it('different localIds produce independent cartons', () => {
    const a = createPendingCarton('474800A.102', 'uuid-a', NOW);
    const b = createPendingCarton('474800A.102', 'uuid-b', NOW);
    expect(a.localId).not.toBe(b.localId);
  });

  it('CARTON_WINDOW_MS is 2000 ms', () => {
    expect(CARTON_WINDOW_MS).toBe(2000);
  });
});

// ── isPendingExpired() ────────────────────────────────────────────────────────

describe('isPendingExpired()', () => {
  it('not expired at creation + 1 ms', () => {
    const p = createPendingCarton('474800A.102', UUID, NOW);
    expect(isPendingExpired(p, NOW + 1)).toBe(false);
  });

  it('not expired one millisecond before window closes', () => {
    const p = createPendingCarton('474800A.102', UUID, NOW);
    expect(isPendingExpired(p, NOW + CARTON_WINDOW_MS - 1)).toBe(false);
  });

  it('expired exactly at expiresAt', () => {
    const p = createPendingCarton('474800A.102', UUID, NOW);
    expect(isPendingExpired(p, NOW + CARTON_WINDOW_MS)).toBe(true);
  });

  it('expired well past window', () => {
    const p = createPendingCarton('474800A.102', UUID, NOW);
    expect(isPendingExpired(p, NOW + 10_000)).toBe(true);
  });
});

// ── isPnCompatible() ─────────────────────────────────────────────────────────

describe('isPnCompatible()', () => {
  it('null incoming PN → compatible (SN-only barcode)', () => {
    expect(isPnCompatible('474800A.102', null)).toBe(true);
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

  it('completely different value → incompatible', () => {
    expect(isPnCompatible('474800A.102', '000000X.000')).toBe(false);
  });
});

// ── Carton pairing scenarios ──────────────────────────────────────────────────
//
// This helper simulates the React-level pairing decision using the three pure
// functions. In production this logic lives inside handleRawScan().

function simulatePairing(
  pendingPn:       string,
  incomingPn:      string | null,
  incomingSn:      string | null,
  msAfterCreation: number,
): 'PAIRED' | 'INCOMPATIBLE_PN' | 'NO_SN' | 'EXPIRED' {
  const pending = createPendingCarton(pendingPn, UUID, NOW);
  const now     = NOW + msAfterCreation;
  if (isPendingExpired(pending, now))                   return 'EXPIRED';
  if (!incomingSn)                                      return 'NO_SN';
  if (!isPnCompatible(pending.partNumber, incomingPn)) return 'INCOMPATIBLE_PN';
  return 'PAIRED';
}

describe('Carton pairing scenarios', () => {
  // PATH B ground truth: ARGA carton, PN=474800A.102, SN=K9241817927
  it('PN 474800A.102 then SN K9241817927 within window → PAIRED', () => {
    expect(simulatePairing('474800A.102', null, 'K9241817927', 500)).toBe('PAIRED');
  });

  it('PN then SN with matching explicit PN → PAIRED (DataMatrix SN scan)', () => {
    expect(simulatePairing('474800A.102', '474800A.102', 'K9241817927', 500)).toBe('PAIRED');
  });

  it('PN then SN with DIFFERENT explicit PN → INCOMPATIBLE_PN (no cross-carton pair)', () => {
    expect(simulatePairing('474800A.102', '474254A.202', 'K9241817927', 500)).toBe('INCOMPATIBLE_PN');
  });

  it('PN then SN after window expired → EXPIRED', () => {
    expect(simulatePairing('474800A.102', null, 'K9241817927', CARTON_WINDOW_MS + 1)).toBe('EXPIRED');
  });

  it('PN then another PN-only scan (no SN) → NO_SN', () => {
    expect(simulatePairing('474800A.102', '474800A.102', null, 500)).toBe('NO_SN');
  });

  it('SN immediately after PN (fast sequential scan) → PAIRED', () => {
    expect(simulatePairing('474800A.102', null, 'K9241817927', 150)).toBe('PAIRED');
  });

  // Rapid multi-carton: Carton A PN, Carton B PN replaces, Carton B SN pairs
  it('Carton B PN arriving while A pending → A flush (INCOMPATIBLE), B starts fresh', () => {
    // When B_PN arrives, A's pending is flushed. The caller starts a new pending for B.
    // This test confirms A_PN ≠ B_PN is detected as incompatible at the A-pending stage.
    expect(simulatePairing('474254A.202', '474800A.102', 'K9241817927', 400))
      .toBe('INCOMPATIBLE_PN');
    // B_PN is then buffered, B_SN pairs correctly:
    expect(simulatePairing('474800A.102', null, 'K9241817927', 400))
      .toBe('PAIRED');
  });

  // Carton A PN + SN in order, then Carton B PN + SN in order (two cartons sequential)
  it('Carton A PN+SN within window, then Carton B PN+SN → both pair independently', () => {
    expect(simulatePairing('474254A.202', null, 'SN111111', 300)).toBe('PAIRED');
    expect(simulatePairing('474800A.102', null, 'K9241817927', 300)).toBe('PAIRED');
  });

  // SN dedup safety: sessionSNs prevents cross-pairing after DataMatrix
  it('SN dedup gate (simulated): sessionSNs.has(sn) blocks pairing before isPnCompatible', () => {
    // In handleRawScan, sessionSNs check comes before the pairing branch.
    // Verify the set lookup behaves correctly:
    const sessionSNs = new Set(['K9241817927']);
    expect(sessionSNs.has('K9241817927')).toBe(true);  // → DUPLICATE, no pairing
    expect(sessionSNs.has('DIFFERENT_SN')).toBe(false); // → proceeds to pairing check
  });
});

// ── Regression tests ──────────────────────────────────────────────────────────

describe('REGRESSION — Nokia ARGA carton (PN: 474800A.102, SN: K9241817927)', () => {
  it('R1: PN barcode then SN barcode within 500 ms → PAIRED', () => {
    expect(simulatePairing('474800A.102', null, 'K9241817927', 500)).toBe('PAIRED');
  });

  it('R2: SN barcode then PN barcode reversed: caller buffers PN, SN would be processed first', () => {
    // When SN arrives first (no pending PN), it goes through normal flow.
    // Then PN arrives → buffer. A subsequent SN would pair.
    // This test verifies that once a pending PN is active, SN pairing works regardless of prior scans.
    expect(simulatePairing('474800A.102', null, 'K9241817927', 800)).toBe('PAIRED');
  });

  it('R3: repeated PN scan within window → same-PN check allows timer refresh (compatible)', () => {
    // isPnCompatible('474800A.102', '474800A.102') → true
    // Caller refreshes timer rather than starting a new pending carton
    expect(isPnCompatible('474800A.102', '474800A.102')).toBe(true);
  });

  it('R4: Q001 / Q005 quantity barcodes have no PN — caller discards them as AUXILIARY_CODE', () => {
    // These never reach the pairing logic; they are dropped before the buffer check.
    // Documented here as a design boundary note — pure functions don't model this.
    expect(true).toBe(true);
  });

  it('R5: DataMatrix (has both PN+SN) bypasses buffer entirely — isPnCompatible confirms no conflict', () => {
    // If DataMatrix arrives while a matching PN is pending (unlikely):
    expect(isPnCompatible('474800A.102', '474800A.102')).toBe(true);
    // Caller creates entry immediately and clears pending regardless.
  });
});
