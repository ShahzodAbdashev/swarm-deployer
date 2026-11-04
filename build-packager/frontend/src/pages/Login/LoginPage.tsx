import {useEffect, useRef, useState, type ReactNode} from 'react';
import {Alert, Button, Field, Icon, Input, PasswordInput, errDetail, toast} from '@devtools/ui';
import {GITLAB_START, authApi} from '../../api/endpoints';
import {router, setTitle} from '../../router';
import {session, setAuth, useAuth} from '../../state/session';
import type {LoginResult} from '../../types/api';
import {DeviceFlow} from './DeviceFlow';

const errFor = (e: unknown) => {
  const {status, detail} = errDetail(e);
  return status === 401 ? 'GitHub rejected this token. It may be expired or revoked.'
    : status === 502 ? "Couldn't reach GitHub. Check your connection and try again." : detail;
};

const glErrFor = (e: unknown, url: string) => {
  const {status, detail} = errDetail(e);
  return status === 401 ? 'GitLab rejected this token. It may be expired or revoked.'
    : status === 502 ? "Couldn't reach GitLab at " + url + '. Check the URL and your network.' : detail;
};

/**
 * Sign-in screen. GitLab first (OAuth when configured, else an access token), then GitHub:
 * gh CLI, personal access token (collapsed), device flow when configured.
 */
