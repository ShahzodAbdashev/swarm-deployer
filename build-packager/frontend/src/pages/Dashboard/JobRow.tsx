import {MenuButton, StatusIcon, fmtDur, fmtRel, localTime, statusText} from '@devtools/ui';
import {jobsApi} from '../../api/endpoints';
import {deleteJob} from '../../lib/deleteJob';
import {jobActive, jobDur, jobLine2} from '../../lib/jobs';
import {repoLabel} from '../../lib/validate';
import {router} from '../../router';
import type {Job} from '../../types/api';
import {rebuild} from '../NewBuild/wizard';

/** One build in the dashboard list: status, service, source, duration, age, second line, actions menu. */
export function JobRow({job: j, onDeleted}: {job: Job; onDeleted: () => void}) {
  const l2 = jobLine2(j);
  const active = jobActive(j);
  return (
    <div className="jrow">
      <a href={'#/jobs/' + j.id} data-id={j.id} aria-label={j.service + ', ' + statusText(j.status) + ', ' + l2}>
        <StatusIcon status={j.status} />
        <span className="svc">{j.service}</span>
        <span className="src">{repoLabel(j.repo_url) + ' · ' + j.branch}</span>
        <span className="dur">{fmtDur(jobDur(j))}</span>
        <time dateTime={j.created_at || ''} title={localTime(j.created_at)}>{fmtRel(j.created_at)}</time>
        <span className={'line2' + (j.status === 'failed' ? ' danger' : '')} title={l2}>{l2}</span>
      </a>
      <MenuButton label={'Actions for ' + j.service} className="icon more" data-id={j.id} items={() => [
        {label: 'View', run: () => router.go('#/jobs/' + j.id)},
        {label: 'Rebuild', run: () => rebuild(j)},
        j.artifacts.zip ? {label: 'Download .zip', href: jobsApi.zipUrl(j.id), download: true} : null,
        '-',
        {label: 'Delete…', danger: true, disabled: active, title: active ? "Running builds can't be deleted" : undefined,
          run: async () => { if (await deleteJob(j)) onDeleted(); }},
      ]} />
    </div>
  );
}
