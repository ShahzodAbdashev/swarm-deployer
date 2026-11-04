// App state: API client + endpoints, auth, per-tab session caches, the wizard draft, and the hash router.
import {confirm, sget, sset, toast} from './ui.js';

// ---------------------------------------------------------------- API

export class ApiError extends Error {
  constructor(status, detail) { super(detail); this.status = status; this.detail = detail; }
}
export const errDetail = e => (e instanceof ApiError ? e : {status: -1, detail: e instanceof Error ? e.message : String(e)});

/** JSON fetch. Errors are {detail} bodies, thrown as ApiError (status 0 = server unreachable). */
async function api(method, path, body) {
  let r;
  try {
    r = await fetch(path, {method, headers: body !== undefined ? {'Content-Type': 'application/json'} : {}, body: body !== undefined ? JSON.stringify(body) : undefined});
  } catch {
    throw new ApiError(0, "Can't reach the local server. Is ./run.sh running?");
  }
  const txt = await r.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (r.ok) return data;
  let d = data && typeof data === 'object' ? data.detail : undefined;
  if (Array.isArray(d)) d = d.map(x => (x && typeof x === 'object' && 'msg' in x ? String(x.msg) : String(x))).join('; ');
  const err = new ApiError(r.status, (typeof d === 'string' && d) || 'Request failed (' + r.status + ')');
  // a 401 from a GitHub/GitLab endpoint means the token expired: back to sign-in
  const seg = path.split('/')[2];
  if (err.status === 401 && (seg === 'github' || seg === 'gitlab') && !router.current().hash.startsWith('#/login')) {
    toast((seg === 'github' ? 'GitHub' : 'GitLab') + ' session expired. Sign in again.', 'error');
    setAuth({logged_in: false, provider: null});
    session.repos = null;
    router.go('#/login');
  }
  throw err;
}

const q = encodeURIComponent;
export const authApi = {
  status: () => api('GET', '/api/auth/status'),
  token: token => api('POST', '/api/auth/token', {token}),
  ghCli: () => api('POST', '/api/auth/gh-cli'),
  deviceStart: () => api('POST', '/api/auth/device/start'),
  devicePoll: device_code => api('POST', '/api/auth/device/poll', {device_code}),
  logout: () => api('POST', '/api/auth/logout'),
  gitlabToken: (token, url) => api('POST', '/api/auth/gitlab/token', {token, url}),
};
/** Full-page navigation target for GitLab OAuth (redirects to GitLab and back). */
export const GITLAB_START = '/api/auth/gitlab/start';
export const gitlabApi = {
  projects: () => api('GET', '/api/gitlab/projects'),
  branches: project => api('GET', '/api/gitlab/branches?project=' + q(project)),
  envPreview: body => api('POST', '/api/gitlab/env-preview', body),
};
export const githubApi = {
  repos: () => api('GET', '/api/github/repos'),
  branches: fullName => api('GET', '/api/github/branches?repo=' + q(fullName)),
};
export const configApi = {
  getGitlab: () => api('GET', '/api/config/gitlab'),
  putGitlab: body => api('PUT', '/api/config/gitlab', body),
  importEnv: content => api('POST', '/api/config/import-env', {content}),
};
export const uploadApi = {
  get: () => api('GET', '/api/config/upload'),
  put: body => api('PUT', '/api/config/upload', body),
  test: body => api('POST', '/api/config/upload/test', body),
};
export const jobsApi = {
  list: () => api('GET', '/api/jobs'),
  get: id => api('GET', '/api/jobs/' + id),
  create: body => api('POST', '/api/jobs', body),
  remove: id => api('DELETE', '/api/jobs/' + id),
  logStreamUrl: id => `/api/jobs/${id}/logs/stream`,
  logUrl: id => `/api/jobs/${id}/log`,
  zipUrl: id => `/api/jobs/${id}/download/zip`,
  tarUrl: id => `/api/jobs/${id}/download/tar`,
};

// ---------------------------------------------------------------- auth + session

let auth = null;
export const getAuth = () => auth;
export function setAuth(patch) {
  auth = {
    logged_in: false, login: null, avatar_url: null, device_flow_available: false, provider: null, oauth_error: null,
    github: {logged_in: false, login: null},
    gitlab: {logged_in: false, login: null, avatar_url: null, url: '', method: null, oauth_available: false},
    ...auth, ...patch,
  };
}

/** In-memory, per-tab state that outlives a page: caches and wizard flags. Reloading the tab starts over (passwords included). */
export const session = {
  repos: null, reposErr: null, reposLoading: null, reposFor: null, // repo list cache (GitHub repos or GitLab projects)
  branches: {},
  uploadCfg: undefined, // undefined = not loaded yet, null = failed
  note: null, // one-shot info on the next wizard step
  fromReview: false,
  urlMode: null, // repo step: paste-a-URL instead of the list
  tried: {}, // wizard steps where Next was pressed (errors show live from then on)
  pendingErr: null, // {step, field, msg} from a 400 on POST /api/jobs
  returnTo: null, // where to go after sign-in
  envMeta: null, // last GitLab .env preview without its values
};

/** Load the user's repos (GitLab projects when signed in to GitLab) once per tab; the dashboard warms it. */
export function prefetchRepos() {
  const p = auth?.provider === 'gitlab' ? 'gitlab' : 'github';
  if (session.reposFor !== p) Object.assign(session, {repos: null, reposErr: null, reposFor: p});
  if (session.repos || session.reposLoading) return session.reposLoading;
  session.reposErr = null;
  session.reposLoading = (p === 'gitlab' ? gitlabApi.projects() : githubApi.repos())
    .then(r => { session.repos = r || []; })
    .catch(e => { session.reposErr = e instanceof ApiError ? e : new ApiError(-1, String(e)); })
    .finally(() => { session.reposLoading = null; });
  return session.reposLoading;
}

