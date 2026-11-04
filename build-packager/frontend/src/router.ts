import {createHashRouter, sset} from '@devtools/ui';
import {getDraft} from './state/draft';
import {getAuth, session} from './state/session';

export const router = createHashRouter();

export const WSTEPS = ['repo', 'source', 'password', 'upload', 'review'] as const;
export type WizardStepKey = (typeof WSTEPS)[number];
export const WLABEL: Record<WizardStepKey, string> = {repo: 'Repository', source: 'Build settings', password: 'Password', upload: 'Upload', review: 'Review'};
export const WSHORT: Record<WizardStepKey, string> = {repo: 'Repository', source: 'Build', password: 'Password', upload: 'Upload', review: 'Review'};

export type View =
  | {name: 'login'}
  | {name: 'dashboard'}
  | {name: 'new'; step: WizardStepKey}
  | {name: 'job'; id: string}
  | {name: 'settings'};

/**
 * Hash → view, or a redirect. Routes: #/login #/dashboard #/new/<step> #/jobs/<id> #/settings.
 * Signed-out users go to #/login (and come back after sign-in); wizard steps need the earlier steps' data.
 */
export function resolveRoute(hash: string): {view: View} | {redirect: string} {
  const parts = hash.replace(/^#\/?/, '').split('/');
  const name = parts[0];
  const authed = !!getAuth()?.logged_in;
  if (name !== 'settings') sset('bp.return', null);
  if (name === 'login') return authed ? {redirect: session.returnTo || '#/dashboard'} : {view: {name: 'login'}};
  if (!['dashboard', 'new', 'jobs', 'settings'].includes(name)) return {redirect: authed ? '#/dashboard' : '#/login'};
  if (!authed) { session.returnTo = hash; return {redirect: '#/login'}; }
  if (name === 'new') {
    const step = parts[1] as WizardStepKey;
    if (!WSTEPS.includes(step)) return {redirect: '#/new/repo'};
    const idx = WSTEPS.indexOf(step);
    if (idx >= 1 && !getDraft().repo_url) return {redirect: '#/new/repo'};
    if (idx >= 3 && !getDraft().password) {
      session.note = session.note || "For safety, the password isn't kept after a reload. Enter it again.";
      return {redirect: '#/new/password'};
    }
    return {view: {name: 'new', step}};
  }
  if (name === 'jobs') return {view: {name: 'job', id: parts[1] || ''}};
  return {view: {name: name as 'dashboard' | 'settings'}};
}

export function setTitle(t: string): void { document.title = t + ' — Build Packager'; }

/** Move focus to the page's h1 after a route change (screen readers announce the new page). */
export function focusH1(): void {
  const h1 = document.querySelector<HTMLElement>('#main h1');
  if (h1) { h1.setAttribute('tabindex', '-1'); h1.focus({preventScroll: false}); }
  window.scrollTo(0, 0);
}
