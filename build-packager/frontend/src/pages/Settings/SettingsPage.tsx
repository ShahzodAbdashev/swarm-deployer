import {useEffect, useRef, useState, type KeyboardEvent, type ReactNode} from 'react';
import {Alert, Button, ErrorText, Field, FieldControl, Icon, Input, PasswordInput, SegmentedControl, Skeleton, StepHead, Switch, Textarea,
  confirm, copyText, errDetail, sget, toast} from '@devtools/ui';
import {GITLAB_START, authApi, configApi, uploadApi} from '../../api/endpoints';
import {remotePathErr} from '../../lib/validate';
import {focusH1, router, setTitle} from '../../router';
import {setAuth, useAuth} from '../../state/session';
import type {EnvImportResult, GitlabConfig, Protocol, UploadConfig, UploadConfigIn, UploadTestResult} from '../../types/api';

const PORTS: Record<Protocol, string> = {sftp: '22', ftp: '21', ftps: '21', smb: '445'};

interface Form {
  enabled: boolean; protocol: Protocol; host: string; port: string; username: string; private_key_path: string; remote_dir: string;
  share: string; domain: string;
}
const formOf = (c: UploadConfig): Form => ({
  enabled: !!c.enabled, protocol: c.protocol, host: c.host, port: String(c.port), username: c.username,
  private_key_path: c.private_key_path, remote_dir: c.remote_dir, share: c.share || '', domain: c.domain || '',
});
const valuesOf = (f: Form) => ({
  enabled: f.enabled, protocol: f.protocol, host: f.host.trim(), port: Number(f.port), username: f.username.trim(),
  private_key_path: f.private_key_path.trim(), remote_dir: f.remote_dir.trim(), share: f.share.trim(), domain: f.domain.trim(),
});

const refreshAuth = () => authApi.status().then(setAuth).catch(() => { /* keep the current auth */ });

/** Upload server (FileZilla-style site): protocol, host, credentials, remote path; test before or after saving. */
export function SettingsPage() {
  const [ret] = useState(() => sget('bp.return'));
  const [saved, setSaved] = useState<UploadConfig | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => { setTitle('Upload server'); focusH1(); }, []);
  useEffect(() => {
    setLoadErr(null);
    uploadApi.get().then(setSaved).catch(e => setLoadErr("Couldn't load settings. " + errDetail(e).detail));
  }, [reload]);

  return (
    <div className="wrap">
      <a className="back-link" href={ret || '#/dashboard'}><Icon name="chevron-left" />{ret ? 'Back to build' : 'Dashboard'}</a>
      <StepHead title="Upload server" sub={<p className="sub">Where finished zips are sent, like FileZilla's Site Manager.</p>} />
      <div>
        {loadErr
          ? <Alert kind="error"><span>{loadErr}</span><div><Button variant="ghost" onClick={() => setReload(r => r + 1)}>Retry</Button></div></Alert>
          : saved ? <UploadForm saved={saved} onSaved={setSaved} />
            : <div className="stack">{[0, 1, 2, 3, 4].map(i => <Skeleton key={i} w="100%" h={36} />)}</div>}
      </div>
      <GitlabSection key={'gl' + reload} />
      <EnvImport onDone={() => { setSaved(null); setReload(r => r + 1); void refreshAuth(); }} />
    </div>
  );
}

/** This app's OAuth callback; GitLab only accepts the exact registered URI, and the backend uses 127.0.0.1. */
const redirectUri = () => location.origin.replace('//localhost', '//127.0.0.1') + GITLAB_START.replace(/start$/, 'callback');

