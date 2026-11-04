import {useEffect, useRef, useState} from 'react';
import {Alert, Button, Icon, Skeleton, SkeletonRows, StatTile, StatTiles, StatusIcon, errDetail, fmtRel, isDialogOpen, isMenuOpen,
  statusText, toast, useInterval} from '@devtools/ui';
import {configApi, deploysApi, servicesApi} from '../../api/endpoints';
import {JobRow} from '../../components/JobRow';
import {jobActive} from '../../lib/jobs';
import {focusH1, router, setTitle, startWizard} from '../../router';
import type {Config, Job, Service} from '../../types/api';
import {ServiceRow} from './ServiceRow';
import {SetupChecklist} from './SetupChecklist';

const ready = (c: Config) => !!(c.file_server && c.file_server.host) && c.targets.length > 0;

function TileSkeletons() {
  return <div className="tiles">{[0, 1, 2, 3].map(i => <div className={'tile' + (i === 3 ? ' lastt' : '')} key={i}><Skeleton w="60%" h={12} /><Skeleton w="40%" h={24} /></div>)}</div>;
}

/** Deployments: setup checklist until configured; then stat tiles, services (live from targets) and recent deploys. */
export function DashboardPage() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [cfgErr, setCfgErr] = useState<string | null>(null);
  useEffect(() => {
    setTitle('Deployments');
    focusH1();
    configApi.get().then(setCfg).catch(e => setCfgErr("Couldn't load settings. " + errDetail(e).detail));
  }, []);
  const isReady = !!cfg && ready(cfg);

  // "n" starts a new deploy (only when the New deploy button is shown)
  useEffect(() => {
    if (!isReady) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName || '';
      if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey && !/INPUT|TEXTAREA|SELECT/.test(tag) && !isDialogOpen() && !isMenuOpen()) {
        e.preventDefault();
        startWizard();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isReady]);

  return (
    <div className="wrap">
      <div className="page-head">
        <h1 tabIndex={-1}>Deployments</h1>
        {isReady ? <Button variant="primary" onClick={() => startWizard()}><Icon name="plus" />New deploy</Button> : null}
      </div>
      {cfgErr ? <Alert kind="error"><span>{cfgErr}</span><div><Button variant="ghost" onClick={() => router.refresh()}>Retry</Button></div></Alert>
        : !cfg ? <div><TileSkeletons /><SkeletonRows n={2} /></div>
          : !isReady ? <SetupChecklist cfg={cfg} />
            : <Overview />}
    </div>
  );
}

function Overview() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [jobsErr, setJobsErr] = useState<string | null>(null);
  const [svcs, setSvcs] = useState<Service[] | null>(null);
  const [svcErr, setSvcErr] = useState<string | null>(null);
  const [svcKey, setSvcKey] = useState(0);
  const [pollKey, setPollKey] = useState(0);
  const [, setNow] = useState(0);
  const prev = useRef<Record<string, string>>({});
  const jobsRef = useRef<Job[] | null>(null);
  jobsRef.current = jobs;
  const svcsRef = useRef<Service[] | null>(null);
  svcsRef.current = svcs;

  useEffect(() => {
    let dead = false;
    servicesApi.list().then(r => { if (!dead) { setSvcs(r || []); setSvcErr(null); } })
      .catch(e => { if (!dead && !svcsRef.current) setSvcErr("Couldn't load services. " + errDetail(e).detail); });
    return () => { dead = true; };
  }, [svcKey]);

  // deploys: load, then poll every 3s while one runs; toast when one finishes
  useEffect(() => {
    let dead = false, t = 0;
    (async () => {
      let list: Job[];
      try { list = await deploysApi.list(); }
      catch (e) {
        if (dead) return;
        if (jobsRef.current) t = window.setTimeout(() => setPollKey(k => k + 1), 3000);
        else setJobsErr("Couldn't load deploys. " + errDetail(e).detail);
        return;
      }
      if (dead) return;
      let finished = false;
      for (const j of list) {
        const was = prev.current[j.id];
        if (was && jobActive({status: was as Job['status']}) && !jobActive(j)) {
          finished = true;
          const what = j.kind === 'rollback' ? ' rollback' : ' deploy';
          toast(j.status === 'success' ? j.package + (j.kind === 'rollback' ? ' rolled back' : ' deployed') : j.package + what + ' failed',
            j.status === 'success' ? 'success' : 'error');
        }
        prev.current[j.id] = j.status;
      }
      if (finished) setSvcKey(k => k + 1);
      setJobs(list);
      if (list.some(jobActive)) t = window.setTimeout(() => setPollKey(k => k + 1), 3000);
    })();
    return () => { dead = true; clearTimeout(t); };
  }, [pollKey]);
  useInterval(() => setNow(Date.now()), jobs?.some(jobActive) ? 1000 : null);

  let tiles = <TileSkeletons />;
  if (jobs) {
    const ok = jobs.filter(j => j.status === 'success').length, bad = jobs.filter(j => j.status === 'failed').length, last = jobs[0];
    tiles = (
      <StatTiles>
        <StatTile label="Total deploys" value={jobs.length} />
        <StatTile label="Succeeded" value={ok} tone={ok ? 'success' : ''} />
        <StatTile label="Failed" value={bad} tone={bad ? 'danger' : ''} />
        {last ? (
          <StatTile label="Last deploy" href={'#/deploys/' + last.id} className="lastt">
            <span className="last">
              <StatusIcon status={last.status} /><span className="sr">{statusText(last.status) + ': '}</span>{last.package}
              <span className="muted" style={{fontWeight: 400}}>{'· ' + fmtRel(last.created_at)}</span>
            </span>
          </StatTile>
        ) : <StatTile label="Last deploy" className="lastt"><span className="last muted">None yet</span></StatTile>}
      </StatTiles>
    );
  }
  return (
    <>
      {tiles}
      <section aria-labelledby="svc-h">
        <h2 id="svc-h" style={{marginBottom: 'var(--s3)'}}>Services</h2>
        <div>
          {svcErr ? <Alert kind="error"><span>{svcErr}</span><div><Button variant="ghost" onClick={() => { setSvcErr(null); setSvcKey(k => k + 1); }}>Retry</Button></div></Alert>
            : !svcs ? <SkeletonRows n={2} />
              : svcs.length ? <div className="list">{svcs.map(s => <ServiceRow key={s.package} s={s} />)}</div>
                : <p className="list-empty">Nothing deployed yet.</p>}
        </div>
      </section>
      <section className="section" aria-labelledby="recent-h">
        <h2 id="recent-h">Recent deploys</h2>
        <div>
          {jobsErr ? <Alert kind="error"><span>{jobsErr}</span></Alert>
            : !jobs ? <SkeletonRows n={3} />
              : <div className="list">{jobs.length ? jobs.slice(0, 15).map(j => <JobRow key={j.id} job={j} />)
                : <p className="list-empty">No deploys yet. Start one with New deploy.</p>}</div>}
        </div>
      </section>
    </>
  );
}
