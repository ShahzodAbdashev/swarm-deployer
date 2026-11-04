import type {CSSProperties, ReactNode} from 'react';

/** Inline SVG icon set (16px grid, stroke icons). */
const PATHS: Record<string, ReactNode> = {
  github: <path fill="currentColor" stroke="none" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />,
  check: <path d="M3 8.5l3.2 3L13 4.5" />,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  circle: <circle cx="8" cy="8" r="5.5" />,
  dash: <path d="M4.5 8h7" />,
  spinner: <><circle cx="8" cy="8" r="5.5" opacity=".25" /><path d="M8 2.5a5.5 5.5 0 015.5 5.5" /></>,
  'chevron-down': <path d="M4 6l4 4 4-4" />,
  'chevron-left': <path d="M10 4L6 8l4 4" />,
  plus: <path d="M8 3v10M3 8h10" />,
  search: <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></>,
  lock: <><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 015 0v2" /></>,
  eye: <><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></>,
  'eye-off': <path d="M2 2l12 12M6.6 6.6a2 2 0 002.8 2.8M4.2 4.6C2.5 5.8 1.5 8 1.5 8S4 12.5 8 12.5c1.3 0 2.5-.5 3.5-1.1M7 3.6c.3 0 .7-.1 1-.1 4 0 6.5 4.5 6.5 4.5s-.5.9-1.4 2" />,
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5V4a1.5 1.5 0 00-1.5-1.5H4A1.5 1.5 0 002.5 4v5A1.5 1.5 0 004 10.5h1.5" /></>,
  download: <path d="M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13.5h10" />,
  gear: <><circle cx="8" cy="8" r="2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" /></>,
  more: <g fill="currentColor" stroke="none"><circle cx="3.5" cy="8" r="1.25" /><circle cx="8" cy="8" r="1.25" /><circle cx="12.5" cy="8" r="1.25" /></g>,
  info: <><circle cx="8" cy="8" r="6.5" /><path d="M8 7.5v4M8 5v.01" /></>,
  alert: <><path d="M8 1.8L1.2 13.5h13.6z" /><path d="M8 6.5v3M8 11.5v.01" /></>,
  box: <><path d="M8 1.5l6 3v7l-6 3-6-3v-7z" /><path d="M2 4.5l6 3 6-3M8 7.5v7" /></>,
  external: <path d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5M12 9.5v3a1 1 0 01-1 1H3.5a1 1 0 01-1-1V5a1 1 0 011-1h3" />,
  play: <path d="M5 3.5l7 4.5-7 4.5z" />,
  wrap: <path d="M2.5 4h11M2.5 8h9a2 2 0 010 4H8M9.5 10.5L8 12l1.5 1.5M2.5 12h3" />,
  up: <path d="M8 13V3.5M4 7.5l4-4 4 4" />,
  folder: <path d="M1.5 4.5a1 1 0 011-1h3.5l1.5 1.5h6a1 1 0 011 1v6.5a1 1 0 01-1 1h-11a1 1 0 01-1-1z" />,
  refresh: <path d="M13.5 8a5.5 5.5 0 11-1.6-3.9M13.5 2.5v3h-3" />,
  undo: <><path d="M5.5 3L2.5 6l3 3" /><path d="M2.5 6h7a4 4 0 010 8h-3" /></>,
  gitlab: <path strokeLinejoin="round" d="M8 14.2L1.6 9.6a.8.8 0 01-.3-.9L3.4 2.2a.3.3 0 01.6 0L5.6 6.4h4.8l1.6-4.2a.3.3 0 01.6 0l2.1 6.5a.8.8 0 01-.3.9z" />,
};

export type IconName = keyof typeof PATHS | string;

export function Icon({name, className, style}: {name: IconName; className?: string; style?: CSSProperties}) {
  return (
    <svg className={'ico' + (className ? ' ' + className : '')} viewBox="0 0 16 16" aria-hidden="true" style={style}>
      {PATHS[name] ?? PATHS.circle}
    </svg>
  );
}

export function Spinner({className}: {className?: string}) {
  return <Icon name="spinner" className={'spin' + (className ? ' ' + className : '')} />;
}

export type Status = 'pending' | 'queued' | 'running' | 'success' | 'failed' | 'skipped';
const STATUS_ICON: Record<string, string> = {pending: 'circle', queued: 'circle', running: 'spinner', success: 'check', failed: 'x', skipped: 'dash'};

/** Status glyph coloured by `.st-<status>`; running spins. */
export function StatusIcon({status, className}: {status: string; className?: string}) {
  const cls = (status === 'running' ? 'spin' + (className ? ' ' + className : '') : className || '') + ' st-' + status;
  return <Icon name={STATUS_ICON[status] || 'circle'} className={cls.trim()} />;
}
