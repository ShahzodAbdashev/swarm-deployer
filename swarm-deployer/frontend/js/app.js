// Swarm Deployer domain helpers: API endpoints, formatting, job/phase helpers, validators, wizard draft, shared rows.
import {api, fmtDur, fmtRel, go, h, parseT, sget, sset, statusIcon, statusText} from './ui.js';

// ------------------------------------------------------------------ API (SPEC.md §4)

const enc = encodeURIComponent;
export const API = {
  config: () => api('GET', '/api/config'),
  createTarget: b => api('POST', '/api/targets', b),
  updateTarget: (id, b) => api('PUT', '/api/targets/' + enc(id), b),
  removeTarget: id => api('DELETE', '/api/targets/' + enc(id)),
  testTarget: id => api('POST', '/api/targets/' + enc(id) + '/test'),
  packages: (path, target) => api('GET', '/api/packages?path=' + enc(path) + '&target=' + enc(target)),
  services: () => api('GET', '/api/services'),
  service: pkg => api('GET', '/api/services/' + enc(pkg)),
  backups: pkg => api('GET', '/api/services/' + enc(pkg) + '/backups'),
  deploys: pkg => api('GET', pkg ? '/api/deploys?package=' + enc(pkg) : '/api/deploys'),
  deploy: id => api('GET', '/api/deploys/' + id),
  createDeploy: b => api('POST', '/api/deploys', b),
  plan: (package_path, password, target) => api('POST', '/api/deploys/plan', {package_path, password, target}),
  removeDeploy: id => api('DELETE', '/api/deploys/' + id),
  rollback: (pkg, backupId) => api('POST', '/api/rollbacks', {package: pkg, backup_id: backupId}),
  logUrl: id => '/api/deploys/' + id + '/log',
  logStreamUrl: id => '/api/deploys/' + id + '/logs/stream',
};

// ------------------------------------------------------------------ formatting

