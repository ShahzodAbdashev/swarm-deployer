// New build wizard steps: repo, source (build settings), password, upload, review. See wizardPage for the step contract.
import {$, alertBox, btn, busy, copyText, errText, field, h, icon, input, paintErrs, pw, radioCards, segmented, select, skel, stepHead,
  textarea, toast, sset} from './ui.js';
import {errDetail, getAuth, getDraft, githubApi, gitlabApi, jobsApi, prefetchRepos, resetDraft, router, session, updateDraft,
  uploadApi} from './state.js';
import {SVC_MSG, SVC_RE, URL_MSG, baseName, envKeys, onGitlab, preloadList, remotePathErr, repoFullFromUrl, repoLabel, sanitize, uploadConfigured,
  uploadTarget, validBranch, validGitUrl} from './lib.js';

const note = () => { const n = session.note; session.note = null; return n ? h('div', {style: {marginBottom: 'var(--s5)'}}, alertBox('info', h('span', {}, n))) : null; };

// ---------------------------------------------------------------- 1. repository

/** Pick one of the user's repos (GitLab projects when signed in to GitLab), or paste any clone URL / local path. */
export function repo(root, ctx) {
  const validate = d => {
    let msg = null;
    if (session.urlMode) { if (!d.repo_url) msg = 'Enter a clone URL.'; else if (!validGitUrl(d.repo_url)) msg = URL_MSG; }
    else if (!d.repo_url) msg = 'Select a repository to continue.';
    return msg ? [['repo', msg]] : [];
  };
  const refresh = () => paintErrs(root, ctx.shown(validate(getDraft())));
  if (session.urlMode === null) session.urlMode = false;
  let dead = false, waiting = false, emptyAccount = false, term = '', active = -1, urlIn = null, searchIn = null, listEl = null, msgEl = null;
  const gl = getAuth()?.provider === 'gitlab';
  const head = () => stepHead('Choose a repository', gl ? 'Your projects on ' + (getAuth()?.gitlab.url || 'GitLab') : 'Which code should we build?');

  const selectRepo = r => {
    const d = getDraft();
    updateDraft({
      repo_url: r.clone_url, repo_full: r.full_name, default_branch: r.default_branch || '', branch: r.default_branch || 'main',
      service: d.service_edited ? d.service : sanitize(r.full_name.split('/').pop() || ''),
    });
    refresh();
  };
  const setUrlMode = (on, empty = false) => {
    session.urlMode = on;
    emptyAccount = empty;
    paint();
    refresh();
    (on ? urlIn : searchIn).focus();
  };

  function paint() {
    if (session.urlMode) {
      urlIn = input({id: 'repo', mono: true, placeholder: 'https://github.com/owner/repo.git', value: getDraft().repo_url, oninput: e => {
        const v = e.target.value.trim(), d = getDraft();
        updateDraft({repo_url: v, repo_full: repoFullFromUrl(v), default_branch: d.repo_url !== v ? '' : d.default_branch,
          service: d.service_edited ? d.service : sanitize(baseName(v))});
        refresh();
      }});
      root.replaceChildren(head(), h('div', {class: 'stack'},
        emptyAccount ? alertBox('info', h('span', {}, 'No repositories found on this account.')) : null,
        field('repo', 'Clone URL', urlIn, {help: 'HTTPS, SSH, git@host:path, file:// or an absolute path.'}),
        emptyAccount ? null : h('p', {class: 'meta'}, h('button', {class: 'link', type: 'button', onclick: () => {
          if (session.repos && !session.repos.some(r => r.clone_url === getDraft().repo_url)) updateDraft({repo_url: '', repo_full: ''});
          setUrlMode(false);
        }}, 'Pick from my repositories'))));
      return;
    }
    searchIn = input({id: 'repo', type: 'search', placeholder: gl ? 'Search your projects' : 'Search your repositories', role: 'combobox',
      'aria-expanded': 'true', 'aria-controls': 'repo-list', 'aria-autocomplete': 'list', value: term,
      oninput: e => { term = e.target.value; active = -1; paintList(); }, onkeydown: onSearchKey});
    listEl = h('ul', {class: 'listbox', id: 'repo-list', role: 'listbox', 'aria-label': 'Repositories'});
    msgEl = h('div');
    root.replaceChildren(head(), h('div', {class: 'stack'},
      field('repo', 'Repository', h('div', {class: 'search'}, icon('search'), searchIn), {labelCls: 'sr', extra: listEl}),
      msgEl,
      h('p', {class: 'meta'}, 'Not listed? ', h('button', {class: 'link', type: 'button', onclick: () => setUrlMode(true)}, 'Paste a clone URL'))));
    paintList();
  }

  const filtered = () => (session.repos || []).filter(r => r.full_name.toLowerCase().includes(term.trim().toLowerCase()));

  function paintList() {
    const repos = session.repos, loading = !repos && !session.reposErr;
    if (repos) {
      // the account has none, or the draft repo isn't listed: paste-a-URL mode
      if (!repos.length) { setUrlMode(true, true); return; }
      const u = getDraft().repo_url;
      if (u && !repos.some(r => r.clone_url === u)) { setUrlMode(true); return; }
    } else if (loading && !waiting) {
      waiting = true;
      prefetchRepos()?.then(() => { waiting = false; if (!dead && !session.urlMode) paintList(); });
    }
    const list = filtered(), act = Math.min(active, list.length - 1), sel = getDraft().repo_url;
    listEl.hidden = !loading && !list.length;
    listEl.replaceChildren(...(loading
      ? [0, 1, 2, 3, 4].map(() => h('li', {'aria-hidden': 'true', style: {cursor: 'default'}}, skel('50%', 12)))
      : list.map((r, i) => h('li', {role: 'option', id: 'opt-' + i, 'aria-selected': String(r.clone_url === sel), class: i === act ? 'active' : '',
        onmousedown: e => e.preventDefault(),
        onclick: () => { selectRepo(r); active = i; paintList(); searchIn.focus(); },
        ondblclick: () => { selectRepo(r); ctx.goNext(); }},
      h('span', {class: 'name'}, r.full_name),
      r.private ? h('span', {class: 'lock', title: 'Private'}, icon('lock'), h('span', {class: 'sr'}, 'Private')) : null,
      h('span', {class: 'br'}, r.default_branch || ''),
      icon('check', 'chk')))));
    if (act >= 0) searchIn.setAttribute('aria-activedescendant', 'opt-' + act); else searchIn.removeAttribute('aria-activedescendant');
    (act >= 0 ? $('opt-' + act) : listEl.querySelector('[aria-selected=true]'))?.scrollIntoView({block: 'nearest'});
    msgEl.replaceChildren(...(session.reposErr
      ? [alertBox('error', [h('span', {}, "Couldn't load repositories. " + session.reposErr.detail),
        h('div', {}, btn('ghost', 'Retry', () => { session.reposErr = null; paintList(); }))])]
      : repos && repos.length && !list.length ? [h('p', {class: 'list-empty'}, 'No repositories match “' + term.trim() + '”.')] : []));
  }

  function onSearchKey(e) {
    const list = filtered(), act = Math.min(active, list.length - 1);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!list.length) return;
      active = e.key === 'ArrowDown' ? Math.min(list.length - 1, act + 1) : Math.max(0, act - 1);
      paintList();
    } else if (e.key === 'Enter' && act >= 0 && list[act]) {
      e.preventDefault();
      selectRepo(list[act]);
      ctx.goNext();
    }
  }

  paint();
  return {validate, refresh, first: () => (session.urlMode ? urlIn : searchIn), cleanup: () => { dead = true; }};
}

