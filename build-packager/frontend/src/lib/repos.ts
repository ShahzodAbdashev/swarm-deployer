import {ApiError} from '@devtools/ui';
import {githubApi, gitlabApi} from '../api/endpoints';
import {getAuth, session} from '../state/session';

/** Load the user's repos (GitLab projects when signed in to GitLab) once per tab; the dashboard warms it. */
export function prefetchRepos(): Promise<void> | null {
  const p = getAuth()?.provider === 'gitlab' ? 'gitlab' : 'github';
  if (session.reposFor !== p) Object.assign(session, {repos: null, reposErr: null, reposFor: p});
  if (session.repos || session.reposLoading) return session.reposLoading;
  session.reposErr = null;
  session.reposLoading = (p === 'gitlab' ? gitlabApi.projects() : githubApi.repos())
    .then(r => { session.repos = r || []; })
    .catch(e => { session.reposErr = e instanceof ApiError ? e : new ApiError(-1, String(e)); })
    .finally(() => { session.reposLoading = null; });
  return session.reposLoading;
}
