// New deploy wizard: Package → Password → Review. Steps replace each other in history, so browser Back leaves the wizard.
import {$, alertBox, announce, btn, confirm, errDetail, field, fmtRel, fmtSize, go, h, icon, isDialogOpen, isMenuOpen, keepFocus, live, on, onLeave,
  put, pwInput, setBusy, setErr, setGuard, skeleton, skeletonRows, sset, toast} from './ui.js';
import {API, basename, draft, draftDirty, draftFormat, draftVersion, fmtTs, joinPath, movingText, resetDraft, session, setTitle,
  updateDraft} from './app.js';

export const WSTEPS = ['package', 'password', 'review'];
const WLABEL = {package: 'Package', password: 'Password', review: 'Review'};
const DISCARD = {title: 'Discard this deploy?', body: 'Nothing has been changed on the server.', cancel: 'Keep editing', confirm: 'Discard'};

export async function wizardCancel() {
  if (draftDirty() && !(await confirm(DISCARD))) return;
  resetDraft();
  setGuard(null);
  go('#/dashboard');
}

/** Leaving the wizard with data asks first; moving between steps or to Settings (and back) doesn't. */
const wizardGuard = target => (/^#\/(new|settings)(\/|$)/.test(target) || !draftDirty() ? null : {...DISCARD, onDiscard: resetDraft});

const STEPS = {package: packageStep, password: passwordStep, review: reviewStep};

/** Frame: stepper, the current step, footer with Back / Next. A step returns {node, validate, submit?, first?}. */
export function wizardPage(main, {step}) {
  const idx = WSTEPS.indexOf(step);
  if (step === 'review') session.fromReview = false;
  const viaReview = session.fromReview && step !== 'review';
  let ext = null;
  if (session.pendingErr && session.pendingErr.step === step) { ext = session.pendingErr; session.pendingErr = null; }
  let tried = !!session.tried[step];
  setTitle('New deploy · ' + WLABEL[step]);

  const formAlert = h('div');
  const next = btn('primary', viaReview ? 'Back to review' : idx < WSTEPS.length - 1 ? 'Next: ' + WLABEL[WSTEPS[idx + 1]] : 'Deploy', () => goNext());
  const ctx = {
    next, goNext: () => goNext(),
    setFormAlert: msg => put(formAlert, msg ? h('div', {style: {marginTop: 'var(--s5)'}}, alertBox('error', h('span', null, msg))) : null),
  };
  const S = STEPS[step](ctx);
  let shown = [];
  const show = errs => { shown.forEach(id => setErr(id, null)); shown = errs.map(([id, m]) => { setErr(id, m); return id; }); };
  const relive = () => { if (tried) show(S.validate()); };

  function goNext() {
    session.tried[step] = tried = true;
    const errs = S.validate();
    show(errs);
    if (errs.length) { $(errs[0][0])?.focus(); return; }
    if (S.submit) { S.submit(); return; }
    go(viaReview ? '#/new/review' : '#/new/' + WSTEPS[idx + 1], true);
  }

  const content = h('div', null, S.node);
  put(main, h('div', {
    class: 'wrap', oninput: relive, onchange: relive,
    // Enter in a text/radio input advances
    onkeydown: e => {
      const t = e.target;
      if (e.key === 'Enter' && !e.defaultPrevented && t.tagName === 'INPUT' && !['checkbox', 'button'].includes(t.type)) { e.preventDefault(); goNext(); }
    },
    onclick: e => {
      const a = e.target.closest?.('a[href^="#/new/"]');
      if (a) { e.preventDefault(); go(a.getAttribute('href'), true); }
    },
  },
  h('div', {class: 'sr', role: 'heading', 'aria-level': '2'}, 'New deploy'),
  h('ol', {class: 'stepper', 'aria-label': 'Deploy steps'}, WSTEPS.map((s, i) => {
    const done = i < idx, c = i === idx;
    const inner = [h('span', {class: 'dot'}, done ? icon('check') : null), h('span', {class: 'lab'}, WLABEL[s])];
    return h('li', {class: done ? 'done' : c ? 'cur' : null, 'aria-current': c ? 'step' : null},
      done ? h('a', {href: '#/new/' + s, 'aria-label': WLABEL[s] + ' (done)'}, inner) : h('span', {'aria-label': c ? WLABEL[s] + ' (current)' : WLABEL[s]}, inner));
  })),
  h('div', {class: 'stepper-m', 'aria-hidden': 'true'},
    h('div', {class: 'micro muted'}, 'Step ' + (idx + 1) + ' of ' + WSTEPS.length + ' · ' + WLABEL[step]),
    h('div', {class: 'bar'}, h('i', {style: {width: ((idx + 1) * 100) / WSTEPS.length + '%'}}))),
  content, formAlert,
  h('div', {class: 'wfoot'},
    idx > 0 ? btn('ghost', [icon('chevron-left'), 'Back'], () => go('#/new/' + WSTEPS[idx - 1], true)) : null,
    h('span', {class: 'spacer'}), next)));

  setGuard(wizardGuard);
  on(document, 'keydown', e => {
    if (e.key === 'Escape' && !isDialogOpen() && !isMenuOpen() && !e.defaultPrevented) { e.preventDefault(); wizardCancel(); }
  });
  relive();
  // initial focus: the server error's field, else the step's first control, else the step title
  if (ext) {
    if ($(ext.field + '-err')) { show([[ext.field, ext.msg]]); $(ext.field)?.focus(); } else ctx.setFormAlert(ext.msg);
  } else {
    const f = S.first ? S.first() : content.querySelector('input,select,textarea');
    (f || content.querySelector('h1'))?.focus();
  }
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ step 1: package

const pkey = p => p.path + '|' + (p.modified_at || '') + '|' + p.size;
const clock = () => new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});
const toSettings = () => { sset('sd.return', '#/new/package'); go('#/settings/file-server'); };

