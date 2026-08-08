import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import {
  CameraScanner, UsbScanner, parseScan, classifyScan, decodeAllDIFields,
  checkCameraPermission, cameraErrorMessage, getScanDiagnostics,
  type CameraPermission, type ScanDiagnostics, type DIField,
} from '../lib/warehouseScanner';
import {
  createPendingCarton, isPendingExpired,
  isPnCompatible, isSnCompatible, CARTON_WINDOW_MS,
  type PendingCarton,
} from '../lib/cartonBuffer';
import type { Warehouse, InventoryItem, ScanEntry } from '../lib/warehouseTypes';
import { normalizeSN } from '../lib/warehouseTypes';
import {
  normalizePn, filterAndDeduplicateMappings, detectMappingConflict,
  MAPPING_SOURCE_RECEIVING, MAPPING_CODE_TYPE_PN, MAPPING_CODE_TYPE_GENERIC_IDENTIFIER,
} from '../lib/pnMapping';
import { captureVideoFrame, ocrCanvasFrame, terminateOcrWorker, type OcrResult } from '../lib/labelOcr';
import { mergeScanAndOcr, type BarcodeSource } from '../lib/smartLabelMerge';
import { buildExistingAssetsMap, getBlockMessage, type KnownAsset, type BlockedMessage } from '../lib/existingAssetCheck';
import type { EditScanEntryForRpc } from '../lib/editReceiptHelpers';
import css from './Warehouse.module.css';

type InputMode = 'camera' | 'usb' | 'manual';
type HudState = 'IDLE' | 'SUCCESS' | 'DUPLICATE' | 'UNKNOWN' | 'OCR_PROCESSING' | 'OCR_SUCCESS' | 'OCR_FAILED' | 'WAITING_SN' | 'WAITING_PN' | 'INCOMPLETE_CARTON' | 'EXISTING_ASSET';

interface ReceiptHeader {
  id:                    string;
  receipt_number:        string;
  warehouse_id:          string;
  supplier_name:         string | null;
  delivery_note_number:  string | null;
  purchase_order_number: string | null;
  receipt_date:          string;
  notes:                 string | null;
  status:                string;
}

interface ExistingRow {
  id:               string;
  inventory_item_id: string | null;
  serial_number:    string;
  part_number:      string | null;
  raw_scan_value:   string;
  barcode_symbology: string | null;
  scanned_manually: boolean;
  itemCode?:        string;
  itemName?:        string;
}

