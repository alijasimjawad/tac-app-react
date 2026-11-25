// ── Invoice helpers — pure (DOM-free) logic ─────────────────────────────────

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
  'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const SCALES = ['', 'Thousand', 'Million', 'Billion', 'Trillion'];

/** Words for 1..999. */
function belowThousand(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (rest) {
    if (rest < 20) parts.push(ONES[rest]);
    else {
      const t = TENS[Math.floor(rest / 10)];
      const o = ONES[rest % 10];
      parts.push(o ? `${t}-${o}` : t);
    }
  }
  return parts.join(' ');
}

/**
 * Writes a whole-dinar amount in English words, e.g.
 *   1500000 → "One Million Five Hundred Thousand Iraqi Dinars Only"
 * IQD has no practical fractional unit, so the amount is rounded to the
 * nearest dinar. Non-finite input is treated as zero. Amounts of one
 * quadrillion or more fall back to digits rather than guessing.
 */
export function amountInWords(value: number | null | undefined): string {
  const raw = Number(value);
  const n = Number.isFinite(raw) ? Math.round(Math.abs(raw)) : 0;
  const negative = Number.isFinite(raw) && raw < 0 && n > 0;

  if (n === 0) return 'Zero Iraqi Dinars Only';
  if (n >= 1e15) return `${n.toLocaleString('en-US')} Iraqi Dinars Only`;

  const groups: string[] = [];
  let remaining = n;
  let scale = 0;
  while (remaining > 0) {
    const chunk = remaining % 1000;
    if (chunk) groups.unshift(`${belowThousand(chunk)}${SCALES[scale] ? ' ' + SCALES[scale] : ''}`);
    remaining = Math.floor(remaining / 1000);
    scale++;
  }

  const unit = n === 1 ? 'Iraqi Dinar' : 'Iraqi Dinars';
  return `${negative ? 'Minus ' : ''}${groups.join(' ')} ${unit} Only`;
}

/** '2026-11-15' → '15 Nov 2026'. Returns the input unchanged if it isn't a valid date. */
export function fmtInvoiceDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
