// One build: status, pipeline steps, result card and the live log (Server-Sent Events: log, status, end).
import {alertBox, announce, btn, copyText, emptyState, fmtDur, fmtSize, h, hhmm, icon, localTime, menuButton, parseT, skel, spoken, statusBadge,
  setIcon, toast} from './ui.js';
import {errDetail, focusH1, jobsApi, router, setTitle} from './state.js';
import {STEP_LABEL, curStep, deleteJob, failedStep, hintFor, jobActive, jobDur, repoLabel} from './lib.js';
import {rebuild} from './wizard.js';

const ID_RE = /^[0-9a-f]{32}$/;
const stepDur = s => (s.started_at ? fmtDur((s.finished_at ? parseT(s.finished_at) : Date.now()) - parseT(s.started_at)) : '');
const SR = {notrun: 'not run', success: 'succeeded'};

// ---------------------------------------------------------------- log lines
// [HH:MM:SS] ==> [step] started | success: ... | failed: ...   [HH:MM:SS] $ command   [HH:MM:SS] ==> JOB SUCCESS | JOB FAILED

function logClass(text) {
  if (text.startsWith('==> JOB SUCCESS')) return 'ok hd';
  if (/failed|error|JOB FAILED/i.test(text)) return 'er' + (text.startsWith('==>') ? ' hd' : '');
  if (text.startsWith('==>')) return 'hd' + (/ started$/.test(text) ? ' start' : '');
  if (text.startsWith('$ ')) return 'cmd';
  return '';
}
function parseLine(raw, id) {
  const m = /^\[(\d\d:\d\d:\d\d)\] ?(.*)$/.exec(raw);
  const text = m ? m[2] : raw, sm = /^==> \[(\w+)\] started/.exec(text);
  return {id, ts: m ? m[1] : '', text, cls: logClass(text), start: sm ? sm[1] : undefined};
}
/** Index of the "==> [name] started" line, or -1. */
const startIndex = (lines, name) => { for (let i = lines.length - 1; i >= 0; i--) if (lines[i].start === name) return i; return -1; };

/** Last plain (non-"==>") line of the running step: shown under it in the pipeline. */
function runningSub(lines, job) {
  const c = curStep(job);
  if (!c) return '';
  for (let i = lines.length - 1, s = startIndex(lines, c.s.name); i > s && s >= 0; i--) {
    const t = lines[i].text;
    if (!t.startsWith('==>') && t.trim() && lines[i].cls !== 'dim') return t;
  }
  return '';
}

/** For a bare "exited with code N" error: the last fatal:/error: line of the failed step's log. */
function failureCause(lines, job) {
  if (!/exited with code/.test(job.error || '')) return '';
  const f = failedStep(job);
  const s = f ? startIndex(lines, f.name) : -1;
  if (s < 0) return '';
  let line = '';
  for (let i = s + 1; i < lines.length; i++) {
    const t = lines[i].text;
    if (t.startsWith('==>')) { if (/ started$/.test(t)) break; continue; }
    if (/\b(fatal|error):/i.test(t)) line = t;
  }
  return line;
}

