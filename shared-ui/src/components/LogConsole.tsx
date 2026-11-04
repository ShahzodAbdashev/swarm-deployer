import {forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ForwardedRef} from 'react';
import {copyText} from '../lib/browser';
import {toast} from './Feedback';
import {Icon} from './Icon';
import './LogConsole.css';

/*
 * Log format shared by both tools' job logs:
 *   [HH:MM:SS] ==> [step] started | success: ... | failed: ...
 *   [HH:MM:SS] $ command
 *   [HH:MM:SS] ==> JOB SUCCESS | JOB FAILED
 */

export interface LogLine {
  id: number;
  ts: string;
  text: string;
  /** CSS class: ok hd | er [hd] | hd [start] | cmd | dim | '' */
  cls: string;
  /** Set on "==> [name] started" lines. */
  start?: string;
}

/** Default line classes; an app can pass its own `classify` to useLogBuffer. */
export function defaultLogClass(text: string): string {
  let cls = '';
  if (text.startsWith('==> JOB SUCCESS')) cls = 'ok hd';
  else if (/failed|error|JOB FAILED/i.test(text)) cls = 'er' + (text.startsWith('==>') ? ' hd' : '');
  else if (text.startsWith('==>')) cls = 'hd' + (/ started$/.test(text) ? ' start' : '');
  else if (text.startsWith('$ ')) cls = 'cmd';
  return cls;
}

export function parseLogLine(raw: string, id: number, classify: (text: string) => string = defaultLogClass): LogLine {
  const m = /^\[(\d\d:\d\d:\d\d)\] ?(.*)$/.exec(raw);
  const ts = m ? m[1] : '', text = m ? m[2] : raw;
  const cls = classify(text);
  const sm = /^==> \[(\w+)\] started/.exec(text);
  return {id, ts, text, cls, start: sm ? sm[1] : undefined};
}

export function dimLine(text: string, id: number): LogLine { return {id, ts: '', text, cls: 'dim'}; }

/**
 * Append-only line buffer with rAF batching and a cap (oldest dropped). `capped` turns true once lines were dropped.
 * `onLines` sees every appended batch (for derived state such as "last message").
 */
export function useLogBuffer({cap = 5000, initial, classify}: {cap?: number; initial?: string; classify?: (text: string) => string} = {}) {
  const nextId = useRef(1);
  const [state, setState] = useState<{lines: LogLine[]; capped: boolean}>(() => ({
    lines: initial ? [dimLine(initial, 0)] : [], capped: false,
  }));
  const queue = useRef<string[]>([]);
  const raf = useRef(0);
  const flush = useCallback(() => {
    raf.current = 0;
    const batch = queue.current.splice(0);
    if (!batch.length) return;
    setState(s => {
      let lines = s.lines.concat(batch.map(l => parseLogLine(l, nextId.current++, classify)));
      let capped = s.capped;
      if (lines.length > cap) { lines = lines.slice(lines.length - cap); capped = true; }
      return {lines, capped};
    });
  }, [cap, classify]);
  const append = useCallback((raw: string) => {
    queue.current.push(raw);
    if (!raf.current) raf.current = requestAnimationFrame(flush);
  }, [flush]);
  const clear = useCallback(() => {
    queue.current = [];
    if (raf.current) { cancelAnimationFrame(raf.current); raf.current = 0; }
    setState({lines: [], capped: false});
  }, []);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  return {lines: state.lines, capped: state.capped, append, clear};
}

export interface LogConsoleHandle {
  /** Show the console, scroll to the line and flash it. */
  jumpTo(lineId: number): void;
}

export interface LogConsoleProps {
  lines: LogLine[];
  capped?: boolean;
  /** Connection indicator: '' | 'on' | 'warn' and its text. */
  live: {cls: string; text: string};
  shown: boolean;
  onShownChange: (shown: boolean) => void;
  downloadHref: string;
  label?: string;
}

