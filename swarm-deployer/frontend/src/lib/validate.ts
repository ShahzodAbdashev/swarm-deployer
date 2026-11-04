/** Client-side validators mirroring SPEC §2 (the server re-checks everything). */

export const RX = {
  svc: /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/,
  host: /^[A-Za-z0-9][A-Za-z0-9.:-]*$/,
  user: /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/,
  tid: /^[a-z0-9][a-z0-9-]{0,31}$/,
  repo: /^([a-z0-9.-]+(:[0-9]{1,5})?\/)?[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*$/,
  tag: /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/,
  url: /^https?:\/\/\S+$/,
  pub: /^\d{1,5}:\d{1,5}$/,
  reg: /^[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?$/,
};

export function pathErr(v: string): string | null {
  if (!v) return 'Path is required.';
  if (!v.startsWith('/')) return 'Use a full path starting with /, e.g. /home/deploy/sd-work.';
  if (v.split('/').includes('..') || /[\x00-\x1f\x7f]/.test(v)) return 'This path is not allowed.';
  if (v.length > 1024) return 'Max 1024 characters.';
  return null;
}
export function portErr(n: number): string | null { return Number.isInteger(n) && n >= 1 && n <= 65535 ? null : 'Port must be 1–65535.'; }
export function hostErr(v: string): string | null { return !v ? 'Enter a host.' : v.length > 253 || !RX.host.test(v) ? 'Use a hostname or IP address.' : null; }
export function userErr(v: string, optional?: boolean): string | null {
  return !v ? (optional ? null : 'Enter a username.') : RX.user.test(v) ? null : 'Use letters, numbers, . _ - (max 64).';
}
export function intErr(n: number, a: number, b: number): string | null {
  return Number.isInteger(n) && n >= a && n <= b ? null : 'Use a whole number from ' + a + ' to ' + b + '.';
}
export function tagErr(v: string): string | null {
  if (!v || v === '@current') return null;
  if (!RX.tag.test(v) || /^backup-/.test(v) || /^\d{8}_\d{6}$/.test(v)) return 'Use letters, numbers, . _ - (not backup-… or a timestamp). Leave empty to turn off.';
  return null;
}

/** Errors keyed by field id, in focus order; returns the first id or null. */
export function firstErr(errs: Record<string, string | null | undefined>): string | null {
  return Object.keys(errs).find(k => errs[k]) || null;
}

/** Map a server "field: message" detail to one of the form's field ids. */
export function detailField(detail: string, resolve: (prefix: string) => string | undefined): string | undefined {
  return resolve(String(detail || '').split(':')[0].trim());
}
