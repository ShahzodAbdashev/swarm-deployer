import {useCallback, useEffect, useRef, useState} from 'react';
import {Alert, Button, EmptyState, Icon, LogConsole, MenuButton, Pipeline, Skeleton, StatusBadge, announce, copyText, errDetail, fmtDur, hhmm,
  localTime, parseT, spoken, toast, useEventSource, useInterval, useLogBuffer, type LogConsoleHandle, type LogLine, type PipelineItem} from '@devtools/ui';
import {jobsApi} from '../../api/endpoints';
import {deleteJob} from '../../lib/deleteJob';
import {STEP_LABEL, curStep, failedStep, jobActive, jobDur} from '../../lib/jobs';
import {repoLabel} from '../../lib/validate';
import {focusH1, router, setTitle} from '../../router';
import type {Job, Step} from '../../types/api';
import {RunResult} from './RunResult';

const ID_RE = /^[0-9a-f]{32}$/;
const stepDur = (s: Step) => (s.started_at ? fmtDur((s.finished_at ? parseT(s.finished_at)! : Date.now()) - parseT(s.started_at)!) : '');

/** Index of the "==> [name] started" line, or -1. */
const startIndex = (lines: LogLine[], name: string) => { for (let i = lines.length - 1; i >= 0; i--) if (lines[i].start === name) return i; return -1; };

/** Last plain (non-"==>") line of the running step: shown under it in the pipeline. */
function runningSub(lines: LogLine[], job: Job): string {
  const c = curStep(job);
  if (!c) return '';
  for (let i = lines.length - 1, s = startIndex(lines, c.s.name); i > s && s >= 0; i--) {
    const t = lines[i].text;
    if (!t.startsWith('==>') && t.trim() && lines[i].cls !== 'dim') return t;
  }
  return '';
}

