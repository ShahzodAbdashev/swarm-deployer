// One mapped service: what runs now on the swarm, its backups (manual rollback) and its deploy history.
import {alertBox, btn, confirm, emptyState, errDetail, fmtRel, go, h, icon, live, put, retryAlert, skeleton, skeletonRows, statusText,
  toast} from './ui.js';
import {API, focusH1, jobRow, localT, session, setTitle, startWizard} from './app.js';

/** Scroll to the section the dashboard menu asked for, once its content is there. */
function scrollPending() {
  const el = session.scrollTo && document.getElementById(session.scrollTo);
  if (el) { el.scrollIntoView({block: 'start'}); session.scrollTo = null; }
}

export function servicePage(main, {pkg}) {
  setTitle(pkg || 'Service');
  const ok = live();
  const meta = h('div', {class: 'run-meta'}, skeleton('50%', 12));
  const now = h('div', null, h('div', {class: 'stack'}, skeleton('60%'), skeleton('30%')));
  const bkBox = h('div', null, skeletonRows(2));
  const hiBox = h('div', null, skeletonRows(3));
  put(main, h('div', {class: 'wrap'},
    h('a', {class: 'back-link', href: '#/dashboard'}, icon('chevron-left'), 'Deployments'),
    h('div', {class: 'run-head'}, h('h1', {tabindex: '-1'}, pkg), h('span', {class: 'spacer'}),
      btn('primary', [icon('up'), 'Deploy new version'], () => startWizard(pkg))),
    meta,
    h('section', {class: 'card', style: {marginTop: 'var(--s5)'}, 'aria-labelledby': 'now-h'},
      h('div', {class: 'card-head'}, h('h2', {id: 'now-h'}, 'Running now')), now),
    h('section', {class: 'section', id: 'backups', 'aria-labelledby': 'bk-h'}, h('h2', {id: 'bk-h'}, 'Backups'), bkBox),
    h('section', {class: 'section', id: 'history', 'aria-labelledby': 'hi-h'}, h('h2', {id: 'hi-h'}, 'History'), hiBox)));
  focusH1();

  API.service(pkg).then(svc => {
    if (!ok()) return;
    put(meta, h('span', {class: 'mono'}, svc.swarm_service + ' @ ' + svc.target), '·', h('span', {class: 'mono'}, svc.image_repo));
    put(now, runningNow(svc));
    backups(bkBox, pkg, svc, ok);
  }).catch(e => {
    if (!ok()) return;
    const {status, detail} = errDetail(e);
    if (status === 404) {
      setTitle('Service not found');
      put(main, h('div', {class: 'wrap'}, emptyState(pkg + ' has not been deployed yet.', h('a', {class: 'btn primary', href: '#/new/package'}, 'New deploy'))));
      focusH1();
      return;
    }
    meta.replaceChildren();
    bkBox.replaceChildren();
    put(now, alertBox('error', h('span', null, detail)));
  });

  API.deploys(pkg).then(jobs => {
    if (!ok()) return;
    put(hiBox, h('div', {class: 'list'}, jobs.length ? jobs.map(jobRow) : h('p', {class: 'list-empty'}, 'No deploys for this service yet.')));
    scrollPending();
  }).catch(e => { if (ok()) put(hiBox, alertBox('error', h('span', null, "Couldn't load history. " + errDetail(e).detail))); });
}

function runningNow(svc) {
  if (svc.error) return alertBox('error', h('span', null, 'Target unreachable: ' + svc.error));
  if (!svc.exists) return alertBox('warning', svc.swarm_service + ' is not on the target any more.', 'alert');
  const rb = /^rollback_/.test(svc.update_state || ''), ld = svc.last_deploy;
  return h('dl', {class: 'kv'},
    h('dt', null, 'Image'), h('dd', null, h('span', {class: 'mono'}, svc.current_image)),
    h('dt', null, 'Replicas'), h('dd', null, svc.replicas_running + '/' + svc.replicas_desired + ' running'),
    h('dt', null, 'Update state'),
    h('dd', null, svc.update_state || '—', rb ? h('span', {class: 'muted'}, svc.update_state === 'rollback_completed' && svc.replicas_running === svc.replicas_desired
      ? ' · swarm rolled back the last update; running the previous image, healthy' : ' · swarm is rolling back the last update') : null),
    ld ? [h('dt', null, 'Last deploy'), h('dd', null, h('a', {href: '#/deploys/' + ld.id},
      statusText(ld.status) + ' · ' + (ld.version || '') + (ld.finished_at ? ' · ' + fmtRel(ld.finished_at) : '')))] : null);
}

/** Backups on the target, newest first; "Roll back" asks, then starts a rollback job and opens it. */
function backups(box, pkg, svc, ok) {
  put(box, skeletonRows(2));
  API.backups(pkg).then(list => {
    if (!ok()) return;
    if (!list.length) put(box, h('div', {class: 'list'}, h('p', {class: 'list-empty'}, 'No backups yet. Every deploy backs up the running version first.')));
    else put(box, h('div', {class: 'list'}, list.map(b => backupRow(b, pkg, svc))));
    scrollPending();
  }).catch(e => { if (ok()) put(box, retryAlert("Couldn't read backups. " + errDetail(e).detail, () => backups(box, pkg, svc, ok))); });
}

function backupRow(b, pkg, svc) {
  const usable = b.tag_present || b.has_image_tar || !!b.in_registry;
  const rollback = async () => {
    const yes = await confirm({title: 'Roll back ' + svc.swarm_service + '?', confirm: 'Roll back',
      body: ['The service will run ', h('code', null, b.previous_image),
        ' (backup from ' + localT(b.created_at) + '). A new backup of the current version is made first.']});
    if (!yes) return;
    try { const j = await API.rollback(pkg, b.id); go('#/deploys/' + j.id); } catch (e) { toast(errDetail(e).detail, 'error'); }
  };
  return h('div', {class: 'lrow'},
    h('div', {class: 'main'},
      h('span', null, h('span', {style: {fontWeight: 500}}, fmtRel(b.created_at)), h('span', {class: 'muted'}, ' · ' + localT(b.created_at))),
      h('span', null, h('span', {class: 'faint micro'}, 'Restores '), h('span', {class: 'mono', 'data-k': 'image'}, b.previous_image || '—'),
        b.in_registry ? h('span', {class: 'badge micro', style: {marginLeft: '8px'}}, 'in registry') : null),
      b.tag_present
        ? h('span', null, h('span', {class: 'faint micro'}, 'Backup tag '), h('span', {class: 'mono muted'}, b.backup_tag))
        : h('span', {class: 'faint micro'}, b.has_image_tar ? 'tag removed · restores from image.tar' : 'image gone')),
    h('div', {class: 'acts'},
      btn('secondary', [icon('undo'), 'Roll back'], rollback, {disabled: !usable, title: usable ? null : 'The backup image is gone'})));
}
