# Swarm Deployer — SPEC

The deploy side of Build Packager. A local web tool that works like a GitLab/GitHub runner job: it takes a
`<service>_<ts>.zip` that Build Packager uploaded to the file server, opens it with the password the user types,
signs in to the target server (a Docker Swarm manager) over SSH, backs up what is running, loads the image,
tags it, updates exactly the mapped swarm service, verifies it, and rolls back on failure. Every phase streams
live logs to the UI.

Backend and frontend are built in parallel from this file. If something is not in this file, it is out of scope.
The mock lab used for testing is in `TESTENV.md`.

Upstream contract (Build Packager, `/home/shahzod/mywork/build-packager/SPEC.md` §5): the zip is AES-256
(pyzipper WZ_AES), every entry is under `<service>_<ts>/`, the image archive is
`<service>_<ts>/<service>_<ts>.tar`, made by `docker save` of `<service.lower()>:<ts>`, and `<ts>` is
`YYYYMMDD_HHMMSS`. Other folders in the zip (source repos) are ignored here.

## 0. Hard rules

1. **No local Docker.** The backend never runs `docker` (or any subprocess) on the machine it runs on. Every docker
   command runs on a remote host over SSH (paramiko). The backend does not import `subprocess`.
2. **No shell interpolation.** Every remote command is built from an argv list with
   `" ".join(shlex.quote(a) for a in argv)`. The only extra shell syntax ever appended is `> ` + `shlex.quote(path)`
   for one redirect (backup `service.json`) and ` 2>&1`. Nothing else.
3. **Secrets.** The zip password exists only in the request body and the job thread's memory; it is never written to
   disk, logs, job json or SSE, and the reference is deleted after the extract phase. Stored SSH/FTP passwords are
   never returned by the API (booleans `has_password` instead) and never logged. Before writing any log line, every
   known secret string (zip password, file-server password, target and node passwords) is replaced with `***`.
4. Bind to `127.0.0.1` only, port **8095**. `TrustedHostMiddleware(allowed_hosts=["127.0.0.1", "localhost"])`.
5. One deploy/rollback at a time per (target, swarm service): a second request gets `409`.
6. **[patch 2026-11-03] Sign-in gate (§11.2).** Every `/api/*` route except `/api/auth/*` returns
   `401 {"detail": "not signed in"}` until a GitLab token (PAT or OAuth+PKCE) is stored for the configured GitLab URL.
   It is a UX gate for one local user (AD-8), not a security boundary.
7. **[patch 2026-11-03] More secrets (§11.2 Masks).** The registry password is sent to `docker login --password-stdin`
   on the SSH channel's stdin, never in argv or logs. GitLab token, refresh token and client secret, and every
   target's `registry.password`, are masked `***` in logs and returned only as `has_<key>` booleans.

## 1. Stack and files

| Path | Purpose |
|---|---|
| `app.py` + `backend/` | FastAPI app (`app.py` is the entry point; modules in `backend/`, see README Structure). Serves `frontend/dist/index.html` at `GET /` (503 with a hint when not built) and the bundle at `GET /assets/{name}`. |
| `frontend/` | UI: React 19 + TypeScript + Vite, built to `frontend/dist`; components from `../shared-ui` (`@devtools/ui`). No CDN, hash routing. |
| `requirements.txt` | `fastapi`, `uvicorn`, `pyzipper`, `paramiko`, `pyyaml`, `smbprotocol==1.17.0` (SMB, §11.3). (No httpx: health checks run on the target; GitLab calls use stdlib `urllib`.) |
| `run.sh` | Create `.venv` if missing, `pip install -r requirements.txt`, build `frontend/dist` when missing or stale (`npm ci` + `npm run build`), then `exec .venv/bin/uvicorn app:app --host 127.0.0.1 --port 8095`. |
| `README.md` | How to run, configure and use it; how to run the lab and tests. |
| `testenv/` | Mock lab scripts (TESTENV.md). |
| `tests/e2e_test.py`, `tests/ui_test.py` | API and browser tests against the lab. |

`data/` (created at startup; path overridable with env `SD_DATA` so tests can use a scratch dir):
```
data/config.json              chmod 600
data/known_hosts              host keys learned/accepted (paramiko format)
data/deploys/<id>.json        job metadata + phases
data/deploys/<id>.log         full log, secrets masked
data/work/<id>/               temp: downloaded zip + extracted tar (removed in cleanup)
data/keys/<target id>         SSH keys imported from .env / GitLab variables (dir 700, file 600, §11.7)
```
`<id>` = `uuid4().hex`. Job `ts` = local time at creation, `YYYYMMDD_HHMMSS` (used for backup ids/tags).

## 2. Conventions

Same as Build Packager §2: JSON bodies; errors `{"detail": "<field>: <message>"}` with 400 (validation),
404 (unknown id/mapping/target/backup), 409 (wrong state / already deploying), 502 (upstream failure where a
synchronous call needs the file server or target); timestamps ISO-8601 local with seconds.
Connection **tests** return 200 `{"ok": false, "message": ...}` on failure, not 502.

### Validation

| Field | Rule |
|---|---|
| package service (`package`) | `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$` (same as Build Packager `service`) |
| package file name | `^(?P<service>[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62})_(?P<ts>\d{8}_\d{6})\.zip$` |
| remote paths (`remote_dir`, `path`, `work_dir`, `backup_dir`) | absolute, no `..` segment, no control chars, ≤1024 chars; normalized (Build Packager `clean_remote_dir`). Spaces allowed. |
| `host` | 1–253 chars, `^[A-Za-z0-9][A-Za-z0-9.:-]*$` (hostname, IPv4, IPv6 without brackets) |
| `port` | 1–65535 |
| `username` | `^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$` (file server: may be empty for anonymous FTP) |
| target `id` | `^[a-z0-9][a-z0-9-]{0,31}$`, unique |
| `docker_cmd` | exactly `"docker"` or `"sudo -n docker"` |
| `host_key_policy` | `auto_add` \| `warn` \| `reject` |
| `swarm_service` | `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$` |
| `image_repo` | `^([a-z0-9.-]+(:[0-9]{1,5})?/)?[a-z0-9]+([._-][a-z0-9]+)*(/[a-z0-9]+([._-][a-z0-9]+)*)*$`, ≤200 chars |
| `moving_tag` | `""` (disabled) or `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$`, not matching `^backup-` and not `\d{8}_\d{6}` |
| `health_url` | `""` or `^https?://\S+$`, ≤500 chars |
| `publish` items | `^\d{1,5}:\d{1,5}$` (published:target) |
| `replicas` | 1–20 |
| `keep_backups` | 1–50 |
| `converge_timeout` | 10–1800 s; `update_monitor` 1–600 s; `health_timeout` 1–600 s |
| deploy `password` | non-empty, ≤1024 chars |
| `backup_id` | `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}_\d{8}_\d{6}$` |

**[patch 2026-11-03]** New validation rows (SMB share/domain, registry, `@current`, GitLab URL/project, `.env`
content, the two package file-name formats): §11.1 *Validation*.

## 3. config.json schema

```json
{
  "file_server": {
    "protocol": "sftp",
    "host": "", "port": 22, "username": "", "password": "", "private_key_path": "",
    "remote_dir": "/",
    "verify_tls": false
  },
  "targets": [
    {
      "id": "lab",
      "name": "Lab swarm",
      "host": "127.0.0.1", "port": 2223, "username": "deploy",
      "password": "", "private_key_path": "",
      "host_key_policy": "auto_add",
      "docker_cmd": "docker",
      "work_dir": "/home/deploy/sd-work",
      "backup_dir": "/home/deploy/sd-backups",
      "extra_nodes": [
        {"host": "127.0.0.1", "port": 2224, "username": "deploy", "password": "", "private_key_path": ""}
      ]
    }
  ],
  "mappings": [
    {
      "package": "sdtest-web1",
      "target": "lab",
      "swarm_service": "sdtest_web1",
      "image_repo": "sdtest/web1",
      "moving_tag": "latest",
      "health_url": "http://127.0.0.1:8081/health",
      "create_if_missing": false,
      "create": {"replicas": 1, "publish": ["8081:8080"]}
    }
  ],
  "options": {
    "keep_backups": 5,
    "save_image_tar": false,
    "converge_timeout": 120,
    "update_monitor": 10,
    "health_timeout": 30
  }
}
```
- Missing file → all defaults above with empty `targets` and `mappings`, `file_server.host` empty.
- `chmod 600` after every write. Writes are under a lock (read-modify-write).
- `protocol`: `sftp` | `ftp` | `ftps` (FTPS = `ftplib.FTP_TLS` explicit TLS + `prot_p()`), same as Build Packager.
- `verify_tls` (FTPS only, default `false`): `true` verifies the server certificate and host name against the system
  CA store (`ssl.create_default_context()`); `false` accepts any certificate, e.g. a self-signed one (lab).
- Mapping key is `package` (unique). A mapping names one target by id. Deleting a target that a mapping uses → 409.
- `host_key_policy`: `auto_add` = paramiko `AutoAddPolicy` and the key is saved to `data/known_hosts`; the log
  prints `WARNING: host key for <host>:<port> auto-accepted (<type> <sha256 fingerprint>)` the first time.
  `warn` = `WarningPolicy` (connects, logs the warning, does not save). `reject` = `RejectPolicy`; known keys come from
  `~/.ssh/known_hosts` + `data/known_hosts`. Default `auto_add` (lab); the Settings UI shows a warning next to it.
- SSH auth: `password` and/or `private_key_path`; if both empty, agent/default keys are allowed
  (`allow_agent`/`look_for_keys` true). Timeouts: connect/banner/auth 15 s.
- `extra_nodes`: other swarm nodes that need the image locally (single-registry-less clusters). They get the same
  transfer/load/tag; they never get service commands. They use the target's `host_key_policy` and `docker_cmd`.

**[patch 2026-11-03]** New keys `file_server.share/domain`, `options.save_image_tar` (now default `true`),
`options.prune_after`, `gitlab{…}`, `env_import{…}` and `targets[].registry{url, username, password}`: §11.1.

## 4. REST API

### 4.1 UI
`GET /` → `frontend/dist/index.html`; `GET /assets/{name}` → built JS/CSS (flat dir, no traversal).

**[patch 2026-11-03]** New routes: `/api/auth/status`, `/api/auth/gitlab/token`, `/api/auth/gitlab/start`,
`/api/auth/gitlab/callback`, `/api/auth/logout` (open), `PUT /api/config/gitlab`, `GET /api/gitlab/projects`,
`POST /api/config/import-env`, `POST /api/config/import-gitlab` (gated): §11.2 and §11.7. `GET /api/packages`
entries gain `format`/`modified_at` and accept two name formats (§11.4); `GET /api/services` rows gain
`current_digest`/`moving_tag`/`registry` and backups rows gain `digest`/`in_registry`/`layout` (§11.6 Backups API).

### 4.2 Settings

**GET `/api/config`** → 200 the whole config with every `password` replaced by `has_password: bool`.

**PUT `/api/config/file-server`** — partial update (omitted fields keep value; `password` omitted keeps it, `""`
clears it). → 200 public file_server. 400 on validation.

**POST `/api/config/file-server/test`** — optional body with file-server fields overriding saved ones for this test
only (blank `password` keeps the saved one). Connects, logs in, lists `remote_dir`. → 200
`{"ok": true, "message": "Connected to host:port, 3 packages in /releases"}` or `{"ok": false, "message": "..."}`.
Never creates folders (read-only side).

**POST `/api/targets`** — body: a target object (all fields; `id` required). → 201 public target. 400; 409 duplicate id.
**PUT `/api/targets/{tid}`** — partial update, same password rules (also for each `extra_nodes[i].password`: an
omitted password for an existing node at the same `host:port` keeps the stored one). → 200. 404.
**DELETE `/api/targets/{tid}`** → 200 `{"deleted": true}`. 404; 409 if a mapping uses it.
**POST `/api/targets/{tid}/test`** — optional overriding body as above. SSH in, run `D info --format '{{json .Swarm}}'`
and `D version --format '{{.Server.Version}}'`. → 200
`{"ok": true, "message": "deploy@127.0.0.1:2223 · Docker 27.5.1 · swarm manager", "swarm_manager": true, "docker_version": "27.5.1", "host_key": "ssh-ed25519 SHA256:..."}`;
`ok` is false (with message) when SSH fails, docker fails, or the node is not an active manager
(`LocalNodeState != "active"` or `ControlAvailable != true`). Extra nodes are tested too; their failures are appended
to `message` and make `ok` false.

**PUT `/api/mappings/{package}`** — body: mapping fields except `package` (taken from the path). Upsert. `target` must
exist. Defaults: `moving_tag "latest"`, `health_url ""`, `create_if_missing false`,
`create {"replicas": 1, "publish": []}`. → 200 mapping. 400; 404 unknown target.
**DELETE `/api/mappings/{package}`** → 200 `{"deleted": true}`. 404.

**PUT `/api/config/options`** — partial. → 200 options. 400.

### 4.3 File server

**GET `/api/packages?path=/releases`** — `path` optional, default `file_server.remote_dir`. Lists one folder
(non-recursive). 400 if the file server is not configured or `path` is invalid; 502 `{"detail": "file server: <error>"}`
on connection/listing failure.
```json
{
  "path": "/releases",
  "dirs": ["archive", "web1"],
  "groups": [
    {"service": "sdtest-web1", "mapped": true, "packages": [
      {"name": "sdtest-web1_20261102_190005.zip", "path": "/releases/sdtest-web1_20261102_190005.zip",
       "ts": "20261102_190005", "created_at": "2026-11-02T19:00:05", "size": 4812345}
    ]}
  ],
  "other": ["notes.txt"]
}
```
- Groups sorted mapped first, then by newest package; packages in a group newest first by `ts` (from the name, not mtime).
- `mapped` = a mapping exists for that service. `other` = non-directory entries that are not package names.
- SFTP: `listdir_attr`. FTP/FTPS: `mlsd()`; on `error_perm` fall back to `nlst()` + `size()` per package
  (`size` null if unsupported). Hidden entries (`.` prefix) are ignored.

### 4.4 Services (live from targets)

