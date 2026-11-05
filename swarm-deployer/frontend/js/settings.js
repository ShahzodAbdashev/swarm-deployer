// All settings on one page; #/settings/<section> scrolls to that card. Cards share one config object.
import {$, alertBox, btn, confirm, ctlWithErr, errDetail, field, gridRow, h, icon, input, live, put, pwInput, retryAlert,
  setBusy, setErr, sget, showErrs, skeleton, testRes, toast} from './ui.js';
import {API, RX, detailField, focusH1, hostErr, intErr, pathErr, portErr, setTitle, targetLabel, userErr} from './app.js';

const SECS = [['file-server', 'File server'], ['targets', 'Target servers'], ['options', 'Backup & deploy options'], ['gitlab', 'GitLab'], ['import', 'Import .env']];
const SAVED = '(saved) · leave blank to keep';

export function settingsPage(main, {section}) {
  setTitle('Settings');
  const ret = sget('sd.return'), ok = live(), box = h('div');
  let imported = null;
  put(main, h('div', {class: 'wrap'},
    h('a', {class: 'back-link', href: ret || '#/dashboard'}, icon('chevron-left'), ret ? 'Back to deploy' : 'Deployments'),
    h('div', {class: 'step-head'}, h('h1', {tabindex: '-1'}, 'Settings'),
      h('p', {class: 'sub'}, 'Where packages come from, where they go, and how deploys are backed up.')),
    h('nav', {class: 'secnav', 'aria-label': 'Settings sections'},
      SECS.map(([id, label]) => h('a', {class: 'btn ghost', href: '#/settings/' + id, 'aria-current': section === id ? 'true' : null}, label))),
    box));
  focusH1();
  const load = () => {
    put(box, h('div', {class: 'stack'}, [0, 1, 2].map(() => skeleton('100%', 120))));
    API.config().then(cfg => {
      if (!ok()) return;
      put(box, fileServerCard(cfg), targetsCard(cfg), optionsCard(cfg), gitlabCard(cfg), importCard(imported, r => { imported = r; load(); }));
      if (section) $(section)?.scrollIntoView({block: 'start'});
    }).catch(e => { if (ok()) put(box, retryAlert("Couldn't load settings. " + errDetail(e).detail, load)); });
  };
  load();
}

/** Live form errors: after the first submit they follow the input; a server error stays on its field until the next edit. */
function errState(validate) {
  const st = {tried: false, api: null};
  const clearApi = () => { if (st.api) { setErr(st.api, null); st.api = null; } };
  st.check = (...a) => { st.tried = true; clearApi(); return showErrs(validate(...a)); };
  st.onInput = (...a) => { clearApi(); if (st.tried) showErrs(validate(...a)); };
  st.apiErr = (id, msg) => { st.api = id; setErr(id, msg); setTimeout(() => $(id)?.focus(), 0); };
  return st;
}
const card = (id, title, help, ...kids) => h('section', {class: 'card', id, 'aria-labelledby': id + '-h'},
  h('div', {class: 'card-head'}, h('h2', {id: id + '-h'}, title)),
  help ? h('p', {class: 'help', style: {margin: 'calc(-1 * var(--s3)) 0 var(--s4)'}}, help) : null, kids);
const errAlert = msg => h('div', {style: {marginTop: 'var(--s3)'}}, alertBox('error', h('span', null, msg)));
/** Enter in a text input submits the card (not on checkboxes / radios). */
const enterSubmits = (el, fn) => el.addEventListener('keydown', e => {
  const t = e.target;
  if (e.key === 'Enter' && t.tagName === 'INPUT' && t.type !== 'checkbox' && t.type !== 'radio') { e.preventDefault(); fn(); }
});
const portInput = (value, props) => input({type: 'number', min: '1', max: '65535', inputmode: 'numeric', value: String(value), ...props});
const footer = (...kids) => h('div', {class: 'wfoot'}, kids);

// ------------------------------------------------------------------ file server

