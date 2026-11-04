// Small DOM kit: element helper, icons, controls, toasts, confirm dialog, menus, formatting, storage.
// Server data only ever goes in as text (h() children / textContent), never as HTML.

export const $ = id => document.getElementById(id);

/** h('div', {class, id, onclick, 'aria-x': ...}, ...children). Strings become text nodes; null/false children are skipped. */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  el.append(...kids.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false).map(c => (c instanceof Node ? c : String(c))));
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && !k.includes('-')) el[k] = v;
    else if (v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';
export function icon(name, cls = '') {
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('class', ('ico ' + cls).trim());
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(SVG, 'use');
  u.setAttribute('href', '#i-' + name);
  s.append(u);
  return s;
}
export const spinner = (cls = '') => icon('spinner', ('spin ' + cls).trim());

const ST_ICON = {pending: 'circle', queued: 'circle', running: 'spinner', success: 'check', failed: 'x', skipped: 'dash'};
export const statusIcon = (st, cls = '') => icon(ST_ICON[st] || 'circle', ((st === 'running' ? 'spin ' : '') + cls + ' st-' + st).trim());
/** Replace the status icon in `slot` only when the status changed (keeps a spinner's animation running). */
export function setIcon(slot, status, cls = '') {
  if (slot.dataset.st === status) return;
  slot.dataset.st = status;
  slot.replaceChildren(statusIcon(status, cls));
}
const PILL = {queued: 'Queued', running: 'Running', success: 'Succeeded', failed: 'Failed'};
export const statusText = st => PILL[st] || st;
export const statusBadge = st => h('span', {class: 'pill ' + st}, st === 'queued' ? icon('circle') : statusIcon(st), statusText(st));

// ---------------------------------------------------------------- controls

export const btn = (cls, kids, onclick, props = {}) => h('button', {class: 'btn ' + cls, type: 'button', onclick, ...props}, kids);

/** While label is set: spinner + label, fixed width, disabled. busy(b, null) restores the button. */
export function busy(b, label) {
  if (label) {
    if (!b._kids) { b._kids = [...b.childNodes]; b._dis = b.disabled; if (b.offsetWidth) b.style.width = b.offsetWidth + 'px'; }
    b.replaceChildren(spinner(), label);
    b.disabled = true;
    b.setAttribute('aria-busy', 'true');
  } else if (b._kids) {
    b.replaceChildren(...b._kids);
    b._kids = null;
    b.disabled = b._dis;
    b.style.width = '';
    b.removeAttribute('aria-busy');
  }
}

const cls = (base, p) => base + (p.mono ? ' mono' : '') + (p.class ? ' ' + p.class : '');
export const input = (p = {}) => h('input', {type: 'text', autocomplete: 'off', spellcheck: false, autocapitalize: 'off', ...p, mono: null, class: cls('input', p)});
export const textarea = (p = {}) => h('textarea', {spellcheck: false, autocapitalize: 'off', ...p, class: cls('input', p)});
export const select = (p, options) => h('select', {...p, class: 'input'}, options);

/** Password input with a show/hide eye. Wrappers sharing a `group` array toggle together. */
export function pw(p, group) {
  const inp = input({...p, type: 'password'});
  const eye = h('button', {class: 'eye', type: 'button', 'aria-label': 'Show password', 'aria-pressed': 'false'}, icon('eye'));
  const wrap = h('div', {class: 'pw'}, inp, eye);
  wrap.show = on => {
    inp.type = on ? 'text' : 'password';
    eye.setAttribute('aria-label', on ? 'Hide password' : 'Show password');
    eye.setAttribute('aria-pressed', String(on));
    eye.replaceChildren(icon(on ? 'eye-off' : 'eye'));
  };
  if (group) group.push(wrap);
  eye.onclick = () => { const on = inp.type === 'password'; (group || [wrap]).forEach(w => w.show(on)); };
  return wrap;
}

export const errText = id => h('p', {class: 'err', id: id + '-err', hidden: true});

/** Label + control + extra + help + error, wired with ids <id>, <id>-help, <id>-err, <id>-field. */
export function field(id, label, ctl, o = {}) {
  const inp = ctl.id === id ? ctl : ctl.querySelector('#' + CSS.escape(id));
  if (o.help && inp) inp.setAttribute('aria-describedby', id + '-help');
  return h('div', {class: 'field', id: id + '-field', hidden: o.hidden, style: o.style},
    h('label', {for: id, class: o.labelCls}, label), ctl, o.extra,
    o.help ? h('p', {class: 'help', id: id + '-help'}, o.help) : null, errText(id));
}

/** Show (or clear) the error under field `id`, with aria-invalid / aria-describedby on the control. */
export function showErr(id, msg) {
  const p = $(id + '-err');
  if (!p) return;
  p.hidden = !msg;
  p.replaceChildren(...(msg ? [icon('alert'), h('span', {}, msg)] : []));
  const c = $(id);
  if (!c || !c.matches('input,select,textarea')) return;
  if (msg) c.setAttribute('aria-invalid', 'true'); else c.removeAttribute('aria-invalid');
  const d = [$(id + '-help') ? id + '-help' : '', msg ? id + '-err' : ''].filter(Boolean).join(' ');
  if (d) c.setAttribute('aria-describedby', d); else c.removeAttribute('aria-describedby');
}

/** Show errors for every field inside `root`: {fieldId: message}; fields not in the map are cleared. */
export function paintErrs(root, map) {
  root.querySelectorAll('.err[id$="-err"]').forEach(p => { const id = p.id.slice(0, -4); showErr(id, map[id]); });
}

export const alertBox = (kind, kids, ico, id) => h('div', {class: 'alert ' + kind, role: kind === 'error' ? 'alert' : null, id},
  icon(ico || (kind === 'error' ? 'alert' : 'info')), h('div', {class: 'body'}, kids));

export const skel = (w, ht = 14) => h('div', {class: 'skel', style: {width: w, height: ht + 'px'}});

export const segmented = (name, labelledBy, value, opts, onChange) => h('div', {class: 'seg', role: 'radiogroup', 'aria-labelledby': labelledBy},
  opts.map(o => h('label', {}, h('input', {type: 'radio', name, value: o.value, checked: o.value === value, onchange: () => onChange(o.value)}), o.label)));

export const radioCards = (name, label, value, opts, onChange) => h('div', {class: 'radios', role: 'radiogroup', 'aria-label': label},
  opts.map(o => h('label', {class: 'rcard'},
    h('input', {type: 'radio', name, value: o.value, checked: o.value === value, onchange: () => onChange(o.value)}),
    h('span', {}, h('div', {class: 't'}, o.title), o.desc !== undefined ? h('div', {class: 'd' + (o.descMono ? ' mono' : '')}, o.desc) : null))));

export function switchBtn(id, checked, labelledBy, onChange) {
  const b = h('button', {class: 'switch', type: 'button', role: 'switch', id, 'aria-checked': String(checked), 'aria-labelledby': labelledBy});
  b.onclick = () => { const v = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', String(v)); onChange(v); };
  return b;
}

export const stepHead = (title, sub) => h('div', {class: 'step-head'}, h('h1', {tabindex: '-1'}, title), sub ? h('div', {class: 'sub'}, sub) : null);

export const emptyState = ({title, text, h1, kids}) => h('div', {class: 'center-state'}, icon('box', 'big'),
  h1 ? h('h1', {tabindex: '-1'}, title) : h('h2', {class: 'display', style: {fontSize: '20px'}}, title),
  text ? h('p', {class: 'muted'}, text) : null, kids);

export function avatar(login, url) {
  const letter = () => h('span', {class: 'avatar', 'aria-hidden': 'true'}, (login || '?').charAt(0));
  if (!url) return letter();
  const img = h('img', {class: 'avatar', src: url, alt: '', width: 24, height: 24});
  img.onerror = () => img.replaceWith(letter());
  return img;
}

// ---------------------------------------------------------------- feedback

/** Toast; at most 3 on screen. Errors stay 6s, others 4s, paused on hover/focus. */
export function toast(msg, kind = 'info', action) {
  const box = $('toasts');
  while (box.children.length > 2) box.firstElementChild.remove();
  let t = 0;
  const close = () => { clearTimeout(t); el.remove(); };
  const arm = () => { clearTimeout(t); t = setTimeout(close, kind === 'error' ? 6000 : 4000); };
  const el = h('div', {class: 'toast t-' + kind, role: kind === 'error' ? 'alert' : 'status',
    onmouseenter: () => clearTimeout(t), onmouseleave: arm, onfocusin: () => clearTimeout(t), onfocusout: arm},
  icon(kind === 'success' ? 'check' : kind === 'error' ? 'alert' : 'info'), h('span', {class: 'msg'}, msg),
  action ? btn('ghost', action.label, () => { close(); action.run(); }) : null,
  btn('ghost icon', icon('x'), close, {'aria-label': 'Dismiss'}));
  box.append(el);
  arm();
}

/** Modal yes/no dialog: {title, body (text or node), confirm, cancel, danger}. Resolves false on Cancel / Escape. */
export function confirm(o) {
  const d = $('dlg'), no = $('dlg-no'), yes = $('dlg-yes');
  return new Promise(res => {
    const back = document.activeElement;
    $('dlg-t').textContent = o.title;
    $('dlg-b').replaceChildren(o.body || '');
    no.textContent = o.cancel || 'Cancel';
    yes.textContent = o.confirm || 'OK';
    yes.className = 'btn ' + (o.danger === false ? 'primary' : 'danger');
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
export const isDialogOpen = () => $('dlg').open;

/** Polite live-region announcement (cleared first so repeats are read). */
export function announce(msg) {
  const a = $('announcer');
  a.textContent = '';
  setTimeout(() => { a.textContent = msg; }, 30);
}

// ---------------------------------------------------------------- menu

let closeOpen = null;
export const isMenuOpen = () => !!closeOpen;
export const closeMenus = () => closeOpen?.(false);

/**
 * Button opening a keyboard-navigable popup menu. items() returns entries:
 * {label, icon, danger, disabled, title, href, download, run} | '-' | {note} | falsy (skipped).
 */
export function menuButton(label, items, cls = 'icon', kids = [], props = {}) {
  const b = h('button', {class: 'btn ghost ' + cls, type: 'button', 'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': 'false', ...props},
    cls.includes('icon') ? icon('more') : null, kids);
  let menu = null;
  const outside = ev => { if (menu && !menu.contains(ev.target) && !b.contains(ev.target)) close(false); };
  const onResize = () => close(false);
  function close(refocus) {
    if (!menu) return;
    menu.remove();
    menu = null;
    if (closeOpen === close) closeOpen = null;
    b.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', outside);
    window.removeEventListener('resize', onResize);
    if (refocus) b.focus();
  }
  const entry = it => {
    if (!it) return null;
    if (it === '-') return h('hr', {role: 'separator'});
    if (it.note) return h('div', {class: 'menu-note', role: 'presentation'}, it.note);
    const onclick = ev => {
      if (it.disabled) { ev.preventDefault(); return; }
      if (it.href) { setTimeout(() => close(false)); return; } // keep the link connected so the browser follows it
      ev.preventDefault();
      close(true);
      it.run?.();
    };
    return h(it.href ? 'a' : 'button', {role: 'menuitem', tabindex: '-1', class: it.danger ? 'danger' : null, title: it.title,
      'aria-disabled': it.disabled ? 'true' : null, href: it.href, download: it.download ? '' : null, type: it.href ? null : 'button', onclick},
    it.icon ? icon(it.icon) : null, it.label);
  };
  const onKey = ev => {
    const list = [...menu.querySelectorAll('[role=menuitem]')];
    const i = list.indexOf(document.activeElement);
    if (ev.key === 'ArrowDown') { ev.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(true); }
    else if (ev.key === 'Tab') close(false);
  };
  b.onclick = e => {
    e.preventDefault();
    e.stopPropagation();
    if (menu) { close(true); return; }
    closeOpen?.(false);
    menu = h('div', {class: 'menu', role: 'menu', 'aria-label': label, onkeydown: onKey}, items().map(entry));
    document.body.append(menu);
    closeOpen = close;
    b.setAttribute('aria-expanded', 'true');
    const r = b.getBoundingClientRect(), w = Math.max(200, menu.offsetWidth), ht = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
    menu.style.top = (r.bottom + 4 + ht > window.innerHeight - 8 ? Math.max(8, r.top - ht - 4) : r.bottom + 4) + 'px';
    const mis = [...menu.querySelectorAll('[role=menuitem]')];
    (mis.find(m => m.getAttribute('aria-disabled') !== 'true') || mis[0])?.focus();
    setTimeout(() => document.addEventListener('click', outside), 0);
    window.addEventListener('resize', onResize);
  };
  return b;
}

// ---------------------------------------------------------------- formatting

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

/** Duration for screen readers: "1 minute 5 seconds". */
export function spoken(ms) {
  const s = Math.round(Math.max(0, ms) / 1000), m = Math.floor(s / 60), r = s % 60;
  const p = [];
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

export const hhmm = iso => { const t = parseT(iso); return t ? new Date(t).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}) : ''; };
export const localTime = iso => { const t = parseT(iso); return t ? new Date(t).toLocaleString() : ''; };

// ---------------------------------------------------------------- browser helpers that never throw

export function sget(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
/** Set a sessionStorage key; null removes it. */
export function sset(k, v) { try { if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch { /* per-tab convenience only */ } }
export async function copyText(t) { try { await navigator.clipboard.writeText(t); return true; } catch { return false; } }
