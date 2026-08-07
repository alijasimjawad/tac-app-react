import { describe, it, expect } from 'vitest';
import { parseLabel } from './labelOcr';
import { mergeScanAndOcr } from './smartLabelMerge';
import type { OcrResult } from './labelOcr';

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
} = {}): OcrResult {
  return {
    rawText: 'test label text',
    itemTypeCandidates:     overrides.itemType     ? [overrides.itemType]     : [],
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