/**
 * Browse the file server folder and pick a package, grouped by service, newest first.
 * The listing refreshes every 5 s (watch): files that show up later are marked New (or Uploading… while their size changes).
 */
function packageStep({goNext}) {
  const ok = live();
  let fs = null, cur = '', data = null, seq = 0, focusOnData = true;
  let seen = null, fresh = new Set(), lastSize = new Map(), uploading = new Set();
  const sub = h('div', {class: 'sub'}, skeleton('240px', 14));
  const crumbs = h('nav', {class: 'crumbs', 'aria-label': 'Folder'});
  const liveEl = h('span', {id: 'pkg-live', class: 'pkg-live muted', 'aria-live': 'off'});
  const list = h('div', {id: 'pkg', tabindex: '-1'}, skeletonRows(3));
  const setLive = good => { liveEl.className = 'pkg-live ' + (good ? 'muted' : 'warn'); liveEl.textContent = (good ? 'Watching · updated ' : "Couldn't refresh · ") + clock(); };

  /** Mark packages that weren't in the first listing of this folder; hold back ones still growing. */
  const watch = d => {
    const pkgs = (d.groups || []).flatMap(g => g.packages), prevSize = lastSize;
    lastSize = new Map(pkgs.map(p => [p.path, p.size]));
    if (!seen) { uploading = new Set(); seen = new Set(pkgs.map(pkey)); return; }
    uploading = new Set(pkgs.filter(p => !prevSize.has(p.path) || prevSize.get(p.path) !== p.size).map(p => p.path));
    let n = 0;
    for (const p of pkgs) {
      const k = pkey(p);
      if (seen.has(k) || uploading.has(p.path)) continue;
      seen.add(k);
      fresh.add(p.path);
      n++;
    }
    if (n) announce(n + ' new package' + (n > 1 ? 's' : ''));
  };

  async function load(path, quiet = false) {
    const my = ++seq;
    focusOnData = !quiet;
    if (!quiet) {
      if (path !== cur) seen = null; // a new folder starts a new watch; Refresh keeps the marks
      cur = path;
      data = null;
      renderCrumbs();
      put(list, skeletonRows(3));
    }
    if (seen === null) { fresh = new Set(); lastSize = new Map(); }
    let d;
    try { d = await API.packages(path); } catch (e) {
      if (my !== seq || !ok()) return;
      if (quiet) setLive(false);
      else {
        put(list, alertBox('error', [h('span', null, "Couldn't list the file server. " + errDetail(e).detail),
          h('div', {class: 'row-flex', style: {flexWrap: 'wrap'}}, btn('ghost', 'Retry', () => load(cur)),
            h('button', {class: 'link', type: 'button', onclick: toSettings}, 'File server settings'))]));
      }
      return;
    }
    if (my !== seq || !ok()) return;
    watch(d);
    if (!quiet) { cur = d.path || path; updateDraft({path: cur}); }
    data = d;
    put(sub, 'Packages on ', h('span', {class: 'mono'}, 'sftp://' + fs.host + cur));
    renderCrumbs();
    renderBody();
    setLive(true);
    // once a listing shows: focus the chosen (or first) package, unless the user already moved focus
    const a = document.activeElement;
    if (focusOnData && (a === document.body || a === $('main') || a === $('main').querySelector('h1'))) {
      (list.querySelector('input:checked') || list.querySelector('input[type=radio]'))?.focus();
    }
  }

  function renderCrumbs() {
    const segs = cur.split('/').filter(Boolean);
    put(crumbs, !fs || !cur ? null : [
      h('button', {type: 'button', 'aria-current': segs.length ? null : 'location', onclick: segs.length ? () => load('/') : null}, '/'),
      segs.map((s, i) => {
        const p = '/' + segs.slice(0, i + 1).join('/'), last = i === segs.length - 1;
        return [i ? h('span', {class: 'sep', 'aria-hidden': 'true'}, '/') : null,
          h('button', {type: 'button', 'aria-current': last ? 'location' : null, onclick: last ? null : () => load(p)}, s)];
      })]);
  }

  function renderBody() {
    const all = data.groups || [];
    const groups = session.filter && all.some(g => g.service === session.filter) ? all.filter(g => g.service === session.filter) : all;
    keepFocus(list, () => put(list,
      groups.length !== all.length ? h('div', {style: {marginBottom: 'var(--s3)'}}, alertBox('info', h('span', null, 'Showing ', h('code', null, session.filter), ' only. ',
        h('button', {class: 'link', type: 'button', onclick: () => { session.filter = null; renderBody(); }}, 'Show all services')))) : null,
      data.dirs?.length ? h('div', {class: 'list', role: 'list', 'aria-label': 'Folders'},
        data.dirs.map(d => h('button', {class: 'drow', type: 'button', role: 'listitem', onclick: () => load(joinPath(data.path, d))}, icon('folder'), d + '/'))) : null,
      groups.length ? null : h('p', {class: 'list-empty'}, 'No packages in ' + data.path + '. Build Packager uploads <service>_<timestamp>.zip here; build_tar.sh zips (<name>.tar.zip) work too.'),
      groups.map(group)));
  }

  function group(g) {
    const gid = 'grp-' + g.service.replace(/[^A-Za-z0-9_-]/g, '_');
    return h('div', {class: 'pgroup'},
      h('h2', {id: gid}, g.service, g.mapped ? null : h('span', {class: 'badge'}, 'New')),
      h('div', {class: 'list', role: 'radiogroup', 'aria-labelledby': gid}, g.packages.map((p, i) => {
        const up = uploading.has(p.path), isNew = !up && fresh.has(p.path), chosen = draft.package_path === p.path;
        const pick = () => { if (!up) { updateDraft({package_path: p.path, package: g.service, path: data.path}); renderBody(); } };
        const size = p.size === null || p.size === undefined ? 'size unknown' : fmtSize(p.size);
        return h('label', {class: 'prow' + (isNew ? ' new' : ''), title: p.name, ondblclick: () => { pick(); goNext(); }},
          h('input', {type: 'radio', name: 'pkg', value: p.path, checked: chosen, disabled: up, onchange: pick}),
          p.format === 'tarzip'
            ? h('span', {class: 't'}, h('span', {class: 'mono'}, p.name), h('span', {class: 'muted'}, ' · ' + size + ' · ' + fmtRel(p.modified_at || p.created_at)),
              ' ', h('span', {class: 'badge fmt'}, /\.tar\.zip$/.test(p.name) ? 'tar.zip' : 'zip'),
              chosen && !p.ts ? h('span', {class: 'muted'}, ' · new version (deploy time)') : null)
            : h('span', {class: 't'}, h('span', {class: 'mono'}, fmtTs(p.ts)), h('span', {class: 'muted'}, ' · ' + size + ' · ' + fmtRel(p.created_at))),
          i === 0 ? h('span', {class: 'badge accent'}, 'Latest') : null,
          up ? h('span', {class: 'badge up'}, 'Uploading…') : isNew ? h('span', {class: 'badge new'}, 'New') : null);
      })));
  }

  API.config().then(cfg => {
    if (!ok()) return;
    const f = cfg.file_server;
    if (!f || !f.host) {
      put(sub, 'No file server is set up.');
      put(list, alertBox('warning', [h('b', null, 'Connect the file server first'),
        h('span', null, 'Swarm Deployer downloads packages from the server Build Packager uploads to.'),
        h('div', null, btn('secondary', 'Set up the file server', toSettings))], 'alert'));
      return;
    }
    fs = f;
    load(draft.path || f.remote_dir || '/');
  }).catch(e => { if (ok()) put(list, alertBox('error', h('span', null, "Couldn't load settings. " + errDetail(e).detail))); });

  const t = setInterval(() => { if (!document.hidden && fs && data) load(cur, true); }, 5000);
  onLeave(() => clearInterval(t));

  return {
    node: [h('div', {class: 'step-head'}, h('h1', {tabindex: '-1'}, 'Choose a package'), sub),
      h('div', {class: 'row-flex', style: {marginBottom: 'var(--s3)', flexWrap: 'wrap'}},
        crumbs, h('span', {class: 'spacer'}), liveEl, btn('ghost', [icon('refresh'), 'Refresh'], () => { if (fs) load(cur); })),
      h('p', {class: 'err', id: 'pkg-err', hidden: true}), list],
    validate: () => (draft.package_path ? [] : [['pkg', 'Choose a package to deploy.']]),
  };
}

