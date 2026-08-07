import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import type { GoodsReceipt, GoodsReceiptItem, InventoryItem, Warehouse } from '../lib/warehouseTypes';
import css from './Warehouse.module.css';

interface ReceiptRow extends GoodsReceipt {
  warehouseName?: string;
  itemCount?: number;
}

interface ReceiptDetail {
  receipt: ReceiptRow;
  lineItems: Array<GoodsReceiptItem & { itemName?: string; itemCode?: string }>;
}

function statusBadge(s: string) {
  if (s === 'POSTED')          return <span className={`${css.badge} ${css.badgeGreen}`}>Posted</span>;
  if (s === 'PENDING_REVIEW')  return <span className={`${css.badge} ${css.badgeAmber}`}>Pending Review</span>;
  if (s === 'DRAFT')           return <span className={`${css.badge} ${css.badgeSlate}`}>Draft</span>;
  if (s === 'CANCELLED')       return <span className={`${css.badge} ${css.badgeRed}`}>Cancelled</span>;
  return <span className={css.badge}>{s}</span>;
}

const PAGE_SIZE = 20;

export default function WarehouseHistory() {
  const { hasPerm, currentUser } = useAuth();
  const [receipts,   setReceipts]   = useState<ReceiptRow[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [items,      setItems]      = useState<InventoryItem[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');
  const [total,      setTotal]      = useState(0);
  const [page,       setPage]       = useState(1);

  const [wrhFilter,    setWrhFilter]    = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [dateFrom,     setDateFrom]     = useState('');
  const [dateTo,       setDateTo]       = useState('');
  const [search,       setSearch]       = useState('');

  const [detail,   setDetail]   = useState<ReceiptDetail | null>(null);
  const [posting,  setPosting]  = useState(false);
  const [canceling, setCanceling] = useState(false);

  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!hasPerm('view_warehouse_history')) return <div className={css.denied}>Access denied.</div>;

  const canPost   = hasPerm('wrh_receive_post');
  const canCancel = hasPerm('wrh_receive_cancel');

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
    if (wRes.data) setWarehouses(wRes.data as Warehouse[]);
    if (iRes.data) setItems(iRes.data as InventoryItem[]);
  }

  async function load(p = page) {
    setLoading(true);
    setError('');

    let q = supabase.from('goods_receipts').select('*', { count: 'exact' });
    if (wrhFilter)    q = q.eq('warehouse_id', wrhFilter);
    if (statusFilter) q = q.eq('status', statusFilter);
    if (dateFrom)     q = q.gte('receipt_date', dateFrom);
    if (dateTo)       q = q.lte('receipt_date', dateTo);
    if (search) {
      const s = search.trim();
      q = q.or(`receipt_number.ilike.%${s}%,supplier_name.ilike.%${s}%,delivery_note_number.ilike.%${s}%`);
    }

    const from = (p - 1) * PAGE_SIZE;
    q = q.order('created_at', { ascending: false }).range(from, from + PAGE_SIZE - 1);

    const { data, error: e, count } = await q;
    if (e) { setError(e.message); setLoading(false); return; }

    const rows = (data || []) as ReceiptRow[];
    const wrhMap = Object.fromEntries(warehouses.map(w => [w.id, w.name]));
    rows.forEach(r => { r.warehouseName = wrhMap[r.warehouse_id] || '—'; });

    setReceipts(rows);
    setTotal(count ?? 0);
    setLoading(false);
  }

  useEffect(() => { loadMeta(); }, []);
  useEffect(() => { if (warehouses.length || !loading) load(1); setPage(1); }, [wrhFilter, statusFilter, dateFrom, dateTo, search]);
  useEffect(() => { load(page); }, [page, warehouses]);

  async function openDetail(receipt: ReceiptRow) {
    const { data: liData } = await supabase
      .from('goods_receipt_items')
      .select('*')
      .eq('goods_receipt_id', receipt.id);

    const lineItems = (liData || []) as Array<GoodsReceiptItem & { itemName?: string; itemCode?: string }>;
    const itemMap = Object.fromEntries(items.map(i => [i.id, i]));
    lineItems.forEach(li => {
      const it = itemMap[li.inventory_item_id];
      if (it) { li.itemName = it.item_name; li.itemCode = it.item_code; }
    });

    setDetail({ receipt, lineItems });
  }

  async function postReceipt(receiptId: string) {
    setPosting(true);
    const { error: e } = await supabase
      .from('goods_receipts')
      .update({ status: 'POSTED', posted_at: new Date().toISOString() })
      .eq('id', receiptId);
    setPosting(false);
    if (e) { showToast(e.message, false); return; }
    if (currentUser) {
      const r = receipts.find(r => r.id === receiptId);
      await supabase.from('activity_log').insert({
        user_id: currentUser.id,
        action:  `Posted goods receipt ${r?.receipt_number || receiptId}`,
      });
    }
    showToast('Receipt posted.', true);
    setDetail(null);
    load(page);
  }

  async function cancelReceipt(receiptId: string) {
    if (!confirm('Cancel this receipt? This cannot be undone.')) return;
    setCanceling(true);
    const { error: e } = await supabase
      .from('goods_receipts')
      .update({ status: 'CANCELLED' })
      .eq('id', receiptId);
    setCanceling(false);
    if (e) { showToast(e.message, false); return; }
    showToast('Receipt cancelled.', true);
    setDetail(null);
    load(page);
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className={css.page}>
      <div className={css.pageHdr}>
        <div>
          <h1 className={css.pageTitle}>Receiving History</h1>
          <p className={css.pageSubtitle}>{total} receipt{total !== 1 ? 's' : ''} total</p>
        </div>
      </div>

      {error && <p className={css.errorMsg}>{error}</p>}

      <div className={css.card}>
        <div className={css.toolbar}>
          <div className={css.searchWrap}>
            <SearchIcon className={css.searchIcon} />
            <input className={css.searchInput}
              placeholder="Receipt #, supplier, DN…"
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <select className={css.select} value={wrhFilter} onChange={e => setWrhFilter(e.target.value)}>
            <option value="">All Warehouses</option>
            {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <select className={css.select} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="">All Statuses</option>
            <option value="DRAFT">Draft</option>
            <option value="PENDING_REVIEW">Pending Review</option>
            <option value="POSTED">Posted</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
          <input type="date" className={css.select} style={{ width: 130 }} value={dateFrom}
            onChange={e => setDateFrom(e.target.value)} title="From date" />
          <input type="date" className={css.select} style={{ width: 130 }} value={dateTo}
            onChange={e => setDateTo(e.target.value)} title="To date" />
        </div>

        <div className={css.tableWrap}>
          {loading ? (
            <table><tbody><tr className={css.loadingRow}><td colSpan={7}>Loading…</td></tr></tbody></table>
          ) : !receipts.length ? (
            <div className={css.emptyState}>
              <div className={css.emptyMsg}>No receipts found</div>
              <div className={css.emptyHint}>Adjust filters or create a new goods receipt.</div>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Receipt #</th>
                  <th>Warehouse</th>
                  <th>Supplier</th>
                  <th>DN #</th>
                  <th>Date</th>
                  <th>Status</th>
                  <th style={{ width: 50 }}></th>
                </tr>
              </thead>
              <tbody>
                {receipts.map(r => (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => openDetail(r)}>
                    <td style={{ fontWeight: 700, color: '#6366f1' }}>{r.receipt_number}</td>
                    <td>{r.warehouseName}</td>
                    <td>{r.supplier_name || '—'}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.delivery_note_number || '—'}</td>
                    <td>{r.receipt_date}</td>
                    <td>{statusBadge(r.status)}</td>
                    <td>
                      <button className={css.btnIcon} onClick={e => { e.stopPropagation(); openDetail(r); }} title="View">
                        <EyeIcon />
                      </button>
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

      {/* Detail drawer */}
      {detail && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget) setDetail(null); }}>
          <div className={`${css.modal} ${css.modalWide}`}>
            <div className={css.modalHdr}>
              <span className={css.modalTitle}>Receipt {detail.receipt.receipt_number}</span>
              <button className={css.modalClose} onClick={() => setDetail(null)}>×</button>
            </div>
            <div className={css.modalBody}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 18, fontSize: 13 }}>
                <SF label="Warehouse"    value={detail.receipt.warehouseName || '—'} />
                <SF label="Date"         value={detail.receipt.receipt_date} />
                <SF label="Status"       value={<span>{statusBadge(detail.receipt.status)}</span>} />
                <SF label="Supplier"     value={detail.receipt.supplier_name || '—'} />
                <SF label="Delivery Note" value={detail.receipt.delivery_note_number || '—'} />
                <SF label="PO Number"    value={detail.receipt.purchase_order_number || '—'} />
              </div>
              {detail.receipt.notes && (
                <div style={{ background: '#f8fafc', borderRadius: 8, padding: 10, marginBottom: 16, fontSize: 13, color: '#475569' }}>
                  {detail.receipt.notes}
                </div>
              )}

              <div style={{ fontSize: 12, fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8 }}>
                Line Items ({detail.lineItems.length})
              </div>
              {detail.lineItems.length === 0 ? (
                <p style={{ fontSize: 13, color: '#94a3b8' }}>No line items recorded.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Part #</th>
                      <th style={{ textAlign: 'right' }}>Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lineItems.map(li => (
                      <tr key={li.id}>
                        <td>
                          <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 12 }}>{li.itemCode}</span>
                          {' '}<span style={{ color: '#64748b' }}>{li.itemName}</span>
                        </td>
                        <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{li.part_number || '—'}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700 }}>{li.quantity}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className={css.modalFtr}>
              <button className={css.btnGhost} onClick={() => setDetail(null)}>Close</button>
              {canCancel && ['DRAFT', 'PENDING_REVIEW'].includes(detail.receipt.status) && (
                <button className={css.btnDanger} onClick={() => cancelReceipt(detail.receipt.id)} disabled={canceling}>
                  {canceling ? 'Cancelling…' : 'Cancel Receipt'}
                </button>
              )}
              {canPost && detail.receipt.status === 'PENDING_REVIEW' && (
                <button className={css.btnAccent} onClick={() => postReceipt(detail.receipt.id)} disabled={posting}>
                  {posting ? 'Posting…' : 'Post to Stock'}
                </button>
              )}
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