**GET `/api/services`** → 200 array, one row per mapping, in mapping order. Targets are queried in parallel (one SSH
session per target, 15 s budget); a failing target fills `error` on its rows instead of failing the call.
```json
[{
  "package": "sdtest-web1", "target": "lab", "swarm_service": "sdtest_web1", "image_repo": "sdtest/web1",
  "exists": true, "current_image": "sdtest/web1:20261102_190005",
  "replicas_running": 1, "replicas_desired": 1, "update_state": "completed",
  "last_deploy": {"id": "...", "kind": "deploy", "status": "success", "version": "20261102_190005", "finished_at": "..."},
  "error": null
}]
```
Commands per service: `D service inspect --format '{{json .}}' <svc>` (missing → `exists: false`), then
`D service ps <svc> --filter desired-state=running --format '{{json .}}'`.
`current_image` = `Spec.TaskTemplate.ContainerSpec.Image` with any `@sha256:...` suffix removed.

**GET `/api/services/{package}`** → 200 the single row. 404 unknown mapping.

**GET `/api/services/{package}/backups`** → 200 array newest first, read from `<backup_dir>` on the mapping's target:
```json
[{"id": "sdtest_web1_20261102_190500", "created_at": "2026-11-02T19:05:00", "previous_image": "sdtest/web1:v1",
  "backup_tag": "sdtest/web1:backup-20261102_190500", "tag_present": true, "has_image_tar": false,
  "job_id": "...", "dir": "/home/deploy/sd-backups/sdtest_web1_20261102_190500"}]
```
Reads `meta.json` of every dir matching `^<swarm_service>_\d{8}_\d{6}$` (via SFTP), and checks
`D image inspect --format '{{.Id}}' <backup_tag>` for `tag_present`. 404 unknown mapping; 502 target unreachable.

### 4.5 Deploys

**POST `/api/deploys`** — start a deploy.
```json
{"package_path": "/releases/sdtest-web1_20261102_190005.zip", "password": "zip-secret", "save_image_tar": null}
```
- `package_path` validated as remote path (an `sftp|ftp|ftps://host[:port]/path` URL, as Build Packager reports
  `artifacts.remote_path`, is accepted when protocol/host/port match the configured file server; else 400); its basename must match the package-file regex. The service part selects
  the mapping; no mapping → 400 `package_path: no mapping for service <svc>`.
- `save_image_tar` null → `options.save_image_tar`.
- → 201 job (§5), status `running`. 409 `{"detail": "a deploy for sdtest_web1 on lab is already running"}`.
- Runs in a `threading.Thread`. Usable from scripts/CI (`curl -X POST ...`) exactly like the UI.

