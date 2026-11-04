import {useEffect, useRef, useState, type KeyboardEvent, type ReactNode} from 'react';
import {Alert, Button, ErrorText, Field, FieldControl, Icon, Input, PasswordInput, Select, confirm, errDetail, toast} from '@devtools/ui';
import {targetsApi} from '../../api/endpoints';
import {GridRow, TestRes} from '../../components/GridRow';
import {targetLabel} from '../../lib/format';
import {RX, detailField, firstErr, hostErr, pathErr, portErr, userErr} from '../../lib/validate';
import type {Config, Target, TargetIn} from '../../types/api';

/** Docker Swarm managers reached over SSH: list with Test / Edit / Delete, or the add/edit form. */
export function TargetsCard({cfg, onChange}: {cfg: Config; onChange: (targets: Target[]) => void}) {
  const [editing, setEditing] = useState<string | null>(null); // null | 'new' | target id
  const [results, setResults] = useState<Record<string, ReactNode>>({});
  const [testing, setTesting] = useState<string | null>(null);

  const head = (
    <div className="card-head">
      <h2 id="tg-h">Target servers</h2>
      {editing ? null : <Button variant="secondary" onClick={() => setEditing('new')}><Icon name="plus" />Add target</Button>}
    </div>
  );
  const help = <p className="help" style={{margin: 'calc(-1 * var(--s3)) 0 var(--s4)'}}>Docker Swarm managers Swarm Deployer signs in to over SSH. Every docker command runs there.</p>;

  if (editing) {
    const t = editing === 'new' ? null : cfg.targets.find(x => x.id === editing) || null;
    return (
      <section className="card" id="targets" aria-labelledby="tg-h">
        {head}{help}
        <TargetForm cfg={cfg} target={t} onCancel={() => setEditing(null)}
          onSaved={r => { onChange(t ? cfg.targets.map(x => (x.id === r.id ? r : x)) : [...cfg.targets, r]); setEditing(null); }} />
      </section>
    );
  }

  const test = async (t: Target) => {
    setResults(r => ({...r, [t.id]: null}));
    setTesting(t.id);
    try {
      const r = await targetsApi.test(t.id);
      setResults(x => ({...x, [t.id]: <TestRes ok={r.ok} msg={r.message + (r.ok && r.host_key ? ' · ' + r.host_key : '')} />}));
    } catch (e) { setResults(x => ({...x, [t.id]: <TestRes ok={false} msg={errDetail(e).detail} />})); }
    finally { setTesting(null); }
  };
  const remove = async (t: Target) => {
    if (!(await confirm({title: 'Delete target ' + (t.name || t.id) + '?', body: 'Only the saved connection is removed. Nothing on the server is touched.', confirm: 'Delete target'}))) return;
    try { await targetsApi.remove(t.id); onChange(cfg.targets.filter(x => x.id !== t.id)); toast('Target deleted', 'success'); }
    catch (e) {
      const {detail} = errDetail(e);
      setResults(x => ({...x, [t.id]: <TestRes ok={false} msg={detail} />}));
    }
  };
  return (
    <section className="card" id="targets" aria-labelledby="tg-h">
      {head}{help}
      <div className="list">
        {cfg.targets.length ? cfg.targets.map(t => {
          const nodes = (t.extra_nodes || []).length;
          return (
            <div className="lrow" key={t.id}>
              <div className="main">
                <span><b style={{fontWeight: 500}}>{t.name || t.id}</b><span className="muted mono">{' · ' + t.id}</span></span>
                <span className="mono muted">{targetLabel(t) + ' · ' + t.docker_cmd + ' · host key ' + t.host_key_policy + (nodes ? ' · ' + nodes + ' extra node' + (nodes > 1 ? 's' : '') : '') + (t.registry?.url ? ' · registry ' + t.registry.url : '')}</span>
              </div>
              <div className="acts">
                <Button variant="secondary" busy={testing === t.id ? 'Testing…' : null} onClick={() => test(t)}>Test</Button>
                <Button variant="ghost" onClick={() => setEditing(t.id)}>Edit</Button>
                <Button variant="ghost" onClick={() => remove(t)}>Delete</Button>
              </div>
              <div className="res" aria-live="polite">{results[t.id]}</div>
            </div>
          );
        }) : <p className="list-empty">No target servers yet.</p>}
      </div>
    </section>
  );
}

