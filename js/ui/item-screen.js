// item-screen.js — one photo, video or note in detail (route p/:pid/i/:iid).
//
// This is where the estimator writes down what has to be priced: the photo
// (with its markup) or the video, and under it the title, tags, the typed
// note, dictation, voice notes, and where and which way it was taken.
//
// Why it is built the way it is:
//  - Typed words are never lost. Every keystroke is copied to localStorage
//    at once (a killed app between a keystroke and the save keeps it), saved
//    to the store ~0.8 s after typing stops, and flushed on leaving, on
//    visibilitychange/pagehide and on cleanup. "Saved" appears only after
//    the store has committed. A copy left in localStorage (the save never
//    finished) is put back and saved the next time the item opens.
//  - Each edit changes only its own fields (a mutating store.updateItem),
//    so the title, the note, a tag and a voice note saved at the same moment
//    never overwrite each other. If another tab changed the note at the same
//    time, both versions are kept in the note (mergeText).
//  - Nothing is erased here: Delete moves the item to Recently Deleted (with
//    Undo); removing a voice note keeps its recording (js/core/voice.js); a
//    voice note still recording when the person leaves is saved, and one
//    that could not be saved stays in memory with Try again / Download.
//  - The plan view, map view, recorder and items panel belong to other
//    modules and are imported on demand, so if one of them fails to load,
//    the photo and its notes still open and can be edited.
//
// The small pure helpers (labels, track maths, file names, text merging,
// the autosaver) are exported for tests/voice.test.mjs.

import { el, iconButton, toast, confirmDialog, promptDialog, choose, saveBlob } from './shell.js';
import { icon } from './icons.js';
import * as store from '../core/store.js';
import { bus as appBus } from '../core/bus.js';
import { getSettings as readSettings } from '../core/settings.js';
import { createDictation, addVoiceNote, removeVoiceNote, restoreVoiceNote, joinDictated } from '../core/voice.js';
import {
  clamp, DEG, normDeg, compassPoint, formatAccuracy, formatDateTime, formatDuration, formatBytes,
  safeFileName, M_PER_FT, buzz, isIOS,
} from '../core/util.js';

const SAVE_DELAY_MS = 800;              // typed text is saved this long after the last keystroke
const MAX_VOICE_MS = 15 * 60 * 1000;    // a voice note stops (and is saved) after 15 minutes
const DRAFT_PREFIX = 'jw.itemDraft.';   // localStorage copy of typing not yet saved, per item
const DEFAULT_CENTER = { lat: 38.5816, lng: -121.4944 }; // Sacramento, when nothing else says where

/** The suggested framing tags, used when js/ui/items-panel.js (which owns the list) cannot be loaded. */
export const FALLBACK_TAGS = Object.freeze([
  'Walls', 'Headers/Beams', 'Floor framing', 'Roof/Trusses', 'Sheathing', 'Shear/Hold-downs', 'Blocking',
  'Stairs', 'Decks/Balconies', 'Hardware', 'Existing conditions', 'Demo', 'Access/Site', 'Issue/RFI', 'Safety',
]);

const SOURCE_LABEL = {
  'device-camera': "Taken with the phone's camera app",
  import: 'Imported from the phone',
  recovered: 'Rebuilt after the app closed while recording',
};

// Other workstreams' modules, loaded only when needed (see the header).
const loaders = {
  planView: () => import('./plan-view.js'),
  mapView: () => import('./map-view.js'),
  recorder: () => import('../core/recorder.js'),
  geo: () => import('../core/geo.js'),
  itemsPanel: () => import('./items-panel.js'),
};

// ---- pure helpers (exported for tests) ---------------------------------------------------

/** 'Photo' | 'Video' | 'Note' */
export function typeLabel(type) {
  return type === 'video' ? 'Video' : type === 'note' ? 'Note' : 'Photo';
}

/** 42.4 → 'NE 42°'; null when there is no heading. */
export function describeHeading(deg) {
  if (deg == null || !Number.isFinite(deg)) return null;
  const d = Math.round(normDeg(deg)) % 360;
  return `${compassPoint(d)} ${d}°`;
}

/** Camera tilt in words: 'Level', 'Looking down 35°', 'Looking up 12°', 'Straight down'. */
export function describeTilt(pitch) {
  if (pitch == null || !Number.isFinite(pitch)) return null;
  if (Math.abs(pitch) < 3) return 'Level';
  if (pitch <= -85) return 'Straight down';
  if (pitch >= 85) return 'Straight up';
  const a = Math.round(Math.abs(pitch));
  return pitch < 0 ? `Looking down ${a}°` : `Looking up ${a}°`;
}

/** GPS altitude: whole feet (imperial) or meters with one decimal; null when unknown. */
export function formatAltitude(meters, units = 'imperial') {
  if (meters == null || !Number.isFinite(meters)) return null;
  if (units === 'metric') return `${meters.toFixed(1)} m`;
  return `${Math.round(meters / M_PER_FT).toLocaleString('en-US')} ft`;
}

export function formatCoords(lat, lng) {
  return `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`;
}

/** A link that opens the spot in Google Maps (app or web). */
export function googleMapsUrl(lat, lng) {
  return `https://www.google.com/maps/search/?api=1&query=${Number(lat).toFixed(7)},${Number(lng).toFixed(7)}`;
}

/** Position quality → the badge class from app.css and a word for it. */
export function qualityBadge(quality) {
  switch (quality) {
    case 'good': return { cls: 'ok', label: 'Good' };
    case 'fair': return { cls: 'warn', label: 'Fair' };
    case 'poor': return { cls: 'err', label: 'Poor' };
    default: return { cls: '', label: 'No GPS' };
  }
}

const byTime = (a, b) => (a.createdAt || 0) - (b.createdAt || 0) || (a.seq || 0) - (b.seq || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The items before and after `current` in the job walk, by time (deleted
 * ones skipped). `current` may itself be deleted (opened from Recently
 * Deleted): then index is -1 and prev/next are its neighbours in time.
 */
export function neighbors(items, current) {
  const live = (items || []).filter((i) => !i.deletedAt && i.id !== current.id);
  const all = [...live, current].sort(byTime);
  const at = all.indexOf(current);
  return {
    prev: all[at - 1] || null,
    next: all[at + 1] || null,
    index: current.deletedAt ? -1 : at,
    count: current.deletedAt ? live.length : all.length,
  };
}

const finite = (...v) => v.every((x) => typeof x === 'number' && Number.isFinite(x));

export function hasPlanTrack(item) {
  return Array.isArray(item?.track) && item.track.some((p) => p && finite(p.x, p.y));
}

export function hasGeoTrack(item) {
  return Array.isArray(item?.track) && item.track.some((p) => p && finite(p.lat, p.lng));
}

/**
 * The track point nearest to `target`: plan pixels ({x, y}, mode 'plan') or
 * lat/lng ({lat, lng}, mode 'geo', distance in meters). → {index, point, distance} | null
 */
export function nearestTrackPoint(track, target, mode = 'plan') {
  if (!Array.isArray(track) || !target) return null;
  let best = null;
  let bestD = Infinity;
  let bestI = -1;
  const kx = mode === 'geo' ? 111320 * Math.cos((target.lat || 0) * DEG) : 0;
  for (let i = 0; i < track.length; i++) {
    const p = track[i];
    if (!p || !finite(p.t)) continue;
    let d;
    if (mode === 'geo') {
      if (!finite(p.lat, p.lng)) continue;
      d = Math.hypot((p.lng - target.lng) * kx, (p.lat - target.lat) * 110574);
    } else {
      if (!finite(p.x, p.y)) continue;
      d = Math.hypot(p.x - target.x, p.y - target.y);
    }
    if (d < bestD) { bestD = d; best = p; bestI = i; }
  }
  return best ? { index: bestI, point: best, distance: bestD } : null;
}

/** The box around a track's plan points, or null when it has none. */
export function trackBounds(track) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
  for (const p of track || []) {
    if (!p || !finite(p.x, p.y)) continue;
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    n++;
  }
  return n ? { minX, minY, maxX, maxY, n } : null;
}

/**
 * Where an item can be shown:
 *  'plan'        its level has a plan and the item has a spot on it (pin or video path)
 *  'map'         it has GPS (lat/lng) — a map-mode level, or a plan that is not calibrated yet
 *  'plan-empty'  the level has a plan but the item has no position at all
 *  'map-empty'   map mode and no position at all
 */
export function placeKind(item, level) {
  const pose = item?.pose || null;
  const hasPlan = !!level?.plan;
  const planPt = !!(pose?.plan && finite(pose.plan.x, pose.plan.y)) || (item?.type === 'video' && hasPlanTrack(item));
  const geoPt = !!(pose?.geo && finite(pose.geo.lat, pose.geo.lng)) || (item?.type === 'video' && hasGeoTrack(item));
  if (hasPlan && planPt) return 'plan';
  if (geoPt) return 'map';
  return hasPlan ? 'plan-empty' : 'map-empty';
}

const MIME_EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
  'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/mpeg': '.mp3', 'audio/webm': '.webm', 'audio/ogg': '.ogg',
  'text/plain': '.txt',
};
const MIME_NAME = {
  'image/jpeg': 'JPEG photo', 'image/png': 'PNG image', 'image/webp': 'WebP image', 'image/heic': 'HEIC photo',
  'video/mp4': 'MP4 video', 'video/quicktime': 'QuickTime video', 'video/webm': 'WebM video',
  'audio/mp4': 'M4A audio', 'audio/webm': 'WebM audio', 'audio/ogg': 'Ogg audio',
};
const baseMime = (mime) => String(mime || '').toLowerCase().split(';')[0].trim();

/** 'video/webm;codecs=vp9' → '.webm'; unknown → '' (no extension rather than a wrong one). */
export function extForMime(mime) {
  return MIME_EXT[baseMime(mime)] || '';
}

