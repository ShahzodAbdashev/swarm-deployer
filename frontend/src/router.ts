import {createHashRouter, sset} from '@devtools/ui';
import {dropPassword, getDraft, resetDraft} from './state/draft';
import {session} from './state/session';

export const router = createHashRouter();

export const WSTEPS = ['package', 'password', 'review'] as const;
export type WizardStepKey = (typeof WSTEPS)[number];
export const WLABEL: Record<WizardStepKey, string> = {package: 'Package', password: 'Password', review: 'Review'};

export type View =
  | {name: 'dashboard'}
  | {name: 'service'; pkg: string}
  | {name: 'new'; step: WizardStepKey}
  | {name: 'deploy'; id: string}
  | {name: 'settings'; section: string};

/**
 * Hash → view, or a redirect (SPEC §8 routes). Wizard steps need the earlier steps' data:
 * no package → step 1; no password in memory (e.g. after a reload) → step 2 with a note.
 */
export function resolveRoute(hash: string): {view: View} | {redirect: string} {
  const parts = hash.replace(/^#\/?/, '').split('/');
  const name = parts[0];
  if (name !== 'new') dropPassword();
  if (name !== 'settings') sset('sd.return', null);
  if (!['dashboard', 'services', 'new', 'deploys', 'settings'].includes(name)) return {redirect: '#/dashboard'};
  if (name === 'new') {
    const step = parts[1] as WizardStepKey;
    if (!WSTEPS.includes(step)) return {redirect: '#/new/package'};
    const idx = WSTEPS.indexOf(step);
    if (idx >= 1 && !getDraft().package_path) return {redirect: '#/new/package'};
    if (idx >= 2 && !getDraft().password) {
      session.note = session.note || "For safety, the password isn't kept after a reload. Enter it again.";
      return {redirect: '#/new/password'};
    }
    return {view: {name: 'new', step}};
  }
  if (name === 'services') {
    let pkg = '';
    try { pkg = decodeURIComponent(parts[1] || ''); } catch { /* bad escape: empty */ }
    return {view: {name: 'service', pkg}};
  }
  if (name === 'deploys') return {view: {name: 'deploy', id: parts[1] || ''}};
  if (name === 'settings') return {view: {name: 'settings', section: parts[1] || ''}};
  return {view: {name: 'dashboard'}};
}

export function setTitle(t: string): void { document.title = t + ' — Swarm Deployer'; }

/** Move focus to the page's h1 after a route change (screen readers announce the new page). */
export function focusH1(): void {
  const h1 = document.querySelector<HTMLElement>('#main h1');
  if (h1) { h1.setAttribute('tabindex', '-1'); h1.focus({preventScroll: false}); }
  window.scrollTo(0, 0);
}

/** Open the wizard fresh, optionally showing only one service's packages. */
export function startWizard(pkg?: string): void {
  resetDraft();
  session.filter = pkg || null;
  router.go('#/new/package');
}