interface NodeForm { host: string; port: string; username: string; private_key_path: string; has_password: boolean; pw: string; key: number }
const API_FIELD: Record<string, string> = {
  id: 'tg-id', name: 'tg-name', host: 'tg-host', port: 'tg-port', username: 'tg-username', password: 'tg-password', private_key_path: 'tg-key',
  host_key_policy: 'tg-policy', docker_cmd: 'tg-docker', work_dir: 'tg-work', backup_dir: 'tg-backup',
  'registry.url': 'tg-reg-url', 'registry.username': 'tg-reg-user', 'registry.password': 'tg-reg-password',
};

function TargetForm({cfg, target, onSaved, onCancel}: {cfg: Config; target: Target | null; onSaved: (t: Target) => void; onCancel: () => void}) {
  const isNew = !target;
  const t0 = target || {id: '', name: '', host: '', port: 22, username: '', has_password: false, private_key_path: '', host_key_policy: 'auto_add',
    docker_cmd: 'docker', work_dir: '', backup_dir: '', extra_nodes: [], registry: undefined};
  const reg0 = t0.registry || {url: '', username: '', has_password: false};
  const [reg, setReg] = useState({url: reg0.url, username: reg0.username});
  const [regPw, setRegPw] = useState('');
  const [f, setF] = useState({id: t0.id, name: t0.name, host: t0.host, port: String(t0.port), username: t0.username, private_key_path: t0.private_key_path,
    host_key_policy: t0.host_key_policy as string, docker_cmd: t0.docker_cmd, work_dir: t0.work_dir, backup_dir: t0.backup_dir});
  const [pw, setPw] = useState('');
  const nodeKey = useRef(0);
  const [nodes, setNodes] = useState<NodeForm[]>(() => (t0.extra_nodes || []).map(n => ({host: n.host, port: String(n.port), username: n.username,
    private_key_path: n.private_key_path || '', has_password: !!n.has_password, pw: '', key: nodeKey.current++})));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [apiErr, setApiErr] = useState<{field: string; msg: string} | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [focusNode, setFocusNode] = useState<number | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const addN = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  useEffect(() => { if (focusNode !== null) { document.getElementById('tg-node-host-' + focusNode)?.focus(); setFocusNode(null); } }, [focusNode]);

  const v = {id: f.id.trim(), name: f.name.trim(), host: f.host.trim(), port: Number(f.port), username: f.username.trim(), private_key_path: f.private_key_path.trim(),
    host_key_policy: f.host_key_policy, docker_cmd: f.docker_cmd, work_dir: f.work_dir.trim(), backup_dir: f.backup_dir.trim()};
  const nv = nodes.map(n => ({host: n.host.trim(), port: Number(n.port), username: n.username.trim(), private_key_path: n.private_key_path.trim(), pw: n.pw}));
  const validate = () => {
    const e: Record<string, string | null> = {};
    if (isNew) e['tg-id'] = RX.tid.test(v.id) ? (cfg.targets.some(x => x.id === v.id) ? 'This id is already used.' : null) : 'Use lowercase letters, numbers and - (max 32).';
    e['tg-host'] = hostErr(v.host);
    e['tg-port'] = portErr(v.port);
    e['tg-username'] = userErr(v.username);
    e['tg-work'] = pathErr(v.work_dir);
    e['tg-backup'] = pathErr(v.backup_dir);
    const ru = reg.url.trim(), rn = reg.username.trim();
    e['tg-reg-url'] = !ru || (ru.length <= 253 && RX.reg.test(ru)) ? null : 'Host and port only, like 192.192.192.175:5050.';
    e['tg-reg-user'] = !ru || rn ? (rn && !/^[A-Za-z0-9_.@+-]{1,128}$/.test(rn) ? 'Use letters, numbers, _ . @ + - (max 128).' : null) : 'Enter the registry user.';
    nv.forEach((n, i) => {
      e['tg-node-host-' + i] = hostErr(n.host);
      e['tg-node-port-' + i] = portErr(n.port);
      e['tg-node-username-' + i] = userErr(n.username);
    });
    return e;
  };
  const errs: Record<string, string | null> = tried ? validate() : {};
  if (apiErr) errs[apiErr.field] = apiErr.msg;
  const set = (patch: Partial<typeof f>) => { setF(x => ({...x, ...patch})); setApiErr(null); };
  const setNode = (i: number, patch: Partial<NodeForm>) => { setNodes(ns => ns.map((n, j) => (j === i ? {...n, ...patch} : n))); setApiErr(null); };

  const save = async () => {
    setTried(true); setAlert(null);
    const bad = firstErr(validate());
    if (bad) { document.getElementById(bad)?.focus(); return; }
    const body: TargetIn = {...v, extra_nodes: nv.map(n => {
      const o: {host: string; port: number; username: string; private_key_path: string; password?: string} = {host: n.host, port: n.port, username: n.username, private_key_path: n.private_key_path};
      if (n.pw) o.password = n.pw;
      return o;
    })};
    if (pw) body.password = pw;
    body.registry = {url: reg.url.trim(), username: reg.username.trim()};
    if (regPw) body.registry.password = regPw;
    if (!body.name) body.name = v.id;
    setBusy(true);
    try {
      let r: Target;
      if (isNew) r = await targetsApi.create(body);
      else { const {id: id0, ...rest} = body; r = await targetsApi.update(id0 || t0.id, rest); }
      body.password = ''; body.extra_nodes = []; body.registry = undefined;
      setBusy(false); setPw(''); setRegPw('');
      toast('Target ' + (r.name || r.id) + ' saved', 'success');
      onSaved(r);
    } catch (e) {
      setBusy(false);
      const {status, detail} = errDetail(e);
      if (status === 409 && isNew) { setApiErr({field: 'tg-id', msg: detail}); first.current?.focus(); return; }
      const id = detailField(detail, pre => {
        const mm = /^extra_nodes\[(\d+)\]\.(\w+)/.exec(pre);
        if (mm) return 'tg-node-' + ({private_key_path: 'key'}[mm[2]] || mm[2]) + '-' + mm[1];
        return API_FIELD[pre];
      });
      if (id && document.getElementById(id + '-err')) { setApiErr({field: id, msg: detail}); setTimeout(() => document.getElementById(id)?.focus(), 0); }
      else setAlert(detail);
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); void save(); }
  };

  return (
    <div onKeyDown={onKeyDown}>
      <div className="form-grid">
        <GridRow id="tg-id" label="Id" help={isNew ? 'Lowercase letters, numbers and -. Deploy history refers to the target by this id.' : null} error={errs['tg-id']}>
          <Input mono ref={isNew ? first : undefined} value={f.id} placeholder="lab" disabled={!isNew} maxLength={32} onChange={e => set({id: e.target.value})} />
        </GridRow>
        <GridRow id="tg-name" label="Name" error={errs['tg-name']}>
          <Input ref={isNew ? undefined : first} value={f.name} placeholder="Lab swarm" onChange={e => set({name: e.target.value})} />
        </GridRow>
        <label className="lbl" htmlFor="tg-host">Host and port</label>
        <div className="ctl">
          <div className="hostport">
            <div className="ctl">
              <FieldControl id="tg-host" error={errs['tg-host']}><Input value={f.host} placeholder="10.0.0.5" onChange={e => set({host: e.target.value})} /></FieldControl>
              <ErrorText id="tg-host-err" msg={errs['tg-host']} />
            </div>
            <div className="ctl">
              <FieldControl id="tg-port" error={errs['tg-port']}><Input type="number" min="1" max="65535" inputMode="numeric" aria-label="Port" value={f.port} onChange={e => set({port: e.target.value})} /></FieldControl>
              <ErrorText id="tg-port-err" msg={errs['tg-port']} />
            </div>
          </div>
        </div>
        <GridRow id="tg-username" label="Username" error={errs['tg-username']}>
          <Input value={f.username} placeholder="deploy" onChange={e => set({username: e.target.value})} />
        </GridRow>
        <GridRow id="tg-password" label="Password" help="Leave empty to use the private key or your SSH agent." error={errs['tg-password']}>
          <PasswordInput autoComplete="new-password" data-secret="1" placeholder={t0.has_password ? '(saved) · leave blank to keep' : ''} value={pw}
            onChange={e => { setPw(e.target.value); setApiErr(null); }} />
        </GridRow>
        <GridRow id="tg-key" label="Private key" error={errs['tg-key']}>
          <Input mono value={f.private_key_path} placeholder="~/.ssh/id_ed25519" onChange={e => set({private_key_path: e.target.value})} />
        </GridRow>
        <GridRow id="tg-policy" label="Host key policy" error={errs['tg-policy']}
          extra={f.host_key_policy === 'auto_add'
            ? <Alert kind="warning" icon="alert">Accepts any host key the first time. Fine for a lab, use 'reject' with known_hosts in production.</Alert> : null}>
          <Select value={f.host_key_policy} onChange={e => set({host_key_policy: e.target.value})}>
            <option value="auto_add">auto_add · accept and remember new keys</option>
            <option value="warn">warn · accept, log a warning</option>
            <option value="reject">reject · only known_hosts</option>
          </Select>
        </GridRow>
        <GridRow id="tg-docker" label="Docker command" error={errs['tg-docker']}>
          <Select value={f.docker_cmd} onChange={e => set({docker_cmd: e.target.value})}>
            <option value="docker">docker</option>
            <option value="sudo -n docker">sudo -n docker</option>
          </Select>
        </GridRow>
        <GridRow id="tg-work" label="Work dir" help="Where the image .tar is uploaded. Created if missing." error={errs['tg-work']}>
          <Input mono value={f.work_dir} placeholder="/home/deploy/sd-work" onChange={e => set({work_dir: e.target.value})} />
        </GridRow>
        <GridRow id="tg-backup" label="Backup dir" help="Service specs and backup metadata are kept here." error={errs['tg-backup']}>
          <Input mono value={f.backup_dir} placeholder="/home/deploy/sd-backups" onChange={e => set({backup_dir: e.target.value})} />
        </GridRow>
        <span className="lbl" />
        <div className="ctl"><h3 className="micro" style={{margin: 'var(--s3) 0 0'}}>Registry (optional)</h3></div>
        <GridRow id="tg-reg-url" label="Registry" error={errs['tg-reg-url']}
          help="Empty = no registry: the image is loaded on each node. With a registry, images under it are pushed and deployed by digest.">
          <Input mono value={reg.url} placeholder="192.192.192.175:5050" onChange={e => { setReg(r => ({...r, url: e.target.value})); setApiErr(null); }} />
        </GridRow>
        <GridRow id="tg-reg-user" label="Registry user" error={errs['tg-reg-user']}>
          <Input value={reg.username} onChange={e => { setReg(r => ({...r, username: e.target.value})); setApiErr(null); }} />
        </GridRow>
        <GridRow id="tg-reg-password" label="Registry password" error={errs['tg-reg-password']}>
          <PasswordInput autoComplete="new-password" data-secret="1" placeholder={reg0.has_password ? '(saved) · leave blank to keep' : ''} value={regPw}
            onChange={e => { setRegPw(e.target.value); setApiErr(null); }} />
        </GridRow>
        <span className="lbl">Extra nodes</span>
        <div className="ctl" id="tg-nodes">
          <p className="help">Other swarm nodes that need the image loaded locally. They never get service commands.</p>
          <div className="stack" style={{gap: 'var(--s3)'}}>
            {nodes.map((n, i) => (
              <div className="nrow" key={n.key}>
                <Field id={'tg-node-host-' + i} label="Host" error={errs['tg-node-host-' + i]}><Input value={n.host} placeholder="10.0.0.6" onChange={e => setNode(i, {host: e.target.value})} /></Field>
                <Field id={'tg-node-port-' + i} label="Port" error={errs['tg-node-port-' + i]}><Input type="number" min="1" max="65535" inputMode="numeric" value={n.port} onChange={e => setNode(i, {port: e.target.value})} /></Field>
                <Field id={'tg-node-username-' + i} label="Username" error={errs['tg-node-username-' + i]}><Input value={n.username} placeholder="deploy" onChange={e => setNode(i, {username: e.target.value})} /></Field>
                <Field id={'tg-node-password-' + i} label="Password" error={errs['tg-node-password-' + i]}>
                  <PasswordInput autoComplete="new-password" data-secret="1" placeholder={n.has_password ? '(saved)' : ''} value={n.pw} onChange={e => setNode(i, {pw: e.target.value})} />
                </Field>
                <Field id={'tg-node-key-' + i} label="Private key" error={errs['tg-node-key-' + i]}><Input mono value={n.private_key_path} placeholder="~/.ssh/id_ed25519" onChange={e => setNode(i, {private_key_path: e.target.value})} /></Field>
                <span />
                <button className="link rm" type="button" aria-label={'Remove node ' + (i + 1)} onClick={() => { setNodes(ns => ns.filter((_, j) => j !== i)); addN.current?.focus(); }}>Remove node</button>
              </div>
            ))}
          </div>
          <div>
            <button ref={addN} className="link" type="button" onClick={() => {
              setNodes(ns => [...ns, {host: '', port: '22', username: f.username.trim(), private_key_path: '', has_password: false, pw: '', key: nodeKey.current++}]);
              setFocusNode(nodes.length);
            }}><Icon name="plus" /> Add node</button>
          </div>
        </div>
      </div>
      <div>{alert ? <div style={{marginTop: 'var(--s3)'}}><Alert kind="error"><span>{alert}</span></Alert></div> : null}</div>
      <div className="wfoot">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <span className="spacer" />
        <Button variant="primary" busy={busy ? 'Saving…' : null} onClick={save}>{isNew ? 'Add target' : 'Save target'}</Button>
      </div>
    </div>
  );
}