/** Monospace log viewer: follows the tail, "Jump to latest" chip when scrolled up, copy/download/wrap/hide toolbar. */
function logConsole(downloadHref, onFlush) {
  const CAP = 5000;
  let lines = [{id: 0, ts: '', text: 'Connecting…', cls: 'dim'}], nextId = 1, capped = false, queue = [], raf = 0;
  let follow = true, newCount = 0, programmatic = false, wrapOn = matchMedia('(max-width:480px)').matches;
  const lineEl = l => h('div', {class: l.cls, 'data-line': l.id}, l.ts ? h('span', {class: 'ts'}, '[' + l.ts + ']') : null, h('span', {}, l.text));
  const cappedEl = h('div', {class: 'dim'}, 'Earlier lines hidden. Download the full log.');
  const liveText = h('span', {}, 'connecting'), live = h('span', {class: 'live'}, h('i'), liveText);
  const box = h('div', {class: 'log' + (wrapOn ? ' wrap' : ''), role: 'log', 'aria-live': 'off', 'aria-label': 'Build log', tabindex: '0'}, lines.map(lineEl));
  const jump = h('button', {class: 'jump', type: 'button', hidden: true});
  const con = h('div', {class: 'console', id: 'log-box'}, box, jump);
  const chev = icon('chevron-down'), toggleText = h('span', {}, 'Hide');
  const toggle = btn('ghost', [chev, toggleText], () => setShown(con.hidden), {'aria-expanded': 'true', 'aria-controls': 'log-box'});
  const wrapBtn = btn('ghost', [icon('wrap'), h('span', {class: 'hide-sm'}, 'Wrap')], () => {
    wrapOn = !wrapOn;
    box.classList.toggle('wrap', wrapOn);
    wrapBtn.setAttribute('aria-pressed', String(wrapOn));
  }, {'aria-label': 'Wrap', 'aria-pressed': String(wrapOn)});
  const el = h('section', {class: 'logs', 'aria-labelledby': 'logs-h'},
    h('div', {class: 'logbar'},
      h('h2', {id: 'logs-h'}, 'Logs'), live, h('span', {class: 'spacer'}),
      btn('ghost', [icon('copy'), h('span', {class: 'hide-sm'}, 'Copy log')], async () => {
        const txt = lines.filter(l => l.cls !== 'dim').map(l => (l.ts ? '[' + l.ts + ']' : '') + l.text).join('\n');
        if (await copyText(txt)) toast('Log copied');
      }, {'aria-label': 'Copy log'}),
      h('a', {class: 'btn ghost', href: downloadHref, target: '_blank', rel: 'noopener', 'aria-label': 'Download log'}, icon('download'), h('span', {class: 'hide-sm'}, 'Download log')),
      wrapBtn, toggle),
    con);

  const paintJump = () => { jump.hidden = follow; jump.textContent = '↓ Jump to latest' + (newCount ? ' (' + newCount + ' new)' : ''); };
  const toBottom = () => { programmatic = true; box.scrollTop = box.scrollHeight; requestAnimationFrame(() => { programmatic = false; }); };
  const resume = () => { follow = true; newCount = 0; paintJump(); toBottom(); };
  jump.onclick = resume;
  box.addEventListener('keydown', e => { if (e.key === 'End') resume(); });
  box.addEventListener('scroll', () => {
    if (programmatic) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    if (atBottom && !follow) { follow = true; newCount = 0; paintJump(); }
    else if (!atBottom && follow) { follow = false; paintJump(); }
  });
  function setShown(v) {
    con.hidden = !v;
    toggleText.textContent = v ? 'Hide' : 'Show';
    chev.style.transform = v ? 'rotate(180deg)' : '';
    toggle.setAttribute('aria-expanded', String(v));
    if (v && follow) toBottom();
  }
  setShown(true);

  function flush() {
    raf = 0;
    const batch = queue.splice(0).map(raw => parseLine(raw, nextId++));
    if (!batch.length) return;
    lines = lines.concat(batch);
    box.append(...batch.map(lineEl));
    if (lines.length > CAP) {
      const drop = lines.length - CAP;
      lines = lines.slice(drop);
      for (let i = 0; i < drop; i++) box.querySelector('[data-line]')?.remove();
      if (!capped) { capped = true; box.prepend(cappedEl); }
    }
    if (follow) toBottom(); else { newCount += batch.length; paintJump(); }
    onFlush();
  }

  return {
    el,
    lines: () => lines,
    append(raw) { queue.push(raw); if (!raf) raf = requestAnimationFrame(flush); },
    clear() {
      queue = [];
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      lines = [];
      capped = false;
      newCount = 0;
      box.replaceChildren();
      paintJump();
    },
    setLive(cls, text) { live.className = 'live ' + cls; liveText.textContent = text; },
    liveText: () => liveText.textContent,
    setShown,
    /** Show the console, scroll to the line and flash it. */
    jumpTo(lineId) {
      setShown(true);
      requestAnimationFrame(() => {
        const ln = box.querySelector('[data-line="' + lineId + '"]');
        if (!ln) return;
        follow = false;
        paintJump();
        programmatic = true;
        ln.scrollIntoView({block: 'center'});
        box.scrollTop = Math.max(0, ln.offsetTop - box.clientHeight / 3);
        requestAnimationFrame(() => { programmatic = false; });
        ln.classList.add('hl');
        setTimeout(() => ln.classList.remove('hl'), 1500);
      });
    },
    stop() { if (raf) cancelAnimationFrame(raf); },
  };
}

