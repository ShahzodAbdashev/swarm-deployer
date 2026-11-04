// One deploy or rollback: status, phase pipeline, result card and the live log (SSE).
import {announce, confirm, copyText, emptyState, errDetail, fmtDur, fmtDurLong, go, h, hhmm, icon, keepFocus, live, menuButton, onLeave,
  parseT, put, refresh, resultCard, retryAlert, skeleton, spoken, statusBadge, statusIcon, toast} from './ui.js';
import {API, basename, classifyDeployLine, dirname, failedPhase, focusH1, jobActive, jobDur, localT, phaseOf, phint, plabel, resetDraft,
  session, setTitle, updateDraft} from './app.js';

const ID_RE = /^[0-9a-f]{32}$/;
const phaseDur = p => (p.started_at ? fmtDur((p.finished_at ? parseT(p.finished_at) : Date.now()) - parseT(p.started_at)) : '');

function notFound(main) {
  setTitle('Deploy not found');
  put(main, h('div', {class: 'wrap'}, emptyState('Deploy not found. It may have been deleted.', h('a', {class: 'btn primary', href: '#/dashboard'}, 'Back to dashboard'))));
  focusH1();
}

export function runPage(main, {id}) {
  if (!ID_RE.test(id)) { notFound(main); return; }
  setTitle('Deploy');
  const ok = live();
  const back = h('a', {class: 'back-link', href: '#/dashboard'}, icon('chevron-left'), 'Deployments');
  const h1 = h('h1', {tabindex: '-1'}, '…');
  const badge = h('span');
  const menuSlot = h('span', {style: {display: 'contents'}});
  const meta = h('div', {class: 'run-meta'}, skeleton('60%', 12));
  const images = h('div');
  const result = h('div');
  const pipeline = h('ol', {class: 'pipeline', 'aria-label': 'Pipeline'});
  const log = logConsole(API.logUrl(id));
  put(main, h('div', {class: 'wrap'}, back, h('div', {class: 'run-head'}, h1, badge, h('span', {class: 'spacer'}), menuSlot),
    meta, images, result, pipeline, log.el));
  focusH1();

  let job = null, svcNow = null, openedActive = false, es = null, ended = false, tick = 0;
  log.onLines = () => { if (jobActive(job)) renderPipeline(); }; // running phase shows the latest log line
  const prevPhases = {};
  onLeave(() => { es?.close(); clearInterval(tick); });

  API.deploy(id).then(j => {
    if (!ok()) return;
    openedActive = jobActive(j);
    if (j.status === 'success') log.setShown(false);
    j.phases.forEach(p => { prevPhases[p.name] = p.status; });
    put(menuSlot, menuButton('Deploy actions', () => [
      {label: 'Copy job id', icon: 'copy', run: async () => { if (await copyText(job.id)) toast('Job id copied'); }},
      {label: 'Service details', run: () => go('#/services/' + encodeURIComponent(job.package))},
      '-',
      {label: 'Delete deploy record…', danger: true, disabled: jobActive(job), title: jobActive(job) ? "Running deploys can't be deleted" : null, run: deleteRecord},
    ]));
    setJob(j);
    connect();
  }).catch(e => {
    if (!ok()) return;
    const {status, detail} = errDetail(e);
    if (status === 404) { notFound(main); return; }
    put(main, h('div', {class: 'wrap'}, back, h('h1', {tabindex: '-1'}, 'Deploy'),
      h('div', {style: {marginTop: 'var(--s4)'}}, retryAlert("Couldn't load this deploy. " + detail, refresh))));
  });

  function connect() {
    es = new EventSource(API.logStreamUrl(id));
    es.addEventListener('open', () => { log.clear(); log.setLive('on', 'live'); });
    es.addEventListener('log', e => log.append(e.data));
    es.addEventListener('status', e => {
      let nj;
      try { nj = JSON.parse(e.data); } catch { return; }
      announcePhases(nj);
      if (job && job.status !== nj.status && nj.status === 'success') announce(nj.kind === 'rollback' ? 'Rollback succeeded' : 'Deploy succeeded');
      setJob(nj);
    });
    es.addEventListener('end', () => {
      ended = true;
      es.close();
      log.setLive('', 'ended');
      clearInterval(tick);
      API.deploy(id).then(j2 => {
        if (!ok()) return;
        setJob(j2);
        if (openedActive) result.querySelector('.display')?.focus();
      }).catch(() => {});
    });
    es.onerror = () => { if (!ended && es.readyState === EventSource.CONNECTING) log.setLive('warn', 'Reconnecting…'); };
  }

  function announcePhases(nj) {
    nj.phases.forEach(p => {
      const was = prevPhases[p.name];
      if (was && was !== p.status) {
        if (p.status === 'running') announce(plabel(p.name, nj) + ' started');
        else if (p.status === 'success') announce(plabel(p.name, nj) + ' succeeded in ' + spoken(parseT(p.finished_at) - parseT(p.started_at)));
        else if (p.status === 'failed') announce(plabel(p.name, nj) + ' failed');
      }
      prevPhases[p.name] = p.status;
    });
  }

  function setJob(j) {
    const wasOk = job?.status === 'success';
    job = j;
    document.title = (j.status === 'success' ? '✓ ' : j.status === 'failed' ? '✗ ' : '● ') + j.package + ' — Swarm Deployer';
    h1.textContent = j.kind === 'rollback' ? 'Rollback · ' + j.package : j.package;
    put(badge, statusBadge(j.status));
    clearInterval(tick);
    if (jobActive(j) && !ended) tick = setInterval(renderClock, 1000);
    // after a success: how many replicas the service runs now
    if (j.status === 'success' && !wasOk) {
      API.service(j.package).then(s => { if (ok() && s && s.exists) { svcNow = s.replicas_running + '/' + s.replicas_desired + ' running'; renderResult(); } }).catch(() => {});
    }
    const active = jobActive(j);
    put(images, !active || j.phases.some(p => p.name === 'connect' && p.status !== 'pending')
      ? h('dl', {id: 'run-images'}, h('dt', null, 'Before'), h('dd', null, j.previous_ref || j.previous_image || '—'),
        h('dt', null, 'After'), h('dd', null, j.deploy_image || j.new_image || '—')) : null);
    renderResult();
    renderClock();
  }

  function renderClock() {
    put(meta, h('span', {class: 'mono'}, job.version || ''), '·',
      h('span', {class: 'mono'}, (job.swarm_service || '') + ' @ ' + (job.target_label || job.target || '')), '·',
      h('span', {title: localT(job.created_at)}, 'started ' + hhmm(job.created_at)), '·',
      h('span', {id: 'run-el'}, fmtDur(jobDur(job))));
    renderPipeline();
  }

  /** Last plain (non-"==>") line since the running phase started: shown under it in the pipeline. */
  function runningSub() {
    const c = phaseOf(job, 'running');
    if (!c) return '';
    const lines = log.lines, s = log.startIndex(c.p.name);
    for (let i = lines.length - 1; i > s && s >= 0; i--) {
      const t = lines[i].text;
      if (!t.startsWith('==>') && t.trim()) return t;
    }
    return '';
  }

  function renderPipeline() {
    const active = jobActive(job), sub = runningSub();
    keepFocus(pipeline, () => put(pipeline, job.phases.map(p => {
      const notRun = !active && p.status === 'pending', running = p.status === 'running', st = notRun ? 'notrun' : p.status;
      const text = running ? sub : p.message || '';
      return h('li', null, h('button', {class: notRun ? 'pstep ps-skipped ps-notrun' : 'pstep ps-' + st, type: 'button', 'data-id': p.name,
        onclick: () => jumpTo(p.name, false)},
      h('span', null, statusIcon(notRun ? 'skipped' : st, 'lg')),
      h('span', null, h('span', {class: 'plab'}, plabel(p.name, job)), h('span', {class: 'sr'}, ', ' + ({notrun: 'not run', success: 'succeeded'}[st] || st))),
      h('span', {class: 'pdur'}, p.status === 'pending' || p.status === 'skipped' ? '' : phaseDur(p)),
      h('span', {class: 'psub' + (running || p.status === 'success' ? ' mono' : ''), hidden: !text, title: running ? null : p.message || null}, text)));
    })));
  }

  function jumpTo(name, failed) {
    const s = log.startIndex(name);
    let line = s >= 0 ? log.lines[s] : undefined;
    if (!line && failed) line = [...log.lines].reverse().find(l => l.cls.startsWith('er'));
    log.setShown(true);
    if (line) log.jumpTo(line.id);
  }

  async function deleteRecord() {
    if (!(await confirm({title: 'Delete this deploy record?', confirm: 'Delete', body: 'Deletes the log and job record from this computer. Nothing on the target or its backups is touched.'}))) return;
    try { await API.removeDeploy(job.id); toast('Deploy record deleted', 'success'); go('#/dashboard'); } catch (e) {
      const {status, detail} = errDetail(e);
      toast(status === 409 ? 'This deploy is still running.' : detail, 'error');
    }
  }

  /** Finished deploy/rollback: green card (what runs now, backup tag) or red card (error, rollback outcome, hint, recovery). */
  function renderResult() {
    if (jobActive(job)) { result.replaceChildren(); return; }
    const isRb = job.kind === 'rollback', svcHref = '#/services/' + encodeURIComponent(job.package);
    const svcLink = h('a', {class: 'link', href: svcHref}, 'Service details');
    if (job.status === 'success') {
      const b = job.backup;
      put(result, resultCard(true,
        isRb ? 'Rolled back ' + job.swarm_service + ' to ' + job.new_image
          : '70-75 uuuuu surqash! Deployed ' + (job.deploy_image || job.new_image) + ' in ' + fmtDurLong(jobDur(job) || 0),
        [h('div', {class: 'muted', id: 'res-svc'}, 'Service ' + job.swarm_service + (svcNow ? ' · ' + svcNow : '')),
          job.new_digest ? h('div', {class: 'muted', id: 'res-digest'}, 'Pushed ' + job.new_digest.slice(0, 19) + '… to ' + (job.registry || 'the registry')) : null,
          b && b.tag ? h('div', {class: 'muted'}, 'Backup ', h('span', {class: 'mono'}, b.tag), b.image_tar ? ' (+ .tar)' : '') : null],
        [h('a', {class: 'btn primary', href: '#/dashboard'}, 'Back to dashboard'), svcLink]));
      return;
    }
    const f = failedPhase(job), rb = job.rollback, what = isRb ? 'Rollback' : 'Deploy';
    const interrupted = !!job.error?.startsWith('interrupted (server restart)'); // recover() appends '; rolled back to …'
    const hint = interrupted ? 'The server restarted while this ran. Check the service, then start again.' : f ? phint(f.name, job) : '';
    const badPkg = !!f && (f.name === 'deploy' || f.name === 'verify');
    const pickOther = () => {
      resetDraft();
      updateDraft({path: dirname(job.package_path)});
      session.filter = job.package;
      go('#/new/package');
    };
    const tryAgain = () => {
      resetDraft();
      updateDraft({package_path: job.package_path || '', package: job.package, path: dirname(job.package_path)});
      session.note = 'Enter the zip password to deploy ' + basename(job.package_path) + ' again.';
      go('#/new/password');
    };
    const b = (cls, label, fn) => h('button', {class: cls, type: 'button', onclick: fn}, label);
    put(result, resultCard(false,
      interrupted ? what + ' interrupted' : f ? what + ' failed at ' + plabel(f.name, job) : what + ' failed',
      [job.error ? h('div', {class: 'err-text'}, job.error) : null,
        rb && rb.performed ? (rb.ok
          ? h('div', {class: 'success', style: {fontWeight: 500}}, rb.to_image ? 'Rolled back to ' + rb.to_image + ' ✓' : 'Rolled back: the new service was removed ✓')
          : h('div', {class: 'danger', style: {fontWeight: 500}}, 'Rollback failed — check the service on the target')) : null,
        hint ? h('div', {class: 'muted'}, 'Try: ' + hint) : null],
      [!isRb && badPkg ? b('btn primary', 'Choose another package', pickOther) : null,
        isRb ? h('a', {class: 'btn primary', href: svcHref}, 'Back to service') : b(badPkg ? 'btn secondary' : 'btn primary', 'Try again', tryAgain),
        b('link', 'Show in log', () => jumpTo(f ? f.name : '', true)),
        isRb ? null : svcLink,
        h('a', {class: 'link muted', href: '#/dashboard'}, 'Back to dashboard')]));
  }
}

