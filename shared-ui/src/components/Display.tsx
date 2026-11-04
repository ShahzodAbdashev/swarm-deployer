import {forwardRef, type ForwardedRef, type ReactNode} from 'react';
import {Icon, StatusIcon} from './Icon';
import './Display.css';

export type AlertKind = 'error' | 'info' | 'warning';

/** Inline callout. Errors are announced (role=alert). */
export function Alert({kind, icon, id, children}: {kind: AlertKind; icon?: string; id?: string; children: ReactNode}) {
  return (
    <div className={'alert ' + kind} role={kind === 'error' ? 'alert' : undefined} id={id}>
      <Icon name={icon ?? (kind === 'error' ? 'alert' : 'info')} />
      <div className="body">{children}</div>
    </div>
  );
}

const PILL_TEXT: Record<string, string> = {queued: 'Queued', running: 'Running', success: 'Succeeded', failed: 'Failed'};
export function statusText(st: string): string { return PILL_TEXT[st] || st; }

/** Job status pill: icon + "Succeeded" / "Failed" / ... */
export function StatusBadge({status}: {status: string}) {
  return (
    <span className={'pill ' + status}>
      {status === 'queued' ? <Icon name="circle" /> : <StatusIcon status={status} />}
      {statusText(status)}
    </span>
  );
}

export function Badge({tone, children}: {tone?: 'warn' | 'accent'; children: ReactNode}) {
  return <span className={'badge' + (tone ? ' ' + tone : '')}>{children}</span>;
}

export function StatTiles({children}: {children: ReactNode}) {
  return <div className="tiles">{children}</div>;
}

/** Number tile; give `href` (and children) for a clickable summary tile. */
export function StatTile({label, value, tone, href, className, children}: {
  label: string; value?: ReactNode; tone?: 'success' | 'danger' | ''; href?: string; className?: string; children?: ReactNode;
}) {
  const body = <><span className="micro">{label}</span>{children ?? <span className={'num ' + (tone || '')}>{value}</span>}</>;
  const cls = 'tile' + (className ? ' ' + className : '');
  return href ? <a className={cls} href={href}>{body}</a> : <div className={cls}>{body}</div>;
}

export function Card({title, actions, children}: {title?: ReactNode; actions?: ReactNode; children: ReactNode}) {
  return (
    <section className="card">
      {title ? <div className="card-head"><h2>{title}</h2>{actions}</div> : null}
      {children}
    </section>
  );
}

/** Finished-job summary: green (ok) or red (bad) card with a focusable headline. */
export const ResultCard = forwardRef(function ResultCard(
  {ok, title, children, actions, after}: {ok: boolean; title: ReactNode; children?: ReactNode; actions?: ReactNode; after?: ReactNode},
  ref: ForwardedRef<HTMLDivElement>,
) {
  return (
    <div className={'result ' + (ok ? 'ok' : 'bad')}>
      <div className="display" tabIndex={-1} ref={ref}><Icon name={ok ? 'check' : 'x'} />{title}</div>
      {children}
      {actions ? <div className="actions">{actions}</div> : null}
      {after}
    </div>
  );
});

export function Skeleton({w, h = 14}: {w: string; h?: number}) {
  return <div className="skel" style={{width: w, height: h}} />;
}

export function SkeletonRows({n = 3}: {n?: number}) {
  return <div className="list">{Array.from({length: n}, (_, i) => <div className="skel-row" key={i}><Skeleton w="45%" h={12} /><Skeleton w="70%" h={10} /></div>)}</div>;
}

/** Centered empty / not-found state. */
export function EmptyState({icon = 'box', title, titleAs = 'h2', text, children}: {
  icon?: string; title: ReactNode; titleAs?: 'h1' | 'h2'; text?: ReactNode; children?: ReactNode;
}) {
  const H = titleAs;
  return (
    <div className="center-state">
      <Icon name={icon} className="big" />
      {H === 'h2' ? <h2 className="display" style={{fontSize: 20}}>{title}</h2> : <H tabIndex={-1}>{title}</H>}
      {text ? <p className="muted">{text}</p> : null}
      {children}
    </div>
  );
}
