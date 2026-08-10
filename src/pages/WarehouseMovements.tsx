import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import type { StockMovement } from '../lib/warehouseTypes';
import {
  buildAssetMap, buildItemMap, buildWarehouseMap, buildProjectMap,
  matchesMovementSearch, enrichMovementRow,
  formatBaghdadDate, formatBaghdadTime,
  type ItemInfo, type MovementDirection,
} from '../lib/warehouseMovementsHelpers';
import css from './Warehouse.module.css';

// ── Types ─────────────────────────────────────────────────────────────────────

interface MovementRow extends StockMovement {
  warehouseName:  string;
  itemCode:       string;
  itemName:       string;
  trackingMethod: string | null;
  performerName:  string;
  receiptNumber?: string;
  issueNumber?:   string;
  serialNumber:   string | null;
  partNumber:     string | null;
  assetStatus:    string | null;
  direction:      MovementDirection;
  projectName:    string;
}

type DirectionFilter = '' | 'IN' | 'OUT';

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 25;

const MOVEMENT_TYPES: Record<string, { label: string; cls: string }> = {
  RECEIVE:      { label: 'Receive',      cls: 'badgeGreen'  },
  ISSUE:        { label: 'Issue',        cls: 'badgeRed'    },
  TRANSFER_IN:  { label: 'Transfer In',  cls: 'badgeAmber'  },
  TRANSFER_OUT: { label: 'Transfer Out', cls: 'badgeAmber'  },
  RETURN:       { label: 'Return',       cls: 'badgePurple' },
  ADJUSTMENT:   { label: 'Adjustment',  cls: 'badgeSlate'  },
  DAMAGE:       { label: 'Damage',       cls: 'badgeAmber'  },
  SCRAP:        { label: 'Scrap',        cls: 'badgeRed'    },
};

function movBadge(type: string) {
  const m = MOVEMENT_TYPES[type] ?? { label: type, cls: 'badgeSlate' };
  return <span className={`${css.badge} ${css[m.cls as keyof typeof css]}`}>{m.label}</span>;
}

