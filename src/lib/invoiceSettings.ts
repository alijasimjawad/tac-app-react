// ── Invoice settings (company / bank / terms) — editable from the app ───────
//
// Saved as one JSON string in the existing `app_settings` key/value table
// (same table the car KM rate uses). Missing or broken data always falls back
// to DEFAULT_COMPANY, so a printed invoice never fails because of settings.

import { supabase } from './supabase';
import { DEFAULT_COMPANY, type CompanyInfo } from './companyInfo';
import type { BuildInvoiceArgs } from './invoicePrint';

export const INVOICE_SETTINGS_KEY = 'invoice_company_info';

const MAX_FIELD = 300;
const MAX_TERMS = 12;

function cloneDefaults(base: CompanyInfo): CompanyInfo {
  return { ...base, bank: { ...base.bank }, terms: [...base.terms] };
}

const clean = (v: unknown, max = MAX_FIELD): string => String(v ?? '').trim().slice(0, max);

/** A string field from untrusted input: use it (even if blank) when it's a string, else the default. */
function strField(src: unknown, key: string, fallback: string): string {
  const v = (src as Record<string, unknown> | null | undefined)?.[key];
  return typeof v === 'string' ? clean(v) : fallback;
}

/**
 * Turns whatever is stored (JSON string, object, null, garbage) into a complete
 * CompanyInfo. Fields that are missing fall back to `defaults`; fields saved as
 * blank stay blank (that's how an admin hides e.g. the website). Terms: a saved
 * array is used as-is (blank entries dropped, so saving an empty list hides the
 * Terms block); no saved array → defaults.
 */
export function parseCompanyInfo(raw: unknown, defaults: CompanyInfo = DEFAULT_COMPANY): CompanyInfo {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return cloneDefaults(defaults); }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return cloneDefaults(defaults);

  const o = obj as Record<string, unknown>;
  const bank = (o.bank && typeof o.bank === 'object' ? o.bank : {}) as Record<string, unknown>;

  return {
    nameEn:  strField(o, 'nameEn',  defaults.nameEn),
    nameAr:  strField(o, 'nameAr',  defaults.nameAr),
    address: strField(o, 'address', defaults.address),
    phone:   strField(o, 'phone',   defaults.phone),
    email:   strField(o, 'email',   defaults.email),
    website: strField(o, 'website', defaults.website),
    bank: {
      bankName:      strField(bank, 'bankName',      defaults.bank.bankName),
      accountName:   strField(bank, 'accountName',   defaults.bank.accountName),
      accountNumber: strField(bank, 'accountNumber', defaults.bank.accountNumber),
      iban:          strField(bank, 'iban',          defaults.bank.iban),
      swift:         strField(bank, 'swift',         defaults.bank.swift),
    },
    terms: Array.isArray(o.terms)
      ? o.terms.map(t => clean(t)).filter(Boolean).slice(0, MAX_TERMS)
      : [...defaults.terms],
  };
}

/** Trims / caps everything and drops blank terms — what actually gets saved. */
export function sanitizeCompanyInfo(info: CompanyInfo): CompanyInfo {
  return parseCompanyInfo(JSON.parse(JSON.stringify(info)), {
    ...DEFAULT_COMPANY,
    // a form always sends every field, so defaults are never used for strings
    terms: [],
  });
}

// ── Load / save (cached for the session) ─────────────────────────────────────

let _cache: CompanyInfo | null = null;

export async function loadInvoiceCompany(force = false): Promise<CompanyInfo> {
  if (_cache && !force) return _cache;
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', INVOICE_SETTINGS_KEY).maybeSingle();
    _cache = parseCompanyInfo(data?.value);
  } catch {
    _cache = cloneDefaults(DEFAULT_COMPANY);
  }
  return _cache;
}

export async function saveInvoiceCompany(info: CompanyInfo): Promise<{ error: string | null; saved: CompanyInfo }> {
  const saved = sanitizeCompanyInfo(info);
  const { error } = await supabase.from('app_settings')
    .upsert({ key: INVOICE_SETTINGS_KEY, value: JSON.stringify(saved), updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) return { error: error.message, saved };
  _cache = saved;
  return { error: null, saved };
}

/** A fully-filled example invoice used by the "Preview" button in Invoice Settings. */
export function sampleInvoiceArgs(company: CompanyInfo, logoUrl: string): BuildInvoiceArgs {
  const items = [
    { site_id: 'BSR-001', section_name: 'Sample Section', description: 'Installation & integration', amount: 1250000 },
    { site_id: 'BSR-002', section_name: 'Sample Section', description: 'Installation & integration', amount: 1300000 },
    { site_id: 'BSR-003', section_name: 'Sample Section', description: 'ATP & clearance', amount: 950000 },
  ];
  const total = items.reduce((s, i) => s + i.amount, 0);
  return {
    invoice: {
      invoice_number: 'SAMPLE-0001', project_name: 'Sample Project', status: 'Sent',
      issue_date: new Date().toISOString().slice(0, 10), due_date: null,
      total_amount: total, amount_received: 0, notes: 'This is a preview using sample data.',
    },
    client: {
      company_name: 'Sample Client Co.', contact_person: 'Contact Person',
      email: 'client@example.com', phone: '+964 000 000 0000', address: 'Client address',
    },
    items, payments: [], company, logoUrl, autoPrint: false,
  };
}
