import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { extractSmrFromPdf, type ExtractedSmrHeader, type ParsedSmrLineCandidate } from '../lib/smrPdfParser';
import {
  matchPnToItem, summarizeSmrLineStatuses,
  type MatchedItemRef, type SmrMatchConfidence,
} from '../lib/smrHelpers';
import { normalizePn, MAPPING_CODE_TYPE_PN } from '../lib/pnMapping';
import type { SmrDocument, SmrDocumentStatus, SmrLine, SmrLineScan, Warehouse, InventoryItem } from '../lib/warehouseTypes';
import css from './Warehouse.module.css';

// ── Local types ────────────────────────────────────────────────────────────────

interface SmrDocRow extends SmrDocument {
  warehouseName?: string;
  projectName?:   string;
  lineCount?:     number;
}

interface ReviewLine {
  localId:          string;
  lineIndex:        number;
  productNumberRaw: string;
  descriptionRaw:   string;
  expectedQty:      number;
  hasSerialFlag:    boolean;
  poReference:      string;
  matchedItemId:    string | null;
  matchedItemCode:  string | null;
  matchedItemName:  string | null;
  matchConfidence:  SmrMatchConfidence;
}

type ProjectRef = { id: string; display_name: string };

// ── Small pure UI helpers ─────────────────────────────────────────────────────

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** Best-effort "30-Apr-2026" / "30/04/2026" → "2026-04-30". Returns '' if unparseable. */
function parseSrDateToIso(raw: string | null): string {
  if (!raw) return '';
  const m1 = raw.match(/^(\d{1,2})[-/]([A-Za-z]{3,9})[-/](\d{2,4})$/);
  if (m1) {
    const day   = m1[1].padStart(2, '0');
    const month = MONTHS[m1[2].slice(0, 3).toLowerCase()];
    let year    = m1[3];
    if (year.length === 2) year = `20${year}`;
    if (month) return `${year}-${month}-${day}`;
  }
  const m2 = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (m2) {
    const day   = m2[1].padStart(2, '0');
    const month = m2[2].padStart(2, '0');
    let year    = m2[3];
    if (year.length === 2) year = `20${year}`;
    return `${year}-${month}-${day}`;
  }
  return '';
}

function statusBadge(s: SmrDocumentStatus) {
  if (s === 'COMPLETED')   return <span className={`${css.badge} ${css.badgeGreen}`}>Completed</span>;
  if (s === 'RECONCILING') return <span className={`${css.badge} ${css.badgeBlue}`}>Reconciling</span>;
  if (s === 'REVIEWED')    return <span className={`${css.badge} ${css.badgeAmber}`}>Reviewed</span>;
  if (s === 'CANCELLED')   return <span className={`${css.badge} ${css.badgeRed}`}>Cancelled</span>;
  return <span className={`${css.badge} ${css.badgeSlate}`}>{s}</span>;
}

function matchBadge(c: SmrMatchConfidence) {
  if (c === 'EXACT')   return <span className={`${css.badge} ${css.badgeGreen}`}>Exact</span>;
  if (c === 'LEARNED') return <span className={`${css.badge} ${css.badgeBlue}`}>Learned</span>;
  if (c === 'MANUAL')  return <span className={`${css.badge} ${css.badgeSlate}`}>Manual</span>;
  return <span className={`${css.badge} ${css.badgeRed}`}>Unmatched</span>;
}

const LINE_STATUS_LABEL: Record<SmrLine['status'], string> = {
  RECEIVED:     'Received',
  PARTIAL:      'Partial',
  NOT_RECEIVED: 'Not Received',
  PENDING:      'Pending',
};
const LINE_STATUS_COLOR: Record<SmrLine['status'], string> = {
  RECEIVED:     '#16a34a',
  PARTIAL:      '#d97706',
  NOT_RECEIVED: '#dc2626',
  PENDING:      '#64748b',
};

/** Shared row-shape both export functions build once from the loaded detail. */
interface ExportLineRow {
  lineIndex:     number;
  partNumber:    string;
  description:   string;
  matchedLabel:  string;
  expectedQty:   number;
  receivedQty:   number;
  status:        SmrLine['status'];
  serials:       string[];
}

function buildExportRows(lines: SmrLine[], scansByLine: Map<string, SmrLineScan[]>, items: InventoryItem[]): ExportLineRow[] {
  const itemsById = new Map(items.map(it => [it.id, it]));
  return lines.map(l => {
    const item = l.matched_item_id ? itemsById.get(l.matched_item_id) : undefined;
    return {
      lineIndex:    l.line_index,
      partNumber:   l.product_number_raw || '—',
      description:  l.description_raw || '—',
      matchedLabel: item ? `${item.item_code} — ${item.item_name}` : 'Unmatched',
      expectedQty:  l.expected_qty,
      receivedQty:  l.received_qty,
      status:       l.status,
      serials:      (scansByLine.get(l.id) || []).map(s => s.serial_number),
    };
  });
}

/** Styled ExcelJS export — mirrors the report-export pattern used elsewhere
 *  in the app (see NetworkScopes.exportSection): dark header row, banded
 *  rows, frozen header, one Serial Numbers line per scanned unit so every
 *  SN is individually visible/verifiable rather than crammed into one cell. */
