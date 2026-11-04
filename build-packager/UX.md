# Build Packager — UX spec (v2 redesign)

This file replaces SPEC.md §7 for the UI. The API (SPEC §4–6) does not change.

Source: Concept 1 "Minimal Focus" won. It takes these ideas from the other two:
- Concept 2: compact stat tiles, "Next: <step>" button labels, a status prefix in the tab title, a live/ended indicator on the log, and auto-copy of the device code.
- Concept 3: a second status line on each dashboard row, a failure hint for each step, a lowercase note on the image tag, the FTP warning, and the "Docker image only (not encrypted)" note on the tar download.

User brief, verbatim: "firstly sign in with github and also show dashboard and also give repo and after step by step and do not show other extra things there and implement ux as well and also with perfect one".

The design follows from that brief:
- **One job per screen and one primary button per screen.** Everything else is a text link or a collapsed section.
- No sidebar, no charts, no filters, no keyboard-shortcut dialog, no greeting, no quick-rebuild strip. Settings are reachable from the top bar only.

---

## 0. Hard constraints (do not break)

The UI is a React + TypeScript app in `frontend/` built on the shared kit `../shared-ui` (`@devtools/ui`).
`tests/e2e_test.py` checks the UI **source** (`frontend/src` + `shared-ui/src`) as text. The rules:

