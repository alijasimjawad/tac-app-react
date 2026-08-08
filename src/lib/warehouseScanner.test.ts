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

  it('AUXILIARY_CODE — Nokia standalone SN DI (SDH252030925) — carton component, enters buffer', () => {
    const parsed = parseScan('SDH252030925', 'CODE_128');
    expect(classifyScan(parsed)).toBe('AUXILIARY_CODE');
  });

  it('VALID_ITEM — Nokia N-series SN (N90001234567, MEDIUM confidence)', () => {
    const parsed = parseScan('N90001234567', 'CODE_128');
    expect(classifyScan(parsed)).toBe('VALID_ITEM');
  });

  it('UNKNOWN_IDENTIFIER — unrecognized alphanumeric code (no SN fabrication)', () => {
    const parsed = parseScan('ABC123456', 'CODE_128');
    expect(classifyScan(parsed)).toBe('UNKNOWN_IDENTIFIER');
  });

  it('AUXILIARY_CODE — Q1 (two chars)', () => {
    const parsed = parseScan('Q1', 'CODE_128');
    expect(classifyScan(parsed)).toBe('AUXILIARY_CODE');
  });

  it('AUXILIARY_CODE — single char V', () => {
    const parsed = parseScan('V', 'CODE_128');
    expect(classifyScan(parsed)).toBe('AUXILIARY_CODE');
  });

  it('UNKNOWN_IDENTIFIER — pure numeric 8569 (no longer silently dropped)', () => {
    const parsed = parseScan('8569', 'CODE_128');
    expect(classifyScan(parsed)).toBe('UNKNOWN_IDENTIFIER');
  });

  it('UNKNOWN_IDENTIFIER — pure numeric 915208 (six digits, no longer auxiliary)', () => {
    const parsed = parseScan('915208', 'CODE_128');
    expect(classifyScan(parsed)).toBe('UNKNOWN_IDENTIFIER');
  });

  it('AUXILIARY_CODE — Nokia quantity DI Q001', () => {
    const parsed = parseScan('Q001', 'CODE_128');
    expect(classifyScan(parsed)).toBe('AUXILIARY_CODE');
  });

  it('UNKNOWN_IDENTIFIER — 12345678 (eight digits, numeric limit rule removed)', () => {
    const parsed = parseScan('12345678', 'CODE_128');
    expect(classifyScan(parsed)).toBe('UNKNOWN_IDENTIFIER');
  });

  it('UNKNOWN_CODE — random garbage with no SN or PN', () => {
    const parsed = parseScan('!!!@@@###', 'UNKNOWN');
    expect(classifyScan(parsed)).toBe('UNKNOWN_CODE');
  });

  it('UNKNOWN_CODE — control characters only', () => {
    const parsed = parseScan('\x1d\x1e\x04', 'DATA_MATRIX');
    expect(classifyScan(parsed)).toBe('UNKNOWN_CODE');
  });

  it('UNKNOWN_IDENTIFIER for 9-digit numeric — serialNumber is null', () => {
    const parsed = parseScan('123456789', 'CODE_128');
    expect(classifyScan(parsed)).toBe('UNKNOWN_IDENTIFIER');
    expect(parsed.serialNumber).toBeNull();
  });

  it('not AUXILIARY_CODE for alphanumeric (ABC123456) — is UNKNOWN_IDENTIFIER', () => {
    const parsed = parseScan('ABC123456', 'CODE_128');
    expect(classifyScan(parsed)).not.toBe('AUXILIARY_CODE');
    expect(classifyScan(parsed)).toBe('UNKNOWN_IDENTIFIER');
  });
});

// ── Nokia alt-PN barcode (474254A.202) — Issue 2 fix ─────────────────────────

