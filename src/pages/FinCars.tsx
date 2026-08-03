import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { invalidateCars } from '../lib/carsCache';
import { invalidateSavedPoints } from '../lib/savedPointsCache';
import { ensureCarKmRateLoaded, getCarKmRate, saveCarKmRate } from '../lib/carSettingsCache';
import css from './FinBilling.module.css';

interface TeamMember { id: string; full_name: string; }

interface Car {
  id: string;
  name: string;
  plate_number: string | null;
  owner_id: string | null;
  is_active: boolean;
}

interface CarForm { name: string; plate_number: string; owner_id: string; is_active: boolean; }
const EMPTY_CAR_FORM: CarForm = { name: '', plate_number: '', owner_id: '', is_active: true };

interface SavedPoint {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  is_active: boolean;
}

interface PointForm { name: string; latitude: string; longitude: string; is_active: boolean; }
const EMPTY_POINT_FORM: PointForm = { name: '', latitude: '', longitude: '', is_active: true };

export default function FinCars() {
  const { hasPerm } = useAuth();

  const [cars,   setCars]   = useState<Car[]>([]);
  const [points, setPoints] = useState<SavedPoint[]>([]);
  const [team,   setTeam]   = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  const [carModal, setCarModal] = useState(false);
  const [carEditId, setCarEditId] = useState<string | null>(null);
  const [carForm, setCarForm] = useState<CarForm>(EMPTY_CAR_FORM);
  const [carFormErr, setCarFormErr] = useState('');

  const [pointModal, setPointModal] = useState(false);
  const [pointEditId, setPointEditId] = useState<string | null>(null);
  const [pointForm, setPointForm] = useState<PointForm>(EMPTY_POINT_FORM);
  const [pointFormErr, setPointFormErr] = useState('');

  const [rateInput, setRateInput] = useState('275');
  const [rateSaving, setRateSaving] = useState(false);

  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!hasPerm('view_fin_cars')) return <div className={css.errorMsg}>Access denied.</div>;

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }

  async function load() {
    setLoading(true);
    setError('');
    const [carsRes, pointsRes, teamRes] = await Promise.all([
      supabase.from('cars').select('*').order('name'),
      supabase.from('saved_points').select('*').order('name'),
      supabase.from('team_members').select('id, full_name'),
      ensureCarKmRateLoaded(),
    ]);
    if (carsRes.error) { setError(carsRes.error.message); setLoading(false); return; }
    setCars(carsRes.data || []);
    if (pointsRes.data) setPoints(pointsRes.data);
    if (teamRes.data) setTeam(teamRes.data as TeamMember[]);
    setRateInput(String(getCarKmRate()));
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function memberName(id: string | null): string {
    if (!id) return '—';
    return team.find(t => t.id === id)?.full_name || '—';
  }

  // ── KM Rate ────────────────────────────────────────────────────────────
  async function submitRate() {
    const n = parseFloat(rateInput);
    if (isNaN(n) || n <= 0) { showToast('Enter a valid rate greater than 0.', false); return; }
    setRateSaving(true);
    const { error: e } = await saveCarKmRate(n);
    setRateSaving(false);
    if (e) { showToast(e, false); return; }
    showToast('KM rate updated.', true);
  }

  // ── Cars ───────────────────────────────────────────────────────────────
  function openAddCar() {
    setCarEditId(null);
    setCarForm(EMPTY_CAR_FORM);
    setCarFormErr('');
    setCarModal(true);
  }

  function openEditCar(c: Car) {
    setCarEditId(c.id);
    setCarForm({ name: c.name || '', plate_number: c.plate_number || '', owner_id: c.owner_id || '', is_active: c.is_active });
    setCarFormErr('');
    setCarModal(true);
  }

  async function saveCar() {
    setCarFormErr('');
    const name = carForm.name.trim();
    if (!name) { setCarFormErr('Car name is required.'); return; }
    const payload = {
      name,
      plate_number: carForm.plate_number.trim() || null,
      owner_id:     carForm.owner_id || null,
      is_active:    carForm.is_active,
    };
    if (carEditId) {
      const { error: e } = await supabase.from('cars').update(payload).eq('id', carEditId);
      if (e) { setCarFormErr(e.message); return; }
      setCars(cs => cs.map(c => c.id === carEditId ? { ...c, ...payload } : c));
      showToast('Car updated.', true);
    } else {
      const { data, error: e } = await supabase.from('cars').insert(payload).select('*').single();
      if (e) { setCarFormErr(e.message); return; }
      setCars(cs => [...cs, data].sort((a, b) => a.name.localeCompare(b.name)));
      showToast('Car added!', true);
    }
    invalidateCars();
    setCarModal(false);
  }

  async function deleteCar(id: string) {
    if (!window.confirm('Delete this car? Past activities referencing it will keep their saved trip data.')) return;
    const { error: e } = await supabase.from('cars').delete().eq('id', id);
    if (e) { showToast(e.message, false); return; }
    setCars(cs => cs.filter(c => c.id !== id));
    invalidateCars();
    showToast('Car deleted.', true);
  }

  // ── Saved Points ───────────────────────────────────────────────────────
  function openAddPoint() {
    setPointEditId(null);
    setPointForm(EMPTY_POINT_FORM);
    setPointFormErr('');
    setPointModal(true);
  }

  function openEditPoint(p: SavedPoint) {
    setPointEditId(p.id);
    setPointForm({ name: p.name || '', latitude: String(p.latitude), longitude: String(p.longitude), is_active: p.is_active });
    setPointFormErr('');
    setPointModal(true);
  }

  async function savePoint() {
    setPointFormErr('');
    const name = pointForm.name.trim();
    const lat = parseFloat(pointForm.latitude);
    const lng = parseFloat(pointForm.longitude);
    if (!name) { setPointFormErr('Point name is required.'); return; }
    if (isNaN(lat) || isNaN(lng)) { setPointFormErr('Valid latitude and longitude are required.'); return; }
    const payload = { name, latitude: lat, longitude: lng, is_active: pointForm.is_active };
    if (pointEditId) {
      const { error: e } = await supabase.from('saved_points').update(payload).eq('id', pointEditId);
      if (e) { setPointFormErr(e.message); return; }
      setPoints(ps => ps.map(p => p.id === pointEditId ? { ...p, ...payload } : p));
      showToast('Saved point updated.', true);
    } else {
      const { data, error: e } = await supabase.from('saved_points').insert(payload).select('*').single();
      if (e) { setPointFormErr(e.message); return; }
      setPoints(ps => [...ps, data].sort((a, b) => a.name.localeCompare(b.name)));
      showToast('Saved point added!', true);
    }
    invalidateSavedPoints();
    setPointModal(false);
  }

  async function deletePoint(id: string) {
    if (!window.confirm('Delete this saved point?')) return;
    const { error: e } = await supabase.from('saved_points').delete().eq('id', id);
    if (e) { showToast(e.message, false); return; }
    setPoints(ps => ps.filter(p => p.id !== id));
    invalidateSavedPoints();
    showToast('Saved point deleted.', true);
  }

  if (loading) return <div className={css.placeholder}>Loading…</div>;
  if (error)   return <div className={css.errorMsg}>{error}</div>;

  return (
    <div className={css.page}>
      <div className={css.pageHdr}>
        <div className={css.pageTitle}>Cars &amp; Trips</div>
        <div className={css.hdrActions}>
          <button className={css.btnGhost} onClick={load}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Refresh
          </button>
        </div>
      </div>

      {/* ── KM Rate ─────────────────────────────────────────────── */}
      {hasPerm('fin_cars_edit_rate') && (
        <div className={css.formGrid} style={{ marginBottom: 24, maxWidth: 360 }}>
          <div className={css.formField}>
            <label>Car KM Rate (IQD per km)</label>
            <input
              className={css.formInput}
              type="number"
              min="0"
              step="1"
              value={rateInput}
              onChange={e => setRateInput(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button className={css.btnSave} disabled={rateSaving} onClick={submitRate}>
              {rateSaving ? 'Saving…' : 'Save Rate'}
            </button>
          </div>
        </div>
      )}

      {/* ── Cars table ──────────────────────────────────────────── */}
      <div className={css.pageHdr} style={{ marginTop: 8 }}>
        <div className={css.pageTitle} style={{ fontSize: 16 }}>Cars</div>
        {hasPerm('fin_cars_add') && (
          <button className={css.btnAccent} onClick={openAddCar}>+ Add Car</button>
        )}
      </div>
      <div className={css.tableWrap}>
        <table className={css.table}>
          <thead><tr>
            <th>Name</th><th>Plate Number</th><th>Owner / Default Driver</th><th>Status</th><th>Actions</th>
          </tr></thead>
          <tbody>
            {cars.length === 0
              ? <tr><td colSpan={5} className={css.empty}>No cars yet. Click "+ Add Car" to add your first vehicle.</td></tr>
              : cars.map(c => (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 600 }}>{c.name}</td>
                    <td>{c.plate_number || '—'}</td>
                    <td>{memberName(c.owner_id)}</td>
                    <td>
                      <span className={css.statusBadge} style={{ background: c.is_active ? '#dcfce7' : '#f1f5f9', color: c.is_active ? '#16a34a' : '#94a3b8' }}>
                        {c.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td>
                      <div className={css.actWrap}>
                        {hasPerm('fin_cars_edit') && (
                          <button className={css.actBtn} title="Edit" onClick={() => openEditCar(c)}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                          </button>
                        )}
                        {hasPerm('fin_cars_delete') && (
                          <button className={`${css.actBtn} ${css.actBtnDel}`} title="Delete" onClick={() => deleteCar(c.id)}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
            }
          </tbody>
        </table>
      </div>

      {/* ── Saved Points table ──────────────────────────────────── */}
      {hasPerm('fin_cars_manage_points') && (<>
        <div className={css.pageHdr} style={{ marginTop: 28 }}>
          <div className={css.pageTitle} style={{ fontSize: 16 }}>Saved Points</div>
          <button className={css.btnAccent} onClick={openAddPoint}>+ Add Point</button>
        </div>
        <div className={css.tableWrap}>
          <table className={css.table}>
            <thead><tr>
              <th>Name</th><th>Latitude</th><th>Longitude</th><th>Status</th><th>Actions</th>
            </tr></thead>
            <tbody>
              {points.length === 0
                ? <tr><td colSpan={5} className={css.empty}>No saved points yet. These are optional shortcuts for common trip start locations — manual entry always works too.</td></tr>
                : points.map(p => (
                    <tr key={p.id}>
                      <td style={{ fontWeight: 600 }}>{p.name}</td>
                      <td>{p.latitude}</td>
                      <td>{p.longitude}</td>
                      <td>
                        <span className={css.statusBadge} style={{ background: p.is_active ? '#dcfce7' : '#f1f5f9', color: p.is_active ? '#16a34a' : '#94a3b8' }}>
                          {p.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td>
                        <div className={css.actWrap}>
                          <button className={css.actBtn} title="Edit" onClick={() => openEditPoint(p)}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                          </button>
                          <button className={`${css.actBtn} ${css.actBtnDel}`} title="Delete" onClick={() => deletePoint(p.id)}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
              }
            </tbody>
          </table>
        </div>
      </>)}

      {/* ── Add/Edit Car Modal ──────────────────────────────────── */}
      {carModal && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget) setCarModal(false); }}>
          <div className={css.modal}>
            <div className={css.modalTitle}>{carEditId ? 'Edit Car' : 'Add Car'}</div>
            <div className={css.formGrid}>
              <div className={`${css.formField} ${css.span2}`}>
                <label>Car Name *</label>
                <input className={css.formInput} placeholder="e.g. Hilux - White" maxLength={100}
                  value={carForm.name} onChange={e => setCarForm(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div className={css.formField}>
                <label>Plate Number</label>
                <input className={css.formInput} placeholder="e.g. 12345 - Baghdad" maxLength={40}
                  value={carForm.plate_number} onChange={e => setCarForm(f => ({ ...f, plate_number: e.target.value }))} />
              </div>
              <div className={css.formField}>
                <label>Owner / Default Driver</label>
                <select className={css.formSel} value={carForm.owner_id} onChange={e => setCarForm(f => ({ ...f, owner_id: e.target.value }))}>
                  <option value="">— None —</option>
                  {team.map(m => <option key={m.id} value={m.id}>{m.full_name}</option>)}
                </select>
              </div>
              <div className={css.formField}>
                <label>Status</label>
                <select className={css.formSel} value={carForm.is_active ? '1' : '0'} onChange={e => setCarForm(f => ({ ...f, is_active: e.target.value === '1' }))}>
                  <option value="1">Active</option>
                  <option value="0">Inactive</option>
                </select>
              </div>
            </div>
            {carFormErr && <div className={css.modalErr}>{carFormErr}</div>}
            <div className={css.modalActions}>
              <button className={css.btnCancel} onClick={() => setCarModal(false)}>Cancel</button>
              <button className={css.btnSave}   onClick={saveCar}>Save</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── Add/Edit Saved Point Modal ──────────────────────────── */}
      {pointModal && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget) setPointModal(false); }}>
          <div className={css.modal}>
            <div className={css.modalTitle}>{pointEditId ? 'Edit Saved Point' : 'Add Saved Point'}</div>
            <div className={css.formGrid}>
              <div className={`${css.formField} ${css.span2}`}>
                <label>Point Name *</label>
                <input className={css.formInput} placeholder="e.g. Baghdad Warehouse" maxLength={100}
                  value={pointForm.name} onChange={e => setPointForm(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div className={css.formField}>
                <label>Latitude *</label>
                <input className={css.formInput} type="number" step="any" placeholder="33.3152"
                  value={pointForm.latitude} onChange={e => setPointForm(f => ({ ...f, latitude: e.target.value }))} />
              </div>
              <div className={css.formField}>
                <label>Longitude *</label>
                <input className={css.formInput} type="number" step="any" placeholder="44.3661"
                  value={pointForm.longitude} onChange={e => setPointForm(f => ({ ...f, longitude: e.target.value }))} />
              </div>
              <div className={css.formField}>
                <label>Status</label>
                <select className={css.formSel} value={pointForm.is_active ? '1' : '0'} onChange={e => setPointForm(f => ({ ...f, is_active: e.target.value === '1' }))}>
                  <option value="1">Active</option>
                  <option value="0">Inactive</option>
                </select>
              </div>
            </div>
            {pointFormErr && <div className={css.modalErr}>{pointFormErr}</div>}
            <div className={css.modalActions}>
              <button className={css.btnCancel} onClick={() => setPointModal(false)}>Cancel</button>
              <button className={css.btnSave}   onClick={savePoint}>Save</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {toast && createPortal(
        <div className={`${css.toast} ${toast.ok ? css.toastOk : css.toastErr}`}>{toast.msg}</div>,
        document.body
      )}
    </div>
  );
}
