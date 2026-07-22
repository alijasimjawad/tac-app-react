import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { FIN_PROJECTS, iqd } from '../lib/finHelpers';
import css from './FinBilling.module.css';

// ── Types ─────────────────────────────────────────────────────
interface Client {
  id: string;
  company_name: string;
  contact_person: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
}

interface Invoice {
  id: string;
  invoice_number: string | null;
  client_id: string;
  project_name: string | null;
  status: string;
  issue_date: string | null;
  due_date: string | null;
  total_amount: number;
  amount_received: number;
  notes: string | null;
  created_by: string | null;
}

interface InvoiceItem {
  id: string;
  invoice_id: string;
  site_id: string | null;
  section_name: string | null;
  description: string | null;
  amount: number;
  revenue_id: string | null;
}

interface Payment {
  id: string;
  invoice_id: string;
  payment_date: string | null;
  amount: number;
  reference: string | null;
  notes: string | null;
  recorded_by: string | null;
}

interface RevRow {
  id: string;
  project_name: string | null;
  section_name: string | null;
  site_id: string | null;
  amount: number | null;
  status: string | null;
}

interface LineItem {
  site_id: string | null;
  section_name: string | null;
  description: string | null;
  amount: number;
  revenue_id: string | null;
  _customId?: number;
}

// ── Status helpers ────────────────────────────────────────────
const STATUS_COLOR: Record<string, string> = {
  Draft: '#f1f5f9', Sent: '#dbeafe', Partial: '#fef3c7', Paid: '#dcfce7', Overdue: '#fee2e2',
};
const STATUS_TEXT: Record<string, string> = {
  Draft: '#475569', Sent: '#1d4ed8', Partial: '#b45309', Paid: '#16a34a', Overdue: '#dc2626',
};
const STATUS_PILL_ACTIVE: Record<string, string> = {
  '': '#1d4ed8', Draft: '#475569', Sent: '#1d4ed8', Partial: '#b45309', Paid: '#16a34a', Overdue: '#dc2626',
};

