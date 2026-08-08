// Dedup key for UNKNOWN_IDENTIFIER scan entries.
// Trim-only; no case normalization — arbitrary QR payloads are case-sensitive.
export function makeIdentifierKey(raw: string): string {
  return raw.trim();
}