// ------------------------------------------------------------------ step 2: password

/** The zip password set in Build Packager. Memory only: never stored, dropped when the wizard is left. */
function passwordStep() {
  const note = session.note;
  session.note = null;
  const pw = pwInput({autocomplete: 'off', 'data-secret': '1', value: draft.password});
  const caps = h('p', {class: 'help', hidden: true}, icon('alert'), ' Caps Lock is on');
  pw.input.addEventListener('input', () => { draft.password = pw.input.value; });
  pw.input.addEventListener('keyup', e => { caps.hidden = !e.getModifierState('CapsLock'); });
  return {
    node: [
      h('div', {class: 'step-head'}, h('h1', {tabindex: '-1'}, 'Unlock the package'),
        h('div', {class: 'sub'}, h('span', {class: 'mono', style: {overflowWrap: 'anywhere'}}, basename(draft.package_path)), h('a', {href: '#/new/package'}, 'Change'))),
      note ? h('div', {style: {marginBottom: 'var(--s5)'}}, alertBox('info', h('span', null, note))) : null,
      h('div', {class: 'stack'},
        field({id: 'zip_password', label: 'Zip password', help: "The password you set in Build Packager. It's used once and never saved."}, pw),
        caps,
        draftFormat() === 'tarzip' ? h('p', {class: 'help', id: 'pw-zipcrypto'}, 'build_tar.sh zips use ZipCrypto, which unpacks slowly (about 1 MB/s; watch the log). AES zips from Build Packager are much faster.') : null),
    ],
    validate: () => {
      const v = draft.password, m = !v ? 'Enter the zip password.' : v.length > 1024 ? 'Max 1024 characters.' : null;
      return m ? [['zip_password', m]] : [];
    },
    first: () => pw.input,
  };
}

