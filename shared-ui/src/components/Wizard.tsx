import type {ReactNode} from 'react';
import {Icon} from './Icon';
import './Wizard.css';

export interface WizardStep {
  key: string;
  /** Short label under the dot. */
  label: string;
  /** Full step name, used for a11y and the mobile progress line. */
  title: string;
  /** Link for completed steps. */
  href?: string;
}

/** Horizontal step indicator (desktop) + "Step n of m" progress bar (mobile). */
export function Stepper({steps, current, label}: {steps: WizardStep[]; current: number; label: string}) {
  return (
    <>
      <ol className="stepper" aria-label={label}>
        {steps.map((s, i) => {
          const done = i < current, cur = i === current;
          const inner = <><span className="dot">{done ? <Icon name="check" /> : null}</span><span className="lab">{s.label}</span></>;
          return (
            <li key={s.key} className={done ? 'done' : cur ? 'cur' : ''} aria-current={cur ? 'step' : undefined}>
              {done && s.href
                ? <a href={s.href} aria-label={s.title + ' (done)'}>{inner}</a>
                : <span aria-label={cur ? s.title + ' (current)' : s.title}>{inner}</span>}
            </li>
          );
        })}
      </ol>
      <div className="stepper-m" aria-hidden="true">
        <div className="micro muted">{'Step ' + (current + 1) + ' of ' + steps.length + ' · ' + steps[current]?.title}</div>
        <div className="bar"><i style={{width: ((current + 1) * 100) / steps.length + '%'}} /></div>
      </div>
    </>
  );
}

/** Step title (focus target) + subtitle. */
export function StepHead({title, sub}: {title: ReactNode; sub?: ReactNode}) {
  return (
    <div className="step-head">
      <h1 tabIndex={-1}>{title}</h1>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  );
}

/** Wizard footer: optional left content (Back), spacer, primary action. Sticky on phones. */
export function WizardFooter({left, right}: {left?: ReactNode; right: ReactNode}) {
  return <div className="wfoot">{left}<span className="spacer" />{right}</div>;
}
