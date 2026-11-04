import {useEffect, useRef, useState} from 'react';
import {Alert, Field, Icon, Input, Skeleton, StepHead} from '@devtools/ui';
import {prefetchRepos} from '../../../lib/repos';
import {URL_MSG, baseName, repoFullFromUrl, sanitize, validGitUrl} from '../../../lib/validate';
import {getDraft, updateDraft, useDraft, type Draft} from '../../../state/draft';
import {getAuth, session} from '../../../state/session';
import type {Repo} from '../../../types/api';
import {shownErrors, type StepErrors, type StepProps} from '../stepApi';

function validate(d: Draft): StepErrors {
  let msg: string | null = null;
  if (session.urlMode) {
    if (!d.repo_url) msg = 'Enter a clone URL.'; else if (!validGitUrl(d.repo_url)) msg = URL_MSG;
  } else if (!d.repo_url) msg = 'Select a repository to continue.';
  return msg ? [['repo', msg]] : [];
}

function selectRepo(r: Repo) {
  const d = getDraft();
  updateDraft({
    repo_url: r.clone_url, repo_full: r.full_name, default_branch: r.default_branch || '', branch: r.default_branch || 'main',
    service: d.service_edited ? d.service : sanitize(r.full_name.split('/').pop() || ''),
  });
}

/** Step 1: pick one of the user's GitHub repos, or paste any clone URL / local path. */
export function RepoStep({register, tried, ext, goNext}: StepProps) {
  const draft = useDraft();
  if (session.urlMode === null) session.urlMode = false;
  const [urlMode, setUrlModeState] = useState(!!session.urlMode);
  const [emptyAccount, setEmptyAccount] = useState(false);
  const [loaded, setLoaded] = useState(0);
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(-1);
  const search = useRef<HTMLInputElement>(null);
  const url = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const focusOnSwitch = useRef(false);

  const setUrlMode = (on: boolean, empty = false) => { session.urlMode = on; setEmptyAccount(empty); setUrlModeState(on); };
  const errs = shownErrors(tried, validate(draft), ext);
  register({validate, first: () => (urlMode ? url.current : search.current)});

  // repos: wait for the shared prefetch; switch to URL mode when the account has none or the draft repo isn't listed
  const repos = session.repos;
  useEffect(() => {
    if (urlMode) return;
    if (repos) {
      if (!repos.length) { focusOnSwitch.current = true; setUrlMode(true, true); return; }
      if (draft.repo_url && !repos.some(r => r.clone_url === draft.repo_url)) { focusOnSwitch.current = true; setUrlMode(true); return; }
      list.current?.querySelector('[aria-selected=true]')?.scrollIntoView({block: 'nearest'});
      return;
    }
    if (session.reposErr) return;
    let dead = false;
    prefetchRepos()?.then(() => { if (!dead) setLoaded(n => n + 1); });
    return () => { dead = true; };
  }, [urlMode, repos, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!focusOnSwitch.current) return;
    focusOnSwitch.current = false;
    (urlMode ? url.current : search.current)?.focus();
  }, [urlMode]);

  const filtered = (repos || []).filter(r => r.full_name.toLowerCase().includes(term.trim().toLowerCase()));
  const act = Math.min(active, filtered.length - 1);
  useEffect(() => { if (act >= 0) document.getElementById('opt-' + act)?.scrollIntoView({block: 'nearest'}); }, [act]);

  const gl = getAuth()?.provider === 'gitlab';
  const head = <StepHead title="Choose a repository" sub={gl ? 'Your projects on ' + (getAuth()?.gitlab.url || 'GitLab') : 'Which code should we build?'} />;

  if (urlMode) {
    return (
      <>{head}
        <div className="stack">
          {emptyAccount ? <Alert kind="info"><span>No repositories found on this account.</span></Alert> : null}
          <Field id="repo" label="Clone URL" help="HTTPS, SSH, git@host:path, file:// or an absolute path." error={errs.repo}>
            <Input ref={url} mono placeholder="https://github.com/owner/repo.git" value={draft.repo_url} onChange={e => {
              const v = e.target.value.trim(), d = getDraft();
              updateDraft({repo_url: v, repo_full: repoFullFromUrl(v), default_branch: d.repo_url !== v ? '' : d.default_branch,
                service: d.service_edited ? d.service : sanitize(baseName(v))});
            }} />
          </Field>
          {emptyAccount ? null : (
            <p className="meta"><button className="link" type="button" onClick={() => {
              if (session.repos && !session.repos.some(r => r.clone_url === getDraft().repo_url)) updateDraft({repo_url: '', repo_full: ''});
              focusOnSwitch.current = true;
              setUrlMode(false);
            }}>Pick from my repositories</button></p>
          )}
        </div>
      </>
    );
  }

  const loading = !repos && !session.reposErr;
  return (
    <>{head}
      <div className="stack">
        <Field id="repo" label="Repository" labelClassName="sr" error={errs.repo} extra={
          <ul className="listbox" id="repo-list" role="listbox" aria-label="Repositories" ref={list} hidden={!loading && !filtered.length}>
            {loading
              ? [0, 1, 2, 3, 4].map(i => <li aria-hidden="true" style={{cursor: 'default'}} key={i}><Skeleton w="50%" h={12} /></li>)
              : filtered.map((r, i) => (
                <li role="option" id={'opt-' + i} key={r.clone_url} aria-selected={r.clone_url === draft.repo_url} className={i === act ? 'active' : ''}
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => { selectRepo(r); setActive(i); search.current?.focus(); }}
                  onDoubleClick={() => { selectRepo(r); goNext(); }}>
                  <span className="name">{r.full_name}</span>
                  {r.private ? <span className="lock" title="Private"><Icon name="lock" /><span className="sr">Private</span></span> : null}
                  <span className="br">{r.default_branch || ''}</span>
                  <Icon name="check" className="chk" />
                </li>
              ))}
          </ul>
        }>
          <div className="search">
            <Icon name="search" />
            <Input ref={search} type="search" placeholder={gl ? 'Search your projects' : 'Search your repositories'} role="combobox" aria-expanded="true" aria-controls="repo-list"
              aria-autocomplete="list" aria-activedescendant={act >= 0 ? 'opt-' + act : undefined} value={term}
              onChange={e => { setTerm(e.target.value); setActive(-1); }}
              onKeyDown={e => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  if (!filtered.length) return;
                  setActive(e.key === 'ArrowDown' ? Math.min(filtered.length - 1, act + 1) : Math.max(0, act - 1));
                } else if (e.key === 'Enter' && act >= 0 && filtered[act]) {
                  e.preventDefault();
                  selectRepo(filtered[act]);
                  goNext();
                }
              }} />
          </div>
        </Field>
        <div>
          {session.reposErr
            ? <Alert kind="error"><span>{"Couldn't load repositories. " + session.reposErr.detail}</span>
                <div><button className="btn ghost" type="button" onClick={() => { session.reposErr = null; setLoaded(n => n + 1); }}>Retry</button></div></Alert>
            : repos && repos.length && !filtered.length ? <p className="list-empty">{'No repositories match “' + term.trim() + '”.'}</p> : null}
        </div>
        <p className="meta">Not listed? <button className="link" type="button" onClick={() => { focusOnSwitch.current = true; setUrlMode(true); }}>Paste a clone URL</button></p>
      </div>
    </>
  );
}
