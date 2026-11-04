import {useCallback, useEffect, useRef, useState} from 'react';
import {Alert, Button, EmptyState, Icon, LogConsole, MenuButton, Pipeline, Skeleton, StatusBadge, announce, confirm, copyText, errDetail, fmtDur,
  hhmm, parseT, spoken, toast, useEventSource, useInterval, useLogBuffer, type LogConsoleHandle, type LogLine, type PipelineItem} from '@devtools/ui';
import {deploysApi, servicesApi} from '../../api/endpoints';
import {localT} from '../../lib/format';
import {classifyDeployLine, plabel, jobActive, jobDur, phaseOf} from '../../lib/jobs';
import {focusH1, router, setTitle} from '../../router';
import type {Job, Phase} from '../../types/api';
import {RunResult} from './RunResult';

const ID_RE = /^[0-9a-f]{32}$/;
const phaseDur = (p: Phase) => (p.started_at ? fmtDur((p.finished_at ? parseT(p.finished_at)! : Date.now()) - parseT(p.started_at)!) : '');
const startIndex = (lines: LogLine[], name: string) => { for (let i = lines.length - 1; i >= 0; i--) if (lines[i].start === name) return i; return -1; };

/** Last plain (non-"==>") line since the running phase started: shown under it in the pipeline. */
function runningSub(lines: LogLine[], job: Job): string {
  const c = phaseOf(job, 'running');
  if (!c) return '';
  for (let i = lines.length - 1, s = startIndex(lines, c.p.name); i > s && s >= 0; i--) {
    const t = lines[i].text;
    if (!t.startsWith('==>') && t.trim()) return t;
  }
  return '';
}

function NotFound() {
  useEffect(() => { setTitle('Deploy not found'); focusH1(); }, []);
  return (
    <div className="wrap">
      <EmptyState titleAs="h1" title="Deploy not found. It may have been deleted."><a className="btn primary" href="#/dashboard">Back to dashboard</a></EmptyState>
    </div>
  );
}

