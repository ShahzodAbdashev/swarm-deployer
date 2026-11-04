import {useMemo, useLayoutEffect} from 'react';
import {AppShell} from '@devtools/ui';
import {TopBar} from './components/TopBar';
import {DashboardPage} from './pages/Dashboard/DashboardPage';
import {NewDeployPage} from './pages/NewDeploy/NewDeployPage';
import {RunPage} from './pages/Run/RunPage';
import {ServicePage} from './pages/Service/ServicePage';
import {SettingsPage} from './pages/Settings/SettingsPage';
import {resolveRoute, router, type View} from './router';

function Page({view}: {view: View}) {
  switch (view.name) {
    case 'dashboard': return <DashboardPage />;
    case 'service': return <ServicePage pkg={view.pkg} />;
    case 'new': return <NewDeployPage step={view.step} />;
    case 'deploy': return <RunPage id={view.id} />;
    case 'settings': return <SettingsPage section={view.section} />;
  }
}

/** Every hash commit remounts the page (fresh state, like a navigation). Opens straight on the dashboard: no sign-in. */
export function App() {
  const {hash, tick} = router.useRoute();
  const res = useMemo(() => resolveRoute(hash), [hash, tick]);
  useLayoutEffect(() => { if ('redirect' in res) router.go(res.redirect, true); }, [res]);
  if ('redirect' in res) return <AppShell topHidden />;
  const view = res.view;
  return (
    <AppShell top={<TopBar view={view} />}>
      <Page key={hash + ':' + tick} view={view} />
    </AppShell>
  );
}
