// Small UI kit: element helper, icons, fetch wrapper, formatting, toast/confirm/announce, menu, hash router.
// Server data only ever goes into the DOM as text nodes / attributes (h() never parses HTML).

export const $ = id => document.getElementById(id);

/** h('div', {class, style:{}, onclick, attr: v}, ...children). Children: Node | string | number | array | null/false (skipped). */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  add(el, kids);
  return el;
}
export function add(el, kids) {
  for (const c of kids.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}
/** Replace an element's children. */
export const put = (el, ...kids) => { el.replaceChildren(); return add(el, kids); };

// ------------------------------------------------------------------ icons (16px stroke set)

const NS = 'http://www.w3.org/2000/svg';
const P = d => ['path', {d}];
const DOT = cx => ['circle', {cx, cy: 8, r: 1.25, fill: 'currentColor', stroke: 'none'}];
const ICONS = {
  check: [P('M3 8.5l3.2 3L13 4.5')],
  x: [P('M4 4l8 8M12 4l-8 8')],
  circle: [['circle', {cx: 8, cy: 8, r: 5.5}]],
  dash: [P('M4.5 8h7')],
  spinner: [['circle', {cx: 8, cy: 8, r: 5.5, opacity: '.25'}], P('M8 2.5a5.5 5.5 0 015.5 5.5')],
  'chevron-down': [P('M4 6l4 4 4-4')],
  'chevron-left': [P('M10 4L6 8l4 4')],
  plus: [P('M8 3v10M3 8h10')],
  eye: [P('M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z'), ['circle', {cx: 8, cy: 8, r: 2}]],
  'eye-off': [P('M2 2l12 12M6.6 6.6a2 2 0 002.8 2.8M4.2 4.6C2.5 5.8 1.5 8 1.5 8S4 12.5 8 12.5c1.3 0 2.5-.5 3.5-1.1M7 3.6c.3 0 .7-.1 1-.1 4 0 6.5 4.5 6.5 4.5s-.5.9-1.4 2')],
  copy: [['rect', {x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5}], P('M10.5 5.5V4a1.5 1.5 0 00-1.5-1.5H4A1.5 1.5 0 002.5 4v5A1.5 1.5 0 004 10.5h1.5')],
  download: [P('M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13.5h10')],
  gear: [['circle', {cx: 8, cy: 8, r: 2}], P('M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4')],
  more: [DOT(3.5), DOT(8), DOT(12.5)],
  info: [['circle', {cx: 8, cy: 8, r: 6.5}], P('M8 7.5v4M8 5v.01')],
  alert: [P('M8 1.8L1.2 13.5h13.6z'), P('M8 6.5v3M8 11.5v.01')],
  box: [P('M8 1.5l6 3v7l-6 3-6-3v-7z'), P('M2 4.5l6 3 6-3M8 7.5v7')],
  play: [P('M5 3.5l7 4.5-7 4.5z')],
  wrap: [P('M2.5 4h11M2.5 8h9a2 2 0 010 4H8M9.5 10.5L8 12l1.5 1.5M2.5 12h3')],
  up: [P('M8 13V3.5M4 7.5l4-4 4 4')],
  folder: [P('M1.5 4.5a1 1 0 011-1h3.5l1.5 1.5h6a1 1 0 011 1v6.5a1 1 0 01-1 1h-11a1 1 0 01-1-1z')],
  refresh: [P('M13.5 8a5.5 5.5 0 11-1.6-3.9M13.5 2.5v3h-3')],
  undo: [P('M5.5 3L2.5 6l3 3'), P('M2.5 6h7a4 4 0 010 8h-3')],
};

export function icon(name, cls) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('class', 'ico' + (cls ? ' ' + cls : ''));
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('aria-hidden', 'true');
  for (const [t, a] of ICONS[name] || ICONS.circle) {
    const e = document.createElementNS(NS, t);
    for (const k in a) e.setAttribute(k, a[k]);
    s.append(e);
  }
  return s;
}
export const spinner = cls => icon('spinner', 'spin' + (cls ? ' ' + cls : ''));
const STATUS_ICON = {pending: 'circle', queued: 'circle', running: 'spinner', success: 'check', failed: 'x', skipped: 'dash'};
export const statusIcon = (st, cls) => icon(STATUS_ICON[st] || 'circle', ((st === 'running' ? 'spin ' : '') + (cls || '') + ' st-' + st).trim());

