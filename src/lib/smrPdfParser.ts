// ── Customer SMR PDF Parser ─────────────────────────────────────────────────
//
// Best-effort extraction of an SMR (Stock Requisition) PDF into structured
// header fields + line items. This is deliberately "best-effort, not
// authoritative": WarehouseSmr.tsx always shows the result in an editable
// review table before anything is saved, per the locked-in design decision —
// a wrong or missing field here is a UX inconvenience, never silent data loss.
//
// Calibrated against a real sample (Zain "S.R" form, S.R No. BN2074, form
// type OUT): header block of label/value pairs (S.R No, WH Name, Form Type,
// Date, Requester Name/Department/Phone, Site Code, Project, SUB), followed
// by a line-item table with columns Index | product number | Item
// Description | Accepted Qty | serial number | Comments. The "serial number"
// column on the PDF is a 0/1 flag, not an actual serial — real SNs are
// captured later via camera scan at the customer's warehouse.
//
// Architecture: PDF text streams don't preserve reading order, so naive
// string extraction produces jumbled output. pdfjs-dist's getTextContent()
// exposes each glyph run's page position (item.transform), which lets us
// reconstruct rows (cluster by y) and columns (bin by x against a detected
// header row) — the standard technique for extracting tabular data from PDFs
// without OCR. All of that positional-reconstruction logic below is pure
// (operates on plain {str,x,y} arrays) and unit-tested without touching
// pdfjs-dist itself. Only extractSmrFromPdf() at the bottom actually loads
// pdfjs-dist and a real file, mirroring how warehouseScanner.ts keeps
// CameraScanner's real device I/O separate from its pure parseScan/classifyScan
// helpers in the same file.

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PositionedTextItem {
  str:   string;
  x:     number; // item.transform[4] — left edge of the glyph run
  y:     number; // item.transform[5] — baseline (PDF y grows upward)
  width: number;
}

export interface TextRow {
  y:     number;
  items: PositionedTextItem[]; // sorted left-to-right
  text:  string;               // items joined with single spaces, for regex matching
}

export interface ExtractedSmrHeader {
  smrNumber:           string | null;
  customerName:        string | null;
  sourceWarehouseName: string | null;
  formType:            string | null;
  srDateRaw:           string | null;
  requesterName:       string | null;
  requesterDepartment: string | null;
  requesterPhone:      string | null;
  siteCode:            string | null;
  projectNameRaw:      string | null;
  subReference:        string | null;
}

export interface ParsedSmrLineCandidate {
  lineIndex:         number;
  productNumberRaw:  string | null;
  descriptionRaw:    string | null;
  expectedQty:       number;
  hasSerialFlag:     boolean;
  poReference:       string | null;
}

export interface ExtractedSmrResult {
  header:   ExtractedSmrHeader;
  lines:    ParsedSmrLineCandidate[];
  warnings: string[];
}

const EMPTY_HEADER: ExtractedSmrHeader = {
  smrNumber: null, customerName: null, sourceWarehouseName: null, formType: null,
  srDateRaw: null, requesterName: null, requesterDepartment: null, requesterPhone: null,
  siteCode: null, projectNameRaw: null, subReference: null,
};

// ── Row reconstruction (pure) ─────────────────────────────────────────────────

/**
 * Clusters raw positioned glyph runs into visual rows (same baseline, within
 * yTolerance points), sorted top-to-bottom then left-to-right — i.e. natural
 * reading order for a left-to-right table layout.
 */
export function groupTextItemsIntoRows(items: PositionedTextItem[], yTolerance = 3): TextRow[] {
  const rows: TextRow[] = [];

  for (const item of items) {
    if (!item.str.trim()) continue;
    const row = rows.find(r => Math.abs(r.y - item.y) <= yTolerance);
    if (row) {
      row.items.push(item);
    } else {
      rows.push({ y: item.y, items: [item], text: '' });
    }
  }

  rows.sort((a, b) => b.y - a.y); // PDF y grows upward → descending y = top to bottom
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    row.text = row.items.map(i => i.str.trim()).filter(Boolean).join(' ');
  }
  return rows;
}

// ── Header field extraction (pure) ────────────────────────────────────────────

