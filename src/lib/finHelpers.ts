export const FIN_PROJECTS = ['Zain Project', 'Nokia Project', 'Huawei Project', 'IPT Project', 'General'];

export const FIN_MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

export function iqd(n: number | null | undefined): string {
  if (n == null) return '—';
  const v = Math.round(+n);
  return isNaN(v) ? '—' : v.toLocaleString('en-US') + ' IQD';
}

export function getYears(): number[] {
  const y = new Date().getFullYear();
  return [y - 2, y - 1, y, y + 1];
}

export function fmtK(v: number): string {
  const a = Math.abs(v);
  return a >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : a >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : v.toLocaleString('en-US');
}
