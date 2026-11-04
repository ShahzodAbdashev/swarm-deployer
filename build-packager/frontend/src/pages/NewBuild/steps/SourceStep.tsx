import {useEffect, useRef, useState, type ReactNode} from 'react';
import {Alert, Button, ErrorText, Field, Icon, Input, SegmentedControl, Select, StepHead, Textarea, errDetail, type Choice} from '@devtools/ui';
import {githubApi, gitlabApi} from '../../../api/endpoints';
import {SVC_MSG, SVC_RE, URL_MSG, baseName, envKeys, onGitlab, preloadList, repoFullFromUrl, repoLabel, validBranch,
  validGitUrl} from '../../../lib/validate';
import {getDraft, updateDraft, useDraft, type Draft} from '../../../state/draft';
import {getAuth, session} from '../../../state/session';
import type {Branch} from '../../../types/api';
import {shownErrors, type StepErrors, type StepProps} from '../stepApi';

const ADV_FIELD = /^(dockerfile|build_command|extra|x-|env_path|preload_tars)/;
const FALLBACK = "Couldn't list branches, type one. It must exist or the build stops at Clone.";

const advCount = (d: Draft) => (d.dockerfile && d.dockerfile !== 'Dockerfile' ? 1 : 0) + (d.build_command ? 1 : 0) + d.extra_repos.length
  + (d.env_path !== '.env' ? 1 : 0) + (preloadList(d.preload_tars).length ? 1 : 0);
const mainRepoDir = (d: Draft) => { const n = baseName(d.repo_url); return SVC_RE.test(n) ? n : 'repo'; };

