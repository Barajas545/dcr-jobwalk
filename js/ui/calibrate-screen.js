// calibrate-screen.js — the calibration wizard: #/p/<pid>/calibrate/<lid>?mode=…
//
// Lines a level's floor plan up with the ground, so every photo's GPS
// position lands on the right spot of the plan (js/core/calibration.js does
// the math). The ways in, in the order the start page recommends:
//
//   ?mode=gps      on site: mark 3 spots on the plan, stand on each, Set location
//   ?mode=scale    a known dimension (a 24' wall): makes the scale exact
//   ?mode=compass  point the phone along a wall: makes camera directions match
//   ?mode=map      in the office: pick the same spots on the plan and the satellite map
//   (none)         the start page: what each one does, the current result, history
//
// Written for a framer on a dusty site, one hand, bright sun: one step at a
// time, one big button, the plan filling the screen, numbers in feet.
//
// Durability (docs/SPEC.md §13):
//  - A calibration point costs half a minute of standing still, so each one
//    is kept on the phone (a kv draft) the moment it is set, and offered back
//    if the app is closed. Leaving with unsaved points asks first.
//  - Saving never loses the calibration it replaces: the store keeps it in
//    calibrationHistory, and the start page can bring it back.
//  - After a save, pins are moved to match (reprojectItems). Only plan
//    coordinates computed from GPS are rewritten; pins placed by hand stay;
//    every photo keeps its raw GPS. If moving some pins fails, the toast
//    offers Retry — the calibration itself is already saved.
//
// Started from the start page, a mode replaces it in the history, so Back
// from a mode returns to the start page and a save returns to the project.

import { el, iconButton, toast, confirmDialog, busy, choose } from './shell.js';
import { icon } from './icons.js';
import { createPlanView } from './plan-view.js';
import { toEnu } from '../core/geo.js';
import {
  solveCalibration, enuToPlan, planToEnu, headingToPlan, planHeadingToTrue, planBearing,
  reprojectItems, describeQuality, describeWarnings, formatScale, averageFixes, combineSamples,
  MAP_SIGMA, QUALITY_GOOD_M, QUALITY_FAIR_M,
} from '../core/calibration.js';
import {
  debounce, throttle, escapeHtml, formatLength, formatAccuracy, formatDateTime, formatTime,
  formatDuration, parseLength, compassPoint, deltaDeg, isIOS, buzz, todayISO,
} from '../core/util.js';

const MODES = ['gps', 'map', 'scale', 'compass'];

// Standing still: 20–30 s mostly lets the GPS settle and drops outliers
// (docs/RESEARCH.md). Done is offered after the minimum; the engine finishes
// by itself at the target precision or the maximum.
const SAMPLE = { minSeconds: 12, maxSeconds: 30, targetAcc: 1.0 };
const HEADING_SECONDS = 3;
const GPS_POINTS = 3;
const GPS_MAX_POINTS = 6;
const MAP_MAX_PAIRS = 4;
const DRAFT_MAX_AGE = 24 * 3600 * 1000;
const MIN_LINE_PX = 20;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ---- screen entry -------------------------------------------------------------------------

/** Open the calibration screen (docs/SPEC.md §3, §6). Returns the cleanup. */
export async function open(ctx) {
  const C = makeContext(ctx);
  ctx.root.classList.add('cal');
  try {
    await loadLevel(C);
    const mode = MODES.includes(ctx.query?.mode) ? ctx.query.mode : 'start';
    if (!C.level) {
      renderProblem(C, {
        title: 'That level is not here',
        text: 'This level is no longer in the job walk. Its photos and notes are safe — open the job walk to see them.',
      });
    } else if (!C.level.plan) {
      renderProblem(C, {
        title: 'No floor plan on this level yet',
        text: 'Calibrating lines a floor plan up with the ground. Add a plan to this level first (menu → Levels & plans), then calibrate it. Photos taken meanwhile keep their GPS position and appear on the plan once it is calibrated.',
      });
    } else {
      await ({ start: startPage, gps: gpsMode, map: mapMode, scale: scaleMode, compass: compassMode })[mode](C);
    }
  } catch (err) {
    await cleanup(C);
    throw err;
  }
  return () => cleanup(C);
}

function makeContext(ctx) {
  const C = {
    ctx,
    app: ctx.app,
    store: ctx.app.store,
    positioning: ctx.app.positioning,
    pid: ctx.params.pid,
    lid: ctx.params.lid,
    mode: 'start',
    project: null,
    level: null,
    planMediaId: null,
    planImage: null,
    alive: true,
    saving: false,
    guard: null,
    disposers: [],
    onProjectChange: null,
    onCleanup(fn) { if (typeof fn === 'function') C.disposers.push(fn); },
    live: () => C.alive && ctx.isCurrent(),
    units: () => (ctx.app.getSettings?.()?.units === 'metric' ? 'metric' : 'imperial'),
  };
  return C;
}

async function cleanup(C) {
  if (!C.alive) return;
  C.alive = false;
  const fns = C.disposers.splice(0).reverse();
  for (const fn of fns) {
    try { await fn(); } catch (err) { console.warn('[calibrate] cleanup step failed', err); }
  }
}

async function loadLevel(C) {
  C.project = await C.store.getProject(C.pid);
  C.level = C.store.getLevel(C.project, C.lid);
  C.planMediaId = C.level?.plan?.mediaId || null;
  // Keep the project fresh: positioning may set the origin, another tab may edit.
  const off = C.app.bus.on('store:change', (ev) => {
    if (ev?.kind !== 'project' || ev.id !== C.pid || !C.alive) return;
    C.store.getProject(C.pid).then((p) => {
      if (!p || !C.alive) return;
      C.project = p;
      C.level = C.store.getLevel(p, C.lid) || C.level;
      C.onProjectChange?.();
    }).catch(() => { /* keep what we have */ });
  });
  C.onCleanup(off);
}

// ---- navigation ---------------------------------------------------------------------------

function installGuard(C, isDirty, message) {
  C.guard = async () => {
    if (!isDirty()) return true;
    return confirmDialog({ title: 'Leave the calibration?', message, okText: 'Leave', cancelText: 'Stay' });
  };
  C.ctx.setGuard(C.guard);
}

/** Another mode (or the start page with mode null), in place of this one. */
async function goMode(C, mode) {
  // Same route, so the router does not ask the guard: ask it here.
  if (C.guard && !(await C.guard())) return;
  C.guard = null;
  C.ctx.setGuard(null);
  const fromStart = C.mode === 'start' || C.ctx.query?.from === 'start';
  const q = mode ? `?mode=${mode}${fromStart ? '&from=start' : ''}` : '';
  C.ctx.navigate(`p/${C.pid}/calibrate/${C.lid}${q}`, { replace: true });
}

function leave(C) {
  if (C.mode !== 'start' && C.ctx.query?.from === 'start') goMode(C, null);
  else C.ctx.back(`p/${C.pid}`);
}

/** Done here: back to the job walk. */
function finish(C) {
  C.guard = null;
  C.ctx.setGuard(null);
  C.ctx.back(`p/${C.pid}`);
}

// ---- small DOM pieces ---------------------------------------------------------------------

function button(label, { ic, cls = 'btn', onclick, disabled = false, title } = {}) {
  return el('button', {
    type: 'button', class: cls, onclick, disabled, title: title || null,
    html: (ic ? icon(ic, { size: 20 }) : '') + `<span>${escapeHtml(label)}</span>`,
  });
}

const actions = (...btns) => el('div', { class: 'cal-actions' }, ...btns.filter(Boolean));

function banner(level, title, text, extra = null) {
  const ic = level === 'ok' ? 'check' : level === 'info' ? 'info' : 'warning';
  return el('div', { class: `banner cal-banner${level && level !== 'info' ? ` ${level}` : ''}`, role: level === 'err' ? 'alert' : null },
    el('span', { class: 'cal-banner-ic', html: icon(ic, { size: 20 }) }),
    el('div', { class: 'grow' },
      title ? el('strong', { class: 'cal-banner-t' }, title) : null,
      text ? el('div', {}, text) : null,
      extra));
}

function tip(text) {
  return el('p', { class: 'cal-tip' }, el('span', { html: icon('info', { size: 18 }) }), el('span', {}, text));
}

function loadingNode(text) {
  return el('div', { class: 'cal-loading' }, el('div', { class: 'spinner' }), el('span', {}, text));
}

function stepsRow(total, done, current) {
  const row = el('div', { class: 'cal-steps', 'aria-hidden': 'true' });
  for (let i = 0; i < total; i++) {
    const isDone = done.has(i) && i !== current;
    row.append(el('span', {
      class: `cal-step${done.has(i) ? ' done' : ''}${i === current ? ' now' : ''}`,
      html: isDone ? icon('check', { size: 16 }) : null,
    }, isDone ? null : String(i + 1)));
  }
  return row;
}

