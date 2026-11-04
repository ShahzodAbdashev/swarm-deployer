# @devtools/ui

Shared React design system for **Build Packager** and **Swarm Deployer**: one look, one set of components.

## Consumers

| App | Frontend | Notes |
|---|---|---|
| Build Packager | `../build-packager/frontend` | default log classes, `Logo` with plain glyph |
| Swarm Deployer | `../swarm-deployer/frontend` | own log classifier (`useLogBuffer({classify})`), `<Logo mark />` |

A kit change must keep both apps building (`npm run typecheck && npm run build` in each) and their browser tests green.

It ships TypeScript source (no build step of its own). Each app depends on it with
`"@devtools/ui": "file:../../shared-ui"` and Vite compiles it with the app.

## Use in an app

```jsonc
// package.json
"dependencies": {"@devtools/ui": "file:../../shared-ui", "react": "19.3.1", "react-dom": "19.3.1"}
```
```ts
// vite.config.ts: the kit is a symlink; resolve its react/react-dom from the app (one React instance)
resolve: {preserveSymlinks: true, dedupe: ['react', 'react-dom']},
optimizeDeps: {exclude: ['@devtools/ui']},
```
```jsonc
// tsconfig.json
"compilerOptions": {"preserveSymlinks": true, "jsx": "react-jsx", "moduleResolution": "Bundler"}
```
Add `install-links=false` to the app's `.npmrc` so npm links the kit instead of copying it.

```tsx
import '@devtools/ui';                       // tokens + base styles (import once, first)
import {AppShell, Button, Field, Input, toast} from '@devtools/ui';
```

## Contents

```
src/
  styles/tokens.css      colours, spacing, radii, fonts; light + dark (prefers-color-scheme)
  styles/base.css        reset, typography, utilities (.muted .sr .stack …), page layout (.wrap .page-head …)
  components/
    Icon.tsx             Icon (inline SVG set), Spinner, StatusIcon
    Button.tsx           Button (variants, sizes, busy state), buttonClass() for <a> buttons
    Field.tsx            Field (label/help/error + aria wiring), FieldControl, ErrorText, Input, Textarea, Select, PasswordInput
    Controls.tsx         Switch, SegmentedControl, RadioCards
    Display.tsx          Alert, StatusBadge, Badge, StatTiles/StatTile, Card, ResultCard, Skeleton, SkeletonRows, EmptyState
    Feedback.tsx         toast() + <Toaster>, confirm() + <ConfirmHost>, announce() + <Announcer>, isDialogOpen()
    Menu.tsx             MenuButton (keyboard menu in a portal), isMenuOpen()
    Wizard.tsx           Stepper, StepHead, WizardFooter
    Pipeline.tsx         Pipeline (job steps with status, duration, detail line)
    LogConsole.tsx       LogConsole (follow tail, jump chip, copy/download/wrap/hide), useLogBuffer({classify}), parseLogLine, defaultLogClass
    AppShell.tsx         AppShell (skip link, #top, #main, feedback hosts), Logo (optional filled `mark`), Avatar
  hooks/
    hashRouter.ts        createHashRouter(): useRoute, go, refresh, leave guards (unsaved-changes dialogs)
    useEventSource.ts    useEventSource (SSE log/status/end), useInterval
  lib/
    api.ts               createApi() fetch wrapper; {detail} errors -> ApiError(status, detail)
    format.ts            fmtDur, fmtDurLong, fmtRel, fmtSize, hhmm, spoken, parseT
    browser.ts           sget/sset (safe sessionStorage), copyText
```

## Conventions

- **Plain CSS per component, global class names** (`.btn.primary`, `.pstep.ps-failed`, `.rcard` …). Both apps'
  browser tests select by these names, so they are part of the contract. Don't rename them.
- **Imperative feedback** (`toast`, `confirm`, `announce`) works from anywhere, including non-React code such as the
  API client, as long as `<AppShell>` is mounted.
- **Accessibility built in**: Field wires `aria-describedby`/`aria-invalid`, dialogs restore focus, menus support
  arrow keys / Escape, status changes go to a polite live region.
- **No runtime dependencies** besides React 19.
