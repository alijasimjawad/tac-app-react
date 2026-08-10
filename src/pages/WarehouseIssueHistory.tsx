import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { canCancelIssue } from '../lib/goodsIssueHelpers';
import type { GoodsIssue } from '../lib/warehouseTypes';
import css from './Warehouse.module.css';

// ── Types ─────────────────────────────────────────────────────────────────────

interface IssueRow extends GoodsIssue {
  warehouseName: string;
  projectName:   string;
}

interface IssueItemDetail {
  id:                string;
  inventory_item_id: string;
  itemCode:          string;
  itemName:          string;
  trackingMethod:    string;
  quantity:          number;
  assets:            Array<{ assetId: string; serialNumber: string; partNumber: string | null }>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 25;

const STATUS_BADGE: Record<string, [string, string]> = {
  DRAFT:     [css.badgeSlate, 'Draft'],
  POSTED:    [css.badgeGreen, 'Posted'],
  CANCELLED: [css.badgeRed,   'Cancelled'],
};

function statusBadge(s: string) {
  const [cls, label] = STATUS_BADGE[s] ?? [css.badgeSlate, s];
  return <span className={`${css.badge} ${cls}`}>{label}</span>;
}

const DEST_LABELS: Record<string, string> = {
  SITE: 'Site', TEAM_MEMBER: 'Team Member', USER: 'User',
  VEHICLE: 'Vehicle', EXTERNAL: 'External', OTHER: 'Other',
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function WarehouseIssueHistory() {
  const { hasPerm } = useAuth();

  const [issues,     setIssues]     = useState<IssueRow[]>([]);
  const [total,      setTotal]      = useState(0);
  const [page,       setPage]       = useState(1);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');

  const [warehouses, setWarehouses] = useState<Array<{ id: string; name: string }>>([]);
  const [projects,   setProjects]   = useState<Array<{ id: string; display_name: string }>>([]);

  const [wrhFilter,  setWrhFilter]  = useState('');
  const [projFilter, setProjFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [dateFrom,   setDateFrom]   = useState('');
  const [dateTo,     setDateTo]     = useState('');
  const [search,     setSearch]     = useState('');

  const [selected,   setSelected]   = useState<IssueRow | null>(null);
  const [itemDetails, setItemDetails] = useState<IssueItemDetail[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [cancelling,    setCancelling]    = useState(false);

  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const wrhMapRef = useRef(new Map<string, string>());
  const projMapRef = useRef(new Map<string, string>());

  if (!hasPerm('view_warehouse_issue_history')) return <div className={css.denied}>Access denied.</div>;

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  async function loadMeta() {
    const [wRes, pRes] = await Promise.all([
      supabase.from('warehouses').select('id, name').order('name'),
      supabase.from('projects').select('id, display_name').order('sort_order').order('display_name'),
    ]);
    if (wRes.data) {
      setWarehouses(wRes.data);
      wRes.data.forEach(w => wrhMapRef.current.set(w.id, w.name));
    }
    if (pRes.data) {
      setProjects(pRes.data as Array<{ id: string; display_name: string }>);
      (pRes.data as Array<{ id: string; display_name: string }>).forEach(p => projMapRef.current.set(p.id, p.display_name));
    }
  }

  async function load(p = page) {
    setLoading(true);
    setError('');

    let q = supabase.from('goods_issues').select('*', { count: 'exact' });
    if (wrhFilter)    q = q.eq('warehouse_id', wrhFilter);
    if (projFilter)   q = q.eq('project_id', projFilter);
    if (statusFilter) q = q.eq('status', statusFilter);
    if (dateFrom)     q = q.gte('issue_date', dateFrom);
    if (dateTo)       q = q.lte('issue_date', dateTo);

    const from = (p - 1) * PAGE_SIZE;
    q = q.order('created_at', { ascending: false }).range(from, from + PAGE_SIZE - 1);

    const { data, error: e, count } = await q;
    if (e) { setError(e.message); setLoading(false); return; }

    const rows = (data ?? []) as GoodsIssue[];
    const enriched: IssueRow[] = rows.map(r => ({
      ...r,
      warehouseName: wrhMapRef.current.get(r.warehouse_id) ?? '—',
      projectName:   projMapRef.current.get(r.project_id)  ?? '—',
    }));

    setIssues(enriched);
    setTotal(count ?? 0);
    setLoading(false);
  }

  useEffect(() => { loadMeta(); }, []);
  useEffect(() => { setPage(1); }, [wrhFilter, projFilter, statusFilter, dateFrom, dateTo]);
  useEffect(() => { load(page); }, [page, wrhFilter, projFilter, statusFilter, dateFrom, dateTo]);

  async function openDetail(issue: IssueRow) {
    setSelected(issue);
    setItemDetails([]);
    setDetailLoading(true);

    // Fetch line items
    const { data: items } = await supabase
      .from('goods_issue_items')
      .select('id, inventory_item_id, quantity')
      .eq('goods_issue_id', issue.id)
      .order('created_at');

    if (!items) { setDetailLoading(false); return; }

    // Fetch item master details
    const itemIds = [...new Set(items.map(i => i.inventory_item_id))];
    const { data: itemMaster } = await supabase
      .from('inventory_items')
      .select('id, item_code, item_name, tracking_method')
      .in('id', itemIds);

    const itemMasterMap = new Map((itemMaster ?? []).map(i => [i.id, i]));

    // Fetch assets for SERIALIZED line items
    const serializedItemIds = items
      .filter(i => itemMasterMap.get(i.inventory_item_id)?.tracking_method === 'SERIALIZED')
      .map(i => i.id);

    let assetRows: Array<{
      goods_issue_item_id: string;
      inventory_asset_id:  string;
      inventory_assets:    { serial_number: string; part_number: string | null } | null;
    }> = [];

    if (serializedItemIds.length) {
      const { data: ga } = await supabase
        .from('goods_issue_assets')
        .select('goods_issue_item_id, inventory_asset_id, inventory_assets(serial_number, part_number)')
        .in('goods_issue_item_id', serializedItemIds);
      assetRows = (ga ?? []) as unknown as typeof assetRows;
    }

    // Group assets by line item id
    const assetsByLine = new Map<string, Array<{ assetId: string; serialNumber: string; partNumber: string | null }>>();
    for (const a of assetRows) {
      const list = assetsByLine.get(a.goods_issue_item_id) ?? [];
      list.push({
        assetId:      a.inventory_asset_id,
        serialNumber: a.inventory_assets?.serial_number ?? '—',
        partNumber:   a.inventory_assets?.part_number   ?? null,
      });
      assetsByLine.set(a.goods_issue_item_id, list);
    }

    const details: IssueItemDetail[] = items.map(i => {
      const master = itemMasterMap.get(i.inventory_item_id);
      return {
        id:                i.id,
        inventory_item_id: i.inventory_item_id,
        itemCode:          master?.item_code      ?? '—',
        itemName:          master?.item_name      ?? '—',
        trackingMethod:    master?.tracking_method ?? '—',
        quantity:          i.quantity,
        assets:            assetsByLine.get(i.id) ?? [],
      };
    });

    setItemDetails(details);
    setDetailLoading(false);
  }

  async function cancelIssue(issue: IssueRow) {
    if (!window.confirm(`Cancel issue ${issue.issue_number}? This cannot be undone.`)) return;
    setCancelling(true);
    const { error: e } = await supabase
      .from('goods_issues')
      .update({ status: 'CANCELLED' })
      .eq('id', issue.id)
      .eq('status', 'DRAFT');
    setCancelling(false);
    if (e) { showToast(e.message, false); return; }
    showToast(`${issue.issue_number} cancelled`, true);
    setSelected(null);
    load(page);
  }

  const displayed = issues.filter(i => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      i.issue_number.toLowerCase().includes(q)       ||
      i.warehouseName.toLowerCase().includes(q)      ||
      i.projectName.toLowerCase().includes(q)        ||
      i.destination_label.toLowerCase().includes(q)
    );
  });

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className={css.page}>
      <div className={css.pageHdr}>
        <div>
          <h1 className={css.pageTitle}>Issue History</h1>
          <p className={css.pageSubtitle}>{total.toLocaleString()} issue{total !== 1 ? 's' : ''} total</p>
        </div>
        <div className={css.hdrActions}>
          {hasPerm('view_warehouse_issue') && (
            <Link to="/warehouse/issue">
              <button className={css.btnAccent}><PlusIcon /> New Issue</button>
            </Link>
          )}
        </div>
      </div>

      {error && <p className={css.errorMsg}>{error}</p>}

      <div className={css.card}>
        <div className={css.toolbar}>
          <div className={css.searchWrap}>
            <SearchIcon className={css.searchIcon} />
            <input
              className={css.searchInput}
              placeholder="Search issue #, warehouse, destination…"
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
          <select className={css.select} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="">All Statuses</option>
            <option value="DRAFT">Draft</option>
            <option value="POSTED">Posted</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
          <input type="date" className={css.select} style={{ width: 130 }} value={dateFrom} onChange={e => setDateFrom(e.target.value)} title="From date" />
          <input type="date" className={css.select} style={{ width: 130 }} value={dateTo}   onChange={e => setDateTo(e.target.value)}   title="To date" />
        </div>

        <div className={css.tableWrap}>
          {loading ? (
            <table><tbody><tr className={css.loadingRow}><td colSpan={7}>Loading…</td></tr></tbody></table>
          ) : !displayed.length ? (
            <div className={css.emptyState}>
              <div className={css.emptyMsg}>No issues found</div>
              <div className={css.emptyHint}>
                {search ? 'No issues match your search.' : 'No goods issues have been created yet.'}
              </div>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Issue #</th>
                  <th>Date</th>
                  <th>Warehouse</th>
                  <th>Project</th>
                  <th>Destination</th>
                  <th>Status</th>
                  <th>Issued By</th>
                </tr>
              </thead>
              <tbody>
                {displayed.map(issue => (
                  <tr key={issue.id} style={{ cursor: 'pointer' }} onClick={() => openDetail(issue)}>
                    <td>
                      <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 12, color: '#6366f1' }}>
                        {issue.issue_number}
                      </span>
                    </td>
                    <td style={{ fontSize: 12 }}>{issue.issue_date}</td>
                    <td style={{ fontSize: 12 }}>{issue.warehouseName}</td>
                    <td style={{ fontSize: 12, color: '#64748b' }}>{issue.projectName}</td>
                    <td style={{ fontSize: 12 }}>
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>{DEST_LABELS[issue.destination_type] ?? issue.destination_type}</div>
                      <div style={{ fontWeight: 600 }}>{issue.destination_label}</div>
                    </td>
                    <td>{statusBadge(issue.status)}</td>
                    <td style={{ fontSize: 12, color: '#64748b' }}>{issue.issued_by}</td>
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
                <button key={n} className={`${css.pageBtn} ${page === n ? css.pageBtnActive : ''}`} onClick={() => setPage(n)}>{n}</button>
              );
            })}
            <button className={css.pageBtn} disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>›</button>
            <span className={css.pageInfo}>{page} / {totalPages}</span>
          </div>
        )}
      </div>

      {/* ── Detail Modal ── */}
      {selected && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget) setSelected(null); }}>
          <div className={`${css.modal} ${css.modalWide}`}>
            <div className={css.modalHdr}>
              <span className={css.modalTitle}>
                {selected.issue_number}
              </span>
              <button className={css.modalClose} onClick={() => setSelected(null)}>×</button>
            </div>

            <div className={css.modalBody}>
              {/* Status */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                {statusBadge(selected.status)}
                <span className={`${css.badge} ${css.badgeBlue}`} style={{ fontSize: 11 }}>
                  {DEST_LABELS[selected.destination_type] ?? selected.destination_type}
                </span>
              </div>

              {/* Header fields */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 18 }}>
                <SF label="Issue Date"   value={selected.issue_date} />
                <SF label="Warehouse"    value={selected.warehouseName} />
                <SF label="Project"      value={selected.projectName} />
                <SF label="Destination"  value={selected.destination_label} />
                <SF label="Issued By"    value={selected.issued_by} />
                {selected.posted_at && <SF label="Posted At" value={new Date(selected.posted_at).toLocaleString()} />}
              </div>

              {selected.notes && (
                <div style={{ background: '#f8fafc', borderRadius: 8, padding: 12, border: '1px solid #e2e8f0', marginBottom: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 4 }}>Notes</div>
                  <div style={{ fontSize: 13, color: '#475569' }}>{selected.notes}</div>
                </div>
              )}

              {/* Line items */}
              <div style={{ fontSize: 12, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8 }}>
                Line Items
              </div>
              {detailLoading ? (
                <p style={{ fontSize: 13, color: '#94a3b8' }}>Loading items…</p>
              ) : itemDetails.length === 0 ? (
                <p style={{ fontSize: 13, color: '#94a3b8' }}>No items found</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {itemDetails.map(line => (
                    <div key={line.id} style={{ border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: '#f8fafc' }}>
                        <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 12 }}>{line.itemCode}</span>
                        <span style={{ fontSize: 12, color: '#64748b', flex: 1 }}>{line.itemName}</span>
                        <span className={`${css.badge} ${line.trackingMethod === 'SERIALIZED' ? css.badgePurple : css.badgeBlue}`} style={{ fontSize: 10 }}>
                          {line.trackingMethod}
                        </span>
                        <span style={{ fontSize: 12, fontWeight: 700 }}>Qty: {line.quantity}</span>
                      </div>
                      {line.trackingMethod === 'SERIALIZED' && line.assets.length > 0 && (
                        <div style={{ padding: '8px 12px' }}>
                          {line.assets.map(a => (
                            <div key={a.assetId} style={{ display: 'flex', gap: 16, padding: '3px 0', borderBottom: '1px solid #f1f5f9' }}>
                              <span style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700 }}>{a.serialNumber}</span>
                              <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#94a3b8' }}>{a.partNumber ?? '—'}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className={css.modalFtr}>
              {hasPerm('wrh_issue_cancel') && canCancelIssue(selected.status) && (
                <button
                  className={css.btnDanger}
                  onClick={() => cancelIssue(selected)}
                  disabled={cancelling}
                >
                  {cancelling ? 'Cancelling…' : 'Cancel Issue'}
                </button>
              )}
              <button className={css.btnGhost} onClick={() => setSelected(null)}>Close</button>
            </div>
          </div>
        </div>,
        document.body,
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

function PlusIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>;
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  );
}
