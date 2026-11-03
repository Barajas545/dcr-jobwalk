// main.js — start the app, and move between screens.
//
// Screens are addressed by the URL hash, so the phone's back button, a
// reload, and a Home Screen relaunch all land where the person was:
//
//   #/                         job walks (home)
//   #/settings                 settings
//   #/trash                    Recently Deleted
//   #/p/<pid>                  a job walk: plan or map, position, items
//   #/p/<pid>/camera           camera (?mode=photo|video)
//   #/p/<pid>/i/<iid>          one photo, video or note
//   #/p/<pid>/i/<iid>/annotate markup editor
//   #/p/<pid>/calibrate/<lid>  calibration wizard for a level (?mode=gps|map|scale|compass)
//   #/p/<pid>/export           backup, export and share
//
// A screen module exports `open(ctx)` and may return a cleanup function
// (docs/SPEC.md, "Screens"). Each screen gets a fresh root element; the
// previous one is cleaned up first.

import { APP_VERSION } from './version.js';
import { bus } from './core/bus.js';
import * as store from './core/store.js';
import { initSettings, getSettings, updateSettings } from './core/settings.js';
import { positioning } from './core/positioning.js';
import * as shell from './ui/shell.js';

const ROUTES = [
  { re: /^$/, load: () => import('./ui/projects-screen.js') },
  { re: /^settings$/, load: () => import('./ui/settings-screen.js') },
  { re: /^trash$/, load: () => import('./ui/trash-screen.js') },
  { re: /^p\/([^/]+)$/, keys: ['pid'], load: () => import('./ui/project-screen.js'), project: true },
  { re: /^p\/([^/]+)\/camera$/, keys: ['pid'], load: () => import('./ui/camera-screen.js'), project: true },
  { re: /^p\/([^/]+)\/i\/([^/]+)$/, keys: ['pid', 'iid'], load: () => import('./ui/item-screen.js'), project: true },
  { re: /^p\/([^/]+)\/i\/([^/]+)\/annotate$/, keys: ['pid', 'iid'], load: () => import('./ui/annotate-screen.js'), project: true },
  { re: /^p\/([^/]+)\/calibrate\/([^/]+)$/, keys: ['pid', 'lid'], load: () => import('./ui/calibrate-screen.js'), project: true },
  { re: /^p\/([^/]+)\/export$/, keys: ['pid'], load: () => import('./ui/export-screen.js'), project: true },
];

/** Shared, long-lived things a screen may need (ctx.app). */
const cache = new Map();
const app = {
  version: APP_VERSION,
  store,
  bus,
  shell,
  positioning,
  getSettings,
  updateSettings,
  cache,
  enterProject,
  currentProjectId: null,
};

// ---- the open project ---------------------------------------------------------------
//
// Positioning runs while any screen of a job walk is open (plan, camera,
// item, calibration), so the position is warm when the camera opens, and
// stops when the person leaves for the home screen.

let projectWatch = null;

async function enterProject(pid) {
  const project = await store.getProject(pid);
  if (!project) {
    const err = new Error('That job walk is not on this phone.');
    err.notFound = true;
    throw err;
  }
  if (app.currentProjectId !== pid) {
    app.currentProjectId = pid;
    projectWatch?.();
    projectWatch = bus.on('store:change', async (ev) => {
      if (ev.kind !== 'project' || ev.id !== app.currentProjectId) return;
      const p = await store.getProject(app.currentProjectId);
      if (p) setPositioningContext(p);
    });
  }
  setPositioningContext(project);
  positioning.start();
  return project;
}

function setPositioningContext(project) {
  positioning.setContext({
    project,
    level: store.activeLevel(project),
    onOrigin: (geo) => store.setOriginOnce(project.id, geo).catch((e) => console.warn('[main] origin', e)),
  });
}

function leaveProject() {
  if (!app.currentProjectId) return;
  app.currentProjectId = null;
  projectWatch?.();
  projectWatch = null;
  positioning.stop();
}

// ---- keeping the screen on ------------------------------------------------------------

let wakeLock = null;
async function setAwake(on) {
  try {
    if (on && getSettings().keepAwake && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      if (!wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { wakeLock = null; }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && app.currentProjectId) setAwake(true);
});

// ---- router ---------------------------------------------------------------------------

const screenHost = () => document.getElementById('screens');
let current = null;          // {root, cleanup, guard, path}
let navToken = 0;
let asking = null;           // {screen, then} while a screen's guard is asking
let passed = null;           // the screen whose guard just said yes: the route leaving it does not ask again

export function parseHash(hash = location.hash) {
  const raw = hash.replace(/^#\/?/, '');
  const [path, qs = ''] = raw.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs));
  return { path: path.replace(/\/+$/, ''), query };
}

function navigate(path, { replace = false } = {}) {
  const h = `#/${String(path).replace(/^#?\/?/, '')}`;
  // A screen with unsaved work is asked BEFORE history changes, so "stay"
  // leaves history as it was: Back then goes where it went before, not to
  // the screen that was refused.
  if (current?.guard && current.path !== parseHash(h).path) {
    askGuard((screen) => { passed = screen; go(h, replace); });
    return;
  }
  go(h, replace);
}

