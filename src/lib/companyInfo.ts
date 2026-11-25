// ── Company details printed on invoices ─────────────────────────────────────
//
// Edit the values below to change what appears on every printed invoice.
// Any field left as '' is simply hidden on the invoice — nothing breaks, no
// empty boxes are drawn. The bank block is shown only when at least one bank
// field is filled in; the terms block only when `terms` is non-empty.

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

export const COMPANY: CompanyInfo = {
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
