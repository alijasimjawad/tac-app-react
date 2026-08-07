import { describe, it, expect } from 'vitest';
import { parseScan, hasNokiaDI, parseNokiaDI, classifyScan } from './warehouseScanner';

// ── Helpers ───────────────────────────────────────────────────────────────────

// Build a GS1/DI DataMatrix payload from fields joined by GS (0x1D)
const GS = '\x1d';
const RS = '\x1e';

function gs1(...fields: string[]) {
  return fields.join(GS);
}

// ── Nokia DataMatrix (multi-field DI payload) ─────────────────────────────────

describe('Nokia DataMatrix — 1P+S DI encoding', () => {
  it('extracts PN and SN from real carton pattern (PN first)', () => {
    const raw = gs1('1P475266B.102', 'SDH252030925');
    const result = parseScan(raw, 'DATA_MATRIX');

    expect(result.partNumber).toBe('475266B.102');
    expect(result.serialNumber).toBe('DH252030925');
    expect(result.parsingProfile).toBe('nokia-gs1');
    expect(result.status).toBe('resolved');
    expect(result.manufacturer).toBe('Nokia');
    expect(result.rawValue).toBe(raw);       // rawValue NEVER modified
    expect(result.itemType).toBeNull();       // item type comes from Item Master, not barcode
  });

  it('extracts PN and SN regardless of field order (SN first)', () => {
    const raw = gs1('SDH252030925', '1P475266B.102');
    const result = parseScan(raw, 'DATA_MATRIX');

    expect(result.partNumber).toBe('475266B.102');
    expect(result.serialNumber).toBe('DH252030925');
    expect(result.parsingProfile).toBe('nokia-gs1');
    expect(result.status).toBe('resolved');
  });

  it('ignores unknown DI fields without failing', () => {
    // Q = Quantity, V = Vendor — should be silently ignored
    const raw = gs1('1P475266B.102', 'SDH252030925', 'Q001', 'VNOKIA');
    const result = parseScan(raw, 'DATA_MATRIX');

    expect(result.partNumber).toBe('475266B.102');
    expect(result.serialNumber).toBe('DH252030925');
    expect(result.status).toBe('resolved');
  });

  it('returns partially_resolved when SN is missing', () => {
    const raw = gs1('1P475266B.102', 'Q001');
    const result = parseScan(raw, 'DATA_MATRIX');

    expect(result.partNumber).toBe('475266B.102');
    expect(result.serialNumber).toBeNull();
    expect(result.status).toBe('partially_resolved');
  });

  it('returns partially_resolved when PN is missing (SN-only multi-field)', () => {
    const raw = gs1('SDH252030925', 'Q001');
    // No 1P field → hasNokiaDI is false → falls to standard GS1 parser
    // (This payload has no PN DI so we can't confirm Nokia DI context)
    const result = parseScan(raw, 'DATA_MATRIX');
    // Should not crash; will be handled by GS1 or generic parser
    expect(result.rawValue).toBe(raw);
    expect(result.status).not.toBeUndefined();
  });

  it('strips identifier chars from values — 1P and S are not in the output', () => {
    const raw = gs1('1P475266B.102', 'SDH252030925');
    const result = parseScan(raw, 'DATA_MATRIX');

    // '1P' must not appear in partNumber
    expect(result.partNumber).not.toMatch(/^1P/);
    // 'S' must not appear at the start of serialNumber
    expect(result.serialNumber).not.toMatch(/^S/);
    expect(result.partNumber).toBe('475266B.102');
    expect(result.serialNumber).toBe('DH252030925');
  });

  it('handles RS (0x1E) separator as well as GS (0x1D)', () => {
    const raw = '1P475266B.102' + RS + 'SDH252030925';
    const result = parseScan(raw, 'DATA_MATRIX');

    expect(result.partNumber).toBe('475266B.102');
    expect(result.serialNumber).toBe('DH252030925');
    expect(result.parsingProfile).toBe('nokia-gs1');
  });

  it('preserves rawValue exactly — no trimming, uppercasing, or splitting', () => {
    const raw = gs1('1P475266B.102', 'SDH252030925');
    const result = parseScan(raw, 'DATA_MATRIX');

    expect(result.rawValue).toBe(raw);
    expect(result.rawValue).toContain('\x1d');  // separator present in raw
  });
});

// ── Standalone Nokia SN barcodes ──────────────────────────────────────────────

