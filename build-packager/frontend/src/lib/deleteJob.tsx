import {confirm, errDetail, toast} from '@devtools/ui';
import {jobsApi} from '../api/endpoints';
import type {Job} from '../types/api';

/** Confirm, delete, toast. Returns true when the build was deleted. */
export async function deleteJob(j: Job): Promise<boolean> {
  const ok = await confirm({
    title: 'Delete this build?', confirm: 'Delete build',
    body: <>Deletes the log, the workspace folder and the zip for <code>{j.folder_name}</code> from this computer. Files already uploaded to your server are not touched.</>,
  });
  if (!ok) return false;
  try { await jobsApi.remove(j.id); toast('Build deleted', 'success'); return true; }
  catch (e) { const {status, detail} = errDetail(e); toast(status === 409 ? 'This build is still running.' : detail, 'error'); return false; }
}
