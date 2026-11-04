import {useEffect, useRef, useState, useSyncExternalStore, type ReactNode} from 'react';
import {Icon} from './Icon';
import './Feedback.css';

/*
 * Imperative feedback APIs (toast, confirm, announce) backed by host components mounted once in <AppShell>.
 * They can be called from anywhere, including non-React code such as the API client.
 */

// ---------------------------------------------------------------- toasts

export type ToastKind = 'info' | 'success' | 'error';
interface ToastItem { id: number; msg: string; kind: ToastKind; action?: {label: string; run: () => void} }

let toasts: ToastItem[] = [];
let nextId = 1;
const toastSubs = new Set<() => void>();
const emitToasts = () => toastSubs.forEach(f => f());

/** Show a toast; at most 3 stay on screen (oldest dropped). Errors stay 6s, others 4s, paused on hover/focus. */
export function toast(msg: string, kind: ToastKind = 'info', action?: {label: string; run: () => void}): void {
  toasts = [...toasts.slice(-2), {id: nextId++, msg, kind, action}];
  emitToasts();
}
function dismiss(id: number) { toasts = toasts.filter(t => t.id !== id); emitToasts(); }

function Toast({t}: {t: ToastItem}) {
  const timer = useRef<number>(0);
  const arm = () => { clearTimeout(timer.current); timer.current = window.setTimeout(() => dismiss(t.id), t.kind === 'error' ? 6000 : 4000); };
  const pause = () => clearTimeout(timer.current);
  useEffect(() => { arm(); return pause; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={'toast t-' + t.kind} role={t.kind === 'error' ? 'alert' : 'status'}
      onMouseEnter={pause} onMouseLeave={arm} onFocus={pause} onBlur={arm}>
      <Icon name={t.kind === 'success' ? 'check' : t.kind === 'error' ? 'alert' : 'info'} />
      <span className="msg">{t.msg}</span>
      {t.action ? <button className="btn ghost" type="button" onClick={() => { dismiss(t.id); t.action!.run(); }}>{t.action.label}</button> : null}
      <button className="btn ghost icon" type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)}><Icon name="x" /></button>
    </div>
  );
}

export function Toaster() {
  const list = useSyncExternalStore(cb => { toastSubs.add(cb); return () => toastSubs.delete(cb); }, () => toasts);
  return <div id="toasts">{list.map(t => <Toast key={t.id} t={t} />)}</div>;
}

// ---------------------------------------------------------------- confirm dialog

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirm: string;
  cancel?: string;
  /** false = primary (non-destructive) confirm button. */
  danger?: boolean;
}

let openConfirm: ((o: ConfirmOptions) => Promise<boolean>) | null = null;

/** Modal yes/no dialog. Resolves false on Cancel or Escape. */
export function confirm(o: ConfirmOptions): Promise<boolean> {
  return openConfirm ? openConfirm(o) : Promise.resolve(window.confirm(o.title));
}
export function isDialogOpen(): boolean {
  return !!(document.getElementById('dlg') as HTMLDialogElement | null)?.open;
}

export function ConfirmHost() {
  const ref = useRef<HTMLDialogElement>(null);
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);
  const back = useRef<Element | null>(null);
  useEffect(() => {
    openConfirm = o => new Promise<boolean>(res => {
      back.current = document.activeElement;
      resolver.current = res;
      setOpts(o);
    });
    return () => { openConfirm = null; };
  }, []);
  useEffect(() => {
    const d = ref.current;
    if (opts && d && !d.open) { d.showModal(); document.getElementById('dlg-no')?.focus(); }
  }, [opts]);
  const done = (v: boolean) => {
    const d = ref.current;
    if (d?.open) d.close();
    setOpts(null);
    const b = back.current as HTMLElement | null;
    if (b && b.isConnected) b.focus();
    resolver.current?.(v);
    resolver.current = null;
  };
  return (
    <dialog id="dlg" ref={ref} aria-labelledby="dlg-t" aria-describedby="dlg-b" onCancel={e => { e.preventDefault(); done(false); }}>
      <h2 id="dlg-t">{opts?.title}</h2>
      <p id="dlg-b" className="muted">{opts?.body}</p>
      <div className="actions">
        <button className="btn secondary" id="dlg-no" type="button" onClick={() => done(false)}>{opts?.cancel || 'Cancel'}</button>
        <button className={'btn ' + (opts?.danger === false ? 'primary' : 'danger')} id="dlg-yes" type="button" onClick={() => done(true)}>{opts?.confirm || 'OK'}</button>
      </div>
    </dialog>
  );
}

// ---------------------------------------------------------------- screen-reader announcements

/** Polite live-region announcement (cleared first so repeats are read). */
export function announce(msg: string): void {
  const a = document.getElementById('announcer');
  if (!a) return;
  a.textContent = '';
  setTimeout(() => { a.textContent = msg; }, 30);
}

export function Announcer() {
  return <div id="announcer" className="sr" aria-live="polite" />;
}
