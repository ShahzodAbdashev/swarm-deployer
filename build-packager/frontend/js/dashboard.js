// Builds overview: stat tiles + recent builds. Polls every 3s while something runs.
import {alertBox, btn, emptyState, fmtDur, fmtRel, h, icon, isDialogOpen, isMenuOpen, localTime, menuButton, setIcon, skel, statusText,
  toast} from './ui.js';
import {errDetail, jobsApi, prefetchRepos, resetDraft, router, setTitle, focusH1} from './state.js';
import {deleteJob, jobActive, jobDur, jobLine2, repoLabel} from './lib.js';
import {rebuild} from './wizard.js';

const newBuild = () => { resetDraft(); router.go('#/new/repo'); };
const newBuildBtn = lg => btn('primary' + (lg ? ' lg' : ''), [icon('plus'), 'New build'], newBuild);

/** One build row: link (status, service, source, duration, age, second line) + actions menu. Updated in place. */
function jobRow(job, onDeleted) {
  const a = h('a', {});
  const row = h('div', {class: 'jrow'}, a, menuButton('Actions for ' + job.service, () => {
    const active = jobActive(job);
    return [
      {label: 'View', run: () => router.go('#/jobs/' + job.id)},
      {label: 'Rebuild', run: () => rebuild(job)},
      job.artifacts.zip ? {label: 'Download .zip', href: jobsApi.zipUrl(job.id), download: true} : null,
      '-',
      {label: 'Delete…', danger: true, disabled: active, title: active ? "Running builds can't be deleted" : undefined,
        run: async () => { if (await deleteJob(job)) onDeleted(job); }},
    ];
  }, 'icon more', [], {'data-id': job.id}));
  const ico = h('span', {style: {display: 'contents'}}), svc = h('span', {class: 'svc'}), src = h('span', {class: 'src'}), dur = h('span', {class: 'dur'});
  const time = h('time'), line2 = h('span');
  a.append(ico, svc, src, dur, time, line2);
  row.update = j => {
    job = j;
    const l2 = jobLine2(j);
    a.href = '#/jobs/' + j.id;
    a.dataset.id = j.id;
    a.setAttribute('aria-label', j.service + ', ' + statusText(j.status) + ', ' + l2);
    setIcon(ico, j.status);
    svc.textContent = j.service;
    src.textContent = repoLabel(j.repo_url) + ' · ' + j.branch;
    dur.textContent = fmtDur(jobDur(j));
    time.dateTime = j.created_at || '';
    time.title = localTime(j.created_at);
    time.textContent = fmtRel(j.created_at);
    line2.className = 'line2' + (j.status === 'failed' ? ' danger' : '');
    line2.title = l2;
    line2.textContent = l2;
  };
  row.update(job);
  return row;
}