// ---------------------------------------------------------------- 2. build settings

const ADV_FIELD = /^(dockerfile|build_command|extra|x-|env_path|preload_tars)/;
const FALLBACK = "Couldn't list branches, type one. It must exist or the build stops at Clone.";
const SRC_LABEL = {gitlab: 'from GitLab CI', file: 'from file', paste: 'pasted'};
const advCount = d => (d.dockerfile && d.dockerfile !== 'Dockerfile' ? 1 : 0) + (d.build_command ? 1 : 0) + d.extra_repos.length
  + (d.env_path !== '.env' ? 1 : 0) + (preloadList(d.preload_tars).length ? 1 : 0);
const mainRepoDir = d => { const n = baseName(d.repo_url); return SVC_RE.test(n) ? n : 'repo'; };

function validateSource(d) {
  const errs = [];
  const put = (id, msg) => { if (msg) errs.push([id, msg]); };
  put('branch', !validBranch(d.branch || '') ? 'Not a valid branch name.' : null);
  put('service', !SVC_RE.test(d.service || '') ? SVC_MSG : null);
  put('env', d.env_mode !== 'none' && !d.env_content.trim() ? "Add the .env content. It isn't kept after a reload." : null);
  const df = d.dockerfile || '';
  put('dockerfile', !df || df.startsWith('/') || df.includes('..') ? 'Use a path inside the repo, like Dockerfile or docker/Dockerfile.' : null);
  put('build_command', d.build_command.length > 2000 ? 'Max 2000 characters.' : null);
  const used = new Set([mainRepoDir(d)]);
  // the image tar sits next to the repos: <service>_<branch>_<ts>.tar
  const tarRe = new RegExp('^' + (d.service || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '_.*\\d{8}_\\d{6}\\.tar$');
  d.extra_repos.forEach((x, i) => {
    put('x-url-' + i, !x.url ? 'Enter a clone URL.' : !validGitUrl(x.url) ? URL_MSG : null);
    put('x-branch-' + i, x.branch && !validBranch(x.branch) ? 'Not a valid branch name.' : null);
    const name = x.name || baseName(x.url);
    let nm = null;
    if (x.name && !SVC_RE.test(x.name)) nm = SVC_MSG;
    else if (!x.name && x.url && !SVC_RE.test(name)) nm = "Can't derive a folder from this URL. Type one.";
    else if (name && (used.has(name) || tarRe.test(name))) nm = 'Folder “' + name + '” is already used in this build.';
    put('x-name-' + i, nm);
    if (name) used.add(name);
  });
  const ep = d.env_path || '';
  put('env_path', !ep || ep.startsWith('/') || ep.includes('..') ? 'Use a path inside the repo, like .env or config/.env.' : null);
  put('preload_tars', preloadList(d.preload_tars).some(p => !p.startsWith('/')) ? 'One absolute path per line, like /app/python.tar.' : null);
  return errs;
}

/** Branch select options: default branch first (marked), then the rest sorted, plus the draft's branch if missing. */
function branchOptions(list, d) {
  const names = list.map(b => b.name);
  const def = d.default_branch && names.includes(d.default_branch) ? d.default_branch : null;
  if (d.branch && !names.includes(d.branch)) names.push(d.branch);
  const rest = names.filter(n => n !== def).sort((a, b) => a.localeCompare(b));
  return {def, rest, value: d.branch || def || rest[0] || ''};
}

/** Branch, service name, .env, advanced options (Dockerfile path, build command, extra repos, .env path, preload tars). */
export function source(root, ctx) {
  const d0 = getDraft();
  let dead = false;
  const upd = patch => { updateDraft(patch); refresh(); };
  const contents = (...nodes) => h('div', {style: {display: 'contents'}}, nodes);

  // branch: a select when the repo's branches can be listed, else free text
  const branchBox = h('div');
  const branchText = (help, extra) => {
    if (!getDraft().branch) updateDraft({branch: 'main'});
    branchBox.replaceChildren(field('branch', 'Branch', input({id: 'branch', mono: true, value: getDraft().branch, oninput: e => upd({branch: e.target.value.trim()})}), {help, extra}));
  };
  const branchSelect = list => {
    const o = branchOptions(list, getDraft());
    if (o.value !== getDraft().branch) updateDraft({branch: o.value});
    const sel = select({id: 'branch', onchange: e => upd({branch: e.target.value})},
      [o.def ? h('option', {value: o.def}, o.def + ' (default)') : null, o.rest.map(n => h('option', {value: n}, n))]);
    sel.value = o.value;
    branchBox.replaceChildren(field('branch', 'Branch', sel));
  };
  const full = d0.repo_full;
  if (!full) branchText(d0.repo_url && !repoFullFromUrl(d0.repo_url) ? 'The branch to build. It must exist or the build stops at Clone.' : FALLBACK);
  else if (Array.isArray(session.branches[full])) branchSelect(session.branches[full]);
  else {
    branchBox.append(field('branch', 'Branch', select({id: 'branch', disabled: true}, h('option', {}, 'Loading branches…'))));
    (onGitlab(d0.repo_url) ? gitlabApi : githubApi).branches(full).then(list => {
      session.branches[full] = list || [];
      if (dead) return;
      if (list && list.length) branchSelect(list); else branchText(FALLBACK);
      refresh();
    }).catch(e => {
      if (dead) return;
      if (errDetail(e).status === 404) branchText(null, h('p', {class: 'help danger'}, 'Repository not found or no access. ', h('a', {href: '#/new/repo'}, 'Change')));
      else branchText(FALLBACK);
      refresh();
    });
  }

  const preview = h('div', {class: 'preview', 'aria-live': 'polite'});
  const svc = input({id: 'service', maxLength: 63, value: d0.service, oninput: e => upd({service: e.target.value.trim(), service_edited: true})});

  // .env written into the repo before docker build: none, a file / pasted text, or generated from the GitLab CI job. Values stay masked.
  const glOk = !!getAuth()?.gitlab?.logged_in && onGitlab(d0.repo_url);
  const envMode = () => (getDraft().env_mode === 'gitlab' && !glOk ? 'content' : getDraft().env_mode);
  let edit = ctx.ext?.field === 'env_content', focus = false, genErr = null;
  const opts = [{value: 'none', label: 'None'}, {value: 'content', label: 'File or paste'}];
  if (glOk) opts.push({value: 'gitlab', label: 'From GitLab CI'});
  const fileField = field('env_file', '.env file', h('input', {type: 'file', id: 'env_file', accept: '.env,text/plain', onchange: async e => {
    const f = e.target.files?.[0];
    if (!f) return;
    edit = false;
    upd({env_content: await f.text(), env_source: 'file'});
  }}));
  const genBtn = btn('secondary', 'Generate from GitLab', async () => {
    genErr = null;
    busy(genBtn, 'Reading .gitlab-ci.yml…');
    refresh();
    const d = getDraft();
    try {
      const {content: c, ...m} = await gitlabApi.envPreview({repo_url: d.repo_url, branch: d.branch, job: d.env_job.trim() || 'export_env'});
      session.envMeta = m;
      updateDraft({env_content: c, env_source: 'gitlab'});
      edit = false;
    } catch (e) { genErr = errDetail(e).detail; } finally { busy(genBtn, null); }
    if (!dead) refresh();
  }, {id: 'env-gen'});
  const genErrBox = contents();
  const glPart = contents(
    field('env_job', 'CI job that writes .env', input({id: 'env_job', mono: true, value: d0.env_job, placeholder: 'export_env', oninput: e => upd({env_job: e.target.value.trim()})})),
    h('div', {}, genBtn), genErrBox);
  const sumText = h('span');
  const editBtn = btn('ghost', 'Edit', () => { edit = !edit; paintEnv(); if (edit) ta.focus(); }, {id: 'env-edit', onmousedown: e => e.preventDefault()});
  const sumRow = h('div', {class: 'env-sum'}, sumText, editBtn);
  const keysUl = h('ul', {id: 'env-keys'});
  const ta = textarea({id: 'env_content', rows: 6, class: 'mono', placeholder: 'KEY=value', 'data-secret': '1', value: d0.env_content,
    onfocus: () => { focus = true; }, onblur: () => { focus = false; paintEnv(); },
    oninput: e => upd({env_content: e.target.value, env_source: 'paste'})});
  const rawField = field('env_content', '.env content', ta, {labelCls: 'sr'});
  const missingBox = contents(), warnBox = contents();
  const envField = h('fieldset', {class: 'env-field', id: 'env-field', tabindex: '-1', 'aria-describedby': 'env-help'},
    h('legend', {id: 'env-l'}, '.env for the build'),
    h('p', {class: 'help', id: 'env-help'}, "Written to the repo before docker build, so the image gets it. It's never saved or logged."),
    segmented('env_mode', 'env-l', envMode(), opts, v => { genErr = null; edit = false; upd({env_mode: v}); }),
    fileField, glPart, sumRow, keysUl, rawField, missingBox, warnBox, errText('env'));

  function paintEnv() {
    const d = getDraft(), mode = envMode(), content = d.env_content;
    if (ta.value !== content) ta.value = content;
    const meta = mode === 'gitlab' ? session.envMeta : null;
    const raw = mode === 'content' ? !content || edit || focus : mode === 'gitlab' && edit;
    const keys = envKeys(content);
    fileField.hidden = mode !== 'content';
    glPart.hidden = mode !== 'gitlab';
    genErrBox.replaceChildren(...(genErr ? [alertBox('error', h('span', {}, genErr))] : []));
    sumRow.hidden = mode === 'none' || !content;
    sumText.textContent = meta && d.env_source === 'gitlab'
      ? 'From ' + meta.job + ' on ' + meta.branch + ' · ' + keys.length + ' keys' : keys.length + ' keys · ' + SRC_LABEL[d.env_source];
    editBtn.textContent = edit ? 'Done' : 'Edit';
    keysUl.hidden = mode === 'none' || !content || raw;
    keysUl.replaceChildren(...(keysUl.hidden ? [] : keys.map(k => {
      const ln = meta?.lines.find(l => l.key === k);
      const miss = ln?.status === 'missing';
      const src = meta && ln && ln.vars.length ? 'from ' + ln.vars.map(v => '$' + v + (meta.sources[v] ? ' · ' + meta.sources[v] : '')).join(', ') : '';
      return h('li', {class: 'env-row' + (miss ? ' missing' : '')}, miss ? icon('alert') : null, h('code', {}, k), ' = ',
        h('span', {class: 'mask'}, '••••••'), src ? h('span', {class: 'src'}, src) : null);
    })));
    rawField.hidden = !raw;
    missingBox.replaceChildren(...(meta && meta.missing.length ? [alertBox('warning', h('span', {}, 'Not set in GitLab: ' + meta.missing.map(v => '$' + v).join(', ')
      + ". They'll be empty in the .env. Add them in GitLab (project or group CI/CD variables) or edit the .env."), null, 'env-missing')] : []));
    warnBox.replaceChildren(...(meta && meta.warnings.length ? [h('ul', {id: 'env-warnings'}, meta.warnings.map(w => h('li', {}, w)))] : []));
  }

  // advanced options
  const advNum = h('span', {class: 'muted', style: {fontWeight: 400}});
  const counter = h('div', {class: 'counter', 'aria-live': 'polite'});
  const xList = h('div', {class: 'stack', style: {gap: 'var(--s3)'}});
  const addBtn = h('button', {class: 'link', type: 'button', onclick: () => {
    const n = getDraft().extra_repos.length;
    updateDraft({extra_repos: [...getDraft().extra_repos, {url: '', branch: 'main', name: ''}]});
    paintX();
    refresh();
    $('x-url-' + n)?.focus();
  }}, icon('plus'), ' Add repository');
  function paintX() {
    xList.replaceChildren(...getDraft().extra_repos.map((x, i) => {
      const set = patch => upd({extra_repos: getDraft().extra_repos.map((y, k) => (k === i ? {...y, ...patch} : y))});
      const rm = () => {
        updateDraft({extra_repos: getDraft().extra_repos.filter((_, k) => k !== i)});
        paintX();
        refresh();
        ($('x-url-' + i) || addBtn).focus();
      };
      const nameIn = input({id: 'x-name-' + i, mono: true, placeholder: 'auto: ' + (baseName(x.url) || 'name'), value: x.name, oninput: e => set({name: e.target.value.trim()})});
      return h('div', {class: 'xrow'},
        field('x-url-' + i, 'URL', input({id: 'x-url-' + i, mono: true, placeholder: 'https://github.com/owner/other.git', value: x.url, oninput: e => {
          const v = e.target.value.trim();
          nameIn.placeholder = 'auto: ' + (baseName(v) || 'name');
          set({url: v});
        }})),
        field('x-branch-' + i, 'Branch', input({id: 'x-branch-' + i, mono: true, placeholder: 'main', value: x.branch, oninput: e => set({branch: e.target.value.trim()})})),
        field('x-name-' + i, 'Folder', nameIn),
        h('button', {class: 'btn ghost icon rm-icon', type: 'button', 'aria-label': 'Remove repository ' + (i + 1), style: {marginTop: '24px'}, onclick: rm}, icon('x')),
        h('button', {class: 'link rm-text', type: 'button', 'aria-label': 'Remove repository ' + (i + 1), onclick: rm}, 'Remove'));
    }));
  }
  paintX();
  const adv = h('details', {class: 'adv', id: 'adv', open: advCount(d0) > 0 || !!(ctx.ext && ADV_FIELD.test(ctx.ext.field))},
    h('summary', {}, icon('chevron-down'), 'Advanced options', advNum),
    h('div', {class: 'adv-body'},
      field('dockerfile', 'Dockerfile path', input({id: 'dockerfile', mono: true, placeholder: 'Dockerfile', value: d0.dockerfile, oninput: e => upd({dockerfile: e.target.value.trim()})}),
        {help: 'Relative to the repo root, e.g. docker/Dockerfile.prod'}),
      field('build_command', 'Build command (optional)', textarea({id: 'build_command', rows: 3, placeholder: 'npm ci && npm run build', value: d0.build_command,
        oninput: e => upd({build_command: e.target.value})}), {help: 'Runs as a shell command in the repo folder before docker build. Only use commands you trust.', extra: counter}),
      h('div', {class: 'field', id: 'extra-field', tabindex: '-1'},
        h('span', {class: 'lbl'}, 'Extra repositories (optional)'),
        h('p', {class: 'help'}, 'Cloned next to your repo inside the zip.'),
        errText('extra'), xList, h('div', {}, addBtn)),
      field('env_path', '.env path in the repo', input({id: 'env_path', mono: true, placeholder: '.env', value: d0.env_path, oninput: e => upd({env_path: e.target.value.trim()})}),
        {help: 'Relative to the repo root.'}),
      field('preload_tars', 'Images to load before the build', textarea({id: 'preload_tars', rows: 2, class: 'mono', placeholder: '/app/python.tar', value: d0.preload_tars,
        oninput: e => upd({preload_tars: e.target.value})}), {help: 'One absolute path per line on this computer, e.g. /app/python.tar (offline base images).'})));

  root.append(
    stepHead('Build settings', [h('span', {class: 'mono'}, d0.repo_full || repoLabel(d0.repo_url)), h('a', {href: '#/new/repo'}, 'Change')]),
    note(),
    h('div', {class: 'stack'}, branchBox, field('service', 'Service name', svc, {extra: preview}), envField, adv));

  function refresh() {
    const d = getDraft();
    const errs = ctx.shown(validateSource(d));
    paintErrs(root, errs);
    if (Object.keys(errs).some(k => ADV_FIELD.test(k))) adv.open = true; // errors inside Advanced options open it
    const s = d.service || 'service';
    preview.replaceChildren(h('div', {}, 'Image ' + s.toLowerCase() + ':<timestamp> · folder ' + s + '_<timestamp>/'),
      /[A-Z]/.test(s) ? h('div', {}, 'Docker tags are lowercase, so the image is tagged ' + s.toLowerCase() + ':…; files keep ' + s + '.') : null);
    const n = advCount(d);
    advNum.textContent = n ? '· ' + n + ' set' : '';
    counter.textContent = d.build_command.length > 1800 ? d.build_command.length + ' / 2000' : '';
    paintEnv();
  }
  return {validate: validateSource, refresh, first: () => (getDraft().service ? null : svc), cleanup: () => { dead = true; }};
}

// ---------------------------------------------------------------- 3. password

const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** Zip password (twice). Lives in memory only, never in storage or the URL. */
export function password(root, ctx) {
  const validate = d => {
    const errs = [];
    const a = d.password.length < 4 ? 'At least 4 characters.' : null;
    const b = !a && d.password !== d.password_confirm ? "Passwords don't match." : null;
    if (a) errs.push(['password', a]);
    if (b) errs.push(['password_confirm', b]);
    return errs;
  };
  const d0 = getDraft(), group = [];
  const w1 = pw({id: 'password', autocomplete: 'new-password', 'data-secret': '1', value: d0.password}, group);
  const w2 = pw({id: 'password_confirm', autocomplete: 'new-password', 'data-secret': '1', value: d0.password_confirm}, group);
  const p1 = w1.querySelector('input'), p2 = w2.querySelector('input');
  const caps = h('p', {class: 'help', hidden: true}, icon('alert'), ' Caps Lock is on');
  for (const p of [p1, p2]) p.addEventListener('keyup', e => { caps.hidden = !e.getModifierState('CapsLock'); });
  p1.addEventListener('input', () => { updateDraft({password: p1.value}); refresh(); });
  p2.addEventListener('input', () => { updateDraft({password_confirm: p2.value}); refresh(); });
  p1.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); p2.focus(); } });
  const liA = h('li'), liB = h('li');
  const generate = async () => {
    const buf = new Uint32Array(20);
    crypto.getRandomValues(buf);
    const pass = [...buf].map(n => ABC[n % ABC.length]).join('');
    updateDraft({password: pass, password_confirm: pass});
    p1.value = p2.value = pass;
    group.forEach(w => w.show(true));
    refresh();
    if (await copyText(pass)) toast('Password copied. Store it somewhere safe.', 'success');
  };
  root.append(
    stepHead('Protect the zip', 'The zip is encrypted with AES-256. Anyone who opens it will need this password.'),
    note(),
    h('div', {class: 'stack'},
      field('password', 'Password', w1),
      field('password_confirm', 'Confirm password', w2),
      caps,
      h('ul', {class: 'checklist', 'aria-live': 'polite'}, liA, liB),
      h('div', {}, h('button', {class: 'link', type: 'button', onclick: generate}, 'Generate a strong password')),
      alertBox('info', h('span', {}, 'The password is never saved. Store it somewhere safe before you start.'))));
  const item = (li, ok, text) => { li.className = ok ? 'ok' : ''; li.replaceChildren(icon(ok ? 'check' : 'circle'), text); };
  function refresh() {
    const d = getDraft();
    paintErrs(root, ctx.shown(validate(d)));
    item(liA, d.password.length >= 4, 'At least 4 characters');
    item(liB, d.password.length > 0 && d.password === d.password_confirm, 'Passwords match');
  }
  return {validate, refresh, first: () => p1};
}