/** SFTP server where Build Packager uploads the zips (read-only for Swarm Deployer). Test uses the typed values without saving. */
function fileServerCard(cfg) {
  const API_FIELD = {protocol: 'fs-proto', host: 'fs-host', port: 'fs-port', username: 'fs-username', password: 'fs-password', private_key_path: 'fs-key', remote_dir: 'fs-dir'};
  const f0 = cfg.file_server;
  const proto = h('select', {class: 'input'}, [['sftp', 'SFTP server'], ['local', 'Folder on this computer']].map(([v, l]) =>
    h('option', {value: v, selected: v === (f0.protocol || 'sftp') ? true : null}, l)));
  const host = input({placeholder: 'files.example.com', value: f0.host});
  const port = portInput(f0.port, {'aria-label': 'Port'});
  const user = input({placeholder: 'deploy', value: f0.username});
  const pw = pwInput({'data-secret': '1'});
  const key = input({placeholder: '~/.ssh/id_ed25519', value: f0.private_key_path}, true);
  const dir = input({placeholder: '/releases', value: f0.remote_dir}, true);
  const res = h('div', {'aria-live': 'polite'});
  const rmPw = h('button', {class: 'link', type: 'button', style: {alignSelf: 'flex-start', fontSize: '13px'}, onclick: () => removePw()}, 'Remove saved password');
  const fill = f => {
    proto.value = f.protocol || 'sftp'; host.value = f.host; port.value = String(f.port); user.value = f.username; key.value = f.private_key_path; dir.value = f.remote_dir;
    pw.input.value = '';
    pw.input.placeholder = f.has_password ? SAVED : '';
    rmPw.hidden = !f.has_password;
    mode();
  };
  let sftpRows = [];
  const mode = () => { const local = proto.value === 'local'; sftpRows.forEach(e => { e.hidden = local; });
    dir.placeholder = local ? '/home/me/releases' : '/releases'; };
  const v = () => ({protocol: proto.value, host: host.value.trim(), port: Number(port.value), username: user.value.trim(), private_key_path: key.value.trim(), remote_dir: dir.value.trim()});
  const st = errState(needHost => {
    const x = v();
    if (x.protocol === 'local') return {'fs-dir': x.remote_dir.startsWith('/') ? null : 'Enter a full folder path, like /home/me/releases.'};
    return {'fs-host': x.host ? hostErr(x.host) : needHost ? 'Enter a host.' : null, 'fs-port': portErr(x.port),
      'fs-username': userErr(x.username, true), 'fs-dir': pathErr(x.remote_dir)};
  });
  const payload = () => (pw.input.value ? {...v(), password: pw.input.value} : v());
  const showApiErr = d => {
    const id = detailField(d, pre => API_FIELD[pre]);
    if (id) { put(res); st.apiErr(id, d); } else put(res, errAlert(d));
  };

  const saveBtn = btn('primary', 'Save', () => save());
  const testBtn = btn('secondary', 'Test connection', () => test());
  async function save() {
    put(res);
    const bad = st.check(false);
    if (bad) { $(bad).focus(); return; }
    setBusy(saveBtn, 'Saving…');
    try {
      const r = await API.putFileServer(payload());
      setBusy(saveBtn, null);
      cfg.file_server = r;
      fill(r);
      put(res, testRes(true, 'Saved.'));
    } catch (e) { setBusy(saveBtn, null); showApiErr(errDetail(e).detail); }
  }
  async function test() {
    put(res);
    const bad = st.check(true);
    if (bad) { $(bad).focus(); return; }
    setBusy(testBtn, 'Testing… (up to 20s)');
    try { const r = await API.testFileServer(payload()); put(res, testRes(r.ok, r.message)); } catch (e) { put(res, testRes(false, errDetail(e).detail)); }
    setBusy(testBtn, null);
  }
  async function removePw() {
    if (!(await confirm({title: 'Remove the saved password?', body: 'The file server will be used with the private key only, or fail if it needs a password.', confirm: 'Remove password'}))) return;
    try {
      const r = await API.putFileServer({password: ''});
      cfg.file_server = r;
      pw.input.placeholder = r.has_password ? SAVED : '';
      rmPw.hidden = !r.has_password;
      toast('Saved password removed', 'success');
    } catch (e) { toast(errDetail(e).detail, 'error'); }
  }

  sftpRows = [h('label', {class: 'lbl', for: 'fs-host'}, 'Host and port'),
    h('div', {class: 'ctl'}, h('div', {class: 'hostport'}, ctlWithErr('fs-host', host), ctlWithErr('fs-port', port))),
    ...gridRow({id: 'fs-username', label: 'Username'}, user),
    ...gridRow({id: 'fs-password', label: 'Password', extra: rmPw}, pw),
    ...gridRow({id: 'fs-key', label: 'Private key', help: 'Optional. Used instead of, or with, the password.'}, key)];
  proto.addEventListener('change', mode);
  fill(f0);
  const el = card('file-server', 'File server', 'Where the zips are: an SFTP server, or a folder on this computer you copy them into. Swarm Deployer only reads from it.',
    h('div', {class: 'form-grid', oninput: () => st.onInput(false)},
      gridRow({id: 'fs-proto', label: 'Source'}, proto),
      sftpRows,
      gridRow({id: 'fs-dir', label: 'Folder', help: 'SFTP: the folder the package list opens in, e.g. /releases. Local: the full path of the folder on this computer.'}, dir)),
    footer(testBtn, h('span', {class: 'spacer'}), saveBtn), res);
  enterSubmits(el, save);
  return el;
}

