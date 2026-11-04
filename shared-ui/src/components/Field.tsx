import {createContext, forwardRef, useContext, useState, type CSSProperties, type ForwardedRef, type InputHTMLAttributes, type ReactNode,
  type SelectHTMLAttributes, type TextareaHTMLAttributes} from 'react';
import {Icon} from './Icon';
import './Field.css';

/** What a control inside <Field> needs for labelling and error state. */
interface FieldCtx { id: string; describedBy?: string; invalid: boolean }
const Ctx = createContext<FieldCtx | null>(null);

function useFieldProps(id?: string, describedBy?: string) {
  const f = useContext(Ctx);
  return {
    id: id ?? f?.id,
    'aria-describedby': describedBy ?? f?.describedBy,
    'aria-invalid': f?.invalid ? true : undefined,
  };
}

/** Error line with alert icon; renders hidden (but present, for aria-describedby) when there is no message. */
export function ErrorText({id, msg}: {id: string; msg?: string | null}) {
  return (
    <p className="err" id={id} hidden={!msg}>
      {msg ? <><Icon name="alert" /><span>{msg}</span></> : null}
    </p>
  );
}

export interface FieldProps {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  error?: string | null;
  /** Rendered between the control and the help text (previews, counters). */
  extra?: ReactNode;
  labelClassName?: string;
  className?: string;
  hidden?: boolean;
  style?: CSSProperties;
  children: ReactNode;
}

/** Label + control + help + error, wired with ids `<id>`, `<id>-help`, `<id>-err`, `<id>-field`. */
export function Field({id, label, help, error, extra, labelClassName, className, hidden, style, children}: FieldProps) {
  const describedBy = [help ? id + '-help' : '', error ? id + '-err' : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className={'field' + (className ? ' ' + className : '')} id={id + '-field'} hidden={hidden} style={style}>
      <label htmlFor={id} className={labelClassName}>{label}</label>
      <Ctx.Provider value={{id, describedBy, invalid: !!error}}>{children}</Ctx.Provider>
      {extra}
      {help ? <p className="help" id={id + '-help'}>{help}</p> : null}
      <ErrorText id={id + '-err'} msg={error} />
    </div>
  );
}

/** Provide field wiring without the stacked .field layout (e.g. .form-grid rows). */
export function FieldControl({id, help, error, children}: {id: string; help?: boolean; error?: string | null; children: ReactNode}) {
  const describedBy = [help ? id + '-help' : '', error ? id + '-err' : ''].filter(Boolean).join(' ') || undefined;
  return <Ctx.Provider value={{id, describedBy, invalid: !!error}}>{children}</Ctx.Provider>;
}

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> & {mono?: boolean; className?: string};

const TEXT_DEFAULTS = {autoComplete: 'off', spellCheck: false, autoCapitalize: 'off'} as const;

export const Input = forwardRef(function Input({mono, className, id, ...rest}: InputProps, ref: ForwardedRef<HTMLInputElement>) {
  const f = useFieldProps(id, rest['aria-describedby']);
  return <input ref={ref} type="text" {...TEXT_DEFAULTS} {...rest} {...f} className={['input', mono && 'mono', className].filter(Boolean).join(' ')} />;
});

export const Textarea = forwardRef(function Textarea({className, id, ...rest}: TextareaHTMLAttributes<HTMLTextAreaElement>, ref: ForwardedRef<HTMLTextAreaElement>) {
  const f = useFieldProps(id);
  return <textarea ref={ref} spellCheck={false} autoCapitalize="off" {...rest} {...f} className={'input' + (className ? ' ' + className : '')} />;
});

export const Select = forwardRef(function Select({className, id, ...rest}: SelectHTMLAttributes<HTMLSelectElement>, ref: ForwardedRef<HTMLSelectElement>) {
  const f = useFieldProps(id);
  return <select ref={ref} {...rest} {...f} className={'input' + (className ? ' ' + className : '')} />;
});

export interface PasswordInputProps extends Omit<InputProps, 'type'> {
  /** Controlled visibility, e.g. one eye toggling a password and its confirmation together. */
  shown?: boolean;
  onShownChange?: (shown: boolean) => void;
  /** Show a "Caps Lock is on" hint via this callback (keyup). */
  onCapsLock?: (on: boolean) => void;
}

/** Password field with a show/hide eye button. */
export const PasswordInput = forwardRef(function PasswordInput(
  {shown, onShownChange, onCapsLock, onKeyUp, ...rest}: PasswordInputProps, ref: ForwardedRef<HTMLInputElement>,
) {
  const [own, setOwn] = useState(false);
  const show = shown ?? own;
  const toggle = () => { if (onShownChange) onShownChange(!show); else setOwn(!show); };
  return (
    <div className="pw">
      <Input ref={ref} {...rest} type={show ? 'text' : 'password'}
        onKeyUp={e => { onCapsLock?.(e.getModifierState('CapsLock')); onKeyUp?.(e); }} />
      <button className="eye" type="button" aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show} onClick={toggle}>
        <Icon name={show ? 'eye-off' : 'eye'} />
      </button>
    </div>
  );
});
