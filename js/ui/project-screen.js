// project-screen.js — a job walk (#/p/:pid): the plan (or the map), where
// you are, and everything captured on it.
//
// The screen an estimator lives in during a walk, so it is built for one
// hand in bright sun: the plan fills the screen, the big red button takes a
// photo, and everything else is one tap away.
//
//  - The view: the level's floor plan (plan-view.js) or, while a level has
//    no plan, the satellite map (map-view.js). The plan image is decoded once
//    and kept in app.cache under 'plan:<mediaId>' ({image, width, height}),
//    so coming back from the camera is instant; the zoom/pan of each level is
//    kept in app.cache too ('view:<pid>:<lid>').
//  - Where you are: positioning 'pose' events move the blue dot and cone; the
//    chip (top left) shows the accuracy and opens the details, "I'm here",
//    and on iPhone the compass permission (it must be asked from a tap).
//  - What needs doing: banners for an uncalibrated plan, a level with no plan,
//    location turned off, and changes not backed up.
//  - Notes: the Note button drops one at your position; a long-press on the
//    plan drops one exactly there. Both are saved (and awaited) before the
//    note opens for typing.
//
// Other workstreams' modules (views, capture, calibration, geo) are loaded
// with import() so a problem in one shows a message here instead of a blank
// screen. Nothing on this screen erases anything: Delete job walk moves it to
// Recently Deleted, and replacing a plan keeps the old one.

import { el, iconButton, toast, confirmDialog, alertDialog, promptDialog, formDialog, choose, openSheet, busy, pickFiles } from './shell.js';
import { icon } from './icons.js';
import { choosePlanAndSave } from './plan-import-dialog.js';
import { openItemsPanel, itemLabel, itemIconName, itemThumbId, noteExcerpt } from './items-panel.js';
import { decodeImage } from '../core/plan-import.js';
import { backupState } from '../core/store.js';
import {
  formatAccuracy, formatLength, formatDateTime, formatDate, formatDuration, compassPoint, normDeg,
  debounce, throttle, buzz, isIOS,
} from '../core/util.js';

// ---- pure helpers (tested) --------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;


/**
 * Whether to remind about a backup: changes are not backed up and either
 * there are 25 or more, or the last backup (or the job walk's start) is more
 * than a day ago. Never for an empty job walk, never when turned off.
 */
export function shouldRemindBackup(project, settings = {}, { now = Date.now(), itemCount = 1 } = {}) {
  if (!project || settings.backupReminder === false || !itemCount) return false;
  const st = backupState(project);
  if (!st.needed) return false;
  if (st.changesSince >= 25) return true;
  const since = st.lastAt || project.createdAt || now;
  return now - since > DAY;
}

/** The position chip: {cls: 'good'|'fair'|'poor'|'', text}. */
export function chipInfo(pose, status = {}, units = 'imperial') {
  const gps = status?.gps;
  if (gps === 'denied') return { cls: 'poor', text: 'Location off' };
  if (gps === 'unavailable') return { cls: '', text: 'No GPS' };
  const has = pose && pose.source !== 'none' && (pose.geo || pose.plan || pose.enu);
  if (!has) return { cls: '', text: gps === 'error' ? 'GPS problem' : gps === 'off' ? 'GPS off' : 'Finding you…' };
  const acc = pose.geo?.acc ?? status?.acc;
  let text = acc != null && Number.isFinite(acc) ? formatAccuracy(acc, units) : pose.source === 'manual' ? 'Set by you' : 'Position';
  if (pose.source === 'sim') text = `Demo ${text}`;
  if (pose.heading != null && Number.isFinite(pose.heading)) text += ` · ${compassPoint(pose.heading)}`;
  return { cls: ['good', 'fair', 'poor'].includes(pose.quality) ? pose.quality : '', text };
}

/**
 * The banners to show over the view, most important first, at most two.
 * mode: 'plan' | 'map'. dismissed: ids hidden for this session.
 * → [{id, cls, icon, text, action: {id, label}}]
 */
export function bannersFor({ project, level, status = {}, settings = {}, now = Date.now(), dismissed = new Set(), mode = 'plan', itemCount = 0 } = {}) {
  const out = [];
  if (status?.gps === 'denied') {
    out.push({ id: 'gps-denied', cls: 'err', icon: 'warning', text: 'Location is off for this app, so photos get no position.', action: { id: 'gps-help', label: 'How to fix' } });
  } else if (status?.gps === 'unavailable') {
    out.push({ id: 'gps-none', cls: 'warn', icon: 'warning', text: 'This device cannot give a location. Place items by hand (long-press the plan).', action: null });
  }
  if (mode === 'plan' && level?.plan && !level.calibration) {
    out.push({ id: 'calibrate', cls: '', icon: 'target', text: 'Calibrate this plan to place photos automatically', action: { id: 'calibrate', label: 'Calibrate' } });
  }
  if (mode === 'map') {
    out.push({ id: 'no-plan', cls: '', icon: 'plan', text: 'No floor plan yet. Photos are placed on the map by GPS.', action: { id: 'add-plan', label: 'Add plan' } });
  }
  if (shouldRemindBackup(project, settings, { now, itemCount })) {
    const n = backupState(project).changesSince;
    out.push({ id: 'backup', cls: 'warn', icon: 'archive', text: `${n} change${n === 1 ? '' : 's'} not backed up`, action: { id: 'backup', label: 'Back up' } });
  }
  return out.filter((b) => !dismissed.has(b.id)).slice(0, 2);
}

/**
 * Where the map opens: the last map position, else the latest GPS fix, else
 * the job walk's origin. When none is known: center null (map-view then
 * shows the country and centres itself on the first position or item) and,
 * when the job walk has an address, look it up once.
 * → {center: {lat, lng} | null, zoom | null, geocode}
 */
export function mapStart(project, pose) {
  const mv = project?.mapView;
  if (mv && Number.isFinite(mv.lat) && Number.isFinite(mv.lng)) return { center: { lat: mv.lat, lng: mv.lng }, zoom: Number.isFinite(mv.zoom) ? mv.zoom : 19, geocode: false };
  const g = pose?.geo;
  if (g && Number.isFinite(g.lat) && Number.isFinite(g.lng)) return { center: { lat: g.lat, lng: g.lng }, zoom: 19, geocode: false };
  const o = project?.origin;
  if (o && Number.isFinite(o.lat) && Number.isFinite(o.lng)) return { center: { lat: o.lat, lng: o.lng }, zoom: 19, geocode: false };
  return { center: null, zoom: null, geocode: !!String(project?.address || '').trim() };
}

function basePose(now) {
  return {
    t: now, geo: null, enu: null, plan: null, planAcc: null, planLocked: false,
    heading: null, headingAcc: null, planHeading: null, pitch: null, roll: null,
    facing: 'camera', source: 'manual', quality: 'good',
  };
}

/**
 * The pose of a note dropped by hand at plan point `pt`: locked to that
 * spot, with ground coordinates too when the plan is calibrated (so the
 * export and the map know where it is). planToEnu/fromEnu come from
 * calibration.js / geo.js; without them only the plan point is kept.
 */
