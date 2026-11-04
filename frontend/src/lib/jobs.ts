import {parseT} from '@devtools/ui';
import type {Job, Phase} from '../types/api';

const PLABEL: Record<string, string> = {
  fetch: 'Download package', extract: 'Unlock and check image', connect: 'Sign in to target', transfer: 'Upload image to target',
  backup: 'Back up current version', load: 'Load image', tag: 'Tag image', deploy: 'Update service', verify: 'Verify rollout', cleanup: 'Clean up',
};

/** Phase label; the tag phase also pushes when the job uses a registry. */
export function plabel(name: string, job?: Pick<Job, 'registry'> | null): string {
  return name === 'tag' && job?.registry ? 'Tag and push image' : PLABEL[name] || name;
}

/** "Try: …" hint on a failed run, per phase. */
export function phint(name: string, job?: Pick<Job, 'registry'> | null): string {
  if (name === 'tag' && job?.registry) return 'Check the registry login in the target settings.';
  if (name === 'verify') return PHINT.verify + ' If the package has .deploy/healthcheck.sh, see its output in the log.'
    + (job?.registry ? ' The moving tag is pushed to the registry only after these checks pass.' : '');
  return PHINT[name] || '';
}
const PHINT: Record<string, string> = {
  fetch: 'Check the file server in Settings and that the file still exists.',
  extract: 'Check the zip password. The package must come from Build Packager.',
  connect: 'Test the target in Settings. It must be a swarm manager.',
  transfer: 'Check free disk space in the work dir on the target.',
  backup: 'Check the backup dir permissions on the target.',
  load: 'See the docker load output in the log.', tag: 'See the log.',
  deploy: 'See the docker service update output in the log.',
  verify: 'The new version did not become healthy.',
  cleanup: 'Leftover files may remain in the work dir.',
};

/** (1) Build Packager <service>_<YYYYMMDD_HHMMSS>.zip, else (2) build_tar.sh <name>[_<ts>].tar.zip / <name>[_<ts>].zip (SPEC §11.1). */
const PKG_RE = /^([a-zA-Z0-9][a-zA-Z0-9_.-]{0,62})_(\d{8}_\d{6})\.zip$/;
const TARZIP_RE = /^([a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}?)(?:_(\d{8}_\d{6}))?(?:\.tar)?\.zip$/;
export function parsePkg(name: string): {service: string; ts: string | null; fmt: 'packager' | 'tarzip'} | null {
  const m = PKG_RE.exec(name);
  if (m) return {service: m[1], ts: m[2], fmt: 'packager'};
  const t = TARZIP_RE.exec(name);
  return t ? {service: t[1], ts: t[2] || null, fmt: 'tarzip'} : null;
}

export function phaseOf(job: Job, st: string): {i: number; p: Phase} | null {
  const ph = job.phases || [];
  const i = ph.findIndex(p => p.status === st);
  return i < 0 ? null : {i, p: ph[i]};
}
export function failedPhase(job: Job): Phase | null { return phaseOf(job, 'failed')?.p ?? null; }
export function jobDur(j: Job): number | null {
  const a = parseT(j.created_at), b = j.finished_at ? parseT(j.finished_at)! : Date.now();
  return a ? b - a : null;
}
export function jobActive(j: Pick<Job, 'status'> | null | undefined): boolean { return !!j && (j.status === 'running' || j.status === 'queued'); }

/** Second line of a deploy row: what is running, what was deployed, or where it failed. */
export function jobLine2(j: Job): string {
  if (jobActive(j)) {
    const c = phaseOf(j, 'running');
    return c ? 'Running · ' + plabel(c.p.name, j) + ' ('+ (c.i + 1) + '/' + j.phases.length + ')' : (j.status === 'queued' ? 'Queued' : 'Running');
  }
  if (j.status === 'success') return j.kind === 'rollback' ? 'Rolled back to ' + (j.new_image || '') : 'Succeeded · ' + (j.new_image || '');
  const f = failedPhase(j);
  return 'Failed at ' + (f ? plabel(f.name, j) : 'start') + (j.error ? ' · ' + j.error : '');
}

/** Deploy log line classes: skipped phases are dimmed, JSON dumps are never "errors", docker WARNINGs are amber. */
export function classifyDeployLine(text: string): string {
  if (text.startsWith('==> JOB SUCCESS')) return 'ok hd';
  if (/^==> \[\w+\] skipped/.test(text)) return 'dim';
  if (/failed|error|JOB FAILED/i.test(text) && !/^[{[]/.test(text)) return 'er' + (text.startsWith('==>') ? ' hd' : '');
  if (/^WARNING/.test(text)) return 'wr';
  if (text.startsWith('==>')) return 'hd' + (/ started$/.test(text) ? ' start' : '');
  if (text.startsWith('$ ')) return 'cmd';
  return '';
}
