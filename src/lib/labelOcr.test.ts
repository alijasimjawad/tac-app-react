import { describe, it, expect } from 'vitest';
import { parseLabel, fuzzyNoiseCheck, normalizeOcr, selectBestItemType } from './labelOcr';
import { mergeScanAndOcr } from './smartLabelMerge';
import type { OcrResult, OcrCandidateDetail } from './labelOcr';
import type { InventoryItem } from './warehouseTypes';

// ── parseLabel() — text parsing without Tesseract ─────────────────────────────

describe('parseLabel() — Nokia label text parsing', () => {
  it('extracts Nokia item type code ABIO from label text', () => {
    const { itemTypes } = parseLabel('NOKIA NETWORKS\nABIO\nP/N: 475266B.102', new Set());
    expect(itemTypes).toContain('ABIO');
  });

  it('extracts Nokia item type code FXDA', () => {
    const { itemTypes } = parseLabel('FXDA outdoor unit', new Set());
    expect(itemTypes).toContain('FXDA');
  });

  it('extracts PN from P/N: prefix', () => {
    const { partNumbers } = parseLabel('P/N: 475266B.102', new Set());
    expect(partNumbers).toContain('475266B.102');
  });

  it('extracts PN from Part No: prefix', () => {
    const { partNumbers } = parseLabel('Part No: 474254A.202', new Set());
    expect(partNumbers).toContain('474254A.202');
  });

  it('extracts PN from Part Number: prefix', () => {
    const { partNumbers } = parseLabel('Part Number: 474254A.202', new Set());
    expect(partNumbers).toContain('474254A.202');
  });

  it('extracts PN from standalone Nokia PN pattern (6digits + letter + .3digits)', () => {
    const { partNumbers } = parseLabel('474254A.202', new Set());
    expect(partNumbers).toContain('474254A.202');
  });

  it('extracts SN from S/N: prefix', () => {
    const { serialNumbers } = parseLabel('S/N: DH252030925', new Set());
    expect(serialNumbers).toContain('DH252030925');
  });

  it('extracts SN from Serial No: prefix', () => {
    const { serialNumbers } = parseLabel('Serial No: 1M241909797', new Set());
    expect(serialNumbers).toContain('1M241909797');
  });

  it('extracts SN from standalone Nokia DH-prefix pattern', () => {
    const { serialNumbers } = parseLabel('DH252030925', new Set());
    expect(serialNumbers).toContain('DH252030925');
  });

  it('extracts all fields from a full Nokia carton label', () => {
    const text = [
      'NOKIA NETWORKS',
      'FXDA',
      'Part No: 474254A.202',
      'Serial No: 1M241909797',
      'Made in China',
    ].join('\n');
    const result = parseLabel(text, new Set());
    expect(result.itemTypes).toContain('FXDA');
    expect(result.partNumbers).toContain('474254A.202');
    expect(result.serialNumbers).toContain('1M241909797');
  });

  it('returns empty arrays for unrelated label text', () => {
    const result = parseLabel('FRAGILE\nHANDLE WITH CARE\nTHIS SIDE UP', new Set());
    expect(result.itemTypes).toHaveLength(0);
    expect(result.partNumbers).toHaveLength(0);
    expect(result.serialNumbers).toHaveLength(0);
  });

  it('matches item type from Item Master vocabulary (itemTypeCodes set)', () => {
    const codes = new Set(['ABCD', 'EFGH']);
    const { itemTypes } = parseLabel('ABCD outdoor unit', codes);
    expect(itemTypes).toContain('ABCD');
  });

  it('does not match excluded common words (MADE, NOKIA, FROM)', () => {
    const codes = new Set(['FROM', 'MADE', 'NOKIA', 'CHINA']);
    const { itemTypes } = parseLabel('MADE FROM NOKIA parts in CHINA', codes);
    expect(itemTypes).not.toContain('FROM');
    expect(itemTypes).not.toContain('MADE');
    expect(itemTypes).not.toContain('NOKIA');
    expect(itemTypes).not.toContain('CHINA');
  });

  it('is case-insensitive for Nokia type code detection', () => {
    const { itemTypes } = parseLabel('abio outdoor unit', new Set());
    expect(itemTypes).toContain('ABIO');
  });

  it('handles empty string without throwing', () => {
    expect(() => parseLabel('', new Set())).not.toThrow();
    const r = parseLabel('', new Set());
    expect(r.itemTypes).toHaveLength(0);
    expect(r.partNumbers).toHaveLength(0);
    expect(r.serialNumbers).toHaveLength(0);
  });

  it('extracts multiple Nokia type codes from the same label', () => {
    const { itemTypes } = parseLabel('Equipment types: ABIO and FXDA', new Set());
    expect(itemTypes).toContain('ABIO');
    expect(itemTypes).toContain('FXDA');
  });
});

// ── mergeScanAndOcr() — merge engine ──────────────────────────────────────────

function makeOcr(overrides: {
  itemType?: string;
  partNumber?: string;
  serialNumber?: string;
  confidence?: number;
  isItemTypeAmbiguous?: boolean;
} = {}): OcrResult {
  return {
    rawText: 'test label text',
    itemTypeCandidates:     overrides.itemType     ? [overrides.itemType]     : [],
    selectedItemType:       overrides.itemType     ?? null,
    candidateDetails:       [],
    isItemTypeAmbiguous:    overrides.isItemTypeAmbiguous ?? false,
    partNumberCandidates:   overrides.partNumber   ? [overrides.partNumber]   : [],
    serialNumberCandidates: overrides.serialNumber ? [overrides.serialNumber] : [],
    confidence:             overrides.confidence   ?? 80,
    source:                 'OCR',
    durationMs:             1200,
  };
}