/** GitLab URL / sign-in state and the OAuth application (id + secret). */
function GitlabSection() {
  const auth = useAuth();
  const [cfg, setCfg] = useState<GitlabConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [id, setId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    configApi.getGitlab().then(c => { setCfg(c); setId(c.client_id || ''); }).catch(e => setErr("Couldn't load GitLab settings. " + errDetail(e).detail));
  }, []);
  const save = async () => {
    setBusy(true);
    try {
      const c = await configApi.putGitlab({client_id: id.trim(), ...(secret ? {client_secret: secret} : {})});
      setCfg(c); setId(c.client_id || ''); setSecret('');
      toast('GitLab settings saved', 'success');
      void refreshAuth();
    } catch (e) { toast(errDetail(e).detail, 'error'); } finally { setBusy(false); }
  };
  const gl = auth?.gitlab;
  const who = gl?.logged_in ? 'signed in as @' + (gl.login || '') + ' (' + (gl.method === 'oauth' ? 'OAuth' : 'token') + ')' : 'not signed in';
  const uri = redirectUri();
  return (
    <section id="gitlab-cfg" className="cfg-sec">
      <h2>GitLab</h2>
      {err ? <Alert kind="error"><span>{err}</span></Alert> : null}
      <p id="gl-cfg-url">{'GitLab: ' + (cfg?.url || gl?.url || '…') + ' · ' + who}</p>
      <Field id="gl-client-id" label="OAuth application ID" help={cfg?.client_id_source === 'env' ? 'From the GITLAB_CLIENT_ID environment variable.' : undefined}>
        <Input mono value={id} onChange={e => setId(e.target.value)} />
      </Field>
      <Field id="gl-client-secret" label="OAuth application secret">
        <PasswordInput data-secret="1" autoComplete="new-password" placeholder={cfg?.has_client_secret ? '(saved) · leave blank to keep' : ''}
          value={secret} onChange={e => setSecret(e.target.value)} />
      </Field>
      <p className="help">Register one application in GitLab for both tools: redirect URIs http://127.0.0.1:8090/api/auth/gitlab/callback and http://127.0.0.1:8095/api/auth/gitlab/callback, scope api, Confidential off (PKCE).</p>
      <div className="redirect">
        <span className="mono" id="gl-redirect">{uri}</span>
        <Button variant="ghost" aria-label="Copy redirect URI" onClick={async () => { if (await copyText(uri)) toast('Redirect URI copied'); }}><Icon name="copy" />Copy</Button>
      </div>
      <div><Button variant="secondary" busy={busy ? 'Saving…' : null} disabled={!cfg} onClick={save}>Save GitLab settings</Button></div>
    </section>
  );
}

/** Fill upload + GitLab settings from a .env file; the server answers with key names only. */
function EnvImport({onDone}: {onDone: () => void}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<EnvImportResult | {fail: string} | null>(null);
  const run = async () => {
    setRes(null);
    if (!text.trim()) { setRes({fail: 'Choose a .env file or paste its content first.'}); return; }
    setBusy(true);
    try {
      const r = await configApi.importEnv(text);
      setRes(r);
      setText('');
      onDone();
    } catch (e) { setRes({fail: errDetail(e).detail}); } finally { setBusy(false); }
  };
  return (
    <section id="env-import" className="cfg-sec">
      <h2>Import .env</h2>
      <p className="help">Fills these settings from a .env file. Values are never shown back.</p>
      <Field id="env-import-file" label=".env file">
        <input type="file" id="env-import-file" accept=".env,text/plain" onChange={async e => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }} />
      </Field>
      <Field id="env-import-text" label="Or paste it">
        <Textarea rows={5} className="mono" data-secret="1" placeholder={'GITLAB_URL=…\nFILE_SERVER_HOST=…'} value={text} onChange={e => setText(e.target.value)} />
      </Field>
      <div><Button variant="secondary" busy={busy ? 'Importing…' : null} onClick={run}>Import .env</Button></div>
      <div id="env-import-res" aria-live="polite">
        {res && 'fail' in res ? <div className="test-res bad"><Icon name="x" /><span>{res.fail}</span></div> : null}
        {res && 'set' in res ? <>
          <div className="test-res ok"><Icon name="check" /><span>{'Set: ' + (res.set.join(', ') || 'nothing')}</span></div>
          {res.ignored.length ? <p className="help">{'Ignored: ' + res.ignored.join(', ')}</p> : null}
          {res.errors.map((x, i) => <div className="test-res bad" key={i}><Icon name="x" /><span>{x}</span></div>)}
        </> : null}
      </div>
    </section>
  );
}

