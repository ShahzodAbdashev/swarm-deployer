import {confirm, type LeaveGuard} from '@devtools/ui';
import {router} from '../../router';
import {draftDirty, resetDraft} from '../../state/draft';

const DISCARD = {title: 'Discard this deploy?', body: 'Nothing has been changed on the server.', cancel: 'Keep editing', confirm: 'Discard'};

export async function wizardCancel(): Promise<void> {
  if (draftDirty() && !(await confirm(DISCARD))) return;
  resetDraft();
  router.setLeaveGuard(null);
  router.go('#/dashboard');
}

/** Leaving the wizard with data asks first; moving between steps or to Settings (and back) doesn't. */
export const wizardGuard: LeaveGuard = target =>
  /^#\/(new|settings)(\/|$)/.test(target) || !draftDirty() ? null : {...DISCARD, onDiscard: resetDraft};
