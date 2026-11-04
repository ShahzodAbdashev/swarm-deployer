import {Avatar, Icon, Logo, MenuButton, errDetail, toast} from '@devtools/ui';
import {authApi} from '../api/endpoints';
import {wizardCancel} from '../pages/NewBuild/wizard';
import {router, type View} from '../router';
import {resetDraft} from '../state/draft';
import {getAuth, session, setAuth, useAuth} from '../state/session';

async function signOut() {
  try { await authApi.logout(); } catch (e) { toast(errDetail(e).detail, 'error'); return; }
  const gl = getAuth()?.gitlab;
  setAuth({logged_in: false, login: null, avatar_url: null, provider: null, github: {logged_in: false, login: null},
    ...(gl ? {gitlab: {...gl, logged_in: false, login: null, avatar_url: null, method: null}} : {})});
  session.repos = null;
  session.branches = {};
  resetDraft();
  session.returnTo = null;
  toast('Signed out');
  router.go('#/login');
}

/** Top bar: logo + Settings + account menu; inside the wizard only logo + Cancel. */
export function TopBar({view}: {view: View}) {
  const auth = useAuth();
  const logo = <Logo href="#/dashboard" name="Build Packager" />;
  if (view.name === 'new') {
    return <>{logo}<span className="spacer" /><button className="btn ghost" type="button" onClick={() => wizardCancel()}>Cancel<kbd className="hide-sm">Esc</kbd></button></>;
  }
  const login = auth?.login || '';
  return (
    <>
      {logo}
      <span className="spacer" />
      <a className="btn ghost" href="#/settings" aria-label="Settings" aria-current={view.name === 'settings' ? 'page' : undefined}>
        <Icon name="gear" /><span className="hide-sm">Settings</span>
      </a>
      <MenuButton label="Account menu" className="user-btn" items={() => [{note: 'Signed in as @' + login}, '-', {label: 'Sign out', run: signOut}]}>
        <Avatar login={auth?.login || '?'} url={auth?.avatar_url} />
        <span className="hide-sm">{login}</span>
        <Icon name="chevron-down" />
      </MenuButton>
    </>
  );
}