// ── Print helper ──────────────────────────────────────────────
function printInvoice(inv: Invoice, client: Client | undefined, items: InvoiceItem[], payments: Payment[]) {
  const outstanding = (+inv.total_amount || 0) - (+inv.amount_received || 0);
  const statusColor = STATUS_TEXT[inv.status] || '#475569';
  const statusBg    = STATUS_COLOR[inv.status] || '#f1f5f9';
  const fmt = (v: number | null | undefined) => (+(v ?? 0)).toLocaleString('en-IQ') + ' IQD';
  const e   = (s: string | null | undefined) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const itemsRows = items.length === 0
    ? '<tr><td colspan="4" style="text-align:center;color:#94a3b8;padding:16px">No line items.</td></tr>'
    : items.map((item, i) => `<tr style="background:${i % 2 === 0 ? '#fff' : '#f8fafc'}">
        <td>${e(item.section_name)}</td>
        <td style="font-weight:600">${e(String(item.site_id || '—'))}</td>
        <td style="color:#64748b">${e(item.description)}</td>
        <td style="text-align:right;font-weight:700">${fmt(item.amount)}</td>
      </tr>`).join('');
  const payRows = payments.length === 0
    ? '<tr><td colspan="3" style="text-align:center;color:#94a3b8;padding:12px">No payments recorded.</td></tr>'
    : payments.map(p => `<tr>
        <td>${e(p.payment_date)}</td>
        <td style="font-weight:700;color:#16a34a">${fmt(p.amount)}</td>
        <td style="color:#64748b">${e(p.reference || '')}${p.notes ? ' · ' + e(p.notes) : ''}</td>
      </tr>`).join('');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>Invoice ${e(inv.invoice_number)}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size:13px; color:#1e293b; background:#fff; padding:32px; }
    @media print { body { padding:16px; } @page { margin:12mm; } }
    .header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:32px; padding-bottom:20px; border-bottom:2px solid #e2e8f0; }
    .brand { font-size:22px; font-weight:900; color:#2563eb; letter-spacing:-0.5px; }
    .brand-sub { font-size:11px; color:#94a3b8; margin-top:2px; }
    .inv-meta { text-align:right; }
    .inv-number { font-size:20px; font-weight:800; color:#1e293b; }
    .status-badge { display:inline-block; padding:2px 12px; border-radius:20px; font-size:11px; font-weight:700; margin-top:4px; background:${statusBg}; color:${statusColor}; }
    .grid-2 { display:grid; grid-template-columns:1fr 1fr; gap:24px; margin-bottom:28px; }
    .info-box h4 { font-size:10px; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:.8px; margin-bottom:6px; }
    .info-box p { font-size:13px; color:#334155; line-height:1.6; }
    .info-box strong { color:#1e293b; font-weight:700; }
    table { width:100%; border-collapse:collapse; margin-bottom:24px; }
    th { background:#f1f5f9; font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase; letter-spacing:.5px; padding:8px 12px; text-align:left; border-bottom:1px solid #e2e8f0; }
    td { padding:9px 12px; border-bottom:1px solid #f1f5f9; color:#334155; }
    .section-title { font-size:11px; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:.6px; margin-bottom:8px; margin-top:20px; }
    .totals-box { background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:16px 20px; display:flex; justify-content:space-between; align-items:center; margin-top:8px; }
    .tot-item { text-align:center; }
    .tot-label { font-size:11px; color:#94a3b8; margin-bottom:3px; text-transform:uppercase; letter-spacing:.5px; }
    .tot-value { font-size:16px; font-weight:800; }
    .notes { margin-top:24px; font-size:12px; color:#64748b; font-style:italic; border-top:1px solid #e2e8f0; padding-top:12px; }
    .footer { margin-top:36px; padding-top:14px; border-top:1px solid #e2e8f0; font-size:11px; color:#94a3b8; text-align:center; }
  </style></head><body>
  <div class="header">
    <div><div class="brand">TAC Network</div><div class="brand-sub">Telecom Infrastructure Management</div></div>
    <div class="inv-meta">
      <div class="inv-number">${e(inv.invoice_number)}</div>
      <div class="status-badge">${e(inv.status || 'Draft')}</div>
    </div>
  </div>
  <div class="grid-2">
    <div class="info-box">
      <h4>Bill To</h4>
      <p><strong>${e(client?.company_name)}</strong>${client?.contact_person ? '<br>' + e(client.contact_person) : ''}${client?.email ? '<br>' + e(client.email) : ''}${client?.phone ? '<br>' + e(client.phone) : ''}${client?.address ? '<br>' + e(client.address) : ''}</p>
    </div>
    <div class="info-box" style="text-align:right">
      <h4>Invoice Details</h4>
      <p>Project: <strong>${e(inv.project_name)}</strong><br>Issue Date: <strong>${e(inv.issue_date)}</strong><br>Due Date: <strong>${e(inv.due_date)}</strong></p>
    </div>
  </div>
  <div class="section-title">Line Items</div>
  <table><thead><tr><th>Section</th><th>Site ID</th><th>Description</th><th style="text-align:right">Amount</th></tr></thead><tbody>${itemsRows}</tbody></table>
  <div class="section-title">Payment History</div>
  <table><thead><tr><th>Date</th><th>Amount</th><th>Reference / Notes</th></tr></thead><tbody>${payRows}</tbody></table>
  <div class="totals-box">
    <div class="tot-item"><div class="tot-label">Total Invoiced</div><div class="tot-value" style="color:#1e293b">${fmt(inv.total_amount)}</div></div>
    <div class="tot-item"><div class="tot-label">Received</div><div class="tot-value" style="color:#16a34a">${fmt(inv.amount_received)}</div></div>
    <div class="tot-item"><div class="tot-label">Outstanding</div><div class="tot-value" style="color:${outstanding > 0 ? '#dc2626' : '#16a34a'}">${fmt(outstanding)}</div></div>
  </div>
  ${inv.notes ? `<div class="notes">Notes: ${e(inv.notes)}</div>` : ''}
  <div class="footer">Generated by TAC Network Tracker &nbsp;·&nbsp; ${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
  <script>window.onload = function(){ window.print(); }<\/script>
  </body></html>`;
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
}

// ── Component ─────────────────────────────────────────────────
export default function FinInvoices() {
  const { hasPerm, currentUser } = useAuth();
  const today = new Date().toISOString().split('T')[0];

  // ── Core data ─────────────────────────────────────────────
  const [clients,      setClients]      = useState<Client[]>([]);
  const [invoices,     setInvoices]     = useState<Invoice[]>([]);
  const [payments,     setPayments]     = useState<Payment[]>([]);
  const [items,        setItems]        = useState<InvoiceItem[]>([]);
  const [revenue,      setRevenue]      = useState<RevRow[]>([]);
  const [invoicedIds,  setInvoicedIds]  = useState<Set<string>>(new Set());
  const [loading,      setLoading]      = useState(true);
  const [statusFilter, setStatusFilter] = useState('');

  // ── Invoice modal ─────────────────────────────────────────
  const [invModal,     setInvModal]     = useState(false);
  const [invEditId,    setInvEditId]    = useState<string | null>(null);
  const [invForm,      setInvForm]      = useState({ clientId: '', number: '', project: '', status: 'Draft', issueDate: today, dueDate: '', notes: '' });
  const [revSites,     setRevSites]     = useState<RevRow[]>([]);
  const [pickerIds,    setPickerIds]    = useState<Set<string>>(new Set()); // invoiced IDs to exclude in picker
  const [checkedRevs,  setCheckedRevs]  = useState<Set<string>>(new Set()); // currently-checked revenue IDs
  const [customItems,  setCustomItems]  = useState<LineItem[]>([]);
  const [pickerLoad,   setPickerLoad]   = useState(false);
  const [pickerStatus, setPickerStatus] = useState('Select a project first');
  const [showCustForm, setShowCustForm] = useState(false);
  const [custForm,     setCustForm]     = useState({ site: '', desc: '', amt: '' });
  const [invErr,       setInvErr]       = useState('');

  // ── Payment modal ─────────────────────────────────────────
  const [payModal,    setPayModal]    = useState(false);
  const [payInvId,    setPayInvId]    = useState<string | null>(null);
  const [payForm,     setPayForm]     = useState({ date: today, amount: '', reference: '', notes: '' });
  const [payErr,      setPayErr]      = useState('');

  // ── Detail modal ──────────────────────────────────────────
  const [detailId,       setDetailId]       = useState<string | null>(null);
  const [detailItems,    setDetailItems]    = useState<InvoiceItem[]>([]);
  const [detailPayments, setDetailPayments] = useState<Payment[]>([]);
  const [detailLoad,     setDetailLoad]     = useState(false);

  // ── Toast ─────────────────────────────────────────────────
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!hasPerm('view_fin_invoices')) return <div className={css.errorMsg}>Access denied.</div>;

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  // ── Load ──────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    const [cl, inv, pym, itm, rev] = await Promise.all([
      supabase.from('clients').select('*').order('company_name'),
      supabase.from('invoices').select('*').order('created_at', { ascending: false }),
      supabase.from('invoice_payments').select('*'),
      supabase.from('invoice_items').select('*'),
      supabase.from('revenue').select('*').order('project_name').order('section_name').order('site_id'),
    ]);
    const invList: Invoice[] = inv.data || [];
    const itmList: InvoiceItem[] = itm.data || [];

    // Rebuild invoiced IDs set
    const { data: idRows } = await supabase.from('invoice_items').select('revenue_id').not('revenue_id', 'is', null);
    const newInvoicedIds = new Set<string>((idRows || []).map((x: { revenue_id: string }) => x.revenue_id).filter(Boolean));

    // Auto-overdue: find invoices with past due_date, not Paid/Overdue, amount_received < total
    const overdueToUpdate = invList.filter(i =>
      i.due_date && i.due_date < today &&
      i.status !== 'Paid' && i.status !== 'Overdue' &&
      (+i.amount_received || 0) < (+i.total_amount || 0)
    );
    if (overdueToUpdate.length > 0) {
      const ids = overdueToUpdate.map(i => i.id);
      await supabase.from('invoices').update({ status: 'Overdue' }).in('id', ids);
      overdueToUpdate.forEach(i => { i.status = 'Overdue'; });
    }

    setClients(cl.data || []);
    setInvoices(invList);
    setPayments(pym.data || []);
    setItems(itmList);
    setRevenue(rev.data || []);
    setInvoicedIds(newInvoicedIds);
    setLoading(false);
  }, [today]);

  useEffect(() => { load(); }, [load]);

  // ── Derived ───────────────────────────────────────────────
  const totalInvoiced    = invoices.reduce((s, r) => s + (+r.total_amount || 0), 0);
  const totalReceived    = invoices.reduce((s, r) => s + (+r.amount_received || 0), 0);
  const totalOutstanding = totalInvoiced - totalReceived;
  const overdueCount     = invoices.filter(r => r.status === 'Overdue').length;

  // Revenue line items from checked boxes
  const revenueLineItems: LineItem[] = revSites
    .filter(r => checkedRevs.has(r.id))
    .map(r => ({
      site_id: r.site_id,
      section_name: r.section_name || '',
      description: `Site implementation — ${r.site_id}`,
      amount: +(r.amount || 0),
      revenue_id: r.id,
    }));
  const allLineItems: LineItem[] = [...revenueLineItems, ...customItems];
  const invTotal = allLineItems.reduce((s, i) => s + (+(i.amount || 0)), 0);

  // Revenue picker grouped by section
  const revSections: Record<string, RevRow[]> = {};
  revSites.forEach(r => {
    const sec = r.section_name || 'No Section';
    if (!revSections[sec]) revSections[sec] = [];
    revSections[sec].push(r);
  });

  // Pending invoice revenue
  const pendingRevenue = revenue.filter(r => !invoicedIds.has(r.id));
  const pendingByProj: Record<string, RevRow[]> = {};
  pendingRevenue.forEach(r => {
    const p = r.project_name || 'Unknown';
    if (!pendingByProj[p]) pendingByProj[p] = [];
    pendingByProj[p].push(r);
  });
  const pendingTotal = pendingRevenue.reduce((s, r) => s + (+(r.amount || 0)), 0);

  // ── Load revenue picker for a project ────────────────────
  async function loadPickerForProject(project: string, editId: string | null, autoSelectAll = false) {
    if (!project) {
      setRevSites([]);
      setPickerIds(new Set());
      setCheckedRevs(new Set());
      setPickerStatus('Select a project first');
      return;
    }
    setPickerLoad(true);
    setPickerStatus('Loading sites…');
    const { data } = await supabase.from('revenue').select('*').eq('project_name', project).order('section_name').order('site_id');
    const sites: RevRow[] = data || [];
    setRevSites(sites);

    // Fetch all invoiced revenue_ids
    const { data: existingItems } = await supabase.from('invoice_items').select('revenue_id').not('revenue_id', 'is', null);
    const invoicedSet = new Set<string>((existingItems || []).map((x: { revenue_id: string }) => x.revenue_id).filter(Boolean));

    // If editing, exclude current invoice's items so they remain selectable
    if (editId) {
      const { data: curItems } = await supabase.from('invoice_items').select('revenue_id').eq('invoice_id', editId);
      (curItems || []).forEach((x: { revenue_id: string | null }) => { if (x.revenue_id) invoicedSet.delete(x.revenue_id); });
    }

    setPickerIds(invoicedSet);
    const available  = sites.filter(r => !invoicedSet.has(r.id)).length;
    const alreadyDone = sites.length - available;
    setPickerStatus(`${available} available${alreadyDone > 0 ? ` · ${alreadyDone} already invoiced` : ''}`);
    setPickerLoad(false);

    if (autoSelectAll) {
      setCheckedRevs(new Set(sites.filter(r => !invoicedSet.has(r.id)).map(r => r.id)));
    }
  }

  // ── Toggle section checkbox ───────────────────────────────
  function toggleSection(secName: string, checked: boolean) {
    setCheckedRevs(prev => {
      const next = new Set(prev);
      revSites.forEach(r => {
        if ((r.section_name || 'No Section') === secName && !pickerIds.has(r.id)) {
          if (checked) next.add(r.id); else next.delete(r.id);
        }
      });
      return next;
    });
  }

  // ── Open invoice form ─────────────────────────────────────
  async function openInvModal(id: string | null) {
    setInvEditId(id);
    setInvErr('');
    setRevSites([]);
    setPickerIds(new Set());
    setCheckedRevs(new Set());
    setCustomItems([]);
    setShowCustForm(false);
    setCustForm({ site: '', desc: '', amt: '' });
    setPickerStatus('Select a project first');
    if (id) {
      const inv = invoices.find(x => x.id === id);
      setInvForm({
        clientId:  inv?.client_id       || '',
        number:    inv?.invoice_number  || '',
        project:   inv?.project_name    || '',
        status:    inv?.status          || 'Draft',
        issueDate: inv?.issue_date      || today,
        dueDate:   inv?.due_date        || '',
        notes:     inv?.notes           || '',
      });
      // Load existing line items
      const { data: existingItems } = await supabase.from('invoice_items').select('*').eq('invoice_id', id);
      const existing: InvoiceItem[] = existingItems || [];
      const revItems = existing.filter(x => x.revenue_id);
      const custItemsList: LineItem[] = existing.filter(x => !x.revenue_id).map(x => ({ ...x, _customId: Date.now() + Math.random() }));
      setCustomItems(custItemsList);
      // Load revenue picker for the project, pre-checking existing revenue items
      if (inv?.project_name) {
        await loadPickerForProject(inv.project_name, id, false);
        setCheckedRevs(new Set(revItems.map(x => x.revenue_id!).filter(Boolean)));
      }
    } else {
      const year  = new Date().getFullYear();
      const count = invoices.filter(i => i.invoice_number?.startsWith(`TAC-${year}-`)).length + 1;
      setInvForm({
        clientId: '', number: `TAC-${year}-${String(count).padStart(3, '0')}`,
        project: '', status: 'Draft', issueDate: today, dueDate: '', notes: '',
      });
    }
    setInvModal(true);
  }

  async function invQuickCreate(projectName: string) {
    setInvEditId(null);
    setInvErr('');
    setRevSites([]);
    setPickerIds(new Set());
    setCheckedRevs(new Set());
    setCustomItems([]);
    setShowCustForm(false);
    setPickerStatus('Select a project first');
    const year  = new Date().getFullYear();
    const count = invoices.filter(i => i.invoice_number?.startsWith(`TAC-${year}-`)).length + 1;
    setInvForm({ clientId: '', number: `TAC-${year}-${String(count).padStart(3, '0')}`, project: projectName, status: 'Draft', issueDate: today, dueDate: '', notes: '' });
    setInvModal(true);
    await loadPickerForProject(projectName, null, true);
  }

  // ── Save invoice ──────────────────────────────────────────
  async function saveInvoice() {
    setInvErr('');
    if (!invForm.clientId)  { setInvErr('Please select a client.'); return; }
    if (!invForm.number)    { setInvErr('Invoice number is required.'); return; }
    if (!invForm.issueDate) { setInvErr('Issue date is required.'); return; }
    const total = invTotal;
    const payload = {
      client_id:      invForm.clientId,
      invoice_number: invForm.number.trim(),
      project_name:   invForm.project || null,
      issue_date:     invForm.issueDate,
      due_date:       invForm.dueDate || null,
      status:         invForm.status || 'Draft',
      total_amount:   total,
      notes:          invForm.notes.trim() || null,
      created_by:     currentUser?.full_name || '',
    };
    try {
      let invoiceId = invEditId;
      if (invEditId) {
        const { error } = await supabase.from('invoices').update(payload).eq('id', invEditId);
        if (error) throw error;
        setInvoices(list => list.map(i => i.id === invEditId ? { ...i, ...payload } : i));
        await supabase.from('invoice_items').delete().eq('invoice_id', invEditId);
      } else {
        const { data, error } = await supabase.from('invoices').insert(payload).select('*').single();
        if (error) throw error;
        setInvoices(list => [data, ...list]);
        invoiceId = data.id;
      }
      if (allLineItems.length > 0 && invoiceId) {
        const itemPayloads = allLineItems.map(item => ({
          invoice_id:   invoiceId,
          site_id:      item.site_id || null,
          section_name: item.section_name || null,
          description:  item.description || null,
          amount:       +(item.amount || 0),
          revenue_id:   item.revenue_id || null,
        }));
        const { data: savedItems } = await supabase.from('invoice_items').insert(itemPayloads).select('*');
        if (savedItems) {
          setItems(prev => {
            const filtered = prev.filter(x => x.invoice_id !== invoiceId);
            return [...filtered, ...savedItems];
          });
          setInvoicedIds(prev => {
            const next = new Set(prev);
            savedItems.forEach((x: InvoiceItem) => { if (x.revenue_id) next.add(x.revenue_id); });
            return next;
          });
        }
      } else if (invEditId && invoiceId) {
        setItems(prev => prev.filter(x => x.invoice_id !== invoiceId));
      }
      setInvModal(false);
      showToast(invEditId ? 'Invoice updated.' : 'Invoice created!', true);
    } catch (e: unknown) {
      setInvErr((e as Error).message);
    }
  }

  async function deleteInvoice(id: string) {
    if (!window.confirm('Delete this invoice? This cannot be undone.')) return;
    const { error } = await supabase.from('invoices').delete().eq('id', id);
    if (error) { showToast(error.message, false); return; }
    setInvoices(list => list.filter(i => i.id !== id));
    showToast('Invoice deleted.', true);
  }

  // ── Payment modal ─────────────────────────────────────────
  function openPayModal(invoiceId: string) {
    setPayInvId(invoiceId);
    setPayForm({ date: today, amount: '', reference: '', notes: '' });
    setPayErr('');
    setDetailId(null); // close detail if open
    setPayModal(true);
  }

  async function savePayment() {
    setPayErr('');
    if (!payForm.date)                             { setPayErr('Payment date is required.'); return; }
    if (!+payForm.amount || +payForm.amount <= 0)  { setPayErr('Valid amount is required.'); return; }
    const payload = {
      invoice_id:   payInvId,
      payment_date: payForm.date,
      amount:       +payForm.amount,
      reference:    payForm.reference.trim() || null,
      notes:        payForm.notes.trim()     || null,
      recorded_by:  currentUser?.full_name   || '',
    };
    const { error } = await supabase.from('invoice_payments').insert(payload);
    if (error) { setPayErr(error.message); return; }
    const inv = invoices.find(x => x.id === payInvId);
    if (inv && payInvId) {
      const newReceived = (+inv.amount_received || 0) + +payForm.amount;
      const newStatus   = newReceived >= (+inv.total_amount || 0) ? 'Paid' : 'Partial';
      await supabase.from('invoices').update({ amount_received: newReceived, status: newStatus }).eq('id', payInvId);
      setInvoices(list => list.map(i => i.id === payInvId ? { ...i, amount_received: newReceived, status: newStatus } : i));
    }
    setPayModal(false);
    showToast('Payment recorded!', true);
  }

  // ── Detail modal ──────────────────────────────────────────
  async function openDetail(id: string) {
    setDetailId(id);
    setDetailLoad(true);
    const [di, dp] = await Promise.all([
      supabase.from('invoice_items').select('*').eq('invoice_id', id),
      supabase.from('invoice_payments').select('*').eq('invoice_id', id).order('payment_date'),
    ]);
    setDetailItems(di.data || []);
    setDetailPayments(dp.data || []);
    setDetailLoad(false);
  }

  // ── Filtered invoices ─────────────────────────────────────
  const filteredInvoices = statusFilter ? invoices.filter(i => i.status === statusFilter) : invoices;

  if (loading) return <div className={css.placeholder}>Loading…</div>;

  const detailInv = detailId ? invoices.find(x => x.id === detailId) : null;
  const detailClient = detailInv ? clients.find(c => c.id === detailInv.client_id) : undefined;

  // ── Render ────────────────────────────────────────────────
  return (
    <div className={css.page}>
      {/* Header */}
      <div className={css.pageHdr}>
        <div className={css.pageTitle}>Invoices</div>
        <div className={css.hdrActions}>
          <button className={css.btnGhost} onClick={load}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Refresh
          </button>
          <button className={css.btnAccent} onClick={() => openInvModal(null)}>+ New Invoice</button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className={css.kpiRow}>
        <div className={`${css.kpiCard} ${css.kpiBlue}`}>
          <div className={css.kpiLabel}>Total Invoiced</div>
          <div className={css.kpiValue}>{iqd(totalInvoiced)}</div>
        </div>
        <div className={`${css.kpiCard} ${css.kpiGreen}`}>
          <div className={css.kpiLabel}>Received</div>
          <div className={css.kpiValue}>{iqd(totalReceived)}</div>
        </div>
        <div className={`${css.kpiCard} ${css.kpiAmber}`}>
          <div className={css.kpiLabel}>Outstanding</div>
          <div className={css.kpiValue}>{iqd(totalOutstanding)}</div>
        </div>
        <div className={`${css.kpiCard} ${css.kpiRed}`}>
          <div className={css.kpiLabel}>Overdue</div>
          <div className={css.kpiValue}>{overdueCount}</div>
        </div>
      </div>

      {/* Status Filters */}
      <div className={css.statusPills}>
        {(['', 'Draft', 'Sent', 'Partial', 'Paid', 'Overdue'] as const).map(s => {
          const count   = s ? invoices.filter(r => r.status === s).length : invoices.length;
          const active  = statusFilter === s;
          const color   = STATUS_PILL_ACTIVE[s] || '#1d4ed8';
          return (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              style={{
                padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer', transition: 'all .15s',
                border: `1.5px solid ${active ? color : '#e2e8f0'}`,
                background: active ? color : 'transparent',
                color: active ? '#fff' : '#64748b',
              }}
            >
              {s || 'All'} <span style={{ opacity: .75 }}>({count})</span>
            </button>
          );
        })}
      </div>

      {/* Invoices Table */}
      <div className={css.tableWrap}>
        <table className={css.table} style={{ fontSize: 12 }}>
          <thead><tr>
            <th style={{ whiteSpace: 'nowrap' }}>Invoice #</th>
            <th>Client / Project</th>
            <th>Sites</th>
            <th>Dates</th>
            <th className={css.num}>Total</th>
            <th className={css.num}>Received</th>
            <th className={css.num}>Outstanding</th>
            <th>Status</th>
            <th>Actions</th>
          </tr></thead>
          <tbody>
            {filteredInvoices.length === 0
              ? <tr><td colSpan={9} className={css.empty}>{statusFilter ? `No ${statusFilter} invoices.` : 'No invoices yet. Click "+ New Invoice" to create your first invoice.'}</td></tr>
              : filteredInvoices.map(inv => {
                  const client      = clients.find(c => c.id === inv.client_id);
                  const outstanding = (+inv.total_amount || 0) - (+inv.amount_received || 0);
                  const invSites    = items.filter(x => x.invoice_id === inv.id);
                  const isOverdue   = inv.due_date && inv.due_date < today && inv.status !== 'Paid';
                  return (
                    <tr key={inv.id}>
                      <td style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{inv.invoice_number || '—'}</td>
                      <td style={{ maxWidth: 140 }}>
                        <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{client?.company_name || '—'}</div>
                        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{inv.project_name || '—'}</div>
                      </td>
                      <td style={{ maxWidth: 160 }}>
                        {invSites.length === 0
                          ? <span style={{ color: '#94a3b8' }}>—</span>
                          : invSites.map(s => (
                              <span key={s.id} className={css.siteBadge}>
                                <span>{String(s.site_id || '')}</span>
                                {s.section_name && <span className={css.siteBadgeSec}>{s.section_name}</span>}
                              </span>
                            ))
                        }
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <div style={{ fontSize: 11, color: '#64748b' }}>📤 {inv.issue_date || '—'}</div>
                        <div style={{ fontSize: 11, color: isOverdue ? '#dc2626' : '#64748b', marginTop: 2 }}>⏱ {inv.due_date || '—'}</div>
                      </td>
                      <td className={css.num} style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{iqd(inv.total_amount || 0)}</td>
                      <td className={css.num} style={{ color: '#16a34a', fontWeight: 700, whiteSpace: 'nowrap' }}>{iqd(inv.amount_received || 0)}</td>
                      <td className={css.num} style={{ color: outstanding > 0 ? '#dc2626' : '#16a34a', fontWeight: 700, whiteSpace: 'nowrap' }}>{iqd(outstanding)}</td>
                      <td>
                        <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 5, background: STATUS_COLOR[inv.status] || '#f1f5f9', color: STATUS_TEXT[inv.status] || '#475569' }}>
                          {inv.status || 'Draft'}
                        </span>
                      </td>
                      <td>
                        <div className={css.actWrap}>
                          <button className={css.actBtn} title="View Detail" onClick={() => openDetail(inv.id)}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2.2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                          </button>
                          <button className={css.actBtn} title="Edit" onClick={() => openInvModal(inv.id)}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                          </button>
                          <button className={css.actBtn} title="Record Payment" onClick={() => openPayModal(inv.id)} style={{ color: '#16a34a' }}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
                          </button>
                          <button className={css.actBtn} title="Download PDF" onClick={() => {
                            const client2 = clients.find(c => c.id === inv.client_id);
                            const invItems = items.filter(x => x.invoice_id === inv.id);
                            const invPayments = payments.filter(x => x.invoice_id === inv.id);
                            printInvoice(inv, client2, invItems, invPayments);
                          }} style={{ color: '#7c3aed' }}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2.2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
                          </button>
                          <button className={`${css.actBtn} ${css.actBtnDel}`} title="Delete" onClick={() => deleteInvoice(inv.id)}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
            }
          </tbody>
        </table>
      </div>

      {/* Pending Invoice Section */}
      {pendingRevenue.length === 0
        ? <div className={css.pendingAllDone}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ verticalAlign: 'middle', marginRight: 6 }}><polyline points="20 6 9 17 4 12"/></svg>
            All revenue entries have been invoiced.
          </div>
        : <div className={css.pendingSection}>
            <div className={css.pendingHdr}>
              <div className={css.pendingTitle}>
                <span className={css.pendingSiteBadge}>{pendingRevenue.length} sites</span>
                Pending Invoice
              </div>
              <div className={css.pendingTotalAmt}>{iqd(pendingTotal)} not yet invoiced</div>
            </div>
            {Object.entries(pendingByProj).map(([proj, sites]) => (
              <div key={proj} className={css.pendingGroup}>
                <div className={css.pendingGroupHdr}>
                  <div className={css.pendingGroupName}>{proj}</div>
                  <div className={css.pendingGroupActions}>
                    <div className={css.pendingGroupMeta}>{sites.length} sites · {iqd(sites.reduce((s, r) => s + (+(r.amount || 0)), 0))}</div>
                    <button className={css.btnInvoiceNow} onClick={() => invQuickCreate(proj)}>⚡ Invoice Now</button>
                  </div>
                </div>
                <table className={css.table} style={{ fontSize: 12 }}>
                  <thead><tr><th>Section</th><th>Site ID</th><th>Status</th><th className={css.num}>Amount (IQD)</th></tr></thead>
                  <tbody>
                    {sites.map(r => (
                      <tr key={r.id}>
                        <td style={{ color: '#64748b' }}>{r.section_name || '—'}</td>
                        <td style={{ fontWeight: 600 }}>{String(r.site_id || '—')}</td>
                        <td>
                          <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 4, fontWeight: 600, background: r.status === 'Accepted' ? '#dcfce7' : '#fef3c7', color: r.status === 'Accepted' ? '#16a34a' : '#b45309' }}>
                            {r.status || '—'}
                          </span>
                        </td>
                        <td className={css.num} style={{ fontWeight: 700, color: '#16a34a' }}>{iqd(r.amount || 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
      }

      {/* Invoice Modal */}
      {invModal && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget) setInvModal(false); }}>
          <div className={`${css.modal} ${css.modalLg}`}>
            <div className={css.modalTitle}>{invEditId ? 'Edit Invoice' : 'New Invoice'}</div>
            <div className={css.formGrid}>
              <div className={css.formField}>
                <label>Client *</label>
                <select className={css.formSel} value={invForm.clientId} onChange={e => setInvForm(f => ({ ...f, clientId: e.target.value }))}>
                  <option value="">— Select Client —</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.company_name}</option>)}
                </select>
              </div>
              <div className={css.formField}>
                <label>Invoice # *</label>
                <input className={css.formInput} placeholder="TAC-2026-001" maxLength={30}
                  value={invForm.number} onChange={e => setInvForm(f => ({ ...f, number: e.target.value }))} />
              </div>
              <div className={css.formField}>
                <label>Project</label>
                <select className={css.formSel} value={invForm.project}
                  onChange={e => {
                    const p = e.target.value;
                    setInvForm(f => ({ ...f, project: p }));
                    setCheckedRevs(new Set());
                    loadPickerForProject(p, invEditId, false);
                  }}>
                  <option value="">— Select —</option>
                  {FIN_PROJECTS.filter(p => p !== 'General').map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div className={css.formField}>
                <label>Status</label>
                <select className={css.formSel} value={invForm.status} onChange={e => setInvForm(f => ({ ...f, status: e.target.value }))}>
                  <option value="Draft">Draft</option>
                  <option value="Sent">Sent</option>
                  <option value="Partial">Partial</option>
                  <option value="Paid">Paid</option>
                  <option value="Overdue">Overdue</option>
                </select>
              </div>
              <div className={css.formField}>
                <label>Issue Date *</label>
                <input type="date" className={css.formInput} value={invForm.issueDate} onChange={e => setInvForm(f => ({ ...f, issueDate: e.target.value }))} />
              </div>
              <div className={css.formField}>
                <label>Due Date</label>
                <input type="date" className={css.formInput} value={invForm.dueDate} onChange={e => setInvForm(f => ({ ...f, dueDate: e.target.value }))} />
              </div>
              <div className={`${css.formField} ${css.span2}`}>
                <label>Notes</label>
                <textarea className={css.formTextarea} rows={2} placeholder="Optional…"
                  value={invForm.notes} onChange={e => setInvForm(f => ({ ...f, notes: e.target.value }))} />
              </div>
            </div>

            {/* Revenue Picker */}
            <div style={{ marginTop: 20 }}>
              <div className={css.pickerHdr}>
                <div className={css.pickerLabel}>SELECT SITES FROM REVENUE</div>
                <div className={css.pickerStatus}>{pickerLoad ? 'Loading…' : pickerStatus}</div>
              </div>
              <div className={css.pickerBox}>
                {!invForm.project
                  ? <div className={css.pickerEmpty}>← Select a project above to load sites</div>
                  : pickerLoad
                    ? <div className={css.pickerEmpty}>Loading sites…</div>
                    : revSites.length === 0
                      ? <div className={css.pickerEmpty}>No revenue entries found for this project.</div>
                      : Object.entries(revSections).map(([sec, sites]) => {
                          const availSites = sites.filter(r => !pickerIds.has(r.id));
                          const allChecked = availSites.length > 0 && availSites.every(r => checkedRevs.has(r.id));
                          return (
                            <div key={sec} style={{ borderBottom: '1px solid #e2e8f0' }}>
                              <div className={css.pickerSecHdr}>
                                <input type="checkbox" checked={allChecked}
                                  onChange={e => toggleSection(sec, e.target.checked)} />
                                {sec}
                              </div>
                              {sites.map(r => {
                                const isInvoiced = pickerIds.has(r.id);
                                return (
                                  <label key={r.id}
                                    className={`${css.pickerRow} ${isInvoiced ? css.pickerRowDisabled : ''}`}
                                    style={{ display: 'flex' }}
                                  >
                                    <input type="checkbox" disabled={isInvoiced}
                                      checked={!isInvoiced && checkedRevs.has(r.id)}
                                      onChange={e => {
                                        setCheckedRevs(prev => {
                                          const next = new Set(prev);
                                          if (e.target.checked) next.add(r.id); else next.delete(r.id);
                                          return next;
                                        });
                                      }} />
                                    <span className={css.pickerSiteId}>{String(r.site_id || '—')}</span>
                                    <span className={css.pickerSec}>{r.section_name || ''}</span>
                                    <span className={css.pickerStatus2}>{r.status || ''}</span>
                                    {isInvoiced && <span className={css.pickerInvoicedBadge}>Invoiced</span>}
                                    <span className={css.pickerAmt}>{iqd(r.amount || 0)}</span>
                                  </label>
                                );
                              })}
                            </div>
                          );
                        })
                }
              </div>
              <div className={css.pickerFooter}>
                <div className={css.pickerCount}>{revenueLineItems.length} site{revenueLineItems.length !== 1 ? 's' : ''} selected</div>
                <div className={css.pickerTotal}>Total: <span className={css.pickerTotalAmt}>{invTotal.toLocaleString()} IQD</span></div>
              </div>
            </div>

            {/* Custom Items */}
            <div style={{ marginTop: 18 }}>
              <div className={css.customHdr}>
                <div className={css.customLabel}>EXTRA / CUSTOM ITEMS</div>
                <button className={css.btnAddItem} onClick={() => { setShowCustForm(true); setCustForm({ site: '', desc: '', amt: '' }); }}>+ Add Item</button>
              </div>
              {customItems.map(item => (
                <div key={item._customId} className={css.customItem}>
                  <span className={css.customItemId}>{String(item.site_id || 'Custom')}</span>
                  <span className={css.customItemDesc}>{item.description}</span>
                  <span className={css.customItemAmt}>{(+(item.amount || 0)).toLocaleString()} IQD</span>
                  <button className={css.btnRemoveItem} title="Remove"
                    onClick={() => setCustomItems(cs => cs.filter(c => c._customId !== item._customId))}>✕</button>
                </div>
              ))}
              {showCustForm && (
                <div className={css.customForm}>
                  <div className={css.customFormGrid}>
                    <input className={css.formInput} placeholder="Site ID (optional)"
                      value={custForm.site} onChange={e => setCustForm(f => ({ ...f, site: e.target.value }))} />
                    <input className={css.formInput} placeholder="Description *"
                      value={custForm.desc} onChange={e => setCustForm(f => ({ ...f, desc: e.target.value }))} />
                    <input type="number" className={css.formInput} placeholder="Amount (IQD) *"
                      value={custForm.amt} onChange={e => setCustForm(f => ({ ...f, amt: e.target.value }))} />
                  </div>
                  <div className={css.customFormActions}>
                    <button className={css.btnCancel} onClick={() => setShowCustForm(false)}>Cancel</button>
                    <button className={css.btnAdd} onClick={() => {
                      if (!custForm.desc.trim()) { showToast('Description is required', false); return; }
                      if (!+custForm.amt || +custForm.amt <= 0) { showToast('Amount must be greater than 0', false); return; }
                      setCustomItems(cs => [...cs, { site_id: custForm.site.trim() || null, section_name: null, description: custForm.desc.trim(), amount: +custForm.amt, revenue_id: null, _customId: Date.now() + Math.random() }]);
                      setShowCustForm(false);
                    }}>Add</button>
                  </div>
                </div>
              )}
            </div>

            {invErr && <div className={css.modalErr}>{invErr}</div>}
            <div className={css.modalActions}>
              <button className={css.btnCancel} onClick={() => setInvModal(false)}>Cancel</button>
              <button className={css.btnSave} onClick={saveInvoice}>Save Invoice</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Payment Modal */}
      {payModal && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget) setPayModal(false); }}>
          <div className={css.modal}>
            <div className={css.modalTitle}>Record Payment</div>
            <div className={css.formGrid}>
              <div className={css.formField}>
                <label>Payment Date *</label>
                <input type="date" className={css.formInput} value={payForm.date} onChange={e => setPayForm(f => ({ ...f, date: e.target.value }))} />
              </div>
              <div className={css.formField}>
                <label>Amount (IQD) *</label>
                <input type="number" className={css.formInput} min={0} placeholder="0"
                  value={payForm.amount} onChange={e => setPayForm(f => ({ ...f, amount: e.target.value }))} />
              </div>
              <div className={`${css.formField} ${css.span2}`}>
                <label>Reference / Cheque #</label>
                <input className={css.formInput} placeholder="Optional…" maxLength={100}
                  value={payForm.reference} onChange={e => setPayForm(f => ({ ...f, reference: e.target.value }))} />
              </div>
              <div className={`${css.formField} ${css.span2}`}>
                <label>Notes</label>
                <textarea className={css.formTextarea} rows={2} placeholder="Optional…"
                  value={payForm.notes} onChange={e => setPayForm(f => ({ ...f, notes: e.target.value }))} />
              </div>
            </div>
            {payErr && <div className={css.modalErr}>{payErr}</div>}
            <div className={css.modalActions}>
              <button className={css.btnCancel} onClick={() => setPayModal(false)}>Cancel</button>
              <button className={css.btnSave} onClick={savePayment}>Record Payment</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Detail Modal */}
      {detailId && detailInv && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget) setDetailId(null); }}>
          <div className={`${css.modal} ${css.modalLg}`}>
            <div className={css.detailHdr}>
              <div className={css.detailNumber}>{detailInv.invoice_number || 'Invoice'}</div>
              <span style={{ fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 20, background: STATUS_COLOR[detailInv.status] || '#f1f5f9', color: STATUS_TEXT[detailInv.status] || '#475569' }}>
                {detailInv.status || 'Draft'}
              </span>
            </div>
            <div className={css.detailMeta}>
              <strong>{detailClient?.company_name || '—'}</strong> &nbsp;·&nbsp; {detailInv.project_name || '—'} &nbsp;·&nbsp; Issued: {detailInv.issue_date || '—'} &nbsp;·&nbsp; Due: {detailInv.due_date || '—'}
              {detailInv.notes && <div style={{ marginTop: 4, fontStyle: 'italic' }}>{detailInv.notes}</div>}
            </div>

            <div className={css.detailSectionLbl}>Line Items</div>
            <div className={css.detailBox}>
              {detailLoad
                ? <div className={css.detailEmpty}>Loading…</div>
                : detailItems.length === 0
                  ? <div className={css.detailEmpty}>No line items.</div>
                  : <table className={css.table} style={{ fontSize: 12 }}>
                      <thead><tr><th>Section</th><th>Site ID</th><th>Description</th><th className={css.num}>Amount</th></tr></thead>
                      <tbody>
                        {detailItems.map(item => (
                          <tr key={item.id}>
                            <td style={{ color: '#64748b' }}>{item.section_name || '—'}</td>
                            <td style={{ fontWeight: 600 }}>{String(item.site_id || '—')}</td>
                            <td style={{ color: '#64748b' }}>{item.description || '—'}</td>
                            <td className={css.num} style={{ fontWeight: 700, color: '#16a34a' }}>{iqd(item.amount || 0)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
              }
            </div>

            <div className={css.detailSectionLbl}>Payment History</div>
            <div className={css.detailBox}>
              {detailLoad
                ? <div className={css.detailEmpty}>Loading…</div>
                : detailPayments.length === 0
                  ? <div className={css.detailEmpty}>No payments recorded yet.</div>
                  : <table className={css.table} style={{ fontSize: 12 }}>
                      <thead><tr><th>Date</th><th>Amount</th><th>Reference</th><th>Recorded By</th><th>Notes</th></tr></thead>
                      <tbody>
                        {detailPayments.map(p => (
                          <tr key={p.id}>
                            <td style={{ whiteSpace: 'nowrap' }}>{p.payment_date || '—'}</td>
                            <td style={{ fontWeight: 700, color: '#16a34a' }}>{iqd(p.amount || 0)}</td>
                            <td style={{ color: '#64748b' }}>{p.reference || '—'}</td>
                            <td style={{ color: '#64748b' }}>{p.recorded_by || '—'}</td>
                            <td style={{ color: '#64748b' }}>{p.notes || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
              }
            </div>

            <div className={css.totalBar}>
              <div className={css.totalBarItem} style={{ color: '#64748b' }}>Total <strong style={{ color: '#1e293b' }}>{iqd(detailInv.total_amount || 0)}</strong></div>
              <div className={css.totalBarItem} style={{ color: '#16a34a' }}>Received <strong>{iqd(detailInv.amount_received || 0)}</strong></div>
              <div className={css.totalBarItem} style={{ color: '#dc2626' }}>Outstanding <strong>{iqd((+detailInv.total_amount || 0) - (+detailInv.amount_received || 0))}</strong></div>
            </div>

            <div className={css.modalActions}>
              <button className={css.btnCancel} onClick={() => setDetailId(null)}>Close</button>
              <button className={css.btnPurple} onClick={() => {
                const invItems = items.filter(x => x.invoice_id === detailInv.id);
                const invPays  = payments.filter(x => x.invoice_id === detailInv.id);
                printInvoice(detailInv, detailClient, invItems, invPays);
              }}>📄 PDF</button>
              <button className={css.btnSave} onClick={() => { setDetailId(null); openPayModal(detailInv.id); }}>Record Payment</button>
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
