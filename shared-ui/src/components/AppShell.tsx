import {useState, type MouseEvent, type ReactNode} from 'react';
import {Announcer, ConfirmHost, Toaster} from './Feedback';
import {Icon, Spinner} from './Icon';
import './AppShell.css';

/** Page frame: skip link, sticky top bar, <main id="main">, and the toast / dialog / live-region hosts. */
export function AppShell({top, topHidden, booting, children}: {top?: ReactNode; topHidden?: boolean; booting?: boolean; children?: ReactNode}) {
  const focusMain = (e: MouseEvent) => {
    e.preventDefault();
    const main = document.getElementById('main');
    (main?.querySelector('h1') || main)?.focus();
  };
  return (
    <>
      <a className="skip" href="#main" id="skip" hidden={topHidden} onClick={focusMain}>Skip to content</a>
      <header id="top" hidden={topHidden}>{topHidden ? null : top}</header>
      <main id="main" tabIndex={-1}>{children}</main>
      <div id="boot" hidden={!booting}><Spinner className="lg" /><span className="sr">Loading</span></div>
      <Toaster />
      <Announcer />
      <ConfirmHost />
    </>
  );
}

/** Product mark + name linking home. `mark` puts the glyph in a small filled accent box. */
export function Logo({href, name, icon = 'box', mark}: {href: string; name: string; icon?: string; mark?: boolean}) {
  return <a className="logo" href={href}>{mark ? <span className="mark"><Icon name={icon} /></span> : <Icon name={icon} className="lg" />}{name}</a>;
}

/** GitHub-style avatar: image, falling back to the first letter of the login. */
export function Avatar({login, url}: {login: string; url?: string | null}) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) return <span className="avatar" aria-hidden="true">{(login || '?').charAt(0)}</span>;
  return <img className="avatar" src={url} alt="" width={24} height={24} onError={() => setBroken(true)} />;
}
