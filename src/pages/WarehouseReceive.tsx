import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import {
  CameraScanner, UsbScanner, parseScan, classifyScan, decodeAllDIFields,
  checkCameraPermission, cameraErrorMessage, getScanDiagnostics,
  type CameraPermission, type ScanDiagnostics, type DIField,
} from '../lib/warehouseScanner';
import type { Warehouse, InventoryItem, ScanEntry, SessionDetails } from '../lib/warehouseTypes';
import { normalizeSN } from '../lib/warehouseTypes';
import { readLabel, terminateOcrWorker, type OcrResult } from '../lib/labelOcr';
import { mergeScanAndOcr, type BarcodeSource } from '../lib/smartLabelMerge';
import css from './Warehouse.module.css';

type Step = 1 | 2 | 3;
type InputMode = 'camera' | 'usb' | 'manual';
type HudState = 'IDLE' | 'SUCCESS' | 'DUPLICATE' | 'UNKNOWN' | 'OCR_PROCESSING' | 'OCR_SUCCESS' | 'OCR_FAILED';

const EMPTY_SESSION: SessionDetails = {
  warehouseId: '', receiptDate: new Date().toISOString().slice(0, 10),
  supplierName: '', deliveryNote: '', poNumber: '', notes: '',
};

export default function WarehouseReceive() {
  const { hasPerm, currentUser } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>(1);
  const [session, setSession] = useState<SessionDetails>(EMPTY_SESSION);
  const [sessionErr, setSessionErr] = useState('');

  // Step 2 — scan
  const [inputMode, setInputMode] = useState<InputMode>('camera');
  const [camPerm, setCamPerm] = useState<CameraPermission>('unknown');
  const [camActive, setCamActive] = useState(false);
  const [camErr, setCamErr] = useState<string | null>(null);
  const [torch, setTorch] = useState(false);
  const [showDiag, setShowDiag] = useState(false);
  const [diagData, setDiagData] = useState<ScanDiagnostics | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [scanFlash, setScanFlash] = useState(false);

  // HUD overlay
  const [hudState, setHudState] = useState<HudState>('IDLE');
  // Duplicate highlight — briefly marks the existing entry
  const [highlightSN, setHighlightSN] = useState<string | null>(null);
  // Duplicate event counter (not entry count)
  const [duplicateCount, setDuplicateCount] = useState(0);
  // Collapsed/expanded diagnostics per scan card
  const [expandedDiags, setExpandedDiags] = useState<Set<string>>(new Set());
  // OCR state
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);

  const videoRef    = useRef<HTMLVideoElement>(null);
  const scannerRef  = useRef<CameraScanner | null>(null);
  const usbRef      = useRef<UsbScanner | null>(null);
  const flashTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hudTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hlTimer     = useRef<ReturnType<typeof setTimeout> | null>(null);

  // O(1) session dedup — holds normalized SNs of all entries in this session
  const sessionSNs  = useRef<Set<string>>(new Set());
  // O(1) item master lookup maps built when items load
  const itemsByPN    = useRef<Map<string, InventoryItem>>(new Map());
  const itemsByCode  = useRef<Map<string, InventoryItem>>(new Map());
  // Item type / item code vocabulary for OCR label matching
  const itemTypeCodes = useRef<Set<string>>(new Set());

  const [scanEntries, setScanEntries] = useState<ScanEntry[]>([]);

  // Manual entry — structured
  const [manualVal, setManualVal] = useState('');
  const [manualType, setManualType] = useState('');
  const [manualPN, setManualPN] = useState('');
  const [manualErr, setManualErr] = useState('');
  const [batchMode, setBatchMode] = useState(false);

  const [items, setItems] = useState<InventoryItem[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);

  // Step 3 — review
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  if (!hasPerm('view_warehouse_receive')) return <div className={css.denied}>Access denied.</div>;
  if (!hasPerm('wrh_receive_create'))    return <div className={css.denied}>You need the "Create Receipt" permission.</div>;

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  // ── Load master data ──────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const [wRes, iRes] = await Promise.all([
        supabase.from('warehouses').select('*').eq('is_active', true).order('name'),
        supabase.from('inventory_items').select('*').eq('is_active', true).order('item_name'),
      ]);
      if (wRes.data) setWarehouses(wRes.data as Warehouse[]);
      if (iRes.data) {
        const rows = iRes.data as InventoryItem[];
        setItems(rows);
        // Build O(1) lookup maps
        const byPN      = new Map<string, InventoryItem>();
        const byCode    = new Map<string, InventoryItem>();
        const typeCodes = new Set<string>();
        for (const it of rows) {
          if (it.part_number) byPN.set(it.part_number.toUpperCase(), it);
          byCode.set(it.item_code.toUpperCase(), it);
          typeCodes.add(it.item_code.toUpperCase());
          if (it.item_type) {
            byCode.set(it.item_type.toUpperCase(), it);
            typeCodes.add(it.item_type.toUpperCase());
          }
        }
        itemsByPN.current    = byPN;
        itemsByCode.current  = byCode;
        itemTypeCodes.current = typeCodes;
      }
      const perm = await checkCameraPermission();
      setCamPerm(perm);
    })();
    return () => { stopCamera(); terminateOcrWorker(); };
  }, []);

  // ── Diagnostics ───────────────────────────────────────────────────────────
  async function loadDiag() {
    setDiagLoading(true);
    const d = await getScanDiagnostics();
    setDiagData(d);
    setDiagLoading(false);
  }

  // ── HUD overlay ───────────────────────────────────────────────────────────
  function setHud(state: 'SUCCESS' | 'DUPLICATE' | 'UNKNOWN') {
    setHudState(state);
    if (hudTimer.current) clearTimeout(hudTimer.current);
    hudTimer.current = setTimeout(() => setHudState('IDLE'), 1200);
  }

  function setHudOcr(state: 'OCR_PROCESSING' | 'OCR_SUCCESS' | 'OCR_FAILED') {
    setHudState(state);
    if (hudTimer.current) clearTimeout(hudTimer.current);
    if (state !== 'OCR_PROCESSING') {
      hudTimer.current = setTimeout(() => setHudState('IDLE'), 2500);
    }
  }

  // ── Audio / haptic feedback ───────────────────────────────────────────────
  function playSuccessBeep() {
    try {
      type AC = typeof AudioContext;
      const Ctor: AC = window.AudioContext ??
        (window as unknown as { webkitAudioContext: AC }).webkitAudioContext;
      if (!Ctor) return;
      const ctx  = new Ctor();
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 1200;
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.start(); osc.stop(ctx.currentTime + 0.15);
    } catch { /* AudioContext not available */ }
  }
  function vibrateOnce() { navigator.vibrate?.(50); }
  function vibrateDup()  { navigator.vibrate?.([50, 50, 50]); }

  // ── Camera ────────────────────────────────────────────────────────────────
  async function startCamera() {
    if (!videoRef.current) return;
    setCamErr(null);
    const scanner = new CameraScanner();
    scannerRef.current = scanner;
    try {
      await scanner.start(videoRef.current, {
        onScan:  (raw, symbology) => handleRawScan(raw, symbology, false),
        onError: msg => showToast(msg, false),
        onStart: () => {
          setCamActive(true);
          setCamPerm('granted');
        },
      });
    } catch (err: unknown) {
      const msg = cameraErrorMessage(err);
      setCamErr(msg);
      const name = (err as DOMException).name;
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setCamPerm('denied');
      }
      scannerRef.current?.stop();
      scannerRef.current = null;
    }
  }

  function stopCamera() {
    scannerRef.current?.stop();
    scannerRef.current = null;
    setCamActive(false);
    setTorch(false);
    setHudState('IDLE');
  }

  // ── OCR — Read Label ──────────────────────────────────────────────────────
  async function handleReadLabel() {
    if (!videoRef.current || !camActive) return;

    // Identify which entry to update BEFORE the async OCR call to avoid stale-closure issues.
    // We look for the most recent PENDING entry (within 30 seconds of tapping Read Label).
    const cutoff = Date.now() - 30_000;
    const targetEntry = scanEntries.find(e =>
      !e.resolvedItemId && new Date(e.scannedAt).getTime() > cutoff
    );

    setOcrLoading(true);
    setOcrError(null);
    setHudOcr('OCR_PROCESSING');

    try {
      const ocr = await readLabel(videoRef.current, itemTypeCodes.current);
      if (targetEntry) {
        applyOcrToEntry(targetEntry.localId, targetEntry, ocr);
      } else {
        addOcrOnlyEntry(ocr);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Label read failed.';
      setOcrError(msg);
      setHudOcr('OCR_FAILED');
    } finally {
      setOcrLoading(false);
    }
  }

  // Merge an OCR result into an existing scan entry (captured before the async call).
  function applyOcrToEntry(localId: string, snapshot: ScanEntry, ocr: OcrResult) {
    const barcode: BarcodeSource | null =
      snapshot.partNumber || snapshot.serialNumber || snapshot.itemTypeRaw
        ? { serialNumber: snapshot.serialNumber, partNumber: snapshot.partNumber, itemType: snapshot.itemTypeRaw }
        : null;

    const merged = mergeScanAndOcr({ barcode, ocr });

    let rid   = snapshot.resolvedItemId;
    let rname = snapshot.resolvedItemName;
    let rcode = snapshot.resolvedItemCode;

    if (!rid) {
      if (merged.itemType) {
        const it = itemsByCode.current.get(merged.itemType.toUpperCase());
        if (it) { rid = it.id; rname = it.item_name; rcode = it.item_code; }
      }
      if (!rid && merged.partNumber) {
        const it = itemsByPN.current.get(merged.partNumber.toUpperCase());
        if (it) { rid = it.id; rname = it.item_name; rcode = it.item_code; }
      }
    }

    const matchStatus: ScanEntry['matchStatus'] =
      rid               ? 'MATCHED'   :
      merged.partNumber ? 'UNMATCHED' : 'NO_PN';

    setScanEntries(prev => prev.map(e => e.localId !== localId ? e : {
      ...e,
      itemTypeRaw:      merged.itemType ?? e.itemTypeRaw,
      resolvedItemId:   rid,
      resolvedItemName: rname,
      resolvedItemCode: rcode,
      status:           rid ? 'VALID' as const : 'PENDING' as const,
      statusMsg:        rid ? null : 'Item not matched — select manually',
      matchStatus,
      ocrRawText:       ocr.rawText.substring(0, 500),
      ocrItemType:      merged.source.itemType === 'OCR'       ? merged.itemType     : null,
      ocrPartNumber:    merged.source.partNumber === 'OCR'     ? merged.partNumber   : null,
      ocrSerialNumber:  merged.source.serialNumber === 'OCR'   ? merged.serialNumber : null,
      mergeConflicts:   merged.conflicts,
      mergeScenario:    merged.scenario,
      ocrDurationMs:    ocr.durationMs,
    }));

    setHudOcr('OCR_SUCCESS');
    if (rid) { playSuccessBeep(); vibrateOnce(); }
  }

  // Create a new scan entry from OCR alone (text-only label scenario).
  function addOcrOnlyEntry(ocr: OcrResult) {
    const merged = mergeScanAndOcr({ barcode: null, ocr });

    if (!merged.serialNumber && !merged.partNumber && !merged.itemType) {
      setOcrError('No recognizable data found on label.');
      setHudOcr('OCR_FAILED');
      return;
    }

    const parts = [merged.itemType, merged.partNumber, merged.serialNumber].filter(Boolean);
    const raw   = parts.length > 0 ? parts.join(';') : ocr.rawText.substring(0, 100);

    let rid: string | null = null, rname: string | null = null, rcode: string | null = null;
    if (merged.itemType) {
      const it = itemsByCode.current.get(merged.itemType.toUpperCase());
      if (it) { rid = it.id; rname = it.item_name; rcode = it.item_code; }
    }
    if (!rid && merged.partNumber) {
      const it = itemsByPN.current.get(merged.partNumber.toUpperCase());
      if (it) { rid = it.id; rname = it.item_name; rcode = it.item_code; }
    }

    const snNorm = merged.serialNumber ? normalizeSN(merged.serialNumber) : null;
    if (snNorm && sessionSNs.current.has(snNorm)) {
      setDuplicateCount(c => c + 1); setHud('DUPLICATE'); vibrateDup(); return;
    }

    const entry: ScanEntry = {
      localId:          crypto.randomUUID(),
      rawValue:         raw,
      symbology:        'OCR',
      serialNumber:     merged.serialNumber,
      serialNumberNorm: snNorm,
      partNumber:       merged.partNumber,
      itemTypeRaw:      merged.itemType,
      resolvedItemId:   rid,
      resolvedItemName: rname,
      resolvedItemCode: rcode,
      status:           rid ? 'VALID' : 'PENDING',
      statusMsg:        rid ? null : 'Item not matched — select manually',
      scannedAt:        new Date().toISOString(),
      manually:         false,
      parsingProfile:   'ocr',
      parseStatus:      merged.serialNumber || merged.partNumber ? 'PARTIAL' : 'FAILED',
      matchStatus:      rid ? 'MATCHED' : merged.partNumber ? 'UNMATCHED' : 'NO_PN',
      scanClassification: rid ? 'VALID_ITEM' : 'PARTIAL_ITEM',
      ocrRawText:       ocr.rawText.substring(0, 500),
      ocrItemType:      merged.itemType,
      ocrPartNumber:    merged.partNumber,
      ocrSerialNumber:  merged.serialNumber,
      mergeConflicts:   [],
      mergeScenario:    'OCR_ONLY',
      ocrDurationMs:    ocr.durationMs,
    };

    if (snNorm) sessionSNs.current.add(snNorm);
    setScanEntries(prev => [entry, ...prev]);
    setHudOcr('OCR_SUCCESS');
    if (rid) { playSuccessBeep(); vibrateOnce(); }
  }

  async function toggleTorch() {
    if (!scannerRef.current) return;
    const newVal = await scannerRef.current.toggleTorch();
    setTorch(newVal);
  }

  async function switchCamera() {
    if (!videoRef.current || !scannerRef.current) return;
    try {
      await scannerRef.current.switchCamera(videoRef.current, {
        onScan:  (raw, symbology) => handleRawScan(raw, symbology, false),
        onError: msg => showToast(msg, false),
        onStart: () => {},
      });
    } catch (err: unknown) {
      showToast(cameraErrorMessage(err), false);
    }
  }

  // ── USB scanner ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (step !== 2 || inputMode !== 'usb') return;
    const usb = new UsbScanner(document.body, {
      onScan: raw => handleRawScan(raw, 'USB_HID', false),
    });
    usb.attach();
    usbRef.current = usb;
    return () => { usb.detach(); usbRef.current = null; };
  }, [step, inputMode]);

  // ── Core scan handler ─────────────────────────────────────────────────────
  function handleRawScan(raw: string, symbology: string, manually: boolean) {
    setScanFlash(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setScanFlash(false), 250);

    const parsed         = parseScan(raw, symbology);
    const classification = classifyScan(parsed);

    // Filter auxiliary / unknown noise from camera and USB — not from manual entry
    if (!manually && (classification === 'AUXILIARY_CODE' || classification === 'UNKNOWN_CODE')) {
      return;
    }

    const sn     = parsed.serialNumber;
    const snNorm = sn ? normalizeSN(sn) : null;

    // O(1) duplicate check
    if (snNorm && sessionSNs.current.has(snNorm)) {
      setDuplicateCount(c => c + 1);
      // Briefly highlight the existing card
      setHighlightSN(snNorm);
      if (hlTimer.current) clearTimeout(hlTimer.current);
      hlTimer.current = setTimeout(() => setHighlightSN(null), 2000);
      setHud('DUPLICATE');
      vibrateDup();
      console.log('[ScanDiag] DUPLICATE', { rawValue: raw, snNorm });
      return;
    }

    // O(1) item master lookup
    const resolveItem = (): { id: string | null; name: string | null; code: string | null } => {
      if (parsed.partNumber) {
        const it = itemsByPN.current.get(parsed.partNumber.toUpperCase());
        if (it) return { id: it.id, name: it.item_name, code: it.item_code };
      }
      if (parsed.itemType) {
        const it = itemsByCode.current.get(parsed.itemType.toUpperCase());
        if (it) return { id: it.id, name: it.item_name, code: it.item_code };
      }
      return { id: null, name: null, code: null };
    };
    const resolved = resolveItem();

    const parseStatus: ScanEntry['parseStatus'] =
      parsed.status === 'resolved'           ? 'RESOLVED' :
      parsed.status === 'partially_resolved' ? 'PARTIAL'  : 'FAILED';

    const matchStatus: ScanEntry['matchStatus'] =
      resolved.id       ? 'MATCHED'   :
      parsed.partNumber ? 'UNMATCHED' : 'NO_PN';

    const status: ScanEntry['status'] = resolved.id ? 'VALID' : 'PENDING';

    const localId = crypto.randomUUID();
    const entry: ScanEntry = {
      localId,
      rawValue:           raw,
      symbology,
      serialNumber:       sn,
      serialNumberNorm:   snNorm,
      partNumber:         parsed.partNumber,
      itemTypeRaw:        parsed.itemType,
      resolvedItemId:     resolved.id,
      resolvedItemName:   resolved.name,
      resolvedItemCode:   resolved.code,
      status,
      statusMsg:          resolved.id ? null : 'Item not matched — select manually',
      scannedAt:          new Date().toISOString(),
      manually,
      parsingProfile:     parsed.parsingProfile,
      parseStatus,
      matchStatus,
      scanClassification: classification,
    };

    if (snNorm) sessionSNs.current.add(snNorm);
    setScanEntries(prev => [entry, ...prev]);

    console.log('[ScanDiag]', {
      rawValue:  raw,
      symbology,
      // All GS-separated DI fields — key for Nokia payload investigation
      diFields:  parsed.diFields ?? decodeAllDIFields(raw),
      extracted: { itemType: parsed.itemType, partNumber: parsed.partNumber, serialNumber: parsed.serialNumber },
      parser:    parsed.parsingProfile,
      classification, parseStatus, matchStatus,
    });

    if (resolved.id) {
      setHud('SUCCESS');
      playSuccessBeep();
      vibrateOnce();
    } else {
      setHud('UNKNOWN');
    }
  }

  function removeEntry(localId: string) {
    setScanEntries(prev => {
      const entry = prev.find(e => e.localId === localId);
      if (entry?.serialNumberNorm) sessionSNs.current.delete(entry.serialNumberNorm);
      return prev.filter(e => e.localId !== localId);
    });
  }

  function toggleDiag(localId: string) {
    setExpandedDiags(prev => {
      const next = new Set(prev);
      next.has(localId) ? next.delete(localId) : next.add(localId);
      return next;
    });
  }

  function manualSubmit() {
    const sn = manualVal.trim();
    if (!sn) { setManualErr('Serial number is required.'); return; }
    setManualErr('');
    const type = manualType.trim();
    const pn   = manualPN.trim();
    const raw  = (type || pn) ? [type, pn, sn].filter(Boolean).join(';') : sn;
    setManualVal('');
    if (!batchMode) { setManualType(''); setManualPN(''); }
    handleRawScan(raw, 'MANUAL', true);
  }

  function resolveEntryItem(localId: string, itemId: string) {
    const item = items.find(i => i.id === itemId);
    setScanEntries(prev => prev.map(e =>
      e.localId === localId
        ? { ...e, resolvedItemId: itemId, resolvedItemName: item?.item_name || null,
            resolvedItemCode: item?.item_code || null, status: 'VALID' as const,
            statusMsg: null, matchStatus: 'MATCHED' as const }
        : e
    ));
  }

  // ── Step navigation ────────────────────────────────────────────────────────
  function goStep2() {
    setSessionErr('');
    if (!session.warehouseId) { setSessionErr('Select a warehouse.'); return; }
    if (!session.receiptDate) { setSessionErr('Receipt date is required.'); return; }
    setStep(2);
  }

  function goStep3() {
    if (!scanEntries.length) {
      showToast('Scan at least one item before proceeding.', false); return;
    }
    stopCamera();
    setStep(3);
  }

  // ── Save receipt ──────────────────────────────────────────────────────────
  async function saveReceipt() {
    setSaving(true);
    const validEntries = scanEntries.filter(e => e.status === 'VALID');

    const { data: receipt, error: rErr } = await supabase
      .from('goods_receipts')
      .insert({
        warehouse_id:          session.warehouseId,
        supplier_name:         session.supplierName || null,
        delivery_note_number:  session.deliveryNote || null,
        purchase_order_number: session.poNumber || null,
        receipt_date:          session.receiptDate,
        status:                'PENDING_REVIEW',
        notes:                 session.notes || null,
        received_by:           currentUser?.id || '',
      })
      .select('id, receipt_number')
      .single();

    if (rErr || !receipt) {
      showToast(rErr?.message || 'Failed to create receipt.', false);
      setSaving(false);
      return;
    }

    await supabase.from('receiving_scan_sessions').insert({
      goods_receipt_id: receipt.id,
      operator_id:      currentUser?.id || '',
      total_scans:      scanEntries.length,
      valid_scans:      validEntries.length,
    });

    const groupedForSave: Record<string, { itemId: string; entries: ScanEntry[] }> = {};
    for (const e of validEntries) {
      if (!e.resolvedItemId) continue;
      if (!groupedForSave[e.resolvedItemId])
        groupedForSave[e.resolvedItemId] = { itemId: e.resolvedItemId, entries: [] };
      groupedForSave[e.resolvedItemId].entries.push(e);
    }

    const lineItems = Object.values(groupedForSave).map(g => ({
      goods_receipt_id:  receipt.id,
      inventory_item_id: g.itemId,
      quantity:          g.entries.length,
      part_number:       g.entries[0].partNumber || null,
    }));
    if (lineItems.length) {
      const { error: liErr } = await supabase.from('goods_receipt_items').insert(lineItems);
      if (liErr) showToast(`Warning: line items not saved — ${liErr.message}`, false);
    }

    const scanLogs = validEntries.map(e => ({
      goods_receipt_id:  receipt.id,
      inventory_item_id: e.resolvedItemId!,
      serial_number:     e.serialNumber || e.rawValue,
      raw_scan_value:    e.rawValue,
      barcode_symbology: e.symbology,
      scanned_manually:  e.manually,
    }));
    if (scanLogs.length) await supabase.from('receiving_scan_log').insert(scanLogs);

    if (currentUser) {
      await supabase.from('activity_log').insert({
        user_full_name: currentUser.full_name,
        action: `Created goods receipt ${receipt.receipt_number} (${validEntries.length} items)`,
      });
    }

    setSaving(false);
    showToast(`Receipt ${receipt.receipt_number} saved — pending review.`, true);
    setTimeout(() => navigate('/warehouse/history'), 1500);
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const validCount   = scanEntries.filter(e => e.status === 'VALID').length;
  const pendingCount = scanEntries.filter(e => e.status === 'PENDING').length;

  const grouped = scanEntries
    .filter(e => e.status === 'VALID')
    .reduce<Record<string, ScanEntry[]>>((acc, e) => {
      const key = e.resolvedItemCode || 'UNMATCHED';
      if (!acc[key]) acc[key] = [];
      acc[key].push(e);
      return acc;
    }, {});

  const warehouseName = warehouses.find(w => w.id === session.warehouseId)?.name;

  return (
    <div className={css.page}>
      <WizardHeader step={step} />

      {/* ── Step 1: Receipt details ───────────────────────────────────────── */}
      {step === 1 && (
        <div className={css.card}>
          <div className={css.cardHdr}>
            <span className={css.cardTitle}>Receipt Details</span>
          </div>
          <div className={css.cardBody}>
            <div className={css.fieldset}>
              <div className={css.fieldRow}>
                <div className={css.field}>
                  <label className={css.label}>Warehouse *</label>
                  <select className={`${css.input} ${css.fieldSelect}`}
                    value={session.warehouseId}
                    onChange={e => setSession(s => ({ ...s, warehouseId: e.target.value }))}>
                    <option value="">— Select Warehouse —</option>
                    {warehouses.map(w => <option key={w.id} value={w.id}>{w.name} ({w.code})</option>)}
                  </select>
                </div>
                <div className={css.field}>
                  <label className={css.label}>Receipt Date *</label>
                  <input type="date" className={css.input}
                    value={session.receiptDate}
                    onChange={e => setSession(s => ({ ...s, receiptDate: e.target.value }))} />
                </div>
              </div>
              <div className={css.field}>
                <label className={css.label}>Supplier / Vendor</label>
                <input className={css.input} placeholder="Nokia, Huawei, local vendor…"
                  value={session.supplierName}
                  onChange={e => setSession(s => ({ ...s, supplierName: e.target.value }))} />
              </div>
              <div className={css.fieldRow}>
                <div className={css.field}>
                  <label className={css.label}>Delivery Note #</label>
                  <input className={css.input} placeholder="DN-XXXXX"
                    value={session.deliveryNote}
                    onChange={e => setSession(s => ({ ...s, deliveryNote: e.target.value }))} />
                </div>
                <div className={css.field}>
                  <label className={css.label}>Purchase Order #</label>
                  <input className={css.input} placeholder="PO-XXXXX"
                    value={session.poNumber}
                    onChange={e => setSession(s => ({ ...s, poNumber: e.target.value }))} />
                </div>
              </div>
              <div className={css.field}>
                <label className={css.label}>Notes</label>
                <textarea className={`${css.input} ${css.textarea}`}
                  value={session.notes} rows={2}
                  onChange={e => setSession(s => ({ ...s, notes: e.target.value }))}
                  placeholder="Optional notes…" />
              </div>
              {sessionErr && <p className={css.formError}>{sessionErr}</p>}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                <button className={css.btnAccent} onClick={goStep2}>
                  Next: Scan Items <ChevronRightIcon />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Step 2: Scan ─────────────────────────────────────────────────── */}
      {step === 2 && (
        <>
          {/* KPI strip */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
            <KpiChip label="Scanned"      value={scanEntries.length} color="#6366f1" />
            <KpiChip label="Valid"         value={validCount}         color="#16a34a" />
            <KpiChip label="Needs Review"  value={pendingCount}       color="#f59e0b" />
            <KpiChip label="Duplicates"    value={duplicateCount}     color="#dc2626" />
          </div>

          {/* Live item tally */}
          {validCount > 0 && (
            <div className={css.groupSummary}>
              {Object.entries(grouped).map(([code, entries]) => (
                <div key={code} className={css.groupSummaryItem}>
                  <span className={css.groupSummaryCode}>{code}</span>
                  <span className={css.groupSummaryCount}>{entries.length}</span>
                </div>
              ))}
            </div>
          )}

          {/* Input mode selector */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {(['camera', 'usb', 'manual'] as InputMode[]).map(m => (
              <button key={m}
                className={inputMode === m ? css.btnAccent : css.btnGhost}
                style={{ textTransform: 'capitalize', fontSize: 12, height: 32 }}
                onClick={() => { if (m !== 'camera' && camActive) stopCamera(); setInputMode(m); }}>
                {m === 'camera' ? '📷 Camera' : m === 'usb' ? '🔌 USB Scanner' : '⌨️ Manual'}
              </button>
            ))}
          </div>

          <div className={css.scanLayout}>
            {/* Left — input panel */}
            <div>
              {inputMode === 'camera' && (
                <>
                  {/*
                   * <video> is ALWAYS in the DOM when camera mode is active.
                   * We toggle visibility via display. This ensures videoRef.current
                   * is non-null when startCamera() is called.
                   */}
                  <div style={{ display: camActive ? 'block' : 'none' }}>
                    <div
                      className={css.videoWrap}
                      style={scanFlash ? { outline: '3px solid #16a34a', outlineOffset: 2 } : {}}>
                      <video ref={videoRef} className={css.videoEl} autoPlay playsInline muted />
                      <div className={css.videoOverlay}>
                        <div className={css.scanFrame} />
                      </div>
                      {/* HUD state banner */}
                      {hudState !== 'IDLE' && (
                        <div className={`${css.hudBanner} ${
                          hudState === 'SUCCESS'        ? css.hudSuccess    :
                          hudState === 'DUPLICATE'      ? css.hudDuplicate  :
                          hudState === 'OCR_PROCESSING' ? css.hudOcrProcess :
                          hudState === 'OCR_SUCCESS'    ? css.hudOcrSuccess :
                          hudState === 'OCR_FAILED'     ? css.hudOcrFailed  : css.hudUnknown
                        }`}>
                          {hudState === 'SUCCESS'        ? '✓ Added'            :
                           hudState === 'DUPLICATE'      ? '⊘ Duplicate'        :
                           hudState === 'OCR_PROCESSING' ? '⏳ Reading Label…'   :
                           hudState === 'OCR_SUCCESS'    ? '✓ Label Read'        :
                           hudState === 'OCR_FAILED'     ? '✗ Label Unreadable'  : '? Unknown'}
                        </div>
                      )}
                      <div className={css.videoActions}>
                        {scannerRef.current?.hasTorch() && (
                          <button className={css.videoBtn} onClick={toggleTorch} title="Toggle torch">
                            {torch ? '🔦' : '💡'}
                          </button>
                        )}
                        <button
                          className={css.videoBtn}
                          onClick={handleReadLabel}
                          disabled={ocrLoading}
                          title={ocrLoading ? 'Reading label…' : 'Read printed label text (OCR)'}>
                          {ocrLoading ? '⏳' : '📝'}
                        </button>
                        <button className={css.videoBtn} onClick={switchCamera} title="Switch camera">
                          🔄
                        </button>
                        <button className={css.videoBtn} onClick={stopCamera} title="Stop camera">
                          ✕
                        </button>
                      </div>
                    </div>
                  </div>

                  {!camActive && (
                    <div className={css.cameraOff}>
                      <CameraIcon size={48} />
                      <div className={css.cameraOffTitle}>
                        {camPerm === 'denied' ? 'Camera access denied' : 'Camera is off'}
                      </div>
                      {camErr && (
                        <div style={{ fontSize: 12, color: '#dc2626', maxWidth: 280, textAlign: 'center', lineHeight: 1.5 }}>
                          {camErr}
                        </div>
                      )}
                      <div className={css.cameraOffHint}>
                        {camPerm === 'denied'
                          ? 'Allow camera access in your browser settings, then try again.'
                          : 'Point the rear camera at a barcode or QR code.'}
                      </div>
                      {camPerm !== 'denied' && (
                        <button className={css.btnAccent} style={{ marginTop: 8 }} onClick={startCamera}>
                          Start Camera
                        </button>
                      )}
                      <button
                        className={css.btnGhost}
                        style={{ fontSize: 11, height: 28, marginTop: 6 }}
                        onClick={() => { setShowDiag(d => !d); if (!diagData) loadDiag(); }}>
                        {showDiag ? 'Hide Diagnostics' : 'Show Diagnostics'}
                      </button>
                    </div>
                  )}

                  {showDiag && <DiagPanel data={diagData} loading={diagLoading} />}
                  {ocrError && (
                    <div className={css.ocrError} onClick={() => setOcrError(null)}>
                      ✗ OCR: {ocrError} (tap to dismiss)
                    </div>
                  )}
                </>
              )}

              {inputMode === 'usb' && (
                <div className={css.cameraOff} style={{ minHeight: 200 }}>
                  <div style={{ fontSize: 40 }}>🔌</div>
                  <div className={css.cameraOffTitle}>USB Scanner Active</div>
                  <div className={css.cameraOffHint}>
                    Scan with your USB/Bluetooth hardware scanner. Focus stays on this page.
                  </div>
                  <div style={{ marginTop: 12, fontSize: 12, color: '#94a3b8', fontFamily: 'monospace' }}>
                    Listening for keyboard input…
                  </div>
                  {scanFlash && (
                    <div style={{ color: '#16a34a', fontWeight: 700, fontSize: 13, marginTop: 10 }}>
                      ✓ Scan received!
                    </div>
                  )}
                </div>
              )}

              {inputMode === 'manual' && (
                <div className={css.card} style={{ padding: 18, marginBottom: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#1e293b' }}>Manual Entry</div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#64748b', cursor: 'pointer' }}>
                      <span>Batch mode</span>
                      <label className={css.switch}>
                        <input type="checkbox" checked={batchMode} onChange={e => setBatchMode(e.target.checked)} />
                        <span className={css.switchSlider} />
                      </label>
                    </label>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      <div>
                        <label style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.4px', display: 'block', marginBottom: 4 }}>
                          Item Type {batchMode && <span style={{ color: '#6366f1' }}>🔒</span>}
                        </label>
                        <input
                          className={css.input}
                          style={{ height: 34, fontSize: 13 }}
                          placeholder="ABIO, FXDA…"
                          value={manualType}
                          onChange={e => setManualType(e.target.value.toUpperCase())}
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.4px', display: 'block', marginBottom: 4 }}>
                          Part # {batchMode && <span style={{ color: '#6366f1' }}>🔒</span>}
                        </label>
                        <input
                          className={css.input}
                          style={{ height: 34, fontSize: 13 }}
                          placeholder="474123-001.001"
                          value={manualPN}
                          onChange={e => setManualPN(e.target.value)}
                        />
                      </div>
                    </div>
                    <div>
                      <label style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.4px', display: 'block', marginBottom: 4 }}>
                        Serial Number *
                      </label>
                      <div className={css.manualRow} style={{ marginTop: 0 }}>
                        <input
                          className={css.manualInput}
                          placeholder="N90001234567…"
                          value={manualVal}
                          onChange={e => setManualVal(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') manualSubmit(); }}
                          autoFocus
                        />
                        <button className={css.btnAccent} onClick={manualSubmit}>Add</button>
                      </div>
                    </div>
                  </div>
                  {manualErr && <p className={css.formError} style={{ marginTop: 6 }}>{manualErr}</p>}
                  {batchMode && (
                    <p style={{ fontSize: 11, color: '#6366f1', marginTop: 8, fontWeight: 600 }}>
                      Batch mode on: Item Type and Part # are locked across entries.
                    </p>
                  )}
                  <p style={{ fontSize: 11, color: '#94a3b8', marginTop: 8 }}>
                    Press Enter or click Add. Supports plain SN, semicolon-delimited (TYPE;PN;SN), or GS1.
                  </p>
                </div>
              )}
            </div>

            {/* Right — scan list */}
            <div className={css.scanListWrap}>
              <div className={css.scanListHdr}>
                <span className={css.scanCount}>{scanEntries.length} scan{scanEntries.length !== 1 ? 's' : ''}</span>
                {scanEntries.length > 0 && (
                  <button className={css.btnDanger} style={{ fontSize: 11, height: 26 }}
                    onClick={() => {
                      if (confirm('Clear all scans?')) {
                        setScanEntries([]);
                        sessionSNs.current.clear();
                        setDuplicateCount(0);
                      }
                    }}>
                    Clear all
                  </button>
                )}
              </div>
              {scanEntries.length === 0 ? (
                <div style={{ color: '#94a3b8', fontSize: 13, textAlign: 'center', padding: 24 }}>
                  No scans yet
                </div>
              ) : (
                <div className={css.scanList}>
                  {scanEntries.map(e => (
                    <div key={e.localId}
                      className={`${css.scanEntry} ${
                        e.status === 'VALID' ? css.scanEntryValid :
                        e.status === 'ERROR' ? css.scanEntryError : css.scanEntryPending
                      } ${highlightSN && highlightSN === e.serialNumberNorm ? css.scanEntryHighlight : ''}`}>

                      <div style={{ flex: 1, minWidth: 0 }}>
                        {/* Top row: item code badge + match status */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, flexWrap: 'wrap' }}>
                          {e.resolvedItemCode && (
                            <span className={css.scanCardItemCode}>{e.resolvedItemCode}</span>
                          )}
                          <span className={`${css.badge} ${
                            e.matchStatus === 'MATCHED'   ? css.badgeGreen :
                            e.matchStatus === 'UNMATCHED' ? css.badgeAmber : css.badgeSlate
                          }`} style={{ fontSize: 9, padding: '1px 6px' }}>
                            {e.matchStatus === 'MATCHED' ? 'MATCHED' :
                             e.matchStatus === 'UNMATCHED' ? 'NO MATCH' : 'NO PN'}
                          </span>
                        </div>

                        {/* SN + PN */}
                        <div className={css.scanSN}>{e.serialNumber || e.rawValue}</div>
                        {e.partNumber && <div className={css.scanPN}>PN: {e.partNumber}</div>}

                        {/* Resolved item name */}
                        {e.resolvedItemName && (
                          <div className={css.scanItem}>{e.resolvedItemName}</div>
                        )}

                        {/* Manual assign dropdown when PENDING */}
                        {e.status === 'PENDING' && !e.resolvedItemId && (
                          <select
                            style={{ marginTop: 4, fontSize: 11, border: '1px solid #e2e8f0', borderRadius: 4, padding: '2px 4px', maxWidth: '100%' }}
                            value=""
                            onChange={ev => resolveEntryItem(e.localId, ev.target.value)}>
                            <option value="">— Assign item —</option>
                            {items.map(it => <option key={it.id} value={it.id}>{it.item_code} — {it.item_name}</option>)}
                          </select>
                        )}

                        {e.statusMsg && <div className={css.scanMsg}>{e.statusMsg}</div>}

                        {/* Collapsible diagnostics */}
                        <button className={css.scanDiagToggle} onClick={() => toggleDiag(e.localId)}>
                          {expandedDiags.has(e.localId) ? '▲ Diagnostics' : '▼ Diagnostics'}
                        </button>
                        {expandedDiags.has(e.localId) && (
                          <NokiaDiagBlock entry={e} />
                        )}
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                        <span className={css.scanTime}>
                          {new Date(e.scannedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        <button className={`${css.btnIcon} ${css.btnIconDanger}`} onClick={() => removeEntry(e.localId)} title="Remove">
                          <TrashIcon />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 20 }}>
            <button className={css.btnGhost} onClick={() => { stopCamera(); setStep(1); }}>
              <ChevronLeftIcon /> Back
            </button>
            <button className={css.btnAccent} onClick={goStep3} disabled={scanEntries.length === 0}>
              Review ({scanEntries.length}) <ChevronRightIcon />
            </button>
          </div>
        </>
      )}

      {/* ── Step 3: Review & Save ─────────────────────────────────────────── */}
      {step === 3 && (
        <>
          <div className={css.card} style={{ marginBottom: 16 }}>
            <div className={css.cardHdr}><span className={css.cardTitle}>Receipt Summary</span></div>
            <div className={css.cardBody}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, fontSize: 13 }}>
                <SummaryField label="Warehouse"    value={warehouseName || '—'} />
                <SummaryField label="Date"         value={session.receiptDate} />
                <SummaryField label="Supplier"     value={session.supplierName || '—'} />
                <SummaryField label="Delivery Note" value={session.deliveryNote || '—'} />
                <SummaryField label="PO Number"    value={session.poNumber || '—'} />
                <SummaryField label="Total Scans"  value={String(scanEntries.length)} />
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <KpiChip label="Valid"        value={validCount}     color="#16a34a" />
            <KpiChip label="Needs Review" value={pendingCount}   color="#f59e0b" />
            <KpiChip label="Duplicates"   value={duplicateCount} color="#dc2626" />
          </div>

          {pendingCount > 0 && (
            <div style={{ background: '#fef9c3', border: '1px solid #fde047', borderRadius: 10, padding: 12, marginBottom: 16, fontSize: 13, color: '#713f12' }}>
              <strong>{pendingCount} scan{pendingCount !== 1 ? 's' : ''}</strong> still unmatched to an item.
              Go back to assign them, or save now and match later.
            </div>
          )}

          {Object.entries(grouped).map(([code, entries]) => {
            const first = entries[0];
            return (
              <div key={code} className={css.reviewSection}>
                <div className={css.reviewSectionTitle}>
                  {first.resolvedItemCode ? `${first.resolvedItemCode} — ${first.resolvedItemName}` : 'Unmatched'} ({entries.length})
                </div>
                <div className={css.card} style={{ borderRadius: '0 0 8px 8px', marginBottom: 0 }}>
                  <div className={css.tableWrap}>
                    <table>
                      <thead>
                        <tr>
                          <th>Serial Number</th>
                          <th>Part #</th>
                          <th>Source</th>
                          <th>Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {entries.map(e => (
                          <tr key={e.localId}>
                            <td style={{ fontFamily: 'monospace', fontWeight: 700 }}>{e.serialNumber || e.rawValue}</td>
                            <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{e.partNumber || '—'}</td>
                            <td>{e.manually ? 'Manual' : e.symbology}</td>
                            <td style={{ fontSize: 11, color: '#64748b' }}>{new Date(e.scannedAt).toLocaleTimeString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            );
          })}

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 20 }}>
            <button className={css.btnGhost} onClick={() => setStep(2)}>
              <ChevronLeftIcon /> Back to Scan
            </button>
            <button className={css.btnAccent} onClick={saveReceipt} disabled={saving || validCount === 0}>
              {saving ? 'Saving…' : `Save Receipt (${validCount} items)`}
            </button>
          </div>
        </>
      )}

      {toast && (
        <div className={`${css.toast} ${toast.ok ? css.toastOk : css.toastErr}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

// Scan-card diagnostic block — full DI field breakdown for Nokia payloads,
// standard field list for all other profiles. Expanded via ▼ Diagnostics toggle.
function NokiaDiagBlock({ entry: e }: { entry: ScanEntry }) {
  const isNokiaDI = e.parsingProfile === 'nokia-gs1';
  const diFields: DIField[] = isNokiaDI ? decodeAllDIFields(e.rawValue) : [];

  return (
    <div className={css.scanDiag}>
      {/* Always shown */}
      <DiagRow label="RAW"    val={e.rawValue}   raw />
      <DiagRow label="SYM"    val={e.symbology} />
      <DiagRow label="PARSER" val={e.parsingProfile} />

      {/* Nokia DI payload: decoded field-by-field */}
      {isNokiaDI && diFields.length > 0 && (
        <>
          <div className={css.scanDiagRow} style={{ marginTop: 5, paddingTop: 4, borderTop: '1px solid #1e293b' }}>
            <span className={css.scanDiagKey} style={{ color: '#818cf8', minWidth: 80 }}>DI FIELDS</span>
            <span className={css.scanDiagVal} style={{ color: '#475569' }}>VALUE</span>
            <span className={css.scanDiagVal} style={{ color: '#475569', marginLeft: 8 }}>MEANING</span>
          </div>
          {diFields.map((f, i) => (
            <div key={i} className={css.scanDiagRow}>
              <span className={css.scanDiagKey} style={{
                color: f.di === '1P' ? '#34d399' : f.di === 'S' ? '#60a5fa' :
                       f.di === '??' ? '#f87171' : '#94a3b8',
              }}>
                {f.di}
              </span>
              <span className={css.scanDiagVal} style={{ flex: 1 }}>{f.value}</span>
              {f.meaning && (
                <span className={css.scanDiagVal} style={{ color: '#475569', marginLeft: 6, fontSize: 10 }}>
                  {f.meaning}
                </span>
              )}
              {!f.meaning && (
                <span className={css.scanDiagVal} style={{ color: '#f87171', marginLeft: 6, fontSize: 10 }}>
                  UNKNOWN DI
                </span>
              )}
            </div>
          ))}
          <div className={css.scanDiagRow} style={{ marginTop: 5, paddingTop: 4, borderTop: '1px solid #1e293b' }}>
            <span className={css.scanDiagKey} style={{ color: '#818cf8' }}>EXTRACTED</span>
          </div>
          <DiagRow label="TYPE" val={e.itemTypeRaw ?? '(not encoded in barcode)'} />
          <DiagRow label="PN"   val={e.partNumber ?? '—'} />
          <DiagRow label="SN"   val={e.serialNumber ?? '—'} />
        </>
      )}

      {/* Non-Nokia profiles: standard field list */}
      {!isNokiaDI && (
        <>
          <DiagRow label="TYPE" val={e.itemTypeRaw ?? '—'} />
          <DiagRow label="PN"   val={e.partNumber ?? '—'} />
          <DiagRow label="SN"   val={e.serialNumber ?? '—'} />
        </>
      )}

      <div className={css.scanDiagRow} style={{ marginTop: 5, paddingTop: 4, borderTop: '1px solid #1e293b' }}>
        <span className={css.scanDiagKey} style={{ color: '#818cf8' }}>STATUS</span>
      </div>
      <DiagRow label="PARSE" val={e.parseStatus} />
      <DiagRow label="MATCH" val={e.matchStatus} />
      <DiagRow label="CLASS" val={e.scanClassification} />

      {/* OCR section — shown only when OCR was run on this entry */}
      {e.mergeScenario != null && (
        <>
          <div className={css.scanDiagRow} style={{ marginTop: 5, paddingTop: 4, borderTop: '1px solid #1e293b' }}>
            <span className={css.scanDiagKey} style={{ color: '#818cf8' }}>OCR</span>
            <span className={css.scanDiagVal} style={{ color: '#475569' }}>
              {e.mergeScenario} · {e.ocrDurationMs ?? '?'}ms
            </span>
          </div>
          {e.ocrItemType    && <DiagRow label="TYPE"     val={e.ocrItemType} />}
          {e.ocrPartNumber  && <DiagRow label="PN"       val={e.ocrPartNumber} />}
          {e.ocrSerialNumber && <DiagRow label="SN"      val={e.ocrSerialNumber} />}
          {e.mergeConflicts && e.mergeConflicts.length > 0 && (
            <DiagRow label="CONFLICT" val={e.mergeConflicts[0]} />
          )}
          {e.ocrRawText != null && (
            <DiagRow label="TEXT" val={
              e.ocrRawText.substring(0, 60) + (e.ocrRawText.length > 60 ? '…' : '')
            } />
          )}
        </>
      )}
    </div>
  );
}

function DiagRow({ label, val, raw }: { label: string; val: string; raw?: boolean }) {
  return (
    <div className={css.scanDiagRow}>
      <span className={css.scanDiagKey}>{label}</span>
      <span className={raw ? css.scanDiagRaw : css.scanDiagVal}>{val}</span>
    </div>
  );
}

function DiagPanel({ data, loading }: { data: ScanDiagnostics | null; loading: boolean }) {
  if (loading) {
    return (
      <div className={css.diagPanel}>
        <span style={{ color: '#94a3b8', fontSize: 12 }}>Running diagnostics…</span>
      </div>
    );
  }
  if (!data) return null;

  const rows: Array<{ label: string; ok: boolean; value: string }> = [
    { label: 'Secure Context (HTTPS)', ok: data.secureContext, value: data.secureContext ? 'Yes' : 'No — camera requires HTTPS' },
    { label: 'navigator.mediaDevices', ok: data.mediaDevicesAvailable, value: data.mediaDevicesAvailable ? 'Available' : 'Not available' },
    { label: 'getUserMedia', ok: data.getUserMediaAvailable, value: data.getUserMediaAvailable ? 'Available' : 'Not available' },
    { label: 'BarcodeDetector (native)', ok: data.barcodeDetectorAvailable, value: data.barcodeDetectorAvailable ? `Yes (${data.barcodeDetectorFormats.length} formats)` : 'No — will use ZXing fallback' },
    { label: 'ZXing fallback', ok: data.zxingAvailable, value: data.zxingAvailable ? 'Available' : 'Not available' },
    { label: 'Camera permission', ok: data.cameraPermission === 'granted', value: data.cameraPermission },
  ];

  return (
    <div className={css.diagPanel}>
      <div className={css.diagTitle}>Camera Diagnostics</div>
      {rows.map(r => (
        <div key={r.label} className={css.diagRow}>
          <span className={css.diagDot} style={{ background: r.ok ? '#16a34a' : '#dc2626' }} />
          <span className={css.diagLabel}>{r.label}</span>
          <span className={css.diagValue}>{r.value}</span>
        </div>
      ))}
    </div>
  );
}

function WizardHeader({ step }: { step: Step }) {
  const steps = ['Receipt Details', 'Scan Items', 'Review & Save'];
  return (
    <div style={{ marginBottom: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, color: '#1e293b', margin: '0 0 16px' }}>Receive Materials</h1>
      <div className={css.wizardSteps}>
        {steps.map((label, i) => {
          const n = (i + 1) as Step;
          return (
            <div key={n} className={css.wizardStep}
              style={{ color: n < step ? '#16a34a' : n === step ? '#6366f1' : '#94a3b8' }}>
              {i > 0 && (
                <div className={css.stepLine}
                  style={{ background: n <= step ? (n < step ? '#16a34a' : '#6366f1') : '#e2e8f0' }} />
              )}
              <div className={css.stepNum}
                style={{
                  background: n < step ? '#16a34a' : n === step ? '#6366f1' : '#e2e8f0',
                  color: n <= step ? '#fff' : '#94a3b8',
                }}>
                {n < step ? '✓' : n}
              </div>
              <span style={{ whiteSpace: 'nowrap', fontSize: 13, fontWeight: 600 }}>{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function KpiChip({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '6px 12px' }}>
      <span style={{ fontSize: 18, fontWeight: 800, color }}>{value}</span>
      <span style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.4px' }}>{label}</span>
    </div>
  );
}

function SummaryField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>{value}</div>
    </div>
  );
}

function CameraIcon({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>;
}
function ChevronLeftIcon()  { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>; }
function ChevronRightIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>; }
function TrashIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>; }
