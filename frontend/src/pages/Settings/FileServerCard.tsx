import {useState, type KeyboardEvent, type ReactNode} from 'react';
import {Alert, Button, ErrorText, FieldControl, Input, PasswordInput, confirm, errDetail, toast} from '@devtools/ui';
import {configApi} from '../../api/endpoints';
import {GridRow, TestRes} from '../../components/GridRow';
import {detailField, firstErr, hostErr, pathErr, portErr, userErr} from '../../lib/validate';
import type {Config, FileServer, FileServerIn} from '../../types/api';

const API_FIELD: Record<string, string> = {
  host: 'fs-host', port: 'fs-port', username: 'fs-username', password: 'fs-password', private_key_path: 'fs-key', remote_dir: 'fs-dir',
};
const formOf = (c: FileServer) => ({host: c.host, port: String(c.port), username: c.username, private_key_path: c.private_key_path, remote_dir: c.remote_dir});

/** SFTP server where Build Packager uploads the zips (read-only for Swarm Deployer). Test uses the typed values without saving. */
export function FileServerCard({cfg, onSaved}: {cfg: Config; onSaved: (fs: FileServer) => void}) {
  const saved = cfg.file_server;
  const [f, setF] = useState(() => formOf(saved));
  const [pw, setPw] = useState('');
  const [tried, setTried] = useState(false);
  const [needHost, setNeedHost] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [res, setRes] = useState<ReactNode>(null);
  const [apiErr, setApiErr] = useState<{field: string; msg: string} | null>(null);

  const v = {host: f.host.trim(), port: Number(f.port), username: f.username.trim(), private_key_path: f.private_key_path.trim(), remote_dir: f.remote_dir.trim()};
  const validate = (nh: boolean) => ({
    'fs-host': v.host ? hostErr(v.host) : nh ? 'Enter a host.' : null,
    'fs-port': portErr(v.port),
    'fs-username': userErr(v.username, true),
    'fs-dir': pathErr(v.remote_dir),
  });
  const errs: Record<string, string | null> = tried ? validate(needHost) : {};
  if (apiErr) errs[apiErr.field] = apiErr.msg;
  const set = (patch: Partial<typeof f>) => { setF(x => ({...x, ...patch})); setApiErr(null); setNeedHost(false); };
  const payload = (): FileServerIn => (pw ? {...v, password: pw} : {...v});

  const showApiErr = (d: string) => {
    const id = detailField(d, pre => API_FIELD[pre]);
    if (id) { setApiErr({field: id, msg: d}); setRes(null); setTimeout(() => document.getElementById(id)?.focus(), 0); }
    else setRes(<div style={{marginTop: 'var(--s3)'}}><Alert kind="error"><span>{d}</span></Alert></div>);
  };
  const save = async () => {
    setTried(true); setNeedHost(false); setRes(null);
    const bad = firstErr(validate(false));
    if (bad) { document.getElementById(bad)?.focus(); return; }
    setBusy('save');
    try {
      const r = await configApi.putFileServer(payload());
      setBusy(null); setPw(''); setF(formOf(r)); onSaved(r);
      setRes(<TestRes ok msg="Saved." />);
    } catch (e) { setBusy(null); showApiErr(errDetail(e).detail); }
  };
  const test = async () => {
    setTried(true); setNeedHost(true); setRes(null);
    const bad = firstErr(validate(true));
    if (bad) { document.getElementById(bad)?.focus(); return; }
    setBusy('test');
    try { const r = await configApi.testFileServer(payload()); setRes(<TestRes ok={r.ok} msg={r.message} />); }
    catch (e) { setRes(<TestRes ok={false} msg={errDetail(e).detail} />); }
    finally { setBusy(null); }
  };
  const removePw = async () => {
    if (!(await confirm({title: 'Remove the saved password?', body: 'The file server will be used with the private key only, or fail if it needs a password.', confirm: 'Remove password'}))) return;
    try { const r = await configApi.putFileServer({password: ''}); onSaved(r); toast('Saved password removed', 'success'); }
    catch (e) { toast(errDetail(e).detail, 'error'); }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const t = e.target as HTMLInputElement;
    if (e.key === 'Enter' && t.tagName === 'INPUT' && t.type !== 'radio') { e.preventDefault(); void save(); }
  };

  return (
    <section className="card" id="file-server" aria-labelledby="fs-h" onKeyDown={onKeyDown}>
      <div className="card-head"><h2 id="fs-h">File server (SFTP)</h2></div>
      <p className="help" style={{margin: 'calc(-1 * var(--s3)) 0 var(--s4)'}}>Where Build Packager uploads the zips. Swarm Deployer only reads from it.</p>
      <div className="form-grid">
        <label className="lbl" htmlFor="fs-host">Host and port</label>
        <div className="ctl">
          <div className="hostport">
            <div className="ctl">
              <FieldControl id="fs-host" error={errs['fs-host']}><Input value={f.host} placeholder="files.example.com" onChange={e => set({host: e.target.value})} /></FieldControl>
              <ErrorText id="fs-host-err" msg={errs['fs-host']} />
            </div>
            <div className="ctl">
              <FieldControl id="fs-port" error={errs['fs-port']}>
                <Input type="number" min="1" max="65535" inputMode="numeric" aria-label="Port" value={f.port}
                  onChange={e => set({port: e.target.value})} />
              </FieldControl>
              <ErrorText id="fs-port-err" msg={errs['fs-port']} />
            </div>
          </div>
        </div>
        <GridRow id="fs-username" label="Username" error={errs['fs-username']}>
          <Input value={f.username} placeholder="deploy" onChange={e => set({username: e.target.value})} />
        </GridRow>
        <GridRow id="fs-password" label="Password" error={errs['fs-password']}
          extra={saved.has_password ? <button className="link" type="button" style={{alignSelf: 'flex-start', fontSize: 13}} onClick={removePw}>Remove saved password</button> : null}>
          <PasswordInput autoComplete="new-password" data-secret="1" placeholder={saved.has_password ? '(saved) · leave blank to keep' : ''} value={pw}
            onChange={e => { setPw(e.target.value); setApiErr(null); }} />
        </GridRow>
        <GridRow id="fs-key" label="Private key" help="Optional. Used instead of, or with, the password." error={errs['fs-key']}>
          <Input mono value={f.private_key_path} placeholder="~/.ssh/id_ed25519" onChange={e => set({private_key_path: e.target.value})} />
        </GridRow>
        <GridRow id="fs-dir" label="Remote folder" error={errs['fs-dir']}
          help="The folder the package list opens in, e.g. /releases.">
          <Input mono value={f.remote_dir} placeholder="/releases" onChange={e => set({remote_dir: e.target.value})} />
        </GridRow>
      </div>
      <div className="wfoot">
        <Button variant="secondary" busy={busy === 'test' ? 'Testing… (up to 20s)' : null} onClick={test}>Test connection</Button>
        <span className="spacer" />
        <Button variant="primary" busy={busy === 'save' ? 'Saving…' : null} onClick={save}>Save</Button>
      </div>
      <div aria-live="polite">{res}</div>
    </section>
  );
}