export function notePoseAtPlan(pt, { level, project, planToEnu, fromEnu, now = Date.now() } = {}) {
  const pose = basePose(now);
  pose.plan = { x: pt.x, y: pt.y };
  pose.planLocked = true;
  if (level?.calibration && typeof planToEnu === 'function') {
    try {
      const enu = planToEnu(level.calibration, pose.plan);
      if (enu && Number.isFinite(enu.e) && Number.isFinite(enu.n)) {
        pose.enu = { e: enu.e, n: enu.n };
        if (project?.origin && typeof fromEnu === 'function') {
          const g = fromEnu(project.origin, enu.e, enu.n);
          if (g && Number.isFinite(g.lat) && Number.isFinite(g.lng)) pose.geo = { lat: g.lat, lng: g.lng, acc: null, alt: null, altAcc: null };
        }
      }
    } catch { /* keep the plan point only */ }
  }
  return pose;
}

/**
 * The pose of a note dropped by hand on the map at `ll`. Not plan-locked:
 * when a plan is added and calibrated later, it is placed from its ground
 * position like a photo.
 */
export function notePoseAtGeo(ll, { project, toEnu, now = Date.now() } = {}) {
  const pose = basePose(now);
  pose.geo = { lat: ll.lat, lng: ll.lng, acc: null, alt: null, altAcc: null };
  if (project?.origin && typeof toEnu === 'function') {
    try {
      const enu = toEnu(project.origin, ll.lat, ll.lng);
      if (enu && Number.isFinite(enu.e) && Number.isFinite(enu.n)) pose.enu = { e: enu.e, n: enu.n };
    } catch { /* geo only */ }
  }
  return pose;
}

/** The map position {lat, lng, zoom} from whatever map-view's getView() returns, or null. */
export function mapViewOf(v) {
  if (!v) return null;
  const lat = v.lat ?? v.center?.lat;
  const lng = v.lng ?? v.center?.lng;
  const zoom = v.zoom ?? v.z;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, zoom: Number.isFinite(zoom) ? zoom : 19 };
}

// ---- small helpers -------------------------------------------------------------------------

/** Listen on an emitter; returns the function that stops listening, whatever on() returns. */
function listen(em, type, fn) {
  const r = em?.on?.(type, fn);
  return typeof r === 'function' ? r : () => em?.off?.(type, fn);
}

const copyPose = (p) => (p ? JSON.parse(JSON.stringify(p)) : null);

// Decoded plan images live in app.cache under 'plan:<mediaId>' as the
// drawable itself (ImageBitmap | <img> | <canvas>) — the format the item and
// camera screens share. Only the two most recently used plans stay cached, so
// switching levels on a phone stays within memory; older ones are dropped
// from the cache (not closed: another screen may still hold one).
const PLAN_CACHE_KEEP = 2;
const inflight = new Map();
const planUsed = new Map();   // cache key → last used (ms)

function drawable(x) {
  if (!x || typeof x !== 'object') return null;
  const img = x.image && typeof x.image === 'object' ? x.image : x;   // tolerate {image} entries
  const w = img.naturalWidth || img.width || 0;
  return w > 0 && (typeof img.close === 'function' || 'naturalWidth' in img || typeof img.getContext === 'function') ? img : null;
}

async function planImage(cache, store, plan) {
  const key = `plan:${plan.mediaId}`;
  const hit = drawable(cache.get(key)) || drawable(cache.get(plan.mediaId));
  if (hit) { planUsed.set(key, Date.now()); return hit; }
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    const blob = await store.getMediaBlob(plan.mediaId);
    if (!blob) throw new Error('The plan image is missing on this device. Add the plan again from Levels & plans (your photos are not affected).');
    let image;
    try {
      image = await decodeImage(blob);
    } catch {
      throw new Error('This plan is too large for this device to show. Replace it with a smaller copy or a crop (Levels & plans). Your photos are not affected.');
    }
    cache.set(key, image);
    planUsed.set(key, Date.now());
    const keys = [...cache.keys()].filter((k) => typeof k === 'string' && k.startsWith('plan:'))
      .sort((a, b) => (planUsed.get(b) || 0) - (planUsed.get(a) || 0));
    for (const k of keys.slice(PLAN_CACHE_KEEP)) { cache.delete(k); planUsed.delete(k); }
    return image;
  })();
  inflight.set(key, job);
  try { return await job; } finally { inflight.delete(key); }
}

const GPS_STATUS = {
  off: 'Off', waiting: 'Waiting for the first fix…', ok: 'On', denied: 'Not allowed for this app',
  unavailable: 'Not available on this device', error: 'Problem',
};
const SENSOR_STATUS = {
  off: 'Off', ok: 'On', 'needs-permission': 'Needs your permission', denied: 'Not allowed',
  unavailable: 'Not available on this device', uncalibrated: 'Needs calibrating (wave the phone in a figure 8)',
};
const SOURCE = {
  fused: 'GPS + step counting', gps: 'GPS', manual: 'Set by you ("I\'m here")', sim: 'Demo mode (made up)', none: 'No position yet',
};

function gpsHelp() {
  if (isIOS()) {
    return 'On iPhone: open Settings → Privacy & Security → Location Services. Turn Location Services on, tap Safari Websites, choose "While Using the App" and turn on Precise Location. Then come back and reload the page.';
  }
  if (/Android/i.test(navigator.userAgent || '')) {
    return 'On Android: turn on Location in the quick settings. Then tap the icon left of the web address (or, for the installed app, long-press its icon → App info → Permissions) → Location → Allow, and use Precise. Reload the page afterwards.';
  }
  return 'Click the icon left of the web address, allow Location for this site, and reload the page.';
}

// ---- the screen ------------------------------------------------------------------------------

