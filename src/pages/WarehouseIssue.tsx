import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { CameraScanner, UsbScanner, parseScan } from '../lib/warehouseScanner';
import {
  validateDestination,
  isDuplicateAsset,
  validateQuantityIssue,
  checkAssetItemMatch,
  computeAvailableQty,
  type DestinationType,
} from '../lib/goodsIssueHelpers';
import css from './Warehouse.module.css';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SiteSuggestion { id: string; siteCode: string; siteName: string; }

interface StockRow {
  itemId:         string;
  itemCode:       string;
  itemName:       string;
  trackingMethod: 'SERIALIZED' | 'QUANTITY';
  onHand:         number;
  reserved:       number;
  available:      number;
}

interface BrowseAsset {
  assetId:      string;
  serialNumber: string;
  partNumber:   string | null;
}

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
  quantity:       number;
  available:      number;
  assets:         ScannedAsset[];
}

interface DestOption { id: string; label: string; }

// ── Constants ─────────────────────────────────────────────────────────────────

const todayStr = () => new Date().toISOString().slice(0, 10);

const DEST_TYPE_LABELS: Record<DestinationType, string> = {
  SITE: 'Site', TEAM_MEMBER: 'Team Member', USER: 'User',
  VEHICLE: 'Vehicle', EXTERNAL: 'External', OTHER: 'Other',
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function WarehouseIssue() {
  const navigate = useNavigate();
  const { hasPerm, currentUser } = useAuth();

  // ── Wizard ────────────────────────────────────────────────────────────────
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // ── Step 1 — Header ───────────────────────────────────────────────────────
  const [warehouseId, setWarehouseId] = useState('');
  const [projectId,   setProjectId]   = useState('');
  const [issueDate,   setIssueDate]   = useState(todayStr());
  const [destType,    setDestType]    = useState<DestinationType>('SITE');
  const [destId,      setDestId]      = useState('');
  const [destLabel,   setDestLabel]   = useState('');
  const [notes,       setNotes]       = useState('');
  const [step1Error,  setStep1Error]  = useState('');

  // Site autocomplete
  const [siteQuery,       setSiteQuery]       = useState('');
  const [siteSuggestions, setSiteSuggestions] = useState<SiteSuggestion[]>([]);
  const [siteMatched,     setSiteMatched]     = useState(false);
  const [siteSearching,   setSiteSearching]   = useState(false);

  // ── Step 2 ────────────────────────────────────────────────────────────────
  const [availableStock, setAvailableStock] = useState<StockRow[]>([]);
  const [stockLoading,   setStockLoading]   = useState(false);
  const [stockSearch,    setStockSearch]    = useState('');
  const [lines,          setLines]          = useState<IssueLine[]>([]);
  const [qtyInputs,      setQtyInputs]      = useState<Record<string, number>>({});
  const [scanInput,      setScanInput]      = useState('');
  const [scanError,      setScanError]      = useState('');
  const [scanLoading,    setScanLoading]    = useState(false);
  const [cameraActive,   setCameraActive]   = useState(false);
  const [step2Error,     setStep2Error]     = useState('');

  // Browse modal
  const [browseItemId,   setBrowseItemId]   = useState<string | null>(null);
  const [browseAssets,   setBrowseAssets]   = useState<BrowseAsset[]>([]);
  const [browseLoading,  setBrowseLoading]  = useState(false);
  const [browseSearch,   setBrowseSearch]   = useState('');
  const [browseSelected, setBrowseSelected] = useState<Set<string>>(new Set());

  // ── Step 3 ────────────────────────────────────────────────────────────────
  const [posting,   setPosting]   = useState(false);
  const [postError, setPostError] = useState('');

  // ── Reference data ────────────────────────────────────────────────────────
  const [warehouses,  setWarehouses]  = useState<Array<{ id: string; name: string }>>([]);
  const [projects,    setProjects]    = useState<Array<{ id: string; display_name: string }>>([]);
  const [destOptions, setDestOptions] = useState<DestOption[]>([]);  // USER dropdown only

  const warehouseNameRef = useRef('');
  const projectNameRef   = useRef('');

  // ── Toast ─────────────────────────────────────────────────────────────────
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Scanner refs ──────────────────────────────────────────────────────────
  const videoRef      = useRef<HTMLVideoElement>(null);
  const cameraRef     = useRef<CameraScanner | null>(null);
  const scanInputRef  = useRef<HTMLInputElement>(null);
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

  // ── Destination options when type changes ─────────────────────────────────
  useEffect(() => {
    setDestId('');
    setDestLabel('');
    setDestOptions([]);
    setSiteQuery('');
    setSiteSuggestions([]);
    setSiteMatched(false);

    if (destType === 'USER') {
      supabase.from('users').select('id, full_name').order('full_name')
        .then(({ data }) => {
          if (data) setDestOptions(data.map(u => ({ id: u.id, label: u.full_name })));
        });
    }
  }, [destType]);

  // ── Site autocomplete search ──────────────────────────────────────────────
  useEffect(() => {
    if (destType !== 'SITE') return;
    const q = siteQuery.trim();
    if (!q) { setSiteSuggestions([]); return; }
    setSiteSearching(true);
    const timer = setTimeout(async () => {
      const { data } = await supabase
        .from('sites')
        .select('id, site_code, site_name')
        .or(`site_code.ilike.%${q}%,site_name.ilike.%${q}%`)
        .order('site_code')
        .limit(8);
      setSiteSuggestions(
        data?.map(s => ({ id: s.id, siteCode: s.site_code, siteName: s.site_name ?? '' })) ?? [],
      );
      setSiteSearching(false);
    }, 300);
    return () => { clearTimeout(timer); setSiteSearching(false); };
  }, [siteQuery, destType]);

  // ── Load available stock when entering step 2 ─────────────────────────────
  useEffect(() => {
    if (step !== 2 || !warehouseId || !projectId) return;
    let cancelled = false;
    setStockLoading(true);
    setAvailableStock([]);

    (async () => {
      const { data: balances } = await supabase
        .from('stock_balances')
        .select('inventory_item_id, quantity_on_hand, quantity_reserved, inventory_items(id, item_code, item_name, tracking_method)')
        .eq('warehouse_id', warehouseId)
        .eq('project_id', projectId);

      if (cancelled) return;

      const rows: StockRow[] = [];
      for (const b of balances ?? []) {
        const item = b.inventory_items as unknown as {
          id: string; item_code: string; item_name: string; tracking_method: string;
        } | null;
        if (!item) continue;
        const available = computeAvailableQty(b.quantity_on_hand, b.quantity_reserved);
        if (available <= 0) continue;
        rows.push({
          itemId:         item.id,
          itemCode:       item.item_code,
          itemName:       item.item_name,
          trackingMethod: item.tracking_method as 'SERIALIZED' | 'QUANTITY',
          onHand:         b.quantity_on_hand,
          reserved:       b.quantity_reserved,
          available,
        });
      }
      rows.sort((a, b) => a.itemCode.localeCompare(b.itemCode));
      setAvailableStock(rows);

      // Init qty inputs to 1 for any QUANTITY row not already set
      setQtyInputs(prev => {
        const next = { ...prev };
        for (const r of rows) {
          if (r.trackingMethod === 'QUANTITY' && !(r.itemId in next)) next[r.itemId] = 1;
        }
        return next;
      });

      setStockLoading(false);
    })();

    return () => { cancelled = true; };
  }, [step, warehouseId, projectId]);

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

  // ── USB scanner — active while on step 2 ─────────────────────────────────
  useEffect(() => {
    if (step !== 2) return;
    const usb = new UsbScanner(document.body, { onScan: raw => handleScanRef.current?.(raw) });
    usb.attach();
    return () => usb.detach();
  }, [step]);

  // ── Scan handler (always latest via ref) ─────────────────────────────────
  handleScanRef.current = async (raw: string) => {
    setScanError('');
    setScanLoading(true);
    try {
      const parsed = parseScan(raw.trim(), 'MANUAL');
      const sn     = parsed.serialNumber ?? raw.trim();
      if (!sn) { setScanError('Could not extract serial number from scan'); return; }
      const snNorm = sn.trim().toUpperCase();

      const allAssetIds = lines.flatMap(l => l.assets.map(a => a.assetId));

      const { data: asset, error: dbErr } = await supabase
        .from('inventory_assets')
        .select('id, serial_number, part_number, status, warehouse_id, project_id, inventory_item_id')
        .eq('serial_number_normalized', snNorm)
        .maybeSingle();

      if (dbErr)   { setScanError(dbErr.message); return; }
      if (!asset)  { setScanError(`Asset not found in inventory: ${sn}`); return; }

      if (isDuplicateAsset(allAssetIds, asset.id)) {
        setScanError(`${sn}: already added to this Goods Issue`);
        return;
      }

      // Contextual project/warehouse errors
      if (asset.project_id !== projectId) {
        const projName = projects.find(p => p.id === asset.project_id)?.display_name ?? 'another project';
        setScanError(`${sn}: Asset belongs to ${projName}`);
        return;
      }
      if (asset.warehouse_id !== warehouseId) {
        const wrhName = warehouses.find(w => w.id === asset.warehouse_id)?.name ?? 'another warehouse';
        setScanError(`${sn}: Asset is currently in ${wrhName}`);
        return;
      }
      if (asset.status !== 'IN_STOCK') {
        setScanError(`${sn}: Asset is already ${asset.status}`);
        return;
      }

      // Validate item is in available stock
      const stockRow = availableStock.find(r => r.itemId === asset.inventory_item_id);
      if (!stockRow) {
        setScanError(`${sn}: Item not in available stock for this warehouse / project`);
        return;
      }

      // checkAssetItemMatch is implicit here — the stockRow is keyed by the asset's own item
      const itemMatchErr = checkAssetItemMatch(asset.inventory_item_id, stockRow.itemId);
      if (itemMatchErr) { setScanError(`${sn}: ${itemMatchErr}`); return; }

      const newAsset: ScannedAsset = {
        assetId:      asset.id,
        serialNumber: asset.serial_number,
        partNumber:   asset.part_number,
      };

      setLines(prev => {
        const existing = prev.find(l => l.itemId === asset.inventory_item_id);
        if (existing) {
          return prev.map(l => {
            if (l.itemId !== asset.inventory_item_id) return l;
            const assets = [...l.assets, newAsset];
            return { ...l, assets, quantity: assets.length };
          });
        }
        return [...prev, {
          localId:        crypto.randomUUID(),
          itemId:         stockRow.itemId,
          itemCode:       stockRow.itemCode,
          itemName:       stockRow.itemName,
          trackingMethod: 'SERIALIZED',
          quantity:       1,
          available:      stockRow.available,
          assets:         [newAsset],
        }];
      });

      setScanInput('');
      setScanError('');
    } finally {
      setScanLoading(false);
    }
  };

  // ── QUANTITY item: add / update ───────────────────────────────────────────
  function addQtyItem(itemId: string) {
    const row = availableStock.find(r => r.itemId === itemId);
    if (!row) return;
    const qty = qtyInputs[itemId] ?? 1;
    const err = validateQuantityIssue(qty, row.available);
    if (err) { setScanError(err); return; }

    setLines(prev => {
      const existing = prev.find(l => l.itemId === itemId);
      if (existing) {
        return prev.map(l => l.itemId !== itemId ? l : { ...l, quantity: qty });
      }
      return [...prev, {
        localId: crypto.randomUUID(),
        itemId:  row.itemId,
        itemCode: row.itemCode,
        itemName: row.itemName,
        trackingMethod: 'QUANTITY',
        quantity: qty,
        available: row.available,
        assets: [],
      }];
    });
    setScanError('');
  }

  // ── Browse modal: open ────────────────────────────────────────────────────
  async function openBrowse(itemId: string) {
    const existingAssets = lines.find(l => l.itemId === itemId)?.assets ?? [];
    setBrowseSelected(new Set(existingAssets.map(a => a.assetId)));
    setBrowseItemId(itemId);
    setBrowseLoading(true);
    setBrowseSearch('');
    setBrowseAssets([]);

    const { data } = await supabase
      .from('inventory_assets')
      .select('id, serial_number, part_number')
      .eq('status', 'IN_STOCK')
      .eq('warehouse_id', warehouseId)
      .eq('project_id', projectId)
      .eq('inventory_item_id', itemId)
      .order('serial_number');

    setBrowseAssets(
      data?.map(a => ({ assetId: a.id, serialNumber: a.serial_number, partNumber: a.part_number })) ?? [],
    );
    setBrowseLoading(false);
  }

  // ── Browse modal: confirm ─────────────────────────────────────────────────
  function confirmBrowse() {
    const stockRow = availableStock.find(r => r.itemId === browseItemId);
    if (!stockRow || !browseItemId) { setBrowseItemId(null); return; }

    const selected = browseAssets.filter(a => browseSelected.has(a.assetId));

    setLines(prev => {
      if (selected.length === 0) return prev.filter(l => l.itemId !== browseItemId);
      const existing = prev.find(l => l.itemId === browseItemId);
      if (existing) {
        return prev.map(l => l.itemId !== browseItemId ? l : {
          ...l, assets: selected, quantity: selected.length,
        });
      }
      return [...prev, {
        localId:        crypto.randomUUID(),
        itemId:         stockRow.itemId,
        itemCode:       stockRow.itemCode,
        itemName:       stockRow.itemName,
        trackingMethod: 'SERIALIZED',
        quantity:       selected.length,
        available:      stockRow.available,
        assets:         selected,
      }];
    });

    setBrowseItemId(null);
  }

  // ── Remove ────────────────────────────────────────────────────────────────
  function removeLine(localId: string) {
    setLines(prev => prev.filter(l => l.localId !== localId));
  }

  function removeAsset(lineItemId: string, assetId: string) {
    setLines(prev => prev.map(l => {
      if (l.itemId !== lineItemId) return l;
      const assets = l.assets.filter(a => a.assetId !== assetId);
      return { ...l, assets, quantity: assets.length };
    }));
  }

  // ── Validation ────────────────────────────────────────────────────────────
  function validateStep1(): boolean {
    if (!warehouseId) { setStep1Error('Select a warehouse'); return false; }
    if (!projectId)   { setStep1Error('Select a project'); return false; }
    if (!issueDate)   { setStep1Error('Enter an issue date'); return false; }
    const err = validateDestination(destType, destId || null, destLabel);
    if (err) { setStep1Error(err); return false; }
    setStep1Error('');
    warehouseNameRef.current = warehouses.find(w => w.id === warehouseId)?.name ?? warehouseId;
    projectNameRef.current   = projects.find(p => p.id === projectId)?.display_name ?? projectId;
    return true;
  }

  function validateStep2(): boolean {
    if (lines.length === 0) { setStep2Error('Select at least one item to issue'); return false; }
    for (const l of lines) {
      if (l.trackingMethod === 'QUANTITY') {
        const err = validateQuantityIssue(l.quantity, l.available);
        if (err) { setStep2Error(`${l.itemCode}: ${err}`); return false; }
      } else {
        if (l.assets.length === 0) {
          setStep2Error(`${l.itemCode}: no assets selected — scan or use View Assets`);
          return false;
        }
      }
    }
    setStep2Error('');
    return true;
  }

  // ── Post ──────────────────────────────────────────────────────────────────
  async function postIssue() {
    if (!currentUser) return;
    setPosting(true);
    setPostError('');
    try {
      const { data: issueRow, error: issueErr } = await supabase
        .from('goods_issues')
        .insert({
          warehouse_id:      warehouseId,
          project_id:        projectId,
          issue_date:        issueDate,
          destination_type:  destType,
          destination_id:    destId || null,
          destination_label: destLabel,
          notes:             notes.trim() || null,
          status:            'DRAFT',
          issued_by:         currentUser.id,
        })
        .select('id, issue_number')
        .single();

      if (issueErr) throw new Error(issueErr.message);
      const issueId = issueRow.id;

      const lineResults: Array<{ itemRowId: string; line: IssueLine }> = [];
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
        lineResults.push({ itemRowId: itemRow.id, line: l });
      }

      for (const { itemRowId, line } of lineResults) {
        if (line.trackingMethod !== 'SERIALIZED') continue;
        for (const asset of line.assets) {
          const { error: assetErr } = await supabase
            .from('goods_issue_assets')
            .insert({ goods_issue_id: issueId, goods_issue_item_id: itemRowId, inventory_asset_id: asset.assetId });
          if (assetErr) throw new Error(assetErr.message);
        }
      }

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

  // ── Derived values ────────────────────────────────────────────────────────
  const warehouseName = warehouses.find(w => w.id === warehouseId)?.name ?? '—';
  const projectName   = projects.find(p => p.id === projectId)?.display_name ?? '—';

  const totalSerialAvail = availableStock
    .filter(r => r.trackingMethod === 'SERIALIZED').reduce((s, r) => s + r.available, 0);
  const totalQtyAvail = availableStock
    .filter(r => r.trackingMethod === 'QUANTITY').reduce((s, r) => s + r.available, 0);

  const totalSelTypes    = lines.length;
  const totalSelSerial   = lines.filter(l => l.trackingMethod === 'SERIALIZED').reduce((s, l) => s + l.assets.length, 0);
  const totalSelQty      = lines.filter(l => l.trackingMethod === 'QUANTITY').reduce((s, l) => s + l.quantity, 0);

  const filteredStock = availableStock.filter(r => {
    const q = stockSearch.trim().toLowerCase();
    if (!q) return true;
    return r.itemCode.toLowerCase().includes(q) || r.itemName.toLowerCase().includes(q);
  });

  const browseRow = availableStock.find(r => r.itemId === browseItemId);
  const filteredBrowseAssets = browseAssets.filter(a => {
    const q = browseSearch.trim().toLowerCase();
    if (!q) return true;
    return a.serialNumber.toLowerCase().includes(q) || (a.partNumber ?? '').toLowerCase().includes(q);
  });

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={css.page}>

      {/* Browse modal */}
      {browseItemId && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 200,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
          }}
          onClick={() => setBrowseItemId(null)}
        >
          <div
            style={{
              background: '#fff', borderRadius: 12, width: '100%', maxWidth: 560,
              maxHeight: '80vh', display: 'flex', flexDirection: 'column', overflow: 'hidden',
            }}
            onClick={e => e.stopPropagation()}
          >
            {/* Modal header */}
            <div style={{ padding: '14px 18px', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{browseRow?.itemCode} — {browseRow?.itemName}</div>
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                  {browseSelected.size} selected · {browseRow?.available ?? 0} available
                </div>
              </div>
              <button className={css.btnIcon} onClick={() => setBrowseItemId(null)}>✕</button>
            </div>

            {/* Search */}
            <div style={{ padding: '10px 18px', borderBottom: '1px solid #f1f5f9' }}>
              <div className={css.searchWrap}>
                <SearchIcon className={css.searchIcon} />
                <input
                  className={css.searchInput}
                  placeholder="Search by SN or PN…"
                  value={browseSearch}
                  onChange={e => setBrowseSearch(e.target.value)}
                  autoFocus
                />
              </div>
            </div>

            {/* Asset list */}
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {browseLoading ? (
                <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>Loading assets…</div>
              ) : filteredBrowseAssets.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
                  {browseSearch ? 'No assets match search' : 'No IN_STOCK assets for this item in this warehouse/project'}
                </div>
              ) : (
                filteredBrowseAssets.map(a => {
                  const checked = browseSelected.has(a.assetId);
                  return (
                    <label
                      key={a.assetId}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12, padding: '10px 18px',
                        borderBottom: '1px solid #f8fafc', cursor: 'pointer',
                        background: checked ? '#f0fdf4' : '#fff',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setBrowseSelected(prev => {
                            const next = new Set(prev);
                            if (next.has(a.assetId)) next.delete(a.assetId);
                            else next.add(a.assetId);
                            return next;
                          });
                        }}
                        style={{ width: 16, height: 16, flexShrink: 0, accentColor: '#16a34a' }}
                      />
                      <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 12, flex: 1 }}>
                        {a.serialNumber}
                      </span>
                      <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#94a3b8' }}>
                        {a.partNumber ?? '—'}
                      </span>
                    </label>
                  );
                })
              )}
            </div>

            {/* Footer */}
            <div style={{ padding: '12px 18px', borderTop: '1px solid #e2e8f0', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className={css.btnGhost} onClick={() => setBrowseItemId(null)}>Cancel</button>
              <button className={css.btnAccent} onClick={confirmBrowse}>
                Confirm {browseSelected.size > 0 ? `(${browseSelected.size})` : ''}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Page header */}
      <div className={css.pageHdr}>
        <div>
          <h1 className={css.pageTitle}>New Goods Issue</h1>
          <p className={css.pageSubtitle}>Issue materials from warehouse stock</p>
        </div>
      </div>

      {/* Wizard step indicator */}
      <div className={css.wizardSteps} style={{ marginBottom: 20 }}>
        {([
          [1, 'Issue Details'],
          [2, 'Items & Assets'],
          [3, 'Review & Post'],
        ] as [number, string][]).map(([n, label], i, arr) => (
          <>
            <div key={n} className={`${css.wizardStep} ${step >= n ? (step > n ? css.done : css.active) : ''}`}>
              <div className={css.stepNum}>{step > n ? '✓' : n}</div>
              <span>{label}</span>
            </div>
            {i < arr.length - 1 && (
              <div key={`line-${n}`} className={`${css.stepLine} ${step > n ? css.stepLineDone : ''}`} />
            )}
          </>
        ))}
      </div>

      {/* ── STEP 1 ──────────────────────────────────────────────────────────── */}
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
                  onChange={e => { setWarehouseId(e.target.value); setLines([]); setQtyInputs({}); }}
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
                  onChange={e => { setProjectId(e.target.value); setLines([]); setQtyInputs({}); }}
                >
                  <option value="">Select project…</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.display_name}</option>)}
                </select>
              </div>
            </div>

            <div className={css.fieldRow} style={{ marginTop: 14 }}>
              <div>
                <div className={css.label}>Issue Date *</div>
                <input
                  type="date"
                  className={css.input}
                  value={issueDate}
                  onChange={e => setIssueDate(e.target.value)}
                />
              </div>
              <div>
                <div className={css.label}>Destination Type *</div>
                <select
                  className={css.fieldSelect}
                  value={destType}
                  onChange={e => setDestType(e.target.value as DestinationType)}
                >
                  {(Object.entries(DEST_TYPE_LABELS) as [DestinationType, string][]).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* ── SITE: free-text with autocomplete ── */}
            {destType === 'SITE' && (
              <div style={{ marginTop: 14, position: 'relative' }}>
                <div className={css.label}>Site *</div>
                <div className={css.searchWrap}>
                  <SearchIcon className={css.searchIcon} />
                  <input
                    className={css.searchInput}
                    placeholder="Type site ID or name…"
                    value={siteQuery}
                    onChange={e => {
                      const val = e.target.value;
                      setSiteQuery(val);
                      setDestLabel(val);
                      setDestId('');
                      setSiteMatched(false);
                    }}
                    onBlur={() => setTimeout(() => setSiteSuggestions([]), 200)}
                  />
                </div>
                {siteSuggestions.length > 0 && (
                  <div style={{
                    position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
                    border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff',
                    boxShadow: '0 4px 12px rgba(0,0,0,.08)', overflow: 'hidden', marginTop: 2,
                  }}>
                    {siteSuggestions.map(s => (
                      <div
                        key={s.id}
                        style={{ padding: '9px 14px', cursor: 'pointer', borderBottom: '1px solid #f1f5f9' }}
                        onMouseDown={() => {
                          const label = `${s.siteCode} — ${s.siteName}`;
                          setSiteQuery(label);
                          setDestLabel(label);
                          setDestId(s.id);
                          setSiteMatched(true);
                          setSiteSuggestions([]);
                        }}
                      >
                        <div style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 12 }}>
                          {s.siteCode} — {s.siteName}
                        </div>
                        <div style={{ fontSize: 11, color: '#16a34a', marginTop: 1 }}>Found in Sites DB</div>
                      </div>
                    ))}
                  </div>
                )}
                {siteMatched && (
                  <p style={{ fontSize: 11, color: '#16a34a', marginTop: 4 }}>✓ Matched in Sites DB</p>
                )}
                {siteQuery && !siteMatched && !siteSuggestions.length && !siteSearching && (
                  <p style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                    Site not found in Sites DB — it will be saved as entered
                  </p>
                )}
              </div>
            )}

            {/* ── USER: dropdown ── */}
            {destType === 'USER' && (
              <div style={{ marginTop: 14 }}>
                <div className={css.label}>User *</div>
                <select
                  className={css.fieldSelect}
                  value={destId}
                  onChange={e => {
                    const opt = destOptions.find(o => o.id === e.target.value);
                    setDestId(e.target.value);
                    setDestLabel(opt?.label ?? '');
                  }}
                >
                  <option value="">Select user…</option>
                  {destOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
              </div>
            )}

            {/* ── TEAM_MEMBER / VEHICLE / EXTERNAL / OTHER: free text ── */}
            {(destType === 'TEAM_MEMBER' || destType === 'VEHICLE' || destType === 'EXTERNAL' || destType === 'OTHER') && (
              <div style={{ marginTop: 14 }}>
                <div className={css.label}>{DEST_TYPE_LABELS[destType]} *</div>
                <input
                  className={css.input}
                  placeholder={`Enter ${DEST_TYPE_LABELS[destType].toLowerCase()} name…`}
                  value={destLabel}
                  onChange={e => setDestLabel(e.target.value)}
                />
              </div>
            )}

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
              <button className={css.btnAccent} onClick={() => { if (validateStep1()) setStep(2); }}>
                Next: Add Items →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── STEP 2 ──────────────────────────────────────────────────────────── */}
      {step === 2 && (
        <div className={css.card}>
          {/* Context header */}
          <div className={css.cardHdr}>
            <span className={css.cardTitle}>Items &amp; Assets</span>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>
                {warehouseName} · {projectName}
              </div>
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                {availableStock.length} item type{availableStock.length !== 1 ? 's' : ''}
                {totalSerialAvail > 0 && ` · ${totalSerialAvail} serialized`}
                {totalQtyAvail > 0 && ` · ${totalQtyAvail} units`}
                {' '}available
              </div>
            </div>
          </div>

          <div className={css.cardBody}>

            {/* ── Scanner controls ── */}
            <div style={{
              background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8,
              padding: '12px 14px', marginBottom: 14,
            }}>
              <div style={{
                fontSize: 11, fontWeight: 700, color: '#64748b',
                textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8,
              }}>
                Scan Serial Number
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <div className={css.searchWrap} style={{ flex: 1, minWidth: 180 }}>
                  <SearchIcon className={css.searchIcon} />
                  <input
                    ref={scanInputRef}
                    className={css.searchInput}
                    placeholder="Type or scan SN, then Enter…"
                    value={scanInput}
                    onChange={e => setScanInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && scanInput.trim()) {
                        handleScanRef.current?.(scanInput.trim());
                        setScanInput('');
                      }
                    }}
                    disabled={scanLoading}
                  />
                </div>
                <button
                  className={css.btnGhost}
                  style={{ whiteSpace: 'nowrap' }}
                  disabled={scanLoading || !scanInput.trim()}
                  onClick={() => {
                    if (scanInput.trim()) { handleScanRef.current?.(scanInput.trim()); setScanInput(''); }
                  }}
                >
                  Add SN
                </button>
                <button
                  className={css.btnGhost}
                  style={{ whiteSpace: 'nowrap' }}
                  onClick={() => { setCameraActive(v => !v); setScanError(''); }}
                >
                  {cameraActive ? '■ Stop Camera' : '📷 Camera'}
                </button>
              </div>

              {cameraActive && (
                <div style={{ marginTop: 10, borderRadius: 8, overflow: 'hidden', background: '#000', maxHeight: 220 }}>
                  <video ref={videoRef} style={{ width: '100%', maxHeight: 220, display: 'block' }} autoPlay playsInline muted />
                </div>
              )}

              {scanLoading && (
                <p style={{ fontSize: 12, color: '#94a3b8', margin: '8px 0 0' }}>Looking up asset…</p>
              )}
              {scanError && (
                <p className={css.formError} style={{ margin: '8px 0 0' }}>{scanError}</p>
              )}
              {!scanLoading && !scanError && (
                <p style={{ fontSize: 11, color: '#94a3b8', margin: '8px 0 0' }}>
                  USB scanner auto-detected · Scanned asset is routed to the correct item automatically
                </p>
              )}
            </div>

            {/* ── Available Stock table ── */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.5px', flex: 1 }}>
                  Available Stock
                </div>
                <div className={css.searchWrap} style={{ maxWidth: 220 }}>
                  <SearchIcon className={css.searchIcon} />
                  <input
                    className={css.searchInput}
                    placeholder="Filter items…"
                    value={stockSearch}
                    onChange={e => setStockSearch(e.target.value)}
                  />
                </div>
              </div>

              {stockLoading ? (
                <div className={css.emptyState} style={{ padding: 24 }}>
                  <div className={css.emptyMsg}>Loading available stock…</div>
                </div>
              ) : filteredStock.length === 0 ? (
                <div className={css.emptyState} style={{ padding: 24 }}>
                  <div className={css.emptyMsg}>
                    {stockSearch ? 'No items match filter' : 'No available stock for this warehouse / project'}
                  </div>
                </div>
              ) : (
                <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
                  {/* Table header */}
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: '90px 1fr 100px 56px 56px 56px auto',
                    gap: 8, padding: '7px 12px',
                    background: '#f1f5f9', borderBottom: '1px solid #e2e8f0',
                    fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.5px',
                  }}>
                    <span>Code</span>
                    <span>Name</span>
                    <span>Tracking</span>
                    <span style={{ textAlign: 'right' }}>On Hand</span>
                    <span style={{ textAlign: 'right' }}>Reserved</span>
                    <span style={{ textAlign: 'right' }}>Avail</span>
                    <span>Action</span>
                  </div>

                  {filteredStock.map((row, i) => {
                    const lineForRow = lines.find(l => l.itemId === row.itemId);
                    const isSerialized = row.trackingMethod === 'SERIALIZED';
                    const selectedCount = lineForRow?.assets.length ?? 0;
                    const currentQty = qtyInputs[row.itemId] ?? 1;

                    return (
                      <div
                        key={row.itemId}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '90px 1fr 100px 56px 56px 56px auto',
                          gap: 8, padding: '9px 12px', alignItems: 'center',
                          borderBottom: i < filteredStock.length - 1 ? '1px solid #f1f5f9' : 'none',
                          background: lineForRow ? '#f0fdf4' : '#fff',
                        }}
                      >
                        <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 11 }}>{row.itemCode}</span>
                        <span style={{ fontSize: 12, color: '#475569' }}>{row.itemName}</span>
                        <span>
                          <span
                            className={`${css.badge} ${isSerialized ? css.badgePurple : css.badgeBlue}`}
                            style={{ fontSize: 9 }}
                          >
                            {row.trackingMethod}
                          </span>
                        </span>
                        <span style={{ textAlign: 'right', fontSize: 12 }}>{row.onHand}</span>
                        <span style={{ textAlign: 'right', fontSize: 12, color: row.reserved > 0 ? '#dc2626' : '#94a3b8' }}>
                          {row.reserved}
                        </span>
                        <span style={{ textAlign: 'right', fontSize: 12, fontWeight: 700, color: '#16a34a' }}>
                          {row.available}
                        </span>

                        {/* Action cell */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {isSerialized ? (
                            <button
                              className={css.btnGhost}
                              style={{ fontSize: 11, height: 28, whiteSpace: 'nowrap' }}
                              onClick={() => openBrowse(row.itemId)}
                            >
                              {selectedCount > 0 ? `View Assets (${selectedCount})` : 'View Assets'}
                            </button>
                          ) : (
                            <>
                              <button
                                className={css.btnIcon}
                                style={{ width: 24, height: 24, fontSize: 14, lineHeight: 1 }}
                                onClick={() => setQtyInputs(p => ({
                                  ...p, [row.itemId]: Math.max(1, (p[row.itemId] ?? 1) - 1),
                                }))}
                              >−</button>
                              <input
                                type="number"
                                className={css.input}
                                style={{ width: 56, textAlign: 'center', height: 28, fontSize: 12 }}
                                min={1}
                                max={row.available}
                                value={currentQty}
                                onChange={e => {
                                  const v = parseInt(e.target.value, 10);
                                  if (!isNaN(v)) setQtyInputs(p => ({
                                    ...p, [row.itemId]: Math.min(row.available, Math.max(1, v)),
                                  }));
                                }}
                              />
                              <button
                                className={css.btnIcon}
                                style={{ width: 24, height: 24, fontSize: 14, lineHeight: 1 }}
                                onClick={() => setQtyInputs(p => ({
                                  ...p, [row.itemId]: Math.min(row.available, (p[row.itemId] ?? 1) + 1),
                                }))}
                              >+</button>
                              <button
                                className={`${css.btnGhost} ${lineForRow ? css.btnAccent : ''}`}
                                style={{ fontSize: 11, height: 28, whiteSpace: 'nowrap' }}
                                onClick={() => addQtyItem(row.itemId)}
                              >
                                {lineForRow ? 'Update' : 'Add'}
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* ── Selected for Issue ── */}
            {lines.length > 0 && (
              <div style={{ marginTop: 4 }}>
                <div style={{
                  fontSize: 11, fontWeight: 700, color: '#64748b',
                  textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8,
                  display: 'flex', alignItems: 'center', gap: 8,
                }}>
                  <span>Selected for Issue</span>
                  <span style={{
                    background: '#16a34a', color: '#fff', borderRadius: 12,
                    padding: '1px 8px', fontSize: 10, fontWeight: 700,
                  }}>
                    {totalSelTypes} type{totalSelTypes !== 1 ? 's' : ''}
                    {totalSelSerial > 0 && ` · ${totalSelSerial} assets`}
                    {totalSelQty > 0 && ` · ${totalSelQty} units`}
                  </span>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {lines.map(l => (
                    <div
                      key={l.localId}
                      style={{ border: '1px solid #bbf7d0', borderRadius: 8, overflow: 'hidden', background: '#f0fdf4' }}
                    >
                      {/* Line header */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px' }}>
                        <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 12 }}>{l.itemCode}</span>
                        <span style={{ fontSize: 12, color: '#475569', flex: 1 }}>{l.itemName}</span>
                        <span
                          className={`${css.badge} ${l.trackingMethod === 'SERIALIZED' ? css.badgePurple : css.badgeBlue}`}
                          style={{ fontSize: 9 }}
                        >
                          {l.trackingMethod}
                        </span>
                        <span style={{ fontSize: 12, fontWeight: 700, color: '#16a34a' }}>
                          {l.trackingMethod === 'SERIALIZED' ? `${l.assets.length} asset${l.assets.length !== 1 ? 's' : ''}` : `Qty: ${l.quantity}`}
                        </span>
                        <button
                          className={css.btnIcon}
                          style={{ color: '#dc2626' }}
                          onClick={() => removeLine(l.localId)}
                          title="Remove"
                        >✕</button>
                      </div>

                      {/* SERIALIZED: asset chips */}
                      {l.trackingMethod === 'SERIALIZED' && l.assets.length > 0 && (
                        <div style={{ padding: '6px 12px 10px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {l.assets.map(a => (
                            <span
                              key={a.assetId}
                              style={{
                                display: 'inline-flex', alignItems: 'center', gap: 5,
                                fontFamily: 'monospace', fontSize: 11,
                                background: '#dcfce7', color: '#166534',
                                borderRadius: 4, padding: '2px 4px 2px 7px', border: '1px solid #bbf7d0',
                              }}
                            >
                              {a.serialNumber}
                              <button
                                onClick={() => removeAsset(l.itemId, a.assetId)}
                                style={{
                                  background: 'none', border: 'none', cursor: 'pointer',
                                  color: '#dc2626', fontSize: 10, padding: 0, lineHeight: 1,
                                }}
                                title="Remove asset"
                              >✕</button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {step2Error && <p className={css.formError} style={{ marginTop: 10 }}>{step2Error}</p>}

            <div style={{ marginTop: 20, display: 'flex', justifyContent: 'space-between' }}>
              <button className={css.btnGhost} onClick={() => setStep(1)}>← Back</button>
              <button className={css.btnAccent} onClick={() => { if (validateStep2()) setStep(3); }}>
                Review →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── STEP 3 ──────────────────────────────────────────────────────────── */}
      {step === 3 && (
        <div className={css.card}>
          <div className={css.cardHdr}><span className={css.cardTitle}>Review &amp; Post</span></div>
          <div className={css.cardBody}>
            <div style={{ background: '#f8fafc', borderRadius: 8, padding: 14, border: '1px solid #e2e8f0', marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 10 }}>
                Issue Header
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                <SF label="Warehouse"        value={warehouseNameRef.current || warehouseName} />
                <SF label="Project"          value={projectNameRef.current   || projectName} />
                <SF label="Date"             value={issueDate} />
                <SF label="Destination Type" value={DEST_TYPE_LABELS[destType]} />
                <SF label="Destination"      value={destLabel} />
                {notes && <SF label="Notes"  value={notes} />}
              </div>
            </div>

            <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8 }}>
              Line Items ({lines.length})
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {lines.map(l => (
                <div key={l.localId} style={{ border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: '#f8fafc' }}>
                    <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 12 }}>{l.itemCode}</span>
                    <span style={{ fontSize: 12, color: '#64748b', flex: 1 }}>{l.itemName}</span>
                    <span className={`${css.badge} ${l.trackingMethod === 'SERIALIZED' ? css.badgePurple : css.badgeBlue}`} style={{ fontSize: 10 }}>
                      {l.trackingMethod}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 700 }}>
                      {l.trackingMethod === 'SERIALIZED' ? `${l.assets.length} asset${l.assets.length !== 1 ? 's' : ''}` : `Qty: ${l.quantity}`}
                    </span>
                  </div>
                  {l.trackingMethod === 'SERIALIZED' && l.assets.length > 0 && (
                    <div style={{ padding: '6px 12px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {l.assets.map(a => (
                        <span key={a.assetId} style={{ fontFamily: 'monospace', fontSize: 11, background: '#ede9fe', color: '#7c3aed', borderRadius: 4, padding: '2px 6px' }}>
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
              <button className={css.btnGhost} disabled={posting} onClick={() => setStep(2)}>← Back to Edit</button>
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

// ── Utilities ─────────────────────────────────────────────────────────────────

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
