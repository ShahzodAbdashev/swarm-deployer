import type {ReactNode} from 'react';
import './Controls.css';

export function Switch({id, checked, onChange, labelledBy}: {id?: string; checked: boolean; onChange: (v: boolean) => void; labelledBy?: string}) {
  return <button className="switch" type="button" role="switch" id={id} aria-checked={checked} aria-labelledby={labelledBy} onClick={() => onChange(!checked)} />;
}

export interface Choice<T extends string> { value: T; label: ReactNode }

/** Small pill group of mutually exclusive options (native radios inside). */
export function SegmentedControl<T extends string>({name, value, options, onChange, labelledBy}: {
  name: string; value: T; options: Choice<T>[]; onChange: (v: T) => void; labelledBy?: string;
}) {
  return (
    <div className="seg" role="radiogroup" aria-labelledby={labelledBy}>
      {options.map(o => (
        <label key={o.value}>
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
          {o.label}
        </label>
      ))}
    </div>
  );
}

export interface RadioCardOption<T extends string> { value: T; title: ReactNode; desc?: ReactNode; descMono?: boolean }

/** Large radio choices with a title and description. */
export function RadioCards<T extends string>({name, value, options, onChange, label}: {
  name: string; value: T; options: RadioCardOption<T>[]; onChange: (v: T) => void; label: string;
}) {
  return (
    <div className="radios" role="radiogroup" aria-label={label}>
      {options.map(o => (
        <label className="rcard" key={o.value}>
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
          <span>
            <div className="t">{o.title}</div>
            {o.desc !== undefined ? <div className={'d' + (o.descMono ? ' mono' : '')}>{o.desc}</div> : null}
          </span>
        </label>
      ))}
    </div>
  );
}
