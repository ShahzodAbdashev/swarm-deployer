import {useEffect, useState} from 'react';
import {Button, Input, Select, Textarea, errDetail} from '@devtools/ui';
import {configApi, gitlabApi} from '../../api/endpoints';
import {GridRow, TestRes} from '../../components/GridRow';
import type {EnvImportResult, GitlabProject} from '../../types/api';

/** Fill settings from a .env (file or paste) or from a GitLab project's CI/CD variables. Values are never shown back. */
export function ImportCard({result, onImported}: {result: EnvImportResult | null; onImported: (r: EnvImportResult) => void}) {
  const [text, setText] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState<'env' | 'gitlab' | null>(null);
  const [projects, setProjects] = useState<GitlabProject[] | null>(null);
  const [projErr, setProjErr] = useState<string | null>(null);
  const [project, setProject] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    gitlabApi.projects().then(p => { if (!dead) { setProjects(p); setProject(p[0]?.full_name || ''); } })
      .catch(e => { if (!dead) setProjErr("Couldn't load GitLab projects. " + errDetail(e).detail); });
    return () => { dead = true; };
  }, []);

  const run = async (kind: 'env' | 'gitlab') => {
    setErr(null);
    if (kind === 'env' && !text.trim()) { setErr('Paste a .env or choose a file first.'); return; }
    setBusy(kind);
    try {
      const r = kind === 'env' ? await configApi.importEnv(text, target.trim() || undefined) : await configApi.importGitlab(project, target.trim() || undefined);
      setText('');
      onImported(r);
    } catch (e) { setBusy(null); setErr(errDetail(e).detail); }
  };

  return (
    <section className="card" id="import" aria-labelledby="ie-h">
      <div className="card-head"><h2 id="ie-h">Import .env</h2></div>
      <p className="help" style={{margin: 'calc(-1 * var(--s3)) 0 var(--s4)'}}>Fills these settings from a .env file. Values are never shown back.</p>
      <div className="form-grid">
        <GridRow id="ie-file" label=".env file">
          <input type="file" id="ie-file" accept=".env,text/plain" onChange={async e => { const f = e.target.files?.[0]; if (f) setText(await f.text()); e.target.value = ''; }} />
        </GridRow>
        <GridRow id="ie-text" label="Or paste it">
          <Textarea className="mono" data-secret="1" rows={6} style={{height: 'auto', paddingTop: 8}} placeholder={'FILE_SERVER_HOST=…\nBASE_DEVELOPMENT_HOST=…'}
            value={text} onChange={e => setText(e.target.value)} />
        </GridRow>
        <GridRow id="ie-target" label="Target id" help='Target id for SSH/registry keys (default: the only target, or "dev").'>
          <Input mono value={target} placeholder="dev" style={{maxWidth: 200}} onChange={e => setTarget(e.target.value)} />
        </GridRow>
        <span className="lbl" />
        <div className="ctl"><div><Button variant="primary" busy={busy === 'env' ? 'Importing…' : null} disabled={busy !== null} onClick={() => run('env')}>Import .env</Button></div></div>
        <GridRow id="ie-project" label="GitLab project" help="Reads the project's CI/CD variables (and its groups'), like the pipeline does.">
          {projErr ? <TestRes ok={false} msg={projErr} />
            : <Select value={project} disabled={!projects} onChange={e => setProject(e.target.value)}>
              {projects ? projects.map(p => <option key={p.full_name} value={p.full_name}>{p.full_name}</option>) : <option value="">Loading projects…</option>}
            </Select>}
        </GridRow>
        <span className="lbl" />
        <div className="ctl"><div><Button variant="secondary" busy={busy === 'gitlab' ? 'Importing…' : null} disabled={busy !== null || !project} onClick={() => run('gitlab')}>Import from GitLab</Button></div></div>
      </div>
      {err ? <div id="ie-err"><TestRes ok={false} msg={err} /></div> : null}
      {result ? <ImportResult r={result} /> : null}
    </section>
  );
}

/** The last import's outcome; the state lives in SettingsPage so it survives the cards remounting. */
function ImportResult({r}: {r: EnvImportResult}) {
  return (
    <div id="ie-result" aria-live="polite">
      <TestRes ok={!r.errors.length || !!r.set.length} msg={(r.project ? r.project + ' · ' : '') + 'Set: ' + (r.set.length ? r.set.join(', ') : 'nothing')} />
      {r.ignored.length ? <p className="muted micro">{'Ignored: ' + r.ignored.join(', ')}</p> : null}
      {r.errors.map(e => <TestRes key={e} ok={false} msg={e} />)}
    </div>
  );
}
