# Build Packager

Local web tool: sign in with GitLab (or GitHub), pick a project + branch, clone it, give the build a `.env`,
build the Docker image, save it as `.tar`, clone extra repos into the same folder, AES-256 zip only the image `.tar`
(plus `deploy.yml` and `.deploy/healthcheck.sh` if the repo has them) with a password, and upload the zip over
SFTP / FTP / FTPS / SMB. Every log line and step status is live in the UI.

## Run

```bash
./run.sh            # creates .venv, installs requirements, serves http://127.0.0.1:8090/
```

Requirements on the host: Python 3.12, git, Docker (usable by the current user),
optionally `gh` CLI.
Optional: `GITHUB_CLIENT_ID=<oauth app client id> ./run.sh` enables "Sign in with GitHub (device flow)".
Optional: `GITLAB_URL`, `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET`, `BP_ENV_FILE` (see below).

## Use

1. **Sign in**: "Continue with GitLab" (OAuth, see below) or a GitLab access token; or, below the divider, GitHub
   (Personal Access Token, "Use gh CLI token", or the device flow).
2. **New build**: service name, repo (from your list or any git URL / local path), branch, Dockerfile path,
   optional build command, optional extra repos, zip password (twice), "Upload after zip".
3. Watch the steps: prepare -> clone -> build -> save -> extra_repos -> zip -> upload, with live logs.
4. Download the `.zip` / `.tar`, or find them on disk:

```
data/workspace/<service>_<YYYYMMDD_HHMMSS>/          repo, extra repos, <service>_<ts>.tar
data/workspace/<service>_<YYYYMMDD_HHMMSS>.zip       AES-256, password-protected
data/jobs/<job_id>.json | .log                       job state and full log
data/config.json                                     tokens + upload settings (chmod 600)
```

5. **Upload settings**: protocol, host, port, user, password or SSH key path (SFTP), share + domain (SMB), remote dir.
   "Test connection" checks login + remote dir and writes/deletes a probe file. When upload is disabled the step is
   `skipped`. Every protocol uploads `<name>.zip.part` and renames it at the end, so a watcher never sees a half file.

Open the zip with 7-Zip / `7z x file.zip` (standard `unzip` does not support AES).

The GitHub token is only sent for `https://github.com/` URLs, is masked as `***` in all logs and is never
returned by the API. The zip password is never stored or logged. The server binds to 127.0.0.1 only.

## GitLab sign-in

The GitLab URL is `GITLAB_URL` (environment or `.env`), the URL typed on the sign-in screen, or the default
`http://192.168.33.175`. A token is only used for the URL it was issued for: changing the URL signs you out of GitLab.

- **Access token:** a personal access token with `read_api` + `read_repository` (`api` to read CI/CD variables
  for "From GitLab CI").
- **OAuth (Continue with GitLab):** register **one application in GitLab for both tools** (Build Packager and Swarm
  Deployer): GitLab → User settings (or Admin) → Applications → add application with redirect URIs
  `http://127.0.0.1:8090/api/auth/gitlab/callback` and `http://127.0.0.1:8095/api/auth/gitlab/callback`,
  scope `api`, **Confidential off** (PKCE). Put its Application ID in `GITLAB_CLIENT_ID` (environment, `.env`, or
  Settings → GitLab). Open the tool as `http://127.0.0.1:8090` (a `localhost` callback is rewritten to `127.0.0.1`).
  The access token is refreshed automatically; when GitLab rejects the refresh you are signed out.

Tokens live only in `data/config.json` (chmod 600), are masked as `***` in logs and never returned by the API.
Clone injects `oauth2:<token>@` only for URLs on the configured GitLab host; the token never lands in `.git/config`,
the zip or the image. GitHub sign-in works as before and is used for `https://github.com/` URLs.

## `.env` for the build

Step "Build settings" → `.env for the build`:

- **File or paste:** the content you give.
- **From GitLab CI:** reads the branch's `.gitlab-ci.yml`, finds the job (default `export_env`) whose script writes
  `.env` with a heredoc (`cat <<EOF >> .env … EOF`), and fills `$VAR` / `${VAR}` from the project's CI/CD
  variables, then its groups (nearest first), then the job's and the file's `variables:`, then predefined `CI_*`
  values. Missing (or GitLab "hidden") variables are listed; you can edit the result.

The content is written to `<repo>/.env` (Advanced: `.env path in the repo`) with mode 644 right before
`docker build`, and removed again afterwards, so only the image contains it. It is never saved, logged or put in the
job json (only key names and the count); secret-looking values are masked in the build log.

**Images to load before the build** (Advanced, `preload_tars`): absolute paths of `docker save` tars on this
computer, `docker load -i`'d before the build — the CI's offline base image `/app/python.tar`.

