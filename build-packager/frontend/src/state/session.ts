import {useSyncExternalStore} from 'react';
import type {ApiError} from '@devtools/ui';
import type {AuthStatus, Branch, EnvPreview, Repo, UploadConfig} from '../types/api';

/** API error mapped to a wizard step + field (from a 400 on POST /api/jobs). */
export interface PendingErr { step: string; field: string; msg: string }

/**
 * In-memory, per-tab state that outlives a page: caches and wizard flags.
 * Never persisted; reloading the tab starts over (passwords included, by design).
 */
export const session = {
  repos: null as Repo[] | null,
  reposErr: null as ApiError | null,
  reposLoading: null as Promise<void> | null,
  /** Provider the cached repos came from. */
  reposFor: null as 'github' | 'gitlab' | null,
  branches: {} as Record<string, Branch[]>,
  /** undefined = not loaded yet, null = failed to load. */
  uploadCfg: undefined as UploadConfig | null | undefined,
  /** One-shot info shown on the next wizard step (rebuild note, reload note). */
  note: null as string | null,
  fromReview: false,
  /** Repo step: paste-a-URL mode instead of the GitHub list. */
  urlMode: null as boolean | null,
  /** Wizard steps where Next was pressed (errors show live from then on). */
  tried: {} as Record<string, boolean>,
  pendingErr: null as PendingErr | null,
  /** Where to go after sign-in. */
  returnTo: null as string | null,
  /** Last .env preview from GitLab, without its values (key names, sources, missing vars). */
  envMeta: null as Omit<EnvPreview, 'content'> | null,
};

// ---------------------------------------------------------------- auth (reactive)

let auth: AuthStatus | null = null;
const subs = new Set<() => void>();

export function getAuth(): AuthStatus | null { return auth; }
export function setAuth(patch: Partial<AuthStatus>): void {
  auth = {
    logged_in: false, login: null, avatar_url: null, device_flow_available: false, provider: null, oauth_error: null,
    github: {logged_in: false, login: null},
    gitlab: {logged_in: false, login: null, avatar_url: null, url: '', method: null, oauth_available: false},
    ...auth, ...patch,
  };
  subs.forEach(f => f());
}
export function useAuth(): AuthStatus | null {
  return useSyncExternalStore(cb => { subs.add(cb); return () => { subs.delete(cb); }; }, () => auth);
}
