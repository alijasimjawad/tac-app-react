// ── Default company details printed on invoices ─────────────────────────────
//
// These are only the DEFAULTS. Admins change the real values from the app
// (Invoices → Invoice Settings); those are saved in the app_settings table
// and take priority — see lib/invoiceSettings.ts. Any field left blank is
// simply hidden on the invoice. The bank block is shown only when at least one
// bank field is filled in; the terms block only when `terms` is non-empty.

export interface CompanyInfo {
  nameEn:  string;
  nameAr:  string;
  address: string;
  phone:   string;
  email:   string;
  website: string;
  bank: {
    bankName:      string;
    accountName:   string;
    accountNumber: string;
    iban:          string;
    swift:         string;
  };
  terms: string[];
}

export const DEFAULT_COMPANY: CompanyInfo = {
  nameEn:  'Tareeq Al-Ahmadi Company',
  nameAr:  'شركة طريق الأحمدي',
  address: '',
  phone:   '',
  email:   '',
  website: '',
  bank: {
    bankName:      '',
    accountName:   '',
    accountNumber: '',
    iban:          '',
    swift:         '',
  },
  terms: [
    'Payment is due within 30 days of the invoice date unless otherwise agreed in writing.',
    'Please quote the invoice number with every payment.',
    'All amounts are stated in Iraqi Dinars (IQD).',
    'Any discrepancy must be reported within 7 days of receiving this invoice.',
  ],
};

/** @deprecated use DEFAULT_COMPANY — kept so older imports keep compiling. */
export const COMPANY = DEFAULT_COMPANY;
