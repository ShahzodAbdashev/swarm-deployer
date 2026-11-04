// Settings: upload server (FileZilla-style site, test before or after saving), GitLab OAuth application, Import .env.
import {alertBox, btn, busy, confirm, copyText, errText, field, h, icon, input, paintErrs, pw, segmented, sget, skel, stepHead, switchBtn, textarea,
  toast} from './ui.js';
import {GITLAB_START, authApi, configApi, errDetail, focusH1, getAuth, router, setAuth, setTitle, uploadApi} from './state.js';
import {remotePathErr} from './lib.js';

const PORTS = {sftp: '22', ftp: '21', ftps: '21', smb: '445'};
const FIELDS = ['enabled', 'protocol', 'host', 'port', 'username', 'private_key_path', 'remote_dir', 'share', 'domain'];
const formOf = c => ({enabled: !!c.enabled, protocol: c.protocol, host: c.host, port: String(c.port), username: c.username,
  private_key_path: c.private_key_path, remote_dir: c.remote_dir, share: c.share || '', domain: c.domain || ''});
const valuesOf = f => ({enabled: f.enabled, protocol: f.protocol, host: f.host.trim(), port: Number(f.port), username: f.username.trim(),
  private_key_path: f.private_key_path.trim(), remote_dir: f.remote_dir.trim(), share: f.share.trim(), domain: f.domain.trim()});
const refreshAuth = () => authApi.status().then(setAuth).catch(() => { /* keep the current auth */ });
/** This app's OAuth callback; GitLab only accepts the exact registered URI, and the backend uses 127.0.0.1. */
const redirectUri = () => location.origin.replace('//localhost', '//127.0.0.1') + GITLAB_START.replace(/start$/, 'callback');
const contents = (...nodes) => h('div', {style: {display: 'contents'}}, nodes);
const testRes = (ok, msg) => h('div', {class: 'test-res ' + (ok ? 'ok' : 'bad')}, icon(ok ? 'check' : 'x'), h('span', {}, msg));

export function settingsPage(main) {
  const ret = sget('bp.return');
  setTitle('Upload server');
  let dead = false, gl = null;
  const formBox = h('div'), glSlot = contents(), envSlot = contents();
  main.append(h('div', {class: 'wrap'},
    h('a', {class: 'back-link', href: ret || '#/dashboard'}, icon('chevron-left'), ret ? 'Back to build' : 'Dashboard'),
    stepHead('Upload server', h('p', {class: 'sub'}, "Where finished zips are sent, like FileZilla's Site Manager.")),
    formBox, glSlot, envSlot));
  focusH1();

  function reload() {
    router.setLeaveGuard(null);
    formBox.replaceChildren(h('div', {class: 'stack'}, [0, 1, 2, 3, 4].map(() => skel('100%', 36))));
    uploadApi.get().then(c => { if (!dead) uploadForm(formBox, c); }).catch(e => {
      if (!dead) formBox.replaceChildren(alertBox('error', [h('span', {}, "Couldn't load settings. " + errDetail(e).detail), h('div', {}, btn('ghost', 'Retry', reload))]));
    });
    gl = gitlabSection();
    glSlot.replaceChildren(gl.el);
  }
  reload();
  envSlot.append(envImport(() => { reload(); refreshAuth().then(() => gl.paintWho()); }));
  return () => { dead = true; router.setLeaveGuard(null); };
}

