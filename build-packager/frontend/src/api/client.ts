import {createApi, toast} from '@devtools/ui';
import {router} from '../router';
import {session, setAuth} from '../state/session';

/** Shared fetch wrapper. A 401 from a GitHub/GitLab endpoint means the token expired: back to sign-in. */
export const api = createApi({
  offlineMessage: "Can't reach the local server. Is ./run.sh running?",
  onError(err, _method, path) {
    const seg = path.split('/')[2];
    if (err.status === 401 && (seg === 'github' || seg === 'gitlab') && !router.current().hash.startsWith('#/login')) {
      toast((seg === 'github' ? 'GitHub' : 'GitLab') + ' session expired. Sign in again.', 'error');
      setAuth({logged_in: false, provider: null});
      session.repos = null;
      router.go('#/login');
    }
  },
});