function go(h, replace) {
  const depth = history.state?.jwDepth || 0;
  // pushState/replaceState fire no hashchange, so the route runs here. The
  // depth in history.state says how many screens of this app are behind
  // this one, so back() never walks out of the app.
  if (replace) history.replaceState({ jwDepth: depth }, '', h);
  else if (location.hash !== h) history.pushState({ jwDepth: depth + 1 }, '', h);
  route();
}

/** Go back, or to `fallback` when this screen was opened directly (a reload, a shared link). */
function back(fallback = '') {
  if ((history.state?.jwDepth || 0) > 0) history.back();
  else navigate(fallback, { replace: true });
}

/**
 * Ask the current screen's guard — once, however often the person presses
 * Back or taps while it asks (each press would otherwise open another
 * dialog). A newer request replaces the one waiting; it runs only if the
 * guard says yes and the screen is still the one showing.
 */
function askGuard(then) {
  const screen = current;
  if (asking?.screen === screen) { asking.then = then; return; }
  const a = { screen, then };
  asking = a;
  (async () => {
    let ok = true;
    try { ok = screen.guard ? await screen.guard() : true; } catch { ok = true; }
    if (asking === a) asking = null;
    if (ok && current === screen) a.then(screen);
  })();
}

async function route() {
  const { path, query } = parseHash();

  // A screen with unsaved work (markup, a recording) may hold the person here.
  const askedAlready = passed !== null && passed === current;
  passed = null;
  if (current?.guard && current.path !== path && !askedAlready) {
    // The browser has already moved (Back, or a link). Put this screen's
    // address back on top at once: the address then matches the screen, and
    // Back pressed again while the guard asks only comes back here — it
    // never walks further back, or out of the app, before photos are saved.
    history.pushState({ jwDepth: (history.state?.jwDepth || 0) + 1 }, '', `#/${current.path}${current.qs ? `?${current.qs}` : ''}`);
    // A yes goes back to where the browser had moved, without asking again.
    askGuard((screen) => { passed = screen; history.back(); });
    return;
  }
  const token = ++navToken;

  const match = ROUTES.map((r) => ({ r, m: path.match(r.re) })).find((x) => x.m);
  // Dialogs and sheets of the screen being left are cancelled, not left behind.
  shell.closeAllOverlays();
  if (current) {
    const c = current;
    current = null;
    try { await c.cleanup?.(); } catch (err) { console.error('[router] cleanup failed', err); }
    c.root.remove();
  }
  if (token !== navToken) return;

  const root = shell.el('section', { class: 'screen' });
  screenHost().append(root);
  const qs = new URLSearchParams(query).toString();
  current = { root, cleanup: null, guard: null, path, qs };

  if (!match) {
    navigate('', { replace: true });
    return;
  }
  const params = {};
  (match.r.keys || []).forEach((k, i) => { params[k] = decodeURIComponent(match.m[i + 1]); });

  if (!match.r.project) { leaveProject(); setAwake(false); }

  const ctx = {
    root,
    params,
    query,
    app,
    navigate,
    back,
    setGuard(fn) { if (current?.root === root) current.guard = fn; },
    isCurrent: () => current?.root === root,
  };
  try {
    if (match.r.project) {
      await enterProject(params.pid);
      setAwake(true);
    }
    const mod = await match.r.load();
    if (token !== navToken) return;
    const cleanup = await mod.open(ctx);
    if (current?.root === root) current.cleanup = typeof cleanup === 'function' ? cleanup : null;
    else if (typeof cleanup === 'function') { try { await cleanup(); } catch { /* left already */ } }
  } catch (err) {
    console.error('[router] screen failed', err);
    if (current?.root !== root) return;
    root.replaceChildren(errorScreen(err));
  }
}

function errorScreen(err) {
  const { el } = shell;
  return el('div', { class: 'error-screen' },
    el('h1', {}, err?.notFound ? 'Not found' : 'Something went wrong'),
    el('p', {}, err?.message || String(err)),
    el('p', { class: 'muted' }, 'Your photos and notes are safe on this phone.'),
    // Another window installed a new version: a screen loaded since may not fit the old program still running here.
    updatedElsewhere ? el('button', { type: 'button', class: 'btn btn-primary', onclick: () => reloadWhenAllowed() }, 'Reload the app') : null,
    el('button', { type: 'button', class: `btn ${updatedElsewhere ? 'btn-outline' : 'btn-primary'}`, onclick: () => navigate('', { replace: true }) }, 'Go to job walks'));
}

// The phone's back button, and a hash typed or linked.
window.addEventListener('hashchange', () => route());

// ---- updates ----------------------------------------------------------------------------
//
// A new version installs in the background and WAITS (sw.js does not skip
// waiting): taking over a running page would load screens of the new
// version next to modules of the old one already in memory. It takes over
// when every window of the app is closed and opened again, or when the
// person taps Update — and that reload asks the screen first, like leaving
// it would (photos still saving, markup not saved).

let updatedElsewhere = false;   // another window applied an update to this page
let reloadOnTakeover = false;   // this page asked the new version to take over: reload when it has

