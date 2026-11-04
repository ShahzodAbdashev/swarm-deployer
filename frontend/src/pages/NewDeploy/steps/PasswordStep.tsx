import {useRef, useState} from 'react';
import {Alert, Field, Icon, PasswordInput, StepHead} from '@devtools/ui';
import {basename} from '../../../lib/format';
import {draftFormat, getDraft, updateDraft, useDraft} from '../../../state/draft';
import {session} from '../../../state/session';
import {shownErrors, type StepErrors, type StepProps} from '../stepApi';

function validate(): StepErrors {
  const pw = getDraft().password;
  const m = !pw ? 'Enter the zip password.' : pw.length > 1024 ? 'Max 1024 characters.' : null;
  return m ? [['zip_password', m]] : [];
}

/** Step 2: the zip password set in Build Packager. Memory only: never stored, dropped when the wizard is left. */
export function PasswordStep({register, tried, ext}: StepProps) {
  const draft = useDraft();
  const [note] = useState(() => { const n = session.note; session.note = null; return n; });
  const [caps, setCaps] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const errs = shownErrors(tried, validate(), ext);
  register({validate, first: () => input.current});
  return (
    <>
      <StepHead title="Unlock the package"
        sub={<><span className="mono" style={{overflowWrap: 'anywhere'}}>{basename(draft.package_path)}</span><a href="#/new/package">Change</a></>} />
      {note ? <div style={{marginBottom: 'var(--s5)'}}><Alert kind="info"><span>{note}</span></Alert></div> : null}
      <div className="stack">
        <Field id="zip_password" label="Zip password" help="The password you set in Build Packager. It's used once and never saved." error={errs.zip_password}>
          <PasswordInput ref={input} autoComplete="off" data-secret="1" value={draft.password} onCapsLock={setCaps}
            onChange={e => updateDraft({password: e.target.value})} />
        </Field>
        <p className="help" hidden={!caps}><Icon name="alert" /> Caps Lock is on</p>
        {draftFormat() === 'tarzip' ? <p className="help" id="pw-zipcrypto">build_tar.sh zips use ZipCrypto, which unpacks slowly (about 1 MB/s; watch the log). AES zips from Build Packager are much faster.</p> : null}
      </div>
    </>
  );
}
