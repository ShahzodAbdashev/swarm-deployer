import {MenuButton, StatusIcon, fmtRel} from '@devtools/ui';
import {tagOf} from '../../lib/format';
import {router, startWizard} from '../../router';
import {session} from '../../state/session';
import type {Service} from '../../types/api';

/** One deployed service: last deploy status, package → service @ target, running version, live state line, actions. */
export function ServiceRow({s}: {s: Service}) {
  const last = s.last_deploy;
  let l2: string, cls = '';
  if (s.error) { l2 = 'Target unreachable: ' + s.error; cls = ' danger'; }
  else if (!s.exists) { l2 = 'Not found on target'; cls = ' warning'; }
  else {
    const p = [s.replicas_running + '/' + s.replicas_desired + ' running', s.current_image || ''];
    if (last) p.push('last deploy ' + (last.status === 'success' ? '✓' : last.status === 'failed' ? '✗' : '●') + ' ' + (last.finished_at ? fmtRel(last.finished_at) : 'running'));
    l2 = p.join(' · ');
  }
  const href = '#/services/' + encodeURIComponent(s.package);
  return (
    <div className="srow">
      <a href={href} data-id={s.package} aria-label={s.package + ', ' + l2}>
        <StatusIcon status={last ? last.status : 'pending'} />
        <span className="pk">{s.package}</span>
        <span className="to">{'→ ' + s.swarm_service + ' @ ' + s.target}</span>
        <span className="ver">{s.current_image ? tagOf(s.current_image) : ''}</span>
        <span className={'line2' + cls} title={l2}>{l2}</span>
      </a>
      <MenuButton label={'Actions for ' + s.package} className="icon more" items={() => [
        {label: 'Deploy new version', icon: 'up', run: () => startWizard(s.package)},
        {label: 'Backups & rollback', icon: 'undo', run: () => { session.scrollTo = 'backups'; router.go(href); }},
        {label: 'History', run: () => { session.scrollTo = 'history'; router.go(href); }},
      ]} />
    </div>
  );
}