function dirBadge(dir: MovementDirection) {
  return dir === 'IN'
    ? <span className={`${css.badge} ${css.badgeGreen}`} style={{ fontSize: 10, letterSpacing: '.3px' }}>▲ IN</span>
    : <span className={`${css.badge} ${css.badgeRed}`}   style={{ fontSize: 10, letterSpacing: '.3px' }}>▼ OUT</span>;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function WarehouseMovements() {
  const { hasPerm } = useAuth();

  const [movements,  setMovements]  = useState<MovementRow[]>([]);
  const [warehouses, setWarehouses] = useState<Array<{ id: string; name: string }>>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');
  const [total,      setTotal]      = useState(0);
  const [page,       setPage]       = useState(1);

  const [projects, setProjects] = useState<Array<{ id: string; display_name: string }>>([]);

  // Server-side filters — each change triggers a new DB query + page reset
  const [wrhFilter,  setWrhFilter]  = useState('');
  const [projFilter, setProjFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [dateFrom,   setDateFrom]   = useState('');
  const [dateTo,     setDateTo]     = useState('');

  // Client-side filters — applied to the already-loaded page, no re-fetch
  const [dirFilter, setDirFilter] = useState<DirectionFilter>('');
  const [search,    setSearch]    = useState('');

  const [selectedMovement, setSelectedMovement] = useState<MovementRow | null>(null);
  const [copiedId, setCopiedId] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Loaded once at mount — all items/warehouses/projects without is_active filter so that
  // historical movements referencing deactivated rows still resolve.
  const metaRef = useRef<{
    itemMap:    Map<string, ItemInfo>;
    wrhMap:     Map<string, string>;
    projectMap: Map<string, string>;
  }>({ itemMap: new Map(), wrhMap: new Map(), projectMap: new Map() });

  if (!hasPerm('view_warehouse_movements')) return <div className={css.denied}>Access denied.</div>;

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  async function loadMeta() {
    // No is_active filter — audit pages must resolve deactivated items/warehouses/projects.
    const [wRes, iRes, allProjRes, activeProjRes] = await Promise.all([
      supabase.from('warehouses').select('id, name').order('name'),
      supabase.from('inventory_items').select('id, item_code, item_name, tracking_method'),
      supabase.from('projects').select('id, display_name').order('sort_order').order('display_name'),
      supabase.from('projects').select('id, display_name').eq('is_active', true).order('sort_order').order('display_name'),
    ]);
    if (wRes.data) {
      setWarehouses(wRes.data);
      metaRef.current.wrhMap = buildWarehouseMap(wRes.data);
    }
    if (iRes.data) {
      metaRef.current.itemMap = buildItemMap(iRes.data);
    }
    if (allProjRes.data) {
      metaRef.current.projectMap = buildProjectMap(allProjRes.data);
    }
    if (activeProjRes.data) {
      setProjects(activeProjRes.data as Array<{ id: string; display_name: string }>);
    }
  }

  async function load(p = page) {
    setLoading(true);
    setError('');

    let q = supabase.from('stock_movements').select('*', { count: 'exact' });
    if (wrhFilter)  q = q.eq('warehouse_id', wrhFilter);
    if (projFilter) q = q.eq('project_id', projFilter);
    if (typeFilter) q = q.eq('movement_type', typeFilter);
    if (dateFrom)   q = q.gte('movement_date', dateFrom);
    if (dateTo)     q = q.lte('movement_date', dateTo);

    const from = (p - 1) * PAGE_SIZE;
    q = q.order('movement_date', { ascending: false })
         .order('created_at',    { ascending: false })
         .range(from, from + PAGE_SIZE - 1);

    const { data, error: e, count } = await q;
    if (e) {
      setError(e.message);
      showToast(e.message, false);
      setLoading(false);
      return;
    }

    const raw = (data ?? []) as StockMovement[];

    // Collect unique IDs for bulk lookups on this page — no query inside .map()
    const perfIds  = [...new Set(raw.map(r => r.performed_by).filter(Boolean))];
    const grIds    = [...new Set(
      raw.filter(r => r.reference_type === 'GOODS_RECEIPT' && r.reference_id)
         .map(r => r.reference_id!),
    )];
    const giIds    = [...new Set(
      raw.filter(r => r.reference_type === 'GOODS_ISSUE' && r.reference_id)
         .map(r => r.reference_id!),
    )];
    const assetIds = [...new Set(
      raw.map(r => r.asset_id).filter((x): x is string => x != null),
    )];

    // Page-scoped Maps built per load — mutated inside Promise.all callbacks
    const perfMap  = new Map<string, string>();
    const grMap    = new Map<string, string>();
    const giMap    = new Map<string, string>();
    let   assetMap = buildAssetMap([]);

    await Promise.all([
      perfIds.length
        ? supabase.from('users').select('id, full_name').in('id', perfIds)
            .then(({ data: d }) => {
              if (d) d.forEach(u => perfMap.set(u.id, u.full_name));
            })
        : Promise.resolve(),
      grIds.length
        ? supabase.from('goods_receipts').select('id, receipt_number').in('id', grIds)
            .then(({ data: d }) => {
              if (d) d.forEach(g => grMap.set(g.id, g.receipt_number));
            })
        : Promise.resolve(),
      giIds.length
        ? supabase.from('goods_issues').select('id, issue_number').in('id', giIds)
            .then(({ data: d }) => {
              if (d) d.forEach(g => giMap.set(g.id, g.issue_number));
            })
        : Promise.resolve(),
      assetIds.length
        ? supabase.from('inventory_assets')
            .select('id, serial_number, part_number, status')
            .in('id', assetIds)
            .then(({ data: d }) => {
              if (d) assetMap = buildAssetMap(d);
            })
        : Promise.resolve(),
    ]);

    // Enrich all rows — O(1) map lookups, no queries
    const enriched: MovementRow[] = raw.map(r => ({
      ...r,
      ...enrichMovementRow(
        r,
        metaRef.current.itemMap,
        metaRef.current.wrhMap,
        assetMap,
        perfMap,
        grMap,
        metaRef.current.projectMap,
        giMap,
      ),
    }));

    setMovements(enriched);
    setTotal(count ?? 0);
    setLoading(false);
  }

  useEffect(() => { loadMeta(); }, []);
  // Server-filter changes reset to page 1 and trigger a new load via the page effect
  useEffect(() => { setPage(1); }, [wrhFilter, projFilter, typeFilter, dateFrom, dateTo]);
  useEffect(() => { load(page); }, [page, wrhFilter, projFilter, typeFilter, dateFrom, dateTo]);
  // search and dirFilter are client-side — they filter displayMovements at render time,
  // no re-fetch needed.

  // Client-side derived view — direction + free-text search applied on loaded page
  const displayMovements = movements.filter(m => {
    if (dirFilter && m.direction !== dirFilter) return false;
    if (search && !matchesMovementSearch(m, search)) return false;
    return true;
  });

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className={css.page}>
      <div className={css.pageHdr}>
        <div>
          <h1 className={css.pageTitle}>Stock Movements</h1>
          <p className={css.pageSubtitle}>
            {total.toLocaleString()} movement{total !== 1 ? 's' : ''} total
          </p>
        </div>
      </div>

      {error && <p className={css.errorMsg}>{error}</p>}

      <div className={css.card}>
        {/* ── Toolbar ── */}
        <div className={css.toolbar}>
          <div className={css.searchWrap}>
            <SearchIcon className={css.searchIcon} />
            <input
              className={css.searchInput}
              placeholder="Search item, SN, PN, GR/GI number…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <select className={css.select} value={wrhFilter} onChange={e => setWrhFilter(e.target.value)}>
            <option value="">All Warehouses</option>
            {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <select className={css.select} value={projFilter} onChange={e => setProjFilter(e.target.value)}>
            <option value="">All Projects</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.display_name}</option>)}
          </select>
          <select className={css.select} value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
            <option value="">All Types</option>
            {Object.entries(MOVEMENT_TYPES).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
          <select
            className={css.select}
            value={dirFilter}
            onChange={e => setDirFilter(e.target.value as DirectionFilter)}
          >
            <option value="">All Directions</option>
            <option value="IN">▲ IN</option>
            <option value="OUT">▼ OUT</option>
          </select>
          <input
            type="date" className={css.select} style={{ width: 130 }}
            value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            title="From date"
          />
          <input
            type="date" className={css.select} style={{ width: 130 }}
            value={dateTo} onChange={e => setDateTo(e.target.value)}
            title="To date"
          />
        </div>

        {/* ── Table ── */}
        <div className={css.tableWrap}>
          {loading ? (
            <table>
              <tbody>
                <tr className={css.loadingRow}><td colSpan={10}>Loading…</td></tr>
              </tbody>
            </table>
          ) : !displayMovements.length ? (
            <div className={css.emptyState}>
              <div className={css.emptyMsg}>No movements found</div>
              <div className={css.emptyHint}>
                {search || dirFilter
                  ? 'No movements match the current filter.'
                  : 'Stock movements are created automatically when receipts are posted.'}
              </div>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Dir</th>
                  <th>Type</th>
                  <th>Item</th>
                  <th>Warehouse</th>
                  <th>Project</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th>SN / PN</th>
                  <th>Reference</th>
                  <th>Performed By</th>
                </tr>
              </thead>
              <tbody>
                {displayMovements.map(m => (
                  <tr
                    key={m.id}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setSelectedMovement(m)}
                  >
                    {/* Date + time in Baghdad local time, derived from created_at */}
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <div style={{ fontSize: 12, color: '#1e293b' }}>{formatBaghdadDate(m.created_at)}</div>
                      <div style={{ fontSize: 10, color: '#94a3b8', fontFamily: 'monospace', marginTop: 1 }}>
                        {formatBaghdadTime(m.created_at)}
                      </div>
                    </td>

                    {/* Direction */}
                    <td>{dirBadge(m.direction)}</td>

                    {/* Movement type */}
                    <td>{movBadge(m.movement_type)}</td>

                    {/* Item */}
                    <td>
                      <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 11 }}>
                        {m.itemCode}
                      </span>
                      <div style={{ fontSize: 11, color: '#64748b', marginTop: 1 }}>{m.itemName}</div>
                    </td>

                    {/* Warehouse */}
                    <td style={{ fontSize: 12 }}>{m.warehouseName}</td>

                    {/* Project */}
                    <td style={{ fontSize: 12, color: '#64748b' }}>{m.projectName}</td>

                    {/* Quantity */}
                    <td style={{
                      textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap',
                      color: m.quantity > 0 ? '#16a34a' : '#dc2626',
                    }}>
                      {m.quantity > 0 ? '+' : ''}{m.quantity}
                    </td>

                    {/* SN / PN */}
                    <td>
                      {m.serialNumber != null ? (
                        <>
                          <div style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 11 }}>
                            {m.serialNumber}
                          </div>
                          <div style={{ fontFamily: 'monospace', fontSize: 10, color: '#64748b', marginTop: 1 }}>
                            {m.partNumber ?? '—'}
                          </div>
                        </>
                      ) : (
                        <span style={{ color: '#94a3b8', fontSize: 12 }}>—</span>
                      )}
                    </td>

                    {/* Reference */}
                    <td style={{ fontSize: 11 }}>
                      {m.receiptNumber ? (
                        <>
                          <div style={{ fontFamily: 'monospace', fontWeight: 700, color: '#6366f1', fontSize: 11 }}>
                            {m.receiptNumber}
                          </div>
                          <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 1 }}>Goods Receipt</div>
                        </>
                      ) : m.issueNumber ? (
                        <>
                          <div style={{ fontFamily: 'monospace', fontWeight: 700, color: '#dc2626', fontSize: 11 }}>
                            {m.issueNumber}
                          </div>
                          <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 1 }}>Goods Issue</div>
                        </>
                      ) : m.reference_type ? (
                        <span className={`${css.badge} ${css.badgeSlate}`} style={{ fontSize: 10 }}>
                          {m.reference_type}
                        </span>
                      ) : (
                        <span style={{ color: '#94a3b8' }}>—</span>
                      )}
                    </td>

                    {/* Performed By */}
                    <td style={{ fontSize: 12 }}>{m.performerName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Pagination ── */}
        {totalPages > 1 && (
          <div className={css.pagination}>
            <button className={css.pageBtn} disabled={page === 1} onClick={() => setPage(p => p - 1)}>‹</button>
            {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
              const n = Math.max(1, Math.min(page - 3, totalPages - 6)) + i;
              if (n < 1 || n > totalPages) return null;
              return (
                <button
                  key={n}
                  className={`${css.pageBtn} ${page === n ? css.pageBtnActive : ''}`}
                  onClick={() => setPage(n)}
                >
                  {n}
                </button>
              );
            })}
            <button className={css.pageBtn} disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>›</button>
            <span className={css.pageInfo}>{page} / {totalPages}</span>
          </div>
        )}
      </div>

      {/* ── Movement Detail Modal ── */}
      {selectedMovement && createPortal(
        <div
          className={css.overlay}
          onClick={e => { if (e.target === e.currentTarget) { setSelectedMovement(null); setCopiedId(false); } }}
        >
          <div className={`${css.modal} ${css.modalWide}`}>
            <div className={css.modalHdr}>
              <span className={css.modalTitle}>Movement Details</span>
              <button className={css.modalClose} onClick={() => setSelectedMovement(null)}>×</button>
            </div>

            <div className={css.modalBody}>
              {/* Type + direction badges */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
                {movBadge(selectedMovement.movement_type)}
                {dirBadge(selectedMovement.direction)}
              </div>

              {/* Core fields */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 18 }}>
                <SF label="Date" value={formatBaghdadDate(selectedMovement.created_at)} />
                <SF label="Time" value={formatBaghdadTime(selectedMovement.created_at)} />
                <SF label="Quantity"   value={
                  <span style={{
                    fontWeight: 700,
                    color: selectedMovement.quantity > 0 ? '#16a34a' : '#dc2626',
                  }}>
                    {selectedMovement.quantity > 0 ? '+' : ''}{selectedMovement.quantity}
                  </span>
                } />
                <SF label="Item Code"  value={
                  <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>
                    {selectedMovement.itemCode}
                  </span>
                } />
                <SF label="Item Name"  value={selectedMovement.itemName} />
                <SF label="Tracking"   value={selectedMovement.trackingMethod ?? '—'} />
                <SF label="Warehouse"  value={selectedMovement.warehouseName} />
                <SF label="Project"    value={selectedMovement.projectName} />
                <SF label="Performed By" value={selectedMovement.performerName} />
                <SF label="Reference"  value={
                  selectedMovement.receiptNumber
                    ? <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#6366f1' }}>
                        {selectedMovement.receiptNumber}
                      </span>
                    : selectedMovement.issueNumber
                    ? <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#dc2626' }}>
                        {selectedMovement.issueNumber}
                      </span>
                    : (selectedMovement.reference_type ?? '—')
                } />
              </div>

              {/* Serialized asset section — only shown when asset_id resolved to an asset row */}
              {selectedMovement.serialNumber != null && (
                <div style={{
                  background: '#f8fafc', borderRadius: 8, padding: 14,
                  marginBottom: 14, border: '1px solid #e2e8f0',
                }}>
                  <div style={{
                    fontSize: 11, fontWeight: 800, color: '#64748b',
                    textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 10,
                  }}>
                    Serialized Asset
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
                    <SF label="Serial Number" value={
                      <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>
                        {selectedMovement.serialNumber}
                      </span>
                    } />
                    <SF label="Part Number" value={
                      <span style={{ fontFamily: 'monospace' }}>
                        {selectedMovement.partNumber ?? '—'}
                      </span>
                    } />
                    <SF label="Asset Status" value={selectedMovement.assetStatus ?? '—'} />
                  </div>
                </div>
              )}

              {/* Notes */}
              {selectedMovement.notes && (
                <div style={{
                  background: '#f8fafc', borderRadius: 8, padding: 12,
                  border: '1px solid #e2e8f0', marginBottom: 14,
                }}>
                  <div style={{
                    fontSize: 11, fontWeight: 700, color: '#94a3b8',
                    textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 4,
                  }}>
                    Notes
                  </div>
                  <div style={{ fontSize: 13, color: '#475569', lineHeight: 1.5 }}>
                    {selectedMovement.notes}
                  </div>
                </div>
              )}

              {/* Technical details */}
              <div style={{
                background: '#f8fafc', borderRadius: 8, padding: '10px 14px',
                border: '1px solid #e2e8f0',
              }}>
                <div style={{
                  fontSize: 11, fontWeight: 700, color: '#94a3b8',
                  textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 8,
                }}>
                  Technical Details
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600, minWidth: 80 }}>
                    Movement ID
                  </span>
                  <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#475569', flex: 1, wordBreak: 'break-all' }}>
                    {selectedMovement.id}
                  </span>
                  <button
                    className={css.btnGhost}
                    style={{ fontSize: 11, height: 26, padding: '0 10px', flexShrink: 0 }}
                    onClick={() => {
                      navigator.clipboard.writeText(selectedMovement.id).then(() => {
                        setCopiedId(true);
                        setTimeout(() => setCopiedId(false), 1500);
                      });
                    }}
                  >
                    {copiedId ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>
            </div>

            <div className={css.modalFtr}>
              <button className={css.btnGhost} onClick={() => { setSelectedMovement(null); setCopiedId(false); }}>Close</button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {toast && (
        <div className={`${css.toast} ${toast.ok ? css.toastOk : css.toastErr}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function SF({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div style={{
        fontSize: 11, fontWeight: 700, color: '#94a3b8',
        textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 2,
      }}>
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