function validate(d: Draft): StepErrors {
  const errs: StepErrors = [];
  const put = (id: string, msg: string | null) => { if (msg) errs.push([id, msg]); };
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
    let nm: string | null = null;
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

type BranchUi = {kind: 'loading'} | {kind: 'select'; list: Branch[]} | {kind: 'text'; help: string | null; extra?: ReactNode};

function initialBranchUi(d: Draft): BranchUi {
  if (!d.repo_full) return {kind: 'text', help: d.repo_url && !repoFullFromUrl(d.repo_url) ? 'The branch to build. It must exist or the build stops at Clone.' : FALLBACK};
  const cached = session.branches[d.repo_full];
  return Array.isArray(cached) ? {kind: 'select', list: cached} : {kind: 'loading'};
}

/** Branch select options: default branch first (marked), then the rest sorted, plus the draft's branch if missing. */
function branchOptions(list: Branch[], d: Draft) {
  const names = list.map(b => b.name);
  const def = d.default_branch && names.includes(d.default_branch) ? d.default_branch : null;
  if (d.branch && !names.includes(d.branch)) names.push(d.branch);
  const rest = names.filter(n => n !== def).sort((a, b) => a.localeCompare(b));
  return {def, rest, value: d.branch || def || rest[0] || ''};
}

const SRC_LABEL = {gitlab: 'from GitLab CI', file: 'from file', paste: 'pasted'} as const;

/** The .env written into the repo before docker build: none, a file / pasted text, or generated from the GitLab CI job. Values stay masked. */
function EnvBlock({draft, err, contentErr}: {draft: Draft; err?: string; contentErr?: string}) {
  const glOk = !!getAuth()?.gitlab?.logged_in && onGitlab(draft.repo_url);
  const mode = draft.env_mode === 'gitlab' && !glOk ? 'content' : draft.env_mode;
  const [edit, setEdit] = useState(!!contentErr);
  const [focus, setFocus] = useState(false);
  const [busy, setBusy] = useState(false);
  const [genErr, setGenErr] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (edit) ta.current?.focus(); }, [edit]);

  const content = draft.env_content;
  const meta = mode === 'gitlab' ? session.envMeta : null;
  const raw = mode === 'content' ? !content || edit || focus : mode === 'gitlab' && edit;
  const keys = envKeys(content);

  const gen = async () => {
    setGenErr(null);
    setBusy(true);
    const d = getDraft();
    try {
      const {content: c, ...m} = await gitlabApi.envPreview({repo_url: d.repo_url, branch: d.branch, job: d.env_job.trim() || 'export_env'});
      session.envMeta = m;
      updateDraft({env_content: c, env_source: 'gitlab'});
      setEdit(false);
    } catch (e) { setGenErr(errDetail(e).detail); } finally { setBusy(false); }
  };

  const opts: Choice<Draft['env_mode']>[] = [{value: 'none', label: 'None'}, {value: 'content', label: 'File or paste'}];
  if (glOk) opts.push({value: 'gitlab', label: 'From GitLab CI'});
  const sum = meta && draft.env_source === 'gitlab'
    ? 'From ' + meta.job + ' on ' + meta.branch + ' · ' + keys.length + ' keys'
    : keys.length + ' keys · ' + SRC_LABEL[draft.env_source];
  return (
    <fieldset className="env-field" id="env-field" tabIndex={-1} aria-describedby="env-help">
      <legend id="env-l">.env for the build</legend>
      <p className="help" id="env-help">Written to the repo before docker build, so the image gets it. It's never saved or logged.</p>
      <SegmentedControl name="env_mode" labelledBy="env-l" value={mode} options={opts}
        onChange={v => { setGenErr(null); setEdit(false); updateDraft({env_mode: v}); }} />
      {mode === 'content' ? (
        <Field id="env_file" label=".env file">
          <input type="file" id="env_file" accept=".env,text/plain" onChange={async e => {
            const f = e.target.files?.[0];
            if (!f) return;
            updateDraft({env_content: await f.text(), env_source: 'file'});
            setEdit(false);
          }} />
        </Field>
      ) : null}
      {mode === 'gitlab' ? (
        <>
          <Field id="env_job" label="CI job that writes .env">
            <Input mono value={draft.env_job} placeholder="export_env" onChange={e => updateDraft({env_job: e.target.value.trim()})} />
          </Field>
          <div><Button id="env-gen" variant="secondary" busy={busy ? 'Reading .gitlab-ci.yml…' : null} onClick={gen}>Generate from GitLab</Button></div>
          {genErr ? <Alert kind="error"><span>{genErr}</span></Alert> : null}
        </>
      ) : null}
      {mode !== 'none' && content ? (
        <div className="env-sum">
          <span>{sum}</span>
          <Button id="env-edit" variant="ghost" onMouseDown={e => e.preventDefault()} onClick={() => setEdit(x => !x)}>{edit ? 'Done' : 'Edit'}</Button>
        </div>
      ) : null}
      {mode !== 'none' && content && !raw ? (
        <ul id="env-keys">
          {keys.map(k => {
            const ln = meta?.lines.find(l => l.key === k);
            const miss = ln?.status === 'missing';
            const src = meta && ln && ln.vars.length ? 'from ' + ln.vars.map(v => '$' + v + (meta.sources[v] ? ' · ' + meta.sources[v] : '')).join(', ') : '';
            return (
              <li className={'env-row' + (miss ? ' missing' : '')} key={k}>
                {miss ? <Icon name="alert" /> : null}<code>{k}</code>{' = '}<span className="mask">••••••</span>
                {src ? <span className="src">{src}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {raw ? (
        <Field id="env_content" label=".env content" labelClassName="sr" error={contentErr}>
          <Textarea ref={ta} rows={6} className="mono" placeholder="KEY=value" data-secret="1" value={content}
            onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
            onChange={e => updateDraft({env_content: e.target.value, env_source: 'paste'})} />
        </Field>
      ) : null}
      {meta && meta.missing.length ? (
        <Alert kind="warning" id="env-missing">
          <span>{'Not set in GitLab: ' + meta.missing.map(v => '$' + v).join(', ') + ". They'll be empty in the .env. Add them in GitLab (project or group CI/CD variables) or edit the .env."}</span>
        </Alert>
      ) : null}
      {meta && meta.warnings.length ? <ul id="env-warnings">{meta.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul> : null}
      <ErrorText id="env-err" msg={err} />
    </fieldset>
  );
}

/** Step 2: branch, service name, .env, advanced options (Dockerfile path, build command, extra repos, .env path, preload tars). */
export function SourceStep({register, tried, ext}: StepProps) {
  const draft = useDraft();
  const [br, setBr] = useState<BranchUi>(() => initialBranchUi(getDraft()));
  const svc = useRef<HTMLInputElement>(null);
  const adv = useRef<HTMLDetailsElement>(null);
  const addBtn = useRef<HTMLButtonElement>(null);
  const focusX = useRef<number | null>(null);
  const [advOpen] = useState(() => advCount(getDraft()) > 0 || !!(ext && ADV_FIELD.test(ext.field)));
  const [note] = useState(() => { const n = session.note; session.note = null; return n; });

  const all = validate(draft);
  const errs = shownErrors(tried, all, ext);
  register({validate, first: () => (getDraft().service ? null : svc.current)});

  // errors inside Advanced options open it
  useEffect(() => { if (adv.current && Object.keys(errs).some(k => ADV_FIELD.test(k))) adv.current.open = true; });

  // the select picks a value: keep the draft in sync; free text defaults to main
  useEffect(() => {
    if (br.kind === 'select') { const v = branchOptions(br.list, getDraft()).value; if (v !== getDraft().branch) updateDraft({branch: v}); }
    if (br.kind === 'text' && !getDraft().branch) updateDraft({branch: 'main'});
  }, [br]);

  useEffect(() => {
    const full = getDraft().repo_full;
    if (br.kind !== 'loading' || !full) return;
    let dead = false;
    (onGitlab(getDraft().repo_url) ? gitlabApi : githubApi).branches(full).then(list => {
      session.branches[full] = list || [];
      if (dead) return;
      setBr(list && list.length ? {kind: 'select', list} : {kind: 'text', help: FALLBACK});
    }).catch(e => {
      if (dead) return;
      setBr(errDetail(e).status === 404
        ? {kind: 'text', help: null, extra: <p className="help danger">Repository not found or no access. <a href="#/new/repo">Change</a></p>}
        : {kind: 'text', help: FALLBACK});
    });
    return () => { dead = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (focusX.current === null) return;
    const i = focusX.current;
    focusX.current = null;
    (document.getElementById('x-url-' + i) || addBtn.current)?.focus();
  }, [draft.extra_repos.length]);

  const setExtra = (i: number, patch: Partial<Draft['extra_repos'][number]>) =>
    updateDraft({extra_repos: getDraft().extra_repos.map((x, k) => (k === i ? {...x, ...patch} : x))});

  const branchField = br.kind === 'loading'
    ? <Field id="branch" label="Branch"><Select disabled><option>Loading branches…</option></Select></Field>
    : br.kind === 'select'
      ? (() => {
          const o = branchOptions(br.list, draft);
          return (
            <Field id="branch" label="Branch" error={errs.branch}>
              <Select value={o.value} onChange={e => updateDraft({branch: e.target.value})}>
                {o.def ? <option value={o.def}>{o.def + ' (default)'}</option> : null}
                {o.rest.map(n => <option key={n} value={n}>{n}</option>)}
              </Select>
            </Field>
          );
        })()
      : <Field id="branch" label="Branch" help={br.help} extra={br.extra} error={errs.branch}>
          <Input mono value={draft.branch} onChange={e => updateDraft({branch: e.target.value.trim()})} />
        </Field>;

  const s = draft.service || 'service';
  const n = advCount(draft);
  return (
    <>
      <StepHead title="Build settings" sub={<><span className="mono">{draft.repo_full || repoLabel(draft.repo_url)}</span><a href="#/new/repo">Change</a></>} />
      {note ? <div style={{marginBottom: 'var(--s5)'}}><Alert kind="info"><span>{note}</span></Alert></div> : null}
      <div className="stack">
        <div>{branchField}</div>
        <Field id="service" label="Service name" error={errs.service} extra={
          <div className="preview" aria-live="polite">
            <div>{'Image ' + s.toLowerCase() + ':<timestamp> · folder ' + s + '_<timestamp>/'}</div>
            {/[A-Z]/.test(s) ? <div>{'Docker tags are lowercase, so the image is tagged ' + s.toLowerCase() + ':…; files keep ' + s + '.'}</div> : null}
          </div>
        }>
          <Input ref={svc} maxLength={63} value={draft.service} onChange={e => updateDraft({service: e.target.value.trim(), service_edited: true})} />
        </Field>
        <EnvBlock draft={draft} err={errs.env} contentErr={errs.env_content} />
        <details className="adv" id="adv" ref={adv} open={advOpen || undefined}>
          <summary><Icon name="chevron-down" />Advanced options<span className="muted" style={{fontWeight: 400}}>{n ? '· ' + n + ' set' : ''}</span></summary>
          <div className="adv-body">
            <Field id="dockerfile" label="Dockerfile path" help="Relative to the repo root, e.g. docker/Dockerfile.prod" error={errs.dockerfile}>
              <Input mono placeholder="Dockerfile" value={draft.dockerfile} onChange={e => updateDraft({dockerfile: e.target.value.trim()})} />
            </Field>
            <Field id="build_command" label="Build command (optional)" error={errs.build_command}
              help="Runs as a shell command in the repo folder before docker build. Only use commands you trust."
              extra={<div className="counter" aria-live="polite">{draft.build_command.length > 1800 ? draft.build_command.length + ' / 2000' : ''}</div>}>
              <Textarea rows={3} placeholder="npm ci && npm run build" value={draft.build_command} onChange={e => updateDraft({build_command: e.target.value})} />
            </Field>
            <div className="field" id="extra-field" tabIndex={-1}>
              <span className="lbl">Extra repositories (optional)</span>
              <p className="help">Cloned next to your repo inside the zip.</p>
              <p className="err" id="extra-err" hidden={!errs.extra}>{errs.extra ? <><Icon name="alert" /><span>{errs.extra}</span></> : null}</p>
              <div className="stack" style={{gap: 'var(--s3)'}}>
                {draft.extra_repos.map((x, i) => {
                  const rm = () => { focusX.current = i; updateDraft({extra_repos: getDraft().extra_repos.filter((_, k) => k !== i)}); };
                  return (
                    <div className="xrow" key={i}>
                      <Field id={'x-url-' + i} label="URL" error={errs['x-url-' + i]}>
                        <Input mono placeholder="https://github.com/owner/other.git" value={x.url} onChange={e => setExtra(i, {url: e.target.value.trim()})} />
                      </Field>
                      <Field id={'x-branch-' + i} label="Branch" error={errs['x-branch-' + i]}>
                        <Input mono placeholder="main" value={x.branch} onChange={e => setExtra(i, {branch: e.target.value.trim()})} />
                      </Field>
                      <Field id={'x-name-' + i} label="Folder" error={errs['x-name-' + i]}>
                        <Input mono placeholder={'auto: ' + (baseName(x.url) || 'name')} value={x.name} onChange={e => setExtra(i, {name: e.target.value.trim()})} />
                      </Field>
                      <button className="btn ghost icon rm-icon" type="button" aria-label={'Remove repository ' + (i + 1)} style={{marginTop: 24}} onClick={rm}><Icon name="x" /></button>
                      <button className="link rm-text" type="button" aria-label={'Remove repository ' + (i + 1)} onClick={rm}>Remove</button>
                    </div>
                  );
                })}
              </div>
              <div>
                <button className="link" type="button" ref={addBtn} onClick={() => {
                  focusX.current = getDraft().extra_repos.length;
                  updateDraft({extra_repos: [...getDraft().extra_repos, {url: '', branch: 'main', name: ''}]});
                }}><Icon name="plus" /> Add repository</button>
              </div>
            </div>
            <Field id="env_path" label=".env path in the repo" help="Relative to the repo root." error={errs.env_path}>
              <Input mono placeholder=".env" value={draft.env_path} onChange={e => updateDraft({env_path: e.target.value.trim()})} />
            </Field>
            <Field id="preload_tars" label="Images to load before the build" error={errs.preload_tars}
              help="One absolute path per line on this computer, e.g. /app/python.tar (offline base images).">
              <Textarea rows={2} className="mono" placeholder="/app/python.tar" value={draft.preload_tars} onChange={e => updateDraft({preload_tars: e.target.value})} />
            </Field>
          </div>
        </details>
      </div>
    </>
  );
}