/** Open a job walk. */
export async function open(ctx) {
  const { root, params, app } = ctx;
  const { store, positioning, bus } = app;
  const pid = params.pid;
  const scope = store.createUrlScope();
  const offs = [];
  const leaving = new AbortController();   // closes the plan dialog if the person leaves mid-way
  let closed = false;

  let project = await store.getProject(pid);
  if (!project) {
    root.append(notFound());
    return () => scope.release();
  }
  if (project.deletedAt) {
    root.append(inTrash(project));
    return () => scope.release();
  }

  function notFound() {
    return el('div', { class: 'error-screen' },
      el('h1', {}, 'Not found'),
      el('p', {}, 'That job walk is not on this device.'),
      el('button', { type: 'button', class: 'btn btn-primary', onclick: () => ctx.navigate('', { replace: true }) }, 'Go to job walks'));
  }

  function inTrash(p) {
    return el('div', { class: 'error-screen' },
      el('h1', {}, 'In Recently Deleted'),
      el('p', {}, `"${p.name}" was deleted ${formatDateTime(p.deletedAt)}. Everything in it is still on this device.`),
      el('div', { class: 'col' },
        el('button', {
          type: 'button', class: 'btn btn-primary', onclick: async () => {
            try { await store.restoreProject(p.id); ctx.navigate(`p/${p.id}`, { replace: true }); } catch (err) { toast(`Not restored: ${err.message}`, { type: 'err' }); }
          },
        }, 'Restore it'),
        el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => ctx.navigate('', { replace: true }) }, 'Go to job walks')));
  }

  const activeLevel = () => store.activeLevel(project);
  const S = () => app.getSettings();

  // ---- state ----
  let items = [];                       // every (not deleted) item of the job walk
  let view = null;
  let viewMode = null;                  // 'plan' | 'map'
  let viewKey = '';
  let buildToken = 0;
  let selectedId = null;
  let lastPose = positioning.getPose?.() || null;
  let status = positioning.getStatus?.() || {};
  let picking = false;
  let noteBusy = false;
  let posSheet = null;                  // {sh, render}
  let levelsSheet = null;               // {sh, render}
  let panel = null;                     // items panel {close}
  const dismissedKey = `dismissed:${pid}`;
  const dismissed = app.cache.get(dismissedKey) instanceof Set ? app.cache.get(dismissedKey) : new Set();
  app.cache.set(dismissedKey, dismissed);

  // ---- layout ----
  const titleH1 = el('h1');
  const titleSub = el('div', { class: 'sub' });
  const levelBtn = el('button', { type: 'button', class: 'chip pj-level-chip', 'aria-haspopup': 'true', onclick: chooseLevel });
  const topbar = el('header', { class: 'topbar pj-topbar' },
    iconButton('back', { title: 'Job walks', onclick: () => ctx.back('') }),
    el('div', { class: 'topbar-title' }, titleH1, titleSub),
    levelBtn,
    iconButton('more', { title: 'Menu', onclick: openMenu }));

  const viewHost = el('div', { class: 'pj-view' });
  const loading = el('div', { class: 'pj-loading', hidden: true });
  const chipText = el('span', { class: 'pj-chip-text' }, 'Finding you…');
  const chip = el('button', { type: 'button', class: 'pos-chip pj-chip', 'aria-label': 'Your position: details', onclick: openPositionSheet },
    el('span', { class: 'dot' }), chipText);
  const compassBtn = el('button', { type: 'button', class: 'btn btn-sm btn-accent pj-compass-btn', hidden: true, onclick: enableSensors },
    el('span', { html: icon('compass', { size: 18 }) }), 'Enable compass');
  const bannersHost = el('div', { class: 'pj-banners' });
  const followBtn = el('button', { type: 'button', class: 'fab pj-fab', title: 'Follow me', 'aria-label': 'Follow me', 'aria-pressed': 'false', onclick: toggleFollow, html: icon('navigation', { size: 22 }) });
  const fitBtn = el('button', { type: 'button', class: 'fab pj-fab', title: 'Show everything', 'aria-label': 'Show everything', onclick: () => view?.fit?.(), html: icon('fit', { size: 22 }) });
  const hereBtn = el('button', { type: 'button', class: 'fab pj-fab pj-here', title: 'I\'m here', 'aria-label': 'I\'m here: set your position', onclick: () => imHere() },
    el('span', { html: icon('here', { size: 22 }) }), el('span', { class: 'pj-here-label' }, 'I\'m here'));
  const previewHost = el('div', { class: 'pj-preview', hidden: true });
  const overlay = el('div', { class: 'pj-overlay' },
    el('div', { class: 'pj-tl' }, chip, compassBtn),
    bannersHost,
    el('div', { class: 'pj-fabs' }, followBtn, fitBtn, hereBtn),
    previewHost);
  const stage = el('div', { class: 'pj-stage' }, viewHost, loading, overlay);

  const itemsCount = el('span', { class: 'pj-count', hidden: true });
  const barBtn = (ic, label, onclick, extra = null) => el('button', { type: 'button', class: 'bar-btn', onclick },
    el('span', { class: 'pj-bar-ic', html: icon(ic, { size: 24 }) }, extra), el('span', {}, label));
  const bottombar = el('nav', { class: 'bottombar pj-bottombar', 'aria-label': 'Capture' },
    barBtn('grid', 'Items', openItems, itemsCount),
    barBtn('note', 'Note', noteHere),
    el('button', {
      type: 'button', class: 'capture-btn pj-shutter', 'aria-label': 'Take a photo', title: 'Take a photo',
      onclick: () => { if (!picking) ctx.navigate(`p/${pid}/camera?mode=photo`); }, html: icon('camera', { size: 30 }),
    }),
    barBtn('video', 'Video', () => { if (!picking) ctx.navigate(`p/${pid}/camera?mode=video`); }),
    barBtn('more', 'More', openMenu));

  root.classList.add('pj-screen');
  root.append(topbar, stage, bottombar);

  // ---- title, level chip, chip, banners ----
  function renderTitle() {
    titleH1.textContent = project.name || 'Job walk';
    titleSub.textContent = project.address || (project.walkDate ? formatDate(project.walkDate) : '');
    const l = activeLevel();
    levelBtn.replaceChildren(el('span', { class: 'pj-level-name' }, l?.name || 'Level'), el('span', { class: 'pj-caret', 'aria-hidden': 'true' }, '▾'));
    levelBtn.setAttribute('aria-label', `Level: ${l?.name || ''}. Change level`);
  }

  function renderChip() {
    if (closed) return;
    const info = chipInfo(lastPose, status, S().units);
    chip.className = `pos-chip pj-chip ${info.cls}`;
    chipText.textContent = info.text;
  }
  const chipSoon = throttle(renderChip, 250);

  function renderCompassBtn() {
    let need = false;
    try { need = !!positioning.needsPermission?.(); } catch { need = false; }
    compassBtn.hidden = !need;
  }

  function renderBanners() {
    if (closed) return;
    const list = bannersFor({
      project, level: activeLevel(), status, settings: S(), now: Date.now(), dismissed, mode: viewMode || (activeLevel()?.plan ? 'plan' : 'map'), itemCount: items.length,
    });
    bannersHost.replaceChildren(...list.map((b) => el('div', { class: `banner ${b.cls} pj-banner`, role: b.cls === 'err' ? 'alert' : 'status' },
      el('span', { class: 'pj-banner-ic', html: icon(b.icon, { size: 20 }) }),
      el('span', { class: 'pj-banner-text' }, b.text),
      b.action ? el('button', { type: 'button', class: 'btn btn-sm btn-accent pj-banner-btn', onclick: () => bannerAction(b.action.id) }, b.action.label) : null,
      iconButton('close', { title: 'Hide', cls: 'icon-btn pj-banner-x', size: 18, onclick: () => { dismissed.add(b.id); renderBanners(); } }))));
  }

  function bannerAction(id) {
    if (id === 'calibrate') chooseCalibration(activeLevel());
    else if (id === 'add-plan') addPlan(activeLevel());
    else if (id === 'backup') ctx.navigate(`p/${pid}/export`);
    else if (id === 'gps-help') alertDialog({ title: 'Turn on location', message: gpsHelp() });
  }

  function renderItemsCount() {
    itemsCount.hidden = !items.length;
    itemsCount.textContent = items.length > 999 ? '999+' : String(items.length);
  }

  // ---- the view ----
  const levelItems = () => {
    const lid = activeLevel()?.id;
    return items.filter((i) => i.levelId === lid);
  };

  function showLoading(text) {
    loading.replaceChildren(el('div', { class: 'spinner' }), el('div', {}, text));
    loading.hidden = false;
  }

  function hideLoading() { loading.hidden = true; }

  function showViewError(err) {
    loading.replaceChildren(el('div', { class: 'pj-view-err' },
      el('span', { html: icon('warning', { size: 30 }) }),
      el('p', {}, err?.message || String(err)),
      el('p', { class: 'small muted' }, 'Your photos and notes are safe on this device.'),
      el('div', { class: 'row' },
        el('button', { type: 'button', class: 'btn btn-primary', onclick: () => buildView(true) }, 'Try again'),
        el('button', { type: 'button', class: 'btn btn-outline', onclick: openLevelsSheet }, 'Levels & plans'))));
    loading.hidden = false;
  }

  const stateKey = (lid) => `view:${pid}:${lid}`;

  function saveViewState() {
    if (!view || !viewKey) return;
    const lid = viewKey.split('|')[1];
    try { app.cache.set(stateKey(lid), { key: viewKey, view: view.getView?.(), follow: !!view.isFollowing?.() }); } catch { /* view gone */ }
  }

  function destroyView() {
    if (!view) return;
    const v = view;
    view = null;
    try { v.destroy?.(); } catch (err) { console.warn('[project] view destroy', err); }
  }

  // The view is rebuilt only when what it shows changes: another level or a
  // new plan image. The map follows the map provider setting by itself, and
  // the plan view takes units and scale changes in place.
  function keyFor(level) {
    return level?.plan ? `plan|${level.id}|${level.plan.mediaId}` : `map|${level?.id}|${S().units}`;
  }

  function refreshViewSettings() {
    if (!view || viewMode !== 'plan') return;
    try {
      view.setUnits?.(S().units);
      view.setPxPerMeter?.(activeLevel()?.calibration?.pxPerMeter || null);
    } catch { /* optional methods */ }
  }

  async function buildView(force = false) {
    if (closed) return;
    const level = activeLevel();
    const key = keyFor(level);
    if (!force && key === viewKey && view) return;
    const t = ++buildToken;
    saveViewState();
    destroyView();
    hidePreview();
    viewKey = key;
    viewMode = level?.plan ? 'plan' : 'map';
    stage.dataset.mode = viewMode;
    const host = el('div', { class: 'pj-view-inner' });
    viewHost.replaceChildren(host);
    renderBanners();
    showLoading(viewMode === 'plan' ? 'Opening the plan…' : 'Opening the map…');
    try {
      let v;
      const s = S();
      if (viewMode === 'plan') {
        const img = await planImage(app.cache, store, level.plan);
        if (t !== buildToken || closed) return;
        const { createPlanView } = await import('./plan-view.js');
        if (t !== buildToken || closed) return;
        v = await createPlanView(host, {
          image: img,
          width: level.plan.width || img.naturalWidth || img.width,
          height: level.plan.height || img.naturalHeight || img.height,
          interactive: true,
          units: s.units,
          pxPerMeter: level.calibration?.pxPerMeter || null,
        });
      } else {
        const { createMapView } = await import('./map-view.js');
        if (t !== buildToken || closed) return;
        const start = mapStart(project, lastPose);
        // No provider/keys passed: the map then follows Settings by itself.
        // No centre when nothing is known: the map centres on the first position or item.
        v = await createMapView(host, {
          center: start.center || undefined, zoom: start.zoom ?? undefined, units: s.units, scaleBar: true, layerSwitch: true,
        });
        if (start.geocode && t === buildToken && !closed) geocodeAddress(v, t);
      }
      if (t !== buildToken || closed) { try { v?.destroy?.(); } catch { /* fine */ } return; }
      view = v;
      wireView(v);
      // Back from the camera or an item: the same zoom and place as before
      // (not after a plan was replaced — its pixels are different).
      const prev = app.cache.get(stateKey(level.id));
      const saved = prev?.key === key ? prev : null;
      if (saved?.view) { try { v.setView?.(saved.view); } catch { /* a different shape: ignore */ } }
      const follow = saved ? saved.follow : viewMode === 'plan' ? !!level.calibration : !project.mapView;
      try { v.setFollow?.(follow); } catch { /* fine */ }
      setFollowUi(!!v.isFollowing?.());
      v.setItems(levelItems(), { selectedId });
      v.setPose(lastPose);
      hideLoading();
      focusFromQuery();
    } catch (err) {
      if (t !== buildToken || closed) return;
      console.error('[project] the view could not open', err);
      showViewError(err);
    }
  }

  function wireView(v) {
    v.on?.('tapitem', (item) => { if (!picking && item) showPreview(item); });
    v.on?.('tap', () => { if (!picking) hidePreview(); });
    v.on?.('longpress', (pt) => { if (!picking && pt) onLongPress(pt); });
    v.on?.('viewchange', () => persistMapSoon());
    v.on?.('followchange', (on) => setFollowUi(on));
  }

  function persistMapView() {
    if (closed || viewMode !== 'map' || !view) return;
    let mv = null;
    try { mv = mapViewOf(view.getView?.()); } catch { mv = null; }
    if (!mv) return;
    const cur = project.mapView;
    if (cur && Math.abs(cur.lat - mv.lat) < 1e-7 && Math.abs(cur.lng - mv.lng) < 1e-7 && cur.zoom === mv.zoom) return;
    project.mapView = mv;
    // Quiet: where the map was is not a change worth a backup.
    store.updateProject(pid, { mapView: mv }, { quiet: true }).catch((e) => console.warn('[project] map position not kept', e));
  }
  const persistMapSoon = debounce(persistMapView, 1500);

  async function geocodeAddress(v, t) {
    if (typeof v.searchAddress !== 'function') return;
    try {
      const results = await v.searchAddress(project.address);
      if (t !== buildToken || closed || view !== v || !results?.length) return;
      // A GPS fix that arrived meanwhile is better than the address.
      if (lastPose?.geo && v.isFollowing?.()) return;
      v.centerOn?.({ lat: results[0].lat, lng: results[0].lng }, 18);
      persistMapView();
    } catch (err) {
      console.warn('[project] address lookup', err);
    }
  }

  // #/p/<pid>?focus=<itemId> (e.g. from an item's mini plan): show that item,
  // on its own level, centred, with its preview card open. Once per visit.
  let focusDone = false;
  function focusFromQuery() {
    const iid = ctx.query?.focus || ctx.query?.item;
    if (focusDone || !iid || !view) return;
    const item = items.find((i) => i.id === iid);
    if (!item) { focusDone = true; return; }
    if (item.levelId !== activeLevel()?.id) {
      // The view is rebuilt for that level, and this runs again from there.
      if (project.levels.some((l) => l.id === item.levelId)) switchLevel(item.levelId);
      else focusDone = true;
      return;
    }
    focusDone = true;
    const pt = viewMode === 'plan' ? item.pose?.plan : item.pose?.geo ? { lat: item.pose.geo.lat, lng: item.pose.geo.lng } : null;
    try { view.setFollow?.(false); setFollowUi(false); if (pt) view.centerOn?.(pt); } catch { /* fine */ }
    showPreview(item);
  }

  function setFollowUi(on) {
    followBtn.classList.toggle('on', !!on);
    followBtn.setAttribute('aria-pressed', String(!!on));
  }

  function toggleFollow() {
    if (!view) return;
    const on = !view.isFollowing?.();
    view.setFollow?.(on);
    setFollowUi(on);
    if (on && !(viewMode === 'plan' ? lastPose?.plan : lastPose?.geo)) {
      toast(viewMode === 'plan' && !activeLevel()?.calibration ? 'Your position shows on the plan once the plan is calibrated.' : 'Waiting for your position…', { type: 'info' });
    }
  }

  // ---- preview card ----
  function showPreview(item) {
    selectedId = item.id;
    try { view?.setItems(levelItems(), { selectedId }); } catch { /* fine */ }
    const tid = itemThumbId(item);
    const ph = el('span', { class: 'pj-prev-ph', html: icon(itemIconName(item), { size: 26 }) });
    const thumb = el('span', { class: 'pj-prev-thumb' }, ph);
    if (tid) {
      scope.url(tid).then((u) => {
        if (!u || closed || selectedId !== item.id) return;
        const img = el('img', { alt: '', src: u, decoding: 'async' });
        img.addEventListener('load', () => ph.remove(), { once: true });
        thumb.append(img);
      }).catch(() => { /* icon stays */ });
    }
    const tags = item.tags || [];
    const excerpt = noteExcerpt(item, 100);
    previewHost.replaceChildren(
      el('button', { type: 'button', class: 'pj-prev-main', onclick: () => openItem(item), 'aria-label': `Open ${itemLabel(item)}` },
        thumb,
        el('span', { class: 'pj-prev-info' },
          el('span', { class: 'pj-prev-title' }, el('span', { html: icon(itemIconName(item), { size: 16 }) }), itemLabel(item),
            item.type === 'video' && item.duration ? el('span', { class: 'muted' }, ` · ${formatDuration(item.duration)}`) : null),
          tags.length ? el('span', { class: 'pj-prev-tags' }, tags.slice(0, 3).map((t) => el('span', { class: 'badge' }, t)), tags.length > 3 ? el('span', { class: 'badge' }, `+${tags.length - 3}`) : null) : null,
          excerpt ? el('span', { class: 'pj-prev-text' }, excerpt) : null,
          el('span', { class: 'pj-prev-time' }, [formatDateTime(item.createdAt), item.capturedBy].filter(Boolean).join(' · ')))),
      el('span', { class: 'pj-prev-side' },
        iconButton('close', { title: 'Close', size: 20, onclick: hidePreview }),
        el('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => openItem(item) }, 'Open')));
    previewHost.hidden = false;
    stage.classList.add('has-preview');
  }

  function hidePreview() {
    if (!selectedId && previewHost.hidden) return;
    selectedId = null;
    previewHost.hidden = true;
    previewHost.replaceChildren();
    stage.classList.remove('has-preview');
    try { view?.setItems(levelItems(), { selectedId: null }); } catch { /* fine */ }
  }

  function openItem(item) {
    ctx.navigate(`p/${pid}/i/${item.id}`);
  }

  // ---- items ----
  async function loadItems() {
    try {
      items = await store.listItems(pid);
    } catch (err) {
      toast(`The photos and notes could not be read: ${err.message}`, { type: 'err' });
      return;
    }
    if (closed) return;
    renderItemsCount();
    try { view?.setItems(levelItems(), { selectedId }); } catch (err) { console.warn('[project] setItems', err); }
    if (selectedId) {
      const cur = items.find((i) => i.id === selectedId);
      if (cur) showPreview(cur); else hidePreview();
    }
  }

  function openItems() {
    if (picking) return;
    panel = openItemsPanel({
      project, items, units: S().units,
      onOpen: (item) => { panel = null; openItem(item); },
    });
  }

  // ---- position ----
  function openPositionSheet() {
    if (posSheet) return;
    const sh = openSheet({ title: 'Your position', cls: 'pj-pos-sheet', onClose: () => { posSheet = null; } });
    const grid = el('dl', { class: 'pj-pos-grid' });
    const extra = el('div', { class: 'pj-pos-extra' });
    const btns = el('div', { class: 'pj-pos-btns' });
    sh.body.append(grid, extra, btns);
    const row = (k, v, cls = '') => [el('dt', {}, k), el('dd', { class: cls }, v)];

    function render() {
      if (closed) return;
      const pose = lastPose || {};
      const units = S().units;
      const level = activeLevel();
      const cal = level?.calibration;
      const gps = status.gps || 'off';
      const rows = [];
      rows.push(row('GPS', [GPS_STATUS[gps] || gps, status.message ? ` — ${status.message}` : ''].join('')));
      const acc = pose.geo?.acc ?? status.acc;
      rows.push(row('Accuracy', acc != null ? `${formatAccuracy(acc, units)}${pose.quality && pose.quality !== 'none' ? ` (${pose.quality})` : ''}` : '—', pose.quality || ''));
      rows.push(row('Source', SOURCE[pose.source] || SOURCE.none));
      if (pose.heading != null) {
        rows.push(row('Heading', `${compassPoint(pose.heading)} ${Math.round(normDeg(pose.heading))}°${pose.facing === 'top' ? ' (top of the phone — it is lying flat)' : ' (camera)'}`));
      } else {
        rows.push(row('Heading', `— (compass ${String(SENSOR_STATUS[status.compass] || status.compass || 'off').toLowerCase()})`));
      }
      if (pose.pitch != null) {
        const p = Math.round(pose.pitch);
        rows.push(row('Tilt', `${Math.abs(p)}° ${p > 2 ? 'up' : p < -2 ? 'down' : '(level)'}`));
      }
      let align;
      if (project.compassOffset != null) align = `Aligned to the plan${project.compassAlignedAt ? ` on ${formatDate(project.compassAlignedAt)}` : ''}`;
      else if (S().declination != null) align = `Not aligned; using declination ${S().declination}°`;
      else align = 'Not aligned: directions may be off by 10–15°';
      rows.push(row('Compass', `${SENSOR_STATUS[status.compass] || status.compass || '—'} · ${align}`));
      const steps = status.steps ?? pose.steps;
      rows.push(row('Steps', steps != null ? `${steps} counted` : (SENSOR_STATUS[status.motion] || status.motion || '—')));
      if (viewMode === 'plan') {
        rows.push(row('On the plan', !cal
          ? 'Not calibrated: your dot shows once the plan is calibrated'
          : pose.plan ? (pose.planAcc != null && cal.pxPerMeter ? formatAccuracy(pose.planAcc / cal.pxPerMeter, units) : 'Shown') : 'Not yet'));
      }
      if (pose.geo?.alt != null) rows.push(row('Altitude', `${formatLength(pose.geo.alt, units)} (approximate)`));
      grid.replaceChildren(...rows.flat());

      extra.replaceChildren();
      if (S().simulate || status.simulated) {
        extra.append(el('div', { class: 'banner warn' }, el('span', { html: icon('warning', { size: 18 }) }),
          el('span', { class: 'grow' }, 'Demo mode is on: this position is made up.'),
          el('button', {
            type: 'button', class: 'btn btn-sm btn-outline', onclick: async () => {
              try { await app.updateSettings({ simulate: false }); toast('Demo mode is off.', { type: 'ok' }); } catch (err) { toast(`Not changed: ${err.message}`, { type: 'err' }); }
              render();
            },
          }, 'Turn off')));
      }
      if (project.compassOffset == null && level?.plan) {
        extra.append(el('p', { class: 'small muted' }, 'Tip: Calibrate → Align the compass makes camera directions match the plan.'));
      }

      let need = false;
      try { need = !!positioning.needsPermission?.(); } catch { need = false; }
      btns.replaceChildren(
        el('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: () => { sh.close(true); posSheet = null; imHere(); } },
          el('span', { html: icon('here', { size: 20 }) }), 'I\'m here — set my position'),
        need ? el('button', { type: 'button', class: 'btn btn-accent btn-block', onclick: enableSensors },
          el('span', { html: icon('compass', { size: 20 }) }), 'Enable compass & motion') : null,
        gps === 'denied' ? el('button', { type: 'button', class: 'btn btn-outline btn-block', onclick: () => alertDialog({ title: 'Turn on location', message: gpsHelp() }) }, 'How to turn on location') : null);
    }
    const renderSoon = throttle(render, 400);
    posSheet = { sh, render, renderSoon };
    render();
  }

  function enableSensors() {
    // iPhone only asks when the request starts inside the tap itself — call it first, await later.
    let req;
    try { req = Promise.resolve(positioning.requestPermission()); } catch (err) { req = Promise.reject(err); }
    req.then((ok) => {
      if (ok) toast('Compass and motion are on.', { type: 'ok' });
      else {
        alertDialog({
          title: 'Compass not allowed',
          message: 'Without the compass, photos still save where they were taken, but not which way the camera faced.\n\nTo try again, close the app (or the Safari tab) completely, open it again, tap Enable compass and choose Allow.',
        });
      }
    }).catch((err) => toast(`The compass could not be turned on: ${err?.message || err}`, { type: 'err' }))
      .finally(() => { renderCompassBtn(); posSheet?.render(); });
  }

  async function imHere(initial) {
    if (!view || picking || closed) return;
    const level = activeLevel();
    if (viewMode === 'plan' && !level?.calibration) {
      const ok = await confirmDialog({
        title: 'Calibrate the plan first',
        message: '"I\'m here" needs to know how the plan lines up with the ground. Calibrating takes 3 spots you can stand on, a minute each.',
        okText: 'Calibrate now',
      });
      if (ok) chooseCalibration(level);
      return;
    }
    if (typeof view.pickPoint !== 'function') return;
    picking = true;
    stage.classList.add('picking');
    hidePreview();
    try {
      const init = initial || (viewMode === 'plan' ? lastPose?.plan : lastPose?.geo ? { lat: lastPose.geo.lat, lng: lastPose.geo.lng } : null) || undefined;
      const pt = await view.pickPoint({
        title: 'Where are you standing?',
        hint: viewMode === 'plan'
          ? 'Move the plan so the cross is exactly on the spot you stand on — a corner, a column, a door.'
          : 'Move the map so the cross is exactly where you stand.',
        initial: init,
      });
      if (!pt || closed) return;
      await positioning.fixHere(viewMode === 'plan' ? { plan: { x: pt.x, y: pt.y } } : { geo: { lat: pt.lat, lng: pt.lng } });
      if (S().vibrate) buzz(20);
      toast('Position set. The next few minutes of photos are more accurate too.', { type: 'ok', ms: 3500 });
    } catch (err) {
      toast(`The position was not set: ${err?.message || err}`, { type: 'err' });
    } finally {
      picking = false;
      stage.classList.remove('picking');
    }
  }

  // ---- notes ----
  async function loadOptional(path) {
    try { return await import(path); } catch (err) { console.warn(`[project] ${path} not available`, err); return null; }
  }

  async function saveNoteItem(pose) {
    if (noteBusy) return;
    noteBusy = true;
    try {
      const level = activeLevel();
      // capture.saveNote cleans the pose (null is fine) and stamps who took it;
      // a plain store record is the fallback if that module cannot load.
      const cap = await loadOptional('../core/capture.js');
      let item;
      if (cap?.saveNote) {
        item = await cap.saveNote({ project, level, pose, text: '', title: '' });
      } else {
        item = await store.createItem(pid, { type: 'note', levelId: level.id, pose, capturedBy: S().userName || '' });
      }
      if (!item?.id) throw new Error('The note was not created.');
      toast(`${itemLabel(item)} saved. Type your note.`, { type: 'ok' });
      if (!closed) ctx.navigate(`p/${pid}/i/${item.id}?focus=text`);
    } catch (err) {
      toast(`The note was not saved: ${err?.message || err}`, { type: 'err', action: { label: 'Try again', onclick: () => saveNoteItem(pose) } });
    } finally {
      noteBusy = false;
    }
  }

  async function noteAt(pt) {
    if (viewMode === 'plan') {
      const [cal, geo] = await Promise.all([loadOptional('../core/calibration.js'), loadOptional('../core/geo.js')]);
      return saveNoteItem(notePoseAtPlan(pt, { level: activeLevel(), project, planToEnu: cal?.planToEnu, fromEnu: geo?.fromEnu }));
    }
    const geo = await loadOptional('../core/geo.js');
    return saveNoteItem(notePoseAtGeo(pt, { project, toEnu: geo?.toEnu }));
  }

  async function noteHere() {
    if (picking || noteBusy) return;
    const pose = copyPose(lastPose || positioning.getPose?.());
    const onView = viewMode === 'plan' ? !!pose?.plan : !!pose?.geo;
    if (onView) { saveNoteItem(pose); return; }
    const level = activeLevel();
    const v = await choose({
      title: 'Where is this note?',
      options: [
        {
          value: 'pick', icon: 'pin', label: viewMode === 'plan' ? 'Place it on the plan' : 'Place it on the map',
          detail: viewMode === 'plan' && !level?.calibration ? 'The plan is not calibrated, so your position is not on it yet' : 'Your position is not known yet',
        },
        pose?.geo
          ? { value: 'gps', icon: 'locate', label: 'Save it with the GPS position', detail: 'It shows on the plan once the plan is calibrated' }
          : { value: 'none', icon: 'note', label: 'Save it without a spot', detail: 'You can place it later with Move pin' },
      ],
    });
    if (!v || closed) return;
    if (v === 'pick') {
      if (!view?.pickPoint) return;
      picking = true;
      stage.classList.add('picking');
      let pt = null;
      try {
        pt = await view.pickPoint({ title: 'Where is the note?', hint: 'Move the view so the cross is on the spot, then tap Set.' });
      } catch { pt = null; } finally {
        picking = false;
        stage.classList.remove('picking');
      }
      if (pt && !closed) noteAt(pt);
      return;
    }
    saveNoteItem(v === 'gps' ? pose : null);
  }

  async function onLongPress(pt) {
    const level = activeLevel();
    const options = [{ value: 'note', label: 'Add a note here', icon: 'note', detail: 'A pin with your text, voice notes and tags' }];
    if (viewMode === 'map' || level?.calibration) options.push({ value: 'here', label: 'I\'m standing here', icon: 'here', detail: 'Correct your position to this spot' });
    const v = await choose({ title: 'This spot', options });
    if (closed) return;
    if (v === 'note') noteAt(pt);
    else if (v === 'here') imHere(pt);
  }

  // ---- levels and plans ----
  function levelDetail(l) {
    const n = items.filter((i) => i.levelId === l.id).length;
    const plan = l.plan ? (l.calibration ? `Plan · calibrated (${l.calibration.quality || 'ok'})` : 'Plan · not calibrated') : 'No plan yet (map)';
    return `${plan} · ${n} item${n === 1 ? '' : 's'}`;
  }

  async function chooseLevel() {
    if (picking) return;
    const options = project.levels.map((l) => ({
      value: l.id, label: l.id === project.activeLevelId ? `${l.name}  ✓` : l.name, icon: l.plan ? 'plan' : 'map', detail: levelDetail(l),
    }));
    options.push({ value: '__add', label: 'Add a level', icon: 'plus' }, { value: '__manage', label: 'Levels & plans…', icon: 'layers' });
    const v = await choose({ title: 'Level', options });
    if (!v || closed) return;
    if (v === '__add') addLevel();
    else if (v === '__manage') openLevelsSheet();
    else if (v !== project.activeLevelId) switchLevel(v);
  }

  async function switchLevel(lid) {
    hidePreview();
    saveViewState();
    try {
      await store.setActiveLevel(pid, lid);
      const p = await store.getProject(pid);
      if (p && !closed) { project = p; applyProject(); }
    } catch (err) {
      toast(`The level was not changed: ${err.message}`, { type: 'err' });
    }
  }

  async function addLevel() {
    const name = await promptDialog({ title: 'Add a level', label: 'Name', value: `Level ${project.levels.length + 1}`, okText: 'Add' });
    if (!name || closed) return;
    let made;
    try {
      made = await store.addLevel(pid, name);
    } catch (err) {
      toast(`The level was not added: ${err.message}`, { type: 'err' });
      return;
    }
    toast(`${made.name} added.`, { type: 'ok' });
    const fresh = await store.getProject(pid);
    if (fresh && !closed) { project = fresh; applyProject(); }
    const want = await confirmDialog({ title: `Add the plan for ${made.name}?`, message: 'You can also add it later from Levels & plans. Until then this level uses the satellite map.', okText: 'Add plan', cancelText: 'Later' });
    if (want && !closed) addPlan(store.getLevel(project, made.id) || made);
  }

  async function addPlan(l) {
    if (!l || closed) return;
    if (l.plan) {
      const ok = await confirmDialog({
        title: `Replace the plan for ${l.name}?`,
        message: 'The new plan has to be calibrated again before photos land on it by themselves. Photos already taken keep their GPS position and are placed again when you calibrate; pins you placed by hand may need moving.\n\nThe old plan is kept in this job walk.',
        okText: 'Choose the new plan',
      });
      if (!ok) return;
    }
    let r;
    try {
      r = await choosePlanAndSave({ project, level: l, allowMap: false, signal: leaving.signal });
    } catch (err) {
      toast(`The plan was not added: ${err.message}`, { type: 'err' });
      return;
    }
    if (r !== 'saved' || closed) return;
    if (l.id !== project.activeLevelId) await switchLevel(l.id);
    const p = await store.getProject(pid);
    if (p && !closed) { project = p; applyProject(); }
    toast('Next: calibrate it so photos land on the plan.', { type: 'info', ms: 6000, action: { label: 'Calibrate', onclick: () => chooseCalibration(store.getLevel(project, l.id)) } });
  }

  async function renameLevel(l) {
    const name = await promptDialog({ title: 'Rename level', label: 'Name', value: l.name, okText: 'Save' });
    if (!name || name === l.name || closed) return;
    try {
      await store.updateLevel(pid, l.id, { name });
      toast('Level renamed.', { type: 'ok' });
    } catch (err) {
      toast(`Not renamed: ${err.message}`, { type: 'err' });
    }
  }

  async function removeLevel(l) {
    const n = items.filter((i) => i.levelId === l.id).length;
    if (n) {
      await alertDialog({ title: `${l.name} cannot be removed`, message: `It has ${n} photo${n === 1 ? '' : 's'}, video${n === 1 ? '' : 's'} or note${n === 1 ? '' : 's'} on it. Nothing is removed together with a level.` });
      return;
    }
    const ok = await confirmDialog({ title: `Remove ${l.name}?`, message: l.plan ? 'The level and its plan are taken out of this job walk.' : 'The level is taken out of this job walk.', okText: 'Remove', danger: true });
    if (!ok || closed) return;
    try {
      await store.removeLevel(pid, l.id);
      toast(`${l.name} removed.`, { type: 'ok' });
    } catch (err) {
      await alertDialog({
        title: `${l.name} was not removed`,
        message: /photos|videos|notes/i.test(err.message) ? `${err.message}\n\nItems in Recently Deleted count too: restore and move them, or erase them there first.` : err.message,
      });
    }
  }

  function openLevelsSheet() {
    if (levelsSheet) { levelsSheet.render(); return; }
    const sh = openSheet({ title: 'Levels & plans', cls: 'pj-levels-sheet', onClose: () => { levelsSheet = null; } });
    const smallBtn = (label, onclick, cls = 'btn-outline') => el('button', { type: 'button', class: `btn btn-sm ${cls}`, onclick }, label);
    function render() {
      if (closed) return;
      const list = el('div', { class: 'pj-levels' });
      for (const l of project.levels) {
        const ph = el('span', { class: 'pj-lv-ph', html: icon(l.plan ? 'plan' : 'map', { size: 26 }) });
        const thumb = el('span', { class: 'pj-lv-thumb' }, ph);
        if (l.plan?.thumbId) {
          scope.url(l.plan.thumbId).then((u) => {
            if (!u || closed) return;
            const img = el('img', { alt: '', src: u });
            img.addEventListener('load', () => ph.remove(), { once: true });
            thumb.append(img);
          }).catch(() => { /* icon stays */ });
        }
        const planLine = l.plan
          ? [l.plan.fileName || 'Plan', l.plan.page ? `page ${l.plan.page}` : null, l.plan.width ? `${l.plan.width} × ${l.plan.height} px` : null].filter(Boolean).join(' · ')
          : 'No plan yet — shows the satellite map';
        const active = l.id === project.activeLevelId;
        list.append(el('div', { class: `pj-lv${active ? ' active' : ''}` },
          el('button', {
            type: 'button', class: 'pj-lv-main', onclick: () => { sh.close(true); levelsSheet = null; if (!active) switchLevel(l.id); },
          },
          thumb,
          el('span', { class: 'pj-lv-info' },
            el('span', { class: 'pj-lv-name' }, l.name, active ? el('span', { class: 'badge info' }, 'Showing') : null),
            el('span', { class: 'pj-lv-detail' }, planLine),
            el('span', { class: 'pj-lv-detail' }, levelDetail(l)))),
          el('div', { class: 'pj-lv-btns' },
            smallBtn('Rename', () => renameLevel(l)),
            smallBtn(l.plan ? 'Replace plan' : 'Add plan', () => addPlan(l), l.plan ? 'btn-outline' : 'btn-primary'),
            l.plan ? smallBtn('Calibrate', () => { sh.close(true); levelsSheet = null; chooseCalibration(l); }) : null,
            project.levels.length > 1 ? smallBtn('Remove', () => removeLevel(l), 'btn-ghost pj-danger-text') : null)));
      }
      sh.body.replaceChildren(
        list,
        el('button', { type: 'button', class: 'btn btn-outline btn-block', onclick: addLevel }, el('span', { html: icon('plus', { size: 20 }) }), 'Add a level'),
        el('p', { class: 'small muted pj-lv-help' }, 'Replacing a plan keeps the old one in this job walk. A new plan must be calibrated again.'));
    }
    levelsSheet = { sh, render };
    render();
  }

  async function chooseCalibration(l = activeLevel()) {
    if (!l || closed) return;
    if (!l.plan) {
      const ok = await confirmDialog({ title: 'Add a plan first', message: 'Calibration lines a floor plan up with the ground. This level has no plan yet.', okText: 'Add plan' });
      if (ok) addPlan(l);
      return;
    }
    const v = await choose({
      title: `Calibrate ${l.name}`,
      options: [
        { value: 'gps', icon: 'locate', label: 'On site, with GPS', detail: 'Mark 3 spots on the plan and stand on each one. The usual way.' },
        { value: 'map', icon: 'map', label: 'Align to the satellite map', detail: 'In the office: match 2–4 points between the plan and the map.' },
        { value: 'scale', icon: 'ruler', label: 'Set the scale from a known dimension', detail: 'Mark a wall you know the length of. Makes distances exact.' },
        { value: 'compass', icon: 'compass', label: 'Align the compass', detail: project.compassOffset != null ? 'Done before — redo it if camera directions look off' : 'Point the phone along a wall so camera directions match the plan.' },
      ],
    });
    if (v && !closed) ctx.navigate(`p/${pid}/calibrate/${l.id}?mode=${v}`);
  }

  // ---- menu ----
  async function openMenu() {
    if (picking) return;
    const level = activeLevel();
    const st = backupState(project);
    const v = await choose({
      title: project.name,
      options: [
        { value: 'info', label: 'Job info', icon: 'edit', detail: [project.address, project.number ? `Job ${project.number}` : null, project.gc].filter(Boolean).join(' · ') || 'Name, address, GC, job #, date, notes' },
        { value: 'levels', label: 'Levels & plans', icon: 'layers', detail: `${project.levels.length} level${project.levels.length === 1 ? '' : 's'}` },
        { value: 'calibrate', label: 'Calibrate', icon: 'target', detail: level?.plan ? (level.calibration ? 'Calibrated — redo or improve it' : 'This plan is not calibrated yet') : 'Add a plan first' },
        { value: 'import', label: 'Add photos from this device', icon: 'image', detail: 'Pictures already in your gallery (their GPS is used when they have it)' },
        { value: 'export', label: 'Back up & export', icon: 'archive', detail: st.needed ? `${st.changesSince} change${st.changesSince === 1 ? '' : 's'} not backed up` : st.lastAt ? `Backed up ${formatDate(st.lastAt)}` : 'One .zip that opens in any browser' },
        { value: 'settings', label: 'Settings', icon: 'settings' },
        { value: 'delete', label: 'Delete job walk', icon: 'trash', danger: true, detail: 'Moves it to Recently Deleted' },
      ],
    });
    if (!v || closed) return;
    if (v === 'info') editInfo();
    else if (v === 'levels') openLevelsSheet();
    else if (v === 'calibrate') chooseCalibration(level);
    else if (v === 'import') importPhotos();
    else if (v === 'export') ctx.navigate(`p/${pid}/export`);
    else if (v === 'settings') ctx.navigate('settings');
    else if (v === 'delete') deleteJobWalk();
  }

  async function editInfo(values = null) {
    const p = values || project;
    const r = await formDialog({
      title: 'Job info',
      fields: [
        { name: 'name', label: 'Job name', value: p.name },
        { name: 'address', label: 'Address', value: p.address, placeholder: 'Street, city' },
        { name: 'gc', label: 'GC / client', value: p.gc },
        { name: 'number', label: 'DCR job #', value: p.number, placeholder: 'e.g. A302' },
        { name: 'walkDate', label: 'Walk date', type: 'date', value: p.walkDate },
        { name: 'notes', label: 'Notes', type: 'textarea', value: p.notes, placeholder: 'Scope, contacts, access…' },
      ],
    });
    if (!r || closed) return;
    const patch = { name: r.name || project.name, address: r.address, gc: r.gc, number: r.number, walkDate: r.walkDate || project.walkDate, notes: r.notes };
    try {
      const addressChanged = patch.address !== project.address;
      await store.updateProject(pid, patch);
      toast('Job info saved.', { type: 'ok' });
      if (addressChanged && viewMode === 'map' && view && patch.address && !lastPose?.geo) geocodeAddress(view, buildToken);
    } catch (err) {
      // Keep what was typed: Try again reopens the form with it.
      toast(`Job info was not saved: ${err.message}`, { type: 'err', action: { label: 'Try again', onclick: () => editInfo({ ...project, ...patch }) } });
    }
  }

  async function importPhotos() {
    const files = await pickFiles({ accept: 'image/*', multiple: true });
    if (!files.length || closed) return;
    const cap = await loadOptional('../core/capture.js');
    if (!cap?.importPhotos) { toast('Adding photos is not available right now. Reload the app and try again.', { type: 'err' }); return; }
    const b = busy(`Adding ${files.length} photo${files.length === 1 ? '' : 's'}… keep this screen open.`);
    try {
      const made = await cap.importPhotos(files, {
        project, level: activeLevel(),
        onProgress: ({ done, total, fileName } = {}) => b.update(`Adding photo ${Math.min((done || 0) + 1, total || files.length)} of ${total || files.length}${fileName ? ` (${fileName})` : ''}…`, total ? done / total : null),
      });
      b.done();
      const n = made?.length ?? 0;
      toast(`Added ${n} photo${n === 1 ? '' : 's'}.`, { type: 'ok' });
      const failed = made?.errors?.length ?? Math.max(0, files.length - n);
      if (failed) {
        const first = made?.errors?.[0];
        toast(`${failed} picture${failed === 1 ? '' : 's'} could not be added${first ? ` (${first.fileName || 'a file'}: ${first.error?.message || first.error})` : ''}.`, { type: 'warn', ms: 9000 });
      }
    } catch (err) {
      b.done();
      toast(`The photos were not added: ${err.message}`, { type: 'err' });
    }
  }

  async function deleteJobWalk() {
    const ok = await confirmDialog({
      title: `Move "${project.name}" to Recently Deleted?`,
      message: 'Its plans, photos, videos and notes are kept in Recently Deleted until you erase them there. You can restore it at any time.',
      okText: 'Move to Recently Deleted',
      danger: true,
    });
    if (!ok || closed) return;
    try {
      await store.softDeleteProject(pid);
    } catch (err) {
      toast(`It was not moved: ${err.message}`, { type: 'err' });
      return;
    }
    const name = project.name;
    toast(`"${name}" is in Recently Deleted.`, {
      type: 'ok', ms: 7000,
      action: { label: 'Undo', onclick: () => store.restoreProject(pid).then(() => toast('Restored.', { type: 'ok' })).catch((e) => toast(`Not restored: ${e.message}`, { type: 'err' })) },
    });
    ctx.navigate('', { replace: true });
  }

  // ---- keeping up with changes ----
  function applyProject() {
    if (closed) return;
    renderTitle();
    renderBanners();
    buildView();
    refreshViewSettings();
    try { view?.setItems(levelItems(), { selectedId }); } catch { /* fine */ }
    posSheet?.render();
    levelsSheet?.render();
  }

  const reloadProject = debounce(async () => {
    if (closed) return;
    let p;
    try { p = await store.getProject(pid); } catch { return; }
    if (closed) return;
    if (!p) { toast('This job walk was erased.', { type: 'warn' }); ctx.navigate('', { replace: true }); return; }
    if (p.deletedAt) { toast(`"${p.name}" was moved to Recently Deleted.`, { type: 'info' }); ctx.navigate('', { replace: true }); return; }
    project = p;
    applyProject();
  }, 120);
  const reloadItems = debounce(() => { if (!closed) loadItems(); }, 200);

  offs.push(bus.on('store:change', (ev) => {
    if (ev.projectId !== pid && ev.id !== pid) return;
    if (ev.kind === 'project') {
      if (ev.action === 'purge') { reloadProject(); return; }
      reloadProject();
    } else if (ev.kind === 'item') {
      reloadItems();
      reloadProject();   // item writes change the backup count on the project
    }
  }));
  offs.push(bus.on('settings:change', () => { renderChip(); renderBanners(); buildView(); refreshViewSettings(); posSheet?.render(); }));
  offs.push(listen(positioning, 'pose', (pose) => {
    lastPose = pose;
    try { view?.setPose(pose); } catch { /* view closing */ }
    chipSoon();
    posSheet?.renderSoon?.();
  }));
  offs.push(listen(positioning, 'status', (s) => {
    status = s || {};
    renderChip();
    renderBanners();
    renderCompassBtn();
    posSheet?.render();
  }));

  let raf = 0;
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { try { view?.resize?.(); } catch { /* fine */ } });
  }) : null;
  ro?.observe(stage);

  // ---- start ----
  renderTitle();
  renderChip();
  renderCompassBtn();
  await loadItems();
  renderBanners();
  buildView();

  return () => {
    persistMapSoon.flush();   // before `closed`, which stops persistMapView
    saveViewState();
    closed = true;
    persistMapSoon.cancel();
    reloadProject.cancel();
    reloadItems.cancel();
    leaving.abort();
    for (const off of offs) { try { off(); } catch { /* fine */ } }
    ro?.disconnect();
    cancelAnimationFrame(raf);
    buildToken++;
    destroyView();
    try { posSheet?.sh.close(true); } catch { /* gone */ }
    try { levelsSheet?.sh.close(true); } catch { /* gone */ }
    try { panel?.close(); } catch { /* gone */ }
    posSheet = null;
    levelsSheet = null;
    panel = null;
    scope.release();
  };
}
