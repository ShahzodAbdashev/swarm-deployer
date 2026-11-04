// New build wizard frame: stepper, the current step, footer with Back / Next. Plus cancel / leave guard / rebuild.
// Steps replace each other in history, so browser Back leaves the wizard instead of replaying it.
import {$, alertBox, btn, busy, confirm, h, icon, isDialogOpen, isMenuOpen} from './ui.js';
import {WLABEL, WSHORT, WSTEPS, draftDefaults, draftDirty, getDraft, resetDraft, router, session, setDraft, setTitle} from './state.js';
import {repoFullFromUrl} from './lib.js';
import * as steps from './steps.js';

const DISCARD = {title: 'Discard this build?', body: 'Nothing has been built yet.', cancel: 'Keep editing', confirm: 'Discard'};

export async function wizardCancel() {
  if (draftDirty() && !(await confirm(DISCARD))) return;
  resetDraft();
  router.setLeaveGuard(null);
  router.go('#/dashboard');
}

/** Leaving the wizard with data asks first; moving between steps or to Settings (and back) doesn't. */
const wizardGuard = target => (/^#\/(new|settings)(\/|$)/.test(target) || !draftDirty() ? null : {...DISCARD, onDiscard: resetDraft});

/** Start a new build with a finished job's settings; the password (and the .env content) must be entered again. */
export function rebuild(j) {
  resetDraft();
  const env = j.env || null;
  setDraft({
    ...draftDefaults(),
    repo_url: j.repo_url, repo_full: repoFullFromUrl(j.repo_url), branch: j.branch, service: j.service, service_edited: true,
    dockerfile: j.dockerfile || 'Dockerfile', build_command: j.build_command || '',
    extra_repos: (j.extra_repos || []).map(x => ({url: x.url, branch: x.branch, name: x.name || ''})),
    upload: j.upload_requested !== false, remote_dir: j.remote_dir || '',
    env_mode: env ? (env.source === 'gitlab' ? 'gitlab' : 'content') : 'none', env_path: env?.path || '.env',
    env_source: env?.source || 'paste', preload_tars: (j.preload_tars || []).join('\n'),
  });
  if (env) {
    session.note = 'Settings copied from ' + j.folder_name + ". Add the .env again; it isn't kept.";
    router.go('#/new/source');
    return;
  }
  session.note = 'Settings copied from ' + j.folder_name + '. Enter a zip password to continue.';
  router.go('#/new/password');
}

function stepper(current) {
  return [
    h('ol', {class: 'stepper', 'aria-label': 'Build steps'}, WSTEPS.map((s, i) => {
      const done = i < current, cur = i === current;
      const inner = [h('span', {class: 'dot'}, done ? icon('check') : null), h('span', {class: 'lab'}, WSHORT[s])];
      return h('li', {class: done ? 'done' : cur ? 'cur' : '', 'aria-current': cur ? 'step' : null},
        done ? h('a', {href: '#/new/' + s, 'aria-label': WLABEL[s] + ' (done)'}, inner) : h('span', {'aria-label': cur ? WLABEL[s] + ' (current)' : WLABEL[s]}, inner));
    })),
    h('div', {class: 'stepper-m', 'aria-hidden': 'true'},
      h('div', {class: 'micro muted'}, 'Step ' + (current + 1) + ' of ' + WSTEPS.length + ' · ' + WLABEL[WSTEPS[current]]),
      h('div', {class: 'bar'}, h('i', {style: {width: ((current + 1) * 100) / WSTEPS.length + '%'}}))),
  ];
}

/**
 * A step is steps[name](root, ctx) -> {validate(draft) -> [[fieldId, msg]], refresh(), submit?, first?, cleanup?}.
 * ctx.shown(errs): errors to display (live after the first Next, else a server error mapped to this step).
 */
export function wizardPage(main, {step}) {
  const idx = WSTEPS.indexOf(step);
  if (step === 'review') session.fromReview = false;
  const viaReview = session.fromReview && step !== 'review';
  let ext = null;
  const pe = session.pendingErr;
  if (pe && pe.step === step) { session.pendingErr = null; ext = pe; }
  let tried = !!session.tried[step];
  setTitle('New build · ' + WLABEL[step]);
  router.setLeaveGuard(wizardGuard);

  const content = h('div'), formAlert = h('div');
  const nextLabel = viaReview ? 'Back to review' : idx < 4 ? 'Next: ' + WLABEL[WSTEPS[idx + 1]] : 'Start build';
  const next = btn('primary', [idx === 4 ? icon('play') : null, nextLabel], () => goNext());
  const ctx = {
    get ext() { return ext; },
    shown: errs => (tried ? Object.fromEntries(errs) : ext ? {[ext.field]: ext.msg} : {}),
    goNext: () => goNext(),
    setNextBusy: label => busy(next, label),
    setFormAlert: node => formAlert.replaceChildren(...(node ? [node] : [])),
  };

  const wrap = h('div', {class: 'wrap'},
    h('div', {class: 'sr', role: 'heading', 'aria-level': '2'}, 'New build'),
    stepper(idx), content, formAlert,
    h('div', {class: 'wfoot'},
      idx > 0 ? btn('ghost', [icon('chevron-left'), 'Back'], () => router.go('#/new/' + WSTEPS[idx - 1], true)) : null,
      h('span', {class: 'spacer'}), next));
  main.append(wrap);
  const S = steps[step](content, ctx);
  S.refresh();

  function goNext() {
    session.tried[step] = true;
    tried = true;
    ext = null;
    S.refresh();
    const errs = S.validate(getDraft());
    if (errs.length) { const id = errs[0][0]; ($(id) || $(id + '-field'))?.focus(); return; }
    if (S.submit) { S.submit(); return; }
    router.go(viaReview ? '#/new/review' : '#/new/' + WSTEPS[idx + 1], true);
  }

  // Enter advances (Ctrl/Cmd+Enter in textareas); links to other steps replace history
  wrap.addEventListener('keydown', e => {
    const t = e.target;
    if (e.key !== 'Enter' || e.defaultPrevented) return;
    if (t.tagName === 'TEXTAREA') { if (e.ctrlKey || e.metaKey) { e.preventDefault(); goNext(); } return; }
    if ((t.tagName === 'INPUT' && !['checkbox', 'button', 'file'].includes(t.type)) || t.tagName === 'SELECT') { e.preventDefault(); goNext(); }
  });
  wrap.addEventListener('click', e => {
    const a = e.target.closest?.('a[href^="#/new/"]');
    if (a) { e.preventDefault(); router.go(a.getAttribute('href'), true); }
  });
  const onEsc = e => {
    if (e.key === 'Escape' && !isDialogOpen() && !isMenuOpen() && !e.defaultPrevented) { e.preventDefault(); wizardCancel(); }
  };
  document.addEventListener('keydown', onEsc);

  // initial focus: the server error's field, else the step's first control, else Next
  if (ext) {
    if ($(ext.field + '-err')) ($(ext.field) || $(ext.field + '-field'))?.focus();
    else { ctx.setFormAlert(alertBox('error', h('span', {}, ext.msg))); ext = null; S.refresh(); }
  } else {
    const f = S.first?.() || content.querySelector('input,select,textarea');
    (f || next).focus();
  }
  window.scrollTo(0, 0);

  return () => {
    document.removeEventListener('keydown', onEsc);
    S.cleanup?.();
    if (router.getLeaveGuard() === wizardGuard) router.setLeaveGuard(null);
  };
}
