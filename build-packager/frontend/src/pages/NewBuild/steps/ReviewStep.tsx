import {useEffect, useState, type ReactNode} from 'react';
import {Alert, StepHead, errDetail, toast} from '@devtools/ui';
import {jobsApi, uploadApi} from '../../../api/endpoints';
import {uploadConfigured, uploadTarget} from '../../../lib/jobs';
import {baseName, envKeys, preloadList} from '../../../lib/validate';
import {router} from '../../../router';
import {getDraft, resetDraft, useDraft} from '../../../state/draft';
import {session} from '../../../state/session';
import type {JobIn, UploadConfig} from '../../../types/api';
import type {StepProps} from '../stepApi';
import {mapDetail} from '../wizard';

/** Step 5: summary with an Edit link per row, then start the build. */
export function ReviewStep({register, setNextBusy, setFormAlert}: StepProps) {
  const d = useDraft();
  const [up, setUp] = useState<UploadConfig | null | undefined>(session.uploadCfg);
  useEffect(() => {
    uploadApi.get().then(c => { session.uploadCfg = c; setUp(c); }).catch(() => { session.uploadCfg = null; setUp(null); });
  }, []);

  const fail = (msg: string) => setFormAlert(<div style={{marginTop: 'var(--s5)'}}><Alert kind="error"><span>{msg}</span></Alert></div>);

  const submit = async () => {
    const D = getDraft();
    const b: JobIn = {
      service: D.service, repo_url: D.repo_url, branch: D.branch, dockerfile: D.dockerfile || 'Dockerfile', build_command: D.build_command,
      extra_repos: D.extra_repos.map(x => ({url: x.url, branch: x.branch || 'main', name: x.name || undefined})),
      password: D.password, password_confirm: D.password_confirm,
      upload: !!(D.upload && uploadConfigured(session.uploadCfg)),
      remote_dir: D.upload && D.remote_dir ? D.remote_dir : undefined,
      env: D.env_mode === 'none' ? null : {content: D.env_content, path: D.env_path || '.env', source: D.env_source},
      preload_tars: preloadList(D.preload_tars),
    };
    if (b.env && !b.env.content.trim()) {
      session.pendingErr = {step: 'source', field: 'env', msg: "Add the .env content. It isn't kept after a reload."};
      session.fromReview = true;
      return router.go('#/new/source', true);
    }
    // client-side mirror of the server's password rules
    if (b.password.length < 4) { session.pendingErr = {step: 'password', field: 'password', msg: 'At least 4 characters.'}; session.fromReview = true; return router.go('#/new/password', true); }
    if (b.password !== b.password_confirm) { session.pendingErr = {step: 'password', field: 'password_confirm', msg: "Passwords don't match."}; session.fromReview = true; return router.go('#/new/password', true); }
    setFormAlert(null);
    setNextBusy('Starting…');
    let job;
    try { job = await jobsApi.create(b); }
    catch (e) {
      setNextBusy(null);
      const {status, detail} = errDetail(e);
      if (status === 400) {
        const m = mapDetail(detail);
        if (m) { session.pendingErr = m; session.fromReview = true; toast('Fix 1 issue before starting.', 'error'); return router.go('#/new/' + m.step, true); }
        fail(detail);
      } else if (status === 409) fail('A build for ' + D.service + ' started this same second. Wait a moment and try again.');
      else if (status === 0) toast("Can't reach the local server.", 'error', {label: 'Retry', run: () => { void submit(); }});
      else fail(detail);
      return;
    }
    b.password = ''; b.password_confirm = ''; b.env = null;
    resetDraft();
    router.setLeaveGuard(null);
    location.replace('#/jobs/' + job.id);
  };
  register({validate: () => [], submit, first: () => null});

  const rows: ReactNode[] = [];
  const row = (label: string, value: string, step: string, mono?: boolean) => rows.push(
    <div key={label}>
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : ''}>{value}</dd>
      <dd className="e"><a href={'#/new/' + step} aria-label={'Edit ' + label} onClick={() => { session.fromReview = true; }}>Edit</a></dd>
    </div>,
  );
  row('Repository', d.repo_full || d.repo_url, 'repo', true);
  row('Branch', d.branch, 'source', true);
  row('Service', d.service + '  →  ' + d.service + '_<timestamp>.zip', 'source', true);
  row('Dockerfile', d.dockerfile || 'Dockerfile', 'source', true);
  if (d.build_command) row('Build command', d.build_command, 'source', true);
  if (d.extra_repos.length) row('Extra repos', d.extra_repos.map(x => (x.name || baseName(x.url)) + ' (' + (x.branch || 'main') + ')').join(', '), 'source', true);
  const ENV_SRC = {gitlab: 'from GitLab CI', file: 'from file', paste: 'pasted'} as const;
  row('.env', d.env_mode === 'none' ? 'None' : envKeys(d.env_content).length + ' keys → ' + (d.env_path || '.env') + ' (' + ENV_SRC[d.env_source] + ')', 'source', d.env_mode !== 'none');
  const pre = preloadList(d.preload_tars).length;
  if (pre) row('Preload', pre + (pre === 1 ? ' image tar' : ' image tars'), 'source');
  row('Password', '•••••••• set', 'password');
  const on = uploadConfigured(up) && d.upload;
  row('Upload', up === undefined ? 'Checking…' : on ? uploadTarget(up!, false, d.remote_dir) : 'Off — saved on this computer', 'upload', on);
  return (
    <>
      <StepHead title="Review and start" sub="Nothing has been built yet." />
      <dl className="review">{rows}</dl>
    </>
  );
}
