import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import css from './FinBilling.module.css';

interface Client {
  id: string;
  company_name: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
}

interface ClientForm {
  company_name: string;
  contact_person: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
}

const EMPTY_FORM: ClientForm = { company_name: '', contact_person: '', phone: '', email: '', address: '', notes: '' };

export default function FinClients() {
  const { hasPerm } = useAuth();
  const [clients, setClients]   = useState<Client[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error,   setError]     = useState('');
  const [modal,   setModal]     = useState(false);
  const [editId,  setEditId]    = useState<string | null>(null);
  const [form,    setForm]      = useState<ClientForm>(EMPTY_FORM);
  const [formErr, setFormErr]   = useState('');
  const [toast,   setToast]     = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!hasPerm('view_fin_clients')) return <div className={css.errorMsg}>Access denied.</div>;

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }

  async function load() {
    setLoading(true);
    const { data, error: e } = await supabase.from('clients').select('*').order('company_name');
    if (e) { setError(e.message); } else { setClients(data || []); }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function openAdd() {
    setEditId(null);
    setForm(EMPTY_FORM);
    setFormErr('');
    setModal(true);
  }

  function openEdit(c: Client) {
    setEditId(c.id);
    setForm({ company_name: c.company_name || '', contact_person: c.contact_person || '', phone: c.phone || '', email: c.email || '', address: c.address || '', notes: c.notes || '' });
    setFormErr('');
    setModal(true);
  }

  async function save() {
    setFormErr('');
    const name = form.company_name.trim();
    if (!name) { setFormErr('Company name is required.'); return; }
    const payload = {
      company_name:   name,
      contact_person: form.contact_person.trim() || null,
      phone:          form.phone.trim()           || null,
      email:          form.email.trim()           || null,
      address:        form.address.trim()         || null,
      notes:          form.notes.trim()           || null,
    };
    if (editId) {
      const { error: e } = await supabase.from('clients').update(payload).eq('id', editId);
      if (e) { setFormErr(e.message); return; }
      setClients(cs => cs.map(c => c.id === editId ? { ...c, ...payload } : c));
      showToast('Client updated.', true);
    } else {
      const { data, error: e } = await supabase.from('clients').insert(payload).select('*').single();
      if (e) { setFormErr(e.message); return; }
      setClients(cs => [data, ...cs]);
      showToast('Client added!', true);
    }
    setModal(false);
  }

  async function del(id: string) {
    if (!window.confirm('Delete this client? This will not delete their invoices.')) return;
    const { error: e } = await supabase.from('clients').delete().eq('id', id);
    if (e) { showToast(e.message, false); return; }
    setClients(cs => cs.filter(c => c.id !== id));
    showToast('Client deleted.', true);
  }

  if (loading) return <div className={css.placeholder}>Loading…</div>;
  if (error)   return <div className={css.errorMsg}>{error}</div>;

  return (
    <div className={css.page}>
      <div className={css.pageHdr}>
        <div className={css.pageTitle}>Clients</div>
        <div className={css.hdrActions}>
          <button className={css.btnGhost} onClick={load}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Refresh
          </button>
          <button className={css.btnAccent} onClick={openAdd}>+ Add Client</button>
        </div>
      </div>

      <div className={css.tableWrap}>
        <table className={css.table}>
          <thead><tr>
            <th>Company</th><th>Contact Person</th><th>Email</th><th>Phone</th><th>Address</th><th>Notes</th><th>Actions</th>
          </tr></thead>
          <tbody>
            {clients.length === 0
              ? <tr><td colSpan={7} className={css.empty}>No clients yet. Click "+ Add Client" to add your first client.</td></tr>
              : clients.map(c => (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 600 }}>{c.company_name}</td>
                    <td>{c.contact_person || '—'}</td>
                    <td style={{ fontSize: 12 }}>{c.email || '—'}</td>
                    <td style={{ fontSize: 12 }}>{c.phone || '—'}</td>
                    <td style={{ fontSize: 12, color: '#64748b' }}>{c.address || '—'}</td>
                    <td style={{ fontSize: 12, color: '#64748b', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.notes || '—'}</td>
                    <td>
                      <div className={css.actWrap}>
                        <button className={css.actBtn} title="Edit" onClick={() => openEdit(c)}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                        </button>
                        <button className={`${css.actBtn} ${css.actBtnDel}`} title="Delete" onClick={() => del(c.id)}>
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

      {/* Add/Edit Modal */}
      {modal && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget) setModal(false); }}>
          <div className={css.modal}>
            <div className={css.modalTitle}>{editId ? 'Edit Client' : 'Add Client'}</div>
            <div className={css.formGrid}>
              <div className={`${css.formField} ${css.span2}`}>
                <label>Company Name *</label>
                <input className={css.formInput} placeholder="e.g. TAC, Nokia Iraq…" maxLength={100}
                  value={form.company_name} onChange={e => setForm(f => ({ ...f, company_name: e.target.value }))} />
              </div>
              <div className={css.formField}>
                <label>Contact Person</label>
                <input className={css.formInput} placeholder="Full name…" maxLength={100}
                  value={form.contact_person} onChange={e => setForm(f => ({ ...f, contact_person: e.target.value }))} />
              </div>
              <div className={css.formField}>
                <label>Phone</label>
                <input className={css.formInput} placeholder="+964…" maxLength={30}
                  value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
              </div>
              <div className={`${css.formField} ${css.span2}`}>
                <label>Email</label>
                <input type="email" className={css.formInput} placeholder="billing@company.com" maxLength={100}
                  value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
              </div>
              <div className={`${css.formField} ${css.span2}`}>
                <label>Address</label>
                <input className={css.formInput} placeholder="City, Country…" maxLength={200}
                  value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} />
              </div>
              <div className={`${css.formField} ${css.span2}`}>
                <label>Notes</label>
                <textarea className={css.formTextarea} rows={2} placeholder="Optional…"
                  value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
              </div>
            </div>
            {formErr && <div className={css.modalErr}>{formErr}</div>}
            <div className={css.modalActions}>
              <button className={css.btnCancel} onClick={() => setModal(false)}>Cancel</button>
              <button className={css.btnSave}   onClick={save}>Save</button>
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