// ---------------------------------------------------------------- 4. upload

const toSettings = () => { sset('bp.return', '#/new/upload'); router.go('#/settings'); };

/** Upload to the configured server (per-build remote path) or keep the zip local. */
export function upload(root, ctx) {
  let cfg, dead = false, path = '';
  const configured = () => uploadConfigured(cfg);
  const validate = () => {
    const m = configured() && getDraft().upload ? remotePathErr(path.trim()) : null;
    return m ? [['remote_path', m]] : [];
  };
  const refresh = () => {
    const errs = ctx.shown(validate());
    if (!getDraft().upload) delete errs.remote_path;
    paintErrs(root, errs);
  };
  const body = h('div', {}, h('div', {}, skel('70%', 16)));
  root.append(stepHead('Upload', "Send the zip to your server when it's ready."), body);

  function paint(c, err) {
    session.uploadCfg = c;
    cfg = c;
    if (c) path = getDraft().remote_dir || c.remote_dir;
    if (configured()) {
      const pathIn = input({id: 'remote_path', mono: true, placeholder: '/home/deploy/releases', value: path, oninput: e => {
        path = e.target.value;
        updateDraft({remote_dir: path.trim()});
        desc.textContent = uploadTarget(cfg, true, path.trim() || undefined);
        refresh();
      }});
      const pf = field('remote_path', 'Remote path', pathIn, {help: 'Full path on the server for this build. Missing folders are created.',
        hidden: !getDraft().upload, style: {marginTop: 'var(--s4)'}});
      const cards = radioCards('upload', 'Upload', String(getDraft().upload), [
        {value: 'true', title: 'Upload to server', desc: uploadTarget(cfg, true, path.trim() || undefined), descMono: true},
        {value: 'false', title: "Don't upload", desc: 'Keep the zip on this computer and download it from the build page.'},
      ], v => { updateDraft({upload: v === 'true'}); pf.hidden = v !== 'true'; refresh(); });
      const desc = cards.querySelector('.d');
      body.replaceChildren(cards, pf, h('p', {class: 'meta', style: {marginTop: 'var(--s4)'}},
        h('a', {href: '#/settings', onclick: e => { e.preventDefault(); e.stopPropagation(); toSettings(); }}, icon('gear'), ' Server settings')));
      // once the server choice appears, focus the selected radio (unless the user already moved on)
      const ae = document.activeElement;
      if (ae === $('main') || ae === document.body || ae?.closest?.('.wfoot')) {
        (document.querySelector('input[name=upload]:checked') || document.querySelector('input[name=upload]'))?.focus();
      }
    } else if (c && c.host && !c.enabled) {
      const turnOn = btn('secondary', 'Turn on', async () => {
        busy(turnOn, 'Turning on…');
        try { const c2 = await uploadApi.put({enabled: true}); updateDraft({upload: true}); toast('Uploads turned on', 'success'); if (!dead) paint(c2); }
        catch (e) { toast(errDetail(e).detail, 'error'); busy(turnOn, null); }
      });
      body.replaceChildren(alertBox('warning', [
        h('b', {}, 'Uploads are turned off in settings'),
        h('span', {class: 'mono', style: {overflowWrap: 'anywhere'}}, uploadTarget(c, true)),
        h('span', {}, 'Turn them on to send this zip there, or continue and keep it on this computer.'),
        h('div', {class: 'row-flex', style: {flexWrap: 'wrap'}}, turnOn, btn('ghost', 'Server settings', toSettings)),
      ], 'info'));
    } else {
      body.replaceChildren(
        err ? h('div', {style: {marginBottom: 'var(--s3)'}}, alertBox('error', h('span', {}, err))) : null,
        alertBox('warning', [
          h('b', {}, 'No upload server is set up'),
          h('span', {}, 'The zip will stay on this computer. You can download it when the build finishes.'),
          h('div', {}, btn('secondary', 'Set up a server', toSettings)),
        ], 'info'));
    }
    refresh();
  }
  uploadApi.get().then(c => { if (!dead) paint(c); }).catch(() => { if (!dead) paint(null, "Couldn't read upload settings. This build will skip upload."); });
  return {validate, refresh, first: () => null, cleanup: () => { dead = true; }};
}