// ------------------------------------------------------------------ targets

/** Docker Swarm managers reached over SSH: list with Test / Edit / Delete, or the add/edit form. */
function targetsCard(cfg) {
  const el = h('section', {class: 'card', id: 'targets', 'aria-labelledby': 'tg-h'});
  const help = () => h('p', {class: 'help', style: {margin: 'calc(-1 * var(--s3)) 0 var(--s4)'}}, 'Docker Swarm managers Swarm Deployer signs in to over SSH. Every docker command runs there.');
  const head = editing => h('div', {class: 'card-head'}, h('h2', {id: 'tg-h'}, 'Target servers'),
    editing ? null : btn('secondary', [icon('plus'), 'Add target'], () => edit(null)));

  function edit(t) {
    put(el, head(true), help(), targetForm(cfg, t, () => list(), r => {
      cfg.targets = t ? cfg.targets.map(x => (x.id === r.id ? r : x)) : [...cfg.targets, r];
      list();
    }));
  }
  function list() {
    put(el, head(false), help(), h('div', {class: 'list'}, cfg.targets.length ? cfg.targets.map(row) : h('p', {class: 'list-empty'}, 'No target servers yet.')));
  }
  function row(t) {
    const res = h('div', {class: 'res', 'aria-live': 'polite'});
    const nodes = (t.extra_nodes || []).length;
    const testBtn = btn('secondary', 'Test', async () => {
      res.replaceChildren();
      setBusy(testBtn, 'Testing…');
      try { const r = await API.testTarget(t.id); put(res, testRes(r.ok, r.message + (r.ok && r.host_key ? ' · ' + r.host_key : ''))); }
      catch (e) { put(res, testRes(false, errDetail(e).detail)); }
      setBusy(testBtn, null);
    });
    const remove = async () => {
      if (!(await confirm({title: 'Delete target ' + (t.name || t.id) + '?', body: 'Only the saved connection is removed. Nothing on the server is touched.', confirm: 'Delete target'}))) return;
      try { await API.removeTarget(t.id); cfg.targets = cfg.targets.filter(x => x.id !== t.id); list(); toast('Target deleted', 'success'); }
      catch (e) { put(res, testRes(false, errDetail(e).detail)); }
    };
    return h('div', {class: 'lrow'},
      h('div', {class: 'main'},
        h('span', null, h('b', {style: {fontWeight: 500}}, t.name || t.id), h('span', {class: 'muted mono'}, ' · ' + t.id)),
        h('span', {class: 'mono muted'}, targetLabel(t) + ' · ' + t.docker_cmd + ' · host key ' + t.host_key_policy
          + (nodes ? ' · ' + nodes + ' extra node' + (nodes > 1 ? 's' : '') : '') + (t.registry?.url ? ' · registry ' + t.registry.url : ''))),
      h('div', {class: 'acts'}, testBtn, btn('ghost', 'Edit', () => edit(t)), btn('ghost', 'Delete', remove)),
      res);
  }
  list();
  return el;
}

