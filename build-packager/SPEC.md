# Build Packager — SPEC

A local web tool: sign in with GitHub, pick repo + branch, clone, build a Docker image, save it as `.tar`, fetch extra repos into the same folder, AES-zip only the image `.tar` (plus `deploy.yml` when present; source repos stay in the local folder) with a password, and upload it over SFTP/FTP/FTPS. Every log line and step status shows live in the UI.

Backend and frontend are built in parallel from this file. If something is not in this file, it is out of scope.

## 1. Stack and files

| Path | Purpose |
|---|---|
| `app.py` + `backend/` | FastAPI app (`app.py` is the entry point; modules in `backend/`, see README Structure). Serves the built UI: `frontend/dist/index.html` at `GET /` (503 with a hint if not built) and `frontend/dist/assets/*` at `GET /assets/{name}`. |
| `frontend/` | UI: plain HTML, CSS and vanilla JavaScript (`index.html`, `app.css`, `js/*.js`), served as-is. No npm, no build, no CDN. |
| `../shared-ui/` | `@devtools/ui`, the design system shared with Swarm Deployer (tokens, components, hooks), consumed as TypeScript source. |
| `requirements.txt` | `fastapi`, `uvicorn`, `pyzipper`, `paramiko`, `httpx` (GitHub and GitLab API calls), `pyyaml`, `smbprotocol` (SMB upload, §11.6). |
| `run.sh` | Creates `.venv` with `python3 -m venv .venv` if it is missing, runs `pip install -r requirements.txt`, builds the UI (`npm ci` + `npm run build` in `frontend/`) when `frontend/dist` is missing or older than its sources, then `exec .venv/bin/uvicorn app:app --host 127.0.0.1 --port 8090`. |
| `README.md` | How to run it and how to use it. |
| `data/` | Created at startup if missing. |

Data layout under `data/`:
```
data/config.json                     chmod 600
data/jobs/<job_id>.json              job metadata + steps
data/jobs/<job_id>.log               full log (plain text, token-masked)
data/workspace/<service>_<ts>/       output folder
data/workspace/<service>_<ts>.zip    AES-256 zip
```
- `<ts>` is the local time when the job was created, formatted `YYYYMMDD_HHMMSS`, for example `20261102_185400`.
- `<job_id>` is `uuid4().hex`, which is 32 lowercase hex characters.

Bind to 127.0.0.1 only. There is no DB, no ORM and no app-level login gate: the tool is local and has a single user (GitHub/GitLab sign-in only feeds repo lists and clone tokens).

## 2. Conventions

- All bodies are JSON (`Content-Type: application/json`), except SSE and the file downloads.
- Every error response is `{"detail": "<human message>"}` with a status code:
  - `400`: bad input or validation failure.
  - `401`: no GitHub/GitLab token, or GitHub/GitLab rejected the token.
  - `404`: unknown job or file.
  - `409`: wrong state (for example, the artifact does not exist yet).
  - `502`: an upstream call failed (GitHub/GitLab API, upload connection test).
  - FastAPI's default `422` is also acceptable for a malformed body.
- Timestamps in JSON are ISO-8601 local time with seconds, for example `"2026-11-02T18:54:00"`, or `null`.
- **Secrets:** no API response ever contains the GitHub token or the upload password. The zip password is never written to disk or logs and is never returned. Wherever a stored secret would appear, the API returns a boolean such as `has_token` or `has_password`.

### Validation rules (enforced by the backend; the frontend should mirror them)

| Field | Rule |
|---|---|
| `service` | `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$` |
| `branch` | `^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$`. It must not contain `..` or `//`, must not end with `/` or `.lock`, and must not start with `-`. |
| `repo_url` | A non-empty string with at most 500 characters, no whitespace and no leading `-`. Accepted forms: `https://…`, `http://…`, `ssh://…`, `git@host:path`, `file://…`, or an absolute local path starting with `/`. |
| extra repo `name` | Optional. Same regex as `service`. If omitted, it is derived from the URL basename with `.git` stripped. The derived name must also match the regex, otherwise the request is rejected with `400`. It must be unique within the job and must not equal the main repo dir name or `<service>_<ts>.tar`. |
| `dockerfile` | A relative path. Default `"Dockerfile"`. It must not be absolute and must not contain `..`. |
| `build_command` | Optional free text, at most 2000 characters. It runs with `shell=True` in the repo dir. This is the **only** shell use. |
| `password` / `password_confirm` | Both required. They must be equal and have at least 4 characters. |
| upload `protocol` | One of `sftp`, `ftp`, `ftps`, `smb` (§11.6). |
| upload `port` | 1–65535. Default 22 for `sftp`, 21 for `ftp` and `ftps`, 445 for `smb`. |
| upload `share` / `domain` | §11.6: share required for `smb` with a host (`^[A-Za-z0-9][A-Za-z0-9 _.$-]{0,79}$`); domain `""` or `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. |
| GitLab URL, project, `env`, `preload_tars` | §11.1, §11.4, §11.5. |

Every other subprocess call uses an argv list. Git calls put `--` before user-controlled positional arguments where git allows it.

### Token injection and masking

- The token is injected **only** when the URL starts with `https://github.com/`. The clone URL becomes `https://x-access-token:<TOKEN>@github.com/<rest>`. **[§11.5]** A GitLab token is injected as `oauth2:<TOKEN>@` only for URLs whose scheme+host equal the configured GitLab URL (no userinfo). Every other URL is used unchanged.
- **[§11.5]** The mask list is the GitHub token, the GitLab token and the secret-looking `.env` values; clone runs `git -c credential.helper= clone …`.
- Before any line is written to the log file or SSE, every occurrence of the token is replaced with `***`. This applies to every log line, including echoed commands and subprocess output.
- Environment for git subprocesses: `GIT_TERMINAL_PROMPT=0`.

## 3. config.json schema

```json
{
  "github_token": "ghp_... | gho_... | null",
  "github_login": "octocat | null",
  "github_avatar_url": "https://... | null",
  "upload": {
    "enabled": false,
    "protocol": "sftp",
    "host": "",
    "port": 22,
    "username": "",
    "password": "",
    "remote_dir": "/",
    "private_key_path": "",
    "domain": "",
    "share": ""
  }
}
```
- **[§11.1]** Also `gitlab_url`, `gitlab_token`, `gitlab_token_url`, `gitlab_refresh_token`, `gitlab_expires_at`, `gitlab_login`, `gitlab_avatar_url`, `gitlab_method`, `gitlab_redirect_uri`, `gitlab_client_id`, `gitlab_client_secret`, `env_import_sha`, `env_import_at`.
- If the file is missing, all of the values above are the defaults.
- After every write, run `os.chmod(path, 0o600)`.
- `private_key_path` is SFTP only and optional. If it is set, it is used instead of, or as well as, `password`.
- `ftps` uses `ftplib.FTP_TLS` with explicit TLS and calls `prot_p()`.

## 4. REST API

### 4.1 UI
| Method | Path | Response |
|---|---|---|
| GET | `/` | `frontend/dist/index.html` (text/html); `GET /assets/{name}` serves the bundle |

### 4.2 GitHub auth

