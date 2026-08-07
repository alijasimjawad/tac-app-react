import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import css from './Warehouse.module.css';

interface KpiData {
  warehouses: number;
  inventoryItems: number;
  assetsInStock: number;
  draftReceipts: number;
  recentReceipts: RecentReceipt[];
}

interface RecentReceipt {
  id: string;
  receipt_number: string;
  warehouse_id: string;
  supplier_name: string | null;
  receipt_date: string;
  status: string;
  warehouseName?: string;
}

function statusBadge(s: string) {
  if (s === 'POSTED')         return <span className={`${css.badge} ${css.badgeGreen}`}>Posted</span>;
  if (s === 'PENDING_REVIEW') return <span className={`${css.badge} ${css.badgeAmber}`}>Pending</span>;
  if (s === 'DRAFT')          return <span className={`${css.badge} ${css.badgeSlate}`}>Draft</span>;
  if (s === 'CANCELLED')      return <span className={`${css.badge} ${css.badgeRed}`}>Cancelled</span>;
  return <span className={css.badge}>{s}</span>;
}

export default function WarehouseOverview() {
  const { hasPerm } = useAuth();
  const [kpi, setKpi] = useState<KpiData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [toast,   setToast]   = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!hasPerm('view_warehouse_overview')) return <div className={css.denied}>Access denied.</div>;

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  async function load() {
    setLoading(true);
    setError('');
    try {
      const [wrhRes, itemRes, assetRes, receiptRes] = await Promise.all([
        supabase.from('warehouses').select('id', { count: 'exact', head: true }).eq('is_active', true),
        supabase.from('inventory_items').select('id', { count: 'exact', head: true }).eq('is_active', true),
        supabase.from('inventory_assets').select('id', { count: 'exact', head: true }).eq('status', 'IN_STOCK'),
        supabase.from('goods_receipts').select('id, receipt_number, warehouse_id, supplier_name, receipt_date, status').order('created_at', { ascending: false }).limit(8),
      ]);

      if (wrhRes.error || itemRes.error || assetRes.error || receiptRes.error) {
        const e = wrhRes.error || itemRes.error || assetRes.error || receiptRes.error;
        setError(e?.message || 'Failed to load data');
        setLoading(false);
        return;
      }

      const receipts = (receiptRes.data || []) as RecentReceipt[];
      const wrhIds = [...new Set(receipts.map(r => r.warehouse_id).filter(Boolean))];
      let wrhNames: Record<string, string> = {};
      if (wrhIds.length) {
        const { data: wData } = await supabase.from('warehouses').select('id, name').in('id', wrhIds);
        if (wData) wData.forEach(w => { wrhNames[w.id] = w.name; });
      }
      receipts.forEach(r => { r.warehouseName = wrhNames[r.warehouse_id] || '—'; });

      const draftCount = receipts.filter(r => r.status === 'DRAFT' || r.status === 'PENDING_REVIEW').length;

      setKpi({
        warehouses:    wrhRes.count ?? 0,
        inventoryItems: itemRes.count ?? 0,
        assetsInStock: assetRes.count ?? 0,
        draftReceipts: draftCount,
        recentReceipts: receipts,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setError(msg);
      showToast(msg, false);
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  return (
    <div className={css.page}>
      <div className={css.pageHdr}>
        <div>
          <h1 className={css.pageTitle}>Warehouse Overview</h1>
          <p className={css.pageSubtitle}>Inventory and receiving summary</p>
        </div>
        <div className={css.hdrActions}>
          {hasPerm('wrh_receive_create') && (
            <Link to="/warehouse/receive">
              <button className={css.btnAccent}>
                <PlusIcon /> New Receipt
              </button>
            </Link>
          )}
          {hasPerm('wrh_warehouses_manage') && (
            <Link to="/warehouse/item-master">
              <button className={css.btnGhost}>Item Master</button>
            </Link>
          )}
        </div>
      </div>

      {error && <p className={css.errorMsg}>{error}</p>}

      <div className={css.kpiGrid}>
        <KpiCard
          icon={<WarehouseIcon />}
          color="#dbeafe" iconColor="#1d4ed8"
          value={loading ? '…' : String(kpi?.warehouses ?? 0)}
          label="Active Warehouses"
        />
        <KpiCard
          icon={<BoxIcon />}
          color="#ede9fe" iconColor="#7c3aed"
          value={loading ? '…' : String(kpi?.inventoryItems ?? 0)}
          label="Inventory Items"
        />
        <KpiCard
          icon={<StockIcon />}
          color="#dcfce7" iconColor="#16a34a"
          value={loading ? '…' : String(kpi?.assetsInStock ?? 0)}
          label="Assets In Stock"
        />
        <KpiCard
          icon={<ClipboardIcon />}
          color="#fef9c3" iconColor="#ca8a04"
          value={loading ? '…' : String(kpi?.draftReceipts ?? 0)}
          label="Pending Receipts"
        />
      </div>

      <div className={css.card}>
        <div className={css.cardHdr}>
          <span className={css.cardTitle}>Recent Receipts</span>
          <Link to="/warehouse/history">
            <button className={css.btnGhost} style={{ fontSize: 12, height: 30 }}>View all</button>
          </Link>
        </div>
        <div className={css.tableWrap}>
          {loading ? (
            <table><tbody><tr className={css.loadingRow}><td colSpan={5}>Loading…</td></tr></tbody></table>
          ) : !kpi?.recentReceipts.length ? (
            <div className={css.emptyState}>
              <div className={css.emptyMsg}>No receipts yet</div>
              <div className={css.emptyHint}>Create your first goods receipt to get started.</div>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Receipt #</th>
                  <th>Warehouse</th>
                  <th>Supplier</th>
                  <th>Date</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {kpi.recentReceipts.map(r => (
                  <tr key={r.id}>
                    <td><Link to={`/warehouse/history`} style={{ color: '#6366f1', fontWeight: 600 }}>{r.receipt_number}</Link></td>
                    <td>{r.warehouseName}</td>
                    <td>{r.supplier_name || '—'}</td>
                    <td>{r.receipt_date}</td>
                    <td>{statusBadge(r.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <QuickLink
          to="/warehouse/inventory"
          perm="view_warehouse_stock"
          icon={<StockIcon />}
          title="Inventory"
          desc="View current stock by warehouse"
          hasPerm={hasPerm}
        />
        <QuickLink
          to="/warehouse/item-master"
          perm="view_warehouse_inventory"
          icon={<BoxIcon />}
          title="Item Master"
          desc="Manage inventory item definitions"
          hasPerm={hasPerm}
        />
        <QuickLink
          to="/warehouse/receive"
          perm="view_warehouse_receive"
          icon={<ReceiveIcon />}
          title="Receive Materials"
          desc="Start a new goods receipt session"
          hasPerm={hasPerm}
        />
        <QuickLink
          to="/warehouse/history"
          perm="view_warehouse_history"
          icon={<ClipboardIcon />}
          title="Receiving History"
          desc="Browse and post past receipts"
          hasPerm={hasPerm}
        />
        <QuickLink
          to="/warehouse/movements"
          perm="view_warehouse_movements"
          icon={<MovementIcon />}
          title="Stock Movements"
          desc="Audit trail of all stock changes"
          hasPerm={hasPerm}
        />
      </div>

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

function QuickLink({ to, perm, icon, title, desc, hasPerm }: {
  to: string; perm: string; icon: React.ReactNode; title: string; desc: string;
  hasPerm: (k: string) => boolean;
}) {
  if (!hasPerm(perm)) return null;
  return (
    <Link to={to} style={{ textDecoration: 'none' }}>
      <div className={css.card} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: 16, cursor: 'pointer', transition: 'box-shadow .15s', marginBottom: 0 }}>
        <div style={{ color: '#6366f1', flexShrink: 0 }}>{icon}</div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#1e293b' }}>{title}</div>
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{desc}</div>
        </div>
      </div>
    </Link>
  );
}

function PlusIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>; }
function WarehouseIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>; }
function BoxIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>; }
function StockIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>; }
function ClipboardIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>; }
function ReceiveIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"/></svg>; }
function MovementIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>; }
