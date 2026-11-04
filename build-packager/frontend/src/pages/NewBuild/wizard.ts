import {confirm, type LeaveGuard} from '@devtools/ui';
import {repoFullFromUrl} from '../../lib/validate';
import {router} from '../../router';
import {draftDefaults, draftDirty, resetDraft, setDraft} from '../../state/draft';
import {session} from '../../state/session';
import type {Job} from '../../types/api';

const DISCARD = {title: 'Discard this build?', body: 'Nothing has been built yet.', cancel: 'Keep editing', confirm: 'Discard'};

export async function wizardCancel(): Promise<void> {
  if (draftDirty() && !(await confirm(DISCARD))) return;
  resetDraft();
  router.setLeaveGuard(null);
  router.go('#/dashboard');
}

/** Leaving the wizard with data asks first; moving between steps or to Settings (and back) doesn't. */
export const wizardGuard: LeaveGuard = target =>
  /^#\/(new|settings)(\/|$)/.test(target) || !draftDirty() ? null : {...DISCARD, onDiscard: resetDraft};

/** Start a new build with a finished job's settings; the password (and the .env content) must be entered again. */
export function rebuild(j: Job): void {
  resetDraft();
  const env = j.env || null;
  setDraft({
    ...draftDefaults(),
    repo_url: j.repo_url, repo_full: repoFullFromUrl(j.repo_url), branch: j.branch, service: j.service, service_edited: true,
    dockerfile: j.dockerfile || 'Dockerfile', build_command: j.build_command || '',
    extra_repos: (j.extra_repos || []).map(x => ({url: x.url, branch: x.branch, name: x.name || ''})),
    upload: j.upload_requested !== false, remote_dir: j.remote_dir || '',
    env_mode: env ? (env.source === 'gitlab' ? 'gitlab' : 'content') : 'none', env_path: env?.path || '.env',
    env_source: env?.source || 'paste', preload_tars: (j.preload_tars || []).join('\n'),
  });
  if (env) {
    session.note = 'Settings copied from ' + j.folder_name + ". Add the .env again; it isn't kept.";
    router.go('#/new/source');
    return;
  }
  session.note = 'Settings copied from ' + j.folder_name + '. Enter a zip password to continue.';
  router.go('#/new/password');
}

/** Map a 400 detail like "extra_repos[1].name: ..." to the wizard step and field that caused it. */
export function mapDetail(detail: string): {step: string; field: string; msg: string} | null {
  const m = /^([a-z_ ]+?)(\[(\d+)\])?(\.(\w+))?\s*:\s*/i.exec(detail || '');
  if (!m) return null;
  const k = m[1].trim().toLowerCase();
  const map: Record<string, [string, string]> = {
    repo_url: ['repo', 'repo'], service: ['source', 'service'], branch: ['source', 'branch'], dockerfile: ['source', 'dockerfile'],
    build_command: ['source', 'build_command'], extra_repos: ['source', 'extra'], 'extra repo': ['source', 'extra'],
    password: ['password', 'password'], remote_dir: ['upload', 'remote_path'],
    env: ['source', 'env'], preload_tars: ['source', 'preload_tars'],
  };
  if (!map[k]) return null;
  let [step, field] = map[k];
  if (k === 'env' && (m[5] === 'content' || m[5] === 'path')) field = 'env_' + m[5];
  if (field === 'extra' && m[3] !== undefined && m[5]) field = 'x-' + ({url: 'url', branch: 'branch', name: 'name'}[m[5]] || 'url') + '-' + m[3];
  return {step, field, msg: detail};
}