**[patch §11.3]** `/api/auth/status` gains `provider`, `github`, `gitlab`, `oauth_error`; logout also clears GitLab. GitLab routes: §11.3–§11.4.

**GET `/api/auth/status`**
→ 200
```json
{"logged_in": true, "login": "octocat", "avatar_url": "https://...", "device_flow_available": false}
```
- `logged_in` means a token is stored. `login` and `avatar_url` come from the cached values in config, or are `null`.
- `device_flow_available` is `true` when the env var `GITHUB_CLIENT_ID` is non-empty.

**POST `/api/auth/token`**: save a PAT.
Request: `{"token": "ghp_xxx"}`
- The backend validates it with `GET https://api.github.com/user` (headers `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`).
- On 200 it saves `github_token`, `github_login` and `github_avatar_url`.
- → 200 `{"logged_in": true, "login": "...", "avatar_url": "..."}`
- Errors: 400 if the token is empty; 401 if GitHub rejects it; 502 if GitHub is unreachable.

**POST `/api/auth/gh-cli`**: no body.
- Runs `gh auth token` with an argv list and a 10s timeout, then validates and saves exactly as `/api/auth/token` does.
- → 200 same shape.
- Errors: 400 `{"detail": "gh CLI not available or not logged in"}` if gh exits non-zero or is missing; 401 or 502 as above.

**POST `/api/auth/device/start`**: no body.
- 400 if `GITHUB_CLIENT_ID` is not set.
- Calls `POST https://github.com/login/device/code` with form `client_id=<id>&scope=repo` and header `Accept: application/json`.
- → 200 `{"device_code": "...", "user_code": "ABCD-1234", "verification_uri": "https://github.com/login/device", "interval": 5, "expires_in": 900}`
- Errors: 502 on upstream failure.

**POST `/api/auth/device/poll`**
Request: `{"device_code": "..."}`
- Calls `POST https://github.com/login/oauth/access_token` with form `client_id`, `device_code` and `grant_type=urn:ietf:params:oauth:grant-type:device_code`, header `Accept: application/json`.
- → 200, one of:
  - `{"status": "pending"}` when GitHub returns `authorization_pending`.
  - `{"status": "slow_down", "interval": 10}` when GitHub returns `slow_down`.
  - `{"status": "ok", "login": "...", "avatar_url": "..."}` when it returns `access_token`. The backend validates and saves it as `/api/auth/token` does.
  - `{"status": "error", "error": "expired_token | access_denied | ..."}`
- The UI polls every `interval` seconds until the status is `ok` or `error`.

**POST `/api/auth/logout`**: no body.
- Sets `github_token`, `github_login` and `github_avatar_url` to null.
- → 200 `{"logged_in": false}`

### 4.3 GitHub data (all of these require a stored token; 401 if there is none)

**GET `/api/github/repos`**
- Proxies `GET https://api.github.com/user/repos?per_page=100&sort=updated` (first page only).
- → 200 array:
```json
[{"full_name": "owner/repo", "clone_url": "https://github.com/owner/repo.git", "default_branch": "main", "private": true}]
```
- Errors: 401 if GitHub returns 401; 502 for other failures.

**GET `/api/github/branches?repo=owner/repo`**
- `repo` must match `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`, otherwise 400.
- Proxies `GET https://api.github.com/repos/{owner}/{repo}/branches?per_page=100`.
- → 200 `[{"name": "main"}, {"name": "dev"}]`
- Errors: 404 if GitHub returns 404; 401; 502.

The UI may also derive `owner/repo` from a free-text `https://github.com/owner/repo(.git)` URL to load branches. For any other URL, branch is a free-text field.

### 4.4 Upload settings

**[patch §11.6]** Fields gain `domain` and `share`; protocol `smb`; every protocol uploads as `<name>.part` and renames at the end.

**GET `/api/config/upload`**
→ 200
```json
{"enabled": false, "protocol": "sftp", "host": "", "port": 22, "username": "", "remote_dir": "/", "private_key_path": "", "has_password": false}
```

**PUT `/api/config/upload`**
Request: the same fields with `password` in place of `has_password`. All fields are optional, and fields that are omitted keep their current value.
- If `password` is omitted, the stored password is kept. If `password` is `""`, the stored password is cleared.
- Validation:
  - `protocol` must be in the allowed set.
  - `port` must be an int from 1 to 65535.
  - `host` must be non-empty when `enabled` is true.
  - `remote_dir` must be non-empty.
- → 200 same shape as GET.
- Errors: 400.

**POST `/api/config/upload/test`**: no body. Uses the stored settings.
- Connects, logs in, changes to `remote_dir` (creating it if possible), then disconnects. Timeout 15s.
- → 200 `{"ok": true, "message": "Connected to host:port, remote_dir OK"}`
- → 200 `{"ok": false, "message": "<error text>"}` when the connection fails. This case returns 200, not 502, so the UI can show the message.
- Errors: 400 if `host` is empty.

### 4.5 Jobs

**[patch §11.5]** `POST /api/jobs` gains `env` and `preload_tars`. **[§11.7]** `POST /api/config/import-env`.

**POST `/api/jobs`**: create and start a job.
Request:
```json
{
  "service": "myapp",
  "repo_url": "https://github.com/owner/repo.git",
  "branch": "main",
  "dockerfile": "Dockerfile",
  "build_command": "",
  "extra_repos": [{"url": "https://github.com/owner/other.git", "branch": "main", "name": "other"}],
  "password": "secret",
  "password_confirm": "secret",
  "upload": true
}
```
- `dockerfile`, `build_command`, `extra_repos` and `upload` are optional. Their defaults are `"Dockerfile"`, `""`, `[]` and `true`.
- `upload: false` forces the upload step to be skipped for this job, even when upload is enabled in config.
- A GitHub token is **not** required. Without one, https://github.com URLs are cloned without credentials, which works for public repos only.
- → 201 with the job object (§5), status `"running"` or `"queued"`.
- Errors: 400 on any validation failure. The `detail` names the field, for example `"service: invalid name"` or `"password: must match confirmation"`.
- The job runs in a background `threading.Thread`. Several jobs may run concurrently. Each job has its own folder because of `<ts>`. If two jobs for the same service are created in the same second, the second one gets a 409, which the UI shows as an error.

**GET `/api/jobs`**
- → 200 array of job objects, newest first by `created_at`.

**GET `/api/jobs/{id}`**
- → 200 job object.
- Errors: 404 if the job is unknown. The id must match `^[0-9a-f]{32}$`, otherwise 404.

**GET `/api/jobs/{id}/log`**
- → 200 `text/plain` with the full log file.
- Errors: 404.

**GET `/api/jobs/{id}/logs/stream`**: SSE, see §6.
- Errors: 404 if the job is unknown.

**GET `/api/jobs/{id}/download/zip`**
- → 200 `application/zip`, `Content-Disposition: attachment; filename="<service>_<ts>.zip"`.
- Errors: 404 if the job is unknown; 409 `{"detail": "zip not available"}` if the file does not exist.

**GET `/api/jobs/{id}/download/tar`**
- → 200 `application/x-tar`, filename `<service>_<ts>.tar`.
- Errors: 404 or 409 as for the zip.