function ordinal(n) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${s}`;
}

function when(ms) {
  if (!ms) return '';
  return todayISO(new Date(ms)) === todayISO() ? `at ${formatTime(ms)}` : `on ${formatDateTime(ms)}`;
}

function residualLevel(m) {
  return m <= QUALITY_GOOD_M ? 'good' : m <= QUALITY_FAIR_M ? 'fair' : 'poor';
}

function readColors() {
  let cs = null;
  try { cs = getComputedStyle(document.documentElement); } catch { cs = null; }
  const v = (n, fb) => (cs?.getPropertyValue(n) || '').trim() || fb;
  return {
    brand: v('--brand', '#c8371f'), accent: v('--accent', '#1f6fc8'), ok: v('--ok', '#1f9d55'),
    warn: v('--warn', '#c98a00'), danger: v('--danger', '#c8371f'), muted: v('--text-muted', '#5d6e80'),
  };
}

function residualColor(colors, m) {
  const l = residualLevel(m);
  return l === 'good' ? colors.ok : l === 'fair' ? colors.warn : colors.danger;
}

function northNode(deg) {
  return el('span', { class: 'cal-north' },
    el('span', { class: 'cal-north-ic', style: { transform: `rotate(${deg}deg)` }, html: icon('navigation', { size: 18 }) }),
    el('span', {}, `${Math.round(deg) % 360}°`));
}

function methodLabel(cal) {
  const n = cal?.pairs?.length || 0;
  return cal?.method === 'map' ? `Satellite map · ${n} pair${n === 1 ? '' : 's'}` : `GPS · ${n} point${n === 1 ? '' : 's'}`;
}

/** The frame of a mode: top bar, the plan stage, the step panel. */
function frame(C, { title, sub = '' }) {
  const subEl = el('div', { class: 'sub' }, sub);
  const topbar = el('header', { class: 'topbar' },
    iconButton('back', { title: 'Back', onclick: () => leave(C) }),
    el('div', { class: 'topbar-title' }, el('h1', {}, title), subEl));
  const overlay = el('div', { class: 'cal-overlay' });
  const stage = el('div', { class: 'cal-stage' }, overlay);
  const panel = el('section', { class: 'cal-panel', 'aria-live': 'polite' });
  const main = el('div', { class: 'cal-main' }, stage, panel);
  C.ctx.root.replaceChildren(topbar, main);
  return { topbar, main, stage, overlay, panel, setSub: (t) => { subEl.textContent = t; } };
}

function renderProblem(C, { title, text }) {
  const topbar = el('header', { class: 'topbar' },
    iconButton('back', { title: 'Back', onclick: () => C.ctx.back(`p/${C.pid}`) }),
    el('div', { class: 'topbar-title' }, el('h1', {}, 'Calibrate')));
  const body = el('div', { class: 'screen-body narrow' },
    el('div', { class: 'empty' },
      el('span', { html: icon('plan', { size: 44 }) }),
      el('h2', {}, title),
      el('p', {}, text),
      button('Back to the job walk', { ic: 'back', cls: 'btn btn-primary', onclick: () => C.ctx.back(`p/${C.pid}`) })));
  C.ctx.root.replaceChildren(topbar, body);
}

/** Call fn when the element changes size (the panel grows and shrinks between steps). */
function watchSize(C, target, fn) {
  if (typeof ResizeObserver === 'undefined') {
    const h = () => { if (C.alive) fn(); };
    window.addEventListener('resize', h);
    C.onCleanup(() => window.removeEventListener('resize', h));
    return;
  }
  let raf = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { if (C.alive) fn(); });
  });
  ro.observe(target);
  C.onCleanup(() => { cancelAnimationFrame(raf); ro.disconnect(); });
}

// ---- the plan ------------------------------------------------------------------------------

function isDrawable(x) {
  if (!x || typeof x !== 'object') return false;
  if (typeof HTMLImageElement !== 'undefined' && x instanceof HTMLImageElement) return x.complete && x.naturalWidth > 0;
  if (typeof ImageBitmap !== 'undefined' && x instanceof ImageBitmap) return x.width > 0;
  if (typeof HTMLCanvasElement !== 'undefined' && x instanceof HTMLCanvasElement) return x.width > 0;
  return false;
}

async function decodePlan(blob) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = 'async';
  const loaded = new Promise((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('The plan image could not be opened on this phone.'));
  });
  img.src = url;
  try {
    await img.decode();
  } catch {
    // decode() gives up on some very large images that still load fine.
    if (!(img.complete && img.naturalWidth)) await loaded;
  }
  // The URL stays alive: the image is kept in app.cache for this session and
  // other screens draw it too.
  return img;
}

/** The decoded plan image, shared with the other screens through app.cache under 'plan:<mediaId>'. */
async function loadPlanImage(C) {
  const id = C.level.plan.mediaId;
  const key = `plan:${id}`;
  const cached = C.app.cache?.get(key);
  if (isDrawable(cached)) return (C.planImage = cached);
  const blob = await C.store.getMediaBlob(id);
  if (!blob) {
    throw new Error('The plan image for this level could not be read from this phone. Add the plan again from Levels & plans — your photos and notes are not affected.');
  }
  const img = await decodePlan(blob);
  C.app.cache?.set(key, img);
  return (C.planImage = img);
}

async function mountPlan(C, host) {
  const image = await loadPlanImage(C);
  if (!C.live()) return null;
  const plan = C.level.plan;
  const view = await createPlanView(host, {
    image,
    width: plan.width || image.naturalWidth || image.width,
    height: plan.height || image.naturalHeight || image.height,
    interactive: true,
    units: C.units(),
    pxPerMeter: C.level.calibration?.pxPerMeter || undefined,   // scale bar, when calibrated
  });
  if (!C.live()) { try { view.destroy?.(); } catch { /* gone */ } return null; }
  C.onCleanup(() => view.destroy?.());
  watchSize(C, host, () => view.resize?.());
  return view;
}

/** A plan point from the person, or null when they cancel. */
async function pickOnPlan(C, view, opts) {
  if (typeof view?.pickPoint !== 'function') {
    toast('The plan cannot take a point here yet. Reload the app and try again.', { type: 'err' });
    return null;
  }
  try {
    const pt = await view.pickPoint(opts);
    return pt && num(pt.x) != null && num(pt.y) != null ? { x: pt.x, y: pt.y } : null;
  } catch (err) {
    if (C.alive) toast(`The point could not be placed: ${err.message}`, { type: 'err' });
    return null;
  }
}

/** The saved scale line for this plan: the level's own, or the one in its calibration. */
function currentScaleLine(level) {
  const own = level?.scaleLine;
  const valid = (l) => l && l.a && l.b && num(l.meters) > 0;
  if (valid(own) && (!own.planMediaId || own.planMediaId === level.plan?.mediaId)) return own;
  const fromCal = level?.calibration?.scaleLine;
  return valid(fromCal) ? fromCal : null;
}

// ---- positioning ------------------------------------------------------------------------

function safeStatus(C) {
  try { return C.positioning?.getStatus?.() || {}; } catch { return {}; }
}

function safePose(C) {
  try { return C.positioning?.getPose?.() || null; } catch { return null; }
}

function needsPermission(C) {
  try { return !!C.positioning?.needsPermission?.(); } catch { return false; }
}

/** Meters east/north of the project origin for a pose (from its lat/lng when it has one). */
function poseEnu(C, pose) {
  const o = C.project?.origin;
  const g = pose?.geo;
  if (o && g && num(g.lat) != null && num(g.lng) != null) {
    try { return toEnu(o, g.lat, g.lng); } catch { /* fall through */ }
  }
  if (pose?.enu && num(pose.enu.e) != null && num(pose.enu.n) != null) return pose.enu;
  return null;
}

/** The pose drawn on this plan with `cal` (which may be a provisional one). */
function posePlan(C, pose, cal) {
  if (!pose || !cal) return null;
  const enu = poseEnu(C, pose);
  if (!enu) return null;
  const acc = num(pose.geo?.acc);
  return {
    ...pose,
    plan: enuToPlan(cal, enu),
    planAcc: acc != null ? acc * cal.pxPerMeter : null,
    planHeading: headingToPlan(cal, pose.heading),
  };
}

/** Keep the blue dot on the plan; returns a function that redraws it now. */
function trackPose(C, view, getCal) {
  const push = () => {
    if (!C.alive) return;
    try { view.setPose?.(posePlan(C, safePose(C), getCal())); } catch (err) { console.warn('[calibrate] pose', err); }
  };
  C.onCleanup(C.positioning.on('pose', push));
  push();
  return push;
}

/** The iOS motion/compass prompt. Must run straight from a tap. */
function askSensors(C) {
  let p;
  try { p = C.positioning.requestPermission(); } catch { p = Promise.resolve(false); }
  Promise.resolve(p).then((ok) => {
    if (ok) toast('Compass and motion sensors are on.', { type: 'ok' });
    else {
      toast(isIOS()
        ? 'The compass was not allowed. Close this tab or the app, open it again, and tap Allow when asked.'
        : 'The compass was not allowed. Allow motion sensors for this site in the browser settings.', { type: 'warn' });
    }
  }, () => toast('The compass could not be turned on.', { type: 'warn' }));
}

function allowButton(C) {
  return button('Allow compass', { ic: 'compass', cls: 'btn btn-sm btn-accent', onclick: () => askSensors(C) });
}

/** What stops (or slows) GPS right now, for the person: null when all is well. */
function gpsProblem(C) {
  const s = safeStatus(C);
  const pose = safePose(C);
  switch (s.gps) {
    case 'denied':
      return {
        level: 'err', blocking: true, title: 'Location is blocked',
        text: isIOS()
          ? 'iPhone: Settings → Privacy & Security → Location Services → Safari Websites (or this app) → While Using, and turn on Precise Location. Then come back and try again.'
          : 'Tap the icon left of the web address → Permissions → Location → Allow, and choose Precise. Then come back and try again.',
      };
    case 'unavailable':
      return {
        level: 'err', blocking: true, title: 'This phone is not giving a location',
        text: `Turn on Location in the phone settings, then try again.${s.message ? ` (${s.message})` : ''}`,
      };
    case 'error':
      return {
        level: 'warn', blocking: false, title: 'GPS had a problem',
        text: `${s.message || 'The phone did not return a position.'} Make sure Location is on, step into the open, and try again.`,
      };
    default:
      break;
  }
  const acc = num(pose?.geo?.acc);
  if (acc == null || s.gps === 'waiting' || s.gps === 'off') {
    return {
      level: 'info', blocking: false, title: 'Waiting for GPS…',
      text: 'Step into the open, away from tall walls and steel. The first fix can take up to a minute.',
    };
  }
  if (acc > 30) {
    return {
      level: 'warn', blocking: false, title: `GPS is weak right now (${formatAccuracy(acc, C.units())})`,
      text: acc > 50
        ? 'Check that Precise Location is on for this browser. Then step into the open and wait a moment.'
        : 'Step away from the building, or wait a moment for it to settle.',
    };
  }
  return null;
}

/** The status chips over the plan: GPS (and compass), plus the iOS Allow button. */
function statusChips(C, host, { compass = false } = {}) {
  const gText = el('span', {}, 'GPS…');
  const gps = el('div', { class: 'pos-chip cal-chip', role: 'status' }, el('span', { class: 'dot' }), gText);
  const cText = el('span', {}, 'Compass…');
  const cmp = compass ? el('div', { class: 'pos-chip cal-chip' }, el('span', { class: 'dot' }), cText) : null;
  const allow = allowButton(C);
  allow.classList.add('cal-allow');
  allow.hidden = true;
  host.append(...[gps, cmp, allow].filter(Boolean));
  const u = C.units;
  const update = () => {
    if (!C.alive) return;
    const s = safeStatus(C);
    const pose = safePose(C);
    const acc = num(pose?.geo?.acc);
    let level = '', text;
    if (s.gps === 'denied') { level = 'poor'; text = 'Location blocked'; }
    else if (s.gps === 'unavailable') { level = 'poor'; text = 'No location'; }
    else if (s.gps === 'error' && acc == null) { level = 'poor'; text = 'GPS problem'; }
    else if (acc == null) text = 'Waiting for GPS…';
    else {
      level = acc <= 1.5 ? 'good' : acc <= 5 ? 'fair' : 'poor';
      text = `${pose?.source === 'sim' ? 'Demo · ' : ''}GPS ${formatAccuracy(acc, u())}`;
    }
    gps.className = `pos-chip cal-chip ${level}`.trim();
    gText.textContent = text;
    if (cmp) {
      const c = {
        ok: ['good', 'Compass on'], 'needs-permission': ['fair', 'Compass: tap Allow'], denied: ['poor', 'Compass blocked'],
        unavailable: ['poor', 'No compass'], uncalibrated: ['fair', 'Compass: figure 8'],
      }[s.compass] || ['', 'Compass…'];
      cmp.className = `pos-chip cal-chip ${c[0]}`.trim();
      cText.textContent = c[1];
    }
    allow.hidden = !needsPermission(C);
  };
  C.onCleanup(C.positioning.on('pose', throttle(update, 400)));
  C.onCleanup(C.positioning.on('status', update));
  update();
}

/** A GPS fix as reported in onProgress.lastFix, whatever its shape: {lat, lng, acc, alt, t} | null. */
function parseFix(f) {
  if (!f || typeof f !== 'object') return null;
  const c = f.coords || f;
  const lat = num(c.lat ?? c.latitude);
  const lng = num(c.lng ?? c.lon ?? c.longitude);
  if (lat == null || lng == null) return null;
  return {
    lat, lng,
    acc: num(c.acc ?? c.accuracy),
    alt: num(c.alt ?? c.altitude),
    t: num(f.t ?? f.timestamp ?? c.t) ?? Date.now(),
  };
}

/** Make sure the job walk has its ground origin (set once, from the first point if needed). */
async function ensureOrigin(C, { lat, lng }) {
  if (C.project?.origin) return C.project.origin;
  const p = await C.store.setOriginOnce(C.pid, { lat, lng });
  C.project = p || await C.store.getProject(C.pid);
  C.level = C.store.getLevel(C.project, C.lid) || C.level;
  return C.project?.origin || null;
}

// ---- drafts (points kept on the phone until the calibration is saved) -------------------

const draftKey = (C) => `calibrate-draft:${C.pid}:${C.lid}`;

async function readDraft(C, part) {
  try {
    const d = await C.store.getKV(draftKey(C), null);
    if (!d || d.planMediaId !== C.planMediaId) return null;
    const x = d[part];
    if (!x || !x.savedAt || Date.now() - x.savedAt > DRAFT_MAX_AGE) return null;
    return x;
  } catch {
    return null;
  }
}

/** Keep (or with null, drop) one mode's draft. Rejects when the phone could not keep it. */
async function writeDraft(C, part, value) {
  const key = draftKey(C);
  let d = null;
  try { d = await C.store.getKV(key, null); } catch { d = null; }
  if (!d || d.planMediaId !== C.planMediaId) d = { v: 1, planMediaId: C.planMediaId };
  if (value == null) delete d[part];
  else d[part] = { ...JSON.parse(JSON.stringify(value)), savedAt: Date.now() };
  await C.store.setKV(key, d);
}

// ---- saving -------------------------------------------------------------------------------

/**
 * Save a calibration for this level, then move the pins to match. Resolves
 * true once the calibration itself is saved (pins that could not be moved
 * get a Retry toast), false when nothing was saved.
 * scaleLine: undefined (leave the level's alone) | null | a line to keep on the level.
 */
async function saveCalibration(C, cal, { draftPart = null, scaleLine } = {}) {
  if (C.saving) return false;
  C.saving = true;
  const b = busy('Saving the calibration…');
  let previous = null;
  try {
    const cur = await C.store.getProject(C.pid);
    const lv = C.store.getLevel(cur, C.lid);
    if (!lv) throw new Error('This level is no longer in the job walk.');
    if (!lv.plan || lv.plan.mediaId !== C.planMediaId) {
      throw new Error('The plan on this level was replaced while you were calibrating, so these points no longer fit it. Start again on the new plan.');
    }
    previous = lv.calibration || null;
    await C.store.setCalibration(C.pid, C.lid, { ...cal, planMediaId: C.planMediaId });
  } catch (err) {
    b.done();
    C.saving = false;
    toast(`The calibration was not saved. ${err.message}`, { type: 'err' });
    return false;
  }
  // From here the calibration is safe; the rest reports its own problems.
  if (scaleLine !== undefined) {
    try {
      await C.store.updateLevel(C.pid, C.lid, (l) => { l.scaleLine = scaleLine; });
    } catch (err) {
      toast(`The calibration is saved, but the scale line could not be kept with the plan: ${err.message}`, { type: 'warn' });
    }
  }
  if (draftPart) {
    try { await writeDraft(C, draftPart, null); } catch { /* an old draft is only ever offered, never applied by itself */ }
  }
  b.update('Moving the pins to match…');
  const res = await movePins(C.store, C.pid, C.lid, previous, (k, n) => b.update(`Moving the pins to match… ${k} of ${n}`, k / n));
  b.done();
  C.saving = false;
  reportPins(C.store, C.pid, C.lid, previous, res, 'Calibration saved.');
  return true;
}

/**
 * Recompute the pins on a level from their GPS with its current calibration.
 * Works from the store only, so a Retry still works after the screen closed.
 */
async function movePins(store, pid, lid, previous, onProgress, onlyIds = null) {
  let project, level, items;
  try {
    project = await store.getProject(pid);
    level = store.getLevel(project, lid);
    items = await store.listItems(pid, { includeDeleted: true });
  } catch (err) {
    return { moved: 0, failed: [], total: 0, error: err };
  }
  if (!level?.calibration) return { moved: 0, failed: [], total: 0 };
  let todo = reprojectItems(items, level, project.origin, { previous });
  if (onlyIds) todo = todo.filter((t) => onlyIds.includes(t.id));
  let moved = 0;
  const failed = [];
  for (let k = 0; k < todo.length; k++) {
    onProgress?.(k + 1, todo.length);
    try {
      await store.updateItem(todo[k].id, (cur) => {
        // Worked out again from the record as it is now, in the same
        // transaction, so an edit made meanwhile (text, a pin placed by
        // hand) is never overwritten.
        const [fresh] = reprojectItems([cur], level, project.origin, { previous });
        if (fresh) { cur.pose = fresh.pose; cur.track = fresh.track; }
        return cur;
      });
      moved++;
    } catch (err) {
      console.warn('[calibrate] pin not moved', todo[k].id, err);
      failed.push(todo[k].id);
    }
  }
  return { moved, failed, total: todo.length };
}

function reportPins(store, pid, lid, previous, res, prefix) {
  if (res.error || res.failed.length) {
    const what = res.error
      ? 'the pins could not be moved to match yet'
      : `${res.failed.length} pin${res.failed.length === 1 ? '' : 's'} could not be moved to match yet`;
    toast(`${prefix} But ${what} — the photos and notes are safe.`, {
      type: 'warn',
      ms: 0,
      action: {
        label: 'Retry',
        onclick: async () => {
          const b = busy('Moving the pins to match…');
          const again = await movePins(store, pid, lid, previous, (k, n) => b.update(`Moving the pins to match… ${k} of ${n}`, k / n), res.error ? null : res.failed);
          b.done();
          reportPins(store, pid, lid, previous, again, 'Tried again.');
        },
      },
    });
    return;
  }
  toast(`${prefix}${res.moved ? ` ${res.moved} pin${res.moved === 1 ? '' : 's'} moved to match.` : ''}`, { type: 'ok' });
}

// ---- the result card ------------------------------------------------------------------------

/**
 * A solved calibration in words and numbers: quality, scale, north, the error
 * at each point, warnings with Redo buttons, and Save / Add.
 */
function resultCard(C, cal, {
  noun = 'Point', compareTo = null, onSave, onRedo = null, onRemove = null, onAdd = null,
  addLabel = '', saveLabel = 'Save calibration', note = null,
} = {}) {
  const u = C.units();
  const q = describeQuality(cal, u);
  const card = el('div', { class: 'cal-result' });
  card.append(
    el('div', { class: 'cal-result-head' },
      el('span', { class: `cal-quality ${q.level}` }, q.label),
      el('div', { class: 'grow' },
        el('div', { class: 'cal-result-acc' }, formatAccuracy(cal.expectedError, u)),
        el('div', { class: 'small muted' }, 'how far pins may be off'))),
    el('p', { class: 'cal-detail' }, q.detail));

  const facts = el('dl', { class: 'cal-facts' });
  const fact = (k, v, s) => facts.append(el('dt', {}, k), el('dd', {}, v, s ? el('div', { class: 's' }, s) : null));
  fact('Scale', formatScale(cal.pxPerMeter, u),
    cal.scaleSource === 'line'
      ? `exact, from your scale line (${formatLength(cal.scaleLine?.meters, u)})`
      : cal.method === 'map'
        ? 'from the satellite map'
        : `from GPS, about ±${Math.max(1, Math.round((cal.scaleSigma || 0) * 100))}%`);
  fact('North', northNode(cal.northAngle),
    `clockwise from the top of the plan, about ±${Math.max(1, Math.round(cal.rotationSigma || 0))}°`);
  card.append(facts);

  const lower = noun.toLowerCase();
  const list = el('div', { class: 'list cal-points' });
  cal.pairs.forEach((p, k) => {
    const r = cal.residuals[k];
    const exact = cal.dof === 0;
    list.append(el('div', { class: 'list-row' },
      el('span', { class: `cal-num ${exact ? '' : residualLevel(r)}`.trim() }, String(k + 1)),
      el('div', { class: 'grow' },
        el('div', { class: 't' }, `${noun} ${k + 1}`),
        el('div', { class: 's' },
          exact ? 'Fits exactly — nothing to check it against yet' : `Off by ${formatLength(r, u)}`,
          p.sigma > 6 ? ` · weak GPS (${formatAccuracy(p.sigma, u)})` : '')),
      onRedo ? button('Redo', { cls: 'btn btn-sm btn-outline', onclick: () => onRedo(k) }) : null,
      onRemove ? iconButton('trash', { title: `Remove ${lower} ${k + 1}`, onclick: () => onRemove(k) }) : null));
  });
  card.append(el('h3', { class: 'section-title' }, `Error at each ${lower}`), list);

  const warns = describeWarnings(cal, u);
  if (warns.length) {
    const box = el('div', { class: 'cal-warns' });
    for (const w of warns) {
      box.append(banner('warn', '', w.text,
        w.redo != null && onRedo ? button(`Redo ${lower} ${w.redo + 1}`, { cls: 'btn btn-sm btn-outline cal-warn-btn', onclick: () => onRedo(w.redo) }) : null));
    }
    card.append(box);
  }
  if (compareTo) {
    const before = describeQuality(compareTo, u);
    card.append(el('p', { class: 'small muted cal-before' },
      `In use now: ${before.label}, ${formatAccuracy(compareTo.expectedError ?? compareTo.rms, u)} (${methodLabel(compareTo)}, ${formatDateTime(compareTo.createdAt)}). It is kept in the history if you save this one.`));
  }
  if (note) card.append(note);
  card.append(actions(button(saveLabel, { ic: 'check', cls: 'btn btn-primary btn-lg btn-block', onclick: onSave })));
  if (onAdd) card.append(actions(button(addLabel, { ic: 'plus', cls: 'btn btn-outline btn-block', onclick: onAdd })));
  return card;
}

function provisionalNote(C, cal, n, noun = 'point') {
  const q = describeQuality(cal, C.units());
  return el('div', { class: 'cal-prov' },
    el('span', { class: `cal-quality small ${q.level}` }, q.label),
    el('span', {}, `With ${n} ${noun}s, pins may be off by about ${formatAccuracy(cal.expectedError, C.units())}.${n === 2 ? ` No check yet — the 3rd ${noun} checks the first two.` : ''}`));
}

// ---- start page ------------------------------------------------------------------------

async function startPage(C) {
  C.mode = 'start';
  const topbar = el('header', { class: 'topbar' },
    iconButton('back', { title: 'Back', onclick: () => C.ctx.back(`p/${C.pid}`) }),
    el('div', { class: 'topbar-title' }, el('h1', {}, 'Calibrate'), el('div', { class: 'sub' }, `${C.level.name} · ${C.project.name}`)));
  const body = el('div', { class: 'screen-body narrow cal-start' });
  C.ctx.root.replaceChildren(topbar, body);
  const render = () => {
    if (!C.live()) return;
    const top = body.scrollTop;
    body.replaceChildren(...startContent(C));
    body.scrollTop = top;
  };
  C.onProjectChange = render;
  render();
}

function optionRow({ n, ic, title, sub, tag, tagCls = '', onclick }) {
  return el('button', { type: 'button', class: 'list-row cal-opt', onclick },
    el('span', { class: 'cal-opt-ic', html: icon(ic, { size: 22 }) }),
    el('div', { class: 'grow' },
      el('div', { class: 't' }, n ? `${n}. ${title}` : title),
      el('div', { class: 's' }, sub)),
    tag ? el('span', { class: `badge ${tagCls}`.trim() }, tag) : null,
    el('span', { class: 'cal-chev', html: icon('forward', { size: 18 }) }));
}

function startContent(C) {
  const u = C.units();
  const lv = C.level;
  const cal = lv.calibration;
  const sl = currentScaleLine(lv);
  const out = [];

  // Where things stand.
  if (cal) {
    const q = describeQuality(cal, u);
    const facts = el('dl', { class: 'cal-facts' },
      el('dt', {}, 'How'), el('dd', {}, methodLabel(cal)),
      el('dt', {}, 'When'), el('dd', {}, formatDateTime(cal.restoredAt || cal.createdAt)),
      el('dt', {}, 'Scale'), el('dd', {}, formatScale(cal.pxPerMeter, u), cal.scaleSource === 'line' ? el('div', { class: 's' }, 'exact, from the scale line') : null),
      el('dt', {}, 'North'), el('dd', {}, northNode(cal.northAngle)));
    out.push(el('div', { class: 'card cal-status' },
      el('div', { class: 'cal-result-head' },
        el('span', { class: `cal-quality ${q.level}` }, q.label),
        el('div', { class: 'grow' },
          el('div', { class: 'cal-result-acc' }, formatAccuracy(cal.expectedError ?? cal.rms, u)),
          el('div', { class: 'small muted' }, 'how far pins may be off'))),
      el('p', { class: 'cal-detail' }, q.detail),
      facts));
  } else {
    out.push(banner('info', 'Not calibrated yet', 'Photos still save with their GPS position. Their pins appear on this plan once it is calibrated — about 2 minutes on site.'));
  }

  const aligned = C.project.compassAlignedAt;
  out.push(el('h2', { class: 'section-title' }, 'On site — in this order'));
  out.push(el('div', { class: 'list' },
    optionRow({
      n: 1, ic: 'locate', title: 'Calibrate with GPS',
      sub: 'Mark 3 spots on the plan you can stand on, then stand on each one. About 2 minutes.',
      tag: cal?.method === 'gps' ? 'Done' : 'Start here', tagCls: cal?.method === 'gps' ? 'ok' : 'info',
      onclick: () => goMode(C, 'gps'),
    }),
    optionRow({
      n: 2, ic: 'ruler', title: 'Scale line',
      sub: sl ? `Set to ${formatLength(sl.meters, u)}. Makes the scale exact.` : 'Mark a dimension you know, like a 24\' wall. Makes the scale exact.',
      tag: sl ? 'Done' : 'Recommended', tagCls: sl ? 'ok' : '',
      onclick: () => goMode(C, 'scale'),
    }),
    optionRow({
      n: 3, ic: 'compass', title: 'Align the compass',
      sub: aligned ? `Aligned ${formatDateTime(aligned)}. Do it again if camera directions look off.` : 'Point the phone along a wall. Makes camera directions match the plan.',
      tag: aligned ? 'Done' : cal ? 'Optional' : 'After step 1', tagCls: aligned ? 'ok' : '',
      onclick: () => goMode(C, 'compass'),
    })));
  out.push(el('h2', { class: 'section-title' }, 'In the office'));
  out.push(el('div', { class: 'list' },
    optionRow({
      ic: 'map', title: 'Align to the satellite map',
      sub: 'No need to be on site: pick the same corners on the plan and on the satellite photo. Less exact than GPS on site.',
      tag: cal?.method === 'map' ? 'Done' : '', tagCls: 'ok',
      onclick: () => goMode(C, 'map'),
    })));
  if (sl) out.push(actions(button('Remove the scale line', { ic: 'trash', cls: 'btn btn-ghost', onclick: () => removeScaleLine(C) })));

  // Earlier calibrations, newest first: nothing saved here is ever lost.
  const hist = (lv.calibrationHistory || []).slice(-5).reverse();
  if (hist.length) {
    out.push(el('h2', { class: 'section-title' }, 'Earlier calibrations'));
    const list = el('div', { class: 'list' });
    for (const h of hist) {
      const q = describeQuality(h, u);
      // A calibration belongs to the plan image it was made on.
      const samePlan = h.planMediaId ? h.planMediaId === C.planMediaId : (h.createdAt || 0) >= (lv.plan?.addedAt || 0);
      list.append(el('div', { class: 'list-row' },
        el('span', { class: `cal-num ${q.level}` }, el('span', { html: icon('restore', { size: 16 }) })),
        el('div', { class: 'grow' },
          el('div', { class: 't' }, `${methodLabel(h)} · ${q.label} ${formatAccuracy(h.expectedError ?? h.rms, u)}`),
          el('div', { class: 's' }, samePlan ? formatDateTime(h.restoredAt || h.createdAt) : `${formatDateTime(h.createdAt)} · made for an earlier plan`)),
        samePlan ? button('Use this', { cls: 'btn btn-sm btn-outline', onclick: () => restoreCalibration(C, h) }) : null));
    }
    out.push(list);
  }

  out.push(el('div', { class: 'card cal-howto' },
    el('h3', {}, 'How precise is this?'),
    el('p', {}, 'Phone GPS is usually good to 7–16 ft outdoors, and worse next to tall walls or under a roof. Standing still on each point helps a little; spreading the points across the whole building helps the most.'),
    el('p', {}, 'A scale line makes the scale exact, and the compass alignment makes camera directions match the plan.'),
    el('p', { class: 'muted' }, 'Every photo also keeps its own GPS position, so a better calibration later moves its pin to the right spot. Pins you placed by hand stay where you put them.')));
  return out;
}

async function restoreCalibration(C, h) {
  const ok = await confirmDialog({
    title: 'Use this earlier calibration?',
    message: `The calibration from ${formatDateTime(h.createdAt)} will be used again, and the pins move to match it. The one in use now is kept in the history.`,
    okText: 'Use it',
  });
  if (!ok || !C.live()) return;
  await saveCalibration(C, { ...h, restoredAt: Date.now() });
}

async function removeScaleLine(C) {
  const u = C.units();
  const cal = C.level.calibration;
  if (cal?.scaleLine && cal.pairs?.length >= 2) {
    let next;
    try {
      next = solveCalibration({ pairs: cal.pairs, scaleLine: null, method: cal.method });
    } catch (err) {
      toast(`The calibration cannot be worked out without the scale line: ${err.message}`, { type: 'err' });
      return;
    }
    const q = describeQuality(next, u);
    const ok = await confirmDialog({
      title: 'Remove the scale line?',
      message: `The calibration then takes its scale from ${cal.method === 'map' ? 'the map' : 'GPS'}: ${q.label}, pins within about ${formatAccuracy(next.expectedError, u)}. The calibration in use now is kept in the history.`,
      okText: 'Remove it',
      danger: true,
    });
    if (!ok || !C.live()) return;
    await saveCalibration(C, next, { scaleLine: null });
    return;
  }
  const ok = await confirmDialog({ title: 'Remove the scale line?', message: 'It will no longer be used when you calibrate this plan.', okText: 'Remove it', danger: true });
  if (!ok || !C.live()) return;
  try {
    await C.store.updateLevel(C.pid, C.lid, (l) => { l.scaleLine = null; });
    toast('Scale line removed.', { type: 'ok' });
  } catch (err) {
    toast(`The scale line was not removed. ${err.message}`, { type: 'err' });
  }
}

// ---- GPS calibration -----------------------------------------------------------------------

const SPREAD_TIPS = [
  'Start at one corner of the building.',
  'Pick a spot far from point 1 — the opposite corner of the building is best.',
  'Make a big triangle: pick a spot well off to the side of the line between points 1 and 2.',
  'Pick a spot far from the other points. Another point shows which one is off, if one is.',
];

/** Pairs for the solver from the GPS points that are set: {pairs, idx (point index of each pair)}. */
function gpsPairs(C, points) {
  const origin = C.project?.origin;
  const pairs = [];
  const idx = [];
  if (!origin) return { pairs, idx };
  points.forEach((p, i) => {
    const f = p?.fix;
    if (!f || num(f.lat) == null || num(f.lng) == null) return;
    pairs.push({
      plan: { x: p.plan.x, y: p.plan.y },
      enu: toEnu(origin, f.lat, f.lng),
      sigma: f.acc,
      geo: { lat: f.lat, lng: f.lng, alt: f.alt ?? null, acc: f.acc },
      samples: f.n, spread: f.spread, seconds: f.seconds, at: f.at,
    });
    idx.push(i);
  });
  return { pairs, idx };
}

function cleanPoint(p) {
  if (!p || !p.plan || num(p.plan.x) == null || num(p.plan.y) == null) return null;
  const f = p.fix;
  const fix = f && num(f.lat) != null && num(f.lng) != null ? f : null;
  return { plan: { x: p.plan.x, y: p.plan.y }, fix };
}

async function gpsMode(C) {
  C.mode = 'gps';
  const F = frame(C, { title: 'Calibrate with GPS', sub: C.level.name });
  const host = el('div', { class: 'cal-view' });
  F.stage.prepend(host);
  F.panel.replaceChildren(loadingNode('Opening the plan…'));
  const view = await mountPlan(C, host);
  if (!view) return;
  statusChips(C, F.overlay);
  const colors = readColors();
  const u = C.units;

  const st = {
    points: [],          // [{plan: {x, y}, fix: null | {lat, lng, alt, acc, n, spread, seconds, at}}]
    target: GPS_POINTS,
    index: 0,            // the point being worked on
    phase: 'mark',       // mark | picking | walk | sampling | sampled | result
    backup: null,        // {index, point}: a set point being redone, put back on Cancel
    sampler: null,
    notice: null,
    saving: false,
    draftWarned: false,
  };
  let liveFn = null;

  // The solve is cached until the points change.
  let ver = 0, solvedVer = -1, solved = null, solveError = '';
  const touch = () => { ver++; };
  function solve() {
    if (solvedVer === ver) return solved;
    solvedVer = ver;
    solved = null;
    solveError = '';
    const { pairs } = gpsPairs(C, st.points);
    if (pairs.length >= 2) {
      try { solved = solveCalibration({ pairs, scaleLine: currentScaleLine(C.level), method: 'gps' }); }
      catch (err) { solveError = err.message; }
    } else if (!C.project?.origin && st.points.some((p) => p?.fix)) {
      solveError = 'The job walk\'s map origin is not saved yet. Tap Save again.';
    }
    return solved;
  }
  const countFixed = () => st.points.filter((p) => p?.fix).length;
  const firstUnfixed = () => st.points.findIndex((p) => !p || !p.fix);

  const redrawPose = trackPose(C, view, () => solve() || C.level.calibration || null);
  C.onProjectChange = () => { touch(); redrawPose(); };

  const onLive = throttle(() => { if (C.alive && liveFn) liveFn(); }, 500);
  C.onCleanup(C.positioning.on('pose', onLive));
  C.onCleanup(C.positioning.on('status', onLive));

  // Stop measuring when the phone hides the app: it gets no GPS while hidden.
  const onVis = () => {
    if (document.visibilityState === 'hidden' && st.sampler) {
      st.sampler.hiddenStop = true;
      cancelSampling(st.sampler);
    }
  };
  document.addEventListener('visibilitychange', onVis);
  C.onCleanup(() => document.removeEventListener('visibilitychange', onVis));
  C.onCleanup(() => {
    const s = st.sampler;
    if (s) { s.done = true; clearInterval(s.tick); clearTimeout(s.safety); try { s.ac.abort(); } catch { /* done */ } }
  });

  installGuard(C, () => !!st.sampler || (countFixed() > 0 && !st.saving),
    'The points you set are not saved as a calibration yet. They stay on this phone for a day, so you can come back and finish.');

  async function persist() {
    try {
      await writeDraft(C, 'gps', { points: st.points, backup: st.backup });
    } catch (err) {
      if (st.draftWarned) return;
      st.draftWarned = true;
      toast(`A backup copy of your points could not be kept on this phone (${err.message}). They are still here while this screen is open.`, { type: 'warn' });
    }
  }

  // Points set earlier (the app was closed) are offered back.
  const draft = await readDraft(C, 'gps');
  if (!C.live()) return;
  if (draft) {
    let pts = (draft.points || []).map(cleanPoint);
    const bk = draft.backup;
    if (bk && num(bk.index) != null && cleanPoint(bk.point)?.fix) pts[bk.index] = cleanPoint(bk.point);
    pts = pts.filter(Boolean);
    const fixed = pts.filter((p) => p.fix);
    const unfixed = pts.find((p) => !p.fix);
    if (fixed.length) {
      const n = fixed.length;
      const go = await confirmDialog({
        title: 'Continue where you left off?',
        message: `You set ${n} point${n === 1 ? '' : 's'} on this plan ${when(draft.savedAt)}. Continue with ${n === 1 ? 'it' : 'them'}, or start over?`,
        okText: 'Continue',
        cancelText: 'Start over',
      });
      if (!C.live()) return;
      if (go) {
        st.points = unfixed ? [...fixed, unfixed] : fixed;
        st.target = Math.max(GPS_POINTS, fixed.length);
        const k = firstUnfixed();
        if (k >= 0) { st.index = k; st.phase = 'walk'; }
        else if (fixed.length >= st.target) st.phase = 'result';
        else { st.index = fixed.length; st.phase = 'mark'; }
        touch();
      }
    }
  }

  // ---- steps ----

  function drawMarks() {
    const cal = st.phase === 'result' ? solve() : null;
    const { pairs, idx } = gpsPairs(C, st.points);
    const marks = [];
    const lines = [];
    const sl = currentScaleLine(C.level);
    if (sl) lines.push({ a: sl.a, b: sl.b, label: formatLength(sl.meters, u()), color: colors.muted, dashed: false });
    st.points.forEach((p, i) => {
      if (!p) return;
      let color = p.fix ? colors.ok : colors.accent;
      if (i === st.index && st.phase !== 'result') color = colors.brand;
      if (cal) { const k = idx.indexOf(i); if (k >= 0) color = residualColor(colors, cal.residuals[k]); }
      marks.push({ x: p.plan.x, y: p.plan.y, label: String(i + 1), color, kind: 'calib' });
    });
    if (cal) {
      // Where GPS says each point is, joined to its mark: the error you can see.
      pairs.forEach((pr, k) => {
        if (!(cal.residuals[k] > 0.05)) return;
        const at = enuToPlan(cal, pr.enu);
        const c = residualColor(colors, cal.residuals[k]);
        lines.push({ a: pr.plan, b: at, color: c, dashed: true });
        marks.push({ x: at.x, y: at.y, label: '', color: c, kind: 'temp' });
      });
    }
    try { view.setMarks?.(marks); view.setLines?.(lines); } catch (err) { console.warn('[calibrate] marks', err); }
  }

  function render() {
    if (!C.live()) return;
    liveFn = null;
    const fixed = new Set(st.points.map((p, i) => (p?.fix ? i : -1)).filter((i) => i >= 0));
    const total = Math.max(st.target, st.points.length, st.index + 1);
    F.panel.classList.toggle('compact', st.phase === 'picking');
    F.setSub(st.phase === 'result' ? `${fixed.size} points · result` : `Point ${st.index + 1} of ${total}`);
    drawMarks();
    redrawPose();
    const head = st.phase === 'picking' ? null : stepsRow(total, fixed, st.phase === 'result' ? -1 : st.index);
    F.panel.replaceChildren(...[head, ...PHASES[st.phase]()].filter(Boolean));
    F.panel.scrollTop = 0;
    liveFn?.();
  }

  const PHASES = {
    mark() {
      const i = st.index;
      const redo = st.backup?.index === i;
      const fixedN = countFixed();
      const nodes = [
        el('h2', { class: 'cal-h' }, redo ? `Redo point ${i + 1}` : `Point ${i + 1}: pick a spot you can stand on`),
        el('p', {}, 'Move the plan so the cross is on a spot you can find on site — a slab corner, a column, a door opening, a stake.'),
        tip(SPREAD_TIPS[Math.min(i, SPREAD_TIPS.length - 1)]),
      ];
      if (i === 0 && !redo) {
        const sl = currentScaleLine(C.level);
        nodes.push(el('p', { class: 'small muted' }, sl
          ? `Your scale line (${formatLength(sl.meters, u())}) will set the scale exactly.`
          : 'Tip: after this, a scale line (a dimension you know) makes the scale exact.'));
      }
      nodes.push(actions(button('Mark on plan', { ic: 'crosshair', cls: 'btn btn-primary btn-lg btn-block', onclick: () => pick(i) })));
      const more = [];
      if (redo) more.push(button('Cancel redo', { cls: 'btn btn-ghost', onclick: cancelRedo }));
      if (!redo && i >= 2 && fixedN >= 2 && fixedN === i) {
        const cal = solve();
        if (cal) nodes.push(provisionalNote(C, cal, fixedN));
        more.push(button(i >= GPS_POINTS ? 'Back to the result' : `See the result with ${fixedN} points`, {
          cls: 'btn btn-ghost',
          onclick: () => { dropUnfixed(); st.target = countFixed(); st.phase = 'result'; render(); },
        }));
      }
      if (more.length) nodes.push(actions(...more));
      return nodes;
    },

    picking() {
      return [el('p', { class: 'cal-picking' },
        el('span', { html: icon('crosshair', { size: 22 }) }),
        el('span', {}, `Point ${st.index + 1}: move the plan so the cross is on the spot, then tap Set.`))];
    },

    walk() {
      const i = st.index;
      const hint = el('p', { class: 'cal-live' });
      const problem = el('div', { class: 'cal-problem' });
      const set = button('Set location', { ic: 'here', cls: 'btn btn-primary btn-lg btn-block', onclick: () => startSampling(false) });
      liveFn = () => {
        const pr = gpsProblem(C);
        if (pr) problem.replaceChildren(banner(pr.level, pr.title, pr.text)); else problem.replaceChildren();
        set.disabled = !!pr?.blocking;
        hint.textContent = walkHint(i);
        hint.hidden = !hint.textContent;
      };
      return [
        el('h2', { class: 'cal-h' }, `Walk to point ${i + 1} and stand on it`),
        el('p', {}, 'Stand right on the spot with the screen on. Hold the phone at chest height and keep still while it measures — about half a minute.'),
        hint,
        problem,
        st.notice ? banner(st.notice.level, '', st.notice.text) : null,
        actions(set),
        actions(
          button('Move the mark', { ic: 'crosshair', cls: 'btn btn-outline', onclick: () => pick(i) }),
          st.backup?.index === i ? button('Cancel redo', { cls: 'btn btn-ghost', onclick: cancelRedo }) : null),
      ];
    },

    sampling() {
      const s = st.sampler;
      const stat = (k) => {
        const v = el('div', { class: 'v' }, '—');
        return [el('div', { class: 'cal-stat' }, v, el('div', { class: 'k' }, k)), v];
      };
      const [nBox, nV] = stat('GPS fixes');
      const [tBox, tV] = stat('Time');
      const [aBox, aV] = stat('Precision');
      const [sBox, sV] = stat('Spread');
      const fill = el('div', { class: 'cal-meter-fill' });
      const meter = el('div', { class: 'cal-meter', role: 'progressbar', 'aria-label': 'Measuring' },
        fill, el('div', { class: 'cal-meter-min', style: { left: `${(SAMPLE.minSeconds / SAMPLE.maxSeconds) * 100}%` } }));
      const hint = el('p', { class: 'cal-live' });
      const done = button('Done', { ic: 'check', cls: 'btn btn-ok btn-lg', onclick: () => finishEarly(s, false) });
      done.disabled = true;
      s.els = { nV, tV, aV, sV, fill, hint, done };
      liveFn = () => paintSampling(s);
      return [
        el('h2', { class: 'cal-h' }, `Point ${st.index + 1}: hold still…`),
        el('div', { class: 'cal-stats' }, nBox, tBox, aBox, sBox),
        meter,
        hint,
        tip('Keep the screen on and this app open — phones stop GPS for apps in the background.'),
        actions(button('Cancel', { cls: 'btn btn-outline', onclick: () => cancelSampling(s) }), done),
      ];
    },

    sampled() {
      const i = st.index;
      const f = st.points[i].fix;
      const fixedN = countFixed();
      const nextIdx = firstUnfixed();
      const toResult = nextIdx < 0 && fixedN >= st.target;
      const nodes = [
        el('h2', { class: 'cal-h cal-ok' }, el('span', { html: icon('check', { size: 22 }) }), el('span', {}, `Point ${i + 1} is set`)),
        el('div', { class: 'cal-big' }, formatAccuracy(f.acc, u())),
        el('p', { class: 'muted' }, `${f.n} GPS fix${f.n === 1 ? '' : 'es'} over ${Math.round(f.seconds || 0)} s${f.spread ? ` · spread ${formatLength(f.spread, u())}` : ''}`),
      ];
      if (f.acc > 5) nodes.push(banner('warn', 'Weak GPS here', 'Tap Keep averaging, or redo this point later with a clearer view of the sky.'));
      const cal = fixedN >= 2 ? solve() : null;
      if (cal && !toResult) nodes.push(provisionalNote(C, cal, fixedN));
      const nextLabel = toResult ? 'See the result' : `Next: point ${(nextIdx < 0 ? st.points.length : nextIdx) + 1}`;
      nodes.push(actions(button(nextLabel, { ic: 'forward', cls: 'btn btn-primary btn-lg btn-block', onclick: next })));
      nodes.push(actions(
        button('Keep averaging', { ic: 'clock', cls: 'btn btn-outline', onclick: () => startSampling(true) }),
        button('Redo this point', { cls: 'btn btn-ghost', onclick: () => redo(i) })));
      return nodes;
    },

    result() {
      const cal = solve();
      const { idx } = gpsPairs(C, st.points);
      if (!cal) {
        return [
          banner('err', 'These points could not be lined up', solveError || 'Check that each point is marked on the spot you stood on.'),
          actions(...st.points.map((p, i) => button(`Redo point ${i + 1}`, { cls: 'btn btn-outline', onclick: () => redo(i) }))),
          countFixed() < GPS_MAX_POINTS ? actions(button('Add a point', { ic: 'plus', cls: 'btn btn-ghost', onclick: addPoint })) : null,
        ];
      }
      const fixedN = countFixed();
      return [resultCard(C, cal, {
        noun: 'Point',
        compareTo: C.level.calibration,
        onSave: save,
        onRedo: (k) => redo(idx[k]),
        onRemove: fixedN > 2 ? (k) => removePoint(idx[k]) : null,
        onAdd: fixedN < GPS_MAX_POINTS ? addPoint : null,
        addLabel: `Add a ${ordinal(fixedN + 1)} point`,
      })];
    },
  };

  function walkHint(i) {
    const pose = safePose(C);
    const here = pose ? poseEnu(C, pose) : null;
    if (!here) return '';
    const acc = num(pose.geo?.acc);
    const L = (m) => formatLength(m, u());
    const cal = solve() || C.level.calibration;
    const target = st.points[i]?.plan;
    if (cal && target) {
      const t = planToEnu(cal, target);
      const d = Math.hypot(t.e - here.e, t.n - here.n);
      if (d <= Math.max(acc ?? 0, 3)) return `You look close to point ${i + 1}. Stand right on it and tap Set location.`;
      return `You're about ${L(d)} from point ${i + 1}${acc != null ? ` (GPS ${formatAccuracy(acc, u())})` : ''}.`;
    }
    // No calibration yet: help spread the points out.
    const { pairs, idx } = gpsPairs(C, st.points);
    let best = null;
    pairs.forEach((p, k) => {
      if (idx[k] === i) return;
      const d = Math.hypot(p.enu.e - here.e, p.enu.n - here.n);
      if (!best || d < best.d) best = { d, k: idx[k] };
    });
    if (!best) return '';
    return best.d < 15
      ? `You're only ${L(best.d)} from point ${best.k + 1}. Points far apart give a much better result.`
      : `Point ${best.k + 1} is ${L(best.d)} away.`;
  }

  async function pick(i) {
    if (st.phase === 'picking') return;
    const prev = st.points[i] || null;
    const back = st.phase;
    st.phase = 'picking';
    render();
    const pt = await pickOnPlan(C, view, {
      title: `Point ${i + 1}`,
      hint: 'Put the cross on a spot you can stand on, then tap Set.',
      initial: prev?.plan || undefined,
    });
    if (!C.live()) return;
    if (!pt) { st.phase = back === 'picking' ? 'mark' : back; render(); return; }
    if (prev?.fix && st.backup?.index !== i) st.backup = { index: i, point: prev };
    st.points[i] = { plan: pt, fix: null };
    st.index = i;
    st.notice = null;
    st.phase = 'walk';
    touch();
    render();
    await persist();
  }

  function redo(i) {
    if (st.sampler) return;
    if (st.points[i]?.fix && st.backup?.index !== i) {
      if (st.backup) st.points[st.backup.index] = st.backup.point;   // only one redo at a time
      st.backup = { index: i, point: st.points[i] };
    }
    st.index = i;
    st.phase = 'mark';
    st.notice = null;
    touch();
    render();
  }

  function cancelRedo() {
    const b = st.backup;
    st.backup = null;
    if (b) st.points[b.index] = b.point;
    touch();
    const k = firstUnfixed();
    if (k >= 0) { st.index = k; st.phase = st.points[k] ? 'walk' : 'mark'; }
    else if (countFixed() >= st.target) st.phase = 'result';
    else { st.index = st.points.length; st.phase = 'mark'; }
    render();
    persist();
  }

  function dropUnfixed() {
    if (st.backup) { st.points[st.backup.index] = st.backup.point; st.backup = null; }
    st.points = st.points.filter((p) => p?.fix);
    touch();
  }

  function addPoint() {
    dropUnfixed();
    st.target = st.points.length + 1;
    st.index = st.points.length;
    st.phase = 'mark';
    render();
  }

  async function removePoint(i) {
    const ok = await confirmDialog({
      title: `Remove point ${i + 1}?`,
      message: 'The calibration will be worked out from the other points. You can add a point again afterwards.',
      okText: 'Remove',
    });
    if (!ok || !C.live()) return;
    st.points.splice(i, 1);
    st.target = Math.max(2, countFixed());
    touch();
    st.phase = 'result';
    render();
    await persist();
  }

  function next() {
    const k = firstUnfixed();
    if (k >= 0) { st.index = k; st.phase = st.points[k] ? 'walk' : 'mark'; }
    else if (countFixed() < st.target) { st.index = st.points.length; st.phase = 'mark'; }
    else st.phase = 'result';
    render();
  }

  // ---- measuring a point ----

  function startSampling(more) {
    if (st.sampler) return;
    if (typeof C.positioning?.sampleStationary !== 'function') {
      toast('Positioning is not ready on this phone yet. Reload the app and try again.', { type: 'err' });
      return;
    }
    const pr = gpsProblem(C);
    if (pr?.blocking) { toast(pr.title, { type: 'err' }); return; }
    const s = {
      ac: new AbortController(), t0: performance.now(), fixes: [], lastKey: '', progress: null,
      done: false, more, tick: 0, safety: 0, waitEngine: false, hiddenStop: false, els: null,
      promise: null, prior: null,
    };
    // "Keep averaging" hands the engine the fixes it already has, so the new
    // average covers the whole time stood there (not two averages glued together).
    const prevRaw = more ? st.points[st.index]?.fix?.raw : null;
    if (prevRaw?.fixes?.length) s.prior = prevRaw;
    st.sampler = s;
    st.phase = 'sampling';
    st.notice = null;
    render();
    s.tick = setInterval(() => paintSampling(s), 250);
    s.safety = setTimeout(() => finishEarly(s, true), (SAMPLE.maxSeconds + 20) * 1000);
    try {
      s.promise = C.positioning.sampleStationary({
        ...SAMPLE, signal: s.ac.signal, onProgress: (p) => onProgress(s, p), ...(s.prior ? { prior: s.prior } : {}),
      });
    } catch (err) {
      settle(s, { error: err });
      return;
    }
    Promise.resolve(s.promise).then(
      (r) => settle(s, { result: fromEngine(r, s) }),
      (err) => settle(s, { error: err }));
  }

  function onProgress(s, p) {
    if (s.done) return;
    s.progress = p || null;
    const f = parseFix(p?.lastFix);
    if (f) {
      const key = `${f.t}|${f.lat}|${f.lng}`;
      if (key !== s.lastKey) { s.lastKey = key; s.fixes.push(f); }
    }
  }

  function fromEngine(r, s) {
    const lat = num(r?.lat), lng = num(r?.lng);
    const local = averageFixes(s.fixes);
    if (lat == null || lng == null) return local;
    return {
      lat, lng,
      alt: num(r.alt),
      acc: num(r.acc) > 0 ? r.acc : (local?.acc ?? 5),
      n: num(r.n) ?? s.fixes.length,
      spread: num(r.spread) ?? local?.spread ?? 0,
      seconds: num(r.seconds),
      // The raw fixes, kept with the draft so Keep averaging can continue them.
      raw: Array.isArray(r.fixes) ? { fixes: r.fixes, seconds: num(r.seconds) ?? 0 } : null,
    };
  }

  function paintSampling(s) {
    const e = s.els;
    if (!e || s.done || !C.alive) return;
    const elapsed = (performance.now() - s.t0) / 1000;
    const local = s.fixes.length ? averageFixes(s.fixes) : null;
    const n = Math.max(num(s.progress?.n) ?? 0, s.fixes.length);
    const acc = num(s.progress?.acc) ?? local?.acc ?? null;
    const spread = num(s.progress?.spread) ?? local?.spread ?? null;
    e.nV.textContent = String(n);
    e.tV.textContent = formatDuration(elapsed);
    e.aV.textContent = acc != null ? formatAccuracy(acc, u()) : '—';
    e.sV.textContent = spread != null ? formatLength(spread, u()) : '—';
    e.fill.style.width = `${Math.min(100, (elapsed / SAMPLE.maxSeconds) * 100)}%`;
    const can = elapsed >= SAMPLE.minSeconds && n >= 3 && !s.waitEngine;
    e.done.disabled = !can;
    e.hint.textContent = s.waitEngine
      ? 'Finishing…'
      : s.progress?.walking
        ? 'You seem to be walking — stand still right on the spot.'
        : n === 0
          ? 'Waiting for the first GPS fix… Stay in the open.'
          : elapsed < SAMPLE.minSeconds
            ? `Keep still — Done in about ${Math.ceil(SAMPLE.minSeconds - elapsed)} s.`
            : `You can tap Done now, or keep still for a better fix (up to ${Math.max(0, Math.ceil(SAMPLE.maxSeconds - elapsed))} s more).`;
  }

  function finishEarly(s, fromTimer) {
    if (s.done) return;
    // The engine can finish with its own (honest) average of what it has.
    const engineFinish = s.promise?.finish || s.progress?.finish;
    if (!fromTimer && typeof engineFinish === 'function') {
      s.waitEngine = true;
      paintSampling(s);
      try { engineFinish(); return; } catch { s.waitEngine = false; }
    }
    const avg = averageFixes(s.fixes);
    if (avg && avg.n >= 3) {
      try { s.ac.abort(); } catch { /* done */ }
      settle(s, { result: avg, early: true });
      return;
    }
    if (fromTimer) {
      try { s.ac.abort(); } catch { /* done */ }
      settle(s, { error: new Error('No GPS fixes came in while measuring.') });
      return;
    }
    // The engine's fixes are not visible from here: let it finish on its own.
    s.waitEngine = true;
    paintSampling(s);
  }

  function cancelSampling(s) {
    if (s.done) return;
    try { s.ac.abort(); } catch { /* done */ }
    settle(s, { cancelled: true });
  }

  function settle(s, { result = null, error = null, cancelled = false, early = false }) {
    if (s.done) return;
    s.done = true;
    clearInterval(s.tick);
    clearTimeout(s.safety);
    if (st.sampler === s) st.sampler = null;
    if (!C.live()) return;
    if (cancelled) {
      st.phase = 'walk';
      st.notice = {
        level: 'info',
        text: s.hiddenStop
          ? 'Measuring stopped because the screen turned off or the app was hidden. Nothing was kept for this try — tap Set location to measure again.'
          : 'Measuring stopped. Nothing was kept for this try — tap Set location when you are ready.',
      };
      render();
      return;
    }
    if (!result) {
      if (s.more) {
        // The point keeps the average it already had.
        st.phase = 'sampled';
        toast(`${sampleErrorText(error)} The point keeps the location it already had.`, { type: 'warn' });
      } else {
        st.phase = 'walk';
        st.notice = { level: 'err', text: sampleErrorText(error) };
      }
      render();
      return;
    }
    acceptSample(s, result, early);
  }

  async function acceptSample(s, r, early) {
    const i = st.index;
    const measured = Math.round((performance.now() - s.t0) / 100) / 10;
    let fix = {
      lat: r.lat, lng: r.lng, alt: num(r.alt), acc: Math.max(num(r.acc) ?? 5, 0.1),
      n: r.n || s.fixes.length, spread: num(r.spread) ?? 0,
      seconds: num(r.seconds) ?? measured,
      at: Date.now(), by: early ? 'local' : 'engine',
      raw: r.raw || null,
    };
    const prev = st.points[i]?.fix;
    // Continued by the engine (prior) already covers both; otherwise combine the two averages.
    if (s.more && prev && !(s.prior && !early)) fix = { ...combineSamples(prev, fix), at: Date.now(), raw: null };
    st.points[i] = { ...st.points[i], fix };
    if (st.backup?.index === i) st.backup = null;
    touch();
    buzz(30);
    await persist();   // kept on the phone first, even if the person has left
    try {
      await ensureOrigin(C, fix);
    } catch (err) {
      toast(`The job walk's map origin could not be saved yet (${err.message}). Your point is kept; saving tries again.`, { type: 'warn' });
    }
    touch();
    if (!C.live()) return;
    st.phase = 'sampled';
    render();
  }

  async function save() {
    if (st.saving) return;
    st.saving = true;
    try {
      if (!C.project?.origin) {
        const f = st.points.find((p) => p?.fix)?.fix;
        if (f) await ensureOrigin(C, f);
      }
    } catch { /* reported below by solve */ }
    touch();
    const cal = solve();
    if (!cal) {
      st.saving = false;
      toast(solveError || 'These points could not be lined up.', { type: 'err' });
      render();
      return;
    }
    const ok = await saveCalibration(C, cal, { draftPart: 'gps' });
    if (!ok) { st.saving = false; return; }
    finish(C);
  }

  if (!st.points.length) { st.phase = 'mark'; st.index = 0; }
  render();
}

