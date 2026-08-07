import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import {
  computeAvailable,
  matchesStockFilter,
  matchesStockSearch,
  type StockRow,
  type StockStateFilter,
} from '../lib/warehouseStock';
import css from './Warehouse.module.css';

interface AssetDetail {
  id: string;
  serial_number: string;
  part_number: string | null;
  status: string;
  source_receipt_id: string | null;
  created_at: string;
  receiptNumber?: string;
}

interface DrilldownState {
  row: StockRow;
  assets: AssetDetail[];
  loading: boolean;
}

export default function WarehouseStock() {
  const { hasPerm } = useAuth();

  const [allRows,           setAllRows]           = useState<StockRow[]>([]);
  const [loading,           setLoading]           = useState(true);
  const [error,             setError]             = useState('');
  const [serializedInStock, setSerializedInStock] = useState(0);

  const [search,        setSearch]        = useState('');
  const [wrhFilter,     setWrhFilter]     = useState('');
  const [trackFilter,   setTrackFilter]   = useState('');
  const [stockFilter,   setStockFilter]   = useState<StockStateFilter>('in_stock');
  const [showZeroStock, setShowZeroStock] = useState(false);

  const [drilldown, setDrilldown] = useState<DrilldownState | null>(null);

  const wrhNamesRef = useRef<Record<string, string>>({});

  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!hasPerm('view_warehouse_stock')) return <div className={css.denied}>Access denied.</div>;

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  async function load() {
    setLoading(true);
    setError('');
    try {
      const [balRes, itemRes, wrhRes, assetCountRes] = await Promise.all([
        supabase.from('stock_balances').select('*'),
        supabase.from('inventory_items').select('id, item_code, item_name, tracking_method').eq('is_active', true),
        supabase.from('warehouses').select('id, name').eq('is_active', true).order('name'),
        supabase.from('inventory_assets').select('id', { count: 'exact', head: true }).eq('status', 'IN_STOCK'),
      ]);

      if (balRes.error)  { setError(balRes.error.message);  setLoading(false); return; }
      if (itemRes.error) { setError(itemRes.error.message); setLoading(false); return; }
      if (wrhRes.error)  { setError(wrhRes.error.message);  setLoading(false); return; }

      setSerializedInStock(assetCountRes.count ?? 0);

      const itemMap = new Map((itemRes.data || []).map(i => [i.id, i]));
      const wrhMap  = new Map((wrhRes.data  || []).map(w => [w.id, w.name]));
      wrhNamesRef.current = Object.fromEntries(wrhMap);

      const rows: StockRow[] = (balRes.data || []).flatMap(b => {
        const item = itemMap.get(b.inventory_item_id);
        if (!item) return [];
        return [{
          balanceId:      b.id,
          itemId:         item.id,
          itemCode:       item.item_code,
          itemName:       item.item_name,
          trackingMethod: item.tracking_method as 'SERIALIZED' | 'QUANTITY',
          warehouseId:    b.warehouse_id,
          warehouseName:  wrhMap.get(b.warehouse_id) || '—',
          onHand:         b.quantity_on_hand   ?? 0,
          reserved:       b.quantity_reserved  ?? 0,
          available:      computeAvailable(b.quantity_on_hand ?? 0, b.quantity_reserved ?? 0),
          updatedAt:      b.updated_at ?? null,
        }];
      });

      // Zero-stock rows: active items with no balance entry in any warehouse
      const itemsWithBalance = new Set((balRes.data || []).map(b => b.inventory_item_id));
      for (const [id, item] of itemMap) {
        if (!itemsWithBalance.has(id)) {
          rows.push({
            balanceId:      null,
            itemId:         item.id,
            itemCode:       item.item_code,
            itemName:       item.item_name,
            trackingMethod: item.tracking_method as 'SERIALIZED' | 'QUANTITY',
            warehouseId:    '',
            warehouseName:  '—',
            onHand:         0,
            reserved:       0,
            available:      0,
            updatedAt:      null,
          });
        }
      }

      setAllRows(rows);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setError(msg);
      showToast(msg, false);
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  const warehousesWithStock = new Set(allRows.filter(r => r.onHand > 0).map(r => r.warehouseId));

  const uniqueWarehouses = [...new Set(allRows.filter(r => r.warehouseId).map(r => r.warehouseId))]
    .map(id => ({ id, name: wrhNamesRef.current[id] || id }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const totalOnHand   = allRows.reduce((s, r) => s + r.onHand,   0);
  const totalReserved = allRows.reduce((s, r) => s + r.reserved, 0);

  const displayRows = allRows.filter(r => {
    if (!showZeroStock && r.balanceId === null) return false;
    if (wrhFilter && r.warehouseId !== wrhFilter) return false;
    if (trackFilter && r.trackingMethod !== trackFilter) return false;
    if (!matchesStockFilter(r, stockFilter)) return false;
    if (!matchesStockSearch(r, search)) return false;
    return true;
  });

  const hasAnyStock = allRows.some(r => r.onHand > 0);

  async function openDrilldown(row: StockRow) {
    setDrilldown({ row, assets: [], loading: true });

    if (row.trackingMethod === 'SERIALIZED' && row.warehouseId) {
      const { data: aData } = await supabase
        .from('inventory_assets')
        .select('id, serial_number, part_number, status, source_receipt_id, created_at')
        .eq('inventory_item_id', row.itemId)
        .eq('warehouse_id', row.warehouseId)
        .order('created_at', { ascending: false });

      const assets = (aData || []) as AssetDetail[];

      const receiptIds = [...new Set(
        assets.map(a => a.source_receipt_id).filter((x): x is string => Boolean(x))
      )];
      if (receiptIds.length) {
        const { data: grData } = await supabase
          .from('goods_receipts')
          .select('id, receipt_number')
          .in('id', receiptIds);
        if (grData) {
          const grMap = Object.fromEntries(grData.map(g => [g.id, g.receipt_number]));
          assets.forEach(a => { if (a.source_receipt_id) a.receiptNumber = grMap[a.source_receipt_id]; });
        }
      }

      setDrilldown({ row, assets, loading: false });
    } else {
      setDrilldown({ row, assets: [], loading: false });
    }
  }

  function buildPnSummary(assets: AssetDetail[]): Array<{ pn: string; count: number }> {
    const map = new Map<string, number>();
    for (const a of assets.filter(x => x.status === 'IN_STOCK')) {
      const key = a.part_number || '(Unknown PN)';
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([pn, count]) => ({ pn, count }));
  }

  return (
    <div className={css.page}>
      <div className={css.pageHdr}>
        <div>
          <h1 className={css.pageTitle}>Inventory</h1>
          <p className={css.pageSubtitle}>Real stock levels by warehouse</p>
        </div>
      </div>

      {error && <p className={css.errorMsg}>{error}</p>}

      <div className={css.kpiGrid}>
        <KpiCard icon={<BoxIcon />}       color="#dbeafe" iconColor="#1d4ed8"
          value={loading ? '…' : totalOnHand.toLocaleString()}        label="Total On Hand" />
        <KpiCard icon={<SerialIcon />}    color="#ede9fe" iconColor="#7c3aed"
          value={loading ? '…' : serializedInStock.toLocaleString()}  label="Serialized In Stock" />
        <KpiCard icon={<LockIcon />}      color="#fef9c3" iconColor="#ca8a04"
          value={loading ? '…' : totalReserved.toLocaleString()}      label="Reserved" />
        <KpiCard icon={<WarehouseIcon />} color="#dcfce7" iconColor="#16a34a"
          value={loading ? '…' : String(warehousesWithStock.size)}    label="Warehouses With Stock" />
      </div>

      <div className={css.card}>
        <div className={css.toolbar}>
          <div className={css.searchWrap}>
            <SearchIcon className={css.searchIcon} />
            <input
              className={css.searchInput}
              placeholder="Search item code or name…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <select className={css.select} value={wrhFilter} onChange={e => setWrhFilter(e.target.value)}>
            <option value="">All Warehouses</option>
            {uniqueWarehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <select className={css.select} value={trackFilter} onChange={e => setTrackFilter(e.target.value)}>
            <option value="">All Tracking</option>
            <option value="SERIALIZED">Serialized</option>
            <option value="QUANTITY">Quantity</option>
          </select>
          <select className={css.select} value={stockFilter} onChange={e => setStockFilter(e.target.value as StockStateFilter)}>
            <option value="all">All</option>
            <option value="in_stock">In Stock</option>
            <option value="zero_stock">Zero Stock</option>
            <option value="reserved">Has Reserved</option>
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#64748b', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={showZeroStock} onChange={e => setShowZeroStock(e.target.checked)} />
            Never received
          </label>
        </div>

        <div className={css.tableWrap}>
          {loading ? (
            <table><tbody><tr className={css.loadingRow}><td colSpan={9}>Loading…</td></tr></tbody></table>
          ) : !hasAnyStock && !showZeroStock ? (
            <div className={css.emptyState}>
              <div className={css.emptyMsg}>No stock has been posted yet</div>
              <div className={css.emptyHint}>Post a goods receipt to see inventory levels here.</div>
            </div>
          ) : !displayRows.length ? (
            <div className={css.emptyState}>
              <div className={css.emptyMsg}>No inventory matches your filters</div>
              <div className={css.emptyHint}>Try adjusting the filters or search term.</div>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Item Name</th>
                  <th>Warehouse</th>
                  <th style={{ textAlign: 'right' }}>On Hand</th>
                  <th style={{ textAlign: 'right' }}>Reserved</th>
                  <th style={{ textAlign: 'right' }}>Available</th>
                  <th>Tracking</th>
                  <th>Last Updated</th>
                  <th style={{ width: 50 }}></th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((r, i) => (
                  <tr
                    key={r.balanceId ?? `zero-${r.itemId}-${i}`}
                    style={{ cursor: 'pointer' }}
                    onClick={() => openDrilldown(r)}
                  >
                    <td style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 12 }}>{r.itemCode}</td>
                    <td style={{ fontWeight: 600 }}>{r.itemName}</td>
                    <td style={{ fontSize: 12, color: '#64748b' }}>{r.warehouseName}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{r.onHand}</td>
                    <td style={{ textAlign: 'right', color: r.reserved > 0 ? '#ca8a04' : '#94a3b8' }}>{r.reserved}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: r.available > 0 ? '#16a34a' : '#94a3b8' }}>{r.available}</td>
                    <td>
                      <span className={`${css.badge} ${r.trackingMethod === 'SERIALIZED' ? css.badgePurple : css.badgeBlue}`}>
                        {r.trackingMethod === 'SERIALIZED' ? 'Serialized' : 'Quantity'}
                      </span>
                    </td>
                    <td style={{ fontSize: 12, color: '#94a3b8' }}>
                      {r.updatedAt ? r.updatedAt.slice(0, 10) : '—'}
                    </td>
                    <td>
                      <button
                        className={css.btnIcon}
                        title="View details"
                        onClick={e => { e.stopPropagation(); openDrilldown(r); }}
                      >
                        <EyeIcon />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {drilldown && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget) setDrilldown(null); }}>
          <div className={`${css.modal} ${css.modalWide}`}>
            <div className={css.modalHdr}>
              <span className={css.modalTitle}>
                {drilldown.row.itemCode} — {drilldown.row.warehouseName}
              </span>
              <button className={css.modalClose} onClick={() => setDrilldown(null)}>×</button>
            </div>
            <div className={css.modalBody}>
              {drilldown.loading ? (
                <p style={{ color: '#94a3b8', fontSize: 13 }}>Loading…</p>
              ) : drilldown.row.trackingMethod === 'QUANTITY' ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
                  <SF label="On Hand"   value={String(drilldown.row.onHand)} />
                  <SF label="Reserved"  value={String(drilldown.row.reserved)} />
                  <SF label="Available" value={String(drilldown.row.available)} />
                </div>
              ) : (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 20 }}>
                    <SF label="On Hand"   value={String(drilldown.row.onHand)} />
                    <SF label="Reserved"  value={String(drilldown.row.reserved)} />
                    <SF label="Available" value={String(drilldown.row.available)} />
                  </div>

                  {(() => {
                    const pnSummary = buildPnSummary(drilldown.assets);
                    if (!pnSummary.length) return null;
                    return (
                      <div style={{ marginBottom: 18 }}>
                        <div style={{ fontSize: 12, fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8 }}>
                          Part Numbers In Stock
                        </div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          {pnSummary.map(({ pn, count }) => (
                            <div key={pn} style={{ background: '#f1f5f9', borderRadius: 6, padding: '4px 10px', fontSize: 12 }}>
                              <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{pn}</span>
                              <span style={{ color: '#64748b', marginLeft: 6 }}>— {count} unit{count !== 1 ? 's' : ''}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                  <div style={{ fontSize: 12, fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8 }}>
                    Serialized Units ({drilldown.assets.length})
                  </div>
                  {drilldown.assets.length === 0 ? (
                    <p style={{ fontSize: 13, color: '#94a3b8' }}>No serialized units found.</p>
                  ) : (
                    <div className={css.tableWrap}>
                      <table>
                        <thead>
                          <tr>
                            <th>Serial Number</th>
                            <th>Part Number</th>
                            <th>Status</th>
                            <th>Received Via</th>
                            <th>Date</th>
                          </tr>
                        </thead>
                        <tbody>
                          {drilldown.assets.map(a => (
                            <tr key={a.id}>
                              <td style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 12 }}>{a.serial_number}</td>
                              <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{a.part_number || '—'}</td>
                              <td>
                                <span className={`${css.badge} ${a.status === 'IN_STOCK' ? css.badgeGreen : css.badgeSlate}`}>
                                  {a.status === 'IN_STOCK' ? 'In Stock' : a.status}
                                </span>
                              </td>
                              <td style={{ fontSize: 12 }}>{a.receiptNumber || '—'}</td>
                              <td style={{ fontSize: 12, color: '#94a3b8' }}>{a.created_at.slice(0, 10)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>
            <div className={css.modalFtr}>
              <button className={css.btnGhost} onClick={() => setDrilldown(null)}>Close</button>
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

function KpiCard({ icon, color, iconColor, value, label }: {
  icon: React.ReactNode; color: string; iconColor: string; value: string; label: string;
}) {
  return (
    <div className={css.kpiCard}>
      <div className={css.kpiIcon} style={{ background: color, color: iconColor }}>{icon}</div>
      <div className={css.kpiContent}>
        <div className={css.kpiValue}>{value}</div>
        <div className={css.kpiLabel}>{label}</div>
      </div>
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
function BoxIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>; }
function SerialIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>; }
function LockIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>; }
function WarehouseIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>; }