const HEADER_PATTERNS: Array<{ field: keyof ExtractedSmrHeader; regex: RegExp }> = [
  { field: 'smrNumber',           regex: /S\.?\s?R\.?\s*No\.?\s*[:\-]?\s*([A-Z]{1,4}\d{3,8})/i },
  { field: 'sourceWarehouseName', regex: /WH\s*Name\s*[:\-]?\s*([A-Za-z][A-Za-z .]{1,30})/i },
  { field: 'formType',            regex: /Form\s*Type\s*[:\-]?\s*([A-Za-z]+)/i },
  { field: 'srDateRaw',           regex: /Date\s*[:\-]?\s*(\d{1,2}[-\/][A-Za-z]{3,9}[-\/]\d{2,4}|\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})/i },
  { field: 'requesterName',       regex: /Requester\s*(?:Name)?\s*[:\-]?\s*([A-Za-z][A-Za-z .]{2,40}?)(?=\s*(?:\(|Department|Phone|$))/i },
  { field: 'requesterDepartment', regex: /(?:Department|Dept\.?)\s*[:\-]?\s*\(?([A-Za-z][A-Za-z \-\/]{2,40}?)\)?(?=\s*(?:Phone|$))/i },
  { field: 'requesterPhone',      regex: /(?:Phone|Mobile|Tel)\.?\s*[:\-]?\s*(\+?\d[\d \-]{6,15}\d)/i },
  { field: 'siteCode',            regex: /Site\s*Code\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9 ]{1,30})/i },
  { field: 'projectNameRaw',      regex: /Project\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9 .\-\/]{2,60})/i },
  { field: 'subReference',        regex: /\bSUB\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9 \-]{1,30})/i },
];

/** Scans reconstructed rows for known label/value patterns. First match per field wins. */
export function extractHeaderFields(rows: TextRow[]): ExtractedSmrHeader {
  const header: ExtractedSmrHeader = { ...EMPTY_HEADER };

  for (const row of rows) {
    for (const { field, regex } of HEADER_PATTERNS) {
      if (header[field] !== null) continue;
      const match = row.text.match(regex);
      if (match?.[1]) header[field] = match[1].trim();
    }
  }
  return header;
}

// ── Line-item table location + parsing (pure) ─────────────────────────────────

const TABLE_HEADER_REQUIRED_KEYWORDS = [/index/i, /(item\s*)?description/i, /(accepted\s*)?qty|quantity/i];
const TABLE_TERMINATOR_PATTERN = /approval|storekeeper|received\s*by|prepared\s*by|authorized\s*by/i;

/** Finds the row that looks like the line-item table's column header. */
export function findLineItemTableHeaderRow(rows: TextRow[]): TextRow | null {
  return rows.find(r => TABLE_HEADER_REQUIRED_KEYWORDS.every(kw => kw.test(r.text))) ?? null;
}

/**
 * Returns the rows between the table header and the next terminator
 * (the approval/signature block), i.e. the candidate line-item rows.
 */
export function findLineItemTableRows(rows: TextRow[], headerRow: TextRow): TextRow[] {
  const headerIdx = rows.indexOf(headerRow);
  if (headerIdx === -1) return [];

  const result: TextRow[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    if (TABLE_TERMINATOR_PATTERN.test(rows[i].text)) break;
    result.push(rows[i]);
  }
  return result;
}

// Fixed column count for the line-item table: Index | product number |
// Item Description | Accepted Qty | serial number | Comments.
const LINE_ITEM_COLUMN_COUNT = 6;

/**
 * Derives the x-position of each logical column's left edge from the header
 * row's glyph runs.
 *
 * Naively using every header item's x as its own boundary breaks on real
 * PDFs: pdfjs-dist frequently splits a single multi-word label (e.g. "Item
 * Description") into several separate text items at different x positions.
 * Treating each of those as its own column boundary shifts every column
 * after it — the classic symptom is description text merging into the
 * part-number cell and every later column reading one slot early.
 *
 * Instead, sort all header items left-to-right and cut at the `numColumns-1`
 * *largest* gaps between consecutive items. Gaps between words within the
 * same column label (e.g. "Item" → "Description") are small; gaps between
 * genuinely different columns are much larger — so this reliably reconstructs
 * the true column boundaries regardless of how the header text got split.
 */
export function computeColumnBoundaries(headerItems: PositionedTextItem[], numColumns: number): number[] {
  const sorted = [...headerItems].sort((a, b) => a.x - b.x);
  if (sorted.length <= numColumns) return sorted.map(i => i.x);

  const gaps: Array<{ afterIdx: number; size: number }> = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    gaps.push({ afterIdx: i - 1, size: sorted[i].x - (prev.x + prev.width) });
  }
  const cutAfter = new Set(
    [...gaps].sort((a, b) => b.size - a.size).slice(0, numColumns - 1).map(g => g.afterIdx)
  );

  const boundaries: number[] = [sorted[0].x];
  for (let i = 1; i < sorted.length; i++) {
    if (cutAfter.has(i - 1)) boundaries.push(sorted[i].x);
  }
  return boundaries;
}