function UploadForm({saved, onSaved}: {saved: UploadConfig; onSaved: (c: UploadConfig) => void}) {
  const [f, setF] = useState<Form>(() => formOf(saved));
  const [pw, setPw] = useState('');
  const [tried, setTried] = useState(false);
  const [portEdited, setPortEdited] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [testRes, setTestRes] = useState<{ok: boolean; msg: string} | null>(null);
  const [apiErr, setApiErr] = useState<{field: string; msg: string} | null>(null);
  const [hostTestErr, setHostTestErr] = useState(false);

  const v = valuesOf(f);
  const dirty = pw !== '' || (Object.keys(v) as (keyof typeof v)[]).some(k => v[k] !== (saved as unknown as Record<string, unknown>)[k]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    router.setLeaveGuard(() => dirtyRef.current
      ? {title: 'Discard unsaved changes?', body: 'Your changes to the upload server will be lost.', cancel: 'Keep editing', confirm: 'Discard'} : null);
    return () => router.setLeaveGuard(null);
  }, []);

  const errors = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (v.enabled && !v.host) e.host = 'Enter a host to enable uploads.';
    if (!Number.isInteger(v.port) || v.port < 1 || v.port > 65535) e.port = 'Port must be 1–65535.';
    const rp = remotePathErr(v.remote_dir);
    if (rp) e.remote_dir = rp;
    if (v.protocol === 'smb' && v.host && !v.share) e.share = 'Enter the share name, e.g. releases.';
    return e;
  };
  const errs: Record<string, string> = tried ? errors() : {};
  if (hostTestErr && !v.host) errs.host = 'Enter a host to test.';
  if (apiErr) errs[apiErr.field] = apiErr.msg;
  const order = ['host', 'port', 'share', 'remote_dir'];
  const focusFirst = (e: Record<string, string>) => { const k = order.find(x => e[x]); if (k) document.getElementById(k)?.focus(); return !!k; };

  const set = (patch: Partial<Form>) => { setF(x => ({...x, ...patch})); setApiErr(null); setHostTestErr(false); };

  const save = async () => {
    setTried(true);
    if (focusFirst(errors())) return;
    const payload: UploadConfigIn = {...v};
    // first host ever saved with the switch untouched: turn uploads on, otherwise the wizard says "not set up"
    if (!saved.enabled && !saved.host && payload.host && !payload.enabled) payload.enabled = true;
    if (pw) payload.password = pw;
    setBusy('save');
    try {
      const c = await uploadApi.put(payload);
      setPw('');
      toast('Settings saved', 'success');
      setF(formOf(c));
      onSaved(c);
    } catch (e) {
      const {detail} = errDetail(e);
      const m = /^(\w+):/.exec(detail);
      const id = m && ({protocol: 'host', password: 'up-password'}[m[1]] || m[1]);
      if (id && document.getElementById(id + '-err')) { setApiErr({field: id, msg: detail}); document.getElementById(id)?.focus(); } else toast(detail, 'error');
    } finally { setBusy(null); }
  };

  const test = async () => {
    setTestRes(null);
    setTried(true);
    const e = errors();
    if (!v.host) { setHostTestErr(true); e.host = 'Enter a host to test.'; }
    if (focusFirst(e)) return;
    setBusy('test');
    try {
      const payload: UploadConfigIn = {...v};
      if (pw) payload.password = pw;
      const r: UploadTestResult = await uploadApi.test(payload);
      setTestRes({ok: r.ok, msg: r.message});
    } catch (err) {
      const {status, detail} = errDetail(err);
      setTestRes({ok: false, msg: status === 400 ? 'Enter a host first.' : detail});
    } finally { setBusy(null); }
  };

  const removePw = async () => {
    if (!(await confirm({title: 'Remove the saved password?', body: 'Uploads will use the private key only, or fail if the server needs a password.', confirm: 'Remove password'}))) return;
    try { const c = await uploadApi.put({password: ''}); toast('Saved password removed', 'success'); onSaved(c); } catch (e) { toast(errDetail(e).detail, 'error'); }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLInputElement;
    if (e.key === 'Enter' && t.tagName === 'INPUT' && t.type !== 'radio') { e.preventDefault(); void save(); }
  };

  const dir = v.remote_dir ? (v.remote_dir.startsWith('/') ? v.remote_dir : '/' + v.remote_dir) : '/';
  const smb = v.protocol === 'smb';
  const base = v.protocol + '://' + (v.username ? v.username + '@' : '') + (v.host || 'host') + ':' + (v.port || '?')
    + (smb ? '/' + (v.share || 'share') : '') + dir.replace(/\/$/, '');
  const sftp = v.protocol === 'sftp';
  const ctl = (id: string, input: ReactNode, help?: string) => (
    <FieldControl id={id} help={!!help} error={errs[id]}>
      <div className="ctl">{input}{help ? <p className="help" id={id + '-help'}>{help}</p> : null}<ErrorText id={id + '-err'} msg={errs[id]} /></div>
    </FieldControl>
  );
  return (
    <div onKeyDown={onKeyDown}>
      <div className="switch-row">
        <div style={{flex: 1}}>
          <div id="sw-l" style={{fontWeight: 500}}>Upload after each build</div>
          <p className="help" hidden={v.enabled}>Uploads are off. Your settings are kept.</p>
        </div>
        <Switch id="enabled" checked={f.enabled} labelledBy="sw-l" onChange={enabled => set({enabled})} />
      </div>
      <div className="form-grid">
        <span className="lbl" id="proto-l">Protocol</span>
        <div className="ctl">
          <SegmentedControl name="protocol" labelledBy="proto-l" value={f.protocol}
            options={(['sftp', 'ftp', 'ftps', 'smb'] as Protocol[]).map(p => ({value: p, label: p.toUpperCase()}))}
            onChange={p => set({protocol: p, ...(portEdited ? {} : {port: PORTS[p]})})} />
          <div className="alert warning" hidden={v.protocol !== 'ftp'}><Icon name="alert" /><div className="body">FTP sends your password unencrypted. Prefer SFTP or FTPS.</div></div>
        </div>
        <label className="lbl" htmlFor="host">Host and port</label>
        <div className="ctl">
          <div className="hostport">
            {ctl('host', <Input value={f.host} placeholder="files.example.com" onChange={e => set({host: e.target.value})} />)}
            {ctl('port', <Input type="number" min={1} max={65535} inputMode="numeric" aria-label="Port" value={f.port}
              onChange={e => { setPortEdited(true); set({port: e.target.value}); }} />)}
          </div>
        </div>
        <label className="lbl" htmlFor="username">Username</label>
        {ctl('username', <Input value={f.username} placeholder="deploy" onChange={e => set({username: e.target.value})} />)}
        <label className="lbl" htmlFor="up-password">Password</label>
        <FieldControl id="up-password" error={errs['up-password']}>
          <div className="ctl">
            <PasswordInput data-secret="1" autoComplete="new-password" placeholder={saved.has_password ? 'Saved · leave blank to keep' : ''} value={pw}
              onChange={e => { setPw(e.target.value); setApiErr(null); }} />
            {saved.has_password ? <button className="link" type="button" style={{alignSelf: 'flex-start', fontSize: 13}} onClick={removePw}>Remove saved password</button> : null}
            <ErrorText id="up-password-err" msg={errs['up-password']} />
          </div>
        </FieldControl>
        <label className="lbl" htmlFor="private_key_path" hidden={!sftp}>Private key</label>
        <div hidden={!sftp} style={{display: 'contents'}}>
          {ctl('private_key_path', <Input mono value={f.private_key_path} placeholder="~/.ssh/id_ed25519" onChange={e => set({private_key_path: e.target.value})} />,
            'Optional. Used instead of, or with, the password.')}
        </div>
        <label className="lbl" htmlFor="share" hidden={!smb}>Share</label>
        <div hidden={!smb} style={{display: 'contents'}}>
          {ctl('share', <Input value={f.share} placeholder="releases" onChange={e => set({share: e.target.value})} />, 'Share name on the server, e.g. releases')}
        </div>
        <label className="lbl" htmlFor="domain" hidden={!smb}>Domain</label>
        <div hidden={!smb} style={{display: 'contents'}}>
          {ctl('domain', <Input value={f.domain} placeholder="" onChange={e => set({domain: e.target.value})} />, 'Leave empty unless your server needs DOMAIN\\user')}
        </div>
        <label className="lbl" htmlFor="remote_dir">Remote path</label>
        {ctl('remote_dir', <Input mono value={f.remote_dir} placeholder={smb ? '/builds' : '/home/deploy/releases'} onChange={e => set({remote_dir: e.target.value})} />,
          smb ? 'Folder inside the share, e.g. /builds' : 'Full path on the server, e.g. /home/deploy/releases. Missing folders are created.')}
      </div>
      <div style={{marginTop: 'var(--s5)'}}><p className="preview" aria-live="polite">{'Uploads as ' + base + '/<service>_<timestamp>.zip'}</p></div>
      <div className="wfoot">
        <Button variant="secondary" busy={busy === 'test' ? 'Testing… (up to 15s)' : null} onClick={test}>Test connection</Button>
        <span className="spacer" />
        <Button variant="primary" busy={busy === 'save' ? 'Saving…' : null} onClick={save}>Save</Button>
      </div>
      <p className="help" style={{marginTop: 'var(--s2)'}} hidden={!dirty}>Tests what you typed. Save to keep it.</p>
      <div aria-live="polite">
        {testRes ? <div className={'test-res ' + (testRes.ok ? 'ok' : 'bad')}><Icon name={testRes.ok ? 'check' : 'x'} /><span>{testRes.msg}</span></div> : null}
      </div>
    </div>
  );
}