describe('mergeScanAndOcr() — merge engine', () => {
  it('BARCODE_ONLY when ocr is null', () => {
    const r = mergeScanAndOcr({
      barcode: { serialNumber: 'DH252030925', partNumber: '475266B.102', itemType: null },
      ocr: null,
    });
    expect(r.scenario).toBe('BARCODE_ONLY');
    expect(r.serialNumber).toBe('DH252030925');
    expect(r.partNumber).toBe('475266B.102');
    expect(r.source.serialNumber).toBe('BARCODE');
    expect(r.source.partNumber).toBe('BARCODE');
  });

  it('OCR_ONLY when barcode is null', () => {
    const r = mergeScanAndOcr({
      barcode: null,
      ocr: makeOcr({ itemType: 'ABIO', partNumber: '474254A.202' }),
    });
    expect(r.scenario).toBe('OCR_ONLY');
    expect(r.itemType).toBe('ABIO');
    expect(r.partNumber).toBe('474254A.202');
    expect(r.source.itemType).toBe('OCR');
    expect(r.source.partNumber).toBe('OCR');
  });

  it('MERGED: barcode PN/SN take priority over OCR when both agree', () => {
    const r = mergeScanAndOcr({
      barcode: { serialNumber: 'DH252030925', partNumber: '475266B.102', itemType: null },
      ocr: makeOcr({ itemType: 'ABIO', partNumber: '475266B.102', serialNumber: 'DH252030925' }),
    });
    expect(r.scenario).toBe('MERGED');
    expect(r.source.partNumber).toBe('BARCODE');
    expect(r.source.serialNumber).toBe('BARCODE');
    expect(r.source.itemType).toBe('OCR');
    expect(r.conflicts).toHaveLength(0);
  });

  it('MERGED: OCR fills ItemType when barcode has none', () => {
    const r = mergeScanAndOcr({
      barcode: { serialNumber: 'DH252030925', partNumber: '475266B.102', itemType: null },
      ocr: makeOcr({ itemType: 'ABIO' }),
    });
    expect(r.scenario).toBe('MERGED');
    expect(r.itemType).toBe('ABIO');
    expect(r.source.itemType).toBe('OCR');
    expect(r.serialNumber).toBe('DH252030925');
    expect(r.partNumber).toBe('475266B.102');
    expect(r.confidence).toBe('HIGH');
  });

  it('CONFLICT when PN disagrees between barcode and OCR', () => {
    const r = mergeScanAndOcr({
      barcode: { serialNumber: 'DH252030925', partNumber: '475266B.102', itemType: null },
      ocr: makeOcr({ partNumber: '474254A.202' }),
    });
    expect(r.scenario).toBe('CONFLICT');
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toContain('PN conflict');
    expect(r.confidence).toBe('LOW');
    // Barcode PN wins even in conflict
    expect(r.partNumber).toBe('475266B.102');
  });

  it('CONFLICT when SN disagrees between barcode and OCR', () => {
    const r = mergeScanAndOcr({
      barcode: { serialNumber: 'DH252030925', partNumber: '475266B.102', itemType: null },
      ocr: makeOcr({ serialNumber: 'DIFFERENT9999' }),
    });
    expect(r.scenario).toBe('CONFLICT');
    expect(r.conflicts[0]).toContain('SN conflict');
    // Barcode SN wins
    expect(r.serialNumber).toBe('DH252030925');
  });

  it('PN comparison is case-insensitive — no false conflict', () => {
    const r = mergeScanAndOcr({
      barcode: { serialNumber: null, partNumber: '475266B.102', itemType: null },
      ocr: makeOcr({ partNumber: '475266b.102' }),
    });
    expect(r.conflicts).toHaveLength(0);
    expect(r.scenario).toBe('MERGED');
  });

  it('SN comparison is case-insensitive — no false conflict', () => {
    const r = mergeScanAndOcr({
      barcode: { serialNumber: 'dh252030925', partNumber: null, itemType: null },
      ocr: makeOcr({ serialNumber: 'DH252030925' }),
    });
    expect(r.conflicts).toHaveLength(0);
  });

  it('HIGH confidence for MERGED with both PN and SN', () => {
    const r = mergeScanAndOcr({
      barcode: { serialNumber: 'DH252030925', partNumber: '475266B.102', itemType: null },
      ocr: makeOcr({ itemType: 'ABIO' }),
    });
    expect(r.confidence).toBe('HIGH');
  });

  it('LOW confidence when both barcode and ocr are null', () => {
    const r = mergeScanAndOcr({ barcode: null, ocr: null });
    expect(r.confidence).toBe('LOW');
    expect(r.serialNumber).toBeNull();
    expect(r.partNumber).toBeNull();
    expect(r.itemType).toBeNull();
    expect(r.source.serialNumber).toBeNull();
    expect(r.source.partNumber).toBeNull();
    expect(r.source.itemType).toBeNull();
  });

  it('OCR fills SN and PN when barcode has none', () => {
    const r = mergeScanAndOcr({
      barcode: null,
      ocr: makeOcr({ serialNumber: 'DH252030925', partNumber: '475266B.102', itemType: 'ABIO' }),
    });
    expect(r.serialNumber).toBe('DH252030925');
    expect(r.partNumber).toBe('475266B.102');
    expect(r.itemType).toBe('ABIO');
    expect(r.source.serialNumber).toBe('OCR');
    expect(r.source.partNumber).toBe('OCR');
  });
});

// ── Phase B — auto-snapshot OCR tests ─────────────────────────────────────────

describe('Phase B — AHGA & generic item type extraction', () => {
  it('extracts AHGA from a real Nokia carton label (ground truth)', () => {
    const text = [
      'NOKIA NETWORKS',
      'AHGA',
      'Part No: 474254A.202',
      'Serial No: 1M241909797',
      'Made in China',
    ].join('\n');
    const { itemTypes, partNumbers, serialNumbers } = parseLabel(text, new Set());
    expect(itemTypes).toContain('AHGA');
    expect(partNumbers).toContain('474254A.202');
    expect(serialNumbers).toContain('1M241909797');
  });

  it('extracts AHGA even when not in Item Master (generic Nokia code pattern)', () => {
    // Nokia label with AHGA — Item Master vocabulary is empty
    const { itemTypes } = parseLabel('AHGA outdoor unit', new Set());
    expect(itemTypes).toContain('AHGA');
  });

  it('prefers Item Master match over pattern match for same token', () => {
    // XYZQ is in the Item Master — extracted regardless of whether it looks Nokia
    const { itemTypes } = parseLabel('XYZQ unit', new Set(['XYZQ']));
    expect(itemTypes).toContain('XYZQ');
  });

  it('does not extract common English words as item type codes (CARE, SIDE)', () => {
    const { itemTypes } = parseLabel('FRAGILE\nHANDLE WITH CARE\nTHIS SIDE UP', new Set());
    expect(itemTypes).not.toContain('CARE');
    expect(itemTypes).not.toContain('SIDE');
    expect(itemTypes).not.toContain('HAND');
    expect(itemTypes).toHaveLength(0);
  });

  it('does not extract NOKIA or CHINA even if they match Nokia code length', () => {
    const { itemTypes } = parseLabel('NOKIA MADE IN CHINA', new Set(['NOKIA', 'CHINA']));
    expect(itemTypes).not.toContain('NOKIA');
    expect(itemTypes).not.toContain('CHINA');
  });

  it('extracts all three from label with 8-char token noise (NETWORKS stays out)', () => {
    const text = 'NOKIA NETWORKS\nFXDA\nP/N: 475266B.102';
    const { itemTypes } = parseLabel(text, new Set());
    expect(itemTypes).toContain('FXDA');
    expect(itemTypes).not.toContain('NETWORKS'); // 8 chars, not 4-letter code
    expect(itemTypes).not.toContain('NOKIA');    // in excluded list
  });
});

