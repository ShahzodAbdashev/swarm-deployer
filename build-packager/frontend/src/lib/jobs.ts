import {fmtSize, parseT} from '@devtools/ui';
import type {Job, Step, StepName, UploadConfig} from '../types/api';

export const STEPS: StepName[] = ['prepare', 'clone', 'build', 'save', 'extra_repos', 'zip', 'upload'];

export const STEP_LABEL: Record<StepName, string> = {
  prepare: 'Prepare workspace', clone: 'Clone repository', build: 'Build image', save: 'Save image (.tar)',
  extra_repos: 'Clone extra repositories', zip: 'Encrypt zip', upload: 'Upload',
};

export const jobActive = (j: Pick<Job, 'status'> | null | undefined): boolean => !!j && (j.status === 'running' || j.status === 'queued');

export function jobDur(j: Job): number | null {
  const a = parseT(j.created_at), b = j.finished_at ? parseT(j.finished_at)! : Date.now();
  return a ? b - a : null;
}

export function curStep(job: Job): {i: number; s: Step} | null {
  const i = job.steps.findIndex(s => s.status === 'running');
  return i < 0 ? null : {i, s: job.steps[i]};
}

export const failedStep = (job: Job): Step | null => job.steps.find(s => s.status === 'failed') || null;

/** Second line of a dashboard row. */
export function jobLine2(j: Job): string {
  if (j.status === 'running') { const c = curStep(j); return c ? 'Running · ' + STEP_LABEL[c.s.name] + ' (' + (c.i + 1) + '/' + j.steps.length + ')' : 'Running'; }
  if (j.status === 'queued') return 'Queued';
  if (j.status === 'success') return 'Succeeded · zip ' + fmtSize(j.artifacts.zip_size) + (j.artifacts.remote_path ? ' · uploaded' : ' · saved locally');
  const f = failedStep(j);
  return 'Failed at ' + (f ? STEP_LABEL[f.name] : 'start') + (j.error ? ' · ' + j.error : '');
}

const HINT: Partial<Record<StepName, string>> = {
  prepare: 'The build folder already exists. Try again in a second.',
  clone: 'Check the branch name and that you have access to the repository. If you gave a GitLab project, check your GitLab sign-in.',
  save: 'Check free disk space.', zip: 'Check free disk space.',
  extra_repos: 'Check the extra repository URL and branch.',
  upload: 'Test the connection in Settings. The zip is still available to download.',
};

export function hintFor(job: Job, f: Step | null): string {
  if (job.error === 'interrupted (server restart)') return 'The server restarted while this build was running. Start it again.';
  if (!f) return '';
  if (f.name === 'build') return /^Dockerfile not found/.test(job.error || '') ? 'Check the Dockerfile path in Advanced options.' : 'See the docker build output in the log. Check the preload tar paths and the .env.';
  return HINT[f.name] || '';
}

export const uploadConfigured = (c: UploadConfig | null | undefined): boolean => !!(c && c.enabled && c.host);

export function uploadTarget(c: UploadConfig, withUser: boolean, dirOverride?: string): string {
  const rd = dirOverride || c.remote_dir;
  const dir = rd ? (rd.startsWith('/') ? rd : '/' + rd) : '/';
  const share = c.protocol === 'smb' && c.share ? '/' + c.share : '';
  return c.protocol + '://' + (withUser && c.username ? c.username + '@' : '') + c.host + ':' + c.port + share + dir;
}
