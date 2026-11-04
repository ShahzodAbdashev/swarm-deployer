import {useEffect, useState} from 'react';
import {Alert, Button, Icon, SkeletonRows, confirm, errDetail, fmtRel, toast} from '@devtools/ui';
import {rollbacksApi, servicesApi} from '../../api/endpoints';
import {localT} from '../../lib/format';
import {router} from '../../router';
import type {Backup, Service} from '../../types/api';

/** Backups on the target, newest first; "Roll back" asks, then starts a rollback job and opens it. */
export function Backups({pkg, svc, onLoaded}: {pkg: string; svc: Service; onLoaded: () => void}) {
  const [list, setList] = useState<Backup[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [key, setKey] = useState(0);
  useEffect(() => {
    let dead = false;
    setErr(null);
    servicesApi.backups(pkg).then(l => { if (!dead) setList(l); }).catch(e => { if (!dead) setErr("Couldn't read backups. " + errDetail(e).detail); });
    return () => { dead = true; };
  }, [pkg, key]);
  useEffect(() => { if (list) onLoaded(); }, [list]); // eslint-disable-line react-hooks/exhaustive-deps

  const rollback = async (b: Backup) => {
    const ok = await confirm({title: 'Roll back ' + svc.swarm_service + '?', confirm: 'Roll back',
      body: <>The service will run <code>{b.previous_image}</code>{' (backup from ' + localT(b.created_at) + '). A new backup of the current version is made first.'}</>});
    if (!ok) return;
    try { const j = await rollbacksApi.create(pkg, b.id); router.go('#/deploys/' + j.id); }
    catch (e) { toast(errDetail(e).detail, 'error'); }
  };

  if (err) return <Alert kind="error"><span>{err}</span><div><Button variant="ghost" onClick={() => setKey(k => k + 1)}>Retry</Button></div></Alert>;
  if (!list) return <SkeletonRows n={2} />;
  if (!list.length) return <div className="list"><p className="list-empty">No backups yet. Every deploy backs up the running version first.</p></div>;
  return (
    <div className="list">
      {list.map(b => {
        const usable = b.tag_present || b.has_image_tar || !!b.in_registry;
        return (
          <div className="lrow" key={b.id}>
            <div className="main">
              <span><span style={{fontWeight: 500}}>{fmtRel(b.created_at)}</span><span className="muted">{' · ' + localT(b.created_at)}</span></span>
              <span><span className="faint micro">Restores </span><span className="mono" data-k="image">{b.previous_image || '—'}</span>{b.in_registry ? <span className="badge micro" style={{marginLeft: 8}}>in registry</span> : null}</span>
              {b.tag_present
                ? <span><span className="faint micro">Backup tag </span><span className="mono muted">{b.backup_tag}</span></span>
                : <span className="faint micro">{b.has_image_tar ? 'tag removed · restores from image.tar' : 'image gone'}</span>}
            </div>
            <div className="acts">
              <Button variant="secondary" disabled={!usable} title={usable ? undefined : 'The backup image is gone'} onClick={() => rollback(b)}><Icon name="undo" />Roll back</Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
