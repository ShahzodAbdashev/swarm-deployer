import {Icon, Logo} from '@devtools/ui';
import {wizardCancel} from '../pages/NewDeploy/wizard';
import type {View} from '../router';

/** Top bar: logo + Settings; inside the wizard only logo + Cancel. */
export function TopBar({view}: {view: View}) {
  const logo = <Logo href="#/dashboard" name="Swarm Deployer" icon="up" mark />;
  if (view.name === 'new') {
    return <>{logo}<span className="spacer" /><button className="btn ghost" type="button" onClick={() => wizardCancel()}>Cancel<kbd className="hide-sm">Esc</kbd></button></>;
  }
  return (
    <>
      {logo}
      <span className="spacer" />
      <a className="btn ghost" href="#/settings" aria-label="Settings" aria-current={view.name === 'settings' ? 'page' : undefined}>
        <Icon name="gear" /><span className="hide-sm">Settings</span>
      </a>
    </>
  );
}