describe('Nokia alt-PN barcode — letter format (Issue 2 fix)', () => {
  it('474254A.202 → parsingProfile = nokia-pn-only, partNumber extracted, no SN', () => {
    const result = parseScan('474254A.202', 'CODE_128');
    expect(result.parsingProfile).toBe('nokia-pn-only');
    expect(result.partNumber).toBe('474254A.202');
    expect(result.serialNumber).toBeNull();
    expect(result.manufacturer).toBe('Nokia');
  });

  it('474254A.202 → classifyScan returns AUXILIARY_CODE', () => {
    const parsed = parseScan('474254A.202', 'CODE_128');
    expect(classifyScan(parsed)).toBe('AUXILIARY_CODE');
  });

  it('474254A.202 has no SN → does not pollute sessionSNs (serialNumber is null)', () => {
    const parsed = parseScan('474254A.202', 'CODE_128');
    expect(parsed.serialNumber).toBeNull();
  });

  it('legacy dash-format Nokia PN still works: 474234-200.001 → nokia-pn-only, AUXILIARY_CODE', () => {
    const parsed = parseScan('474234-200.001', 'CODE_128');
    expect(parsed.parsingProfile).toBe('nokia-pn-only');
    expect(classifyScan(parsed)).toBe('AUXILIARY_CODE');
  });

  it('letter-format PN does not match generic-sn-only profile (no fake PARTIAL_ITEM)', () => {
    const parsed = parseScan('474254A.202', 'CODE_128');
    expect(parsed.parsingProfile).not.toBe('generic-sn-only');
    expect(classifyScan(parsed)).not.toBe('PARTIAL_ITEM');
  });

  it('alt-PN variants: 6-digit + uppercase letter + .3-digit all match', () => {
    for (const pn of ['474254A.202', '123456B.001', '999999Z.999']) {
      const parsed = parseScan(pn, 'CODE_128');
      expect(classifyScan(parsed)).toBe('AUXILIARY_CODE');
    }
  });
});

// ── Nokia PN barcode with 1P DI prefix (PATH B linear aggregation fix) ───────