/** 'image/jpeg' → 'JPEG photo' */
export function describeMime(mime) {
  const m = baseMime(mime);
  return MIME_NAME[m] || m || 'Unknown';
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * A file name that says what it is, like the photo export:
 * '012 - Level 1 - Header over garage - 2026-11-02 10.32.jpg'
 */
export function fileNameFor(item, { levelName = '', variant = 'original', mimeType } = {}) {
  const d = new Date(item?.createdAt || Date.now());
  const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}.${pad2(d.getMinutes())}`;
  const what = String(item?.title || '').trim() || item?.tags?.[0] || typeLabel(item?.type);
  const parts = [String(item?.seq || 0).padStart(3, '0'), levelName, what, stamp];
  if (variant === 'annotated') parts.push('markup');
  const ext = extForMime(mimeType || item?.mimeType) || (item?.type === 'note' ? '.txt' : '');
  return safeFileName(parts.filter(Boolean).join(' - '), 'item') + ext;
}

/**
 * Combine a text field edited here (`mine`) with what the store holds now
 * (`theirs`), given what it held when this screen last read it (`base`).
 * The usual case — nobody else changed it — is simply `mine`. When both
 * changed, both are kept: nothing anybody typed is lost.
 * → {text, conflict}
 */
export function mergeText(base, mine, theirs) {
  const b = base ?? '';
  const m = mine ?? '';
  const t = theirs ?? '';
  if (t === b || t === m) return { text: m, conflict: false };
  if (m === b) return { text: t, conflict: false };
  if (m.includes(t)) return { text: m, conflict: false };
  if (t.includes(m)) return { text: t, conflict: false };
  return { text: `${m}\n\n${t}`, conflict: true };
}

/**
 * The zoom (screen px per plan px) that shows about `meters` around a pin,
 * never less than the whole plan and never more than `maxScale`. Without a
 * calibration the scale is unknown, so it zooms 4× into the fitted plan.
 */
export function focusScale({ cw, ch, planW, planH, pxPerMeter = null, meters = 12, maxScale = 2 }) {
  if (!(cw > 0 && ch > 0 && planW > 0 && planH > 0)) return 1;
  const fitS = Math.min(cw / planW, ch / planH);
  const want = pxPerMeter > 0 ? Math.min(cw, ch) / (meters * pxPerMeter) : fitS * 4;
  return clamp(want, fitS, Math.max(fitS, maxScale));
}

/** The zoom that fits a video's path (bounds from trackBounds) with some room around it. */
export function trackFitScale({ cw, ch, planW, planH, bounds, pad = 32, pxPerMeter = null }) {
  if (!(cw > 0 && ch > 0 && planW > 0 && planH > 0)) return 1;
  const fitS = Math.min(cw / planW, ch / planH);
  if (!bounds) return fitS;
  const bw = Math.max(bounds.maxX - bounds.minX, 1);
  const bh = Math.max(bounds.maxY - bounds.minY, 1);
  const s = Math.min((cw - 2 * pad) / bw, (ch - 2 * pad) / bh);
  return clamp(s, fitS, focusScale({ cw, ch, planW, planH, pxPerMeter, meters: 10 }));
}

/**
 * Saves typed fields a moment after typing stops, and right away on flush().
 *   const a = createAutosaver({save: async (values) => …, onState});
 *   a.set('text', textarea.value);       // on every input
 *   await a.flush();                     // before leaving; rejects if the save failed
 * save(values) gets {field: value} for every field changed since the last
 * save and must resolve only once the store has committed. Saves run one at
 * a time, in order; typing during a save is saved right after it. A failed
 * save keeps its values and is retried (after 5 s, then less often), or on
 * the next flush. onState('dirty' | 'saving' | 'saved' | 'error', err).
 */
export function createAutosaver({ save, delay = SAVE_DELAY_MS, onState = () => {} } = {}) {
  const pending = new Map();
  let inFlight = null;
  let timer = null;
  let chain = Promise.resolve();
  let failures = 0;

  const state = (s, err) => {
    try { onState(s, err); } catch (e) { console.error('[item] save state', e); }
  };

  function schedule(ms = delay) {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; flush().catch(() => { /* reported through onState */ }); }, ms);
  }

  async function saveNow() {
    if (!pending.size) return;
    clearTimeout(timer);
    timer = null;
    const values = Object.fromEntries(pending);
    pending.clear();
    inFlight = values;
    state('saving');
    try {
      await save(values);
      inFlight = null;
      failures = 0;
      if (pending.size) { state('dirty'); schedule(); } else state('saved');
    } catch (err) {
      inFlight = null;
      // Keep what could not be saved (unless newer typing replaced it).
      for (const [k, v] of Object.entries(values)) if (!pending.has(k)) pending.set(k, v);
      failures++;
      state('error', err);
      schedule(Math.min(60_000, 5000 * 2 ** (failures - 1)));
      throw err;
    }
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    const run = chain.then(saveNow);
    chain = run.catch(() => { /* the caller of this flush handles it */ });
    return run;
  }

  return {
    set(field, value) { pending.set(field, value); state('dirty'); schedule(); },
    flush,
    /** True while `field` has typing that is not saved yet (waiting or being saved). */
    isPending(field) { return pending.has(field) || !!(inFlight && Object.prototype.hasOwnProperty.call(inFlight, field)); },
    get dirty() { return pending.size > 0 || !!inFlight; },
    get failed() { return failures > 0; },
    cancel() { clearTimeout(timer); timer = null; },
  };
}

/** A tag as typed → a clean one, reusing the spelling of a tag that already exists. */
export function cleanTag(text, known = []) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!t) return '';
  return known.find((k) => k.toLowerCase() === t.toLowerCase()) || t;
}

/** What to say when the microphone does not start (the recorder's own messages are already plain). */
export function micErrorMessage(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'The microphone is blocked for this app. Allow the microphone for this site in the browser settings, then try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found on this device.';
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'The microphone is busy (a call, or another app is recording). Close that and try again.';
  }
  return err?.message || 'The microphone could not start. Try again.';
}

/**
 * The lat/lng that is (dx, dy) CSS px away from a map view's centre
 * ({lat, lng, zoom}, Web Mercator with 256 px tiles, as Leaflet draws it).
 */
export function offsetLatLng({ lat, lng, zoom }, dx, dy) {
  const world = 256 * 2 ** zoom;
  const s = Math.sin(lat * DEG);
  const x = ((lng + 180) / 360) * world + dx;
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world + dy;
  return {
    lat: Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / world))) / DEG,
    lng: (x / world) * 360 - 180,
  };
}

// ---- small DOM helpers ---------------------------------------------------------------------

function observeResize(node, fn) {
  if (typeof ResizeObserver !== 'undefined') {
    let raf = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => fn()); });
    ro.observe(node);
    return { disconnect() { cancelAnimationFrame(raf); ro.disconnect(); } };
  }
  const h = () => fn();
  window.addEventListener('resize', h);
  return { disconnect() { window.removeEventListener('resize', h); } };
}

/** Run fn once `node` scrolls into view inside `scroller` (so a mini plan is not decoded for nothing). */
function whenVisible(node, scroller, fn) {
  if (typeof IntersectionObserver === 'undefined') {
    const t = setTimeout(fn, 0);
    return () => clearTimeout(t);
  }
  let done = false;
  const io = new IntersectionObserver((entries) => {
    if (done || !entries.some((e) => e.isIntersecting)) return;
    done = true;
    io.disconnect();
    fn();
  }, { root: scroller, rootMargin: '240px 0px' });
  io.observe(node);
  return () => { done = true; io.disconnect(); };
}

/** A horizontal swipe on `target` (touch and pen; desktop has the arrows). Returns the remover. */
function attachSwipe(target, onSwipe, { ignore } = {}) {
  let start = null;
  const down = (e) => {
    start = null;
    if (!e.isPrimary || e.pointerType === 'mouse' || ignore?.(e)) return;
    start = { x: e.clientX, y: e.clientY, t: performance.now() };
  };
  const up = (e) => {
    if (!start || !e.isPrimary) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const dt = performance.now() - start.t;
    start = null;
    if (Math.abs(dx) < 80 || Math.abs(dx) < Math.abs(dy) * 1.6 || dt > 900) return;
    onSwipe(dx < 0 ? 'next' : 'prev');
  };
  const cancel = () => { start = null; };
  target.addEventListener('pointerdown', down);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', cancel);
  return () => {
    target.removeEventListener('pointerdown', down);
    target.removeEventListener('pointerup', up);
    target.removeEventListener('pointercancel', cancel);
  };
}

function safeDestroy(view) {
  try { view?.destroy?.(); } catch (err) { console.warn('[item] a view did not close cleanly', err); }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* older browsers: the textarea way below */ }
  try {
    const ta = el('textarea', { style: { position: 'fixed', left: '-1000px', top: '0', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

const isTextField = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));
const modalOpen = () => !!document.querySelector('#overlays .modal-back, #overlays .sheet-back, #overlays .busy-back');

// ---- the plan image ------------------------------------------------------------------------
//
// A floor plan can be 6000+ px, so it is decoded once per page and kept in
// app.cache under 'plan:<mediaId>' (other screens may share the key; a plain
// '<mediaId>' entry holding a decoded image is used too).
//
// A decoded plan is up to ~64 MB, so only the two most recently used stay in
// the cache, the same rule as the project and calibrate screens. The cache
// Map's own order is the order of use, so the screens agree on it: a plan
// used again moves to the end, and keeping a new one drops the oldest
// (dropped, not closed: a screen still showing it keeps its own reference).

const planLoads = new Map();
const PLAN_CACHE_KEEP = 2;

/** Put (or move) `key` last in `cache` and drop all but the newest `keep` 'plan:' entries. */
export function keepPlanCached(cache, key, image, keep = PLAN_CACHE_KEEP) {
  if (!cache || typeof cache.set !== 'function') return;
  cache.delete?.(key);
  cache.set(key, image);
  if (typeof cache.keys !== 'function') return;
  const plans = [...cache.keys()].filter((k) => typeof k === 'string' && k.startsWith('plan:'));
  for (const k of plans.slice(0, Math.max(0, plans.length - keep))) cache.delete(k);
}

function isDrawable(x) {
  if (!x || typeof x !== 'object') return false;
  if (typeof ImageBitmap !== 'undefined' && x instanceof ImageBitmap) return x.width > 0;
  if (typeof HTMLImageElement !== 'undefined' && x instanceof HTMLImageElement) return x.naturalWidth > 0;
  if (typeof HTMLCanvasElement !== 'undefined' && x instanceof HTMLCanvasElement) return x.width > 0;
  return false;
}

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    // The URL stays alive with the cached image (one per plan, for the page's life).
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The floor plan image could not be read.'));
    img.src = URL.createObjectURL(blob);
  });
}

async function loadPlanImage(cache, plan) {
  const key = `plan:${plan.mediaId}`;
  for (const k of [key, plan.mediaId]) {
    const hit = cache?.get?.(k);
    if (!isDrawable(hit)) continue;
    if (k === key) keepPlanCached(cache, key, hit);   // used again: the newest now
    return hit;
  }
  if (planLoads.has(plan.mediaId)) return planLoads.get(plan.mediaId);
  const p = (async () => {
    const blob = await store.getMediaBlob(plan.mediaId);
    if (!blob) throw new Error('The floor plan image is missing on this phone.');
    let img = null;
    if (typeof createImageBitmap === 'function') {
      try { img = await createImageBitmap(blob); } catch { img = null; }
    }
    if (!img) img = await blobToImage(blob);
    keepPlanCached(cache, key, img);
    return img;
  })();
  planLoads.set(plan.mediaId, p);
  try { return await p; } finally { planLoads.delete(plan.mediaId); }
}

// ---- a light zoomable image viewer -----------------------------------------------------------
//
// The photo is an <img> at its natural size, moved and scaled with a CSS
// transform (screen = photo × s + t). Pointer events give pinch-zoom (the
// photo point under the fingers stays under them), pan when zoomed, a
// rubber-band swipe to the next item when not, double-tap / double-click
// zoom, wheel zoom and +/−/0 keys. will-change is only on while a finger is
// down, so Safari re-draws the photo sharp after a zoom.

function createZoomViewer(host, { label = '', onSwipe = null, onTap = null } = {}) {
  let img = makeImg();
  const note = el('div', { class: 'zv-msg', hidden: true });
  const stage = el('div', { class: 'zv', role: 'img', 'aria-label': label, tabindex: '0' }, img, note);
  host.append(stage);

  let iw = 0, ih = 0, cw = 0, ch = 0;   // photo and stage sizes
  let s = 1, tx = 0, ty = 0, fitS = 1;  // the transform, and the scale that fits the whole photo
  let swipeDx = 0;                      // rubber-band offset while swiping
  const pts = new Map();                // pointers down: id → {x, y} in stage coordinates
  let g = null;                         // the gesture in progress
  let lastTap = null;
  let tapTimer = null;
  let animTimer = null;
  let token = 0;
  let destroyed = false;

  function makeImg() {
    const im = document.createElement('img');
    im.className = 'zv-img';
    im.alt = '';
    im.draggable = false;
    im.decoding = 'async';
    return im;
  }

  const maxS = () => Math.max(fitS * 8, 2);
  const isZoomed = () => s > fitS * 1.02;

  function measure() {
    cw = stage.clientWidth;
    ch = stage.clientHeight;
    fitS = iw && ih && cw && ch ? Math.min(cw / iw, ch / ih) : 1;
  }
  function bound() {
    const w = iw * s, h = ih * s;
    tx = w <= cw ? (cw - w) / 2 : clamp(tx, cw - w, 0);
    ty = h <= ch ? (ch - h) / 2 : clamp(ty, ch - h, 0);
  }
  function apply() {
    img.style.transform = `translate(${tx + swipeDx}px, ${ty}px) scale(${s})`;
    stage.classList.toggle('zoomed', isZoomed());
  }
  function fitView() { measure(); s = fitS; swipeDx = 0; bound(); apply(); }
  function zoomTo(ns, px, py) {
    const n = clamp(ns, fitS, maxS());
    const k = n / s;
    tx = px - (px - tx) * k;
    ty = py - (py - ty) * k;
    s = n;
    bound();
    apply();
  }
  function animated(fn) {
    stage.classList.add('animating');
    fn();
    clearTimeout(animTimer);
    animTimer = setTimeout(() => stage.classList.remove('animating'), 260);
  }
  /** The view relative to the photo (centre in 0..1, zoom over fit), to keep it across a source swap. */
  function rel() { return iw ? { cx: (cw / 2 - tx) / (iw * s), cy: (ch / 2 - ty) / (ih * s), z: s / fitS } : null; }
  function restore(r) {
    measure();
    s = clamp(fitS * r.z, fitS, maxS());
    tx = cw / 2 - r.cx * iw * s;
    ty = ch / 2 - r.cy * ih * s;
    bound();
    apply();
  }
  function local(e) {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function loadImg(im, url) {
    return new Promise((resolve, reject) => {
      im.onload = () => {
        im.onload = im.onerror = null;
        Promise.resolve(im.decode ? im.decode().catch(() => {}) : null).then(() => resolve(im));
      };
      im.onerror = () => { im.onload = im.onerror = null; reject(new Error('The picture could not be shown.')); };
      im.src = url;
    });
  }

  /** Show `url`. The new picture replaces the old one only once it is decoded (no flash). */
  async function setSource(url) {
    const my = ++token;
    const r = iw && isZoomed() ? rel() : null;
    const next = makeImg();
    try { await loadImg(next, url); } catch { return false; }
    if (my !== token || destroyed) return false;
    img.replaceWith(next);
    img = next;
    iw = next.naturalWidth || 1;
    ih = next.naturalHeight || 1;
    img.style.width = `${iw}px`;
    img.style.height = `${ih}px`;
    if (r) restore(r); else fitView();
    note.hidden = true;
    return true;
  }

  function showMessage(text, action = null) {
    note.replaceChildren(el('div', { html: icon('warning', { size: 30 }) }), el('p', {}, text),
      action ? el('button', { type: 'button', class: 'btn btn-sm', onclick: action.onclick }, action.label) : null);
    note.hidden = false;
  }

  function endGesture() { g = null; stage.classList.remove('gesturing'); }

  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try { stage.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    pts.set(e.pointerId, local(e));
    stage.classList.add('gesturing');
    stage.classList.remove('animating');
    if (pts.size === 1) {
      const p = pts.get(e.pointerId);
      g = { kind: 'one', x0: p.x, y0: p.y, tx0: tx, ty0: ty, t0: performance.now(), moved: false, afterPinch: false, mouse: e.pointerType === 'mouse' };
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      g = { kind: 'pinch', d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, s0: s, tx0: tx, ty0: ty };
      swipeDx = 0;
      clearTimeout(tapTimer);
      lastTap = null;
    }
  }

  function onMove(e) {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, local(e));
    if (!g) return;
    if (g.kind === 'pinch') {
      if (pts.size < 2) return;
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const ix = (g.m0.x - g.tx0) / g.s0;
      const iy = (g.m0.y - g.ty0) / g.s0;
      s = clamp(g.s0 * d / g.d0, fitS * 0.7, maxS());
      tx = m.x - ix * s;
      ty = m.y - iy * s;
      apply();
      return;
    }
    const p = pts.get(e.pointerId);
    const dx = p.x - g.x0;
    const dy = p.y - g.y0;
    if (!g.moved && Math.hypot(dx, dy) > 8) g.moved = true;
    if (!g.moved) return;
    if (isZoomed() || g.afterPinch) {
      tx = g.tx0 + dx;
      ty = g.ty0 + dy;
      bound();
      apply();
    } else if (onSwipe && Math.abs(dx) > Math.abs(dy)) {
      swipeDx = dx * 0.45;
      apply();
    }
  }

  function onUp(e) {
    if (!pts.has(e.pointerId)) return;
    const p = pts.get(e.pointerId);
    pts.delete(e.pointerId);
    if (!g) return;
    const cancelled = e.type === 'pointercancel';
    if (g.kind === 'pinch') {
      if (pts.size >= 2) return;
      if (pts.size === 1) {
        // One finger is still down: carry on as a pan with it.
        const [q] = [...pts.values()];
        g = { kind: 'one', x0: q.x, y0: q.y, tx0: tx, ty0: ty, t0: performance.now(), moved: true, afterPinch: true };
        return;
      }
      endGesture();
      animated(() => { if (s < fitS) fitView(); else { bound(); apply(); } });
      return;
    }
    if (pts.size) return;
    const dx = p.x - g.x0;
    const dy = p.y - g.y0;
    const dt = performance.now() - g.t0;
    const wasTap = !cancelled && !g.moved && dt < 400;
    const canSwipe = !cancelled && onSwipe && g.moved && !g.afterPinch && !isZoomed();
    const mouse = g.mouse;
    endGesture();
    if (wasTap) { handleTap(p, mouse); return; }
    if (canSwipe) {
      const fast = Math.abs(dx) / Math.max(dt, 1) > 0.45;
      if (Math.abs(dx) > Math.abs(dy) * 1.4 && (Math.abs(dx) > 70 || (fast && Math.abs(dx) > 30))) {
        swipeDx = 0;
        apply();
        onSwipe(dx < 0 ? 'next' : 'prev');
        return;
      }
    }
    animated(() => { swipeDx = 0; bound(); apply(); });
  }

  function handleTap(p, mouse) {
    const now = performance.now();
    if (lastTap && now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 36) {
      clearTimeout(tapTimer);
      lastTap = null;
      animated(() => { if (isZoomed()) fitView(); else zoomTo(fitS * 2.5, p.x, p.y); });
      return;
    }
    lastTap = { t: now, x: p.x, y: p.y };
    clearTimeout(tapTimer);
    // A single tap (not the first half of a double tap) shows the photo bigger — on touch only.
    tapTimer = setTimeout(() => { lastTap = null; if (!mouse) onTap?.(); }, 320);
  }

  function onWheel(e) {
    if (!iw) return;
    e.preventDefault();
    const p = local(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    zoomTo(s * Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y);
  }

  function onKey(e) {
    if (e.key === '+' || e.key === '=') { e.preventDefault(); animated(() => zoomTo(s * 1.5, cw / 2, ch / 2)); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); animated(() => zoomTo(s / 1.5, cw / 2, ch / 2)); }
    else if (e.key === '0') { e.preventDefault(); animated(fitView); }
  }

  const noGesture = (e) => e.preventDefault(); // iOS: no page zoom on top of ours
  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', onUp);
  stage.addEventListener('wheel', onWheel, { passive: false });
  stage.addEventListener('keydown', onKey);
  stage.addEventListener('gesturestart', noGesture);
  const ro = observeResize(stage, () => {
    if (!iw) return;
    const r = isZoomed() ? rel() : null;
    if (r) restore(r); else fitView();
  });

  return {
    el: stage,
    setSource,
    showMessage,
    hasImage: () => iw > 0,
    isZoomed,
    fit: () => animated(fitView),
    destroy() {
      destroyed = true;
      ++token;
      ro.disconnect();
      clearTimeout(tapTimer);
      clearTimeout(animTimer);
      stage.removeEventListener('pointerdown', onDown);
      stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerup', onUp);
      stage.removeEventListener('pointercancel', onUp);
      stage.removeEventListener('wheel', onWheel);
      stage.removeEventListener('keydown', onKey);
      stage.removeEventListener('gesturestart', noGesture);
      img.removeAttribute('src');
      stage.remove();
    },
  };
}

// ---- the screen -------------------------------------------------------------------------------

/**
 * Open the item screen (docs/SPEC.md §3, §10). Returns its cleanup.
 * ctx.query.move === '1' opens "Move pin" straight away; ctx.query.focus ===
 * 'text' puts the caret in the Notes box (a new note from the Note button).
 */
export async function open(ctx) {
  const { root, params } = ctx;
  const app = ctx.app || {};
  const pid = params.pid;
  const iid = params.iid;
  const bus = app.bus || appBus;
  const getSettings = app.getSettings || readSettings;
  const cache = app.cache || null;
  root.classList.add('item-screen');

  // Everything that must be undone when the screen closes.
  const offs = [];
  const listen = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    offs.push(() => target.removeEventListener(type, fn, opts));
  };
  const scope = store.createUrlScope();
  let disposed = false;
  let gone = false;               // the item was erased elsewhere while open

  // ---- top bar (shown while loading too) ----
  const h1 = el('h1', {}, 'Loading…');
  const sub = el('div', { class: 'sub' });
  const backBtn = iconButton('back', { title: 'Back', onclick: () => ctx.back(`p/${pid}`) });
  const prevBtn = iconButton('back', { title: 'Previous', cls: 'icon-btn item-nav-btn', onclick: () => go(-1) });
  const nextBtn = iconButton('forward', { title: 'Next', cls: 'icon-btn item-nav-btn', onclick: () => go(1) });
  const moreBtn = iconButton('more', { title: 'More', onclick: () => openMenu() });
  prevBtn.disabled = true;
  nextBtn.disabled = true;
  moreBtn.disabled = true;
  const main = el('div', { class: 'item-main' },
    el('div', { class: 'item-loading', role: 'status' }, el('div', { class: 'spinner' }), el('span', {}, 'Opening…')));
  root.append(
    el('header', { class: 'topbar' }, backBtn, el('div', { class: 'topbar-title' }, h1, sub),
      el('div', { class: 'item-nav', role: 'group', 'aria-label': 'Previous and next' }, prevBtn, nextBtn), moreBtn),
    main);

  function showGone(title, message) {
    h1.textContent = title;
    sub.textContent = '';
    main.replaceChildren(el('div', { class: 'empty item-gone' },
      el('div', { html: icon('info', { size: 40 }) }),
      el('h2', {}, title),
      el('p', {}, message),
      el('button', { type: 'button', class: 'btn btn-primary', onclick: () => ctx.navigate(`p/${pid}`, { replace: true }) }, 'Back to the job walk')));
  }

  // ---- load ----
  let project = null;
  let item = null;
  let siblings = [];
  try {
    [project, item] = await Promise.all([store.getProject(pid), store.getItem(iid)]);
    if (item) siblings = await store.listItems(pid);
  } catch (err) {
    if (ctx.isCurrent()) showGone('This could not be opened', `${err.message} Your photos and notes are safe on this phone.`);
    return () => scope.release();
  }
  if (!ctx.isCurrent()) { scope.release(); return null; }
  if (!project || !item || item.projectId !== pid) {
    showGone('Not on this phone', 'This photo, video or note is not on this phone. It may have been deleted for good from Recently Deleted.');
    return () => scope.release();
  }

  let level = store.getLevel(project, item.levelId);
  let nav = { prev: null, next: null, index: -1, count: 0 };
  const base = { title: item.title || '', text: item.text || '' }; // what the store held when last read/saved
  const blobs = { key: '', original: null, annotated: null, originalError: null }; // Blob handles, ready for Share (iOS needs them before the tap)
  root.classList.add(`is-${item.type}`);

  const media = el('div', { class: 'item-media' });
  const details = el('div', { class: 'item-details' });
  main.replaceChildren(media, details);

  const kindWord = () => typeLabel(item.type).toLowerCase();
  const levelKind = () => (level?.plan ? 'plan' : 'map'); // where a pin is placed by hand on this level

  function geoOf(it) {
    const g = it?.pose?.geo;
    if (g && finite(g.lat, g.lng)) return g;
    const p = (it?.track || []).find((q) => q && finite(q.lat, q.lng));
    return p ? { lat: p.lat, lng: p.lng, acc: p.acc ?? null } : null;
  }
  function hasPin() {
    return levelKind() === 'plan' ? !!(item.pose?.plan && finite(item.pose.plan.x, item.pose.plan.y)) : !!item.pose?.geo && !!geoOf(item);
  }
  // A video with a path is placed by its path; moving one pin would not mean much.
  const canMovePin = () => !(item.type === 'video' && (hasPlanTrack(item) || hasGeoTrack(item)));

  // ================= media: photo =================

  let viewer = null;
  let showMarkup = true;
  let photoKey = 0; // the latest showPhoto() call; older ones stop when it changes
  const segMarkup = el('button', { type: 'button', onclick: () => setMarkup(true) }, 'Markup');
  const segOriginal = el('button', { type: 'button', onclick: () => setMarkup(false) }, 'Original');
  const seg = el('div', { class: 'seg item-seg', role: 'group', 'aria-label': 'Show' }, segMarkup, segOriginal);
  const expandBtn = el('button', {
    type: 'button', class: 'item-media-btn', title: 'Bigger', 'aria-label': 'Show the photo full screen',
    onclick: () => setImmersive(!root.classList.contains('immersive')), html: icon('fit', { size: 20 }),
  });
  const spinBadge = el('div', { class: 'item-media-spin', hidden: true }, el('div', { class: 'spinner' }));

  function buildPhoto() {
    viewer = createZoomViewer(media, {
      label: `Photo #${item.seq}`,
      onSwipe: (dir) => go(dir === 'next' ? 1 : -1),
      onTap: () => setImmersive(!root.classList.contains('immersive')),
    });
    media.append(el('div', { class: 'item-media-tools' }, seg, el('div', { class: 'spacer' }), expandBtn), spinBadge);
    showPhoto();
  }

  function setMarkup(on) {
    if (showMarkup === on) return;
    showMarkup = on;
    showPhoto();
  }

  function setImmersive(on) {
    root.classList.toggle('immersive', on);
    expandBtn.innerHTML = icon(on ? 'close' : 'fit', { size: 20 });
    expandBtn.title = on ? 'Show the details' : 'Bigger';
    expandBtn.setAttribute('aria-label', on ? 'Show the details' : 'Show the photo full screen');
  }

  async function showPhoto() {
    const m = item.media || {};
    const marked = !!m.annotated;
    const useMarkup = marked && showMarkup;
    seg.hidden = !marked;
    segMarkup.classList.toggle('on', useMarkup);
    segMarkup.setAttribute('aria-pressed', String(useMarkup));
    segOriginal.classList.toggle('on', !useMarkup);
    segOriginal.setAttribute('aria-pressed', String(!useMarkup));
    const fullId = useMarkup ? m.annotated : m.original;
    const thumbId = useMarkup ? m.annotatedThumb : m.thumb;
    const my = ++photoKey;
    spinBadge.hidden = false;
    try {
      // The small thumbnail first (instant), then the full photo over it.
      if (!viewer.hasImage() && thumbId) {
        const tu = await scope.url(thumbId);
        if (photoKey !== my || disposed) return;
        if (tu) await viewer.setSource(tu);
      }
      const fu = fullId ? await scope.url(fullId) : null;
      if (photoKey !== my || disposed) return;
      if (!fu) {
        viewer.showMessage(useMarkup ? 'The marked-up copy is missing. Tap Original to see the photo.' : 'The photo file is missing on this phone.');
        return;
      }
      const ok = await viewer.setSource(fu);
      if (!ok && photoKey === my && !disposed) {
        viewer.showMessage('This photo could not be shown here. It is still saved — Download keeps a copy.', { label: 'Download', onclick: () => doDownload(useMarkup ? 'annotated' : 'original') });
      }
    } catch (err) {
      if (!disposed) viewer.showMessage(`This photo could not be shown: ${err.message}`);
    } finally {
      if (photoKey === my) spinBadge.hidden = true;
    }
  }

  // ================= media: video =================

  let video = null;
  let videoUrl = null;            // the player's object URL, revoked at cleanup
  let pendingSeek = null;
  let raf = 0;
  const videoMsg = el('div', { class: 'zv-msg', hidden: true });

  async function buildVideo() {
    video = el('video', {
      class: 'item-video', controls: true, playsinline: true, 'webkit-playsinline': true, preload: 'metadata',
      'aria-label': `Video #${item.seq}`,
    });
    video.playsInline = true;
    const wrap = el('div', { class: 'item-video-wrap' }, video, videoMsg);
    media.append(wrap);
    listen(video, 'timeupdate', () => syncPlayback());
    listen(video, 'seeked', () => syncPlayback());
    listen(video, 'play', startRaf);
    listen(video, 'pause', stopRaf);
    listen(video, 'ended', stopRaf);
    listen(video, 'loadedmetadata', () => {
      if (pendingSeek == null) return;
      try { video.currentTime = pendingSeek; } catch { /* not seekable yet */ }
      pendingSeek = null;
    });
    listen(video, 'error', () => showVideoProblem());
    // Swipes that start on the player's own controls (the bottom strip) are scrubbing, not paging.
    offs.push(attachSwipe(wrap, (dir) => go(dir === 'next' ? 1 : -1), { ignore: (e) => e.clientY > wrap.getBoundingClientRect().bottom - 84 }));
    const m = item.media || {};
    try {
      // The player plays the same Blob that refreshBlobs reads for Share and
      // Download, not a second read of its own: a long walk-through video is
      // hundreds of MB, and two copies can close Safari's tab. Only the small
      // poster goes through the URL scope.
      const [poster] = await Promise.all([scope.url(m.poster), refreshBlobs()]);
      if (disposed) return;
      if (poster) video.poster = poster;
      if (!blobs.original) {
        showVideoProblem(blobs.originalError ? `The video could not be opened: ${blobs.originalError.message || blobs.originalError}` : 'The video file is missing on this phone.');
        return;
      }
      videoUrl = URL.createObjectURL(blobs.original);
      video.src = videoUrl;
    } catch (err) {
      if (!disposed) showVideoProblem(`The video could not be opened: ${err.message}`);
    }
  }

  function showVideoProblem(text) {
    if (disposed) return;
    const webm = /webm/i.test(item.mimeType || blobs.original?.type || '');
    const msg = text || (webm && isIOS()
      ? 'This video was recorded as WebM, which this iPhone cannot play. It is kept safe — download it, or watch it on a computer.'
      : 'This video cannot be played here. It is kept safe on this phone — download it to watch it on a computer.');
    videoMsg.replaceChildren(el('div', { html: icon('warning', { size: 30 }) }), el('p', {}, msg),
      el('button', { type: 'button', class: 'btn btn-sm', onclick: () => doDownload('original') }, el('span', { html: icon('download', { size: 18 }) }), 'Download video'));
    videoMsg.hidden = false;
  }

  function syncPlayback(tMs) {
    if (!video) return;
    const t = Number.isFinite(tMs) ? tMs : (video.currentTime || 0) * 1000;
    for (const v of [track?.view, overlay?.view]) {
      if (!v?.setPlayback) continue;
      try { v.setPlayback(item, t); } catch (err) { console.warn('[item] playback marker', err); }
    }
  }
  function startRaf() {
    if (raf) return;
    const tick = () => {
      raf = 0;
      if (!video || video.paused || video.ended || disposed) return;
      syncPlayback();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }
  function stopRaf() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    syncPlayback();
  }

  // ================= media: note =================

  function buildNote() {
    const hero = el('div', { class: 'item-note-hero' },
      el('div', { class: 'item-note-ic', html: icon('note', { size: 40 }) }),
      el('div', {}, el('div', { class: 'item-note-k' }, `Note #${item.seq}`), el('div', { class: 'item-note-s' }, formatDateTime(item.createdAt))));
    media.append(hero);
    offs.push(attachSwipe(hero, (dir) => go(dir === 'next' ? 1 : -1)));
  }

  // ================= details: banner, title, actions =================

  const deletedBanner = el('div', { class: 'banner warn item-banner', hidden: true });
  function renderBanner() {
    if (!item.deletedAt) { deletedBanner.hidden = true; return; }
    deletedBanner.replaceChildren(el('span', { html: icon('trash', { size: 18 }) }),
      el('div', { class: 'grow' }, `This ${kindWord()} is in Recently Deleted.`),
      el('button', { type: 'button', class: 'btn btn-sm', onclick: () => doRestore() }, 'Restore'));
    deletedBanner.hidden = false;
  }

  const titleInput = el('input', {
    class: 'item-title', type: 'text', maxlength: '200', enterkeyhint: 'done', autocomplete: 'off',
    autocapitalize: 'sentences', spellcheck: 'true', 'aria-label': 'Title',
    placeholder: item.type === 'note' ? 'Add a title' : `Add a title — e.g. ${item.type === 'video' ? 'Walk of the east wall' : 'Header over garage door'}`,
  });
  titleInput.value = base.title;

  function actionButton(name, label, onclick, cls = '') {
    return el('button', { type: 'button', class: `item-action ${cls}`, onclick },
      el('span', { html: icon(name, { size: 24 }) }), el('span', {}, label));
  }
  const actMarkup = actionButton('pen', 'Mark up', () => doMarkup());
  const actShare = actionButton('share', 'Share', () => doShare());
  const actDownload = actionButton('download', 'Download', () => doDownload('original'));
  const actDelete = actionButton('trash', 'Delete', () => doDelete(), 'danger');
  const actRestore = actionButton('restore', 'Restore', () => doRestore(), 'ok');
  const actions = el('div', { class: 'item-actions' });
  function renderActions() {
    const list = [];
    if (item.type === 'photo' && !item.deletedAt) list.push(actMarkup);
    list.push(actShare, actDownload, item.deletedAt ? actRestore : actDelete);
    actions.replaceChildren(...list);
    actions.style.setProperty('--n', String(list.length));
    actMarkup.disabled = !item.media?.original;
  }

  function section(title, extra, ...children) {
    return el('section', { class: 'item-section' },
      el('div', { class: 'item-section-head' }, el('h2', {}, title), extra || null), ...children);
  }

  // ================= tags =================

  let defaultTags = [...FALLBACK_TAGS];
  const tagPending = new Map(); // tag → wanted on/off, while its save is in flight
  const tagRow = el('div', { class: 'chip-row item-tags', role: 'group', 'aria-label': 'Tags' });

  function allTags() {
    const extra = new Set();
    for (const s of siblings) for (const t of s.tags || []) extra.add(t);
    for (const t of item.tags || []) extra.add(t);
    for (const t of tagPending.keys()) extra.add(t);
    for (const t of defaultTags) extra.delete(t);
    return [...defaultTags, ...[...extra].sort((a, b) => a.localeCompare(b))];
  }

  function renderTags() {
    const has = new Set(item.tags || []);
    const chips = allTags().map((t) => {
      const pending = tagPending.has(t);
      const on = pending ? tagPending.get(t) : has.has(t);
      return el('button', {
        type: 'button', class: `chip item-tag${on ? ' on' : ''}${pending ? ' pending' : ''}`, 'aria-pressed': String(on),
        onclick: () => setTag(t, !on),
      }, on ? el('span', { html: icon('check', { size: 15 }) }) : null, t);
    });
    tagRow.replaceChildren(...chips,
      el('button', { type: 'button', class: 'chip item-tag item-tag-add', onclick: () => addCustomTag() },
        el('span', { html: icon('plus', { size: 15 }) }), 'Tag'));
  }

  async function setTag(tag, want) {
    tagPending.set(tag, want);
    renderTags();
    buzz(8);
    try {
      const saved = await store.updateItem(iid, (cur) => {
        const set = new Set(cur.tags || []);
        if (want) set.add(tag); else set.delete(tag);
        cur.tags = [...set];
      });
      if (tagPending.get(tag) === want) tagPending.delete(tag);
      applyItem(saved);
      renderTags();
    } catch (err) {
      if (tagPending.get(tag) === want) tagPending.delete(tag);
      if (!disposed) renderTags();
      toast(`The tag could not be saved: ${err.message}`, { type: 'err' });
    }
  }

  async function addCustomTag() {
    const typed = await promptDialog({ title: 'Add a tag', label: 'Tag', placeholder: 'e.g. Fire blocking', okText: 'Add' });
    if (disposed) return;
    const tag = cleanTag(typed, allTags());
    if (!tag) return;
    if ((item.tags || []).includes(tag)) { toast(`"${tag}" is already on this ${kindWord()}.`); return; }
    setTag(tag, true);
  }

  // ================= notes (typed, autosaved) =================

  const notes = el('textarea', {
    class: 'input item-notes', rows: '5', 'aria-label': 'Notes', autocapitalize: 'sentences', spellcheck: 'true',
    placeholder: 'What needs pricing here? Sizes, spans, counts, questions for the GC…',
  });
  notes.value = base.text;
  const saveState = el('span', { class: 'item-save', 'aria-live': 'polite' });
  const dictBtn = el('button', { type: 'button', class: 'btn btn-sm item-dictate', hidden: true, onclick: () => toggleDictation() });
  const interim = el('div', { class: 'item-interim', hidden: true, 'aria-live': 'polite' });

  function autoGrow() {
    notes.style.height = 'auto';
    notes.style.height = `${Math.max(132, notes.scrollHeight + 2)}px`;
  }

  let errorShown = false;
  const autosaver = createAutosaver({ save: saveFields, onState: showSaveState });

  async function saveFields(values) {
    let conflict = false;
    const saved = await store.updateItem(iid, (cur) => {
      for (const field of ['title', 'text']) {
        if (!(field in values)) continue;
        const r = mergeText(base[field], values[field], cur[field] || '');
        if (r.conflict) conflict = true;
        cur[field] = r.text;
      }
    });
    for (const [field, input] of [['title', titleInput], ['text', notes]]) {
      if (!(field in values)) continue;
      if ((saved[field] || '') === values[field]) { base[field] = values[field]; continue; }
      // Another window changed it too: the merged text is what is saved now.
      if (input.value === values[field]) {
        input.value = saved[field] || '';
        base[field] = saved[field] || '';
        if (field === 'text') autoGrow();
      } else {
        base[field] = values[field]; // newer typing is merged again on the next save
      }
    }
    if (conflict) toast('This note was also changed in another window. Both versions are kept in the note.', { type: 'warn', ms: 8000 });
    applyItem(saved);
    return saved;
  }

  function showSaveState(st, err) {
    saveState.className = 'item-save';
    if (st === 'saving') {
      saveState.replaceChildren('Saving…');
    } else if (st === 'saved') {
      errorShown = false;
      // Only now (nothing waiting, nothing in flight) is the safety copy no longer needed.
      clearDraftIfSaved();
      saveState.classList.add('ok');
      saveState.replaceChildren(el('span', { html: icon('check', { size: 16 }) }), 'Saved');
    } else if (st === 'error') {
      saveState.classList.add('err');
      saveState.replaceChildren(el('button', { type: 'button', class: 'item-save-retry', onclick: () => autosaver.flush().catch(() => {}) },
        el('span', { html: icon('warning', { size: 16 }) }), 'Not saved — tap to retry'));
      if (!errorShown && !disposed) {
        toast(`Your note could not be saved yet: ${err?.message || 'the phone did not say why.'} A copy is kept on this phone and it will try again.`, { type: 'err' });
      }
      errorShown = true;
    } else if (st === 'dirty' && !errorShown) {
      saveState.replaceChildren();
    }
  }

  // The safety copy in localStorage (see the header).
  const draftKey = DRAFT_PREFIX + iid;
  function writeDraft() {
    try {
      localStorage.setItem(draftKey, JSON.stringify({
        at: Date.now(), title: titleInput.value, titleBase: base.title, text: notes.value, textBase: base.text,
      }));
    } catch { /* private mode or full: the store save still runs */ }
  }
  function clearDraftIfSaved() {
    if (autosaver.dirty || titleInput.value !== base.title || notes.value !== base.text) return;
    try { localStorage.removeItem(draftKey); } catch { /* nothing kept */ }
  }
  function restoreDraft() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(draftKey) || 'null'); } catch { d = null; }
    if (!d || typeof d !== 'object') return;
    let restored = 0;
    for (const [field, input] of [['title', titleInput], ['text', notes]]) {
      if (typeof d[field] !== 'string') continue;
      const stored = item[field] || '';
      if (d[field] === stored) continue;
      const draftBase = typeof d[`${field}Base`] === 'string' ? d[`${field}Base`] : stored;
      const r = mergeText(draftBase, d[field], stored);
      if (r.text === stored) continue;
      input.value = r.text;
      autosaver.set(field, r.text);
      restored++;
    }
    if (!restored) {
      try { localStorage.removeItem(draftKey); } catch { /* nothing kept */ }
      return;
    }
    autoGrow();
    autosaver.flush()
      .then(() => toast('Words you typed earlier had not finished saving. They are back and saved now.', { type: 'ok', ms: 7000 }))
      .catch(() => { /* the save state shows it, and it retries */ });
  }

  function onTyped(field, input) {
    writeDraft();
    autosaver.set(field, input.value);
    if (field === 'text') autoGrow();
  }

  // ================= dictation =================

  let dictation = null;
  let dictating = false;
  let caret = null; // where dictated words go: the last cursor position in the note

  function rememberCaret() {
    caret = { start: notes.selectionStart ?? notes.value.length, end: notes.selectionEnd ?? notes.value.length };
  }

  function setupDictation() {
    dictation = createDictation({
      onText: (t) => insertDictated(t),
      onInterim: (t) => { interim.textContent = t ? `“${t}…”` : ''; interim.hidden = !t; },
      onEnd: () => { dictating = false; interim.hidden = true; if (!disposed) renderRec(); },
      onError: (err) => { if (!disposed) toast(err.message, { type: 'warn', ms: 8000 }); },
    });
    dictBtn.hidden = !dictation;
  }

  function renderDictate() {
    dictBtn.classList.toggle('on', dictating);
    dictBtn.disabled = !dictating && recState !== 'idle';
    dictBtn.setAttribute('aria-pressed', String(dictating));
    dictBtn.replaceChildren(
      dictating ? el('span', { class: 'item-live-dot' }) : el('span', { html: icon('mic', { size: 18 }) }),
      dictating ? 'Stop dictating' : 'Dictate');
  }

  function toggleDictation() {
    if (!dictation) return;
    if (dictating) {
      dictating = false;
      dictation.stop();
      renderRec();
      return;
    }
    if (recState !== 'idle') return;
    stopPlayer();
    if (!caret) caret = { start: notes.value.length, end: notes.value.length };
    dictating = true;
    renderRec();
    dictation.start();
  }

  function stopDictation() {
    if (!dictation || !dictating) return;
    dictating = false;
    dictation.stop();
    if (!disposed) renderRec();
  }

  function insertDictated(text) {
    const v = notes.value;
    const s = clamp(caret?.start ?? v.length, 0, v.length);
    const e = clamp(caret?.end ?? s, s, v.length);
    const ins = joinDictated(v.slice(0, s), text, v.slice(e));
    if (!ins) return;
    notes.value = v.slice(0, s) + ins + v.slice(e);
    caret = { start: s + ins.length, end: s + ins.length };
    if (document.activeElement === notes) {
      try { notes.setSelectionRange(caret.start, caret.end); } catch { /* not focusable now */ }
    }
    onTyped('text', notes);
    // Words that arrive after the screen closed are saved at once.
    if (disposed) autosaver.flush().catch(() => {});
  }

  // ================= voice notes =================

  let recState = 'idle';          // 'idle' | 'starting' | 'recording' | 'saving'
  let recorder = null;
  let recStartedAt = 0;
  let recTick = null;
  let recRaf = 0;
  let recLimit = null;
  let savingVoice = null;         // the save of the last recording, while it runs
  let hiddenSaved = false;        // a recording was saved because the app went to the background
  const recorderOk = typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  const unsavedVoice = [];        // recordings that could not be saved: kept in memory to retry or download
  let recorderMod = null;         // js/core/recorder.js, loaded ahead of the first tap

  function preloadRecorder() {
    if (!recorderOk || recorderMod) return;
    loaders.recorder().then((m) => { recorderMod = m; }).catch((err) => console.warn('[item] the voice recorder did not load yet', err));
  }

  const recBtn = el('button', { type: 'button', class: 'item-rec-btn', onclick: () => (recState === 'recording' ? stopRecording() : startRecording()) });
  const recLabel = el('div', { class: 'item-rec-label' });
  const recSub = el('div', { class: 'item-rec-sub' });
  const recLevel = el('div', { class: 'item-rec-level' });
  const recMeter = el('div', { class: 'item-rec-meter', hidden: true, 'aria-hidden': 'true' }, recLevel);
  const recPanel = el('div', { class: 'item-rec' }, recBtn, el('div', { class: 'item-rec-info' }, recLabel, recSub, recMeter));
  const unsavedBox = el('div', { class: 'item-unsaved' });
  const voiceList = el('div', { class: 'item-voice-list' });

  function renderRec() {
    const st = recState;
    recPanel.classList.toggle('recording', st === 'recording');
    recPanel.classList.toggle('busy', st === 'starting' || st === 'saving');
    recBtn.disabled = !recorderOk || st === 'starting' || st === 'saving' || (dictating && st === 'idle');
    recBtn.innerHTML = icon(st === 'recording' ? 'stop' : 'mic', { size: 28 });
    recBtn.setAttribute('aria-label', st === 'recording' ? 'Stop and save the voice note' : 'Record a voice note');
    recMeter.hidden = st !== 'recording';
    if (!recorderOk) {
      recLabel.textContent = 'Voice notes cannot be recorded in this browser';
      recSub.textContent = 'Dictate or type the note instead.';
    } else if (st === 'starting') {
      recLabel.textContent = 'Starting the microphone…';
      recSub.textContent = '';
    } else if (st === 'recording') {
      renderRecTime();
      recSub.textContent = 'Tap the button again to stop and save.';
    } else if (st === 'saving') {
      recLabel.textContent = 'Saving the voice note…';
      recSub.textContent = '';
    } else {
      recLabel.textContent = 'Record a voice note';
      recSub.textContent = dictating ? 'Stop dictating first.' : 'Tap to start, tap again to stop and save.';
    }
    renderDictate();
  }
  function renderRecTime() {
    recLabel.textContent = `Recording ${formatDuration((performance.now() - recStartedAt) / 1000)}`;
  }
  function meterLoop() {
    const tick = () => {
      recRaf = 0;
      if (recState !== 'recording' || !recorder) return;
      let lv = 0;
      try { lv = typeof recorder.level === 'function' ? clamp(Number(recorder.level()) || 0, 0, 1) : 0; } catch { lv = 0; }
      recLevel.style.transform = `scaleX(${Math.max(0.03, lv).toFixed(3)})`;
      recRaf = requestAnimationFrame(tick);
    };
    recRaf = requestAnimationFrame(tick);
  }

  async function startRecording() {
    if (recState !== 'idle' || !recorderOk) return;
    stopDictation();
    stopPlayer();
    recState = 'starting';
    renderRec();
    let rec = null;
    try {
      // Normally loaded at open (preloadRecorder), so start() still runs inside
      // the tap: iPhone only lets sound start from one.
      const mod = recorderMod || (recorderMod = await loaders.recorder().catch(() => null));
      if (typeof mod?.createAudioRecorder !== 'function') {
        const e = new Error('Voice recording could not be loaded. Reload the app and try again.');
        e.name = 'LoadError';
        throw e;
      }
      rec = mod.createAudioRecorder();
      await rec.start();
    } catch (err) {
      try { rec?.cancel?.(); } catch { /* never started */ }
      recState = 'idle';
      if (!disposed) { renderRec(); toast(err?.name === 'LoadError' ? err.message : micErrorMessage(err), { type: 'err' }); }
      return;
    }
    if (disposed) { // left while the microphone was starting: nothing has been said yet
      try { rec.cancel(); } catch { /* gone */ }
      return;
    }
    recorder = rec;
    recStartedAt = performance.now();
    recState = 'recording';
    buzz(20);
    renderRec();
    recTick = setInterval(renderRecTime, 250);
    recLimit = setTimeout(() => {
      stopRecording().then((ok) => {
        if (ok) toast('Voice notes stop at 15 minutes — that one is saved. Tap Record to keep going.', { ms: 7000 });
      });
    }, MAX_VOICE_MS);
    meterLoop();
  }

  /** Stop and save. Resolves true when the recording is saved (or there was nothing to save). */
  function stopRecording({ quiet = false } = {}) {
    if (recState === 'saving' && savingVoice) return savingVoice;
    if (recState !== 'recording' || !recorder) return Promise.resolve(true);
    const rec = recorder;
    recorder = null;
    recState = 'saving';
    clearInterval(recTick); recTick = null;
    clearTimeout(recLimit); recLimit = null;
    cancelAnimationFrame(recRaf); recRaf = 0;
    if (!disposed) renderRec();
    savingVoice = (async () => {
      let result;
      try {
        result = await rec.stop();
      } catch (err) {
        toast(`The voice note could not be finished: ${err.message}`, { type: 'err' });
        return false;
      }
      return saveVoice(result, null, { quiet });
    })().finally(() => {
      savingVoice = null;
      recState = 'idle';
      if (!disposed) renderRec();
    });
    return savingVoice;
  }

  async function saveVoice(result, retry = null, { quiet = false } = {}) {
    if (!retry && !result?.blob?.size) {
      toast('The recording was empty, so nothing was saved. Tap Record, talk for a moment, then tap Stop.', { type: 'warn' });
      return true;
    }
    try {
      const saved = await addVoiceNote(iid, result);
      const at = retry ? unsavedVoice.indexOf(retry) : -1;
      if (at >= 0) unsavedVoice.splice(at, 1);
      applyItem(saved);
      if (!disposed) renderUnsaved();
      if (!quiet) toast('Voice note saved', { type: 'ok' });
      buzz(15);
      return true;
    } catch (err) {
      const entry = retry || { blob: result.blob, duration: result.duration, mimeType: result.mimeType || result.blob.type, at: Date.now() };
      entry.error = err.message;
      if (!retry) unsavedVoice.push(entry);
      if (!disposed) renderUnsaved();
      toast(`The voice note could not be saved: ${err.message} It is kept here — tap Try again.`, { type: 'err' });
      return false;
    }
  }

  function renderUnsaved() {
    unsavedBox.replaceChildren(...unsavedVoice.map((u) => el('div', { class: 'banner err item-unsaved-row' },
      el('span', { html: icon('warning', { size: 18 }) }),
      el('div', { class: 'grow' },
        el('div', { class: 'item-unsaved-t' }, `A voice note${u.duration ? ` (${formatDuration(u.duration)})` : ''} is not saved yet`),
        el('div', { class: 'small muted' }, u.error || '')),
      el('div', { class: 'item-unsaved-btns' },
        el('button', { type: 'button', class: 'btn btn-sm', onclick: () => saveVoice(u, u) }, 'Try again'),
        el('button', {
          type: 'button', class: 'btn btn-sm btn-ghost',
          onclick: () => saveBlob(u.blob, safeFileName(`Voice note #${item.seq} ${formatDateTime(u.at)}`) + extForMime(u.mimeType), { preferShare: isIOS() }),
        }, 'Download')))));
  }

  // Playback: one audio element for the screen.
  let player = null;
  let playingId = null;
  const voiceRows = new Map();   // voice id → {row, btn, bar, n, v}
  const voiceUrls = new Map();   // media id → object URL, fetched ahead so play starts inside the tap (iPhone)

  function ensurePlayer() {
    if (player) return player;
    player = new Audio();
    player.preload = 'auto';
    listen(player, 'timeupdate', updateVoiceProgress);
    listen(player, 'play', renderPlayState);
    listen(player, 'pause', renderPlayState);
    listen(player, 'ended', () => { playingId = null; renderPlayState(); });
    listen(player, 'error', () => {
      if (!playingId) return;
      playingId = null;
      renderPlayState();
      toast('This recording cannot be played on this phone. It is kept, and included when the job walk is exported.', { type: 'warn', ms: 7000 });
    });
    return player;
  }

  async function playVoice(v) {
    const p = ensurePlayer();
    if (playingId === v.id) {
      if (p.paused) p.play().catch((err) => playFailed(err));
      else p.pause();
      return;
    }
    stopDictation();
    let url = voiceUrls.get(v.mediaId);
    if (!url) {
      url = await scope.url(v.mediaId);
      if (!url) { toast('This recording is missing on this phone.', { type: 'err' }); return; }
      voiceUrls.set(v.mediaId, url);
    }
    if (disposed) return;
    playingId = v.id;
    p.src = url;
    renderPlayState();
    try { await p.play(); } catch (err) { playFailed(err); }
  }
  function playFailed(err) {
    if (err?.name === 'AbortError') return; // another note was started
    playingId = null;
    renderPlayState();
    toast(err?.name === 'NotAllowedError' ? 'Tap play again to listen.' : 'This recording cannot be played on this phone. It is kept, and included when the job walk is exported.', { type: 'warn' });
  }
  function stopPlayer() {
    if (!player) return;
    try { player.pause(); } catch { /* not playing */ }
    playingId = null;
    renderPlayState();
  }
  function renderPlayState() {
    for (const [id, r] of voiceRows) {
      const current = id === playingId;
      const on = current && player && !player.paused;
      r.row.classList.toggle('playing', current);
      r.btn.innerHTML = icon(on ? 'pause' : 'play', { size: 22 });
      r.btn.setAttribute('aria-label', `${on ? 'Pause' : 'Play'} voice note ${r.n}`);
      if (!current) r.bar.style.transform = 'scaleX(0)';
    }
  }
  function updateVoiceProgress() {
    const r = voiceRows.get(playingId);
    if (!r || !player) return;
    const d = Number.isFinite(player.duration) && player.duration > 0 ? player.duration : (r.v.duration || 0);
    r.bar.style.transform = `scaleX(${d ? clamp(player.currentTime / d, 0, 1) : 0})`;
  }

  function renderVoiceNotes() {
    const list = item.voiceNotes || [];
    voiceRows.clear();
    if (!list.length) {
      voiceList.replaceChildren(el('div', { class: 'item-voice-empty' }, 'No voice notes yet. Handy with gloves on: tap the red button and talk.'));
    } else {
      voiceList.replaceChildren(...list.map((v, i) => voiceRow(v, i + 1)));
    }
    for (const v of list) {
      if (voiceUrls.has(v.mediaId)) continue;
      scope.url(v.mediaId).then((u) => { if (u) voiceUrls.set(v.mediaId, u); }).catch(() => { /* fetched again on play */ });
    }
    if (playingId && !list.some((v) => v.id === playingId)) stopPlayer();
    renderPlayState();
  }

  function voiceRow(v, n) {
    const btn = el('button', { type: 'button', class: 'item-voice-play', onclick: () => playVoice(v) });
    const bar = el('div');
    const row = el('div', { class: 'item-voice-row' }, btn,
      el('div', { class: 'grow' },
        el('div', { class: 'item-voice-t' }, `Voice note ${n}`),
        el('div', { class: 'item-voice-s' }, [formatDuration(v.duration), formatDateTime(v.createdAt)].filter(Boolean).join(' · ')),
        el('div', { class: 'item-voice-progress' }, bar)),
      iconButton('trash', { title: `Delete voice note ${n}`, cls: 'icon-btn item-voice-del', onclick: () => deleteVoice(v, n) }));
    voiceRows.set(v.id, { row, btn, bar, n, v });
    return row;
  }

  async function deleteVoice(v, n) {
    const ok = await confirmDialog({
      title: `Delete voice note ${n}?`,
      message: `Voice note ${n}${v.duration ? ` (${formatDuration(v.duration)})` : ''} will be taken off this ${kindWord()}.`,
      okText: 'Delete', danger: true,
    });
    if (!ok || disposed) return;
    if (playingId === v.id) stopPlayer();
    try {
      const saved = await removeVoiceNote(iid, v.id);
      applyItem(saved);
      toast(`Voice note ${n} deleted`, { ms: 8000, action: { label: 'Undo', onclick: () => undoVoice(v.id) } });
    } catch (err) {
      toast(`The voice note could not be deleted: ${err.message}`, { type: 'err' });
    }
  }
  async function undoVoice(voiceId) {
    try {
      const saved = await restoreVoiceNote(iid, voiceId);
      applyItem(saved);
      toast('The voice note is back', { type: 'ok' });
    } catch (err) {
      toast(`It could not be brought back: ${err.message}`, { type: 'err' });
    }
  }

  // ================= where and when =================

  const factsCard = el('div', { class: 'card item-card' });
  const faint = (t) => el('span', { class: 'faint' }, t);

  function factList(rows) {
    return el('dl', { class: 'item-facts' }, rows.filter(Boolean).map(([k, v]) =>
      el('div', { class: 'item-fact' }, el('dt', {}, k), el('dd', {}, v))));
  }

  function positionCell(pose, units) {
    const wrap = el('span', { class: 'item-pos' });
    if (!pose || (!pose.geo && !pose.plan && !pose.enu)) { wrap.append(faint('No position saved')); return wrap; }
    const acc = pose.geo?.acc;
    if (pose.planLocked) {
      wrap.append(el('span', { class: 'badge info' }, 'Placed by hand'));
      if (finite(acc)) wrap.append(faint(`GPS said ${formatAccuracy(acc, units)}`));
    } else {
      const q = qualityBadge(pose.quality);
      wrap.append(el('span', { class: `badge ${q.cls}` }, q.label));
      if (finite(acc)) wrap.append(el('span', {}, formatAccuracy(acc, units)));
    }
    if (pose.source === 'sim') wrap.append(el('span', { class: 'badge' }, 'Demo position'));
    if (level?.plan && !pose.plan && pose.geo) {
      wrap.append(el('span', { class: 'item-fact-note' }, 'GPS only — the pin shows on the plan once the plan is calibrated.'));
    }
    return wrap;
  }

  function headingCell(pose) {
    const h = pose.heading;
    return el('span', { class: 'item-heading' },
      el('span', { class: 'item-compass', style: { transform: `rotate(${normDeg(h)}deg)` }, html: icon('navigation', { size: 16 }) }),
      describeHeading(h),
      finite(pose.headingAcc) ? faint(`±${Math.round(pose.headingAcc)}°`) : null,
      pose.facing === 'top' ? el('span', { class: 'item-fact-note' }, 'The phone was flat: this is where its top edge pointed.') : null);
  }

  function gpsCell(geo, pose) {
    const coords = formatCoords(geo.lat, geo.lng);
    return el('span', { class: 'item-gps' },
      el('span', { class: 'mono' }, coords),
      el('a', { class: 'item-link', href: googleMapsUrl(geo.lat, geo.lng), target: '_blank', rel: 'noopener noreferrer' },
        el('span', { html: icon('map', { size: 16 }) }), 'Open in Google Maps'),
      el('button', {
        type: 'button', class: 'btn btn-sm btn-ghost item-copy',
        onclick: async () => toast((await copyText(coords)) ? 'Coordinates copied' : 'Could not copy — press and hold the numbers to copy them.', { type: 'info' }),
      }, 'Copy'),
      pose?.gpsGeo && finite(pose.gpsGeo.lat, pose.gpsGeo.lng)
        ? el('span', { class: 'item-fact-note' }, `Moved by hand. GPS said ${formatCoords(pose.gpsGeo.lat, pose.gpsGeo.lng)}.`)
        : null);
  }

  function renderFacts() {
    const units = getSettings().units;
    const pose = item.pose || null;
    const geo = pose?.geo && finite(pose.geo.lat, pose.geo.lng) ? pose.geo : geoOf(item);
    const isNote = item.type === 'note';
    const rows = [];
    rows.push(['When', `${formatDateTime(item.createdAt)}${item.type === 'video' && item.duration ? ` · ${formatDuration(item.duration)} long` : ''}`]);
    rows.push([isNote ? 'Added by' : 'Taken by', item.capturedBy || faint('Not recorded')]);
    rows.push(['Level', level?.name || faint('Unknown level')]);
    rows.push(['Position', positionCell(pose, units)]);
    if (finite(pose?.heading)) rows.push([item.type === 'video' ? 'Facing at start' : 'Facing', headingCell(pose)]);
    else if (!isNote) rows.push(['Facing', faint('Not recorded')]);
    const tilt = describeTilt(pose?.pitch);
    if (tilt) rows.push(['Tilt', tilt]);
    else if (!isNote) rows.push(['Tilt', faint('Not recorded')]);
    const alt = formatAltitude(pose?.geo?.alt, units);
    if (alt) {
      rows.push(['Altitude', el('span', {}, alt,
        finite(pose.geo.altAcc) ? faint(` ${formatAccuracy(pose.geo.altAcc, units)}`) : null,
        el('span', { class: 'item-fact-note' }, 'From GPS — approximate.'))]);
    }
    if (geo) rows.push(['GPS', gpsCell(geo, pose)]);
    if (SOURCE_LABEL[item.source]) rows.push(['Source', SOURCE_LABEL[item.source]]);
    factsCard.replaceChildren(factList(rows));
  }

  // The mini plan / map with this pin, created when it scrolls into view.
  const miniBox = el('div', { class: 'item-mini' });
  const miniCap = el('div', { class: 'item-cap' });
  const placeBtns = el('div', { class: 'item-place-btns' });
  const miniWrap = el('div', { class: 'item-mini-wrap' }, miniBox, miniCap, placeBtns);
  let mini = null;          // {view, key, ro, host}
  let miniToken = 0;
  let stopVisible = null;

  function captionFor(kind) {
    if (kind === 'map' && level?.plan) return 'Shown on the satellite map: this plan is not calibrated yet, so the pin goes on the plan once it is.';
    if (kind === 'plan' && item.pose?.planLocked) return 'Placed by hand on the plan.';
    return '';
  }

  function renderPlace() {
    const kind = placeKind(item, level);
    const viewKind = kind === 'plan' || kind === 'map' ? kind : null;
    const videoPath = item.type === 'video' && (hasPlanTrack(item) || hasGeoTrack(item));
    const btns = [];
    if (canMovePin()) {
      btns.push(el('button', { type: 'button', class: 'btn', onclick: () => openPlace({ move: true }) },
        el('span', { html: icon('pin', { size: 20 }) }), hasPin() ? 'Move pin' : (levelKind() === 'plan' ? 'Place on the plan' : 'Place on the map')));
    }
    if (viewKind && !videoPath) {
      btns.push(el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => openPlace({ kind: viewKind }) },
        el('span', { html: icon('fit', { size: 20 }) }), viewKind === 'plan' ? 'Open plan' : 'Open map'));
    }
    placeBtns.replaceChildren(...btns);
    miniCap.textContent = captionFor(kind);

    if (videoPath) { miniBox.hidden = true; destroyMini(); return; } // the path view at the top shows it
    miniBox.hidden = false;
    if (!viewKind) {
      destroyMini();
      miniBox.replaceChildren(el('div', { class: 'item-mini-msg' }, el('span', { html: icon('pin', { size: 28 }) }),
        el('span', {}, `No position was saved for this ${kindWord()}. Place it on the ${levelKind()} by hand.`)));
      return;
    }
    const key = `${viewKind}|${level?.plan?.mediaId || ''}`;
    if (mini && mini.key === key) {
      try { mini.view.setItems([item], { selectedId: item.id }); focusView(mini.view, viewKind, mini.host, 16); } catch (err) { console.warn('[item] mini view', err); }
      return;
    }
    destroyMini();
    const host = el('div', { class: 'item-mini-host' });
    const spin = el('div', { class: 'item-mini-msg' }, el('div', { class: 'spinner' }));
    const openBtn = el('button', { type: 'button', class: 'item-mini-open', 'aria-label': viewKind === 'plan' ? 'Open the plan' : 'Open the map', onclick: () => openPlace({ kind: viewKind }) });
    const hint = el('span', { class: 'item-mini-hint' }, el('span', { html: icon('fit', { size: 14 }) }), 'Tap to open');
    miniBox.replaceChildren(host, spin, openBtn, hint);
    const token = ++miniToken;
    stopVisible = whenVisible(miniBox, details, () => buildMini(token, viewKind, key, host, spin));
  }

  async function buildMini(token, viewKind, key, host, spin) {
    let view;
    try {
      view = await createView(viewKind, host, { interactive: false });
    } catch (err) {
      if (token !== miniToken || disposed) return;
      console.warn('[item] mini view failed', err);
      spin.replaceChildren(el('span', { html: icon('warning', { size: 24 }) }), el('span', {}, `The ${viewKind} could not be shown here: ${err.message}`));
      return;
    }
    if (token !== miniToken || disposed) { safeDestroy(view); return; }
    spin.remove();
    // A non-interactive view goes back to the whole plan when its size changes
    // (the phone turned): centre it on the pin again.
    const ro = observeResize(host, () => {
      try { view.resize?.(); focusView(view, viewKind, host, 16); } catch { /* view closing */ }
    });
    mini = { view, key, ro, host };
    try { view.setItems([item], { selectedId: item.id }); } catch (err) { console.warn('[item] mini items', err); }
    requestAnimationFrame(() => {
      if (mini?.view !== view) return;
      try { view.resize?.(); focusView(view, viewKind, host, 16); } catch (err) { console.warn('[item] mini focus', err); }
    });
  }

  function destroyMini() {
    miniToken++;
    stopVisible?.();
    stopVisible = null;
    if (!mini) return;
    mini.ro.disconnect();
    safeDestroy(mini.view);
    mini = null;
  }

  /** A plan view or map view in `host` (both loaded on demand). */
  async function createView(kind, host, { interactive = true } = {}) {
    const s = getSettings();
    if (kind === 'plan') {
      const plan = level?.plan;
      if (!plan) throw new Error('this level has no plan.');
      const [mod, image] = await Promise.all([loaders.planView(), loadPlanImage(cache, plan)]);
      if (typeof mod.createPlanView !== 'function') throw new Error('the plan viewer is missing from this version of the app.');
      return mod.createPlanView(host, {
        image, width: plan.width || image.width || image.naturalWidth, height: plan.height || image.height || image.naturalHeight,
        interactive, units: s.units, pxPerMeter: level.calibration?.pxPerMeter || undefined,
      });
    }
    const mod = await loaders.mapView();
    if (typeof mod.createMapView !== 'function') throw new Error('the map is missing from this version of the app.');
    const g = geoOf(item);
    const center = g || project.mapView || project.origin || DEFAULT_CENTER;
    const zoom = g ? 19 : (project.mapView?.zoom || (project.origin ? 18 : 16));
    return mod.createMapView(host, {
      center: { lat: center.lat, lng: center.lng }, zoom, provider: s.mapProvider, googleKey: s.googleMapsKey,
      interactive, units: s.units,
    });
  }

  /** The plan point ({x, y}) or map spot ({lat, lng}) under screen point (sx, sy) of `host`. */
  function viewPointAt(view, kind, host, sx, sy) {
    let v = null;
    try { v = view.getView?.(); } catch { v = null; }
    if (!v) return null;
    const dx = sx - host.clientWidth / 2;
    const dy = sy - host.clientHeight / 2;
    if (kind === 'plan') return finite(v.x, v.y, v.scale) && v.scale > 0 ? { x: v.x + dx / v.scale, y: v.y + dy / v.scale } : null;
    return finite(v.lat, v.lng, v.zoom) ? offsetLatLng(v, dx, dy) : null;
  }

  /** Tapping a video's path in `view` seeks the video there. Returns the remover. */
  function wireSeek(view, kind, host) {
    let lastUp = null;
    // Capture phase: runs before the view's own handler decides what was tapped.
    const onUp = (e) => {
      const r = host.getBoundingClientRect();
      lastUp = { x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() };
    };
    host.addEventListener('pointerup', onUp, true);
    const offs2 = [
      view.on?.('tap', (p) => seekToPoint(p, kind, view)),
      // A tap ON the path is reported as a tap on the item, with no point:
      // work the point out from where the finger was lifted.
      view.on?.('tapitem', (it) => {
        if (it?.id !== item.id || !lastUp || performance.now() - lastUp.t > 1500) return;
        const p = viewPointAt(view, kind, host, lastUp.x, lastUp.y);
        if (p) seekToPoint(p, kind, view);
      }),
    ];
    return () => {
      host.removeEventListener('pointerup', onUp, true);
      for (const off of offs2) if (typeof off === 'function') { try { off(); } catch { /* gone */ } }
    };
  }

  function firstPlanTrackPoint(it) {
    return (it.track || []).find((p) => p && finite(p.x, p.y)) || null;
  }

  /** Centre a view on this item's pin, zoomed to show the room around it. */
  function focusView(view, kind, host, meters = 12) {
    if (kind === 'plan') {
      const pt = item.pose?.plan && finite(item.pose.plan.x, item.pose.plan.y) ? item.pose.plan : firstPlanTrackPoint(item);
      if (!pt || !level?.plan) { view.fit?.(); return; }
      const scale = focusScale({
        cw: host.clientWidth, ch: host.clientHeight, planW: level.plan.width, planH: level.plan.height,
        pxPerMeter: level.calibration?.pxPerMeter, meters,
      });
      view.centerOn?.({ x: pt.x, y: pt.y }, scale);
    } else {
      const g = geoOf(item);
      if (g) view.centerOn?.({ lat: g.lat, lng: g.lng }, 19); else view.fit?.();
    }
  }

  /** Fit a video's whole path in a view. */
  function fitTrack(view, kind, host) {
    if (kind !== 'plan' || !level?.plan) { view.fit?.(); return; }
    const b = trackBounds(item.track);
    if (!b) { view.fit?.(); return; }
    const scale = trackFitScale({
      cw: host.clientWidth, ch: host.clientHeight, planW: level.plan.width, planH: level.plan.height, bounds: b,
      pxPerMeter: level.calibration?.pxPerMeter,
    });
    view.centerOn?.({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, scale);
  }

  // ================= video path (plan or map under the player) =================

  const trackHost = el('div', { class: 'item-mini-host' });
  const trackBox = el('div', { class: 'item-track' });
  const trackCap = el('div', { class: 'item-cap' });
  const trackSection = section('Path', null, trackBox, trackCap);
  let track = null;        // {view, kind, ro, offs}
  let trackToken = 0;

  async function buildTrack() {
    destroyTrack();
    if (item.type !== 'video') { trackSection.hidden = true; return; }
    const kind = level?.plan && hasPlanTrack(item) ? 'plan' : hasGeoTrack(item) ? 'map' : null;
    if (!kind) { trackSection.hidden = true; return; }
    trackSection.hidden = false;
    trackCap.textContent = `The line is where the video was taken; the marker follows the video. Tap the path to jump there.${kind === 'map' && level?.plan ? ' Shown on the satellite map because this plan is not calibrated yet.' : ''}`;
    const token = ++trackToken;
    const spin = el('div', { class: 'item-mini-msg' }, el('div', { class: 'spinner' }));
    const full = el('button', {
      type: 'button', class: 'item-media-btn item-track-full', title: 'Full screen', 'aria-label': 'Show the path full screen',
      onclick: () => openPlace({ kind }), html: icon('fit', { size: 20 }),
    });
    trackBox.replaceChildren(trackHost, spin, full);
    let view;
    try {
      view = await createView(kind, trackHost, { interactive: true });
    } catch (err) {
      if (token !== trackToken || disposed) return;
      console.warn('[item] path view failed', err);
      spin.replaceChildren(el('span', { html: icon('warning', { size: 24 }) }), el('span', {}, `The path could not be shown: ${err.message}`));
      return;
    }
    if (token !== trackToken || disposed) { safeDestroy(view); return; }
    spin.remove();
    const ro = observeResize(trackHost, () => { try { view.resize?.(); } catch { /* view closing */ } });
    track = { view, kind, ro, offs: [wireSeek(view, kind, trackHost)] };
    try { view.setItems([item], { selectedId: item.id }); } catch (err) { console.warn('[item] path items', err); }
    requestAnimationFrame(() => {
      if (track?.view !== view) return;
      try { view.resize?.(); fitTrack(view, kind, trackHost); } catch (err) { console.warn('[item] path fit', err); }
      syncPlayback();
    });
  }

  function destroyTrack() {
    trackToken++;
    if (!track) return;
    for (const off of track.offs) if (typeof off === 'function') { try { off(); } catch { /* gone */ } }
    track.ro.disconnect();
    safeDestroy(track.view);
    track = null;
  }

  /** How far from the path a tap may be (plan px or meters) and still count — about 40 screen px. */
  function tapTolerance(view, kind, p) {
    let v = null;
    try { v = view.getView?.(); } catch { v = null; }
    if (kind === 'plan') {
      const sc = Number(v?.scale ?? v?.zoom);
      if (sc > 0 && Number.isFinite(sc)) return 40 / sc;
      return Math.max(level?.plan?.width || 0, level?.plan?.height || 0) * 0.05 || 60;
    }
    const z = Number(v?.zoom);
    if (z > 0 && Number.isFinite(z)) return 40 * 156543.03 * Math.cos((p.lat || 0) * DEG) / 2 ** z;
    return 30;
  }

  function seekToPoint(p, kind, view) {
    if (!video || !item.track?.length || !p) return;
    const mode = kind === 'plan' ? 'plan' : 'geo';
    if (mode === 'plan' ? !finite(p.x, p.y) : !finite(p.lat, p.lng)) return;
    const hit = nearestTrackPoint(item.track, p, mode);
    if (!hit || hit.distance > tapTolerance(view, kind, p)) return;
    const sec = Math.max(0, hit.point.t / 1000);
    if (video.readyState >= 1) {
      try { video.currentTime = Number.isFinite(video.duration) ? Math.min(sec, video.duration) : sec; } catch { pendingSeek = sec; }
    } else {
      pendingSeek = sec;
    }
    syncPlayback(sec * 1000);
    buzz(8);
  }

  // ================= full-screen plan / map, and Move pin =================
  //
  // An overlay inside this screen. It pushes a history entry with the same
  // URL, so the phone's back button closes the overlay (popstate, no
  // hashchange) instead of leaving the item.

  let overlay = null; // {el, view, kind, closed, pushed, picking, ro, unwire, bar}

  async function openPlace({ move = false, kind = null } = {}) {
    if (overlay || disposed) return;
    const vk = move ? levelKind() : (kind || (placeKind(item, level) === 'map' ? 'map' : levelKind()));
    const movable = canMovePin() && vk === levelKind();
    const title = move ? `${hasPin() ? 'Move' : 'Place'} the pin of #${item.seq}` : `#${item.seq} ${typeLabel(item.type)}`;
    const host = el('div', { class: 'item-place-view' });
    const spin = el('div', { class: 'item-mini-msg' }, el('div', { class: 'spinner' }));
    host.append(spin);
    const moveBtn = el('button', { type: 'button', class: 'btn btn-primary btn-lg', onclick: () => pick() },
      el('span', { html: icon('pin', { size: 22 }) }), hasPin() ? 'Move pin' : 'Place pin');
    const bar = el('div', { class: 'bottombar item-place-bar' }, moveBtn);
    bar.hidden = move || !movable;
    const box = el('div', { class: 'item-place', role: 'dialog', 'aria-label': title },
      el('header', { class: 'topbar' },
        iconButton('close', { title: 'Close', onclick: () => closeOverlay() }),
        el('div', { class: 'topbar-title' }, el('h1', {}, title),
          el('div', { class: 'sub' }, [level?.name, vk === 'plan' ? 'Floor plan' : 'Map'].filter(Boolean).join(' · ')))),
      host, bar);
    const ov = { el: box, view: null, kind: vk, closed: false, pushed: false, picking: false, ro: null, unwire: null, bar };
    overlay = ov;
    root.append(box);
    try {
      history.pushState({ ...(history.state || {}), jwDepth: (history.state?.jwDepth || 0) + 1, jwItemOverlay: true }, '', location.href);
      ov.pushed = true;
    } catch { /* the back button then leaves the item, which is fine */ }

    try {
      ov.view = await createView(vk, host, { interactive: true });
    } catch (err) {
      if (ov.closed) return;
      console.warn('[item] full view failed', err);
      spin.replaceChildren(el('span', { html: icon('warning', { size: 28 }) }), el('span', {}, `The ${vk === 'plan' ? 'plan' : 'map'} could not be opened: ${err.message}`));
      bar.hidden = true;
      return;
    }
    if (ov.closed || disposed) { safeDestroy(ov.view); return; }
    spin.remove();
    ov.ro = observeResize(host, () => { try { ov.view.resize?.(); } catch { /* closing */ } });
    try { ov.view.setItems([item], { selectedId: item.id }); } catch (err) { console.warn('[item] full items', err); }
    if (item.type === 'video' && video) {
      ov.unwire = wireSeek(ov.view, vk, host);
      syncPlayback();
    }
    requestAnimationFrame(() => {
      if (ov.closed) return;
      try {
        ov.view.resize?.();
        if (item.type === 'video' && (hasPlanTrack(item) || hasGeoTrack(item))) fitTrack(ov.view, vk, host);
        else focusView(ov.view, vk, host, 12);
      } catch (err) { console.warn('[item] full focus', err); }
      if (move) pick();
    });

    async function pick() {
      if (ov.picking || ov.closed || typeof ov.view?.pickPoint !== 'function') return;
      ov.picking = true;
      bar.hidden = true;
      const g = geoOf(item);
      const initial = vk === 'plan'
        ? (item.pose?.plan && finite(item.pose.plan.x, item.pose.plan.y) ? { x: item.pose.plan.x, y: item.pose.plan.y } : undefined)
        : (g ? { lat: g.lat, lng: g.lng } : undefined);
      let pt = null;
      try {
        pt = await ov.view.pickPoint({
          title: hasPin() ? 'Move the pin' : 'Place the pin',
          hint: `Drag the ${vk === 'plan' ? 'plan' : 'map'} until the cross is on the exact spot, then tap Set.`,
          initial,
        });
      } catch (err) {
        if (!ov.closed) toast(`The spot could not be picked: ${err.message}`, { type: 'err' });
      }
      ov.picking = false;
      if (ov.closed) return;
      if (!pt) { if (move) closeOverlay(); else bar.hidden = !movable; return; }
      await commitPin(vk, pt, ov, movable);
    }
  }

  async function commitPin(kind, pt, ov, movable) {
    try {
      const saved = await savePin(kind, pt);
      applyItem(saved);
      toast(`Pin ${kind === 'plan' ? 'placed on the plan' : 'placed on the map'}`, { type: 'ok' });
      buzz(15);
      if (overlay === ov) closeOverlay();
    } catch (err) {
      toast(`The pin could not be saved: ${err.message}`, { type: 'err', action: { label: 'Try again', onclick: () => commitPin(kind, pt, ov, movable) } });
      if (!ov.closed) ov.bar.hidden = !movable;
    }
  }

  /** Save a pin placed by hand. The GPS fix the item had is kept (pose.gpsGeo) when the map spot replaces it. */
  async function savePin(kind, pt) {
    if (kind === 'plan' ? !finite(pt?.x, pt?.y) : !finite(pt?.lat, pt?.lng)) throw new Error('that spot could not be read.');
    let toEnu = null;
    if (kind === 'map' && project.origin) {
      try { toEnu = (await loaders.geo()).toEnu || null; } catch { toEnu = null; }
    }
    return store.updateItem(iid, (cur) => {
      const pose = cur.pose ? { ...cur.pose } : {
        t: cur.createdAt, geo: null, enu: null, plan: null, planAcc: null, planLocked: false, heading: null, headingAcc: null,
        planHeading: null, pitch: null, roll: null, facing: 'camera', source: 'manual', quality: 'none',
      };
      if (kind === 'plan') {
        pose.plan = { x: pt.x, y: pt.y };
      } else {
        if (pose.geo && !pose.gpsGeo) pose.gpsGeo = { ...pose.geo };
        pose.geo = { acc: null, alt: null, altAcc: null, ...(pose.geo || {}), lat: pt.lat, lng: pt.lng };
        if (toEnu && project.origin) {
          try { pose.enu = toEnu(project.origin, pt.lat, pt.lng); } catch { /* keep the old one */ }
        }
      }
      // Only a spot placed on the PLAN is locked there. A spot placed on the
      // map is a ground position: a plan calibrated later places it, like GPS.
      if (kind === 'plan') pose.planLocked = true;
      pose.pinnedAt = Date.now();
      cur.pose = pose;
    });
  }

  function closeOverlay({ fromHistory = false } = {}) {
    const ov = overlay;
    if (!ov) return;
    overlay = null;
    ov.closed = true;
    ov.ro?.disconnect();
    try { ov.unwire?.(); } catch { /* gone */ }
    safeDestroy(ov.view);
    ov.el.remove();
    if (ov.pushed && !fromHistory) {
      ov.pushed = false;
      try { history.back(); } catch { /* fine */ }
    }
  }

  // ================= file =================

  const fileCard = el('div', { class: 'card item-card' });
  const fileSection = section('File', null, fileCard);

  // The files are read once per open (and again only when they change): a
  // second call while the read is running gets that same read, so the video
  // player and the File section share one copy of the bytes.
  let blobsRead = Promise.resolve();
  let blobsReading = false;       // a read is running; Share / Download wait for it
  let blobsReadAt = 0;            // when it started
  function refreshBlobs() {
    const m = item.media || {};
    const key = `${m.original}|${m.annotated}`;
    if (blobs.key === key) return blobsRead;
    blobs.key = key;
    blobsReading = true;
    blobsReadAt = Date.now();
    blobsRead = (async () => {
      let originalError = null;
      const [o, a] = await Promise.all([
        m.original ? store.getMediaBlob(m.original).catch((err) => { originalError = err; return null; }) : null,
        m.annotated ? store.getMediaBlob(m.annotated).catch(() => null) : null,
      ]);
      if (blobs.key !== key) return;   // a newer read took over
      blobs.original = o;
      blobs.annotated = a;
      blobs.originalError = originalError;
      blobsReading = false;
    })();
    return blobsRead;
  }

  // Share or Download found no file yet: read it again, unless a read is
  // still running. Then it is waited for, not started a second time: a tap
  // while a long video is still being read would hold two copies again. A
  // read stuck for half a minute (a phone database that stopped answering)
  // is started again, so a tap can still get the file.
  function retryBlobs() {
    if (!blobsReading || Date.now() - blobsReadAt > 30000) blobs.key = '';
    refreshBlobs().then(renderFile);
  }

  function renderFile() {
    if (item.type === 'note' || disposed) { fileSection.hidden = true; return; }
    const rows = [];
    if (item.width && item.height) rows.push(['Resolution', `${item.width} × ${item.height} px`]);
    if (item.type === 'video' && item.duration) rows.push(['Length', formatDuration(item.duration)]);
    rows.push(['Size', blobs.original ? formatBytes(blobs.original.size) : faint(item.media?.original ? 'Checking…' : 'Missing')]);
    if (blobs.annotated) rows.push(['Marked-up copy', formatBytes(blobs.annotated.size)]);
    rows.push(['Type', describeMime(item.mimeType || blobs.original?.type)]);
    fileCard.replaceChildren(factList(rows));
  }

  // ================= actions =================

  function go(dir) {
    const target = dir < 0 ? nav.prev : nav.next;
    if (!target || overlay || disposed) return;
    leaveCheck().then((ok) => {
      if (!ok || disposed) return;
      buzz(8);
      // replace: back from any item returns to the job walk, not through every item seen.
      ctx.navigate(`p/${pid}/i/${target.id}`, { replace: true });
    });
  }

  function doMarkup() {
    if (item.type !== 'photo' || !item.media?.original) return;
    ctx.navigate(`p/${pid}/i/${iid}/annotate`);
  }

  function shareText() {
    const g = geoOf(item);
    return [
      `#${item.seq} ${typeLabel(item.type)}${titleInput.value.trim() ? ` — ${titleInput.value.trim()}` : ''}`,
      [project.name, level?.name, formatDateTime(item.createdAt)].filter(Boolean).join(' · '),
      item.tags?.length ? `Tags: ${item.tags.join(', ')}` : '',
      notes.value.trim(),
      g ? `Location: ${googleMapsUrl(g.lat, g.lng)}` : '',
    ].filter(Boolean).join('\n');
  }

  async function doShare() {
    if (item.type === 'note') {
      const text = shareText();
      if (navigator.share) {
        try { await navigator.share({ title: `#${item.seq} Note`, text }); return; } catch (err) { if (err?.name === 'AbortError') return; }
      }
      toast((await copyText(text)) ? 'The note was copied. Paste it into an email or a message.' : 'This browser cannot share or copy the note.', { type: 'info', ms: 5000 });
      return;
    }
    const useMarked = !!(item.media?.annotated && blobs.annotated);
    const blob = useMarked ? blobs.annotated : blobs.original;
    if (!blob) {
      toast('The file is still being read. Try again in a moment.', { type: 'warn' });
      retryBlobs();
      return;
    }
    const name = fileNameFor(item, { levelName: level?.name, variant: useMarked ? 'annotated' : 'original', mimeType: blob.type });
    try {
      // share: true opens the share sheet on Android too (photos and videos
      // are types Chrome shares); 'needs-tap' means nothing was shared.
      const how = await saveBlob(blob, name, { share: true, title: name });
      if (how === 'downloaded') toast(`Downloaded ${name}`, { type: 'ok' });
      else if (how === 'needs-tap') toast('The phone wants another tap: tap Share again.', { type: 'warn' });
    } catch (err) {
      toast(`It could not be shared: ${err.message}`, { type: 'err' });
    }
  }

  async function doDownload(variant = 'original') {
    if (item.type === 'note') {
      const name = fileNameFor(item, { levelName: level?.name, mimeType: 'text/plain' });
      saveBlob(new Blob([shareText()], { type: 'text/plain' }), name, { preferShare: isIOS() }).catch((err) => toast(`It could not be saved: ${err.message}`, { type: 'err' }));
      return;
    }
    const blob = variant === 'annotated' ? blobs.annotated : blobs.original;
    if (!blob) {
      toast('The file is still being read. Try again in a moment.', { type: 'warn' });
      retryBlobs();
      return;
    }
    const name = fileNameFor(item, { levelName: level?.name, variant, mimeType: blob.type });
    try {
      // On iPhone the share sheet is how a file is saved (Save Image / Save to Files).
      const how = await saveBlob(blob, name, { preferShare: isIOS(), title: name });
      if (how === 'downloaded') toast(`Downloaded ${name}`, { type: 'ok' });
    } catch (err) {
      toast(`It could not be saved: ${err.message}`, { type: 'err' });
    }
  }

  async function doDelete() {
    if (!(await leaveCheck())) return;
    const label = `${typeLabel(item.type)} #${item.seq}`;
    try {
      await store.softDeleteItem(iid);
    } catch (err) {
      toast(`${label} could not be deleted: ${err.message}`, { type: 'err' });
      return;
    }
    toast(`${label} moved to Recently Deleted`, {
      ms: 8000,
      action: {
        label: 'Undo',
        onclick: async () => {
          try { await store.restoreItem(iid); toast(`${label} is back`, { type: 'ok' }); }
          catch (err) { toast(`It could not be undone: ${err.message} It is in Recently Deleted.`, { type: 'err' }); }
        },
      },
    });
    ctx.back(`p/${pid}`);
  }

  async function doRestore() {
    try {
      const saved = await store.restoreItem(iid);
      applyItem(saved);
      reloadSiblings();
      toast(`${typeLabel(item.type)} #${item.seq} is back`, { type: 'ok' });
    } catch (err) {
      toast(`It could not be restored: ${err.message}`, { type: 'err' });
    }
  }

  async function openMenu() {
    if (disposed) return;
    const t = kindWord();
    const g = geoOf(item);
    const opts = [];
    if (item.type === 'photo' && !item.deletedAt) {
      opts.push({ value: 'markup', label: 'Mark up', icon: 'pen', detail: 'Arrows, boxes, clouds, dimensions, text', disabled: !item.media?.original });
    }
    opts.push({
      value: 'share', label: 'Share', icon: 'share',
      detail: item.type === 'photo' ? (item.media?.annotated ? 'The marked-up photo' : 'The photo') : item.type === 'video' ? 'The video file' : 'The note as text',
    });
    if (item.type === 'note') opts.push({ value: 'download', label: 'Download as a text file', icon: 'download' });
    else opts.push({ value: 'download', label: `Download the original ${t}`, icon: 'download' });
    if (item.media?.annotated) opts.push({ value: 'download-markup', label: 'Download the marked-up copy', icon: 'download' });
    if (canMovePin()) opts.push({ value: 'move', label: hasPin() ? 'Move pin' : (levelKind() === 'plan' ? 'Place on the plan' : 'Place on the map'), icon: 'pin' });
    const pk = placeKind(item, level);
    if (pk === 'plan' || pk === 'map') opts.push({ value: 'open', label: pk === 'plan' ? 'Show on the plan' : 'Show on the map', icon: pk === 'plan' ? 'plan' : 'map' });
    if (g) opts.push({ value: 'copy', label: 'Copy GPS coordinates', icon: 'clipboard', detail: formatCoords(g.lat, g.lng) });
    opts.push(item.deletedAt
      ? { value: 'restore', label: 'Restore', icon: 'restore' }
      : { value: 'delete', label: `Delete ${t}`, icon: 'trash', danger: true, detail: 'Moves it to Recently Deleted' });
    const v = await choose({ title: `#${item.seq} ${typeLabel(item.type)}`, options: opts });
    if (disposed || !v) return;
    if (v === 'markup') doMarkup();
    else if (v === 'share') doShare();
    else if (v === 'download') doDownload('original');
    else if (v === 'download-markup') doDownload('annotated');
    else if (v === 'move') openPlace({ move: true });
    else if (v === 'open') openPlace({ kind: pk });
    else if (v === 'copy' && g) toast((await copyText(formatCoords(g.lat, g.lng))) ? 'Coordinates copied' : 'Could not copy them.', { type: 'info' });
    else if (v === 'restore') doRestore();
    else if (v === 'delete') doDelete();
  }

  // ================= keeping in step with the store =================

  function renderHeader() {
    h1.textContent = `#${item.seq} ${typeLabel(item.type)}`;
    nav = neighbors(siblings, item);
    sub.textContent = [nav.index >= 0 ? `${nav.index + 1} of ${nav.count}` : 'In Recently Deleted', level?.name].filter(Boolean).join(' · ');
    prevBtn.disabled = !nav.prev;
    nextBtn.disabled = !nav.next;
    moreBtn.disabled = false;
  }

  function syncField(field, input) {
    if (autosaver.isPending(field)) return; // the person's own typing wins; mergeText keeps both at save time
    const v = item[field] || '';
    if (input.value !== v) {
      if (document.activeElement === input) {
        const s = input.selectionStart;
        const e = input.selectionEnd;
        input.value = v;
        try { input.setSelectionRange(Math.min(s, v.length), Math.min(e, v.length)); } catch { /* not a text field now */ }
      } else {
        input.value = v;
      }
      if (field === 'text') autoGrow();
    }
    base[field] = v;
  }

  const trackKey = (t) => (Array.isArray(t) && t.length
    ? `${t.length}|${t[0]?.x},${t[0]?.y},${t[0]?.lat}|${t[t.length - 1]?.x},${t[t.length - 1]?.y},${t[t.length - 1]?.t}`
    : '');

  /** Take a newer copy of the item (our own save, the annotate screen, another tab) and refresh what changed. */
  function applyItem(fresh) {
    if (!fresh || disposed || fresh.id !== iid) return;
    const prev = item;
    item = fresh;
    const at = siblings.findIndex((s) => s.id === fresh.id);
    if (at >= 0) siblings[at] = fresh;
    syncField('title', titleInput);
    syncField('text', notes);
    renderHeader();
    const mediaChanged = JSON.stringify(prev.media || {}) !== JSON.stringify(fresh.media || {});
    if (mediaChanged) {
      refreshBlobs().then(renderFile);
      if (fresh.type === 'photo' && viewer) showPhoto();
    }
    if (JSON.stringify(prev.tags || []) !== JSON.stringify(fresh.tags || [])) renderTags();
    if (JSON.stringify(prev.voiceNotes || []) !== JSON.stringify(fresh.voiceNotes || [])) renderVoiceNotes();
    const poseChanged = JSON.stringify(prev.pose) !== JSON.stringify(fresh.pose) || prev.levelId !== fresh.levelId;
    if (poseChanged) {
      level = store.getLevel(project, fresh.levelId);
      renderFacts();
      renderPlace();
      if (overlay?.view) { try { overlay.view.setItems([item], { selectedId: item.id }); } catch { /* closing */ } }
    }
    if (trackKey(prev.track) !== trackKey(fresh.track)) buildTrack();
    if (!!prev.deletedAt !== !!fresh.deletedAt) { renderActions(); renderBanner(); }
    if (prev.capturedBy !== fresh.capturedBy || prev.source !== fresh.source) renderFacts();
  }

  let reloadTimer = null;
  let siblingsTimer = null;
  let projectTimer = null;

  async function reloadItem() {
    let fresh;
    try { fresh = await store.getItem(iid); } catch { return; }
    if (disposed) return;
    if (!fresh) { onGone(); return; }
    applyItem(fresh);
  }
  async function reloadSiblings() {
    let list;
    try { list = await store.listItems(pid); } catch { return; }
    if (disposed) return;
    siblings = list;
    renderHeader();
    renderTags();
  }
  const levelKey = (l) => JSON.stringify(l ? [l.name, l.plan?.mediaId, l.plan?.width, l.plan?.height, l.calibration?.createdAt, l.calibration?.pxPerMeter] : null);
  async function reloadProject() {
    let p;
    try { p = await store.getProject(pid); } catch { return; }
    if (disposed) return;
    if (!p) { onGone(); return; }
    const before = levelKey(level);
    project = p;
    level = store.getLevel(p, item.levelId);
    if (levelKey(level) !== before) {
      renderHeader();
      renderFacts();
      renderPlace();
      buildTrack();
    }
  }
  function onGone() {
    if (gone) return;
    gone = true;
    autosaver.cancel();
    try { localStorage.removeItem(draftKey); } catch { /* nothing kept */ }
    toast(`This ${kindWord()} was deleted for good on this phone.`, { type: 'warn' });
    if (overlay) closeOverlay({ fromHistory: true });
    ctx.navigate(`p/${pid}`, { replace: true });
  }

  offs.push(bus.on('store:change', (ev) => {
    if (!ev || disposed || gone) return;
    if (ev.kind === 'item' && ev.id === iid) {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(reloadItem, 120);
    } else if (ev.kind === 'item' && ev.projectId === pid) {
      clearTimeout(siblingsTimer);
      siblingsTimer = setTimeout(reloadSiblings, 400);
    } else if (ev.kind === 'project' && ev.id === pid) {
      clearTimeout(projectTimer);
      projectTimer = setTimeout(reloadProject, 200);
    }
  }));
  offs.push(bus.on('settings:change', () => { if (!disposed) renderFacts(); }));

  // ================= leaving =================

  // When the person already chose "Leave" in one of the dialogs below, the
  // router's own guard call that follows (next/previous, delete) must not ask again.
  let leaveOkAt = 0;

  /** Before leaving (route guard, next/previous, delete): save what is in progress. false = stay. */
  async function leaveCheck() {
    if (gone || disposed) return true;
    if (Date.now() - leaveOkAt < 3000) {
      autosaver.flush().catch(() => { /* the draft copy is kept */ });
      return true;
    }
    return askBeforeLeaving();
  }

  async function askBeforeLeaving() {
    if (recState === 'recording') {
      const save = await confirmDialog({
        title: 'Save the voice note?', message: 'A voice note is still recording. It is saved before you go.',
        okText: 'Save it', cancelText: 'Keep recording',
      });
      if (!save) return false;
      if (!(await stopRecording())) return false; // not saved: stay, so Try again / Download are at hand
    } else if (savingVoice) {
      if (!(await savingVoice)) return false;
    }
    if (unsavedVoice.length) {
      const leave = await confirmDialog({
        title: 'A voice note is not saved',
        message: 'It could not be saved to this phone. If you leave now it is lost. Stay to try again, or download it first.',
        okText: 'Leave without it', cancelText: 'Stay', danger: true,
      });
      if (!leave) return false;
      leaveOkAt = Date.now();
    }
    stopDictation();
    try {
      await autosaver.flush();
    } catch (err) {
      const leave = await confirmDialog({
        title: 'Your note is not saved yet',
        message: `${err.message}\n\nA copy is kept on this phone and comes back the next time you open this ${kindWord()}.`,
        okText: 'Leave', cancelText: 'Stay and retry',
      });
      if (!leave) return false;
      leaveOkAt = Date.now();
    }
    return true;
  }
  ctx.setGuard(leaveCheck);

  function onHidden() {
    if (disposed) return;
    autosaver.flush().catch(() => { /* shown in the save state; the draft copy is kept */ });
    stopDictation();
    // A phone in the background stops a web page's microphone, so the voice note is saved now.
    if (recState === 'recording') stopRecording({ quiet: true }).then((ok) => { if (ok) hiddenSaved = true; });
  }
  listen(document, 'visibilitychange', () => {
    if (document.visibilityState === 'hidden') onHidden();
    else if (hiddenSaved) {
      hiddenSaved = false;
      toast('Your voice note was saved when the phone left the app.', { type: 'ok', ms: 6000 });
    }
  });
  listen(window, 'pagehide', onHidden);
  listen(window, 'popstate', () => {
    if (overlay?.pushed && !history.state?.jwItemOverlay) {
      overlay.pushed = false;
      closeOverlay({ fromHistory: true });
    }
  });
  listen(document, 'keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (overlay) {
      if (e.key === 'Escape' && !modalOpen() && !overlay.picking) { e.preventDefault(); closeOverlay(); }
      return;
    }
    if (modalOpen() || isTextField(e.target) || /^(VIDEO|AUDIO)$/.test(e.target?.tagName || '')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === 'Escape' && root.classList.contains('immersive')) { e.preventDefault(); setImmersive(false); }
  });

  // Typing: the photo shrinks so the note has room above the keyboard (css/item.css).
  let typingTimer = null;
  listen(details, 'focusin', (e) => {
    if (!isTextField(e.target)) return;
    clearTimeout(typingTimer);
    root.classList.add('typing');
    if (e.target === notes && window.matchMedia?.('(max-width: 899px)').matches) {
      typingTimer = setTimeout(() => { try { notes.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* old browser */ } }, 260);
    }
  });
  listen(details, 'focusout', (e) => {
    if (!isTextField(e.target)) return;
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => root.classList.remove('typing'), 150);
  });

  listen(notes, 'input', () => onTyped('text', notes));
  listen(titleInput, 'input', () => onTyped('title', titleInput));
  listen(titleInput, 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); titleInput.blur(); } });
  for (const input of [titleInput, notes]) {
    listen(input, 'blur', () => { if (autosaver.dirty) autosaver.flush().catch(() => {}); });
  }
  for (const type of ['select', 'keyup', 'click', 'input', 'focus', 'blur']) listen(notes, type, rememberCaret);

  // ================= build =================

  if (item.type === 'photo') buildPhoto();
  else if (item.type === 'video') buildVideo();
  else buildNote();

  details.append(
    deletedBanner,
    trackSection,
    el('div', { class: 'item-head' }, titleInput),
    actions,
    section('Tags', null, tagRow),
    section('Notes', saveState, notes, el('div', { class: 'item-notes-bar' }, dictBtn, interim)),
    section('Voice notes', null, recPanel, unsavedBox, voiceList),
    section('Where and when', null, factsCard, miniWrap),
    fileSection,
  );
  renderHeader();
  renderBanner();
  renderActions();
  renderTags();
  renderVoiceNotes();
  renderUnsaved();
  setupDictation();
  preloadRecorder();
  renderRec();
  renderFacts();
  renderPlace();
  renderFile();
  buildTrack();
  requestAnimationFrame(autoGrow);
  restoreDraft();
  refreshBlobs().then(() => { if (!disposed) renderFile(); });
  loaders.itemsPanel().then((mod) => {
    if (disposed || !Array.isArray(mod?.DEFAULT_TAGS) || !mod.DEFAULT_TAGS.length) return;
    defaultTags = [...mod.DEFAULT_TAGS];
    renderTags();
  }).catch((err) => console.warn('[item] the items panel tag list could not be loaded; using the built-in one', err));
  if (ctx.query?.move === '1' && canMovePin()) openPlace({ move: true });
  // The Note button opens its new note with ?focus=text, to be typed: bring
  // the Notes box on screen (it is below the tags on a phone) and put the
  // caret in it. iOS may not raise the keyboard without a tap, but the box
  // is in view.
  if (ctx.query?.focus === 'text') {
    requestAnimationFrame(() => {
      if (disposed) return;
      try {
        notes.scrollIntoView({ block: 'center' });
        notes.focus({ preventScroll: true });
        notes.setSelectionRange(notes.value.length, notes.value.length);
      } catch { /* an old browser: the box is still there to tap */ }
    });
  }

  // ================= cleanup =================

  return async function cleanup() {
    if (disposed) return;
    disposed = true;
    for (const off of offs.splice(0)) { try { off(); } catch { /* already gone */ } }
    clearTimeout(reloadTimer);
    clearTimeout(siblingsTimer);
    clearTimeout(projectTimer);
    clearTimeout(typingTimer);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    try { dictation?.stop(); } catch { /* not listening */ }
    // A voice note still recording is saved, never dropped.
    if (recState === 'recording') { try { await stopRecording(); } catch { /* reported by its toast */ } }
    else if (savingVoice) { try { await savingVoice; } catch { /* reported by its toast */ } }
    clearInterval(recTick);
    clearTimeout(recLimit);
    cancelAnimationFrame(recRaf);
    if (!gone) {
      try { await autosaver.flush(); } catch (err) {
        toast(`Your note could not be saved yet: ${err.message} A copy is kept on this phone and comes back when you open it again.`, { type: 'err' });
      }
    }
    autosaver.cancel();
    if (player) {
      try { player.pause(); player.removeAttribute('src'); player.load(); } catch { /* gone */ }
      player = null;
    }
    if (video) {
      try { video.pause(); video.removeAttribute('src'); video.load(); } catch { /* gone */ }
    }
    if (videoUrl) { URL.revokeObjectURL(videoUrl); videoUrl = null; }
    if (overlay) { overlay.pushed = false; closeOverlay({ fromHistory: true }); }
    destroyMini();
    destroyTrack();
    viewer?.destroy();
    scope.release();
  };
}
