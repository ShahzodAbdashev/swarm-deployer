// Deployments: setup checklist until configured; then stat tiles, services (live from targets) and recent deploys.
import {alertBox, btn, errDetail, fmtDur, fmtRel, go, h, icon, isDialogOpen, isMenuOpen, keepFocus, live, menuButton, on, onLeave, put, refresh, retryAlert,
  skeleton, skeletonRows, statusIcon, statusText, toast} from './ui.js';
import {API, focusH1, jobActive, jobDur, jobRow, session, setTitle, startWizard, tagOf} from './app.js';

const ready = c => !!(c.file_server && c.file_server.host) && c.targets.length > 0;
const tileSkeletons = () => h('div', {class: 'tiles'},
  [0, 1, 2, 3].map(i => h('div', {class: 'tile' + (i === 3 ? ' lastt' : '')}, skeleton('60%', 12), skeleton('40%', 24))));

export function dashboardPage(main) {
  setTitle('Deployments');
  const ok = live();
  const head = h('div', {class: 'page-head'}, h('h1', {tabindex: '-1'}, 'Deployments'));
  const body = h('div', null, tileSkeletons(), skeletonRows(2));
  put(main, h('div', {class: 'wrap'}, head, body));
  focusH1();
  API.config().then(cfg => {
    if (!ok()) return;
    if (!ready(cfg)) { put(body, setupChecklist(cfg)); return; }
    head.append(btn('primary', [icon('plus'), 'New deploy'], () => startWizard()));
    // "n" starts a new deploy (only when the New deploy button is shown)
    on(document, 'keydown', e => {
      const tag = document.activeElement?.tagName || '';
      if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey && !/INPUT|TEXTAREA|SELECT/.test(tag) && !isDialogOpen() && !isMenuOpen()) {
        e.preventDefault();
        startWizard();
      }
    });
    overview(body, ok);
  }).catch(e => { if (ok()) put(body, retryAlert("Couldn't load settings. " + errDetail(e).detail, refresh)); });
}

/** First start: the two things to set up before the first deploy, each linking to its Settings section. */
function setupChecklist(cfg) {
  const items = [
    [!!(cfg.file_server && cfg.file_server.host), 'Connect the file server', 'Where Build Packager uploads the zips.', 'file-server'],
    [cfg.targets.length > 0, 'Add a target server', 'The swarm manager Swarm Deployer signs in to over SSH.', 'targets'],
  ];
  return h('section', {class: 'card setup', 'aria-labelledby': 'setup-h'},
    h('div', {class: 'card-head'}, h('h2', {id: 'setup-h'}, 'Get ready to deploy')),
    h('div', {class: 'list'}, items.map(([done, title, text, sec], i) => h('div', {class: 'lrow'},
      h('span', {class: 'num' + (done ? ' ok' : ''), 'aria-hidden': 'true'}, done ? icon('check') : String(i + 1)),
      h('div', {class: 'main'}, h('span', {style: {fontWeight: 500}}, title), h('span', {class: 'meta'}, text)),
      done ? h('span', {class: 'success micro'}, 'Done') : h('a', {class: 'btn secondary', href: '#/settings/' + sec}, 'Set up')))),
    h('p', {class: 'meta', style: {margin: 'var(--s3) var(--s4) 0'}}, h('a', {class: 'link', href: '#/settings/import'}, 'or import a .env')));
}

/** One deployed service: last deploy status, package → service @ target, running version, live state line, actions. */
function serviceRow(s) {
  const last = s.last_deploy;
  let l2, cls = '';
  if (s.error) { l2 = 'Target unreachable: ' + s.error; cls = ' danger'; }
  else if (!s.exists) { l2 = 'Not found on target'; cls = ' warning'; }
  else {
    const p = [s.replicas_running + '/' + s.replicas_desired + ' running', s.current_image || ''];
    if (last) p.push('last deploy ' + (last.status === 'success' ? '✓' : last.status === 'failed' ? '✗' : '●') + ' ' + (last.finished_at ? fmtRel(last.finished_at) : 'running'));
    l2 = p.join(' · ');
  }
  const href = '#/services/' + encodeURIComponent(s.package);
  return h('div', {class: 'srow'},
    h('a', {href, 'data-id': s.package, 'aria-label': s.package + ', ' + l2},
      statusIcon(last ? last.status : 'pending'),
      h('span', {class: 'pk'}, s.package),
      h('span', {class: 'to'}, '→ ' + s.swarm_service + ' @ ' + s.target),
      h('span', {class: 'ver'}, s.current_image ? tagOf(s.current_image) : ''),
      h('span', {class: 'line2' + cls, title: l2}, l2)),
    menuButton('Actions for ' + s.package, () => [
      {label: 'Deploy new version', icon: 'up', run: () => startWizard(s.package)},
      {label: 'Backups & rollback', icon: 'undo', run: () => { session.scrollTo = 'backups'; go(href); }},
      {label: 'History', run: () => { session.scrollTo = 'history'; go(href); }},
    ], 'icon more'));
}