function targetForm(cfg, target, onCancel, onSaved) {
  const API_FIELD = {
    id: 'tg-id', name: 'tg-name', host: 'tg-host', port: 'tg-port', username: 'tg-username', password: 'tg-password', private_key_path: 'tg-key',
    host_key_policy: 'tg-policy', docker_cmd: 'tg-docker', work_dir: 'tg-work', backup_dir: 'tg-backup',
    'registry.url': 'tg-reg-url', 'registry.username': 'tg-reg-user', 'registry.password': 'tg-reg-password',
  };
  const isNew = !target;
  const t0 = target || {id: '', name: '', host: '', port: 22, username: '', has_password: false, private_key_path: '', host_key_policy: 'auto_add',
    docker_cmd: 'docker', work_dir: '', backup_dir: '', extra_nodes: []};
  const reg0 = t0.registry || {url: '', username: '', has_password: false};
  const select = (value, opts) => h('select', {class: 'input'}, opts.map(([v, l]) => h('option', {value: v, selected: v === value ? true : null}, l)));

  const f = {
    id: input({placeholder: 'lab', value: t0.id, disabled: !isNew, maxlength: '32'}, true),
    name: input({placeholder: 'Lab swarm', value: t0.name}),
    host: input({placeholder: '10.0.0.5', value: t0.host}),
    port: portInput(t0.port, {'aria-label': 'Port'}),
    username: input({placeholder: 'deploy', value: t0.username}),
    pw: pwInput({'data-secret': '1', placeholder: t0.has_password ? SAVED : ''}),
    key: input({placeholder: '~/.ssh/id_ed25519', value: t0.private_key_path}, true),
    policy: select(t0.host_key_policy, [['auto_add', 'auto_add · accept and remember new keys'], ['warn', 'warn · accept, log a warning'], ['reject', 'reject · only known_hosts']]),
    docker: select(t0.docker_cmd, [['docker', 'docker'], ['sudo -n docker', 'sudo -n docker']]),
    work: input({placeholder: '/home/deploy/sd-work', value: t0.work_dir}, true),
    backup: input({placeholder: '/home/deploy/sd-backups', value: t0.backup_dir}, true),
    regUrl: input({placeholder: '192.192.192.175:5050', value: reg0.url}, true),
    regUser: input({value: reg0.username}),
    regPw: pwInput({'data-secret': '1', placeholder: reg0.has_password ? SAVED : ''}),
  };
  const policyWarn = alertBox('warning', "Accepts any host key the first time. Fine for a lab, use 'reject' with known_hosts in production.", 'alert');
  const syncPolicy = () => { policyWarn.hidden = f.policy.value !== 'auto_add'; };
  f.policy.addEventListener('change', syncPolicy);
  syncPolicy();

  // extra nodes: state objects; the list re-renders (ids are by position) on add / remove
  let nodes = (t0.extra_nodes || []).map(n => ({host: n.host, port: String(n.port), username: n.username, private_key_path: n.private_key_path || '', has_password: !!n.has_password, pw: ''}));
  const nodeBox = h('div', {class: 'stack', style: {gap: 'var(--s3)'}});
  const addN = h('button', {class: 'link', type: 'button'}, icon('plus'), ' Add node');
  const renderNodes = () => put(nodeBox, nodes.map((n, i) => {
    const bind = (el, k) => { el.addEventListener('input', () => { n[k] = (el.input || el).value; }); return el; };
    return h('div', {class: 'nrow'},
      field({id: 'tg-node-host-' + i, label: 'Host'}, bind(input({placeholder: '10.0.0.6', value: n.host}), 'host')),
      field({id: 'tg-node-port-' + i, label: 'Port'}, bind(portInput(n.port), 'port')),
      field({id: 'tg-node-username-' + i, label: 'Username'}, bind(input({placeholder: 'deploy', value: n.username}), 'username')),
      field({id: 'tg-node-password-' + i, label: 'Password'}, bind(pwInput({'data-secret': '1', placeholder: n.has_password ? '(saved)' : '', value: n.pw}), 'pw')),
      field({id: 'tg-node-key-' + i, label: 'Private key'}, bind(input({placeholder: '~/.ssh/id_ed25519', value: n.private_key_path}, true), 'private_key_path')),
      h('span'),
      h('button', {class: 'link rm', type: 'button', 'aria-label': 'Remove node ' + (i + 1), onclick: () => { nodes.splice(i, 1); renderNodes(); addN.focus(); }}, 'Remove node'));
  }));
  addN.addEventListener('click', () => {
    nodes.push({host: '', port: '22', username: f.username.value.trim(), private_key_path: '', has_password: false, pw: ''});
    renderNodes();
    $('tg-node-host-' + (nodes.length - 1))?.focus();
  });
  renderNodes();

  const v = () => ({id: f.id.value.trim(), name: f.name.value.trim(), host: f.host.value.trim(), port: Number(f.port.value), username: f.username.value.trim(),
    private_key_path: f.key.value.trim(), host_key_policy: f.policy.value, docker_cmd: f.docker.value, work_dir: f.work.value.trim(), backup_dir: f.backup.value.trim()});
  const nv = () => nodes.map(n => ({host: n.host.trim(), port: Number(n.port), username: n.username.trim(), private_key_path: n.private_key_path.trim(), pw: n.pw}));
  const st = errState(() => {
    const x = v(), e = {};
    if (isNew) e['tg-id'] = RX.tid.test(x.id) ? (cfg.targets.some(t => t.id === x.id) ? 'This id is already used.' : null) : 'Use lowercase letters, numbers and - (max 32).';
    e['tg-host'] = hostErr(x.host);
    e['tg-port'] = portErr(x.port);
    e['tg-username'] = userErr(x.username);
    e['tg-work'] = pathErr(x.work_dir);
    e['tg-backup'] = pathErr(x.backup_dir);
    const ru = f.regUrl.value.trim(), rn = f.regUser.value.trim();
    e['tg-reg-url'] = !ru || (ru.length <= 253 && RX.reg.test(ru)) ? null : 'Host and port only, like 192.192.192.175:5050.';
    e['tg-reg-user'] = !ru || rn ? (rn && !/^[A-Za-z0-9_.@+-]{1,128}$/.test(rn) ? 'Use letters, numbers, _ . @ + - (max 128).' : null) : 'Enter the registry user.';
    nv().forEach((n, i) => {
      e['tg-node-host-' + i] = hostErr(n.host);
      e['tg-node-port-' + i] = portErr(n.port);
      e['tg-node-username-' + i] = userErr(n.username);
    });
    return e;
  });

  const alertSlot = h('div');
  const saveBtn = btn('primary', isNew ? 'Add target' : 'Save target', () => save());
  async function save() {
    put(alertSlot);
    const bad = st.check();
    if (bad) { $(bad).focus(); return; }
    const x = v();
    const body = {...x, extra_nodes: nv().map(n => {
      const o = {host: n.host, port: n.port, username: n.username, private_key_path: n.private_key_path};
      if (n.pw) o.password = n.pw;
      return o;
    })};
    if (f.pw.input.value) body.password = f.pw.input.value;
    body.registry = {url: f.regUrl.value.trim(), username: f.regUser.value.trim()};
    if (f.regPw.input.value) body.registry.password = f.regPw.input.value;
    if (!body.name) body.name = x.id;
    setBusy(saveBtn, 'Saving…');
    try {
      let r;
      if (isNew) r = await API.createTarget(body);
      else { const {id: id0, ...rest} = body; r = await API.updateTarget(id0 || t0.id, rest); }
      toast('Target ' + (r.name || r.id) + ' saved', 'success');
      onSaved(r);
    } catch (e) {
      setBusy(saveBtn, null);
      const {status, detail} = errDetail(e);
      if (status === 409 && isNew) { st.apiErr('tg-id', detail); return; }
      const id = detailField(detail, pre => {
        const mm = /^extra_nodes\[(\d+)\]\.(\w+)/.exec(pre);
        if (mm) return 'tg-node-' + ({private_key_path: 'key'}[mm[2]] || mm[2]) + '-' + mm[1];
        return API_FIELD[pre];
      });
      if (id && $(id + '-err')) st.apiErr(id, detail); else put(alertSlot, errAlert(detail));
    }
  }

  const el = h('div', null,
    h('div', {class: 'form-grid', oninput: () => st.onInput()},
      gridRow({id: 'tg-id', label: 'Id', help: isNew ? 'Lowercase letters, numbers and -. Deploy history refers to the target by this id.' : null}, f.id),
      gridRow({id: 'tg-name', label: 'Name'}, f.name),
      h('label', {class: 'lbl', for: 'tg-host'}, 'Host and port'),
      h('div', {class: 'ctl'}, h('div', {class: 'hostport'}, ctlWithErr('tg-host', f.host), ctlWithErr('tg-port', f.port))),
      gridRow({id: 'tg-username', label: 'Username'}, f.username),
      gridRow({id: 'tg-password', label: 'Password', help: 'Leave empty to use the private key or your SSH agent.'}, f.pw),
      gridRow({id: 'tg-key', label: 'Private key'}, f.key),
      gridRow({id: 'tg-policy', label: 'Host key policy', extra: policyWarn}, f.policy),
      gridRow({id: 'tg-docker', label: 'Docker command'}, f.docker),
      gridRow({id: 'tg-work', label: 'Work dir', help: 'Where the image .tar is uploaded. Created if missing.'}, f.work),
      gridRow({id: 'tg-backup', label: 'Backup dir', help: 'Service specs and backup metadata are kept here.'}, f.backup),
      h('span', {class: 'lbl'}),
      h('div', {class: 'ctl'}, h('h3', {class: 'micro', style: {margin: 'var(--s3) 0 0'}}, 'Registry (optional)')),
      gridRow({id: 'tg-reg-url', label: 'Registry', help: 'Empty = no registry: the image is loaded on each node. With a registry, images under it are pushed and deployed by digest.'}, f.regUrl),
      gridRow({id: 'tg-reg-user', label: 'Registry user'}, f.regUser),
      gridRow({id: 'tg-reg-password', label: 'Registry password'}, f.regPw),
      h('span', {class: 'lbl'}, 'Extra nodes'),
      h('div', {class: 'ctl', id: 'tg-nodes'},
        h('p', {class: 'help'}, 'Other swarm nodes that need the image loaded locally. They never get service commands.'),
        nodeBox, h('div', null, addN))),
    alertSlot,
    footer(btn('ghost', 'Cancel', onCancel), h('span', {class: 'spacer'}), saveBtn));
  el.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); save(); } });
  setTimeout(() => (isNew ? f.id : f.name).focus(), 0);
  return el;
}