async function exportSmrExcel(doc: SmrDocRow, lines: SmrLine[], scansByLine: Map<string, SmrLineScan[]>, items: InventoryItem[]) {
  const rows = buildExportRows(lines, scansByLine, items);
  const summary = summarizeSmrLineStatuses(lines);

  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TAC Network Tracker';
  wb.created = new Date();

  const ws = wb.addWorksheet('SMR ' + (doc.smr_number || 'Export').slice(0, 25));
  const columns = ['#', 'Part Number', 'Description', 'Matched Item', 'Expected', 'Received', 'Status', 'Serial Numbers'];
  const colCount = columns.length;

  ws.columns = [
    { width: 6 }, { width: 20 }, { width: 32 }, { width: 30 },
    { width: 11 }, { width: 11 }, { width: 14 }, { width: 40 },
  ];

  const titleText = `SMR ${doc.smr_number || '—'}  ·  ${doc.customer_name || 'Customer'}  ·  ${doc.source_warehouse_name || 'Source WH'} → Destination`;
  ws.addRow([titleText]);
  ws.mergeCells(1, 1, 1, colCount);
  ws.getRow(1).height = 26;
  const titleCell = ws.getCell('A1');
  titleCell.font      = { bold: true, size: 12, color: { argb: 'FF0F2038' } };
  titleCell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EDF5' } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left' };

  const metaText = `Requester: ${doc.requester_name || '—'}   ·   Date: ${doc.sr_date || '—'}   ·   Status: ${doc.status}   ·   Exported: ${new Date().toISOString().slice(0, 10)}`;
  ws.addRow([metaText]);
  ws.mergeCells(2, 1, 2, colCount);
  ws.getCell('A2').font = { size: 10, color: { argb: 'FF64748B' } };

  const summaryText = `${summary.total} total   ·   ${summary.received} received   ·   ${summary.partial} partial   ·   ${summary.notReceived} not received   ·   ${summary.pending} pending`;
  ws.addRow([summaryText]);
  ws.mergeCells(3, 1, 3, colCount);
  ws.getCell('A3').font = { size: 10, bold: true, color: { argb: 'FF1E293B' } };

  ws.addRow([]);

  ws.addRow(columns);
  const headerRowNum = 5;
  const headerRow = ws.getRow(headerRowNum);
  headerRow.height = 26;
  for (let c = 1; c <= colCount; c++) {
    const cell     = headerRow.getCell(c);
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F2038' } };
    cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.alignment = { vertical: 'middle', horizontal: (c === 5 || c === 6) ? 'right' : 'left' };
    cell.border    = { bottom: { style: 'medium', color: { argb: 'FF1A4060' } } };
  }
  ws.views = [{ state: 'frozen', ySplit: headerRowNum, showGridLines: true }];

  rows.forEach((r, idx) => {
    const bgArgb  = idx % 2 === 0 ? 'FFFFFFFF' : 'FFF4F6F8';
    const snText  = r.serials.length ? r.serials.join('\n') : '—';
    const exRow   = ws.addRow([r.lineIndex, r.partNumber, r.description, r.matchedLabel, r.expectedQty, r.receivedQty, LINE_STATUS_LABEL[r.status], snText]);
    exRow.height  = Math.max(20, 14 * Math.max(1, r.serials.length));
    exRow.eachCell({ includeEmpty: true }, (cell, c) => {
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgArgb } };
      cell.font      = { color: { argb: 'FF111827' }, size: 10.5 };
      cell.border    = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } };
      cell.alignment = { vertical: 'top', horizontal: (c === 5 || c === 6) ? 'right' : 'left', wrapText: c === 8 };
    });
    exRow.getCell(7).font = { color: { argb: LINE_STATUS_COLOR[r.status].replace('#', 'FF') }, bold: true, size: 10.5 };
  });

  const buffer = await wb.xlsx.writeBuffer();
  const blob   = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url    = URL.createObjectURL(blob);
  const fname  = `SMR_${(doc.smr_number || 'export').replace(/[^a-zA-Z0-9-]/g, '_')}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  Object.assign(document.createElement('a'), { href: url, download: fname }).click();
  URL.revokeObjectURL(url);
}

/** Print-to-PDF export — mirrors printInvoice (FinInvoices.tsx): renders a
 *  standalone HTML report in a new tab and triggers the browser print
 *  dialog, letting the browser handle pagination for the line-item table
 *  natively (more reliable than rasterizing a canvas for a variable-length
 *  report like this one). */
function exportSmrPdf(doc: SmrDocRow, lines: SmrLine[], scansByLine: Map<string, SmrLineScan[]>, items: InventoryItem[]) {
  const rows = buildExportRows(lines, scansByLine, items);
  const summary = summarizeSmrLineStatuses(lines);
  const e = (s: string | null | undefined) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const lineRows = rows.length === 0
    ? '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:16px">No line items.</td></tr>'
    : rows.map((r, i) => `<tr style="background:${i % 2 === 0 ? '#fff' : '#f8fafc'}">
        <td>${r.lineIndex}</td>
        <td style="font-family:monospace;font-size:11px">${e(r.partNumber)}</td>
        <td style="color:#64748b">${e(r.description)}</td>
        <td style="text-align:right">${r.expectedQty}</td>
        <td style="text-align:right;font-weight:700">${r.receivedQty}</td>
        <td><span class="status-pill" style="background:${LINE_STATUS_COLOR[r.status]}1a;color:${LINE_STATUS_COLOR[r.status]}">${LINE_STATUS_LABEL[r.status]}</span></td>
        <td style="font-family:monospace;font-size:10.5px;color:#334155">${r.serials.length ? r.serials.map(e).join('<br>') : '<span style="color:#cbd5e1">—</span>'}</td>
      </tr>`).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>SMR ${e(doc.smr_number)}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size:13px; color:#1e293b; background:#fff; padding:32px; }
    @media print { body { padding:16px; } @page { margin:12mm; } tr { break-inside: avoid; } }
    .header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:24px; padding-bottom:16px; border-bottom:2px solid #e2e8f0; }
    .brand { font-size:22px; font-weight:900; color:#2563eb; letter-spacing:-0.5px; }
    .brand-sub { font-size:11px; color:#94a3b8; margin-top:2px; }
    .doc-meta { text-align:right; }
    .doc-number { font-size:20px; font-weight:800; color:#1e293b; }
    .status-badge { display:inline-block; padding:2px 12px; border-radius:20px; font-size:11px; font-weight:700; margin-top:4px; background:#e0e7ff; color:#4338ca; }
    .grid-3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:20px; margin-bottom:20px; }
    .info-box h4 { font-size:10px; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:.8px; margin-bottom:4px; }
    .info-box p { font-size:13px; color:#334155; line-height:1.5; }
    .summary-row { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:20px; }
    .summary-pill { padding:5px 12px; border-radius:20px; font-size:11.5px; font-weight:700; background:#f1f5f9; color:#334155; }
    table { width:100%; border-collapse:collapse; margin-bottom:20px; }
    th { background:#0f2038; font-size:10.5px; font-weight:700; color:#fff; text-transform:uppercase; letter-spacing:.4px; padding:8px 10px; text-align:left; }
    td { padding:8px 10px; border-bottom:1px solid #f1f5f9; color:#334155; vertical-align:top; }
    .status-pill { display:inline-block; padding:2px 9px; border-radius:20px; font-size:11px; font-weight:700; }
    .section-title { font-size:11px; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:.6px; margin-bottom:8px; }
    .footer { margin-top:24px; padding-top:12px; border-top:1px solid #e2e8f0; font-size:11px; color:#94a3b8; text-align:center; }
  </style></head><body>
  <div class="header">
    <div><div class="brand">TAC Network</div><div class="brand-sub">Customer SMR Receiving Report</div></div>
    <div class="doc-meta">
      <div class="doc-number">SMR ${e(doc.smr_number)}</div>
      <div class="status-badge">${e(doc.status)}</div>
    </div>
  </div>
  <div class="grid-3">
    <div class="info-box"><h4>Customer</h4><p>${e(doc.customer_name) || '—'}</p></div>
    <div class="info-box"><h4>Source Warehouse</h4><p>${e(doc.source_warehouse_name) || '—'}</p></div>
    <div class="info-box"><h4>Destination</h4><p>${e(doc.warehouseName) || '—'}</p></div>
    <div class="info-box"><h4>S.R Date</h4><p>${e(doc.sr_date) || '—'}</p></div>
    <div class="info-box"><h4>Requester</h4><p>${e(doc.requester_name) || '—'}</p></div>
    <div class="info-box"><h4>Project</h4><p>${e(doc.projectName) || '—'}</p></div>
  </div>
  <div class="summary-row">
    <span class="summary-pill">${summary.total} total</span>
    <span class="summary-pill" style="background:#dcfce7;color:#16a34a">${summary.received} received</span>
    <span class="summary-pill" style="background:#fef3c7;color:#d97706">${summary.partial} partial</span>
    <span class="summary-pill" style="background:#fee2e2;color:#dc2626">${summary.notReceived} not received</span>
    <span class="summary-pill">${summary.pending} pending</span>
  </div>
  <div class="section-title">Line Items (${rows.length})</div>
  <table><thead><tr><th>#</th><th>Part Number</th><th>Description</th><th style="text-align:right">Expected</th><th style="text-align:right">Received</th><th>Status</th><th>Serial Numbers</th></tr></thead><tbody>${lineRows}</tbody></table>
  <div class="footer">Generated by TAC Network Tracker &nbsp;·&nbsp; ${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
  <script>window.onload = function(){ window.print(); }<\/script>
  </body></html>`;
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
}