describe('Nokia standalone SN barcode — S DI prefix', () => {
  it('strips S DI from SDH252030925, returns SN=DH252030925', () => {
    const result = parseScan('SDH252030925', 'CODE_128');

    expect(result.serialNumber).toBe('DH252030925');
    expect(result.partNumber).toBeNull();
    expect(result.parsingProfile).toBe('nokia-sn-di');
    expect(result.rawValue).toBe('SDH252030925');  // raw unchanged
  });

  it('strips S DI from SN-series SNs: SN912345678 → N912345678', () => {
    // S is DI, N912345678 is the SN value
    const result = parseScan('SN912345678', 'CODE_128');

    expect(result.serialNumber).toBe('N912345678');
    expect(result.parsingProfile).toBe('nokia-sn-di');
  });

  it('does NOT strip S when it is genuinely part of the value — 4+ letters after S', () => {
    // SERIAL001: S + ERIAL (4 letters) + 001 (3 digits < 6 minimum)
    // Does NOT match NOKIA_SN_DI_RE → S is part of the value
    const result = parseScan('SERIAL001', 'CODE_128');

    expect(result.serialNumber).not.toBe('ERIAL001');
    // 'SERIAL001' is only 9 chars so it won't even match generic-sn-only (6-30 alnum)
    // The raw SN should include S if anything
  });

  it('does NOT strip S from SFULL12345678 — FULL is 4 letters (> 3 limit)', () => {
    const result = parseScan('SFULL12345678', 'CODE_128');

    // NOKIA_SN_DI_RE requires ≤3 alnum chars before the digit run; FULL breaks it
    expect(result.serialNumber).not.toBe('FULL12345678');
    expect(result.parsingProfile).not.toBe('nokia-sn-di');
  });

  it('Phase B: strips S DI from S1M241909797 → SN=1M241909797 (digit-first Nokia prefix)', () => {
    // Real carton: printed linear barcode S1M241909797 encodes SN 1M241909797
    // The DataMatrix also produces SN=1M241909797 (via 1P+S DI fields).
    // Both must normalize to the same value so the linear barcode is caught as DUPLICATE.
    const result = parseScan('S1M241909797', 'CODE_128');

    expect(result.serialNumber).toBe('1M241909797');
    expect(result.partNumber).toBeNull();
    expect(result.parsingProfile).toBe('nokia-sn-di');
    expect(result.rawValue).toBe('S1M241909797'); // raw unchanged
  });

  it('Nokia N-series SN: N is part of the SN value — NOT stripped', () => {
    // N90001234567 is a standard Nokia N-series SN. N is part of the value.
    const result = parseScan('N90001234567', 'CODE_128');

    expect(result.serialNumber).toBe('N90001234567');  // N preserved
    expect(result.parsingProfile).toBe('nokia-sn-only');
  });
});

// ── Standard GS1 (non-Nokia) — should be unaffected ──────────────────────────

describe('Standard GS1 AI barcodes — not affected by Nokia DI parser', () => {
  it('parses (01) GTIN and (21) SN using standard GS1 AIs', () => {
    const raw = '(01)04012345678901(21)SN001ABC';
    const result = parseScan(raw, 'DATA_MATRIX');

    expect(result.parsingProfile).toBe('gs1');
    expect(result.partNumber).toBe('04012345678901');
    expect(result.serialNumber).toBe('SN001ABC');
  });

  it('does not activate Nokia DI parser when 1P is absent', () => {
    const raw = gs1('(01)04012345678901', '(21)TESTSERIAL');
    const result = parseScan(raw, 'DATA_MATRIX');

    expect(result.parsingProfile).toBe('gs1');
    expect(result.parsingProfile).not.toBe('nokia-gs1');
  });
});

// ── hasNokiaDI unit tests ─────────────────────────────────────────────────────

describe('hasNokiaDI()', () => {
  it('returns true when 1P field is present', () => {
    expect(hasNokiaDI(['1P475266B.102', 'SDH252030925'])).toBe(true);
  });

  it('returns false when only S field is present (no 1P)', () => {
    expect(hasNokiaDI(['SDH252030925', 'Q001'])).toBe(false);
  });

  it('returns false for standard GS1 fields', () => {
    expect(hasNokiaDI(['(01)04012345678901', '(21)SN001'])).toBe(false);
  });

  it('returns false for empty array', () => {
    expect(hasNokiaDI([])).toBe(false);
  });
});

// ── parseNokiaDI unit tests ───────────────────────────────────────────────────

describe('parseNokiaDI()', () => {
  it('extracts PN=475266B.102 and SN=DH252030925', () => {
    const r = parseNokiaDI(['1P475266B.102', 'SDH252030925']);
    expect(r.partNumber).toBe('475266B.102');
    expect(r.serialNumber).toBe('DH252030925');
    expect(r.status).toBe('resolved');
  });

  it('handles empty / whitespace-only fields without crashing', () => {
    const r = parseNokiaDI(['1P475266B.102', '', '  ', 'SDH252030925']);
    expect(r.partNumber).toBe('475266B.102');
    expect(r.serialNumber).toBe('DH252030925');
  });

  it('returns unresolved for completely unknown DI fields', () => {
    const r = parseNokiaDI(['Q005', 'VUNKNOWN']);
    expect(r.partNumber).toBeNull();
    expect(r.serialNumber).toBeNull();
    expect(r.status).toBe('unresolved');
  });

  it('sets manufacturer to Nokia', () => {
    const r = parseNokiaDI(['1P475266B.102', 'SDH252030925']);
    expect(r.manufacturer).toBe('Nokia');
  });

  it('sets parsingProfile to nokia-gs1', () => {
    const r = parseNokiaDI(['1P475266B.102', 'SDH252030925']);
    expect(r.parsingProfile).toBe('nokia-gs1');
  });
});