function sampleErrorText(err) {
  const m = err?.message || '';
  if (err?.code === 1 || /denied|permission/i.test(m)) {
    return 'Location is blocked for this app. Allow location in the phone settings, then tap Set location again.';
  }
  if (err?.code === 3 || /timeout|timed out|no fix|no gps|fixes/i.test(m)) {
    return 'No GPS position came in. Step into the open, away from walls and steel, wait until the GPS chip shows a number, then tap Set location again.';
  }
  return `The location could not be measured (${m || 'the phone gave no position'}). Tap Set location to try again.`;
}

// ---- satellite map alignment (office) -----------------------------------------------------

function mapStart(C) {
  const p = C.project;
  if (p?.mapView && num(p.mapView.lat) != null && num(p.mapView.lng) != null) {
    return { center: { lat: p.mapView.lat, lng: p.mapView.lng }, zoom: num(p.mapView.zoom) ?? 19, known: true };
  }
  if (p?.origin) return { center: { lat: p.origin.lat, lng: p.origin.lng }, zoom: 19, known: true };
  const g = safePose(C)?.geo;
  if (g && num(g.lat) != null && num(g.lng) != null && (num(g.acc) ?? 999) < 200) {
    return { center: { lat: g.lat, lng: g.lng }, zoom: 18, known: true };
  }
  return { center: { lat: 39.5, lng: -98.35 }, zoom: 4, known: false };
}