// ------------------------------------------------------------------ log console

/**
 * Monospace log viewer: follows the tail, "Jump to latest" chip when scrolled up, copy / download / wrap / hide toolbar.
 * Lines: "[HH:MM:SS] text", batched per animation frame, capped at 5000 (oldest dropped).
 */
function logConsole(downloadHref, cap = 5000) {
  let lines = [], nextId = 1, queue = [], raf = 0, follow = true, newCount = 0, programmatic = false, shown = true, capped = false;
  const liveEl = h('span', {class: 'live'}, h('i'), h('span', null, 'connecting'));
  const box = h('div', {class: 'log', role: 'log', 'aria-live': 'off', 'aria-label': 'Deploy log', tabindex: '0'});
  const jump = h('button', {class: 'jump', type: 'button', hidden: true, onclick: () => resume()});
  const wrapBtn = h('button', {class: 'btn ghost', type: 'button', 'aria-label': 'Wrap', 'aria-pressed': 'false'}, icon('wrap'), h('span', {class: 'hide-sm'}, 'Wrap'));
  const showBtn = h('button', {class: 'btn ghost', type: 'button', 'aria-controls': 'log-box'});
  const consoleEl = h('div', {class: 'console', id: 'log-box'}, box, jump);
  const capNote = h('div', {class: 'dim'}, 'Earlier lines hidden. Download the full log.');

  const toBottom = () => {
    programmatic = true;
    box.scrollTop = box.scrollHeight;
    requestAnimationFrame(() => { programmatic = false; });
  };
  const setFollow = v => {
    follow = v;
    if (v) newCount = 0;
    jump.hidden = v;
    jump.textContent = '↓ Jump to latest' + (newCount ? ' (' + newCount + ' new)' : '');
  };
  const resume = () => { setFollow(true); toBottom(); };
  const setWrap = v => { box.classList.toggle('wrap', v); wrapBtn.setAttribute('aria-pressed', String(v)); };
  const lineEl = l => h('div', {class: l.cls || null, 'data-line': l.id}, l.ts ? h('span', {class: 'ts'}, '[' + l.ts + ']') : null, h('span', null, l.text));
  const parse = raw => {
    const m = /^\[(\d\d:\d\d:\d\d)\] ?(.*)$/.exec(raw), text = m ? m[2] : raw, sm = /^==> \[(\w+)\] started/.exec(text);
    return {id: nextId++, ts: m ? m[1] : '', text, cls: classifyDeployLine(text), start: sm ? sm[1] : undefined};
  };
  const flush = () => {
    raf = 0;
    const batch = queue.splice(0).map(parse);
    if (!batch.length) return;
    lines = lines.concat(batch);
    box.append(...batch.map(lineEl));
    if (lines.length > cap) {
      const drop = lines.length - cap;
      lines = lines.slice(drop);
      for (let i = 0; i < drop; i++) box.querySelector('[data-line]')?.remove();
      if (!capped) { capped = true; box.prepend(capNote); }
    }
    if (follow) toBottom(); else { newCount += batch.length; setFollow(false); }
    api.onLines?.();
  };
  const setShown = v => {
    shown = v;
    consoleEl.hidden = !v;
    showBtn.setAttribute('aria-expanded', String(v));
    put(showBtn, icon('chevron-down', v ? 'rot' : null), v ? 'Hide' : 'Show');
    if (v && follow) toBottom();
  };

  box.addEventListener('scroll', () => {
    if (programmatic) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    if (atBottom && !follow) setFollow(true);
    else if (!atBottom && follow) setFollow(false);
  });
  box.addEventListener('keydown', e => { if (e.key === 'End') resume(); });
  wrapBtn.addEventListener('click', () => setWrap(!box.classList.contains('wrap')));
  showBtn.addEventListener('click', () => setShown(!shown));
  setWrap(matchMedia('(max-width:480px)').matches);
  setShown(true);
  box.append(lineEl({id: 0, ts: '', text: 'Connecting…', cls: 'dim'}));

  const copy = async () => {
    const txt = lines.filter(l => l.cls !== 'dim').map(l => (l.ts ? '[' + l.ts + ']' : '') + l.text).join('\n');
    if (await copyText(txt)) toast('Log copied');
  };

  const api = {
    el: h('section', {class: 'logs', 'aria-labelledby': 'logs-h'},
      h('div', {class: 'logbar'}, h('h2', {id: 'logs-h'}, 'Logs'), liveEl, h('span', {class: 'spacer'}),
        h('button', {class: 'btn ghost', type: 'button', 'aria-label': 'Copy log', onclick: copy}, icon('copy'), h('span', {class: 'hide-sm'}, 'Copy log')),
        h('a', {class: 'btn ghost', href: downloadHref, target: '_blank', rel: 'noopener', 'aria-label': 'Download log'}, icon('download'), h('span', {class: 'hide-sm'}, 'Download log')),
        wrapBtn, showBtn),
      consoleEl),
    get lines() { return lines; },
    append: raw => { queue.push(raw); if (!raf) raf = requestAnimationFrame(flush); },
    clear: () => {
      queue = [];
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      lines = [];
      capped = false;
      box.replaceChildren();
      setFollow(true);
    },
    setLive: (cls, text) => { liveEl.className = 'live ' + cls; liveEl.lastChild.textContent = text; },
    setShown,
    startIndex: name => { for (let i = lines.length - 1; i >= 0; i--) if (lines[i].start === name) return i; return -1; },
    /** Show the console, scroll to the line and flash it. */
    jumpTo: lineId => requestAnimationFrame(() => {
      const el = box.querySelector('[data-line="' + lineId + '"]');
      if (!el) return;
      setFollow(false);
      programmatic = true;
      el.scrollIntoView({block: 'center'});
      box.scrollTop = Math.max(0, el.offsetTop - box.clientHeight / 3);
      requestAnimationFrame(() => { programmatic = false; });
      el.classList.add('hl');
      setTimeout(() => el.classList.remove('hl'), 1500);
    }),
  };
  return api;
}