/**
 * Bins a data row's items into columns, then parses each column's joined text.
 * Returns null for rows that don't look like a real line item (no leading
 * numeric index, or no PN/description content at all).
 *
 * Column detection has two strategies:
 *
 * 1. Ordinal (preferred): when the row already has exactly
 *    LINE_ITEM_COLUMN_COUNT glyph runs, map them 1:1 to columns by position
 *    (left-to-right). Real-world PDFs (e.g. the BN2074 sample) frequently
 *    render each cell as its own single glyph run in correct column order —
 *    but the header LABEL's x position doesn't necessarily line up with
 *    where the body data starts. E.g. "Item Description" is centered/offset
 *    within its column and sits at x≈340, while the actual description text
 *    below it — center-aligned within the same column — starts as early as
 *    x≈286 for a long string. Using the header label's x as a hard left
 *    boundary would misbin that data into the previous ("product number")
 *    column. Ordinal mapping sidesteps header/data alignment entirely.
 *
 * 2. x-boundary fallback: used only when a row's item count doesn't match
 *    the expected column count (e.g. an empty cell collapsing the count, or
 *    a wrapped cell splitting into extra items), via computeColumnBoundaries.
 */
export function parseLineItemRow(row: TextRow, headerRow: TextRow): ParsedSmrLineCandidate | null {
  if (row.items.length === 0) return null;

  let columns: string[];

  if (row.items.length === LINE_ITEM_COLUMN_COUNT) {
    columns = row.items.map(item => item.str.trim());
  } else {
    const boundaries = computeColumnBoundaries(headerRow.items, LINE_ITEM_COLUMN_COUNT);
    columns = boundaries.map(() => '');

    for (const item of row.items) {
      let colIdx = 0;
      for (let i = 0; i < boundaries.length; i++) {
        if (item.x + 0.01 >= boundaries[i]) colIdx = i;
      }
      columns[colIdx] = columns[colIdx] ? `${columns[colIdx]} ${item.str.trim()}` : item.str.trim();
    }
  }

  const [colIndex, colPn, colDesc, colQty, colSerialFlag, colComments] = columns.map(c => c.trim());

  const lineIndex = parseInt(colIndex, 10);
  if (!Number.isFinite(lineIndex)) return null;
  if (!colPn && !colDesc) return null;

  const expectedQty = parseFloat(colQty);

  return {
    lineIndex,
    productNumberRaw: colPn || null,
    descriptionRaw:   colDesc || null,
    expectedQty:      Number.isFinite(expectedQty) ? expectedQty : 0,
    hasSerialFlag:    /^1(\.0+)?$/.test(colSerialFlag ?? ''),
    poReference:      colComments || null,
  };
}

// ── Top-level orchestration (impure — real pdfjs-dist + File I/O) ────────────

/**
 * Loads a PDF file, reconstructs its text layout page by page, and returns a
 * best-effort structured extraction. Always returns a result (never throws
 * for "couldn't find X" cases) — gaps are reported via `warnings` so the
 * caller's review UI can prompt the user to fill them in manually rather than
 * failing the upload outright.
 */
export async function extractSmrFromPdf(file: File): Promise<ExtractedSmrResult> {
  const warnings: string[] = [];

  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

  const buffer = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buffer }).promise;

  const allRows: TextRow[] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();

    // Cast defensively: pdfjs-dist's TextContent.items mixes TextItem (has `str`)
    // and TextMarkedContent (no `str`) — only TextItem entries carry glyph text.
    const rawItems = content.items as Array<{ str?: string; transform?: number[]; width?: number }>;
    const items: PositionedTextItem[] = rawItems
      .filter((it): it is { str: string; transform: number[]; width: number } =>
        typeof it.str === 'string' && Array.isArray(it.transform))
      .map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5], width: it.width ?? 0 }));

    allRows.push(...groupTextItemsIntoRows(items));
  }

  const header = extractHeaderFields(allRows);
  if (!header.smrNumber) warnings.push('Could not detect the S.R number — please fill it in manually.');
  if (!header.sourceWarehouseName) warnings.push('Could not detect the customer warehouse name — please fill it in manually.');

  const headerRow = findLineItemTableHeaderRow(allRows);
  let lines: ParsedSmrLineCandidate[] = [];

  if (!headerRow) {
    warnings.push('Could not locate the line-item table in this PDF — please add line items manually.');
  } else {
    const tableRows = findLineItemTableRows(allRows, headerRow);
    lines = tableRows
      .map(r => parseLineItemRow(r, headerRow))
      .filter((l): l is ParsedSmrLineCandidate => l !== null);

    if (lines.length === 0) {
      warnings.push('Found the line-item table header but could not parse any rows — please add line items manually.');
    }
  }

  return { header, lines, warnings };
}