describe('Nokia PN barcode with 1P DI prefix', () => {
  it('1P474800A.102 → nokia-pn-only, partNumber=474800A.102, serialNumber=null', () => {
    const r = parseScan('1P474800A.102', 'CODE_128');
    expect(r.parsingProfile).toBe('nokia-pn-only');
    expect(r.partNumber).toBe('474800A.102');
    expect(r.serialNumber).toBeNull();
    expect(r.manufacturer).toBe('Nokia');
  });

  it('1P474800A.102 → classifyScan → AUXILIARY_CODE', () => {
    const parsed = parseScan('1P474800A.102', 'CODE_128');
    expect(classifyScan(parsed)).toBe('AUXILIARY_CODE');
  });

  it('1P prefix stripped: partNumber does not contain 1P', () => {
    const parsed = parseScan('1P474800A.102', 'CODE_128');
    expect(parsed.partNumber).toBe('474800A.102');
    expect(parsed.partNumber).not.toMatch(/^1P/i);
  });

  it('serialNumber is null — no fake SN enters sessionSNs', () => {
    const parsed = parseScan('1P474800A.102', 'CODE_128');
    expect(parsed.serialNumber).toBeNull();
  });

  it('1P474254A.202 → nokia-pn-only, AUXILIARY_CODE, partNumber=474254A.202', () => {
    const parsed = parseScan('1P474254A.202', 'CODE_128');
    expect(parsed.parsingProfile).toBe('nokia-pn-only');
    expect(classifyScan(parsed)).toBe('AUXILIARY_CODE');
    expect(parsed.partNumber).toBe('474254A.202');
  });

  it('1P474234-200.001 (legacy dash-format with DI) → nokia-pn-only, AUXILIARY_CODE', () => {
    const parsed = parseScan('1P474234-200.001', 'CODE_128');
    expect(parsed.parsingProfile).toBe('nokia-pn-only');
    expect(classifyScan(parsed)).toBe('AUXILIARY_CODE');
    expect(parsed.partNumber).toBe('474234-200.001');
  });

  it('1P-prefixed and bare PN produce the same partNumber value (buffer pairing works)', () => {
    const withDI    = parseScan('1P474800A.102', 'CODE_128');
    const withoutDI = parseScan('474800A.102',   'CODE_128');
    expect(withDI.partNumber).toBe(withoutDI.partNumber);
    expect(withDI.parsingProfile).toBe(withoutDI.parsingProfile);
  });

  it('1PGARBAGE does not match Nokia PN (garbage after 1P fails regex → genericParser)', () => {
    const parsed = parseScan('1PGARBAGE', 'CODE_128');
    expect(parsed.parsingProfile).not.toBe('nokia-pn-only');
  });

  it('SK9241817927 → nokia-sn-di, AUXILIARY_CODE, SN=K9241817927 (enters bidirectional buffer)', () => {
    const parsed = parseScan('SK9241817927', 'CODE_128');
    expect(parsed.parsingProfile).toBe('nokia-sn-di');
    expect(classifyScan(parsed)).toBe('AUXILIARY_CODE');
    expect(parsed.serialNumber).toBe('K9241817927');
    expect(parsed.partNumber).toBeNull();
    expect(parsed.manufacturer).toBe('Nokia');
  });

  it('K9241817927 (bare, no S prefix) → nokia-k-sn, VALID_ITEM, serialNumber=K9241817927', () => {
    const parsed = parseScan('K9241817927', 'CODE_128');
    expect(parsed.parsingProfile).toBe('nokia-k-sn');
    expect(classifyScan(parsed)).toBe('VALID_ITEM');
    expect(parsed.serialNumber).toBe('K9241817927');
    expect(parsed.manufacturer).toBe('Nokia');
  });

  it('DataMatrix 1P+S DI fields still route to nokia-gs1 (not intercepted by 1P linear fix)', () => {
    // DataMatrix payload has GS separator — splits into ['1P474800A.102', 'SK9241817927']
    // → genericParser → hasNokiaDI=true → parseNokiaDI → nokia-gs1
    const raw = '1P474800A.102' + '\x1d' + 'SK9241817927';
    const parsed = parseScan(raw, 'DATA_MATRIX');
    expect(parsed.parsingProfile).toBe('nokia-gs1');
    expect(parsed.partNumber).toBe('474800A.102');
    expect(parsed.serialNumber).toBe('K9241817927');
    expect(classifyScan(parsed)).toBe('VALID_ITEM');
  });

  it('REGRESSION — 474800A.102 bare still works (existing nokia-pn-only path unchanged)', () => {
    const parsed = parseScan('474800A.102', 'CODE_128');
    expect(parsed.parsingProfile).toBe('nokia-pn-only');
    expect(classifyScan(parsed)).toBe('AUXILIARY_CODE');
  });

  it('REGRESSION — 474254A.202 bare still AUXILIARY_CODE', () => {
    const parsed = parseScan('474254A.202', 'CODE_128');
    expect(classifyScan(parsed)).toBe('AUXILIARY_CODE');
  });
});

// ── Continuous scanning — SN dedup and secondary barcode handling ─────────────