function saveMapView(C, mv) {
  try {
    const v = mv?.getView?.();
    const lat = num(v?.lat ?? v?.center?.lat), lng = num(v?.lng ?? v?.center?.lng), zoom = num(v?.zoom);
    if (lat == null || lng == null || zoom == null) return;
    C.store.updateProject(C.pid, { mapView: { lat, lng, zoom } }, { quiet: true }).catch(() => { /* view state only */ });
  } catch { /* view state only */ }
}

async function mapMode(C) {
  C.mode = 'map';
  const F = frame(C, { title: 'Align plan to map', sub: C.level.name });
  F.stage.classList.add('cal-split');
  const planHost = el('div', { class: 'cal-view cal-plan' });
  const mapHost = el('div', { class: 'cal-view cal-map' });
  F.stage.prepend(planHost, mapHost);
  F.panel.replaceChildren(loadingNode('Opening the plan and the map…'));
  const view = await mountPlan(C, planHost);
  if (!view) return;
  const colors = readColors();
  const u = C.units;

  let mv = null;
  const start = mapStart(C);
  try {
    const mod = await import('./map-view.js');
    if (!C.live()) return;
    // No provider passed: the map follows the Map settings (Esri / Google / OSM) itself.
    mv = await mod.createMapView(mapHost, { center: start.center, zoom: start.zoom, units: C.units() });
    if (!C.live()) { try { mv.destroy?.(); } catch { /* gone */ } return; }
    C.onCleanup(() => { saveMapView(C, mv); mv.destroy?.(); });
    watchSize(C, mapHost, () => mv.resize?.());
  } catch (err) {
    if (!C.live()) return;
    F.panel.replaceChildren(
      banner('err', 'The satellite map could not be opened', `${err?.message || err} Lining up with the map needs an internet connection. Calibrating with GPS on site works without one.`),
      actions(
        button('Calibrate with GPS instead', { ic: 'locate', cls: 'btn btn-primary', onclick: () => goMode(C, 'gps') }),
        button('Back', { cls: 'btn btn-ghost', onclick: () => leave(C) })));
    return;
  }

  const st = { pairs: [], index: 0, phase: 'plan', pending: null, backup: null, picking: false, saving: false, draftWarned: false };
  let ver = 0, solvedVer = -1, solved = null, solveError = '';
  const touch = () => { ver++; };
  function mapPairs() {
    const origin = C.project?.origin;
    if (!origin) return [];
    return st.pairs.filter((p) => p?.plan && p.geo).map((p) => ({
      plan: { x: p.plan.x, y: p.plan.y },
      enu: toEnu(origin, p.geo.lat, p.geo.lng),
      sigma: MAP_SIGMA,
      geo: { lat: p.geo.lat, lng: p.geo.lng },
    }));
  }
  function solve() {
    if (solvedVer === ver) return solved;
    solvedVer = ver;
    solved = null;
    solveError = '';
    const pairs = mapPairs();
    if (pairs.length >= 2) {
      try { solved = solveCalibration({ pairs, scaleLine: currentScaleLine(C.level), method: 'map' }); }
      catch (err) { solveError = err.message; }
    }
    return solved;
  }
  const done = () => st.pairs.filter((p) => p?.plan && p.geo).length;

  installGuard(C, () => done() > 0 && !st.saving,
    'The pairs you picked are not saved as a calibration yet. They stay on this phone for a day, so you can come back and finish.');

  async function persist() {
    try { await writeDraft(C, 'map', { pairs: st.pairs.filter((p) => p?.plan && p.geo) }); }
    catch (err) {
      if (st.draftWarned) return;
      st.draftWarned = true;
      toast(`A backup copy of your pairs could not be kept on this phone (${err.message}).`, { type: 'warn' });
    }
  }

  // Plan | Satellite on a phone; side by side on a wide screen.
  const segPlan = el('button', { type: 'button', onclick: () => show('plan') }, 'Plan');
  const segMap = el('button', { type: 'button', onclick: () => show('map') }, 'Satellite');
  F.overlay.append(el('div', { class: 'seg cal-seg', role: 'group', 'aria-label': 'Show' }, segPlan, segMap));
  function show(which) {
    F.stage.dataset.show = which;
    segPlan.classList.toggle('on', which === 'plan');
    segMap.classList.toggle('on', which === 'map');
    requestAnimationFrame(() => { if (!C.alive) return; view.resize?.(); mv.resize?.(); });
  }
  const setPicking = (on) => { st.picking = on; segPlan.disabled = on; segMap.disabled = on; };

  // Finding the site: the address typed for the job walk, searched only on a tap
  // (or once, when the map has nowhere better to start).
  const q = el('input', {
    class: 'input', type: 'search', placeholder: 'Address or place', autocomplete: 'off',
    enterkeyhint: 'search', 'aria-label': 'Find the site on the map',
  });
  q.value = C.project.address || '';
  const findBtn = button('Find', { ic: 'search', cls: 'btn btn-outline', onclick: () => findAddress(q.value) });
  const searchRow = el('form', { class: 'cal-search', onsubmit: (e) => { e.preventDefault(); findAddress(q.value); } }, q, findBtn);

  async function findAddress(text) {
    const query = String(text || '').trim();
    if (!query) { toast('Type the site address first.', { type: 'info' }); return; }
    if (typeof mv.searchAddress !== 'function') return;
    findBtn.disabled = true;
    let results = [];
    try {
      results = (await mv.searchAddress(query)) || [];
    } catch (err) {
      if (C.alive) toast(`The address search did not work (${err.message}). Check the internet connection, or move the map by hand.`, { type: 'warn' });
      return;
    } finally {
      findBtn.disabled = false;
    }
    if (!C.live()) return;
    if (!results.length) { toast('No place found for that address. Try the street and city, or move the map by hand.', { type: 'warn' }); return; }
    let r = results[0];
    if (results.length > 1) {
      const k = await choose({ title: 'Which one?', options: results.slice(0, 6).map((x, i) => ({ value: i, label: x.label, icon: 'pin' })) });
      if (k == null || !C.live()) return;
      r = results[k];
    }
    show('map');
    mv.centerOn?.({ lat: r.lat, lng: r.lng }, 19);
  }

  // Pairs from earlier (the app was closed) are offered back.
  const draft = await readDraft(C, 'map');
  if (!C.live()) return;
  const saved = (draft?.pairs || []).filter((p) => p?.plan && num(p.plan.x) != null && num(p.geo?.lat) != null && num(p.geo?.lng) != null);
  if (saved.length) {
    const go = await confirmDialog({
      title: 'Continue where you left off?',
      message: `You picked ${saved.length} pair${saved.length === 1 ? '' : 's'} ${when(draft.savedAt)}. Continue with ${saved.length === 1 ? 'it' : 'them'}, or start over?`,
      okText: 'Continue',
      cancelText: 'Start over',
    });
    if (!C.live()) return;
    if (go) {
      st.pairs = saved.map((p) => ({ plan: { x: p.plan.x, y: p.plan.y }, geo: { lat: p.geo.lat, lng: p.geo.lng } }));
      st.index = st.pairs.length;
      st.phase = st.pairs.length >= 2 ? 'result' : 'plan';
      touch();
    }
  }

  function drawMarks() {
    const cal = solve();
    const marks = [];
    const lines = [];
    const sl = currentScaleLine(C.level);
    if (sl) lines.push({ a: sl.a, b: sl.b, label: formatLength(sl.meters, u()), color: colors.muted, dashed: false });
    const geoMarks = [];
    st.pairs.forEach((p, k) => {
      if (!p) return;
      let color = k === st.index && st.phase !== 'result' ? colors.brand : colors.ok;
      if (cal && st.phase === 'result') color = residualColor(colors, cal.residuals[k] ?? 0);
      marks.push({ x: p.plan.x, y: p.plan.y, label: String(k + 1), color, kind: 'calib' });
      if (p.geo) geoMarks.push({ lat: p.geo.lat, lng: p.geo.lng, label: String(k + 1), color, kind: 'calib' });
    });
    if (st.pending) marks.push({ x: st.pending.x, y: st.pending.y, label: String(st.index + 1), color: colors.brand, kind: 'calib' });
    try {
      view.setMarks?.(marks);
      view.setLines?.(lines);
      mv.setMarks?.(geoMarks);
      // The plan laid over the satellite photo shows at a glance whether it fits.
      mv.setPlanOverlay?.(cal && C.planImage ? {
        image: C.planImage, calibration: cal, origin: C.project.origin, opacity: 0.55,
        width: C.level.plan.width, height: C.level.plan.height,
      } : null);
    } catch (err) {
      console.warn('[calibrate] map marks', err);
    }
  }

  function render() {
    if (!C.live()) return;
    const n = done();
    const total = Math.max(2, n + (st.phase === 'result' ? 0 : 1), st.index + 1);
    F.panel.classList.toggle('compact', st.picking);
    F.setSub(st.phase === 'result' ? `${n} pairs · result` : `Pair ${st.index + 1} · at least 2, up to ${MAP_MAX_PAIRS}`);
    drawMarks();
    const head = st.picking ? null : stepsRow(Math.min(total, MAP_MAX_PAIRS), new Set(st.pairs.map((p, i) => (p?.geo ? i : -1)).filter((i) => i >= 0)), st.phase === 'result' ? -1 : st.index);
    F.panel.replaceChildren(...[head, ...PHASES[st.picking ? 'picking' : st.phase]()].filter(Boolean));
    F.panel.scrollTop = 0;
  }

  const PHASES = {
    plan() {
      const i = st.index;
      const nodes = [
        el('h2', { class: 'cal-h' }, st.backup ? `Redo pair ${i + 1}: the plan` : `Pair ${i + 1}: pick a spot on the plan`),
        el('p', {}, 'Pick something you can also see on the satellite photo — a building corner, a slab corner, the end of a wall. Pick spots far apart.'),
        searchRow,
        actions(button('Mark on plan', { ic: 'crosshair', cls: 'btn btn-primary btn-lg btn-block', onclick: pickPlan })),
      ];
      const more = [];
      if (st.backup) more.push(button('Cancel redo', { cls: 'btn btn-ghost', onclick: cancelRedo }));
      else if (done() >= 2) more.push(button('Back to the result', { cls: 'btn btn-ghost', onclick: () => { st.pending = null; st.phase = 'result'; render(); } }));
      if (more.length) nodes.push(actions(...more));
      return nodes;
    },
    map() {
      const i = st.index;
      return [
        el('h2', { class: 'cal-h' }, `Pair ${i + 1}: the same spot on the map`),
        el('p', {}, 'Move the satellite photo so the cross is on exactly the same spot you marked on the plan. Zoom in close.'),
        searchRow,
        actions(button('Mark on map', { ic: 'crosshair', cls: 'btn btn-primary btn-lg btn-block', onclick: pickMap })),
        actions(
          button('Change the plan spot', { cls: 'btn btn-outline', onclick: pickPlan }),
          st.backup ? button('Cancel redo', { cls: 'btn btn-ghost', onclick: cancelRedo }) : null),
      ];
    },
    picking() {
      const onMap = F.stage.dataset.show === 'map';
      return [el('p', { class: 'cal-picking' },
        el('span', { html: icon('crosshair', { size: 22 }) }),
        el('span', {}, onMap
          ? `Pair ${st.index + 1}: put the cross on the same spot on the satellite photo, then tap Set.`
          : `Pair ${st.index + 1}: put the cross on the spot on the plan, then tap Set.`))];
    },
    result() {
      const cal = solve();
      if (!cal) {
        return [
          banner('err', 'These pairs could not be lined up', solveError || 'Check that each pair marks the same spot.'),
          actions(...st.pairs.map((_, k) => button(`Redo pair ${k + 1}`, { cls: 'btn btn-outline', onclick: () => redoPair(k) }))),
        ];
      }
      const n = done();
      return [resultCard(C, cal, {
        noun: 'Pair',
        compareTo: C.level.calibration,
        onSave: save,
        onRedo: redoPair,
        onRemove: n > 2 ? removePair : null,
        onAdd: n < MAP_MAX_PAIRS ? addPair : null,
        addLabel: n === 2 ? 'Add a 3rd pair (recommended)' : `Add pair ${n + 1}`,
        note: el('p', { class: 'small muted' }, 'The plan is laid over the satellite photo — switch to Satellite to check that walls and corners line up.'),
      })];
    },
  };

  async function pickPlan() {
    if (st.picking) return;
    const i = st.index;
    show('plan');
    setPicking(true);
    render();
    const pt = await pickOnPlan(C, view, {
      title: `Pair ${i + 1}: plan`,
      hint: 'Put the cross on a corner you can also see on the satellite photo, then tap Set.',
      initial: st.pending || st.backup?.pair?.plan || undefined,
    });
    if (!C.live()) return;
    setPicking(false);
    if (!pt) { render(); return; }
    st.pending = pt;
    st.phase = 'map';
    render();
    pickMap();
  }

  async function pickMap() {
    if (st.picking || !st.pending) return;
    const i = st.index;
    if (typeof mv.pickPoint !== 'function') { toast('The map cannot take a point here yet. Reload the app and try again.', { type: 'err' }); return; }
    show('map');
    setPicking(true);
    render();
    let g = null;
    try {
      const old = st.backup?.pair?.geo;
      g = await mv.pickPoint({
        title: `Pair ${i + 1}: map`,
        hint: 'Put the cross on the same spot on the satellite photo, then tap Set.',
        initial: old ? { lat: old.lat, lng: old.lng } : undefined,
      });
    } catch (err) {
      if (C.alive) toast(`The point could not be placed: ${err.message}`, { type: 'err' });
    }
    if (!C.live()) return;
    setPicking(false);
    if (!g || num(g.lat) == null || num(g.lng) == null) { st.phase = 'map'; render(); return; }
    try {
      await ensureOrigin(C, g);
    } catch (err) {
      toast(`The job walk's map origin could not be saved (${err.message}). Try again.`, { type: 'err' });
      st.phase = 'map';
      render();
      return;
    }
    if (!C.live()) return;
    st.pairs[i] = { plan: st.pending, geo: { lat: g.lat, lng: g.lng } };
    st.pending = null;
    st.backup = null;
    touch();
    await persist();
    if (!C.live()) return;
    const n = done();
    if (n >= 2) { st.phase = 'result'; show('map'); }
    else { st.index = n; st.phase = 'plan'; show('plan'); }
    render();
  }

  function redoPair(k) {
    if (st.backup) st.pairs[st.backup.index] = st.backup.pair;
    st.backup = { index: k, pair: st.pairs[k] };
    st.index = k;
    st.pending = null;
    st.phase = 'plan';
    render();
  }

  function cancelRedo() {
    if (st.backup) st.pairs[st.backup.index] = st.backup.pair;
    st.backup = null;
    st.pending = null;
    st.index = done();
    st.phase = done() >= 2 ? 'result' : 'plan';
    touch();
    render();
  }

  function addPair() {
    st.index = done();
    st.pending = null;
    st.phase = 'plan';
    show('plan');
    render();
  }

  async function removePair(k) {
    const ok = await confirmDialog({ title: `Remove pair ${k + 1}?`, message: 'The alignment will be worked out from the other pairs.', okText: 'Remove' });
    if (!ok || !C.live()) return;
    st.pairs.splice(k, 1);
    st.index = done();
    touch();
    st.phase = 'result';
    render();
    await persist();
  }

  async function save() {
    if (st.saving) return;
    st.saving = true;
    touch();
    const cal = solve();
    if (!cal) {
      st.saving = false;
      toast(solveError || 'These pairs could not be lined up.', { type: 'err' });
      return;
    }
    const ok = await saveCalibration(C, cal, { draftPart: 'map' });
    if (!ok) { st.saving = false; return; }
    finish(C);
  }

  C.onProjectChange = () => { touch(); };
  show(st.phase === 'result' ? 'map' : 'plan');
  render();
  if (!start.known && C.project.address) findAddress(C.project.address);
}