describe('Phase B — barcode+OCR merge (auto-snapshot scenario)', () => {
  it('MERGED: Nokia DataMatrix PN+SN + OCR type AHGA → correct provenance', () => {
    // This is the expected ground truth for the real Nokia AHGA carton:
    // DataMatrix decoded: PN=474254A.202, SN=1M241909797
    // OCR read from label: AHGA
    const r = mergeScanAndOcr({
      barcode: { serialNumber: '1M241909797', partNumber: '474254A.202', itemType: null },
      ocr: makeOcr({ itemType: 'AHGA' }),
    });
    expect(r.scenario).toBe('MERGED');
    expect(r.itemType).toBe('AHGA');
    expect(r.serialNumber).toBe('1M241909797');
    expect(r.partNumber).toBe('474254A.202');
    expect(r.source.itemType).toBe('OCR');
    expect(r.source.serialNumber).toBe('BARCODE');
    expect(r.source.partNumber).toBe('BARCODE');
    expect(r.confidence).toBe('HIGH');
    expect(r.conflicts).toHaveLength(0);
  });

  it('MERGED: OCR fills unknown item type — barcode PN/SN untouched', () => {
    const r = mergeScanAndOcr({
      barcode: { serialNumber: 'DH252030925', partNumber: '475266B.102', itemType: null },
      ocr: makeOcr({ itemType: 'ABIO', serialNumber: 'DH252030925' }),
    });
    expect(r.scenario).toBe('MERGED');
    expect(r.itemType).toBe('ABIO');
    expect(r.source.itemType).toBe('OCR');
    expect(r.source.serialNumber).toBe('BARCODE');
  });

  it('rapid scan: two entries each get their own OCR result (no cross-contamination)', () => {
    // Simulate two independent merges with different localIds/barcode data
    const r1 = mergeScanAndOcr({
      barcode: { serialNumber: '1M241909797', partNumber: '474254A.202', itemType: null },
      ocr: makeOcr({ itemType: 'AHGA' }),
    });
    const r2 = mergeScanAndOcr({
      barcode: { serialNumber: 'DH252030925', partNumber: '475266B.102', itemType: null },
      ocr: makeOcr({ itemType: 'ABIO' }),
    });
    // Each result is independent
    expect(r1.itemType).toBe('AHGA');
    expect(r1.serialNumber).toBe('1M241909797');
    expect(r2.itemType).toBe('ABIO');
    expect(r2.serialNumber).toBe('DH252030925');
  });

  it('OCR failure (null OCR) → BARCODE_ONLY, barcode data preserved', () => {
    const r = mergeScanAndOcr({
      barcode: { serialNumber: '1M241909797', partNumber: '474254A.202', itemType: null },
      ocr: null,
    });
    expect(r.scenario).toBe('BARCODE_ONLY');
    expect(r.serialNumber).toBe('1M241909797');
    expect(r.partNumber).toBe('474254A.202');
    expect(r.itemType).toBeNull();
  });

  it('unknown item type (not in Item Master) extracted as generic Nokia code', () => {
    // WXYZ is not in the Item Master but matches Nokia 4-letter code pattern
    const { itemTypes } = parseLabel('WXYZ outdoor unit P/N: 474254A.202', new Set());
    expect(itemTypes).toContain('WXYZ');
  });
});

// ── normalizeOcr() ────────────────────────────────────────────────────────────

describe('normalizeOcr() — digit/letter confusable substitution', () => {
  it('replaces 0 with O', () => expect(normalizeOcr('N0KIA')).toBe('NOKIA'));
  it('replaces 1 with I', () => expect(normalizeOcr('NOK1A')).toBe('NOKIA'));
  it('replaces both 0 and 1', () => expect(normalizeOcr('N0K1A')).toBe('NOKIA'));
  it('leaves clean strings unchanged', () => expect(normalizeOcr('AHGA')).toBe('AHGA'));
});

// ── fuzzyNoiseCheck() ─────────────────────────────────────────────────────────

describe('fuzzyNoiseCheck() — fuzzy noise rejection', () => {
  it('rejects OKIA — substring of NOKIA (dropped leading N)', () => {
    const r = fuzzyNoiseCheck('OKIA');
    expect(r).not.toBeNull();
    expect(r).toContain('NOKIA');
  });

  it('rejects NOKI — substring of NOKIA (dropped trailing A)', () => {
    const r = fuzzyNoiseCheck('NOKI');
    expect(r).not.toBeNull();
    expect(r).toContain('NOKIA');
  });

  it('rejects N0KIA (5 chars) via normalized exact match — but note: N0KIA never reaches Nokia 4-letter check due to length; test normalizeOcr directly', () => {
    // N0KIA normalizes to NOKIA: this is tested at the normalizeOcr level.
    // fuzzyNoiseCheck receives tokens already at ≤8 chars from ITEM_TYPE_TOKEN_RE.
    // If somehow a 4-char form like N0KI reaches here — check it:
    expect(fuzzyNoiseCheck('N0KI')).not.toBeNull(); // NOKI after norm → substring of NOKIA
  });

  it('rejects CHLNA — hamming distance 1 from CHINA (L vs I)', () => {
    const r = fuzzyNoiseCheck('CHLNA');
    expect(r).not.toBeNull();
    expect(r).toContain('CHINA');
  });

  it('accepts AHGA — not a noise word or corruption', () => {
    expect(fuzzyNoiseCheck('AHGA')).toBeNull();
  });

  it('accepts ABIO — not a noise word or corruption', () => {
    expect(fuzzyNoiseCheck('ABIO')).toBeNull();
  });

  it('accepts FXDA — not a noise word or corruption', () => {
    expect(fuzzyNoiseCheck('FXDA')).toBeNull();
  });

  it('accepts WXYZ — no match to any noise word', () => {
    expect(fuzzyNoiseCheck('WXYZ')).toBeNull();
  });
});

// ── parseLabel() with fuzzy noise rejection ───────────────────────────────────

