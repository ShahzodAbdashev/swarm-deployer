import {useEffect, useState, type ReactNode} from 'react';
import {Alert, StepHead, errDetail, toast} from '@devtools/ui';
import {configApi, deploysApi} from '../../../api/endpoints';
import {basename, movingText} from '../../../lib/format';
import {router} from '../../../router';
import {draftVersion, getDraft, resetDraft} from '../../../state/draft';
import {session} from '../../../state/session';
import type {DeployPlan} from '../../../types/api';
import type {StepProps} from '../stepApi';

/** Wrong zip password (from plan or create): back to the password step with the error on its field. */
function toPassword(detail: string): void {
  session.pendingErr = {step: 'password', field: 'zip_password', msg: detail};
  session.fromReview = true;
  router.go('#/new/password', true);
}

/**
 * Step 3: where it goes is worked out, not picked: SERVICE_NAME / DEV_IMAGE_TAG / HEALTHCHECK_URL from the
 * .gitlab-ci.yml in the zip (else the last deploy of this package), the image repo from the running service.
 */
export function ReviewStep({register, setNextBusy, setFormAlert}: StepProps) {
  const d = getDraft();
  const [plan, setPlan] = useState<DeployPlan | null>(null);
  const [planErr, setPlanErr] = useState<string | null>(null);
  const [saveTar, setSaveTar] = useState(!!session.saveTar);
  useEffect(() => {
    let dead = false;
    if (session.saveTar === null) configApi.get().then(c => { session.saveTar = !!c.options?.save_image_tar; if (!dead) setSaveTar(session.saveTar); }).catch(() => {});
    deploysApi.plan(d.package_path, d.password).then(p => { if (!dead) setPlan(p); }).catch(e => {
      if (dead) return;
      const {status, detail} = errDetail(e);
      if (status === 400 && /^password:/.test(detail)) toPassword(detail);
      else setPlanErr(detail);
    });
    return () => { dead = true; };
  }, [d.package_path, d.password]);

  const submit = async () => {
    setFormAlert(null);
    const body = {package_path: d.package_path, password: d.password, save_image_tar: session.saveTar};
    setNextBusy('Starting…');
    let job;
    try { job = await deploysApi.create(body); }
    catch (e) {
      setNextBusy(null);
      body.password = '';
      const {status, detail} = errDetail(e);
      if (status === 400 && /^password:/.test(detail)) { toPassword(detail); return; }
      if (status === 0) { toast("Can't reach the local server.", 'error', {label: 'Retry', run: () => void submit()}); return; }
      setFormAlert(<div style={{marginTop: 'var(--s5)'}}><Alert kind="error"><span>{detail}</span></Alert></div>);
      return;
    }
    body.password = '';
    resetDraft();
    router.setLeaveGuard(null);
    location.replace('#/deploys/' + job.id);
  };
  register({validate: () => (plan ? [] : [['review-plan', planErr || 'Still working out where it goes…']]), submit, first: () => null});

  const rows: ReactNode[] = [];
  const row = (label: string, value: ReactNode, step?: string, mono?: boolean) => rows.push(
    <div key={label}>
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : ''}>{value}</dd>
      <dd className="e">{step ? <a href={'#/new/' + step} aria-label={'Edit ' + label} onClick={() => { session.fromReview = true; }}>Edit</a> : null}</dd>
    </div>,
  );
  row('Package', basename(d.package_path), 'package', true);
  row('Password', '•••••••• set', 'password');
  const ver = draftVersion();
  if (planErr) row('Service', <span className="danger" id="review-plan">{planErr}</span>);
  else if (!plan) row('Service', <span id="review-plan">Working out where it goes…</span>);
  else {
    const v = ver || '<deploy time>', loaded = ver ? d.package.toLowerCase() + ':' + ver : 'the image in the tar';
    const from = plan.source === 'gitlab-ci' ? ' (SERVICE_NAME in .gitlab-ci.yml)' : ' (same as the last deploy)';
    row('Service', <span id="review-plan">{plan.swarm_service + ' on ' + plan.target_name + from}</span>);
    const tag = movingText(plan.moving_tag, plan.current_image) || v;  // the service keeps this name (DEV_IMAGE_TAG)
    row('Image', loaded + ' → ' + plan.image_repo + ':' + tag + ', service updated to it'
      + (plan.registry ? ' · push to ' + plan.registry : ''), undefined, true);
    row('Health check', plan.health_url || 'None (the rollout must converge)', undefined, !!plan.health_url);
    row('Backup', 'Current image ' + plan.current_image + ' will be tagged ' + plan.image_repo + ':backup-<when started>'
      + (saveTar ? ' (+ .tar)' : '') + (plan.registry ? ', pushed' : ''));
    row('On failure', 'Automatic rollback to the backup image (' + plan.image_repo + ':backup-<when started>), run under the same name '
      + plan.current_image);
  }
  return (
    <>
      <StepHead title="Review and deploy" sub="Nothing has changed on the server yet." />
      <dl className="review">{rows}</dl>
      <label className="cbx" style={{marginTop: 'var(--s5)'}}>
        <input type="checkbox" id="save_tar" checked={saveTar} onChange={e => { session.saveTar = e.target.checked; setSaveTar(e.target.checked); }} />
        <span>Also save the current image as a .tar backup<span className="help" style={{display: 'block'}}>Slower, but the rollback still works if the backup tag is removed.</span></span>
      </label>
    </>
  );
}