**DELETE `/api/jobs/{id}`**
- Deletes the job json, its log, its workspace folder and its zip.
- → 200 `{"deleted": true}`
- Errors: 404; 409 if the job is still running.

## 5. Job JSON schema (`data/jobs/<id>.json` and the API response are identical)

```json
{
  "id": "3f2a...32hex",
  "service": "myapp",
  "ts": "20261102_185400",
  "folder_name": "myapp_20261102_185400",
  "repo_url": "https://github.com/owner/repo.git",
  "branch": "main",
  "dockerfile": "Dockerfile",
  "build_command": "",
  "extra_repos": [{"url": "...", "branch": "main", "name": "other"}],
  "upload_requested": true,
  "image_tag": "myapp:20261102_185400",
  "status": "queued | running | success | failed",
  "error": null,
  "created_at": "2026-11-02T18:54:00",
  "finished_at": null,
  "steps": [
    {"name": "prepare",     "status": "pending", "started_at": null, "finished_at": null, "message": ""},
    {"name": "clone",       "status": "pending", "started_at": null, "finished_at": null, "message": ""},
    {"name": "build",       "status": "pending", "started_at": null, "finished_at": null, "message": ""},
    {"name": "save",        "status": "pending", "started_at": null, "finished_at": null, "message": ""},
    {"name": "extra_repos", "status": "pending", "started_at": null, "finished_at": null, "message": ""},
    {"name": "zip",         "status": "pending", "started_at": null, "finished_at": null, "message": ""},
    {"name": "upload",      "status": "pending", "started_at": null, "finished_at": null, "message": ""}
  ],
  "artifacts": {"tar": false, "zip": false, "tar_size": 0, "zip_size": 0, "remote_path": null}
}
```
- `repo_url` is stored as the user typed it. The token never appears in it.
- The service name is lowercased for the Docker tag only, because Docker requires it: `image_tag` is `<service.lower()>:<ts>`. File and folder names keep the original case.
- Step `status` is one of `pending | running | success | failed | skipped`.
- `message` is a short result line, for example `"image myapp:20261102_185400 built"`, `"skipped: no extra repos"`, `"skipped: upload disabled"`, or the error text.
- `error` is the failed step's message when the job failed, otherwise `null`.
- The job json is rewritten on every step transition.
- When the job starts, the backend sets `status` to `running`. If the process restarts, jobs still marked `running` or `queued` are marked `failed` with `error: "interrupted (server restart)"`.

### Pipeline (strict order; the first failure stops the job)

When a step fails, its status becomes `failed`. All steps after it stay `pending`, the job status becomes `failed` and `finished_at` is set. If every step ends as `success` or `skipped`, the job is `success`.

`F` = `data/workspace/<service>_<ts>`. `repo_name` = the basename of `repo_url` with `.git` stripped. If that is invalid against the service regex, `repo_name` is `"repo"`.

1. **prepare**: `mkdir F`. If `F` already exists, the step fails.
2. **clone** (**[§11.5]**: also copies `.deploy/healthcheck.sh`): `git -c credential.helper= clone --depth 1 --branch <branch> --single-branch -- <url_with_token_if_github> F/<repo_name>`. Fails on a non-zero exit.
3. **build** (**[§11.5]**: `preload_tars` are loaded, then the `.env` is written, and removed again after the build):
   - If `build_command` is non-empty, run it with `shell=True` and `cwd=F/<repo_name>`. Fails on a non-zero exit.
   - If `F/<repo_name>/<dockerfile>` does not exist, the step **fails** with `"Dockerfile not found: <dockerfile>"`.
   - Otherwise run `docker build -t <image_tag> -f F/<repo_name>/<dockerfile> F/<repo_name>`. Fails on a non-zero exit.
4. **save**: `docker save -o F/<service>_<ts>.tar <image_tag>`. On success set `artifacts.tar = true` and `tar_size` to the size in bytes.
5. **extra_repos**:
   - If the list is empty: `skipped` with message `"skipped: no extra repos"`.
   - Otherwise, for each entry in order, run `git clone --depth 1 --branch <b> --single-branch -- <url> F/<name>`, with the same token rule as clone. The step fails on the first failure.
6. **zip**:
   - Use `pyzipper.AESZipFile(F + ".zip", "w", compression=ZIP_DEFLATED, encryption=WZ_AES)` with `setpassword(password)` and AES-256, which is the pyzipper default strength.
   - Only the image tar, `deploy.yml` (if present) and `.deploy/healthcheck.sh` (if present) are added, as `<service>_<ts>/<name>`. Source repos stay in the local folder. Symlinks are skipped.
   - On success set `artifacts.zip = true` and `zip_size`.
   - After this step the password is dropped from memory: the reference is deleted. It is never persisted.
7. **upload**:
   - If `upload_requested` is false, or `config.upload.enabled` is false: `skipped` with message `"skipped: upload disabled"`.
   - If upload is enabled but `host` is empty: `skipped` with message `"skipped: upload not configured"`.
   - `sftp`: paramiko `SSHClient` with `AutoAddPolicy`, then `connect(host, port, username, password or None, key_filename=private_key_path or None, timeout=15)` and `open_sftp()`. Create `remote_dir` if it is missing (mkdir -p semantics), then `put(F.zip, remote_dir/<service>_<ts>.zip, callback=progress)`.
   - `ftp`: `ftplib.FTP()`, `connect(host, port, timeout=15)`, `login`, then `cwd` to `remote_dir`, creating it if it is missing. Then `storbinary("STOR <service>_<ts>.zip", f, callback=progress)`.
   - `ftps`: `ftplib.FTP_TLS`, the same as `ftp`, plus `prot_p()` after login.
   - Progress is logged at most once per 10% of the file.
   - `smb`: §11.6.
   - Every protocol writes `<name>.part` and renames it at the end; a failed upload removes the `.part`.
   - On success set `artifacts.remote_path`, for example `"sftp://host:22/remote_dir/myapp_20261102_185400.zip"` or `"smb://host:445/share/remote_dir/myapp_….zip"`.
   - Exceptions fail the step, and the error text is put in `message`.

### Log format (`data/jobs/<id>.log`)

Each line has the form `[HH:MM:SS] <text>`. The backend writes:
- `==> [step] started` at the start of each step and `==> [step] success|failed|skipped: <message>` at the end.
- Each external command, before it runs, as `$ <argv joined by spaces>`. The token is masked, and the zip password is never included.
- Every stdout and stderr line of a subprocess as it arrives. The two streams are merged with `stderr=STDOUT`, `bufsize=1`, text mode, and the output is read line by line.
- Last line: `==> JOB SUCCESS` or `==> JOB FAILED: <error>`.

## 6. SSE: `GET /api/jobs/{id}/logs/stream`

`Content-Type: text/event-stream`, `Cache-Control: no-cache`. Each event is sent as:
```
event: <type>
data: <payload>

```
Event types:
- `log`: `data` is one raw log line, without its trailing newline. Log lines never contain a newline.
- `status`: `data` is the full job object (§5) as single-line JSON. It is sent once immediately after connecting (after the replay), then again whenever the job json changes.
- `end`: `data` is `{"status": "success" | "failed"}`. It is sent once, after the final `log` lines and the final `status`. The server then closes the stream.

