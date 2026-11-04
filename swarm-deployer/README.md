# Swarm Deployer

The deploy side of Build Packager. It runs locally with no sign-in: pick a
`<service>_<YYYYMMDD_HHMMSS>.zip` that Build Packager uploaded to the SFTP file server (or a `build_tar.sh` zip
`<name>.tar.zip` / `<name>.zip`), type its zip password, and it runs these phases with a live log:

`fetch → extract → connect → transfer → backup → load → tag → deploy → verify → cleanup`

1. **fetch**: downloads the zip from the file server over SFTP.
2. **extract**: unzips the image `.tar` (AES or ZipCrypto) and checks it is a docker archive (`manifest.json`/`RepoTags`).
   It also picks up `.deploy/healthcheck.sh` when the package has it.
3. **connect**: signs in to the target (a swarm manager) over SSH, logs in to the registry (if any), checks the swarm
   service exists, and creates the job folder `<work_dir>/<package>/<version>/`.
4. **transfer**: uploads the tar (and the health script) into that folder over SFTP and checks its sha256.
5. **backup**: creates `<backup_dir>/<swarm service>/<ts>/` with `service.json`, `image.txt` (image ref + digest),
   `meta.json` and (by default) the `docker save` tar of the running image; tags it `<repo>:backup-<ts>` (pushed with
   a registry) and prunes old backups.
6. **load**: runs `docker load` on the target (and on extra nodes when there is no registry).
7. **tag**: tags the image `<repo>:<version>` and `<repo>:<moving tag>`; with a registry it pushes `<repo>:<version>`.
8. **deploy**: runs `docker service update --image ...` on the mapped swarm service only (by digest, with
   `--with-registry-auth`, when a registry is used).
9. **verify**: waits until the tasks converge, the health URL passes and the package's health script passes; with a
   registry it then pushes the moving tag. If anything fails, it rolls back automatically.
10. **cleanup**: removes the job folder on the target and the local temp files (optionally `docker system prune -f`).
    Backups are kept.

If the server is restarted mid-deploy, on startup the job is rolled back the same way (when it had reached tag or
later), cleaned up, and marked `failed` with `interrupted (server restart); rolled back to <image>`.

Each `docker` command runs on the remote host over SSH (paramiko), and every argument goes through `shlex.quote`.
Nothing runs on the local machine. The zip password is used for one deploy only. It is never stored or logged.

## Run

```
./run.sh                    # creates .venv, installs requirements, builds the UI (Node 18+), serves http://127.0.0.1:8095/
SD_DATA=/some/dir ./run.sh  # use another data dir (config, job logs, known_hosts, imported SSH keys)
SD_ENV_FILE=/x/sd.env ./run.sh   # import this .env at startup instead of ./.env (see "Setup from a .env")
```

The server listens on 127.0.0.1 only and has no sign-in: it is a local tool for one user. Requests whose Host header
is not `127.0.0.1` or `localhost` are rejected, and so are writes from other web pages (cross-site Origin).

## GitLab (optional)

Only **Settings → Import .env → Import from GitLab project** uses GitLab: it reads that project's CI/CD variables. Set
the GitLab URL (default `GITLAB_URL` or `http://192.168.33.175`) and a personal access token with the `api` scope in
**Settings → GitLab** (or `GITLAB_URL` / `GITLAB_TOKEN` in `.env`). Changing the URL without a new token clears the
saved one. The token lives only in `data/config.json` (chmod 600), is masked in logs and never returned by the API.

## Structure