describe('parseLabel() — fuzzy noise rejection integrated', () => {
  it('OKIA not extracted from label text (rejected as partial read of NOKIA)', () => {
    const { itemTypes, rejectedTokens } = parseLabel('OKIA outdoor unit', new Set());
    expect(itemTypes).not.toContain('OKIA');
    expect(rejectedTokens?.some(r => r.text === 'OKIA')).toBe(true);
    expect(rejectedTokens?.find(r => r.text === 'OKIA')?.reason).toContain('NOKIA');
  });

  it('CHLNA not extracted (hamming-1 corruption of CHINA)', () => {
    const { itemTypes } = parseLabel('CHLNA logistics', new Set());
    expect(itemTypes).not.toContain('CHLNA');
  });

  it('NOKI not extracted (substring of NOKIA)', () => {
    const { itemTypes } = parseLabel('NOKI network label', new Set());
    expect(itemTypes).not.toContain('NOKI');
  });

  it('REGRESSION — real Nokia AHGA carton with OKIA noise: AHGA accepted, OKIA rejected', () => {
    const text = [
      'OKIA',                          // OCR corruption of Nokia brand text (N dropped)
      'Nokia Solutions and Networks',
      'AHGA',                          // real equipment code — must be extracted
      'Part No: 474254A.202',
      'Serial No: 1M241909797',
      'Made in China',
    ].join('\n');
    const { itemTypes, rejectedTokens } = parseLabel(text, new Set());
    expect(itemTypes).toContain('AHGA');
    expect(itemTypes).not.toContain('OKIA');
    expect(rejectedTokens?.some(r => r.text === 'OKIA')).toBe(true);
  });

  it('REGRESSION — NOK1A noise: AHGA accepted, NOK1A not a 4-letter code so naturally dropped', () => {
    // NOK1A is 5 chars — ITEM_TYPE_TOKEN_RE captures it but NOKIA_EQUIP_CODE_RE
    // (/^[A-Z]{4}$/) rejects 5-char tokens. Verify AHGA still extracted.
    const text = 'NOK1A\nAHGA\nPart No: 474254A.202';
    const { itemTypes } = parseLabel(text, new Set());
    expect(itemTypes).toContain('AHGA');
    expect(itemTypes).not.toContain('NOK1A');
  });

  it('REGRESSION — N0KIA noise: same as NOK1A case (5 chars, filtered by pattern)', () => {
    const text = 'N0KIA Networks\nFXDA\nP/N: 474254A.202';
    const { itemTypes } = parseLabel(text, new Set());
    expect(itemTypes).toContain('FXDA');
    expect(itemTypes).not.toContain('N0KIA');
  });

  it('legitimate Nokia equipment codes still pass noise filter', () => {
    const { itemTypes } = parseLabel('ABIO FXDA FXEA AHGA equipment', new Set());
    expect(itemTypes).toContain('ABIO');
    expect(itemTypes).toContain('FXDA');
    expect(itemTypes).toContain('FXEA');
    expect(itemTypes).toContain('AHGA');
  });

  it('rejectedTokens populated for OKIA but not for AHGA', () => {
    const { itemTypes, rejectedTokens } = parseLabel('AHGA\nOKIA', new Set());
    expect(itemTypes).toContain('AHGA');
    expect(rejectedTokens?.map(r => r.text)).not.toContain('AHGA');
    expect(rejectedTokens?.map(r => r.text)).toContain('OKIA');
  });
});

// ── selectBestItemType() — candidate ranking and ambiguity ────────────────────

function makeDetail(text: string, overrides: Partial<OcrCandidateDetail> = {}): OcrCandidateDetail {
  return {
    text,
    passes:            ['A'],
    inItemMaster:      false,
    score:             30,
    accepted:          true,
    noiseRejected:     false,
    maxConf:           70,
    nearestMasterCode: null,
    nearestMasterDist: null,
    correctedToMaster: null,
    decisionReason:    'test candidate',
    ...overrides,
  };
}

function makeRejected(text: string, reason: string, passes: string[] = ['A']): OcrCandidateDetail {
  return {
    text, passes, inItemMaster: false, score: -1000, accepted: false, noiseRejected: true,
    rejectionReason: reason,
    maxConf: 0, nearestMasterCode: null, nearestMasterDist: null,
    correctedToMaster: null, decisionReason: `noise rejected: ${reason}`,
  };
}

describe('selectBestItemType() — candidate ranking', () => {
  it('single accepted candidate → selected, not ambiguous', () => {
    const { selectedItemType, isItemTypeAmbiguous } = selectBestItemType([
      makeDetail('AHGA', { passes: ['B', 'D'], score: 55 }),
    ]);
    expect(selectedItemType).toBe('AHGA');
    expect(isItemTypeAmbiguous).toBe(false);
  });

  it('Item Master match always wins regardless of score gap', () => {
    const { selectedItemType, isItemTypeAmbiguous } = selectBestItemType([
      makeDetail('AHGA', { score: 55, inItemMaster: true }),
      makeDetail('FXDA', { score: 50, inItemMaster: false }),
    ]);
    expect(selectedItemType).toBe('AHGA');
    expect(isItemTypeAmbiguous).toBe(false);
  });

  it('two unknown codes score gap ≥ 15 → clear winner', () => {
    const { selectedItemType, isItemTypeAmbiguous } = selectBestItemType([
      makeDetail('AHGA', { score: 55, passes: ['A', 'B', 'D'] }), // multi-pass + D bonus
      makeDetail('FXDA', { score: 30 }),
    ]);
    expect(selectedItemType).toBe('AHGA');
    expect(isItemTypeAmbiguous).toBe(false);
  });

  it('two unknown codes (single non-D pass) → insufficient evidence, not ambiguous', () => {
    // Both are single-pass unknown words — new policy: Case 4 → null, false (not ambiguous)
    const { selectedItemType, isItemTypeAmbiguous } = selectBestItemType([
      makeDetail('AHGA', { score: 40 }),  // passes=['A'] default
      makeDetail('FXDA', { score: 35 }),  // passes=['A'] default
    ]);
    expect(selectedItemType).toBeNull();
    expect(isItemTypeAmbiguous).toBe(false);
  });

  it('two unknown codes in Pass D within 15 pts → genuinely ambiguous', () => {
    // Both have Pass D (spatial evidence) but scores too close to pick one
    const { selectedItemType, isItemTypeAmbiguous } = selectBestItemType([
      makeDetail('AHGA', { score: 40, passes: ['D'] }),
      makeDetail('FXDA', { score: 35, passes: ['D'] }),
    ]);
    expect(selectedItemType).toBeNull();
    expect(isItemTypeAmbiguous).toBe(true);
  });

  it('REGRESSION — OKIA noise rejected, AHGA selected cleanly', () => {
    const { selectedItemType, isItemTypeAmbiguous } = selectBestItemType([
      makeDetail('AHGA', { passes: ['B', 'D'], score: 55 }),
      makeRejected('OKIA', 'partial read of "NOKIA"', ['A']),
    ]);
    expect(selectedItemType).toBe('AHGA');
    expect(isItemTypeAmbiguous).toBe(false);
  });

  it('REGRESSION — multi-pass AHGA (A+B+D) vs FXDA (A only): AHGA wins', () => {
    // AHGA in passes A, B, D: base 30 + multi-pass 20 + D bonus 15 = 65
    // FXDA in pass A only: base 30 = 30; gap = 35 ≥ 15 → AHGA wins
    const { selectedItemType } = selectBestItemType([
      makeDetail('AHGA', { passes: ['A', 'B', 'D'], score: 65 }),
      makeDetail('FXDA', { passes: ['A'], score: 30 }),
    ]);
    expect(selectedItemType).toBe('AHGA');
  });

  it('no accepted candidates → null, not ambiguous', () => {
    const { selectedItemType, isItemTypeAmbiguous } = selectBestItemType([
      makeRejected('OKIA', 'partial read of "NOKIA"'),
    ]);
    expect(selectedItemType).toBeNull();
    expect(isItemTypeAmbiguous).toBe(false);
  });

  it('empty list → null, not ambiguous', () => {
    const { selectedItemType, isItemTypeAmbiguous } = selectBestItemType([]);
    expect(selectedItemType).toBeNull();
    expect(isItemTypeAmbiguous).toBe(false);
  });
});

