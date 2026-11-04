import {StatusIcon, type Status} from './Icon';
import './Pipeline.css';

export interface PipelineItem {
  key: string;
  label: string;
  /** 'notrun' = the job finished before this step ran. */
  status: Status | 'notrun';
  duration?: string;
  /** Detail line under the label (last log line, skip reason, ...). */
  sub?: string;
  subMono?: boolean;
  /** Tooltip for the detail line (it is truncated to one line). */
  subTitle?: string;
}

const SR: Record<string, string> = {notrun: 'not run', success: 'succeeded'};

/** Vertical list of job steps with status glyphs and durations; clicking a step calls onSelect. */
export function Pipeline({items, onSelect, label = 'Pipeline'}: {items: PipelineItem[]; onSelect?: (key: string) => void; label?: string}) {
  return (
    <ol className="pipeline" aria-label={label}>
      {items.map(it => {
        const notRun = it.status === 'notrun';
        return (
          <li key={it.key}>
            <button className={notRun ? 'pstep ps-skipped ps-notrun' : 'pstep ps-' + it.status} type="button" onClick={() => onSelect?.(it.key)}>
              <span><StatusIcon status={notRun ? 'skipped' : it.status} className="lg" /></span>
              <span><span className="plab">{it.label}</span><span className="sr">{', ' + (SR[it.status] || it.status)}</span></span>
              <span className="pdur" data-live={it.status === 'running' ? '' : undefined}>{it.duration || ''}</span>
              <span className={'psub' + (it.subMono ? ' mono' : '')} hidden={!it.sub} title={it.subTitle}>{it.sub || ''}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