// ------------------------------------------------------------------ options

/** Backup retention, default .tar backup, rollout timeouts. */
function optionsCard(cfg) {
  const API_FIELD = {keep_backups: 'op-keep', converge_timeout: 'op-conv', update_monitor: 'op-mon', health_timeout: 'op-ht'};
  const num = (a, b) => input({type: 'number', min: String(a), max: String(b), inputmode: 'numeric', style: {maxWidth: '140px'}});
  const keep = num(1, 50), conv = num(10, 1800), mon = num(1, 600), ht = num(1, 600);
  const tar = h('input', {type: 'checkbox', id: 'op-tar'}), prune = h('input', {type: 'checkbox', id: 'op-prune', 'aria-describedby': 'op-prune-help'});
  const fill = o => {
    keep.value = String(o.keep_backups); conv.value = String(o.converge_timeout); mon.value = String(o.update_monitor); ht.value = String(o.health_timeout);
    tar.checked = !!o.save_image_tar; prune.checked = !!o.prune_after;
  };
  fill(cfg.options);
  const v = () => ({keep_backups: Number(keep.value), save_image_tar: tar.checked, prune_after: prune.checked, converge_timeout: Number(conv.value),
    update_monitor: Number(mon.value), health_timeout: Number(ht.value)});
  const st = errState(() => {
    const x = v();
    return {'op-keep': intErr(x.keep_backups, 1, 50), 'op-conv': intErr(x.converge_timeout, 10, 1800),
      'op-mon': intErr(x.update_monitor, 1, 600), 'op-ht': intErr(x.health_timeout, 1, 600)};
  });
  const res = h('div', {'aria-live': 'polite'});
  const saveBtn = btn('primary', 'Save', () => save());
  async function save() {
    put(res);
    const bad = st.check();
    if (bad) { $(bad).focus(); return; }
    setBusy(saveBtn, 'Saving…');
    try { const r = await API.putOptions(v()); setBusy(saveBtn, null); cfg.options = r; fill(r); put(res, testRes(true, 'Saved.')); }
    catch (e) {
      setBusy(saveBtn, null);
      const d = errDetail(e).detail, id = detailField(d, pre => API_FIELD[pre]);
      if (id) st.apiErr(id, d); else put(res, errAlert(d));
    }
  }
  const el = card('options', 'Backup & deploy options', null,
    h('div', {class: 'form-grid'},
      gridRow({id: 'op-keep', label: 'Keep backups', help: 'Per service. Older backup dirs and tags are pruned (1–50).'}, keep),
      h('span', {class: 'lbl'}, 'Image .tar'),
      h('div', {class: 'ctl'}, h('label', {class: 'cbx'}, tar, h('span', null, 'Save the current image as a .tar in every backup by default'))),
      h('span', {class: 'lbl'}, 'Prune'),
      h('div', {class: 'ctl'},
        h('label', {class: 'cbx'}, prune, h('span', null, 'Run docker system prune -f on the target after a successful deploy')),
        h('p', {class: 'help', id: 'op-prune-help'}, "Same as the CI's prune: removes all stopped containers on the manager and unused networks (also a stopped stack's networks), dangling images and build cache.")),
      gridRow({id: 'op-conv', label: 'Converge timeout', help: 'Seconds to wait for all tasks to run the new image (10–1800).'}, conv),
      gridRow({id: 'op-mon', label: 'Update monitor', help: 'Seconds swarm watches each task before it counts as updated (1–600).'}, mon),
      gridRow({id: 'op-ht', label: 'Health timeout', help: 'Seconds to wait for the health check URL (1–600).'}, ht)),
    footer(h('span', {class: 'spacer'}), saveBtn), res);
  enterSubmits(el, save);
  return el;
}

