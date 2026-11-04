// Boot (auth status), top bar, route -> page. Each page renders into <main> and may return a cleanup function.
import {$, avatar, closeMenus, h, icon, menuButton, toast} from './ui.js';
import {authApi, errDetail, getAuth, resetDraft, resolveRoute, router, session, setAuth} from './state.js';
import {loginPage} from './login.js';
import {dashboardPage} from './dashboard.js';
import {wizardCancel, wizardPage} from './wizard.js';
import {runPage} from './run.js';
import {settingsPage} from './settings.js';

const PAGES = {login: loginPage, dashboard: dashboardPage, new: wizardPage, job: runPage, settings: settingsPage};
let cleanup = null;

async function signOut() {
  try { await authApi.logout(); } catch (e) { toast(errDetail(e).detail, 'error'); return; }
  const gl = getAuth()?.gitlab;
  setAuth({logged_in: false, login: null, avatar_url: null, provider: null, github: {logged_in: false, login: null},
    ...(gl ? {gitlab: {...gl, logged_in: false, login: null, avatar_url: null, method: null}} : {})});
  session.repos = null;
  session.branches = {};
  resetDraft();
  session.returnTo = null;
  toast('Signed out');
  router.go('#/login');
}

/** Logo + Settings + account menu; inside the wizard only logo + Cancel. */
function topBar(view) {
  const logo = h('a', {class: 'logo', href: '#/dashboard'}, icon('box', 'lg'), 'Build Packager');
  const spacer = h('span', {class: 'spacer'});
  if (view.name === 'new') return [logo, spacer, h('button', {class: 'btn ghost', type: 'button', onclick: () => wizardCancel()}, 'Cancel', h('kbd', {class: 'hide-sm'}, 'Esc'))];
  const login = getAuth()?.login || '';
  return [logo, spacer,
    h('a', {class: 'btn ghost', href: '#/settings', 'aria-label': 'Settings', 'aria-current': view.name === 'settings' ? 'page' : null},
      icon('gear'), h('span', {class: 'hide-sm'}, 'Settings')),
    menuButton('Account menu', () => [{note: 'Signed in as @' + login}, '-', {label: 'Sign out', run: signOut}], 'user-btn',
      [avatar(login || '?', getAuth()?.avatar_url), h('span', {class: 'hide-sm'}, login), icon('chevron-down')])];
}

function render() {
  closeMenus();
  if (cleanup) { cleanup(); cleanup = null; }
  const res = resolveRoute(location.hash);
  const main = $('main');
  if (res.redirect) { main.replaceChildren(); $('top').hidden = $('skip').hidden = true; router.go(res.redirect, true); return; }
  const view = res.view;
  $('top').hidden = $('skip').hidden = view.name === 'login';
  $('top').replaceChildren(...(view.name === 'login' ? [] : topBar(view)));
  main.replaceChildren();
  cleanup = PAGES[view.name](main, view) || null;
}

$('skip').addEventListener('click', e => {
  e.preventDefault();
  const main = $('main');
  (main.querySelector('h1') || main).focus();
});

const bootTimer = setTimeout(() => { $('boot').hidden = false; }, 200);
authApi.status()
  .then(a => setAuth(a))
  .catch(e => { setAuth({logged_in: false, device_flow_available: false}); toast(errDetail(e).detail, 'error'); })
  .finally(() => {
    clearTimeout(bootTimer);
    $('boot').hidden = true;
    if (!location.hash || location.hash === '#') history.replaceState(null, '', getAuth()?.logged_in ? '#/dashboard' : '#/login');
    router.onCommit(render);
    router.refresh();
  });
