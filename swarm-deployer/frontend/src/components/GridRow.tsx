import type {ReactNode} from 'react';
import {ErrorText, FieldControl, Icon} from '@devtools/ui';

/**
 * One label/control row of a `.form-grid` (settings forms): `<label for=id>` + `.ctl#<id>-row` with the control,
 * extra nodes, help and the `<id>-err` line. The control gets id/aria wiring from FieldControl.
 */
export function GridRow({id, label, help, error, hidden, children, extra}: {
  id: string; label: string; help?: ReactNode; error?: string | null; hidden?: boolean; children: ReactNode; extra?: ReactNode;
}) {
  return (
    <>
      <label className="lbl" htmlFor={id} hidden={hidden}>{label}</label>
      <div className="ctl" id={id + '-row'} hidden={hidden}>
        <FieldControl id={id} help={!!help} error={error}>{children}</FieldControl>
        {extra}
        {help ? <p className="help" id={id + '-help'}>{help}</p> : null}
        <ErrorText id={id + '-err'} msg={error} />
      </div>
    </>
  );
}

/** Inline result line under a form: green check or red cross with the message. */
export function TestRes({ok, msg}: {ok: boolean; msg: string}) {
  return <div className={'test-res ' + (ok ? 'ok' : 'bad')}><Icon name={ok ? 'check' : 'x'} /><span>{msg}</span></div>;
}
