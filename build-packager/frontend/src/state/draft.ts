import {useSyncExternalStore} from 'react';
import {sget, sset} from '@devtools/ui';
import type {EnvSource} from '../types/api';
import {session} from './session';

/** The New build wizard's form. Kept in sessionStorage (minus passwords) so a reload keeps the user's place. */
export interface Draft {
  repo_full: string;
  repo_url: string;
  default_branch: string;
  service: string;
  service_edited: boolean;
  branch: string;
  dockerfile: string;
  build_command: string;
  extra_repos: {url: string; branch: string; name: string}[];
  upload: boolean;
  remote_dir: string;
  env_mode: 'none' | 'content' | 'gitlab';
  env_path: string;
  env_job: string;
  env_source: EnvSource;
  /** One absolute path per line. */
  preload_tars: string;
  /** Memory only: never written to storage or the URL. */
  password: string;
  password_confirm: string;
  /** Memory only, like the password: the .env holds secrets. */
  env_content: string;
}

const KEY = 'bp.draft';
const PERSISTED = ['repo_full', 'repo_url', 'default_branch', 'service', 'service_edited', 'branch', 'dockerfile',
  'build_command', 'extra_repos', 'upload', 'remote_dir', 'env_mode', 'env_path', 'env_job', 'env_source', 'preload_tars'] as const;

export const draftDefaults = (): Draft => ({
  repo_full: '', repo_url: '', default_branch: '', service: '', service_edited: false, branch: '',
  dockerfile: 'Dockerfile', build_command: '', extra_repos: [], upload: true, remote_dir: '', password: '', password_confirm: '',
  env_mode: 'none', env_path: '.env', env_job: 'export_env', env_source: 'paste', preload_tars: '', env_content: '',
});

function load(): Draft {
  try {
    const v = JSON.parse(sget(KEY) || 'null');
    if (v && typeof v === 'object') return {...draftDefaults(), ...v, password: '', password_confirm: '', env_content: ''};
  } catch { /* corrupt draft: start fresh */ }
  return draftDefaults();
}

let draft: Draft = load();
const subs = new Set<() => void>();

function persist() {
  const o: Record<string, unknown> = {};
  for (const k of PERSISTED) o[k] = draft[k];
  sset(KEY, JSON.stringify(o));
}

export function getDraft(): Draft { return draft; }

export function updateDraft(patch: Partial<Draft>): void {
  // a .env generated from GitLab belongs to its repo, branch and job: drop it when one of them changes
  const stale = draft.env_source === 'gitlab' && !!draft.env_content && !('env_content' in patch)
    && (['repo_url', 'branch', 'env_job'] as const).some(k => k in patch && patch[k] !== draft[k]);
  draft = {...draft, ...patch, ...(stale ? {env_content: ''} : {})};
  if (stale) session.envMeta = null;
  persist();
  subs.forEach(f => f());
}

/** Replace the whole draft (rebuild from a finished job). */
export function setDraft(d: Draft): void { draft = d; persist(); subs.forEach(f => f()); }

export function resetDraft(): void {
  draft = draftDefaults();
  sset(KEY, null);
  Object.assign(session, {note: null, fromReview: false, urlMode: null, tried: {}, pendingErr: null, envMeta: null});
  subs.forEach(f => f());
}

export function draftDirty(): boolean { return !!(draft.repo_url || draft.password || draft.password_confirm || draft.env_content); }

export function useDraft(): Draft {
  return useSyncExternalStore(cb => { subs.add(cb); return () => { subs.delete(cb); }; }, () => draft);
}
