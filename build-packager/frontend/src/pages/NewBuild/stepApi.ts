import type {ReactNode} from 'react';
import type {Draft} from '../../state/draft';
import type {PendingErr} from '../../state/session';

/** [fieldId, message] pairs, in focus order. */
export type StepErrors = [string, string][];

/** What a step registers with the wizard shell on every render. */
export interface StepApi {
  /** Pure: errors for the given draft. Called with the latest draft on Next. */
  validate: (d: Draft) => StepErrors;
  /** Last step only: start the build instead of moving on. */
  submit?: () => Promise<void>;
  /** Element to focus when the step opens (default: first input). */
  first?: () => HTMLElement | null;
}

export interface StepProps {
  /** Register this step's validate/submit/first (call during render). */
  register: (api: StepApi) => void;
  /** Next was pressed on this step: show errors live. */
  tried: boolean;
  /** Error from the server mapped to one of this step's fields. */
  ext: PendingErr | null;
  goNext: () => void;
  setNextBusy: (label: string | null) => void;
  setFormAlert: (n: ReactNode) => void;
}

/** Errors to display: live validation after the first Next, otherwise a server error mapped to this step. */
export function shownErrors(tried: boolean, errs: StepErrors, ext: PendingErr | null): Record<string, string> {
  if (tried) return Object.fromEntries(errs);
  return ext ? {[ext.field]: ext.msg} : {};
}