// ---- scale line -----------------------------------------------------------------------------

async function scaleMode(C) {
  C.mode = 'scale';
  const F = frame(C, { title: 'Scale line', sub: C.level.name });
  const host = el('div', { class: 'cal-view' });
  F.stage.prepend(host);
  F.panel.replaceChildren(loadingNode('Opening the plan…'));
  const view = await mountPlan(C, host);
  if (!view) return;
  const colors = readColors();
  const u = C.units;
  const existing = currentScaleLine(C.level);

  const st = { a: null, b: null, text: '', phase: 'a', picking: false, cal: null, line: null, saved: false };
  const d = await readDraft(C, 'scale');
  if (!C.live()) return;
  if (d?.a && d?.b && num(d.a.x) != null && num(d.b.x) != null) {
    st.a = d.a; st.b = d.b; st.text = d.text || ''; st.phase = 'length';
  }

  // What is typed is kept on the phone within a second, and when the app hides.
  const keep = () => writeDraft(C, 'scale', { a: st.a, b: st.b, text: st.text }).catch((err) => console.warn('[calibrate] scale draft', err));
  const keepSoon = debounce(keep, 800);
  const flush = () => keepSoon.flush();
  const onVis = () => { if (document.visibilityState === 'hidden') flush(); };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('pagehide', flush);
  C.onCleanup(() => {
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('pagehide', flush);
    if (!st.saved) flush(); else keepSoon.cancel();
  });

  installGuard(C, () => !!(st.a && st.b) && !st.saved,
    'The scale line is not saved yet. It stays on this phone for a day, so you can come back and finish.');

  const px = () => (st.a && st.b ? Math.hypot(st.b.x - st.a.x, st.b.y - st.a.y) : 0);
  const meters = () => parseLength(st.text, u());
  const validLen = (m) => m != null && m >= 0.3 && m <= 3000;

  function drawMarks() {
    const marks = [];
    const lines = [];
    if (existing && !(st.a && st.b)) lines.push({ a: existing.a, b: existing.b, label: `now ${formatLength(existing.meters, u())}`, color: colors.muted, dashed: true });
    if (st.a) marks.push({ x: st.a.x, y: st.a.y, label: 'A', color: colors.brand, kind: 'scale' });
    if (st.b) marks.push({ x: st.b.x, y: st.b.y, label: 'B', color: colors.brand, kind: 'scale' });
    if (st.a && st.b) {
      const m = meters();
      lines.push({ a: st.a, b: st.b, label: validLen(m) ? formatLength(m, u()) : '?', color: colors.brand, dashed: false });
    }
    try { view.setMarks?.(marks); view.setLines?.(lines); } catch (err) { console.warn('[calibrate] marks', err); }
  }

  function render() {
    if (!C.live()) return;
    F.panel.classList.toggle('compact', st.picking);
    const step = { a: 1, b: 2, length: 3, result: 4, saved: 4 }[st.phase] || 1;
    F.setSub(st.phase === 'saved' ? 'Saved' : `Step ${Math.min(step, 3)} of 3`);
    drawMarks();
    const head = st.picking ? null : stepsRow(3, new Set([st.a ? 0 : -1, st.b ? 1 : -1, st.saved || st.phase === 'result' ? 2 : -1]), Math.min(step, 3) - 1);
    F.panel.replaceChildren(...[head, ...PHASES[st.picking ? 'picking' : st.phase]()].filter(Boolean));
    F.panel.scrollTop = 0;
  }

  const PHASES = {
    a() {
      return [
        el('h2', { class: 'cal-h' }, 'Mark one end of a dimension you know'),
        el('p', {}, 'Pick something long whose length you know — a 24\' wall on the plan, a grid line spacing, a slab edge. The longer it is, the more exact the scale.'),
        existing ? banner('info', `Scale line now: ${formatLength(existing.meters, u())}`, 'A new one replaces it. The old one stays in the calibration history.') : null,
        actions(button('Mark end A', { ic: 'crosshair', cls: 'btn btn-primary btn-lg btn-block', onclick: pickA })),
      ];
    },
    b() {
      return [
        el('h2', { class: 'cal-h' }, st.b ? 'Check the other end' : 'Now mark the other end'),
        el('p', {}, 'Put the cross on the other end of the same dimension. Zoom in for an exact spot.'),
        actions(button('Mark end B', { ic: 'crosshair', cls: 'btn btn-primary btn-lg btn-block', onclick: pickB })),
        actions(
          st.b ? button('Keep end B', { cls: 'btn btn-outline', onclick: () => { st.phase = 'length'; render(); } }) : null,
          button('Move end A', { cls: 'btn btn-ghost', onclick: pickA })),
      ];
    },
    picking() {
      return [el('p', { class: 'cal-picking' },
        el('span', { html: icon('crosshair', { size: 22 }) }),
        el('span', {}, 'Move the plan so the cross is on the end, then tap Set.'))];
    },
    length() {
      const input = el('input', {
        class: 'input cal-len', type: 'text', inputmode: 'text', autocomplete: 'off', autocapitalize: 'off',
        spellcheck: 'false', enterkeyhint: 'done', 'aria-label': 'Length between the two ends',
        placeholder: u() === 'metric' ? 'e.g. 7.32 m' : 'e.g. 24\' 6"',
      });
      input.value = st.text;
      const echo = el('p', { class: 'cal-echo', 'aria-live': 'polite' });
      const info = el('p', { class: 'small muted' });
      const use = button('Use this length', { ic: 'check', cls: 'btn btn-primary btn-lg btn-block', onclick: () => useLength() });
      const update = () => {
        const m = meters();
        const ok = validLen(m);
        const typed = !!st.text.trim();
        echo.classList.toggle('bad', typed && !ok);
        if (!typed) echo.textContent = '';
        else if (m == null) echo.textContent = `Type a length like ${u() === 'metric' ? '7.32 m' : '24\' 6"'}.`;
        else if (!ok) echo.textContent = m < 0.3 ? 'That is very short — pick a longer dimension.' : 'That is longer than a job site — check the number.';
        else echo.textContent = `= ${formatLength(m, 'imperial')}  (${formatLength(m, 'metric')})`;
        use.disabled = !ok;
        let t = `On the plan the line is ${Math.round(px())} px long.`;
        if (ok) {
          t += ` That gives ${formatScale(px() / m, u())}.`;
          const cur = C.level.calibration;
          const ea = planToEnu(cur, st.a), eb = planToEnu(cur, st.b);
          if (ea && eb) {
            const gm = Math.hypot(eb.e - ea.e, eb.n - ea.n);
            const diff = gm / m - 1;
            t += ` The calibration in use measures it as ${formatLength(gm, u())}${Math.abs(diff) >= 0.005 ? ` (${Math.round(Math.abs(diff) * 100)}% ${diff > 0 ? 'longer' : 'shorter'})` : ''}.`;
          }
        }
        info.textContent = t;
        drawMarks();
      };
      input.addEventListener('input', () => { st.text = input.value; keepSoon(); update(); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); if (!use.disabled) useLength(); }
      });
      update();
      requestAnimationFrame(() => { if (C.alive && !st.text) input.focus(); });
      return [
        el('h2', { class: 'cal-h' }, 'How long is it?'),
        el('p', {}, 'Type the real length between the two ends — feet and inches like 24\' 6", or meters.'),
        el('label', { class: 'field' }, input),
        echo,
        info,
        actions(use),
        actions(button('Move the ends', { cls: 'btn btn-ghost', onclick: () => { st.phase = 'a'; render(); } })),
      ];
    },
    result() {
      const cur = C.level.calibration;
      return [
        resultCard(C, st.cal, {
          noun: cur?.method === 'map' ? 'Pair' : 'Point',
          compareTo: cur,
          onSave: saveWithLine,
          saveLabel: 'Save with this scale',
          note: el('p', { class: 'small muted' }, `The same ${cur?.method === 'map' ? 'pairs' : 'points'} as now, with the scale from your line. To redo a point, calibrate with ${cur?.method === 'map' ? 'the map' : 'GPS'} again — the scale line is used there too.`),
        }),
        actions(button('Change the length', { cls: 'btn btn-ghost', onclick: () => { st.phase = 'length'; render(); } })),
      ];
    },
    saved() {
      return [
        banner('ok', `Scale line saved: ${formatLength(st.line.meters, u())}`, 'It sets the scale exactly when you calibrate this plan with GPS or the satellite map.'),
        actions(button('Calibrate with GPS now', { ic: 'locate', cls: 'btn btn-primary btn-lg btn-block', onclick: () => goMode(C, 'gps') })),
        actions(button('Done', { cls: 'btn btn-outline btn-block', onclick: () => finish(C) })),
      ];
    },
  };

  async function pickA() {
    if (st.picking) return;
    st.picking = true;
    render();
    const pt = await pickOnPlan(C, view, { title: 'End A', hint: 'Put the cross on one end of the dimension, then tap Set.', initial: st.a || existing?.a || undefined });
    if (!C.live()) return;
    st.picking = false;
    if (pt) { st.a = pt; st.phase = 'b'; keep(); }
    render();
  }

  async function pickB() {
    if (st.picking) return;
    st.picking = true;
    render();
    const pt = await pickOnPlan(C, view, { title: 'End B', hint: 'Put the cross on the other end, then tap Set.', initial: st.b || existing?.b || undefined });
    if (!C.live()) return;
    st.picking = false;
    if (pt) {
      if (Math.hypot(pt.x - st.a.x, pt.y - st.a.y) < MIN_LINE_PX) {
        toast('The two ends are on almost the same spot. Zoom in and mark the ends of a longer dimension.', { type: 'warn' });
      } else {
        st.b = pt;
        st.phase = 'length';
        keep();
      }
    }
    render();
  }

  async function useLength() {
    const m = meters();
    if (!validLen(m) || !st.a || !st.b) return;
    keepSoon.flush();
    const line = { a: { ...st.a }, b: { ...st.b }, meters: m, planMediaId: C.planMediaId, setAt: Date.now() };
    st.line = line;
    const cur = C.level.calibration;
    if (cur?.pairs?.length >= 2) {
      try {
        st.cal = solveCalibration({ pairs: cur.pairs, scaleLine: line, method: cur.method });
      } catch (err) {
        toast(`The calibration could not use this line: ${err.message}`, { type: 'err' });
        return;
      }
      st.phase = 'result';
      render();
      return;
    }
    // No calibration yet: keep the line with the plan for the GPS (or map) solve.
    const b = busy('Saving the scale line…');
    try {
      await C.store.updateLevel(C.pid, C.lid, (l) => { l.scaleLine = line; });
    } catch (err) {
      b.done();
      toast(`The scale line was not saved. ${err.message}`, { type: 'err' });
      return;
    }
    b.done();
    st.saved = true;
    keepSoon.cancel();
    try { await writeDraft(C, 'scale', null); } catch { /* harmless */ }
    toast(`Scale line saved: ${formatLength(m, u())}.`, { type: 'ok' });
    if (!C.live()) return;
    st.phase = 'saved';
    render();
  }

  async function saveWithLine() {
    if (!st.cal || !st.line) return;
    const ok = await saveCalibration(C, st.cal, { draftPart: 'scale', scaleLine: st.line });
    if (!ok) return;
    st.saved = true;
    keepSoon.cancel();
    finish(C);
  }

  render();
}

