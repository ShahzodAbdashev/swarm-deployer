import {useSyncExternalStore} from 'react';
import {sget, sset} from '@devtools/ui';
import {parsePkg} from '../lib/jobs';
import {basename} from '../lib/format';
import {session} from './session';

/**
 * The New deploy wizard's form. Only package_path / package / path go to sessionStorage['sd.draft'];
 * the zip password lives in memory and is dropped when the wizard is left (SPEC §8 hard constraints).
 */
export interface Draft {
  package_path: string;
  package: string;
  path: string;
  /** Memory only. */
  password: string;
}

const KEY = 'sd.draft';
const empty = (): Draft => ({package_path: '', package: '', path: '', password: ''});
const KEPT = ['package_path', 'package', 'path'] as const;

function load(): Draft {
  try {
    const v = JSON.parse(sget(KEY) || 'null');
    if (v && typeof v === 'object') return {...empty(), ...Object.fromEntries(KEPT.map(k => [k, String(v[k] || '')]))};
  } catch { /* corrupt draft: start fresh */ }
  return empty();
}

let draft: Draft = load();
const subs = new Set<() => void>();
const emit = () => subs.forEach(f => f());
const persist = () => sset(KEY, JSON.stringify(Object.fromEntries(KEPT.map(k => [k, draft[k]]))));

export function getDraft(): Draft { return draft; }
export function updateDraft(patch: Partial<Draft>): void {
  draft = {...draft, ...patch};
  persist();
  emit();
}

export function resetDraft(): void {
  draft = empty();
  sset(KEY, null);
  Object.assign(session, {note: null, fromReview: false, tried: {}, pendingErr: null, saveTar: null, filter: null});
  emit();
}

/** Called on every route outside the wizard: the zip password never outlives it. No re-render needed (no wizard mounted). */
export function dropPassword(): void { if (draft.password) draft = {...draft, password: ''}; }

export function draftDirty(): boolean { return !!(draft.package_path || draft.password); }
/** The package's version from its name, or null (build_tar.sh zip without a timestamp: the deploy time is used). */
export function draftVersion(): string | null { return parsePkg(basename(draft.package_path))?.ts ?? null; }
export function draftFormat(): 'packager' | 'tarzip' | null { return parsePkg(basename(draft.package_path))?.fmt ?? null; }

export function useDraft(): Draft {
  return useSyncExternalStore(cb => { subs.add(cb); return () => { subs.delete(cb); }; }, () => draft);
}
