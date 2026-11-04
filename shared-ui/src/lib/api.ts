/** Fetch wrapper for the tools' JSON APIs. Errors are {detail} bodies, surfaced as ApiError. */

export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

export interface ApiOptions {
  /** Message when the local server can't be reached (status 0). */
  offlineMessage?: string;
  /** Called before the error is thrown, e.g. to redirect to sign-in on a 401. */
  onError?: (err: ApiError, method: string, path: string) => void;
}

export type ApiFn = <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;

export function createApi(opts: ApiOptions = {}): ApiFn {
  return async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    let r: Response;
    try {
      r = await fetch(path, {
        method,
        headers: body !== undefined ? {'Content-Type': 'application/json'} : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, opts.offlineMessage || "Can't reach the local server.");
    }
    const txt = await r.text();
    let data: unknown = null;
    try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
    if (!r.ok) {
      let d = data && typeof data === 'object' ? (data as {detail?: unknown}).detail : undefined;
      if (Array.isArray(d)) d = d.map(x => (x && typeof x === 'object' && 'msg' in x ? String(x.msg) : String(x))).join('; ');
      const err = new ApiError(r.status, (typeof d === 'string' && d) || 'Request failed (' + r.status + ')');
      opts.onError?.(err, method, path);
      throw err;
    }
    return data as T;
  };
}

/** Narrow an unknown catch value to an ApiError-like shape for display. */
export function errDetail(e: unknown): {status: number; detail: string} {
  if (e instanceof ApiError) return e;
  return {status: -1, detail: e instanceof Error ? e.message : String(e)};
}
