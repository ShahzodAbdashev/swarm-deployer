import {useSyncExternalStore} from 'react';
import {confirm, type ConfirmOptions} from '../components/Feedback';

/** What a leave guard asks before navigating away; onDiscard runs when the user confirms. */
export interface LeaveAsk extends ConfirmOptions { onDiscard?: () => void }
/** Return a question to block navigation to `target`, or null to allow it. */
export type LeaveGuard = (target: string) => LeaveAsk | null;

export interface RouteSnapshot {
  hash: string;
  /** Bumps on every commit, including re-navigation to the same hash: use it in page keys to remount. */
  tick: number;
}

/**
 * Hash router (#/a/b) with an optional leave guard (unsaved-changes dialogs).
 * One instance per app; pages read the route with useRoute() and navigate with go().
 */
export function createHashRouter() {
  let snap: RouteSnapshot = {hash: location.hash, tick: 0};
  let guard: LeaveGuard | null = null;
  const subs = new Set<() => void>();

  const commit = () => {
    guard = null;
    snap = {hash: location.hash, tick: snap.tick + 1};
    subs.forEach(f => f());
  };

  window.addEventListener('hashchange', async () => {
    if (location.hash === snap.hash) return; // already committed (e.g. refresh() ran before this event arrived)
    if (guard && location.hash !== snap.hash) {
      const target = location.hash, ask = guard(target);
      if (ask) {
        history.replaceState(null, '', snap.hash || location.pathname);
        if (!(await confirm(ask))) return;
        ask.onDiscard?.();
        guard = null;
        location.hash = target;
        return;
      }
    }
    commit();
  });

  const subscribe = (cb: () => void) => { subs.add(cb); return () => { subs.delete(cb); }; };

  return {
    useRoute: (): RouteSnapshot => useSyncExternalStore(subscribe, () => snap),
    current: (): RouteSnapshot => snap,
    /** Navigate; replace=true keeps the current entry out of history. Same hash = re-render the page. */
    go(hash: string, replace = false) {
      if (location.hash === hash) { commit(); return; }
      if (replace) location.replace(hash); else location.hash = hash;
    },
    /** Re-run routing for the current hash (e.g. after sign-in state changed). */
    refresh: commit,
    setLeaveGuard(g: LeaveGuard | null) { guard = g; },
    getLeaveGuard: () => guard,
  };
}

export type HashRouter = ReturnType<typeof createHashRouter>;
