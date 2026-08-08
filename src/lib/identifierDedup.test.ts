import { describe, it, expect } from 'vitest';
import { makeIdentifierKey } from './identifierDedup';

describe('makeIdentifierKey', () => {
  it('returns the raw value unchanged when no leading/trailing whitespace', () => {
    expect(makeIdentifierKey('10116110')).toBe('10116110');
  });

  it('trims leading and trailing whitespace', () => {
    expect(makeIdentifierKey('  10116110  ')).toBe('10116110');
    expect(makeIdentifierKey('\t10116110\n')).toBe('10116110');
  });

  it('preserves internal whitespace', () => {
    expect(makeIdentifierKey('ABC 123')).toBe('ABC 123');
  });

  it('is case-sensitive — does not uppercase', () => {
    expect(makeIdentifierKey('abc123')).toBe('abc123');
    expect(makeIdentifierKey('ABC123')).toBe('ABC123');
    expect(makeIdentifierKey('abc123')).not.toBe(makeIdentifierKey('ABC123'));
  });

  it('preserves special characters and slashes', () => {
    expect(makeIdentifierKey('ZAIN/2024/001')).toBe('ZAIN/2024/001');
    expect(makeIdentifierKey('A-B.C')).toBe('A-B.C');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(makeIdentifierKey('   ')).toBe('');
  });
});

describe('Set-based UNKNOWN_IDENTIFIER dedup', () => {
  it('blocks second scan of same code', () => {
    const seen = new Set<string>();
    const key1 = makeIdentifierKey('10116110');
    expect(seen.has(key1)).toBe(false);
    seen.add(key1);
    expect(seen.has(makeIdentifierKey('10116110'))).toBe(true);
  });

  it('allows distinct codes through', () => {
    const seen = new Set<string>();
    seen.add(makeIdentifierKey('10116110'));
    expect(seen.has(makeIdentifierKey('10116111'))).toBe(false);
  });

  it('treats different-case codes as distinct entries', () => {
    const seen = new Set<string>();
    seen.add(makeIdentifierKey('ABC123'));
    expect(seen.has(makeIdentifierKey('abc123'))).toBe(false);
  });

  it('allows re-scan after entry removal', () => {
    const seen = new Set<string>();
    const key = makeIdentifierKey('10116110');
    seen.add(key);
    seen.delete(key);
    expect(seen.has(key)).toBe(false);
  });

  it('clear resets all keys', () => {
    const seen = new Set<string>();
    seen.add(makeIdentifierKey('10116110'));
    seen.add(makeIdentifierKey('ZAIN/2024'));
    seen.clear();
    expect(seen.size).toBe(0);
    expect(seen.has(makeIdentifierKey('10116110'))).toBe(false);
  });

  it('url-payload key matches on re-scan', () => {
    const seen = new Set<string>();
    const url = 'https://zain.com/promo/qr?id=abc';
    seen.add(makeIdentifierKey(url));
    expect(seen.has(makeIdentifierKey(url))).toBe(true);
    expect(seen.has(makeIdentifierKey(url + '1'))).toBe(false);
  });
});
