import { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import type { StockMovement, Warehouse, InventoryItem } from '../lib/warehouseTypes';
import css from './Warehouse.module.css';

interface MovementRow extends StockMovement {
  warehouseName?: string;
  itemName?: string;
  itemCode?: string;
  performerName?: string;
}

const PAGE_SIZE = 25;

const MOVEMENT_TYPES: Record<string, { label: string; cls: string }> = {
  RECEIPT:   { label: 'Receipt',   cls: 'badgeGreen'  },
  ISSUE:     { label: 'Issue',     cls: 'badgeAmber'  },
  RETURN:    { label: 'Return',    cls: 'badgeBlue'   },
  TRANSFER:  { label: 'Transfer',  cls: 'badgePurple' },
  ADJUSTMENT:{ label: 'Adjust',   cls: 'badgeSlate'  },
  SCRAP:     { label: 'Scrap',     cls: 'badgeRed'    },
};

function movBadge(type: string) {
  const m = MOVEMENT_TYPES[type] || { label: type, cls: 'badgeSlate' };
  return <span className={`${css.badge} ${css[m.cls as keyof typeof css]}`}>{m.label}</span>;
}

export default function WarehouseMovements() {
  const { hasPerm } = useAuth();
  const [movements,  setMovements]  = useState<MovementRow[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');
  const [total,      setTotal]      = useState(0);
  const [page,       setPage]       = useState(1);

  const [wrhFilter,  setWrhFilter]  = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [dateFrom,   setDateFrom]   = useState('');
  const [dateTo,     setDateTo]     = useState('');
  const [search,     setSearch]     = useState('');

  const metaRef = useRef<{ itemMap: Record<string, InventoryItem>; wrhMap: Record<string, string> }>({
    itemMap: {}, wrhMap: {},
  });

  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!hasPerm('view_warehouse_movements')) return <div className={css.denied}>Access denied.</div>;

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  async function loadMeta() {
    const [wRes, iRes] = await Promise.all([
      supabase.from('warehouses').select('*').eq('is_active', true).order('name'),
      supabase.from('inventory_items').select('id, item_code, item_name').eq('is_active', true),
    ]);
    if (wRes.data) {
      setWarehouses(wRes.data as Warehouse[]);
      metaRef.current.wrhMap = Object.fromEntries((wRes.data as Warehouse[]).map(w => [w.id, w.name]));
    }
    if (iRes.data) {
      metaRef.current.itemMap = Object.fromEntries((iRes.data as InventoryItem[]).map(i => [i.id, i]));
    }
  }

  async function load(p = page) {
    setLoading(true);
    setError('');

    let q = supabase.from('stock_movements').select('*', { count: 'exact' });
    if (wrhFilter)  q = q.eq('warehouse_id', wrhFilter);
    if (typeFilter) q = q.eq('movement_type', typeFilter);
    if (dateFrom)   q = q.gte('movement_date', dateFrom);
    if (dateTo)     q = q.lte('movement_date', dateTo);

    const from = (p - 1) * PAGE_SIZE;
    q = q.order('movement_date', { ascending: false }).range(from, from + PAGE_SIZE - 1);

    const { data, error: e, count } = await q;
    if (e) {
      setError(e.message);
      showToast(e.message, false);
      setLoading(false);
      return;
    }

    const rows = (data || []) as MovementRow[];
    const { itemMap, wrhMap } = metaRef.current;

    // Gather unique performer IDs
    const perfIds = [...new Set(rows.map(r => r.performed_by).filter(Boolean))];
    let perfMap: Record<string, string> = {};
    if (perfIds.length) {
      const { data: pData } = await supabase
        .from('team_members').select('id, full_name').in('id', perfIds);
      if (pData) pData.forEach(p => { perfMap[p.id] = p.full_name; });
    }

    rows.forEach(r => {
      r.warehouseName  = wrhMap[r.warehouse_id] || '—';
      const it = itemMap[r.inventory_item_id];
      r.itemName  = it?.item_name  || '—';
      r.itemCode  = it?.item_code  || '—';
      r.performerName = perfMap[r.performed_by] || r.performed_by || '—';
    });

    let filtered = rows;
    if (search) {
      const q = search.toLowerCase();
      filtered = rows.filter(r =>
        (r.itemCode  || '').toLowerCase().includes(q) ||
        (r.itemName  || '').toLowerCase().includes(q) ||
        (r.asset_id  || '').toLowerCase().includes(q) ||
        (r.notes     || '').toLowerCase().includes(q)
      );
    }

    setMovements(filtered);
    setTotal(count ?? 0);
    setLoading(false);
  }

  useEffect(() => { loadMeta(); }, []);
  useEffect(() => { setPage(1); }, [wrhFilter, typeFilter, dateFrom, dateTo, search]);
  useEffect(() => { load(page); }, [page, wrhFilter, typeFilter, dateFrom, dateTo]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className={css.page}>
      <div className={css.pageHdr}>
        <div>
          <h1 className={css.pageTitle}>Stock Movements</h1>
          <p className={css.pageSubtitle}>{total.toLocaleString()} movement{total !== 1 ? 's' : ''} total</p>
        </div>
      </div>

      {error && <p className={css.errorMsg}>{error}</p>}

      <div className={css.card}>
        <div className={css.toolbar}>
          <div className={css.searchWrap}>
            <SearchIcon className={css.searchIcon} />
            <input className={css.searchInput}
              placeholder="Search item code, notes…"
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <select className={css.select} value={wrhFilter} onChange={e => setWrhFilter(e.target.value)}>
            <option value="">All Warehouses</option>
            {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <select className={css.select} value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
            <option value="">All Types</option>
            {Object.entries(MOVEMENT_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <input type="date" className={css.select} style={{ width: 130 }} value={dateFrom}
            onChange={e => setDateFrom(e.target.value)} title="From date" />
          <input type="date" className={css.select} style={{ width: 130 }} value={dateTo}
            onChange={e => setDateTo(e.target.value)} title="To date" />
        </div>

        <div className={css.tableWrap}>
          {loading ? (
            <table><tbody><tr className={css.loadingRow}><td colSpan={8}>Loading…</td></tr></tbody></table>
          ) : !movements.length ? (
            <div className={css.emptyState}>
              <div className={css.emptyMsg}>No movements found</div>
              <div className={css.emptyHint}>Stock movements are created automatically when receipts are posted.</div>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Warehouse</th>
                  <th>Item</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th>Reference</th>
                  <th>Performed By</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {movements.map(m => (
                  <tr key={m.id}>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 12, color: '#64748b' }}>
                      {m.movement_date.slice(0, 10)}
                    </td>
                    <td>{movBadge(m.movement_type)}</td>
                    <td style={{ fontSize: 12 }}>{m.warehouseName}</td>
                    <td>
                      <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 11 }}>{m.itemCode}</span>
                      {' '}<span style={{ fontSize: 12, color: '#64748b' }}>{m.itemName}</span>
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: m.quantity > 0 ? '#16a34a' : '#dc2626' }}>
                      {m.quantity > 0 ? '+' : ''}{m.quantity}
                    </td>
                    <td style={{ fontSize: 11, color: '#64748b' }}>
                      {m.reference_type && <span className={`${css.badge} ${css.badgeSlate}`} style={{ fontSize: 10 }}>{m.reference_type}</span>}
                    </td>
                    <td style={{ fontSize: 12 }}>{m.performerName}</td>
                    <td style={{ fontSize: 12, color: '#64748b', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {m.notes || '—'}
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

      {toast && (
        <div className={`${css.toast} ${toast.ok ? css.toastOk : css.toastErr}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function SearchIcon({ className }: { className?: string }) { return <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>; }