// ---------------------------------------------------------------- wizard draft (sessionStorage, minus passwords and .env content)

const DRAFT_KEY = 'bp.draft';
const PERSISTED = ['repo_full', 'repo_url', 'default_branch', 'service', 'service_edited', 'branch', 'dockerfile',
  'build_command', 'extra_repos', 'upload', 'remote_dir', 'env_mode', 'env_path', 'env_job', 'env_source', 'preload_tars'];

export const draftDefaults = () => ({
  repo_full: '', repo_url: '', default_branch: '', service: '', service_edited: false, branch: '',
  dockerfile: 'Dockerfile', build_command: '', extra_repos: [], upload: true, remote_dir: '', password: '', password_confirm: '',
  env_mode: 'none', env_path: '.env', env_job: 'export_env', env_source: 'paste', preload_tars: '', env_content: '',
});

function loadDraft() {
  try {
    const v = JSON.parse(sget(DRAFT_KEY) || 'null');
    if (v && typeof v === 'object') return {...draftDefaults(), ...v, password: '', password_confirm: '', env_content: ''};
  } catch { /* corrupt draft: start fresh */ }
  return draftDefaults();
}

let draft = loadDraft();
const persist = () => sset(DRAFT_KEY, JSON.stringify(Object.fromEntries(PERSISTED.map(k => [k, draft[k]]))));

export const getDraft = () => draft;
export function updateDraft(patch) {
  // a .env generated from GitLab belongs to its repo, branch and job: drop it when one of them changes
  const stale = draft.env_source === 'gitlab' && !!draft.env_content && !('env_content' in patch)
    && ['repo_url', 'branch', 'env_job'].some(k => k in patch && patch[k] !== draft[k]);
  draft = {...draft, ...patch, ...(stale ? {env_content: ''} : {})};
  if (stale) session.envMeta = null;
  persist();
}
export function setDraft(d) { draft = d; persist(); }
export function resetDraft() {
  draft = draftDefaults();
  sset(DRAFT_KEY, null);
  Object.assign(session, {note: null, fromReview: false, urlMode: null, tried: {}, pendingErr: null, envMeta: null});
}
export const draftDirty = () => !!(draft.repo_url || draft.password || draft.password_confirm || draft.env_content);

// ---------------------------------------------------------------- hash router with a leave guard

let snap = {hash: location.hash, tick: 0}, guard = null, onCommit = () => {};
function commit() {
  guard = null;
  snap = {hash: location.hash, tick: snap.tick + 1};
  onCommit();
}
window.addEventListener('hashchange', async () => {
  if (location.hash === snap.hash) return;
  if (guard) {
    const target = location.hash, ask = guard(target);
    if (ask) {
      history.replaceState(null, '', snap.hash || location.pathname);
      if (!(await confirm(ask))) return;
      ask.onDiscard?.();
      guard = null;
      location.hash = target;
      return;
    }
  }
  commit();
});

export const router = {
  current: () => snap,
  /** Navigate; replace=true keeps the current entry out of history. Same hash = render the page again. */
  go(hash, replace = false) {
    if (location.hash === hash) { commit(); return; }
    if (replace) location.replace(hash); else location.hash = hash;
  },
  refresh: () => commit(),
  setLeaveGuard(g) { guard = g; },
  getLeaveGuard: () => guard,
  onCommit(f) { onCommit = f; },
};

export const WSTEPS = ['repo', 'source', 'password', 'upload', 'review'];
export const WLABEL = {repo: 'Repository', source: 'Build settings', password: 'Password', upload: 'Upload', review: 'Review'};
export const WSHORT = {repo: 'Repository', source: 'Build', password: 'Password', upload: 'Upload', review: 'Review'};

/**
 * Hash -> {view} or {redirect}. Routes: #/login #/dashboard #/new/<step> #/jobs/<id> #/settings.
 * Signed-out users go to #/login (and come back after sign-in); wizard steps need the earlier steps' data.
 */
export function resolveRoute(hash) {
  const parts = hash.replace(/^#\/?/, '').split('/');
  const name = parts[0];
  const authed = !!auth?.logged_in;
  if (name !== 'settings') sset('bp.return', null);
  if (name === 'login') return authed ? {redirect: session.returnTo || '#/dashboard'} : {view: {name: 'login'}};
  if (!['dashboard', 'new', 'jobs', 'settings'].includes(name)) return {redirect: authed ? '#/dashboard' : '#/login'};
  if (!authed) { session.returnTo = hash; return {redirect: '#/login'}; }
  if (name === 'new') {
    const step = parts[1];
    if (!WSTEPS.includes(step)) return {redirect: '#/new/repo'};
    const idx = WSTEPS.indexOf(step);
    if (idx >= 1 && !draft.repo_url) return {redirect: '#/new/repo'};
    if (idx >= 3 && !draft.password) {
      session.note = session.note || "For safety, the password isn't kept after a reload. Enter it again.";
      return {redirect: '#/new/password'};
    }
    return {view: {name: 'new', step}};
  }
  if (name === 'jobs') return {view: {name: 'job', id: parts[1] || ''}};
  return {view: {name}};
}

export function setTitle(t) { document.title = t + ' — Build Packager'; }

/** Move focus to the page's h1 after a route change (screen readers announce the new page). */
export function focusH1() {
  const h1 = document.querySelector('#main h1');
  if (h1) { h1.setAttribute('tabindex', '-1'); h1.focus({preventScroll: false}); }
  window.scrollTo(0, 0);
}