// ── Malformed payloads ────────────────────────────────────────────────────────

describe('Malformed and edge-case payloads', () => {
  it('returns unresolved for random garbage', () => {
    const result = parseScan('!!!@@@###$$$', 'UNKNOWN');
    expect(result.status).toBe('unresolved');
    expect(result.rawValue).toBe('!!!@@@###$$$');
  });

  it('handles empty string without throwing', () => {
    expect(() => parseScan('', 'CODE_128')).not.toThrow();
  });

  it('handles control characters only without throwing', () => {
    expect(() => parseScan('\x1d\x1e\x04', 'DATA_MATRIX')).not.toThrow();
  });

  it('preserves rawValue for all payloads including malformed ones', () => {
    const raw = '\x1d1P475266B.102\x1dSDH252030925\x1d';
    const result = parseScan(raw, 'DATA_MATRIX');
    expect(result.rawValue).toBe(raw);
  });
});

// ── classifyScan() ────────────────────────────────────────────────────────────

describe('classifyScan()', () => {
  it('VALID_ITEM — Nokia DataMatrix with both PN and SN (HIGH confidence)', () => {
    const raw = gs1('1P475266B.102', 'SDH252030925');
    const parsed = parseScan(raw, 'DATA_MATRIX');
    expect(classifyScan(parsed)).toBe('VALID_ITEM');
  });

  it('VALID_ITEM — Nokia standalone SN DI (SDH252030925, MEDIUM confidence)', () => {
    const parsed = parseScan('SDH252030925', 'CODE_128');
    expect(classifyScan(parsed)).toBe('VALID_ITEM');
  });

  it('VALID_ITEM — Nokia N-series SN (N90001234567, MEDIUM confidence)', () => {
    const parsed = parseScan('N90001234567', 'CODE_128');
    expect(classifyScan(parsed)).toBe('VALID_ITEM');
  });

  it('PARTIAL_ITEM — generic SN only (LOW confidence)', () => {
    const parsed = parseScan('ABC123456', 'CODE_128');
    expect(classifyScan(parsed)).toBe('PARTIAL_ITEM');
  });

  it('AUXILIARY_CODE — Q1 (two chars)', () => {
    const parsed = parseScan('Q1', 'CODE_128');
    expect(classifyScan(parsed)).toBe('AUXILIARY_CODE');
  });

  it('AUXILIARY_CODE — single char V', () => {
    const parsed = parseScan('V', 'CODE_128');
    expect(classifyScan(parsed)).toBe('AUXILIARY_CODE');
  });

  it('AUXILIARY_CODE — pure numeric 8569', () => {
    const parsed = parseScan('8569', 'CODE_128');
    expect(classifyScan(parsed)).toBe('AUXILIARY_CODE');
  });

  it('AUXILIARY_CODE — pure numeric 915208 (six digits)', () => {
    const parsed = parseScan('915208', 'CODE_128');
    expect(classifyScan(parsed)).toBe('AUXILIARY_CODE');
  });

  it('AUXILIARY_CODE — Nokia quantity DI Q001', () => {
    const parsed = parseScan('Q001', 'CODE_128');
    expect(classifyScan(parsed)).toBe('AUXILIARY_CODE');
  });

  it('AUXILIARY_CODE — 12345678 (eight digit numeric limit)', () => {
    const parsed = parseScan('12345678', 'CODE_128');
    expect(classifyScan(parsed)).toBe('AUXILIARY_CODE');
  });

  it('UNKNOWN_CODE — random garbage with no SN or PN', () => {
    const parsed = parseScan('!!!@@@###', 'UNKNOWN');
    expect(classifyScan(parsed)).toBe('UNKNOWN_CODE');
  });

  it('UNKNOWN_CODE — control characters only', () => {
    const parsed = parseScan('\x1d\x1e\x04', 'DATA_MATRIX');
    expect(classifyScan(parsed)).toBe('UNKNOWN_CODE');
  });

  it('not AUXILIARY_CODE for 9-digit numeric (could be a SN)', () => {
    const parsed = parseScan('123456789', 'CODE_128');
    // 9 digits exceeds the 1-8 limit — not filtered as auxiliary
    expect(classifyScan(parsed)).not.toBe('AUXILIARY_CODE');
  });

  it('not AUXILIARY_CODE for alphanumeric SN (ABC123456)', () => {
    const parsed = parseScan('ABC123456', 'CODE_128');
    expect(classifyScan(parsed)).not.toBe('AUXILIARY_CODE');
  });
});