Behaviour:
- On connect, the server replays the whole existing log as `log` events and then follows the file. It polls about every 0.3s for new lines and for changes to the job json, by mtime or content.
- If the job has already finished, the server replays the log, sends `status`, sends `end`, and closes.
- A `: ping` comment line is sent every 15s while idle.
- The UI uses `EventSource`. When it receives `end`, it calls `es.close()` to stop auto-reconnect.

## 7. UI (`frontend/`, React single-page app; see UX.md)

The page has these sections, top to bottom:

1. **Header**
   - App name.
   - When logged in: the GitHub avatar (32px, round), `@login` and a "Logout" button.
   - When logged out: "Not signed in".

2. **GitHub sign-in card** (shown when logged out; collapsed when logged in)
   - Token field (`type=password`) with a "Save token" button.
   - "Use gh CLI token" button.
   - "Sign in with GitHub (device flow)" button, shown only if `device_flow_available` is true. Clicking it shows `user_code` large, with a link to `verification_uri` (target `_blank`) and a "Waiting for authorization…" status, then polls.
   - Errors are shown inline in red.

3. **New build card**
   - Service name, with a pattern hint.
   - Repo selector:
     - A `<select>` filled from `/api/github/repos` when logged in.
     - Choosing a repo fills the repo URL field (`clone_url`) and the service name if that is still empty (the repo name, sanitised).
     - The repo URL field is always editable free text.
   - Branch:
     - For GitHub URLs, a `<select>` filled from `/api/github/branches`. The default selection is the repo's `default_branch`.
     - Otherwise, or if loading fails, a text input with default `main`.
   - Dockerfile path (default `Dockerfile`).
   - Custom build command (optional textarea).
   - Extra repos list: rows of url, branch and optional name, with "+ Add repo" and "remove" buttons per row.
   - Zip password and confirm password, both `type=password`. The page validates on the client that they match and have at least 4 characters.
   - "Upload after zip" checkbox. It is checked by default, and disabled with the hint "upload not configured" when the upload config is not enabled.
   - "Start build" button. It is disabled while the request is in flight. A 400 `detail` is shown inline.

4. **Upload settings card** (FileZilla-like, collapsible)
   - Fields: enabled toggle, protocol (SFTP, FTP, FTPS) and port.
   - Changing the protocol sets the default port, unless the user has edited the port.
   - Host, username, and a password field. The password placeholder reads "(saved)" when `has_password` is true; leaving it blank keeps the saved password.
   - Private key path (SFTP only), remote dir.
   - "Save" and "Test connection" buttons. The test result is shown inline in green for ok and red for failure.

5. **Current job panel**
   - Shown after start, or when a job is clicked in history.
   - Job id, folder name, overall status badge.
   - Step list with an icon and colour per step status:
     - pending: grey ○
     - running: blue spinner ◐
     - success: green ✓
     - failed: red ✗
     - skipped: grey –
   - Each step also shows its duration and message.
   - Log viewer:
     - Monospace, dark background, fixed height about 400px, scrollable.
     - Auto-scrolls to the bottom unless the user has scrolled up.
     - Lines containing `failed`, `error` or `JOB FAILED` are tinted red. `==>` lines are bold.
   - "Download .zip" and "Download .tar" buttons, enabled when the matching artifact flag is true.
   - The panel connects via SSE and updates steps from `status` events.

6. **History table**
   - Columns: created, service, branch, status, and action buttons ("view", "delete").
   - "delete" is disabled while the job is running.
   - The table refreshes on page load and whenever a job ends.

Responsive down to 375px width. All dynamic text is inserted via `textContent`, never `innerHTML`, so a log line cannot inject HTML.

## 8. Acceptance criteria

Setup and security
- **AC-1** On a clean checkout, `./run.sh` creates `.venv`, installs the requirements and serves the UI at `http://127.0.0.1:8090/`. `GET /` returns 200 HTML.
- **AC-2** The server listens on 127.0.0.1 only: `ss -ltnp` shows `127.0.0.1:8090`, not `0.0.0.0`.
- **AC-3** After any auth or upload save, `data/config.json` exists with mode `600`.
- **AC-4** No API response contains the GitHub token or the upload password. Check by grepping all responses from `/api/auth/*`, `/api/config/upload`, `/api/jobs*` for the token string.

GitHub auth
- **AC-5** `POST /api/auth/token` with an invalid token returns 401. With a valid token it returns 200 with `login`. `/api/auth/status` then reports `logged_in: true` and the UI shows the avatar and `@login`.
- **AC-6** `POST /api/auth/gh-cli` returns 200 with the gh user's login.
- **AC-7** Without `GITHUB_CLIENT_ID`, `device_flow_available` is false, the device button is hidden, and `POST /api/auth/device/start` returns 400.
- **AC-8** When logged in, `GET /api/github/repos` returns an array of objects with `full_name` and `clone_url`. `GET /api/github/branches?repo=<a real repo>` returns names including the default branch. `repo=../x` returns 400.
- **AC-9** `POST /api/auth/logout` makes `logged_in` false, and `/api/github/repos` then returns 401.

Validation
- **AC-10** `POST /api/jobs` returns 400 for each of these:
  - service `"-bad"` or `"a b"`
  - branch `"--upload-pack=x"` or `"a..b"`
  - mismatched passwords
  - a password of 3 characters
  - dockerfile `"../x"`
  - duplicate extra repo names

Pipeline: happy path. Use a local fixture repo (`file:///…` or `/abs/path`) containing a `Dockerfile` such as `FROM busybox` plus `CMD ["true"]`, and one extra local repo.
- **AC-11** The job reaches `success`. Steps prepare, clone, build, save, extra_repos and zip are `success`. Upload is `skipped` with message `"skipped: upload disabled"` when upload is not enabled.
- **AC-12** The folder `data/workspace/<service>_<YYYYMMDD_HHMMSS>/` exists. The name matches `^<service>_\d{8}_\d{6}$` and contains `<repo_name>/`, `<extra_name>/` and `<service>_<ts>.tar`.
- **AC-13** The `.tar` is a valid Docker image archive: `docker load -i` succeeds, or `tar tf` lists `manifest.json`. `docker image inspect <service>:<ts>` succeeds.
- **AC-14** The `.zip` exists:
  - With pyzipper, opening it without a password, or with the wrong one, raises an error.
  - With the correct password, every entry name starts with `<service>_<ts>/` and the tar can be extracted.
  - The entries use AES encryption (pyzipper reports compress_type 99 / WZ_AES).
- **AC-15** `GET /api/jobs/{id}/download/zip` and `/download/tar` return 200 and the right `Content-Disposition` filename. For a job without the artifact they return 409, and for an unknown id 404.

Pipeline: failure paths
- **AC-16** A non-existent branch makes clone `failed`, the job `failed`, all later steps `pending`, and `error` set.
- **AC-17** A repo without a Dockerfile makes build `failed` with a message containing `Dockerfile not found`.
- **AC-18** A `build_command` of `exit 3` makes build `failed`. A `build_command` of `echo HELLO_BUILD` puts `HELLO_BUILD` in the log, and the build continues.
- **AC-19** With no extra repos, extra_repos is `skipped`.

