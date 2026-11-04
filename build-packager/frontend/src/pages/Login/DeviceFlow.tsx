import {useEffect, useRef, useState} from 'react';
import {Alert, Button, Icon, Spinner, copyText, errDetail, toast} from '@devtools/ui';
import {authApi} from '../../api/endpoints';
import type {DeviceStart, LoginResult} from '../../types/api';

type Phase = {kind: 'starting'} | {kind: 'waiting'; d: DeviceStart} | {kind: 'failed'; msg: string; again: string};

/** GitHub OAuth device flow: show the code, poll until authorized, expire after `expires_in`. */
export function DeviceFlow({onSuccess, onBack}: {onSuccess: (d: LoginResult) => void; onBack: () => void}) {
  const [phase, setPhase] = useState<Phase>({kind: 'starting'});
  const [left, setLeft] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const againRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let dead = false, poll = 0, tick = 0;
    const stop = () => { clearTimeout(poll); clearInterval(tick); };
    const fail = (msg: string, again: string) => { stop(); if (!dead) setPhase({kind: 'failed', msg, again}); };
    setPhase({kind: 'starting'});
    authApi.deviceStart().then(async d => {
      if (dead) return;
      let interval = (d.interval || 5) * 1000, remaining = d.expires_in || 900;
      setLeft(remaining);
      setPhase({kind: 'waiting', d});
      tick = window.setInterval(() => {
        remaining = Math.max(0, remaining - 1);
        setLeft(remaining);
        if (!remaining) fail('The code expired.', 'Get a new code');
      }, 1000);
      if (await copyText(d.user_code)) toast('Code copied');
      const doPoll = async () => {
        let r;
        try { r = await authApi.devicePoll(d.device_code); }
        catch (e) { return fail('Sign-in failed: ' + errDetail(e).detail + '.', 'Try again'); }
        if (dead) return;
        if (r.status === 'ok') { stop(); return onSuccess(r as LoginResult); }
        if (r.status === 'slow_down') interval = (r.interval || 10) * 1000;
        if (r.status === 'error') {
          if (r.error === 'expired_token') return fail('The code expired.', 'Get a new code');
          if (r.error === 'access_denied') return fail('Authorization was denied on GitHub.', 'Try again');
          return fail('Sign-in failed: ' + r.error + '.', 'Try again');
        }
        poll = window.setTimeout(doPoll, interval);
      };
      poll = window.setTimeout(doPoll, interval);
    }).catch(e => { if (!dead) { toast(errDetail(e).detail, 'error'); onBack(); } });
    return () => { dead = true; stop(); };
  }, [attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (phase.kind === 'failed') againRef.current?.focus(); }, [phase.kind]);

  if (phase.kind === 'starting') return <Button variant="secondary" size="lg" full busy="Requesting code…">Sign in with a device code</Button>;
  if (phase.kind === 'failed') {
    return (
      <>
        <Alert kind="error"><span>{phase.msg}</span></Alert>
        <Button variant="secondary" ref={againRef} onClick={() => setAttempt(a => a + 1)}>{phase.again}</Button>
        <Button variant="ghost" onClick={onBack}>Back</Button>
      </>
    );
  }
  const {d} = phase;
  const vuri = d.verification_uri || 'https://github.com/login/device';
  return (
    <>
      <p className="muted">Enter this code on GitHub</p>
      <div className="row-flex" style={{justifyContent: 'center'}}>
        <span className="code-box">{d.user_code}</span>
        <Button variant="secondary" onClick={async () => { if (await copyText(d.user_code)) toast('Code copied'); }}><Icon name="copy" />Copy</Button>
      </div>
      <a className="btn primary lg full" href={vuri} target="_blank" rel="noopener">{'Open ' + vuri.replace(/^https?:\/\//, '')}<Icon name="external" /></a>
      <div className="waiting" aria-live="polite">
        <Spinner /><span>Waiting for authorization…</span>
        <span className="faint">{Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') + ' left'}</span>
      </div>
      <Button variant="ghost" onClick={onBack}>Cancel</Button>
    </>
  );
}
