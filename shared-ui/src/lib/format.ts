/** Time and size formatting shared by both tools. All inputs are ISO strings or milliseconds. */

export function parseT(s: string | null | undefined): number | null {
  return s ? new Date(s).getTime() : null;
}

/** Compact duration: <1s, 12s, 3:05, 1h 02m. */
export function fmtDur(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || isNaN(ms)) return '';
  const s = Math.max(0, ms) / 1000;
  if (s < 1) return '<1s';
  if (s < 60) return Math.floor(s) + 's';
  if (s < 3600) return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  return Math.floor(s / 3600) + 'h ' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + 'm';
}

/** Long duration: 12s, 3m 05s, 1h 02m. */
export function fmtDurLong(ms: number): string {
  const s = Math.round(Math.max(0, ms) / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
}

/** Duration for screen readers: "1 minute 5 seconds". */
export function spoken(ms: number): string {
  const s = Math.round(Math.max(0, ms) / 1000), m = Math.floor(s / 60), r = s % 60;
  const p: string[] = [];
  if (m) p.push(m + (m === 1 ? ' minute' : ' minutes'));
  if (r || !m) p.push(r + (r === 1 ? ' second' : ' seconds'));
  return p.join(' ');
}

/** Relative time: just now, 5 min ago, 3 h ago, yesterday, Nov 2. */
export function fmtRel(iso: string | null | undefined): string {
  const t = parseT(iso);
  if (!t) return '';
  const d = (Date.now() - t) / 1000;
  if (d < 45) return 'just now';
  if (d < 3600) return Math.max(1, Math.round(d / 60)) + ' min ago';
  if (d < 86400) return Math.round(d / 3600) + ' h ago';
  const dt = new Date(t), y = new Date();
  y.setDate(y.getDate() - 1);
  if (dt.toDateString() === y.toDateString()) return 'yesterday';
  return dt.toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: dt.getFullYear() === new Date().getFullYear() ? undefined : 'numeric'});
}

export function fmtSize(b: number | null | undefined): string {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return (i === 0 || b >= 100 ? Math.round(b) : b.toFixed(1)) + ' ' + u[i];
}

/** 24h clock time, e.g. 19:05. */
export function hhmm(iso: string | null | undefined): string {
  const t = parseT(iso);
  return t ? new Date(t).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}) : '';
}

export function localTime(iso: string | null | undefined): string {
  const t = parseT(iso);
  return t ? new Date(t).toLocaleString() : '';
}