Logs and SSE
- **AC-20** `curl -N /api/jobs/{id}/logs/stream` on a running job shows `event: log` lines arriving live, `event: status` events with changing step statuses, and finally `event: end`, after which the connection closes.
- **AC-21** Connecting to the stream of a finished job replays the complete log, then `status`, then `end`.
- **AC-22** The log contains `==> [step] started` and a result line for every step it reached, each `$ ` command line, the docker build output, and `==> JOB SUCCESS` or `==> JOB FAILED: …`.
- **AC-23** For an https://github.com URL with a token stored, neither the token nor the zip password appears in `data/jobs/<id>.log`, `data/jobs/<id>.json` or any SSE output. The masked clone command shows `***`.

Upload
- **AC-24** `PUT /api/config/upload` round-trips every field. GET shows `has_password: true` and never shows `password`. Omitting `password` on a later PUT keeps the stored password.
- **AC-25** `POST /api/config/upload/test` against an unreachable host returns 200 `{"ok": false, "message": …}` within about 20s.
- **AC-26** When upload is enabled and points at a reachable SFTP server (or a local test FTP server, such as `python -m pyftpdlib` installed in a scratch venv), the upload step succeeds, the remote file exists with the same size as the local zip, and `artifacts.remote_path` is set. When the upload fails, the step is `failed` and so is the job.

UI
- **AC-27** In the browser the full flow works without the console: sign in, pick repo, pick branch, enter the password twice, start, watch live logs and step icons, download zip and tar. The history shows the job and "view" reopens its logs.
- **AC-28** A mismatched or short password is blocked on the client before the request is sent, with an inline message.
- **AC-29** A log line containing `<b>x</b>` renders as literal text.
- **AC-30** `DELETE /api/jobs/{id}` on a finished job removes its json, log, folder and zip. On a running job it returns 409.

New criteria BP-AC-40..47 for GitLab, `.env`, preload tars, healthcheck.sh and SMB are in §11.9.

## 9. Changes (2026-11-02): remote path + connection test

- `remote_dir` must be a full path starting with `/`; `..` segments and control characters are rejected with 400 (`remote_dir: ...`). Missing folders are created on upload (SFTP and FTP/FTPS) and each one is logged as `created remote folder <path>`.
- `POST /api/config/upload/test` takes an optional body with the same fields as `PUT /api/config/upload`. Those values override the saved settings for this test only and are not saved; a blank `password` keeps the saved one. The test connects, creates the remote path if needed, then writes and deletes a probe file. Response: `{ok, message, created: [paths created]}`.
- `POST /api/jobs` accepts an optional `remote_dir`, which overrides the settings' path for that build. It is stored on the job as `remote_dir` (null = use the settings).

## 10. deploy.yml (2026-11-03)

After `clone`, a root `deploy.yml` (or `deploy.yaml`, not both) in the main repo is parsed and validated: keys ⊆
{service, image, target, health_url, moving_tag}, all strings; `service` = swarm service name, `image` = lowercase
docker repo, `target` = target id, `health_url` = http(s) URL, `moving_tag` = docker tag or the literal `@current` (§11.1). Invalid → the clone step
fails with `deploy.yml: <reason>`. Valid → copied to `<folder>/deploy.yml` (zip: `<service>_<ts>/deploy.yml`) and
stored as job field `deploy_manifest` (null when absent; "no deploy.yml" is logged). The run view's result card shows
`deploy.yml: service X · image Y`. Swarm Deployer reads it to know which swarm service to update.

## 11. GitLab sign-in, .env for the build, preload tars, healthcheck.sh, SMB upload (2026-11-03)

This addendum merges into `build-packager/SPEC.md` as a new section; the sections it modifies are marked **[patch]**. Decisions come from `BRIEF.md` D1–D4, D9, D11 and D15. Hard constraints:

- **Steps stay `prepare, clone, build, save, extra_repos, zip, upload` (7).** Tests and the UI pin both the names and the count.
- **GitHub sign-in keeps working.** The flat keys in `/api/auth/status` keep their names and meaning, and `/api/auth/logout` still returns exactly `{"logged_in": false}`.
- **No API gate.** Jobs can run without signing in, as they do today.

### 11.1 Config (flat keys) **[patch config]**

`load_config()` gets these defaults:

```python
{"github_token": None, "github_login": None, "github_avatar_url": None,
 "gitlab_url": "", "gitlab_token": None, "gitlab_token_url": "", "gitlab_refresh_token": None, "gitlab_expires_at": None,
 "gitlab_login": None, "gitlab_avatar_url": None, "gitlab_method": None, "gitlab_redirect_uri": "",
 "gitlab_client_id": "", "gitlab_client_secret": "",
 "env_import_sha": "", "env_import_at": None,
 "upload": DEFAULT_UPLOAD}
DEFAULT_UPLOAD = {"enabled": False, "protocol": "sftp", "host": "", "port": 22, "username": "", "password": "",
                  "remote_dir": "/", "private_key_path": "", "domain": "", "share": ""}
```

How each setting is resolved:

- **GitLab base URL:** `gl_base()` returns the first non-empty of `cfg.gitlab_url`, `$GITLAB_URL` and `"http://192.168.33.175"`, with the trailing `/` stripped.
- **OAuth client:** the client id is `cfg.gitlab_client_id or $GITLAB_CLIENT_ID`, and the secret is resolved the same way.
- **`oauth_available`:** true when a client id is set.
- **Signed in to GitLab:** `gl_signed_in(cfg)` = `bool(gitlab_token) and gitlab_token_url == gl_base()`, the same rule as
  the deployer's `signed_in`. Status, `need_gitlab()` and the clone token injection all use it, so a token is never
  sent to a GitLab URL other than the one it was issued for. Every path that stores a token stores
  `gitlab_token_url = gl_base()` too; logout clears it.

The validation rules (GitLab URL, project path, `.env` content, SMB share and domain) are the same as in the Swarm Deployer SPEC §11.1.

**deploy.yml rules [patch check_manifest]:** `moving_tag` also accepts the literal `@current`, the same as in the deployer. No other change.

### 11.2 GitLab HTTP

`gl_request(method, path, token=None, data=None)` sits next to `gh_request` and uses the existing httpx client:

- The base is `gl_base()`.
- Headers are `Accept: application/json` plus `Authorization: Bearer <token>`.
- `httpx.HTTPError` raises 502 `GitLab unreachable: <e>`.

`need_gitlab()` returns a valid token or raises 401 `not signed in to GitLab` (when `not gl_signed_in(cfg)`). When `gitlab_expires_at - 60` has passed and a refresh token is stored, it refreshes under `gl_lock`:

- It POSTs `/oauth/token` with `grant_type=refresh_token, refresh_token, client_id, redirect_uri, client_secret?`.
- On success it saves the new access token, refresh token and expiry.
- A 400 or 401 response clears the GitLab session and raises 401 `GitLab session expired, sign in again`.

### 11.3 Auth endpoints (D1) **[patch §4 auth]**

**GET `/api/auth/status`** keeps the existing keys and adds the new ones:

```json
{"logged_in": true, "login": "sdtest-dev", "avatar_url": "…", "device_flow_available": false,
 "provider": "gitlab",
 "github": {"logged_in": false, "login": null},
 "gitlab": {"logged_in": true, "login": "sdtest-dev", "avatar_url": "…", "url": "http://127.0.0.1:18929",
            "method": "oauth", "oauth_available": true},
 "oauth_error": null}
```

- `provider` is `"gitlab"` when `gl_signed_in(cfg)`. Otherwise it is `"github"` when a GitHub token is stored, and `null` when neither is.
- The flat `logged_in` is true when either provider is signed in. The flat `login` and `avatar_url` are the provider's.
- With no GitLab sign-in, the flat values are exactly today's. `t_auth` and `t_logout` stay green.
- `oauth_error` is one-shot: it is returned once and then reset.
- If `gitlab_login` is empty while signed in (for example a token imported from `.env`), the endpoint starts **one background thread per process** that calls `GET /api/v4/user` (5 s timeout) and saves the login. Status never waits for GitLab.

**POST `/api/auth/gitlab/token`** takes `{"token": "...", "url"?: "..."}`.

- On success it returns 200 `{"logged_in": true, "login": ..., "avatar_url": ..., "provider": "gitlab"}`.
- It validates the token with `GET /api/v4/user`.
- Errors:

  | Case | Status | Detail |
  |---|---|---|
  | Empty token | 400 | |
  | Signed in to GitLab and `url` ≠ `gl_base()` | 409 | `sign out first to change the GitLab URL` |
  | GitLab returns 401 | 401 | `GitLab rejected the token` |
  | Other GitLab error | 502 | |

- It saves `gitlab_url` (when a URL is given), `gitlab_token`, `gitlab_token_url=gl_base()`, `gitlab_refresh_token=None`, `gitlab_expires_at=None`, `gitlab_method="pat"`, the login and the avatar.

**GET `/api/auth/gitlab/start`** and **GET `/api/auth/gitlab/callback`** work exactly as in Swarm Deployer §11.2 (same `redirect_uri` rule with `localhost` → `127.0.0.1`, same `token_url` save), with these differences:

- The scope is `api`, **the same as the deployer**: one GitLab application serves both apps (redirect URIs for `127.0.0.1:8090` and `127.0.0.1:8095`, scope `api`, confidential off). `api` also grants git over HTTP, so clone needs nothing more.
- The callback redirects to `/#/dashboard`.
- Errors redirect to `/#/login` and set `oauth_error`.

`state` and the PKCE verifier live in a module dict with a 600 s TTL.

**POST `/api/auth/logout`** clears **both** GitHub and GitLab and returns exactly `{"logged_in": false}`.

**GET `/api/config/gitlab`** returns 200 `{"url": gl_base(), "client_id": <effective id>, "client_id_source": "settings"|"env"|null, "has_client_secret": bool, "oauth_available": bool}`.

**PUT `/api/config/gitlab`** takes `{"client_id"?, "client_secret"?}`. An omitted field keeps its value and `""` clears it. It returns the same shape as GET.

### 11.4 GitLab data endpoints

