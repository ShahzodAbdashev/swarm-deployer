import {useEffect, useLayoutEffect, useMemo, useState} from 'react';
import {AppShell, errDetail, toast} from '@devtools/ui';
import {authApi} from './api/endpoints';
import {TopBar} from './components/TopBar';
import {DashboardPage} from './pages/Dashboard/DashboardPage';
import {LoginPage} from './pages/Login/LoginPage';
import {NewBuildPage} from './pages/NewBuild/NewBuildPage';
import {RunPage} from './pages/Run/RunPage';
import {SettingsPage} from './pages/Settings/SettingsPage';
import {resolveRoute, router, type View} from './router';
import {getAuth, setAuth, useAuth} from './state/session';

function Page({view}: {view: View}) {
  switch (view.name) {
    case 'login': return <LoginPage />;
    case 'dashboard': return <DashboardPage />;
    case 'new': return <NewBuildPage step={view.step} />;
    case 'job': return <RunPage id={view.id} />;
    case 'settings': return <SettingsPage />;
  }
}

function Routes() {
  const {hash, tick} = router.useRoute();
  // auth changes always come with a navigation, so the route only re-resolves on hash commits
  const res = useMemo(() => resolveRoute(hash), [hash, tick]);
  useLayoutEffect(() => { if ('redirect' in res) router.go(res.redirect, true); }, [res]);
  if ('redirect' in res) return <AppShell topHidden />;
  const view = res.view;
  return (
    <AppShell topHidden={view.name === 'login'} top={<TopBar view={view} />}>
      <Page key={hash + ':' + tick} view={view} />
    </AppShell>
  );
}

export function App() {
  const auth = useAuth();
  const [booting, setBooting] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setBooting(true), 200);
    authApi.status()
      .then(a => setAuth(a))
      .catch(e => { setAuth({logged_in: false, device_flow_available: false}); toast(errDetail(e).detail, 'error'); })
      .finally(() => {
        clearTimeout(t);
        setBooting(false);
        if (!location.hash || location.hash === '#') history.replaceState(null, '', getAuth()?.logged_in ? '#/dashboard' : '#/login');
        router.refresh();
      });
  }, []);
  if (!auth) return <AppShell topHidden booting={booting} />;
  return <Routes />;
}
