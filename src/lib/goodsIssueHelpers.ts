// Pure helpers for Goods Issue workflow — no Supabase imports, testable in isolation.

export type DestinationType = 'SITE' | 'TEAM_MEMBER' | 'USER' | 'VEHICLE' | 'EXTERNAL' | 'OTHER';
export type GoodsIssueStatus = 'DRAFT' | 'POSTED' | 'CANCELLED';

const ID_REQUIRED: ReadonlySet<DestinationType> = new Set(['TEAM_MEMBER', 'USER']);

export function destinationTypeRequiresId(type: DestinationType): boolean {
  return ID_REQUIRED.has(type);
}

export function validateDestination(
  type: DestinationType,
  id: string | null,
  label: string,
): string | null {
  if (!label.trim()) return 'Destination label is required';
  if (destinationTypeRequiresId(type) && !id) return 'A selection is required for this destination type';
  return null;
}

export function isDuplicateAsset(selectedIds: string[], newId: string): boolean {
  return selectedIds.includes(newId);
}

export function validateSerializedCount(selectedCount: number, lineQty: number): string | null {
  if (selectedCount !== lineQty) {
    return `Must scan exactly ${lineQty} asset${lineQty !== 1 ? 's' : ''} — ${selectedCount} scanned`;
  }
  return null;
}

export function validateQuantityIssue(requested: number, available: number): string | null {
  if (requested <= 0) return 'Quantity must be greater than 0';
  if (requested > available) return `Only ${available} available`;
  return null;
}

export function checkAssetBelongsToIssue(
  assetProjectId: string | null,
  issueProjectId: string,
  assetWarehouseId: string | null,
  issueWarehouseId: string,
): string | null {
  if (assetProjectId !== issueProjectId) return 'Asset belongs to a different project';
  if (assetWarehouseId !== issueWarehouseId) return 'Asset is in a different warehouse';
  return null;
}

export function checkAssetItemMatch(
  assetItemId: string,
  lineItemId: string,
): string | null {
  if (assetItemId !== lineItemId) return 'Asset belongs to a different item type';
  return null;
}

export function isDuplicateItem(
  lines: Array<{ itemId: string }>,
  newItemId: string,
): boolean {
  return lines.some(l => l.itemId === newItemId);
}

export function canCancelIssue(status: string): boolean {
  return status === 'DRAFT';
}

export function canPostIssue(status: string): boolean {
  return status === 'DRAFT';
}

export function computeAvailableQty(onHand: number, reserved: number): number {
  return Math.max(0, onHand - reserved);
}