/** GitLab URL / sign-in state and the OAuth application (id + secret). */
function gitlabSection() {
  let cfg = null;
  const errBox = contents();
  const urlP = h('p', {id: 'gl-cfg-url'});
  const idIn = input({id: 'gl-client-id', mono: true});
  const envHelp = h('p', {class: 'help', id: 'gl-client-id-help', hidden: true}, 'From the GITLAB_CLIENT_ID environment variable.');
  const secretWrap = pw({id: 'gl-client-secret', 'data-secret': '1', autocomplete: 'new-password'});
  const secretIn = secretWrap.querySelector('input');
  const uri = redirectUri();
  const paintWho = () => {
    const g = getAuth()?.gitlab;
    const who = g?.logged_in ? 'signed in as @' + (g.login || '') + ' (' + (g.method === 'oauth' ? 'OAuth' : 'token') + ')' : 'not signed in';
    urlP.textContent = 'GitLab: ' + (cfg?.url || g?.url || '…') + ' · ' + who;
  };
  const show = c => {
    cfg = c;
    idIn.value = c.client_id || '';
    secretIn.value = '';
    secretIn.placeholder = c.has_client_secret ? '(saved) · leave blank to keep' : '';
    envHelp.hidden = c.client_id_source !== 'env';
    if (!envHelp.hidden) idIn.setAttribute('aria-describedby', 'gl-client-id-help');
    saveBtn.disabled = false;
    paintWho();
  };
  const saveBtn = btn('secondary', 'Save GitLab settings', async () => {
    busy(saveBtn, 'Saving…');
    try {
      const v = secretIn.value;
      const c = await configApi.putGitlab({client_id: idIn.value.trim(), ...(v ? {client_secret: v} : {})});
      busy(saveBtn, null);
      show(c);
      toast('GitLab settings saved', 'success');
      refreshAuth().then(paintWho);
    } catch (e) { busy(saveBtn, null); toast(errDetail(e).detail, 'error'); }
  }, {disabled: true});
  configApi.getGitlab().then(show).catch(e => errBox.replaceChildren(alertBox('error', h('span', {}, "Couldn't load GitLab settings. " + errDetail(e).detail))));
  paintWho();
  const el = h('section', {id: 'gitlab-cfg', class: 'cfg-sec'},
    h('h2', {}, 'GitLab'), errBox, urlP,
    field('gl-client-id', 'OAuth application ID', idIn, {extra: envHelp}),
    field('gl-client-secret', 'OAuth application secret', secretWrap),
    h('p', {class: 'help'}, 'Register one application in GitLab for both tools: redirect URIs http://127.0.0.1:8090/api/auth/gitlab/callback and http://127.0.0.1:8095/api/auth/gitlab/callback, scope api, Confidential off (PKCE).'),
    h('div', {class: 'redirect'}, h('span', {class: 'mono', id: 'gl-redirect'}, uri),
      btn('ghost', [icon('copy'), 'Copy'], async () => { if (await copyText(uri)) toast('Redirect URI copied'); }, {'aria-label': 'Copy redirect URI'})),
    h('div', {}, saveBtn));
  return {el, paintWho};
}

/** Fill upload + GitLab settings from a .env file; the server answers with key names only. */
function envImport(onDone) {
  const ta = textarea({id: 'env-import-text', rows: 5, class: 'mono', 'data-secret': '1', placeholder: 'GITLAB_URL=…\nFILE_SERVER_HOST=…'});
  const res = h('div', {id: 'env-import-res', 'aria-live': 'polite'});
  const run = btn('secondary', 'Import .env', async () => {
    res.replaceChildren();
    if (!ta.value.trim()) { res.replaceChildren(testRes(false, 'Choose a .env file or paste its content first.')); return; }
    busy(run, 'Importing…');
    try {
      const r = await configApi.importEnv(ta.value);
      ta.value = '';
      res.replaceChildren(testRes(true, 'Set: ' + (r.set.join(', ') || 'nothing')),
        r.ignored.length ? h('p', {class: 'help'}, 'Ignored: ' + r.ignored.join(', ')) : null,
        ...r.errors.map(x => testRes(false, x)));
      onDone();
    } catch (e) { res.replaceChildren(testRes(false, errDetail(e).detail)); } finally { busy(run, null); }
  });
  return h('section', {id: 'env-import', class: 'cfg-sec'},
    h('h2', {}, 'Import .env'),
    h('p', {class: 'help'}, 'Fills these settings from a .env file. Values are never shown back.'),
    field('env-import-file', '.env file', h('input', {type: 'file', id: 'env-import-file', accept: '.env,text/plain',
      onchange: async e => { const f = e.target.files?.[0]; if (f) ta.value = await f.text(); }})),
    field('env-import-text', 'Or paste it', ta),
    h('div', {}, run),
    res);
}