// ---- compass alignment ------------------------------------------------------------------

function compassDial() {
  const wrap = el('div', {
    class: 'cal-dial',
    html: '<svg viewBox="0 0 120 120" width="132" height="132" aria-hidden="true" focusable="false">'
      + '<circle cx="60" cy="60" r="54" class="ring"/>'
      + '<text x="60" y="13" text-anchor="middle" class="up">plan ↑</text>'
      + '<g class="wall"><line x1="60" y1="60" x2="60" y2="20"/><path d="M60 13l6 11h-12z"/></g>'
      + '<g class="cam"><line x1="60" y1="60" x2="60" y2="26"/><circle cx="60" cy="26" r="5"/></g>'
      + '<circle cx="60" cy="60" r="4" class="hub"/></svg>',
  });
  const legend = el('div', { class: 'cal-dial-legend small' },
    el('span', { class: 'k wall' }, 'Wall'), el('span', { class: 'k cam' }, 'Camera now'));
  const box = el('div', { class: 'cal-dial-box' }, wrap, legend);
  const wall = wrap.querySelector('.wall');
  const cam = wrap.querySelector('.cam');
  return {
    el: box,
    set(wallDeg, camDeg) {
      wall.setAttribute('transform', `rotate(${wallDeg} 60 60)`);
      if (num(camDeg) != null) { cam.removeAttribute('visibility'); cam.setAttribute('transform', `rotate(${camDeg} 60 60)`); }
      else cam.setAttribute('visibility', 'hidden');
    },
  };
}