- **GET `/api/gitlab/projects`** returns `[{full_name, clone_url, default_branch, private}]`, the same shape as `/api/github/repos`.
  - The GitLab call is `GET /projects?membership=true&per_page=100&order_by=last_activity_at` (no `simple=true`: the simple view has no `visibility`).
  - The fields map as follows: `full_name` ← `path_with_namespace`, `clone_url` = `gl_base() + "/" + path_with_namespace + ".git"` (**not** `http_url_to_repo`, which GitLab builds from its `external_url` and often names another host, so D2's host check would skip the token and env-preview would reject it), `private` ← `visibility != "public"`.
- **GET `/api/gitlab/branches?project=<full_name>`** returns `[{"name": "main"}, ...]` from `GET /projects/<quoted>/repository/branches?per_page=100`.
  - A bad project gives 400 `project: must be group/name`.
  - A 404 from GitLab is passed through as 404.
- **Errors:** a GitLab 401 on any of these endpoints gives 401, and the UI returns to the login screen.

**POST `/api/gitlab/env-preview`** (D3 generate-from-GitLab) takes `{"repo_url": "...", "branch": "v2", "job"?: "export_env"}`:

1. `need_gitlab()`.
2. Derive the project from `repo_url`: its scheme and netloc must equal `gl_base()`'s. The project is the path with the leading `/` and trailing `.git` stripped. Otherwise return 400 `repo_url: not a project on <gl_base>`.
3. `valid_branch(branch)`. `job` must be 1–255 characters with no control characters; it defaults to `export_env`.
4. `GET /projects/<q>/repository/files/.gitlab-ci.yml/raw?ref=<branch>`. A 404 gives 400 `.gitlab-ci.yml not found on <branch>`. The file is capped at 512 KB.
5. Parse it with `parse_ci_env(text, job)`, described below.
6. Resolve the variables (below) and return 200:

```json
{"project": "sdtest/apps/mock-web3", "branch": "v2", "job": "export_env", "target": ".env",
 "content": "SVC_PORT=8084\nGREETING=hello from project var\nMONGO_HOST=mongo.sdtest.local\nMONGO_PASSWORD=sdtest-mongo-secret-42\nAPP_ENV=development\n",
 "lines": [{"key": "SVC_PORT", "vars": ["WEB3_SERVICE_PORT"], "status": "ok"},
           {"key": "APP_ENV", "vars": [], "status": "literal"}],
 "keys": ["SVC_PORT", "GREETING", "MONGO_HOST", "MONGO_PASSWORD", "APP_ENV"],
 "missing": [], "sources": {"WEB3_SERVICE_PORT": "project", "BASE_MONGO_HOST": "group sdtest"},
 "warnings": []}
```

Notes on the response:

- **`content` holds the real resolved values.** The UI keeps them in memory only, shows them masked, and sends them back in `POST /api/jobs` `env.content`. This endpoint is the **only** API response that may carry `.env` values (AD-4 in WORKPLAN). Tests exclude it from leak scans.
- A line's `status` is `ok` (every referenced variable was found), `missing` (at least one was not), or `literal` (the line references no variables).

#### Heredoc parsing rules (`parse_ci_env`)

1. **Load the YAML.** Use `yaml.load(text, Loader=L)`, where `L` is a `yaml.SafeLoader` subclass with `add_multi_constructor("!", lambda l, s, n: None)`. GitLab's `!reference` tags then load as `None` instead of failing.
2. **Pick the job.** Use the top-level key equal to `job` if its value is a dict. Otherwise use the first top-level dict-valued key that is not reserved (`default include stages variables workflow image services before_script after_script cache`) and whose script contains a heredoc into an env file. Otherwise return 400 `job: no job writes .env with a heredoc (jobs: a, b, c)`.
3. **Flatten the script.** Concatenate the job's `before_script` and `script`; each is a string or a (possibly nested) list. Split every item on `\n`.
4. **Find the heredoc start.** It is a line that contains both of these:
   - `<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2`, giving the tag and whether it is quoted.
   - A redirect `(>>?)\s*(['"]?)([^\s'";&|]+)\5` whose target ends with `.env`, for example `.env`, `./.env` or `$CI_PROJECT_DIR/.env`. A target containing `$` counts when its basename is `.env`.

   Both orders match, for example `cat <<EOF >> .env` and `cat > .env <<'EOF'`. A `>` redirect resets the content collected so far; `>>` appends to it.
5. **Read the body.** It is the following lines up to the first line whose `strip()` equals the tag. An unterminated heredoc adds a warning and the body runs to the end of the script.
6. **Expand variables**, only when the tag is unquoted:
   - `\$` becomes `$`.
   - `${N:-d}` and `${N-d}` expand to the value or the default `d`.
   - `${N}` and `$N` expand to the value. An unset name expands to `""` and is added to `missing`.
   - `$(…)` and backticks are kept literally, with the warning `line <n>: command substitution not supported`.
   - A `$` that is not followed by a name is kept as is.
7. **Record keys and sources.** A line's key is `^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=`. Lines without a key (comments, blanks) are kept verbatim. Each line records the variables it referenced.
8. **Ignore `include:`.** It is not followed and produces the warning `include: not followed`.

#### Variable resolution order

The first source that has the variable wins:

1. **Project CI/CD variables:** `GET /projects/<q>/variables?per_page=100`.
2. **Ancestor groups, nearest first:** for every prefix of `namespace.full_path` from `GET /projects/<q>`, longest first, call `GET /groups/<quoted prefix>/variables?per_page=100`.
   - Only when `namespace.kind == "group"`.
   - A group that returns 403 or 404 is skipped with the warning `group <p>: variables not readable (<status>)`.
   - A 403 on the project itself also adds a warning and resolution continues with the remaining sources.
3. **The job's `variables:`** from YAML, where a value may be a string or `{value: ...}`.
4. **Top-level `variables:`** from YAML.
5. **Predefined variables:** `CI_PROJECT_NAME`, `CI_PROJECT_PATH`, `CI_PROJECT_NAMESPACE`, `CI_PROJECT_DIR=/builds/<path>`, `CI_COMMIT_REF_NAME`, `CI_COMMIT_BRANCH` (the branch), `CI_DEFAULT_BRANCH`, and `CI_REGISTRY_IMAGE` (from the project's `container_registry_image_prefix` when present).

Within one level, a variable with `environment_scope == "*"` beats scoped ones. Values from GitLab and YAML that are not `raw` are expanded one level against the same resolver. File-type variables use their content as the value and add the warning `<VAR> is a file variable; its content is used`. A GitLab variable with `value: null` (17.4+ "masked and hidden") counts as **missing** (it expands to `""`, is listed in `missing`) and adds the warning `<VAR> is hidden in GitLab; its value can't be read`; resolution does not fall through to lower levels for it.

The `sources` value names the winning level: `project`, `group <full_path>`, `job variables`, `variables` or `predefined`.

### 11.5 Jobs (D3, D9) **[patch §4 jobs, §5]**

#### Request body

`JobIn` gains:

```python
class EnvIn(BaseModel):
    content: str = ""
    path: str = ".env"
    source: str = "paste"        # paste | file | gitlab (label only)

class JobIn(BaseModel):
    ...
    env: EnvIn | None = None
    preload_tars: list[str] = []
```

#### Validation in `create_job`

- **`env.content`:** 1–65536 characters. `parse_env(content)` must return at least one key, otherwise 400 `env.content: no KEY=value lines`.
- **`env.path`:** relative, no `..` segment, no control characters, at most 200 characters, and must not start with `/` or `-`. Otherwise 400 `env.path: must be a relative path inside the repo without '..'`.
- **`env.source`:** must be one of `paste`, `file` or `gitlab`, otherwise it is set to `paste`.
- **`preload_tars`:** at most 20 entries. Each must be absolute, have no control characters, be at most 1024 characters, and pass `os.path.isfile`. Otherwise 400 `preload_tars[<i>]: not a file on this computer`.

#### Job JSON

The job JSON gains these fields:

```json
"env": {"path": ".env", "keys": ["SVC_PORT", "GREETING", "MONGO_HOST", "MONGO_PASSWORD", "APP_ENV"], "count": 5, "source": "gitlab",
        "written": "/…/data/workspace/<folder>/mock-web3/.env"},
"preload_tars": ["/app/python.tar"],
"healthcheck": false
```

`env` is `null` when no `.env` was given. **The `.env` content is never stored.** It travels like the zip password: `Runner(job, password, tokens, env=content)` keeps it in `self.secret["env"]`, pops it in `s_build`, and `self.secret.clear()` runs in the `finally`.

#### Clone with a GitLab token (D2)

`auth_url(url, gh_token, gl)` takes `gl = (gl_base(), token)` or `None`:

- **GitLab:** if `gl` is set, `urlsplit(url).scheme == urlsplit(gl[0]).scheme`, the netlocs are equal, and the URL has no userinfo, inject `oauth2:<tok>@` after `scheme://`.
- **GitHub:** keep the existing rule.

The rest stays as it is. `Runner.clone` already runs `remote set-url origin <plain url>` whenever the URL changed, so the token is never stored in `.git/config`, the zip or the image. `create_job` builds `gl` from a best-effort `need_gitlab()`: when the user is not signed in, `gl` is `None` and the job still runs.

`Runner.clone` runs `git -c credential.helper= clone …` (one extra arg) so a configured `store`/`libsecret` helper never saves the injected token after git's 401 challenge.

#### Masks

`Runner.masks` is the list `[github_token, gitlab_token, *env_secret_values]`, sorted longest first. The mask replaces each value with `***` in `log()`, in `run()`'s last-line error, and in step messages.

An env value is masked when either rule holds:

- Its key matches `(?i)(PASS|SECRET|TOKEN|KEY|PRIVATE|CREDENTIAL)` and the value is at least 3 characters long.
- The value is at least 8 characters long. This is GitLab's masked-variable minimum.

This is a ponytail trade-off: shorter non-secret values such as `8084` or `dev` stay readable in the log.

#### Step changes (names and order unchanged)

- **clone** — after cloning the main repo, and **before** the existing early return for a missing `deploy.yml`:
  - If `<repo>/.deploy/healthcheck.sh` is a regular file, not a symlink, and at most 256 KB:
    - `os.makedirs(<F>/.deploy)`, then `shutil.copy2` to `<F>/.deploy/healthcheck.sh`. The exec bit is kept.
    - Set `job.healthcheck = true`.
    - Log `found .deploy/healthcheck.sh -> copied to <folder>/.deploy/healthcheck.sh`.
  - The zip therefore holds `<folder>/.deploy/healthcheck.sh`, next to `<folder>/deploy.yml`. The message gets ` · healthcheck.sh`.
- **build** — order:
  1. Run `docker load -i <path>` for each entry of `preload_tars` and log it. A missing file fails with `preload tar not found: <path>`.
  2. If `env` is set:
     - Compute `target = realpath(join(repo, env.path))`. It must stay inside `realpath(repo) + os.sep`, must not be a symlink, and its parent must exist; otherwise fail `env.path: outside the repo`.
     - If a file is already there, keep its bytes so they can be restored.
     - Save `job.env.written = target` to the job JSON **before** writing (a path, not a value), so `recover_interrupted()` can delete it after a kill.
     - Write the content with mode **644**, like the CI's `cat <<EOF >> .env`. `COPY . /app` keeps the mode, and a 600 root-owned file can't be read by an image whose `USER` is not root.
     - Log `wrote <path> (<n> keys: K1, K2, …)`, with names only.
     - If `<repo>/.dockerignore` has a line equal to `.env`, `*.env` or `**/.env`, log `WARNING: .dockerignore excludes .env; the image will not contain it`.
  3. Run `build_command`, if any (unchanged).
  4. Run `docker build -t <image_tag> -f <df> <repo>` (unchanged).
  5. In a `finally` block, restore the original file or delete the written one. Then `self.secret.pop("env", None)`. The zip and upload therefore never carry the separate `.env` file; it exists only inside the image.

  **[patch recover_interrupted]** For each interrupted job whose `env.written` is set, `os.remove` that path if it exists (best effort). A kill during `build` therefore leaves no plaintext `.env` in the workspace. (A pre-existing `.env` in the clone is lost in that case; the clone is a job artifact.)

  The message becomes `image sdtest-web3:20261103_120000 built · .env 5 keys · preloaded 1 tar`.
- **upload** — SMB (§11.6). `remote_path` is `smb://<host>:<port>/<share><dir>/<name>`.

`written` is null until the build step writes the file.

### 11.6 SMB upload (D4) **[patch §4.6 upload]**

`remote(u, created)` gains an `elif u["protocol"] == "smb":` branch. It uses `smbclient`, the same `unc()`, `kw` and username rules as the deployer, and a per-call `connection_cache`:

- **Create the directory path:** walk each component of `remote_dir` and call `smbclient.stat(unc(path), **kw)`. If it raises `OSError`, call `smbclient.mkdir(...)` and append the path to `created`.
- **`put(local, name, cb)`:** open `smbclient.open_file(unc(d + "/" + name + ".part"), mode="wb", **kw)`, copy 1 MiB chunks calling `cb(done)` after each, then `smbclient.replace(<.part>, <final>, **kw)` (replace, not rename, so an existing name is overwritten like SFTP `posix_rename`).
- **All protocols upload as `<name>.part` and rename at the end** (SFTP `posix_rename`, FTP/FTPS `ftp.rename`), so the deployer's watch never lists a half-written zip under its final name (`x.zip.part` doesn't match its name rules). A failed upload removes the `.part` best-effort.
- **`remove(name)`:** `smbclient.remove(unc(d + "/" + name), **kw)`.
- **`finally`:** `smbclient.reset_connection_cache(connection_cache=cache)`.

Other changes:

- One tuple `PROTOCOLS = ("sftp", "ftp", "ftps", "smb")` is used by both `put_upload` and `test_upload`.
- When the protocol is `smb` and the host is set, `share` is required and must match `^[A-Za-z0-9][A-Za-z0-9 _.$-]{0,79}$`; otherwise 400 `share: required for SMB`. The `domain` rule is the same as in the deployer.
- `UploadIn` gains `domain` and `share`. `public_upload` already strips only `password`.
- The `test_upload` message is `Connected to <host>:<port> · <share><remote_dir> is writable`.
- The `s_upload` log line is `connecting smb://<host>:<port>/<share> as <user>`.
- **Port:** the server does not swap ports on PUT, so the UI sends 445. This matches BP's current behaviour.

### 11.7 `.env` import (D11)

`parse_env` follows the same rules as the deployer (§11.7, including the CRLF/CR → LF normalisation first) and is copied verbatim, since each app is a single file.

**Startup import.** This runs at module level after `recover_interrupted()`:

- The path is `os.environ.get("BP_ENV_FILE") or join(BASE, ".env")`.
- The file is imported only when its sha256 differs from `env_import_sha`. After the import, `env_import_sha` and `env_import_at` are saved.
- A single stderr line lists only the names that were imported.
- The import never fails startup.

**POST `/api/config/import-env`** takes `{"content": "..."}` and returns 200 `{"set": [...], "ignored": [...], "errors": [...]}`. It never returns values.

| `.env` key | sets |
|---|---|
| `GITLAB_URL` | `gitlab_url` |
| `GITLAB_TOKEN` | `gitlab_token`, `gitlab_token_url` (= `gl_base()` after this import's `GITLAB_URL`), `gitlab_method="pat"` (login filled in the background by status) |
| `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET` | `gitlab_client_id`, `gitlab_client_secret` |
| `FILE_SERVER_PROTOCOL` `_HOST` `_PORT` `_USER` `_PASSWORD` `_DOMAIN` `_SHARE` `_REMOTE_DIR` `_KEY_PATH` | `upload.protocol/host/port/username/password/domain/share/remote_dir/private_key_path`. When the protocol changes and no port is given, the port defaults to 22, 21 or 445 |
| `BP_UPLOAD_ENABLED` | `upload.enabled`. Defaults to `true` when `FILE_SERVER_HOST` is imported |

How the import is applied:

- The upload section is validated with the same checks as `put_upload`. A failure goes to `errors` as `upload: <detail>`, and the GitLab keys still apply.
- `SD_*`, `CI_*`, `BASE_*`, `SERVICE_NAME`, `HEALTHCHECK_URL`, `DEV_IMAGE_TAG` and `ZIP_PASSWORD` are deployer keys. They go to `ignored`, so one shared `.env` works for both apps.

### 11.8 Masking and secrets (summary)

| Secret | Where it may exist |
|---|---|
| GitHub token, GitLab token, GitLab refresh token, client secret, upload password | Only in `data/config.json` (mode 600). Never in an API response; the response carries `has_*` booleans instead. Masked in logs. |
| Zip password | Unchanged. |
| `.env` content | In the browser's memory, in the `POST /api/jobs` body, in Runner memory, and in `<repo>/<path>` during `docker build` only; that file is removed afterwards (by the build's `finally`, or by `recover_interrupted()` after a kill). Also inside the built image, by design. Values are never in the job JSON, logs or SSE; key names are fine. The only API response that carries them is `/api/gitlab/env-preview`. |

### 11.9 Acceptance criteria (new)

| ID | Criterion |
|---|---|
| BP-AC-40 | GitLab PAT and OAuth+PKCE sign-in work, including refresh; a rejected refresh signs out. GitHub sign-in is unchanged. Logout clears both. The token is only used for the GitLab URL it was issued for. |
| BP-AC-41 | GitLab projects and branches are listed; `clone_url` is built from the configured GitLab URL. Cloning a private GitLab repo over HTTP injects the token and leaves it out of the log, `.git/config`, git credential helpers and the zip. |
| BP-AC-42 | `env-preview` follows the parsing rules and resolution order: project wins over the nearest group, which wins over the root group. Missing variables are listed. |
| BP-AC-43 | A job with `env` writes the file before `docker build`, the image contains it, the zip source folder does not, and the job JSON and log hold names only. |
| BP-AC-44 | `preload_tars` are loaded before the build. |
| BP-AC-45 | `.deploy/healthcheck.sh` is copied to `<folder>/.deploy/healthcheck.sh` in the zip. |
| BP-AC-46 | SMB upload creates folders and uploads (as `.part`, renamed at the end, for every protocol). The test connection writes and deletes a probe file. |
| BP-AC-47 | The `.env` import at startup and through the endpoint sets upload and GitLab settings and returns names only. |