function uploadForm(box, saved) {
  let f = formOf(saved), pwv = '', tried = false, portEdited = false, apiErr = null, hostTestErr = false;
  const v = () => valuesOf(f);
  const dirty = () => { const x = v(); return pwv !== '' || FIELDS.some(k => x[k] !== saved[k]); };
  router.setLeaveGuard(() => (dirty() ? {title: 'Discard unsaved changes?', body: 'Your changes to the upload server will be lost.', cancel: 'Keep editing', confirm: 'Discard'} : null));

  const set = patch => { f = {...f, ...patch}; apiErr = null; hostTestErr = false; paint(); };
  const txt = (id, p = {}) => input({id, value: f[id], oninput: e => set({[id]: e.target.value}), ...p});
  const ctl = (id, inp, help) => h('div', {class: 'ctl'}, inp, help ? h('p', {class: 'help', id: id + '-help'}, help) : null, errText(id));

  const sw = switchBtn('enabled', f.enabled, 'sw-l', enabled => set({enabled}));
  const offHelp = h('p', {class: 'help'}, 'Uploads are off. Your settings are kept.');
  const protoBox = contents();
  const ftpWarn = h('div', {class: 'alert warning'}, icon('alert'), h('div', {class: 'body'}, 'FTP sends your password unencrypted. Prefer SFTP or FTPS.'));
  const inputs = {
    host: txt('host', {placeholder: 'files.example.com'}),
    port: input({id: 'port', type: 'number', min: 1, max: 65535, inputmode: 'numeric', 'aria-label': 'Port', value: f.port,
      oninput: e => { portEdited = true; set({port: e.target.value}); }}),
    username: txt('username', {placeholder: 'deploy'}),
    private_key_path: txt('private_key_path', {mono: true, placeholder: '~/.ssh/id_ed25519'}),
    share: txt('share', {placeholder: 'releases'}),
    domain: txt('domain', {placeholder: ''}),
    remote_dir: txt('remote_dir', {mono: true}),
  };
  const pwWrap = pw({id: 'up-password', 'data-secret': '1', autocomplete: 'new-password', oninput: e => { pwv = e.target.value; apiErr = null; paint(); }});
  const pwIn = pwWrap.querySelector('input');
  const removePwBtn = h('button', {class: 'link', type: 'button', style: {alignSelf: 'flex-start', fontSize: '13px'}, onclick: async () => {
    if (!(await confirm({title: 'Remove the saved password?', body: 'Uploads will use the private key only, or fail if the server needs a password.', confirm: 'Remove password'}))) return;
    try { saved = await uploadApi.put({password: ''}); toast('Saved password removed', 'success'); paint(); } catch (e) { toast(errDetail(e).detail, 'error'); }
  }}, 'Remove saved password');
  const dirHelp = h('p', {class: 'help', id: 'remote_dir-help'});
  const sftpOnly = [h('label', {class: 'lbl', for: 'private_key_path'}, 'Private key'),
    contents(ctl('private_key_path', inputs.private_key_path, 'Optional. Used instead of, or with, the password.'))];
  const smbOnly = [h('label', {class: 'lbl', for: 'share'}, 'Share'), contents(ctl('share', inputs.share, 'Share name on the server, e.g. releases')),
    h('label', {class: 'lbl', for: 'domain'}, 'Domain'), contents(ctl('domain', inputs.domain, 'Leave empty unless your server needs DOMAIN\\user'))];
  const preview = h('p', {class: 'preview', 'aria-live': 'polite'});
  const dirtyHelp = h('p', {class: 'help', style: {marginTop: 'var(--s2)'}}, 'Tests what you typed. Save to keep it.');
  const resBox = h('div', {'aria-live': 'polite'});

  const errors = () => {
    const x = v(), e = {};
    if (x.enabled && !x.host) e.host = 'Enter a host to enable uploads.';
    if (!Number.isInteger(x.port) || x.port < 1 || x.port > 65535) e.port = 'Port must be 1–65535.';
    const rp = remotePathErr(x.remote_dir);
    if (rp) e.remote_dir = rp;
    if (x.protocol === 'smb' && x.host && !x.share) e.share = 'Enter the share name, e.g. releases.';
    return e;
  };
  const focusFirst = e => { const k = ['host', 'port', 'share', 'remote_dir'].find(x => e[x]); if (k) document.getElementById(k)?.focus(); return !!k; };

  function fill() {
    for (const k of Object.keys(inputs)) inputs[k].value = f[k];
    sw.setAttribute('aria-checked', String(f.enabled));
    protoBox.replaceChildren(segmented('protocol', 'proto-l', f.protocol, ['sftp', 'ftp', 'ftps', 'smb'].map(p => ({value: p, label: p.toUpperCase()})), p => {
      const patch = {protocol: p};
      if (!portEdited) { patch.port = PORTS[p]; inputs.port.value = PORTS[p]; }
      set(patch);
    }));
  }

  function paint() {
    const x = v(), smb = x.protocol === 'smb';
    const errs = tried ? errors() : {};
    if (hostTestErr && !x.host) errs.host = 'Enter a host to test.';
    if (apiErr) errs[apiErr.field] = apiErr.msg;
    paintErrs(box, errs);
    offHelp.hidden = x.enabled;
    ftpWarn.hidden = x.protocol !== 'ftp';
    sftpOnly.forEach(e => { e.hidden = x.protocol !== 'sftp'; });
    smbOnly.forEach(e => { e.hidden = !smb; });
    inputs.remote_dir.placeholder = smb ? '/builds' : '/home/deploy/releases';
    dirHelp.textContent = smb ? 'Folder inside the share, e.g. /builds' : 'Full path on the server, e.g. /home/deploy/releases. Missing folders are created.';
    const dir = x.remote_dir ? (x.remote_dir.startsWith('/') ? x.remote_dir : '/' + x.remote_dir) : '/';
    const base = x.protocol + '://' + (x.username ? x.username + '@' : '') + (x.host || 'host') + ':' + (x.port || '?')
      + (smb ? '/' + (x.share || 'share') : '') + dir.replace(/\/$/, '');
    preview.textContent = 'Uploads as ' + base + '/<service>_<timestamp>.zip';
    pwIn.placeholder = saved.has_password ? 'Saved · leave blank to keep' : '';
    removePwBtn.hidden = !saved.has_password;
    dirtyHelp.hidden = !dirty();
  }

  const saveBtn = btn('primary', 'Save', save);
  const testBtn = btn('secondary', 'Test connection', test);
  async function save() {
    tried = true;
    paint();
    if (focusFirst(errors())) return;
    const payload = {...v()};
    // first host ever saved with the switch untouched: turn uploads on, otherwise the wizard says "not set up"
    if (!saved.enabled && !saved.host && payload.host && !payload.enabled) payload.enabled = true;
    if (pwv) payload.password = pwv;
    busy(saveBtn, 'Saving…');
    try {
      const c = await uploadApi.put(payload);
      pwv = '';
      pwIn.value = '';
      toast('Settings saved', 'success');
      saved = c;
      f = formOf(c);
      fill();
    } catch (e) {
      const {detail} = errDetail(e);
      const m = /^(\w+):/.exec(detail);
      const id = m && ({protocol: 'host', password: 'up-password'}[m[1]] || m[1]);
      if (id && document.getElementById(id + '-err')) { apiErr = {field: id, msg: detail}; document.getElementById(id)?.focus(); } else toast(detail, 'error');
    } finally { busy(saveBtn, null); paint(); }
  }
  async function test() {
    resBox.replaceChildren();
    tried = true;
    const e = errors();
    if (!v().host) { hostTestErr = true; e.host = 'Enter a host to test.'; }
    paint();
    if (focusFirst(e)) return;
    busy(testBtn, 'Testing… (up to 15s)');
    try {
      const payload = {...v()};
      if (pwv) payload.password = pwv;
      const r = await uploadApi.test(payload);
      resBox.replaceChildren(testRes(r.ok, r.message));
    } catch (err) {
      const {status, detail} = errDetail(err);
      resBox.replaceChildren(testRes(false, status === 400 ? 'Enter a host first.' : detail));
    } finally { busy(testBtn, null); }
  }

  const form = h('div', {onkeydown: e => { const t = e.target; if (e.key === 'Enter' && t.tagName === 'INPUT' && t.type !== 'radio') { e.preventDefault(); save(); } }},
    h('div', {class: 'switch-row'}, h('div', {style: {flex: '1'}}, h('div', {id: 'sw-l', style: {fontWeight: 500}}, 'Upload after each build'), offHelp), sw),
    h('div', {class: 'form-grid'},
      h('span', {class: 'lbl', id: 'proto-l'}, 'Protocol'),
      h('div', {class: 'ctl'}, protoBox, ftpWarn),
      h('label', {class: 'lbl', for: 'host'}, 'Host and port'),
      h('div', {class: 'ctl'}, h('div', {class: 'hostport'}, ctl('host', inputs.host), ctl('port', inputs.port))),
      h('label', {class: 'lbl', for: 'username'}, 'Username'),
      ctl('username', inputs.username),
      h('label', {class: 'lbl', for: 'up-password'}, 'Password'),
      h('div', {class: 'ctl'}, pwWrap, removePwBtn, errText('up-password')),
      sftpOnly, smbOnly,
      h('label', {class: 'lbl', for: 'remote_dir'}, 'Remote path'),
      h('div', {class: 'ctl'}, inputs.remote_dir, dirHelp, errText('remote_dir'))),
    h('div', {style: {marginTop: 'var(--s5)'}}, preview),
    h('div', {class: 'wfoot'}, testBtn, h('span', {class: 'spacer'}), saveBtn),
    dirtyHelp, resBox);
  fill();
  box.replaceChildren(form);
  paint();
}