/** Monospace log viewer: follows the tail, "Jump to latest" chip when scrolled up, copy/download/wrap/hide toolbar. */
export const LogConsole = forwardRef(function LogConsole(
  {lines, capped, live, shown, onShownChange, downloadHref, label = 'Build log'}: LogConsoleProps,
  ref: ForwardedRef<LogConsoleHandle>,
) {
  const log = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const [wrap, setWrap] = useState(() => matchMedia('(max-width:480px)').matches);
  const programmatic = useRef(false);
  const lastId = useRef(0);
  const followRef = useRef(follow);
  followRef.current = follow;

  const toBottom = () => {
    const el = log.current;
    if (!el) return;
    programmatic.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => { programmatic.current = false; });
  };

  // new lines: follow the tail, or count them for the chip
  useLayoutEffect(() => {
    const last = lines.length ? lines[lines.length - 1].id : 0;
    if (!lines.length) { setNewCount(0); lastId.current = 0; return; }
    const added = last > lastId.current ? last - lastId.current : 0;
    lastId.current = last;
    if (followRef.current) toBottom(); else if (added) setNewCount(n => n + added);
  }, [lines]);

  useLayoutEffect(() => { if (shown && followRef.current) toBottom(); }, [shown]);

  const resume = () => { setFollow(true); setNewCount(0); toBottom(); };
  const onScroll = () => {
    const el = log.current;
    if (programmatic.current || !el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom && !followRef.current) { setFollow(true); setNewCount(0); }
    else if (!atBottom && followRef.current) setFollow(false);
  };

  useImperativeHandle(ref, () => ({
    jumpTo(lineId: number) {
      onShownChange(true);
      requestAnimationFrame(() => {
        const box = log.current, el = box?.querySelector<HTMLElement>('[data-line="' + lineId + '"]');
        if (!box || !el) return;
        setFollow(false);
        programmatic.current = true;
        el.scrollIntoView({block: 'center'});
        box.scrollTop = Math.max(0, el.offsetTop - box.clientHeight / 3);
        requestAnimationFrame(() => { programmatic.current = false; });
        el.classList.add('hl');
        setTimeout(() => el.classList.remove('hl'), 1500);
      });
    },
  }), [onShownChange]);

  const copy = async () => {
    const txt = lines.filter(l => l.cls !== 'dim').map(l => (l.ts ? '[' + l.ts + ']' : '') + l.text).join('\n');
    if (await copyText(txt)) toast('Log copied');
  };

  return (
    <section className="logs" aria-labelledby="logs-h">
      <div className="logbar">
        <h2 id="logs-h">Logs</h2>
        <span className={'live ' + live.cls}><i /><span>{live.text}</span></span>
        <span className="spacer" />
        <button className="btn ghost" type="button" aria-label="Copy log" onClick={copy}><Icon name="copy" /><span className="hide-sm">Copy log</span></button>
        <a className="btn ghost" href={downloadHref} target="_blank" rel="noopener" aria-label="Download log"><Icon name="download" /><span className="hide-sm">Download log</span></a>
        <button className="btn ghost" type="button" aria-label="Wrap" aria-pressed={wrap} onClick={() => setWrap(!wrap)}><Icon name="wrap" /><span className="hide-sm">Wrap</span></button>
        <button className="btn ghost" type="button" aria-expanded={shown} aria-controls="log-box" onClick={() => onShownChange(!shown)}>
          <Icon name="chevron-down" style={{transform: shown ? 'rotate(180deg)' : ''}} />{shown ? 'Hide' : 'Show'}
        </button>
      </div>
      <div className="console" id="log-box" hidden={!shown}>
        <div className={'log' + (wrap ? ' wrap' : '')} role="log" aria-live="off" aria-label={label} tabIndex={0} ref={log} onScroll={onScroll}
          onKeyDown={e => { if (e.key === 'End') resume(); }}>
          {capped ? <div className="dim">Earlier lines hidden. Download the full log.</div> : null}
          {lines.map(l => (
            <div key={l.id} className={l.cls} data-line={l.id}>
              {l.ts ? <span className="ts">{'[' + l.ts + ']'}</span> : null}<span>{l.text}</span>
            </div>
          ))}
        </div>
        <button className="jump" type="button" hidden={follow} onClick={resume}>{'↓ Jump to latest' + (newCount ? ' (' + newCount + ' new)' : '')}</button>
      </div>
    </section>
  );
});
