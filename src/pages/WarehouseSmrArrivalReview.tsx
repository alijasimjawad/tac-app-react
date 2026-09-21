import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import {
  CameraScanner, parseScan, classifyScan,
  checkCameraPermission, cameraErrorMessage, type CameraPermission,
} from '../lib/warehouseScanner';
import { normalizeSN } from '../lib/warehouseTypes';
import type { SmrDocument, InventoryItem, Warehouse } from '../lib/warehouseTypes';
import {
  summarizeArrivalConfirmation, buildArrivalConfirmedPayload,
  type ArrivalConfirmedLine,
} from '../lib/smrHelpers';
import css from './Warehouse.module.css';

// ── Local types ────────────────────────────────────────────────────────────────

interface ReceiptHeader {
  id:                    string;
  receipt_number:        string;
  warehouse_id:          string;
  project_id:            string | null;
  supplier_name:         string | null;
  delivery_note_number:  string | null;
  purchase_order_number: string | null;
  receipt_date:          string;
  notes:                 string | null;
  status:                string;
}

interface PickupScanUi {
  serialNumber:      string;
  serialNumberNorm:  string;
  rawScanValue:      string | null;
  barcodeSymbology:  string | null;
  scannedManually:   boolean;
}

interface ArrivalScanUi {
  serialNumber:     string;
  serialNumberNorm: string;
}

interface ReviewLine {
  id:               string;
  lineIndex:        number;
  productNumberRaw: string | null;
  descriptionRaw:   string | null;
  expectedQty:      number;
  receivedQty:      number;
  matchedItemId:    string | null;
  matchedItemCode:  string | null;
  matchedItemName:  string | null;
  trackingMethod:   'SERIALIZED' | 'QUANTITY' | null;
  pickupScans:      PickupScanUi[];
  arrivalScans:     ArrivalScanUi[];
  arrivalConfirmed: boolean;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className={css.label}>{label}</div>
      <div style={{ fontSize: 13, color: '#1e293b', marginTop: 2 }}>{value}</div>
    </div>
  );
}

