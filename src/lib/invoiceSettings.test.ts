import { describe, it, expect, vi } from 'vitest';

// supabase is imported by the module for load/save; the pure functions under
// test never touch it.
vi.mock('./supabase', () => ({ supabase: {} }));

import { parseCompanyInfo, sanitizeCompanyInfo } from './invoiceSettings';
import { DEFAULT_COMPANY } from './companyInfo';

describe('parseCompanyInfo()', () => {
  it('returns defaults for null / undefined / garbage', () => {
    expect(parseCompanyInfo(null)).toEqual(DEFAULT_COMPANY);
    expect(parseCompanyInfo(undefined)).toEqual(DEFAULT_COMPANY);
    expect(parseCompanyInfo('not json {')).toEqual(DEFAULT_COMPANY);
    expect(parseCompanyInfo('42')).toEqual(DEFAULT_COMPANY);
    expect(parseCompanyInfo('[1,2]')).toEqual(DEFAULT_COMPANY);
  });

  it('never returns the shared defaults object (no accidental mutation)', () => {
    const a = parseCompanyInfo(null);
    a.terms.push('x');
    a.bank.iban = 'changed';
    expect(DEFAULT_COMPANY.terms).not.toContain('x');
    expect(DEFAULT_COMPANY.bank.iban).toBe('');
  });

  it('uses saved values and falls back per field for missing ones', () => {
    const info = parseCompanyInfo(JSON.stringify({ phone: ' +964 770 ', bank: { iban: 'IQ12' } }));
    expect(info.phone).toBe('+964 770');
    expect(info.bank.iban).toBe('IQ12');
    expect(info.nameEn).toBe(DEFAULT_COMPANY.nameEn);
    expect(info.bank.bankName).toBe('');
    expect(info.terms).toEqual(DEFAULT_COMPANY.terms);
  });

  it('keeps a field saved as blank blank (admin hid it)', () => {
    const custom = { ...DEFAULT_COMPANY, website: 'www.default.com' };
    const info = parseCompanyInfo({ website: '' }, custom);
    expect(info.website).toBe('');
  });

  it('ignores non-string field values', () => {
    const info = parseCompanyInfo({ phone: 123, email: { a: 1 } });
    expect(info.phone).toBe('');
    expect(info.email).toBe('');
  });

  it('uses a saved terms list, drops blanks, and caps the count', () => {
    const many = Array.from({ length: 20 }, (_, i) => `Term ${i + 1}`);
    const info = parseCompanyInfo({ terms: ['  One  ', '', '   ', 'Two', ...many] });
    expect(info.terms.slice(0, 2)).toEqual(['One', 'Two']);
    expect(info.terms).toHaveLength(12);
  });

  it('an explicitly empty terms list stays empty (hides the block)', () => {
    expect(parseCompanyInfo({ terms: [] }).terms).toEqual([]);
  });

  it('caps very long values', () => {
    expect(parseCompanyInfo({ address: 'x'.repeat(1000) }).address).toHaveLength(300);
  });
});

describe('sanitizeCompanyInfo()', () => {
  it('trims fields and drops blank terms but keeps blank fields blank', () => {
    const out = sanitizeCompanyInfo({
      ...DEFAULT_COMPANY,
      address: '  Basra  ',
      website: '',
      bank: { ...DEFAULT_COMPANY.bank, iban: '  IQ99  ' },
      terms: ['  Pay in 30 days ', '', '  '],
    });
    expect(out.address).toBe('Basra');
    expect(out.website).toBe('');
    expect(out.bank.iban).toBe('IQ99');
    expect(out.terms).toEqual(['Pay in 30 days']);
  });

  it('keeps an empty terms list empty instead of restoring defaults', () => {
    expect(sanitizeCompanyInfo({ ...DEFAULT_COMPANY, terms: [] }).terms).toEqual([]);
  });
});