/** One deploy or rollback: status, phase pipeline, result card and the live log (SSE). */
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
  const [svcNow, setSvcNow] = useState<string | null>(null);
  const log = useLogBuffer({initial: 'Connecting…', classify: classifyDeployLine});
  const consoleRef = useRef<LogConsoleHandle>(null);
  const resultHead = useRef<HTMLDivElement>(null);
  const openedActive = useRef(false);
  const prevPhases = useRef<Record<string, string>>({});
  const [, setNow] = useState(0);
  const jobRef = useRef<Job | null>(null);
  jobRef.current = job;

  useEffect(() => {
    setTitle('Deploy');
    focusH1();
    let dead = false;
    deploysApi.get(id).then(j => {
      if (dead) return;
      openedActive.current = jobActive(j);
      if (j.status === 'success') setShown(false);
      j.phases.forEach(p => { prevPhases.current[p.name] = p.status; });
      setJob(j);
      setStreamUrl(deploysApi.logStreamUrl(id));
    }).catch(e => {
      if (dead) return;
      const {status, detail} = errDetail(e);
      if (status === 404) setMissing(true); else setLoadErr("Couldn't load this deploy. " + detail);
    });
    return () => { dead = true; };
  }, [id]);

  const isRb = job?.kind === 'rollback';

  const announcePhases = (nj: Job) => {
    nj.phases.forEach(p => {
      const was = prevPhases.current[p.name];
      if (was && was !== p.status) {
        if (p.status === 'running') announce(plabel(p.name, nj) + ' started');
        else if (p.status === 'success') announce(plabel(p.name, nj) + ' succeeded in ' + spoken(parseT(p.finished_at)! - parseT(p.started_at)!));
        else if (p.status === 'failed') announce(plabel(p.name, nj) + ' failed');
      }
      prevPhases.current[p.name] = p.status;
    });
  };

  useEventSource(streamUrl, {
    open: () => { log.clear(); setLive({cls: 'on', text: 'live'}); },
    log: data => log.append(data),
    status: data => {
      let nj: Job;
      try { nj = JSON.parse(data); } catch { return; }
      const prev = jobRef.current;
      announcePhases(nj);
      if (prev && prev.status !== nj.status && nj.status === 'success') announce(nj.kind === 'rollback' ? 'Rollback succeeded' : 'Deploy succeeded');
      jobRef.current = nj;
      setJob(nj);
    },
    end: () => {
      setLive({cls: '', text: 'ended'});
      deploysApi.get(id).then(j2 => { setJob(j2); if (openedActive.current) setFocusResult(true); }).catch(() => {});
    },
    error: (es, ended) => { if (!ended && es.readyState === EventSource.CONNECTING) setLive({cls: 'warn', text: 'Reconnecting…'}); },
  });

  useInterval(() => setNow(Date.now()), job && jobActive(job) && live.text !== 'ended' ? 1000 : null);
  useEffect(() => {
    if (!job) return;
    document.title = (job.status === 'success' ? '✓ ' : job.status === 'failed' ? '✗ ' : '● ') + job.package + ' — Swarm Deployer';
  }, [job]);
  useEffect(() => { if (focusResult) { resultHead.current?.focus(); setFocusResult(false); } }, [focusResult]);

  // after a success: how many replicas the service runs now
  const succeeded = job?.status === 'success';
  useEffect(() => {
    if (!succeeded || !job) return;
    let dead = false;
    servicesApi.get(job.package).then(s => { if (!dead && s && s.exists) setSvcNow(s.replicas_running + '/' + s.replicas_desired + ' running'); }).catch(() => {});
    return () => { dead = true; };
  }, [succeeded]); // eslint-disable-line react-hooks/exhaustive-deps

  const onShownChange = useCallback((v: boolean) => setShown(v), []);
  const jumpTo = (name: string, failed: boolean) => {
    setShown(true);
    const s = startIndex(log.lines, name);
    let line = s >= 0 ? log.lines[s] : undefined;
    if (!line && failed) line = [...log.lines].reverse().find(l => l.cls.startsWith('er'));
    if (line) consoleRef.current?.jumpTo(line.id);
  };

  if (missing) return <NotFound />;
  const back = <a className="back-link" href="#/dashboard"><Icon name="chevron-left" />Deployments</a>;
  if (loadErr) {
    return (
      <div className="wrap">{back}<h1 tabIndex={-1}>Deploy</h1>
        <div style={{marginTop: 'var(--s4)'}}><Alert kind="error"><span>{loadErr}</span><div><Button variant="ghost" onClick={() => router.refresh()}>Retry</Button></div></Alert></div>
      </div>
    );
  }

  const active = jobActive(job);
  const sub = job ? runningSub(log.lines, job) : '';
  const items: PipelineItem[] = (job?.phases || []).map(p => {
    const notRun = !active && p.status === 'pending';
    const running = p.status === 'running';
    return {
      key: p.name, label: plabel(p.name, job), status: notRun ? 'notrun' : p.status,
      duration: p.status === 'pending' || p.status === 'skipped' ? '' : phaseDur(p),
      sub: running ? sub : p.message || '', subMono: running || p.status === 'success', subTitle: running ? undefined : p.message || undefined,
    };
  });

  const deleteRecord = async () => {
    if (!job) return;
    if (!(await confirm({title: 'Delete this deploy record?', confirm: 'Delete', body: 'Deletes the log and job record from this computer. Nothing on the target or its backups is touched.'}))) return;
    try { await deploysApi.remove(job.id); toast('Deploy record deleted', 'success'); router.go('#/dashboard'); }
    catch (e) { const {status, detail} = errDetail(e); toast(status === 409 ? 'This deploy is still running.' : detail, 'error'); }
  };

  return (
    <div className="wrap">
      {back}
      <div className="run-head">
        <h1 tabIndex={-1}>{job ? (isRb ? 'Rollback · ' + job.package : job.package) : '…'}</h1>
        <span>{job ? <StatusBadge status={job.status} /> : null}</span>
        <span className="spacer" />
        {job ? (
          <MenuButton label="Deploy actions" items={() => [
            {label: 'Copy job id', icon: 'copy', run: async () => { if (await copyText(job.id)) toast('Job id copied'); }},
            {label: 'Service details', run: () => router.go('#/services/' + encodeURIComponent(job.package))},
            '-',
            {label: 'Delete deploy record…', danger: true, disabled: active, title: active ? "Running deploys can't be deleted" : undefined, run: deleteRecord},
          ]} />
        ) : null}
      </div>
      <div className="run-meta">
        {job ? (
          <>
            <span className="mono">{job.version || ''}</span>·
            <span className="mono">{(job.swarm_service || '') + ' @ ' + (job.target_label || job.target || '')}</span>·
            <span title={localT(job.created_at)}>{'started ' + hhmm(job.created_at)}</span>·
            <span id="run-el">{fmtDur(jobDur(job))}</span>
          </>
        ) : <Skeleton w="60%" h={12} />}
      </div>
      {job && (!active || job.phases.some(p => p.name === 'connect' && p.status !== 'pending')) ? (
        <dl id="run-images">
          <dt>Before</dt><dd>{job.previous_ref || job.previous_image || '—'}</dd>
          <dt>After</dt><dd>{job.deploy_image || job.new_image || '—'}</dd>
        </dl>
      ) : null}
      <div>{job && !active ? <RunResult ref={resultHead} job={job} svcNow={svcNow} onShowInLog={jumpTo} /> : null}</div>
      <Pipeline items={items} onSelect={k => jumpTo(k, false)} />
      <LogConsole ref={consoleRef} lines={log.lines} capped={log.capped} live={live} shown={shown} onShownChange={onShownChange}
        downloadHref={deploysApi.logUrl(id)} label="Deploy log" />
    </div>
  );
}
