import type {Backup, Config, DeployIn, EnvImportResult, FileServer, FileServerIn, GitlabConfig,
  DeployPlan, GitlabProject, Job, Options, PackageList, Service, Target, TargetIn, TestResult} from '../types/api';
import {api} from './client';

/** Typed API, one object per resource (SPEC.md §4). Ids are concatenated onto literal route prefixes. */

const enc = encodeURIComponent;

export const gitlabApi = {
  projects: () => api<GitlabProject[]>('GET', '/api/gitlab/projects'),
};

export const configApi = {
  get: () => api<Config>('GET', '/api/config'),
  putFileServer: (body: FileServerIn) => api<FileServer>('PUT', '/api/config/file-server', body),
  testFileServer: (body: FileServerIn) => api<TestResult>('POST', '/api/config/file-server/test', body),
  putOptions: (body: Partial<Options>) => api<Options>('PUT', '/api/config/options', body),
  putGitlab: (body: {url?: string; token?: string}) => api<GitlabConfig>('PUT', '/api/config/gitlab', body),
  importEnv: (content: string, target_id?: string) => api<EnvImportResult>('POST', '/api/config/import-env', target_id ? {content, target_id} : {content}),
  importGitlab: (project: string, target_id?: string) => api<EnvImportResult>('POST', '/api/config/import-gitlab', target_id ? {project, target_id} : {project}),
};

export const targetsApi = {
  create: (body: TargetIn) => api<Target>('POST', '/api/targets', body),
  update: (id: string, body: TargetIn) => api<Target>('PUT', '/api/targets/' + enc(id), body),
  remove: (id: string) => api<unknown>('DELETE', '/api/targets/' + enc(id)),
  test: (id: string) => api<TestResult>('POST', '/api/targets/' + enc(id) + '/test'),
};

export const packagesApi = {
  list: (path: string) => api<PackageList>('GET', '/api/packages?path=' + enc(path)),
};

export const servicesApi = {
  list: () => api<Service[]>('GET', '/api/services'),
  get: (pkg: string) => api<Service>('GET', '/api/services/' + enc(pkg)),
  backups: (pkg: string) => api<Backup[]>('GET', '/api/services/' + enc(pkg) + '/backups'),
};

export const deploysApi = {
  list: (pkg?: string) => api<Job[]>('GET', pkg ? '/api/deploys?package=' + enc(pkg) : '/api/deploys'),
  get: (id: string) => api<Job>('GET', '/api/deploys/' + id),
  create: (body: DeployIn) => api<Job>('POST', '/api/deploys', body),
  plan: (package_path: string, password: string) => api<DeployPlan>('POST', '/api/deploys/plan', {package_path, password}),
  remove: (id: string) => api<unknown>('DELETE', '/api/deploys/' + id),
  logUrl: (id: string) => '/api/deploys/' + id + '/log',
  logStreamUrl: (id: string) => '/api/deploys/' + id + '/logs/stream',
};

export const rollbacksApi = {
  create: (pkg: string, backupId: string) => api<Job>('POST', '/api/rollbacks', {package: pkg, backup_id: backupId}),
};
