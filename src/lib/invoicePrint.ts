// ── Premium printable invoice — builds a self-contained HTML document ───────
//
// Pure string building (no DOM access) so it can be tested. FinInvoices.tsx
// opens the result in a new window and prints it. Colours follow the Tareeq
// Al-Ahmadi logo: deep navy + gold. Company details / bank / terms come from
// src/lib/companyInfo.ts; anything left blank there is simply not drawn.

import type { CompanyInfo } from './companyInfo';
import { amountInWords, fmtInvoiceDate } from './invoiceHelpers';

export interface PrintInvoice {
  invoice_number: string | null;
  project_name:   string | null;
  status:         string;
  issue_date:     string | null;
  due_date:       string | null;
  total_amount:   number;
  amount_received: number;
  notes:          string | null;
}
export interface PrintClient {
  company_name:   string;
  contact_person: string | null;
  email:          string | null;
  phone:          string | null;
  address:        string | null;
}
export interface PrintItem {
  site_id:      string | null;
  section_name: string | null;
  description:  string | null;
  amount:       number;
}
export interface PrintPayment {
  payment_date: string | null;
  amount:       number;
  reference:    string | null;
  notes:        string | null;
}

export interface BuildInvoiceArgs {
  invoice:  PrintInvoice;
  client:   PrintClient | undefined;
  items:    PrintItem[];
  payments: PrintPayment[];
  company:  CompanyInfo;
  /** Absolute URL of the logo image (the print window has no base URL). */
  logoUrl:  string;
  /** Date shown in the footer; defaults to now. */
  generatedOn?: Date;
  /** Open the print dialog automatically on load. */
  autoPrint?: boolean;
}

const STATUS_STYLE: Record<string, { bg: string; fg: string }> = {
  Draft:   { bg: '#eef0f4', fg: '#4b5563' },
  Sent:    { bg: '#e0e9ff', fg: '#1e3a8a' },
  Partial: { bg: '#fdf0cf', fg: '#8a5a00' },
  Paid:    { bg: '#dcf5e4', fg: '#15803d' },
  Overdue: { bg: '#fde2e2', fg: '#b91c1c' },
};

const WATERMARK: Record<string, { text: string; color: string }> = {
  Paid:  { text: 'PAID',  color: 'rgba(21,128,61,.07)' },
  Draft: { text: 'DRAFT', color: 'rgba(75,85,99,.07)' },
};