// ------------------------------------------------------------------ GitLab

/** GitLab URL + access token, used only by "Import from GitLab project". */
function gitlabCard(cfg) {
  const g = cfg.gitlab;
  const url = input({placeholder: 'http://192.168.33.175', value: g?.url || ''}, true);
  const token = pwInput({'data-secret': '1', placeholder: g?.has_token ? SAVED : 'glpat-…'});
  const res = h('div', {'aria-live': 'polite'});
  const saveBtn = btn('primary', 'Save', async () => {
    put(res);
    setBusy(saveBtn, 'Saving…');
    const body = {url: url.value.trim()};
    if (token.input.value) body.token = token.input.value.trim();
    try {
      const r = await API.putGitlab(body);
      cfg.gitlab = r;
      url.value = r.url;
      token.input.value = '';
      token.input.placeholder = r.has_token ? SAVED : 'glpat-…';
      put(res, testRes(true, r.has_token ? 'Saved.' : 'Saved. No token: a new URL needs its token again.'));
    } catch (e) { put(res, testRes(false, errDetail(e).detail)); }
    setBusy(saveBtn, null);
  });
  return card('gitlab', 'GitLab', 'Optional. Only needed for "Import from GitLab project" below.',
    h('div', {class: 'form-grid'},
      gridRow({id: 'gl-url', label: 'GitLab URL'}, url),
      gridRow({id: 'gl-token', label: 'Access token', help: 'Personal access token with the api scope (reads CI/CD variables).'}, token)),
    footer(h('span', {class: 'spacer'}), saveBtn), res);
}

