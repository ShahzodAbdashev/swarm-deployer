import {Icon} from '@devtools/ui';
import type {Config} from '../../types/api';

/** First start: the two things to set up before the first deploy, each linking to its Settings section. */
export function SetupChecklist({cfg}: {cfg: Config}) {
  const items: [boolean, string, string, string][] = [
    [!!(cfg.file_server && cfg.file_server.host), 'Connect the file server', 'Where Build Packager uploads the zips.', 'file-server'],
    [cfg.targets.length > 0, 'Add a target server', 'The swarm manager Swarm Deployer signs in to over SSH.', 'targets'],
  ];
  return (
    <section className="card setup" aria-labelledby="setup-h">
      <div className="card-head"><h2 id="setup-h">Get ready to deploy</h2></div>
      <div className="list">
        {items.map(([done, title, text, sec], i) => (
          <div className="lrow" key={sec}>
            <span className={'num' + (done ? ' ok' : '')} aria-hidden="true">{done ? <Icon name="check" /> : String(i + 1)}</span>
            <div className="main"><span style={{fontWeight: 500}}>{title}</span><span className="meta">{text}</span></div>
            {done ? <span className="success micro">Done</span> : <a className="btn secondary" href={'#/settings/' + sec}>Set up</a>}
          </div>
        ))}
      </div>
      <p className="meta" style={{margin: 'var(--s3) var(--s4) 0'}}><a className="link" href="#/settings/import">or import a .env</a></p>
    </section>
  );
}
