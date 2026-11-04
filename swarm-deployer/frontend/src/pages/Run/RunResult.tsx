import {forwardRef, type ForwardedRef} from 'react';
import {ResultCard, fmtDurLong} from '@devtools/ui';
import {basename, dirname} from '../../lib/format';
import {failedPhase, jobDur, phint, plabel} from '../../lib/jobs';
import {router} from '../../router';
import {resetDraft, updateDraft} from '../../state/draft';
import {session} from '../../state/session';
import type {Job} from '../../types/api';

/** Finished deploy/rollback: green card (what runs now, backup tag) or red card (error, rollback outcome, hint, recovery). */
export const RunResult = forwardRef(function RunResult(
  {job, svcNow, onShowInLog}: {job: Job; svcNow: string | null; onShowInLog: (phase: string, failed: boolean) => void},
  ref: ForwardedRef<HTMLDivElement>,
) {
  const isRb = job.kind === 'rollback';
  const svcHref = '#/services/' + encodeURIComponent(job.package);
  const svcLink = <a className="link" href={svcHref}>Service details</a>;

  if (job.status === 'success') {
    const b = job.backup;
    return (
      <ResultCard ok ref={ref}
        title={isRb ? 'Rolled back ' + job.swarm_service + ' to ' + job.new_image : '70-75 uuuuu surqash! Deployed ' + (job.deploy_image || job.new_image) + ' in ' + fmtDurLong(jobDur(job) || 0)}
        actions={<><a className="btn primary" href="#/dashboard">Back to dashboard</a>{svcLink}</>}>
        <div className="muted" id="res-svc">{'Service ' + job.swarm_service + (svcNow ? ' · ' + svcNow : '')}</div>
        {job.new_digest ? <div className="muted" id="res-digest">{'Pushed ' + job.new_digest.slice(0, 19) + '… to ' + (job.registry || 'the registry')}</div> : null}
        {b && b.tag ? <div className="muted">Backup <span className="mono">{b.tag}</span>{b.image_tar ? ' (+ .tar)' : ''}</div> : null}
      </ResultCard>
    );
  }

  const f = failedPhase(job);
  const interrupted = !!job.error?.startsWith('interrupted (server restart)'); // recover() appends '; rolled back to …'
  const what = isRb ? 'Rollback' : 'Deploy';
  const rb = job.rollback;
  const hint = interrupted ? 'The server restarted while this ran. Check the service, then start again.' : f ? phint(f.name, job) : '';
  const badPkg = !!f && (f.name === 'deploy' || f.name === 'verify');
  const pickOther = () => {
    resetDraft();
    updateDraft({path: dirname(job.package_path)});
    session.filter = job.package;
    router.go('#/new/package');
  };
  const tryAgain = () => {
    resetDraft();
    updateDraft({package_path: job.package_path || '', package: job.package, path: dirname(job.package_path)});
    session.note = 'Enter the zip password to deploy ' + basename(job.package_path) + ' again.';
    router.go('#/new/password');
  };
  return (
    <ResultCard ok={false} ref={ref}
      title={interrupted ? what + ' interrupted' : f ? what + ' failed at ' + plabel(f.name, job) : what + ' failed'}
      actions={<>
        {!isRb && badPkg ? <button className="btn primary" type="button" onClick={pickOther}>Choose another package</button> : null}
        {isRb ? <a className="btn primary" href={svcHref}>Back to service</a>
          : <button className={badPkg ? 'btn secondary' : 'btn primary'} type="button" onClick={tryAgain}>Try again</button>}
        <button className="link" type="button" onClick={() => onShowInLog(f ? f.name : '', true)}>Show in log</button>
        {isRb ? null : svcLink}
        <a className="link muted" href="#/dashboard">Back to dashboard</a>
      </>}>
      {job.error ? <div className="err-text">{job.error}</div> : null}
      {rb && rb.performed ? (rb.ok
        ? <div className="success" style={{fontWeight: 500}}>{rb.to_image ? 'Rolled back to ' + rb.to_image + ' ✓' : 'Rolled back: the new service was removed ✓'}</div>
        : <div className="danger" style={{fontWeight: 500}}>Rollback failed — check the service on the target</div>) : null}
      {hint ? <div className="muted">{'Try: ' + hint}</div> : null}
    </ResultCard>
  );
});