/** Reload once the current screen allows leaving it (`reload` defaults to location.reload). */
function reloadWhenAllowed(reload = () => location.reload()) {
  if (current?.guard) askGuard(() => reload());
  else reload();
}

function watchForUpdates(reg) {
  let offered = null;
  const offer = () => {
    const w = reg.waiting;
    // No controller: the first install, nothing older is running.
    if (!w || !navigator.serviceWorker.controller || offered === w) return;
    offered = w;
    shell.toast('A new version of DCR Job Walk is ready.', {
      type: 'info', ms: 10000,
      action: {
        label: 'Update',
        onclick: () => reloadWhenAllowed(() => {
          if (!reg.waiting) { location.reload(); return; } // another window already applied it
          reloadOnTakeover = true;
          reg.waiting.postMessage('skipWaiting');
        }),
      },
    });
  };
  const whenInstalled = (w) => w?.addEventListener('statechange', () => { if (w.state === 'installed') offer(); });
  offer();
  // The browser checks for a new version when the page loads, so one may
  // already be installing (its updatefound came before this listener).
  whenInstalled(reg.installing);
  reg.addEventListener('updatefound', () => whenInstalled(reg.installing));
}

// ---- videos left by an app that was closed while filming ------------------------------

/** A count recorder.js reports as a number or as a list. */
const countOf = (v) => (Array.isArray(v) ? v.length : Number(v) || 0);

/**
 * Rebuild the videos that were still recording when the app closed. One
 * whose rebuild already stopped the app (out of memory) is skipped at
 * launch, so it can never keep the app from opening, and one can fail
 * (storage full). Either way its pieces are kept, and a warning that stays
 * until tapped says so — with Try again, which tries the skipped ones too.
 */
async function recoverVideos({ force = false } = {}) {
  const b = force ? shell.busy('Rebuilding the video… If the app closes, its pieces are still kept.') : null;
  let left = 0;
  let why = '';
  try {
    const { recoverRecordings } = await import('./core/recorder.js');
    const recovered = await recoverRecordings({ force });
    if (recovered?.length) {
      shell.toast(`Recovered ${recovered.length} video${recovered.length > 1 ? 's' : ''} that ${recovered.length > 1 ? 'were' : 'was'} still recording when the app closed.`, { type: 'ok', ms: 8000 });
    }
    left = countOf(recovered?.skipped) + countOf(recovered?.errors);
    why = recovered?.errors?.[0]?.message || '';
  } catch (err) {
    console.error('[boot] recovery failed', err);
    left = (countOf(err?.errors) + countOf(err?.skipped)) || 1;
    why = err?.message || String(err);
  } finally {
    b?.done();
  }
  if (!left) return;
  why = why.replace(/\.\s*$/, '');
  shell.toast(`${left > 1 ? `${left} videos that were` : 'A video that was'} recording when the app closed could not be rebuilt yet${why ? ` (${why})` : ''}. ${left > 1 ? 'Their' : 'Its'} pieces are kept on this phone.`, {
    type: 'warn', ms: 0, action: { label: 'Try again', onclick: () => recoverVideos({ force: true }) },
  });
}

// ---- start ------------------------------------------------------------------------------

async function boot() {
  document.documentElement.dataset.version = APP_VERSION;
  try {
    await initSettings();
  } catch (err) {
    document.getElementById('screens').replaceChildren(errorScreen(err));
    return;
  }

  // Ask the browser to keep this app's storage (it may say no until the app
  // is installed or used more; Settings shows the state and how to fix it).
  store.requestPersist();

  // On this PC (localhost) the worker would serve yesterday's files after
  // every edit, so it only runs there when asked for with ?sw=1.
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (local && /[?&]sw=1\b/.test(location.search)) sessionStorage.setItem('jw.sw', '1');
  const wantSw = !local || sessionStorage.getItem('jw.sw') === '1';
  if ('serviceWorker' in navigator && location.protocol !== 'file:' && wantSw) {
    // The first install also takes over this page (clients.claim): that is not an update.
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('./sw.js').then(watchForUpdates).catch((e) => console.warn('[sw] register failed', e));
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) { hadController = true; return; }
      if (reloadOnTakeover) { location.reload(); return; }
      updatedElsewhere = true;
      shell.toast('DCR Job Walk was updated in another window. Reload to finish.', {
        type: 'info', ms: 10000, action: { label: 'Reload', onclick: () => reloadWhenAllowed() },
      });
    });
  }

  // A video that was still recording when the app was closed is rebuilt from
  // the pieces already saved, before anything else happens.
  await recoverVideos();
  // A photo whose bytes were saved but whose item was not (the app died in
  // between) is turned back into an item.
  try {
    const { items } = await store.recoverOrphans();
    if (items.length) shell.toast(`Recovered ${items.length} photo${items.length > 1 ? 's' : ''} that had been saved but not listed.`, { type: 'ok', ms: 8000 });
  } catch (err) {
    console.error('[boot] orphan recovery failed', err);
  }

  screenHost().replaceChildren();
  route();
}

boot();