// ── mergeScanAndOcr() uses selectedItemType ───────────────────────────────────

describe('mergeScanAndOcr() — uses selectedItemType over itemTypeCandidates[0]', () => {
  it('REGRESSION — OKIA in itemTypeCandidates[0] but selectedItemType=AHGA → AHGA wins', () => {
    // Simulate what would have happened in the real test: OKIA first in candidates list
    // but selectedItemType correctly points to AHGA after ranking.
    const ocr: OcrResult = {
      rawText: 'OKIA\nAHGA\n474254A.202',
      itemTypeCandidates:  ['OKIA', 'AHGA'],  // old order — OKIA first
      selectedItemType:    'AHGA',              // ranking chose AHGA
      candidateDetails:    [],
      isItemTypeAmbiguous: false,
      partNumberCandidates:   ['474254A.202'],
      serialNumberCandidates: [],
      confidence: 72, source: 'OCR', durationMs: 4200,
    };
    const r = mergeScanAndOcr({
      barcode: { serialNumber: '1M241909797', partNumber: '474254A.202', itemType: null },
      ocr,
    });
    expect(r.itemType).toBe('AHGA');
    expect(r.itemType).not.toBe('OKIA');
  });

  it('ambiguous OCR → no itemType applied (selectedItemType null)', () => {
    const r = mergeScanAndOcr({
      barcode: { serialNumber: 'DH252030925', partNumber: '475266B.102', itemType: null },
      ocr: makeOcr({ isItemTypeAmbiguous: true }),  // no itemType in makeOcr → selectedItemType null
    });
    expect(r.itemType).toBeNull();
  });
});

// ── Item Master resolution — post-OCR merge (Issue 1) ────────────────────────
//
// Mirrors the corrected applyOcrByEntryId resolution logic:
//   1. Exact PN match (itemsByPN)       ← highest priority
//   2. Exact item_type / item_code match (itemsByCode)
//   No fuzzy matching at any step.

function makeItem(overrides: {
  id: string;
  item_code: string;
  item_name: string;
  item_type?: string | null;
  part_number?: string | null;
}): InventoryItem {
  return {
    id:               overrides.id,
    item_code:        overrides.item_code,
    item_name:        overrides.item_name,
    item_type:        overrides.item_type ?? null,
    manufacturer:     null,
    part_number:      overrides.part_number ?? null,
    category:         null,
    tracking_method:  'SERIALIZED',
    unit:             'pcs',
    is_active:        true,
    notes:            null,
    created_at:       '',
    updated_at:       '',
  };
}

function buildMaps(items: InventoryItem[]) {
  const byPN   = new Map<string, InventoryItem>();
  const byCode = new Map<string, InventoryItem>();
  for (const it of items) {
    if (it.part_number) byPN.set(it.part_number.toUpperCase(), it);
    byCode.set(it.item_code.toUpperCase(), it);
    if (it.item_type) byCode.set(it.item_type.toUpperCase(), it);
  }
  return { byPN, byCode };
}

// Pure resolution function — mirrors applyOcrByEntryId logic after the Issue 1 fix
function resolveAfterOcr(
  merged: { itemType: string | null; partNumber: string | null },
  byPN:   Map<string, InventoryItem>,
  byCode: Map<string, InventoryItem>,
): { rid: string | null; rname: string | null; rcode: string | null } {
  let rid: string | null = null, rname: string | null = null, rcode: string | null = null;
  if (merged.partNumber) {
    const it = byPN.get(merged.partNumber.toUpperCase());
    if (it) { rid = it.id; rname = it.item_name; rcode = it.item_code; }
  }
  if (!rid && merged.itemType) {
    const it = byCode.get(merged.itemType.toUpperCase());
    if (it) { rid = it.id; rname = it.item_name; rcode = it.item_code; }
  }
  return { rid, rname, rcode };
}

