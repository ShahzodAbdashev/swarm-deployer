import {StatusIcon, fmtDur, fmtRel, statusText} from '@devtools/ui';
import {localT} from '../lib/format';
import {jobDur, jobLine2} from '../lib/jobs';
import type {Job} from '../types/api';

/** One deploy (or rollback) in a list: status, package + badges, version → service, duration, age, second line. */
export function JobRow({job: j}: {job: Job}) {
  const l2 = jobLine2(j);
  return (
    <div className="jrow">
      <a href={'#/deploys/' + j.id} data-id={j.id} aria-label={(j.kind === 'rollback' ? 'Rollback ' : '') + j.package + ', ' + statusText(j.status) + ', ' + l2}>
        <StatusIcon status={j.status} />
        <span className="svc">
          {j.package}
          {j.kind === 'rollback' ? <span className="badge" style={{marginLeft: 8}}>Rollback</span> : null}
        </span>
        <span className="src">{(j.version || '') + ' → ' + (j.swarm_service || '')}</span>
        <span className="dur">{fmtDur(jobDur(j))}</span>
        <time dateTime={j.created_at || ''} title={localT(j.created_at)}>{fmtRel(j.created_at)}</time>
        <span className={'line2' + (j.status === 'failed' ? ' danger' : '')} title={l2}>{l2}</span>
      </a>
    </div>
  );
}
