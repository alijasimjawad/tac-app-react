import { describe, it, expect } from 'vitest';
import {
  normalizePn,
  isMappingEligible,
  detectMappingConflict,
  filterAndDeduplicateMappings,
  type MappingEligible,
} from './pnMapping';

// ── normalizePn() ─────────────────────────────────────────────────────────────

describe('normalizePn()', () => {
  it('uppercases and trims a mixed-case PN', () => {
    expect(normalizePn('474800a.102')).toBe('474800A.102');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizePn('  474800A.102  ')).toBe('474800A.102');
  });

  it('already-normalized PN is unchanged', () => {
    expect(normalizePn('474800A.102')).toBe('474800A.102');
  });
});

// ── isMappingEligible() ───────────────────────────────────────────────────────

describe('isMappingEligible()', () => {
  const valid: MappingEligible = {
    status: 'VALID', partNumber: '474800A.102',
    resolvedItemId: 'item-uuid', resolvedItemCode: 'ABIO', resolvedItemName: 'ABIO Radio Unit',
  };

  it('returns true for a fully resolved VALID entry', () => {
    expect(isMappingEligible(valid)).toBe(true);
  });

  it('returns false when status is PENDING', () => {
    expect(isMappingEligible({ ...valid, status: 'PENDING' })).toBe(false);
  });

  it('returns false when partNumber is null', () => {
    expect(isMappingEligible({ ...valid, partNumber: null })).toBe(false);
  });

  it('returns false when resolvedItemId is null', () => {
    expect(isMappingEligible({ ...valid, resolvedItemId: null })).toBe(false);
  });
});

// ── detectMappingConflict() ───────────────────────────────────────────────────

describe('detectMappingConflict()', () => {
  it('returns false when both IDs are the same item', () => {
    expect(detectMappingConflict('item-a', 'item-a')).toBe(false);
  });

  it('returns true when mapped and OCR resolve to different items', () => {
    expect(detectMappingConflict('item-a', 'item-b')).toBe(true);
  });

  it('returns false when ocrItemId is null (OCR found nothing)', () => {
    expect(detectMappingConflict('item-a', null)).toBe(false);
  });

  it('returns false when mappedItemId is null', () => {
    expect(detectMappingConflict(null, 'item-b')).toBe(false);
  });
});

// ── filterAndDeduplicateMappings() ───────────────────────────────────────────

const makeEntry = (
  pn: string,
  itemId = 'item-uuid',
  status = 'VALID',
): MappingEligible => ({
  status,
  partNumber:       pn,
  resolvedItemId:   itemId,
  resolvedItemCode: 'ABIO',
  resolvedItemName: 'ABIO Radio Unit',
});

describe('filterAndDeduplicateMappings()', () => {
  it('returns an empty result for an empty entry list', () => {
    const result = filterAndDeduplicateMappings([], new Map());
    expect(result.candidates).toHaveLength(0);
    expect(result.skippedAlreadyLearned).toBe(0);
  });

  it('returns one candidate for a single eligible entry', () => {
    const result = filterAndDeduplicateMappings(
      [makeEntry('474800A.102')],
      new Map(),
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].partNumber).toBe('474800A.102');
    expect(result.candidates[0].itemId).toBe('item-uuid');
    expect(result.skippedAlreadyLearned).toBe(0);
  });

  it('deduplicates two entries with identical PN — first wins', () => {
    const entries = [makeEntry('474800A.102', 'item-a'), makeEntry('474800A.102', 'item-b')];
    const result = filterAndDeduplicateMappings(entries, new Map());
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].itemId).toBe('item-a');
  });

  it('deduplicates case-insensitively (474800A.102 vs 474800a.102)', () => {
    const entries = [makeEntry('474800A.102'), makeEntry('474800a.102')];
    const result = filterAndDeduplicateMappings(entries, new Map());
    expect(result.candidates).toHaveLength(1);
  });

  it('skips entries already in learnedMap and increments counter', () => {
    const learnedMap = new Map([['474800A.102', {}]]);
    const result = filterAndDeduplicateMappings([makeEntry('474800A.102')], learnedMap);
    expect(result.candidates).toHaveLength(0);
    expect(result.skippedAlreadyLearned).toBe(1);
  });

  it('learnedMap lookup is case-insensitive (key already normalized)', () => {
    const learnedMap = new Map([['474800A.102', {}]]);  // already normalized
    const result = filterAndDeduplicateMappings([makeEntry('474800a.102')], learnedMap);
    expect(result.candidates).toHaveLength(0);
    expect(result.skippedAlreadyLearned).toBe(1);
  });

  it('skips PENDING entries', () => {
    const result = filterAndDeduplicateMappings(
      [makeEntry('474800A.102', 'item-uuid', 'PENDING')],
      new Map(),
    );
    expect(result.candidates).toHaveLength(0);
    expect(result.skippedAlreadyLearned).toBe(0);
  });

  it('handles mixed eligible / ineligible entries correctly', () => {
    const entries: MappingEligible[] = [
      makeEntry('474800A.102', 'item-a'),
      { ...makeEntry('474800X.999'), status: 'PENDING' },        // ineligible
      makeEntry('474800B.200', 'item-b'),
      makeEntry('474800A.102', 'item-c'),                        // dup of first
    ];
    const learnedMap = new Map([['474800B.200', {}]]);           // already learned
    const result = filterAndDeduplicateMappings(entries, learnedMap);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].partNumber).toBe('474800A.102');
    expect(result.candidates[0].itemId).toBe('item-a');
    expect(result.skippedAlreadyLearned).toBe(1);
  });
});
