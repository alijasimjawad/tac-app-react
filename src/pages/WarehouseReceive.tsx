import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import {
  CameraScanner, UsbScanner, parseScan, checkCameraPermission,
  type CameraPermission,
} from '../lib/warehouseScanner';
import type { Warehouse, InventoryItem, ScanEntry, SessionDetails } from '../lib/warehouseTypes';
import { normalizeSN } from '../lib/warehouseTypes';
import css from './Warehouse.module.css';

type Step = 1 | 2 | 3;
type InputMode = 'camera' | 'usb' | 'manual';

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
  const [torch, setTorch] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<CameraScanner | null>(null);
  const usbRef = useRef<UsbScanner | null>(null);
  const [scanEntries, setScanEntries] = useState<ScanEntry[]>([]);
  const [manualVal, setManualVal] = useState('');
  const [manualErr, setManualErr] = useState('');

  // Item master (for resolving)
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);

  // Step 3 — review
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      if (iRes.data) setItems(iRes.data as InventoryItem[]);
      const perm = await checkCameraPermission();
      setCamPerm(perm);
    })();
    return () => stopCamera();
  }, []);

  // ── Camera ────────────────────────────────────────────────────────────────
  async function startCamera() {
    if (!videoRef.current) return;
    const scanner = new CameraScanner();
    scannerRef.current = scanner;
    try {
      await scanner.start(videoRef.current, {
        onScan: (raw, symbology) => handleRawScan(raw, symbology, false),
        onError: msg => showToast(msg, false),
        onStart: () => {
          setCamActive(true);
          setCamPerm('granted');
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Camera error';
      if (msg.includes('NotAllowedError') || msg.includes('Permission')) {
        setCamPerm('denied');
        showToast('Camera permission denied.', false);
      } else {
        showToast(msg, false);
      }
    }
  }

  function stopCamera() {
    scannerRef.current?.stop();
    scannerRef.current = null;
    setCamActive(false);
    setTorch(false);
  }

  async function toggleTorch() {
    if (!scannerRef.current) return;
    await scannerRef.current.toggleTorch();
    setTorch(t => !t);
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

  // ── Resolve item from parsed scan ─────────────────────────────────────────
  const resolveItem = useCallback((parsed: ReturnType<typeof parseScan>, items: InventoryItem[]) => {
    if (!items.length) return { id: null, name: null, code: null };
    // Match by part_number first
    if (parsed.partNumber) {
      const pn = parsed.partNumber.toUpperCase();
      const m = items.find(it => (it.part_number || '').toUpperCase() === pn);
      if (m) return { id: m.id, name: m.item_name, code: m.item_code };
    }
    // Match by item_type
    if (parsed.itemType) {
      const it = parsed.itemType.toUpperCase();
      const m = items.find(i => (i.item_type || '').toUpperCase() === it || i.item_code.toUpperCase() === it);
      if (m) return { id: m.id, name: m.item_name, code: m.item_code };
    }
    return { id: null, name: null, code: null };
  }, []);

  async function handleRawScan(raw: string, symbology: string, manually: boolean) {
    const parsed = parseScan(raw, symbology);
    const sn     = parsed.serialNumber;
    const snNorm = sn ? normalizeSN(sn) : null;
    const resolved = resolveItem(parsed, items);

    const localId = crypto.randomUUID();
    const entry: ScanEntry = {
      localId,
      rawValue:         raw,
      symbology,
      serialNumber:     sn,
      serialNumberNorm: snNorm,
      partNumber:       parsed.partNumber,
      itemTypeRaw:      parsed.itemType,
      resolvedItemId:   resolved.id,
      resolvedItemName: resolved.name,
      resolvedItemCode: resolved.code,
      status:           'PENDING',
      statusMsg:        null,
      scannedAt:        new Date().toISOString(),
      manually,
    };

    setScanEntries(prev => {
      // Deduplicate by normalized SN within this session
      if (snNorm) {
        const dup = prev.find(e => e.serialNumberNorm === snNorm);
        if (dup) {
          return [
            ...prev.map(e => e.localId === dup.localId
              ? ({ ...e, status: 'DUPLICATE' as const, statusMsg: 'Duplicate in this session' } satisfies ScanEntry)
              : e
            ),
            { ...entry, status: 'DUPLICATE' as const, statusMsg: 'Already scanned' } satisfies ScanEntry,
          ];
        }
      }
      if (!resolved.id) {
        return [{ ...entry, status: 'PENDING' as const, statusMsg: 'Item not matched — select manually' } satisfies ScanEntry, ...prev];
      }
      return [{ ...entry, status: 'VALID' as const, statusMsg: null } satisfies ScanEntry, ...prev];
    });
  }

  function removeEntry(localId: string) {
    setScanEntries(prev => prev.filter(e => e.localId !== localId));
  }

  function manualSubmit() {
    const val = manualVal.trim();
    if (!val) { setManualErr('Enter a serial number or scan value.'); return; }
    setManualErr('');
    setManualVal('');
    handleRawScan(val, 'MANUAL', true);
  }

  function resolveEntryItem(localId: string, itemId: string) {
    const item = items.find(i => i.id === itemId);
    setScanEntries(prev => prev.map(e =>
      e.localId === localId
        ? { ...e, resolvedItemId: itemId, resolvedItemName: item?.item_name || null, resolvedItemCode: item?.item_code || null, status: 'VALID', statusMsg: null }
        : e
    ));
  }

  // ── Step validation ────────────────────────────────────────────────────────
  function goStep2() {
    setSessionErr('');
    if (!session.warehouseId) { setSessionErr('Select a warehouse.'); return; }
    if (!session.receiptDate) { setSessionErr('Receipt date is required.'); return; }
    stopCamera();
    setStep(2);
  }

  function goStep3() {
    const valid = scanEntries.filter(e => e.status === 'VALID');
    if (!valid.length && !scanEntries.length) {
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

    // Insert scan session record
    await supabase.from('receiving_scan_sessions').insert({
      goods_receipt_id: receipt.id,
      operator_id:      currentUser?.id || '',
      total_scans:      scanEntries.length,
      valid_scans:      validEntries.length,
    });

    // Group valid entries by item
    const grouped: Record<string, { itemId: string; entries: ScanEntry[] }> = {};
    for (const e of validEntries) {
      if (!e.resolvedItemId) continue;
      if (!grouped[e.resolvedItemId]) grouped[e.resolvedItemId] = { itemId: e.resolvedItemId, entries: [] };
      grouped[e.resolvedItemId].entries.push(e);
    }

    // Insert receipt line items
    const lineItems = Object.values(grouped).map(g => ({
      goods_receipt_id:  receipt.id,
      inventory_item_id: g.itemId,
      quantity:          g.entries.length,
      part_number:       g.entries[0].partNumber || null,
    }));
    if (lineItems.length) {
      const { error: liErr } = await supabase.from('goods_receipt_items').insert(lineItems);
      if (liErr) showToast(`Warning: line items not saved — ${liErr.message}`, false);
    }

    // Insert scan log rows
    const scanLogs = validEntries.map(e => ({
      goods_receipt_id:  receipt.id,
      inventory_item_id: e.resolvedItemId!,
      serial_number:     e.serialNumber || e.rawValue,
      raw_scan_value:    e.rawValue,
      barcode_symbology: e.symbology,
      scanned_manually:  e.manually,
    }));
    if (scanLogs.length) {
      await supabase.from('receiving_scan_log').insert(scanLogs);
    }

    if (currentUser) {
      await supabase.from('activity_log').insert({
        user_full_name: currentUser.full_name,
        action:         `Created goods receipt ${receipt.receipt_number} (${validEntries.length} items)`,
      });
    }

    setSaving(false);
    showToast(`Receipt ${receipt.receipt_number} saved — pending review.`, true);
    setTimeout(() => navigate('/warehouse/history'), 1500);
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const validCount   = scanEntries.filter(e => e.status === 'VALID').length;
  const dupCount     = scanEntries.filter(e => e.status === 'DUPLICATE').length;
  const pendingCount = scanEntries.filter(e => e.status === 'PENDING').length;

  const grouped = scanEntries.filter(e => e.status === 'VALID').reduce<Record<string, ScanEntry[]>>((acc, e) => {
    const key = e.resolvedItemCode || 'UNMATCHED';
    if (!acc[key]) acc[key] = [];
    acc[key].push(e);
    return acc;
  }, {});

  const warehouseName = warehouses.find(w => w.id === session.warehouseId)?.name;

  return (
    <div className={css.page}>
      {/* Wizard steps */}
      <WizardHeader step={step} />

      {/* ── Step 1: Session details ─────────────────────────────────────── */}
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
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <KpiChip label="Scanned" value={scanEntries.length} color="#6366f1" />
            <KpiChip label="Valid"   value={validCount}   color="#16a34a" />
            <KpiChip label="Pending" value={pendingCount} color="#f59e0b" />
            <KpiChip label="Dup"     value={dupCount}     color="#dc2626" />
          </div>

          {/* Mode switcher */}
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
            {/* Left — camera / input */}
            <div>
              {inputMode === 'camera' && (
                camActive ? (
                  <div className={css.videoWrap}>
                    <video ref={videoRef} className={css.videoEl} playsInline muted />
                    <div className={css.videoOverlay}>
                      <div className={css.scanFrame} />
                    </div>
                    <div className={css.videoActions}>
                      {scannerRef.current?.hasTorch() && (
                        <button className={css.videoBtn} onClick={toggleTorch} title="Toggle torch">
                          {torch ? '🔦' : '💡'}
                        </button>
                      )}
                      <button className={css.videoBtn} onClick={stopCamera} title="Stop camera">
                        ✕
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className={css.cameraOff}>
                    <CameraIcon size={48} />
                    <div className={css.cameraOffTitle}>
                      {camPerm === 'denied' ? 'Camera access denied' : 'Camera is off'}
                    </div>
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
                  </div>
                )
              )}

              {inputMode === 'usb' && (
                <div className={css.cameraOff} style={{ minHeight: 200 }}>
                  <div style={{ fontSize: 40 }}>🔌</div>
                  <div className={css.cameraOffTitle}>USB Scanner Active</div>
                  <div className={css.cameraOffHint}>
                    Scan barcodes with your USB/Bluetooth hardware scanner. Focus stays on this page.
                  </div>
                  <div style={{ marginTop: 12, fontSize: 12, color: '#94a3b8', fontFamily: 'monospace' }}>
                    Listening for keyboard input…
                  </div>
                </div>
              )}

              {inputMode === 'manual' && (
                <div className={css.card} style={{ padding: 18, marginBottom: 0 }}>
                  <div style={{ marginBottom: 8, fontSize: 13, fontWeight: 700, color: '#1e293b' }}>Manual Entry</div>
                  <div className={css.manualRow}>
                    <input
                      className={css.manualInput}
                      placeholder="Type serial number or scan value…"
                      value={manualVal}
                      onChange={e => setManualVal(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') manualSubmit(); }}
                      autoFocus
                    />
                    <button className={css.btnAccent} onClick={manualSubmit}>Add</button>
                  </div>
                  {manualErr && <p className={css.formError} style={{ marginTop: 4 }}>{manualErr}</p>}
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
                    onClick={() => { if (confirm('Clear all scans?')) setScanEntries([]); }}>
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
                        e.status === 'DUPLICATE' ? css.scanEntryDup :
                        e.status === 'ERROR' ? css.scanEntryError : css.scanEntryPending
                      }`}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className={css.scanSN}>{e.serialNumber || e.rawValue}</div>
                        {e.partNumber && <div className={css.scanPN}>PN: {e.partNumber}</div>}
                        {e.resolvedItemName ? (
                          <div className={css.scanItem}>{e.resolvedItemCode} — {e.resolvedItemName}</div>
                        ) : e.status === 'PENDING' ? (
                          <select style={{ marginTop: 4, fontSize: 11, border: '1px solid #e2e8f0', borderRadius: 4, padding: '2px 4px', maxWidth: '100%' }}
                            value=""
                            onChange={ev => resolveEntryItem(e.localId, ev.target.value)}>
                            <option value="">— Assign item —</option>
                            {items.map(it => <option key={it.id} value={it.id}>{it.item_code} — {it.item_name}</option>)}
                          </select>
                        ) : null}
                        {e.statusMsg && <div className={css.scanMsg}>{e.statusMsg}</div>}
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

      {/* ── Step 3: Review ────────────────────────────────────────────────── */}
      {step === 3 && (
        <>
          <div className={css.card} style={{ marginBottom: 16 }}>
            <div className={css.cardHdr}><span className={css.cardTitle}>Receipt Summary</span></div>
            <div className={css.cardBody}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, fontSize: 13 }}>
                <SummaryField label="Warehouse" value={warehouseName || '—'} />
                <SummaryField label="Date" value={session.receiptDate} />
                <SummaryField label="Supplier" value={session.supplierName || '—'} />
                <SummaryField label="Delivery Note" value={session.deliveryNote || '—'} />
                <SummaryField label="PO Number" value={session.poNumber || '—'} />
                <SummaryField label="Total Scans" value={String(scanEntries.length)} />
              </div>
            </div>
          </div>

          {/* Stats */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <KpiChip label="Valid"    value={validCount}   color="#16a34a" />
            <KpiChip label="Pending"  value={pendingCount} color="#f59e0b" />
            <KpiChip label="Duplicate" value={dupCount}    color="#dc2626" />
          </div>

          {pendingCount > 0 && (
            <div style={{ background: '#fef9c3', border: '1px solid #fde047', borderRadius: 10, padding: 12, marginBottom: 16, fontSize: 13, color: '#713f12' }}>
              <strong>{pendingCount} scan{pendingCount !== 1 ? 's' : ''}</strong> still unmatched to an item.
              Go back to assign them, or save now and match later.
            </div>
          )}

          {/* Grouped by item */}
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

function WizardHeader({ step }: { step: Step }) {
  const steps = ['Receipt Details', 'Scan Items', 'Review & Save'];
  return (
    <div style={{ marginBottom: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, color: '#1e293b', margin: '0 0 16px' }}>Receive Materials</h1>
      <div className={css.wizardSteps}>
        {steps.map((label, i) => {
          const n = (i + 1) as Step;
          const cls = n < step ? 'done' : n === step ? 'active' : '';
          return (
            <div key={n} className={`${css.wizardStep} ${cls === 'done' ? css['done' as keyof typeof css] || '' : ''}`}
              style={{ color: n < step ? '#16a34a' : n === step ? '#6366f1' : '#94a3b8' }}>
              {i > 0 && <div className={css.stepLine} style={{ background: n <= step ? (n < step ? '#16a34a' : '#6366f1') : '#e2e8f0' }} />}
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