**`.deploy/healthcheck.sh`:** when the repo has it, it is copied to `<service>_<ts>/.deploy/healthcheck.sh` in the
zip. Swarm Deployer runs it as `bash healthcheck.sh --url=<health_url> --service=<svc>` after the update.

## SMB upload

Protocol `smb` (port 445): host, user, password, optional domain (`DOMAIN\user`), **share** (required, e.g.
`releases`) and remote dir (a folder inside the share, created if missing). Uses `smbprotocol`. The remote path is
shown as `smb://host:445/<share>/<dir>/<name>.zip`.

## `.env` setup ("make everything automatic")

At startup `BP_ENV_FILE` (default `./.env` next to `app.py`) is imported into the settings when its content changed
since the last import. Settings → "Import .env" does the same for an uploaded or pasted file. Only setting names are
reported back, never values. One `.env` can configure both tools: Swarm Deployer keys are ignored here.

| `.env` key | sets |
|---|---|
| `GITLAB_URL` | GitLab URL |
| `GITLAB_TOKEN` | GitLab access token (signs in as a token user; the login is fetched in the background) |
| `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET` | OAuth application (secret optional, PKCE) |
| `FILE_SERVER_PROTOCOL` | `sftp` \| `ftp` \| `ftps` \| `smb` (the port follows: 22/21/445 unless `FILE_SERVER_PORT` is set) |
| `FILE_SERVER_HOST`, `FILE_SERVER_PORT`, `FILE_SERVER_USER`, `FILE_SERVER_PASSWORD` | upload host, port, user, password |
| `FILE_SERVER_DOMAIN`, `FILE_SERVER_SHARE` | SMB domain and share |
| `FILE_SERVER_REMOTE_DIR` | remote dir (inside the share for SMB) |
| `FILE_SERVER_KEY_PATH` | SFTP private key path |
| `BP_UPLOAD_ENABLED` | upload on/off (default on when `FILE_SERVER_HOST` is given) |
| `SD_*`, `CI_*`, `BASE_*`, `SERVICE_NAME`, `HEALTHCHECK_URL`, `DEV_IMAGE_TAG`, `ZIP_PASSWORD`, anything else | ignored (Swarm Deployer keys) |

Values may be quoted (`"..."` with `\n`, or `'...'` literal, both may span lines); `export KEY=...` works.

## Structure

```
app.py                     entry point: `uvicorn app:app` (imports backend.main)
backend/                   FastAPI backend
  main.py                  app, middleware (cross-site, trusted host), routers, startup
  api/schemas.py           request bodies (pydantic)
  api/routes/              one router per area: auth (GitLab + GitHub sign-in), gitlab (settings, projects,
                           branches, .env preview), github, upload (settings + test), jobs (builds, logs,
                           downloads), env (.env import), ui (serves the static files in frontend/)
  core/                    paths (data layout), enums (JobStatus, Step, Protocol, ...), constants, patterns
                           (validation regexes), errors (StepFailed, Skip, bad -> HTTP 400)
  utils/                   dates, files (atomic private JSON)
  config/store.py          config.json load / locked update
  validators/              fields, manifest (deploy.yml), upload (file server settings)
  github/client.py         GitHub API + token storage
  gitlab/client.py         GitLab API + token refresh
  envfile/                 parser (.env), gitlab_ci (.gitlab-ci.yml export_env -> .env), apply (settings)
  remote/upload.py         SFTP / FTP / FTPS / SMB upload (atomic .part rename)
  jobs/                    store (job files), runner (build steps), manager (restart recovery)
frontend/                  static UI: plain HTML, CSS and browser-native JS modules (no npm, no build step)
  index.html               page shell, icon sprite, toast / dialog / live-region hosts
  app.css                  design tokens (light + dark via prefers-color-scheme), base, components, screens
  js/main.js               boot (auth status), top bar, route -> page (each page returns a cleanup)
  js/state.js              API client + endpoints (401 handling), auth, per-tab session caches, wizard draft
                           (sessionStorage minus passwords), hash router (#/login #/dashboard #/new/<step>
                           #/jobs/<id> #/settings) with redirects and leave guards
  js/ui.js                 h() element helper, icons, fields, toasts, confirm dialog, menus, formatting
  js/lib.js                validation, job helpers, delete dialog
  js/login.js  dashboard.js  wizard.js (shell, rebuild)  steps.js (wizard steps)  run.js (live log)  settings.js
tests/e2e_test.py          API + pipeline end-to-end (176 checks)
tests/ui_test.py           Playwright browser flow (138 checks)
```

## Develop

```bash
./run.sh                                   # backend on :8090, also serves the UI from frontend/
.venv/bin/python tests/e2e_test.py
<playwright venv>/bin/python tests/ui_test.py
```
The UI has no build step: edit `frontend/` and reload the page (HTML/CSS/JS are served with `Cache-Control: no-cache`).
Server data is only ever inserted as text (`textContent` / `h()` children), never as HTML.
