import {useRef, useState} from 'react';
import {Alert, Field, Icon, PasswordInput, StepHead, copyText, toast} from '@devtools/ui';
import {updateDraft, useDraft, type Draft} from '../../../state/draft';
import {session} from '../../../state/session';
import {shownErrors, type StepErrors, type StepProps} from '../stepApi';

function validate(d: Draft): StepErrors {
  const errs: StepErrors = [];
  const a = d.password.length < 4 ? 'At least 4 characters.' : null;
  const b = !a && d.password !== d.password_confirm ? "Passwords don't match." : null;
  if (a) errs.push(['password', a]);
  if (b) errs.push(['password_confirm', b]);
  return errs;
}

const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** Step 3: zip password (twice). Lives in memory only, never in storage or the URL. */
export function PasswordStep({register, tried, ext}: StepProps) {
  const draft = useDraft();
  const [note] = useState(() => { const n = session.note; session.note = null; return n; });
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);
  const p1 = useRef<HTMLInputElement>(null);
  const p2 = useRef<HTMLInputElement>(null);
  const errs = shownErrors(tried, validate(draft), ext);
  register({validate, first: () => p1.current});

  const a = draft.password.length >= 4, b = draft.password.length > 0 && draft.password === draft.password_confirm;
  const generate = async () => {
    const buf = new Uint32Array(20);
    crypto.getRandomValues(buf);
    const pw = [...buf].map(n => ABC[n % ABC.length]).join('');
    updateDraft({password: pw, password_confirm: pw});
    setShown(true);
    if (await copyText(pw)) toast('Password copied. Store it somewhere safe.', 'success');
  };
  return (
    <>
      <StepHead title="Protect the zip" sub="The zip is encrypted with AES-256. Anyone who opens it will need this password." />
      {note ? <div style={{marginBottom: 'var(--s5)'}}><Alert kind="info"><span>{note}</span></Alert></div> : null}
      <div className="stack">
        <Field id="password" label="Password" error={errs.password}>
          <PasswordInput ref={p1} autoComplete="new-password" data-secret="1" value={draft.password} shown={shown} onShownChange={setShown} onCapsLock={setCaps}
            onChange={e => updateDraft({password: e.target.value})}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); p2.current?.focus(); } }} />
        </Field>
        <Field id="password_confirm" label="Confirm password" error={errs.password_confirm}>
          <PasswordInput ref={p2} autoComplete="new-password" data-secret="1" value={draft.password_confirm} shown={shown} onShownChange={setShown} onCapsLock={setCaps}
            onChange={e => updateDraft({password_confirm: e.target.value})} />
        </Field>
        <p className="help" hidden={!caps}><Icon name="alert" /> Caps Lock is on</p>
        <ul className="checklist" aria-live="polite">
          <li className={a ? 'ok' : ''}><Icon name={a ? 'check' : 'circle'} />At least 4 characters</li>
          <li className={b ? 'ok' : ''}><Icon name={b ? 'check' : 'circle'} />Passwords match</li>
        </ul>
        <div><button className="link" type="button" onClick={generate}>Generate a strong password</button></div>
        <Alert kind="info"><span>The password is never saved. Store it somewhere safe before you start.</span></Alert>
      </div>
    </>
  );
}
