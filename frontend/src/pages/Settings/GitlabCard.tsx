import {useState, type ReactNode} from 'react';
import {Button, Input, PasswordInput, errDetail} from '@devtools/ui';
import {configApi} from '../../api/endpoints';
import {GridRow, TestRes} from '../../components/GridRow';
import type {Config, GitlabConfig} from '../../types/api';

/** GitLab URL + access token, used only by "Import from GitLab project". */
export function GitlabCard({cfg, onSaved}: {cfg: Config; onSaved: (g: GitlabConfig) => void}) {
  const g = cfg.gitlab;
  const [url, setUrl] = useState(g?.url || '');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ReactNode>(null);

  const save = async () => {
    setRes(null);
    setBusy(true);
    const body: {url: string; token?: string} = {url: url.trim()};
    if (token) body.token = token.trim();
    try {
      const r = await configApi.putGitlab(body);
      setBusy(false); setToken(''); setUrl(r.url); onSaved(r);
      setRes(<TestRes ok msg={r.has_token ? 'Saved.' : 'Saved. No token: a new URL needs its token again.'} />);
    } catch (e) { setBusy(false); setRes(<TestRes ok={false} msg={errDetail(e).detail} />); }
  };

  return (
    <section className="card" id="gitlab" aria-labelledby="gl-h">
      <div className="card-head"><h2 id="gl-h">GitLab</h2></div>
      <p className="help" style={{margin: 'calc(-1 * var(--s3)) 0 var(--s4)'}}>Optional. Only needed for "Import from GitLab project" below.</p>
      <div className="form-grid">
        <GridRow id="gl-url" label="GitLab URL">
          <Input mono value={url} placeholder="http://192.168.33.175" onChange={e => setUrl(e.target.value)} />
        </GridRow>
        <GridRow id="gl-token" label="Access token" help="Personal access token with the api scope (reads CI/CD variables).">
          <PasswordInput autoComplete="new-password" data-secret="1" placeholder={g?.has_token ? '(saved) · leave blank to keep' : 'glpat-…'} value={token} onChange={e => setToken(e.target.value)} />
        </GridRow>
      </div>
      <div className="wfoot"><span className="spacer" /><Button variant="primary" busy={busy ? 'Saving…' : null} onClick={save}>Save</Button></div>
      <div aria-live="polite">{res}</div>
    </section>
  );
}