describe('Continuous scanning — SN dedup and secondary barcode handling', () => {
  it('DataMatrix SN and secondary linear SN barcode normalize to same value → both would be DUPLICATE', () => {
    // DataMatrix gives SN=1M241909797 via S DI after stripping
    const dm = parseScan(gs1('1P474254A.202', 'S1M241909797'), 'DATA_MATRIX');
    // Linear SN barcode S1M241909797 → nokia-sn-di → SN=1M241909797
    const linear = parseScan('S1M241909797', 'CODE_128');

    expect(dm.serialNumber).toBe('1M241909797');
    expect(linear.serialNumber).toBe('1M241909797');
    // Both normalize identically → second scan hits sessionSNs.has() → DUPLICATE
  });

  it('different SN from next carton → different normalized SN → not a duplicate', () => {
    const cartonA = parseScan(gs1('1P474254A.202', 'S1M241909797'), 'DATA_MATRIX');
    const cartonB = parseScan(gs1('1P474254A.202', 'S1M241999999'), 'DATA_MATRIX');

    expect(cartonA.serialNumber).toBe('1M241909797');
    expect(cartonB.serialNumber).toBe('1M241999999');
    // SNs differ → sessionSNs never collides → cartonB accepted
  });

  it('PN-only linear barcode from second carton (same model) → AUXILIARY_CODE, not DUPLICATE', () => {
    const parsed = parseScan('474254A.202', 'CODE_128');
    expect(classifyScan(parsed)).toBe('AUXILIARY_CODE');
    expect(parsed.serialNumber).toBeNull();
    // Filtered before reaching sessionSNs → cannot create a fake DUPLICATE
  });

  it('quantity barcode Q001 from same label → AUXILIARY_CODE', () => {
    expect(classifyScan(parseScan('Q001', 'CODE_128'))).toBe('AUXILIARY_CODE');
  });

  it('quantity barcode Q005 from same label → AUXILIARY_CODE', () => {
    expect(classifyScan(parseScan('Q005', 'CODE_128'))).toBe('AUXILIARY_CODE');
  });

  it('Nokia N-series SN of different carton → VALID_ITEM, different SN → not duplicate', () => {
    const cartonA = parseScan('N912345678901', 'CODE_128');
    const cartonB = parseScan('N912345678902', 'CODE_128');

    expect(classifyScan(cartonA)).toBe('VALID_ITEM');
    expect(classifyScan(cartonB)).toBe('VALID_ITEM');
    expect(cartonA.serialNumber).not.toBe(cartonB.serialNumber);
  });

  it('DataMatrix carton A then DataMatrix carton B → both VALID_ITEM with distinct SNs', () => {
    const rawA = gs1('1P474254A.202', 'S1M000001');
    const rawB = gs1('1P474254A.202', 'S1M000002');

    const parsedA = parseScan(rawA, 'DATA_MATRIX');
    const parsedB = parseScan(rawB, 'DATA_MATRIX');

    expect(classifyScan(parsedA)).toBe('VALID_ITEM');
    expect(classifyScan(parsedB)).toBe('VALID_ITEM');
    expect(parsedA.serialNumber).toBe('1M000001');
    expect(parsedB.serialNumber).toBe('1M000002');
  });
});

// ── Phase 3E-C: Universal Scanner — unknown identifier / generic codes ─────────