export function dashboardPage(main) {
  setTitle('Builds');
  prefetchRepos();
  let jobs = null, dead = false, pollT = 0, tickT = 0, kind = '';
  const prev = {}, rows = new Map();
  const wrap = h('div', {class: 'wrap'});
  main.append(wrap);
  const head = withButton => h('div', {class: 'page-head'}, h('h1', {tabindex: '-1'}, 'Builds'), withButton ? newBuildBtn() : null);

  // list view parts, built once and updated in place so focus and open menus survive polling
  const num = () => h('span', {class: 'num'});
  const nTotal = num(), nOk = num(), nBad = num();
  const lastIco = h('span', {style: {display: 'contents'}}), lastSr = h('span', {class: 'sr'}), lastSvc = document.createTextNode(''), lastAge = h('span', {class: 'muted', style: {fontWeight: 400}});
  const lastTile = h('a', {class: 'tile lastt'}, h('span', {class: 'micro'}, 'Last build'), h('span', {class: 'last'}, lastIco, lastSr, lastSvc, lastAge));
  const list = h('div', {class: 'list'});
  const tile = (label, n) => h('div', {class: 'tile'}, h('span', {class: 'micro'}, label), n);
  const listView = [head(true), h('div', {class: 'tiles'}, tile('Total builds', nTotal), tile('Succeeded', nOk), tile('Failed', nBad), lastTile),
    h('section', {'aria-labelledby': 'recent-h'}, h('h2', {id: 'recent-h', style: {marginBottom: 'var(--s3)'}}, 'Recent builds'), list)];

  const show = (k, nodes) => {
    if (kind === k) return;
    const hadFocus = wrap.contains(document.activeElement);
    kind = k;
    wrap.replaceChildren(...nodes);
    if (hadFocus || k === 'loading') focusH1();
  };
  const onDeleted = j => { jobs = jobs.filter(x => x.id !== j.id); paint(); };

  function paint() {
    if (!jobs.length) {
      show('empty', [head(false), emptyState({title: 'No builds yet', text: 'Pick a repository, set a zip password, and get an encrypted package.', kids: newBuildBtn(true)})]);
      return;
    }
    show('list', listView);
    const ok = jobs.filter(j => j.status === 'success').length, bad = jobs.filter(j => j.status === 'failed').length, last = jobs[0];
    nTotal.textContent = jobs.length;
    nOk.textContent = ok; nOk.className = 'num' + (ok ? ' success' : '');
    nBad.textContent = bad; nBad.className = 'num' + (bad ? ' danger' : '');
    lastTile.href = '#/jobs/' + last.id;
    setIcon(lastIco, last.status);
    lastSr.textContent = statusText(last.status) + ': ';
    lastSvc.data = last.service;
    lastAge.textContent = '· ' + fmtRel(last.created_at);
    const ids = new Set(jobs.map(j => j.id));
    for (const [id, r] of rows) if (!ids.has(id)) { r.remove(); rows.delete(id); }
    jobs.forEach((j, i) => {
      let r = rows.get(j.id);
      if (r) r.update(j); else rows.set(j.id, r = jobRow(j, onDeleted));
      if (list.children[i] !== r) list.insertBefore(r, list.children[i] || null);
    });
    clearInterval(tickT);
    if (jobs.some(jobActive)) tickT = setInterval(paint, 1000); // live durations
  }

  async function load() {
    let fresh;
    try { fresh = await jobsApi.list(); }
    catch (e) {
      if (dead) return;
      if (jobs) { pollT = setTimeout(load, 3000); return; }
      show('error', [head(false), alertBox('error', [h('span', {}, "Couldn't load builds. " + errDetail(e).detail),
        h('div', {}, btn('ghost', 'Retry', () => { showLoading(); load(); }))])]);
      return;
    }
    if (dead) return;
    for (const j of fresh) {
      const was = prev[j.id];
      if (was && jobActive({status: was}) && !jobActive(j)) toast(j.service + (j.status === 'success' ? ' succeeded' : ' failed'), j.status === 'success' ? 'success' : 'error');
      prev[j.id] = j.status;
    }
    jobs = fresh;
    paint();
    if (jobs.some(jobActive)) pollT = setTimeout(load, 3000);
  }

  const showLoading = () => {
    kind = '';
    show('loading', [head(false),
      h('div', {class: 'tiles'}, [0, 1, 2, 3].map(i => h('div', {class: 'tile' + (i === 3 ? ' lastt' : '')}, skel('60%', 12), skel('40%', 24)))),
      h('div', {class: 'list'}, [0, 1, 2].map(() => h('div', {class: 'skel-row'}, skel('45%', 12), skel('70%', 10))))]);
  };
  showLoading();
  load();

  const onKey = e => {
    const tag = document.activeElement?.tagName || '';
    if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey && !/INPUT|TEXTAREA|SELECT/.test(tag) && !isDialogOpen() && !isMenuOpen()) {
      e.preventDefault();
      newBuild();
    }
  };
  document.addEventListener('keydown', onKey);
  return () => { dead = true; clearTimeout(pollT); clearInterval(tickT); document.removeEventListener('keydown', onKey); };
}