// ------------------------------------------------------------------ API

export class ApiError extends Error {
  constructor(status, detail) { super(detail); this.status = status; this.detail = detail; }
}

/** JSON fetch; errors are ApiError({status, detail}); status 0 = server unreachable. */
export async function api(method, path, body) {
  let r;
  try {
    r = await fetch(path, {method, headers: body !== undefined ? {'Content-Type': 'application/json'} : {},
      body: body !== undefined ? JSON.stringify(body) : undefined});
  } catch {
    throw new ApiError(0, "Can't reach the local server. Is ./run.sh running?");
  }
  const txt = await r.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (!r.ok) {
    let d = data && typeof data === 'object' ? data.detail : undefined;
    if (Array.isArray(d)) d = d.map(x => (x && typeof x === 'object' && 'msg' in x ? String(x.msg) : String(x))).join('; ');
    throw new ApiError(r.status, (typeof d === 'string' && d) || 'Request failed (' + r.status + ')');
  }
  return data;
}
export const errDetail = e => (e instanceof ApiError ? e : {status: -1, detail: e instanceof Error ? e.message : String(e)});

// ------------------------------------------------------------------ formatting

export const parseT = s => (s ? new Date(s).getTime() : null);

/** Compact duration: <1s, 12s, 3:05, 1h 02m. */
export function fmtDur(ms) {
  if (ms === null || ms === undefined || isNaN(ms)) return '';
  const s = Math.max(0, ms) / 1000;
  if (s < 1) return '<1s';
  if (s < 60) return Math.floor(s) + 's';
  if (s < 3600) return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  return Math.floor(s / 3600) + 'h ' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + 'm';
}
/** Long duration: 12s, 3m 05s, 1h 02m. */
export function fmtDurLong(ms) {
  const s = Math.round(Math.max(0, ms) / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
}
/** Duration for screen readers: "1 minute 5 seconds". */
export function spoken(ms) {
  const s = Math.round(Math.max(0, ms) / 1000), m = Math.floor(s / 60), r = s % 60, p = [];
  if (m) p.push(m + (m === 1 ? ' minute' : ' minutes'));
  if (r || !m) p.push(r + (r === 1 ? ' second' : ' seconds'));
  return p.join(' ');
}
/** Relative time: just now, 5 min ago, 3 h ago, yesterday, Nov 2. */
export function fmtRel(iso) {
  const t = parseT(iso);
  if (!t) return '';
  const d = (Date.now() - t) / 1000;
  if (d < 45) return 'just now';
  if (d < 3600) return Math.max(1, Math.round(d / 60)) + ' min ago';
  if (d < 86400) return Math.round(d / 3600) + ' h ago';
  const dt = new Date(t), y = new Date();
  y.setDate(y.getDate() - 1);
  if (dt.toDateString() === y.toDateString()) return 'yesterday';
  return dt.toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: dt.getFullYear() === new Date().getFullYear() ? undefined : 'numeric'});
}
export function fmtSize(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return (i === 0 || b >= 100 ? Math.round(b) : b.toFixed(1)) + ' ' + u[i];
}
/** 24h clock time, e.g. 19:05. */
export function hhmm(iso) {
  const t = parseT(iso);
  return t ? new Date(t).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}) : '';
}

// ------------------------------------------------------------------ browser helpers (never throw)