export function LoginPage() {
  const auth = useAuth();
  const gl = auth?.gitlab;
  const oauth = !!gl?.oauth_available;
  const [error, setError] = useState<ReactNode>(() => (auth?.oauth_error ? <span>{auth.oauth_error}</span> : null));
  const [busy, setBusy] = useState<'gh' | 'pat' | 'gl' | 'glpat' | null>(null);
  const [glView, setGlView] = useState(false);
  const [glUrl, setGlUrl] = useState(gl?.url || '');
  const [glPat, setGlPat] = useState('');
  const [glPatErr, setGlPatErr] = useState<string | null>(null);
  const glRef = useRef<HTMLButtonElement>(null);
  const glPatRef = useRef<HTMLInputElement>(null);
  const [pat, setPat] = useState('');
  const [patErr, setPatErr] = useState<string | null>(null);
  const [device, setDevice] = useState(false);
  const details = useRef<HTMLDetailsElement>(null);
  const patRef = useRef<HTMLInputElement>(null);
  const ghRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setTitle('Sign in');
    (oauth ? glRef : ghRef).current?.focus();
    if (auth?.oauth_error) setAuth({oauth_error: null});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (glView) glPatRef.current?.focus(); }, [glView]);

  const glContinue = () => {
    setError(null);
    if (!oauth) { setGlView(true); return; }
    setBusy('gl');
    location.href = GITLAB_START;
  };

  const glBack = () => { setGlView(false); setError(null); setTimeout(() => glRef.current?.focus(), 0); };

  const glSubmit = async () => {
    const v = glPat.trim(), url = glUrl.trim();
    setGlPatErr(null);
    if (!v) { setGlPatErr('Paste a token first.'); glPatRef.current?.focus(); return; }
    setError(null);
    setBusy('glpat');
    try {
      await authApi.gitlabToken(v, url);
      // the token endpoint's response isn't the status shape: re-read it
      const st = await authApi.status();
      setAuth(st);
      setGlPat('');
      toast('Signed in as @' + (st.gitlab?.login || st.login || ''), 'success');
      const back = session.returnTo;
      session.returnTo = null;
      router.go(back && !back.startsWith('#/login') ? back : '#/dashboard');
    } catch (e) {
      setBusy(null);
      setError(<span>{glErrFor(e, url || gl?.url || '')}</span>);
      if (errDetail(e).status === 401) { setGlPat(''); glPatRef.current?.focus(); }
    }
  };

  const success = (d: LoginResult) => {
    setAuth({logged_in: true, login: d.login, avatar_url: d.avatar_url});
    setPat('');
    toast('Signed in as @' + d.login, 'success');
    const back = session.returnTo;
    session.returnTo = null;
    router.go(back && !back.startsWith('#/login') ? back : '#/dashboard');
  };

  const ghCli = async () => {
    setError(null);
    setBusy('gh');
    try { success(await authApi.ghCli()); }
    catch (e) {
      setBusy(null);
      if (errDetail(e).status === 400) {
        setError(<><b>gh CLI isn't installed or isn't signed in.</b><span>Run <code>gh auth login</code> in a terminal and try again, or use a token below.</span></>);
        if (details.current) details.current.open = true;
        setTimeout(() => patRef.current?.focus(), 0);
      } else setError(<span>{errFor(e)}</span>);
    }
  };

  const patSubmit = async () => {
    const v = pat.trim();
    setPatErr(null);
    if (!v) { setPatErr('Paste a token first.'); patRef.current?.focus(); return; }
    setError(null);
    setBusy('pat');
    try { success(await authApi.token(v)); }
    catch (e) {
      setBusy(null);
      setError(<span>{errFor(e)}</span>);
      if (errDetail(e).status === 401) { setPat(''); patRef.current?.focus(); }
    }
  };

  const locked = busy !== null;
  const live = <div aria-live="polite" hidden={!error}>{error ? <Alert kind="error">{error}</Alert> : null}</div>;
  const tokenView = (
    <form id="gl-token" className="pat" onSubmit={e => { e.preventDefault(); void glSubmit(); }}>
      <h2>Sign in to GitLab</h2>
      <Field id="gl-url" label="GitLab URL" help="Your self-hosted GitLab, e.g. http://192.168.33.175">
        <Input mono value={glUrl} disabled={locked} onChange={e => setGlUrl(e.target.value)} />
      </Field>
      <Field id="gl-pat" label="Personal access token" error={glPatErr} help="Needs read_api + read_repository (api to read CI/CD variables).">
        <PasswordInput ref={glPatRef} placeholder="glpat-…" data-secret="1" value={glPat} disabled={locked} onChange={e => setGlPat(e.target.value)} />
      </Field>
      <Button variant="primary" full type="submit" busy={busy === 'glpat' ? 'Signing in…' : null} disabled={locked}>Sign in with GitLab token</Button>
      <Button variant="ghost" full disabled={locked} onClick={glBack}>Back</Button>
      {live}
    </form>
  );
  const main = (
    <>
      <Button variant="primary" size="lg" full id="gl-continue" ref={glRef} busy={busy === 'gl' ? 'Opening GitLab…' : null} disabled={locked} onClick={glContinue}>
        <Icon name="gitlab" />Continue with GitLab
      </Button>
      <p className="meta" style={{marginTop: 'calc(-1 * var(--s2))'}}>
        {oauth ? 'Signs in at ' + (gl?.url || '') : 'Self-hosted GitLab at ' + (gl?.url || '') + ' · paste an access token'}
      </p>
      {oauth ? <Button variant="ghost" full id="gl-use-token" disabled={locked} onClick={() => { setError(null); setGlView(true); }}>Use a GitLab access token</Button> : null}
      <p className="or">or</p>
      <Button variant="github" size="lg" full ref={ghRef} busy={busy === 'gh' ? 'Checking gh CLI…' : null} disabled={locked} onClick={ghCli}>
        <Icon name="github" />Continue with GitHub
      </Button>
      <p className="meta" style={{marginTop: 'calc(-1 * var(--s2))'}}>Uses your local gh CLI sign-in</p>
      {auth?.device_flow_available
        ? <Button variant="secondary" size="lg" full disabled={locked} onClick={() => { setError(null); setDevice(true); }}>Sign in with a device code</Button>
        : null}
      <details ref={details}>
        <summary>Use a personal access token <Icon name="chevron-down" /></summary>
        <form className="pat" onSubmit={e => { e.preventDefault(); patSubmit(); }}>
          <Field id="pat" label="Personal access token" error={patErr}
            help={<>Needs the repo scope. <a href="https://github.com/settings/tokens/new?scopes=repo&description=Build%20Packager" target="_blank" rel="noopener">Create one <Icon name="external" /></a></>}>
            <PasswordInput ref={patRef} placeholder="ghp_…" data-secret="1" value={pat} disabled={locked} onChange={e => setPat(e.target.value)} />
          </Field>
          <Button variant="secondary" full type="submit" busy={busy === 'pat' ? 'Signing in…' : null} disabled={locked}>Sign in with token</Button>
        </form>
      </details>
      {live}
    </>
  );

  return (
    <div className="login">
      <div className="panel">
        <div className="brand">
          <span className="mark"><Icon name="box" /></span>
          <h1 className="display">Build Packager</h1>
          <p className="muted">Build, package and ship a repo in one go.</p>
        </div>
        <div className="stack">
          {device ? <DeviceFlow onSuccess={success} onBack={() => { setDevice(false); setTimeout(() => ghRef.current?.focus(), 0); }} /> : glView ? tokenView : main}
        </div>
        <p className="micro foot-note">Runs locally · tokens stay on this computer</p>
      </div>
    </div>
  );
}
