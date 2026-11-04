import {useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode} from 'react';
import {flushSync} from 'react-dom';
import {Alert, Button, Icon, Stepper, WizardFooter, isDialogOpen, isMenuOpen} from '@devtools/ui';
import {WLABEL, WSHORT, WSTEPS, router, setTitle, type WizardStepKey} from '../../router';
import {getDraft} from '../../state/draft';
import {session, type PendingErr} from '../../state/session';
import type {StepApi, StepProps} from './stepApi';
import {PasswordStep} from './steps/PasswordStep';
import {RepoStep} from './steps/RepoStep';
import {ReviewStep} from './steps/ReviewStep';
import {SourceStep} from './steps/SourceStep';
import {UploadStep} from './steps/UploadStep';
import {wizardCancel, wizardGuard} from './wizard';

const STEP_VIEW: Record<WizardStepKey, (p: StepProps) => ReactNode> = {
  repo: RepoStep, source: SourceStep, password: PasswordStep, upload: UploadStep, review: ReviewStep,
};

/**
 * New build wizard frame: stepper, the current step, footer with Back / Next.
 * Steps replace each other in history, so browser Back leaves the wizard instead of replaying it.
 */
export function NewBuildPage({step}: {step: WizardStepKey}) {
  const idx = WSTEPS.indexOf(step);
  const [viaReview] = useState(() => {
    if (step === 'review') session.fromReview = false;
    return session.fromReview && step !== 'review';
  });
  // a server error mapped to this step (consumed once)
  const [ext, setExt] = useState<PendingErr | null>(() => {
    const pe = session.pendingErr;
    if (pe && pe.step === step) { session.pendingErr = null; return pe; }
    return null;
  });
  const [tried, setTried] = useState(!!session.tried[step]);
  const [busy, setNextBusy] = useState<string | null>(null);
  const [formAlert, setFormAlert] = useState<ReactNode>(null);
  const api = useRef<StepApi>({validate: () => []});
  const content = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const register = useCallback((a: StepApi) => { api.current = a; }, []);

  const goNext = useCallback(() => {
    session.tried[step] = true;
    flushSync(() => { setTried(true); setExt(null); });
    const errs = api.current.validate(getDraft());
    if (errs.length) { const id = errs[0][0]; (document.getElementById(id) || document.getElementById(id + '-field'))?.focus(); return; }
    if (api.current.submit) { void api.current.submit(); return; }
    router.go(viaReview ? '#/new/review' : '#/new/' + WSTEPS[idx + 1], true);
  }, [step, idx, viaReview]);

  useEffect(() => {
    setTitle('New build · ' + WLABEL[step]);
    router.setLeaveGuard(wizardGuard);
    const onEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !isDialogOpen() && !isMenuOpen() && !e.defaultPrevented) { e.preventDefault(); wizardCancel(); }
    };
    document.addEventListener('keydown', onEsc);
    // initial focus: the server error's field, else the step's first control, else Next
    if (ext) {
      if (document.getElementById(ext.field + '-err')) (document.getElementById(ext.field) || document.getElementById(ext.field + '-field'))?.focus();
      else { setFormAlert(<Alert kind="error"><span>{ext.msg}</span></Alert>); setExt(null); }
    } else {
      const f = api.current.first?.() || content.current?.querySelector<HTMLElement>('input,select,textarea');
      if (f) f.focus(); else next.current?.focus();
    }
    window.scrollTo(0, 0);
    return () => { document.removeEventListener('keydown', onEsc); if (router.getLeaveGuard() === wizardGuard) router.setLeaveGuard(null); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Enter advances (Ctrl/Cmd+Enter in textareas); links to other steps replace history
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (e.key !== 'Enter' || e.isDefaultPrevented()) return;
    if (t.tagName === 'TEXTAREA') { if (e.ctrlKey || e.metaKey) { e.preventDefault(); goNext(); } return; }
    if ((t.tagName === 'INPUT' && !['checkbox', 'button'].includes((t as HTMLInputElement).type)) || t.tagName === 'SELECT') { e.preventDefault(); goNext(); }
  };
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest?.('a[href^="#/new/"]');
    if (a) { e.preventDefault(); router.go(a.getAttribute('href')!, true); }
  };

  const View = STEP_VIEW[step];
  const nextLabel = viaReview ? 'Back to review' : idx < 4 ? 'Next: ' + WLABEL[WSTEPS[idx + 1]] : 'Start build';
  return (
    <div className="wrap" onKeyDown={onKeyDown} onClick={onClick}>
      <div className="sr" role="heading" aria-level={2}>New build</div>
      <Stepper label="Build steps" current={idx} steps={WSTEPS.map(s => ({key: s, label: WSHORT[s], title: WLABEL[s], href: '#/new/' + s}))} />
      <div ref={content}>
        <View register={register} tried={tried} ext={ext} goNext={goNext} setNextBusy={setNextBusy} setFormAlert={setFormAlert} />
      </div>
      <div>{formAlert}</div>
      <WizardFooter
        left={idx > 0 ? <Button variant="ghost" onClick={() => router.go('#/new/' + WSTEPS[idx - 1], true)}><Icon name="chevron-left" />Back</Button> : null}
        right={<Button variant="primary" ref={next} busy={busy} onClick={goNext}>{idx === 4 ? <Icon name="play" /> : null}{nextLabel}</Button>} />
    </div>
  );
}
