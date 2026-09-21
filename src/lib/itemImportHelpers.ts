// ── Item Master Excel Import — pure (DOM-free) logic ───────────────────────────
//
// Detects the relevant columns from an arbitrary Excel/CSV header row, dedupes
// rows down to one entry per item code, and diffs against already-existing
// item codes so only genuinely new items get created. All file reading and
// Supabase I/O live in WarehouseInventory.tsx — this module is pure logic,
// kept separate for testability (same convention as smrHelpers.ts).

export interface DetectedColumns {
  codeKey:   string | null;
  nameKey:   string | null;
  serialKey: string | null;
}

const CODE_HEADER_ALIASES   = ['item code', 'itemcode', 'code', 'material code', 'material', 'part number', 'partnumber', 'pn'];
const NAME_HEADER_ALIASES   = ['item description', 'itemdescription', 'description', 'item name', 'itemname', 'name', 'material description'];
const SERIAL_HEADER_ALIASES = ['serial number', 'serialnumber', 'serial no', 'serialno', 'serial', 'sn'];

function normHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[_.]/g, ' ').replace(/\s+/g, ' ');
}

/** Finds the best-matching header for code / name / serial columns, case- and punctuation-insensitive. */
export function detectColumns(headers: string[]): DetectedColumns {
  const norm = headers.map(h => ({ raw: h, n: normHeader(h) }));
  const find = (aliases: string[]) => norm.find(h => aliases.includes(h.n))?.raw ?? null;
  return {
    codeKey:   find(CODE_HEADER_ALIASES),
    nameKey:   find(NAME_HEADER_ALIASES),
    serialKey: find(SERIAL_HEADER_ALIASES),
  };
}

export interface ImportItemRow {
  item_code:       string;
  item_name:       string;
  part_number:     string;
  tracking_method: 'SERIALIZED' | 'QUANTITY';
  unit:            string;
  sourceRowCount:  number;
}

export interface ImportPreview {
  totalRows:        number;
  uniqueCodes:       number;
  newItems:         ImportItemRow[];
  existingSkipped:  number;
  invalidRows:      number;  // rows with no usable code
  hasSerialColumn:  boolean;
}

/**
 * Dedupes raw sheet rows by item code (case-insensitive, trimmed), picks the
 * longest non-empty description seen for each code, infers tracking method
 * from whether a Serial Number column is present (per-unit serial data implies
 * SERIALIZED tracking; otherwise defaults to QUANTITY), and splits the result
 * into items to create vs. codes that already exist in the item master.
 *
 * existingCodes must already be normalized to UPPER(TRIM(...)) form.
 */
export function buildImportPreview(
  rows:          Record<string, unknown>[],
  columns:       DetectedColumns,
  existingCodes: Set<string>,
): ImportPreview {
  const hasSerialColumn = !!columns.serialKey;
  const trackingMethod: 'SERIALIZED' | 'QUANTITY' = hasSerialColumn ? 'SERIALIZED' : 'QUANTITY';

  const byCode = new Map<string, { name: string; count: number }>();
  let invalidRows = 0;

  for (const row of rows) {
    const rawCode = columns.codeKey ? row[columns.codeKey] : null;
    const code = rawCode != null ? String(rawCode).trim().toUpperCase() : '';
    if (!code) { invalidRows++; continue; }

    const rawName = columns.nameKey ? row[columns.nameKey] : null;
    const name = rawName != null ? String(rawName).trim() : '';

    const existing = byCode.get(code);
    if (existing) {
      existing.count++;
      if (name && name.length > existing.name.length) existing.name = name;
    } else {
      byCode.set(code, { name, count: 1 });
    }
  }

  const newItems: ImportItemRow[] = [];
  let existingSkipped = 0;
  for (const [code, info] of byCode) {
    if (existingCodes.has(code)) { existingSkipped++; continue; }
    newItems.push({
      item_code:       code,
      item_name:       info.name || code,
      part_number:     code,
      tracking_method: trackingMethod,
      unit:            'pcs',
      sourceRowCount:  info.count,
    });
  }
  newItems.sort((a, b) => a.item_code.localeCompare(b.item_code));

  return {
    totalRows: rows.length,
    uniqueCodes: byCode.size,
    newItems,
    existingSkipped,
    invalidRows,
    hasSerialColumn,
  };
}