describe('Item Master resolution — post-OCR merge (Issue 1)', () => {
  const FXDA_ITEM = makeItem({ id: 'item-1', item_code: 'FXDA-00', item_name: 'FXDA Outdoor Unit',  item_type: 'FXDA', part_number: '475266B.102' });
  const ABIO_ITEM = makeItem({ id: 'item-2', item_code: 'ABIO-00', item_name: 'ABIO Module',         item_type: 'ABIO', part_number: null });
  const CODE_ONLY = makeItem({ id: 'item-3', item_code: 'AHGA',    item_name: 'AHGA Unit',           item_type: null,   part_number: null });

  it('item_type match → MATCHED (FXDA found via item_type)', () => {
    const { byPN, byCode } = buildMaps([FXDA_ITEM]);
    const { rid } = resolveAfterOcr({ itemType: 'FXDA', partNumber: null }, byPN, byCode);
    expect(rid).toBe('item-1');
  });

  it('item_code match → MATCHED (AHGA found via item_code when item_type is null on item)', () => {
    const { byPN, byCode } = buildMaps([CODE_ONLY]);
    const { rid } = resolveAfterOcr({ itemType: 'AHGA', partNumber: null }, byPN, byCode);
    expect(rid).toBe('item-3');
  });

  it('PN match takes priority over item_type match', () => {
    // PN=475266B.102 → FXDA_ITEM; itemType=ABIO → ABIO_ITEM; PN must win
    const { byPN, byCode } = buildMaps([FXDA_ITEM, ABIO_ITEM]);
    const { rid } = resolveAfterOcr({ itemType: 'ABIO', partNumber: '475266B.102' }, byPN, byCode);
    expect(rid).toBe('item-1');
  });

  it('resolvedItemId populated when item found via item_type', () => {
    const { byPN, byCode } = buildMaps([ABIO_ITEM]);
    const { rid } = resolveAfterOcr({ itemType: 'ABIO', partNumber: null }, byPN, byCode);
    expect(rid).not.toBeNull();
    expect(rid).toBe('item-2');
  });

  it('AHGA not in Item Master → rid is null (UNMATCHED, kept as TYPE display)', () => {
    const { byPN, byCode } = buildMaps([FXDA_ITEM, ABIO_ITEM]);
    const { rid } = resolveAfterOcr({ itemType: 'AHGA', partNumber: null }, byPN, byCode);
    expect(rid).toBeNull();
  });

  it('resolution is case-insensitive for item_type', () => {
    const { byPN, byCode } = buildMaps([FXDA_ITEM]);
    const { rid } = resolveAfterOcr({ itemType: 'fxda', partNumber: null }, byPN, byCode);
    expect(rid).toBe('item-1');
  });

  it('resolution is case-insensitive for PN', () => {
    const { byPN, byCode } = buildMaps([FXDA_ITEM]);
    const { rid } = resolveAfterOcr({ itemType: null, partNumber: '475266b.102' }, byPN, byCode);
    expect(rid).toBe('item-1');
  });

  it('no fuzzy matching — FXDX (one letter off FXDA) is not resolved', () => {
    const { byPN, byCode } = buildMaps([FXDA_ITEM]);
    const { rid } = resolveAfterOcr({ itemType: 'FXDX', partNumber: null }, byPN, byCode);
    expect(rid).toBeNull();
  });

  it('null itemType and null partNumber → not resolved', () => {
    const { byPN, byCode } = buildMaps([FXDA_ITEM]);
    const { rid } = resolveAfterOcr({ itemType: null, partNumber: null }, byPN, byCode);
    expect(rid).toBeNull();
  });

  it('REGRESSION — AHGA not in DB → rid null, itemType preserved in OCR merge result', () => {
    // Confirmed: AHGA is not in inventory_items. Result: item remains PENDING with TYPE shown.
    const { byPN, byCode } = buildMaps([]); // empty master
    const mergeResult = mergeScanAndOcr({
      barcode: { serialNumber: '1M241909797', partNumber: '474254A.202', itemType: null },
      ocr: makeOcr({ itemType: 'AHGA' }),
    });
    expect(mergeResult.itemType).toBe('AHGA'); // OCR type preserved
    const { rid } = resolveAfterOcr({ itemType: mergeResult.itemType, partNumber: mergeResult.partNumber }, byPN, byCode);
    expect(rid).toBeNull(); // UNMATCHED — not in master
  });

  it('REGRESSION — OKIA not resolved even if accidentally in master (noise rejection upstream)', () => {
    // fuzzyNoiseCheck rejects OKIA before it reaches resolution; simulate correctly rejected:
    const mergeResult = mergeScanAndOcr({
      barcode: { serialNumber: '1M241909797', partNumber: '474254A.202', itemType: null },
      ocr: {
        rawText: 'OKIA\nAHGA\n474254A.202',
        itemTypeCandidates:  ['OKIA', 'AHGA'],
        selectedItemType:    'AHGA', // ranking chose AHGA, not OKIA
        candidateDetails:    [],
        isItemTypeAmbiguous: false,
        partNumberCandidates:   ['474254A.202'],
        serialNumberCandidates: [],
        confidence: 72, source: 'OCR', durationMs: 4200,
      },
    });
    // AHGA is selectedItemType — OKIA is not passed to resolution
    expect(mergeResult.itemType).toBe('AHGA');
    expect(mergeResult.itemType).not.toBe('OKIA');
  });
});

// ── Confusion-correction is diagnostic only — ARGA must never auto-correct to AHGA ──────

describe('selectBestItemType() — confusion correction is diagnostic only', () => {
  // THE CRITICAL REGRESSION: printed label says ARGA, not AHGA.
  // Even though AHGA is in Item Master at confusionDistance=1, ARGA must stay ARGA.
  it('ARGA in Pass D (correctedToMaster=AHGA) → selects ARGA, NOT AHGA', () => {
    const { selectedItemType, isItemTypeAmbiguous } = selectBestItemType([
      makeDetail('ARGA', {
        passes: ['D'], score: 20,  // 5 (4-letter) + 15 (D-pass) = 20
        correctedToMaster: 'AHGA', nearestMasterCode: 'AHGA', nearestMasterDist: 1,
      }),
    ]);
    expect(selectedItemType).toBe('ARGA');  // OCR text preserved — NOT rewritten to AHGA
    expect(isItemTypeAmbiguous).toBe(false);
  });

  it('ARGA single non-D pass (correctedToMaster=AHGA) → null (insufficient evidence)', () => {
    // Single non-D pass with unknown word → Case 3: null, not ambiguous
    const { selectedItemType, isItemTypeAmbiguous } = selectBestItemType([
      makeDetail('ARGA', {
        passes: ['A'], score: 5,
        correctedToMaster: 'AHGA', nearestMasterCode: 'AHGA', nearestMasterDist: 1,
      }),
    ]);
    expect(selectedItemType).toBeNull();  // not enough evidence; no auto-correction
    expect(isItemTypeAmbiguous).toBe(false);
  });

  it('ARGA multi-pass (correctedToMaster=AHGA) → selects ARGA', () => {
    const { selectedItemType } = selectBestItemType([
      makeDetail('ARGA', {
        passes: ['A', 'B'], score: 15,  // 5 + 10(multi-pass)
        correctedToMaster: 'AHGA', nearestMasterCode: 'AHGA', nearestMasterDist: 1,
      }),
    ]);
    expect(selectedItemType).toBe('ARGA');
  });

  it('ARGA in Pass D beats REET noise — selects ARGA (not AHGA)', () => {
    const { selectedItemType, isItemTypeAmbiguous } = selectBestItemType([
      makeDetail('ARGA', { passes: ['D'], score: 20, correctedToMaster: 'AHGA' }),
      makeDetail('REET', { passes: ['A'], score: 5 }),
    ]);
    expect(selectedItemType).toBe('ARGA');  // OCR text, not the corrected master code
    expect(isItemTypeAmbiguous).toBe(false);
  });

  it('AHGA directly OCR-read + in master → selects AHGA (Case 1 exact master)', () => {
    // When the label actually says AHGA and Tesseract reads it correctly → normal path
    const { selectedItemType } = selectBestItemType([
      makeDetail('AHGA', { passes: ['B', 'C'], score: 120, inItemMaster: true }),
      makeDetail('ARGA', { passes: ['A'], score: 5, correctedToMaster: 'AHGA' }),
    ]);
    expect(selectedItemType).toBe('AHGA');  // Case 1 — direct master match always wins
  });
});

// ── REET / WHOS suppression (real 7-carton failures) ─────────────────────────