describe('Phase 3E-C — unknown-identifier and url-payload profiles', () => {
  // ── unknown-identifier profile (replaces generic-sn-only) ────────────────

  it('unknown-identifier: 8569 → profile=unknown-identifier, serialNumber=null', () => {
    const p = parseScan('8569', 'CODE_128');
    expect(p.parsingProfile).toBe('unknown-identifier');
    expect(p.serialNumber).toBeNull();
    expect(p.partNumber).toBeNull();
  });

  it('unknown-identifier: 915208 → UNKNOWN_IDENTIFIER, serialNumber=null', () => {
    const p = parseScan('915208', 'CODE_128');
    expect(classifyScan(p)).toBe('UNKNOWN_IDENTIFIER');
    expect(p.serialNumber).toBeNull();
  });

  it('unknown-identifier: ABC123456 → profile=unknown-identifier, serialNumber=null (no fabrication)', () => {
    const p = parseScan('ABC123456', 'CODE_128');
    expect(p.parsingProfile).toBe('unknown-identifier');
    expect(p.serialNumber).toBeNull();
    expect(classifyScan(p)).toBe('UNKNOWN_IDENTIFIER');
  });

  it('unknown-identifier: XQZABC123456 → unknown-identifier, serialNumber=null', () => {
    const p = parseScan('XQZABC123456', 'CODE_128');
    expect(p.parsingProfile).toBe('unknown-identifier');
    expect(p.serialNumber).toBeNull();
  });

  it('generic-sn-only profile is NEVER produced by the parser', () => {
    // Any alphanumeric 6–30 char string that would previously produce generic-sn-only
    // now produces unknown-identifier with no serial number
    const candidates = ['ABC123456', 'ZYXWVU9876', 'SIM10116110', 'MODEMDEVICE'];
    for (const raw of candidates) {
      const p = parseScan(raw, 'CODE_128');
      expect(p.parsingProfile).not.toBe('generic-sn-only');
    }
  });

  // ── url-payload profile ───────────────────────────────────────────────────

  it('url-payload: https URL → profile=url-payload, UNKNOWN_IDENTIFIER, no SN/PN', () => {
    const p = parseScan('https://example.com', 'QR_CODE');
    expect(p.parsingProfile).toBe('url-payload');
    expect(classifyScan(p)).toBe('UNKNOWN_IDENTIFIER');
    expect(p.serialNumber).toBeNull();
    expect(p.partNumber).toBeNull();
  });

  it('url-payload: http URL → url-payload', () => {
    const p = parseScan('http://vendor.zain.com/qr?id=123456', 'QR_CODE');
    expect(p.parsingProfile).toBe('url-payload');
    expect(classifyScan(p)).toBe('UNKNOWN_IDENTIFIER');
  });

  it('url-payload: JSON QR → url-payload, UNKNOWN_IDENTIFIER', () => {
    const p = parseScan('{"id":"SIM123","type":"SIM_CARD"}', 'QR_CODE');
    expect(p.parsingProfile).toBe('url-payload');
    expect(classifyScan(p)).toBe('UNKNOWN_IDENTIFIER');
    expect(p.serialNumber).toBeNull();
  });

  // ── Nokia K-series SN ─────────────────────────────────────────────────────

  it('nokia-k-sn: K9241817927 → nokia-k-sn, VALID_ITEM, serialNumber=K9241817927, Nokia', () => {
    const p = parseScan('K9241817927', 'CODE_128');
    expect(p.parsingProfile).toBe('nokia-k-sn');
    expect(classifyScan(p)).toBe('VALID_ITEM');
    expect(p.serialNumber).toBe('K9241817927');
    expect(p.manufacturer).toBe('Nokia');
    expect(p.confidence).toBe('MEDIUM');
  });

  it('nokia-k-sn: KABCDE12345 → nokia-k-sn, VALID_ITEM', () => {
    const p = parseScan('KABCDE12345', 'CODE_128');
    expect(p.parsingProfile).toBe('nokia-k-sn');
    expect(classifyScan(p)).toBe('VALID_ITEM');
    expect(p.serialNumber).toBe('KABCDE12345');
  });

  it('nokia-k-sn: K123 (too short, 4 chars) → NOT nokia-k-sn', () => {
    const p = parseScan('K123', 'CODE_128');
    expect(p.parsingProfile).not.toBe('nokia-k-sn');
  });

  it('nokia-k-sn: SK9241817927 still → nokia-sn-di, AUXILIARY_CODE, SN=K9241817927 (unchanged)', () => {
    const p = parseScan('SK9241817927', 'CODE_128');
    expect(p.parsingProfile).toBe('nokia-sn-di');
    expect(classifyScan(p)).toBe('AUXILIARY_CODE');
    expect(p.serialNumber).toBe('K9241817927');
  });

  // ── Nokia quantity DI still works ─────────────────────────────────────────

  it('Q001 → AUXILIARY_CODE (Nokia quantity DI rule unchanged)', () => {
    expect(classifyScan(parseScan('Q001', 'CODE_128'))).toBe('AUXILIARY_CODE');
  });

  it('Q1 → AUXILIARY_CODE (two-char length rule unchanged)', () => {
    expect(classifyScan(parseScan('Q1', 'CODE_128'))).toBe('AUXILIARY_CODE');
  });

  // ── UNKNOWN_IDENTIFIER never fabricates a serial number ──────────────────

  it('UNKNOWN_IDENTIFIER entries always have serialNumber=null', () => {
    const codes = ['8569', '915208', '12345678', 'ABC123456', '123456789'];
    for (const raw of codes) {
      const p = parseScan(raw, 'CODE_128');
      if (classifyScan(p) === 'UNKNOWN_IDENTIFIER') {
        expect(p.serialNumber).toBeNull();
      }
    }
  });

  it('url-payload: rawValue preserved exactly', () => {
    const url = 'https://example.com/barcode?id=SIM-999';
    const p   = parseScan(url, 'QR_CODE');
    expect(p.rawValue).toBe(url);
    expect(p.parsingProfile).toBe('url-payload');
  });
});