export default function WarehouseReceiveEdit() {
  const { receiptId }                 = useParams<{ receiptId: string }>();
  const { hasPerm, currentUser }      = useAuth();
  const navigate                      = useNavigate();

  const [loading,    setLoading]      = useState(true);
  const [loadError,  setLoadError]    = useState('');
  const [saving,     setSaving]       = useState(false);
  const [receipt,    setReceipt]      = useState<ReceiptHeader | null>(null);
  const [existingRows, setExistingRows] = useState<ExistingRow[]>([]);
  const [removedIds, setRemovedIds]   = useState<Set<string>>(new Set());
  const [items,      setItems]        = useState<InventoryItem[]>([]);
  const [warehouses, setWarehouses]   = useState<Warehouse[]>([]);

  // Editable header fields
  const [editSupplier, setEditSupplier] = useState('');
  const [editDn,       setEditDn]       = useState('');
  const [editPo,       setEditPo]       = useState('');
  const [editDate,     setEditDate]     = useState('');
  const [editNotes,    setEditNotes]    = useState('');

  // Scanner UI state
  const [inputMode,    setInputMode]   = useState<InputMode>('camera');
  const [camPerm,      setCamPerm]     = useState<CameraPermission>('unknown');
  const [camActive,    setCamActive]   = useState(false);
  const [camErr,       setCamErr]      = useState<string | null>(null);
  const [torch,        setTorch]       = useState(false);
  const [showDiag,     setShowDiag]    = useState(false);
  const [diagData,     setDiagData]    = useState<ScanDiagnostics | null>(null);
  const [diagLoading,  setDiagLoading] = useState(false);
  const [scanFlash,    setScanFlash]   = useState(false);
  const [hudState,     setHudState]    = useState<HudState>('IDLE');
  const [highlightSN,  setHighlightSN] = useState<string | null>(null);
  const [duplicateCount, setDuplicateCount] = useState(0);
  const [expandedDiags, setExpandedDiags]   = useState<Set<string>>(new Set());
  const [ocrLoading,   setOcrLoading]  = useState(false);
  const [ocrError,     setOcrError]    = useState<string | null>(null);
  const [scanEntries,  setScanEntries] = useState<ScanEntry[]>([]);
  const [manualVal,    setManualVal]   = useState('');
  const [manualType,   setManualType]  = useState('');
  const [manualPN,     setManualPN]    = useState('');
  const [manualErr,    setManualErr]   = useState('');
  const [batchMode,    setBatchMode]   = useState(false);
  const [toast,        setToast]       = useState<{ msg: string; ok: boolean } | null>(null);
  const [blockedAsset, setBlockedAsset] = useState<{
    sn:            string;
    status:        KnownAsset['status'];
    msg:           BlockedMessage;
    itemCode:      string | null;
    itemName:      string | null;
    partNumber:    string | null;
    warehouseName: string | null;
    receiptNumber: string | null;
  } | null>(null);

  // Refs
  const videoRef              = useRef<HTMLVideoElement>(null);
  const scannerRef            = useRef<CameraScanner | null>(null);
  const usbRef                = useRef<UsbScanner | null>(null);
  const flashTimer            = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimer            = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hudTimer              = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hlTimer               = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionSNs            = useRef<Set<string>>(new Set());
  const itemsByPN             = useRef<Map<string, InventoryItem>>(new Map());
  const itemsByCode           = useRef<Map<string, InventoryItem>>(new Map());
  const learnedByPN           = useRef<Map<string, InventoryItem>>(new Map());
  const learnedByCode         = useRef<Map<string, InventoryItem>>(new Map());
  const itemTypeCodes         = useRef<Set<string>>(new Set());
  const existingAssets        = useRef<Map<string, KnownAsset>>(new Map());
  const grRefMap              = useRef<Map<string, string>>(new Map());
  const pendingCarton         = useRef<PendingCarton | null>(null);
  const pendingCartonFrame    = useRef<HTMLCanvasElement | null>(null);
  const pendingCartonTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasChangesRef         = useRef(false);

  if (!hasPerm('view_warehouse_history')) return <div className={css.denied}>Access denied.</div>;
  if (!hasPerm('wrh_receive_edit'))       return <div className={css.denied}>You need the "Edit Receipt" permission.</div>;

  // ── Derived values ────────────────────────────────────────────────────────
  const activeExistingRows  = existingRows.filter(r => !removedIds.has(r.id));
  const keptExistingCount   = activeExistingRows.filter(r => r.inventory_item_id).length;
  const newValidCount       = scanEntries.filter(e => e.status === 'VALID').length;
  const totalUnits          = keptExistingCount + newValidCount;
  const needsReviewCount    = scanEntries.filter(e => e.matchStatus === 'NEEDS_REVIEW').length;

  const hasChanges = (
    removedIds.size > 0 ||
    scanEntries.length > 0 ||
    editSupplier !== (receipt?.supplier_name          || '') ||
    editDn       !== (receipt?.delivery_note_number   || '') ||
    editPo       !== (receipt?.purchase_order_number  || '') ||
    editDate     !== (receipt?.receipt_date           || '') ||
    editNotes    !== (receipt?.notes                  || '')
  );
  hasChangesRef.current = hasChanges;

  const warehouseName = warehouses.find(w => w.id === receipt?.warehouse_id)?.name;

  // ── beforeunload ──────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!hasChangesRef.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  // ── Load all data at mount ────────────────────────────────────────────────
  useEffect(() => {
    if (!receiptId) { setLoadError('No receipt ID provided.'); setLoading(false); return; }
    (async () => {
      setLoading(true);
      const [rcptRes, scanRes, itemsRes, wrhRes, assetRes, grRes] = await Promise.all([
        supabase.from('goods_receipts').select('*').eq('id', receiptId).single(),
        supabase.from('receiving_scan_log').select('*').eq('goods_receipt_id', receiptId).order('created_at'),
        supabase.from('inventory_items').select('*').eq('is_active', true).order('item_name'),
        supabase.from('warehouses').select('*').eq('is_active', true).order('name'),
        supabase.from('inventory_assets').select('serial_number_normalized, inventory_item_id, part_number, warehouse_id, status, source_receipt_id'),
        supabase.from('goods_receipts').select('id, receipt_number'),
      ]);

      if (rcptRes.error || !rcptRes.data) {
        setLoadError(rcptRes.error?.message || 'Receipt not found.');
        setLoading(false);
        return;
      }
      const rcpt = rcptRes.data as ReceiptHeader;
      if (rcpt.status !== 'PENDING_REVIEW') {
        setLoadError(`This receipt is ${rcpt.status} and cannot be edited.`);
        setLoading(false);
        return;
      }

      setReceipt(rcpt);
      setEditSupplier(rcpt.supplier_name          || '');
      setEditDn(rcpt.delivery_note_number         || '');
      setEditPo(rcpt.purchase_order_number        || '');
      setEditDate(rcpt.receipt_date);
      setEditNotes(rcpt.notes                     || '');

      if (wrhRes.data) setWarehouses(wrhRes.data as Warehouse[]);

      // Build item lookup maps
      let byId: Map<string, InventoryItem> | null = null;
      if (itemsRes.data) {
        const rows = itemsRes.data as InventoryItem[];
        setItems(rows);
        const byPN_   = new Map<string, InventoryItem>();
        const byCode_ = new Map<string, InventoryItem>();
        const byId_   = new Map<string, InventoryItem>();
        const types_  = new Set<string>();
        for (const it of rows) {
          if (it.part_number) byPN_.set(normalizePn(it.part_number), it);
          byCode_.set(it.item_code.toUpperCase(), it);
          byId_.set(it.id, it);
          types_.add(it.item_code.toUpperCase());
          if (it.item_type) { byCode_.set(it.item_type.toUpperCase(), it); types_.add(it.item_type.toUpperCase()); }
        }
        itemsByPN.current    = byPN_;
        itemsByCode.current  = byCode_;
        itemTypeCodes.current = types_;
        byId = byId_;
      }

      // Build existing rows with item info + pre-populate sessionSNs
      if (scanRes.data) {
        const rows = (scanRes.data as ExistingRow[]);
        rows.forEach(s => {
          if (s.inventory_item_id && byId) {
            const it = byId.get(s.inventory_item_id);
            if (it) { s.itemCode = it.item_code; s.itemName = it.item_name; }
          }
          if (s.serial_number) sessionSNs.current.add(normalizeSN(s.serial_number));
        });
        setExistingRows(rows);
      }

      // Load learned PN mappings
      if (byId) {
        const mRes = await supabase
          .from('item_code_mappings')
          .select('external_code, inventory_item_id')
          .eq('code_type', MAPPING_CODE_TYPE_PN)
          .eq('is_active', true);
        if (mRes.data && !mRes.error) {
          const byLearnedPN = new Map<string, InventoryItem>();
          for (const row of mRes.data as { external_code: string; inventory_item_id: string }[]) {
            const item = byId.get(row.inventory_item_id);
            if (item) byLearnedPN.set(normalizePn(row.external_code), item);
          }
          learnedByPN.current = byLearnedPN;
        }
      }

      // Load learned generic code → item mappings
      if (byId) {
        const gcRes = await supabase
          .from('item_code_mappings')
          .select('external_code, inventory_item_id')
          .eq('code_type', MAPPING_CODE_TYPE_GENERIC_IDENTIFIER)
          .eq('is_active', true);
        if (gcRes.data && !gcRes.error) {
          const byCode = new Map<string, InventoryItem>();
          for (const row of gcRes.data as { external_code: string; inventory_item_id: string }[]) {
            const item = byId.get(row.inventory_item_id);
            if (item) byCode.set(row.external_code.trim(), item);
          }
          learnedByCode.current = byCode;
        }
      }

      // Build existing-asset map (for Phase 3E-A blocking on new scans)
      if (assetRes.data) {
        existingAssets.current = buildExistingAssetsMap(
          (assetRes.data as Array<{
            serial_number_normalized: string;
            inventory_item_id:        string;
            part_number:              string | null;
            warehouse_id:             string | null;
            status:                   KnownAsset['status'];
            source_receipt_id:        string | null;
          }>).map(r => ({
            serialNumberNorm: r.serial_number_normalized,
            inventoryItemId:  r.inventory_item_id,
            partNumber:       r.part_number,
            warehouseId:      r.warehouse_id,
            status:           r.status,
            sourceReceiptId:  r.source_receipt_id,
          }))
        );
      }
      if (grRes.data) {
        grRefMap.current = new Map(
          (grRes.data as Array<{ id: string; receipt_number: string }>).map(r => [r.id, r.receipt_number])
        );
      }

      const perm = await checkCameraPermission();
      setCamPerm(perm);
      setLoading(false);
    })();

    return () => { stopCamera(); terminateOcrWorker(); clearPendingCarton(); };
  }, [receiptId]);

  // ── USB scanner ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (loading || inputMode !== 'usb') return;
    const usb = new UsbScanner(document.body, {
      onScan: raw => handleRawScan(raw, 'USB_HID', false),
    });
    usb.attach();
    usbRef.current = usb;
    return () => { usb.detach(); usbRef.current = null; };
  }, [loading, inputMode]);

  // ── Toast ─────────────────────────────────────────────────────────────────
  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  // ── HUD ───────────────────────────────────────────────────────────────────
  function setHud(state: 'SUCCESS' | 'DUPLICATE' | 'UNKNOWN') {
    setHudState(state);
    if (hudTimer.current) clearTimeout(hudTimer.current);
    hudTimer.current = setTimeout(() => setHudState('IDLE'), 1200);
  }

  function setHudOcr(state: 'OCR_PROCESSING' | 'OCR_SUCCESS' | 'OCR_FAILED') {
    setHudState(state);
    if (hudTimer.current) clearTimeout(hudTimer.current);
    if (state !== 'OCR_PROCESSING') hudTimer.current = setTimeout(() => setHudState('IDLE'), 2500);
  }

  // ── CartonScanBuffer ──────────────────────────────────────────────────────
  const clearPendingCarton = () => {
    if (pendingCartonTimer.current) { clearTimeout(pendingCartonTimer.current); pendingCartonTimer.current = null; }
    if (pendingCartonFrame.current) { pendingCartonFrame.current.width = 0; pendingCartonFrame.current.height = 0; pendingCartonFrame.current = null; }
    pendingCarton.current = null;
  };

  const startPendingCartonTimer = () => {
    if (pendingCartonTimer.current) clearTimeout(pendingCartonTimer.current);
    pendingCartonTimer.current = setTimeout(() => {
      clearPendingCarton();
      setHudState('INCOMPLETE_CARTON');
      if (hudTimer.current) clearTimeout(hudTimer.current);
      hudTimer.current = setTimeout(() => setHudState('IDLE'), 2000);
    }, CARTON_WINDOW_MS);
  };

  // ── PN resolution ─────────────────────────────────────────────────────────
  function resolveByPN(pn: string): { item: InventoryItem; fromMapping: boolean } | null {
    const key    = normalizePn(pn);
    const mapped = learnedByPN.current.get(key);
    if (mapped) return { item: mapped, fromMapping: true };
    const byPn   = itemsByPN.current.get(key);
    if (byPn)  return { item: byPn,   fromMapping: false };
    return null;
  }

  function resolveByGenericCode(raw: string): InventoryItem | null {
    return learnedByCode.current.get(raw.trim()) ?? null;
  }

  // ── Existing-asset block check ────────────────────────────────────────────
  function checkAndBlock(snNorm: string): boolean {
    const found = existingAssets.current.get(snNorm);
    if (!found) return false;
    const item    = items.find(i => i.id === found.inventoryItemId);
    const wh      = warehouses.find(w => w.id === (found.warehouseId ?? ''));
    const rcptNum = found.sourceReceiptId ? (grRefMap.current.get(found.sourceReceiptId) ?? null) : null;
    setBlockedAsset({
      sn:            snNorm,
      status:        found.status,
      msg:           getBlockMessage(found.status),
      itemCode:      item?.item_code ?? null,
      itemName:      item?.item_name ?? null,
      partNumber:    found.partNumber,
      warehouseName: wh?.name ?? null,
      receiptNumber: rcptNum,
    });
    setHudState('EXISTING_ASSET');
    if (hudTimer.current) clearTimeout(hudTimer.current);
    hudTimer.current = setTimeout(() => setHudState('IDLE'), 2000);
    navigator.vibrate?.([50, 50, 50]);
    return true;
  }

  // ── Audio/haptic ──────────────────────────────────────────────────────────
  function playSuccessBeep() {
    try {
      type AC = typeof AudioContext;
      const Ctor: AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: AC }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor(); const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 1200;
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.start(); osc.stop(ctx.currentTime + 0.15);
    } catch { /* AudioContext not available */ }
  }

  // ── Camera ────────────────────────────────────────────────────────────────
  async function startCamera() {
    if (!videoRef.current) return;
    setCamErr(null);
    const scanner = new CameraScanner();
    scannerRef.current = scanner;
    try {
      await scanner.start(videoRef.current, {
        onScan:  (raw, sym) => handleRawScan(raw, sym, false),
        onError: msg => showToast(msg, false),
        onStart: () => { setCamActive(true); setCamPerm('granted'); },
      });
    } catch (err: unknown) {
      const msg  = cameraErrorMessage(err);
      const name = (err as DOMException).name;
      setCamErr(msg);
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') setCamPerm('denied');
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

  async function toggleTorch() {
    if (!scannerRef.current) return;
    const newVal = await scannerRef.current.toggleTorch();
    setTorch(newVal);
  }

  async function switchCamera() {
    if (!videoRef.current || !scannerRef.current) return;
    try {
      await scannerRef.current.switchCamera(videoRef.current, {
        onScan:  (raw, sym) => handleRawScan(raw, sym, false),
        onError: msg => showToast(msg, false),
        onStart: () => {},
      });
    } catch (err: unknown) { showToast(cameraErrorMessage(err), false); }
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────
  async function loadDiag() {
    setDiagLoading(true);
    setDiagData(await getScanDiagnostics());
    setDiagLoading(false);
  }

  // ── OCR core merge ────────────────────────────────────────────────────────
  function applyOcrByEntryId(localId: string, barcodeData: BarcodeSource | null, ocr: OcrResult) {
    const barcode: BarcodeSource | null =
      barcodeData && (barcodeData.partNumber || barcodeData.serialNumber || barcodeData.itemType) ? barcodeData : null;
    const merged = mergeScanAndOcr({ barcode, ocr });
    let rid: string | null = null, rname: string | null = null, rcode: string | null = null, ridFromMapping = false;
    if (merged.partNumber) {
      const result = resolveByPN(merged.partNumber);
      if (result) { rid = result.item.id; rname = result.item.item_name; rcode = result.item.item_code; ridFromMapping = result.fromMapping; }
    }
    if (!rid && merged.itemType) {
      const it = itemsByCode.current.get(merged.itemType.toUpperCase());
      if (it) { rid = it.id; rname = it.item_name; rcode = it.item_code; }
    }
    setScanEntries(prev => prev.map(e => {
      if (e.localId !== localId) return e;
      const mergedPn = e.partNumber ?? merged.partNumber;
      const mergedSn = e.serialNumber ?? merged.serialNumber;
      const mergedSnNorm = e.serialNumberNorm ?? (merged.serialNumber ? normalizeSN(merged.serialNumber) : null);
      if (!e.serialNumberNorm && mergedSnNorm) sessionSNs.current.add(mergedSnNorm);
      const mappingConflict = e.resolvedByMapping ? detectMappingConflict(e.resolvedItemId, rid) : false;
      const priorItemCode = e.resolvedItemCode;
      const newRid   = mappingConflict ? null : (e.resolvedItemId   ?? rid);
      const newRname = mappingConflict ? null : (e.resolvedItemName ?? rname);
      const newRcode = mappingConflict ? null : (e.resolvedItemCode ?? rcode);
      const newResolvedByMapping = mappingConflict ? false : e.resolvedByMapping ?? (rid ? ridFromMapping : undefined);
      const matchStatus: ScanEntry['matchStatus'] =
        mappingConflict ? 'NEEDS_REVIEW' : newRid ? 'MATCHED' : mergedPn ? 'UNMATCHED' : 'NO_PN';
      const requiresSn = !mergedSn && e.scanClassification === 'UNKNOWN_IDENTIFIER';
      const resolvedItem = newRid ? items.find(i => i.id === newRid) : null;
      const staysPending = requiresSn && resolvedItem?.tracking_method === 'SERIALIZED';

      return {
        ...e,
        partNumber: mergedPn, serialNumber: mergedSn, serialNumberNorm: mergedSnNorm,
        itemTypeRaw: merged.itemType ?? e.itemTypeRaw,
        resolvedItemId: newRid, resolvedItemName: newRname, resolvedItemCode: newRcode,
        resolvedByMapping: newResolvedByMapping,
        status: staysPending ? 'PENDING' as const : (newRid ? 'VALID' as const : 'PENDING' as const),
        statusMsg: staysPending
          ? `${resolvedItem?.item_name ?? 'Item'} is serialized — scan SN barcode to complete`
          : mappingConflict
            ? `Mapping (${priorItemCode ?? '?'}) vs OCR (${rcode ?? '?'}) — select correct item below`
            : newRid ? null : merged.itemType ? `${merged.itemType} not in Item Master — assign manually` : 'Item not matched — select manually',
        matchStatus,
        ocrRawText: ocr.rawText.substring(0, 500),
        ocrItemType:     merged.source.itemType     === 'OCR' ? merged.itemType     : null,
        ocrPartNumber:   merged.source.partNumber   === 'OCR' ? merged.partNumber   : null,
        ocrSerialNumber: merged.source.serialNumber === 'OCR' ? merged.serialNumber : null,
        mergeConflicts: merged.conflicts, mergeScenario: merged.scenario,
        ocrDurationMs: ocr.durationMs, ocrStatus: 'DONE' as const,
        ocrPasses: ocr.passes, ocrCandidates: ocr.candidateDetails, ocrAmbiguous: ocr.isItemTypeAmbiguous,
        ocrMergeApplied: !!(merged.itemType && !e.itemTypeRaw) || !!(merged.partNumber && !e.partNumber) || !!(merged.serialNumber && !e.serialNumber),
      };
    }));
  }

  async function launchAutoOcr(localId: string, barcodeData: BarcodeSource, canvas: HTMLCanvasElement) {
    try {
      const ocr = await ocrCanvasFrame(canvas, itemTypeCodes.current);
      applyOcrByEntryId(localId, barcodeData, ocr);
    } catch {
      canvas.width = 0; canvas.height = 0;
      setScanEntries(prev => prev.map(e => e.localId === localId ? { ...e, ocrStatus: 'FAILED' as const } : e));
    }
  }

  async function handleReadLabel() {
    if (!videoRef.current || !camActive) return;
    const cutoff      = Date.now() - 30_000;
    const targetEntry = scanEntries.find(e => !e.resolvedItemId && new Date(e.scannedAt).getTime() > cutoff);
    const targetId    = targetEntry?.localId ?? null;
    const barcodeData: BarcodeSource | null = targetEntry
      ? { serialNumber: targetEntry.serialNumber, partNumber: targetEntry.partNumber, itemType: targetEntry.itemTypeRaw }
      : null;
    setOcrLoading(true); setOcrError(null); setHudOcr('OCR_PROCESSING');
    try {
      const canvas = captureVideoFrame(videoRef.current);
      const ocr    = await ocrCanvasFrame(canvas, itemTypeCodes.current);
      if (targetId) applyOcrByEntryId(targetId, barcodeData, ocr);
      else addOcrOnlyEntry(ocr);
      setHudOcr('OCR_SUCCESS');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Label read failed.';
      setOcrError(msg); setHudOcr('OCR_FAILED');
    } finally { setOcrLoading(false); }
  }

  function addOcrOnlyEntry(ocr: OcrResult) {
    const merged = mergeScanAndOcr({ barcode: null, ocr });
    if (!merged.serialNumber && !merged.partNumber && !merged.itemType) {
      setOcrError('No recognizable data found on label.'); setHudOcr('OCR_FAILED'); return;
    }
    const parts = [merged.itemType, merged.partNumber, merged.serialNumber].filter(Boolean);
    const raw   = parts.length > 0 ? parts.join(';') : ocr.rawText.substring(0, 100);
    let rid: string | null = null, rname: string | null = null, rcode: string | null = null, ridFromMapping = false;
    if (merged.partNumber) { const r = resolveByPN(merged.partNumber); if (r) { rid = r.item.id; rname = r.item.item_name; rcode = r.item.item_code; ridFromMapping = r.fromMapping; } }
    if (!rid && merged.itemType) { const it = itemsByCode.current.get(merged.itemType.toUpperCase()); if (it) { rid = it.id; rname = it.item_name; rcode = it.item_code; } }
    const snNorm = merged.serialNumber ? normalizeSN(merged.serialNumber) : null;
    if (snNorm && sessionSNs.current.has(snNorm)) { setDuplicateCount(c => c + 1); setHud('DUPLICATE'); navigator.vibrate?.([50, 50, 50]); return; }
    if (snNorm && checkAndBlock(snNorm)) return;
    const entry: ScanEntry = {
      localId: crypto.randomUUID(), rawValue: raw, symbology: 'OCR',
      serialNumber: merged.serialNumber, serialNumberNorm: snNorm, partNumber: merged.partNumber,
      itemTypeRaw: merged.itemType, resolvedItemId: rid, resolvedItemName: rname, resolvedItemCode: rcode,
      resolvedByMapping: rid ? ridFromMapping : undefined,
      status: rid ? 'VALID' : 'PENDING', scannedAt: new Date().toISOString(), manually: false,
      statusMsg: rid ? null : merged.itemType ? `${merged.itemType} not in Item Master — assign manually` : 'Item not matched — select manually',
      parsingProfile: 'ocr', parseStatus: merged.serialNumber || merged.partNumber ? 'PARTIAL' : 'FAILED',
      matchStatus: rid ? 'MATCHED' : merged.partNumber ? 'UNMATCHED' : 'NO_PN',
      scanClassification: rid ? 'VALID_ITEM' : 'PARTIAL_ITEM',
      ocrRawText: ocr.rawText.substring(0, 500), ocrItemType: merged.itemType,
      ocrPartNumber: merged.partNumber, ocrSerialNumber: merged.serialNumber,
      mergeConflicts: [], mergeScenario: 'OCR_ONLY', ocrDurationMs: ocr.durationMs,
    };
    if (snNorm) sessionSNs.current.add(snNorm);
    setBlockedAsset(null);
    setScanEntries(prev => [entry, ...prev]);
    setHudOcr('OCR_SUCCESS');
    if (rid) { playSuccessBeep(); navigator.vibrate?.(50); }
  }

  // ── Finalize paired carton ────────────────────────────────────────────────
  function finalizePairedCarton(
    localId: string, pn: string, sn: string, snNorm: string,
    frame: HTMLCanvasElement | null, rawValue: string, symbology: string,
  ) {
    let resolvedId: string | null = null, resolvedName: string | null = null, resolvedCode: string | null = null, resolvedByMapping = false;
    const result = resolveByPN(pn);
    if (result) { resolvedId = result.item.id; resolvedName = result.item.item_name; resolvedCode = result.item.item_code; resolvedByMapping = result.fromMapping; }
    const entry: ScanEntry = {
      localId, rawValue, symbology, serialNumber: sn, serialNumberNorm: snNorm, partNumber: pn,
      itemTypeRaw: null, resolvedItemId: resolvedId, resolvedItemName: resolvedName, resolvedItemCode: resolvedCode,
      resolvedByMapping: resolvedId ? resolvedByMapping : undefined,
      status: resolvedId ? 'VALID' : 'PENDING',
      statusMsg: resolvedId ? null : 'Item not matched — select manually',
      scannedAt: new Date().toISOString(), manually: false, parsingProfile: 'nokia-pn-sn-aggregated',
      parseStatus: 'RESOLVED', matchStatus: resolvedId ? 'MATCHED' : 'UNMATCHED',
      scanClassification: resolvedId ? 'VALID_ITEM' : 'PARTIAL_ITEM',
      ocrStatus: frame ? 'RUNNING' : undefined,
      ocrCanvasSize: frame ? `${frame.width}×${frame.height}` : undefined,
    };
    sessionSNs.current.add(snNorm);
    setBlockedAsset(null);
    setScanEntries(prev => [entry, ...prev]);
    if (frame) void launchAutoOcr(localId, { serialNumber: sn, partNumber: pn, itemType: null }, frame);
    if (resolvedId) { setHud('SUCCESS'); playSuccessBeep(); navigator.vibrate?.(50); }
    else { setHud('UNKNOWN'); }
  }

  // ── Core scan handler ─────────────────────────────────────────────────────
  function handleRawScan(raw: string, symbology: string, manually: boolean) {
    setScanFlash(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setScanFlash(false), 250);

    const parsed         = parseScan(raw, symbology);
    const classification = classifyScan(parsed);
    const videoEl        = videoRef.current;

    if (classification === 'AUXILIARY_CODE' && parsed.parsingProfile === 'nokia-pn-only' && parsed.partNumber) {
      const newPn = parsed.partNumber;
      let pnFrame: HTMLCanvasElement | null = null;
      if (!manually && symbology !== 'USB_HID' && videoEl?.videoWidth) { try { pnFrame = captureVideoFrame(videoEl); } catch { /* non-fatal */ } }
      const existing = pendingCarton.current;
      if (existing && !isPendingExpired(existing) && existing.serialNumber && !existing.partNumber) {
        const frame = pendingCartonFrame.current ?? pnFrame; pendingCartonFrame.current = null;
        const sn = existing.serialNumber; const snNorm = normalizeSN(sn); const localId = existing.localId;
        clearPendingCarton(); finalizePairedCarton(localId, newPn, sn, snNorm, frame, raw, symbology); return;
      }
      if (existing && !isPendingExpired(existing) && !existing.serialNumber && existing.partNumber?.toUpperCase() === newPn.toUpperCase()) {
        if (pnFrame) { if (pendingCartonFrame.current) { pendingCartonFrame.current.width = 0; pendingCartonFrame.current.height = 0; } pendingCartonFrame.current = pnFrame; }
        startPendingCartonTimer();
      } else {
        clearPendingCarton(); pendingCarton.current = createPendingCarton({ partNumber: newPn }, crypto.randomUUID());
        pendingCartonFrame.current = pnFrame; startPendingCartonTimer(); setHudState('WAITING_SN');
      }
      return;
    }

    if (parsed.parsingProfile === 'nokia-sn-di' && parsed.serialNumber) {
      const newSn = parsed.serialNumber; const newSnNorm = normalizeSN(newSn);
      if (sessionSNs.current.has(newSnNorm)) {
        clearPendingCarton(); setDuplicateCount(c => c + 1); setHighlightSN(newSnNorm);
        if (hlTimer.current) clearTimeout(hlTimer.current);
        hlTimer.current = setTimeout(() => setHighlightSN(null), 2000);
        setHud('DUPLICATE'); navigator.vibrate?.([50, 50, 50]); return;
      }
      if (checkAndBlock(newSnNorm)) { clearPendingCarton(); return; }
      let snFrame: HTMLCanvasElement | null = null;
      if (!manually && symbology !== 'USB_HID' && videoEl?.videoWidth) { try { snFrame = captureVideoFrame(videoEl); } catch { /* non-fatal */ } }
      const existing = pendingCarton.current;
      if (existing && !isPendingExpired(existing) && existing.partNumber && !existing.serialNumber) {
        const frame = pendingCartonFrame.current ?? snFrame; pendingCartonFrame.current = null;
        const pn = existing.partNumber; const localId = existing.localId;
        clearPendingCarton(); finalizePairedCarton(localId, pn, newSn, newSnNorm, frame, raw, symbology); return;
      }
      if (existing && !isPendingExpired(existing) && !existing.partNumber && existing.serialNumber?.toUpperCase() === newSn.toUpperCase()) {
        if (snFrame) { if (pendingCartonFrame.current) { pendingCartonFrame.current.width = 0; pendingCartonFrame.current.height = 0; } pendingCartonFrame.current = snFrame; }
        startPendingCartonTimer();
      } else {
        clearPendingCarton(); pendingCarton.current = createPendingCarton({ serialNumber: newSn }, crypto.randomUUID());
        pendingCartonFrame.current = snFrame; startPendingCartonTimer(); setHudState('WAITING_PN');
      }
      return;
    }

    if (classification === 'UNKNOWN_IDENTIFIER') {
      const mappedItem = resolveByGenericCode(raw);

      let unknownFrame: HTMLCanvasElement | null = null;
      if (!manually && symbology !== 'USB_HID' && parsed.parsingProfile !== 'url-payload'
          && videoEl?.videoWidth) {
        try { unknownFrame = captureVideoFrame(videoEl); } catch { /* non-fatal */ }
      }

      const uid = crypto.randomUUID();
      const isSerialized = mappedItem?.tracking_method === 'SERIALIZED';
      const unknownEntry: ScanEntry = {
        localId:              uid,
        rawValue:             raw,
        symbology,
        serialNumber:         null,
        serialNumberNorm:     null,
        partNumber:           null,
        itemTypeRaw:          null,
        resolvedItemId:       mappedItem?.id ?? null,
        resolvedItemName:     mappedItem?.item_name ?? null,
        resolvedItemCode:     mappedItem?.item_code ?? null,
        resolvedByMapping:    mappedItem ? false : undefined,
        status:               (mappedItem && !isSerialized) ? 'VALID' as const : 'PENDING' as const,
        statusMsg:            isSerialized && mappedItem
          ? `${mappedItem.item_name} is serialized — scan SN barcode to complete`
          : parsed.parsingProfile === 'url-payload'
            ? 'Non-inventory QR payload — not an item barcode'
            : 'Unknown code — assign item if needed',
        scannedAt:            new Date().toISOString(),
        manually,
        parsingProfile:       parsed.parsingProfile,
        parseStatus:          'FAILED',
        matchStatus:          mappedItem ? 'MATCHED' : 'NO_PN',
        scanClassification:   classification,
        unknownIdentifierRaw: raw,
        ocrStatus:            unknownFrame ? 'RUNNING' as const : undefined,
        ocrCanvasSize:        unknownFrame ? `${unknownFrame.width}×${unknownFrame.height}` : undefined,
      };

      setBlockedAsset(null);
      setScanEntries(prev => [unknownEntry, ...prev]);

      if (unknownFrame) {
        void launchAutoOcr(uid, { serialNumber: null, partNumber: null, itemType: null }, unknownFrame);
      }

      setHud('UNKNOWN');
      return;
    }

    if (!manually && (classification === 'AUXILIARY_CODE' || classification === 'UNKNOWN_CODE')) return;

    if (pendingCarton.current && isPendingExpired(pendingCarton.current)) clearPendingCarton();

    const sn = parsed.serialNumber; const snNorm = sn ? normalizeSN(sn) : null;

    if (snNorm && sessionSNs.current.has(snNorm)) {
      clearPendingCarton(); setDuplicateCount(c => c + 1); setHighlightSN(snNorm);
      if (hlTimer.current) clearTimeout(hlTimer.current);
      hlTimer.current = setTimeout(() => setHighlightSN(null), 2000);
      setHud('DUPLICATE'); navigator.vibrate?.([50, 50, 50]); return;
    }
    if (snNorm && checkAndBlock(snNorm)) { clearPendingCarton(); return; }

    const pending = pendingCarton.current;
    if (pending && sn && snNorm) {
      const incomingPn = parsed.partNumber; const finalPn = incomingPn ?? pending.partNumber;
      const pnOk = isPnCompatible(pending.partNumber, incomingPn); const snOk = isSnCompatible(pending.serialNumber, sn);
      if (pnOk && snOk && finalPn) {
        const frame = pendingCartonFrame.current; pendingCartonFrame.current = null;
        const localId = pending.localId; clearPendingCarton();
        finalizePairedCarton(localId, finalPn, sn, snNorm, frame, raw, symbology); return;
      }
      clearPendingCarton();
    }

    const resolveItem = (): { id: string | null; name: string | null; code: string | null; fromMapping: boolean } => {
      if (parsed.partNumber) { const r = resolveByPN(parsed.partNumber); if (r) return { id: r.item.id, name: r.item.item_name, code: r.item.item_code, fromMapping: r.fromMapping }; }
      if (parsed.itemType)   { const it = itemsByCode.current.get(parsed.itemType.toUpperCase()); if (it) return { id: it.id, name: it.item_name, code: it.item_code, fromMapping: false }; }
      return { id: null, name: null, code: null, fromMapping: false };
    };
    const resolved = resolveItem();

    const parseStatus: ScanEntry['parseStatus'] =
      parsed.status === 'resolved'           ? 'RESOLVED' :
      parsed.status === 'partially_resolved' ? 'PARTIAL'  : 'FAILED';
    const matchStatus: ScanEntry['matchStatus'] =
      resolved.id       ? 'MATCHED'   : parsed.partNumber ? 'UNMATCHED' : 'NO_PN';
    const status: ScanEntry['status'] = resolved.id ? 'VALID' : 'PENDING';

    let autoOcrCanvas: HTMLCanvasElement | null = null;
    if (!manually && symbology !== 'USB_HID' && videoEl?.videoWidth) {
      try { autoOcrCanvas = captureVideoFrame(videoEl); } catch { /* non-fatal */ }
    }

    const localId = crypto.randomUUID();
    const entry: ScanEntry = {
      localId, rawValue: raw, symbology, serialNumber: sn, serialNumberNorm: snNorm,
      partNumber: parsed.partNumber, itemTypeRaw: parsed.itemType,
      resolvedItemId: resolved.id, resolvedItemName: resolved.name, resolvedItemCode: resolved.code,
      resolvedByMapping: resolved.id ? resolved.fromMapping : undefined,
      status, statusMsg: resolved.id ? null : 'Item not matched — select manually',
      scannedAt: new Date().toISOString(), manually, parsingProfile: parsed.parsingProfile,
      parseStatus, matchStatus, scanClassification: classification,
      ocrStatus:     autoOcrCanvas ? 'RUNNING' : undefined,
      ocrCanvasSize: autoOcrCanvas ? `${autoOcrCanvas.width}×${autoOcrCanvas.height}` : undefined,
    };

    if (snNorm) sessionSNs.current.add(snNorm);
    setBlockedAsset(null);
    setScanEntries(prev => [entry, ...prev]);

    if (autoOcrCanvas) {
      void launchAutoOcr(localId, { serialNumber: parsed.serialNumber, partNumber: parsed.partNumber, itemType: parsed.itemType }, autoOcrCanvas);
    }

    if (resolved.id) { setHud('SUCCESS'); playSuccessBeep(); navigator.vibrate?.(50); }
    else { setHud('UNKNOWN'); }
  }

  // ── Entry management ──────────────────────────────────────────────────────
  function removeEntry(localId: string) {
    setScanEntries(prev => {
      const entry = prev.find(e => e.localId === localId);
      if (entry?.serialNumberNorm) sessionSNs.current.delete(entry.serialNumberNorm);
      return prev.filter(e => e.localId !== localId);
    });
  }

  function resolveEntryItem(localId: string, itemId: string) {
    const item = items.find(i => i.id === itemId);
    if (!item) return;

    setScanEntries(prev => prev.map(e => {
      if (e.localId !== localId) return e;
      const needsSn = e.scanClassification === 'UNKNOWN_IDENTIFIER' && item.tracking_method === 'SERIALIZED';
      return {
        ...e,
        resolvedItemId:   itemId,
        resolvedItemName: item.item_name,
        resolvedItemCode: item.item_code,
        resolvedByMapping: false,
        status:    needsSn ? 'PENDING' as const : 'VALID' as const,
        statusMsg: needsSn ? `${item.item_name} is serialized — scan SN barcode to complete` : null,
        matchStatus: 'MATCHED' as const,
      };
    }));

    const entry = scanEntries.find(e => e.localId === localId);
    if (entry?.scanClassification === 'UNKNOWN_IDENTIFIER' && item.tracking_method === 'QUANTITY') {
      const row = {
        inventory_item_id: itemId,
        manufacturer:      null as string | null,
        code_type:         MAPPING_CODE_TYPE_GENERIC_IDENTIFIER,
        external_code:     entry.rawValue.trim(),
        parsing_profile:   null as string | null,
        is_active:         true,
        source:            MAPPING_SOURCE_RECEIVING,
        created_by:        currentUser?.id ?? null,
      };
      void supabase.from('item_code_mappings')
        .upsert([row], { ignoreDuplicates: true })
        .then(
          ({ error }) => { if (!error) learnedByCode.current.set(entry.rawValue.trim(), item); },
          () => { /* non-fatal */ },
        );
    }
  }

  function removeExistingRow(rowId: string) {
    const row = existingRows.find(r => r.id === rowId);
    if (row?.serial_number) sessionSNs.current.delete(normalizeSN(row.serial_number));
    setRemovedIds(prev => new Set([...prev, rowId]));
  }

  function toggleDiag(localId: string) {
    setExpandedDiags(prev => { const n = new Set(prev); n.has(localId) ? n.delete(localId) : n.add(localId); return n; });
  }

  function manualSubmit() {
    const sn = manualVal.trim();
    if (!sn) { setManualErr('Serial number is required.'); return; }
    setManualErr('');
    const type = manualType.trim(); const pn = manualPN.trim();
    const raw  = (type || pn) ? [type, pn, sn].filter(Boolean).join(';') : sn;
    setManualVal('');
    if (!batchMode) { setManualType(''); setManualPN(''); }
    handleRawScan(raw, 'MANUAL', true);
  }

  // ── Learn PN mappings ─────────────────────────────────────────────────────
  async function learnPnMappings(entries: ScanEntry[]) {
    const { candidates } = filterAndDeduplicateMappings(entries, learnedByPN.current);
    if (candidates.length === 0) return;
    const rows = candidates.map(c => ({
      inventory_item_id: c.itemId, manufacturer: null as string | null,
      code_type: MAPPING_CODE_TYPE_PN, external_code: c.partNumber,
      parsing_profile: null as string | null, is_active: true,
      source: MAPPING_SOURCE_RECEIVING, created_by: currentUser?.id ?? null,
    }));
    const { error } = await supabase.from('item_code_mappings').upsert(rows, { ignoreDuplicates: true });
    if (error) { console.warn('[LearnPN] Mapping insert skipped:', error.message); return; }
    for (const c of candidates) {
      const item = items.find(i => i.id === c.itemId);
      if (item) learnedByPN.current.set(normalizePn(c.partNumber), item);
    }
  }

  // ── Cancel editing ────────────────────────────────────────────────────────
  function handleCancelEditing() {
    if (hasChangesRef.current && !confirm('You have unsaved changes. Leave without saving?')) return;
    navigate('/warehouse/history');
  }

  // ── Save changes ──────────────────────────────────────────────────────────
  async function saveChanges() {
    if (!receipt || !receiptId) return;
    setSaving(true);

    if (needsReviewCount > 0) {
      showToast(`Resolve ${needsReviewCount} item conflict${needsReviewCount > 1 ? 's' : ''} before saving.`, false);
      setSaving(false);
      return;
    }

    if (!editDate) {
      showToast('Receipt date is required.', false);
      setSaving(false);
      return;
    }

    const keptExisting: EditScanEntryForRpc[] = existingRows
      .filter(r => !removedIds.has(r.id) && r.inventory_item_id)
      .map(r => ({
        inventory_item_id: r.inventory_item_id!,
        serial_number:     r.serial_number,
        part_number:       r.part_number,
        raw_scan_value:    r.raw_scan_value,
        barcode_symbology: r.barcode_symbology,
        scanned_manually:  r.scanned_manually,
      }));

    const newValidEntries: EditScanEntryForRpc[] = scanEntries
      .filter(e => e.status === 'VALID' && e.resolvedItemId && e.serialNumber)
      .map(e => ({
        inventory_item_id: e.resolvedItemId!,
        serial_number:     e.serialNumber!,
        part_number:       e.partNumber ?? null,
        raw_scan_value:    e.rawValue,
        barcode_symbology: e.symbology,
        scanned_manually:  e.manually,
      }));

    const allEntries = [...keptExisting, ...newValidEntries];

    if (allEntries.length === 0) {
      showToast('Cannot save a receipt with no scanned units.', false);
      setSaving(false);
      return;
    }

    const { data, error: rpcErr } = await supabase.rpc('update_pending_goods_receipt', {
      p_receipt_id:            receiptId,
      p_supplier_name:         editSupplier || null,
      p_delivery_note_number:  editDn       || null,
      p_purchase_order_number: editPo       || null,
      p_receipt_date:          editDate,
      p_notes:                 editNotes    || null,
      p_scan_entries:          allEntries,
    });

    if (rpcErr) {
      showToast(rpcErr.message, false);
      setSaving(false);
      return;
    }

    const result = data as { success: boolean; receipt_number: string; old_count: number; new_count: number };
    const added   = newValidEntries.length;
    const removed = removedIds.size;

    if (currentUser) {
      await Promise.allSettled([
        supabase.from('receiving_scan_sessions').insert({
          goods_receipt_id: receiptId,
          operator_id:      currentUser.id,
          total_scans:      allEntries.length,
          valid_scans:      allEntries.length,
        }),
        supabase.from('activity_log').insert({
          user_full_name: currentUser.full_name,
          action: `GOODS_RECEIPT_UPDATED ${result.receipt_number} (${added} added, ${removed} removed)`,
        }),
      ]);
    }

    await learnPnMappings(scanEntries.filter(e => e.status === 'VALID'));

    setSaving(false);
    hasChangesRef.current = false;
    showToast(`Receipt ${result.receipt_number} updated.`, true);
    setTimeout(() => navigate('/warehouse/history'), 1500);
  }

  // ── Loading / error states ────────────────────────────────────────────────
  if (loading) {
    return (
      <div className={css.page}>
        <div className={css.card} style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>
          Loading receipt…
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className={css.page}>
        <div className={css.card} style={{ padding: 32 }}>
          <p className={css.errorMsg}>{loadError}</p>
          <button className={css.btnGhost} onClick={() => navigate('/warehouse/history')}>
            Back to History
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={css.page}>
      <div className={css.pageHdr}>
        <div>
          <h1 className={css.pageTitle}>Edit Goods Receipt {receipt?.receipt_number}</h1>
          <p className={css.pageSubtitle}>
            {warehouseName} · <span style={{ color: '#f59e0b' }}>Pending Review</span>
          </p>
        </div>
      </div>

      {/* ── Editable header ──────────────────────────────────────────────── */}
      <div className={css.card} style={{ marginBottom: 16 }}>
        <div className={css.cardHdr}><span className={css.cardTitle}>Receipt Details</span></div>
        <div className={css.cardBody}>
          <div className={css.fieldset}>
            <div className={css.fieldRow}>
              <div className={css.field}>
                <label className={css.label}>Supplier / Vendor</label>
                <input className={css.input} value={editSupplier} placeholder="Nokia, Huawei…"
                  onChange={e => setEditSupplier(e.target.value)} />
              </div>
              <div className={css.field}>
                <label className={css.label}>Receipt Date *</label>
                <input type="date" className={css.input} value={editDate}
                  onChange={e => setEditDate(e.target.value)} />
              </div>
            </div>
            <div className={css.fieldRow}>
              <div className={css.field}>
                <label className={css.label}>Delivery Note #</label>
                <input className={css.input} value={editDn} placeholder="DN-XXXXX"
                  onChange={e => setEditDn(e.target.value)} />
              </div>
              <div className={css.field}>
                <label className={css.label}>Purchase Order #</label>
                <input className={css.input} value={editPo} placeholder="PO-XXXXX"
                  onChange={e => setEditPo(e.target.value)} />
              </div>
            </div>
            <div className={css.field}>
              <label className={css.label}>Notes</label>
              <textarea className={`${css.input} ${css.textarea}`} value={editNotes} rows={2}
                onChange={e => setEditNotes(e.target.value)} placeholder="Optional notes…" />
            </div>
          </div>
        </div>
      </div>

      {/* ── KPI strip ────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <KpiChip label="Total Units" value={totalUnits}         color="#6366f1" />
        <KpiChip label="New Added"   value={newValidCount}      color="#16a34a" />
        <KpiChip label="Removed"     value={removedIds.size}    color="#dc2626" />
        <KpiChip label="Duplicates"  value={duplicateCount}     color="#f59e0b" />
      </div>

      {/* ── Input mode selector ───────────────────────────────────────────── */}
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
        {/* ── Left: input panel ─────────────────────────────────────────── */}
        <div>
          {inputMode === 'camera' && (
            <>
              <div style={{ display: camActive ? 'block' : 'none' }}>
                <div className={css.videoWrap}
                  style={scanFlash ? { outline: '3px solid #16a34a', outlineOffset: 2 } : {}}>
                  <video ref={videoRef} className={css.videoEl} autoPlay playsInline muted />
                  <div className={css.videoOverlay}><div className={css.scanFrame} /></div>
                  {hudState !== 'IDLE' && (
                    <div className={`${css.hudBanner} ${
                      hudState === 'SUCCESS'           ? css.hudSuccess    :
                      hudState === 'DUPLICATE'         ? css.hudDuplicate  :
                      hudState === 'EXISTING_ASSET'    ? css.hudDuplicate  :
                      hudState === 'OCR_PROCESSING'    ? css.hudOcrProcess :
                      hudState === 'OCR_SUCCESS'       ? css.hudOcrSuccess :
                      hudState === 'OCR_FAILED'        ? css.hudOcrFailed  :
                      hudState === 'INCOMPLETE_CARTON' ? css.hudDuplicate  : css.hudUnknown
                    }`}>
                      {hudState === 'SUCCESS'           ? '✓ Added'                       :
                       hudState === 'DUPLICATE'         ? '⊘ Duplicate'                   :
                       hudState === 'EXISTING_ASSET'    ? '⊘ Already Known — see details' :
                       hudState === 'OCR_PROCESSING'    ? '⏳ Reading Label…'              :
                       hudState === 'OCR_SUCCESS'       ? '✓ Label Read'                   :
                       hudState === 'OCR_FAILED'        ? '✗ Label Unreadable'             :
                       hudState === 'WAITING_SN'        ? 'PN captured — scan SN'          :
                       hudState === 'WAITING_PN'        ? 'SN captured — scan PN'          :
                       hudState === 'INCOMPLETE_CARTON' ? 'Incomplete carton — scan again' : '? Unknown'}
                    </div>
                  )}
                  <div className={css.videoActions}>
                    {scannerRef.current?.hasTorch() && (
                      <button className={css.videoBtn} onClick={toggleTorch} title="Toggle torch">
                        {torch ? '🔦' : '💡'}
                      </button>
                    )}
                    <button className={css.videoBtn} onClick={handleReadLabel} disabled={ocrLoading}
                      title={ocrLoading ? 'Reading label…' : 'Read label text'}>
                      {ocrLoading ? '⏳' : '📝'}
                    </button>
                    <button className={css.videoBtn} onClick={switchCamera} title="Switch camera">🔄</button>
                    <button className={css.videoBtn} onClick={stopCamera} title="Stop camera">✕</button>
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
                      : 'Scan barcodes to add units to this receipt.'}
                  </div>
                  {camPerm !== 'denied' && (
                    <button className={css.btnAccent} style={{ marginTop: 8 }} onClick={startCamera}>
                      Start Camera
                    </button>
                  )}
                  <button className={css.btnGhost} style={{ fontSize: 11, height: 28, marginTop: 6 }}
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
              <div className={css.cameraOffHint}>Scan with your USB/Bluetooth hardware scanner.</div>
              {scanFlash && <div style={{ color: '#16a34a', fontWeight: 700, fontSize: 13, marginTop: 10 }}>✓ Scan received!</div>}
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
                    <input className={css.input} style={{ height: 34, fontSize: 13 }} placeholder="ABIO, FXDA…"
                      value={manualType} onChange={e => setManualType(e.target.value.toUpperCase())} />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.4px', display: 'block', marginBottom: 4 }}>
                      Part # {batchMode && <span style={{ color: '#6366f1' }}>🔒</span>}
                    </label>
                    <input className={css.input} style={{ height: 34, fontSize: 13 }} placeholder="474123-001.001"
                      value={manualPN} onChange={e => setManualPN(e.target.value)} />
                  </div>
                </div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.4px', display: 'block', marginBottom: 4 }}>
                    Serial Number *
                  </label>
                  <div className={css.manualRow} style={{ marginTop: 0 }}>
                    <input className={css.manualInput} placeholder="N90001234567…" value={manualVal}
                      onChange={e => setManualVal(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') manualSubmit(); }} autoFocus />
                    <button className={css.btnAccent} onClick={manualSubmit}>Add</button>
                  </div>
                </div>
              </div>
              {manualErr && <p className={css.formError} style={{ marginTop: 6 }}>{manualErr}</p>}
            </div>
          )}
        </div>

        {/* ── Right: unit list ─────────────────────────────────────────────── */}
        <div className={css.scanListWrap}>
          {/* Blocked-asset card */}
          {blockedAsset && (
            <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 10, padding: '12px 14px', marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: '#991b1b' }}>⊘ {blockedAsset.msg.headline}</div>
                <button onClick={() => setBlockedAsset(null)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#991b1b', fontSize: 18, lineHeight: 1, padding: '0 2px' }}
                  title="Dismiss">×</button>
              </div>
              <div style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 12, color: '#7f1d1d', marginTop: 4 }}>{blockedAsset.sn}</div>
              <div style={{ marginTop: 8, fontSize: 12, color: '#991b1b', lineHeight: 1.6, display: 'flex', flexDirection: 'column', gap: 1 }}>
                {blockedAsset.itemCode  && <div><strong>Item:</strong> {blockedAsset.itemCode} — {blockedAsset.itemName}</div>}
                {blockedAsset.partNumber && <div><strong>PN:</strong> {blockedAsset.partNumber}</div>}
                {blockedAsset.warehouseName && <div><strong>Location:</strong> {blockedAsset.warehouseName}</div>}
                {blockedAsset.receiptNumber && <div><strong>Receipt:</strong> {blockedAsset.receiptNumber}</div>}
              </div>
              <div style={{ marginTop: 6, fontSize: 11, color: '#7f1d1d', lineHeight: 1.4 }}>{blockedAsset.msg.subtext}</div>
              {blockedAsset.msg.allowReturn && (
                <div style={{ marginTop: 4, fontSize: 11, fontWeight: 700, color: '#991b1b' }}>
                  Use the Return to Warehouse workflow to process this asset.
                </div>
              )}
            </div>
          )}

          {/* New scans from this session */}
          {scanEntries.length > 0 && (
            <>
              <div className={css.scanListHdr}>
                <span className={css.scanCount}>{scanEntries.length} new scan{scanEntries.length !== 1 ? 's' : ''}</span>
                <button className={css.btnDanger} style={{ fontSize: 11, height: 26 }}
                  onClick={() => {
                    if (confirm('Clear new scans?')) {
                      for (const e of scanEntries) {
                        if (e.serialNumberNorm) sessionSNs.current.delete(e.serialNumberNorm);
                      }
                      setScanEntries([]);
                      setDuplicateCount(0);
                    }
                  }}>
                  Clear new
                </button>
              </div>
              <div className={css.scanList}>
                {scanEntries.map(e => (
                  <div key={e.localId}
                    className={`${css.scanEntry} ${
                      e.status === 'VALID' ? css.scanEntryValid :
                      e.status === 'ERROR' ? css.scanEntryError : css.scanEntryPending
                    } ${highlightSN && highlightSN === e.serialNumberNorm ? css.scanEntryHighlight : ''}`}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, flexWrap: 'wrap' }}>
                        {e.resolvedItemCode && <span className={css.scanCardItemCode}>{e.resolvedItemCode}</span>}
                        <span className={`${css.badge} ${
                          e.matchStatus === 'MATCHED'      ? css.badgeGreen :
                          e.matchStatus === 'NEEDS_REVIEW' ? css.badgeRed   :
                          e.matchStatus === 'UNMATCHED'    ? css.badgeAmber : css.badgeSlate
                        }`} style={{ fontSize: 9, padding: '1px 6px' }}>
                          {e.matchStatus === 'MATCHED' ? 'MATCHED' : e.matchStatus === 'NEEDS_REVIEW' ? 'NEEDS REVIEW' : e.matchStatus === 'UNMATCHED' ? 'NO MATCH' : 'NO PN'}
                        </span>
                      </div>
                      <div className={css.scanSN}>{e.serialNumber ?? '—'}</div>
                      {e.unknownIdentifierRaw && !e.serialNumber && (
                        <div style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'monospace', marginTop: 2, wordBreak: 'break-all' }}>
                          {e.parsingProfile === 'url-payload' ? '🔗' : '?'}{' '}
                          {e.unknownIdentifierRaw.length > 60
                            ? e.unknownIdentifierRaw.substring(0, 60) + '…'
                            : e.unknownIdentifierRaw}
                        </div>
                      )}
                      {e.partNumber && <div className={css.scanPN}>PN: {e.partNumber}</div>}
                      {e.resolvedItemName && <div className={css.scanItem}>{e.resolvedItemName}</div>}
                      {e.status === 'PENDING' && !e.resolvedItemId && e.parsingProfile !== 'url-payload' && (
                        <select style={{ marginTop: 4, fontSize: 11, border: '1px solid #e2e8f0', borderRadius: 4, padding: '2px 4px', maxWidth: '100%' }}
                          value="" onChange={ev => resolveEntryItem(e.localId, ev.target.value)}>
                          <option value="">— Assign item —</option>
                          {items.map(it => <option key={it.id} value={it.id}>{it.item_code} — {it.item_name}</option>)}
                        </select>
                      )}
                      {e.statusMsg && <div className={css.scanMsg}>{e.statusMsg}</div>}
                      <button className={css.scanDiagToggle} onClick={() => toggleDiag(e.localId)}>
                        {expandedDiags.has(e.localId) ? '▲ Diagnostics' : '▼ Diagnostics'}
                      </button>
                      {expandedDiags.has(e.localId) && <NokiaDiagBlock entry={e} />}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                      <span className={css.scanTime}>{new Date(e.scannedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      <button className={`${css.btnIcon} ${css.btnIconDanger}`} onClick={() => removeEntry(e.localId)} title="Remove">
                        <TrashIcon />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Existing units from DB */}
          {activeExistingRows.length > 0 && (
            <div style={{ marginTop: scanEntries.length > 0 ? 16 : 0 }}>
              <div className={css.scanListHdr}>
                <span className={css.scanCount}>
                  {activeExistingRows.length} existing unit{activeExistingRows.length !== 1 ? 's' : ''}
                  {removedIds.size > 0 && <span style={{ color: '#dc2626' }}> · {removedIds.size} removed</span>}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                {activeExistingRows.map(r => (
                  <div key={r.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '8px 10px', background: '#f0f9ff',
                    border: '1px solid #bae6fd', borderRadius: 8,
                  }}>
                    {r.itemCode && (
                      <span className={css.scanCardItemCode} style={{ flexShrink: 0 }}>{r.itemCode}</span>
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className={css.scanSN} style={{ fontSize: 13 }}>{r.serial_number}</div>
                      {r.part_number && <div className={css.scanPN} style={{ fontSize: 11 }}>PN: {r.part_number}</div>}
                      {r.itemName && <div style={{ fontSize: 11, color: '#64748b', marginTop: 1 }}>{r.itemName}</div>}
                    </div>
                    {r.barcode_symbology && (
                      <span className={`${css.badge} ${css.badgeSlate}`} style={{ fontSize: 10, flexShrink: 0 }}>
                        {r.barcode_symbology}
                      </span>
                    )}
                    <button className={`${css.btnIcon} ${css.btnIconDanger}`}
                      onClick={() => removeExistingRow(r.id)} title="Remove this unit">
                      <TrashIcon />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeExistingRows.length === 0 && scanEntries.length === 0 && (
            <div style={{ color: '#94a3b8', fontSize: 13, textAlign: 'center', padding: 32 }}>
              No units — scan items to add them
            </div>
          )}
        </div>
      </div>

      {/* ── Conflict warning ──────────────────────────────────────────────── */}
      {needsReviewCount > 0 && (
        <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 10, padding: 12, marginTop: 16, fontSize: 13, color: '#991b1b' }}>
          <strong>{needsReviewCount} item conflict{needsReviewCount > 1 ? 's' : ''} must be resolved before saving.</strong>
          {' '}Select the correct item for each scan marked <strong>NEEDS REVIEW</strong>.
        </div>
      )}

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 20 }}>
        <button className={css.btnGhost} onClick={handleCancelEditing}>
          Cancel Editing
        </button>
        <button className={css.btnAccent} onClick={saveChanges}
          disabled={saving || totalUnits === 0 || !editDate || needsReviewCount > 0}>
          {saving ? 'Saving…' : `Save Changes (${totalUnits} units)`}
        </button>
      </div>

      {toast && (
        <div className={`${css.toast} ${toast.ok ? css.toastOk : css.toastErr}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function NokiaDiagBlock({ entry: e }: { entry: ScanEntry }) {
  const isNokiaDI = e.parsingProfile === 'nokia-gs1';
  const diFields: DIField[] = isNokiaDI ? decodeAllDIFields(e.rawValue) : [];
  return (
    <div className={css.scanDiag}>
      <DiagRow label="RAW"    val={e.rawValue}          raw />
      <DiagRow label="SYM"    val={e.symbology} />
      <DiagRow label="PARSER" val={e.parsingProfile} />
      {isNokiaDI && diFields.length > 0 && (
        <>
          <div className={css.scanDiagRow} style={{ marginTop: 5, paddingTop: 4, borderTop: '1px solid #1e293b' }}>
            <span className={css.scanDiagKey} style={{ color: '#818cf8', minWidth: 80 }}>DI FIELDS</span>
          </div>
          {diFields.map((f, i) => (
            <div key={i} className={css.scanDiagRow}>
              <span className={css.scanDiagKey} style={{ color: f.di === '1P' ? '#34d399' : f.di === 'S' ? '#60a5fa' : f.di === '??' ? '#f87171' : '#94a3b8' }}>{f.di}</span>
              <span className={css.scanDiagVal} style={{ flex: 1 }}>{f.value}</span>
              {f.meaning && <span className={css.scanDiagVal} style={{ color: '#475569', marginLeft: 6, fontSize: 10 }}>{f.meaning}</span>}
              {!f.meaning && <span className={css.scanDiagVal} style={{ color: '#f87171', marginLeft: 6, fontSize: 10 }}>UNKNOWN DI</span>}
            </div>
          ))}
        </>
      )}
      {!isNokiaDI && (
        <>
          <DiagRow label="TYPE" val={e.itemTypeRaw ?? '—'} />
          <DiagRow label="PN"   val={e.partNumber   ?? '—'} />
          <DiagRow label="SN"   val={e.serialNumber  ?? '—'} />
        </>
      )}
      <div className={css.scanDiagRow} style={{ marginTop: 5, paddingTop: 4, borderTop: '1px solid #1e293b' }}>
        <span className={css.scanDiagKey} style={{ color: '#818cf8' }}>STATUS</span>
      </div>
      <DiagRow label="PARSE" val={e.parseStatus} />
      <DiagRow label="MATCH" val={e.matchStatus} />
      {e.ocrStatus && (
        <div className={css.scanDiagRow} style={{ marginTop: 5, paddingTop: 4, borderTop: '1px solid #1e293b' }}>
          <span className={css.scanDiagKey} style={{ color: '#818cf8' }}>OCR</span>
          <span className={css.scanDiagVal} style={{ color: '#475569' }}>{e.ocrStatus}{e.ocrDurationMs != null ? ` · ${e.ocrDurationMs}ms` : ''}</span>
        </div>
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
  if (loading) return <div className={css.diagPanel}><span style={{ color: '#94a3b8', fontSize: 12 }}>Running diagnostics…</span></div>;
  if (!data) return null;
  const rows = [
    { label: 'Secure Context (HTTPS)',    ok: data.secureContext,           value: data.secureContext ? 'Yes' : 'No — camera requires HTTPS' },
    { label: 'navigator.mediaDevices',    ok: data.mediaDevicesAvailable,   value: data.mediaDevicesAvailable ? 'Available' : 'Not available' },
    { label: 'getUserMedia',              ok: data.getUserMediaAvailable,   value: data.getUserMediaAvailable ? 'Available' : 'Not available' },
    { label: 'BarcodeDetector (native)',  ok: data.barcodeDetectorAvailable, value: data.barcodeDetectorAvailable ? `Yes (${data.barcodeDetectorFormats.length} formats)` : 'No — ZXing fallback' },
    { label: 'ZXing fallback',           ok: data.zxingAvailable,          value: data.zxingAvailable ? 'Available' : 'Not available' },
    { label: 'Camera permission',        ok: data.cameraPermission === 'granted', value: data.cameraPermission },
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

function KpiChip({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '6px 12px' }}>
      <span style={{ fontSize: 18, fontWeight: 800, color }}>{value}</span>
      <span style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.4px' }}>{label}</span>
    </div>
  );
}

function CameraIcon({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>;
}
function TrashIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>;
}
