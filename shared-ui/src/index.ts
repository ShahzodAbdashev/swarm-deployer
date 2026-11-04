// @devtools/ui: shared design system for Build Packager and Swarm Deployer.
// Global styles first so component styles can build on the tokens.
import './styles/tokens.css';
import './styles/base.css';

export {Icon, Spinner, StatusIcon, type IconName, type Status} from './components/Icon';
export {Button, buttonClass, type ButtonProps, type ButtonVariant} from './components/Button';
export {Field, FieldControl, ErrorText, Input, Textarea, Select, PasswordInput, type FieldProps} from './components/Field';
export {Switch, SegmentedControl, RadioCards, type Choice, type RadioCardOption} from './components/Controls';
export {Alert, StatusBadge, statusText, Badge, StatTiles, StatTile, Card, ResultCard, Skeleton, SkeletonRows, EmptyState,
  type AlertKind} from './components/Display';
export {toast, Toaster, confirm, ConfirmHost, isDialogOpen, announce, Announcer, type ConfirmOptions, type ToastKind} from './components/Feedback';
export {MenuButton, isMenuOpen, type MenuItem, type MenuEntry} from './components/Menu';
export {Stepper, StepHead, WizardFooter, type WizardStep} from './components/Wizard';
export {Pipeline, type PipelineItem} from './components/Pipeline';
export {LogConsole, useLogBuffer, parseLogLine, defaultLogClass, dimLine, type LogLine, type LogConsoleHandle} from './components/LogConsole';
export {AppShell, Logo, Avatar} from './components/AppShell';

export {createHashRouter, type HashRouter, type LeaveAsk, type LeaveGuard, type RouteSnapshot} from './hooks/hashRouter';
export {useEventSource, useInterval, type EventSourceHandlers} from './hooks/useEventSource';

export {createApi, ApiError, errDetail, type ApiFn, type ApiOptions} from './lib/api';
export {parseT, fmtDur, fmtDurLong, spoken, fmtRel, fmtSize, hhmm, localTime} from './lib/format';
export {sget, sset, copyText} from './lib/browser';
