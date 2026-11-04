import {useEffect, useRef, useState, type ReactNode} from 'react';
import {Alert, Button, ErrorText, Icon, Skeleton, SkeletonRows, announce, errDetail, fmtRel, fmtSize, sset, useInterval} from '@devtools/ui';
import {configApi, packagesApi} from '../../../api/endpoints';
import {fmtTs, joinPath} from '../../../lib/format';
import {router} from '../../../router';
import {getDraft, updateDraft, useDraft} from '../../../state/draft';
import {session} from '../../../state/session';
import type {FileServer, Package, PackageList} from '../../../types/api';
import {shownErrors, type StepErrors, type StepProps} from '../stepApi';

function validate(): StepErrors {
  return getDraft().package_path ? [] : [['pkg', 'Choose a package to deploy.']];
}

const pkey = (p: Package) => p.path + '|' + (p.modified_at || '') + '|' + p.size;
const clock = () => new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});

const toSettings = () => { sset('sd.return', '#/new/package'); router.go('#/settings/file-server'); };

/**
 * Step 1: browse the file server folder and pick a package, grouped by service, newest first.
 * The listing refreshes every 5 s (watch): files that show up later are marked New (or Uploading… while their size changes).
 */
export function PackageStep({register, tried, ext, goNext}: StepProps) {
  const draft = useDraft();
  const [fs, setFs] = useState<FileServer | null | 'none'>(null);
  const [cfgErr, setCfgErr] = useState<string | null>(null);
  const [cur, setCur] = useState('');
  const [data, setData] = useState<PackageList | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const [filter, setFilter] = useState(session.filter);
  const [live, setLive] = useState<{ok: boolean; at: string} | null>(null);
  const seq = useRef(0);
  const seen = useRef<Set<string> | null>(null);
  const fresh = useRef(new Set<string>());
  const lastSize = useRef(new Map<string, number | null>());
  const uploading = useRef(new Set<string>());
  const focusOnData = useRef(true);
  const list = useRef<HTMLDivElement>(null);
  const errs = shownErrors(tried, validate(), ext);
  register({validate});

  /** Mark packages that weren't in the first listing of this folder; hold back ones still growing. */
  const watch = (d: PackageList) => {
    const pkgs = (d.groups || []).flatMap(g => g.packages);
    const prevSize = lastSize.current;
    lastSize.current = new Map(pkgs.map(p => [p.path, p.size]));
    if (!seen.current) { uploading.current = new Set(); seen.current = new Set(pkgs.map(pkey)); return; }
    // first seen after the first listing, or its size changed: provisional until the size holds for one poll
    uploading.current = new Set(pkgs.filter(p => !prevSize.has(p.path) || prevSize.get(p.path) !== p.size).map(p => p.path));
    let n = 0;
    for (const p of pkgs) {
      const k = pkey(p);
      if (seen.current.has(k) || uploading.current.has(p.path)) continue;
      seen.current.add(k);
      fresh.current.add(p.path);
      n++;
    }
    if (n) announce(n + ' new package' + (n > 1 ? 's' : ''));
  };

  const load = async (path: string, quiet = false) => {
    const my = ++seq.current;
    focusOnData.current = !quiet;
    if (!quiet) {
      if (path !== cur) seen.current = null; // a new folder starts a new watch; Refresh keeps the marks
      setCur(path);
      setData(null);
      setListErr(null);
    }
    if (seen.current === null) {
      fresh.current = new Set();
      lastSize.current = new Map();
    }
    let d: PackageList;
    try { d = await packagesApi.list(path); }
    catch (e) {
      if (my !== seq.current) return;
      if (quiet) setLive({ok: false, at: clock()}); else setListErr("Couldn't list the file server. " + errDetail(e).detail);
      return;
    }
    if (my !== seq.current) return;
    watch(d);
    if (!quiet) { setCur(d.path || path); updateDraft({path: d.path || path}); }
    setData(d);
    setLive({ok: true, at: clock()});
  };

  useEffect(() => {
    configApi.get().then(cfg => {
      const f = cfg.file_server;
      if (!f || !f.host) { setFs('none'); return; }
      setFs(f);
      void load(getDraft().path || f.remote_dir || '/');
    }).catch(e => setCfgErr("Couldn't load settings. " + errDetail(e).detail));
    return () => { seq.current++; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // once a listing shows: focus the chosen (or first) package, unless the user already moved focus
  useEffect(() => {
    if (!data || !list.current || !focusOnData.current) return;
    const a = document.activeElement;
    const h1 = list.current.closest('#main')?.querySelector('h1');
    if (a === document.body || a === document.getElementById('main') || a === h1) {
      (list.current.querySelector<HTMLElement>('input:checked') || list.current.querySelector<HTMLElement>('input[type=radio]'))?.focus();
    }
  }, [data]);

  const server = fs && fs !== 'none' ? fs : null;
  useInterval(() => { if (!document.hidden) void load(cur, true); }, server && data ? 5000 : null);
  const go = (p: string) => { if (server) void load(p); };
  const segs = cur.split('/').filter(Boolean);

  let sub: ReactNode = <Skeleton w="240px" h={14} />;
  if (fs === 'none') sub = 'No file server is set up.';
  else if (server && cur) {
    const where = 'sftp://' + server.host + cur;
    sub = <>Packages on <span className="mono">{where}</span></>;
  }

  let body: ReactNode = <SkeletonRows n={3} />;
  if (cfgErr) body = <Alert kind="error"><span>{cfgErr}</span></Alert>;
  else if (fs === 'none') {
    body = (
      <Alert kind="warning" icon="alert">
        <b>Connect the file server first</b>
        <span>Swarm Deployer downloads packages from the server Build Packager uploads to.</span>
        <div><Button variant="secondary" onClick={toSettings}>Set up the file server</Button></div>
      </Alert>
    );
  } else if (listErr) {
    body = (
      <Alert kind="error">
        <span>{listErr}</span>
        <div className="row-flex" style={{flexWrap: 'wrap'}}>
          <Button variant="ghost" onClick={() => go(cur)}>Retry</Button>
          <button className="link" type="button" onClick={toSettings}>File server settings</button>
        </div>
      </Alert>
    );
  } else if (data) {
    const groupsAll = data.groups || [];
    const groups = filter && groupsAll.some(g => g.service === filter) ? groupsAll.filter(g => g.service === filter) : groupsAll;
    body = (
      <>
        {groups.length !== groupsAll.length ? (
          <div style={{marginBottom: 'var(--s3)'}}>
            <Alert kind="info"><span>Showing <code>{filter}</code> only. <button className="link" type="button" onClick={() => { session.filter = null; setFilter(null); }}>Show all services</button></span></Alert>
          </div>
        ) : null}
        {data.dirs?.length ? (
          <div className="list" role="list" aria-label="Folders">
            {data.dirs.map(d => <button key={d} className="drow" type="button" role="listitem" onClick={() => go(joinPath(data.path, d))}><Icon name="folder" />{d + '/'}</button>)}
          </div>
        ) : null}
        {!groups.length ? <p className="list-empty">{'No packages in ' + data.path + '. Build Packager uploads <service>_<timestamp>.zip here; build_tar.sh zips (<name>.tar.zip) work too.'}</p> : null}
        {groups.map(g => {
          const gid = 'grp-' + g.service.replace(/[^A-Za-z0-9_-]/g, '_');
          return (
            <div className="pgroup" key={g.service}>
              <h2 id={gid}>
                {g.service}
                {g.mapped ? null : <span className="badge">New</span>}
              </h2>
              <div className="list" role="radiogroup" aria-labelledby={gid}>
                {g.packages.map((p, i) => {
                  const up = uploading.current.has(p.path), isNew = !up && fresh.current.has(p.path);
                  const pick = () => up ? undefined : updateDraft({package_path: p.path, package: g.service, path: data.path});
                  const size = p.size === null || p.size === undefined ? 'size unknown' : fmtSize(p.size);
                  return (
                    <label className={'prow' + (isNew ? ' new' : '')} title={p.name} key={p.path} onDoubleClick={() => { pick(); goNext(); }}>
                      <input type="radio" name="pkg" value={p.path} checked={draft.package_path === p.path} disabled={up} onChange={pick} />
                      {p.format === 'tarzip' ? (
                        <span className="t">
                          <span className="mono">{p.name}</span>
                          <span className="muted">{' · ' + size + ' · ' + fmtRel(p.modified_at || p.created_at)}</span>
                          {' '}<span className="badge fmt">{/\.tar\.zip$/.test(p.name) ? 'tar.zip' : 'zip'}</span>
                          {draft.package_path === p.path && !p.ts ? <span className="muted">{' · new version (deploy time)'}</span> : null}
                        </span>
                      ) : (
                        <span className="t">
                          <span className="mono">{fmtTs(p.ts)}</span>
                          <span className="muted">{' · ' + size + ' · ' + fmtRel(p.created_at)}</span>
                        </span>
                      )}
                      {i === 0 ? <span className="badge accent">Latest</span> : null}
                      {up ? <span className="badge up">Uploading…</span> : isNew ? <span className="badge new">New</span> : null}
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </>
    );
  }

  return (
    <>
      <div className="step-head"><h1 tabIndex={-1}>Choose a package</h1><div className="sub">{sub}</div></div>
      <div className="row-flex" style={{marginBottom: 'var(--s3)', flexWrap: 'wrap'}}>
        <nav className="crumbs" aria-label="Folder">
          {server && cur ? (
            <>
              <button type="button" aria-current={segs.length ? undefined : 'location'} onClick={segs.length ? () => go('/') : undefined}>/</button>
              {segs.map((s, i) => {
                const p = '/' + segs.slice(0, i + 1).join('/'), last = i === segs.length - 1;
                return (
                  <span key={p} style={{display: 'contents'}}>
                    {i ? <span className="sep" aria-hidden="true">/</span> : null}
                    <button type="button" aria-current={last ? 'location' : undefined} onClick={last ? undefined : () => go(p)}>{s}</button>
                  </span>
                );
              })}
            </>
          ) : null}
        </nav>
        <span className="spacer" />
        <span id="pkg-live" className={'pkg-live ' + (live && !live.ok ? 'warn' : 'muted')} aria-live="off">
          {live ? (live.ok ? 'Watching · updated ' : "Couldn't refresh · ") + live.at : ''}
        </span>
        <Button variant="ghost" onClick={() => { if (server) go(cur); }}><Icon name="refresh" />Refresh</Button>
      </div>
      <ErrorText id="pkg-err" msg={errs.pkg} />
      <div id="pkg" tabIndex={-1} ref={list}>{body}</div>
    </>
  );
}