/** For a bare "exited with code N" error: the last fatal:/error: line of the failed step's log. */
function failureCause(lines: LogLine[], job: Job): string {
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

function NotFound() {
  useEffect(() => { setTitle('Build not found'); focusH1(); }, []);
  return (
    <div className="wrap">
      <EmptyState titleAs="h1" title="Build not found. It may have been deleted."><a className="btn primary" href="#/dashboard">Back to dashboard</a></EmptyState>
    </div>
  );
}

/** One build: status, pipeline steps, result card and the live log (SSE). */
export function RunPage({id}: {id: string}) {
  if (!ID_RE.test(id)) return <NotFound />;
  return <Run id={id} />;
}

function Run({id}: {id: string}) {
  const [job, setJob] = useState<Job | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [live, setLive] = useState({cls: '', text: 'connecting'});
  const [shown, setShown] = useState(true);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [focusResult, setFocusResult] = useState(false);
  const log = useLogBuffer({initial: 'Connecting…'});
  const consoleRef = useRef<LogConsoleHandle>(null);
  const resultHead = useRef<HTMLDivElement>(null);
  const openedActive = useRef(false);
  const prevSteps = useRef<Record<string, string>>({});
  const [, setNow] = useState(0);
  const jobRef = useRef<Job | null>(null);
  jobRef.current = job;

  useEffect(() => {
    setTitle('Build');
    focusH1();
    let dead = false;
    jobsApi.get(id).then(j => {
      if (dead) return;
      openedActive.current = jobActive(j);
      if (j.status === 'success') setShown(false);
      j.steps.forEach(s => { prevSteps.current[s.name] = s.status; });
      setJob(j);
      setStreamUrl(jobsApi.logStreamUrl(id));
    }).catch(e => {
      if (dead) return;
      const {status, detail} = errDetail(e);
      if (status === 404) setMissing(true); else setLoadErr("Couldn't load this build. " + detail);
    });
    return () => { dead = true; };
  }, [id]);

  // step transitions are announced for screen readers
  const announceSteps = (nj: Job) => {
    nj.steps.forEach(s => {
      const was = prevSteps.current[s.name];
      if (was && was !== s.status) {
        if (s.status === 'running') announce(STEP_LABEL[s.name] + ' started');
        else if (s.status === 'success') announce(STEP_LABEL[s.name] + ' succeeded in ' + spoken(parseT(s.finished_at)! - parseT(s.started_at)!));
        else if (s.status === 'skipped') announce(STEP_LABEL[s.name] + ' skipped');
      }
      prevSteps.current[s.name] = s.status;
    });
  };

  useEventSource(streamUrl, {
    open: () => { log.clear(); setLive({cls: 'on', text: 'live'}); },
    log: data => log.append(data),
    status: data => {
      let nj: Job;
      try { nj = JSON.parse(data); } catch { return; }
      const prev = jobRef.current;
      announceSteps(nj);
      if (prev && prev.status !== nj.status && nj.status === 'failed') { const f = failedStep(nj); announce(f ? 'Failed at the ' + STEP_LABEL[f.name] + ' step' : 'Build failed'); }
      if (prev && prev.status !== nj.status && nj.status === 'success') announce('Build succeeded');
      jobRef.current = nj;
      setJob(nj);
    },
    end: () => {
      setLive({cls: '', text: 'ended'});
      jobsApi.get(id).then(j2 => { setJob(j2); if (openedActive.current) setFocusResult(true); }).catch(() => {});
    },
    error: (es, ended) => { if (!ended && es.readyState === EventSource.CONNECTING) setLive({cls: 'warn', text: 'Reconnecting…'}); },
  });

  useInterval(() => setNow(Date.now()), job && jobActive(job) && live.text !== 'ended' ? 1000 : null);
  useEffect(() => {
    if (!job) return;
    document.title = (job.status === 'success' ? '✓ ' : job.status === 'failed' ? '✗ ' : '● ') + job.service + ' — Build Packager';
  }, [job]);
  useEffect(() => { if (focusResult) { resultHead.current?.focus(); setFocusResult(false); } }, [focusResult]);

  const onShownChange = useCallback((v: boolean) => setShown(v), []);
  const jumpTo = (name: string, failed: boolean) => {
    setShown(true);
    const s = startIndex(log.lines, name);
    let line = s >= 0 ? log.lines[s] : undefined;
    if (!line && failed) line = [...log.lines].reverse().find(l => l.cls.startsWith('er'));
    if (line) consoleRef.current?.jumpTo(line.id);
  };

  if (missing) return <NotFound />;
  const back = <a className="back-link" href="#/dashboard"><Icon name="chevron-left" />Builds</a>;
  if (loadErr) {
    return (
      <div className="wrap">{back}<h1 tabIndex={-1}>Build</h1>
        <div style={{marginTop: 'var(--s4)'}}><Alert kind="error"><span>{loadErr}</span><div><Button variant="ghost" onClick={() => router.refresh()}>Retry</Button></div></Alert></div>
      </div>
    );
  }

  const active = jobActive(job);
  const sub = job ? runningSub(log.lines, job) : '';
  const items: PipelineItem[] = (job?.steps ?? Object.keys(STEP_LABEL).map(n => ({name: n, status: 'pending'} as Step))).map(s => {
    const notRun = !!job && !active && s.status === 'pending';
    let text = '', mono = false;
    if (job && s.status === 'failed' && job.status === 'failed' && job.error) text = ''; // shown on the result card
    else if (s.status === 'failed' || s.status === 'skipped') text = s.message || '';
    else if (s.status === 'running') { text = sub; mono = true; }
    return {
      key: s.name, label: STEP_LABEL[s.name], status: notRun ? 'notrun' : s.status,
      duration: s.status === 'pending' || s.status === 'skipped' ? '' : stepDur(s), sub: text, subMono: mono,
    };
  });

  return (
    <div className="wrap">
      {back}
      <div className="run-head">
        <h1 tabIndex={-1}>{job ? job.service : '…'}</h1>
        <span>{job ? <StatusBadge status={job.status} /> : null}</span>
        <span className="spacer" />
        {job ? (
          <MenuButton label="Build actions" items={() => [
            {label: 'Copy folder name', icon: 'copy', run: async () => { if (await copyText(job.folder_name)) toast('Folder name copied'); }},
            {label: 'Copy job id', icon: 'copy', run: async () => { if (await copyText(job.id)) toast('Job id copied'); }},
            '-',
            {label: 'Delete build…', danger: true, disabled: active, title: active ? "Running builds can't be deleted" : undefined,
              run: async () => { if (await deleteJob(job)) router.go('#/dashboard'); }},
          ]} />
        ) : null}
      </div>
      <div className="run-meta">
        {job ? (
          <>
            <span className="mono">{repoLabel(job.repo_url)}</span>·<span className="mono">{job.branch}</span>·
            <span className="mono">{job.folder_name}</span>·<span title={localTime(job.created_at)}>{'started ' + hhmm(job.created_at)}</span>·
            <span id="run-el">{fmtDur(jobDur(job))}</span>
          </>
        ) : <Skeleton w="60%" h={12} />}
      </div>
      <div>{job && !active ? <RunResult ref={resultHead} job={job} cause={failureCause(log.lines, job)} onShowInLog={jumpTo} /> : null}</div>
      <Pipeline items={items} onSelect={k => jumpTo(k, false)} />
      <LogConsole ref={consoleRef} lines={log.lines} capped={log.capped} live={live} shown={shown} onShownChange={onShownChange} downloadHref={jobsApi.logUrl(id)} />
    </div>
  );
}