export default function WarehouseSmrArrivalReview() {
  const { receiptId } = useParams<{ receiptId: string }>();
  const { hasPerm, currentUser } = useAuth();
  const navigate = useNavigate();

  const [loading,   setLoading]   = useState(true);
  const [loadError, setLoadError] = useState('');
  const [receipt,   setReceipt]   = useState<ReceiptHeader | null>(null);
  const [smrDoc,    setSmrDoc]    = useState<SmrDocument | null>(null);
  const [lines,     setLines]     = useState<ReviewLine[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [posting,   setPosting]   = useState(false);
  const [toast,     setToast]     = useState<{ msg: string; ok: boolean } | null>(null);

  const [camPerm, setCamPerm] = useState<CameraPermission>('unknown');
  const [camOn,   setCamOn]   = useState(false);
  const [camErr,  setCamErr]  = useState<string | null>(null);
  const [manualSn, setManualSn] = useState('');

  const videoRef   = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<CameraScanner | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // See WarehouseSmrReconcile.tsx for why this indirection exists: the running
  // camera's onScan callback is bound once at Start Camera time, so it must
  // always call the CURRENT render's closure rather than a stale one that
  // captured an old `lines` array.
  const handleArrivalScanRef = useRef<(raw: string, symbology: string, manually: boolean) => void>(() => {});

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  if (!hasPerm('view_warehouse_history')) return <div className={css.denied}>Access denied.</div>;
  if (!hasPerm('wrh_receive_edit'))       return <div className={css.denied}>You need the "Edit Receipt" permission.</div>;
  const canPost = hasPerm('wrh_receive_post');

  // ── Load ─────────────────────────────────────────────────────────────────────
  useEffect(() => { load(); checkCameraPermission().then(setCamPerm); return () => stopCamera(); }, [receiptId]);

  async function load() {
    if (!receiptId) { setLoadError('No receipt ID provided.'); setLoading(false); return; }
    setLoading(true);

    const { data: rcpt, error: rErr } = await supabase.from('goods_receipts').select('*').eq('id', receiptId).single();
    if (rErr || !rcpt) { setLoadError(rErr?.message || 'Receipt not found.'); setLoading(false); return; }
    const rcptRow = rcpt as ReceiptHeader;
    if (rcptRow.status !== 'PENDING_REVIEW') {
      setLoadError(`This receipt is ${rcptRow.status} and cannot be reviewed.`);
      setLoading(false);
      return;
    }

    const { data: doc } = await supabase.from('smr_documents').select('*').eq('goods_receipt_id', receiptId).maybeSingle();
    if (!doc) {
      setLoadError('This receipt isn’t linked to a Customer SMR — use Edit Receipt instead.');
      setLoading(false);
      return;
    }

    const [linesRes, itemsRes, whRes] = await Promise.all([
      supabase.from('smr_lines').select('*').eq('smr_document_id', doc.id).order('line_index'),
      supabase.from('inventory_items').select('*').eq('is_active', true),
      supabase.from('warehouses').select('*').eq('is_active', true).order('name'),
    ]);

    const rawLines = (linesRes.data || []) as Array<{
      id: string; line_index: number; product_number_raw: string | null; description_raw: string | null;
      expected_qty: number; received_qty: number; matched_item_id: string | null;
      arrival_confirmed: boolean;
    }>;
    const itemsById = new Map((itemsRes.data as InventoryItem[] || []).map(it => [it.id, it]));

    const lineIds = rawLines.map(l => l.id);
    const { data: scanRows } = lineIds.length
      ? await supabase.from('smr_line_scans').select('*').in('smr_line_id', lineIds).order('created_at')
      : { data: [] as Array<Record<string, unknown>> };

    const scansByLine = new Map<string, Array<{ serial_number: string; serial_number_normalized: string; raw_scan_value: string | null; barcode_symbology: string | null; scanned_manually: boolean; stage: string }>>();
    for (const s of (scanRows || []) as Array<{ smr_line_id: string; serial_number: string; serial_number_normalized: string; raw_scan_value: string | null; barcode_symbology: string | null; scanned_manually: boolean; stage: string }>) {
      const arr = scansByLine.get(s.smr_line_id) ?? [];
      arr.push(s);
      scansByLine.set(s.smr_line_id, arr);
    }

    const built: ReviewLine[] = rawLines.map(l => {
      const item = l.matched_item_id ? itemsById.get(l.matched_item_id) : undefined;
      const scans = scansByLine.get(l.id) ?? [];
      return {
        id:               l.id,
        lineIndex:        l.line_index,
        productNumberRaw: l.product_number_raw,
        descriptionRaw:   l.description_raw,
        expectedQty:      l.expected_qty,
        receivedQty:      l.received_qty,
        matchedItemId:    l.matched_item_id,
        matchedItemCode:  item?.item_code ?? null,
        matchedItemName:  item?.item_name ?? null,
        trackingMethod:   item?.tracking_method ?? null,
        pickupScans:  scans.filter(s => s.stage !== 'ARRIVAL').map(s => ({
          serialNumber: s.serial_number, serialNumberNorm: s.serial_number_normalized,
          rawScanValue: s.raw_scan_value, barcodeSymbology: s.barcode_symbology, scannedManually: s.scanned_manually,
        })),
        arrivalScans: scans.filter(s => s.stage === 'ARRIVAL').map(s => ({
          serialNumber: s.serial_number, serialNumberNorm: s.serial_number_normalized,
        })),
        arrivalConfirmed: l.arrival_confirmed,
      };
    });

    setReceipt(rcptRow);
    setSmrDoc(doc as SmrDocument);
    setLines(built);
    setWarehouses((whRes.data || []) as Warehouse[]);
    setLoading(false);
  }

  // ── Camera ───────────────────────────────────────────────────────────────────
  async function startCamera() {
    if (!videoRef.current) return;
    setCamErr(null);
    const scanner = new CameraScanner();
    scannerRef.current = scanner;
    try {
      await scanner.start(videoRef.current, {
        onScan:  (raw, symbology) => handleArrivalScanRef.current(raw, symbology, false),
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

  // ── Confirm a line by scan — matches against THIS SMR's own pickup scans ─────
  async function handleArrivalScan(raw: string, symbology: string, manually: boolean) {
    const parsed = parseScan(raw, symbology);
    const classification = classifyScan(parsed);
    if (classification === 'AUXILIARY_CODE') return;
    if (!parsed.serialNumber) { showToast('Could not read a serial number from that code.', false); return; }

    const snNorm = normalizeSN(parsed.serialNumber);
    const targetLine = lines.find(l => l.pickupScans.some(s => s.serialNumberNorm === snNorm));

    if (!targetLine) {
      showToast(`Serial ${snNorm} isn’t part of this SMR — not added.`, false);
      return;
    }
    if (targetLine.arrivalScans.some(s => s.serialNumberNorm === snNorm)) {
      showToast(`Already confirmed on #${targetLine.lineIndex}.`, false);
      return;
    }

    // Optimistic UI
    setLines(prev => prev.map(l => l.id === targetLine.id
      ? { ...l, arrivalScans: [...l.arrivalScans, { serialNumber: parsed.serialNumber!, serialNumberNorm: snNorm }], arrivalConfirmed: true }
      : l));

    const { error: insErr } = await supabase.from('smr_line_scans').insert({
      smr_line_id:       targetLine.id,
      serial_number:      parsed.serialNumber,
      raw_scan_value:      raw,
      barcode_symbology: symbology === 'MANUAL' ? null : symbology,
      scanned_manually:  manually,
      scanned_by:        currentUser?.id || null,
      stage:              'ARRIVAL',
    });

    if (insErr) {
      setLines(prev => prev.map(l => l.id === targetLine.id
        ? { ...l, arrivalScans: l.arrivalScans.filter(s => s.serialNumberNorm !== snNorm) }
        : l));
      showToast(`Scan failed: ${insErr.message}`, false);
      return;
    }

    if (!targetLine.arrivalConfirmed) {
      await supabase.from('smr_lines').update({
        arrival_confirmed:    true,
        arrival_confirmed_at: new Date().toISOString(),
        arrival_confirmed_by: currentUser?.id || null,
      }).eq('id', targetLine.id);
    }

    showToast(`Confirmed #${targetLine.lineIndex} ${targetLine.matchedItemCode || targetLine.productNumberRaw || ''}`, true);
  }

  useEffect(() => { handleArrivalScanRef.current = (raw, symbology, manually) => { void handleArrivalScan(raw, symbology, manually); }; });

  async function handleManualAdd() {
    const sn = manualSn.trim();
    if (!sn) return;
    setManualSn('');
    await handleArrivalScan(sn, 'MANUAL', true);
  }

  // ── Tick confirm (works for any line — serialized or quantity) ───────────────
  async function toggleTick(lineId: string, next: boolean) {
    setLines(prev => prev.map(l => l.id === lineId ? { ...l, arrivalConfirmed: next } : l));
    const patch = next
      ? { arrival_confirmed: true, arrival_confirmed_at: new Date().toISOString(), arrival_confirmed_by: currentUser?.id || null }
      : { arrival_confirmed: false, arrival_confirmed_at: null, arrival_confirmed_by: null };
    const { error } = await supabase.from('smr_lines').update(patch).eq('id', lineId);
    if (error) {
      setLines(prev => prev.map(l => l.id === lineId ? { ...l, arrivalConfirmed: !next } : l));
      showToast(`Failed to update: ${error.message}`, false);
    }
  }

  // ── Destination warehouse override ────────────────────────────────────────────
  async function saveWarehouse(newId: string) {
    if (!receipt) return;
    const prev = receipt.warehouse_id;
    setReceipt({ ...receipt, warehouse_id: newId });
    const { error } = await supabase.from('goods_receipts').update({ warehouse_id: newId }).eq('id', receiptId);
    if (error) {
      setReceipt(r => r ? { ...r, warehouse_id: prev } : r);
      showToast(`Failed to update warehouse: ${error.message}`, false);
    } else {
      showToast('Destination warehouse updated.', true);
    }
  }

  // ── Post to Stock — only the confirmed lines get posted ──────────────────────
  async function handlePost() {
    if (!receipt || !canPost || posting) return;
    const confirmed = lines.filter(l => l.arrivalConfirmed);
    const missing   = lines.filter(l => !l.arrivalConfirmed);

    if (confirmed.length === 0) { showToast('Confirm at least one item before posting.', false); return; }

    const missingLabel = missing.map(l => `#${l.lineIndex} ${l.matchedItemCode || l.productNumberRaw || 'unmatched'}`).join(', ');
    const msg = missing.length
      ? `${missing.length} item(s) are not confirmed and will NOT be posted:\n${missingLabel}\n\nPost the ${confirmed.length} confirmed item(s) to stock?`
      : `Post all ${confirmed.length} confirmed item(s) to stock?`;
    if (!confirm(msg)) return;

    setPosting(true);
    try {
      const payloadLines: ArrivalConfirmedLine[] = confirmed.map(l => ({
        matchedItemId:  l.matchedItemId,
        trackingMethod: l.trackingMethod,
        receivedQty:    l.receivedQty,
        partNumberRaw:  l.productNumberRaw,
        pickupScans:    l.pickupScans.map(s => ({
          serialNumber: s.serialNumber, rawScanValue: s.rawScanValue,
          barcodeSymbology: s.barcodeSymbology, scannedManually: s.scannedManually,
        })),
      }));
      const { scanEntries, quantityEntries } = buildArrivalConfirmedPayload(payloadLines);

      if (scanEntries.length === 0 && quantityEntries.length === 0) {
        showToast('Nothing to post — none of the confirmed lines are matched to an inventory item.', false);
        setPosting(false);
        return;
      }

      const { error: updErr } = await supabase.rpc('update_pending_goods_receipt', {
        p_receipt_id:            receiptId,
        p_supplier_name:         receipt.supplier_name,
        p_delivery_note_number:  receipt.delivery_note_number,
        p_purchase_order_number: receipt.purchase_order_number,
        p_receipt_date:          receipt.receipt_date,
        p_notes:                 receipt.notes,
        p_scan_entries:          scanEntries,
        p_quantity_entries:      quantityEntries,
      });
      if (updErr) throw updErr;

      const { data: postResult, error: postErr } = await supabase.rpc('post_goods_receipt', {
        p_receipt_id:   receiptId,
        p_performed_by: currentUser?.id || '',
      });
      if (postErr) throw postErr;

      const created = (postResult as { assets_created?: number } | null)?.assets_created ?? 0;
      showToast(`Posted to stock — ${created} unit(s) created.`, true);
      setTimeout(() => navigate('/warehouse/history'), 1200);
    } catch (e: unknown) {
      showToast(`Post failed: ${e instanceof Error ? e.message : String(e)}`, false);
    }
    setPosting(false);
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  if (loading) return <div className={css.page}><p style={{ color: '#94a3b8' }}>Loading…</p></div>;
  if (loadError) {
    return (
      <div className={css.page}>
        <p className={css.errorMsg}>{loadError}</p>
        <button className={css.btnGhost} onClick={() => navigate('/warehouse/history')}>← Back to Receiving History</button>
      </div>
    );
  }
  if (!receipt || !smrDoc) return null;

  const summary = summarizeArrivalConfirmation(lines.map(l => ({ arrivalConfirmed: l.arrivalConfirmed })));
  const destName = warehouses.find(w => w.id === receipt.warehouse_id)?.name || '—';

  return (
    <div className={css.page}>
      <div className={css.pageHdr}>
        <div>
          <h1 className={css.pageTitle}>Confirm Arrival — {smrDoc.smr_number}</h1>
          <p className={css.pageSubtitle}>Receipt {receipt.receipt_number} · Pending Review</p>
        </div>
        <div className={css.hdrActions}>
          <button className={css.btnGhost} onClick={() => navigate('/warehouse/history')}>← Back</button>
        </div>
      </div>

      <div className={css.card} style={{ marginBottom: 18 }}>
        <div className={css.cardBody}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
            <Field label="Customer" value={smrDoc.customer_name || '—'} />
            <Field label="Source WH" value={smrDoc.source_warehouse_name || '—'} />
            <Field label="S.R Date" value={smrDoc.sr_date || '—'} />
            <div>
              <div className={css.label}>Destination Warehouse</div>
              <select className={css.fieldSelect} style={{ marginTop: 2, width: '100%' }}
                value={receipt.warehouse_id} onChange={e => saveWarehouse(e.target.value)}>
                {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
          </div>
        </div>
      </div>

      <div className={css.kpiGrid} style={{ marginBottom: 18 }}>
        <div className={css.kpiCard}>
          <div className={css.kpiContent}>
            <div className={css.kpiValue}>{summary.total}</div>
            <div className={css.kpiLabel}>Total Lines</div>
          </div>
        </div>
        <div className={css.kpiCard}>
          <div className={css.kpiContent}>
            <div className={css.kpiValue} style={{ color: '#16a34a' }}>{summary.confirmed}</div>
            <div className={css.kpiLabel}>Confirmed</div>
          </div>
        </div>
        <div className={css.kpiCard}>
          <div className={css.kpiContent}>
            <div className={css.kpiValue} style={{ color: summary.missing ? '#dc2626' : '#1e293b' }}>{summary.missing}</div>
            <div className={css.kpiLabel}>Missing / Not Confirmed</div>
          </div>
        </div>
      </div>

      <div className={css.card} style={{ marginBottom: 18 }}>
        <div className={css.cardHdr}><span className={css.cardTitle}>Line Items — destination: {destName}</span></div>
        <div className={css.tableWrap}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 40 }}></th>
                <th>#</th>
                <th>Part Number</th>
                <th>Description</th>
                <th>Matched Item</th>
                <th style={{ textAlign: 'right' }}>Received</th>
                <th>Serial Numbers</th>
                <th>Arrival Status</th>
              </tr>
            </thead>
            <tbody>
              {lines.map(l => (
                <tr key={l.id} style={{ background: l.arrivalConfirmed ? '#f0fdf4' : undefined }}>
                  <td>
                    <input type="checkbox" checked={l.arrivalConfirmed}
                      onChange={e => toggleTick(l.id, e.target.checked)} />
                  </td>
                  <td>{l.lineIndex}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{l.productNumberRaw || '—'}</td>
                  <td style={{ fontSize: 12 }}>{l.descriptionRaw || '—'}</td>
                  <td style={{ fontSize: 12 }}>{l.matchedItemCode ? `${l.matchedItemCode} — ${l.matchedItemName}` : <span style={{ color: '#dc2626' }}>Unmatched</span>}</td>
                  <td style={{ textAlign: 'right' }}>{l.receivedQty}</td>
                  <td style={{ fontSize: 11, fontFamily: 'monospace', maxWidth: 220 }}>
                    {l.pickupScans.length === 0 ? '—' : l.pickupScans.map(s => {
                      const arrived = l.arrivalScans.some(a => a.serialNumberNorm === s.serialNumberNorm);
                      return (
                        <span key={s.serialNumberNorm} style={{
                          display: 'inline-block', margin: '1px 3px 1px 0', padding: '1px 5px', borderRadius: 4,
                          background: arrived ? '#dcfce7' : '#f1f5f9', color: arrived ? '#16a34a' : '#64748b',
                        }}>{s.serialNumber}{arrived ? ' ✓' : ''}</span>
                      );
                    })}
                  </td>
                  <td>
                    {l.arrivalConfirmed
                      ? <span className={`${css.badge} ${css.badgeGreen}`}>Confirmed</span>
                      : <span className={`${css.badge} ${css.badgeRed}`}>Missing</span>}
                  </td>
                </tr>
              ))}
              {lines.length === 0 && (
                <tr><td colSpan={8} className={css.emptyMsg} style={{ textAlign: 'center', padding: 24 }}>No line items on this SMR.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className={css.card} style={{ marginBottom: 18 }}>
        <div className={css.cardHdr}><span className={css.cardTitle}>Scan to Confirm</span></div>
        <div className={css.cardBody}>
          <p style={{ fontSize: 12, color: '#64748b', marginTop: 0, marginBottom: 12 }}>
            Scan a unit's serial — if it matches a serial already recorded on this SMR, that line is confirmed automatically.
          </p>
          <div className={css.videoWrap} style={{ maxHeight: 260, display: camOn ? 'block' : 'none' }}>
            <video ref={videoRef} className={css.videoEl} />
            <div className={css.videoOverlay}><div className={css.scanFrame} /></div>
          </div>
          {camOn ? (
            <button className={css.btnGhost} style={{ marginTop: 8 }} onClick={stopCamera}>Stop Camera</button>
          ) : (
            <>
              <button className={css.btnAccent} onClick={startCamera}>Start Camera</button>
              {camErr && <p style={{ fontSize: 12, color: '#dc2626', marginTop: 6 }}>{camErr}</p>}
              {camPerm === 'denied' && <p style={{ fontSize: 12, color: '#dc2626', marginTop: 6 }}>Camera permission denied — allow it in browser settings.</p>}
            </>
          )}
          <div className={css.manualRow} style={{ marginTop: 12 }}>
            <input className={`${css.input} ${css.manualInput}`} placeholder="Manual serial entry…"
              value={manualSn} onChange={e => setManualSn(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleManualAdd(); }} />
            <button className={css.btnSm} onClick={handleManualAdd}>Add</button>
          </div>
        </div>
      </div>

      {canPost && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button className={css.btnAccent} onClick={handlePost} disabled={posting}>
            {posting ? 'Posting…' : `Post to Stock (${summary.confirmed} confirmed)`}
          </button>
        </div>
      )}

      {toast && (
        <div className={`${css.toast} ${toast.ok ? css.toastOk : css.toastErr}`}>{toast.msg}</div>
      )}
    </div>
  );
}
