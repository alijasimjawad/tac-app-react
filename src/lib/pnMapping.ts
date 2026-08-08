// ── Learned PN → Inventory Item Mapping — pure (DOM-free) logic ───────────────
//
// Manages the lifecycle of learned part-number mappings. All DB I/O and React
// state live in WarehouseReceive.tsx; this module contains only the pure logic
// for filtering, deduplication, and conflict detection.

export const MAPPING_SOURCE_RECEIVING              = 'RECEIVING';
export const MAPPING_CODE_TYPE_PN                  = 'PART_NUMBER';
export const MAPPING_CODE_TYPE_GENERIC_IDENTIFIER  = 'GENERIC_IDENTIFIER';

/** Canonical form used as the map key and stored in the DB via UPPER(TRIM(...)). */
export function normalizePn(pn: string): string {
  return pn.trim().toUpperCase();
}

/** Minimum shape required by filterAndDeduplicateMappings / isMappingEligible. */
export interface MappingEligible {
  status:           string;
  partNumber:       string | null;
  resolvedItemId:   string | null;
  resolvedItemCode: string | null;
  resolvedItemName: string | null;
}

export interface LearningCandidate {
  partNumber: string;
  itemId:     string;
  itemCode:   string;
  itemName:   string;
}

export interface FilterResult {
  candidates:            LearningCandidate[];
  skippedAlreadyLearned: number;
}

/**
 * True when an entry is eligible to produce a learned mapping:
 *   - status must be VALID (user confirmed or system resolved)
 *   - must have both a partNumber and a resolved item
 */
export function isMappingEligible(entry: MappingEligible): boolean {
  return entry.status === 'VALID' && !!entry.partNumber && !!entry.resolvedItemId;
}

/**
 * Returns true when a learned mapping's resolved item disagrees with the item
 * that OCR independently resolved. Both IDs must be non-null for a conflict.
 */
export function detectMappingConflict(
  mappedItemId: string | null,
  ocrItemId:    string | null,
): boolean {
  if (!mappedItemId || !ocrItemId) return false;
  return mappedItemId !== ocrItemId;
}

/**
 * From a list of valid entries, derive the minimal set of (PN → item) rows that
 * should be upserted as learned mappings:
 *   1. Skip ineligible entries (not VALID, no PN, no resolved item).
 *   2. Deduplicate by normalized PN within the batch — first occurrence wins.
 *   3. Skip PNs already in learnedMap (already persisted in a prior session).
 *
 * learnedMap keys must be already-normalized (normalizePn form).
 */
export function filterAndDeduplicateMappings(
  entries:    MappingEligible[],
  learnedMap: Map<string, unknown>,
): FilterResult {
  const seen  = new Set<string>();
  const candidates: LearningCandidate[] = [];
  let skippedAlreadyLearned = 0;

  for (const e of entries) {
    if (!isMappingEligible(e)) continue;
    const key = normalizePn(e.partNumber!);
    if (seen.has(key)) continue;
    seen.add(key);
    if (learnedMap.has(key)) { skippedAlreadyLearned++; continue; }
    candidates.push({
      partNumber: e.partNumber!,
      itemId:     e.resolvedItemId!,
      itemCode:   e.resolvedItemCode ?? '',
      itemName:   e.resolvedItemName ?? '',
    });
  }

  return { candidates, skippedAlreadyLearned };
}
