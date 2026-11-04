import {getAuth} from '../state/session';

/** Client-side mirrors of the backend validation rules (SPEC.md §2). */

export const SVC_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const BR_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
export const URL_MSG = "That doesn't look like a Git URL. Use https://…, ssh://…, git@host:path, file://… or an absolute path.";
export const SVC_MSG = 'Use letters, numbers, . _ - and start with a letter or number (max 63).';

export function validGitUrl(u: string): boolean {
  return u.length <= 500 && !/\s/.test(u) && !u.startsWith('-') && /^(https:\/\/|http:\/\/|ssh:\/\/|git@|file:\/\/|\/)/.test(u) && u.length > 1;
}

export function validBranch(b: string): boolean {
  return BR_RE.test(b) && !b.includes('..') && !b.includes('//') && !b.endsWith('/') && !b.endsWith('.lock');
}

export function remotePathErr(v: string): string | null {
  if (!v) return 'Remote path is required.';
  if (!v.startsWith('/')) return 'Use a full path starting with /, e.g. /home/deploy/releases.';
  if (v.split('/').includes('..') || /[\x00-\x1f]/.test(v)) return 'This path is not allowed.';
  return null;
}

/** group/name for a URL on the signed-in GitLab host (same scheme + host, no userinfo), else ''. */
function gitlabPath(u: string): string {
  const gl = getAuth()?.gitlab?.url;
  if (!gl || !u) return '';
  try {
    const a = new URL(u), b = new URL(gl);
    if (a.protocol !== b.protocol || a.host !== b.host || a.username) return '';
    const p = a.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
    return p.includes('/') ? p : '';
  } catch { return ''; }
}

export const onGitlab = (u: string): boolean => !!gitlabPath(u);

/** owner/repo for github.com HTTPS URLs, group/name for GitLab ones, else ''. */
export function repoFullFromUrl(u: string): string {
  const m = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(\.git)?\/?$/.exec(u || '');
  return m ? m[1] + '/' + m[2] : gitlabPath(u);
}

const ENV_KEY = /^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** Key names in .env content (first occurrence order, no duplicates). */
export function envKeys(content: string): string[] {
  const out: string[] = [];
  for (const l of (content || '').split(/\r?\n|\r/)) { const m = ENV_KEY.exec(l); if (m && !out.includes(m[2])) out.push(m[2]); }
  return out;
}

export const preloadList = (s: string): string[] => s.split('\n').map(x => x.trim()).filter(Boolean);

/** Last path segment without .git, e.g. "svcrepo". */
export function baseName(u: string): string {
  return String(u || '').replace(/\/+$/, '').split(/[/:]/).pop()!.replace(/\.git$/, '');
}

export function repoLabel(u: string): string { return repoFullFromUrl(u) || baseName(u) || u; }

/** Turn a repo name into a valid service name. */
export function sanitize(n: string): string {
  return String(n || '').replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 63);
}