describe('selectBestItemType() — false-word suppression (REET, WHOS)', () => {
  it('REET single non-D pass → null (insufficient evidence, not ambiguous)', () => {
    const { selectedItemType, isItemTypeAmbiguous } = selectBestItemType([
      makeDetail('REET', { passes: ['A'], score: 10 }),
    ]);
    expect(selectedItemType).toBeNull();
    expect(isItemTypeAmbiguous).toBe(false);
  });

  it('WHOS single non-D pass → null (insufficient evidence)', () => {
    const { selectedItemType, isItemTypeAmbiguous } = selectBestItemType([
      makeDetail('WHOS', { passes: ['B'], score: 10 }),
    ]);
    expect(selectedItemType).toBeNull();
    expect(isItemTypeAmbiguous).toBe(false);
  });

  it('REET appears in Pass D → may select (spatial evidence, operator reviews)', () => {
    // If a label word appears in upper-right Nokia item-type area, trust it but keep PENDING
    const { selectedItemType } = selectBestItemType([
      makeDetail('REET', { passes: ['D'], score: 20 }),
    ]);
    expect(selectedItemType).toBe('REET');  // Case 3 — D pass, only candidate
  });

  it('REET does not beat a valid Item Master code even in Pass D', () => {
    const { selectedItemType } = selectBestItemType([
      makeDetail('AHGA', { passes: ['D'], score: 115, inItemMaster: true }),
      makeDetail('REET', { passes: ['D'], score: 20 }),
    ]);
    expect(selectedItemType).toBe('AHGA');  // Case 1 — master always wins
  });

  it('REET does not beat ARGA in Pass D — ARGA selected (correctedToMaster is diagnostic only)', () => {
    const { selectedItemType } = selectBestItemType([
      makeDetail('ARGA', { passes: ['D'], score: 20, correctedToMaster: 'AHGA' }),
      makeDetail('REET', { passes: ['A'], score: 5 }),
    ]);
    expect(selectedItemType).toBe('ARGA');  // OCR text wins, not the correction
  });

  it('unknown 4-letter word multi-pass → selects (consensus evidence)', () => {
    // An unknown code seen in A+B passes has multi-pass consensus
    const { selectedItemType } = selectBestItemType([
      makeDetail('XYZQ', { passes: ['A', 'B'], score: 20 }),
    ]);
    expect(selectedItemType).toBe('XYZQ');
  });
});

// ── 7-carton regression suite ─────────────────────────────────────────────────

describe('7-carton real-world regression (scoring system)', () => {
  // SUCCESSFUL cartons
  it('AHGA (master) in Pass D → auto-selects AHGA', () => {
    const { selectedItemType } = selectBestItemType([
      makeDetail('AHGA', { passes: ['B', 'D'], score: 130, inItemMaster: true }),
    ]);
    expect(selectedItemType).toBe('AHGA');
  });

  it('ABIA (master) in multiple passes → auto-selects ABIA', () => {
    const { selectedItemType } = selectBestItemType([
      makeDetail('ABIA', { passes: ['C', 'D'], score: 125, inItemMaster: true }),
    ]);
    expect(selectedItemType).toBe('ABIA');
  });

  it('ABIO (master) → auto-selects ABIO', () => {
    const { selectedItemType } = selectBestItemType([
      makeDetail('ABIO', { passes: ['B', 'C', 'D'], score: 140, inItemMaster: true }),
    ]);
    expect(selectedItemType).toBe('ABIO');
  });

  // FAILED cartons — should be improved
  it('ARGA + AHGA in master: AHGA dominates, ARGA is noise (realistic scores)', () => {
    // Realistic score: AHGA (master) = 100+D+multi-pass+conf ≈ 135; ARGA ≈ 5+pass
    const { selectedItemType } = selectBestItemType([
      makeDetail('AHGA', { passes: ['B', 'C', 'D'], score: 135, inItemMaster: true }),
      makeDetail('ARGA', { passes: ['A'], score: 12, correctedToMaster: 'AHGA' }),
    ]);
    expect(selectedItemType).toBe('AHGA');
  });

  it('ARGA alone (AHGA not read) → selects ARGA (correctedToMaster is diagnostic only)', () => {
    // Only ARGA appears in OCR. AHGA is in master at confusionDistance=1.
    // Policy: OCR text is validated, not rewritten. ARGA stays ARGA.
    const { selectedItemType } = selectBestItemType([
      makeDetail('ARGA', {
        passes: ['D'], score: 20,  // 5 + 15(D-pass)
        correctedToMaster: 'AHGA', nearestMasterCode: 'AHGA', nearestMasterDist: 1,
        inItemMaster: false,
      }),
    ]);
    expect(selectedItemType).toBe('ARGA');  // NOT 'AHGA' — printed text is the truth
  });

  it('REET alone → null (not auto-assigned)', () => {
    const { selectedItemType, isItemTypeAmbiguous } = selectBestItemType([
      makeDetail('REET', { passes: ['A'], score: 10 }),
    ]);
    expect(selectedItemType).toBeNull();
    expect(isItemTypeAmbiguous).toBe(false);
  });

  it('WHOS alone → null (not auto-assigned)', () => {
    const { selectedItemType, isItemTypeAmbiguous } = selectBestItemType([
      makeDetail('WHOS', { passes: ['A'], score: 10 }),
    ]);
    expect(selectedItemType).toBeNull();
    expect(isItemTypeAmbiguous).toBe(false);
  });

  it('ambiguous candidates (REET + WHOS, both non-D single pass) → null, not ambiguous', () => {
    const { selectedItemType, isItemTypeAmbiguous } = selectBestItemType([
      makeDetail('REET', { passes: ['A'], score: 10 }),
      makeDetail('WHOS', { passes: ['A'], score: 9 }),
    ]);
    expect(selectedItemType).toBeNull();
    expect(isItemTypeAmbiguous).toBe(false);
  });

  it('unknown legitimate code not in master (multi-pass) → selected, PENDING (not auto-matched)', () => {
    // e.g. a new equipment type not yet in master — shows TYPE: XXXX [OCR], stays PENDING
    const { selectedItemType, isItemTypeAmbiguous } = selectBestItemType([
      makeDetail('XXXX', { passes: ['B', 'D'], score: 30, inItemMaster: false }),
    ]);
    expect(selectedItemType).toBe('XXXX');  // selected for display, will be PENDING in scan entry
    expect(isItemTypeAmbiguous).toBe(false);
  });

  it('OKIA must never beat AHGA (master) regardless of pass order', () => {
    const { selectedItemType } = selectBestItemType([
      makeRejected('OKIA', 'partial read of "NOKIA"', ['A']),
      makeDetail('AHGA', { passes: ['D'], score: 115, inItemMaster: true }),
    ]);
    expect(selectedItemType).toBe('AHGA');
  });

  it('text-only label: AHGA alone in master → resolves when OCR reads it directly', () => {
    // Full OCR extraction via parseLabel — confirmed by existing parseLabel tests
    const { itemTypes } = parseLabel('AHGA\nP/N: 474254A.202\nS/N: 1M241909797', new Set(['AHGA']));
    expect(itemTypes).toContain('AHGA');
  });
});

