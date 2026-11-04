import {parseT} from '@devtools/ui';
import type {Target} from '../types/api';

/** Local date + 24h time with seconds, e.g. "Nov 2, 2026, 19:05:00". */
export function localT(iso: string | null | undefined): string {
  const t = parseT(iso);
  return t ? new Date(t).toLocaleString([], {year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'}) : '';
}

/** "20261102_190005" → "20261102 19:00:05". */
export function fmtTs(ts: string | null | undefined): string {
  const m = /^(\d{8})_(\d\d)(\d\d)(\d\d)$/.exec(ts || '');
  return m ? m[1] + ' ' + m[2] + ':' + m[3] + ':' + m[4] : ts || '';
}

/** Tag of an image ref ("repo:tag[@sha256:…]" → "tag"; no tag → "latest"). */
export function tagOf(img: string | null | undefined): string {
  if (!img) return '';
  img = img.split('@')[0];
  const i = img.lastIndexOf(':');
  return i > img.lastIndexOf('/') ? img.slice(i + 1) : 'latest';
}

export function basename(p: string | null | undefined): string { return String(p || '').replace(/\/+$/, '').split('/').pop() || ''; }
export function dirname(p: string | null | undefined): string { const s = String(p || ''); const i = s.lastIndexOf('/'); return i <= 0 ? '/' : s.slice(0, i); }
export function joinPath(a: string, b: string): string { return (a.endsWith('/') ? a : a + '/') + b; }
export function targetLabel(t: Pick<Target, 'username' | 'host' | 'port'> | null | undefined): string {
  return t ? (t.username ? t.username + '@' : '') + t.host + ':' + t.port : '';
}

/** Registry mode for a mapping (AD-2): the target has a registry and the image repo lives under it. */
export function registryOf(t: {registry?: {url: string} | null} | null | undefined, repo: string | null | undefined): string | null {
  const u = t?.registry?.url;
  return u && (repo || '').startsWith(u + '/') ? u : null;
}

/** Moving tag as shown: "@current" becomes "<tag the service runs now> (@current)" when known. */
export function movingText(mt: string | null | undefined, currentImage: string | null | undefined): string {
  if (mt !== '@current') return mt || '';
  return currentImage ? tagOf(currentImage) + ' (@current)' : '@current';
}
