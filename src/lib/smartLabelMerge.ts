// Merge engine: combines barcode parse results with OCR label results.
//
// Priority rules:
//   PN, SN → Barcode wins when both sources have a value (barcode > OCR)
//   ItemType → OCR is primary (Nokia barcodes don't encode item type)
//
// Conflicts are flagged (not silently resolved) so the operator can review.

import type { OcrResult } from './labelOcr';

export interface BarcodeSource {
  serialNumber: string | null;
  partNumber:   string | null;
  itemType:     string | null;
}

export interface MergeInput {
  barcode: BarcodeSource | null;
  ocr:     OcrResult | null;
}

export type MergeScenario = 'BARCODE_ONLY' | 'OCR_ONLY' | 'MERGED' | 'CONFLICT';
export type FieldSource   = 'BARCODE' | 'OCR';

export interface MergedResult {
  serialNumber: string | null;
  partNumber:   string | null;
  itemType:     string | null;
  source: {
    serialNumber: FieldSource | null;
    partNumber:   FieldSource | null;
    itemType:     FieldSource | null;
  };
  conflicts:  string[];
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  scenario:   MergeScenario;
}

export function mergeScanAndOcr({ barcode, ocr }: MergeInput): MergedResult {
  const bSN = barcode?.serialNumber ?? null;
  const bPN = barcode?.partNumber   ?? null;
  const bIT = barcode?.itemType     ?? null;

  const oSN = ocr?.serialNumberCandidates[0] ?? null;
  const oPN = ocr?.partNumberCandidates[0]   ?? null;
  const oIT = ocr?.itemTypeCandidates[0]     ?? null;

  const conflicts: string[] = [];

  // Conflict = both sources provide a value AND they disagree (case-insensitive)
  if (bPN && oPN && bPN.toUpperCase() !== oPN.toUpperCase()) {
    conflicts.push(`PN conflict: barcode=${bPN} vs OCR=${oPN}`);
  }
  if (bSN && oSN && bSN.toUpperCase() !== oSN.toUpperCase()) {
    conflicts.push(`SN conflict: barcode=${bSN} vs OCR=${oSN}`);
  }

  // Merge: barcode > OCR for PN/SN; OCR > barcode for ItemType
  const serialNumber = bSN ?? oSN;
  const partNumber   = bPN ?? oPN;
  const itemType     = oIT ?? bIT;

  const source: MergedResult['source'] = {
    serialNumber: bSN ? 'BARCODE' : oSN ? 'OCR' : null,
    partNumber:   bPN ? 'BARCODE' : oPN ? 'OCR' : null,
    itemType:     oIT ? 'OCR'     : bIT ? 'BARCODE' : null,
  };

  const hasBarcode = barcode != null;
  const hasOcr     = ocr     != null;
  const scenario: MergeScenario =
    conflicts.length > 0 ? 'CONFLICT'    :
    hasBarcode && hasOcr ? 'MERGED'       :
    hasBarcode           ? 'BARCODE_ONLY' : 'OCR_ONLY';

  const confidence: MergedResult['confidence'] =
    conflicts.length > 0       ? 'LOW'    :
    scenario === 'MERGED'      ? 'HIGH'   :
    serialNumber && partNumber ? 'HIGH'   :
    serialNumber || partNumber ? 'MEDIUM' : 'LOW';

  return { serialNumber, partNumber, itemType, source, conflicts, confidence, scenario };
}
