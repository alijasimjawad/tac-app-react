import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import type { InventoryItem } from '../lib/warehouseTypes';
import css from './Warehouse.module.css';

type TrackingMethod = 'SERIALIZED' | 'QUANTITY';

interface ItemForm {
  item_code: string;
  item_name: string;
  item_type: string;
  manufacturer: string;
  part_number: string;
  category: string;
  tracking_method: TrackingMethod;
  unit: string;
  is_active: boolean;
  notes: string;
}

const EMPTY_FORM: ItemForm = {
  item_code: '', item_name: '', item_type: '', manufacturer: '',
  part_number: '', category: '', tracking_method: 'SERIALIZED',
  unit: 'pcs', is_active: true, notes: '',
};

const CATEGORIES = ['Radio', 'Antenna', 'Cable', 'Power', 'Fiber', 'Hardware', 'Tools', 'Other'];
const ITEM_TYPES  = ['Nokia', 'Huawei', 'Ericsson', 'Generic', 'Consumable', 'Other'];

export default function WarehouseInventory() {
  const { hasPerm, currentUser } = useAuth();
  const [items,   setItems]   = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [search,  setSearch]  = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [trackFilter, setTrackFilter] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  const [modal,     setModal]     = useState(false);
  const [editId,    setEditId]    = useState<string | null>(null);
  const [form,      setForm]      = useState<ItemForm>(EMPTY_FORM);
  const [formErr,   setFormErr]   = useState('');
  const [saving,    setSaving]    = useState(false);

  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!hasPerm('view_warehouse_inventory')) return <div className={css.denied}>Access denied.</div>;

  const canAdd  = hasPerm('wrh_items_add');
  const canEdit = hasPerm('wrh_items_edit');

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  async function load() {
    setLoading(true);
    setError('');
    const q = supabase.from('inventory_items').select('*').order('item_name');
    const { data, error: e } = await q;
    if (e) { setError(e.message); setLoading(false); return; }
    setItems(data as InventoryItem[]);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  const filtered = items.filter(it => {
    if (!showInactive && !it.is_active) return false;
    if (catFilter && it.category !== catFilter) return false;
    if (trackFilter && it.tracking_method !== trackFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        it.item_code.toLowerCase().includes(q) ||
        it.item_name.toLowerCase().includes(q) ||
        (it.manufacturer || '').toLowerCase().includes(q) ||
        (it.part_number  || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  function openAdd() {
    setEditId(null);
    setForm(EMPTY_FORM);
    setFormErr('');
    setModal(true);
  }

  function openEdit(item: InventoryItem) {
    setEditId(item.id);
    setForm({
      item_code:        item.item_code,
      item_name:        item.item_name,
      item_type:        item.item_type || '',
      manufacturer:     item.manufacturer || '',
      part_number:      item.part_number || '',
      category:         item.category || '',
      tracking_method:  item.tracking_method,
      unit:             item.unit,
      is_active:        item.is_active,
      notes:            item.notes || '',
    });
    setFormErr('');
    setModal(true);
  }

  async function saveItem() {
    setFormErr('');
    const code = form.item_code.trim().toUpperCase();
    const name = form.item_name.trim();
    if (!code) { setFormErr('Item code is required.'); return; }
    if (!name) { setFormErr('Item name is required.'); return; }
    if (!form.unit.trim()) { setFormErr('Unit is required.'); return; }

    setSaving(true);
    const payload = {
      item_code:       code,
      item_name:       name,
      item_type:       form.item_type.trim() || null,
      manufacturer:    form.manufacturer.trim() || null,
      part_number:     form.part_number.trim() || null,
      category:        form.category || null,
      tracking_method: form.tracking_method,
      unit:            form.unit.trim(),
      is_active:       form.is_active,
      notes:           form.notes.trim() || null,
    };

    let err;
    if (editId) {
      ({ error: err } = await supabase.from('inventory_items').update(payload).eq('id', editId));
    } else {
      ({ error: err } = await supabase.from('inventory_items').insert(payload));
    }
    setSaving(false);

    if (err) {
      if (err.code === '23505') setFormErr('Item code already exists. Use a unique code.');
      else setFormErr(err.message);
      return;
    }

    if (currentUser) {
      await supabase.from('activity_log').insert({
        user_full_name: currentUser.full_name,
        action:         editId ? `Updated inventory item: ${name}` : `Created inventory item: ${name}`,
      });
    }

    showToast(editId ? 'Item updated.' : 'Item created.', true);
    setModal(false);
    load();
  }

  async function toggleActive(item: InventoryItem) {
    if (!canEdit) return;
    const { error: e } = await supabase
      .from('inventory_items')
      .update({ is_active: !item.is_active })
      .eq('id', item.id);
    if (e) { showToast(e.message, false); return; }
    showToast(item.is_active ? 'Item deactivated.' : 'Item reactivated.', true);
    load();
  }

  return (
    <div className={css.page}>
      <div className={css.pageHdr}>
        <div>
          <h1 className={css.pageTitle}>Item Master</h1>
          <p className={css.pageSubtitle}>Define trackable inventory items</p>
        </div>
        <div className={css.hdrActions}>
          {canAdd && (
            <button className={css.btnAccent} onClick={openAdd}>
              <PlusIcon /> Add Item
            </button>
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
              placeholder="Search by code, name, part number…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <select className={css.select} value={catFilter} onChange={e => setCatFilter(e.target.value)}>
            <option value="">All Categories</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className={css.select} value={trackFilter} onChange={e => setTrackFilter(e.target.value)}>
            <option value="">All Tracking</option>
            <option value="SERIALIZED">Serialized</option>
            <option value="QUANTITY">Quantity</option>
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#64748b', cursor: 'pointer' }}>
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
            Show inactive
          </label>
        </div>

        <div className={css.tableWrap}>
          {loading ? (
            <table><tbody><tr className={css.loadingRow}><td colSpan={8}>Loading…</td></tr></tbody></table>
          ) : !filtered.length ? (
            <div className={css.emptyState}>
              <div className={css.emptyMsg}>No items found</div>
              <div className={css.emptyHint}>{search ? 'Try a different search.' : 'Add your first inventory item.'}</div>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Type / Mfr</th>
                  <th>Part #</th>
                  <th>Category</th>
                  <th>Tracking</th>
                  <th>Unit</th>
                  <th style={{ width: 80 }}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(it => (
                  <tr key={it.id} style={{ opacity: it.is_active ? 1 : .5 }}>
                    <td style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 12 }}>{it.item_code}</td>
                    <td style={{ fontWeight: 600 }}>{it.item_name}</td>
                    <td style={{ color: '#64748b', fontSize: 12 }}>
                      {[it.item_type, it.manufacturer].filter(Boolean).join(' / ') || '—'}
                    </td>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{it.part_number || '—'}</td>
                    <td>
                      {it.category ? (
                        <span className={`${css.badge} ${css.badgeSlate}`}>{it.category}</span>
                      ) : '—'}
                    </td>
                    <td>
                      <span className={`${css.badge} ${it.tracking_method === 'SERIALIZED' ? css.badgePurple : css.badgeBlue}`}>
                        {it.tracking_method === 'SERIALIZED' ? 'Serialized' : 'Quantity'}
                      </span>
                    </td>
                    <td style={{ fontSize: 12, color: '#64748b' }}>{it.unit}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {canEdit && (
                          <button className={css.btnIcon} title="Edit" onClick={() => openEdit(it)}>
                            <EditIcon />
                          </button>
                        )}
                        {canEdit && (
                          <button
                            className={css.btnIcon}
                            title={it.is_active ? 'Deactivate' : 'Reactivate'}
                            onClick={() => toggleActive(it)}
                          >
                            {it.is_active ? <EyeOffIcon /> : <EyeIcon />}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {modal && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget) setModal(false); }}>
          <div className={css.modal}>
            <div className={css.modalHdr}>
              <span className={css.modalTitle}>{editId ? 'Edit Item' : 'Add Inventory Item'}</span>
              <button className={css.modalClose} onClick={() => setModal(false)}>×</button>
            </div>
            <div className={css.modalBody}>
              <div className={css.fieldset}>
                <div className={css.fieldRow}>
                  <div className={css.field}>
                    <label className={css.label}>Item Code *</label>
                    <input className={css.input} value={form.item_code} style={{ textTransform: 'uppercase' }}
                      onChange={e => setForm(f => ({ ...f, item_code: e.target.value.toUpperCase() }))}
                      placeholder="e.g. ABIO" />
                  </div>
                  <div className={css.field}>
                    <label className={css.label}>Item Name *</label>
                    <input className={css.input} value={form.item_name}
                      onChange={e => setForm(f => ({ ...f, item_name: e.target.value }))}
                      placeholder="e.g. Nokia ABIO-B1" />
                  </div>
                </div>
                <div className={css.fieldRow}>
                  <div className={css.field}>
                    <label className={css.label}>Manufacturer</label>
                    <input className={css.input} value={form.manufacturer}
                      onChange={e => setForm(f => ({ ...f, manufacturer: e.target.value }))}
                      placeholder="Nokia, Huawei, Ericsson…" list="mfr-list" />
                    <datalist id="mfr-list">
                      {['Nokia', 'Huawei', 'Ericsson', 'ZTE', 'Commscope', 'Generic'].map(m => <option key={m} value={m} />)}
                    </datalist>
                  </div>
                  <div className={css.field}>
                    <label className={css.label}>Part Number</label>
                    <input className={css.input} value={form.part_number}
                      onChange={e => setForm(f => ({ ...f, part_number: e.target.value }))}
                      placeholder="Manufacturer part #" />
                  </div>
                </div>
                <div className={css.fieldRow}>
                  <div className={css.field}>
                    <label className={css.label}>Item Type</label>
                    <input className={css.input} value={form.item_type}
                      onChange={e => setForm(f => ({ ...f, item_type: e.target.value }))}
                      placeholder="Nokia, Huawei, Cable…" list="type-list" />
                    <datalist id="type-list">
                      {ITEM_TYPES.map(t => <option key={t} value={t} />)}
                    </datalist>
                  </div>
                  <div className={css.field}>
                    <label className={css.label}>Category</label>
                    <select className={`${css.input} ${css.fieldSelect}`} value={form.category}
                      onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
                      <option value="">— Select —</option>
                      {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                </div>
                <div className={css.fieldRow}>
                  <div className={css.field}>
                    <label className={css.label}>Tracking Method</label>
                    <select className={`${css.input} ${css.fieldSelect}`} value={form.tracking_method}
                      onChange={e => setForm(f => ({ ...f, tracking_method: e.target.value as TrackingMethod }))}>
                      <option value="SERIALIZED">Serialized (per serial number)</option>
                      <option value="QUANTITY">Quantity (bulk count)</option>
                    </select>
                  </div>
                  <div className={css.field}>
                    <label className={css.label}>Unit *</label>
                    <input className={css.input} value={form.unit}
                      onChange={e => setForm(f => ({ ...f, unit: e.target.value }))}
                      placeholder="pcs, m, kg…" list="unit-list" />
                    <datalist id="unit-list">
                      {['pcs', 'units', 'm', 'km', 'kg', 'box', 'roll'].map(u => <option key={u} value={u} />)}
                    </datalist>
                  </div>
                </div>
                <div className={css.field}>
                  <label className={css.label}>Notes</label>
                  <textarea className={`${css.input} ${css.textarea}`} value={form.notes}
                    onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                    placeholder="Optional notes about this item…" rows={2} />
                </div>
                <div className={css.switchRow}>
                  <label className={css.switch}>
                    <input type="checkbox" checked={form.is_active}
                      onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} />
                    <span className={css.switchSlider} />
                  </label>
                  <span style={{ fontSize: 13, color: '#475569' }}>Active</span>
                </div>
                {formErr && <p className={css.formError}>{formErr}</p>}
              </div>
            </div>
            <div className={css.modalFtr}>
              <button className={css.btnGhost} onClick={() => setModal(false)}>Cancel</button>
              <button className={css.btnAccent} onClick={saveItem} disabled={saving}>
                {saving ? 'Saving…' : editId ? 'Save Changes' : 'Create Item'}
              </button>
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

function PlusIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>; }
function SearchIcon({ className }: { className?: string }) { return <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>; }
function EditIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>; }
function EyeOffIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>; }
function EyeIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>; }
