import { describe, it, expect } from 'vitest';
import { amountInWords, fmtInvoiceDate } from './invoiceHelpers';

describe('amountInWords()', () => {
  it('handles zero and bad input', () => {
    expect(amountInWords(0)).toBe('Zero Iraqi Dinars Only');
    expect(amountInWords(null)).toBe('Zero Iraqi Dinars Only');
    expect(amountInWords(undefined)).toBe('Zero Iraqi Dinars Only');
    expect(amountInWords(NaN)).toBe('Zero Iraqi Dinars Only');
  });

  it('uses the singular for exactly one dinar', () => {
    expect(amountInWords(1)).toBe('One Iraqi Dinar Only');
  });

  it('writes teens, tens and hyphenated compounds', () => {
    expect(amountInWords(13)).toBe('Thirteen Iraqi Dinars Only');
    expect(amountInWords(20)).toBe('Twenty Iraqi Dinars Only');
    expect(amountInWords(21)).toBe('Twenty-One Iraqi Dinars Only');
    expect(amountInWords(99)).toBe('Ninety-Nine Iraqi Dinars Only');
  });

  it('writes hundreds', () => {
    expect(amountInWords(100)).toBe('One Hundred Iraqi Dinars Only');
    expect(amountInWords(101)).toBe('One Hundred One Iraqi Dinars Only');
    expect(amountInWords(342)).toBe('Three Hundred Forty-Two Iraqi Dinars Only');
  });

  it('writes thousands and skips empty groups', () => {
    expect(amountInWords(1000)).toBe('One Thousand Iraqi Dinars Only');
    expect(amountInWords(1001)).toBe('One Thousand One Iraqi Dinars Only');
    expect(amountInWords(1_000_000)).toBe('One Million Iraqi Dinars Only');
    expect(amountInWords(1_000_001)).toBe('One Million One Iraqi Dinars Only');
  });

  it('writes typical invoice amounts', () => {
    expect(amountInWords(1_500_000)).toBe('One Million Five Hundred Thousand Iraqi Dinars Only');
    expect(amountInWords(1_234_567)).toBe(
      'One Million Two Hundred Thirty-Four Thousand Five Hundred Sixty-Seven Iraqi Dinars Only',
    );
    expect(amountInWords(12_000_000)).toBe('Twelve Million Iraqi Dinars Only');
    expect(amountInWords(2_500_000_000)).toBe('Two Billion Five Hundred Million Iraqi Dinars Only');
  });

  it('rounds to the nearest dinar', () => {
    expect(amountInWords(99.6)).toBe('One Hundred Iraqi Dinars Only');
    expect(amountInWords(1000.4)).toBe('One Thousand Iraqi Dinars Only');
  });

  it('marks negatives', () => {
    expect(amountInWords(-5000)).toBe('Minus Five Thousand Iraqi Dinars Only');
  });
});

describe('fmtInvoiceDate()', () => {
  it('formats ISO dates', () => {
    expect(fmtInvoiceDate('2026-11-15')).toBe('15 Nov 2026');
  });
  it('accepts full timestamps', () => {
    expect(fmtInvoiceDate('2026-01-05T10:20:30Z')).toBe('05 Jan 2026');
  });
  it('returns a dash for empty values', () => {
    expect(fmtInvoiceDate(null)).toBe('—');
    expect(fmtInvoiceDate('')).toBe('—');
  });
  it('returns unparseable input unchanged', () => {
    expect(fmtInvoiceDate('soon')).toBe('soon');
  });
});