function compassProblem(C) {
  const s = safeStatus(C);
  if (s.compass === 'needs-permission' || needsPermission(C)) {
    return { level: 'warn', blocking: true, allow: true, title: 'The compass needs your OK', text: 'Tap Allow compass, then choose Allow.' };
  }
  switch (s.compass) {
    case 'denied':
      return {
        level: 'err', blocking: true, title: 'The compass is blocked',
        text: isIOS()
          ? 'iPhone asks only once per visit. Close this tab or the app, open it again, and tap Allow when asked.'
          : 'Allow motion sensors for this site in the browser\'s site settings, then reload the app.',
      };
    case 'unavailable':
      return {
        level: 'err', blocking: true, title: 'No compass',
        text: 'This phone or browser does not report a compass direction, so camera directions cannot be aligned. Photos still save their position.',
      };
    case 'uncalibrated':
      return { level: 'warn', blocking: false, title: 'The compass needs calibrating', text: 'Move the phone in a big figure 8 a few times, away from steel, then try again.' };
    default:
      break;
  }
  if (num(safePose(C)?.heading) == null) {
    return { level: 'info', blocking: false, title: 'Waiting for the compass…', text: 'Hold the phone still for a moment.' };
  }
  return null;
}

function headingErrorText(err) {
  const m = err?.message || '';
  if (err?.name === 'AbortError') return 'Stopped. Aim along the wall and tap Set direction when you are ready.';
  // The engine's own messages already say what to do.
  if (/compass/i.test(m)) return m;
  if (/denied|permission/i.test(m)) return 'The compass is blocked. Allow motion sensors for this app, then try again.';
  return 'The compass gave no steady reading. Hold the phone upright and still, away from steel, and tap Set direction again.';
}

const fmtDeg = (d) => `${Math.round(((d % 360) + 360) % 360)}°`;
const fmtOffset = (d) => `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}°`;