function emptyHeader(): ExtractedSmrHeader {
  return {
    smrNumber: null, customerName: null, sourceWarehouseName: null, formType: null,
    srDateRaw: null, requesterName: null, requesterDepartment: null, requesterPhone: null,
    siteCode: null, projectNameRaw: null, subReference: null,
  };
}

const PAGE_SIZE = 20;

export default function WarehouseSmr() {
  const { hasPerm, currentUser } = useAuth();
  const navigate = useNavigate();

  // ── List state ───────────────────────────────────────────────────────────
  const [documents,  setDocuments]  = useState<SmrDocRow[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [projects,   setProjects]   = useState<ProjectRef[]>([]);
  const [items,      setItems]      = useState<InventoryItem[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');
  const [total,      setTotal]      = useState(0);
  const [page,       setPage]       = useState(1);

  const [wrhFilter,    setWrhFilter]    = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [search,       setSearch]       = useState('');

  const [detail,    setDetail]    = useState<{ doc: SmrDocRow; lines: SmrLine[]; scansByLine: Map<string, SmrLineScan[]> } | null>(null);
  const [exporting, setExporting] = useState<'' | 'excel' | 'pdf'>('');
  const [canceling, setCanceling] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Upload / review modal state ────────────────────────────────────────────
  const [showUpload,        setShowUpload]        = useState(false);
  const [uploadStep,        setUploadStep]        = useState<'select' | 'review'>('select');
  const [uploadWarehouseId, setUploadWarehouseId]  = useState('');
  const [uploadProjectId,   setUploadProjectId]    = useState('');
  const [uploadFile,        setUploadFile]         = useState<File | null>(null);
  const [extracting,        setExtracting]         = useState(false);
  const [saving,            setSaving]             = useState(false);
  const [warnings,          setWarnings]           = useState<string[]>([]);
  const [reviewHeader,      setReviewHeader]       = useState<ExtractedSmrHeader>(emptyHeader());
  const [reviewSrDate,      setReviewSrDate]       = useState('');
  const [reviewLines,       setReviewLines]        = useState<ReviewLine[]>([]);

  const exactByPn   = useRef<Map<string, MatchedItemRef>>(new Map());
  const learnedByPn = useRef<Map<string, MatchedItemRef>>(new Map());

  if (!hasPerm('view_warehouse_smr')) return <div className={css.denied}>Access denied.</div>;

  const canUpload = hasPerm('wrh_smr_upload');
  const canScan   = hasPerm('wrh_smr_scan');
  const canCancel = hasPerm('wrh_smr_cancel');
  const canDelete = hasPerm('wrh_smr_delete');

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  // ── Load master data ────────────────────────────────────────────────────────
  async function loadMeta() {
    const [wRes, pRes, iRes] = await Promise.all([
      supabase.from('warehouses').select('*').eq('is_active', true).order('name'),
      supabase.from('projects').select('id, display_name').eq('is_active', true).order('sort_order').order('display_name'),
      supabase.from('inventory_items').select('*').eq('is_active', true).order('item_name'),
    ]);
    if (wRes.data) setWarehouses(wRes.data as Warehouse[]);
    if (pRes.data) setProjects(pRes.data as ProjectRef[]);

    if (iRes.data) {
      const rows = iRes.data as InventoryItem[];
      setItems(rows);
      const exact = new Map<string, MatchedItemRef>();
      for (const it of rows) {
        if (it.part_number) {
          exact.set(normalizePn(it.part_number), { itemId: it.id, itemCode: it.item_code, itemName: it.item_name });
        }
      }
      exactByPn.current = exact;

      const itemsById = new Map(rows.map(it => [it.id, it]));
      const mRes = await supabase
        .from('item_code_mappings')
        .select('external_code, inventory_item_id')
        .eq('code_type', MAPPING_CODE_TYPE_PN)
        .eq('is_active', true);
      if (mRes.data && !mRes.error) {
        const learned = new Map<string, MatchedItemRef>();
        for (const row of mRes.data as { external_code: string; inventory_item_id: string }[]) {
          const item = itemsById.get(row.inventory_item_id);
          if (item) learned.set(normalizePn(row.external_code), { itemId: item.id, itemCode: item.item_code, itemName: item.item_name });
        }
        learnedByPn.current = learned;
      }
    }
  }

  async function load(p = page) {
    setLoading(true);
    setError('');

    let q = supabase.from('smr_documents').select('*', { count: 'exact' });
    if (wrhFilter)    q = q.eq('destination_warehouse_id', wrhFilter);
    if (statusFilter) q = q.eq('status', statusFilter);
    if (search) {
      const s = search.trim();
      q = q.or(`smr_number.ilike.%${s}%,source_warehouse_name.ilike.%${s}%,customer_name.ilike.%${s}%`);
    }

    const from = (p - 1) * PAGE_SIZE;
    q = q.order('created_at', { ascending: false }).range(from, from + PAGE_SIZE - 1);

    const { data, error: e, count } = await q;
    if (e) { setError(e.message); setLoading(false); return; }

    const rows = (data || []) as SmrDocRow[];
    const wrhMap  = Object.fromEntries(warehouses.map(w => [w.id, w.name]));
    const projMap = new Map(projects.map(p => [p.id, p.display_name]));
    rows.forEach(r => {
      r.warehouseName = wrhMap[r.destination_warehouse_id] || '—';
      r.projectName   = r.project_id ? (projMap.get(r.project_id) ?? 'Unknown Project') : '—';
    });

    if (rows.length) {
      const { data: lineCounts } = await supabase
        .from('smr_lines')
        .select('smr_document_id')
        .in('smr_document_id', rows.map(r => r.id));
      if (lineCounts) {
        const counts = new Map<string, number>();
        for (const l of lineCounts as { smr_document_id: string }[]) {
          counts.set(l.smr_document_id, (counts.get(l.smr_document_id) ?? 0) + 1);
        }
        rows.forEach(r => { r.lineCount = counts.get(r.id) ?? 0; });
      }
    }

    setDocuments(rows);
    setTotal(count ?? 0);
    setLoading(false);
  }

  useEffect(() => { loadMeta(); }, []);
  useEffect(() => { if (warehouses.length || !loading) load(1); setPage(1); }, [wrhFilter, statusFilter, search]);
  useEffect(() => { load(page); }, [page, warehouses, projects]);

  // ── Detail ───────────────────────────────────────────────────────────────────
  async function openDetail(doc: SmrDocRow) {
    const { data } = await supabase.from('smr_lines').select('*').eq('smr_document_id', doc.id).order('line_index');
    const lines = (data || []) as SmrLine[];

    const scansByLine = new Map<string, SmrLineScan[]>();
    if (lines.length) {
      const { data: scanRows } = await supabase
        .from('smr_line_scans')
        .select('*')
        .in('smr_line_id', lines.map(l => l.id))
        .order('created_at');
      for (const s of (scanRows || []) as SmrLineScan[]) {
        const arr = scansByLine.get(s.smr_line_id) ?? [];
        arr.push(s);
        scansByLine.set(s.smr_line_id, arr);
      }
    }

    setDetail({ doc, lines, scansByLine });
  }

  async function handleExport(kind: 'excel' | 'pdf') {
    if (!detail) return;
    setExporting(kind);
    try {
      if (kind === 'excel') {
        await exportSmrExcel(detail.doc, detail.lines, detail.scansByLine, items);
      } else {
        exportSmrPdf(detail.doc, detail.lines, detail.scansByLine, items);
      }
    } catch (e: unknown) {
      showToast('Export failed: ' + (e instanceof Error ? e.message : String(e)), false);
    }
    setExporting('');
  }

  async function cancelDocument(id: string) {
    if (!confirm('Cancel this SMR? This cannot be undone.')) return;
    setCanceling(true);
    const { error: e } = await supabase.from('smr_documents').update({ status: 'CANCELLED' }).eq('id', id);
    setCanceling(false);
    if (e) { showToast(e.message, false); return; }
    showToast('SMR cancelled.', true);
    setDetail(null);
    load(page);
  }

  // ── Hard delete (test-data cleanup) ─────────────────────────────────────────
  // Unlike cancelDocument (soft, reversible-by-reopening status), this permanently
  // removes the smr_documents row — smr_lines and smr_line_scans cascade via FK
  // (ON DELETE CASCADE, migration 011). If the SMR was already finalized into a
  // goods receipt, that goods_receipts row is deleted too (its own items and
  // scan log cascade, migration 001) — but the SMR document must be deleted
  // FIRST: smr_documents.goods_receipt_id references goods_receipts(id) with no
  // ON DELETE CASCADE, so deleting the receipt while the SMR still points at it
  // fails with a foreign-key violation.
  async function deleteDocument(doc: SmrDocRow) {
    const warn = doc.goods_receipt_id
      ? 'Permanently delete this SMR AND the goods receipt it created? This cannot be undone.'
      : 'Permanently delete this SMR? This cannot be undone.';
    if (!confirm(warn)) return;
    setDeleting(true);
    const { error: e } = await supabase.from('smr_documents').delete().eq('id', doc.id);
    if (e) { setDeleting(false); showToast(e.message, false); return; }
    if (doc.goods_receipt_id) {
      const { error: rErr } = await supabase.from('goods_receipts').delete().eq('id', doc.goods_receipt_id);
      if (rErr) { setDeleting(false); showToast(`SMR deleted, but failed to delete linked receipt: ${rErr.message}`, false); setDetail(null); load(page); return; }
    }
    setDeleting(false);
    showToast('SMR deleted.', true);
    setDetail(null);
    load(page);
  }

  // ── Upload / extract / review ────────────────────────────────────────────────
  function openUploadModal() {
    setUploadStep('select');
    setUploadWarehouseId('');
    setUploadProjectId('');
    setUploadFile(null);
    setWarnings([]);
    setReviewHeader(emptyHeader());
    setReviewSrDate('');
    setReviewLines([]);
    setShowUpload(true);
  }
  function closeUploadModal() { setShowUpload(false); }

  function buildReviewLines(lines: ParsedSmrLineCandidate[]): ReviewLine[] {
    return lines.map(l => {
      const match = matchPnToItem(l.productNumberRaw, exactByPn.current, learnedByPn.current);

      // The customer's PDF "serial number" flag column is a best-effort read of
      // their paperwork, and has proven unreliable in practice (e.g. real
      // serialized radio units printed with a 0 in that column). When the line
      // already confidently matches a known item master row (EXACT/LEARNED),
      // trust that item's own tracking_method instead — it's the authoritative
      // answer to "does this SKU need per-unit serial tracking," not a guess.
      const matchedItem = match.itemId ? items.find(it => it.id === match.itemId) : undefined;
      const hasSerialFlag = (match.confidence === 'EXACT' || match.confidence === 'LEARNED') && matchedItem
        ? matchedItem.tracking_method === 'SERIALIZED'
        : l.hasSerialFlag;

      return {
        localId:          crypto.randomUUID(),
        lineIndex:        l.lineIndex,
        productNumberRaw: l.productNumberRaw ?? '',
        descriptionRaw:   l.descriptionRaw ?? '',
        expectedQty:      l.expectedQty,
        hasSerialFlag,
        poReference:      l.poReference ?? '',
        matchedItemId:    match.itemId,
        matchedItemCode:  match.itemCode,
        matchedItemName:  match.itemName,
        matchConfidence:  match.confidence,
      };
    });
  }

  async function handleExtract() {
    if (!uploadWarehouseId) { showToast('Select a destination warehouse.', false); return; }
    if (!uploadFile)        { showToast('Choose a PDF file to upload.', false); return; }
    if (uploadFile.size > 20 * 1024 * 1024) { showToast('File must be under 20 MB.', false); return; }

    setExtracting(true);
    try {
      const result = await extractSmrFromPdf(uploadFile);
      setWarnings(result.warnings);
      setReviewHeader(result.header);
      setReviewSrDate(parseSrDateToIso(result.header.srDateRaw));
      setReviewLines(buildReviewLines(result.lines));
      setUploadStep('review');
    } catch (e: unknown) {
      showToast('Failed to read PDF: ' + (e instanceof Error ? e.message : String(e)), false);
    }
    setExtracting(false);
  }

  function updateReviewLine(localId: string, patch: Partial<ReviewLine>) {
    setReviewLines(prev => prev.map(l => l.localId === localId ? { ...l, ...patch } : l));
  }

  function setLineItemMatch(localId: string, itemId: string) {
    const item = items.find(i => i.id === itemId);
    updateReviewLine(localId, {
      matchedItemId:   itemId || null,
      matchedItemCode: item?.item_code ?? null,
      matchedItemName: item?.item_name ?? null,
      matchConfidence: itemId ? 'MANUAL' : 'UNMATCHED',
      // Picking a match by hand is at least as trustworthy as an EXACT/LEARNED
      // auto-match — sync the scan-vs-quantity flag to the chosen item's own
      // tracking_method rather than leaving whatever the PDF happened to print.
      ...(item ? { hasSerialFlag: item.tracking_method === 'SERIALIZED' } : {}),
    });
  }

  function addReviewLine() {
    setReviewLines(prev => [...prev, {
      localId: crypto.randomUUID(),
      lineIndex: prev.length ? Math.max(...prev.map(l => l.lineIndex)) + 1 : 1,
      productNumberRaw: '', descriptionRaw: '', expectedQty: 0, hasSerialFlag: false, poReference: '',
      matchedItemId: null, matchedItemCode: null, matchedItemName: null, matchConfidence: 'UNMATCHED',
    }]);
  }

  function removeReviewLine(localId: string) {
    setReviewLines(prev => prev.filter(l => l.localId !== localId));
  }

  async function handleSaveReview() {
    if (!uploadFile) return;
    if (!reviewHeader.smrNumber?.trim()) { showToast('S.R Number is required.', false); return; }
    if (reviewLines.length === 0) { showToast('Add at least one line item.', false); return; }

    setSaving(true);
    try {
      const safeName = uploadFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `smr/${Date.now()}-${safeName}`;
      const { error: upErr } = await supabase.storage.from('employee-docs').upload(path, uploadFile, { upsert: false });
      if (upErr) throw upErr;

      const { data: doc, error: docErr } = await supabase.from('smr_documents').insert({
        smr_number:               reviewHeader.smrNumber.trim(),
        customer_name:            reviewHeader.customerName || null,
        source_warehouse_name:    reviewHeader.sourceWarehouseName || null,
        form_type:                reviewHeader.formType || null,
        sr_date:                  reviewSrDate || null,
        requester_name:           reviewHeader.requesterName || null,
        requester_department:     reviewHeader.requesterDepartment || null,
        requester_phone:          reviewHeader.requesterPhone || null,
        site_code:                reviewHeader.siteCode || null,
        project_id:               uploadProjectId || null,
        project_name_raw:         reviewHeader.projectNameRaw || null,
        sub_reference:            reviewHeader.subReference || null,
        destination_warehouse_id: uploadWarehouseId,
        pdf_file_path:            path,
        pdf_file_name:            uploadFile.name,
        status:                   'REVIEWED',
        created_by:               currentUser?.id || '',
      }).select('id').single();

      if (docErr || !doc) throw docErr || new Error('Failed to create SMR document.');

      const lineRows = reviewLines.map(l => ({
        smr_document_id:    doc.id,
        line_index:         l.lineIndex,
        product_number_raw: l.productNumberRaw || null,
        description_raw:    l.descriptionRaw || null,
        expected_qty:       Number.isFinite(l.expectedQty) ? l.expectedQty : 0,
        has_serial_flag:    l.hasSerialFlag,
        po_reference:       l.poReference || null,
        matched_item_id:    l.matchedItemId,
        match_confidence:   l.matchConfidence,
      }));
      const { error: liErr } = await supabase.from('smr_lines').insert(lineRows);
      if (liErr) throw liErr;

      if (currentUser) {
        await supabase.from('activity_log').insert({
          user_full_name: currentUser.full_name,
          action: `Uploaded SMR ${reviewHeader.smrNumber.trim()} (${lineRows.length} line item${lineRows.length !== 1 ? 's' : ''})`,
        });
      }

      showToast(`SMR ${reviewHeader.smrNumber.trim()} saved.`, true);
      setShowUpload(false);
      load(1);
      setPage(1);
    } catch (e: unknown) {
      showToast('Save failed: ' + (e instanceof Error ? e.message : String(e)), false);
    }
    setSaving(false);
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className={css.page}>
      <div className={css.pageHdr}>
        <div>
          <h1 className={css.pageTitle}>Customer SMR Receiving</h1>
          <p className={css.pageSubtitle}>{total} SMR{total !== 1 ? 's' : ''} total</p>
        </div>
        {canUpload && (
          <div className={css.hdrActions}>
            <button className={css.btnAccent} onClick={openUploadModal}>+ Upload SMR</button>
          </div>
        )}
      </div>

      {error && <p className={css.errorMsg}>{error}</p>}

      <div className={css.card}>
        <div className={css.toolbar}>
          <div className={css.searchWrap}>
            <SearchIcon className={css.searchIcon} />
            <input className={css.searchInput}
              placeholder="S.R No, customer, source WH…"
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <select className={css.select} value={wrhFilter} onChange={e => setWrhFilter(e.target.value)}>
            <option value="">All Warehouses</option>
            {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <select className={css.select} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="">All Statuses</option>
            <option value="DRAFT">Draft</option>
            <option value="EXTRACTED">Extracted</option>
            <option value="REVIEWED">Reviewed</option>
            <option value="RECONCILING">Reconciling</option>
            <option value="COMPLETED">Completed</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </div>

        <div className={css.tableWrap}>
          {loading ? (
            <table><tbody><tr className={css.loadingRow}><td colSpan={7}>Loading…</td></tr></tbody></table>
          ) : !documents.length ? (
            <div className={css.emptyState}>
              <div className={css.emptyMsg}>No SMRs found</div>
              <div className={css.emptyHint}>Upload a customer S.R PDF to get started.</div>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>S.R No</th>
                  <th>Customer</th>
                  <th>Source WH</th>
                  <th>Destination</th>
                  <th>Lines</th>
                  <th>Date</th>
                  <th>Status</th>
                  <th style={{ width: 50 }}></th>
                </tr>
              </thead>
              <tbody>
                {documents.map(d => (
                  <tr key={d.id} style={{ cursor: 'pointer' }} onClick={() => openDetail(d)}>
                    <td style={{ fontWeight: 700, color: '#6366f1' }}>{d.smr_number}</td>
                    <td>{d.customer_name || '—'}</td>
                    <td>{d.source_warehouse_name || '—'}</td>
                    <td>{d.warehouseName}</td>
                    <td>{d.lineCount ?? '—'}</td>
                    <td>{d.sr_date || '—'}</td>
                    <td>{statusBadge(d.status)}</td>
                    <td>
                      <button className={css.btnIcon} onClick={e => { e.stopPropagation(); openDetail(d); }} title="View">
                        <EyeIcon />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {totalPages > 1 && (
          <div className={css.pagination}>
            <button className={css.pageBtn} disabled={page === 1} onClick={() => setPage(p => p - 1)}>‹</button>
            {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
              const n = Math.max(1, Math.min(page - 3, totalPages - 6)) + i;
              if (n < 1 || n > totalPages) return null;
              return (
                <button key={n} className={`${css.pageBtn} ${page === n ? css.pageBtnActive : ''}`}
                  onClick={() => setPage(n)}>{n}</button>
              );
            })}
            <button className={css.pageBtn} disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>›</button>
            <span className={css.pageInfo}>{page} / {totalPages}</span>
          </div>
        )}
      </div>

      {/* ── Upload / Review modal ─────────────────────────────────────────────── */}
      {showUpload && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget && !saving && !extracting) closeUploadModal(); }}>
          <div className={`${css.modal} ${css.modalWide}`}>
            <div className={css.modalHdr}>
              <span className={css.modalTitle}>{uploadStep === 'select' ? 'Upload SMR' : 'Review Extracted Data'}</span>
              <button className={css.modalClose} onClick={closeUploadModal}>×</button>
            </div>
            <div className={css.modalBody}>
              {uploadStep === 'select' && (
                <div className={css.fieldset}>
                  <div className={css.fieldRow}>
                    <div className={css.field}>
                      <label className={css.label}>Destination Warehouse *</label>
                      <select className={`${css.input} ${css.fieldSelect}`}
                        value={uploadWarehouseId}
                        onChange={e => setUploadWarehouseId(e.target.value)}>
                        <option value="">— Select Warehouse —</option>
                        {warehouses.map(w => <option key={w.id} value={w.id}>{w.name} ({w.code})</option>)}
                      </select>
                    </div>
                    <div className={css.field}>
                      <label className={css.label}>Project (optional)</label>
                      <select className={`${css.input} ${css.fieldSelect}`}
                        value={uploadProjectId}
                        onChange={e => setUploadProjectId(e.target.value)}>
                        <option value="">— None —</option>
                        {projects.map(p => <option key={p.id} value={p.id}>{p.display_name}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className={css.field}>
                    <label className={css.label}>SMR PDF *</label>
                    <input type="file" accept="application/pdf" className={css.input}
                      onChange={e => setUploadFile(e.target.files?.[0] ?? null)} />
                  </div>
                  <p style={{ fontSize: 12, color: '#94a3b8' }}>
                    We'll try to auto-extract the header and line items. You'll be able to review and correct everything before saving.
                  </p>
                </div>
              )}

              {uploadStep === 'review' && (
                <>
                  {warnings.length > 0 && (
                    <div style={{ background: '#fef9c3', border: '1px solid #fde68a', borderRadius: 8, padding: 10, marginBottom: 16 }}>
                      {warnings.map((w, i) => (
                        <div key={i} style={{ fontSize: 12, color: '#92400e' }}>⚠ {w}</div>
                      ))}
                    </div>
                  )}

                  <div className={css.reviewSection}>
                    <div className={css.reviewSectionTitle}>Header</div>
                    <div className={css.fieldset}>
                      <div className={css.fieldRow}>
                        <div className={css.field}>
                          <label className={css.label}>S.R Number *</label>
                          <input className={css.input} value={reviewHeader.smrNumber ?? ''}
                            onChange={e => setReviewHeader(h => ({ ...h, smrNumber: e.target.value }))} />
                        </div>
                        <div className={css.field}>
                          <label className={css.label}>Customer</label>
                          <input className={css.input} placeholder="Zain, Korek, …" value={reviewHeader.customerName ?? ''}
                            onChange={e => setReviewHeader(h => ({ ...h, customerName: e.target.value }))} />
                        </div>
                      </div>
                      <div className={css.fieldRow}>
                        <div className={css.field}>
                          <label className={css.label}>Source Warehouse</label>
                          <input className={css.input} value={reviewHeader.sourceWarehouseName ?? ''}
                            onChange={e => setReviewHeader(h => ({ ...h, sourceWarehouseName: e.target.value }))} />
                        </div>
                        <div className={css.field}>
                          <label className={css.label}>Form Type</label>
                          <input className={css.input} value={reviewHeader.formType ?? ''}
                            onChange={e => setReviewHeader(h => ({ ...h, formType: e.target.value }))} />
                        </div>
                      </div>
                      <div className={css.fieldRow}>
                        <div className={css.field}>
                          <label className={css.label}>S.R Date</label>
                          <input type="date" className={css.input} value={reviewSrDate}
                            onChange={e => setReviewSrDate(e.target.value)} />
                        </div>
                        <div className={css.field}>
                          <label className={css.label}>Site Code</label>
                          <input className={css.input} value={reviewHeader.siteCode ?? ''}
                            onChange={e => setReviewHeader(h => ({ ...h, siteCode: e.target.value }))} />
                        </div>
                      </div>
                      <div className={css.fieldRow}>
                        <div className={css.field}>
                          <label className={css.label}>Requester Name</label>
                          <input className={css.input} value={reviewHeader.requesterName ?? ''}
                            onChange={e => setReviewHeader(h => ({ ...h, requesterName: e.target.value }))} />
                        </div>
                        <div className={css.field}>
                          <label className={css.label}>Requester Phone</label>
                          <input className={css.input} value={reviewHeader.requesterPhone ?? ''}
                            onChange={e => setReviewHeader(h => ({ ...h, requesterPhone: e.target.value }))} />
                        </div>
                      </div>
                      <div className={css.fieldRow}>
                        <div className={css.field}>
                          <label className={css.label}>Project (as printed)</label>
                          <input className={css.input} value={reviewHeader.projectNameRaw ?? ''}
                            onChange={e => setReviewHeader(h => ({ ...h, projectNameRaw: e.target.value }))} />
                        </div>
                        <div className={css.field}>
                          <label className={css.label}>SUB Reference</label>
                          <input className={css.input} value={reviewHeader.subReference ?? ''}
                            onChange={e => setReviewHeader(h => ({ ...h, subReference: e.target.value }))} />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className={css.reviewSection}>
                    <div className={css.reviewSectionTitle}>
                      Line Items ({reviewLines.length})
                      <button className={css.btnSm} style={{ marginLeft: 10 }} onClick={addReviewLine}>+ Add Line</button>
                    </div>
                    <div className={css.tableWrap}>
                      <table>
                        <thead>
                          <tr>
                            <th style={{ width: 40 }}>#</th>
                            <th>Part Number</th>
                            <th>Description</th>
                            <th style={{ width: 80 }}>Qty</th>
                            <th style={{ width: 70 }}>Serial?</th>
                            <th>Matched Item</th>
                            <th>PO Ref</th>
                            <th style={{ width: 40 }}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {reviewLines.map(l => (
                            <tr key={l.localId}>
                              <td>{l.lineIndex}</td>
                              <td>
                                <input className={css.input} style={{ fontFamily: 'monospace', fontSize: 12 }}
                                  value={l.productNumberRaw}
                                  onChange={e => updateReviewLine(l.localId, { productNumberRaw: e.target.value })} />
                              </td>
                              <td>
                                <input className={css.input} value={l.descriptionRaw}
                                  onChange={e => updateReviewLine(l.localId, { descriptionRaw: e.target.value })} />
                              </td>
                              <td>
                                <input type="number" step="0.01" className={css.input} value={l.expectedQty}
                                  onChange={e => updateReviewLine(l.localId, { expectedQty: parseFloat(e.target.value) || 0 })} />
                              </td>
                              <td style={{ textAlign: 'center' }}>
                                <input type="checkbox" checked={l.hasSerialFlag}
                                  title="Needs a per-unit serial number scanned at reconcile time"
                                  onChange={e => updateReviewLine(l.localId, { hasSerialFlag: e.target.checked })} />
                              </td>
                              <td>
                                <select className={`${css.input} ${css.fieldSelect}`} value={l.matchedItemId ?? ''}
                                  onChange={e => setLineItemMatch(l.localId, e.target.value)}>
                                  <option value="">— Unmatched —</option>
                                  {items.map(it => <option key={it.id} value={it.id}>{it.item_code} — {it.item_name}</option>)}
                                </select>
                                <div style={{ marginTop: 4 }}>{matchBadge(l.matchConfidence)}</div>
                              </td>
                              <td>
                                <input className={css.input} value={l.poReference}
                                  onChange={e => updateReviewLine(l.localId, { poReference: e.target.value })} />
                              </td>
                              <td>
                                <button className={css.btnIcon} title="Remove" onClick={() => removeReviewLine(l.localId)}>
                                  <TrashIcon />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}
            </div>
            <div className={css.modalFtr}>
              <button className={css.btnGhost} onClick={closeUploadModal} disabled={extracting || saving}>Cancel</button>
              {uploadStep === 'select' && (
                <button className={css.btnAccent} onClick={handleExtract} disabled={extracting}>
                  {extracting ? 'Extracting…' : 'Extract & Review'}
                </button>
              )}
              {uploadStep === 'review' && (
                <>
                  <button className={css.btnGhost} onClick={() => setUploadStep('select')} disabled={saving}>Back</button>
                  <button className={css.btnAccent} onClick={handleSaveReview} disabled={saving}>
                    {saving ? 'Saving…' : 'Save SMR'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── Detail modal ───────────────────────────────────────────────────────── */}
      {detail && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget) setDetail(null); }}>
          <div className={`${css.modal} ${css.modalWide}`}>
            <div className={css.modalHdr}>
              <span className={css.modalTitle}>SMR {detail.doc.smr_number}</span>
              <button className={css.modalClose} onClick={() => setDetail(null)}>×</button>
            </div>
            <div className={css.modalBody}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 18, fontSize: 13 }}>
                <SF label="Customer"    value={detail.doc.customer_name || '—'} />
                <SF label="Source WH"   value={detail.doc.source_warehouse_name || '—'} />
                <SF label="Destination" value={detail.doc.warehouseName || '—'} />
                <SF label="Form Type"   value={detail.doc.form_type || '—'} />
                <SF label="Date"        value={detail.doc.sr_date || '—'} />
                <SF label="Status"      value={<span>{statusBadge(detail.doc.status)}</span>} />
                <SF label="Requester"   value={detail.doc.requester_name || '—'} />
                <SF label="Site Code"   value={detail.doc.site_code || '—'} />
                <SF label="Project"     value={detail.doc.projectName || '—'} />
              </div>

              {detail.lines.length > 0 && (() => {
                const summary = summarizeSmrLineStatuses(detail.lines);
                return (
                  <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                    <span className={`${css.badge} ${css.badgeSlate}`}>{summary.total} total</span>
                    <span className={`${css.badge} ${css.badgeGreen}`}>{summary.received} received</span>
                    <span className={`${css.badge} ${css.badgeAmber}`}>{summary.partial} partial</span>
                    <span className={`${css.badge} ${css.badgeRed}`}>{summary.notReceived} not received</span>
                    <span className={`${css.badge} ${css.badgeSlate}`}>{summary.pending} pending</span>
                  </div>
                );
              })()}

              <div style={{ fontSize: 12, fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8 }}>
                Line Items ({detail.lines.length})
              </div>
              {detail.lines.length === 0 ? (
                <p style={{ fontSize: 13, color: '#94a3b8' }}>No line items recorded.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Part Number</th>
                      <th>Description</th>
                      <th style={{ textAlign: 'right' }}>Expected</th>
                      <th style={{ textAlign: 'right' }}>Received</th>
                      <th>Match</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map(l => (
                      <tr key={l.id}>
                        <td>{l.line_index}</td>
                        <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{l.product_number_raw || '—'}</td>
                        <td>{l.description_raw || '—'}</td>
                        <td style={{ textAlign: 'right' }}>{l.expected_qty}</td>
                        <td style={{ textAlign: 'right' }}>{l.received_qty}</td>
                        <td>{matchBadge(l.match_confidence)}</td>
                        <td>{l.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className={css.modalFtr}>
              <button className={css.btnGhost} onClick={() => setDetail(null)}>Close</button>
              {detail.lines.length > 0 && (
                <>
                  <button className={css.btnGhost} onClick={() => handleExport('excel')} disabled={exporting !== ''}>
                    {exporting === 'excel' ? 'Exporting…' : '⇩ Excel'}
                  </button>
                  <button className={css.btnGhost} onClick={() => handleExport('pdf')} disabled={exporting !== ''}>
                    {exporting === 'pdf' ? 'Exporting…' : '⇩ PDF'}
                  </button>
                </>
              )}
              {canCancel && !['COMPLETED', 'CANCELLED'].includes(detail.doc.status) && (
                <button className={css.btnDanger} onClick={() => cancelDocument(detail.doc.id)} disabled={canceling}>
                  {canceling ? 'Cancelling…' : 'Cancel SMR'}
                </button>
              )}
              {canDelete && (
                <button className={css.btnDanger} onClick={() => deleteDocument(detail.doc)} disabled={deleting}
                  title="Permanently deletes this SMR (and its lines/scans). If finalized, also deletes the goods receipt it created.">
                  {deleting ? 'Deleting…' : 'Delete SMR'}
                </button>
              )}
              {canScan && ['REVIEWED', 'RECONCILING'].includes(detail.doc.status) && (
                <button className={css.btnAccent} onClick={() => navigate(`/warehouse/smr/${detail.doc.id}/reconcile`)}>
                  Scan / Reconcile
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {toast && (
        <div className={`${css.toast} ${toast.ok ? css.toastOk : css.toastErr}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function SF({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>{value}</div>
    </div>
  );
}

function SearchIcon({ className }: { className?: string }) { return <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>; }
function EyeIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>; }
function TrashIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>; }
