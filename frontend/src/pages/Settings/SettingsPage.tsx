import {useEffect, useState} from 'react';
import {Alert, Button, Icon, Skeleton, errDetail, sget} from '@devtools/ui';
import {configApi} from '../../api/endpoints';
import {focusH1, setTitle} from '../../router';
import type {Config, EnvImportResult} from '../../types/api';
import {FileServerCard} from './FileServerCard';
import {GitlabCard} from './GitlabCard';
import {ImportCard} from './ImportCard';
import {OptionsCard} from './OptionsCard';
import {TargetsCard} from './TargetsCard';

const SECS: [string, string][] = [['file-server', 'File server'], ['targets', 'Target servers'],
  ['options', 'Backup & deploy options'], ['gitlab', 'GitLab'], ['import', 'Import .env']];

/** All settings on one page; #/settings/<section> scrolls to that card. Cards share one config object. */
export function SettingsPage({section}: {section: string}) {
  const [ret] = useState(() => sget('sd.return'));
  const [cfg, setCfg] = useState<Config | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [imported, setImported] = useState<EnvImportResult | null>(null);
  useEffect(() => { setTitle('Settings'); focusH1(); }, []);
  useEffect(() => {
    setLoadErr(null);
    configApi.get().then(setCfg).catch(e => setLoadErr("Couldn't load settings. " + errDetail(e).detail));
  }, [reload]);
  const loaded = !!cfg;
  useEffect(() => { if (loaded && section) document.getElementById(section)?.scrollIntoView({block: 'start'}); }, [loaded, section]);
  const patch = (p: Partial<Config>) => setCfg(c => (c ? {...c, ...p} : c));

  return (
    <div className="wrap">
      <a className="back-link" href={ret || '#/dashboard'}><Icon name="chevron-left" />{ret ? 'Back to deploy' : 'Deployments'}</a>
      <div className="step-head">
        <h1 tabIndex={-1}>Settings</h1>
        <p className="sub">Where packages come from, where they go, and how deploys are backed up.</p>
      </div>
      <nav className="secnav" aria-label="Settings sections">
        {SECS.map(([id, label]) => <a key={id} className="btn ghost" href={'#/settings/' + id} aria-current={section === id ? 'true' : undefined}>{label}</a>)}
      </nav>
      <div>
        {loadErr ? <Alert kind="error"><span>{loadErr}</span><div><Button variant="ghost" onClick={() => setReload(r => r + 1)}>Retry</Button></div></Alert>
          : !cfg ? <div className="stack">{[0, 1, 2].map(i => <Skeleton key={i} w="100%" h={120} />)}</div>
            : (
              <>
                <FileServerCard cfg={cfg} onSaved={fs => patch({file_server: fs})} />
                <TargetsCard cfg={cfg} onChange={targets => patch({targets})} />
                <OptionsCard cfg={cfg} onSaved={options => patch({options})} />
                <GitlabCard cfg={cfg} onSaved={gitlab => patch({gitlab})} />
                <ImportCard result={imported} onImported={r => { setImported(r); setCfg(null); setReload(x => x + 1); }} />
              </>
            )}
      </div>
    </div>
  );
}
