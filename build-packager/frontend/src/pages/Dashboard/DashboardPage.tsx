import {useEffect, useRef, useState} from 'react';
import {Alert, Button, EmptyState, Icon, Skeleton, SkeletonRows, StatTile, StatTiles, StatusIcon, errDetail, fmtRel, isDialogOpen,
  isMenuOpen, statusText, toast, useInterval} from '@devtools/ui';
import {jobsApi} from '../../api/endpoints';
import {jobActive} from '../../lib/jobs';
import {prefetchRepos} from '../../lib/repos';
import {focusH1, router, setTitle} from '../../router';
import {resetDraft} from '../../state/draft';
import type {Job} from '../../types/api';
import {JobRow} from './JobRow';

const newBuild = () => { resetDraft(); router.go('#/new/repo'); };

function NewBuildButton({lg}: {lg?: boolean}) {
  return <Button variant="primary" size={lg ? 'lg' : undefined} onClick={newBuild}><Icon name="plus" />New build</Button>;
}

/** Builds overview: stat tiles + recent builds. Polls every 3s while something runs. */
export function DashboardPage() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [, setNow] = useState(0);
  const prev = useRef<Record<string, string>>({});
  const jobsRef = useRef<Job[] | null>(null);
  jobsRef.current = jobs;

  useEffect(() => {
    setTitle('Builds');
    focusH1();
    prefetchRepos();
    const onKey = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName || '';
      if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey && !/INPUT|TEXTAREA|SELECT/.test(tag) && !isDialogOpen() && !isMenuOpen()) {
        e.preventDefault();
        newBuild();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // load + poll while any job is active
  const [pollKey, setPollKey] = useState(0);
  useEffect(() => {
    let dead = false, t = 0;
    (async () => {
      let list: Job[];
      try { list = await jobsApi.list(); }
      catch (e) {
        if (dead) return;
        if (jobsRef.current) t = window.setTimeout(() => setPollKey(k => k + 1), 3000);
        else setLoadErr("Couldn't load builds. " + errDetail(e).detail);
        return;
      }
      if (dead) return;
      for (const j of list) {
        const was = prev.current[j.id];
        if (was && jobActive({status: was as Job['status']}) && !jobActive(j)) {
          toast(j.service + (j.status === 'success' ? ' succeeded' : ' failed'), j.status === 'success' ? 'success' : 'error');
        }
        prev.current[j.id] = j.status;
      }
      setJobs(list);
      if (list.some(jobActive)) t = window.setTimeout(() => setPollKey(k => k + 1), 3000);
    })();
    return () => { dead = true; clearTimeout(t); };
  }, [pollKey]);

  const active = !!jobs?.some(jobActive);
  useInterval(() => setNow(Date.now()), active ? 1000 : null);

  const head = (withButton: boolean) => <div className="page-head"><h1 tabIndex={-1}>Builds</h1>{withButton ? <NewBuildButton /> : null}</div>;

  if (loadErr) {
    return (
      <div className="wrap">{head(false)}
        <Alert kind="error"><span>{loadErr}</span><div><button className="btn ghost" type="button" onClick={() => { setLoadErr(null); setPollKey(k => k + 1); }}>Retry</button></div></Alert>
      </div>
    );
  }
  if (!jobs) {
    return (
      <div className="wrap">{head(false)}
        <div className="tiles">{[0, 1, 2, 3].map(i => <div className={'tile' + (i === 3 ? ' lastt' : '')} key={i}><Skeleton w="60%" h={12} /><Skeleton w="40%" h={24} /></div>)}</div>
        <SkeletonRows n={3} />
      </div>
    );
  }
  if (!jobs.length) {
    return (
      <div className="wrap">{head(false)}
        <EmptyState title="No builds yet" text="Pick a repository, set a zip password, and get an encrypted package."><NewBuildButton lg /></EmptyState>
      </div>
    );
  }
  const ok = jobs.filter(j => j.status === 'success').length, bad = jobs.filter(j => j.status === 'failed').length, last = jobs[0];
  return (
    <div className="wrap">{head(true)}
      <StatTiles>
        <StatTile label="Total builds" value={jobs.length} />
        <StatTile label="Succeeded" value={ok} tone={ok > 0 ? 'success' : ''} />
        <StatTile label="Failed" value={bad} tone={bad > 0 ? 'danger' : ''} />
        <StatTile label="Last build" href={'#/jobs/' + last.id} className="lastt">
          <span className="last">
            <StatusIcon status={last.status} /><span className="sr">{statusText(last.status) + ': '}</span>{last.service}
            <span className="muted" style={{fontWeight: 400}}>{'· ' + fmtRel(last.created_at)}</span>
          </span>
        </StatTile>
      </StatTiles>
      <section aria-labelledby="recent-h">
        <h2 id="recent-h" style={{marginBottom: 'var(--s3)'}}>Recent builds</h2>
        <div className="list">
          {jobs.map(j => <JobRow key={j.id} job={j} onDeleted={() => setJobs(js => (js || []).filter(x => x.id !== j.id))} />)}
        </div>
      </section>
    </div>
  );
}