// ------------------------------------------------------------------ step 3: review

/** Wrong zip password (from plan or create): back to the password step with the error on its field. */
function toPassword(detail) {
  session.pendingErr = {step: 'password', field: 'zip_password', msg: detail};
  session.fromReview = true;
  go('#/new/password', true);
}

/**
 * Where it goes is worked out, not picked: SERVICE_NAME / DEV_IMAGE_TAG / HEALTHCHECK_URL from the .gitlab-ci.yml in the zip
 * (else the last deploy of this package), the image repo from the running service.
 */
function reviewStep({next, setFormAlert}) {
  const ok = live();
  let plan = null, planErr = null;
  const dl = h('dl', {class: 'review'});
  const cb = h('input', {type: 'checkbox', id: 'save_tar', checked: !!session.saveTar,
    onchange: () => { session.saveTar = cb.checked; render(); }});

  function render() {
    const rows = [];
    const row = (label, value, step, mono) => rows.push(h('div', null, h('dt', null, label), h('dd', {class: mono ? 'mono' : null}, value),
      h('dd', {class: 'e'}, step ? h('a', {href: '#/new/' + step, 'aria-label': 'Edit ' + label, onclick: () => { session.fromReview = true; }}, 'Edit') : null)));
    row('Package', basename(draft.package_path), 'package', true);
    row('Password', '•••••••• set', 'password');
    const ver = draftVersion();
    if (planErr) row('Service', h('span', {class: 'danger', id: 'review-plan'}, planErr));
    else if (!plan) row('Service', h('span', {id: 'review-plan'}, 'Working out where it goes…'));
    else {
      const v = ver || '<deploy time>', loaded = ver ? draft.package.toLowerCase() + ':' + ver : 'the image in the tar';
      const from = plan.source === 'gitlab-ci' ? ' (SERVICE_NAME in .gitlab-ci.yml)' : ' (same as the last deploy)';
      row('Service', h('span', {id: 'review-plan'}, plan.swarm_service + ' on ' + plan.target_name + from));
      const tag = movingText(plan.moving_tag, plan.current_image) || v; // the service keeps this name (DEV_IMAGE_TAG)
      row('Image', loaded + ' → ' + plan.image_repo + ':' + tag + ', service updated to it' + (plan.registry ? ' · push to ' + plan.registry : ''), null, true);
      row('Health check', plan.health_url || 'None (the rollout must converge)', null, !!plan.health_url);
      row('Backup', 'Current image ' + plan.current_image + ' will be tagged ' + plan.image_repo + ':backup-<when started>'
        + (cb.checked ? ' (+ .tar)' : '') + (plan.registry ? ', pushed' : ''));
      row('On failure', 'Automatic rollback to the backup image (' + plan.image_repo + ':backup-<when started>), run under the same name '
        + plan.current_image);
    }
    put(dl, rows);
  }

  if (session.saveTar === null) {
    API.config().then(c => { session.saveTar = !!c.options?.save_image_tar; if (ok()) { cb.checked = session.saveTar; render(); } }).catch(() => {});
  }
  API.plan(draft.package_path, draft.password).then(p => { if (ok()) { plan = p; render(); } }).catch(e => {
    if (!ok()) return;
    const {status, detail} = errDetail(e);
    if (status === 400 && /^password:/.test(detail)) toPassword(detail);
    else { planErr = detail; render(); }
  });

  async function submit() {
    setFormAlert(null);
    const body = {package_path: draft.package_path, password: draft.password, save_image_tar: session.saveTar};
    setBusy(next, 'Starting…');
    let job;
    try { job = await API.createDeploy(body); } catch (e) {
      setBusy(next, null);
      body.password = '';
      const {status, detail} = errDetail(e);
      if (status === 400 && /^password:/.test(detail)) { toPassword(detail); return; }
      if (status === 0) { toast("Can't reach the local server.", 'error', {label: 'Retry', run: () => submit()}); return; }
      setFormAlert(detail);
      return;
    }
    body.password = '';
    resetDraft();
    setGuard(null);
    location.replace('#/deploys/' + job.id);
  }

  render();
  return {
    node: [h('div', {class: 'step-head'}, h('h1', {tabindex: '-1'}, 'Review and deploy'), h('div', {class: 'sub'}, 'Nothing has changed on the server yet.')),
      dl,
      h('label', {class: 'cbx', style: {marginTop: 'var(--s5)'}}, cb,
        h('span', null, 'Also save the current image as a .tar backup',
          h('span', {class: 'help', style: {display: 'block'}}, 'Slower, but the rollback still works if the backup tag is removed.')))],
    validate: () => (plan ? [] : [['review-plan', planErr || 'Still working out where it goes…']]),
    submit,
    first: () => null,
  };
}