// ---------------------------------------------------------------- 5. review

/** Map a 400 detail like "extra_repos[1].name: ..." to the wizard step and field that caused it. */
function mapDetail(detail) {
  const m = /^([a-z_ ]+?)(\[(\d+)\])?(\.(\w+))?\s*:\s*/i.exec(detail || '');
  if (!m) return null;
  const k = m[1].trim().toLowerCase();
  const map = {
    repo_url: ['repo', 'repo'], service: ['source', 'service'], branch: ['source', 'branch'], dockerfile: ['source', 'dockerfile'],
    build_command: ['source', 'build_command'], extra_repos: ['source', 'extra'], 'extra repo': ['source', 'extra'],
    password: ['password', 'password'], remote_dir: ['upload', 'remote_path'],
    env: ['source', 'env'], preload_tars: ['source', 'preload_tars'],
  };
  if (!map[k]) return null;
  let [step, fieldId] = map[k];
  if (k === 'env' && (m[5] === 'content' || m[5] === 'path')) fieldId = 'env_' + m[5];
  if (fieldId === 'extra' && m[3] !== undefined && m[5]) fieldId = 'x-' + ({url: 'url', branch: 'branch', name: 'name'}[m[5]] || 'url') + '-' + m[3];
  return {step, field: fieldId, msg: detail};
}