1. No CDN and no webfonts; everything is bundled by Vite into `frontend/dist`. The only external resource is the GitHub `avatar_url` `<img>`. If it fails to load, show a circle with the first letter of the login.
2. The literals `innerHTML` and `dangerouslySetInnerHTML` must not appear anywhere in the source, **including comments**. React renders all text as text.
3. The source must contain `EventSource`, `addEventListener('end'` (single quotes, exactly as written) and `es.close()` (in the kit's `useEventSource`).
4. The client validator builds the request body as `b`. It must contain the literal expressions `b.password.length < 4` and `b.password !== b.password_confirm`.
5. Every `'/api/...'` string literal must be a real route from SPEC §4 (`frontend/src/api/endpoints.ts`). Do not invent paths, not even in comments.
6. Secrets: the PAT, the zip password and the upload password live only in component state / the in-memory draft.
   - They are never stored in `localStorage`, in `sessionStorage`, in the URL or hash, or in a toast.
   - Clear every password input after a successful submit, after Cancel and after sign-out.
7. Class names, ids and texts used by `tests/ui_test.py` are part of the contract (global CSS class names, not CSS modules).
8. Log lines are untrusted: rendered as text only.

Allowed storage:
- `sessionStorage['bp.draft']` holds the non-secret wizard fields: `repo_full`, `repo_url`, `default_branch`, `service`, `service_edited`, `branch`, `dockerfile`, `build_command`, `extra_repos`, `upload`. This lets a refresh keep the user's place.
- `sessionStorage['bp.return']` holds the route to return to after Settings.

Nothing else is stored.

---

## 1. Routes

| Hash | Screen | Guard |
|---|---|---|
| `#/login` | Sign-in | logged in -> `#/dashboard` |
| `#/dashboard` | Dashboard | logged out -> `#/login` |
| `#/new/repo` | Wizard 1 · Repository | logged out -> `#/login` |
| `#/new/source` | Wizard 2 · Build settings | no `repo_url` in draft -> `#/new/repo` |
| `#/new/password` | Wizard 3 · Password | no `repo_url` -> `#/new/repo` |
| `#/new/upload` | Wizard 4 · Upload | no password in memory -> `#/new/password` |
| `#/new/review` | Wizard 5 · Review | no password in memory -> `#/new/password`, with a note (see §4.3) |
| `#/jobs/<32 hex>` | Run / build detail | logged out -> login; unknown id -> 404 state |
| `#/settings` | Upload server | logged out -> login |
| empty / unknown | -> `#/dashboard` (or `#/login`) | |

- **Boot.** The body shows only a centered 20px spinner, and only if it lasts more than 200ms. Call `GET /api/auth/status`, then route. The login screen must not flash.
- **Return after login.** If the user was sent to login from a protected route, return them to that route after sign-in.
- **Leaving a run view.** Leaving `#/jobs/<id>` always calls `es.close()`.
- **Focus on route change.** Focus moves to the screen's `<h1>` (`tabindex="-1"`).
- **Tab title.** `document.title` is `"<Screen> — Build Packager"`, for example "New build · Password — Build Packager". On a run view it is prefixed with the status: `"● myapp"` while running, `"✓ myapp"` on success, `"✗ myapp"` on failure.
- **Sign-in gate.** Job APIs do not need a token, but the UI still gates everything behind sign-in, because that is the flow the user asked for.

---

## 2. Design tokens

Put these in `:root`. Dark mode uses `@media (prefers-color-scheme: dark) { :root { … } }`. There is no theme toggle. Set `color-scheme: light dark`, and give `body` `background: var(--bg); color: var(--fg)`.

```css
:root{
  --bg:#ffffff; --bg-subtle:#f7f7f8; --surface:#ffffff;
  --border:#e7e7ea; --border-strong:#d4d4d8;
  --fg:#0b0b0d; --fg-muted:#5f5f68; --fg-faint:#8a8a93;
  --accent:#4f46e5; --accent-hover:#4338ca; --accent-fg:#ffffff; --accent-subtle:#eef0ff;
  --success:#15803d; --success-subtle:#f0fdf4;
  --danger:#dc2626;  --danger-subtle:#fef2f2;
  --warning:#b45309; --warning-subtle:#fffbeb;
  --gh-bg:#24292f; --gh-fg:#ffffff;                 /* GitHub button */
  --log-bg:#0b0b0c; --log-fg:#d4d4d8; --log-dim:#71717a;
  --log-cmd:#7dd3fc; --log-err:#fca5a5; --log-err-bg:rgba(248,113,113,.08); --log-ok:#86efac;
  --focus:0 0 0 2px var(--bg),0 0 0 4px var(--accent);
  --shadow-pop:0 8px 24px rgb(0 0 0 / .12);
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
  --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:24px; --s6:32px; --s7:48px; --s8:64px;
  --r-sm:6px; --r-md:8px; --r-lg:12px; --r-full:999px;
  --h-ctl:36px; --h-ctl-lg:44px;
  --dur:150ms;
}
@media (prefers-color-scheme: dark){ :root{
  --bg:#0a0a0b; --bg-subtle:#141416; --surface:#17171a;
  --border:#26262b; --border-strong:#34343a;
  --fg:#ededef; --fg-muted:#a0a0ab; --fg-faint:#6e6e78;
  --accent:#7c74ff; --accent-hover:#8f88ff; --accent-fg:#ffffff; --accent-subtle:#1d1b3a;
  --success:#3fb950; --success-subtle:#0f2a17;
  --danger:#f85149;  --danger-subtle:#2a1215;
  --warning:#d29922; --warning-subtle:#2a1f08;
  --gh-bg:#f0f6fc; --gh-fg:#0d1117;
  --shadow-pop:0 8px 24px rgb(0 0 0 / .5);
}}
```

**Type.** These are size / line height in px, then weight.

| Role | Size / line height | Weight and notes |
|---|---|---|
| display (login title, result headline) | 24/32 | 600, letter-spacing -0.01em |
| h1 (page or step title) | 20/28 | 600 |
| body | 14/22 | — |
| label | 13/18 | 500 |
| helper / meta | 13/18 | `--fg-muted` |
| micro (pills, stepper labels, stat labels) | 12/16 | 500 |
| stat number | 24/32 | 600 |
| mono (log, code values) | 12.5/20 | — |

All numbers use `font-variant-numeric: tabular-nums`. Inputs are 16px at ≤480px so iOS does not zoom.

**Spacing.** Use only `--s1`…`--s8`. Some fixed values:
- Field gap 16px. Label to input 6px.
- Section gap 32px. Title to content 24px.
- Content column: `max-width:720px`, centered. Side gutter 16px at ≤640px, 24px above. Top padding 48px on desktop, 24px on mobile.

**Radius, shadow, motion.**
- Radius is 6px for inputs and buttons, 8px for cards, list boxes, tiles and the log, 12px for the result card and the login panel, and full for pills and the avatar.
- Use borders, not shadows. Only menus, toasts and dialogs get `--shadow-pop`.
- Transitions are 150ms ease-out. The spinner is a 0.8s linear rotation.
- With `prefers-reduced-motion: reduce`, there are no transitions, the spinner becomes a static ring, and there is no shimmer and no smooth scroll.

**Icons.** Use one hidden `<svg>` with `<symbol>`s, referenced with `<use href="#i-x">`. Icons are 16px (20px in the steppers), with a 1.5 stroke in `currentColor`.

The set: github, check, x, circle, dash, spinner, chevron-down, chevron-left, plus, search, lock, eye, eye-off, copy, download, gear, more, info, alert, box (logo), external.

Decorative icons get `aria-hidden="true"`.

---

## 3. Components

| Component | Spec |
|---|---|
| **Button** | Variants are `primary` (accent background), `secondary` (surface with a `--border-strong` border), `ghost` (muted text, subtle background on hover), `danger` (danger background, used only in confirm dialogs) and `github` (`--gh-bg`). Height is 36px, or 44px for `lg` and for any button at ≤480px. **Busy:** a 14px spinner replaces the icon, the label changes to a verb ending in "…", the width stays fixed, `aria-busy="true"`, and the button is disabled. There is one primary button per screen. Wizard Continue is never disabled; it runs validation instead. |
| **Field** | `<label for>`, then the input, then helper text, then the error. The error has `id="<f>-err"` and the input gets `aria-describedby` and `aria-invalid="true"`. The error text is 13px `--danger` with the alert icon. The input is 36px tall (44px at ≤480px) with a `--border-strong` border. On focus it gets `--focus` and an accent border. |
| **Password field** | An input plus an eye button inside it on the right (`aria-label` "Show password" or "Hide password", `aria-pressed`). |
| **Status pill** | 12px/500, full radius, padding 2px 8px, a 6px dot or 12px icon, and a word. The variants: queued (faint, hollow circle, "Queued"), running (accent on accent-subtle, spinner, "Running"), success (success on success-subtle, check, "Succeeded"), failed (danger on danger-subtle, x, "Failed"). Color is never the only signal. |
| **Step icon** | pending: hollow circle, `--fg-faint`. running: spinner, `--accent`. success: check, `--success`. failed: x, `--danger`. skipped: dash, `--fg-faint`, with the label in muted color. |
| **Toast** | Bottom center. At most 3 stacked. A surface background with a 3px status-colored left bar, an icon and text. Normal toasts use `role="status"` and close after 4s. Error toasts use `role="alert"` and close after 6s. Hover or focus pauses the timer. There is a close ✕. |
| **Dialog** | Native `<dialog>` opened with `showModal()`, which traps focus. Esc cancels, and focus returns to the trigger. It has a title, one sentence and the buttons [Cancel] [Danger action]. |
| **Menu** | Opened by a button with `aria-haspopup="menu"` and `aria-expanded`. It is a `role="menu"` list with `role="menuitem"` items. ↑/↓ moves, Enter activates, Esc closes, and a click outside closes it. |
| **Skeleton** | `--bg-subtle` blocks with a 1.2s shimmer (none under reduced motion). |
| **Inline alert** | Form-level. Icon plus text on `*-subtle`, 8px radius, `role="alert"`. |

**API helper.** One `api(method, path, body)`:
- Returns the parsed JSON.
- On a non-2xx status it throws `{status, detail}`, taking `detail` from `{detail}` or falling back to `"Request failed (<status>)"`.
- If fetch itself throws, `detail` is "Can't reach the local server. Is ./run.sh running?".
- A 401 from any `/api/github/*` call, on any screen except login, shows the toast "GitHub session expired. Sign in again." and goes to `#/login`.

**Field-mapped API errors.** A 400 `detail` with a `<field>:` prefix maps to a field:

| Prefix | Field | Wizard step |
|---|---|---|
| `repo_url` | repo | repo |
| `service` | service | source |
| `branch` | branch | source |
| `dockerfile` | dockerfile | source |
| `build_command` | build command | source (Advanced opens) |
| `extra_repos` or `extra repo` | extra repos block | source (Advanced opens) |
| `password` | password | password |

Any other `detail` shows as an inline alert above the action buttons.

---

## 4. Screens

### 4.0 App shell (every screen except login)

```
┌────────────────────────────────────────────────────────────────────┐
│ [▣] Build Packager                       ⚙ Settings   (◉) octocat ▾ │ 56px, sticky, bottom border
└────────────────────────────────────────────────────────────────────┘
```

- **Logo.** A 20px accent box glyph plus "Build Packager" at 14/600. It is an `<a href="#/dashboard">`.
- **Settings.** A ghost link "Settings" with a gear icon. At ≤480px it shows only the icon, with `aria-label="Settings"`.
- **Avatar menu.** A 24px round avatar plus the login (the login text is hidden at ≤480px). Clicking it opens a menu with:
  - the line "Signed in as @octocat", muted and not clickable;
  - a divider;
  - "Sign out".
- **Sign out.** Calls `POST /api/auth/logout`, then shows the toast "Signed out" and goes to `#/login`. There is no confirmation, because signing back in is one click.
- **Wizard routes.** On `#/new/*` the right side shows only `Cancel` (ghost, with the hint `Esc` on desktop). Settings and the avatar are hidden there, to keep distractions down.

### 4.1 `#/login` — Sign in

Only this screen is visible. There is no top bar. The panel is centered on both axes, with `width:min(400px, 100% - 32px)`.
GitLab comes first, then a divider (`p.or` "or"), then the GitHub block unchanged.

```
                              [▣]
                        Build Packager
              Build, package and ship a repo in one go.

          ┌─────────────────────────────────────────┐
          │  (gl)  Continue with GitLab             │  #gl-continue, primary lg full; autofocus when gitlab.oauth_available
          └─────────────────────────────────────────┘
        Signs in at http://192.168.33.175                 no OAuth: "Self-hosted GitLab at <url> · paste an access token"
               Use a GitLab access token                  #gl-use-token, ghost; only when oauth_available
          ─────────────────── or ───────────────────
          ┌─────────────────────────────────────────┐
          │  (gh)  Continue with GitHub             │  github variant, lg, full width, autofocus when GitLab OAuth is off
          └─────────────────────────────────────────┘
               Uses your local gh CLI sign-in

          ┌─────────────────────────────────────────┐
          │  Sign in with a device code             │  secondary lg. Only if device_flow_available
          └─────────────────────────────────────────┘

                Use a personal access token ▾          <details>, collapsed

          [inline alert area, role=alert]

            Runs locally · tokens stay on this computer          micro, faint
```

There is still exactly one `<details>` and no visible input on load.

**Continue with GitLab.** With `gitlab.oauth_available`, `location.href = '/api/auth/gitlab/start'` (busy "Opening GitLab…"); the
server redirects to GitLab (OAuth + PKCE) and back to `#/dashboard`, or to `#/login` with a one-shot `oauth_error` that shows in the
alert area. Without OAuth, the button opens the token view.

**GitLab token view** (`form#gl-token`, replaces the main view like the device flow does):

```
                   Sign in to GitLab                      h2
  GitLab URL            [ http://192.168.33.175 ]          #gl-url, prefilled with gitlab.url
                        Your self-hosted GitLab, e.g. http://192.168.33.175
  Personal access token [ glpat-…          (eye) ]          #gl-pat, data-secret
                        Needs read_api + read_repository (api to read CI/CD variables).
  [ Sign in with GitLab token ]                            primary, busy "Signing in…"
                         Back                              ghost: main view, focus #gl-continue
```

- Empty token: `#gl-pat-err` "Paste a token first.", no request.
- `POST /api/auth/gitlab/token {token, url}`. 401 "GitLab rejected this token. It may be expired or revoked." (field cleared);
  502 "Couldn't reach GitLab at <url>. Check the URL and your network."; 400/409 the server's detail.
- Success: re-read `GET /api/auth/status` (the token response isn't the status shape), clear the field, toast
  "Signed in as @<login>", go to the return route or `#/dashboard`.
- A 401 from any `/api/gitlab/*` call later toasts "GitLab session expired. Sign in again." and goes to `#/login`
  (GitHub: "GitHub session expired. Sign in again.").

**Continue with GitHub.** Calls `POST /api/auth/gh-cli`.
- Busy: the label is "Checking gh CLI…" and all controls are disabled.
- 200: toast "Signed in as @<login>", then go to `#/dashboard` (or the return route).
- 400: an inline alert, and the PAT `<details>` opens with focus on the token field. The alert reads:
  > **gh CLI isn't installed or isn't signed in.**
  > Run `gh auth login` in a terminal and try again, or use a token below.

  `gh auth login` is in mono.
- 401: "GitHub rejected this token. It may be expired or revoked."
- 502: "Couldn't reach GitHub. Check your connection and try again."

**PAT section** (expanded):

```
  Personal access token
  [ ••••••••••••••••••••••          (eye) ]     type=password, autocomplete=off, spellcheck=false
  Needs the repo scope.  Create one ↗           link: https://github.com/settings/tokens/new?scopes=repo&description=Build%20Packager
  [ Sign in with token ]                        secondary, full width
```

- Enter in the field submits. An empty field shows the error "Paste a token first." without sending a request.
- `POST /api/auth/token`. The errors are the same as above. On a 401 the field is cleared and refocused. On success the field is cleared.

**Device flow.** `POST /api/auth/device/start`. The panel body is then replaced with:

```
                Enter this code on GitHub
                 ┌───────────────┐
                 │  ABCD-1234    │ [Copy]       mono 32px, letter-spacing .15em
                 └───────────────┘
        [ Open github.com/login/device ↗ ]     primary; verification_uri, target=_blank rel=noopener
        (spinner) Waiting for authorization…  14:52 left       aria-live=polite
                         Cancel                ghost
```

- The code is copied to the clipboard automatically, with the toast "Code copied". If the clipboard API fails, the code stays visible and the toast is not shown.
- Poll `POST /api/auth/device/poll` every `interval` seconds. On `slow_down`, use the new interval. The countdown starts from `expires_in`.
- `ok`: go to the dashboard, as for gh.
- `expired_token`: "The code expired." plus [Get a new code].
- `access_denied`: "Authorization was denied on GitHub." plus [Try again].
- Any other error: "Sign-in failed: <error>." plus [Try again].
- Cancel stops polling and restores the main panel.

### 4.2 `#/dashboard`

```
  Builds                                                   [ + New build ]   h1 + primary

  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────────────────┐
  │ Total builds │ │ Succeeded    │ │ Failed       │ │ Last build               │
  │ 12           │ │ 10           │ │ 2            │ │ ✓ myapp · 14 min ago     │
  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────────────────┘

  Recent builds
  ┌──────────────────────────────────────────────────────────────────────┐
  │ (spin) myapp         owner/myapp · main            0:42    just now  ⋯│
  │        Running · Build image (3/7)                                    │
  ├──────────────────────────────────────────────────────────────────────┤
  │ ✓      api-gateway   owner/api-gateway · release/1.2  4m 02s yesterday ⋯│
  │        Succeeded · zip 182 MB · uploaded                              │
  ├──────────────────────────────────────────────────────────────────────┤
  │ ✗      worker        owner/worker · dev            0:31    Nov 1     ⋯│
  │        Failed at Clone repository · Remote branch dev not found       │
  └──────────────────────────────────────────────────────────────────────┘
```

**Data.** `GET /api/jobs` on entry. While any job is `running` or `queued`, poll it every 3s and stop once none are. There is no SSE on the dashboard. Prefetch `GET /api/github/repos` in the background and keep it in memory for the wizard.

**Stats.** All four are computed on the client from the jobs array.

| Tile | Value |
|---|---|
| Total builds | `jobs.length` |
| Succeeded | the number of jobs with `status == success` |
| Failed | the number with `status == failed`, shown in `--danger` only when above 0 |
| Last build | `jobs[0]`: status icon, service, relative `created_at`. The tile links to that job. |

- Tiles have a border, 8px radius and 16px padding. The label is micro and muted, and the number is the 24px stat style.
- Layout is 4 columns above 720px, 2×2 at 720px and below, and the Last build tile spans the full width at ≤480px.

**Rows.** Each row is one `<a href="#/jobs/<id>" class="row">`, 64px tall, with a `--bg-subtle` background on hover and a focus ring on the whole row.
- **Line 1:**
  - status icon, 16px;
  - the service name, 14/500;
  - `owner/repo · branch` in muted mono 12px. `owner/repo` comes from a github.com `repo_url`; otherwise use the URL basename;
  - the duration, right-aligned in tabular-nums. It is `finished_at - created_at`, or a live 1s tick while the job is running;
  - the relative time, as `<time datetime title="<absolute local>">`.
- **Line 2** (muted 13px):
  - running: "Running · <Step label> (n/7)";
  - queued: "Queued";
  - success: "Succeeded · zip <size>", followed by " · uploaded" when `remote_path` is set, otherwise " · saved locally";
  - failed: "Failed at <Step label> · <error>" in `--danger`, one line with an ellipsis.
- **⋯ button** (`aria-label="Actions for <service>"`, a separate tab stop that does not open the row) opens a menu:
  - **View**
  - **Rebuild** (§4.4.6)
  - **Download .zip**, only if `artifacts.zip`
  - **Delete…**, disabled while the job is running, with `title` "Running builds can't be deleted"
- **Delete dialog.** Title "Delete this build?". Body: "Deletes the log, the workspace folder and the zip for `<folder_name>` from this computer. Files already uploaded to your server are not touched." Buttons: [Cancel] [Delete build] (danger).
  - Then `DELETE /api/jobs/{id}`, the row is removed and the toast says "Build deleted".
  - A 409 shows the toast "This build is still running."
- **≤480px.** Line 1 is the icon, the service and the relative time. Line 2 is the status line. `owner/repo · branch` and the duration are hidden.
- There is no pagination; all rows show in API order (newest first).
- **Finish toast.** When a polled job changes from running to finished while the user is on the dashboard, show the toast "<service> succeeded" or "<service> failed".

**States**

- **Loading:** 4 skeleton tiles and 3 skeleton rows.
- **Empty** (no jobs): the tiles, "Recent builds" and the header button are all hidden, so there is a single CTA:
  ```
                      [box icon 40px, faint]
                         No builds yet
         Pick a repository, set a zip password, and get an encrypted package.
                        [ + New build ]           primary lg
  ```
- **Error:** an inline alert "Couldn't load builds. <detail>" with a [Retry] ghost button.

### 4.3 `#/new/*` — Wizard frame

```
  New build                                                         ← h1 is the step title (below)
  ●━━━━━━━●━━━━━━━○───────○───────○
  Repository  Build  Password  Upload  Review          ≤480px: "Step 2 of 5 · Build settings" + 4px progress bar

  Build settings                                                    h1, 20/600
  owner/myapp                                       Change          subtitle, muted

  [ fields ]

  ──────────────────────────────────────────────────────────────
  ← Back                                         [ Next: Password ]   ≤480px: sticky bottom bar, safe-area padding
```

**Stepper.**
- It is an `<ol aria-label="Build steps">` with 5 items. The current item has `aria-current="step"`.
- A done step is an accent-filled dot with a check, and it is a link back to that step.
- The current step is an accent ring. Future steps are a `--border` ring with faint text, and they are not clickable.
- The connectors are accent up to the current step and `--border` after it.

**Footer.**
- Back is a ghost button, hidden on step 1.
- The primary button names the next step: "Next: Build settings", "Next: Password", "Next: Upload", "Next: Review", and on step 5 "Start build".
- If the user arrived through a Review "Edit" link, the primary button reads "Back to review".

**Keyboard.**
- Enter in a single-line input means Next. In the textarea, Enter adds a new line and Ctrl/Cmd+Enter means Next.
- Esc means Cancel.
- On step entry, focus goes to the first field.

**Validation.**
- It runs when the user presses Next. After the first attempt it also runs on blur and input, and errors clear as soon as a field becomes valid.
- The first invalid field gets focus.

**Draft.**
- Every change writes the draft (without the password) to `sessionStorage['bp.draft']`.
- The password lives only in `state.password` and `state.password_confirm`.
- If the user lands on `#/new/upload` or `#/new/review` with no password in memory (for example after a refresh), redirect to `#/new/password` and show the info note "For safety, the password isn't kept after a reload. Enter it again."

**Cancel.**
- If the draft is dirty, open a dialog: "Discard this build? Nothing has been built yet." [Keep editing] [Discard].
- Discard clears the draft and the password, then goes to `#/dashboard`.
- If the draft is clean, go straight to the dashboard.

**New build** from the dashboard always starts with an empty draft.

#### Step 1 `#/new/repo` — "Choose a repository" (subtitle: "Which code should we build?")

```
  [ (search) Search your repositories            ]   autofocus, role=combobox, aria-controls=list
  ┌────────────────────────────────────────────────┐
  │ owner/api-gateway          (lock)      main     │  role=listbox, max-height 360px, scroll
  │ owner/myapp                            main  ✓  │  selected: accent left bar + check, aria-selected
  │ owner/worker               (lock)      dev      │
  └────────────────────────────────────────────────┘
  Not listed?  Paste a clone URL                       text link
```

- **Data.** Use the cached repos, or `GET /api/github/repos`. Filtering is a case-insensitive substring match on `full_name`.
- **Keyboard.** ↑/↓ moves the active option (`aria-activedescendant`). Enter selects it and goes Next. A click selects a row, and a double-click selects it and goes Next.
- **Row content.** `full_name` in mono, a lock icon with "Private" for screen readers, and the `default_branch` in faint text.
- **On select:**
  - set `repo_url = clone_url`, `repo_full`, and `default_branch`;
  - set `branch = default_branch`;
  - set `service = sanitize(repo name)`, unless `service_edited` is true;
  - sanitize: replace characters outside `[A-Za-z0-9_.-]` with `-`, strip leading characters that are not alphanumeric, and cut to 63.
- **"Paste a clone URL."** The list is swapped for a single field:
  - label "Clone URL", placeholder `https://github.com/owner/repo.git`;
  - helper "HTTPS, SSH, git@host:path, file:// or an absolute path.";
  - a link back, "Pick from my repositories".
  - If the URL matches `https://github.com/<o>/<r>(.git)`, set `repo_full` so branches can still be loaded.
  - The service name is derived from the URL basename.
- **Validation.**
  - In list mode, with nothing selected: "Select a repository to continue."
  - In URL mode: empty gives "Enter a clone URL." Otherwise check: at most 500 characters, no whitespace, no leading `-`, and a prefix of `https://`, `http://`, `ssh://`, `git@`, `file://` or `/`. Failure gives "That doesn't look like a Git URL. Use https://…, ssh://…, git@host:path, file://… or an absolute path."
- **States.**
  - Loading: 5 skeleton rows.
  - Empty: "No repositories found on this account." and URL mode opens.
  - No match: "No repositories match “<q>”."
  - Error: inline alert "Couldn't load repositories. <detail>" with [Retry] and the URL link.

#### Step 2 `#/new/source` — "Build settings" (subtitle: `owner/myapp` mono, plus a `Change` link to step 1)

```
  Branch
  [ main  (default)                          ▾ ]

  Service name
  [ myapp                                      ]
  Image myapp:<timestamp> · folder myapp_<timestamp>/        live, mono, faint

  ▸ Advanced options                                         <details>, closed; summary shows "· 2 set" when any non-default
```

**Branch.**
- If `repo_full` is set, call `GET /api/github/branches?repo=<repo_full>`, or `GET /api/gitlab/branches?project=<repo_full>` when the
  repo URL is on the signed-in GitLab host (same scheme + host; `repo_full` is then the path minus `.git`). While it loads, a disabled `<select>` shows "Loading branches…".
- Show a `<select>` with `default_branch` first, labelled "main (default)", and the rest sorted alphabetically. Preselect `draft.branch`.
- If there is no `repo_full`, or the request fails, show a text input holding `draft.branch` or "main". The helper is: "Couldn't list branches, type one. It must exist or the build stops at Clone."
- A 404 shows "Repository not found or no access." with a `Change` link.

**Service name.**
- Editing it sets `service_edited = true`.
- If it contains capital letters, the preview adds a second line: "Docker tags are lowercase, so the image is tagged myapp:…; files keep MyApp."

**.env for the build** (`fieldset#env-field`, between Service name and Advanced):

```
  .env for the build
  Written to the repo before docker build, so the image gets it. It's never saved or logged.
  ( None | File or paste | From GitLab CI )                 name=env_mode; GitLab option only when signed in to GitLab
                                                            and the repo is on the GitLab host
  File or paste:  [ Choose file ] #env_file   [ KEY=value … ] Textarea#env_content (data-secret, mono, 6 rows)
  From GitLab CI: CI job that writes .env [ export_env ] #env_job   [ Generate from GitLab ] #env-gen
                  (busy "Reading .gitlab-ci.yml…") → POST /api/gitlab/env-preview {repo_url, branch, job}
  From export_env on v2 · 5 keys                [ Edit ]    #env-edit toggles the raw textarea (Edit / Done)
  ┌──────────────────────────────────────────────┐
  │ SVC_PORT = ••••••   from $WEB3_SERVICE_PORT · project  │ ul#env-keys > li.env-row (li.missing + warning icon)
  │ MONGO_HOST = ••••••  from $BASE_MONGO_HOST · group sdtest│
  └──────────────────────────────────────────────┘
  ⚠ Not set in GitLab: $A, $B. They'll be empty in the .env. Add them …    #env-missing, only when missing
  • include: not followed                                   #env-warnings, muted
```

- The content (real values) lives only in JS memory (`draft.env_content`, not in `PERSISTED`), never in sessionStorage, the URL or
  toasts. A reload clears it; the rest of the block (mode, path, job, source) is kept. `session.envMeta` keeps the preview metadata
  (keys, sources, missing, warnings) without values.
- Raw text is visible only while the textarea has focus, while Edit is on, or (file/paste) while it is empty; otherwise the masked
  summary shows. Editing sets the source to `paste`; the mode stays.
- A preview error shows as an Alert inside `#env-field`.

**Advanced** (expanded inline, no extra box):

```
  Dockerfile path
  [ Dockerfile                                 ]   helper: Relative to the repo root, e.g. docker/Dockerfile.prod

  Build command (optional)
  [ npm ci && npm run build                    ]   mono textarea, 3 rows
  Runs as a shell command in the repo folder before docker build. Only use commands you trust.

  Extra repositories (optional)
  Cloned next to your repo inside the zip.
  [ URL https://github.com/owner/other.git ] [ Branch main ] [ Folder (auto: other) ]  [✕]
  + Add repository

  .env path in the repo
  [ .env                                       ]   #env_path; helper: Relative to the repo root.
  Images to load before the build
  [ /app/python.tar                            ]   Textarea#preload_tars; helper: One absolute path per line on this computer,
                                                   e.g. /app/python.tar (offline base images).
```

- The `· N set` count includes `env_path` when it isn't `.env` and `preload_tars` when non-empty (the env defaults don't count).

- The Advanced section opens automatically if any of its fields is not the default, or if an error maps into it.
- An extra-repo row is a grid of URL (1fr), branch (120px), folder (160px) and ✕ (`aria-label="Remove repository <n>"`).
  - At ≤640px the row stacks into one column and ✕ becomes a "Remove" text link.
  - Add moves focus to the new row's URL field. Remove moves focus to the next row or to Add.
  - The folder placeholder shows the derived name live, for example "auto: other".

**Validation (mirrors SPEC §2):**

| Field | Rule | Message |
|---|---|---|
| service | `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$` | "Use letters, numbers, . _ - and start with a letter or number (max 63)." |
| branch (and extra repo branch) | `^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$`, no `..` or `//`, does not end in `/` or `.lock` | "Not a valid branch name." |
| dockerfile | not empty, does not start with `/`, no `..` | "Use a path inside the repo, like Dockerfile or docker/Dockerfile." |
| build command | at most 2000 characters; a counter "1850 / 2000" appears past 1800 | "Max 2000 characters." |
| extra URL | same rule as the clone URL | (clone URL message) |
| extra folder | optional; when given, the service regex; unique; not equal to the main repo folder name; not `<service>_<ts>.tar` | "Folder “x” is already used in this build." |
| env | mode ≠ none and empty content | "Add the .env content. It isn't kept after a reload." |
| env_path | empty, absolute or contains `..` | "Use a path inside the repo, like .env or config/.env." |
| preload_tars | any non-empty line not starting with `/` | "One absolute path per line, like /app/python.tar." |

Review adds a `.env` row (`5 keys → .env (from GitLab CI)` / `(from file)` / `(pasted)`, or `None`) and a `Preload` row
(`1 image tar`) when set. `POST /api/jobs` gains `env: {content, path, source} | null` and `preload_tars: string[]`. Server 400s
`env…`, `env.content…`, `env.path…`, `preload_tars[i]…` map back to this step.

#### Step 3 `#/new/password` — "Protect the zip"

Subtitle: "The zip is encrypted with AES-256. Anyone who opens it will need this password."

```
  Password
  [ ••••••••                              (eye) ]    autocomplete=new-password, spellcheck=false
  Confirm password
  [ ••••••••                              (eye) ]    one eye toggles both
  ✓ At least 4 characters    ✓ Passwords match     live checklist, faint -> --success; aria-live=polite
  Generate a strong password                        ghost link
  (info) The password is never saved. Store it somewhere safe before you start.
```

- **Generate.** Fills both fields with 20 characters from `crypto.getRandomValues` (alphabet `A-Za-z0-9` without the look-alikes `0O1lI`), switches both fields to show, and copies the password to the clipboard with the toast "Password copied. Store it somewhere safe." The toast never contains the password.
- **Enter.** In Password, Enter moves to Confirm. In Confirm, Enter means Next.
- **Errors.** "At least 4 characters." under Password. "Passwords don't match." under Confirm.
- **Caps Lock.** If `getModifierState('CapsLock')` is on, show the hint "Caps Lock is on".

#### Step 4 `#/new/upload` — "Upload"

Fetch `GET /api/config/upload` when the step opens. While it loads, show one skeleton line.

When the server is configured (`enabled && host`):

```
  Send the zip to your server when it's ready.

  (◉) Upload to server                                      radio card, role=radiogroup
      sftp://deploy@files.example.com:22/releases           mono, muted
  ( ) Don't upload
      Keep the zip on this computer and download it from the build page.

  Server settings ↗                                         link -> #/settings (sets bp.return)
```

When it is not configured, or it is disabled:

```
  ┌ (info) No upload server is set up ─────────────────────────┐   warning-subtle
  │ The zip will stay on this computer. You can download it    │
  │ when the build finishes.                                   │
  │ [ Set up a server ]                                        │   secondary
  └────────────────────────────────────────────────────────────┘
```

Here the footer primary is still "Next: Review", and `upload = false`.

- **Default.** `upload = true` when the server is configured. The value maps to `upload: true|false` in the job request.
- **Settings round trip.** "Set up a server" and "Server settings" write `bp.return = '#/new/upload'` and go to `#/settings`. Settings then shows "← Back to build". Coming back re-fetches the config. The draft and the in-memory password survive, because no reload happens.
- **Load error.** "Couldn't read upload settings. This build will skip upload." The step treats the server as not configured.

#### Step 5 `#/new/review` — "Review and start"

Subtitle: "Nothing has been built yet."

```
  Repository     owner/myapp                                   Edit
  Branch         main                                          Edit
  Service        myapp  →  myapp_<timestamp>.zip                Edit
  Dockerfile     Dockerfile                                    Edit
  Build command  npm ci && npm run build                       Edit    (only if set)
  Extra repos    other (main), docs (dev)                      Edit    (only if any)
  Password       •••••••• set                                  Edit
  Upload         sftp://files.example.com:22/releases          Edit    or "Off — saved on this computer"

  ──────────────────────────────────────────────────────────────
  ← Back                                            [ ▶ Start build ]
```

- **Layout.** The summary is a `<dl>` with a 120px muted label column. Code-like values are in mono. Each "Edit" link has `aria-label="Edit <label>"` and jumps to its step.
- **Start build.** Build the body `b`, then run the client checks, including `b.password.length < 4` and `b.password !== b.password_confirm`. Then `POST /api/jobs`. While it is in flight the label is "Starting…" and the button is disabled.
- **201:** clear `state.password`, the confirm and all password inputs, and delete `bp.draft`. Then `location.replace('#/jobs/' + job.id)`, so that browser Back goes to the dashboard rather than back into the wizard.
- **400:** map `detail` to its field (§3), jump to that step, show the detail under the field with focus on it, and show the toast "Fix 1 issue before starting." If the detail does not map to a field, show it as an inline alert above the footer.
- **409:** an inline alert: "A build for <service> started this same second. Wait a moment and try again."
- **Network error:** the toast "Can't reach the local server." with a Retry action.

### 4.4 `#/jobs/<id>` — Run / build detail

The same view serves live and finished jobs. The column is 720px.

```
  ← Builds                                                        ghost link -> #/dashboard

  myapp                                              (pill) Running      h1 + pill
  owner/myapp · main · myapp_20261102_185400 · started 18:54 · 1:12      muted, mono parts

  [ RESULT CARD — only when finished, see 4.4.3 ]

  ✓  Prepare workspace                                         0.1s
  ✓  Clone repository                                          3.2s
  ◐  Build image                                               1:12      live tick
  │    Step 4/9 : RUN npm ci                                             latest message, muted, 1 line
  ○  Save image
  ○  Clone extra repositories
  ○  Encrypt zip
  ○  Upload

  Logs  ● live                         [Copy] [Download] [Wrap]  [▴ Hide]
  ┌──────────────────────────────────────────────────────────────────┐
  │ 18:54:01  ==> [clone] started                                    │
  │ 18:54:01  $ git clone --depth 1 --branch main -- https://***@…   │
  │ 18:54:04  Cloning into '…/myapp'...                              │
  │                                   [ ↓ Jump to latest (12 new) ]  │
  └──────────────────────────────────────────────────────────────────┘
```

**Data.**
- First paint uses `GET /api/jobs/{id}`.
- Then open `es = new EventSource('/api/jobs/' + id + '/logs/stream')`:
  - `log` appends a line;
  - `status` replaces the job and re-renders the header, the steps and the pill;
  - `es.addEventListener('end', …)` calls `es.close()`, renders the result card and invalidates the dashboard cache.
- Leaving the route calls `es.close()`.
- If `onerror` fires before `end` (readyState CONNECTING), the indicator changes to "Reconnecting…" in `--warning`. On the next `open`, clear the console, because the server replays the full log.

#### 4.4.1 Pipeline stepper

- **Element.** `<ol aria-label="Pipeline">`: 20px icons on a 1px connector line, one row of 40px per step.
- **Labels.**

  | Step name | Label |
  |---|---|
  | `prepare` | "Prepare workspace" |
  | `clone` | "Clone repository" |
  | `build` | "Build image" |
  | `save` | "Save image (.tar)" |
  | `extra_repos` | "Clone extra repositories" |
  | `zip` | "Encrypt zip" |
  | `upload` | "Upload" |

- **Duration.**
  - Formats: `0.4s` under 10s, `12s` under 60s, `1:12` under 1h, `1h 02m` above.
  - A finished step shows `finished_at - started_at`.
  - A running step ticks every 1s from `started_at`.
  - Pending steps show no duration.
- **Second line.**
  - running: the latest non-`==>` log line, faint, with an ellipsis;
  - failed: `message` in `--danger` on a `--danger-subtle` row background;
  - skipped: `message` in muted text ("skipped: upload disabled");
  - success: no second line.
- **Click.** Each row is a `<button>`. Clicking it scrolls the log to that step's `==> [<name>] started` line and highlights the line for 1.5s. If the log is hidden, it opens first.
- **Announcer.** A visually hidden `aria-live="polite"` region announces transitions: "Build image started", "Build image succeeded in 1 minute 12 seconds", "Build failed at Build image", "Build succeeded".

#### 4.4.2 Log console

- **Look.** Always dark: `--log-bg`, `--log-fg`, mono 12.5/20, padding 12px. Height is `min(60vh, 480px)`, or 60vh at ≤480px. `role="log"` with `aria-live="off"`, because the announcer carries the status.
- **Each line** is a `<div>` with a faint timestamp span `[HH:MM:SS]` and a text span, both set with `textContent`.
- **Line colors.**
  - `==>` lines: bold white, with a 1px top separator on `started` lines.
  - `$ ` lines: `--log-cmd`.
  - Lines matching `/failed|error|JOB FAILED/i`: `--log-err` on `--log-err-bg`.
  - `JOB SUCCESS`: `--log-ok`.
- **Follow.** On by default. Scrolling up more than 40px from the bottom pauses it and shows the floating chip "↓ Jump to latest (n new)". Clicking the chip, or pressing End inside the log, resumes following.
- **Toolbar.**
  - **Copy** copies all lines, with the toast "Log copied".
  - **Download** is `<a href="/api/jobs/{id}/log" target="_blank">`. Build it as `'/api/jobs/' + id + '/log'`.
  - **Wrap** toggles `white-space: pre-wrap`; the default is `pre`, and the log scrolls horizontally inside its own box.
  - **Hide/Show** is a `<button aria-expanded>`.
- **Live indicator.** "● live" with a pulsing `--success` dot while streaming, then "ended" after `end`.
- **Default visibility.** Shown while running and on a failed job. Collapsed when the view opens on a job that already succeeded.
- **Line cap.** At most 5,000 DOM lines. Older lines are dropped, and a top line reads "Earlier lines hidden. Download the full log."

#### 4.4.3 Result card

It appears above the stepper when `status` is success or failed, with a 150ms fade. On a live finish, focus moves to its headline (`tabindex=-1`).

Success (`--success-subtle` background, 3px `--success` left border, 12px radius):

```
  ✓ Build succeeded in 4m 12s                                            display
  myapp_20261102_185400.zip · 182 MB · AES-256                           mono
  Uploaded to sftp://files.example.com:22/releases/myapp_….zip  [Copy]   only if remote_path
  — or — Not uploaded. Download it below.
  [ ⤓ Download .zip ]   ⤓ Download .tar (540 MB · image only, not encrypted)   Rebuild   Back to dashboard
```

Failed (`--danger-subtle`, `--danger` left border):

```
  ✗ Build failed at Build image                                          display
  Dockerfile not found: Dockerfile                                       job.error, mono, --danger
  Try: check the Dockerfile path in Advanced options.                    hint by step (below)
  [ Rebuild ]   Show in log   Back to dashboard    (⤓ Download .tar if artifacts.tar; ⤓ .zip if artifacts.zip)
```

**Buttons.**
- The primary is Download .zip on success and Rebuild on failure.
- Downloads are `<a class="btn" href download>` pointing at `` `/api/jobs/${id}/download/zip` `` or `` `/api/jobs/${id}/download/tar` ``. They are **hidden**, not just disabled, when the matching `artifacts.*` flag is false.
- "Show in log" opens the log and scrolls to the failed step.

**Hints by failed step:**

| Failed step | Hint |
|---|---|
| prepare | "The build folder already exists. Try again in a second." |
| clone | "Check the branch name and that you have access to the repository." |
| build | If `error` starts with "Dockerfile not found": "Check the Dockerfile path in Advanced options." Otherwise: "See the docker build output in the log." |
| save, zip | "Check free disk space." |
| extra_repos | "Check the extra repository URL and branch." |
| upload | "Test the connection in Settings. The zip is still available to download." |

If `error` is "interrupted (server restart)", the headline is "Build interrupted" and the hint is "The server restarted while this build was running. Start it again."

#### 4.4.4 Header actions

A `⋯` menu next to the pill holds:
- "Copy folder name"
- "Copy job id"
- "Delete build…", disabled while running. It uses the same dialog as the dashboard; after deleting, go to `#/dashboard` and show the toast "Build deleted".

#### 4.4.5 States

- **Loading:** a skeleton header, 7 skeleton step rows and a dark console reading "Connecting…".
- **404, or an id that is not 32 hex characters:** a centered "Build not found. It may have been deleted." with [Back to dashboard].
- **A job that is already finished:** the result card is shown immediately. The SSE replays the log and closes.

#### 4.4.6 Rebuild

Rebuild is available from the result card and from the dashboard row menu.
1. Write `bp.draft` from the job: `repo_url`, `repo_full` (derived), `branch`, `service` (with `service_edited = true`), `dockerfile`, `build_command`, `extra_repos`, and `upload = upload_requested`.
2. Clear the password.
3. Go to `#/new/password`. Steps 1 and 2 show as done.
4. Show the info note "Settings copied from <folder_name>. Enter a zip password to continue."

When the job had a `.env` (`job.env`), the mode, path, source and `preload_tars` are copied (never the content) and the wizard goes
to `#/new/source` instead, with the note "Settings copied from <folder_name>. Add the .env again; it isn't kept."

The result card adds `#res-env` ".env: <count> keys (<path>)" and `#res-hc` "healthcheck.sh included" when set. The dashboard's
"Running · <Step> (n/N)" uses `steps.length`.

### 4.5 `#/settings` — Upload server

The link at the top reads "← Back to build" if `bp.return` is set, otherwise "← Dashboard". Following it clears `bp.return`.

```
  Upload server                                                         h1
  Where finished zips are sent, like FileZilla's Site Manager.

  Upload after each build                                    [ ●○ ]     role=switch, aria-checked

  Protocol        ( SFTP | FTP | FTPS )                                 segmented radiogroup
  Host            [ files.example.com           ]   Port [ 22  ]        grid 1fr 96px; stacks ≤480
  Username        [ deploy                      ]
  Password        [ Saved · leave blank to keep    (eye) ]   Remove saved password
  Private key     [ ~/.ssh/id_ed25519           ]   SFTP only (hidden otherwise)
                  Optional. Used instead of, or with, the password.
  Remote folder   [ /releases                   ]

  Uploads as sftp://deploy@files.example.com:22/releases/<service>_<timestamp>.zip     live, mono, faint

  ──────────────────────────────────────────────────────────────
  Test connection                                            [ Save ]
  ✓ Connected to files.example.com:22, remote_dir OK                    inline result, aria-live=polite
```

- **Layout.** Labels sit in a 140px left column on desktop and above the fields at ≤640px.
- **Load.** `GET /api/config/upload`, with field skeletons while loading. A load error shows "Couldn't load settings. <detail>" with [Retry].
- **Upload switch off.** The fields are dimmed to 60% opacity but stay editable, with the note "Uploads are off. Your settings are kept."
- **Protocol.** Changing it sets the port to 22 for SFTP and 21 for FTP or FTPS, unless the user has edited the port. With FTP selected, a warning appears: "FTP sends your password unencrypted. Prefer SFTP or FTPS."
- **Password.** When `has_password` is true, the placeholder is "Saved · leave blank to keep". A blank field means `password` is omitted from the PUT. "Remove saved password" opens the dialog "Remove the saved password?" and then sends `password: ""`.
- **Validation.**
  - When enabled with no host: "Enter a host to enable uploads."
  - Port outside 1–65535: "Port must be 1–65535."
  - Empty remote folder: "Remote folder is required."
  - A 400 `detail` from the server shows inline under the matching field, or as an alert.
- **Save.** `PUT /api/config/upload`, busy label "Saving…". On 200, show the toast "Settings saved", clear the password input and mark the form clean.
- **Test connection.**
  - If the form is dirty, the label is "Save & test", and it does a PUT followed by `POST /api/config/upload/test`. The helper explains: "Testing uses the saved settings."
  - Busy label: "Testing… (up to 15s)".
  - `ok:true` shows a check and the message in `--success`. `ok:false` shows an x and the message in mono, in `--danger`. A 400 shows "Enter a host first."
- **Unsaved changes.** Navigating away with unsaved changes opens the dialog "Discard unsaved changes?" [Keep editing] [Discard].
- **Keyboard.** Enter in a field means Save.
- **SMB.** Protocol gains SMB (port 445; the port map is `{sftp: 22, ftp: 21, ftps: 21, smb: 445}`, a hand-edited port is kept).
  SMB shows `#share` (required when a host is set: "Enter the share name, e.g. releases.", help "Share name on the server, e.g.
  releases") and `#domain` (optional, "Leave empty unless your server needs DOMAIN\user"), hides the private key, and the remote
  path help becomes "Folder inside the share, e.g. /builds". The preview and the wizard show `smb://host:445/<share>/<dir>`.

**GitLab** (`section#gitlab-cfg`, below the upload card; no `.wfoot`, no `.test-res`):

```
  GitLab                                                                       h2
  GitLab: http://192.168.33.175 · signed in as @dev (OAuth)                    #gl-cfg-url (or "not signed in")
  OAuth application ID      [ … ]          #gl-client-id; help "From the GITLAB_CLIENT_ID environment variable." when from env
  OAuth application secret  [ (saved) · leave blank to keep ]     #gl-client-secret
  Register one application in GitLab for both tools: redirect URIs http://127.0.0.1:8090/api/auth/gitlab/callback and
  http://127.0.0.1:8095/api/auth/gitlab/callback, scope api, Confidential off (PKCE).
  http://127.0.0.1:8090/api/auth/gitlab/callback  [Copy]                       #gl-redirect (localhost → 127.0.0.1)
  [ Save GitLab settings ]       PUT /api/config/gitlab → toast "GitLab settings saved", re-read /api/auth/status
```

**Import .env** (`section#env-import`; no `.wfoot`; `.test-res` only inside `#env-import-res` after a result):

- Help "Fills these settings from a .env file. Values are never shown back." `input#env-import-file` reads into
  `Textarea#env-import-text` (data-secret, 5 rows). [Import .env] → `POST /api/config/import-env {content}`.
- `#env-import-res`: `.test-res.ok` "Set: upload.host, upload.share, gitlab_url", muted "Ignored: …", one `.test-res.bad` per error.
- Afterwards the textarea is cleared, the upload card reloads with fresh values, and the auth status is re-read.

---

## 5. Accessibility and keyboard

- Every input has a `<label for>`. Helper and error text are linked through `aria-describedby`. Invalid fields get `aria-invalid`.
- `:focus-visible { box-shadow: var(--focus); outline: none }` applies to every interactive element, and it is never removed. A skip link "Skip to content" is the first tab stop on shell screens.
- Tab order follows the visual order. Hit targets are at least 44px at ≤480px.
- Live regions:
  - toasts (`status` or `alert`);
  - the run announcer (`polite`);
  - the device-flow waiting line;
  - the password checklist;
  - the settings test result.
- Keys:

  | Where | Key | Action |
  |---|---|---|
  | wizard | Enter | Next or Start |
  | wizard textarea | Ctrl/Cmd+Enter | Next |
  | wizard | Esc | Cancel |
  | repo list | ↑/↓ | move the active option |
  | repo list | Enter | pick and go Next |
  | menus | ↑/↓, Enter, Esc | move, activate, close |
  | dialogs | Esc | cancel |
  | dashboard | `N` (when not typing) | New build |
  | log | End | resume following |
- Status is never shown by color alone: it always has an icon plus a word or label. All text pairs meet AA (4.5:1). `--fg-faint` is used only for non-essential text of 12px or larger.
- `<html lang="en">`. Every icon-only button has an `aria-label`.

## 6. Responsive (reference width 375px)

- No horizontal page scroll anywhere. Only the log scrolls sideways, and only inside its box.
- At ≤480px:
  - **Top bar:** the logo, the gear icon and the avatar.
  - **Dashboard:** tiles are 2×2 with Last build spanning the full width, and rows have two lines.
  - **Wizard:** the stepper becomes "Step n of 5 · Label" with a bar, the footer is sticky, and the primary button is full width.
  - **Settings:** labels sit above the fields.
  - **Result card:** buttons stack at full width with the primary first.

## 7. Backend changes

GitLab + `.env` + SMB release (2026-11-03, SPEC GitLab section) adds these routes used by the UI:
`POST /api/auth/gitlab/token`, `GET /api/auth/gitlab/start` (full-page navigation; callback `/api/auth/gitlab/callback`),
`GET /api/gitlab/projects`, `GET /api/gitlab/branches?project=`, `POST /api/gitlab/env-preview`, `GET|PUT /api/config/gitlab`,
`POST /api/config/import-env`. `GET /api/auth/status` gains `provider`, `github`, `gitlab {logged_in, login, avatar_url, url, method,
oauth_available}` and `oauth_error`; the upload config gains `share`/`domain`; jobs gain `env`, `preload_tars`, `healthcheck`.
When `provider === 'gitlab'`, step 1 lists `GET /api/gitlab/projects` (subtitle "Your projects on <gitlab url>").

The v2 redesign itself needed **no** backend changes:
- Dashboard stats, durations, the current step, `owner/repo` and the hints are all computed on the client from `GET /api/jobs` and `GET /api/jobs/{id}`.
- `default_branch` comes from `GET /api/github/repos`.
- The upload state comes from `GET /api/config/upload`.
- Rebuild uses fields that are already in the job object.

`app.py`, SPEC §4–6 and `tests/e2e_test.py` stay unchanged. After the redesign, update SPEC §7 to point to this file.

---

## 8. UX acceptance checklist

Run these at 1280×800 and at 375×812, in light and in dark mode (DevTools → Rendering → `prefers-color-scheme`). Take a screenshot for each item.

1. **UX-1** Logged out, `/` → `#/login`. The only things visible are the logo, the title, the tagline, "Continue with GitHub", the "Use a personal access token" disclosure (collapsed), the device-code button only if `device_flow_available` is true, and the footnote. There is no top bar, no build form and no settings.
2. **UX-2** On load, "Continue with GitHub" has focus, and pressing Enter triggers it. With gh missing, the inline alert mentions `gh auth login`, and the PAT disclosure opens with the token field focused.
3. **UX-3** An empty PAT shows "Paste a token first." and sends no request. A bad PAT shows "GitHub rejected this token…" and clears the field. A valid PAT goes to `#/dashboard` with the toast "Signed in as @<login>".
4. **UX-4** With `GITHUB_CLIENT_ID` set, the device flow shows the code in 32px mono, a Copy button, an "Open github.com/login/device" link (new tab), "Waiting for authorization…" with a countdown, and Cancel, which returns to the main panel.
5. **UX-5** Signed in, the top bar shows the logo, Settings, the avatar and the login. The avatar menu has "Signed in as @<login>" and "Sign out". Sign out goes to `#/login`.
6. **UX-6** The dashboard with jobs shows 4 tiles (Total builds, Succeeded, Failed, Last build) whose numbers match `GET /api/jobs`. Failed is red only when above 0. Clicking the Last build tile opens that job.
7. **UX-7** Each dashboard row shows a status icon, the service, `owner/repo · branch`, the duration, the relative time (with the absolute time in a tooltip) and a second status line. A failed row reads "Failed at <Step> · <error>" in red.
8. **UX-8** The dashboard with no jobs shows only "No builds yet", one sentence and a single "+ New build" button. There are no tiles and no header button.
9. **UX-9** The dashboard shows no upload settings, no filters and no build form. Settings is reachable only from the top bar.
10. **UX-10** The row ⋯ menu has View, Rebuild, Download .zip (only if a zip exists) and Delete…. Delete is disabled on a running job. The dialog names the folder, and confirming removes the row and shows the toast "Build deleted".
11. **UX-11** While a job runs, its dashboard row ticks the duration and updates "Running · <Step> (n/7)" without a reload. Polling stops when no jobs are running (check the Network panel).
12. **UX-12** "+ New build" → `#/new/repo`. The stepper shows 5 steps with step 1 current. The top bar shows only the logo and Cancel.
13. **UX-13** The repo search is focused. Typing filters the list. ↑/↓ then Enter selects the repo and moves to `#/new/source`. Private repos show a lock.
14. **UX-14** Pressing Next with nothing selected shows "Select a repository to continue." "Paste a clone URL" with `bad url` shows the Git URL error. A valid `/abs/path` is accepted.
15. **UX-15** After picking `owner/myapp` (default branch `dev`), step 2 shows Branch = "dev (default)" in a select and Service = `myapp`, and the preview line reads `myapp:<timestamp>`. Advanced is collapsed.
16. **UX-16** Service `-bad` plus Next shows the service error inline, focuses the field and keeps the route. Service `MyApp` shows the lowercase tag note.
17. **UX-17** Expanding Advanced shows the Dockerfile (default `Dockerfile`), Build command and Extra repositories. Adding 2 extra repos with the same folder shows the uniqueness error. After collapsing, the summary shows "· N set".
18. **UX-18** On the password step, a 3-character password plus Next shows "At least 4 characters." A mismatch shows "Passwords don't match." The checklist turns green when both rules pass. The eye toggles both fields, and its `aria-pressed` changes.
19. **UX-19** "Generate a strong password" fills both fields with 20 characters, shows them and shows the toast "Password copied…". The toast does not contain the password.
20. **UX-20** With upload not configured, the upload step shows the "No upload server is set up" callout with "Set up a server". With it configured, it shows two radio cards, and "Upload to server" with the URL is preselected.
21. **UX-21** "Set up a server" → `#/settings` with "← Back to build". Save, then go back, and the upload step reflects the new config. Earlier fields and the password are kept, and there is no re-entry prompt.
22. **UX-22** Review lists every value, with an Edit per row. Rows for build command and extra repos appear only when set. Edit → step → the primary button reads "Back to review".
23. **UX-23** Refreshing on `#/new/review` lands on `#/new/password` with the reload note, while the repo, branch and service are kept. DevTools → Application shows no password in localStorage or sessionStorage, and no secret in the URL.
24. **UX-24** "Start build" shows "Starting…" and is disabled, then goes to `#/jobs/<id>`. Browser Back from there goes to the dashboard, not to the wizard.
25. **UX-25** On a forced 400 (for example a service rejected by the server), the wizard jumps to the owning step and shows the `detail` text under the field.
26. **UX-26** The run view shows the h1 service, a status pill, a meta line and 7 steps with the exact labels from §4.4.1. The running step has a spinner and a ticking duration. Pending steps have hollow circles.
27. **UX-27** The log auto-scrolls while running. Scrolling up shows "↓ Jump to latest (n new)", and clicking it resumes following. `==>` lines are bold, `$` lines are cyan, and error lines are red-tinted.
28. **UX-28** The log toolbar Copy shows the toast "Log copied". Download opens the raw log. Wrap toggles wrapping. Hide/Show collapses the console and updates `aria-expanded`.
29. **UX-29** On success, the green result card shows the duration, the zip name and size, the upload target or "Not uploaded", Download .zip (primary), Download .tar with the "not encrypted" note, Rebuild and Back to dashboard. Both downloads save files.
30. **UX-30** On failure (for example a missing Dockerfile), the red card reads "Build failed at Build image", the error is in mono, and the matching hint shows. The failed step row is red, and the later steps stay pending. The tab title starts with "✗".
31. **UX-31** Rebuild from a finished job lands on `#/new/password` with the note "Settings copied from …". Steps 1 and 2 show as done, and Review shows the original values.
32. **UX-32** Opening a finished job from the dashboard shows the result card immediately, plus the full log (collapsed on success) and every step state.
33. **UX-33** `#/jobs/0000…` (32 zeros) and `#/jobs/abc` show "Build not found…" with [Back to dashboard].
34. **UX-34** Settings: switching the protocol to FTP sets the port to 21 and shows the FTP warning. The Private key field is hidden for FTP and FTPS. A saved password shows the placeholder "Saved · leave blank to keep".
35. **UX-35** Settings: with the form dirty, the button reads "Save & test". The test result shows inline in green or red. Leaving the page while dirty asks "Discard unsaved changes?".
36. **UX-36** Keyboard only: the whole flow (sign in → New build → 5 steps → Start → result → Back to dashboard) can be completed without a mouse. A focus ring is visible on every stop, and Esc in the wizard opens the discard dialog when the draft is dirty.
37. **UX-37** Screen reader / accessibility tree: every input has a name, the stepper has `aria-current="step"`, and the run announcer announces step transitions. Status pills include text.
38. **UX-38** At 375px no screen scrolls horizontally. The wizard footer is sticky with a full-width primary. Tiles are 2×2. Result card buttons stack.
39. **UX-39** In dark mode, every screen uses the dark tokens and has no white flashes. The log console is dark in both themes, and text contrast passes AA (Lighthouse a11y has no contrast failures).
40. **UX-40** With `prefers-reduced-motion: reduce`, there are no transitions, the spinners are static rings and there is no skeleton shimmer.
41. **UX-41** On every route change, focus moves to the h1 and `document.title` updates. While a job runs, the run view tab title starts with "●".
42. **UX-42** `python tests/e2e_test.py` passes. `grep -rc innerHTML frontend/src ../shared-ui/src` finds nothing. The network panel shows no request to any external host other than avatars.githubusercontent.com.
43. **UX-43** GitLab login: `#gl-continue` "Continue with GitLab" first, then `p.or`, then the GitHub block; with OAuth it navigates to
   `/api/auth/gitlab/start` and has focus, without OAuth "Continue with GitHub" has focus and `#gl-continue` opens `form#gl-token`
   (`#gl-url`, `#gl-pat`, `#gl-pat-err`, Back). Errors per §4.1. Footnote "Runs locally · tokens stay on this computer".
44. **UX-44** Signed in to GitLab, step 1 lists projects as `group/sub/name`, step 2 lists GitLab branches, and `#env-field` offers
   "From GitLab CI": `#env-gen` fills `ul#env-keys` (masked), `#env-missing` lists missing variables. No `.env` value in
   sessionStorage (`bp.draft`), the URL or toasts; after a reload the content is gone and Next shows the `env` error.
45. **UX-45** Advanced has `#env_path` and `#preload_tars`; Review shows `.env` and `Preload`; the run result shows `#res-env` / `#res-hc`.
   Rebuild of a job with `.env` lands on `#/new/source` with the "Add the .env again" note.
46. **UX-46** Settings: SMB shows `#share`/`#domain`, port 445, hides Private key; `section#gitlab-cfg` and `section#env-import` work
   as in §4.5 and contain no `.wfoot`.
