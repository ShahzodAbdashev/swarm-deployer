// Sign-in: GitLab first (OAuth when configured, else an access token), then GitHub: gh CLI, token (collapsed), device flow.
import {alertBox, btn, busy, copyText, field, h, icon, input, pw, showErr, spinner, toast} from './ui.js';
import {GITLAB_START, authApi, errDetail, getAuth, router, session, setAuth, setTitle} from './state.js';

const errFor = e => {
  const {status, detail} = errDetail(e);
  return status === 401 ? 'GitHub rejected this token. It may be expired or revoked.'
    : status === 502 ? "Couldn't reach GitHub. Check your connection and try again." : detail;
};
const glErrFor = (e, url) => {
  const {status, detail} = errDetail(e);
  return status === 401 ? 'GitLab rejected this token. It may be expired or revoked.'
    : status === 502 ? "Couldn't reach GitLab at " + url + '. Check the URL and your network.' : detail;
};

function goBack() {
  const back = session.returnTo;
  session.returnTo = null;
  router.go(back && !back.startsWith('#/login') ? back : '#/dashboard');
}

export function loginPage(main) {
  setTitle('Sign in');
  const auth = getAuth(), gl = auth.gitlab, oauth = !!gl.oauth_available;
  let glUrl = gl.url || '', stopDevice = null;

  const live = h('div', {'aria-live': 'polite', hidden: true});
  const setError = (...nodes) => { live.replaceChildren(...(nodes.length ? [alertBox('error', nodes)] : [])); live.hidden = !nodes.length; };
  const stack = h('div', {class: 'stack'});
  const lockAll = on => stack.querySelectorAll('button,input').forEach(e => { e.disabled = on; });
  /** Busy label on `b`, every control locked; failures unlock and rethrow. */
  const run = async (b, label, fn) => {
    setError();
    busy(b, label);
    lockAll(true);
    try { await fn(); } catch (e) { busy(b, null); lockAll(false); throw e; }
  };
  const meta = text => h('p', {class: 'meta', style: {marginTop: 'calc(-1 * var(--s2))'}}, text);

  main.append(h('div', {class: 'login'}, h('div', {class: 'panel'},
    h('div', {class: 'brand'}, h('span', {class: 'mark'}, icon('box')), h('h1', {class: 'display'}, 'Build Packager'),
      h('p', {class: 'muted'}, 'Build, package and ship a repo in one go.')),
    stack,
    h('p', {class: 'micro foot-note'}, 'Runs locally · tokens stay on this computer'))));

  const success = d => {
    setAuth({logged_in: true, login: d.login, avatar_url: d.avatar_url});
    toast('Signed in as @' + d.login, 'success');
    goBack();
  };

  // ---------------------------------------------------------------- main view
  function mainView() {
    const glBtn = btn('primary lg full', [icon('gitlab'), 'Continue with GitLab'], () => {
      setError();
      if (!oauth) { tokenView(); return; }
      busy(glBtn, 'Opening GitLab…');
      lockAll(true);
      location.href = GITLAB_START;
    }, {id: 'gl-continue'});
    const ghBtn = btn('github lg full', [icon('github'), 'Continue with GitHub'], () => run(ghBtn, 'Checking gh CLI…', async () => {
      success(await authApi.ghCli());
    }).catch(e => {
      if (errDetail(e).status === 400) {
        setError(h('b', {}, "gh CLI isn't installed or isn't signed in."),
          h('span', {}, 'Run ', h('code', {}, 'gh auth login'), ' in a terminal and try again, or use a token below.'));
        details.open = true;
        setTimeout(() => patIn.focus(), 0);
      } else setError(h('span', {}, errFor(e)));
    }));

    const patWrap = pw({id: 'pat', placeholder: 'ghp_…', 'data-secret': '1'});
    const patIn = patWrap.querySelector('input');
    const patBtn = h('button', {class: 'btn secondary full', type: 'submit'}, 'Sign in with token');
    const patForm = h('form', {class: 'pat'},
      field('pat', 'Personal access token', patWrap, {help: [
        'Needs the repo scope. ',
        h('a', {href: 'https://github.com/settings/tokens/new?scopes=repo&description=Build%20Packager', target: '_blank', rel: 'noopener'}, 'Create one ', icon('external')),
      ]}),
      patBtn);
    patForm.onsubmit = e => {
      e.preventDefault();
      const v = patIn.value.trim();
      showErr('pat', null);
      if (!v) { showErr('pat', 'Paste a token first.'); patIn.focus(); return; }
      run(patBtn, 'Signing in…', async () => success(await authApi.token(v))).catch(err => {
        setError(h('span', {}, errFor(err)));
        if (errDetail(err).status === 401) { patIn.value = ''; patIn.focus(); }
      });
    };
    const details = h('details', {}, h('summary', {}, 'Use a personal access token ', icon('chevron-down')), patForm);

    stack.replaceChildren(
      glBtn,
      meta(oauth ? 'Signs in at ' + (gl.url || '') : 'Self-hosted GitLab at ' + (gl.url || '') + ' · paste an access token'),
      oauth ? btn('ghost full', 'Use a GitLab access token', () => { setError(); tokenView(); }, {id: 'gl-use-token'}) : null,
      h('p', {class: 'or'}, 'or'),
      ghBtn,
      meta('Uses your local gh CLI sign-in'),
      auth.device_flow_available ? btn('secondary lg full', 'Sign in with a device code', () => { setError(); deviceView(); }) : null,
      details,
      live,
    );
    return {glBtn, ghBtn};
  }

  // ---------------------------------------------------------------- GitLab token view
  function tokenView() {
    const urlIn = input({id: 'gl-url', mono: true, value: glUrl, oninput: e => { glUrl = e.target.value; }});
    const patWrap = pw({id: 'gl-pat', placeholder: 'glpat-…', 'data-secret': '1'});
    const patIn = patWrap.querySelector('input');
    const submit = h('button', {class: 'btn primary full', type: 'submit'}, 'Sign in with GitLab token');
    const form = h('form', {id: 'gl-token', class: 'pat'},
      h('h2', {}, 'Sign in to GitLab'),
      field('gl-url', 'GitLab URL', urlIn, {help: 'Your self-hosted GitLab, e.g. http://192.168.33.175'}),
      field('gl-pat', 'Personal access token', patWrap, {help: 'Needs read_api + read_repository (api to read CI/CD variables).'}),
      submit,
      btn('ghost full', 'Back', () => { setError(); mainView().glBtn.focus(); }),
      live);
    form.onsubmit = e => {
      e.preventDefault();
      const v = patIn.value.trim(), url = glUrl.trim();
      showErr('gl-pat', null);
      if (!v) { showErr('gl-pat', 'Paste a token first.'); patIn.focus(); return; }
      run(submit, 'Signing in…', async () => {
        await authApi.gitlabToken(v, url);
        const st = await authApi.status(); // the token endpoint's response isn't the status shape: re-read it
        setAuth(st);
        toast('Signed in as @' + (st.gitlab?.login || st.login || ''), 'success');
        goBack();
      }).catch(err => {
        setError(h('span', {}, glErrFor(err, url || gl.url || '')));
        if (errDetail(err).status === 401) { patIn.value = ''; patIn.focus(); }
      });
    };
    stack.replaceChildren(form);
    patIn.focus();
  }

  // ---------------------------------------------------------------- GitHub device flow: show the code, poll, expire
  function deviceView() {
    let dead = false, poll = 0, tick = 0;
    const stop = () => { clearTimeout(poll); clearInterval(tick); };
    stopDevice = () => { dead = true; stop(); };
    const back = () => { stopDevice(); stopDevice = null; mainView().ghBtn.focus(); };
    const fail = (msg, again) => {
      stop();
      if (dead) return;
      const b = btn('secondary', again, deviceView);
      stack.replaceChildren(alertBox('error', h('span', {}, msg)), b, btn('ghost', 'Back', back));
      b.focus();
    };
    const starting = btn('secondary lg full', 'Sign in with a device code');
    stack.replaceChildren(starting);
    busy(starting, 'Requesting code…');

    authApi.deviceStart().then(async d => {
      if (dead) return;
      let interval = (d.interval || 5) * 1000, remaining = d.expires_in || 900;
      const vuri = d.verification_uri || 'https://github.com/login/device';
      const left = h('span', {class: 'faint'});
      const paintLeft = () => { left.textContent = Math.floor(remaining / 60) + ':' + String(remaining % 60).padStart(2, '0') + ' left'; };
      paintLeft();
      stack.replaceChildren(
        h('p', {class: 'muted'}, 'Enter this code on GitHub'),
        h('div', {class: 'row-flex', style: {justifyContent: 'center'}}, h('span', {class: 'code-box'}, d.user_code),
          btn('secondary', [icon('copy'), 'Copy'], async () => { if (await copyText(d.user_code)) toast('Code copied'); })),
        h('a', {class: 'btn primary lg full', href: vuri, target: '_blank', rel: 'noopener'}, 'Open ' + vuri.replace(/^https?:\/\//, ''), icon('external')),
        h('div', {class: 'waiting', 'aria-live': 'polite'}, spinner(), h('span', {}, 'Waiting for authorization…'), left),
        btn('ghost', 'Cancel', back));
      tick = setInterval(() => {
        remaining = Math.max(0, remaining - 1);
        paintLeft();
        if (!remaining) fail('The code expired.', 'Get a new code');
      }, 1000);
      if (await copyText(d.user_code)) toast('Code copied');
      const doPoll = async () => {
        let r;
        try { r = await authApi.devicePoll(d.device_code); }
        catch (e) { return fail('Sign-in failed: ' + errDetail(e).detail + '.', 'Try again'); }
        if (dead) return;
        if (r.status === 'ok') { stopDevice(); return success(r); }
        if (r.status === 'slow_down') interval = (r.interval || 10) * 1000;
        if (r.status === 'error') {
          if (r.error === 'expired_token') return fail('The code expired.', 'Get a new code');
          if (r.error === 'access_denied') return fail('Authorization was denied on GitHub.', 'Try again');
          return fail('Sign-in failed: ' + r.error + '.', 'Try again');
        }
        poll = setTimeout(doPoll, interval);
      };
      poll = setTimeout(doPoll, interval);
    }).catch(e => { if (!dead) { toast(errDetail(e).detail, 'error'); back(); } });
  }

  const {glBtn, ghBtn} = mainView();
  if (auth.oauth_error) { setError(h('span', {}, auth.oauth_error)); setAuth({oauth_error: null}); }
  (oauth ? glBtn : ghBtn).focus();
  return () => stopDevice?.();
}
