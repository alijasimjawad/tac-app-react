import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { CameraScanner, UsbScanner, parseScan } from '../lib/warehouseScanner';
import {
  validateDestination,
  isDuplicateAsset,
  validateQuantityIssue,
  checkAssetBelongsToIssue,
  checkAssetItemMatch,
  computeAvailableQty,
  type DestinationType,
} from '../lib/goodsIssueHelpers';
import css from './Warehouse.module.css';

// ── Local types ───────────────────────────────────────────────────────────────

interface ScannedAsset {
  assetId:      string;
  serialNumber: string;
  partNumber:   string | null;
}

interface IssueLine {
  localId:        string;
  itemId:         string;
  itemCode:       string;
  itemName:       string;
  trackingMethod: 'SERIALIZED' | 'QUANTITY';
  quantity:       number;   // QUANTITY items: user-set; SERIALIZED: equals assets.length
  available:      number;
  assets:         ScannedAsset[];
  lineError:      string | null;
}

interface DestOption { id: string; label: string; }

// ── Helpers ───────────────────────────────────────────────────────────────────

const todayStr = () => new Date().toISOString().slice(0, 10);

const DEST_TYPE_LABELS: Record<DestinationType, string> = {
  SITE:        'Site',
  TEAM_MEMBER: 'Team Member',
  USER:        'User',
  VEHICLE:     'Vehicle',
  EXTERNAL:    'External',
  OTHER:       'Other',
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function WarehouseIssue() {
  const navigate = useNavigate();
  const { hasPerm, currentUser } = useAuth();

  // ── Wizard step ───────────────────────────────────────────────────────────
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // ── Step 1 — Header ───────────────────────────────────────────────────────
  const [warehouseId,  setWarehouseId]  = useState('');
  const [projectId,    setProjectId]    = useState('');
  const [issueDate,    setIssueDate]    = useState(todayStr());
  const [destType,     setDestType]     = useState<DestinationType>('SITE');
  const [destId,       setDestId]       = useState('');
  const [destLabel,    setDestLabel]    = useState('');
  const [notes,        setNotes]        = useState('');
  const [step1Error,   setStep1Error]   = useState('');

  // ── Step 2 — Line items ───────────────────────────────────────────────────
  const [lines,          setLines]          = useState<IssueLine[]>([]);
  const [expandedLineId, setExpandedLineId] = useState<string | null>(null);
  const [scanInput,      setScanInput]      = useState('');
  const [scanError,      setScanError]      = useState('');
  const [scanLoading,    setScanLoading]    = useState(false);
  const [cameraActive,   setCameraActive]   = useState(false);
  const [step2Error,     setStep2Error]     = useState('');

  // Item search
  const [itemQuery,   setItemQuery]   = useState('');
  const [itemResults, setItemResults] = useState<Array<{
    id: string; item_code: string; item_name: string; tracking_method: string;
  }>>([]);

  // ── Step 3 — Post ─────────────────────────────────────────────────────────
  const [posting,   setPosting]   = useState(false);
  const [postError, setPostError] = useState('');

  // ── Reference data ────────────────────────────────────────────────────────
  const [warehouses,  setWarehouses]  = useState<Array<{ id: string; name: string }>>([]);
  const [projects,    setProjects]    = useState<Array<{ id: string; display_name: string }>>([]);
  const [destOptions, setDestOptions] = useState<DestOption[]>([]);

  const warehouseNameRef = useRef('');
  const projectNameRef   = useRef('');

  // ── Toast ─────────────────────────────────────────────────────────────────
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Scanner refs ──────────────────────────────────────────────────────────
  const videoRef     = useRef<HTMLVideoElement>(null);
  const cameraRef    = useRef<CameraScanner | null>(null);
  const scanInputRef = useRef<HTMLInputElement>(null);

  // Stable ref wrapping the latest handleScan — avoids stale closures in scanner callbacks
  const handleScanRef = useRef<((raw: string) => Promise<void>) | undefined>(undefined);

  if (!hasPerm('view_warehouse_issue')) return <div className={css.denied}>Access denied.</div>;

  // ── Toast ─────────────────────────────────────────────────────────────────
  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  // ── Load reference data ───────────────────────────────────────────────────
  useEffect(() => {
    Promise.all([
      supabase.from('warehouses').select('id, name').eq('is_active', true).order('name'),
      supabase.from('projects').select('id, display_name').eq('is_active', true).order('sort_order').order('display_name'),
    ]).then(([wRes, pRes]) => {
      if (wRes.data) setWarehouses(wRes.data);
      if (pRes.data) setProjects(pRes.data as Array<{ id: string; display_name: string }>);
    });
  }, []);

  // ── Load destination options when type changes ────────────────────────────
  useEffect(() => {
    setDestId('');
    setDestLabel('');
    setDestOptions([]);
    if (destType === 'SITE') {
      supabase.from('sites').select('id, site_code, site_name').order('site_name')
        .then(({ data }) => {
          if (data) setDestOptions(data.map(s => ({ id: s.id, label: `${s.site_code} — ${s.site_name}` })));
        });
    } else if (destType === 'USER') {
      supabase.from('users').select('id, full_name').order('full_name')
        .then(({ data }) => {
          if (data) setDestOptions(data.map(u => ({ id: u.id, label: u.full_name })));
        });
    }
  }, [destType]);

  // ── Item search ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (itemQuery.trim().length < 2) { setItemResults([]); return; }
    const q = itemQuery.trim();
    supabase
      .from('inventory_items')
      .select('id, item_code, item_name, tracking_method')
      .eq('is_active', true)
      .or(`item_code.ilike.%${q}%,item_name.ilike.%${q}%`)
      .order('item_code')
      .limit(20)
      .then(({ data }) => setItemResults(data ?? []));
  }, [itemQuery]);

  // ── Add line item ─────────────────────────────────────────────────────────
  async function addItem(item: { id: string; item_code: string; item_name: string; tracking_method: string }) {
    if (!warehouseId || !projectId) { showToast('Select warehouse and project first', false); return; }
    if (lines.some(l => l.itemId === item.id)) { showToast('Item already in this issue', false); return; }

    const { data: bal } = await supabase
      .from('stock_balances')
      .select('quantity_on_hand, quantity_reserved')
      .eq('warehouse_id', warehouseId)
      .eq('project_id', projectId)
      .eq('inventory_item_id', item.id)
      .maybeSingle();

    const onHand    = bal?.quantity_on_hand  ?? 0;
    const reserved  = bal?.quantity_reserved ?? 0;
    const available = computeAvailableQty(onHand, reserved);

    const line: IssueLine = {
      localId:        crypto.randomUUID(),
      itemId:         item.id,
      itemCode:       item.item_code,
      itemName:       item.item_name,
      trackingMethod: item.tracking_method as 'SERIALIZED' | 'QUANTITY',
      quantity:       item.tracking_method === 'QUANTITY' ? Math.min(1, available) : 0,
      available,
      assets:         [],
      lineError:      null,
    };

    setLines(prev => [...prev, line]);
    setItemQuery('');
    setItemResults([]);
    if (item.tracking_method === 'SERIALIZED') setExpandedLineId(line.localId);
  }

  // ── Update quantity for QUANTITY items ────────────────────────────────────
  function updateQty(localId: string, qty: number) {
    setLines(prev => prev.map(l => {
      if (l.localId !== localId) return l;
      const err = validateQuantityIssue(qty, l.available);
      return { ...l, quantity: qty, lineError: err };
    }));
  }

  // ── Remove line item ──────────────────────────────────────────────────────
  function removeLine(localId: string) {
    setLines(prev => prev.filter(l => l.localId !== localId));
    if (expandedLineId === localId) {
      setExpandedLineId(null);
      setCameraActive(false);
    }
  }

  // ── Remove scanned asset ──────────────────────────────────────────────────
  function removeAsset(lineLocalId: string, assetId: string) {
    setLines(prev => prev.map(l => {
      if (l.localId !== lineLocalId) return l;
      const assets = l.assets.filter(a => a.assetId !== assetId);
      return { ...l, assets, quantity: assets.length };
    }));
  }

  // ── Handle scan (via camera, USB, or manual input) ────────────────────────
  // NOTE: This function is assigned to handleScanRef.current on every render
  // so scanner callbacks always invoke the latest version without stale closures.
  handleScanRef.current = async (raw: string) => {
    const lineId = expandedLineId;
    if (!lineId) return;

    const line = lines.find(l => l.localId === lineId);
    if (!line) return;

    setScanError('');
    setScanLoading(true);

    try {
      const parsed = parseScan(raw.trim(), 'MANUAL');
      const sn = parsed.serialNumber ?? raw.trim();
      if (!sn) {
        setScanError('Could not extract serial number from scan');
        return;
      }

      const snNorm = sn.trim().toUpperCase();

      // Duplicate SN check within this line
      if (line.assets.some(a => a.serialNumber.toUpperCase() === snNorm)) {
        setScanError(`Already added: ${sn}`);
        return;
      }

      // Duplicate across all lines
      const allAssetIds = lines.flatMap(l => l.assets.map(a => a.assetId));

      // Look up asset in DB
      const { data: asset, error: dbErr } = await supabase
        .from('inventory_assets')
        .select('id, serial_number, part_number, status, warehouse_id, project_id, inventory_item_id')
        .eq('serial_number_normalized', snNorm)
        .maybeSingle();

      if (dbErr) { setScanError(dbErr.message); return; }
      if (!asset) { setScanError(`Asset not found in stock: ${sn}`); return; }

      if (isDuplicateAsset(allAssetIds, asset.id)) {
        setScanError(`${sn}: already added to another item in this issue`);
        return;
      }

      const belongsErr = checkAssetBelongsToIssue(
        asset.project_id, projectId, asset.warehouse_id, warehouseId,
      );
      if (belongsErr) { setScanError(`${sn}: ${belongsErr}`); return; }

      if (asset.status !== 'IN_STOCK') {
        setScanError(`${sn} is ${asset.status} — not available for issue`);
        return;
      }

      const itemMatchErr = checkAssetItemMatch(asset.inventory_item_id, line.itemId);
      if (itemMatchErr) { setScanError(`${sn}: ${itemMatchErr}`); return; }

      // All valid — add to line
      const newAsset: ScannedAsset = {
        assetId:      asset.id,
        serialNumber: asset.serial_number,
        partNumber:   asset.part_number,
      };

      setLines(prev => prev.map(l => {
        if (l.localId !== lineId) return l;
        const assets = [...l.assets, newAsset];
        return { ...l, assets, quantity: assets.length, lineError: null };
      }));
      setScanInput('');
    } finally {
      setScanLoading(false);
    }
  };

  // ── Camera scanner ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!cameraActive || !videoRef.current) return;
    const cam = new CameraScanner();
    cameraRef.current = cam;
    cam.start(videoRef.current, {
      onScan: (raw, sym) => {
        const parsed = parseScan(raw, sym);
        handleScanRef.current?.(parsed.serialNumber ?? raw);
      },
      onError: msg => setScanError(msg),
    });
    return () => { cam.stop(); cameraRef.current = null; };
  }, [cameraActive]);

  // ── USB scanner (attaches to document.body when a serialized line is expanded) ──
  useEffect(() => {
    if (!expandedLineId) return;
    const usb = new UsbScanner(document.body, {
      onScan: (raw) => handleScanRef.current?.(raw),
    });
    usb.attach();
    return () => usb.detach();
  }, [expandedLineId]);

  // Stop camera when expanded line changes or scanner collapses
  useEffect(() => {
    if (!expandedLineId) {
      cameraRef.current?.stop();
      setCameraActive(false);
    }
  }, [expandedLineId]);

  // ── Step validation ───────────────────────────────────────────────────────
  function validateStep1(): boolean {
    if (!warehouseId) { setStep1Error('Select a warehouse'); return false; }
    if (!projectId)   { setStep1Error('Select a project'); return false; }
    if (!issueDate)   { setStep1Error('Enter an issue date'); return false; }
    const err = validateDestination(destType, destId || null, destLabel);
    if (err) { setStep1Error(err); return false; }
    setStep1Error('');
    // Snapshot names for Step 3 display
    warehouseNameRef.current = warehouses.find(w => w.id === warehouseId)?.name ?? warehouseId;
    projectNameRef.current   = projects.find(p => p.id === projectId)?.display_name ?? projectId;
    return true;
  }

  function validateStep2(): boolean {
    if (lines.length === 0) { setStep2Error('Add at least one item'); return false; }
    for (const l of lines) {
      if (l.trackingMethod === 'QUANTITY') {
        const err = validateQuantityIssue(l.quantity, l.available);
        if (err) { setStep2Error(`${l.itemCode}: ${err}`); return false; }
      } else {
        if (l.assets.length === 0) {
          setStep2Error(`${l.itemCode}: no assets scanned — expand and scan at least one`);
          return false;
        }
      }
    }
    setStep2Error('');
    return true;
  }

  // ── Post issue ────────────────────────────────────────────────────────────
  async function postIssue() {
    if (!currentUser) return;
    setPosting(true);
    setPostError('');

    try {
      const finalDestId = (destType === 'VEHICLE' || destType === 'EXTERNAL' || destType === 'OTHER')
        ? null : (destId || null);

      // 1. Insert goods_issues (DRAFT)
      const { data: issueRow, error: issueErr } = await supabase
        .from('goods_issues')
        .insert({
          warehouse_id:      warehouseId,
          project_id:        projectId,
          issue_date:        issueDate,
          destination_type:  destType,
          destination_id:    finalDestId,
          destination_label: destLabel,
          notes:             notes.trim() || null,
          status:            'DRAFT',
          issued_by:         currentUser.id,
        })
        .select('id, issue_number')
        .single();

      if (issueErr) throw new Error(issueErr.message);
      const issueId = issueRow.id;

      // 2. Insert goods_issue_items
      const lineResults: Array<{ lineLocalId: string; itemRowId: string; line: IssueLine }> = [];
      for (const l of lines) {
        const { data: itemRow, error: itemErr } = await supabase
          .from('goods_issue_items')
          .insert({
            goods_issue_id:    issueId,
            inventory_item_id: l.itemId,
            quantity:          l.trackingMethod === 'SERIALIZED' ? l.assets.length : l.quantity,
          })
          .select('id')
          .single();
        if (itemErr) throw new Error(itemErr.message);
        lineResults.push({ lineLocalId: l.localId, itemRowId: itemRow.id, line: l });
      }

      // 3. Insert goods_issue_assets (SERIALIZED items only)
      for (const { itemRowId, line } of lineResults) {
        if (line.trackingMethod !== 'SERIALIZED') continue;
        for (const asset of line.assets) {
          const { error: assetErr } = await supabase
            .from('goods_issue_assets')
            .insert({
              goods_issue_id:      issueId,
              goods_issue_item_id: itemRowId,
              inventory_asset_id:  asset.assetId,
            });
          if (assetErr) throw new Error(assetErr.message);
        }
      }

      // 4. Call post_goods_issue RPC
      const { data: rpcResult, error: rpcErr } = await supabase.rpc('post_goods_issue', {
        p_issue_id:     issueId,
        p_performed_by: currentUser.id,
      });

      if (rpcErr) throw new Error(rpcErr.message);

      showToast(`${rpcResult.issue_number} posted successfully`, true);
      setTimeout(() => navigate('/warehouse/issue-history'), 1200);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setPostError(msg);
      showToast(msg, false);
    } finally {
      setPosting(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const warehouseName = warehouses.find(w => w.id === warehouseId)?.name ?? '—';
  const projectName   = projects.find(p => p.id === projectId)?.display_name ?? '—';

  return (
    <div className={css.page}>
      <div className={css.pageHdr}>
        <div>
          <h1 className={css.pageTitle}>New Goods Issue</h1>
          <p className={css.pageSubtitle}>Issue materials from warehouse stock</p>
        </div>
      </div>

      {/* ── Wizard steps indicator ── */}
      <div className={css.wizardSteps} style={{ marginBottom: 20 }}>
        <div className={`${css.wizardStep} ${step >= 1 ? (step > 1 ? css.done : css.active) : ''}`}>
          <div className={css.stepNum}>{step > 1 ? '✓' : '1'}</div>
          <span>Issue Details</span>
        </div>
        <div className={`${css.stepLine} ${step > 1 ? css.stepLineDone : ''}`} />
        <div className={`${css.wizardStep} ${step >= 2 ? (step > 2 ? css.done : css.active) : ''}`}>
          <div className={css.stepNum}>{step > 2 ? '✓' : '2'}</div>
          <span>Items &amp; Assets</span>
        </div>
        <div className={`${css.stepLine} ${step > 2 ? css.stepLineDone : ''}`} />
        <div className={`${css.wizardStep} ${step === 3 ? css.active : ''}`}>
          <div className={css.stepNum}>3</div>
          <span>Review &amp; Post</span>
        </div>
      </div>

      {/* ── Step 1: Header ── */}
      {step === 1 && (
        <div className={css.card}>
          <div className={css.cardHdr}><span className={css.cardTitle}>Issue Details</span></div>
          <div className={css.cardBody}>
            <div className={css.fieldRow}>
              <div>
                <div className={css.label}>Warehouse *</div>
                <select
                  className={css.fieldSelect}
                  value={warehouseId}
                  onChange={e => { setWarehouseId(e.target.value); setLines([]); }}
                >
                  <option value="">Select warehouse…</option>
                  {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </div>
              <div>
                <div className={css.label}>Project *</div>
                <select
                  className={css.fieldSelect}
                  value={projectId}
                  onChange={e => { setProjectId(e.target.value); setLines([]); }}
                >
                  <option value="">Select project…</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.display_name}</option>)}
                </select>
              </div>
            </div>

            <div className={css.fieldRow} style={{ marginTop: 14 }}>
              <div>
                <div className={css.label}>Issue Date *</div>
                <input type="date" className={css.input} value={issueDate} onChange={e => setIssueDate(e.target.value)} />
              </div>
              <div>
                <div className={css.label}>Destination Type *</div>
                <select className={css.fieldSelect} value={destType} onChange={e => setDestType(e.target.value as DestinationType)}>
                  {(Object.entries(DEST_TYPE_LABELS) as [DestinationType, string][]).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              {(destType === 'SITE' || destType === 'USER') && destOptions.length > 0 ? (
                <>
                  <div className={css.label}>{DEST_TYPE_LABELS[destType]} *</div>
                  <select
                    className={css.fieldSelect}
                    value={destId}
                    onChange={e => {
                      const opt = destOptions.find(o => o.id === e.target.value);
                      setDestId(e.target.value);
                      setDestLabel(opt?.label ?? '');
                    }}
                  >
                    <option value="">Select {DEST_TYPE_LABELS[destType].toLowerCase()}…</option>
                    {destOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                </>
              ) : (
                <>
                  <div className={css.label}>Destination *</div>
                  <input
                    className={css.input}
                    placeholder={`Enter ${DEST_TYPE_LABELS[destType].toLowerCase()} name…`}
                    value={destLabel}
                    onChange={e => setDestLabel(e.target.value)}
                  />
                </>
              )}
            </div>

            <div style={{ marginTop: 14 }}>
              <div className={css.label}>Notes</div>
              <textarea
                className={css.textarea}
                rows={3}
                placeholder="Optional notes…"
                value={notes}
                onChange={e => setNotes(e.target.value)}
              />
            </div>

            {step1Error && <p className={css.formError} style={{ marginTop: 10 }}>{step1Error}</p>}

            <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end' }}>
              <button
                className={css.btnAccent}
                onClick={() => { if (validateStep1()) setStep(2); }}
              >
                Next: Add Items →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Step 2: Items & Assets ── */}
      {step === 2 && (
        <div className={css.card}>
          <div className={css.cardHdr}>
            <span className={css.cardTitle}>Items &amp; Assets</span>
            <span style={{ fontSize: 12, color: '#64748b' }}>
              {warehouseName} · {projectName}
            </span>
          </div>
          <div className={css.cardBody}>
            {/* Item search */}
            <div style={{ marginBottom: 16 }}>
              <div className={css.label}>Search &amp; Add Item</div>
              <div className={css.searchWrap}>
                <SearchIcon className={css.searchIcon} />
                <input
                  className={css.searchInput}
                  placeholder="Type item code or name…"
                  value={itemQuery}
                  onChange={e => setItemQuery(e.target.value)}
                  onBlur={() => setTimeout(() => setItemResults([]), 200)}
                />
              </div>
              {itemResults.length > 0 && (
                <div style={{
                  border: '1px solid #e2e8f0', borderRadius: 8, marginTop: 4,
                  overflow: 'hidden', maxHeight: 220, overflowY: 'auto',
                  boxShadow: '0 4px 12px rgba(0,0,0,.08)',
                }}>
                  {itemResults.map(item => (
                    <div
                      key={item.id}
                      style={{
                        padding: '8px 14px', cursor: 'pointer',
                        borderBottom: '1px solid #f1f5f9',
                        display: 'flex', alignItems: 'center', gap: 10,
                        background: '#fff',
                      }}
                      onMouseDown={() => addItem(item)}
                    >
                      <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 12, minWidth: 80 }}>
                        {item.item_code}
                      </span>
                      <span style={{ fontSize: 12, color: '#475569', flex: 1 }}>{item.item_name}</span>
                      <span
                        className={`${css.badge} ${item.tracking_method === 'SERIALIZED' ? css.badgePurple : css.badgeBlue}`}
                        style={{ fontSize: 10 }}
                      >
                        {item.tracking_method}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Line items */}
            {lines.length === 0 ? (
              <div className={css.emptyState} style={{ padding: 28 }}>
                <div className={css.emptyMsg}>No items added yet</div>
                <div className={css.emptyHint}>Search for items above to add them</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {lines.map(line => (
                  <div
                    key={line.localId}
                    style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}
                  >
                    {/* Line header */}
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '10px 14px', background: '#f8fafc',
                    }}>
                      <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 12 }}>
                        {line.itemCode}
                      </span>
                      <span style={{ fontSize: 12, color: '#64748b', flex: 1 }}>{line.itemName}</span>
                      <span
                        className={`${css.badge} ${line.trackingMethod === 'SERIALIZED' ? css.badgePurple : css.badgeBlue}`}
                        style={{ fontSize: 10 }}
                      >
                        {line.trackingMethod}
                      </span>
                      <span style={{ fontSize: 11, color: '#64748b', whiteSpace: 'nowrap' }}>
                        Avail: {line.available}
                      </span>
                      {line.trackingMethod === 'SERIALIZED' && (
                        <button
                          className={css.btnGhost}
                          style={{ fontSize: 11, height: 26, whiteSpace: 'nowrap' }}
                          onClick={() => {
                            const isOpen = expandedLineId === line.localId;
                            setExpandedLineId(isOpen ? null : line.localId);
                            if (isOpen) setCameraActive(false);
                            setScanError('');
                            setScanInput('');
                          }}
                        >
                          {expandedLineId === line.localId
                            ? 'Collapse'
                            : `Scan (${line.assets.length})`}
                        </button>
                      )}
                      <button
                        className={css.btnIcon}
                        style={{ color: '#dc2626' }}
                        onClick={() => removeLine(line.localId)}
                        title="Remove item"
                      >
                        ✕
                      </button>
                    </div>

                    {/* QUANTITY: qty input */}
                    {line.trackingMethod === 'QUANTITY' && (
                      <div style={{
                        padding: '10px 14px',
                        display: 'flex', alignItems: 'center', gap: 12,
                      }}>
                        <div className={css.label} style={{ margin: 0, minWidth: 60 }}>Quantity</div>
                        <input
                          type="number"
                          className={css.input}
                          style={{ width: 90, textAlign: 'right' }}
                          min={1}
                          max={line.available}
                          value={line.quantity || ''}
                          onChange={e => updateQty(line.localId, parseInt(e.target.value, 10) || 0)}
                        />
                        <span style={{ fontSize: 12, color: '#64748b' }}>
                          / {line.available} available
                        </span>
                        {line.lineError && (
                          <span className={css.formError}>{line.lineError}</span>
                        )}
                      </div>
                    )}

                    {/* SERIALIZED: scan section */}
                    {line.trackingMethod === 'SERIALIZED' && expandedLineId === line.localId && (
                      <div style={{ padding: '12px 14px', borderTop: '1px solid #e2e8f0' }}>
                        {/* Scanner input row */}
                        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                          <div className={css.searchWrap} style={{ flex: 1 }}>
                            <SearchIcon className={css.searchIcon} />
                            <input
                              ref={scanInputRef}
                              className={css.searchInput}
                              placeholder="Scan or type serial number, then press Enter…"
                              value={scanInput}
                              onChange={e => setScanInput(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter' && scanInput.trim()) {
                                  handleScanRef.current?.(scanInput.trim());
                                  setScanInput('');
                                }
                              }}
                              disabled={scanLoading}
                              autoFocus
                            />
                          </div>
                          <button
                            className={css.btnGhost}
                            style={{ whiteSpace: 'nowrap' }}
                            disabled={scanLoading || !scanInput.trim()}
                            onClick={() => {
                              if (scanInput.trim()) {
                                handleScanRef.current?.(scanInput.trim());
                                setScanInput('');
                              }
                            }}
                          >
                            Add
                          </button>
                          <button
                            className={css.btnGhost}
                            style={{ whiteSpace: 'nowrap' }}
                            onClick={() => setCameraActive(v => !v)}
                          >
                            {cameraActive ? 'Stop Camera' : '📷 Camera'}
                          </button>
                        </div>

                        {/* Camera preview */}
                        {cameraActive && (
                          <div style={{ marginBottom: 10, borderRadius: 8, overflow: 'hidden', background: '#000', maxHeight: 220 }}>
                            <video
                              ref={videoRef}
                              style={{ width: '100%', maxHeight: 220, display: 'block' }}
                              autoPlay
                              playsInline
                              muted
                            />
                          </div>
                        )}

                        {scanLoading && (
                          <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 8px' }}>Checking…</p>
                        )}
                        {scanError && (
                          <p className={css.formError} style={{ margin: '0 0 8px' }}>{scanError}</p>
                        )}

                        {/* Scanned assets list */}
                        {line.assets.length > 0 ? (
                          <div style={{ background: '#f8fafc', borderRadius: 8, padding: '8px 12px' }}>
                            <div style={{
                              fontSize: 11, fontWeight: 700, color: '#64748b',
                              textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6,
                            }}>
                              Scanned ({line.assets.length})
                            </div>
                            {line.assets.map((asset, i) => (
                              <div
                                key={asset.assetId}
                                style={{
                                  display: 'flex', alignItems: 'center', gap: 10,
                                  padding: '4px 0',
                                  borderBottom: i < line.assets.length - 1 ? '1px solid #e2e8f0' : 'none',
                                }}
                              >
                                <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 12, flex: 1 }}>
                                  {asset.serialNumber}
                                </span>
                                <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#94a3b8' }}>
                                  {asset.partNumber ?? '—'}
                                </span>
                                <button
                                  className={css.btnIcon}
                                  style={{ color: '#dc2626', fontSize: 10, height: 20, width: 20 }}
                                  onClick={() => removeAsset(line.localId, asset.assetId)}
                                  title="Remove asset"
                                >
                                  ✕
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p style={{ fontSize: 12, color: '#94a3b8', margin: 0 }}>
                            No assets scanned — use the input above or camera to scan serial numbers
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {step2Error && <p className={css.formError} style={{ marginTop: 10 }}>{step2Error}</p>}

            <div style={{ marginTop: 20, display: 'flex', justifyContent: 'space-between' }}>
              <button className={css.btnGhost} onClick={() => setStep(1)}>← Back</button>
              <button
                className={css.btnAccent}
                onClick={() => { if (validateStep2()) setStep(3); }}
              >
                Review →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Step 3: Review & Post ── */}
      {step === 3 && (
        <div className={css.card}>
          <div className={css.cardHdr}><span className={css.cardTitle}>Review &amp; Post</span></div>
          <div className={css.cardBody}>
            {/* Header summary */}
            <div style={{
              background: '#f8fafc', borderRadius: 8,
              padding: 14, border: '1px solid #e2e8f0', marginBottom: 16,
            }}>
              <div style={{
                fontSize: 11, fontWeight: 700, color: '#64748b',
                textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 10,
              }}>
                Issue Header
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                <SF label="Warehouse"   value={warehouseName} />
                <SF label="Project"     value={projectName} />
                <SF label="Date"        value={issueDate} />
                <SF label="Destination Type" value={DEST_TYPE_LABELS[destType]} />
                <SF label="Destination" value={destLabel} />
                {notes && <SF label="Notes" value={notes} />}
              </div>
            </div>

            {/* Lines summary */}
            <div style={{
              fontSize: 11, fontWeight: 700, color: '#64748b',
              textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8,
            }}>
              Line Items ({lines.length})
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {lines.map(l => (
                <div
                  key={l.localId}
                  style={{ border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}
                >
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 12px', background: '#f8fafc',
                  }}>
                    <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 12 }}>{l.itemCode}</span>
                    <span style={{ fontSize: 12, color: '#64748b', flex: 1 }}>{l.itemName}</span>
                    <span
                      className={`${css.badge} ${l.trackingMethod === 'SERIALIZED' ? css.badgePurple : css.badgeBlue}`}
                      style={{ fontSize: 10 }}
                    >
                      {l.trackingMethod}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 700 }}>
                      Qty: {l.trackingMethod === 'SERIALIZED' ? l.assets.length : l.quantity}
                    </span>
                  </div>
                  {l.trackingMethod === 'SERIALIZED' && l.assets.length > 0 && (
                    <div style={{ padding: '6px 12px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {l.assets.map(a => (
                        <span
                          key={a.assetId}
                          style={{
                            fontFamily: 'monospace', fontSize: 11,
                            background: '#ede9fe', color: '#7c3aed',
                            borderRadius: 4, padding: '2px 6px',
                          }}
                        >
                          {a.serialNumber}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {postError && <p className={css.formError} style={{ marginTop: 12 }}>{postError}</p>}

            <div style={{ marginTop: 20, display: 'flex', justifyContent: 'space-between' }}>
              <button className={css.btnGhost} disabled={posting} onClick={() => setStep(2)}>
                ← Back to Edit
              </button>
              <button className={css.btnAccent} disabled={posting} onClick={postIssue}>
                {posting ? 'Posting…' : 'Post Goods Issue'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={`${css.toast} ${toast.ok ? css.toastOk : css.toastErr}`}>{toast.msg}</div>
      )}
    </div>
  );
}

// ── Small field component ─────────────────────────────────────────────────────

function SF({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>{value}</div>
    </div>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  );
}