/** Summary with an Edit link per row, then start the build. */
export function review(root, ctx) {
  let up = session.uploadCfg, dead = false;
  const dl = h('dl', {class: 'review'});
  root.append(stepHead('Review and start', 'Nothing has been built yet.'), dl);
  const ENV_SRC = {gitlab: 'from GitLab CI', file: 'from file', paste: 'pasted'};

  function paintRows() {
    const d = getDraft(), rows = [];
    const row = (label, value, step, mono) => rows.push(h('div', {}, h('dt', {}, label), h('dd', {class: mono ? 'mono' : ''}, value),
      h('dd', {class: 'e'}, h('a', {href: '#/new/' + step, 'aria-label': 'Edit ' + label, onclick: () => { session.fromReview = true; }}, 'Edit'))));
    row('Repository', d.repo_full || d.repo_url, 'repo', true);
    row('Branch', d.branch, 'source', true);
    row('Service', d.service + '  →  ' + d.service + '_<timestamp>.zip', 'source', true);
    row('Dockerfile', d.dockerfile || 'Dockerfile', 'source', true);
    if (d.build_command) row('Build command', d.build_command, 'source', true);
    if (d.extra_repos.length) row('Extra repos', d.extra_repos.map(x => (x.name || baseName(x.url)) + ' (' + (x.branch || 'main') + ')').join(', '), 'source', true);
    row('.env', d.env_mode === 'none' ? 'None' : envKeys(d.env_content).length + ' keys → ' + (d.env_path || '.env') + ' (' + ENV_SRC[d.env_source] + ')', 'source', d.env_mode !== 'none');
    const pre = preloadList(d.preload_tars).length;
    if (pre) row('Preload', pre + (pre === 1 ? ' image tar' : ' image tars'), 'source');
    row('Password', '•••••••• set', 'password');
    const on = uploadConfigured(up) && d.upload;
    row('Upload', up === undefined ? 'Checking…' : on ? uploadTarget(up, false, d.remote_dir) : 'Off — saved on this computer', 'upload', on);
    dl.replaceChildren(...rows);
  }
  paintRows();
  uploadApi.get().then(c => { session.uploadCfg = c; up = c; }).catch(() => { session.uploadCfg = null; up = null; })
    .then(() => { if (!dead) paintRows(); });

  const fail = msg => ctx.setFormAlert(h('div', {style: {marginTop: 'var(--s5)'}}, alertBox('error', h('span', {}, msg))));
  const back = (pending, step) => { session.pendingErr = pending; session.fromReview = true; router.go('#/new/' + step, true); };

  async function submit() {
    const D = getDraft();
    const b = {
      service: D.service, repo_url: D.repo_url, branch: D.branch, dockerfile: D.dockerfile || 'Dockerfile', build_command: D.build_command,
      extra_repos: D.extra_repos.map(x => ({url: x.url, branch: x.branch || 'main', name: x.name || undefined})),
      password: D.password, password_confirm: D.password_confirm,
      upload: !!(D.upload && uploadConfigured(session.uploadCfg)),
      remote_dir: D.upload && D.remote_dir ? D.remote_dir : undefined,
      env: D.env_mode === 'none' ? null : {content: D.env_content, path: D.env_path || '.env', source: D.env_source},
      preload_tars: preloadList(D.preload_tars),
    };
    if (b.env && !b.env.content.trim()) return back({step: 'source', field: 'env', msg: "Add the .env content. It isn't kept after a reload."}, 'source');
    // client-side mirror of the server's password rules
    if (b.password.length < 4) return back({step: 'password', field: 'password', msg: 'At least 4 characters.'}, 'password');
    if (b.password !== b.password_confirm) return back({step: 'password', field: 'password_confirm', msg: "Passwords don't match."}, 'password');
    ctx.setFormAlert(null);
    ctx.setNextBusy('Starting…');
    let job;
    try { job = await jobsApi.create(b); }
    catch (e) {
      ctx.setNextBusy(null);
      const {status, detail} = errDetail(e);
      if (status === 400) {
        const m = mapDetail(detail);
        if (m) { toast('Fix 1 issue before starting.', 'error'); return back(m, m.step); }
        fail(detail);
      } else if (status === 409) fail('A build for ' + D.service + ' started this same second. Wait a moment and try again.');
      else if (status === 0) toast("Can't reach the local server.", 'error', {label: 'Retry', run: () => { submit(); }});
      else fail(detail);
      return;
    }
    b.password = ''; b.password_confirm = ''; b.env = null;
    resetDraft();
    router.setLeaveGuard(null);
    location.replace('#/jobs/' + job.id);
  }
  return {validate: () => [], refresh: () => {}, submit, first: () => null, cleanup: () => { dead = true; }};
}