```
app.py                     entry point: `uvicorn app:app` (imports backend.main)
backend/                   FastAPI backend
  main.py                  app, middleware (cross-site, trusted host), routers, startup
  api/deps.py              request helpers
  api/routes/              one router per area: settings, targets, mappings, packages, services,
                           deploys (+ rollbacks, logs), env (.env / GitLab import), ui (serves frontend/dist)
  core/                    paths (SD_DATA layout), enums (JobStatus, Phase, Protocol, ...), constants (defaults,
                           limits), patterns (validation regexes), errors (Fail, Skip, bad -> HTTP 400)
  utils/                   dates, files (atomic private JSON), text, images (image refs, package names)
  config/store.py          config.json load / locked update / public view
  validators/              fields (v_str, v_int, ...), settings (file server, target, mapping)
  remote/                  ssh (Shell, host keys, probe), swarm (service queries, overview), fileserver (SFTP)
  gitlab/client.py         GitLab API: CI/CD variables for the project import
  jobs/                    store (job files, busy set), manager (new/start/recover), runner/ (base, package
                           phases, deploy phases, rollback; Runner combines them)
  envimport/               keys (.env names -> settings), parser, apply
frontend/                  React 19 + TypeScript + Vite UI
  src/main.tsx, App.tsx    entry, route -> page
  src/router.ts            hash routes #/dashboard #/services/<pkg> #/new/<step> #/deploys/<id> #/settings/<section>
  src/api/                 client.ts (fetch wrapper), endpoints.ts (config, targets, mappings, packages, services, deploys, rollbacks)
  src/types/api.ts         API types (SPEC.md §3–5, §10)
  src/state/               draft.ts (wizard: sessionStorage sd.draft minus the password), session.ts (per-tab flags)
  src/lib/                 format, validate, job/phase helpers + deploy log classifier
  src/components/          TopBar, JobRow, MappingForm (wizard + Settings), GridRow/TestRes (settings form rows)
  src/pages/               Dashboard/ (setup checklist, service rows)  NewDeploy/ (wizard frame + steps/*)
                           Run/ (pipeline, log, result)  Service/ (running now, backups + rollback, history)
                           Settings/ (file server, targets, mappings, options, GitLab, import cards)
  src/styles/app.css       screen-specific styles
../shared-ui/              @devtools/ui: tokens, components, hooks shared with Build Packager (see its README)
```

## Develop

```bash
./run.sh                                   # backend on :8095 (builds the UI when missing or stale)
cd frontend && npm run dev                 # Vite on :5173 with hot reload, /api proxied to :8095
cd frontend && npm run typecheck           # tsc --noEmit (also checks ../shared-ui)
cd frontend && npm run build               # -> frontend/dist, served by the backend
```
`run.sh` rebuilds `frontend/dist` whenever `frontend/src`, `frontend/index.html`, `frontend/package.json` or
`../shared-ui/src` is newer than the last build, and runs `npm ci` when `package-lock.json` changed.

## Configure (Settings page, or the API)

- **File server**: the SFTP server Build Packager uploads to: host, port, user, password or key, and the remote folder
  (e.g. `/releases`). The package list refreshes every 5 s in the wizard and marks new zips.
- **Target servers**: the swarm manager's SSH host, port, user, password or key path, and host key policy (`auto_add` is meant for a lab; use `reject` in production with known_hosts). Also the docker command (`docker` or `sudo -n docker`), the work dir and the backup dir. Extra nodes get the image loaded too.
- **Service mappings**: a package service (`sdtest-web1`) maps to a target, a swarm service (`sdtest_web1`), an image repo (`sdtest/web1`), a moving tag (`latest`), an optional health URL checked from the target, and optionally "create if missing".
- **Options**: keep N backups, save the image tar by default (on), converge timeout, update monitor, health timeout,
  and `prune_after` (below).

### Registry (optional, per target)

Set **Registry** (`host:port`, e.g. `192.192.192.175:5050`, no scheme), user and password on a target. A mapping uses
the registry when its image repo starts with `<registry>/` (e.g. `192.192.192.175:5050/fortress/ownercheck`);
other mappings on that target keep loading the tar on each node. With a registry, a deploy:

1. logs in with `docker login --username <user> --password-stdin <registry>` (the password goes over the SSH
   channel's stdin, never on the command line or in the log);
2. backs up the running image as `<repo>:backup-<ts>` and pushes it;
3. loads the tar on the manager only, tags `<repo>:<version>` and `<repo>:<moving tag>`, pushes `<repo>:<version>`;
4. runs `docker service update --with-registry-auth --image <repo>:<moving tag>@<digest>`, so every node pulls
   exactly the pushed image;
5. pushes the moving tag (`:dev`) **only after verify passed** (converge, health URL, health script). The registry's
   moving tag therefore only ever holds a verified image. If the deploy fails, the service goes back to the previous
   image by digest; if the moving-tag push had already started, the previous image is pushed as the moving tag again.

Restart recovery does the same. Prune never deletes tags in the registry, only local backup dirs and tags.

The registry needs a user **and** a password (a registry without auth is not supported). A saved password belongs to
its host: changing the registry URL (or a target's / the file server's host) without entering the password again
clears it, so an old password is never sent to a new host.

### Moving tag `@current`

A mapping's moving tag `@current` means "the tag the service runs now": if the service runs
`192.192.192.175:5050/fortress/ownercheck:dev@sha256:…`, the new image is tagged and pushed as `:dev`. The run fails
before touching anything when the running tag is a timestamp, a `backup-` tag or missing.

**Deviation from the brief (D8), needs your sign-off (AD-1):** `@current` is the *default* moving tag **only in
registry mode** (the target has a registry and the image repo is under it). Every other mapping still defaults to
`latest`, because services that run fixed tags without a registry (`web:v1`) would otherwise get `v1` re-pointed at
the new image. You can always set `@current` explicitly.

### Health script

When the package contains `.deploy/healthcheck.sh` (Build Packager copies it from the repo), it is uploaded into the
job folder and run on the target after the health URL check as
`timeout <converge timeout> bash healthcheck.sh --url=<health_url> --service=<swarm service>`. A non-zero exit fails
verify and rolls back. Such a package needs a health URL in its mapping, else it fails before touching the
target. The script runs as the SSH user with plain `bash` (not through `sudo`), so if it calls `docker`, that user
must be in the `docker` group even when the target's docker command is `sudo -n docker`.

### prune_after

**Options → Run docker system prune -f on the target after a successful deploy** (off by default) does what the CI's
deploy job does. On the manager it removes **all stopped containers on that host, unused networks (also a stopped
stack's overlay networks), dangling images and build cache**. Leave it off when the manager runs anything that relies
on stopped containers or idle networks.

### build_tar.sh zips

`~/build_tar.sh` style zips work as-is: `<name>.tar.zip` or `<name>.zip` holding one flat `<name>.tar` made with
`docker save`. The package name is `<name>` (map it in Settings); the version is the deploy's start time. The
archive must hold exactly one image (several tags of it are fine); the tags `docker load` sets on the target are put
back afterwards. `build_tar.sh` uses ZipCrypto, which unpacks in pure Python at about **1 MB/s** (a 500 MB image
takes several minutes in extract, progress is logged). AES zips (Build Packager, or `7z a -tzip -mem=AES256`) extract
much faster.

## Setup from a .env ("make everything automatic")

At startup the app imports `./.env` (or `SD_ENV_FILE`) when its content changed since the last import. **Settings →
Import .env** (upload or paste) and **Import from GitLab project** (that project's CI/CD variables plus its groups')
use the same parser: `KEY=value`, `export KEY=value`, `'…'`/`"…"` (may span lines, e.g. an SSH key), `#` comments,
CRLF is fine. Only the keys present are applied; the answer lists the setting names that were set, the ignored keys
and errors, **never values**. One `.env` can configure both tools: Build Packager's `BP_*` keys are ignored here.

| `.env` key (native · CI alias) | sets |
|---|---|
| `GITLAB_URL`, `GITLAB_TOKEN` | GitLab URL and token for the project import |
| `FILE_SERVER_HOST` `PORT` `USER` `PASSWORD` `REMOTE_DIR` `KEY_PATH` | SFTP file server |
| `SD_TARGET_ID` | the target these keys go to (else the import's target, else the only target, else `dev`) |
| `SD_TARGET_HOST` · `BASE_DEVELOPMENT_HOST` | target host |
| `SD_TARGET_PORT`, `SD_TARGET_PASSWORD`, `SD_TARGET_KEY_PATH` | target SSH port, password, key path |
| `SD_TARGET_USER` · `BASE_DEVELOPMENT_HOST_USER` | target SSH user |
| `SD_TARGET_SSH_KEY` · `BASE_DEVELOPMENT_SSH_PRIVATE_KEY` | key **content**, written to `data/keys/<target>` (mode 600) and used as the key path |
| `SD_WORK_DIR`, `SD_BACKUP_DIR` | job and backup folders (new targets default to `/home/<user>/sd-work`, `/home/<user>/sd-backups`) |
| `SD_DOCKER_CMD`, `SD_HOST_KEY_POLICY` | `docker` or `sudo -n docker`; `auto_add`/`warn`/`reject` |
| `SD_REGISTRY` · `CI_REGISTRY`, `SD_REGISTRY_USER` · `CI_REGISTRY_USER`, `SD_REGISTRY_PASSWORD` · `CI_REGISTRY_PASSWORD` | target registry |
| `SD_PACKAGE` | mapping package name; default: the last path segment of the image repo (`…/fortress/ownercheck` → `ownercheck`), else of the GitLab project, else `SERVICE_NAME` |
| `SD_SWARM_SERVICE` · `SERVICE_NAME` | swarm service |
| `SD_IMAGE_REPO` · `CI_REGISTRY_IMAGE` | image repo |
| `SD_MOVING_TAG` · `DEV_IMAGE_TAG` | moving tag (default `@current` with a registry, else `latest`) |
| `SD_HEALTH_URL` · `HEALTHCHECK_URL` | health URL |
| `SD_KEEP_BACKUPS`, `SD_SAVE_IMAGE_TAR`, `SD_PRUNE_AFTER`, `SD_CONVERGE_TIMEOUT`, `SD_UPDATE_MONITOR`, `SD_HEALTH_TIMEOUT` | options (bools: true/false/1/0/yes/no/on/off) |

When both a native key and its CI alias are present, the native key wins. A GitLab project import never sets
`GITLAB_*`, `SD_HOST_KEY_POLICY` or `SD_DOCKER_CMD`. GitLab's **predefined** `CI_REGISTRY*` variables (the per-job
registry token) are not in the variables API, so they can't be imported: define the registry user/password as
ordinary CI/CD variables, or set them in Settings → Targets. Variables that are "masked and hidden" in GitLab are
reported as errors (their value can't be read).

## API (for scripts/CI)

```
curl -X POST http://127.0.0.1:8095/api/deploys -H 'Content-Type: application/json' \
  -d '{"package_path": "/releases/sdtest-web1_20261102_190005.zip", "password": "zip-secret"}'
curl -N http://127.0.0.1:8095/api/deploys/<id>/logs/stream     # SSE: log / status / end
curl -X POST http://127.0.0.1:8095/api/rollbacks -H 'Content-Type: application/json' \
  -d '{"package": "sdtest-web1", "backup_id": "sdtest_web1_20261102_190500"}'
```

`package_path` may also be Build Packager's `remote_path` URL (`sftp://host:port/<dir>/<file>`).
The full API is in `SPEC.md` §4 and §11.

## Lab and tests

The lab is a mock file server plus a Docker-in-Docker swarm reachable over SSH. It only uses containers named
`sdtest-*` and never runs swarm commands on the host daemon. See `TESTENV.md`.

All commands run from the repo root (`cd /home/shahzod/mywork/swarm-deployer`):

```
./run.sh                                   # once, to create .venv (Ctrl+C); suites start their own app instance
testenv/up.sh --node2                      # lab: SFTP + FTP + FTPS file servers, swarm target, worker node2
testenv/seed.sh                            # mock repos, v1 services, packages (seed.sh --reset: services only)
testenv/selftest.sh                        # P1 lab self-test (ssh, swarm, SFTP/FTP, zip content, safety grep)
.venv/bin/python tests/ac_test.py          # P2 API acceptance AC-2..AC-25 + FTP/FTPS deploys
.venv/bin/python tests/full_chain_test.py  # P4 Build Packager -> file server -> Swarm Deployer -> swarm, + AC-26 restart
.venv/bin/python tests/gitlab_chain_test.py   # GitLab sign-in -> BP build with .env -> SMB -> registry deploy/rollback
.venv/bin/python tests/unit_test.py        # no lab: rollback/cleanup logic with a fake shell, secrets handling
python3 -m venv /tmp/pwvenv && /tmp/pwvenv/bin/pip install playwright
/tmp/pwvenv/bin/python tests/ui_test.py    # P3 browser UI test, uses /usr/bin/google-chrome
testenv/down.sh                            # remove every sdtest* resource (--keep-files keeps $L)
```

Each suite (and `seed.sh`) takes an exclusive lock on `$L/lab.lock`, so suites can be started together and run one
after another. A suite that holds the lock and calls `seed.sh` exports `SDTEST_LAB_LOCK_HELD=1` so the child
`seed.sh` does not wait on its parent's lock; only set it yourself when your own process already holds the lock.
To try the app by hand against the lab:
`. /tmp/claude-1000/-home-shahzod-mywork/9cc69e64-a217-469a-aadc-7f8a210ef0d3/scratchpad/deployer/lab.env && SD_DATA=$L/sd-data ./run.sh`.
