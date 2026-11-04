import type {AuthStatus, Branch, DevicePoll, DeviceStart, EnvImportResult, EnvPreview, GitlabConfig, Job, JobIn, LoginResult, Repo,
  UploadConfig, UploadConfigIn, UploadTestResult} from '../types/api';
import {api} from './client';

/** Typed API, one object per resource (SPEC.md §4). */

export const authApi = {
  status: () => api<AuthStatus>('GET', '/api/auth/status'),
  token: (token: string) => api<LoginResult>('POST', '/api/auth/token', {token}),
  ghCli: () => api<LoginResult>('POST', '/api/auth/gh-cli'),
  deviceStart: () => api<DeviceStart>('POST', '/api/auth/device/start'),
  devicePoll: (device_code: string) => api<DevicePoll>('POST', '/api/auth/device/poll', {device_code}),
  logout: () => api<unknown>('POST', '/api/auth/logout'),
  gitlabToken: (token: string, url: string) => api<LoginResult>('POST', '/api/auth/gitlab/token', {token, url}),
};

/** Full-page navigation target for GitLab OAuth (redirects to GitLab and back). */
export const GITLAB_START = '/api/auth/gitlab/start';

export const gitlabApi = {
  projects: () => api<Repo[]>('GET', '/api/gitlab/projects'),
  branches: (project: string) => api<Branch[]>('GET', '/api/gitlab/branches?project=' + encodeURIComponent(project)),
  envPreview: (body: {repo_url: string; branch: string; job: string}) => api<EnvPreview>('POST', '/api/gitlab/env-preview', body),
};

export const configApi = {
  getGitlab: () => api<GitlabConfig>('GET', '/api/config/gitlab'),
  putGitlab: (body: {client_id?: string; client_secret?: string}) => api<GitlabConfig>('PUT', '/api/config/gitlab', body),
  importEnv: (content: string) => api<EnvImportResult>('POST', '/api/config/import-env', {content}),
};

export const githubApi = {
  repos: () => api<Repo[]>('GET', '/api/github/repos'),
  branches: (fullName: string) => api<Branch[]>('GET', '/api/github/branches?repo=' + encodeURIComponent(fullName)),
};

export const uploadApi = {
  get: () => api<UploadConfig>('GET', '/api/config/upload'),
  put: (body: UploadConfigIn) => api<UploadConfig>('PUT', '/api/config/upload', body),
  test: (body: UploadConfigIn) => api<UploadTestResult>('POST', '/api/config/upload/test', body),
};

export const jobsApi = {
  list: () => api<Job[]>('GET', '/api/jobs'),
  get: (id: string) => api<Job>('GET', '/api/jobs/' + id),
  create: (body: JobIn) => api<Job>('POST', '/api/jobs', body),
  remove: (id: string) => api<unknown>('DELETE', '/api/jobs/' + id),
  logStreamUrl: (id: string) => `/api/jobs/${id}/logs/stream`,
  logUrl: (id: string) => `/api/jobs/${id}/log`,
  zipUrl: (id: string) => `/api/jobs/${id}/download/zip`,
  tarUrl: (id: string) => `/api/jobs/${id}/download/tar`,
};
