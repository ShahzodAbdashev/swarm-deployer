import {forwardRef, type ForwardedRef} from 'react';
import {Icon, ResultCard, copyText, fmtDur, fmtSize, toast} from '@devtools/ui';
import {jobsApi} from '../../api/endpoints';
import {STEP_LABEL, failedStep, hintFor, jobDur} from '../../lib/jobs';
import type {Job} from '../../types/api';
import {rebuild} from '../NewBuild/wizard';

/** Finished build: green card with downloads, or red card with the error, cause, hint and recovery actions. */
export const RunResult = forwardRef(function RunResult(
  {job, cause, onShowInLog}: {job: Job; cause: string; onShowInLog: (step: string, failed: boolean) => void},
  ref: ForwardedRef<HTMLDivElement>,
) {
  const a = job.artifacts;
  const ok = job.status === 'success';
  const zipA = a.zip ? <a className={'btn ' + (ok ? 'primary' : 'secondary')} href={jobsApi.zipUrl(job.id)} download=""><Icon name="download" />Download .zip</a> : null;
  const tarA = a.tar
    ? <a className="link" href={jobsApi.tarUrl(job.id)} download=""><Icon name="download" /> Download .tar <span className="tar-note">{'(' + fmtSize(a.tar_size) + ' · image only, not encrypted)'}</span></a>
    : null;
  const rb = <button className={ok ? 'link' : 'btn primary'} type="button" onClick={() => rebuild(job)}>Rebuild</button>;
  const home = <a className="link muted" href="#/dashboard">Back to dashboard</a>;
  const extras = <>
    {job.env ? <div className="mono" id="res-env">{'.env: ' + job.env.count + ' keys (' + job.env.path + ')'}</div> : null}
    {job.healthcheck ? <div className="mono" id="res-hc">healthcheck.sh included</div> : null}
  </>;

  if (ok) {
    return (
      <ResultCard ok ref={ref} title={'Build succeeded in ' + fmtDur(jobDur(job))} actions={<>{zipA}{rb}{home}</>} after={tarA}>
        <div className="mono">{job.folder_name + '.zip · ' + fmtSize(a.zip_size) + ' · AES-256'}</div>
        {job.deploy_manifest
          ? <div className="mono" data-manifest="1">{'deploy.yml: service ' + job.deploy_manifest.service + ' · image ' + job.deploy_manifest.image}</div>
          : null}
        {extras}
        {a.remote_path ? (
          <div className="row-flex" style={{flexWrap: 'wrap'}}>
            <span className="muted">Uploaded to</span>
            <span className="mono" style={{wordBreak: 'break-all'}}>{a.remote_path}</span>
            <button className="btn ghost" type="button" style={{height: 28}} aria-label="Copy upload path"
              onClick={async () => { if (await copyText(a.remote_path!)) toast('Path copied'); }}><Icon name="copy" />Copy</button>
          </div>
        ) : <div className="muted">Not uploaded. Download it below.</div>}
      </ResultCard>
    );
  }
  const f = failedStep(job);
  const interrupted = job.error === 'interrupted (server restart)';
  const hint = hintFor(job, f);
  return (
    <ResultCard ok={false} ref={ref}
      title={interrupted ? 'Build interrupted' : f ? 'Failed at the ' + STEP_LABEL[f.name] + ' step' : 'Build failed before starting'}
      actions={<>{rb}<button className="link" type="button" onClick={() => onShowInLog(f ? f.name : '', true)}>Show in log</button>{home}{tarA}{zipA}</>}>
      {job.error ? <div className="err-text">{job.error}</div> : null}
      {extras}
      <div className="cause" hidden={!cause}>{cause}</div>
      {hint ? <div className="muted">{'Try: ' + hint}</div> : null}
    </ResultCard>
  );
});
