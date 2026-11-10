// Settings: the target servers (SSH login + packages folder + backup folder). That is all the setup there is.
import {$, alertBox, btn, confirm, ctlWithErr, errDetail, field, gridRow, h, icon, input, live, put, pwInput, retryAlert,
  setBusy, setErr, sget, showErrs, skeleton, testRes, toast} from './ui.js';
import {API, RX, detailField, focusH1, hostErr, intErr, pathErr, portErr, setTitle, targetLabel, userErr} from './app.js';

const SAVED = '(saved) · leave blank to keep';

export function settingsPage(main, {section}) {
  setTitle('Settings');
  const ret = sget('sd.return'), ok = live(), box = h('div');
  put(main, h('div', {class: 'wrap'},
    h('a', {class: 'back-link', href: ret || '#/dashboard'}, icon('chevron-left'), ret ? 'Back to deploy' : 'Deployments'),
    h('div', {class: 'step-head'}, h('h1', {tabindex: '-1'}, 'Settings'),
      h('p', {class: 'sub'}, 'The target server: how to sign in, where new image zips arrive, and where backups go.')),
    box));
  focusH1();
  const load = () => {
    put(box, h('div', {class: 'stack'}, [skeleton('100%', 120)]));
    API.config().then(cfg => {
      if (!ok()) return;
      put(box, targetsCard(cfg));
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
          + (nodes ? ' · ' + nodes + ' extra node' + (nodes > 1 ? 's' : '') : '') + (t.registry?.url ? ' · registry ' + t.registry.url : '')),
        h('span', {class: 'mono muted'}, t.packages_dir ? 'packages ' + t.packages_dir + ' · backups ' + t.backup_dir
          : h('span', {class: 'warn'}, 'Packages folder not set: Edit to add it'))),
      h('div', {class: 'acts'}, testBtn, btn('ghost', 'Edit', () => edit(t)), btn('ghost', 'Delete', remove)),
      res);
  }
  list();
  return el;
}

function targetForm(cfg, target, onCancel, onSaved) {
  const API_FIELD = {
    id: 'tg-id', name: 'tg-name', host: 'tg-host', port: 'tg-port', username: 'tg-username', password: 'tg-password', private_key_path: 'tg-key',
    host_key_policy: 'tg-policy', docker_cmd: 'tg-docker', packages_dir: 'tg-packages', backup_dir: 'tg-backup',
    'registry.url': 'tg-reg-url', 'registry.username': 'tg-reg-user', 'registry.password': 'tg-reg-password',
  };
  const isNew = !target;
  const t0 = target || {id: '', name: '', host: '', port: 22, username: '', has_password: false, private_key_path: '', host_key_policy: 'auto_add',
    docker_cmd: 'docker', packages_dir: '', backup_dir: '', extra_nodes: []};
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
    packages: input({placeholder: '/home/deploy/releases', value: t0.packages_dir}, true),
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
    private_key_path: f.key.value.trim(), host_key_policy: f.policy.value, docker_cmd: f.docker.value, packages_dir: f.packages.value.trim(), backup_dir: f.backup.value.trim()});
  const nv = () => nodes.map(n => ({host: n.host.trim(), port: Number(n.port), username: n.username.trim(), private_key_path: n.private_key_path.trim(), pw: n.pw}));
  const st = errState(() => {
    const x = v(), e = {};
    if (isNew) e['tg-id'] = RX.tid.test(x.id) ? (cfg.targets.some(t => t.id === x.id) ? 'This id is already used.' : null) : 'Use lowercase letters, numbers and - (max 32).';
    e['tg-host'] = hostErr(x.host);
    e['tg-port'] = portErr(x.port);
    e['tg-username'] = userErr(x.username);
    e['tg-packages'] = pathErr(x.packages_dir);
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
      gridRow({id: 'tg-packages', label: 'Packages folder', help: 'Full path where the new image zips arrive, e.g. /home/deploy/releases.'}, f.packages),
      gridRow({id: 'tg-backup', label: 'Backup dir', help: 'Full path, e.g. /home/deploy/sd-backups. Backups go here; deploys use .work inside it for a moment.'}, f.backup),
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
