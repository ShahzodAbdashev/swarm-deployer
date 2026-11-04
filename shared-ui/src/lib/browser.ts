/** Browser helpers that never throw (private windows, blocked storage, no clipboard permission). */

function session(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

export function sget(k: string): string | null {
  try { return session()?.getItem(k) ?? null; } catch { return null; }
}

/** Set a sessionStorage key; null removes it. */
export function sset(k: string, v: string | null): void {
  try {
    const s = session();
    if (!s) return;
    if (v === null) s.removeItem(k); else s.setItem(k, v);
  } catch { /* storage unavailable: per-tab convenience only */ }
}

export async function copyText(t: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(t); return true; } catch { return false; }
}