export function escapeHtml(s: string | number | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const money = (v: number | null | undefined) =>
  (+(v ?? 0)).toLocaleString('en-US', { maximumFractionDigits: 0 });

export function buildInvoiceHtml(a: BuildInvoiceArgs): string {
  const { invoice: inv, client, items, payments, company, logoUrl } = a;
  const e = escapeHtml;

  const total       = +inv.total_amount || 0;
  const received    = +inv.amount_received || 0;
  const outstanding = total - received;
  const paidInFull  = total > 0 && outstanding <= 0;
  const st          = STATUS_STYLE[inv.status] ?? STATUS_STYLE.Draft;
  const wm          = WATERMARK[inv.status];
  const generated   = (a.generatedOn ?? new Date()).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

  const contactBits = [company.address, company.phone, company.email, company.website].filter(Boolean);
  const contactHeader = contactBits.length
    ? `<div class="co-lines">${contactBits.map(b => `<span class="nw">${e(b)}</span>`).join('<span class="dot">◆</span>')}</div>` : '';

  const clientLines = [
    client?.contact_person, client?.address, client?.phone, client?.email,
  ].filter(Boolean).map(l => `<div>${e(l)}</div>`).join('');

  const itemsRows = items.length === 0
    ? '<tr><td colspan="5" class="empty">No line items.</td></tr>'
    : items.map((it, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td>${e(it.section_name) || '—'}</td>
        <td class="site">${e(it.site_id || '—')}</td>
        <td class="muted">${e(it.description) || '—'}</td>
        <td class="amt">${money(it.amount)}</td>
      </tr>`).join('');

  const paymentsBlock = payments.length === 0 ? '' : `
    <div class="block">
      <div class="sec-title">Payments Received</div>
      <table class="pay">
        <thead><tr><th>Date</th><th>Reference / Notes</th><th class="r">Amount (IQD)</th></tr></thead>
        <tbody>${payments.map(p => `<tr>
          <td>${e(fmtInvoiceDate(p.payment_date))}</td>
          <td class="muted">${e(p.reference || '')}${p.reference && p.notes ? ' · ' : ''}${e(p.notes || '') || (p.reference ? '' : '—')}</td>
          <td class="amt paid-amt">${money(p.amount)}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>`;

  const b = company.bank;
  const bankRows: [string, string][] = ([
    ['Bank', b.bankName], ['Account Name', b.accountName], ['Account No.', b.accountNumber],
    ['IBAN', b.iban], ['SWIFT', b.swift],
  ] as [string, string][]).filter(([, v]) => !!v);
  const bankBox = bankRows.length ? `
    <div class="box">
      <div class="box-title">Payment Details</div>
      ${bankRows.map(([k, v]) => `<div class="kv"><span>${e(k)}</span><b>${e(v)}</b></div>`).join('')}
    </div>` : '';
  const termsBox = company.terms.length ? `
    <div class="box">
      <div class="box-title">Terms &amp; Conditions</div>
      <ol class="terms">${company.terms.map(t => `<li>${e(t)}</li>`).join('')}</ol>
    </div>` : '';
  const infoRow = (bankBox || termsBox)
    ? `<div class="info-row ${bankBox && termsBox ? 'two' : 'one'}">${bankBox}${termsBox}</div>` : '';

  const notesBlock = inv.notes
    ? `<div class="notes"><span>Notes</span>${e(inv.notes)}</div>` : '';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>Invoice ${e(inv.invoice_number)}</title>
<style>
  :root { --navy:#0f2260; --navy2:#1b3a8c; --gold:#c9971c; --gold2:#e9c46a; --ink:#1f2937; --muted:#6b7280; --line:#e6e8ee; --tint:#f7f6f1; }
  * { margin:0; padding:0; box-sizing:border-box; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  html, body { background:#e9ebf0; }
  body { font-family:'Helvetica Neue', Helvetica, Arial, 'Segoe UI', sans-serif; font-size:12px; color:var(--ink); line-height:1.45; }
  .page { position:relative; width:210mm; min-height:297mm; margin:0 auto; background:#fff; padding:0 14mm 12mm; overflow:hidden; }
  @media screen { .page { margin:16px auto; box-shadow:0 8px 40px rgba(15,34,96,.18); } }
  @media print { html, body { background:#fff; } @page { size:A4; margin:0; } .page { margin:0; box-shadow:none; } }

  .topbar { height:9px; margin:0 -14mm; background:linear-gradient(90deg,var(--navy) 0%,var(--navy2) 68%,var(--gold) 68%,var(--gold2) 100%); }
  .wm { position:absolute; top:46%; left:50%; transform:translate(-50%,-50%) rotate(-28deg); font-size:150px; font-weight:900; letter-spacing:14px; color:${wm ? wm.color : 'transparent'}; pointer-events:none; user-select:none; z-index:0; }
  .content { position:relative; z-index:1; }

  .hdr { display:flex; justify-content:space-between; align-items:center; padding:12px 0 10px; }
  .logo { width:38mm; height:38mm; object-fit:contain; display:block; }
  .co-lines { margin-top:4px; font-size:10px; color:var(--muted); max-width:100mm; line-height:1.7; }
  .co-lines .nw { white-space:nowrap; }
  .co-lines .dot { color:var(--gold); margin:0 6px; font-size:7px; vertical-align:middle; }
  .title-block { text-align:right; }
  .doc-title { font-size:34px; font-weight:800; letter-spacing:9px; color:var(--navy); line-height:1; margin-right:-9px; }
  .inv-no { margin-top:8px; font-size:15px; font-weight:700; color:var(--ink); letter-spacing:.5px; }
  .pill { display:inline-block; margin-top:8px; padding:3px 14px; border-radius:20px; font-size:10px; font-weight:800; letter-spacing:1.4px; text-transform:uppercase; background:${st.bg}; color:${st.fg}; }
  .rule { height:2px; background:linear-gradient(90deg,var(--gold),var(--gold2) 40%,rgba(233,196,106,0)); margin:2px 0 18px; }

  .parties { display:grid; grid-template-columns:1.15fr 1fr; gap:14px; margin-bottom:20px; }
  .card { background:var(--tint); border-left:3px solid var(--gold); border-radius:4px; padding:12px 16px; }
  .card h4 { font-size:9px; font-weight:800; letter-spacing:1.8px; text-transform:uppercase; color:var(--gold); margin-bottom:7px; }
  .card .name { font-size:14px; font-weight:800; color:var(--navy); margin-bottom:3px; }
  .card .lines { font-size:11.5px; color:#4b5563; line-height:1.6; }
  .kv-row { display:flex; justify-content:space-between; gap:12px; padding:3px 0; font-size:11.5px; }
  .kv-row span { color:var(--muted); }
  .kv-row b { color:var(--ink); font-weight:700; text-align:right; }

  .sec-title { font-size:9px; font-weight:800; letter-spacing:1.8px; text-transform:uppercase; color:var(--navy); margin:0 0 7px; display:flex; align-items:center; gap:8px; }
  .sec-title::after { content:''; flex:1; height:1px; background:var(--line); }
  .block { margin-top:18px; }

  table { width:100%; border-collapse:collapse; }
  thead th { background:var(--navy); color:#fff; font-size:9.5px; font-weight:700; letter-spacing:1.2px; text-transform:uppercase; padding:9px 11px; text-align:left; }
  thead th.r { text-align:right; }
  thead th:first-child { border-radius:4px 0 0 0; } thead th:last-child { border-radius:0 4px 0 0; }
  tbody td { padding:9px 11px; border-bottom:1px solid var(--line); font-size:11.5px; vertical-align:top; }
  tbody tr:nth-child(even) td { background:#fafbfd; }
  tr { break-inside:avoid; page-break-inside:avoid; }
  td.num { width:28px; color:var(--muted); font-weight:700; }
  td.site { font-weight:700; color:var(--navy); white-space:nowrap; }
  td.muted, .muted { color:#6b7280; }
  td.amt { text-align:right; font-weight:700; white-space:nowrap; font-variant-numeric:tabular-nums; }
  td.paid-amt { color:#15803d; }
  td.empty { text-align:center; color:#9ca3af; padding:18px; }
  table.pay thead th { background:#334155; }

  .summary { display:grid; grid-template-columns:1fr 78mm; gap:18px; margin-top:16px; break-inside:avoid; }
  .words { font-size:11px; color:var(--muted); align-self:end; }
  .words b { display:block; font-size:9px; letter-spacing:1.6px; text-transform:uppercase; color:var(--gold); margin-bottom:3px; }
  .words i { color:var(--ink); font-style:italic; font-size:11.5px; }
  .tot { border:1px solid var(--line); border-radius:6px; overflow:hidden; }
  .tot .row { display:flex; justify-content:space-between; padding:8px 14px; font-size:12px; border-bottom:1px solid var(--line); }
  .tot .row span { color:var(--muted); }
  .tot .row b { font-variant-numeric:tabular-nums; }
  .tot .row.rec b { color:#15803d; }
  .tot .due { display:flex; justify-content:space-between; align-items:center; padding:12px 14px; background:linear-gradient(100deg,var(--navy),var(--navy2)); color:#fff; border-bottom:3px solid var(--gold); }
  .tot .due span { font-size:10px; font-weight:700; letter-spacing:1.6px; text-transform:uppercase; color:var(--gold2); }
  .tot .due b { font-size:17px; font-weight:800; font-variant-numeric:tabular-nums; }
  .tot .due small { font-size:10px; font-weight:600; opacity:.85; margin-left:4px; }

  .notes { margin-top:16px; padding:10px 14px; border-left:3px solid var(--navy); background:#f4f6fb; font-size:11.5px; color:#4b5563; border-radius:0 4px 4px 0; break-inside:avoid; }
  .notes span { display:block; font-size:9px; font-weight:800; letter-spacing:1.6px; text-transform:uppercase; color:var(--navy); margin-bottom:2px; }

  .info-row { display:grid; gap:14px; margin-top:20px; break-inside:avoid; }
  .info-row.two { grid-template-columns:1fr 1.25fr; } .info-row.one { grid-template-columns:1fr; }
  .box { border:1px solid var(--line); border-top:3px solid var(--gold); border-radius:4px; padding:11px 14px; }
  .box-title { font-size:9px; font-weight:800; letter-spacing:1.8px; text-transform:uppercase; color:var(--navy); margin-bottom:7px; }
  .kv { display:flex; justify-content:space-between; gap:10px; padding:2.5px 0; font-size:11px; }
  .kv span { color:var(--muted); } .kv b { font-weight:700; text-align:right; word-break:break-all; }
  ol.terms { padding-left:16px; font-size:10.5px; color:#4b5563; line-height:1.6; }

  .sign { display:grid; grid-template-columns:1fr 1fr; gap:36px; margin-top:34px; break-inside:avoid; }
  .sign div { border-top:1px solid #9ca3af; padding-top:6px; text-align:center; font-size:9.5px; letter-spacing:1.4px; text-transform:uppercase; color:var(--muted); height:44px; }

  .foot { margin-top:26px; text-align:center; break-inside:avoid; }
  .foot .thanks { font-size:13px; font-weight:800; color:var(--navy); letter-spacing:.4px; }
  .foot .sub { margin-top:3px; font-size:10px; color:var(--muted); }
  .foot .gold { height:2px; margin:10px auto 0; width:60%; background:linear-gradient(90deg,rgba(201,151,28,0),var(--gold),rgba(201,151,28,0)); }
</style></head><body>
<div class="page">
  <div class="topbar"></div>
  ${wm ? `<div class="wm">${wm.text}</div>` : ''}
  <div class="content">
    <div class="hdr">
      <div>
        <img class="logo" src="${e(logoUrl)}" alt="${e(company.nameEn)}">
        ${contactHeader}
      </div>
      <div class="title-block">
        <div class="doc-title">INVOICE</div>
        <div class="inv-no"># ${e(inv.invoice_number) || '—'}</div>
        <span class="pill">${e(inv.status || 'Draft')}</span>
      </div>
    </div>
    <div class="rule"></div>

    <div class="parties">
      <div class="card">
        <h4>Billed To</h4>
        <div class="name">${e(client?.company_name) || '—'}</div>
        <div class="lines">${clientLines}</div>
      </div>
      <div class="card">
        <h4>Invoice Details</h4>
        <div class="kv-row"><span>Invoice No.</span><b>${e(inv.invoice_number) || '—'}</b></div>
        <div class="kv-row"><span>Project</span><b>${e(inv.project_name) || '—'}</b></div>
        <div class="kv-row"><span>Issue Date</span><b>${e(fmtInvoiceDate(inv.issue_date))}</b></div>
        <div class="kv-row"><span>Due Date</span><b>${e(fmtInvoiceDate(inv.due_date))}</b></div>
      </div>
    </div>

    <div class="sec-title">Description of Services</div>
    <table>
      <thead><tr><th>#</th><th>Section</th><th>Site ID</th><th>Description</th><th class="r">Amount (IQD)</th></tr></thead>
      <tbody>${itemsRows}</tbody>
    </table>

    <div class="summary">
      <div class="words"><b>Amount in Words</b><i>${e(amountInWords(total))}</i></div>
      <div class="tot">
        <div class="row"><span>Total Invoiced</span><b>${money(total)} IQD</b></div>
        <div class="row rec"><span>Received</span><b>${money(received)} IQD</b></div>
        <div class="due"><span>${paidInFull ? 'Balance' : 'Amount Due'}</span><b>${money(Math.max(outstanding, 0))}<small>IQD</small></b></div>
      </div>
    </div>

    ${paymentsBlock}
    ${notesBlock}
    ${infoRow}

    <div class="sign"><div>Authorized Signature</div><div>Company Stamp</div></div>

    <div class="foot">
      <div class="thanks">Thank you for your business</div>
      <div class="sub">${e(company.nameEn)}${company.nameAr ? ' &nbsp;·&nbsp; ' + e(company.nameAr) : ''} &nbsp;·&nbsp; Generated ${e(generated)}</div>
      <div class="gold"></div>
    </div>
  </div>
</div>
${a.autoPrint === false ? '' : '<script>window.onload = function(){ setTimeout(function(){ window.print(); }, 250); }<\/script>'}
</body></html>`;
}