**POST `/api/rollbacks`** — manual rollback to a backup.
```json
{"package": "sdtest-web1", "backup_id": "sdtest_web1_20261102_190500"}
```
→ 201 job with `kind: "rollback"`. 404 unknown mapping; 400 bad id; 409 busy. (Backup existence is checked in the
job's `load` phase, so the request needs no SSH.)

**GET `/api/deploys?package=sdtest-web1`** → 200 jobs newest first; `package` optional filter (deploy history).
**GET `/api/deploys/{id}`** → 200 job. 404 (id must match `^[0-9a-f]{32}$`).
**GET `/api/deploys/{id}/log`** → 200 `text/plain`. 404.
**GET `/api/deploys/{id}/logs/stream`** → SSE (§7). 404.
**DELETE `/api/deploys/{id}`** → 200 `{"deleted": true}` (json + log + work dir). 404; 409 while running.

On startup, jobs still `queued`/`running` are recovered: phases that were `running` become `failed`, `pending` ones
`skipped` (except `cleanup`), and a background thread per job (holding the job's per-service lock, so new deploys of
that service get 409 meanwhile) reconnects to the target. If the job had reached `tag`, `deploy` or `verify` (and
`verify` had not succeeded) it runs the same tag restore + automatic rollback as a verify failure (§6.11, logged to
the job log). Then it runs `cleanup` (remote tar on all hosts + local temp). The job ends `failed` with
`error: "interrupted (server restart)"` plus `"; rolled back to <img>"`, `"; rollback failed: <err>"` or
`"; tags restored, service still runs <img>"`. Idempotent: the job stays `running` until recovery ends, so a second
restart recovers it again, and a service that no longer runs `new_image` is not rolled back twice.

## 5. Job JSON (`data/deploys/<id>.json` = API response)

```json
{
  "id": "32hex",
  "kind": "deploy",
  "ts": "20261102_190500",
  "package": "sdtest-web1",
  "package_path": "/releases/sdtest-web1_20261102_190005.zip",
  "version": "20261102_190005",
  "target": "lab",
  "target_label": "deploy@127.0.0.1:2223",
  "swarm_service": "sdtest_web1",
  "image_repo": "sdtest/web1",
  "mode": "update",
  "loaded_image": "sdtest-web1:20261102_190005",
  "new_image": "sdtest/web1:20261102_190005",
  "moving_image": "sdtest/web1:latest",
  "previous_image": "sdtest/web1:v1",
  "backup": {"id": "sdtest_web1_20261102_190500", "dir": "/home/deploy/sd-backups/sdtest_web1_20261102_190500",
             "tag": "sdtest/web1:backup-20261102_190500", "image_tar": false},
  "backup_id": null,
  "save_image_tar": false,
  "rollback": null,
  "status": "running",
  "error": null,
  "created_at": "2026-11-02T19:05:00",
  "finished_at": null,
  "phases": [
    {"name": "fetch", "status": "pending", "started_at": null, "finished_at": null, "message": ""}
  ],
  "artifacts": {"zip_size": 0, "tar_size": 0, "tar_sha256": null, "remote_tar": null, "nodes_loaded": []}
}
```
- `kind: "deploy"` phases, in order: `fetch, extract, connect, transfer, backup, load, tag, deploy, verify, cleanup`.
- `kind: "rollback"` phases: `connect, backup, load, deploy, verify`. For rollback: `backup_id` set, `version` =
  the backup's ts, `new_image` = the backup's `previous_image` tag when it still resolves to the backup tag's image
  id (re-created from the backup tag when missing), otherwise the backup tag, `package_path`/`loaded_image`/`moving_image` null except
  `moving_image` is still re-pointed (see §6.11).
- Phase `status`: `pending | running | success | failed | skipped`. `message` is one short line.
- `mode`: `update` | `create` (service missing and `create_if_missing`).
- `rollback` after a failed deploy/verify:
  `{"performed": true, "method": "swarm_auto | service_rollback | backup_tag | previous_image | removed_new_service", "to_image": "sdtest/web1:v1", "ok": true}`;
  `null` when no rollback was needed (failure before the service was touched).
- `error`: `"<phase>: <message>"`; when a rollback ran and succeeded it ends with `; rolled back to <to_image>`;
  when it failed: `; ROLLBACK FAILED: <reason>`.
- The job json is rewritten on every phase transition and when any top-level field changes.

**[patch 2026-11-03]** New job fields (`triggered_by`, `package_format`, `registry`, `moving_tag`, `previous_ref`,
`previous_digest`, `new_digest`, `deploy_image`, `pushed`, `load_tags`, `health_script`, `backup.digest`,
`artifacts.job_dir`): §11.5.

### Failure rule
The first failed phase stops the pipeline. Rollback (§6.11) runs if the failed phase is `deploy` or `verify`.
All later phases become `skipped` with message `skipped: earlier phase failed`, **except `cleanup`, which always
runs** (its own failure is logged and shown but does not change the job error if the job already failed; on an
otherwise successful job a cleanup failure fails the job). Job `success` iff every phase is `success` or `skipped`
and no phase failed.

## 6. Phases (exact behaviour)

**[patch 2026-11-03]** Registry mode, the job dir `W/<package>/<version>`, the backup dir `B/<svc>/<ts>/`, the
flat `build_tar.sh` layout, the health script, `prune_after` and the registry branch of §6.11 are specified in
§11.6. They override the matching text below; the phase lists stay 10 deploy / 5 rollback.

Notation: `q` = `shlex.quote`; `D` = `shlex.split(target.docker_cmd)` (argv prefix);
`run(argv)` = execute `" ".join(q(a) for a in argv) + " 2>&1"` (with a redirect: `+ " > " + q(file)` and stderr merged by
`set_combine_stderr`, so it never lands in the file) over the target's SSH session with
`exec_command(..., timeout)`, stream merged output line by line to the log, return `(exit_code, output)`.
Before each command the log gets `$ [<host>] <command string>`. Default timeout 60 s; `docker load`/`docker save`/
transfers 1800 s. A non-zero exit fails the phase unless stated otherwise.
`W` = `work_dir`, `B` = `backup_dir`, `svc` = mapping `swarm_service`, `repo` = mapping `image_repo`,
`tar_name` = `<package>_<version>.tar`, `RT` = `W/<tar_name>` (remote tar path, posixpath.join).

1. **fetch** — connect to the file server (Build Packager's `remote()` code, but download): SFTP `sftp.get` /
   FTP `retrbinary("RETR <name>")` after `cwd` to the folder. Saves to `data/work/<id>/<name>`. Progress every 10%.
   Fails if the file is missing. Message `downloaded <name> (<size>)`. Sets `artifacts.zip_size`.
2. **extract** — `pyzipper.AESZipFile(zip)`; `setpassword(password)`. Choose the member
   `<package>_<version>/<package>_<version>.tar`; if absent, the only member ending in `.tar` at depth ≤ 2; zero or
   several → fail `no image .tar found in zip` / `several .tar files in zip: ...`. Stream that one member
   (`zf.open(member)` + `shutil.copyfileobj`) to `data/work/<id>/<tar_name>` — never `extractall` (zip-slip safe).
   Wrong password → fail `wrong zip password` (catch `RuntimeError` "Bad password" and `zlib`/BadZip errors on read).
   Then `tarfile.open(tar)`: read `manifest.json`; it must be a list with ≥1 entry with non-empty `RepoTags`, else fail
   `not a docker image archive (manifest.json/RepoTags missing)`. All RepoTags together must be exactly
   `[<package.lower()>:<version>]` (`docker load` re-tags every RepoTag on the target, so an extra or foreign tag
   could clobber another service's image), else fail `archive must hold exactly one image tagged <x>, found: ...`.
   Compute sha256 and size. Delete the password reference. Message `image sdtest-web1:20261102_190005 · 52 MB`.
3. **connect** — SSH to the target (§3 policy), log `signed in to deploy@host:port`. Then:
   - `run(D + ["info", "--format", "{{json .Swarm}}"])` → JSON; fail `target is not a swarm manager` unless
     `LocalNodeState == "active"` and `ControlAvailable == true`.
   - `run(D + ["service", "inspect", "--format", "{{json .}}", svc])` (non-zero allowed): exists → `mode = "update"`,
     store `previous_image` (digest stripped). Missing → if `create_if_missing`: `mode = "create"`, else fail
     `swarm service <svc> not found on target (enable "create if missing" in the mapping to create it)`.
   - `run(["mkdir", "-p", "--", W])`.
   - Rollback jobs: skip `mkdir`; service must exist.
   - Extra nodes: SSH to each now; failure fails this phase (`node <host>:<port>: <error>`).
   Message `deploy@127.0.0.1:2223 · service sdtest_web1 running sdtest/web1:v1`.
4. **transfer** — `sftp.put(local_tar, RT)` with progress every 10%, then
   `run(["sha256sum", "--", RT])` → first field must equal the local sha256, else fail `checksum mismatch`.
   Same for each extra node (its own `W`, same path string). Sets `artifacts.remote_tar`.
5. **backup** — skipped with `skipped: no running service to back up` when `mode == "create"`. Otherwise
   `bid = <svc>_<job ts>`, `BD = B/<bid>`, `btag = <repo>:backup-<job ts>`:
   - `run(["mkdir", "-p", "--", BD])`
   - `" ".join(q(a) for a in D + ["service", "inspect", svc]) + " > " + q(BD + "/service.json")` (the one redirect)
   - `run(D + ["image", "inspect", "--format", "{{.Id}}", previous_image])` — if non-zero (image not on the
     manager), log `WARNING: current image not present locally; backup tag skipped` and set `backup.tag = null`.
   - else `run(D + ["tag", previous_image, btag])`.
   - if `save_image_tar` and the tag exists: `run(D + ["save", "-o", BD + "/image.tar", btag])` (timeout 1800).
   - write `BD/meta.json` via SFTP: `{id, swarm_service, package, previous_image, backup_tag, has_image_tar, created_at, job_id}`.
   - **Prune**: list `B` via SFTP, keep dirs matching `^<svc>_\d{8}_\d{6}$`, sort by name descending, for every dir
     beyond `keep_backups`: read its `meta.json`; if its `backup_tag` is not the service's current image, run
     `run(D + ["rmi", backup_tag])` (non-zero allowed, logged) and `run(["rm", "-rf", "--", dir])`.
     Log `pruned backup <id>` per removed dir.
   - Sets `job.backup`. Message `backup sdtest/web1:backup-20261102_190500 (spec + tag), pruned 1`.
6. **load** — deploy: `run(D + ["load", "-i", RT])` (timeout 1800); parse `Loaded image: <ref>` lines; the job's
   `loaded_image` must be among them (or confirmed by `run(D + ["image", "inspect", "--format", "{{.Id}}", loaded_image])`).
   Same on each extra node; append to `artifacts.nodes_loaded` as `"host:port"`.
   Rollback: check `btag = meta.backup_tag` with `image inspect`; if missing and `BD/image.tar` exists:
   `run(D + ["load", "-i", BD + "/image.tar"])`; if still missing → fail `backup image <btag> not available`.
   Missing backup dir/meta → fail `backup <id> not found`.
7. **tag** — `new_image = <repo>:<version>`; `run(D + ["tag", loaded_image, new_image])`; if `moving_tag`:
   `moving_image = <repo>:<moving_tag>`, `run(D + ["tag", loaded_image, moving_image])`. Same on extra nodes.
   Message `sdtest-web1:20261102_190005 → sdtest/web1:20261102_190005, sdtest/web1:latest`.
8. **deploy** —
   - `mode == "update"`: `argv = D + ["service", "update", "--image", new_image, "--no-resolve-image",
     "--update-failure-action", "rollback", "--update-monitor", f"{update_monitor}s", "--detach=true"]`;
     add `"--force"` when `previous_image == new_image` (redeploy of the same version); finally append `svc`.
   - `mode == "create"`: `D + ["service", "create", "--name", svc, "--replicas", str(replicas)]` +
     for each publish `"--publish", f"published={p},target={t},mode=host"` +
     `["--no-resolve-image", "--update-failure-action", "rollback", "--detach=true", new_image]`.
   - Rollback job: update with `new_image = btag`, same flags, `--force` if equal.
   - The command touches **only** `svc`. Message `service sdtest_web1 updating to sdtest/web1:20261102_190005`.
9. **verify** — every 2 s until `converge_timeout`:
   - `run(D + ["service", "inspect", "--format", "{{json .UpdateStatus}}", svc])` → `state` (`null` → treat as
     `completed` once tasks match; this is the case for `create`).
   - `run(D + ["service", "ps", svc, "--filter", "desired-state=running", "--format", "{{json .}}"])` and desired
     replicas from `{{json .Spec.Mode}}`.
   - Log a one-line summary only when it changes: `update_state=updating running=0/1 (new image 0)`.
   - `state in ("rollback_started", "rollback_paused", "rollback_completed")` → swarm rolled back by itself →
     failure `swarm rejected the update (<UpdateStatus.Message>)`, rollback method `swarm_auto`.
   - `state == "paused"` → failure `update paused: <Message>`.
   - Success condition: `state` is `completed`/null and running tasks == desired and every running task's `Image`
     equals `new_image` (digest stripped). Then, if `health_url`: on the target run
     `run(["wget", "-q", "-O", "/dev/null", "-T", "5", health_url])` every 2 s until exit 0 or `health_timeout`
     → failure `health check failed: <url>`.
   - Timeout → failure `not converged after <n>s (running a/b with new image)`.
   - Message on success `1/1 tasks running sdtest/web1:20261102_190005 · health OK`.
10. **cleanup** — (deploy only, always runs) `run(["rm", "-f", "--", RT])` on the target and each extra node if
    connected (errors logged); `shutil.rmtree(data/work/<id>)`; close SSH/SFTP. Backups are kept.
    Message `removed remote tar and local temp files` (`removed local temp files` when no remote tar was uploaded).

### 6.11 Rollback semantics (automatic, after a failed `deploy` or `verify`)
Only when the service was touched (`deploy` command returned 0, or it failed but the service's spec image now equals
`new_image`). Steps, each logged under `==> [rollback] ...` inside the failed phase:
1. `mode == "create"` → `run(D + ["service", "rm", svc])`, method `removed_new_service`, `to_image: null`.
2. If verify saw `swarm_auto`: wait (same polling, `converge_timeout`) until `rollback_completed` and tasks run
   `previous_image`. Method `swarm_auto`.
3. Otherwise `run(D + ["service", "rollback", "--detach=true", svc])`, then wait until tasks run `previous_image`.
   Method `service_rollback`.
4. If 3 fails or does not converge: the first of `backup.tag`, `previous_image` that `docker image inspect` finds on
   the target: `service update --image <it> --no-resolve-image --force --detach=true svc`, wait. Method `backup_tag`
   or `previous_image` (the backup tag may have been removed outside the app).
5. If `moving_tag` is set and `previous_image` exists locally: `run(D + ["tag", previous_image, moving_image])` so the
   moving tag points at what is running again (same on extra nodes).
`rollback.ok` = tasks converged on the old image. The job is always `failed` after an automatic rollback.

A manual rollback job whose own `verify` fails uses step 3 (back to what ran before the rollback job).

### Log format
Same as Build Packager §5: `[HH:MM:SS] <text>`; `==> [phase] started` / `==> [phase] success|failed|skipped: <message>`;
`$ [host] <cmd>` before every remote command; remote output lines as they arrive; last line `==> JOB SUCCESS` or
`==> JOB FAILED: <error>`. Lines never contain `\n` (split on newlines, strip `\r`). Secrets masked (§0.3).

## 7. SSE `GET /api/deploys/{id}/logs/stream`
Identical to Build Packager §6: events `log` (one line), `status` (full job json, once after replay and on every
change), `end` (`{"status": "success" | "failed"}`, then close). Replays the whole log first; polls ~0.3 s;
`: ping` every 15 s. Finished job → replay, status, end, close.

## 8. UX

**[patch 2026-11-03]** The SD screens added for this release (login `#/login`, TopBar account menu, Settings
GitLab / Import `.env` / SMB / registry / `@current` / prune rows, live package watch, format (2) rows, run-view
`#run-by` / `#run-images` / `#res-digest`) are specified in the UI addendum `design/UI_ADDENDUM.md` §2 and §5–§8
(2026-11-03); its ids and texts are the contract for the UI tests.

Share Build Packager's look through `../shared-ui` (`@devtools/ui`): its `:root` tokens (light + dark), base styles, button / field /
password field / status pill / step icon / toast / dialog / menu / skeleton / inline alert components, the app shell,
the wizard frame and stepper, the run view (pipeline stepper, log console, result card) and the `api()` helper.
Logo glyph: same 20px accent box with an up-arrow glyph; name "Swarm Deployer". Title format
`"<Screen> — Swarm Deployer"`, status prefix `● / ✓ / ✗ <package>` on run views. One primary button per screen.

### Hard UI constraints (checked by tests as text)
- React + TypeScript source in `frontend/src` + `../shared-ui/src` (tests scan the source, not the minified bundle):
  no CDN, no webfonts, no external resource at all.
- The literal `innerHTML` never appears (including comments and `dangerouslySetInnerHTML`). React renders text only.
- Contains `EventSource`, `addEventListener('end'` and `es.close()` (the kit's `useEventSource`).
- Every `'/api/...'` literal is a real route from §4; ids are concatenated (`'/api/deploys/' + id + '/logs/stream'`).
- The zip password and SSH/FTP passwords live only in input `.value` / JS variables: never in `localStorage`,
  `sessionStorage`, URL, hash or toasts. Password inputs are cleared after submit, Cancel and route exit.
- Allowed storage: `sessionStorage['sd.draft']` = `{package_path, package, path}` and `sessionStorage['sd.return']`.

### Routes

| Hash | Screen |
|---|---|
| `#/dashboard` | Services + recent deploys (default) |
| `#/services/<package>` | Service detail: current state, deploy history, backups + rollback |
| `#/new/package` | Wizard 1 · Package |
| `#/new/password` | Wizard 2 · Password (guard: no `package_path` → step 1) |
| `#/new/target` | Wizard 3 · Target (guard: no password in memory → step 2, with the note "For safety, the password isn't kept after a reload. Enter it again.") |
| `#/new/review` | Wizard 4 · Review (same guard) |
| `#/deploys/<32hex>` | Run view (deploy or rollback) |
| `#/settings` | File server, target servers, service mappings, options |
| unknown | → `#/dashboard` |

No sign-in screen (local single-user tool). App shell top bar: logo · "Settings" ghost link. On `#/new/*` only `Cancel`.

### 8.1 Dashboard
- h1 "Deployments", primary `+ New deploy`.
- **Setup checklist** replaces everything when setup is incomplete:
  "Get ready to deploy" — ① Connect the file server ② Add a target server ③ Map a service — each a row with a done
  check or a link to `#/settings` (section anchor). Done = file_server.host set / ≥1 target / ≥1 mapping.
- Stat tiles (client-computed from `GET /api/deploys`): Total deploys · Succeeded · Failed · Last deploy.
- **Services** list (`GET /api/services`, skeleton while loading): one row per mapping, `<a href="#/services/<package>">`:
  - Line 1: status dot of last deploy, `package` 14/500, `→ swarm_service @ target` muted mono, right: current
    version (`current_image` tag) in mono.
  - Line 2 muted: `1/1 running · sdtest/web1:20261102_190005 · last deploy ✓ 3 min ago`; missing service:
    `Not found on target` in `--warning`; target error: `Target unreachable: <error>` in `--danger`.
  - `⋯` menu: Deploy new version (wizard with the service filter preset), Backups & rollback, History.
- **Recent deploys**: rows like Build Packager's (icon, package, `version → swarm_service`, duration, relative time;
  line 2 `Running · Load image (6/10)` / `Succeeded · sdtest/web1:…` / `Failed at Verify · … · rolled back to …`).
  Rollback jobs show a `Rollback` micro badge.
- Poll `GET /api/deploys` every 3 s while any job runs; finish toast "<package> deployed" / "<package> deploy failed".

### 8.2 Wizard (4 steps; stepper labels Package · Password · Target · Review)
Same frame, footer, keyboard and validation rules as Build Packager UX §4.3. Primary labels "Next: Password",
"Next: Target", "Next: Review", "Deploy". Cancel with a dirty draft → dialog "Discard this deploy? Nothing has been
changed on the server." [Keep editing] [Discard].

1. **`#/new/package` — "Choose a package"** (subtitle: "Packages on <protocol>://<host><path>").
   Path breadcrumb with clickable segments + `dirs` as folder rows (FileZilla-like navigation), `Refresh` ghost button.
   Groups by service (heading = service, `Not mapped` warning badge if `mapped` false), radio rows:
   `20261102 19:00:05 · 4.8 MB · 3 min ago` (newest first, mapped groups first then newest group first; the newest row of each group has a
   `Latest` badge). Error state: inline alert "Couldn't list the file server. <detail>" + [Retry] + link to Settings.
   Empty: "No packages in <path>. Build Packager uploads <service>_<timestamp>.zip files here."
   Validation: "Choose a package to deploy."
2. **`#/new/password` — "Unlock the package"** (subtitle: package name mono + Change). One password field with eye,
   label "Zip password", helper "The password you set in Build Packager. It's used once and never saved."
   Validation: "Enter the zip password." (wrong password is reported by the extract phase).
3. **`#/new/target` — "Where it goes"**. Shows the mapping card: Target `Lab swarm · deploy@127.0.0.1:2223`,
   Swarm service `sdtest_web1`, Image `sdtest/web1:<version>` + `:latest`, Health check URL or "None". Below, live
   from `GET /api/services/{package}`: "Now running sdtest/web1:v1 · 1/1 tasks" or warning "sdtest_web1 is not on
   the target" (+ "It will be created" if `create_if_missing`, otherwise Next is blocked with that error).
   Checkbox "Also save the current image as a .tar backup" (default `options.save_image_tar`).
   No mapping → inline mapping form (target select, swarm service, image repo, moving tag, health URL) with
   "Save mapping" (PUT `/api/mappings/...`), then the card shows.
4. **`#/new/review` — "Review and deploy"**: definition list — Package · Image `sdtest-web1:… → sdtest/web1:… + :latest`
   · Service `sdtest_web1 on Lab swarm` · Backup "Current image sdtest/web1:v1 will be tagged
   sdtest/web1:backup-<when started> (+ .tar)" · On failure "Automatic rollback to sdtest/web1:v1". Each with an
   Edit link. Primary "Deploy" → `POST /api/deploys` → clear password → `#/deploys/<id>`. 409 → inline alert.

### 8.3 Run view `#/deploys/<id>`
Build Packager UX §4.4 layout. Header: h1 package (or "Rollback · package"), pill, meta line
`version · swarm_service @ target_label · started 19:05 · 1:12`. Phase labels:

| phase | label | failure hint |
|---|---|---|
| fetch | Download package | Check the file server in Settings and that the file still exists. |
| extract | Unlock and check image | Check the zip password. The package must come from Build Packager. |
| connect | Sign in to target | Test the target in Settings. It must be a swarm manager. |
| transfer | Upload image to target | Check free disk space in the work dir on the target. |
| backup | Back up current version | Check the backup dir permissions on the target. |
| load | Load image | See the docker load output in the log. |
| tag | Tag image | See the log. |
| deploy | Update service | See the docker service update output in the log. |
| verify | Verify rollout | The new version did not become healthy. |
| cleanup | Clean up | Leftover files may remain in the work dir. |

Result card: success "✓ Deployed sdtest/web1:20261102_190005 in 1m 12s", lines "Service sdtest_web1 · 1/1 running",
"Backup sdtest/web1:backup-…", buttons [Back to dashboard] (primary) · Service details.
Failure "✗ Deploy failed at Verify rollout", `job.error` mono danger, rollback line
"Rolled back to sdtest/web1:v1 ✓" (or "Rollback failed — check the service on the target" in danger), hint,
buttons [Try again] (primary → wizard step 2 with the same package) · Show in log · Back to dashboard.
Rollback jobs: "✓ Rolled back sdtest_web1 to sdtest/web1:backup-…".

### 8.4 Service detail `#/services/<package>`
h1 package, meta `swarm_service @ target · image_repo`. Card "Running now": current image, replicas, update state.
Primary `Deploy new version`. Section "Backups" (GET backups): rows `created · previous_image · backup tag
(missing tag → "image gone" faint, unless has_image_tar)`, each with a secondary `Roll back` → dialog
"Roll back sdtest_web1? The service will run sdtest/web1:v1 (backup from <time>). A new backup of the current
version is made first." [Cancel] [Roll back] (danger) → `POST /api/rollbacks` → run view. Section "History":
`GET /api/deploys?package=` rows as on the dashboard.

### 8.5 Settings `#/settings`
Four cards with anchors `#/settings` sections (`file-server`, `targets`, `mappings`, `options`), each with its own
Save and inline result:
- **File server**: protocol (SFTP/FTP/FTPS, port default swap), host, port, username, password ("(saved)"
  placeholder), private key path (SFTP), remote folder; [Test connection] [Save]. FTP warning
  "FTP sends the password unencrypted."
- **Target servers**: list; Add/Edit form: id, name, host, port, username, password, key path, host key policy
  (select; `auto_add` shows warning "Accepts any host key the first time. Fine for a lab, use 'reject' with
  known_hosts in production."), docker command, work dir, backup dir, extra nodes rows (+ Add node);
  [Test] per target shows `ok` message incl. "swarm manager". Delete → dialog; 409 shown inline.
- **Service mappings**: table package → target / swarm service / image repo / moving tag / health URL /
  create-if-missing (+ replicas, publish); Add, Edit, Delete.
- **Backup & deploy options**: keep backups, save image tar by default, converge timeout, update monitor,
  health timeout.

Accessibility/responsive: as Build Packager UX §5–6 (375px, focus to h1 on route change, aria-live announcer
"Verify rollout failed", "Deploy succeeded").

## 9. Acceptance criteria

Setup and security
- **AC-1** `./run.sh` on a clean checkout creates `.venv` and serves `http://127.0.0.1:8095/` (200 HTML); `ss -ltn`
  shows `127.0.0.1:8095` only. A request with `Host: evil.com` gets 400.
- **AC-2** `data/config.json` is mode 600 after any settings write. `GET /api/config` never contains any stored
  password (grep for each lab password over all API responses = 0 hits); it shows `has_password: true`.
- **AC-3** `app.py` contains no `import subprocess`, no `os.system`, no `shell=True`; every `exec_command` call
  receives a string produced by the single quoting helper (grep-checked). Host containers/services not prefixed
  `sdtest` are unchanged before vs after the whole test run (`docker ps -a --format '{{.Names}} {{.Image}} {{.Status}}'` diff, ignoring uptime).
- **AC-4** Validation 400s: mapping `swarm_service` `"x;rm -rf /"`, `image_repo` `"Bad/Repo"`, `moving_tag`
  `"backup-1"`, `work_dir` `"rel/dir"` and `"/a/../b"`, `docker_cmd` `"bash -c"`, `package_path` basename `"x.zip"`,
  empty deploy password, `health_url` `"file:///etc/passwd"`, `publish` `"80"`.
- **AC-5** Quoting: a target whose `work_dir` and `backup_dir` contain a space and a `$` (`/home/deploy/sd work $X`)
  deploys successfully; the files are created under that literal path on the target.

Settings and listing
- **AC-6** File-server test returns ok against the lab SFTP and FTP servers and `{"ok": false}` within 20 s for a
  closed port. Target test returns ok + `swarm_manager: true` for `sdtest-target`, and ok false with message
  "not a swarm manager" against `sdtest-node2` used as a target.
- **AC-7** `GET /api/packages` on the lab lists the seeded zips grouped by service, newest first, `mapped` correct,
  `dirs` lists subfolders, `other` lists `README.txt`. Works identically for SFTP and FTP.
- **AC-8** `GET /api/services` shows `sdtest_web1` and `sdtest_web2` with `current_image` `sdtest/web1:v1` /
  `sdtest/web2:v1`, `1/1` running; a mapping for a non-existent swarm service shows `exists: false`.

Deploy pipeline (lab, SFTP file server)
- **AC-9 happy path** Deploying the web1 `v2` package → job `success`, 10 phases `success`; `curl 127.0.0.1:18081/version`
  returns `web1 v2`; on the target `sdtest/web1:<version>`, `sdtest/web1:latest` (same image id) and
  `sdtest/web1:backup-<job ts>` (image id of v1) exist; `<backup_dir>/sdtest_web1_<job ts>/service.json` is valid JSON
  of the old spec and `meta.json` has `previous_image: sdtest/web1:v1`; the remote tar is gone; `data/work/<id>` is gone.
- **AC-10 exact container** During AC-9, `sdtest_web2` keeps the same image and the same task ids before and after.
- **AC-11 wrong password** → `extract` failed `wrong zip password`; connect..verify `skipped`; cleanup `success`;
  nothing created on the target (no new backup dir, no tar in work dir, service unchanged).
- **AC-12 not a docker tar** (seeded `sdtest-bad` package) → extract failed with `not a docker image archive`.
- **AC-13 missing service** mapping to `sdtest_missing` without create → connect failed `... not found on target`;
  with `create_if_missing` and `publish ["8083:8080"]` → `mode: create`, backup skipped, service created and running.
- **AC-14 broken version** (container exits) → verify failed, `rollback.method` `swarm_auto` or `service_rollback`,
  `rollback.ok` true, error ends with `rolled back to sdtest/web1:<previous>`; `/version` serves the previous version;
  `sdtest/web1:latest` points at the previous image again.
- **AC-15 unhealthy version** (HEALTHCHECK fails / health URL fails) → same as AC-14.
- **AC-16 redeploy same version** → `--force` appears in the deploy command and the job succeeds.
- **AC-17 backups pruned** with `keep_backups: 2` after 3 successful deploys only the 2 newest backup dirs remain
  and pruned backup tags are removed (except a tag in use).
- **AC-18 save_image_tar** true → `image.tar` exists in the backup dir and `has_image_tar` true in the backups list.
- **AC-19 manual rollback** to the AC-9 backup → rollback job `success` (phases connect, backup, load, deploy,
  verify), `/version` returns `web1 v1`, a new backup of v2 exists; after `docker rmi` of the backup tag on the target
  and with `image.tar` present, the rollback still succeeds by loading the tar.
- **AC-20 concurrency** a second `POST /api/deploys` for the same service while one runs → 409; a deploy of web2 in
  parallel is accepted and both succeed.
- **AC-21 extra node** with `sdtest-node2` in `extra_nodes`: after deploy `docker image inspect sdtest/web1:<version>`
  succeeds inside `sdtest-node2`; its remote tar is removed.
- **AC-22 FTP file server** the AC-9 flow works with `protocol: ftp` against the lab pyftpdlib server.

Logs, SSE, secrets
- **AC-23** `curl -N .../logs/stream` shows live `log` events, `status` events with changing phase statuses, then
  `end` and close; a finished job replays everything then `status` + `end`.
- **AC-24** The log has `==> [phase] started` and a result line for every phase reached, `$ [127.0.0.1] docker ...`
  lines with quoted args, the `docker load` output, and the final `==> JOB SUCCESS|FAILED`.
- **AC-25** The zip password appears nowhere in `data/` (recursive grep); stored passwords appear in `data/` only in
  `config.json` (mode 600, see §3). Neither appears in any API response or in SSE output.
- **AC-26** After a server kill + restart during verify, the job ends `failed` with
  `interrupted (server restart); rolled back to <img>`, the service serves the previous version, the remote tar is
  gone on all hosts, and the service is busy (409) until recovery ends (`tests/full_chain_test.py` phase H).

UI (Playwright, `tests/ui_test.py`)
- **AC-27** Fresh data dir → dashboard shows the setup checklist; filling Settings (file server, target, mappings) with
  Test buttons showing ok makes the checklist disappear and the services list appear with `v1`.
- **AC-28** Wizard: pick the web1 v2 package (newest-first, grouped), enter password, target card shows "Now running
  sdtest/web1:v1", review shows the tag transition, Deploy → run view with 10 phases turning green live, result card
  "Deployed sdtest/web1:…"; dashboard row shows the new version.
- **AC-29** Broken package via the wizard → result card "Deploy failed at Verify rollout" + "Rolled back to …".
- **AC-30** Service detail → Backups → Roll back → dialog → run view succeeds; history lists all jobs for the service.
- **AC-31** Static checks: no `innerHTML`, has `EventSource` / `addEventListener('end'` / `es.close()`, every `'/api/`
  literal is a §4 route, no `localStorage` write of a password; a log line `<b>x</b>` renders as text; no horizontal
  scroll at 375px; no console errors.

Full chain (Build Packager → file server → Swarm Deployer → swarm), `tests/full_chain_test.py`
- **AC-32** A scratch **copy** of Build Packager (its `app.py` + `frontend/dist/` + `.venv`, own `data/`, port 18090) builds
  `mock-web1` branch `v2` (repo `file://…/repos/mock-web1`, service `sdtest-web1`), zips with a password and uploads
  over SFTP to `sdtest-files:/releases`; Swarm Deployer lists that exact zip as the newest `sdtest-web1` package,
  deploys it with the same password, and `127.0.0.1:18081/version` returns `web1 v2`. The image on the target is
  tagged `sdtest/web1:<Build Packager ts>` and `:latest`.
- **AC-33** Same chain with branch `broken` ends `failed` with automatic rollback, the service still serves `web1 v2`.
- **AC-34** Same chain for `mock-web2` (service `sdtest-web2`, nginx-based) succeeds and does not change `sdtest_web1`.
- **AC-35** Build Packager's own tests (`tests/e2e_test.py`, `tests/ui_test.py`) still pass unchanged.


**[patch 2026-11-03]** GitLab sign-in, SMB, registry, health script, `.env` setup (§11):

- **AC-36** Unauthenticated `/api/*` gets 401, but not `/api/auth/*`. A PAT sign-in or OAuth+PKCE sign-in unlocks it. Logout, or a rejected refresh, locks it again. No token, client secret or refresh token appears in any API response or log. A token is only used for the GitLab URL it was issued for.
- **AC-37** The SMB file server lists, tests and downloads. A package uploaded by Build Packager over SMB deploys.
- **AC-38** The package list returns `modified_at`/`format`. A zip copied into the folder appears on the next poll.
- **AC-39** A `<name>.tar.zip` ZipCrypto flat zip and a `<name>.zip` AES flat zip deploy (version = name ts, else job ts). A flat archive must hold exactly one image (several tags of it are fine); its load-time tags are put back in cleanup.
- **AC-40** The job dir `W/<pkg>/<version>` is created and removed. The backup dir `B/<svc>/<ts>/` holds `service.json`, `image.txt`, `image.tar` and `meta.json`.
- **AC-41** Registry mode: login via stdin, push of `:<version>`, `service update --with-registry-auth --image <repo>:<moving>@<digest>`, and the moving tag pushed only after verify passed (AD-7). The registry tag digest equals the job's `new_digest` and the service spec digest. **Deviation (AD-1, needs sign-off): `@current` is the default moving tag only in registry mode; other mappings default to `latest`.**
- **AC-42** `.deploy/healthcheck.sh` runs with `--url`/`--service` (bounded by `timeout`). A non-zero exit leads to rollback: the service goes back to the previous digest and the registry moving tag still (or again) holds the previous digest. A package with a health script and no `health_url` fails before the target is touched.
- **AC-43** Restart recovery in registry mode restores both, also when the registry login fails.
- **AC-44** `.env` import at startup, Import .env, and Import from GitLab project set config, return names only, and write the SSH key mode 600. CRLF is handled; hidden GitLab variables are reported in `errors`; a GitLab import never sets `GITLAB_*`, host-key policy or docker command.
- **AC-45** `triggered_by` is the GitLab username, or `auto`.
- **AC-46** `prune_after` runs `docker system prune -f` only after a successful deploy.
- **AC-47** Auto-deploy works over SMB, including a format (2) file overwritten in place; a file still growing waits one interval; an unmapped format (2) zip never starts a job.

## 10. deploy.yml and auto-deploy (2026-11-03)

### 10.1 deploy.yml
- Build Packager: after `clone`, a root `deploy.yml` (or `deploy.yaml`, not both) is parsed with yaml.safe_load and
  validated (`check_manifest`): keys ⊆ {service, image, target, health_url, moving_tag}, all strings; `service`
  matches the swarm service name rule; `image` is a lowercase docker repo; `target` is a target id; `health_url` is
  http(s); `moving_tag` is a docker tag. Invalid → `clone` fails with `deploy.yml: <reason>`. Valid → copied to
  `<folder>/deploy.yml` (so the zip holds `<service>_<ts>/deploy.yml`), job field `deploy_manifest`. Missing → logged.
- Swarm Deployer, `extract` phase: reads `<service>_<ts>/deploy.yml` from the zip (≤ 64 KB) with the same rules,
  then `resolve()` (before `connect`):
  1. deploy.yml present → service must be in `options.allowed_services`; target = deploy.yml target, else the
     mapping's, else the only configured target; the image repo must not belong to a Settings mapping or a
     successful deploy.yml deploy of another service/target. These give the job's swarm_service, image_repo,
     new_image, moving_image, health_url; `mapping_source = "deploy.yml"`. `create_if_missing` is always false: a
     missing service fails `connect` ("deploy.yml names swarm service X, which does not exist on target").
  2. no deploy.yml → the Settings mapping (`mapping_source = "settings"`), else fail "no deploy.yml in the package and
     no Settings mapping for <package>".
  The per-service lock is re-keyed to the resolved service (409-style failure if that service is busy).
- `POST /api/deploys` accepts a package without a mapping only when `allowed_services` is non-empty (else 400).
- `PUT /api/config/options` accepts `allowed_services: [names]`. `GET /api/packages` groups get `deployable`.
- `/api/services` also lists packages known only from a successful deploy.yml deploy (`source: "deploy.yml"`); their
  backups and rollbacks work as for mapped ones.
- Job fields added: `trigger` ("manual" | "auto"), `mapping_source` (null until resolved), `health_url`.

### 10.2 Auto-deploy
- Config `auto = {enabled, interval (15-86400 s), password, prefix}`; `PUT /api/config/auto` (blank password keeps the
  saved one, `clear_password: true` clears it; enabling needs a password). Turning it on lists the file server and
  records each package's newest version as handled (baseline).
- A daemon thread polls every `interval`: for each package (name starts with `prefix`) in `file_server.remote_dir`
  whose newest zip is newer than `auto_state.last_ts[package]`, it calls the same `start_deploy` as the API with
  `trigger="auto"`. 409 (busy) → retried next tick; otherwise the version is recorded as handled whether the job is
  later successful or not (no retry loop). State: `data/auto_state.json`.
- `GET /api/auto/status` → `{enabled, interval, prefix, has_password, last_poll, last_error, last_versions,
  processed: [{package, version, path, at, job_id, status, error}]}` (newest first, ≤ 50). Never the password.

## 11. GitLab sign-in, SMB, registry, health script, .env setup (2026-11-03)

### 11.0 Architect decisions (refinements, not reversals)

| id | decision | why |
|---|---|---|
| AD-1 | `@current` is the **default** `moving_tag` only when registry mode applies (AD-2: the target has `registry.url` **and** `image_repo` starts with `registry.url + "/"`); otherwise the default stays `latest`. `@current` may always be set explicitly. **This narrows D8's literal wording; it is stated in the README and in the AC table (AC-41) and needs the user's sign-off.** | Without a registry the lab services run fixed tags (`sdtest/web1:v1`). `@current` would re-tag `v1` locally, and `seed.sh --reset` would then recreate the service from the wrong image. The user's flow (`:dev` on a registry) gets `@current` by default. |
| AD-2 | Registry mode applies **per job**: the target has `registry.url` **and** the job's `image_repo` starts with `registry.url + "/"`. Any other case uses today's local-load behaviour. | One target can serve both kinds of service, and a repo without a registry host prefix is never pushed by accident (it would go to Docker Hub). |
| AD-3 | Remote work dir `<ts>` = the job's `version`: the package timestamp for format (1), the job ts for format (2). | Tests can predict the path; it is unique per version and per service lock. |
| AD-4 | Signed in = a GitLab token is stored. The 401 gate does not call GitLab on each request. The token is refreshed when a GitLab API call needs it. | The tool must keep deploying when GitLab is down. Single local user, same as the Build Packager GitHub token. |
| AD-5 | Backups use the new layout `B/<svc>/<ts>/`. Legacy flat `B/<svc>_<ts>/` dirs are still listed and can be rolled back to, but are never pruned. | No data loss for existing users. |
| AD-6 | Prune never deletes tags in the registry, only local dirs and tags. | Deleting a manifest by digest would also delete `:dev` when it shares that digest. |
| AD-7 | Registry order: `tag` pushes only `<repo>:<ts>`; the service is updated to `<repo>:<moving>@<new digest>` (the swarm pulls by digest, whatever the registry's `:<moving>` points at); the registry `:<moving>` is pushed **last, in `verify`, after every check passed** (deploy and rollback jobs). | The registry moving tag then only ever holds a verified image. A failure or a server kill before that point leaves it untouched, so rollback and recovery don't need to write to the registry; D10's "re-tag + push" only runs for the narrow window where the moving push itself started (§6.11 `registry_repair`). Same outcome as D8/D10, safer order. |
| AD-8 | The 401 gate is a UX gate for a single local user, not a security boundary against other local processes. | No cookies or sessions by design (D1). §11.2 still blocks the cheap abuses (URL swap while signed in). |

### 11.1 Config **[patch §3]**

```python
DEFAULTS = {
  "file_server": {..., "share": "", "domain": ""},                    # SMB fields (D4)
  "options": {..., "save_image_tar": True, "prune_after": False},     # D7 tar on by default, D10 prune option
  "gitlab": {"url": "", "client_id": "", "client_secret": "", "token": "", "refresh_token": "",
             "expires_at": None, "username": "", "avatar_url": "", "method": "", "redirect_uri": "",
             "token_url": ""},                                        # gl_base() the token was issued for
  "env_import": {"sha": "", "at": None, "set": []},
  ...
}
TARGET_DEFAULTS = {..., "registry": {"url": "", "username": "", "password": ""}}
```
- `load_config()` also merges `gitlab` and `env_import` (dict.update like `auto`). Targets that were saved without a
  `registry` key read as `{"url": "", "username": "", "password": ""}` (use `t.get("registry") or {...}`).
  The `save_image_tar: True` default only reaches configs that never saved `options.save_image_tar`.
- `public()` treats `SECRET_KEYS = ("password", "token", "refresh_token", "client_secret")` the same way: each is
  dropped and `has_<key>: bool` is added. The existing name `has_password` stays.
- Effective GitLab values:
  - `gl_base(cfg)` is `cfg.gitlab.url or os.environ["GITLAB_URL"] or "http://192.168.33.175"`, with the trailing `/`
    stripped.
  - `gl_client(cfg)` is `(cfg.gitlab.client_id or env GITLAB_CLIENT_ID, cfg.gitlab.client_secret or env GITLAB_CLIENT_SECRET)`.
  - `oauth_available` is `bool(client_id)`.
  - `signed_in(cfg)` is `bool(cfg.gitlab.token) and cfg.gitlab.token_url == gl_base(cfg)`. **Every** place that
    asks "signed in?" (gate, status, `gl_token()`) uses it, so a token is never sent to, or accepted for, a GitLab
    URL other than the one it was issued for (a URL changed by `.env`, Settings or the environment signs the user
    out). Every code path that stores a token also stores `token_url = gl_base(cfg)` (after applying any URL in
    the same request/import).
- `GET /api/config` returns `gitlab` as `public(cfg.gitlab)` with `url` replaced by `gl_base(cfg)`, `client_id`
  by the effective id, plus `client_id_source: "settings" | "env" | null`, so the Settings card shows values that
  come from the environment.
- New paths: `DATA/keys/` (mode 700) holds the SSH keys imported from `.env` as `DATA/keys/<target id>` (mode 600).

#### Validation **[patch §2]** (new rows)

| Field | Rule |
|---|---|
| `file_server.protocol` | `sftp` \| `ftp` \| `ftps` \| `smb` |
| `file_server.share` | required when `protocol == "smb"` and `host` set: `^[A-Za-z0-9][A-Za-z0-9 _.$-]{0,79}$`; else `""` allowed |
| `file_server.domain` | `""` or `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` |
| `targets[].registry.url` | `""` or `^[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?$` (host[:port], no scheme, no path), ≤ 253 |
| `targets[].registry.username` | required if url set: `^[A-Za-z0-9_.@+-]{1,128}$` (GitLab deploy tokens have `+`) |
| `targets[].registry.password` | `v_str` ≤ 1024; omitted keeps the stored one, `""` clears it (same rule as `password`) |
| `moving_tag` (mapping and deploy.yml) | `"@current"` \| `""` \| current rule. `v_moving_tag` and `check_manifest` accept `@current` |
| mapping `moving_tag` default | `"@current"` when registry mode applies (target `registry.url` set **and** `image_repo` starts with `registry.url + "/"`), else `"latest"` (AD-1). For deploy.yml without `moving_tag`, the same rule in `resolve()` (see §11.5) |
| mapping `image_repo` with a registry target | not enforced. A repo outside the registry just means no registry for that mapping (AD-2). `check_mapping` returns it unchanged |
| GitLab `url` (sign-in body, `.env`) | `^https?://[A-Za-z0-9.-]+(:\d{1,5})?(/[A-Za-z0-9._~/-]*)?$`, ≤ 200, trailing `/` stripped |
| GitLab `project` | `^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+){1,19}$`, no `..` segment |
| `.env` content | str, 1–262144 chars |
| package file name | format (1) `PKG_FILE_RE` (unchanged); format (2) `TARZIP_RE = (?P<service>[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}?)(?:_(?P<ts>\d{8}_\d{6}))?(?:\.tar)?\.zip`. Format (1) is tried first |
| `options.prune_after` | bool (goes through the `v_bool` branch of `put_options` with `save_image_tar`) |

#### Package name parsing (D6)
`parse_pkg(name) -> (service, ts|None, fmt) | None`:
- `PKG_FILE_RE` gives `(svc, ts, "packager")`.
- Else `TARZIP_RE` gives `(svc, ts or None, "tarzip")`. Examples: `ownercheck.tar.zip` is `ownercheck`, `my.app.zip` is
  `my.app`, `sdtest-web3.zip` is `sdtest-web3`, `ownercheck_20261103_120501.tar.zip` is `ownercheck` with ts
  `20261103_120501`.
- Else `None`.
- The name only picks the service and ts. **The RepoTag rule is chosen by content in `extract`** (§11.6), so a flat
  `build_tar.sh` zip renamed `ownercheck_20261103_120501.zip` also works.

Use it at every call site of `PKG_FILE_RE`: the FTP `nlst` fallback, `test_file_server`, `list_packages`, `create_deploy`,
`start_deploy` and `auto_packages`.

### 11.2 Auth (D1) **[patch §0, §4]**

#### Gate
Add an `@app.middleware("http")` that runs after `TrustedHostMiddleware`. When the path starts with `/api/`, does not
start with `/api/auth/`, and `not signed_in(load_config())`, it returns
`JSONResponse({"detail": "not signed in"}, 401)`. This covers SSE, logs and downloads. `/`, `/assets/*` and
`/api/auth/*` stay open.

#### GitLab HTTP helper (stdlib only, no httpx in this venv)
`gl_call(method, path, token=None, form=None, base=None, timeout=15) -> (status, json_or_None)` uses
`urllib.request`.
- Headers: `Accept: application/json` and, with a token, `Authorization: Bearer <token>`. GitLab accepts PATs and
  OAuth tokens as Bearer.
- `form` is sent urlencoded. `path` is either `/api/v4/...` or `/oauth/...` and is appended to `base or gl_base(cfg)`.
- `HTTPError` returns `(e.code, parsed json or None)`. `URLError` and `OSError` raise `HTTPException(502, "GitLab unreachable: <reason>")`.
- The token never goes into an exception message.

`gl_token()` returns a usable access token or raises:
- If `not signed_in(cfg)`, it raises 401 `not signed in`.
- If `expires_at` is set, `time.time() > expires_at - 60` and a refresh token is stored, it refreshes under
  `gl_lock = threading.Lock()` (it re-reads the config inside the lock, so only one refresh happens). It POSTs
  `/oauth/token` with form `{grant_type: "refresh_token", refresh_token, client_id, redirect_uri, client_secret?}`.
  - On 200 it saves `token`, `refresh_token` (GitLab rotates it) and `expires_at = int(time.time()) + expires_in`.
  - On 400 or 401 it clears the session (same as logout) and raises 401 `GitLab session expired, sign in again`.
  - A network error raises 502.

`gl_paths(project)` = `urllib.parse.quote(project, safe="")` for `/projects/<id>`.

#### Routes

**GET `/api/auth/status`** (open) → 200
```json
{"logged_in": true, "login": "sdtest-dev", "avatar_url": "http://…/avatar.png", "provider": "gitlab",
 "method": "oauth", "gitlab_url": "http://127.0.0.1:18929", "oauth_available": true, "oauth_error": null}
```
- `provider` is `"gitlab"` when signed in, otherwise null.
- `oauth_error` is a one-shot module variable: it is returned once, then reset to None.
- `logged_in` is `signed_in(cfg)`.
- When signed in but `username` is empty (the token came from `.env`), it starts **one background thread per
  process** (module flag set before the start) that calls `GET /api/v4/user` with a 5 s timeout and saves
  `username`/`avatar_url` on 200, ignoring errors. Status never waits for it (GitLab may be unreachable; status is
  the first boot call of the UI).

**POST `/api/auth/gitlab/token`** (open) `{"token": "glpat-…", "url": "http://127.0.0.1:18929"}` (url optional,
validated) → 200 `{"logged_in": true, "login": "sdtest-dev", "avatar_url": …}`.
- While `signed_in(cfg)`, a `url` other than `gl_base(cfg)` gives 409 `sign out first to change the GitLab URL`
  (AD-8: an open endpoint must not let any local process swap the URL and token under a signed-in user).
- An empty token gives 400 `token: required`.
- GitLab 401 gives 401 `GitLab rejected the token`.
- Any other non-200 gives 502 `GitLab error <status>`. Network errors give 502.
- On success it saves `{url (if given), token, token_url: gl_base(), refresh_token: "", expires_at: None, method: "pat",
  username, avatar_url}`. It never echoes the token.

**GET `/api/auth/gitlab/start`** (open). The browser navigates here and gets a 302 to
`<gl_base>/oauth/authorize?client_id=…&redirect_uri=…&response_type=code&state=…&scope=api&code_challenge=…&code_challenge_method=S256`.
- **Scope is `api` in both apps** (it also grants git-over-HTTP read, so BP needs nothing more). One GitLab
  application serves both apps: redirect URIs `http://127.0.0.1:8095/api/auth/gitlab/callback` and
  `http://127.0.0.1:8090/api/auth/gitlab/callback`, scope `api`, confidential off. The README says exactly this.
- `redirect_uri` is `str(request.base_url).rstrip("/") + "/api/auth/gitlab/callback"` with the host `localhost`
  replaced by `127.0.0.1` (GitLab matches the registered URI exactly), for example
  `http://127.0.0.1:8095/api/auth/gitlab/callback`.
- `state = secrets.token_urlsafe(24)` and `verifier = secrets.token_urlsafe(48)`.
- `challenge = base64.urlsafe_b64encode(sha256(verifier).digest()).rstrip(b"=")`.
- `OAUTH_PENDING[state] = {"verifier", "redirect_uri", "exp": time.monotonic() + 600}` is a module dict. Expired
  entries are pruned on each start, and at most 20 are kept.
- With no `client_id`, it sets `oauth_error = "GitLab sign-in isn't configured: set GITLAB_CLIENT_ID (Settings, .env or environment)"`
  and returns a 302 to `/#/login`.

**GET `/api/auth/gitlab/callback?code=…&state=…`** (or `?error=…&error_description=…`):
1. Pop `OAUTH_PENDING[state]`. If it is missing or expired, the error is `sign-in expired or state mismatch, try again`.
2. If `error` is present, the error is `GitLab: <error_description or error>`.
3. POST `/oauth/token` with form `{grant_type: "authorization_code", code, redirect_uri, client_id, code_verifier, client_secret?}`.
   A non-200 gives `GitLab token exchange failed (<status> <json.error>)`.
4. `GET /api/v4/user` with the new access token.
5. Save `{token: access_token, token_url: gl_base(), refresh_token, expires_at, method: "oauth", redirect_uri, username, avatar_url}`.
6. Return a 302 to `/#/dashboard`. On any error, set `oauth_error` and return a 302 to `/#/login`. Codes, tokens and
   the verifier are never logged.

**POST `/api/auth/logout`** (open) clears `token, token_url, refresh_token, expires_at, username, avatar_url, method`
and returns `{"logged_in": false}`.

**PUT `/api/config/gitlab`** (gated) takes `{"client_id"?: str ≤ 200, "client_secret"?: str ≤ 512}`. An omitted field
keeps its value and `""` clears it. Returns 200 `public(cfg.gitlab)`. The URL is not editable here: the login form,
`.env` or the environment set it.

**GET `/api/gitlab/projects`** (gated) calls `GET /api/v4/projects?membership=true&per_page=100&order_by=last_activity_at`
(**no `simple=true`**: the simple view has no `visibility`) with `gl_token()` and returns 200
`[{"full_name": "sdtest/apps/mock-web3", "clone_url": "http://…/sdtest/apps/mock-web3.git", "default_branch": "main", "private": true}]`.
- `clone_url = gl_base() + "/" + path_with_namespace + ".git"`, **never** `http_url_to_repo` (GitLab builds that
  from its `external_url`, which often names another host than the IP the user configured).
- `private = visibility != "public"`.
- GitLab 401 gives 401. Only the first page is read (ponytail: 100 projects).

#### triggered_by
`new_job(..., triggered_by=...)` stores the value:
- `create_deploy` and `create_rollback` pass `load_config()["gitlab"]["username"] or None`.
- `auto_tick` passes `"auto"`.
- The existing `trigger` field stays as it is (`manual`|`auto`).

#### Masks **[patch §0.3]**
`Runner.masks` also includes every target's `registry.password` and `cfg.gitlab.token`, `refresh_token` and
`client_secret`.

### 11.3 SMB file server (D4)

`fileserver(u)` gets an `elif u["protocol"] == "smb":` branch. It keeps the same contract
`(ls(path) -> [(name, is_dir, size, mtime)], get(path, local, cb) -> size)`. **The `ls` tuple gains a 4th element
`mtime` (epoch float or None) for every protocol.** It comes from SFTP `a.st_mtime`, from FTP `mlsd` facts
`["type","size","modify"]` (`modify` is `YYYYMMDDHHMMSS[.f]` UTC), as None in the FTP `nlst` fallback, and from SMB
`entry.stat().st_mtime`.

```python
import smbclient   # smbprotocol==1.17.0
cache = {}
kw = {"port": port, "connection_cache": cache}
user = f"{u['domain']}\\{u['username']}" if u.get("domain") else (u["username"] or None)
smbclient.register_session(host, username=user, password=u["password"] or None, **kw)
unc = lambda p: "\\\\" + host + "\\" + u["share"] + p.replace("/", "\\")     # p is an absolute posix path
ls  = [(e.name, e.is_dir(), e.stat().st_size if not e.is_dir() else None, e.stat().st_mtime)
       for e in smbclient.scandir(unc(path), **kw) if e.name not in (".", "..")]
get: total = smbclient.stat(unc(path), **kw).st_size; with smbclient.open_file(unc(path), mode="rb", **kw) as f:
     1 MiB chunk loop -> local file, cb(done, total)
     OSError with errno ENOENT -> raise FileNotFoundError(path)        # p_fetch only catches FileNotFoundError
finally: smbclient.reset_connection_cache(connection_cache=cache)
```
- `remote_dir` and `package_path` are paths **inside the share**. `/` is the share root.
- `put_file_server`: when the protocol changes and `port` is omitted, smb gets 445 (the existing swap at L1471:
  `{"sftp": 22, "smb": 445}.get(p, 21)`).
- `test_file_server` message: `Connected to smb://<host>:<port>/<share>, <n> packages in <remote_dir>` (n counts
  formats 1+2). Other protocols keep their message.
- `p_fetch` log line: `connecting smb://<host>:<port>/<share> as <user|(anonymous)>`, and the existing format for the
  other protocols.
- `create_deploy` URL form: the regex becomes `(sftp|ftps?|smb)://([^/:]+)(?::(\d+))?(/.*)`. For smb, the first path
  segment must equal `fs.share`, and the rest is the path. `smb://127.0.0.1:1445/releases/gl/x.zip` becomes `/gl/x.zip`.
  A mismatch gives 400 `package_path: URL does not match the configured file server`.

### 11.4 Packages and watch (D5, D6)

**GET `/api/packages`** **[patch §4.3]**: each package entry becomes
```json
{"name": "sdtest-web3.tar.zip", "path": "/gl/sdtest-web3.tar.zip", "ts": null, "format": "tarzip",
 "created_at": "2026-11-03T12:01:05", "modified_at": "2026-11-03T12:01:05", "size": 5234110}
```
- `ts` comes from the name (format (1), or a format (2) name with a `_<YYYYMMDD_HHMMSS>` suffix), else null.
- `modified_at` is the mtime in local ISO, or null.
- `created_at` is `ts_iso(ts)` when `ts` is set, else `modified_at`.
- Packages and groups are sorted by `key = ts or mtime_ts` descending, where `mtime_ts = strftime("%Y%m%d_%H%M%S")`
  of the mtime, or `""`.
- Group fields are unchanged (`service`, `mapped`, `deployable`, `packages`).
- Watching is client-side polling (UI_ADDENDUM). The backend needs no other change.

**Auto-deploy** **[patch §10.2]**: `auto_packages` uses `parse_pkg`, and the comparison key is `ts or mtime_ts`. A
format (2) file therefore redeploys when it is overwritten with a newer mtime, which matches the `build_tar.sh` habit
of reusing the same name. Rules:
- `auto_state.last_ts` stores that key (name kept).
- A format (2) file without a ts in its name is a candidate **only when its service has a Settings mapping**
  (no deploy.yml can name its service, so an unrelated `docs.zip` must not start jobs).
- **Upload in progress:** a candidate starts only when its `(size, mtime)` equals what the previous tick saw for that
  path (`auto_state.seen = {path: [size, mtime]}`, rewritten every tick). A file still being copied onto the share
  therefore waits one interval instead of failing with `not a valid zip`.
- `processed[]` entries are `{package, key, version, path, at, job_id, error}`: `key` is the comparison key and
  `version` the started job's `version` (the job ts for a format (2) file without ts; `key` when no job started).
  The UI shows `version`.

The job's version is the name ts, else the job ts (below).

**POST `/api/deploys`**:
- The basename must satisfy `parse_pkg`, else 400
  `package_path: file name must be <service>_<YYYYMMDD_HHMMSS>.zip, <name>.tar.zip or <name>.zip`.
- `start_deploy` creates the job with `version = ts`. When the name has no ts (format (2)) it sets
  `version = job["ts"]` right after `new_job`, and `new_image = f"{repo}:{job['ts']}"` when it is mapped.
- Job field `package_format: "packager"|"tarzip"`, first from the name, then corrected by content in `extract`.

### 11.5 Job JSON additions **[patch §5]**

```json
{
  "triggered_by": "sdtest-dev",
  "package_format": "packager",
  "registry": "127.0.0.1:5050",
  "moving_tag": "@current",
  "moving_image": "127.0.0.1:5050/sdtest/web3:dev",
  "previous_image": "127.0.0.1:5050/sdtest/web3:dev",
  "previous_ref": "127.0.0.1:5050/sdtest/web3:dev@sha256:aaa…",
  "previous_digest": "sha256:aaa…",
  "new_image": "127.0.0.1:5050/sdtest/web3:20261103_120501",
  "new_digest": "sha256:bbb…",
  "deploy_image": "127.0.0.1:5050/sdtest/web3:dev@sha256:bbb…",
  "pushed": ["127.0.0.1:5050/sdtest/web3:backup-20261103_120501", "127.0.0.1:5050/sdtest/web3:20261103_120501",
             "127.0.0.1:5050/sdtest/web3:dev"],
  "load_tags": {"127.0.0.1:2223": {"sdtest-web3:latest": "sha256:ccc…"}},
  "health_script": true,
  "backup": {"id": "sdtest_web3_20261103_120501", "dir": "/home/deploy/sd-backups/sdtest_web3/20261103_120501",
             "tag": "127.0.0.1:5050/sdtest/web3:backup-20261103_120501", "image_tar": true, "digest": "sha256:aaa…"},
  "artifacts": {"...": "...", "job_dir": "/home/deploy/sd-work/sdtest-web3/20261103_120501"}
}
```
Field meanings:

| field | meaning |
|---|---|
| `registry` | Registry URL when registry mode is used for this job (AD-2), else null. |
| `moving_tag` | The effective tag (mapping, or deploy.yml, or the AD-1 default); it may be `@current`. |
| `moving_image` | Null until `connect` (deploy) or `load` (rollback) resolves `@current`. |
| `previous_ref` | The full `Spec.TaskTemplate.ContainerSpec.Image` before the job, digest included. Null in create mode. |
| `deploy_image` | The exact `--image` passed to `service update`/`create`. Without a registry it equals `new_image`. |
| `pushed` | Refs this job started to push, in order. A ref is added **before** its push runs (§11.6 `push`). |
| `load_tags` | Format (2) only: per host, each archive RepoTag → the image ID it named before `docker load` (null = absent). `cleanup` puts them back. |

All new fields default to null, `[]` or false in `new_job`. Each one is saved (`self.save()`) the moment it is set,
so `recover()` can use it.

`new_job` details:
- It stores `moving_tag = m["moving_tag"]`.
- `moving_image` is `f"{repo}:{mt}"` only when `mt` is set and is not `"@current"`; otherwise it is None, and connect
  resolves it.
- `mapping_for()`, which derives the moving tag of a deploy.yml mapping from `moving_image`, keeps working because it
  sees the resolved tag.

`resolve()` **[patch]** (it rebuilds `moving_image` today, so it needs the same rule):
- deploy.yml without `moving_tag` gets the AD-1 default for the resolved target and `image`.
- It sets `j["moving_tag"] = m["moving_tag"]` and `moving_image = f"{repo}:{mt}"` only when `mt` is set and is not
  `"@current"`, else None. `connect` then resolves `@current` exactly as for Settings mappings.
- After resolve, `if j["health_script"] and not j["health_url"]`: fail
  `package has .deploy/healthcheck.sh but no health_url is set (mapping or deploy.yml)` — before anything touches
  the target (the script's contract needs `--url`).

### 11.6 Phases: exact behaviour and remote argv **[patch §6]**

Notation as in §6. The rest of this list adds to it:
- `q` = shlex.quote. Every argv goes through `shell_cmd`, and `exec_command` receives only `shell_cmd(...)` (AC-3).
- `R` = the job registry `{url, username, password}`, or None (AD-2).
- `JD` = `W/<package>/<version>`, the job dir. `BD` = `B/<svc>/<job ts>`.
- `split_ref(ref) -> (repo, tag|None, digest|None)`. The tag is the part after the last `:` when that `:` comes after
  the last `/`.
- `prev_ref` = `f"{repo_of(previous_image)}@{previous_digest}"` when a digest is known, else `previous_image`.
- `same_image(task_img, want)` = `task_img == want` if `"@" in want`, else `strip_digest(task_img) == want`. It is
  used by `p_verify` and `wait_on`.

**`Shell.run(argv, timeout=60, redirect=None, quiet=False, stdin=None)`**: after `chan.exec_command(shell_cmd(...))`,
when `stdin` is not None it calls `chan.sendall(stdin.encode()); chan.shutdown_write()`. `check()` passes `stdin`
through. The stdin text is never logged.

**`service_tasks`** adds `--no-trunc`, giving `D service ps <svc> --no-trunc --filter desired-state=running --format {{json .}}`.
This is required because the CLI strips the digest from `Image` unless `--no-trunc` is passed. Task IDs become full
IDs everywhere, which keeps them consistent.

**Helpers**
- `push(sh, ref)`: first appends the ref to `job.pushed` (deduplicated) and saves the job, **then** runs
  `check(D + ["push", ref], timeout=1800, what="docker push")`, so a kill mid-push still leaves a record for
  `recover()`. The digest is the last match of `digest: (sha256:[0-9a-f]{64})` in the output; with no match it raises
  `Fail("docker push <ref>: no digest in output")`. It logs `pushed <ref> -> <digest>` and returns the digest.
- `registry_login(sh)`: logs `registry <url>: logging in as <username> (password via stdin)`, then runs
  `check(D + ["login", "--username", R.username, "--password-stdin", R.url], stdin=R.password, what="docker login")`.
  It fails with `registry login failed: <last line>`.
- `health_wait(url)`: the existing `wget` loop moved out of `p_verify` (`wget -q -O /dev/null -T 5 <url>` every 2 s
  until `health_timeout`). It returns True or False.
- `repo_of(ref)` = `split_ref(ref)[0]`.

#### 1 fetch
Unchanged apart from the SMB branch and the log line in §11.3. A missing file gives
`file not found on the file server: <path>`.

#### 2 extract
Members:
- Format (1): `<pkg>_<ver>/<pkg>_<ver>.tar`. Otherwise the existing fallback, which is the only `.tar` at depth ≤ 1.
  That fallback already covers the flat `x.tar` layout.
- pyzipper `AESZipFile` opens ZipCrypto and AES alike. The wrong-password mapping is unchanged
  (`RuntimeError` Bad password, `zlib.error`, `BadZipFile` "Bad CRC-32" all give `wrong zip password`).
- The log says `extracting <member> (<AES|ZipCrypto>)`, and the copy loop reports progress with the existing
  `self.progress("extracted")` callback (every 10 %). **ZipCrypto decrypts in pure Python at about 1.3 MB/s**
  (measured with this venv): a 500 MB `build_tar.sh` zip takes about 6 minutes. The README and the wizard's
  password step say so (`AES zips from Build Packager or 7z -mem=AES256 extract much faster`). Ponytail: no
  worker process; add one if the API is measured to stall.

Health script:
- `hc = posixpath.join(posixpath.dirname(member), ".deploy/healthcheck.sh")`, or `.deploy/healthcheck.sh` when the
  member sits at the zip root.
- If it is present (file_size ≤ 262144), copy it to `WORK/<id>/healthcheck.sh`, set `job.health_script = true` and log
  `package has .deploy/healthcheck.sh (<n> bytes)`. Larger than 256 KB fails with `healthcheck.sh: larger than 256 KB`.

RepoTags — **the rule follows the layout, not the file name** (`job.package_format` is set here and saved):
- Member `<pkg>_<ver>/<pkg>_<ver>.tar` or the existing depth-1 fallback (a folder layout): format (1) rule, RepoTags
  must be exactly `[<pkg.lower()>:<ver>]` (unchanged).
- A `.tar` at the zip root (flat layout, `build_tar.sh`): format (2) rule. `docker save <name>` stores **every**
  tag of the repo, so:
  - `manifest.json` must hold exactly **one** image entry. Several entries fail with
    `archive holds <n> images (<tags>); save just one, e.g. docker save -o x.tar <name>:latest`.
  - That entry needs ≥ 1 RepoTag, else `archive image has no tag; docker save it by name`.
  - `loaded_image` = the RepoTag ending in `:latest`, else the first one.

After `resolve()`, format (2) also fails when the repo of **any** of the entry's RepoTags equals the `image_repo` of a
Settings mapping or of a successful deploy.yml owner that belongs to **another** (service, target). The message is
`image tag <t> belongs to mapping <pkg> (<svc>)`. `docker load` sets every RepoTag on the manager, so `load` records
what they named before and `cleanup` puts them back (`load_tags`).

After `resolve()`, the health-script/`health_url` check of §11.5 runs.

The message gains ` · health script` when one is present.

#### 3 connect (deploy and rollback)
1. SSH connect, then `D info --format {{json .Swarm}}` (unchanged).
2. Set `job.registry = R.url` if registry mode applies (AD-2), else null. With a registry:
   `D login --username <R.username> --password-stdin <R.url>` with stdin `<R.password>`.
3. `D service inspect --format {{json .}} <svc>` (quiet, `(output hidden)` as today). When the service exists:
   `previous_ref = Spec…Image`, `previous_image = strip_digest(previous_ref)`,
   `previous_digest = previous_ref.split("@",1)[1] if "@" in previous_ref else None`.
4. Resolve `@current` (**deploy jobs only**; rollback jobs resolve it in `load` from the backup) when
   `moving_tag == "@current"`:
   - Mode update: `repo, t, dg = split_ref(previous_ref)`. A digest-only ref (`dg` set, `t` None) keeps `t = None`;
     no tag and no digest means `t = "latest"`.
   - If `t` is None, fails `TAG_RE`, starts with `backup-`, or matches `TS_RE`, fail with
     `moving tag @current: <svc> runs <previous_ref>; its tag "<t or (none)>" can't be a moving tag — set moving_tag in the mapping`.
   - Mode create: `t = "latest"`, with the log line `@current: service is new, using latest` (so the created spec
     carries a moving tag and the next `@current` deploy works).
   - Then `moving_image = f"{image_repo}:{t}"`, saved, with the log line `moving tag @current = <t>`.
   - When registry mode does **not** apply but `previous_ref` has a digest and `image_repo`'s first segment contains
     `.` or `:` (a registry host), log `WARNING: <svc> runs a registry image but target <id> has no registry for
     <image_repo>; the image is only loaded on the connected hosts (set the registry in Settings → Targets)`.
5. Deploy jobs only:
   - `mkdir -p -- <JD>` on the manager, which sets `artifacts.job_dir = JD`.
   - Extra nodes are connected and get `mkdir -p -- <JD>` **only when `job.registry` is null**. Otherwise log
     `registry <url>: extra nodes pull from it, no tar copied to them`.

Message: `deploy@127.0.0.1:2223 · service sdtest_web3 running 127.0.0.1:5050/sdtest/web3:dev · registry 127.0.0.1:5050`.

#### 4 transfer
- `rt = JD/<tar_name>`. It does `sftp.put` followed by `sha256sum -- <rt>` on the manager, plus the extra nodes when
  there is no registry (unchanged otherwise).
- If `job.health_script`, it also runs `sftp.put(local healthcheck.sh, JD + "/healthcheck.sh")` on the manager only and
  logs `uploaded healthcheck.sh to <label>:<JD>/healthcheck.sh`.
- `artifacts.remote_tar = rt` (unchanged meaning).

#### 5 backup (mode update; mode create is still skipped)
1. `mkdir -p -- <BD>`
2. `D service inspect <svc>` redirected `> <BD>/service.json` (the one redirect)
3. `D image inspect --format {{.Id}} <prev_ref>` gives `prev_id`. If that is non-zero, a registry is set and
   `previous_digest` is known: `D pull <prev_ref>` (timeout 1800, **non-fatal**: a failure is logged), then inspect
   again. If it is still missing, log `WARNING: current image not present locally; backup tag skipped` and set
   `btag = None`, as today.
4. `D tag <prev_ref> <btag>` with `btag = <image_repo>:backup-<job ts>`
5. With a registry and `btag`: `backup.digest = push(btag)`. When `previous_digest` is known the old image is
   already in the registry by digest, so a failed push only logs `WARNING: backup push failed: <last line>` and
   leaves `backup.digest` null (re-pushing a pulled image can fail on a containerd image store). Without a known
   `previous_digest` the push stays fatal (it is the only copy other nodes could pull).
6. If `save_image_tar` and `btag`: `D save -o <BD>/image.tar <btag>` (timeout 1800)
7. Write `<BD>/image.txt` over SFTP:
   ```
   image=<previous_ref or previous_image>
   digest=<previous_digest or empty>
   id=<prev_id or empty>
   backup_tag=<btag or empty>
   backup_digest=<backup.digest or empty>
   ```
8. Write `<BD>/meta.json` over SFTP. It has the existing keys plus `previous_ref`, `previous_digest`,
   `backup_digest` and `registry`.
9. Prune (new layout only, AD-5/AD-6): list `B/<svc>` and keep the names that match `TS_RE`, sorted descending.
   For each one beyond `keep_backups` (never `job.backup_id`'s ts): read its `meta.json`. If `backup_tag` is not
   `previous_image`, run `D rmi <backup_tag>` (a non-zero exit is allowed). Then `rm -rf -- <B>/<svc>/<ts>` and log
   `pruned backup <svc>_<ts>`.

Message: `backup 127.0.0.1:5050/sdtest/web3:backup-20261103_120501 (spec + tag + push + tar), pruned 0`.

#### 6 load
- **Deploy:** for format (2), first record `load_tags[<host>:<port>][tag] = <D image inspect --format {{.Id}} tag> or
  null` for every archive RepoTag on each host that loads, and save. Then `D load -i <JD>/<tar_name>` (timeout 1800)
  on the manager, plus the extra nodes only without a registry. The `Loaded image:` check is unchanged.
- **Rollback job:**
  1. Backup dir `BDr` = `B/<svc>/<ts>` if its `meta.json` exists, else the legacy `B/<svc>_<ts>`, else fail
     `backup <id> not found`.
  2. `D image inspect --format {{.Id}} <btag>`. If the tag is missing and a registry is set: pull
     `btag` when `meta.backup_digest` is known, else `meta.previous_ref` when it has a digest, then `D tag <that> <btag>`.
     If it is still missing and `image.tar` exists, run `D load -i <BDr>/image.tar`. If it is still missing, fail
     `backup image <btag> not available`.
  3. Choose `new_image` (previous_image vs btag) as today.
  4. `@current`: when `moving_tag == "@current"`, `t = split_ref(meta.previous_image)[1] or "latest"`. If `t` passes
     the connect-step-4 rules, `moving_image = f"{image_repo}:{t}"`; otherwise `moving_image = None` with
     `WARNING: backup ran <previous_image>; no moving tag for this rollback`. A rollback never fails on this.
  5. With a registry (no push here; the moving tag is pushed in `verify`, AD-7):
     - `same = repo_of(meta.previous_image) == image_repo`
     - `digest = meta.backup_digest or (meta.previous_digest if same else None) or push(btag)`
     - `name = moving_image or (meta.previous_image if same else btag)`
     - `new_digest = digest`, `deploy_image = f"{name}@{digest}"`.
  6. Without a registry: `deploy_image = new_image`.

#### 7 tag (deploy)
- Hosts are the manager, plus the extra nodes without a registry.
- `D tag <loaded_image> <new_image>`, then `D tag <loaded_image> <moving_image>` if a moving tag is set (local tags).
- With a registry (AD-7):
  - `new_digest = push(new_image)`. **The moving tag is not pushed here.**
  - `deploy_image = f"{moving_image or new_image}@{new_digest}"`. The service must keep the moving tag in its spec,
    or the next `@current` resolves to a timestamp tag. The nodes pull by digest, so the registry's `:<moving>` may
    still point at the old image.
- Without a registry: `deploy_image = new_image`.
- Message: `sdtest-web3:latest → …/web3:20261103_120501, …/web3:dev · pushed …:20261103_120501 sha256:bbbbbbbbbbbb`. The
  UI label is "Tag and push image" when the job has a registry.

#### 8 deploy
`ni = deploy_image`.
- **Update:**
  `D service update --image <ni> [--with-registry-auth] --no-resolve-image --update-failure-action rollback --update-monitor <n>s --detach=true [--force] <svc>`.
  - `--with-registry-auth` is added iff `job.registry`.
  - `--force` is added when the image is unchanged: `previous_digest == new_digest` with a registry, else
    `previous_image == new_image` (unchanged).
- **Create:** today's argv with `--with-registry-auth` added iff a registry is set, and `ni` as the image.
- **Rollback job:** keeps `D tag <ni> <moving_image>` before the update (unchanged, local), in both modes; with a
  registry `verify` pushes that local tag.
- Touched check on failure: `info.Spec…Image == ni` with a registry, else stripped equality (unchanged).

#### 9 verify
1. Converge loop as today, using `same_image(task.Image, deploy_image)` and new task IDs.
2. Health URL with `health_wait(url)` (unchanged message).
3. **Health script (D9):** deploy jobs with `job.health_script` only (`health_url` is guaranteed by §11.5). Log
   `running health script`, then
   `run(["timeout", str(converge_timeout), "bash", JD + "/healthcheck.sh", f"--url={health_url}", f"--service={svc}"], timeout=converge_timeout + 30)`
   (`Shell.run`'s timeout is an inactivity timeout; coreutils/busybox `timeout` bounds the total). The output is
   streamed to the log. A non-zero exit fails with `health script failed (exit <code>): <last output line>` (124 =
   timed out).
4. **Moving tag to the registry (AD-7):** deploy and rollback jobs with `job.registry` and `moving_image`:
   `d2 = push(moving_image)`. If `d2 != new_digest`, log `WARNING: <moving> digest <d2> != <new_digest>` (re-push of
   an identical image normally gives the same digest). A push failure fails `verify`, so the normal rollback runs.

Message: `1/1 tasks running <deploy_image> · health OK · health script OK · pushed :dev`.

#### 10 cleanup
- Every connected host runs `rm -rf -- <JD>` (job_dir). An old job without `job_dir` falls back to `rm -f -- <rt>`.
- `load_tags` (format (2)): on each host, for each tag not equal to `new_image`/`moving_image`: `D tag <old id> <tag>`
  when an old id was recorded, else `D rmi <tag>` (only drops the tag; `new_image` keeps the image). Non-zero exits
  are logged, not fatal. Runs after success and failure, and in recovery.
- Registry mode, job succeeded, `moving_image` set: `D rmi <new_image>` on the manager (non-zero allowed). It only drops
  the local `:<ts>` tag (`:<moving>` and the repo digest keep the running image), so `prune_after` and later
  prunes can free old images instead of keeping every deployed version tagged forever.
- `shutil.rmtree(WORK/<id>)` as today.
- **prune_after (D10):** when `options.prune_after` is set, `job.error` is empty and `self.sh` exists, run
  `D system prune -f` on the manager (timeout 600). A non-zero exit only logs `WARNING: docker system prune failed: …`.
  The message gets ` · docker system prune done`. The README and the option's help say what it removes on a
  manager: **all stopped containers on that host and unused networks, including a stopped stack's overlay networks**
  — the same as the CI's `docker system prune -f`, which is why it is offered.
- Message: `removed <JD> and local temp files`.

#### 6.11 Rollback with registry **[patch §6.11]** (D10)
`auto_rollback()` with `job.registry` set:
1. `restore_tags()` (local tags, unchanged).
2. If `touched` (mode update):
   1. If `swarm_auto` is set, `ok = wait_on(previous_ref, "rollback_completed")` with method `swarm_auto`.
   2. If that did not run or was not ok, pick `rb_img`:
      - `previous_ref` when it contains `@`, method `previous_digest`;
      - else `f"{moving_image or previous_image}@{backup.digest}"` when `backup.digest` is known, method
        `backup_digest` (never `btag` in the spec: a `backup-` tag would make every later `@current` deploy fail);
      - else `previous_image`, method `previous_image`.

      Run `D service update --image <rb_img> --with-registry-auth --no-resolve-image --force --detach=true <svc>`,
      then `ok = wait_on(rb_img)`.
   3. **Mode update only (registry or not):** after a converged rollback, if `health_url` is set,
      `ok = ok and health_wait(health_url)`. The reason becomes `health check failed after rollback` when this fails.
      (Mode create rolls back with `service rm`; there is nothing to health-check.)
   4. `rollback = {performed, method, to_image: rb_img or previous_ref, ok}`, and the error suffix is
      `; rolled back to <to_image>`.
3. **`registry_repair()`, always last, also when the service was not touched** (the existing
   `if not self.touched or not self.sh: return ""` becomes `return self.registry_repair()`, and the normal path ends
   with `return suffix + self.registry_repair()`; it has its own try, so a registry error never changes step 2's
   result; it returns `""` without `self.sh` or `job.registry`): when `moving_image in job.pushed` (the `verify`
   push started, AD-7) and `previous_ref` is known:
   `D image inspect <prev_ref>` → if missing `D pull <prev_ref>` → `D tag <prev_ref> <moving_image>` →
   `d = push(moving_image)` → log `==> [rollback] <moving_image> -> <d> again`. A failure logs
   `==> [rollback] WARNING: registry <moving_image> not restored: <reason>` and appends
   ` (registry <moving_image> not restored)` to the suffix. In mode create (no `previous_ref`) nothing is pushed.

Mode create and the non-registry path keep today's logic. Only step 2.3 (the health wait) is new for mode update.

`recover()`:
- After `connect_target`, when `job.registry` is set, call `registry_login(self.sh)` in **its own** try: a failure
  logs `WARNING: registry login failed: …` and recovery goes on (rolling back to `previous_ref` by digest needs no
  login; the nodes have the old image). It must not land in `err`, which would skip the service rollback.
- Extra nodes are reconnected only for deploy jobs **without** a registry, because those are the only jobs that
  touched them.
- The touched check uses `img_full == job.deploy_image` with a registry. Everything else is unchanged.
- Recovery then runs the same `auto_rollback()` (including `registry_repair()`) and `p_cleanup()` (including
  `load_tags`).

#### Backups API **[patch §4.4]**
**GET `/api/services/{package}/backups`**:
- Lists the new layout `B/<svc>/<ts>` (id `<svc>_<ts>`), then legacy `B/<svc>_<ts>`, newest first by ts.
- Each row adds `"digest": meta.backup_digest or meta.previous_digest | null`, `"in_registry": bool(meta.registry and that digest)` and
  `"layout": "new"|"legacy"`. `dir` is the real path.
- `create_rollback` is unchanged (the id format is the same).

**GET `/api/services`** rows add `"current_digest"` (from the spec image, or null), `"moving_tag"` (from the mapping)
and `"registry"` (the target registry URL, or null).

### 11.7 .env-driven setup (D11)

#### Parser (same rules in Build Packager)
`parse_env(text) -> dict` (the last occurrence wins):
- First `text = text.replace("\r\n", "\n").replace("\r", "\n")` (a Windows `.env` or a GitLab value with CRLF must
  not leave a trailing `\r` in passwords).
- Lines are `[export ]KEY=VALUE` with `KEY = [A-Za-z_][A-Za-z0-9_]*`. Blank lines and `#` lines are skipped.
- `'…'` is literal and may span lines.
- `"…"` may span lines and supports the escapes `\n \" \\`.
- An unquoted value is stripped, and a ` #…` trailing comment is removed.
- No `$VAR` expansion.
- Text with no valid line returns `{}`.

#### Startup import
- At module level, **before** `recover_interrupted()`, read `path = os.environ.get("SD_ENV_FILE") or BASE/.env`.
- If the file exists and `sha256(bytes) != cfg.env_import.sha`, run `apply_env(parse_env(text), source=".env")`,
  then save `env_import = {sha, at: now_iso(), set: names}`.
- Print one line to stderr: `env import: set <names>; ignored <names>; errors <msgs>`. Names only.
- Exceptions are caught; startup never fails because of the `.env`.

#### `apply_env(kv, target_id=None, project=None, source=".env") -> {"set": [...], "ignored": [...], "errors": [...]}`
- A `None` value (a GitLab "hidden" variable, §below) is dropped first; when its key is one of the table's keys it
  adds `errors += ["<KEY> is hidden in GitLab; its value can't be read"]`, else it goes to `ignored`.
- `source == "gitlab"` (Import from GitLab project) puts `GITLAB_*`, `SD_HOST_KEY_POLICY` and `SD_DOCKER_CMD` in
  `ignored`: `GITLAB_TOKEN` is a common bot variable (renovate, semantic-release), and project variables must not
  swap the user's session, the GitLab URL, SSH host-key policy or the remote docker command.
- Applies the sections in the order gitlab, file_server, target, mapping, options, auto.
- Each section is one `update_config` call that runs the existing validator (`check_file_server`, `check_target`,
  `check_mapping`, `v_*`). An `HTTPException` in one section becomes `errors += [f"{section}: {detail}"]`, and the
  other sections still apply.
- When both a native `SD_*` key and a CI alias are present, the native key wins.
- Names in `set` are setting paths. `ignored` lists unknown keys. **Values are never returned or logged.**

| `.env` key(s) (native first, then CI alias) | sets |
|---|---|
| `GITLAB_URL` | `gitlab.url` (validated URL) |
| `GITLAB_TOKEN` | `gitlab.token`, `token_url` (= `gl_base` after this import's `GITLAB_URL`), `method="pat"`; the username is filled in the background after the next `/api/auth/status` |
| `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET` | `gitlab.client_id`, `gitlab.client_secret` |
| `FILE_SERVER_PROTOCOL` / `HOST` / `PORT` / `USER` / `PASSWORD` / `DOMAIN` / `SHARE` / `REMOTE_DIR` / `KEY_PATH` | `file_server.protocol/host/port(int)/username/password/domain/share/remote_dir/private_key_path`. When the protocol changes and no PORT is given, the default port follows (22/21/445) |
| `SD_TARGET_ID` | target id (else the `target_id` argument, else the only existing target, else `dev`). **Checked with `TID_RE` before anything uses it**; a bad id puts `target: id …` in errors and skips the target and key sections |
| `SD_TARGET_HOST` · `BASE_DEVELOPMENT_HOST` | `targets.<id>.host` |
| `SD_TARGET_PORT` | `targets.<id>.port` |
| `SD_TARGET_USER` · `BASE_DEVELOPMENT_HOST_USER` | `targets.<id>.username` |
| `SD_TARGET_PASSWORD` | `targets.<id>.password` |
| `SD_TARGET_SSH_KEY` · `BASE_DEVELOPMENT_SSH_PRIVATE_KEY` | Key **content** (must contain `-----BEGIN` **and** `-----END`, else errors `ssh key: incomplete — quote multi-line values in .env`) is written to `DATA/keys/<id>` (dir 700; file via `os.open(p, O_WRONLY\|O_CREAT\|O_TRUNC\|O_NOFOLLOW, 0o600)` + `os.fchmod(fd, 0o600)`, so an existing 0644 file or a planted symlink can't leak it; CRLF→LF, trailing `\n`) and sets `targets.<id>.private_key_path`. A value that starts with `/` with no newline is used as a path |
| `SD_TARGET_KEY_PATH` | `targets.<id>.private_key_path` |
| `SD_WORK_DIR`, `SD_BACKUP_DIR` | `work_dir`, `backup_dir`. Defaults for a **new** target: `/home/<user>/sd-work`, `/home/<user>/sd-backups` (`/root/...` for root) |
| `SD_DOCKER_CMD`, `SD_HOST_KEY_POLICY` | `docker_cmd`, `host_key_policy` |
| `SD_REGISTRY` · `CI_REGISTRY` | `targets.<id>.registry.url` |
| `SD_REGISTRY_USER` · `CI_REGISTRY_USER` | `targets.<id>.registry.username` |
| `SD_REGISTRY_PASSWORD` · `CI_REGISTRY_PASSWORD` | `targets.<id>.registry.password` |
| `SD_PACKAGE` | mapping package. Else, **same rule for both imports**: the last path segment of `SD_IMAGE_REPO`/`CI_REGISTRY_IMAGE`, else the last segment of `project` (GitLab import), else `SERVICE_NAME`. This matches Build Packager's default service name (the repo name) and `build_tar.sh` (`<folder>.tar.zip`), e.g. `…/fortress/ownercheck` → `ownercheck` |
| `SD_SWARM_SERVICE` · `SERVICE_NAME` | `mappings.<pkg>.swarm_service` |
| `SD_IMAGE_REPO` · `CI_REGISTRY_IMAGE` | `mappings.<pkg>.image_repo` |
| `SD_MOVING_TAG` · `DEV_IMAGE_TAG` | `mappings.<pkg>.moving_tag` (default per AD-1) |
| `SD_HEALTH_URL` · `HEALTHCHECK_URL` | `mappings.<pkg>.health_url` |
| `SD_KEEP_BACKUPS`, `SD_SAVE_IMAGE_TAR`, `SD_PRUNE_AFTER`, `SD_CONVERGE_TIMEOUT`, `SD_UPDATE_MONITOR`, `SD_HEALTH_TIMEOUT` | `options.*` (ints via `v_int` ranges; bools accept `true/false/1/0/yes/no/on/off`) |
| `ZIP_PASSWORD` | `auto.password` |
| `SD_AUTO_DEPLOY`, `SD_AUTO_INTERVAL`, `SD_AUTO_PREFIX` | `auto.enabled/interval/prefix`, applied through the same logic as `put_auto` (baseline listing; a 502 lands in errors and auto stays off) |

Target rules:
- A target is created only when host and user are known, from this import or an existing target with that id.
- An existing target is merged field by field.

Mapping rules:
- A mapping needs `swarm_service`, `image_repo` and an existing or just-created target.
- An existing mapping with the same package is merged.

Keys of the other app (`BP_*`) and unknown keys go to `ignored`. One `.env` can therefore configure both apps.

#### Routes
**POST `/api/config/import-env`** (gated) `{"content": "...", "target_id"?: "dev"}` returns 200
`{"set": ["file_server.protocol", "file_server.host", "targets.dev.registry.password"], "ignored": ["BOGUS"], "errors": []}`.
Empty or invalid content gives 400 `content: no KEY=value lines`.

**POST `/api/config/import-gitlab`** (gated) `{"project": "sdtest/apps/mock-web3", "target_id"?: "lab"}`:
1. `vars = gl_ci_vars(project)` (§ below).
2. `apply_env(vars, target_id, project, source="gitlab")`.
3. Return 200 with the same shape plus `"project"`.

GitLab 403 on the project variables gives 403 `GitLab: variables need the api scope and Maintainer role`. A 404
project gives 404.

`gl_ci_vars(project)` uses the same resolution as Build Packager:
1. `GET /projects/:id` to read `namespace.kind` and `namespace.full_path`.
2. `GET /projects/:id/variables?per_page=100`.
3. When the namespace is a group, for each prefix of `full_path` from nearest to root,
   `GET /groups/<quoted prefix>/variables?per_page=100`. A 403 or 404 on a group is skipped.
4. The first hit wins in the order project, then nearest group, then root group.
5. For the same key, `environment_scope == "*"` is preferred over scoped values.
6. `variable_type == "file"`: the value is used as the content.
7. `value: null` (GitLab 17.4+ "masked and hidden") is kept as `None`, so `apply_env` reports it.
8. **Predefined CI variables are not in the variables API.** `CI_REGISTRY_IMAGE`, `CI_REGISTRY`, `CI_REGISTRY_USER`
   and `CI_REGISTRY_PASSWORD` only exist when the project defines them as ordinary variables (as the user's
   standalone registry setup and the mock do). When `CI_REGISTRY_IMAGE` is absent, it is taken from the project's
   `container_registry_image_prefix`, and `CI_REGISTRY` from that prefix's first segment. When a registry URL is
   known but no `CI_REGISTRY_USER`/`CI_REGISTRY_PASSWORD`/`SD_REGISTRY_*` value is, `apply_env` adds
   `errors += ["registry credentials not found in GitLab variables (CI_REGISTRY_USER/PASSWORD are per-job tokens there); set them in Settings → Targets"]`.
   Ponytail: no automatic use of the user's GitLab token as registry password.

### 11.8 Log lines (new, exact prefixes)

```
connecting smb://127.0.0.1:1445/releases as files
package has .deploy/healthcheck.sh (812 bytes)
registry 127.0.0.1:5050: logging in as sdtest-reg (password via stdin)
$ [127.0.0.1] docker login --username sdtest-reg --password-stdin 127.0.0.1:5050 2>&1
moving tag @current = dev
registry 127.0.0.1:5050: extra nodes pull from it, no tar copied to them
$ [127.0.0.1] mkdir -p -- /home/deploy/sd-work/sdtest-web3/20261103_120501 2>&1
uploaded healthcheck.sh to deploy@127.0.0.1:2223:/home/deploy/sd-work/sdtest-web3/20261103_120501/healthcheck.sh
extracted 40% (…/… bytes)
pushed 127.0.0.1:5050/sdtest/web3:20261103_120501 -> sha256:…
running health script
$ [127.0.0.1] timeout 90 bash /home/deploy/sd-work/sdtest-web3/20261103_120501/healthcheck.sh --url=http://127.0.0.1:8084/health --service=sdtest_web3 2>&1
pushed 127.0.0.1:5050/sdtest/web3:dev -> sha256:…            (verify step 4, only after every check passed)
==> [rollback] 127.0.0.1:5050/sdtest/web3:dev -> sha256:… again   (registry_repair, only if the verify push had started)
$ [127.0.0.1] docker system prune -f 2>&1
```

### 11.9 Acceptance criteria (new; also listed in §9)

| id | criterion |
|---|---|
| AC-36 | Unauthenticated `/api/*` gets 401, but not `/api/auth/*`. A PAT sign-in or OAuth+PKCE sign-in unlocks it. Logout, or a rejected refresh, locks it again. No token, client secret or refresh token appears in any API response or log. A token is only used for the GitLab URL it was issued for. |
| AC-37 | The SMB file server lists, tests and downloads. A package uploaded by Build Packager over SMB deploys. |
| AC-38 | The package list returns `modified_at`/`format`. A zip copied into the folder appears on the next poll. |
| AC-39 | A `<name>.tar.zip` ZipCrypto flat zip and a `<name>.zip` AES flat zip deploy (version = name ts, else job ts). A flat archive must hold exactly one image (several tags of it are fine); its load-time tags are put back in cleanup. |
| AC-40 | The job dir `W/<pkg>/<version>` is created and removed. The backup dir `B/<svc>/<ts>/` holds `service.json`, `image.txt`, `image.tar` and `meta.json`. |
| AC-41 | Registry mode: login via stdin, push of `:<version>`, `service update --with-registry-auth --image <repo>:<moving>@<digest>`, and the moving tag pushed only after verify passed (AD-7). The registry tag digest equals the job's `new_digest` and the service spec digest. **Deviation (AD-1, needs sign-off): `@current` is the default moving tag only in registry mode; other mappings default to `latest`.** |
| AC-42 | `.deploy/healthcheck.sh` runs with `--url`/`--service` (bounded by `timeout`). A non-zero exit leads to rollback: the service goes back to the previous digest and the registry moving tag still (or again) holds the previous digest. A package with a health script and no `health_url` fails before the target is touched. |
| AC-43 | Restart recovery in registry mode restores both, also when the registry login fails. |
| AC-44 | `.env` import at startup, Import .env, and Import from GitLab project set config, return names only, and write the SSH key mode 600. CRLF is handled; hidden GitLab variables are reported in `errors`; a GitLab import never sets `GITLAB_*`, host-key policy or docker command. |
| AC-45 | `triggered_by` is the GitLab username, or `auto`. |
| AC-46 | `prune_after` runs `docker system prune -f` only after a successful deploy. |
| AC-47 | Auto-deploy works over SMB, including a format (2) file overwritten in place; a file still growing waits one interval; an unmapped format (2) zip never starts a job. |

### 11.10 Implementation notes (where `app.py` differs from the letter of §11)

- **SMB listing** uses `entry.smb_info` (size `end_of_file`, mtime `last_write_time`, UTC) instead of
  `entry.stat()`: smbclient 1.17's `DirEntry.stat()` drops the `port` kwarg and reconnects on 445, which breaks any
  non-default port (the lab's 1445). It also saves one round trip per file.
- **SMB not found**: `STATUS_OBJECT_NAME_NOT_FOUND`/`OBJECT_PATH_NOT_FOUND` (errno ENOENT) **and** `STATUS_NO_SUCH_FILE`
  map to `FileNotFoundError` (servers differ).
- **Rollback job, deploy phase**: the local `D tag <src> <moving_image>` uses the local tag `new_image` (previous
  image or `backup-<ts>`) as `<src>`, not the digest-pinned `deploy_image`; same image, no dependence on local
  RepoDigests. Without a registry the two are equal, so nothing changes there.
- **Backup without a registry**: when the digest form `repo@sha256:…` of the running image is not known locally, the
  backup falls back to the tag (`previous_image`), as before this release.
- The log line `registry <url>: extra nodes pull from it, no tar copied to them` is printed for every registry-mode
  deploy, with or without extra nodes.
- `cleanup` fails with `could not remove remote job files: …` (was `… remote tar …`); the success message is
  `removed <job_dir> and local temp files`.
- An unencrypted zip member logs `extracting <member> (no encryption)`.
- `.env` import of target fields for a target id that does not exist yet, without host and user, gives the error
  `target: target <id> does not exist; SD_TARGET_HOST and SD_TARGET_USER are needed to create it`.
- The module-level `recover_interrupted()` call moved to the end of `app.py`, right after the startup `.env` import
  (which needs `put_auto`), so the order "import, then recover" holds.
