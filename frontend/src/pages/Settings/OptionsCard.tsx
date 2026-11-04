import {useState, type KeyboardEvent, type ReactNode} from 'react';
import {Alert, Button, Input, errDetail} from '@devtools/ui';
import {configApi} from '../../api/endpoints';
import {GridRow, TestRes} from '../../components/GridRow';
import {detailField, firstErr, intErr} from '../../lib/validate';
import type {Config, Options} from '../../types/api';

const API_FIELD: Record<string, string> = {keep_backups: 'op-keep', converge_timeout: 'op-conv', update_monitor: 'op-mon', health_timeout: 'op-ht'};
const formOf = (o: Options) => ({keep: String(o.keep_backups), tar: o.save_image_tar, prune: !!o.prune_after, conv: String(o.converge_timeout), mon: String(o.update_monitor),
  ht: String(o.health_timeout)});

/** Backup retention, default .tar backup, rollout timeouts. */
export function OptionsCard({cfg, onSaved}: {cfg: Config; onSaved: (o: Options) => void}) {
  const [f, setF] = useState(() => formOf(cfg.options));
  const [errs, setErrs] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ReactNode>(null);
  const v = {keep_backups: Number(f.keep), save_image_tar: f.tar, prune_after: f.prune, converge_timeout: Number(f.conv), update_monitor: Number(f.mon), health_timeout: Number(f.ht)};
  const set = (patch: Partial<typeof f>) => setF(x => ({...x, ...patch}));

  const save = async () => {
    setRes(null);
    const e = {
      'op-keep': intErr(v.keep_backups, 1, 50), 'op-conv': intErr(v.converge_timeout, 10, 1800),
      'op-mon': intErr(v.update_monitor, 1, 600), 'op-ht': intErr(v.health_timeout, 1, 600),
    };
    setErrs(e);
    const bad = firstErr(e);
    if (bad) { document.getElementById(bad)?.focus(); return; }
    setBusy(true);
    try { const r = await configApi.putOptions(v); setBusy(false); setF(formOf(r)); onSaved(r); setRes(<TestRes ok msg="Saved." />); }
    catch (err) {
      setBusy(false);
      const d = errDetail(err).detail, id = detailField(d, pre => API_FIELD[pre]);
      if (id) { setErrs({[id]: d}); document.getElementById(id)?.focus(); }
      else setRes(<div style={{marginTop: 'var(--s3)'}}><Alert kind="error"><span>{d}</span></Alert></div>);
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const t = e.target as HTMLInputElement;
    if (e.key === 'Enter' && t.tagName === 'INPUT' && t.type !== 'checkbox') { e.preventDefault(); void save(); }
  };
  const num = (k: 'keep' | 'conv' | 'mon' | 'ht', a: number, b: number) => (
    <Input type="number" min={String(a)} max={String(b)} inputMode="numeric" style={{maxWidth: 140}} value={f[k]} onChange={e => set({[k]: e.target.value})} />
  );
  return (
    <section className="card" id="options" aria-labelledby="op-h" onKeyDown={onKeyDown}>
      <div className="card-head"><h2 id="op-h">Backup &amp; deploy options</h2></div>
      <div className="form-grid">
        <GridRow id="op-keep" label="Keep backups" help="Per service. Older backup dirs and tags are pruned (1–50)." error={errs['op-keep']}>{num('keep', 1, 50)}</GridRow>
        <span className="lbl">Image .tar</span>
        <div className="ctl">
          <label className="cbx"><input type="checkbox" id="op-tar" checked={f.tar} onChange={e => set({tar: e.target.checked})} /><span>Save the current image as a .tar in every backup by default</span></label>
        </div>
        <span className="lbl">Prune</span>
        <div className="ctl">
          <label className="cbx"><input type="checkbox" id="op-prune" aria-describedby="op-prune-help" checked={f.prune} onChange={e => set({prune: e.target.checked})} /><span>Run docker system prune -f on the target after a successful deploy</span></label>
          <p className="help" id="op-prune-help">Same as the CI's prune: removes all stopped containers on the manager and unused networks (also a stopped stack's networks), dangling images and build cache.</p>
        </div>
        <GridRow id="op-conv" label="Converge timeout" help="Seconds to wait for all tasks to run the new image (10–1800)." error={errs['op-conv']}>{num('conv', 10, 1800)}</GridRow>
        <GridRow id="op-mon" label="Update monitor" help="Seconds swarm watches each task before it counts as updated (1–600)." error={errs['op-mon']}>{num('mon', 1, 600)}</GridRow>
        <GridRow id="op-ht" label="Health timeout" help="Seconds to wait for the health check URL (1–600)." error={errs['op-ht']}>{num('ht', 1, 600)}</GridRow>
      </div>
      <div className="wfoot"><span className="spacer" /><Button variant="primary" busy={busy ? 'Saving…' : null} onClick={save}>Save</Button></div>
      <div aria-live="polite">{res}</div>
    </section>
  );
}
