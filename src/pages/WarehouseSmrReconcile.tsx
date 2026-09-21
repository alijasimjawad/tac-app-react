import { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import {
  CameraScanner, parseScan, classifyScan,
  checkCameraPermission, cameraErrorMessage, type CameraPermission,
} from '../lib/warehouseScanner';
import {
  computeSmrLineStatus, summarizeSmrLineStatuses, isSmrReconciliationComplete,
  countUniqueScans, isDuplicateScanForLine, buildReceiptItemsFromSmrLines,
  suggestFuzzyMatches,
  type SmrLineStatus, type SmrMatchConfidence,
} from '../lib/smrHelpers';
import { normalizePn, MAPPING_SOURCE_RECEIVING, MAPPING_CODE_TYPE_PN } from '../lib/pnMapping';
import { normalizeSN } from '../lib/warehouseTypes';
import type { SmrDocument, InventoryItem } from '../lib/warehouseTypes';
import css from './Warehouse.module.css';

// ── Local types ────────────────────────────────────────────────────────────────

interface LineScan {
  id:                string;
  serialNumber:      string;
  serialNumberNorm:  string;
  rawScanValue:      string;
  barcodeSymbology:  string | null;
  scannedManually:   boolean;
}

interface ReconcileLine {
  id:                string;
  lineIndex:         number;
  productNumberRaw:  string | null;
  descriptionRaw:    string | null;
  expectedQty:       number;
  hasSerialFlag:     boolean;
  poReference:       string | null;
  matchedItemId:     string | null;
  matchedItemCode:   string | null;
  matchedItemName:   string | null;
  matchConfidence:   SmrMatchConfidence;
  trackingMethod:    'SERIALIZED' | 'QUANTITY' | null;
  receivedQty:       number;
  status:            SmrLineStatus;
  scans:             LineScan[];
}

function matchBadge(c: SmrMatchConfidence) {
  if (c === 'EXACT')   return <span className={`${css.badge} ${css.badgeGreen}`}>Exact</span>;
  if (c === 'LEARNED') return <span className={`${css.badge} ${css.badgeBlue}`}>Learned</span>;
  if (c === 'MANUAL')  return <span className={`${css.badge} ${css.badgeSlate}`}>Manual</span>;
  return <span className={`${css.badge} ${css.badgeRed}`}>Unmatched</span>;
}

function statusBadge(s: SmrLineStatus) {
  if (s === 'RECEIVED')     return <span className={`${css.badge} ${css.badgeGreen}`}>Received</span>;
  if (s === 'PARTIAL')      return <span className={`${css.badge} ${css.badgeAmber}`}>Partial</span>;
  if (s === 'NOT_RECEIVED') return <span className={`${css.badge} ${css.badgeRed}`}>Not Received</span>;
  return <span className={`${css.badge} ${css.badgeSlate}`}>Pending</span>;
}

export default function WarehouseSmrReconcile() {
  const { smrId } = useParams<{ smrId: string }>();
  const { hasPerm, currentUser } = useAuth();
  const navigate = useNavigate();

  const [doc,        setDoc]        = useState<SmrDocument | null>(null);
  const [lines,       setLines]      = useState<ReconcileLine[]>([]);
  const [items,       setItems]      = useState<InventoryItem[]>([]);
  const [loading,     setLoading]    = useState(true);
  const [error,       setError]      = useState('');
  const [activeLineId, setActiveLineId] = useState<string | null>(null);

  const [camPerm, setCamPerm] = useState<CameraPermission>('unknown');
  const [camOn,   setCamOn]   = useState(false);
  const [camErr,  setCamErr]  = useState<string | null>(null);
  const videoRef    = useRef<HTMLVideoElement | null>(null);
  const scannerRef  = useRef<CameraScanner | null>(null);

  const [manualSn, setManualSn] = useState('');
  const [savingQty, setSavingQty] = useState(false);
  const [finalizing, setFinalizing] = useState(false);

  // ── New-item creation (unmatched line whose PN genuinely isn't in the item master) ──
  const [showCreateItem, setShowCreateItem] = useState(false);
  const [newItemForm, setNewItemForm] = useState({
    item_code: '', item_name: '', tracking_method: 'SERIALIZED' as 'SERIALIZED' | 'QUANTITY', unit: 'pcs',
  });
  const [creatingItem, setCreatingItem] = useState(false);
  const [createItemErr, setCreateItemErr] = useState('');

  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  if (!hasPerm('view_warehouse_smr')) return <div className={css.denied}>Access denied.</div>;
  const canScan     = hasPerm('wrh_smr_scan');
  const canFinalize = hasPerm('wrh_smr_finalize');
  const canAddItem  = hasPerm('wrh_items_add');

  // ── Load ─────────────────────────────────────────────────────────────────────
  async function load() {
    if (!smrId) return;
    setLoading(true);
    setError('');

    const [docRes, lineRes, itemRes] = await Promise.all([
      supabase.from('smr_documents').select('*').eq('id', smrId).single(),
      supabase.from('smr_lines').select('*').eq('smr_document_id', smrId).order('line_index'),
      supabase.from('inventory_items').select('*').eq('is_active', true).order('item_name'),
    ]);

    if (docRes.error || !docRes.data) { setError(docRes.error?.message || 'SMR not found.'); setLoading(false); return; }
    const document = docRes.data as SmrDocument;

    const itemRows = (itemRes.data || []) as InventoryItem[];
    setItems(itemRows);
    const itemsById = new Map(itemRows.map(it => [it.id, it]));

    const lineRows = (lineRes.data || []) as Array<{
      id: string; line_index: number; product_number_raw: string | null; description_raw: string | null;
      expected_qty: number; has_serial_flag: boolean; po_reference: string | null;
      matched_item_id: string | null; match_confidence: SmrMatchConfidence;
      received_qty: number; status: SmrLineStatus;
    }>;

    let scansByLine = new Map<string, LineScan[]>();
    if (lineRows.length) {
      const { data: scanRows } = await supabase
        .from('smr_line_scans')
        .select('*')
        .in('smr_line_id', lineRows.map(l => l.id));
      if (scanRows) {
        const grouped = new Map<string, LineScan[]>();
        for (const s of scanRows as Array<{
          id: string; smr_line_id: string; serial_number: string; serial_number_normalized: string;
          raw_scan_value: string; barcode_symbology: string | null; scanned_manually: boolean;
        }>) {
          const arr = grouped.get(s.smr_line_id) ?? [];
          arr.push({
            id: s.id, serialNumber: s.serial_number, serialNumberNorm: s.serial_number_normalized,
            rawScanValue: s.raw_scan_value, barcodeSymbology: s.barcode_symbology, scannedManually: s.scanned_manually,
          });
          grouped.set(s.smr_line_id, arr);
        }
        scansByLine = grouped;
      }
    }

    const built: ReconcileLine[] = lineRows.map(l => {
      const item = l.matched_item_id ? itemsById.get(l.matched_item_id) : undefined;
      return {
        id: l.id, lineIndex: l.line_index, productNumberRaw: l.product_number_raw, descriptionRaw: l.description_raw,
        expectedQty: l.expected_qty, hasSerialFlag: l.has_serial_flag, poReference: l.po_reference,
        matchedItemId: l.matched_item_id, matchedItemCode: item?.item_code ?? null, matchedItemName: item?.item_name ?? null,
        matchConfidence: l.match_confidence, trackingMethod: item?.tracking_method ?? null,
        receivedQty: l.received_qty, status: l.status,
        scans: scansByLine.get(l.id) ?? [],
      };
    });

    setDoc(document);
    setLines(built);
    if (!activeLineId && built.length) setActiveLineId(built[0].id);
    setLoading(false);

    // Transition REVIEWED → RECONCILING on first open
    if (document.status === 'REVIEWED') {
      await supabase.from('smr_documents').update({ status: 'RECONCILING' }).eq('id', document.id);
      setDoc({ ...document, status: 'RECONCILING' });
    }
  }

  useEffect(() => { load(); checkCameraPermission().then(setCamPerm); return () => stopCamera(); }, [smrId]);

  const activeLine = lines.find(l => l.id === activeLineId) ?? null;

  // Only worth suggesting for lines that still need a manual match — an
  // exact/learned match is already trustworthy, so don't second-guess it.
  const fuzzySuggestions = useMemo(() => {
    if (!activeLine || activeLine.matchedItemId) return [];
    return suggestFuzzyMatches(activeLine.descriptionRaw, activeLine.productNumberRaw, items);
  }, [activeLine, items]);

  // ── Persist a line's received_qty / status ──────────────────────────────────
  async function persistLine(lineId: string, patch: { receivedQty: number; status: SmrLineStatus }) {
    setLines(prev => prev.map(l => l.id === lineId ? { ...l, ...patch } : l));
    const { error: e } = await supabase.from('smr_lines')
      .update({ received_qty: patch.receivedQty, status: patch.status })
      .eq('id', lineId);
    if (e) showToast(`Failed to save line: ${e.message}`, false);
  }

  // ── Camera ───────────────────────────────────────────────────────────────────
  async function startCamera() {
    if (!videoRef.current) return;
    setCamErr(null);
    const scanner = new CameraScanner();
    scannerRef.current = scanner;
    try {
      await scanner.start(videoRef.current, {
        onScan:  (raw, symbology) => handleRawScan(raw, symbology, false),
        onError: msg => showToast(msg, false),
        onStart: () => setCamOn(true),
      });
    } catch (e) {
      setCamErr(cameraErrorMessage(e));
      setCamOn(false);
    }
  }

  function stopCamera() {
    scannerRef.current?.stop();
    scannerRef.current = null;
    setCamOn(false);
  }

  // ── Scan handling ────────────────────────────────────────────────────────────
  async function handleRawScan(raw: string, symbology: string, manually: boolean) {
    if (!activeLine) { showToast('Select a line item first.', false); return; }
    if (!activeLine.hasSerialFlag) { showToast('This line is not serialized — enter a quantity instead.', false); return; }
    // Scanning no longer requires a prior match — matching an item just to unlock
    // scanning made it impossible to receive equipment the item master doesn't
    // know about yet. Match (or create a new item) before finalizing instead.

    const parsed = parseScan(raw, symbology);
    const classification = classifyScan(parsed);
    if (classification === 'AUXILIARY_CODE') return; // silently ignored, mirrors WarehouseReceive
    if (!parsed.serialNumber) { showToast('Could not read a serial number from that code.', false); return; }

    const snNorm = normalizeSN(parsed.serialNumber);

    if (isDuplicateScanForLine(activeLine.scans.map(s => ({ serialNumberNormalized: s.serialNumberNorm })), snNorm)) {
      showToast('Already scanned against this line.', false);
      return;
    }
    const dupElsewhere = lines.some(l => l.id !== activeLine.id && l.scans.some(s => s.serialNumberNorm === snNorm));
    if (dupElsewhere) {
      showToast('This serial was already scanned against a different line.', false);
      return;
    }

    const { data, error: e } = await supabase.from('smr_line_scans').insert({
      smr_line_id:       activeLine.id,
      serial_number:     parsed.serialNumber,
      raw_scan_value:    raw,
      barcode_symbology: symbology,
      scanned_manually:  manually,
      scanned_by:        currentUser?.id || null,
    }).select('id, serial_number, serial_number_normalized').single();

    if (e || !data) { showToast(`Failed to save scan: ${e?.message ?? 'unknown error'}`, false); return; }

    const newScan: LineScan = {
      id: data.id, serialNumber: data.serial_number, serialNumberNorm: data.serial_number_normalized,
      rawScanValue: raw, barcodeSymbology: symbology, scannedManually: manually,
    };
    const updatedScans = [...activeLine.scans, newScan];
    const receivedQty  = countUniqueScans(updatedScans.map(s => ({ serialNumberNormalized: s.serialNumberNorm })));
    const status       = computeSmrLineStatus(activeLine.expectedQty, receivedQty, false);

    setLines(prev => prev.map(l => l.id === activeLine.id ? { ...l, scans: updatedScans, receivedQty, status } : l));
    await supabase.from('smr_lines').update({ received_qty: receivedQty, status }).eq('id', activeLine.id);
    showToast(`Scanned ${data.serial_number}`, true);
  }

  async function handleManualAdd() {
    const sn = manualSn.trim();
    if (!sn) return;
    setManualSn('');
    await handleRawScan(sn, 'MANUAL', true);
  }

  async function removeScan(lineId: string, scan: LineScan) {
    const line = lines.find(l => l.id === lineId);
    if (!line) return;
    const { error: e } = await supabase.from('smr_line_scans').delete().eq('id', scan.id);
    if (e) { showToast(`Failed to remove scan: ${e.message}`, false); return; }
    const updatedScans = line.scans.filter(s => s.id !== scan.id);
    const receivedQty  = countUniqueScans(updatedScans.map(s => ({ serialNumberNormalized: s.serialNumberNorm })));
    const status       = computeSmrLineStatus(line.expectedQty, receivedQty, false);
    setLines(prev => prev.map(l => l.id === lineId ? { ...l, scans: updatedScans, receivedQty, status } : l));
    await supabase.from('smr_lines').update({ received_qty: receivedQty, status }).eq('id', lineId);
  }

  // ── Quantity-line handling ───────────────────────────────────────────────────
  async function saveQuantity(lineId: string, qty: number) {
    const line = lines.find(l => l.id === lineId);
    if (!line) return;
    setSavingQty(true);
    const status = computeSmrLineStatus(line.expectedQty, qty, false);
    await persistLine(lineId, { receivedQty: qty, status });
    setSavingQty(false);
  }

  async function markNotReceived(lineId: string) {
    if (!confirm('Mark this line as not received?')) return;
    await persistLine(lineId, { receivedQty: 0, status: 'NOT_RECEIVED' });
  }

  async function resetToPending(lineId: string) {
    await persistLine(lineId, { receivedQty: 0, status: 'PENDING' });
  }

  // ── Re-match an item ─────────────────────────────────────────────────────────
  async function rematchLine(lineId: string, itemId: string) {
    const item = items.find(i => i.id === itemId);
    const confidence: SmrMatchConfidence = itemId ? 'MANUAL' : 'UNMATCHED';
    setLines(prev => prev.map(l => l.id === lineId ? {
      ...l,
      matchedItemId: itemId || null,
      matchedItemCode: item?.item_code ?? null,
      matchedItemName: item?.item_name ?? null,
      trackingMethod: item?.tracking_method ?? null,
      matchConfidence: confidence,
    } : l));
    await supabase.from('smr_lines').update({ matched_item_id: itemId || null, match_confidence: confidence }).eq('id', lineId);
  }

  // ── Manually override a line's scan-vs-quantity mode ──────────────────────────
  // hasSerialFlag comes straight from the customer's SMR PDF (the "serial number"
  // 0/1 column) — it's a best-effort read of their document, not our own
  // classification, so it can simply be wrong on the source paperwork (e.g. a
  // serialized radio unit printed with a 0 in that column). Rather than trying to
  // out-guess a customer's PDF in the parser, let the warehouse user flip it here
  // when they know better, same "extract, then let a human correct it" pattern
  // used throughout this feature.
  async function toggleLineTrackingMode(lineId: string) {
    const line = lines.find(l => l.id === lineId);
    if (!line) return;
    const next = !line.hasSerialFlag;
    setLines(prev => prev.map(l => l.id === lineId ? { ...l, hasSerialFlag: next } : l));
    const { error: e } = await supabase.from('smr_lines').update({ has_serial_flag: next }).eq('id', lineId);
    if (e) {
      showToast(`Failed to switch mode: ${e.message}`, false);
      setLines(prev => prev.map(l => l.id === lineId ? { ...l, hasSerialFlag: !next } : l));
    } else {
      showToast(`Switched to ${next ? 'Scan' : 'Quantity'} mode for this line.`, true);
    }
  }

  // ── Create a brand-new item master row for a PN that genuinely doesn't exist ──
  // (a first-time customer SMR can reference equipment the internal item master has
  // never seen before — no amount of fuzzy suggestion or manual dropdown search will
  // find something that isn't there). Prefills from the active line, then matches the
  // line to it. The PN→item mapping is picked up for free at finalize() time, which
  // already learns a mapping for every MANUAL-confidence matched line.
  function openCreateItem() {
    if (!activeLine) return;
    setNewItemForm({
      item_code:       (activeLine.productNumberRaw || '').trim().toUpperCase(),
      item_name:       activeLine.descriptionRaw || activeLine.productNumberRaw || '',
      tracking_method: activeLine.hasSerialFlag ? 'SERIALIZED' : 'QUANTITY',
      unit:            'pcs',
    });
    setCreateItemErr('');
    setShowCreateItem(true);
  }

  async function createAndMatchItem() {
    if (!activeLine) return;
    const code = newItemForm.item_code.trim().toUpperCase();
    const name = newItemForm.item_name.trim();
    if (!code) { setCreateItemErr('Item code is required.'); return; }
    if (!name) { setCreateItemErr('Item name is required.'); return; }
    if (!newItemForm.unit.trim()) { setCreateItemErr('Unit is required.'); return; }

    setCreatingItem(true);
    setCreateItemErr('');

    const { data: created, error: cErr } = await supabase.from('inventory_items').insert({
      item_code:       code,
      item_name:       name,
      item_type:       null,
      manufacturer:    null,
      part_number:     activeLine.productNumberRaw || null,
      category:        null,
      tracking_method: newItemForm.tracking_method,
      unit:            newItemForm.unit.trim(),
      is_active:       true,
      notes:           `Auto-created from Customer SMR ${doc?.smr_number ?? ''} line #${activeLine.lineIndex}`,
    }).select('*').single();

    if (cErr || !created) {
      setCreatingItem(false);
      setCreateItemErr(cErr?.code === '23505' ? 'Item code already exists — use a unique code.' : (cErr?.message || 'Failed to create item.'));
      return;
    }

    const newItem = created as InventoryItem;
    setItems(prev => [...prev, newItem].sort((a, b) => a.item_name.localeCompare(b.item_name)));

    await rematchLine(activeLine.id, newItem.id);

    if (currentUser) {
      await supabase.from('activity_log').insert({
        user_full_name: currentUser.full_name,
        action: `Created inventory item ${newItem.item_code} from Customer SMR ${doc?.smr_number ?? ''}`,
      });
    }

    setCreatingItem(false);
    setShowCreateItem(false);
    showToast(`Created "${newItem.item_name}" and matched this line.`, true);
  }

  // ── Finalize ─────────────────────────────────────────────────────────────────
  async function finalize() {
    if (!doc) return;
    if (!isSmrReconciliationComplete(lines)) {
      showToast('Resolve every line (received, partial, or not received) before finalizing.', false);
      return;
    }
    // Scanning/qty entry no longer requires a prior match, so a line can reach
    // RECEIVED/PARTIAL while still unmatched — buildReceiptItemsFromSmrLines
    // silently skips unmatched lines, which would otherwise drop real received
    // quantities from the receipt without any warning.
    const receivedButUnmatched = lines.filter(l => !l.matchedItemId && (l.status === 'RECEIVED' || l.status === 'PARTIAL'));
    if (receivedButUnmatched.length > 0) {
      const lineNumbers = receivedButUnmatched.map(l => `#${l.lineIndex}`).join(', ');
      showToast(
        `Line(s) ${lineNumbers} have received quantities but aren't matched to an inventory item yet — match them or create a new item first.`,
        false,
      );
      setActiveLineId(receivedButUnmatched[0].id); // jump straight to the first offender
      return;
    }
    if (!confirm('Finalize this SMR? This creates a goods receipt pending review — it will not post to stock automatically.')) return;

    setFinalizing(true);
    try {
      const receiptItems = buildReceiptItemsFromSmrLines(
        lines.map(l => ({ matchedItemId: l.matchedItemId, receivedQty: l.receivedQty, partNumberRaw: l.productNumberRaw }))
      );
      if (receiptItems.length === 0) {
        showToast('Nothing to post — no matched lines with a received quantity.', false);
        setFinalizing(false);
        return;
      }

      const { data: receipt, error: rErr } = await supabase.from('goods_receipts').insert({
        warehouse_id:          doc.destination_warehouse_id,
        project_id:            doc.project_id,
        supplier_name:         doc.customer_name,
        delivery_note_number:  doc.smr_number,
        purchase_order_number: null,
        receipt_date:          new Date().toISOString().slice(0, 10),
        status:                'PENDING_REVIEW',
        notes:                 `Auto-created from Customer SMR ${doc.smr_number}`,
        received_by:           currentUser?.id || '',
      }).select('id, receipt_number').single();

      if (rErr || !receipt) throw rErr || new Error('Failed to create goods receipt.');

      const { error: liErr } = await supabase.from('goods_receipt_items').insert(
        receiptItems.map(ri => ({
          goods_receipt_id:  receipt.id,
          inventory_item_id: ri.inventory_item_id,
          quantity:          ri.quantity,
          part_number:       ri.part_number,
        }))
      );
      if (liErr) throw liErr;

      const scanLogs = lines
        .filter(l => l.trackingMethod === 'SERIALIZED' && l.matchedItemId)
        .flatMap(l => l.scans.map(s => ({
          goods_receipt_id:  receipt.id,
          inventory_item_id: l.matchedItemId!,
          serial_number:     s.serialNumber,
          part_number:       l.productNumberRaw,
          raw_scan_value:    s.rawScanValue,
          barcode_symbology: s.barcodeSymbology,
          scanned_manually:  s.scannedManually,
        })));
      if (scanLogs.length) {
        const { error: slErr } = await supabase.from('receiving_scan_log').insert(scanLogs);
        if (slErr) throw slErr;
      }

      await supabase.from('smr_documents').update({ status: 'COMPLETED', goods_receipt_id: receipt.id }).eq('id', doc.id);

      // Learn PN mappings from manually-resolved lines (non-fatal if it fails)
      const manualLines = lines.filter(l => l.matchConfidence === 'MANUAL' && l.matchedItemId && l.productNumberRaw);
      if (manualLines.length) {
        await supabase.from('item_code_mappings').upsert(
          manualLines.map(l => ({
            inventory_item_id: l.matchedItemId,
            manufacturer:      null,
            code_type:         MAPPING_CODE_TYPE_PN,
            external_code:     normalizePn(l.productNumberRaw!),
            parsing_profile:   null,
            is_active:         true,
            source:            MAPPING_SOURCE_RECEIVING,
            created_by:        currentUser?.id ?? null,
          })),
          { ignoreDuplicates: true },
        );
      }

      if (currentUser) {
        await supabase.from('activity_log').insert({
          user_full_name: currentUser.full_name,
          action: `Finalized SMR ${doc.smr_number} → goods receipt ${receipt.receipt_number} (pending review)`,
        });
      }

      showToast(`SMR finalized — receipt ${receipt.receipt_number} created, pending review.`, true);
      setTimeout(() => navigate('/warehouse/smr'), 1500);
    } catch (e: unknown) {
      showToast('Finalize failed: ' + (e instanceof Error ? e.message : String(e)), false);
    }
    setFinalizing(false);
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  if (loading) return <div className={css.page}><p style={{ color: '#94a3b8' }}>Loading…</p></div>;
  if (error || !doc) return <div className={css.page}><p className={css.errorMsg}>{error || 'SMR not found.'}</p></div>;

  const summary = summarizeSmrLineStatuses(lines);
  const complete = isSmrReconciliationComplete(lines);

  return (
    <div className={css.page}>
      <div className={css.pageHdr}>
        <div>
          <h1 className={css.pageTitle}>Reconcile SMR {doc.smr_number}</h1>
          <p className={css.pageSubtitle}>
            {doc.customer_name || 'Customer'} · {doc.source_warehouse_name || 'source WH'} → destination warehouse
          </p>
        </div>
        <div className={css.hdrActions}>
          <button className={css.btnGhost} onClick={() => navigate('/warehouse/smr')}>Back to list</button>
          {canFinalize && doc.status !== 'COMPLETED' && doc.status !== 'CANCELLED' && (
            <button className={css.btnAccent} onClick={finalize} disabled={!complete || finalizing}>
              {finalizing ? 'Finalizing…' : 'Finalize to Receipt'}
            </button>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
        <span className={`${css.badge} ${css.badgeSlate}`}>{summary.total} total</span>
        <span className={`${css.badge} ${css.badgeGreen}`}>{summary.received} received</span>
        <span className={`${css.badge} ${css.badgeAmber}`}>{summary.partial} partial</span>
        <span className={`${css.badge} ${css.badgeRed}`}>{summary.notReceived} not received</span>
        <span className={`${css.badge} ${css.badgeSlate}`}>{summary.pending} pending</span>
      </div>

      <div className={css.scanLayout}>
        {/* ── Line list ──────────────────────────────────────────────────────── */}
        <div className={css.scanListWrap}>
          <div className={css.scanListHdr}>
            <span className={css.scanCount}>Line Items ({lines.length})</span>
          </div>
          <div className={css.scanList}>
            {lines.map(l => (
              <div key={l.id}
                className={`${css.scanEntry} ${l.id === activeLineId ? css.scanEntryHighlight : ''}`}
                style={{ cursor: 'pointer' }}
                onClick={() => { setActiveLineId(l.id); setShowCreateItem(false); }}>
                <div style={{ flex: 1 }}>
                  <div className={css.scanSN}>#{l.lineIndex} {l.matchedItemCode || l.productNumberRaw || '—'}</div>
                  <div className={css.scanPN}>{l.descriptionRaw || l.productNumberRaw || ''}</div>
                  <div className={css.scanItem}>{l.receivedQty} / {l.expectedQty} {l.hasSerialFlag ? 'scanned' : 'received'}</div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                  {statusBadge(l.status)}
                  {matchBadge(l.matchConfidence)}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Active line detail ─────────────────────────────────────────────── */}
        <div className={css.videoWrap} style={{ position: 'static', aspectRatio: 'auto', padding: 16 }}>
          {!activeLine ? (
            <p style={{ color: '#94a3b8' }}>Select a line item to begin.</p>
          ) : (
            <div className={css.fieldset}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>#{activeLine.lineIndex} — {activeLine.descriptionRaw || activeLine.productNumberRaw || 'Line item'}</div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                  PN: {activeLine.productNumberRaw || '—'} · Expected: {activeLine.expectedQty} · {statusBadge(activeLine.status)}
                </div>
                {canScan && (
                  <button type="button" className={css.btnGhost} style={{ marginTop: 8, fontSize: 12 }}
                    onClick={() => toggleLineTrackingMode(activeLine.id)}
                    title="Use this if the SMR PDF's serial-number column looks wrong for this item">
                    Wrong mode? Switch to {activeLine.hasSerialFlag ? 'Quantity' : 'Scan'} mode
                  </button>
                )}
              </div>

              <div className={css.field}>
                <label className={css.label}>Matched Inventory Item</label>
                {fuzzySuggestions.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.5px' }}>
                      Suggested matches
                    </div>
                    {fuzzySuggestions.map(s => (
                      <button key={s.itemId} type="button" className={css.btnGhost}
                        style={{ display: 'flex', justifyContent: 'space-between', textAlign: 'left', width: '100%' }}
                        onClick={() => rematchLine(activeLine.id, s.itemId)}>
                        <span>{s.itemCode} — {s.itemName}</span>
                        <span style={{ color: '#94a3b8', fontSize: 11, marginLeft: 8 }}>{Math.round(s.score * 100)}%</span>
                      </button>
                    ))}
                  </div>
                )}
                <select className={`${css.input} ${css.fieldSelect}`} value={activeLine.matchedItemId ?? ''}
                  onChange={e => rematchLine(activeLine.id, e.target.value)}>
                  <option value="">— Unmatched —</option>
                  {items.map(it => <option key={it.id} value={it.id}>{it.item_code} — {it.item_name}</option>)}
                </select>

                {!activeLine.matchedItemId && canAddItem && (
                  showCreateItem ? (
                    <div style={{ border: '1px dashed #475569', borderRadius: 8, padding: 10, marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.5px' }}>
                        New Inventory Item
                      </div>
                      <input className={css.input} placeholder="Item code" value={newItemForm.item_code}
                        onChange={e => setNewItemForm(f => ({ ...f, item_code: e.target.value.toUpperCase() }))} />
                      <input className={css.input} placeholder="Item name" value={newItemForm.item_name}
                        onChange={e => setNewItemForm(f => ({ ...f, item_name: e.target.value }))} />
                      <div style={{ display: 'flex', gap: 8 }}>
                        <select className={`${css.input} ${css.fieldSelect}`} value={newItemForm.tracking_method}
                          onChange={e => setNewItemForm(f => ({ ...f, tracking_method: e.target.value as 'SERIALIZED' | 'QUANTITY' }))}>
                          <option value="SERIALIZED">Serialized</option>
                          <option value="QUANTITY">Quantity</option>
                        </select>
                        <input className={css.input} placeholder="Unit" value={newItemForm.unit} style={{ maxWidth: 90 }}
                          onChange={e => setNewItemForm(f => ({ ...f, unit: e.target.value }))} />
                      </div>
                      {createItemErr && <p style={{ fontSize: 12, color: '#dc2626' }}>{createItemErr}</p>}
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className={css.btnAccent} disabled={creatingItem} onClick={createAndMatchItem}>
                          {creatingItem ? 'Creating…' : 'Create & Match'}
                        </button>
                        <button className={css.btnGhost} onClick={() => setShowCreateItem(false)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" className={css.btnGhost} style={{ marginTop: 8 }} onClick={openCreateItem}>
                      + Create New Item (PN not in item master)
                    </button>
                  )
                )}
              </div>

              {!activeLine.matchedItemId && (
                <p style={{ fontSize: 12, color: '#ca8a04' }}>
                  Not matched yet — you can still scan or record a quantity now, but match this line (or create a new item) before finalizing.
                </p>
              )}

              {activeLine.hasSerialFlag ? (
                <>
                  {!canScan ? (
                    <p style={{ fontSize: 12, color: '#94a3b8' }}>You don't have permission to scan.</p>
                  ) : (
                    <>
                      {camOn ? (
                        <div>
                          <video ref={videoRef} className={css.videoEl} style={{ maxHeight: 260, borderRadius: 8 }} />
                          <button className={css.btnGhost} style={{ marginTop: 8 }} onClick={stopCamera}>Stop Camera</button>
                        </div>
                      ) : (
                        <div>
                          <video ref={videoRef} style={{ display: 'none' }} />
                          <button className={css.btnAccent} onClick={startCamera}>Start Camera</button>
                          {camErr && <p style={{ fontSize: 12, color: '#dc2626', marginTop: 6 }}>{camErr}</p>}
                          {camPerm === 'denied' && <p style={{ fontSize: 12, color: '#dc2626', marginTop: 6 }}>Camera permission denied — allow it in browser settings.</p>}
                        </div>
                      )}
                      <div className={css.manualRow} style={{ marginTop: 12 }}>
                        <input className={`${css.input} ${css.manualInput}`} placeholder="Manual serial entry…"
                          value={manualSn} onChange={e => setManualSn(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') handleManualAdd(); }} />
                        <button className={css.btnSm} onClick={handleManualAdd}>Add</button>
                      </div>
                    </>
                  )}

                  <div style={{ fontSize: 12, fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.5px', marginTop: 10 }}>
                    Scanned Serials ({activeLine.scans.length})
                  </div>
                  {activeLine.scans.length === 0 ? (
                    <p style={{ fontSize: 12, color: '#94a3b8' }}>No serials scanned yet.</p>
                  ) : (
                    <div className={css.scanList}>
                      {activeLine.scans.map(s => (
                        <div key={s.id} className={css.scanEntry}>
                          <div style={{ flex: 1 }}>
                            <div className={css.scanSN}>{s.serialNumber}</div>
                            {s.scannedManually && <div className={css.scanPN}>Manual entry</div>}
                          </div>
                          {canScan && (
                            <button className={css.btnIcon} onClick={() => removeScan(activeLine.id, s)}>×</button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className={css.fieldRow}>
                  <div className={css.field}>
                    <label className={css.label}>Received Qty</label>
                    <input type="number" step="0.01" className={css.input} value={activeLine.receivedQty}
                      onChange={e => setLines(prev => prev.map(l => l.id === activeLine.id ? { ...l, receivedQty: parseFloat(e.target.value) || 0 } : l))} />
                  </div>
                  <div className={css.field} style={{ justifyContent: 'flex-end', flexDirection: 'row', display: 'flex', gap: 8 }}>
                    <button className={css.btnAccent} disabled={savingQty} onClick={() => saveQuantity(activeLine.id, activeLine.receivedQty)}>
                      {savingQty ? 'Saving…' : 'Save Qty'}
                    </button>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                {activeLine.status !== 'NOT_RECEIVED' ? (
                  <button className={css.btnGhost} onClick={() => markNotReceived(activeLine.id)}>Mark Not Received</button>
                ) : (
                  <button className={css.btnGhost} onClick={() => resetToPending(activeLine.id)}>Reset to Pending</button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {toast && (
        <div className={`${css.toast} ${toast.ok ? css.toastOk : css.toastErr}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
