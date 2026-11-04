/** API shapes (SPEC.md §3–§5, §10). Passwords never come back: only `has_password`. */

export type HostKeyPolicy = 'auto_add' | 'warn' | 'reject';
export type JobStatus = 'queued' | 'running' | 'success' | 'failed';
export type PhaseStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';
export type PhaseName = 'fetch' | 'extract' | 'connect' | 'transfer' | 'backup' | 'load' | 'tag' | 'deploy' | 'verify' | 'cleanup';

export interface FileServer {
  host: string;
  port: number;
  username: string;
  has_password: boolean;
  private_key_path: string;
  remote_dir: string;
}
export type FileServerIn = Partial<Omit<FileServer, 'has_password'>> & {password?: string};

export interface ExtraNode { host: string; port: number; username: string; private_key_path?: string; has_password?: boolean }
export interface ExtraNodeIn { host: string; port: number; username: string; private_key_path: string; password?: string }

export interface Target {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  has_password: boolean;
  private_key_path: string;
  host_key_policy: HostKeyPolicy;
  docker_cmd: string;
  work_dir: string;
  backup_dir: string;
  extra_nodes: ExtraNode[];
  registry?: Registry;
}
export interface Registry { url: string; username: string; has_password: boolean }
export interface TargetIn {
  id?: string;
  name: string;
  host: string;
  port: number;
  username: string;
  private_key_path: string;
  host_key_policy: string;
  docker_cmd: string;
  work_dir: string;
  backup_dir: string;
  password?: string;
  extra_nodes?: ExtraNodeIn[];
  registry?: {url: string; username: string; password?: string};
}

/** POST /api/deploys/plan: where the package goes, worked out from its .gitlab-ci.yml / last deploy (nothing to pick). */
export interface DeployPlan {
  package: string;
  target: string;
  target_name: string;
  swarm_service: string;
  image_repo: string;
  moving_tag: string;
  health_url: string;
  source: 'gitlab-ci' | 'last-deploy';
  registry: string | false;
  current_image: string;
}

export interface Options {
  keep_backups: number;
  save_image_tar: boolean;
  converge_timeout: number;
  update_monitor: number;
  health_timeout: number;
  prune_after: boolean;
}

export interface Config {
  file_server: FileServer;
  targets: Target[];
  options: Options;
  gitlab?: GitlabConfig;
}

export interface GitlabConfig { url: string; has_token: boolean }

export interface GitlabProject { full_name: string; clone_url: string; default_branch: string; private: boolean }
export interface EnvImportResult { set: string[]; ignored: string[]; errors: string[]; project?: string }

export interface TestResult { ok: boolean; message: string; host_key?: string; swarm_manager?: boolean; docker_version?: string }

export interface Package { name: string; path: string; ts: string | null; format?: 'packager' | 'tarzip'; created_at: string; modified_at?: string | null; size: number | null }
export interface PackageGroup { service: string; mapped: boolean; deployable?: boolean; packages: Package[] }
export interface PackageList { path: string; dirs: string[]; groups: PackageGroup[]; other: string[] }

export interface LastDeploy { id: string; kind: string; status: JobStatus; version: string; finished_at: string | null }
export interface Service {
  package: string;
  target: string;
  swarm_service: string;
  image_repo: string;
  health_url?: string;
  exists: boolean;
  current_image: string | null;
  replicas_running: number;
  replicas_desired: number;
  update_state: string | null;
  last_deploy: LastDeploy | null;
  error: string | null;
  current_digest?: string | null;
  moving_tag?: string;
  registry?: string | null;
}

export interface Backup {
  id: string;
  created_at: string;
  previous_image: string | null;
  backup_tag: string;
  tag_present: boolean;
  has_image_tar: boolean;
  job_id: string | null;
  dir: string;
  digest?: string | null;
  in_registry?: boolean;
  layout?: 'new' | 'legacy';
}

export interface Phase { name: PhaseName; status: PhaseStatus; started_at: string | null; finished_at: string | null; message: string }

export interface Job {
  id: string;
  kind: 'deploy' | 'rollback';
  ts: string;
  package: string;
  package_path: string | null;
  version: string;
  target: string;
  target_label: string | null;
  swarm_service: string | null;
  image_repo: string | null;
  mode: 'update' | 'create' | null;
  loaded_image: string | null;
  new_image: string | null;
  moving_image: string | null;
  previous_image: string | null;
  backup: {id: string; dir: string; tag: string; image_tar: boolean; digest?: string | null} | null;
  backup_id: string | null;
  save_image_tar: boolean;
  rollback: {performed: boolean; method: string; to_image: string | null; ok: boolean} | null;
  status: JobStatus;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  phases: Phase[];
  health_url?: string | null;
  package_format?: 'packager' | 'tarzip' | null;
  registry?: string | null;
  moving_tag?: string | null;
  previous_ref?: string | null;
  previous_digest?: string | null;
  new_digest?: string | null;
  deploy_image?: string | null;
  pushed?: string[];
  health_script?: boolean;
  artifacts?: {job_dir?: string; [k: string]: unknown} | null;
}
export interface DeployIn { package_path: string; password: string; save_image_tar: boolean | null }