// ── 10 mandatory regressions — ARGA/AHGA no-auto-correction policy ────────────
//
// These tests encode the real-world acceptance criteria from the ARGA carton
// (PN: 474800A.102, SN: K9241817927). ARGA must never silently become AHGA.

describe('REGRESSION — confusion correction diagnostic-only policy', () => {
  const AHGA_ITEM = makeItem({ id: 'ahga-1', item_code: 'AHGA', item_name: 'AHGA Radio Module', item_type: 'AHGA' });
  const ARGA_ITEM = makeItem({ id: 'arga-1', item_code: 'ARGA', item_name: 'ARGA Unit',          item_type: 'ARGA' });

  // 1. OCR=ARGA, master has AHGA only → selectedItemType=ARGA; resolution must NOT return AHGA's id
  it('R1: OCR=ARGA, master has AHGA only → selected=ARGA, rid=null (NOT AHGA\'s id)', () => {
    const { selectedItemType } = selectBestItemType([
      makeDetail('ARGA', { passes: ['D'], score: 20, correctedToMaster: 'AHGA',
        nearestMasterCode: 'AHGA', nearestMasterDist: 1, inItemMaster: false }),
    ]);
    expect(selectedItemType).toBe('ARGA');

    // Resolution must NOT look up correctedToMaster — only exact OCR text
    const { byPN, byCode } = buildMaps([AHGA_ITEM]);
    const { rid } = resolveAfterOcr({ itemType: selectedItemType, partNumber: null }, byPN, byCode);
    expect(rid).toBeNull();  // ARGA not in master → PENDING, not auto-matched to AHGA
  });

  // 2. ARGA in 3 passes (A,B,D), AHGA not OCR'd → ARGA selected (strong consensus)
  it('R2: ARGA in passes A+B+D → selected=ARGA (strong multi-pass+D consensus)', () => {
    const { selectedItemType } = selectBestItemType([
      makeDetail('ARGA', { passes: ['A', 'B', 'D'], score: 30, inItemMaster: false }),
    ]);
    expect(selectedItemType).toBe('ARGA');
  });

  // 3. AHGA in 3 passes (directly OCR'd), ARGA once → AHGA wins (direct master match)
  it('R3: AHGA directly read in B+C+D (master), ARGA once in A → AHGA wins (Case 1)', () => {
    const { selectedItemType } = selectBestItemType([
      makeDetail('AHGA', { passes: ['B', 'C', 'D'], score: 130, inItemMaster: true }),
      makeDetail('ARGA', { passes: ['A'], score: 5, correctedToMaster: 'AHGA' }),
    ]);
    expect(selectedItemType).toBe('AHGA');
  });

  // 4. ARGA and AHGA with comparable D-pass evidence → ambiguous (can't pick either)
  it('R4: ARGA in D (unknown) vs AHGA in D (master) → master wins (Case 1 over Case 2)', () => {
    const { selectedItemType } = selectBestItemType([
      makeDetail('AHGA', { passes: ['D'], score: 115, inItemMaster: true }),
      makeDetail('ARGA', { passes: ['D'], score: 20, correctedToMaster: 'AHGA' }),
    ]);
    expect(selectedItemType).toBe('AHGA');
  });

  // 5. Exact OCR AHGA + AHGA in master → MATCHED via item_type
  it('R5: exact OCR AHGA + AHGA in master → rid resolved', () => {
    const { byPN, byCode } = buildMaps([AHGA_ITEM]);
    const { selectedItemType } = selectBestItemType([
      makeDetail('AHGA', { passes: ['B', 'D'], score: 130, inItemMaster: true }),
    ]);
    expect(selectedItemType).toBe('AHGA');
    const { rid } = resolveAfterOcr({ itemType: selectedItemType, partNumber: null }, byPN, byCode);
    expect(rid).toBe('ahga-1');
  });

  // 6. Exact OCR ARGA + ARGA in master → MATCHED via item_type (not confused)
  it('R6: exact OCR ARGA + ARGA in master → rid resolved to ARGA item', () => {
    const { byPN, byCode } = buildMaps([ARGA_ITEM]);
    const { selectedItemType } = selectBestItemType([
      makeDetail('ARGA', { passes: ['B', 'D'], score: 130, inItemMaster: true }),
    ]);
    expect(selectedItemType).toBe('ARGA');
    const { rid } = resolveAfterOcr({ itemType: selectedItemType, partNumber: null }, byPN, byCode);
    expect(rid).toBe('arga-1');
  });

  // 7. OCR=ARGA, ARGA NOT in master → selectedItemType=ARGA preserved, rid=null (PENDING)
  it('R7: OCR=ARGA, ARGA not in master → TYPE ARGA preserved, rid=null (PENDING)', () => {
    const { selectedItemType } = selectBestItemType([
      makeDetail('ARGA', { passes: ['D'], score: 20, inItemMaster: false }),
    ]);
    expect(selectedItemType).toBe('ARGA');

    const { byPN, byCode } = buildMaps([]);  // empty master
    const { rid } = resolveAfterOcr({ itemType: selectedItemType, partNumber: null }, byPN, byCode);
    expect(rid).toBeNull();
  });

  // 8. OKIA noise still rejected upstream (not a selectBestItemType concern, but verified)
  it('R8: OKIA noise rejected by fuzzyNoiseCheck — does not reach selectBestItemType', () => {
    expect(fuzzyNoiseCheck('OKIA')).not.toBeNull();
  });

  // 9. REET/WHOS low-evidence (single non-D pass) → null, not auto-assigned
  it('R9: REET single non-D pass → null; WHOS single non-D pass → null', () => {
    const r1 = selectBestItemType([makeDetail('REET', { passes: ['A'], score: 5 })]);
    expect(r1.selectedItemType).toBeNull();
    expect(r1.isItemTypeAmbiguous).toBe(false);
    const r2 = selectBestItemType([makeDetail('WHOS', { passes: ['B'], score: 5 })]);
    expect(r2.selectedItemType).toBeNull();
    expect(r2.isItemTypeAmbiguous).toBe(false);
  });

  // 10. PN/SN from barcode are never rewritten by OCR correction logic
  it('R10: PN and SN from Nokia DataMatrix barcode pass through merge unchanged', () => {
    const r = mergeScanAndOcr({
      barcode: { serialNumber: 'K9241817927', partNumber: '474800A.102', itemType: null },
      ocr: makeOcr({ itemType: 'ARGA' }),  // OCR sees ARGA (not AHGA)
    });
    expect(r.serialNumber).toBe('K9241817927');  // barcode SN unchanged
    expect(r.partNumber).toBe('474800A.102');    // barcode PN unchanged
    expect(r.itemType).toBe('ARGA');             // OCR type is ARGA, not auto-corrected
    expect(r.source.serialNumber).toBe('BARCODE');
    expect(r.source.partNumber).toBe('BARCODE');
  });
});
