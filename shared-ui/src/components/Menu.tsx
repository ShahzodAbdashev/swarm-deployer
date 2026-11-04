import {useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {Icon} from './Icon';

export interface MenuItem {
  label: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  /** Renders an <a>; with `download`, a download link. */
  href?: string;
  download?: boolean;
  run?: () => void;
}
/** '-' = separator, {note} = non-interactive text line; falsy entries are skipped. */
export type MenuEntry = MenuItem | '-' | {note: string} | null | false | undefined;

// one menu open at a time, app-wide
let closeOpen: ((refocus: boolean) => void) | null = null;
export function isMenuOpen(): boolean { return !!closeOpen; }

export interface MenuButtonProps {
  /** Accessible name of the button and the menu. */
  label: string;
  items: () => MenuEntry[];
  /** Extra button classes; default "icon" renders the ⋯ glyph. */
  className?: string;
  children?: ReactNode;
  'data-id'?: string;
}

/** Button that opens a keyboard-navigable popup menu (role=menu), positioned under the button. */
export function MenuButton({label, items, className, children, ...rest}: MenuButtonProps) {
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [entries, setEntries] = useState<MenuEntry[] | null>(null);
  const cls = className || 'icon';

  // stable identity so the app-wide `closeOpen` slot can be compared across renders
  const self = useRef((refocus: boolean) => {
    if (closeOpen === self.current) closeOpen = null;
    setEntries(null);
    if (refocus) btn.current?.focus();
  });
  const close = self.current;

  useEffect(() => () => { if (closeOpen === self.current) closeOpen = null; }, []); // unmounted while open

  useLayoutEffect(() => {
    const el = menu.current, b = btn.current;
    if (!entries || !el || !b) return;
    const r = b.getBoundingClientRect(), w = Math.max(200, el.offsetWidth);
    el.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
    const below = r.bottom + 4, hgt = el.offsetHeight;
    el.style.top = (below + hgt > window.innerHeight - 8 ? Math.max(8, r.top - hgt - 4) : below) + 'px';
    const mis = [...el.querySelectorAll<HTMLElement>('[role=menuitem]')];
    (mis.find(m => m.getAttribute('aria-disabled') !== 'true') || mis[0])?.focus();
    const outside = (ev: globalThis.MouseEvent) => { if (!el.contains(ev.target as Node) && ev.target !== b && !b.contains(ev.target as Node)) close(false); };
    const onResize = () => close(false);
    const t = setTimeout(() => document.addEventListener('click', outside), 0);
    window.addEventListener('resize', onResize);
    return () => { clearTimeout(t); document.removeEventListener('click', outside); window.removeEventListener('resize', onResize); };
  }, [entries]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (entries) { close(true); return; }
    closeOpen?.(false);
    closeOpen = self.current;
    setEntries(items());
  };

  const onKey = (ev: KeyboardEvent) => {
    const list = [...(menu.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (ev.key === 'ArrowDown') { ev.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(true); }
    else if (ev.key === 'Tab') close(false);
  };

  return (
    <>
      <button ref={btn} className={'btn ghost ' + cls} type="button" aria-label={label} aria-haspopup="menu"
        aria-expanded={!!entries} onClick={toggle} {...rest}>
        {cls.includes('icon') ? <Icon name="more" /> : null}
        {children}
      </button>
      {entries ? createPortal(
        <div className="menu" role="menu" aria-label={label} ref={menu} onKeyDown={onKey}>
          {entries.map((it, k) => {
            if (!it) return null;
            if (it === '-') return <hr role="separator" key={k} />;
            if ('note' in it) return <div className="menu-note" role="presentation" key={k}>{it.note}</div>;
            const onClick = (ev: MouseEvent) => {
              if (it.disabled) { ev.preventDefault(); return; }
              close(!it.href);
              if (it.run) { ev.preventDefault(); it.run(); }
            };
            const common = {role: 'menuitem', tabIndex: -1, className: it.danger ? 'danger' : '', title: it.title,
              'aria-disabled': it.disabled ? true : undefined, onClick} as const;
            return it.href
              ? <a key={k} {...common} href={it.href} download={it.download ? '' : undefined}>{it.icon ? <Icon name={it.icon} /> : null}{it.label}</a>
              : <button key={k} {...common} type="button">{it.icon ? <Icon name={it.icon} /> : null}{it.label}</button>;
          })}
        </div>, document.body) : null}
    </>
  );
}
