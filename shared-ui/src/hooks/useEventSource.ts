import {useEffect, useRef} from 'react';

export interface EventSourceHandlers {
  open?: () => void;
  /** One log line per event. */
  log?: (data: string) => void;
  /** JSON job snapshot. */
  status?: (data: string) => void;
  /** Stream finished; the source is already closed. */
  end?: (data: string) => void;
  error?: (es: EventSource, ended: boolean) => void;
}

/**
 * Server-Sent Events for job logs (events: log, status, end). Pass url=null to stay disconnected.
 * Handlers can change between renders without reconnecting.
 */
export function useEventSource(url: string | null, handlers: EventSourceHandlers): void {
  const h = useRef(handlers);
  h.current = handlers;
  useEffect(() => {
    if (!url) return;
    const es = new EventSource(url);
    let ended = false;
    es.addEventListener('open', () => h.current.open?.());
    es.addEventListener('log', e => h.current.log?.((e as MessageEvent).data));
    es.addEventListener('status', e => h.current.status?.((e as MessageEvent).data));
    es.addEventListener('end', e => { ended = true; es.close(); h.current.end?.((e as MessageEvent).data); });
    es.onerror = () => h.current.error?.(es, ended);
    return () => es.close();
  }, [url]);
}

/** setInterval that always calls the latest callback; ms=null pauses it. */
export function useInterval(fn: () => void, ms: number | null): void {
  const f = useRef(fn);
  f.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const t = setInterval(() => f.current(), ms);
    return () => clearInterval(t);
  }, [ms]);
}
