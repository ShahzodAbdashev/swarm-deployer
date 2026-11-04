import {createApi} from '@devtools/ui';

/** Shared fetch wrapper; errors are ApiError({status, detail}). */
export const api = createApi({
  offlineMessage: "Can't reach the local server. Is ./run.sh running?",
});