/** Local date + 24h time with seconds, e.g. "Nov 2, 2026, 19:05:00". */
export function localT(iso) {
  const t = parseT(iso);
  return t ? new Date(t).toLocaleString([], {year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'}) : '';
}
/** "20261102_190005" → "20261102 19:00:05". */
export function fmtTs(ts) {
  const m = /^(\d{8})_(\d\d)(\d\d)(\d\d)$/.exec(ts || '');
  return m ? m[1] + ' ' + m[2] + ':' + m[3] + ':' + m[4] : ts || '';
}
/** Tag of an image ref ("repo:tag[@sha256:…]" → "tag"; no tag → "latest"). */
export function tagOf(img) {
  if (!img) return '';
  img = img.split('@')[0];
  const i = img.lastIndexOf(':');
  return i > img.lastIndexOf('/') ? img.slice(i + 1) : 'latest';
}
export const basename = p => String(p || '').replace(/\/+$/, '').split('/').pop() || '';
export function dirname(p) { const s = String(p || ''), i = s.lastIndexOf('/'); return i <= 0 ? '/' : s.slice(0, i); }
export const joinPath = (a, b) => (a.endsWith('/') ? a : a + '/') + b;
export const targetLabel = t => (t ? (t.username ? t.username + '@' : '') + t.host + ':' + t.port : '');
/** Moving tag as shown: "@current" becomes "<tag the service runs now> (@current)" when known. */
export function movingText(mt, currentImage) {
  if (mt !== '@current') return mt || '';
  return currentImage ? tagOf(currentImage) + ' (@current)' : '@current';
}

// ------------------------------------------------------------------ jobs and phases

const PLABEL = {
  fetch: 'Download package', extract: 'Unlock and check image', connect: 'Sign in to target', transfer: 'Upload image to target',
  backup: 'Back up current version', load: 'Load image', tag: 'Tag image', deploy: 'Update service', verify: 'Verify rollout', cleanup: 'Clean up',
};
/** Phase label; the tag phase also pushes when the job uses a registry. */
export const plabel = (name, job) => (name === 'tag' && job?.registry ? 'Tag and push image' : PLABEL[name] || name);

const PHINT = {
  fetch: "Check the target's packages folder in Settings and that the file still exists.",
  extract: 'Check the zip password. The package must come from Build Packager.',
  connect: 'Test the target in Settings. It must be a swarm manager.',
  transfer: 'Check free disk space in the work dir on the target.',
  backup: 'Check the backup dir permissions on the target.',
  load: 'See the docker load output in the log.', tag: 'See the log.',
  deploy: 'See the docker service update output in the log.',
  verify: 'The new version did not become healthy.',
  cleanup: 'Leftover files may remain in the work dir.',
};
/** "Try: …" hint on a failed run, per phase. */
export function phint(name, job) {
  if (name === 'tag' && job?.registry) return 'Check the registry login in the target settings.';
  if (name === 'verify') return PHINT.verify + ' If the package has .deploy/healthcheck.sh, see its output in the log.'
    + (job?.registry ? ' The moving tag is pushed to the registry only after these checks pass.' : '');
  return PHINT[name] || '';
}

/** (1) Build Packager <service>_<YYYYMMDD_HHMMSS>.zip, else (2) build_tar.sh <name>[_<ts>].tar.zip / <name>[_<ts>].zip (SPEC §11.1). */
const PKG_RE = /^([a-zA-Z0-9][a-zA-Z0-9_.-]{0,62})_(\d{8}_\d{6})\.zip$/;
const TARZIP_RE = /^([a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}?)(?:_(\d{8}_\d{6}))?(?:\.tar)?\.zip$/;
export function parsePkg(name) {
  const m = PKG_RE.exec(name);
  if (m) return {service: m[1], ts: m[2], fmt: 'packager'};
  const t = TARZIP_RE.exec(name);
  return t ? {service: t[1], ts: t[2] || null, fmt: 'tarzip'} : null;
}

export function phaseOf(job, st) {
  const ph = job.phases || [], i = ph.findIndex(p => p.status === st);
  return i < 0 ? null : {i, p: ph[i]};
}
export const failedPhase = job => phaseOf(job, 'failed')?.p ?? null;
export function jobDur(j) {
  const a = parseT(j.created_at), b = j.finished_at ? parseT(j.finished_at) : Date.now();
  return a ? b - a : null;
}
export const jobActive = j => !!j && (j.status === 'running' || j.status === 'queued');

/** Second line of a deploy row: what is running, what was deployed, or where it failed. */
export function jobLine2(j) {
  if (jobActive(j)) {
    const c = phaseOf(j, 'running');
    return c ? 'Running · ' + plabel(c.p.name, j) + ' (' + (c.i + 1) + '/' + j.phases.length + ')' : (j.status === 'queued' ? 'Queued' : 'Running');
  }
  if (j.status === 'success') return j.kind === 'rollback' ? 'Rolled back to ' + (j.new_image || '') : 'Succeeded · ' + (j.new_image || '');
  const f = failedPhase(j);
  return 'Failed at ' + (f ? plabel(f.name, j) : 'start') + (j.error ? ' · ' + j.error : '');
}

/** Deploy log line classes: skipped phases are dimmed, JSON dumps are never "errors", docker WARNINGs are amber. */
export function classifyDeployLine(text) {
  if (text.startsWith('==> JOB SUCCESS')) return 'ok hd';
  if (/^==> \[\w+\] skipped/.test(text)) return 'dim';
  if (/failed|error|JOB FAILED/i.test(text) && !/^[{[]/.test(text)) return 'er' + (text.startsWith('==>') ? ' hd' : '');
  if (/^WARNING/.test(text)) return 'wr';
  if (text.startsWith('==>')) return 'hd' + (/ started$/.test(text) ? ' start' : '');
  if (text.startsWith('$ ')) return 'cmd';
  return '';
}

/** One deploy (or rollback) in a list: status, package + badges, version → service, duration, age, second line. */
export function jobRow(j) {
  const l2 = jobLine2(j);
  return h('div', {class: 'jrow'},
    h('a', {href: '#/deploys/' + j.id, 'data-id': j.id, 'aria-label': (j.kind === 'rollback' ? 'Rollback ' : '') + j.package + ', ' + statusText(j.status) + ', ' + l2},
      statusIcon(j.status),
      h('span', {class: 'svc'}, j.package, j.kind === 'rollback' ? h('span', {class: 'badge', style: {marginLeft: '8px'}}, 'Rollback') : null),
      h('span', {class: 'src'}, (j.version || '') + ' → ' + (j.swarm_service || '')),
      h('span', {class: 'dur'}, fmtDur(jobDur(j))),
      h('time', {datetime: j.created_at || '', title: localT(j.created_at)}, fmtRel(j.created_at)),
      h('span', {class: 'line2' + (j.status === 'failed' ? ' danger' : ''), title: l2}, l2)));
}

// ------------------------------------------------------------------ validators (SPEC §2; the server re-checks everything)

export const RX = {
  host: /^[A-Za-z0-9][A-Za-z0-9.:-]*$/,
  user: /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/,
  tid: /^[a-z0-9][a-z0-9-]{0,31}$/,
  reg: /^[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?$/,
};
/** Targets with a packages folder: where packages can be picked from. */
export const pkgTargets = cfg => cfg.targets.filter(t => t.packages_dir);
export function pathErr(v) {
  if (!v) return 'Path is required.';
  if (!v.startsWith('/')) return 'Use a full path starting with /, e.g. /home/deploy/releases.';
  if (v.split('/').includes('..') || /[\x00-\x1f\x7f]/.test(v)) return 'This path is not allowed.';
  if (v.length > 1024) return 'Max 1024 characters.';
  return null;
}
export const portErr = n => (Number.isInteger(n) && n >= 1 && n <= 65535 ? null : 'Port must be 1–65535.');
export const hostErr = v => (!v ? 'Enter a host.' : v.length > 253 || !RX.host.test(v) ? 'Use a hostname or IP address.' : null);
export const userErr = (v, optional) => (!v ? (optional ? null : 'Enter a username.') : RX.user.test(v) ? null : 'Use letters, numbers, . _ - (max 64).');
export const intErr = (n, a, b) => (Number.isInteger(n) && n >= a && n <= b ? null : 'Use a whole number from ' + a + ' to ' + b + '.');
/** Map a server "field: message" detail to one of the form's field ids. */
export const detailField = (detail, resolve) => resolve(String(detail || '').split(':')[0].trim());

// ------------------------------------------------------------------ wizard draft + per-tab session flags

/** package_path / package / path / target go to sessionStorage['sd.draft']; the zip password lives in memory only (SPEC §8). */
const DKEY = 'sd.draft';
const empty = () => ({package_path: '', package: '', path: '', target: '', password: ''});
export const draft = empty();
try {
  const v = JSON.parse(sget(DKEY) || 'null');
  if (v && typeof v === 'object') for (const k of ['package_path', 'package', 'path', 'target']) draft[k] = String(v[k] || '');
} catch { /* corrupt draft: start fresh */ }

export function updateDraft(p) {
  Object.assign(draft, p);
  sset(DKEY, JSON.stringify({package_path: draft.package_path, package: draft.package, path: draft.path, target: draft.target}));
}

/** In-memory, per-tab flags that outlive one page. Never persisted. */
export const session = {note: null, fromReview: false, tried: {}, pendingErr: null, saveTar: null, filter: null, scrollTo: null};

export function resetDraft() {
  Object.assign(draft, empty());
  sset(DKEY, null);
  Object.assign(session, {note: null, fromReview: false, tried: {}, pendingErr: null, saveTar: null, filter: null});
}
export const dropPassword = () => { draft.password = ''; };
export const draftDirty = () => !!(draft.package_path || draft.password);
/** The package's version from its name, or null (build_tar.sh zip without a timestamp: the deploy time is used). */
export const draftVersion = () => parsePkg(basename(draft.package_path))?.ts ?? null;
export const draftFormat = () => parsePkg(basename(draft.package_path))?.fmt ?? null;

// ------------------------------------------------------------------ page helpers

export const setTitle = t => { document.title = t + ' — Swarm Deployer'; };
/** Move focus to the page's h1 after a route change (screen readers announce the new page). */
export function focusH1() {
  const el = document.querySelector('#main h1');
  if (el) { el.setAttribute('tabindex', '-1'); el.focus(); }
  window.scrollTo(0, 0);
}
/** Open the wizard fresh, optionally showing only one service's packages. */
export function startWizard(pkg) {
  resetDraft();
  session.filter = pkg || null;
  go('#/new/package');
}
