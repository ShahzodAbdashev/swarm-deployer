// Validation (client-side mirrors of the backend rules, SPEC.md §2) and job helpers.
import {confirm, fmtSize, h, parseT, toast} from './ui.js';
import {errDetail, getAuth, jobsApi} from './state.js';

export const SVC_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const BR_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
export const URL_MSG = "That doesn't look like a Git URL. Use https://…, ssh://…, git@host:path, file://… or an absolute path.";
export const SVC_MSG = 'Use letters, numbers, . _ - and start with a letter or number (max 63).';

export const validGitUrl = u => u.length <= 500 && !/\s/.test(u) && !u.startsWith('-') && /^(https:\/\/|http:\/\/|ssh:\/\/|git@|file:\/\/|\/)/.test(u) && u.length > 1;
export const validBranch = b => BR_RE.test(b) && !b.includes('..') && !b.includes('//') && !b.endsWith('/') && !b.endsWith('.lock');

export function remotePathErr(v) {
  if (!v) return 'Remote path is required.';
  if (!v.startsWith('/')) return 'Use a full path starting with /, e.g. /home/deploy/releases.';
  if (v.split('/').includes('..') || /[\x00-\x1f]/.test(v)) return 'This path is not allowed.';
  return null;
}

/** group/name for a URL on the signed-in GitLab host (same scheme + host, no userinfo), else ''. */
function gitlabPath(u) {
  const gl = getAuth()?.gitlab?.url;
  if (!gl || !u) return '';
  try {
    const a = new URL(u), b = new URL(gl);
    if (a.protocol !== b.protocol || a.host !== b.host || a.username) return '';
    const p = a.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
    return p.includes('/') ? p : '';
  } catch { return ''; }
}
export const onGitlab = u => !!gitlabPath(u);

/** owner/repo for github.com HTTPS URLs, group/name for GitLab ones, else ''. */
export function repoFullFromUrl(u) {
  const m = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(\.git)?\/?$/.exec(u || '');
  return m ? m[1] + '/' + m[2] : gitlabPath(u);
}

const ENV_KEY = /^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
/** Key names in .env content (first occurrence order, no duplicates). */
export function envKeys(content) {
  const out = [];
  for (const l of (content || '').split(/\r?\n|\r/)) { const m = ENV_KEY.exec(l); if (m && !out.includes(m[2])) out.push(m[2]); }
  return out;
}
export const preloadList = s => s.split('\n').map(x => x.trim()).filter(Boolean);
/** Last path segment without .git, e.g. "svcrepo". */
export const baseName = u => String(u || '').replace(/\/+$/, '').split(/[/:]/).pop().replace(/\.git$/, '');
export const repoLabel = u => repoFullFromUrl(u) || baseName(u) || u;
/** Turn a repo name into a valid service name. */
export const sanitize = n => String(n || '').replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 63);

// ---------------------------------------------------------------- jobs

export const STEP_LABEL = {
  prepare: 'Prepare workspace', clone: 'Clone repository', build: 'Build image', save: 'Save image (.tar)',
  extra_repos: 'Clone extra repositories', zip: 'Encrypt zip', upload: 'Upload',
};
export const jobActive = j => !!j && (j.status === 'running' || j.status === 'queued');
export function jobDur(j) {
  const a = parseT(j.created_at), b = j.finished_at ? parseT(j.finished_at) : Date.now();
  return a ? b - a : null;
}
export function curStep(job) {
  const i = job.steps.findIndex(s => s.status === 'running');
  return i < 0 ? null : {i, s: job.steps[i]};
}
export const failedStep = job => job.steps.find(s => s.status === 'failed') || null;

/** Second line of a dashboard row. */
export function jobLine2(j) {
  if (j.status === 'running') { const c = curStep(j); return c ? 'Running · ' + STEP_LABEL[c.s.name] + ' (' + (c.i + 1) + '/' + j.steps.length + ')' : 'Running'; }
  if (j.status === 'queued') return 'Queued';
  if (j.status === 'success') return 'Succeeded · zip ' + fmtSize(j.artifacts.zip_size) + (j.artifacts.remote_path ? ' · uploaded' : ' · saved locally');
  const f = failedStep(j);
  return 'Failed at ' + (f ? STEP_LABEL[f.name] : 'start') + (j.error ? ' · ' + j.error : '');
}

const HINT = {
  prepare: 'The build folder already exists. Try again in a second.',
  clone: 'Check the branch name and that you have access to the repository. If you gave a GitLab project, check your GitLab sign-in.',
  save: 'Check free disk space.', zip: 'Check free disk space.',
  extra_repos: 'Check the extra repository URL and branch.',
  upload: 'Test the connection in Settings. The zip is still available to download.',
};
export function hintFor(job, f) {
  if (job.error === 'interrupted (server restart)') return 'The server restarted while this build was running. Start it again.';
  if (!f) return '';
  if (f.name === 'build') return /^Dockerfile not found/.test(job.error || '') ? 'Check the Dockerfile path in Advanced options.' : 'See the docker build output in the log. Check the preload tar paths and the .env.';
  return HINT[f.name] || '';
}

export const uploadConfigured = c => !!(c && c.enabled && c.host);
export function uploadTarget(c, withUser, dirOverride) {
  const rd = dirOverride || c.remote_dir;
  const dir = rd ? (rd.startsWith('/') ? rd : '/' + rd) : '/';
  const share = c.protocol === 'smb' && c.share ? '/' + c.share : '';
  return c.protocol + '://' + (withUser && c.username ? c.username + '@' : '') + c.host + ':' + c.port + share + dir;
}

/** Confirm, delete, toast. Resolves true when the build was deleted. */
export async function deleteJob(j) {
  const ok = await confirm({
    title: 'Delete this build?', confirm: 'Delete build',
    body: h('span', {}, 'Deletes the log, the workspace folder and the zip for ', h('code', {}, j.folder_name),
      ' from this computer. Files already uploaded to your server are not touched.'),
  });
  if (!ok) return false;
  try { await jobsApi.remove(j.id); toast('Build deleted', 'success'); return true; }
  catch (e) { const {status, detail} = errDetail(e); toast(status === 409 ? 'This build is still running.' : detail, 'error'); return false; }
}