function overview(body, ok) {
  const tiles = tileSkeletons();
  const svcBox = h('div', null, skeletonRows(2));
  const jobsBox = h('div', null, skeletonRows(3));
  put(body, tiles,
    h('section', {'aria-labelledby': 'svc-h'}, h('h2', {id: 'svc-h', style: {marginBottom: 'var(--s3)'}}, 'Services'), svcBox),
    h('section', {class: 'section', 'aria-labelledby': 'recent-h'}, h('h2', {id: 'recent-h'}, 'Recent deploys'), jobsBox));

  let svcs = null, jobs = null, poll = 0, tick = 0;
  const prev = {};
  onLeave(() => { clearTimeout(poll); clearInterval(tick); });

  const loadServices = () => API.services().then(r => {
    if (!ok()) return;
    svcs = r || [];
    put(svcBox, svcs.length ? h('div', {class: 'list'}, svcs.map(serviceRow)) : h('p', {class: 'list-empty'}, 'Nothing deployed yet.'));
  }).catch(e => {
    if (ok() && !svcs) put(svcBox, retryAlert("Couldn't load services. " + errDetail(e).detail, () => { put(svcBox, skeletonRows(2)); loadServices(); }));
  });

  const renderJobs = () => {
    const nOk = jobs.filter(j => j.status === 'success').length, bad = jobs.filter(j => j.status === 'failed').length, last = jobs[0];
    const tile = (label, value, tone) => h('div', {class: 'tile'}, h('span', {class: 'micro'}, label), h('span', {class: 'num ' + (tone || '')}, value));
    put(tiles, tile('Total deploys', jobs.length), tile('Succeeded', nOk, nOk ? 'success' : ''), tile('Failed', bad, bad ? 'danger' : ''),
      last
        ? h('a', {class: 'tile lastt', href: '#/deploys/' + last.id}, h('span', {class: 'micro'}, 'Last deploy'),
          h('span', {class: 'last'}, statusIcon(last.status), h('span', {class: 'sr'}, statusText(last.status) + ': '), last.package,
            h('span', {class: 'muted', style: {fontWeight: 400}}, '· ' + fmtRel(last.created_at))))
        : h('div', {class: 'tile lastt'}, h('span', {class: 'micro'}, 'Last deploy'), h('span', {class: 'last muted'}, 'None yet')));
    keepFocus(jobsBox, () => put(jobsBox, h('div', {class: 'list'}, jobs.length ? jobs.slice(0, 15).map(jobRow)
      : h('p', {class: 'list-empty'}, 'No deploys yet. Start one with New deploy.'))));
  };

  // deploys: load, then poll every 3s while one runs; toast when one finishes; tick durations every second meanwhile
  const loadJobs = async () => {
    let list;
    try { list = await API.deploys(); } catch (e) {
      if (!ok()) return;
      if (jobs) poll = setTimeout(loadJobs, 3000);
      else put(jobsBox, alertBox('error', h('span', null, "Couldn't load deploys. " + errDetail(e).detail)));
      return;
    }
    if (!ok()) return;
    let finished = false;
    for (const j of list) {
      const was = prev[j.id];
      if (was && jobActive({status: was}) && !jobActive(j)) {
        finished = true;
        toast(j.status === 'success' ? j.package + (j.kind === 'rollback' ? ' rolled back' : ' deployed') : j.package + (j.kind === 'rollback' ? ' rollback' : ' deploy') + ' failed',
          j.status === 'success' ? 'success' : 'error');
      }
      prev[j.id] = j.status;
    }
    if (finished) loadServices();
    jobs = list;
    renderJobs();
    const active = list.some(jobActive);
    clearInterval(tick);
    if (active) { poll = setTimeout(loadJobs, 3000); tick = setInterval(tickJobs, 1000); }
  };
  // only the clock texts change between polls: keeps focus/hover on the rows
  const tickJobs = () => jobsBox.querySelectorAll('.jrow a').forEach(a => {
    const j = jobs.find(x => x.id === a.dataset.id);
    if (j) { a.querySelector('.dur').textContent = fmtDur(jobDur(j)); a.querySelector('time').textContent = fmtRel(j.created_at); }
  });
  loadServices();
  loadJobs();
}
