// Entry: hash routes (SPEC §8) → page. #/dashboard #/services/<pkg> #/new/<step> #/deploys/<id> #/settings/<section>
import {$, h, icon, put, sset, startRouter} from './ui.js';
import {draft, dropPassword, session} from './app.js';
import {dashboardPage} from './dashboard.js';
import {servicePage} from './service.js';
import {WSTEPS, wizardCancel, wizardPage} from './wizard.js';
import {runPage} from './run.js';
import {settingsPage} from './settings.js';

/** Hash → view, or a redirect. Wizard steps need the earlier steps' data (no password after a reload → step 2 with a note). */
function resolve(hash) {
  const parts = hash.replace(/^#\/?/, '').split('/'), name = parts[0];
  if (name !== 'new') dropPassword();
  if (name !== 'settings') sset('sd.return', null);
  if (!['dashboard', 'services', 'new', 'deploys', 'settings'].includes(name)) return {redirect: '#/dashboard'};
  if (name === 'new') {
    const step = parts[1], idx = WSTEPS.indexOf(step);
    if (idx < 0) return {redirect: '#/new/package'};
    if (idx >= 1 && !draft.package_path) return {redirect: '#/new/package'};
    if (idx >= 2 && !draft.password) {
      session.note = session.note || "For safety, the password isn't kept after a reload. Enter it again.";
      return {redirect: '#/new/password'};
    }
    return {name, step};
  }
  if (name === 'services') {
    let pkg = '';
    try { pkg = decodeURIComponent(parts[1] || ''); } catch { /* bad escape: empty */ }
    return {name, pkg};
  }
  return {name, id: parts[1] || '', section: parts[1] || ''};
}

/** Top bar: logo + Settings; inside the wizard only logo + Cancel. */
function topBar(v) {
  const logo = h('a', {class: 'logo', href: '#/dashboard'}, h('span', {class: 'mark'}, icon('up')), 'Swarm Deployer');
  if (v.name === 'new') {
    return [logo, h('span', {class: 'spacer'}),
      h('button', {class: 'btn ghost', type: 'button', onclick: () => wizardCancel()}, 'Cancel', h('kbd', {class: 'hide-sm'}, 'Esc'))];
  }
  return [logo, h('span', {class: 'spacer'}),
    h('a', {class: 'btn ghost', href: '#/settings', 'aria-label': 'Settings', 'aria-current': v.name === 'settings' ? 'page' : null},
      icon('gear'), h('span', {class: 'hide-sm'}, 'Settings'))];
}

const PAGES = {dashboard: dashboardPage, services: servicePage, new: wizardPage, deploys: runPage, settings: settingsPage};

$('skip').addEventListener('click', e => {
  e.preventDefault();
  const m = $('main');
  (m.querySelector('h1') || m).focus();
});

startRouter(hash => {
  const v = resolve(hash);
  if (v.redirect) { location.replace(v.redirect); return; }
  put($('top'), topBar(v));
  const main = $('main');
  main.replaceChildren();
  PAGES[v.name](main, v);
});