// ------------------------------------------------------------------ import

/** Fill settings from a .env (file or paste) or from a GitLab project's CI/CD variables. Values are never shown back. */
function importCard(result, onImported) {
  const file = h('input', {type: 'file', accept: '.env,text/plain'});
  const text = h('textarea', {class: 'input mono', 'data-secret': '1', rows: '6', spellcheck: 'false', autocapitalize: 'off',
    style: {height: 'auto', paddingTop: '8px'}, placeholder: 'FILE_SERVER_HOST=…\nBASE_DEVELOPMENT_HOST=…'});
  const target = input({placeholder: 'dev', style: {maxWidth: '200px'}}, true);
  const project = h('select', {class: 'input', disabled: true}, h('option', {value: ''}, 'Loading projects…'));
  const errBox = h('div', {id: 'ie-err'});
  file.addEventListener('change', async () => { const f0 = file.files?.[0]; if (f0) text.value = await f0.text(); file.value = ''; });

  const envBtn = btn('primary', 'Import .env', () => run('env', envBtn));
  const glBtn = btn('secondary', 'Import from GitLab', () => run('gitlab', glBtn), {disabled: true});
  async function run(kind, b) {
    errBox.replaceChildren();
    if (kind === 'env' && !text.value.trim()) { put(errBox, testRes(false, 'Paste a .env or choose a file first.')); return; }
    const other = b === envBtn ? glBtn : envBtn, otherWas = other.disabled;
    setBusy(b, 'Importing…');
    other.disabled = true;
    try {
      const tid = target.value.trim() || undefined;
      const r = kind === 'env' ? await API.importEnv(text.value, tid) : await API.importGitlab(project.value, tid);
      text.value = '';
      onImported(r);
    } catch (e) {
      setBusy(b, null);
      other.disabled = otherWas;
      put(errBox, testRes(false, errDetail(e).detail));
    }
  }
  API.gitlabProjects().then(ps => {
    put(project, ps.map(p => h('option', {value: p.full_name}, p.full_name)));
    project.disabled = false;
    glBtn.disabled = !ps.length;
  }).catch(e => project.replaceWith(testRes(false, "Couldn't load GitLab projects. " + errDetail(e).detail)));

  return card('import', 'Import .env', 'Fills these settings from a .env file. Values are never shown back.',
    h('div', {class: 'form-grid'},
      gridRow({id: 'ie-file', label: '.env file'}, file),
      gridRow({id: 'ie-text', label: 'Or paste it'}, text),
      gridRow({id: 'ie-target', label: 'Target id', help: 'Target id for SSH/registry keys (default: the only target, or "dev").'}, target),
      h('span', {class: 'lbl'}), h('div', {class: 'ctl'}, h('div', null, envBtn)),
      gridRow({id: 'ie-project', label: 'GitLab project', help: "Reads the project's CI/CD variables (and its groups'), like the pipeline does."}, project),
      h('span', {class: 'lbl'}), h('div', {class: 'ctl'}, h('div', null, glBtn))),
    errBox,
    result ? h('div', {id: 'ie-result', 'aria-live': 'polite'},
      testRes(!result.errors.length || !!result.set.length, (result.project ? result.project + ' · ' : '') + 'Set: ' + (result.set.length ? result.set.join(', ') : 'nothing')),
      result.ignored.length ? h('p', {class: 'muted micro'}, 'Ignored: ' + result.ignored.join(', ')) : null,
      result.errors.map(e => testRes(false, e))) : null);
}
