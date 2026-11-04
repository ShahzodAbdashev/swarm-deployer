import {useEffect, useRef, useState} from 'react';
import {Alert, Button, Field, Icon, Input, RadioCards, Skeleton, StepHead, errDetail, sset, toast} from '@devtools/ui';
import {uploadApi} from '../../../api/endpoints';
import {uploadConfigured, uploadTarget} from '../../../lib/jobs';
import {remotePathErr} from '../../../lib/validate';
import {router} from '../../../router';
import {getDraft, updateDraft, useDraft} from '../../../state/draft';
import {session} from '../../../state/session';
import type {UploadConfig} from '../../../types/api';
import {shownErrors, type StepProps} from '../stepApi';

const toSettings = () => { sset('bp.return', '#/new/upload'); router.go('#/settings'); };

/** Step 4: upload to the configured server (per-build remote path) or keep the zip local. */
export function UploadStep({register, tried, ext}: StepProps) {
  const draft = useDraft();
  const [cfg, setCfg] = useState<UploadConfig | null | undefined>(undefined);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [turningOn, setTurningOn] = useState(false);
  const [path, setPath] = useState('');
  const pathRef = useRef(path);
  pathRef.current = path;

  const configured = uploadConfigured(cfg);
  const validate = () => {
    const m = configured && getDraft().upload ? remotePathErr(pathRef.current.trim()) : null;
    return m ? [['remote_path', m] as [string, string]] : [];
  };
  const errs = shownErrors(tried, validate(), ext);
  register({validate, first: () => null});

  const paint = (c: UploadConfig | null, err?: string) => {
    session.uploadCfg = c;
    setCfg(c);
    setLoadErr(err || null);
    if (c) setPath(getDraft().remote_dir || c.remote_dir);
  };
  useEffect(() => {
    let dead = false;
    uploadApi.get().then(c => { if (!dead) paint(c); }).catch(() => { if (!dead) paint(null, "Couldn't read upload settings. This build will skip upload."); });
    return () => { dead = true; };
  }, []);

  // once the server choice appears, focus the selected radio (unless the user already moved on)
  useEffect(() => {
    if (!configured) return;
    const ae = document.activeElement;
    if (ae === document.getElementById('main') || ae === document.body || (ae as HTMLElement | null)?.closest?.('.wfoot')) {
      (document.querySelector<HTMLInputElement>('input[name=upload]:checked') || document.querySelector<HTMLInputElement>('input[name=upload]'))?.focus();
    }
  }, [configured]);

  const head = <StepHead title="Upload" sub="Send the zip to your server when it's ready." />;
  if (cfg === undefined) return <>{head}<div><Skeleton w="70%" h={16} /></div></>;

  if (configured && cfg) {
    return (
      <>{head}
        <div>
          <RadioCards name="upload" label="Upload" value={String(draft.upload) as 'true' | 'false'}
            onChange={v => updateDraft({upload: v === 'true'})}
            options={[
              {value: 'true', title: 'Upload to server', desc: uploadTarget(cfg, true, path.trim() || undefined), descMono: true},
              {value: 'false', title: "Don't upload", desc: 'Keep the zip on this computer and download it from the build page.'},
            ]} />
          <Field id="remote_path" label="Remote path" help="Full path on the server for this build. Missing folders are created."
            error={draft.upload ? errs.remote_path : null} hidden={!draft.upload} style={{marginTop: 'var(--s4)'}}>
            <Input mono placeholder="/home/deploy/releases" value={path}
              onChange={e => { setPath(e.target.value); updateDraft({remote_dir: e.target.value.trim()}); }} />
          </Field>
          <p className="meta" style={{marginTop: 'var(--s4)'}}>
            <a href="#/settings" onClick={e => { e.preventDefault(); e.stopPropagation(); toSettings(); }}><Icon name="gear" /> Server settings</a>
          </p>
        </div>
      </>
    );
  }
  if (cfg && cfg.host && !cfg.enabled) {
    const turnOn = async () => {
      setTurningOn(true);
      try { const c2 = await uploadApi.put({enabled: true}); updateDraft({upload: true}); toast('Uploads turned on', 'success'); paint(c2); }
      catch (e) { toast(errDetail(e).detail, 'error'); }
      finally { setTurningOn(false); }
    };
    return (
      <>{head}
        <div>
          <Alert kind="warning" icon="info">
            <b>Uploads are turned off in settings</b>
            <span className="mono" style={{overflowWrap: 'anywhere'}}>{uploadTarget(cfg, true)}</span>
            <span>Turn them on to send this zip there, or continue and keep it on this computer.</span>
            <div className="row-flex" style={{flexWrap: 'wrap'}}>
              <Button variant="secondary" busy={turningOn ? 'Turning on…' : null} onClick={turnOn}>Turn on</Button>
              <Button variant="ghost" onClick={toSettings}>Server settings</Button>
            </div>
          </Alert>
        </div>
      </>
    );
  }
  return (
    <>{head}
      <div>
        {loadErr ? <div style={{marginBottom: 'var(--s3)'}}><Alert kind="error"><span>{loadErr}</span></Alert></div> : null}
        <Alert kind="warning" icon="info">
          <b>No upload server is set up</b>
          <span>The zip will stay on this computer. You can download it when the build finishes.</span>
          <div><Button variant="secondary" onClick={toSettings}>Set up a server</Button></div>
        </Alert>
      </div>
    </>
  );
}