export function sget(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
/** Set a sessionStorage key; null removes it. */
export function sset(k, v) { try { if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch { /* per-tab convenience only */ } }
export async function copyText(t) { try { await navigator.clipboard.writeText(t); return true; } catch { return false; } }

// ------------------------------------------------------------------ feedback: toast, confirm, announce

/** At most 3 toasts on screen; errors stay 6s, others 4s, paused on hover/focus. */
export function toast(msg, kind = 'info', action) {
  const box = $('toasts');
  while (box.children.length >= 3) box.firstElementChild.remove();
  let t = 0;
  const kill = () => { clearTimeout(t); el.remove(); };
  const arm = () => { clearTimeout(t); t = setTimeout(kill, kind === 'error' ? 6000 : 4000); };
  const pause = () => clearTimeout(t);
  const el = h('div', {class: 'toast t-' + kind, role: kind === 'error' ? 'alert' : 'status',
    onmouseenter: pause, onmouseleave: arm, onfocusin: pause, onfocusout: arm},
  icon(kind === 'success' ? 'check' : kind === 'error' ? 'alert' : 'info'),
  h('span', {class: 'msg'}, msg),
  action ? h('button', {class: 'btn ghost', type: 'button', onclick: () => { kill(); action.run(); }}, action.label) : null,
  h('button', {class: 'btn ghost icon', type: 'button', 'aria-label': 'Dismiss', onclick: kill}, icon('x')));
  box.append(el);
  arm();
}

/** Modal yes/no dialog ({title, body: string|Node, confirm, cancel, danger}). Resolves false on Cancel or Escape. */
export function confirm(o) {
  const d = $('dlg'), no = $('dlg-no'), yes = $('dlg-yes'), back = document.activeElement;
  $('dlg-t').textContent = o.title;
  put($('dlg-b'), o.body ?? '');
  no.textContent = o.cancel || 'Cancel';
  yes.textContent = o.confirm || 'OK';
  yes.className = 'btn ' + (o.danger === false ? 'primary' : 'danger');
  return new Promise(res => {
    const done = v => {
      no.onclick = yes.onclick = d.oncancel = null;
      if (d.open) d.close();
      if (back && back.isConnected) back.focus();
      res(v);
    };
    no.onclick = () => done(false);
    yes.onclick = () => done(true);
    d.oncancel = e => { e.preventDefault(); done(false); };
    d.showModal();
    no.focus();
  });
}
export const isDialogOpen = () => !!$('dlg')?.open;

/** Polite live-region announcement (cleared first so repeats are read). */
export function announce(msg) {
  const a = $('announcer');
  a.textContent = '';
  setTimeout(() => { a.textContent = msg; }, 30);
}

// ------------------------------------------------------------------ menu button (one open at a time)

let openMenu = null;
export const isMenuOpen = () => !!openMenu;
export const closeMenu = refocus => openMenu?.(refocus);

/** ⋯ button with a keyboard-navigable popup (role=menu). items(): [{label, icon, danger, disabled, title, run} | '-' | null]. */
export function menuButton(label, items, cls = 'icon') {
  const b = h('button', {class: 'btn ghost ' + cls, type: 'button', 'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': 'false'},
    cls.includes('icon') ? icon('more') : null);
  b.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    const mine = b.getAttribute('aria-expanded') === 'true';
    closeMenu(mine);
    if (mine) return;
    const m = h('div', {class: 'menu', role: 'menu', 'aria-label': label});
    const outside = ev => { if (!m.contains(ev.target) && !b.contains(ev.target)) close(false); };
    const close = refocus => {
      m.remove();
      document.removeEventListener('click', outside);
      window.removeEventListener('resize', close);
      b.setAttribute('aria-expanded', 'false');
      openMenu = null;
      if (refocus === true) b.focus();
    };
    for (const it of items()) {
      if (!it) continue;
      if (it === '-') { m.append(h('hr', {role: 'separator'})); continue; }
      m.append(h('button', {type: 'button', role: 'menuitem', tabindex: '-1', class: it.danger ? 'danger' : null, title: it.title,
        'aria-disabled': it.disabled ? 'true' : null,
        onclick: ev => { ev.preventDefault(); if (it.disabled) return; close(true); it.run(); }},
      it.icon ? icon(it.icon) : null, it.label));
    }
    m.addEventListener('keydown', ev => {
      const list = [...m.querySelectorAll('[role=menuitem]')], i = list.indexOf(document.activeElement);
      if (ev.key === 'ArrowDown') { ev.preventDefault(); list[(i + 1) % list.length]?.focus(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(true); }
      else if (ev.key === 'Tab') close(false);
    });
    document.body.append(m);
    const r = b.getBoundingClientRect(), w = Math.max(200, m.offsetWidth), hgt = m.offsetHeight, below = r.bottom + 4;
    m.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
    m.style.top = (below + hgt > window.innerHeight - 8 ? Math.max(8, r.top - hgt - 4) : below) + 'px';
    const mis = [...m.querySelectorAll('[role=menuitem]')];
    (mis.find(x => x.getAttribute('aria-disabled') !== 'true') || mis[0])?.focus();
    setTimeout(() => document.addEventListener('click', outside), 0);
    window.addEventListener('resize', close);
    openMenu = close;
    b.setAttribute('aria-expanded', 'true');
  });
  return b;
}

// ------------------------------------------------------------------ components

export const btn = (variant, kids, onclick, props) => h('button', {class: 'btn ' + variant, type: 'button', onclick, ...props}, kids);

/** While label is set: spinner + label, same width, disabled. null restores the button. */
export function setBusy(b, label) {
  if (label) {
    if (!b._kids) b._kids = [...b.childNodes];
    b.style.width = b.offsetWidth ? b.offsetWidth + 'px' : '';
    b.disabled = true;
    b.setAttribute('aria-busy', 'true');
    put(b, spinner(), label);
  } else if (b._kids) {
    put(b, b._kids);
    b._kids = null;
    b.style.width = '';
    b.disabled = false;
    b.removeAttribute('aria-busy');
  }
}

/** Inline callout; errors are announced (role=alert). */
export const alertBox = (kind, kids, ico) => h('div', {class: 'alert ' + kind, role: kind === 'error' ? 'alert' : null},
  icon(ico || (kind === 'error' ? 'alert' : 'info')), h('div', {class: 'body'}, kids));
/** Error alert with a Retry button. */
export const retryAlert = (msg, retry) => alertBox('error', [h('span', null, msg), h('div', null, btn('ghost', 'Retry', retry))]);

const PILL = {queued: 'Queued', running: 'Running', success: 'Succeeded', failed: 'Failed'};
export const statusText = st => PILL[st] || st;
export const statusBadge = st => h('span', {class: 'pill ' + st}, st === 'queued' ? icon('circle') : statusIcon(st), statusText(st));

export const skeleton = (w, hgt = 14) => h('div', {class: 'skel', style: {width: w, height: hgt + 'px'}});
export const skeletonRows = (n = 3) => h('div', {class: 'list'},
  Array.from({length: n}, () => h('div', {class: 'skel-row'}, skeleton('45%', 12), skeleton('70%', 10))));

/** Centered empty / not-found state with an h1 title. */
export const emptyState = (title, ...kids) => h('div', {class: 'center-state'}, icon('box', 'big'), h('h1', {tabindex: '-1'}, title), kids);

/** Finished-job card: green (ok) or red with a focusable headline (.display). */
export const resultCard = (ok, title, body, actions) => h('div', {class: 'result ' + (ok ? 'ok' : 'bad')},
  h('div', {class: 'display', tabindex: '-1'}, icon(ok ? 'check' : 'x'), title), body, h('div', {class: 'actions'}, actions));

/** Inline result line: green check or red cross with the message. */
export const testRes = (ok, msg) => h('div', {class: 'test-res ' + (ok ? 'ok' : 'bad')}, icon(ok ? 'check' : 'x'), h('span', null, msg));

const TEXT = {autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off'};
/** Text input with the kit defaults; mono adds the monospace class. */
export const input = (props = {}, mono) => h('input', {type: 'text', ...TEXT, ...props, class: 'input' + (mono ? ' mono' : '')});

/** Password input with a show/hide eye. Returns the .pw wrapper; the input is wrapper.input. */
export function pwInput(props = {}) {
  const i = input({autocomplete: 'new-password', ...props, type: 'password'});
  const eye = h('button', {class: 'eye', type: 'button', 'aria-label': 'Show password', 'aria-pressed': 'false'}, icon('eye'));
  eye.addEventListener('click', () => {
    const show = i.type === 'password';
    i.type = show ? 'text' : 'password';
    eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    eye.setAttribute('aria-pressed', String(show));
    put(eye, icon(show ? 'eye-off' : 'eye'));
  });
  const w = h('div', {class: 'pw'}, i, eye);
  w.input = i;
  return w;
}

const errP = id => h('p', {class: 'err', id: id + '-err', hidden: true});
/** Wire a control (or the input inside a .pw) to its id and help text. */
function wire(ctl, id, help) {
  const c = ctl.input || ctl;
  c.id = id;
  if (help) c.setAttribute('aria-describedby', id + '-help');
  return ctl;
}
/** Settings form row inside a .form-grid: [label, .ctl with control, extra, help, error line]. */
export function gridRow({id, label, help, extra}, ctl) {
  return [h('label', {class: 'lbl', for: id}, label),
    h('div', {class: 'ctl', id: id + '-row'}, wire(ctl, id, help), extra, help ? h('p', {class: 'help', id: id + '-help'}, help) : null, errP(id))];
}
/** Stacked label / control / help / error. */
export const field = ({id, label, help}, ctl) => h('div', {class: 'field', id: id + '-field'},
  h('label', {for: id}, label), wire(ctl, id, help), help ? h('p', {class: 'help', id: id + '-help'}, help) : null, errP(id));
/** Bare control + its error line (host/port pairs). */
export const ctlWithErr = (id, ctl) => h('div', {class: 'ctl'}, wire(ctl, id), errP(id));

/** Show or clear the error of field `id` (its #id-err line, aria-invalid, aria-describedby). */
export function setErr(id, msg) {
  const p = $(id + '-err'), c = $(id);
  if (p) { put(p, msg ? [icon('alert'), h('span', null, msg)] : []); p.hidden = !msg; }
  if (!c) return;
  if (msg) c.setAttribute('aria-invalid', 'true'); else c.removeAttribute('aria-invalid');
  const d = [$(id + '-help') ? id + '-help' : '', msg && p ? id + '-err' : ''].filter(Boolean).join(' ');
  if (d) c.setAttribute('aria-describedby', d); else c.removeAttribute('aria-describedby');
}
/** Show a {fieldId: msg|null} map; returns the first id with an error (focus order = key order) or null. */
export function showErrs(errs) {
  for (const k in errs) setErr(k, errs[k]);
  return Object.keys(errs).find(k => errs[k]) || null;
}

// ------------------------------------------------------------------ hash router with a leave guard

let cur = location.hash, guard = null, leave = [], gen = 0, renderFn = () => {};

/** Register cleanup for the current page (timers, listeners, EventSource). */
export const onLeave = fn => { leave.push(fn); };
/** Returns a check that is true while the page that called it is still shown. */
export const live = () => { const g = gen; return () => g === gen; };
/** addEventListener removed when the page is left. */
export function on(target, ev, fn) { target.addEventListener(ev, fn); onLeave(() => target.removeEventListener(ev, fn)); }

function commit() {
  guard = null;
  cur = location.hash;
  gen++;
  closeMenu(false);
  leave.splice(0).forEach(f => { try { f(); } catch { /* keep navigating */ } });
  renderFn(cur);
}
/** Navigate; replace keeps the current entry out of history. Same hash re-renders the page. */
export function go(hash, replace = false) {
  if (location.hash === hash) { commit(); return; }
  if (replace) location.replace(hash); else location.hash = hash;
}
export const refresh = () => commit();
/** guard(target) returns {title, body, confirm, cancel, onDiscard} to ask before leaving, or null. Reset on every navigation. */
export const setGuard = g => { guard = g; };
export const getGuard = () => guard;

export function startRouter(fn) {
  renderFn = fn;
  window.addEventListener('hashchange', async () => {
    if (location.hash === cur) return;
    const ask = guard && guard(location.hash);
    if (ask) {
      const target = location.hash;
      history.replaceState(null, '', cur || location.pathname);
      if (!(await confirm(ask))) return;
      ask.onDiscard?.();
      guard = null;
      location.hash = target;
      return;
    }
    commit();
  });
  commit();
}

/** Run fn (which rebuilds part of `box`) and give focus back to the element with the same data-id / radio value. */
export function keepFocus(box, fn) {
  const a = document.activeElement, inside = a && box.contains(a);
  const sel = !inside ? null : a.dataset?.id ? '[data-id="' + CSS.escape(a.dataset.id) + '"]'
    : a.type === 'radio' ? 'input[type=radio][value="' + CSS.escape(a.value) + '"]' : null;
  fn();
  if (sel) box.querySelector(sel)?.focus();
}
