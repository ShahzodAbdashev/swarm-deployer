import type {ReactNode} from 'react';
import type {PendingErr} from '../../state/session';

/** [fieldId, message] pairs, in focus order. */
export type StepErrors = [string, string][];

/** What a step registers with the wizard frame on every render. */
export interface StepApi {
  /** Errors for the step's current state (closure over it). */
  validate: () => StepErrors;
  /** Last step only: start the deploy instead of moving on. */
  submit?: () => Promise<void>;
  /** Element to focus when the step opens; null = the Next button. Omitted = first input. */
  first?: () => HTMLElement | null;
}

export interface StepProps {
  register: (api: StepApi) => void;
  /** Next was pressed on this step: show errors live. */
  tried: boolean;
  /** Server error mapped to one of this step's fields. */
  ext: PendingErr | null;
  goNext: () => void;
  setNextBusy: (label: string | null) => void;
  setFormAlert: (n: ReactNode) => void;
  /** The wizard's Next button, for steps that move focus there once loaded. */
  nextRef: {current: HTMLButtonElement | null};
}

/** Errors to show: live after the first Next, otherwise a server error mapped to this step. */
export function shownErrors(tried: boolean, errs: StepErrors, ext: PendingErr | null): Record<string, string> {
  if (tried) return Object.fromEntries(errs);
  return ext ? {[ext.field]: ext.msg} : {};
}
