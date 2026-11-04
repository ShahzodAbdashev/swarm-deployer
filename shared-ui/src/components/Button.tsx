import {forwardRef, useLayoutEffect, useRef, type ButtonHTMLAttributes, type ForwardedRef} from 'react';
import {Spinner} from './Icon';
import './Button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'github';

export interface ButtonStyle {
  variant?: ButtonVariant;
  size?: 'lg';
  full?: boolean;
  /** Square icon-only button. */
  iconOnly?: boolean;
  className?: string;
}

/** Class string for anything that should look like a button (e.g. an <a> download link). */
export function buttonClass({variant, size, full, iconOnly, className}: ButtonStyle = {}): string {
  return ['btn', variant, size, full && 'full', iconOnly && 'icon', className].filter(Boolean).join(' ');
}

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'>, ButtonStyle {
  /** While set, shows a spinner with this label, keeps the width and disables the button. */
  busy?: string | null;
}

export const Button = forwardRef(function Button(
  {variant, size, full, iconOnly, className, busy, children, disabled, style, type = 'button', ...rest}: ButtonProps,
  ref: ForwardedRef<HTMLButtonElement>,
) {
  const own = useRef<HTMLButtonElement | null>(null);
  const width = useRef<number | null>(null);
  useLayoutEffect(() => { if (!busy && own.current) width.current = own.current.offsetWidth; });
  const setRef = (el: HTMLButtonElement | null) => {
    own.current = el;
    if (typeof ref === 'function') ref(el); else if (ref) ref.current = el;
  };
  return (
    <button
      ref={setRef}
      type={type}
      className={buttonClass({variant, size, full, iconOnly, className})}
      disabled={disabled || !!busy}
      aria-busy={busy ? true : undefined}
      style={busy && width.current ? {...style, width: width.current} : style}
      {...rest}
    >
      {busy ? <><Spinner />{busy}</> : children}
    </button>
  );
});
