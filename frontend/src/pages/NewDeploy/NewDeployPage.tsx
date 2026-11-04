import {useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode} from 'react';
import {flushSync} from 'react-dom';
import {Alert, Button, Icon, Stepper, WizardFooter, isDialogOpen, isMenuOpen} from '@devtools/ui';
import {WLABEL, WSTEPS, router, setTitle, type WizardStepKey} from '../../router';
import {session, type PendingErr} from '../../state/session';
import type {StepApi, StepProps} from './stepApi';
import {PackageStep} from './steps/PackageStep';
import {PasswordStep} from './steps/PasswordStep';
import {ReviewStep} from './steps/ReviewStep';
import {wizardCancel, wizardGuard} from './wizard';

const STEP_VIEW: Record<WizardStepKey, (p: StepProps) => ReactNode> = {
  package: PackageStep, password: PasswordStep, review: ReviewStep,
};

/**
 * New deploy wizard frame: stepper, the current step, footer with Back / Next.
 * Steps replace each other in history, so browser Back leaves the wizard instead of replaying it.
 */
export function NewDeployPage({step}: {step: WizardStepKey}) {
  const idx = WSTEPS.indexOf(step);
  const [viaReview] = useState(() => {
    if (step === 'review') session.fromReview = false;
    return session.fromReview && step !== 'review';
  });
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
    const errs = api.current.validate();
    if (errs.length) { document.getElementById(errs[0][0])?.focus(); return; }
    if (api.current.submit) { void api.current.submit(); return; }
    router.go(viaReview ? '#/new/review' : '#/new/' + WSTEPS[idx + 1], true);
  }, [step, idx, viaReview]);

  useEffect(() => {
    setTitle('New deploy · ' + WLABEL[step]);
    router.setLeaveGuard(wizardGuard);
    const onEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !isDialogOpen() && !isMenuOpen() && !e.defaultPrevented) { e.preventDefault(); wizardCancel(); }
    };
    document.addEventListener('keydown', onEsc);
    // initial focus: the server error's field, else the step's first control, else the step title
    if (ext) {
      if (document.getElementById(ext.field + '-err')) document.getElementById(ext.field)?.focus();
      else { setFormAlert(<div style={{marginTop: 'var(--s5)'}}><Alert kind="error"><span>{ext.msg}</span></Alert></div>); setExt(null); }
    } else {
      const f = api.current.first ? api.current.first() : content.current?.querySelector<HTMLElement>('input,select,textarea');
      (f || content.current?.querySelector<HTMLElement>('h1'))?.focus();
    }
    window.scrollTo(0, 0);
    return () => { document.removeEventListener('keydown', onEsc); if (router.getLeaveGuard() === wizardGuard) router.setLeaveGuard(null); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Enter in a text/radio input advances, except inside forms that handle Enter themselves (mapping form)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLInputElement;
    if (e.key !== 'Enter' || e.isDefaultPrevented() || t.closest('[data-own-enter]')) return;
    if (t.tagName === 'INPUT' && !['checkbox', 'button'].includes(t.type)) { e.preventDefault(); goNext(); }
  };
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest?.('a[href^="#/new/"]');
    if (a) { e.preventDefault(); router.go(a.getAttribute('href')!, true); }
  };

  const View = STEP_VIEW[step];
  const nextLabel = viaReview ? 'Back to review' : idx < WSTEPS.length - 1 ? 'Next: ' + WLABEL[WSTEPS[idx + 1]] : 'Deploy';
  return (
    <div className="wrap" onKeyDown={onKeyDown} onClick={onClick}>
      <div className="sr" role="heading" aria-level={2}>New deploy</div>
      <Stepper label="Deploy steps" current={idx} steps={WSTEPS.map(s => ({key: s, label: WLABEL[s], title: WLABEL[s], href: '#/new/' + s}))} />
      <div ref={content}>
        <View register={register} tried={tried} ext={ext} goNext={goNext} setNextBusy={setNextBusy} setFormAlert={setFormAlert} nextRef={next} />
      </div>
      <div>{formAlert}</div>
      <WizardFooter
        left={idx > 0 ? <Button variant="ghost" onClick={() => router.go('#/new/' + WSTEPS[idx - 1], true)}><Icon name="chevron-left" />Back</Button> : null}
        right={<Button variant="primary" ref={next} busy={busy} onClick={goNext}>{idx === 3 ? <Icon name="play" /> : null}{nextLabel}</Button>} />
    </div>
  );
}