// ---------------------------------------------------------------- page

function notFound(wrap) {
  setTitle('Build not found');
  wrap.replaceChildren(emptyState({h1: true, title: 'Build not found. It may have been deleted.', kids: h('a', {class: 'btn primary', href: '#/dashboard'}, 'Back to dashboard')}));
  focusH1();
}

export function runPage(main, {id}) {
  const wrap = h('div', {class: 'wrap'});
  main.append(wrap);
  if (!ID_RE.test(id)) { notFound(wrap); return null; }
  setTitle('Build');
  let job = null, dead = false, es = null, openedActive = false, causeEl = null, resultHead = null, menuAdded = false, pipeKey = '';
  const prevSteps = {}, pItems = new Map();

  const back = h('a', {class: 'back-link', href: '#/dashboard'}, icon('chevron-left'), 'Builds');
  const h1 = h('h1', {tabindex: '-1'}, '…');
  const badge = h('span');
  const head = h('div', {class: 'run-head'}, h1, badge, h('span', {class: 'spacer'}));
  const metaEl = h('div', {class: 'run-meta'}, skel('60%', 12));
  const elapsed = h('span', {id: 'run-el'});
  const resultBox = h('div');
  const pipe = h('ol', {class: 'pipeline', 'aria-label': 'Pipeline'});
  const con = logConsole(jobsApi.logUrl(id), () => {
    if (!job) return;
    if (jobActive(job)) paintPipeline();
    else if (causeEl) { const c = failureCause(con.lines(), job); causeEl.textContent = c; causeEl.hidden = !c; }
  });
  wrap.append(back, head, metaEl, resultBox, pipe, con.el);
  focusH1();

  const jumpTo = (name, failed) => {
    const lines = con.lines(), s = startIndex(lines, name);
    let line = s >= 0 ? lines[s] : undefined;
    if (!line && failed) line = [...lines].reverse().find(l => l.cls.startsWith('er'));
    if (line) con.jumpTo(line.id); else con.setShown(true);
  };

  function paintPipeline() {
    const steps = job?.steps ?? Object.keys(STEP_LABEL).map(name => ({name, status: 'pending'}));
    const key = steps.map(s => s.name).join();
    if (key !== pipeKey) { pipeKey = key; pipe.replaceChildren(); pItems.clear(); }
    const active = jobActive(job), sub = job ? runningSub(con.lines(), job) : '';
    for (const s of steps) {
      let it = pItems.get(s.name);
      if (!it) {
        it = {ico: h('span'), sr: h('span', {class: 'sr'}), dur: h('span', {class: 'pdur'}), sub: h('span', {class: 'psub'})};
        it.b = h('button', {class: 'pstep', type: 'button', onclick: () => jumpTo(s.name, false)},
          it.ico, h('span', {}, h('span', {class: 'plab'}, STEP_LABEL[s.name]), it.sr), it.dur, it.sub);
        pItems.set(s.name, it);
        pipe.append(h('li', {}, it.b));
      }
      const notRun = !!job && !active && s.status === 'pending';
      let text = '', mono = false;
      if (job && s.status === 'failed' && job.status === 'failed' && job.error) text = ''; // shown on the result card
      else if (s.status === 'failed' || s.status === 'skipped') text = s.message || '';
      else if (s.status === 'running') { text = sub; mono = true; }
      const st = notRun ? 'notrun' : s.status;
      it.b.className = notRun ? 'pstep ps-skipped ps-notrun' : 'pstep ps-' + st;
      setIcon(it.ico, notRun ? 'skipped' : st, 'lg');
      it.sr.textContent = ', ' + (SR[st] || st);
      it.dur.textContent = s.status === 'pending' || s.status === 'skipped' ? '' : stepDur(s);
      it.sub.className = 'psub' + (mono ? ' mono' : '');
      it.sub.textContent = text;
      it.sub.hidden = !text;
    }
  }

  function paintResult() {
    resultHead = causeEl = null;
    if (!job || jobActive(job)) { resultBox.replaceChildren(); return; }
    const j = job, a = j.artifacts, ok = j.status === 'success';
    const zipA = a.zip ? h('a', {class: 'btn ' + (ok ? 'primary' : 'secondary'), href: jobsApi.zipUrl(j.id), download: ''}, icon('download'), 'Download .zip') : null;
    const tarA = a.tar ? h('a', {class: 'link', href: jobsApi.tarUrl(j.id), download: ''}, icon('download'), ' Download .tar ',
      h('span', {class: 'tar-note'}, '(' + fmtSize(a.tar_size) + ' · image only, not encrypted)')) : null;
    const rb = h('button', {class: ok ? 'link' : 'btn primary', type: 'button', onclick: () => rebuild(j)}, 'Rebuild');
    const home = h('a', {class: 'link muted', href: '#/dashboard'}, 'Back to dashboard');
    const extras = [j.env ? h('div', {class: 'mono', id: 'res-env'}, '.env: ' + j.env.count + ' keys (' + j.env.path + ')') : null,
      j.healthcheck ? h('div', {class: 'mono', id: 'res-hc'}, 'healthcheck.sh included') : null];
    let title, kids, actions, after = null;
    if (ok) {
      title = 'Build succeeded in ' + fmtDur(jobDur(j));
      kids = [h('div', {class: 'mono'}, j.folder_name + '.zip · ' + fmtSize(a.zip_size) + ' · AES-256'),
        j.deploy_manifest ? h('div', {class: 'mono', 'data-manifest': '1'}, 'deploy.yml: service ' + j.deploy_manifest.service + ' · image ' + j.deploy_manifest.image) : null,
        extras,
        a.remote_path ? h('div', {class: 'row-flex', style: {flexWrap: 'wrap'}}, h('span', {class: 'muted'}, 'Uploaded to'),
          h('span', {class: 'mono', style: {wordBreak: 'break-all'}}, a.remote_path),
          btn('ghost', [icon('copy'), 'Copy'], async () => { if (await copyText(a.remote_path)) toast('Path copied'); }, {style: {height: '28px'}, 'aria-label': 'Copy upload path'}))
          : h('div', {class: 'muted'}, 'Not uploaded. Download it below.')];
      actions = [zipA, rb, home];
      after = tarA;
    } else {
      const f = failedStep(j), interrupted = j.error === 'interrupted (server restart)', hint = hintFor(j, f), cause = failureCause(con.lines(), j);
      title = interrupted ? 'Build interrupted' : f ? 'Failed at the ' + STEP_LABEL[f.name] + ' step' : 'Build failed before starting';
      causeEl = h('div', {class: 'cause', hidden: !cause}, cause);
      kids = [j.error ? h('div', {class: 'err-text'}, j.error) : null, extras, causeEl, hint ? h('div', {class: 'muted'}, 'Try: ' + hint) : null];
      actions = [rb, h('button', {class: 'link', type: 'button', onclick: () => jumpTo(f ? f.name : '', true)}, 'Show in log'), home, tarA, zipA];
    }
    resultHead = h('div', {class: 'display', tabindex: '-1'}, icon(ok ? 'check' : 'x'), title);
    resultBox.replaceChildren(h('div', {class: 'result ' + (ok ? 'ok' : 'bad')}, resultHead, kids, h('div', {class: 'actions'}, actions), after));
  }

  function paintMeta() {
    elapsed.textContent = fmtDur(jobDur(job));
    if (metaEl.contains(elapsed)) return;
    const m = t => h('span', {class: 'mono'}, t);
    metaEl.replaceChildren(m(repoLabel(job.repo_url)), '·', m(job.branch), '·', m(job.folder_name), '·',
      h('span', {title: localTime(job.created_at)}, 'started ' + hhmm(job.created_at)), '·', elapsed);
  }

  function paintAll() {
    h1.textContent = job.service;
    badge.replaceChildren(statusBadge(job.status));
    document.title = (job.status === 'success' ? '✓ ' : job.status === 'failed' ? '✗ ' : '● ') + job.service + ' — Build Packager';
    if (!menuAdded) {
      menuAdded = true;
      head.append(menuButton('Build actions', () => {
        const active = jobActive(job);
        return [
          {label: 'Copy folder name', icon: 'copy', run: async () => { if (await copyText(job.folder_name)) toast('Folder name copied'); }},
          {label: 'Copy job id', icon: 'copy', run: async () => { if (await copyText(job.id)) toast('Job id copied'); }},
          '-',
          {label: 'Delete build…', danger: true, disabled: active, title: active ? "Running builds can't be deleted" : undefined,
            run: async () => { if (await deleteJob(job)) router.go('#/dashboard'); }},
        ];
      }));
    }
    paintMeta();
    paintResult();
    paintPipeline();
  }

  // step transitions are announced for screen readers
  const announceSteps = nj => nj.steps.forEach(s => {
    const was = prevSteps[s.name];
    if (was && was !== s.status) {
      if (s.status === 'running') announce(STEP_LABEL[s.name] + ' started');
      else if (s.status === 'success') announce(STEP_LABEL[s.name] + ' succeeded in ' + spoken(parseT(s.finished_at) - parseT(s.started_at)));
      else if (s.status === 'skipped') announce(STEP_LABEL[s.name] + ' skipped');
    }
    prevSteps[s.name] = s.status;
  });

  function stream() {
    es = new EventSource(jobsApi.logStreamUrl(id));
    let ended = false;
    es.addEventListener('open', () => { con.clear(); con.setLive('on', 'live'); });
    es.addEventListener('log', e => con.append(e.data));
    es.addEventListener('status', e => {
      let nj;
      try { nj = JSON.parse(e.data); } catch { return; }
      announceSteps(nj);
      if (job.status !== nj.status && nj.status === 'failed') { const f = failedStep(nj); announce(f ? 'Failed at the ' + STEP_LABEL[f.name] + ' step' : 'Build failed'); }
      if (job.status !== nj.status && nj.status === 'success') announce('Build succeeded');
      job = nj;
      paintAll();
    });
    es.addEventListener('end', () => {
      ended = true;
      es.close();
      con.setLive('', 'ended');
      jobsApi.get(id).then(j2 => {
        if (dead) return;
        job = j2;
        paintAll();
        if (openedActive) resultHead?.focus();
      }).catch(() => {});
    });
    es.onerror = () => { if (!ended && es.readyState === EventSource.CONNECTING) con.setLive('warn', 'Reconnecting…'); };
  }

  const tick = setInterval(() => { if (job && jobActive(job) && con.liveText() !== 'ended') { paintMeta(); paintPipeline(); } }, 1000);

  paintPipeline();
  jobsApi.get(id).then(j => {
    if (dead) return;
    openedActive = jobActive(j);
    if (j.status === 'success') con.setShown(false);
    j.steps.forEach(s => { prevSteps[s.name] = s.status; });
    job = j;
    paintAll();
    stream();
  }).catch(e => {
    if (dead) return;
    const {status, detail} = errDetail(e);
    if (status === 404) { notFound(wrap); return; }
    wrap.replaceChildren(back, h('h1', {tabindex: '-1'}, 'Build'),
      h('div', {style: {marginTop: 'var(--s4)'}}, alertBox('error', [h('span', {}, "Couldn't load this build. " + detail), h('div', {}, btn('ghost', 'Retry', () => router.refresh()))])));
  });

  return () => { dead = true; es?.close(); clearInterval(tick); con.stop(); };
}
