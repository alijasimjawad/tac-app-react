// ── Warehouse Posting — pure (DOM-free) helpers for post_goods_receipt RPC ────

export interface PostReceiptSuccess {
  success:            true;
  receipt_number:     string;
  assets_created:     number;
  movements_created:  number;
}

export function formatPostingToast(result: PostReceiptSuccess): string {
  const parts = [`Receipt ${result.receipt_number} posted.`];
  if (result.assets_created > 0)
    parts.push(`${result.assets_created} asset${result.assets_created === 1 ? '' : 's'} created.`);
  if (result.movements_created > 0)
    parts.push(`${result.movements_created} movement${result.movements_created === 1 ? '' : 's'} recorded.`);
  return parts.join(' ');
}

export function isAlreadyPostedError(message: string): boolean {
  return message.includes('not in PENDING_REVIEW status');
}

export function isDuplicateSnError(message: string): boolean {
  return message.includes('Duplicate serial number') || message.includes('already in inventory');
}

export function isQuantityMismatchError(message: string): boolean {
  return message.includes('scan count') && message.includes('does not match');
}

export function isInactiveItemError(message: string): boolean {
  return message.includes('is not active');
}

export function extractSnFromError(message: string): string | null {
  const m =
    message.match(/Serial number already in inventory: (.+)/) ??
    message.match(/Duplicate serial number within receipt: (.+)/);
  return m ? m[1].trim() : null;
}

export function friendlyPostingError(message: string): string {
  if (isAlreadyPostedError(message))  return 'This receipt has already been posted.';
  if (isDuplicateSnError(message)) {
    const sn = extractSnFromError(message);
    return sn
      ? `Duplicate serial number: ${sn}`
      : 'A duplicate serial number was detected.';
  }
  if (isQuantityMismatchError(message)) return 'Scan count does not match receipt quantity for one or more items.';
  if (isInactiveItemError(message))     return 'One or more items in this receipt are no longer active.';
  return message;
}
