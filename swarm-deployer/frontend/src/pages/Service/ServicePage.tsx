import {useEffect, useState, type ReactNode} from 'react';
import {Alert, Button, EmptyState, Icon, Skeleton, SkeletonRows, errDetail, fmtRel, statusText} from '@devtools/ui';
import {deploysApi, servicesApi} from '../../api/endpoints';
import {JobRow} from '../../components/JobRow';
import {focusH1, setTitle, startWizard} from '../../router';
import {session} from '../../state/session';
import type {Job, Service} from '../../types/api';
import {Backups} from './Backups';

/** Scroll to the section the dashboard menu asked for, once its content is there. */
function scrollPending() {
  const id = session.scrollTo, el = id ? document.getElementById(id) : null;
  if (el) { el.scrollIntoView({block: 'start'}); session.scrollTo = null; }
}

/** One mapped service: what runs now on the swarm, its backups (manual rollback) and its deploy history. */
export function ServicePage({pkg}: {pkg: string}) {
  const [svc, setSvc] = useState<Service | null>(null);
  const [svcErr, setSvcErr] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [jobsErr, setJobsErr] = useState<string | null>(null);

  useEffect(() => {
    setTitle(pkg || 'Service');
    focusH1();
    let dead = false;
    servicesApi.get(pkg).then(s => { if (!dead) setSvc(s); }).catch(e => {
      if (dead) return;
      const {status, detail} = errDetail(e);
      if (status === 404) { setTitle('Service not found'); setMissing(true); } else setSvcErr(detail);
    });
    deploysApi.list(pkg).then(j => { if (!dead) setJobs(j); }).catch(e => { if (!dead) setJobsErr("Couldn't load history. " + errDetail(e).detail); });
    return () => { dead = true; };
  }, [pkg]);
  useEffect(() => { if (jobs) scrollPending(); }, [jobs]);
  useEffect(() => { if (missing) focusH1(); }, [missing]);

  if (missing) {
    return (
      <div className="wrap">
        <EmptyState titleAs="h1" title={pkg + ' has not been deployed yet.'}><a className="btn primary" href="#/new/package">New deploy</a></EmptyState>
      </div>
    );
  }

  let now: ReactNode = <div className="stack"><Skeleton w="60%" h={14} /><Skeleton w="30%" h={14} /></div>;
  if (svcErr) now = <Alert kind="error"><span>{svcErr}</span></Alert>;
  else if (svc?.error) now = <Alert kind="error"><span>{'Target unreachable: ' + svc.error}</span></Alert>;
  else if (svc && !svc.exists) now = <Alert kind="warning" icon="alert">{svc.swarm_service + ' is not on the target any more.'}</Alert>;
  else if (svc) {
    const rb = /^rollback_/.test(svc.update_state || '');
    const ld = svc.last_deploy;
    now = (
      <dl className="kv">
        <dt>Image</dt><dd><span className="mono">{svc.current_image}</span></dd>
        <dt>Replicas</dt><dd>{svc.replicas_running + '/' + svc.replicas_desired + ' running'}</dd>
        <dt>Update state</dt>
        <dd>{svc.update_state || '—'}{rb ? <span className="muted">{svc.update_state === 'rollback_completed' && svc.replicas_running === svc.replicas_desired
          ? ' · swarm rolled back the last update; running the previous image, healthy' : ' · swarm is rolling back the last update'}</span> : null}</dd>
        {ld ? <><dt>Last deploy</dt><dd><a href={'#/deploys/' + ld.id}>{statusText(ld.status) + ' · ' + (ld.version || '') + (ld.finished_at ? ' · ' + fmtRel(ld.finished_at) : '')}</a></dd></> : null}
      </dl>
    );
  }

  return (
    <div className="wrap">
      <a className="back-link" href="#/dashboard"><Icon name="chevron-left" />Deployments</a>
      <div className="run-head">
        <h1 tabIndex={-1}>{pkg}</h1>
        <span className="spacer" />
        <Button variant="primary" onClick={() => startWizard(pkg)}><Icon name="up" />Deploy new version</Button>
      </div>
      <div className="run-meta">
        {svc ? <><span className="mono">{svc.swarm_service + ' @ ' + svc.target}</span>·<span className="mono">{svc.image_repo}</span></> : <Skeleton w="50%" h={12} />}
      </div>
      <section className="card" style={{marginTop: 'var(--s5)'}} aria-labelledby="now-h">
        <div className="card-head"><h2 id="now-h">Running now</h2></div>
        {now}
      </section>
      <section className="section" id="backups" aria-labelledby="bk-h">
        <h2 id="bk-h">Backups</h2>
        <div>{svc ? <Backups pkg={pkg} svc={svc} onLoaded={scrollPending} /> : svcErr ? null : <SkeletonRows n={2} />}</div>
      </section>
      <section className="section" id="history" aria-labelledby="hi-h">
        <h2 id="hi-h">History</h2>
        <div>
          {jobsErr ? <Alert kind="error"><span>{jobsErr}</span></Alert>
            : !jobs ? <SkeletonRows n={3} />
              : <div className="list">{jobs.length ? jobs.map(j => <JobRow key={j.id} job={j} />) : <p className="list-empty">No deploys for this service yet.</p>}</div>}
        </div>
      </section>
    </div>
  );
}