async function compassMode(C) {
  C.mode = 'compass';
  const F = frame(C, { title: 'Align the compass', sub: C.level.name });
  const cal = C.level.calibration;
  if (!cal) {
    F.main.classList.add('solo');
    F.panel.replaceChildren(
      el('h2', { class: 'cal-h' }, 'Calibrate the plan first'),
      el('p', {}, 'The compass is lined up against the plan, so the app first needs to know which way north is on it. Calibrate with GPS on site (or with the satellite map), then come back to align the compass.'),
      actions(button('Calibrate with GPS', { ic: 'locate', cls: 'btn btn-primary btn-lg btn-block', onclick: () => goMode(C, 'gps') })),
      actions(button('Align to the satellite map', { ic: 'map', cls: 'btn btn-outline btn-block', onclick: () => goMode(C, 'map') })),
      actions(button('Back', { cls: 'btn btn-ghost', onclick: () => leave(C) })));
    return;
  }
  const host = el('div', { class: 'cal-view' });
  F.stage.prepend(host);
  F.panel.replaceChildren(loadingNode('Opening the plan…'));
  const view = await mountPlan(C, host);
  if (!view) return;
  statusChips(C, F.overlay, { compass: true });
  const colors = readColors();
  trackPose(C, view, () => C.level.calibration);

  const st = { p1: null, p2: null, phase: 'p1', picking: false, res: null, sampler: null, notice: null, saved: false };
  let liveFn = null;
  const d = await readDraft(C, 'compass');
  if (!C.live()) return;
  if (d?.p1 && d?.p2 && num(d.p1.x) != null && num(d.p2.x) != null) { st.p1 = d.p1; st.p2 = d.p2; st.phase = 'aim'; }

  const onLive = throttle(() => { if (C.alive && liveFn) liveFn(); }, 250);
  C.onCleanup(C.positioning.on('pose', onLive));
  C.onCleanup(C.positioning.on('status', onLive));
  C.onCleanup(() => {
    const s = st.sampler;
    if (s) { s.done = true; clearInterval(s.tick); try { s.ac.abort(); } catch { /* done */ } }
  });
  installGuard(C, () => !!st.sampler || (!!st.res && !st.saved),
    'The compass correction you measured is not saved yet.');

  const keepWall = () => writeDraft(C, 'compass', { p1: st.p1, p2: st.p2 }).catch((err) => console.warn('[calibrate] compass draft', err));
  const wallPlan = () => planBearing(st.p1, st.p2);
  const wallTrue = () => planHeadingToTrue(C.level.calibration, wallPlan());
  const currentOffset = () => num(C.project.compassOffset) ?? num(C.app.getSettings?.()?.declination) ?? 0;

  function drawMarks() {
    const marks = [];
    const lines = [];
    if (st.p1) marks.push({ x: st.p1.x, y: st.p1.y, label: '1', color: colors.brand, kind: 'calib' });
    if (st.p2) marks.push({ x: st.p2.x, y: st.p2.y, label: '2', color: colors.brand, kind: 'calib' });
    if (st.p1 && st.p2) lines.push({ a: st.p1, b: st.p2, label: '1 → 2', color: colors.brand, dashed: false });
    try { view.setMarks?.(marks); view.setLines?.(lines); } catch (err) { console.warn('[calibrate] marks', err); }
  }

  function render() {
    if (!C.live()) return;
    liveFn = null;
    F.panel.classList.toggle('compact', st.picking);
    const step = { p1: 0, p2: 1, aim: 2, measuring: 2, done: 3 }[st.phase] ?? 0;
    F.setSub(`Step ${Math.min(step + 1, 4)} of 4`);
    drawMarks();
    const head = st.picking ? null : stepsRow(4, new Set([st.p1 ? 0 : -1, st.p2 ? 1 : -1, st.res ? 2 : -1]), step);
    F.panel.replaceChildren(...[head, ...PHASES[st.picking ? 'picking' : st.phase]()].filter(Boolean));
    F.panel.scrollTop = 0;
    liveFn?.();
  }

  const PHASES = {
    p1() {
      return [
        el('h2', { class: 'cal-h' }, 'Pick a straight wall you can stand next to'),
        el('p', {}, 'Mark where the wall starts. You will stand here and point the phone along the wall.'),
        actions(button('Mark point 1', { ic: 'crosshair', cls: 'btn btn-primary btn-lg btn-block', onclick: pickP1 })),
      ];
    },
    p2() {
      return [
        el('h2', { class: 'cal-h' }, 'Now mark where the wall goes'),
        el('p', {}, 'Mark a spot farther along the same wall — the farther, the better.'),
        actions(button('Mark point 2', { ic: 'crosshair', cls: 'btn btn-primary btn-lg btn-block', onclick: pickP2 })),
        actions(button('Move point 1', { cls: 'btn btn-ghost', onclick: pickP1 })),
      ];
    },
    picking() {
      return [el('p', { class: 'cal-picking' },
        el('span', { html: icon('crosshair', { size: 22 }) }),
        el('span', {}, 'Move the plan so the cross is on the wall, then tap Set.'))];
    },
    aim() {
      const dial = compassDial();
      const readout = el('p', { class: 'cal-live' });
      const problem = el('div', { class: 'cal-problem' });
      const set = button('Set direction', { ic: 'compass', cls: 'btn btn-primary btn-lg btn-block', onclick: measure });
      const wp = wallPlan();
      const wt = wallTrue();
      liveFn = () => {
        const pose = safePose(C);
        const pr = compassProblem(C);
        if (pr) problem.replaceChildren(banner(pr.level, pr.title, pr.text, pr.allow ? allowButton(C) : null)); else problem.replaceChildren();
        set.disabled = !!pr?.blocking;
        dial.set(wp, headingToPlan(C.level.calibration, pose?.heading));
        const h = num(pose?.heading);
        readout.textContent = h != null
          ? `Wall: ${fmtDeg(wt)} ${compassPoint(wt)} · Camera now: ${fmtDeg(h)} ${compassPoint(h)}${pose?.facing === 'top' ? ' — hold the phone upright, camera facing along the wall.' : ''}`
          : '';
        readout.hidden = !readout.textContent;
      };
      return [
        el('h2', { class: 'cal-h' }, 'Stand at point 1 and aim along the wall'),
        el('p', {}, 'Hold the phone upright, like taking a photo, and point the camera along the real wall from point 1 toward point 2. Keep it level and steady.'),
        dial.el,
        readout,
        problem,
        tip('Line the phone up with the real wall, not with the arrows on the screen — the screen is what this corrects. Stay a few feet away from steel, rebar and vehicles.'),
        st.notice ? banner(st.notice.level, '', st.notice.text) : null,
        actions(set),
        actions(button('Pick a different wall', { cls: 'btn btn-ghost', onclick: restartWall })),
      ];
    },
    measuring() {
      const s = st.sampler;
      const big = el('div', { class: 'cal-big' }, '—');
      const steady = el('p', { class: 'cal-live' }, 'Hold steady…');
      const fill = el('div', { class: 'cal-meter-fill' });
      s.els = { big, steady, fill };
      liveFn = () => paintHeading(s);
      return [
        el('h2', { class: 'cal-h' }, 'Hold steady, pointing along the wall…'),
        el('div', { class: 'small muted' }, 'Compass reads'),
        big,
        el('div', { class: 'cal-meter', role: 'progressbar', 'aria-label': 'Measuring' }, fill),
        steady,
        actions(button('Cancel', { cls: 'btn btn-outline', onclick: () => { s.cancelled = true; try { s.ac.abort(); } catch { /* done */ } } })),
      ];
    },
    done() {
      const r = st.res;
      const off = r.offset;
      const prev = num(C.project.compassOffset);
      const decl = num(C.app.getSettings?.()?.declination);
      const b4 = r.before || {};
      const kept = 'Photos already taken keep the direction they were saved with.';
      let beforeText;
      if (prev != null) beforeText = `Before: ${fmtOffset(prev)}${C.project.compassAlignedAt ? `, aligned ${formatDateTime(C.project.compassAlignedAt)}` : ''}. ${kept}`;
      else if (b4.source === 'wmm' && b4.value != null) beforeText = `Before: ${fmtOffset(b4.value)}, the usual magnetic declination for this place. ${kept}`;
      else if (decl != null) beforeText = `Before: the declination setting, ${fmtOffset(decl)}. ${kept}`;
      else beforeText = `Before: no correction. ${kept}`;
      const nodes = [
        el('h2', { class: 'cal-h' }, 'Compass correction'),
        el('div', { class: 'cal-big' }, fmtOffset(off)),
        el('p', {}, Math.abs(off) < 0.5
          ? 'The compass already matches the plan.'
          : `The compass read ${Math.round(Math.abs(off))}° ${off > 0 ? 'west' : 'east'} of the wall's real direction. Saving adds this correction to every camera direction from now on.`),
        el('p', { class: 'small muted' }, num(r.spread) != null
          ? (r.spread < 3 ? `Steady reading (±${Math.max(1, Math.round(r.spread))}°).` : `Readings varied by ±${Math.round(r.spread)}°.`)
          : ''),
        el('p', { class: 'small muted' }, beforeText),
      ];
      if (Math.abs(off) > 25) {
        nodes.push(banner('warn', 'That is a big correction', 'Steel, rebar, vehicles or a magnetic phone case can throw the compass off. Check you aimed from point 1 toward point 2, step a few feet away from steel, and measure again.'));
      }
      if (num(r.spread) != null && r.spread > 8) {
        nodes.push(banner('warn', 'The phone moved while measuring', 'Measure again holding the phone steady against your chest or a level.'));
      }
      nodes.push(actions(button('Save compass alignment', { ic: 'check', cls: 'btn btn-primary btn-lg btn-block', onclick: save })));
      nodes.push(actions(
        button('Measure again', { ic: 'compass', cls: 'btn btn-outline', onclick: measure }),
        button('Pick a different wall', { cls: 'btn btn-ghost', onclick: restartWall })));
      return nodes;
    },
  };

  async function pickP1() {
    if (st.picking) return;
    st.picking = true;
    render();
    const pt = await pickOnPlan(C, view, { title: 'Point 1: wall start', hint: 'Put the cross where the wall starts, then tap Set.', initial: st.p1 || undefined });
    if (!C.live()) return;
    st.picking = false;
    if (pt) { st.p1 = pt; st.res = null; st.phase = st.p2 ? 'aim' : 'p2'; keepWall(); }
    render();
  }

  async function pickP2() {
    if (st.picking) return;
    st.picking = true;
    render();
    const pt = await pickOnPlan(C, view, { title: 'Point 2: along the wall', hint: 'Put the cross farther along the same wall, then tap Set.', initial: st.p2 || undefined });
    if (!C.live()) return;
    st.picking = false;
    if (pt) {
      if (Math.hypot(pt.x - st.p1.x, pt.y - st.p1.y) < MIN_LINE_PX) {
        toast('The two points are on almost the same spot. Mark a spot farther along the wall.', { type: 'warn' });
      } else {
        st.p2 = pt;
        st.res = null;
        st.phase = 'aim';
        keepWall();
      }
    }
    render();
  }

  function restartWall() {
    if (st.sampler) return;
    st.p1 = null;
    st.p2 = null;
    st.res = null;
    st.notice = null;
    st.phase = 'p1';
    render();
  }

  function paintHeading(s) {
    const e = s.els;
    if (!e || s.done || !C.alive) return;
    const elapsed = (performance.now() - s.t0) / 1000;
    e.fill.style.width = `${Math.min(100, (elapsed / HEADING_SECONDS) * 100)}%`;
    const p = s.last;
    let h = num(p?.magnetic ?? p?.heading ?? p?.mean);
    if (h == null) {
      const pose = safePose(C);
      h = num(pose?.magHeading);
      const t = num(pose?.heading);
      if (h == null && t != null) h = ((t - currentOffset()) % 360 + 360) % 360;
    }
    e.big.textContent = h != null ? `${fmtDeg(h)} ${compassPoint(h)}` : '—';
    const spread = num(p?.spread);
    e.steady.textContent = spread == null ? 'Hold steady…' : spread < 3 ? 'Steady — keep holding.' : spread < 8 ? 'A little shaky — hold still.' : 'Too shaky — hold the phone still.';
  }

  async function measure() {
    if (st.sampler) return;
    if (typeof C.positioning?.sampleHeading !== 'function') {
      toast('The compass is not ready on this phone yet. Reload the app and try again.', { type: 'err' });
      return;
    }
    const pr = compassProblem(C);
    if (pr?.blocking) { toast(pr.title, { type: 'err' }); return; }
    const s = { ac: new AbortController(), t0: performance.now(), done: false, cancelled: false, last: null, tick: 0, els: null };
    st.sampler = s;
    st.notice = null;
    st.phase = 'measuring';
    render();
    s.tick = setInterval(() => paintHeading(s), 200);
    let res = null, error = null;
    try {
      res = await C.positioning.sampleHeading({ seconds: HEADING_SECONDS, signal: s.ac.signal, onProgress: (p) => { s.last = p; } });
    } catch (err) {
      error = err;
    }
    clearInterval(s.tick);
    if (s.done) return;
    s.done = true;
    st.sampler = null;
    if (!C.live()) return;
    if (s.cancelled) {
      st.phase = 'aim';
      st.notice = { level: 'info', text: 'Stopped. Aim along the wall and tap Set direction when you are ready.' };
      render();
      return;
    }
    const magnetic = num(res?.magnetic);
    if (error || magnetic == null) {
      st.phase = 'aim';
      st.notice = { level: 'err', text: headingErrorText(error) };
      render();
      return;
    }
    const wt = wallTrue();
    // true = magnetic + offset, so the offset that makes the wall read true:
    st.res = {
      magnetic, spread: num(res.spread), wallTrue: wt, offset: deltaDeg(magnetic, wt), at: Date.now(),
      before: { value: num(res.declination), source: res.headingSource || null },
    };
    st.phase = 'done';
    buzz(30);
    render();
  }

  async function save() {
    const r = st.res;
    if (!r) return;
    const b = busy('Saving the compass alignment…');
    try {
      await C.store.updateProject(C.pid, { compassOffset: r.offset, compassAlignedAt: Date.now() });
    } catch (err) {
      b.done();
      toast(`The compass alignment was not saved. ${err.message}`, { type: 'err' });
      return;
    }
    b.done();
    st.saved = true;
    try { await writeDraft(C, 'compass', null); } catch { /* harmless */ }
    toast('Compass aligned. Camera directions now match the plan.', { type: 'ok' });
    finish(C);
  }

  render();
}
