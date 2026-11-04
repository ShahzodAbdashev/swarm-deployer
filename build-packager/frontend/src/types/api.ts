/** Types of the Build Packager REST API (SPEC.md §4–§5). */

export interface GitlabAuth {
  logged_in: boolean;
  login: string | null;
  avatar_url: string | null;
  url: string;
  method: 'oauth' | 'pat' | null;
  oauth_available: boolean;
}

export interface AuthStatus {
  logged_in: boolean;
  login: string | null;
  avatar_url: string | null;
  device_flow_available: boolean;
  provider: 'gitlab' | 'github' | null;
  github: {logged_in: boolean; login: string | null};
  gitlab: GitlabAuth;
  /** One-shot OAuth callback error. */
  oauth_error: string | null;
}

export interface GitlabConfig {
  url: string;
  client_id: string;
  client_id_source: 'settings' | 'env' | null;
  has_client_secret: boolean;
  oauth_available: boolean;
}

export interface EnvLine { key: string; vars: string[]; status: 'ok' | 'missing' | 'literal' }

/** POST /api/gitlab/env-preview. `content` holds real values: memory only, never stored. */
export interface EnvPreview {
  project: string;
  branch: string;
  job: string;
  target: string;
  content: string;
  lines: EnvLine[];
  keys: string[];
  missing: string[];
  sources: Record<string, string>;
  warnings: string[];
}

export interface EnvImportResult { set: string[]; ignored: string[]; errors: string[] }

export interface LoginResult { login: string; avatar_url: string | null }

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
}

export interface DevicePoll extends Partial<LoginResult> {
  status: 'pending' | 'slow_down' | 'ok' | 'error';
  interval?: number;
  error?: string;
}

export interface Repo {
  full_name: string;
  clone_url: string;
  default_branch: string;
  private: boolean;
}

export interface Branch { name: string }

export type Protocol = 'sftp' | 'ftp' | 'ftps' | 'smb';

export interface UploadConfig {
  enabled: boolean;
  protocol: Protocol;
  host: string;
  port: number;
  username: string;
  private_key_path: string;
  remote_dir: string;
  share: string;
  domain: string;
  has_password: boolean;
}

/** PUT /api/config/upload and the test endpoint body: every field optional; password '' removes it. */
export type UploadConfigIn = Partial<Omit<UploadConfig, 'has_password'>> & {password?: string};

export interface UploadTestResult { ok: boolean; message: string; created?: string[] }

export type StepName = 'prepare' | 'clone' | 'build' | 'save' | 'extra_repos' | 'zip' | 'upload';
export type StepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';
export type JobStatus = 'queued' | 'running' | 'success' | 'failed';

export interface Step {
  name: StepName;
  status: StepStatus;
  started_at: string | null;
  finished_at: string | null;
  message: string;
}

export interface ExtraRepo { url: string; branch: string; name: string }

export interface DeployManifest { service: string; image: string; target?: string; health_url?: string; moving_tag?: string }

export interface Job {
  id: string;
  service: string;
  ts: string;
  folder_name: string;
  tar_name?: string;
  repo_url: string;
  repo_name?: string;
  branch: string;
  dockerfile: string;
  build_command: string;
  extra_repos: ExtraRepo[];
  upload_requested: boolean;
  remote_dir?: string | null;
  image_tag: string;
  status: JobStatus;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  steps: Step[];
  artifacts: {tar: boolean; zip: boolean; tar_size: number; zip_size: number; remote_path: string | null};
  deploy_manifest?: DeployManifest | null;
  env?: {path: string; keys: string[]; count: number; source: EnvSource; written?: string | null} | null;
  preload_tars?: string[];
  healthcheck?: boolean;
}

export type EnvSource = 'paste' | 'file' | 'gitlab';

export interface JobIn {
  service: string;
  repo_url: string;
  branch: string;
  dockerfile: string;
  build_command: string;
  extra_repos: {url: string; branch: string; name?: string}[];
  password: string;
  password_confirm: string;
  upload: boolean;
  remote_dir?: string;
  env?: {content: string; path: string; source: EnvSource} | null;
  preload_tars?: string[];
}
