// plan-view.js — the floor plan on screen: pan, pinch-zoom, pins, paths and
// "you are here".
//
// This is the view the estimator looks at most of the walk — on a phone, in
// the sun, often one-handed, over a plan that can be 8000 px across. It has to
// feel like the phone's own photo viewer, so:
//
//  - One <canvas>, redrawn only when something changed, at most once per
//    animation frame. The plan image is drawn with a single transform
//    (screen = plan × scale + offset), cropped to the part that is on screen.
//  - The plan is drawn from a pre-shrunk copy that matches the zoom (an image
//    "pyramid": ½, ¼, ⅛ … built in the background after the first frame), so a
//    zoomed-out 8000 px plan costs about as much as a photo, and thin lines do
//    not shimmer or vanish the way they do when a browser shrinks a huge image
//    in one step.
//  - Pins, paths, calibration marks and the blue dot are drawn afterwards in
//    screen pixels (js/ui/markers.js), so they keep one size at any zoom.
//  - Gestures are Pointer Events: one finger pans (with a little fling), two
//    fingers pinch-zoom around the fingers, a double-tap zooms in (at full
//    zoom it goes back to the whole sheet), a two-finger tap zooms out, the
//    mouse wheel / trackpad pinch zooms at the cursor, a long press (or a
//    right-click) asks for a note at that spot, + − 0 and the arrow keys work
//    when the plan has keyboard focus.
//  - "Follow me" keeps the person in the middle, gliding rather than jumping;
//    dragging or pinching the plan turns it off (followchange tells the screen
//    so its button can follow).
//
// Coordinates. "Plan" = pixels of the stored plan image (origin top-left, x
// right, y down — docs/SPEC.md §4.2). "Screen" = CSS pixels from the top-left
// corner of this view's element. A view transform {scale, tx, ty} maps one to
// the other; the pure helpers below (fitTransform, planToScreen, screenToPlan,
// zoomAround, clampTransform, interpolateTrack, hitTestTargets …) hold that
// math and are covered by tests/views.test.mjs.
//
// pickPoint() is the precise placement mode used for calibration points, "I'm
// here" and moving a pin: a fixed cross in the middle, the plan moves under it,
// a 3× magnifier above the cross shows the exact spot, big Set / Cancel buttons
// at the bottom (Enter / Escape on a keyboard). A tap moves the tapped spot
// under the cross.
//
// The map view (js/ui/map-view.js) reuses this module's scene drawing, hit
// testing, track interpolation and placement overlay, so both look and behave
// the same.

import { Emitter } from '../core/bus.js';
import { clamp, deltaDeg, DEG, buzz, escapeHtml } from '../core/util.js';
import { el } from './shell.js';
import { icon } from './icons.js';
import {
  markerColors, drawPhotoPin, drawNotePin, drawVideoPath, drawMe, drawPlayhead,
  drawMark, drawLineMark, drawCrosshair, drawScaleBar,
} from './markers.js';

const PIN_HIT = 22;            // px: a generous finger
const PATH_HIT = 16;
const TAP_SLOP = { touch: 10, pen: 8, mouse: 4 };
const DOUBLE_TAP_MS = 300;     // second tap must land this soon after the first …
const TAP_DELAY_MS = 300;      // … so a plain tap waits this long before it counts
const LONG_PRESS_MS = 550;
const MAX_DEVICE_ZOOM = 8;     // at most 8 device pixels per plan pixel
const FIT_PAD = 12;            // px of air around the sheet when it fits the screen
const SETTLE_MS = 160;
const LOUPE_ZOOM = 3;
const MAX_CANVAS_PX = 12e6;    // backing-store cap (a 4K desktop window at 2×)
const PYRAMID_MIN_SIDE = 1400; // stop halving below this

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const posNum = (v) => (isNum(v) && v > 0 ? v : 0);
const validPt = (p) => !!p && isNum(p.x) && isNum(p.y);
const round2 = (v) => Math.round(v * 100) / 100;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

/** Degrees folded into [0, 360) — never exactly 360, even for −1e-15. */
function norm360(d) {
  let r = d % 360;
  if (r < 0) r += 360;
  return r >= 360 ? 0 : r;
}

// ---- view math (pure) -----------------------------------------------------------------

/** The transform that shows a whole plan (planW × planH) centred in the view, with `pad` px of air. */
export function fitTransform(viewW, viewH, planW, planH, pad = 0) {
  const aw = Math.max(1, viewW - 2 * pad);
  const ah = Math.max(1, viewH - 2 * pad);
  const scale = Math.min(aw / Math.max(1e-9, planW), ah / Math.max(1e-9, planH));
  return { scale, tx: (viewW - planW * scale) / 2, ty: (viewH - planH * scale) / 2 };
}

/** Plan px → screen px for transform t. */
export function planToScreen(t, x, y) {
  return { x: x * t.scale + t.tx, y: y * t.scale + t.ty };
}

/** Screen px → plan px for transform t. */
export function screenToPlan(t, sx, sy) {
  return { x: (sx - t.tx) / t.scale, y: (sy - t.ty) / t.scale };
}

/** The transform at `newScale` that keeps the plan point under screen (sx, sy) where it is (zooming at a finger or cursor). */
export function zoomAround(t, newScale, sx, sy) {
  const p = screenToPlan(t, sx, sy);
  return { scale: newScale, tx: sx - p.x * newScale, ty: sy - p.y * newScale };
}

/** The transform at `scale` with plan point p in the middle of a viewW × viewH view. */
export function centerTransform(p, scale, viewW, viewH) {
  return { scale, tx: viewW / 2 - p.x * scale, ty: viewH / 2 - p.y * scale };
}

/**
 * Keep the content in reach. `b` is the content's box in plan px ({x0, y0,
 * x1, y1}: the sheet, plus any pin or the person outside it).
 *
 * The rule is about the plan point under the middle of the view: it may go
 * anywhere over the content, so every pin — even one in a corner under a
 * button — can be brought to the middle, and the precise-placement cross can
 * reach every corner. With `lockSmall` (normal viewing), while the content
 * is smaller than the screen it stays centred like a photo, and the reach
 * grows smoothly as it is zoomed past the screen size (no snapping).
 */
export function clampTransform(t, viewW, viewH, b, { lockSmall = true } = {}) {
  const axis = (lo, hi, view, s, off) => {
    const mid = (lo + hi) / 2;
    let reach = (hi - lo) / 2;
    if (lockSmall) reach *= clamp(((hi - lo) * s) / Math.max(1, view) - 1, 0, 1);
    const c = (view / 2 - off) / s;
    return view / 2 - clamp(c, mid - reach, mid + reach) * s;
  };
  return { scale: t.scale, tx: axis(b.x0, b.x1, viewW, t.scale, t.tx), ty: axis(b.y0, b.y1, viewH, t.scale, t.ty) };
}

/** Distance from point (px, py) to the segment a–b. */
export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * What a tap at (sx, sy) hits. targets: [{kind: 'pin', x, y, selected?, item}
 * | {kind: 'path', pts: [{x, y}], item}] in screen px. Pins win over paths
 * (they sit on top); among pins the nearest wins, a tie goes to the one drawn
 * later, and the selected pin (drawn bigger) gets a few px of help.
 */
export function hitTestTargets(targets, sx, sy, { pinRadius = PIN_HIT, pathRadius = PATH_HIT } = {}) {
  let best = null, bestD = Infinity;
  for (const t of targets || []) {
    if (t?.kind !== 'pin' || !isNum(t.x) || !isNum(t.y)) continue;
    const d = Math.hypot(t.x - sx, t.y - sy) - (t.selected ? 4 : 0);
    if (d <= pinRadius && d <= bestD) { best = t; bestD = d; }
  }
  if (best) return best;
  for (const t of targets || []) {
    if (t?.kind !== 'path' || !t.pts?.length) continue;
    let d = Infinity;
    if (t.pts.length === 1) d = Math.hypot(t.pts[0].x - sx, t.pts[0].y - sy);
    for (let i = 1; i < t.pts.length; i++) {
      const a = t.pts[i - 1], b = t.pts[i];
      d = Math.min(d, distToSegment(sx, sy, a.x, a.y, b.x, b.y));
    }
    if (d <= pathRadius && d <= bestD) { best = t; bestD = d; }
  }
  return best;
}

/**
 * Project a path to the screen and drop points closer than `minDist` px to
 * the previous kept one (a 10-minute video has ~3000 points; at a zoomed-out
 * view most of them land on the same pixel). The last point is always kept.
 */
export function simplifyScreenPath(pts, proj = (p) => p, minDist = 1.5) {
  const out = [];
  const d2 = minDist * minDist;
  let last = null;
  for (let i = 0; i < (pts?.length || 0); i++) {
    const q = proj(pts[i]);
    if (!q || !isNum(q.x) || !isNum(q.y)) continue;
    if (last && i < pts.length - 1) {
      const dx = q.x - last.x, dy = q.y - last.y;
      if (dx * dx + dy * dy < d2) continue;
    }
    out.push(q);
    last = q;
  }
  return out;
}

// ---- 2-D affine transforms [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f (canvas order) ----

/** Apply affine m to (x, y). */
export function applyAffine(m, x, y) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** The inverse of affine m, or null when it is degenerate. */
export function invertAffine(m) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!isNum(det) || Math.abs(det) < 1e-12) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/**
 * The affine that maps a W × H image onto screen points: its top-left corner
 * to `tl`, top-right to `tr`, bottom-left to `bl` (how a rotated, scaled plan
 * is laid over the map).
 */
export function affineFromCorners(tl, tr, bl, W, H) {
  return [(tr.x - tl.x) / W, (tr.y - tl.y) / W, (bl.x - tl.x) / H, (bl.y - tl.y) / H, tl.x, tl.y];
}

// ---- video tracks (pure) -------------------------------------------------------------------

// Fields interpolated together: a position is only used when both halves are there.
const TRACK_GROUPS = [
  { name: 'xy', keys: ['x', 'y'] },
  { name: 'geo', keys: ['lat', 'lng'] },
  { name: 'enu', keys: ['e', 'n'] },
  { name: 'acc', keys: ['acc'] },
  { name: 'pitch', keys: ['pitch'] },
  { name: 'heading', keys: ['heading'], angle: true },
  { name: 'planHeading', keys: ['planHeading'], angle: true },
];
const trackCache = new WeakMap();

/** A track's points sorted by time, and per field group the points that have it — cached per track (and refreshed as a live track grows). */
function preparedTrack(track) {
  const hit = trackCache.get(track);
  if (hit && hit.len === track.length) return hit;
  const pts = track.filter((p) => p && isNum(p.t));
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].t < pts[i - 1].t) { pts.sort((a, b) => a.t - b.t); break; }
  }
  const groups = {};
  for (const g of TRACK_GROUPS) groups[g.name] = pts.filter((p) => g.keys.every((k) => isNum(p[k])));
  const prep = { len: track.length, pts, groups };
  trackCache.set(track, prep);
  return prep;
}

/** Index of the last point with t ≤ time, or −1. */
function lastAtOrBefore(pts, time) {
  let lo = 0, hi = pts.length - 1, i = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= time) { i = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return i;
}

/**
 * Where a video's camera was, and which way it looked, `tMs` milliseconds
 * after the video started. Positions are interpolated linearly between the
 * samples around that time; headings along the shorter way round the circle
 * (350° → 10° passes through 0°, not 180°). A field missing from some
 * samples is taken from the nearest samples that have it; before the first
 * sample the first one is used, after the last the last one.
 * Returns {t, x, y, lat, lng, e, n, acc, pitch, heading, planHeading} (null
 * for a field no sample has), or null for an empty track.
 */
export function interpolateTrack(track, tMs) {
  if (!Array.isArray(track) || !track.length) return null;
  const prep = preparedTrack(track);
  if (!prep.pts.length) return null;
  const time = isNum(tMs) ? tMs : 0;
  const out = { t: time };
  for (const g of TRACK_GROUPS) {
    const pts = prep.groups[g.name];
    if (!pts.length) { for (const k of g.keys) out[k] = null; continue; }
    const i = lastAtOrBefore(pts, time);
    const a = i >= 0 ? pts[i] : null;
    const b = i + 1 < pts.length ? pts[i + 1] : null;
    if (!a || !b) {
      const p = a || b;
      for (const k of g.keys) out[k] = p[k];
      continue;
    }
    const span = b.t - a.t;
    const f = span > 0 ? clamp((time - a.t) / span, 0, 1) : 0;
    for (const k of g.keys) {
      out[k] = g.angle ? norm360(a[k] + deltaDeg(a[k], b[k]) * f) : a[k] + (b[k] - a[k]) * f;
    }
  }
  return out;
}

// ---- the image pyramid --------------------------------------------------------------------
//
// Shared per image and reference-counted: the plan screen and the camera's
// mini-map show the same decoded plan, and going from one to the other should
// not rebuild it. A pyramid nobody uses is freed a few seconds later (the
// canvases are shrunk to 0×0 first, which is what makes iOS give the memory
// back).

const pyramids = new Map();

export function imageWidth(img) {
  return posNum(img?.naturalWidth) || posNum(img?.videoWidth) || posNum(img?.width) || 0;
}
export function imageHeight(img) {
  return posNum(img?.naturalHeight) || posNum(img?.videoHeight) || posNum(img?.height) || 0;
}

/**
 * The pyramid for `image` (built in the background, one level per tick).
 * Call releasePyramid() when done. `onLevel` is called when a new level is ready.
 */
export function acquirePyramid(image, onLevel) {
  let p = pyramids.get(image);
  if (!p) {
    p = { image, refs: 0, levels: [{ src: image, w: imageWidth(image), h: imageHeight(image) }], done: false, timer: 0, freeTimer: 0, listeners: new Set() };
    pyramids.set(image, p);
  }
  clearTimeout(p.freeTimer);
  p.freeTimer = 0;
  p.refs++;
  if (onLevel) p.listeners.add(onLevel);
  schedulePyramid(p);
  return p;
}

/** Give back a pyramid from acquirePyramid(). */
export function releasePyramid(p, onLevel) {
  if (!p) return;
  if (onLevel) p.listeners.delete(onLevel);
  p.refs = Math.max(0, p.refs - 1);
  if (p.refs === 0 && !p.freeTimer) {
    p.freeTimer = setTimeout(() => freePyramid(p), 8000);
    p.freeTimer?.unref?.();   // Node (tests): a pending free must not keep the process alive
  }
}

function freePyramid(p) {
  if (p.refs > 0) return;
  clearTimeout(p.timer);
  for (const lv of p.levels.slice(1)) { try { lv.src.width = 0; lv.src.height = 0; } catch { /* already gone */ } }
  p.levels.length = 1;
  p.done = true;
  pyramids.delete(p.image);
}

function schedulePyramid(p) {
  if (p.done || p.timer || typeof document === 'undefined') return;
  p.timer = setTimeout(() => {
    p.timer = 0;
    if (p.refs <= 0) return;
    buildNextLevel(p);
    schedulePyramid(p);
  }, p.levels.length === 1 ? 120 : 40);
}

function buildNextLevel(p) {
  const last = p.levels[p.levels.length - 1];
  if (!last.w || !last.h) { // not decoded yet: a later acquire (after 'load') tries again
    p.levels[0].w = imageWidth(p.image);
    p.levels[0].h = imageHeight(p.image);
    if (!p.levels[0].w) return;
  }
  if (Math.max(last.w, last.h) <= PYRAMID_MIN_SIDE * 1.4) { p.done = true; return; }
  const w = Math.max(1, Math.round(last.w / 2));
  const h = Math.max(1, Math.round(last.h / 2));
  try {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    if (!g) { p.done = true; return; }
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(last.src, 0, 0, w, h);
    p.levels.push({ src: c, w, h });
  } catch (err) {
    // Out of canvas memory (old iPhones): the full image still works, just slower.
    console.warn('[plan-view] could not pre-shrink the plan', err);
    p.done = true;
    return;
  }
  if (Math.max(w, h) <= PYRAMID_MIN_SIDE * 1.4) p.done = true;
  for (const fn of [...p.listeners]) { try { fn(); } catch { /* a view went away */ } }
}

/**
 * Which pyramid level to draw from: the smallest copy that still has at least
 * `need` of its pixels per full-size pixel (a 10% stretch is invisible and
 * saves a level). levels[0] is the full image.
 */
export function chooseLevel(levels, need) {
  const w0 = levels?.[0]?.w || 0;
  if (!w0) return 0;
  let best = 0;
  for (let i = 1; i < levels.length; i++) {
    if (levels[i].w / w0 >= need * 0.9) best = i;
    else break;
  }
  return best;
}

/**
 * Draw a plan (pyramid `pyr` of a W × H plan) through affine m (plan px →
 * CSS px), cropped to the part that falls inside the viewW × viewH view.
 * Returns false when there is nothing to draw from yet. `paper` fills white
 * under the image first (a transparent PNG plan stays readable).
 */
export function drawPlanImage(ctx, pyr, W, H, m, { dpr = 1, viewW, viewH, quality = 'high', alpha = 1, paper = true } = {}) {
  const levels = pyr?.levels;
  const L0 = levels?.[0];
  if (!L0) return false;
  if (!L0.w) { L0.w = imageWidth(L0.src); L0.h = imageHeight(L0.src); }
  if (!L0.w || !L0.h) return false;
  const inv = invertAffine(m);
  if (!inv) return false;
  const sc = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  const lv = levels[chooseLevel(levels, (sc * dpr * W) / L0.w)];

  // The part of the plan on screen: the view's corners mapped back to plan px.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of [[0, 0], [viewW, 0], [0, viewH], [viewW, viewH]]) {
    const p = applyAffine(inv, x, y);
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  x0 = clamp(x0, 0, W); x1 = clamp(x1, 0, W); y0 = clamp(y0, 0, H); y1 = clamp(y1, 0, H);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return true;

  const kx = lv.w / W, ky = lv.h / H;
  const sx = Math.max(0, Math.floor(x0 * kx)), sy = Math.max(0, Math.floor(y0 * ky));
  const ex = Math.min(lv.w, Math.ceil(x1 * kx)), ey = Math.min(lv.h, Math.ceil(y1 * ky));
  if (ex - sx <= 0 || ey - sy <= 0) return true;

  ctx.save();
  ctx.setTransform(dpr * m[0], dpr * m[1], dpr * m[2], dpr * m[3], dpr * m[4], dpr * m[5]);
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = quality;
  if (paper) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(sx / kx, sy / ky, (ex - sx) / kx, (ey - sy) / ky);
  }
  ctx.drawImage(lv.src, sx, sy, ex - sx, ey - sy, sx / kx, sy / ky, (ex - sx) / kx, (ey - sy) / ky);
  ctx.restore();
  return true;
}

// ---- the scene (shared with the map view) ------------------------------------------------------

/**
 * Draw everything that sits on the plan or map, in screen px, in this
 * order: video paths, photo and note pins, calibration lines and marks, the
 * playback marker, the person. The selected (or playing) item is drawn on
 * top and bigger; while a video plays the other items are dimmed.
 *
 * scene: {
 *   videos: [{item, n, screen: [{x, y}]}],
 *   pins:   [{item, kind: 'photo'|'note', sx, sy, h (rad|null), n, annotated}],
 *   lines:  [{a: {x, y}, b: {x, y}, label, color, dashed}],
 *   marks:  [{sx, sy, label, color, kind}],
 *   play:   {sx, sy, h} | null,
 *   me:     {sx, sy, accPx, h, facing, stale, uncertain} | null,
 *   selectedId, playId,
 * }
 */
export function drawScene(g, scene, { viewW = Infinity, viewH = Infinity, light = false } = {}) {
  const pad = 80;
  const onScreen = (x, y) => x > -pad && y > -pad && x < viewW + pad && y < viewH + pad;
  const isHl = (id) => id != null && (id === scene.selectedId || id === scene.playId);
  const dim = scene.playId != null;

  const top = [];
  for (const v of scene.videos || []) {
    if (!v.screen?.length) continue;
    if (isHl(v.item?.id)) { top.push(v); continue; }
    drawVideoPath(g, v.screen, { n: v.n, light, dim });
  }
  for (const v of top) drawVideoPath(g, v.screen, { n: v.n, light, selected: true });

  let sel = null;
  for (const p of scene.pins || []) {
    if (!onScreen(p.sx, p.sy)) continue;
    if (p.item?.id != null && p.item.id === scene.selectedId) { sel = p; continue; }
    drawPin(g, p, { light, dim });
  }
  if (sel) drawPin(g, sel, { light, selected: true });

  for (const l of scene.lines || []) drawLineMark(g, l.a, l.b, { label: l.label, color: l.color, dashed: l.dashed, light });
  for (const m of scene.marks || []) {
    if (onScreen(m.sx, m.sy)) drawMark(g, m.sx, m.sy, { label: m.label, color: m.color, kind: m.kind, light });
  }
  if (scene.play) drawPlayhead(g, scene.play.sx, scene.play.sy, scene.play.h);
  if (scene.me) {
    const me = scene.me;
    drawMe(g, me.sx, me.sy, me.accPx, me.h, me.facing, { stale: me.stale, uncertain: me.uncertain, light });
  }
}

function drawPin(g, p, o) {
  if (p.kind === 'note') drawNotePin(g, p.sx, p.sy, { ...o, n: p.n });
  else drawPhotoPin(g, p.sx, p.sy, p.h, { ...o, n: p.n, annotated: p.annotated });
}

/** True when an item has markup (a flattened copy or shapes). */
export function isAnnotated(item) {
  return !!(item?.media?.annotated || item?.annotations?.shapes?.length);
}

/** Pose fields → what drawMe needs (shared by plan and map). */
export function meStyle(pose) {
  return {
    facing: pose?.facing || 'camera',
    stale: pose?.quality === 'none' || pose?.source === 'none',
    uncertain: isNum(pose?.headingAcc) && pose.headingAcc > 35,
  };
}

// ---- the placement overlay (shared with the map view) -----------------------------------------

const CROSS_SVG = '<svg width="72" height="72" viewBox="0 0 72 72" aria-hidden="true" focusable="false"><g fill="none" stroke-linecap="round">'
  + '<path d="M36 5v21M36 46v21M5 36h21M46 36h21" stroke="#fff" stroke-width="6"/>'
  + '<path d="M36 5v21M36 46v21M5 36h21M46 36h21" stroke="#c8371f" stroke-width="2.5"/>'
  + '<circle cx="36" cy="36" r="2.6" fill="#c8371f" stroke="#fff" stroke-width="1.6"/></g></svg>';

/**
 * The DOM of the precise placement mode: the title/hint banner, the fixed
 * cross, the magnifier canvas and the Set / Cancel buttons. The caller puts
 * `el` inside its view, calls layout() when the view's size changes, draws
 * into `loupe`, and calls destroy() at the end.
 */
export function createPickOverlay({ title = '', hint = '', setLabel = 'Set', cancelLabel = 'Cancel', onSet, onCancel } = {}) {
  const loupe = el('canvas', { class: 'vw-loupe', 'aria-hidden': 'true' });
  const banner = el('div', { class: 'vw-pick-banner', role: 'status', 'aria-live': 'polite' },
    title ? el('div', { class: 'vw-pick-title' }, title) : null,
    hint ? el('div', { class: 'vw-pick-hint' }, hint) : null);
  const setBtn = el('button', {
    type: 'button', class: 'btn btn-primary btn-lg vw-pick-set',
    html: `${icon('check', { size: 22 })}<span>${escapeHtml(setLabel)}</span>`,
    onclick: (e) => { e.stopPropagation(); onSet?.(); },
  });
  const cancelBtn = el('button', {
    type: 'button', class: 'btn btn-lg vw-pick-cancel',
    onclick: (e) => { e.stopPropagation(); onCancel?.(); },
  }, cancelLabel);
  // The buttons sit on the view: keep their touches away from the pan/zoom handlers.
  for (const b of [setBtn, cancelBtn]) {
    for (const t of ['pointerdown', 'pointerup', 'mousedown', 'touchstart', 'dblclick', 'wheel', 'contextmenu']) {
      b.addEventListener(t, (e) => e.stopPropagation(), { passive: true });
    }
  }
  const root = el('div', { class: 'vw-pick' },
    title || hint ? banner : null,
    el('div', { class: 'vw-cross', 'aria-hidden': 'true', html: CROSS_SVG }),
    loupe,
    el('div', { class: 'vw-pick-btns' }, cancelBtn, setBtn));
  let size = 0;
  return {
    el: root,
    loupe,
    setBtn,
    get size() { return size; },
    /** Place the magnifier above the cross (beside it on a short screen). Returns its size in CSS px. */
    layout(viewW, viewH) {
      size = Math.round(clamp(Math.min(viewW, viewH) * 0.34, 92, 148));
      const cx = viewW / 2, cy = viewH / 2, gap = 40;
      const top = banner.isConnected ? banner.offsetTop + banner.offsetHeight + 8 : 8;
      let x = cx - size / 2, y = cy - gap - size;
      if (y < top) {
        // Not enough room above: beside the cross, on the left (a right thumb covers the right side).
        y = clamp(cy - size - 6, top, Math.max(top, viewH - size - 8));
        x = cx - gap - size;
        if (x < 8) x = cx + gap;
      }
      loupe.style.width = `${size}px`;
      loupe.style.height = `${size}px`;
      loupe.style.left = `${Math.round(x)}px`;
      loupe.style.top = `${Math.round(y)}px`;
      return size;
    },
    destroy() {
      try { loupe.width = 0; loupe.height = 0; } catch { /* gone */ }
      root.remove();
    },
  };
}

/** True when keys typed now belong to a text field, not to the plan. */
export function isTypingTarget(t) {
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));
}

/** A dialog or sheet is open on top: let it have the keyboard. */
export function overlayOpen() {
  return typeof document !== 'undefined' && !!document.querySelector('#overlays .modal-back, #overlays .sheet-back');
}

let reducedMql = null;
export function prefersReducedMotion() {
  try {
    if (!reducedMql && typeof matchMedia === 'function') reducedMql = matchMedia('(prefers-reduced-motion: reduce)');
    return !!reducedMql?.matches;
  } catch { return false; }
}

// ---- the view -----------------------------------------------------------------------------------

/**
 * Create a plan view inside `container` (which must have a size; the view
 * fills it).
 *
 * opts: {
 *   image          HTMLImageElement | ImageBitmap | HTMLCanvasElement (may be
 *                  a smaller copy — it is stretched to width × height; an
 *                  <img> still loading is fine)
 *   width, height  the stored plan's size in px (plan coordinates)
 *   interactive    false for the camera's mini-map: no gestures, always
 *                  centred on the person, lighter drawing
 *   units          'imperial' | 'metric' (scale bar)
 *   pxPerMeter     optional: the calibration's scale — shows a scale bar, and
 *                  lets the mini-map zoom to `metersAcross` (default 24 m)
 * }
 *
 * Events (view.on(type, fn) returns an unsubscribe function):
 *   tapitem  (item)        a pin or path was tapped (at once)
 *   tap      ({x, y})      the plan was tapped elsewhere (plan px; after the
 *                          double-tap window)
 *   longpress({x, y})      held still for ½ s, or right-clicked (plan px)
 *   viewchange(view)       the view settled after moving ({x, y, scale, zoom})
 *   followchange(on)       Follow me turned on or off
 */
export function createPlanView(container, opts = {}) {
  if (!container) throw new Error('createPlanView needs a container element.');
  const interactive = opts.interactive !== false;
  let units = opts.units || 'imperial';
  let pxPerMeter = posNum(opts.pxPerMeter) || null;
  const metersAcross = posNum(opts.metersAcross) || 24;
  const showScale = opts.scaleBar !== false;
  let W = posNum(opts.width) || imageWidth(opts.image) || 1000;
  let H = posNum(opts.height) || imageHeight(opts.image) || 1000;

  const emitter = new Emitter();
  const offs = new Set();
  const root = el('div', {
    class: `pv${interactive ? '' : ' pv-static'}`,
    tabindex: interactive ? '0' : null,
    role: interactive ? 'application' : 'img',
    'aria-roledescription': interactive ? 'floor plan' : null,
    'aria-label': interactive
      ? 'Floor plan. Drag to move, pinch or scroll to zoom, double-tap to zoom in.'
      : 'Floor plan with your position',
  });
  const canvas = el('canvas', { class: 'pv-canvas', 'aria-hidden': 'true' });
  root.append(canvas);
  container.append(root);
  const ctx = canvas.getContext('2d', { alpha: false }) || canvas.getContext('2d');

  // ---- state --------------------------------------------------------------
  let T = { scale: 1, tx: 0, ty: 0 };
  let vw = 0, vh = 0, dpr = 1, sized = false;
  let pendingView = null;
  let image = null, imageState = 'none';   // 'none' | 'loading' | 'ready' | 'failed'
  let pyr = null;
  let pins = [], videos = [], itemsB = null, selectedId = null;
  let pose = null, marks = [], lines = [];
  let contentB = { x0: 0, y0: 0, x1: W, y1: H };
  let following = !interactive;
  let insetZoomed = false;
  let play = null;                          // {item, pt, video}
  let anim = null;
  let raf = 0, dirty = false, lastFrame = 0, viewStamp = 0;
  let quality = 'high';
  let settleTimer = 0, viewMoved = false;
  let destroyed = false, drawWarned = false;
  let pick = null;

  // ---- frame loop -----------------------------------------------------------

  function requestFrame() {
    if (!raf && !destroyed) raf = requestAnimationFrame(frame);
  }
  function requestDraw() {
    dirty = true;
    requestFrame();
  }
  function setT(next) {
    T = next;
    viewStamp++;
    viewMoved = true;
    dirty = true;
    scheduleSettle();
    requestFrame();
  }

  function frame(now) {
    raf = 0;
    if (destroyed) return;
    const dt = lastFrame ? clamp(now - lastFrame, 1, 64) : 16;
    lastFrame = now;
    let more = false;
    if (anim) more = stepAnim(now, dt);
    if (following && interactive && !gesture && !anim && !pick) more = stepFollow(dt) || more;
    if (dirty) { dirty = false; draw(); }
    // The steps above may already have asked for the next frame (setT does);
    // never queue a second one, or every animated frame would double them.
    if (more) requestFrame();
    else if (!raf) lastFrame = 0;
  }

  function scheduleSettle() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, SETTLE_MS);
  }
  function settle() {
    settleTimer = 0;
    if (destroyed) return;
    if (gesture || anim) { scheduleSettle(); return; }
    if (quality !== 'high') { quality = 'high'; requestDraw(); }
    if (viewMoved) { viewMoved = false; emitter.emit('viewchange', getView()); }
  }

  // ---- limits ----------------------------------------------------------------

  const fitScale = () => fitTransform(vw, vh, W, H, FIT_PAD).scale;
  function minScale() {
    const fc = fitTransform(vw, vh, contentB.x1 - contentB.x0, contentB.y1 - contentB.y0, FIT_PAD).scale;
    return Math.min(fitScale(), fc);
  }
  const maxScale = () => Math.max(MAX_DEVICE_ZOOM / dpr, fitScale() * 4);
  const clampScale = (s) => clamp(isNum(s) && s > 0 ? s : fitScale(), minScale(), maxScale());

  /** A transform inside the limits (scale range, content in reach). */
  function constrain(t) {
    let next = t;
    const s = clampScale(t.scale);
    if (Math.abs(s - t.scale) > 1e-12) {
      const c = screenToPlan(t, vw / 2, vh / 2);
      next = centerTransform(c, s, vw, vh);
    }
    return clampTransform(next, vw, vh, contentB, { lockSmall: !pick });
  }

  function recomputeContent() {
    const b = { x0: 0, y0: 0, x1: W, y1: H };
    // Far-off points (a wild GPS fix, a pin from a bad calibration) widen the
    // reach by at most one sheet in each direction.
    const add = (x, y) => {
      if (!isNum(x) || !isNum(y)) return;
      x = clamp(x, -W, 2 * W);
      y = clamp(y, -H, 2 * H);
      b.x0 = Math.min(b.x0, x); b.y0 = Math.min(b.y0, y);
      b.x1 = Math.max(b.x1, x); b.y1 = Math.max(b.y1, y);
    };
    if (itemsB) { add(itemsB.x0, itemsB.y0); add(itemsB.x1, itemsB.y1); }
    if (validPt(pose?.plan)) add(pose.plan.x, pose.plan.y);
    contentB = b;
  }

  // ---- drawing -------------------------------------------------------------------

  function screenPath(v) {
    if (v.stamp === viewStamp && v.screen) return v.screen;
    const { scale: s, tx, ty } = T;
    v.screen = simplifyScreenPath(v.pts, (p) => ({ x: p.x * s + tx, y: p.y * s + ty }));
    v.stamp = viewStamp;
    return v.screen;
  }

  function buildScene() {
    const { scale: s, tx, ty } = T;
    const sp = (p) => ({ x: p.x * s + tx, y: p.y * s + ty });
    const scene = { selectedId, playId: play?.item?.id ?? null, pins: [], videos: [], marks: [], lines: [], me: null, play: null };
    for (const v of videos) scene.videos.push({ item: v.item, n: v.n, screen: screenPath(v) });
    if (play?.video && !videos.some((v) => v.item.id === play.item.id)) {
      scene.videos.push({ item: play.item, n: play.video.n, screen: screenPath(play.video) });
    }
    for (const p of pins) {
      scene.pins.push({ item: p.item, kind: p.kind, sx: p.x * s + tx, sy: p.y * s + ty, h: p.h, n: p.n, annotated: p.annotated });
    }
    for (const l of lines) if (validPt(l?.a) && validPt(l?.b)) scene.lines.push({ ...l, a: sp(l.a), b: sp(l.b) });
    for (const m of marks) if (validPt(m)) scene.marks.push({ ...m, sx: m.x * s + tx, sy: m.y * s + ty });
    if (validPt(play?.pt)) {
      scene.play = { sx: play.pt.x * s + tx, sy: play.pt.y * s + ty, h: isNum(play.pt.planHeading) ? play.pt.planHeading * DEG : null };
    }
    if (validPt(pose?.plan)) {
      scene.me = {
        sx: pose.plan.x * s + tx,
        sy: pose.plan.y * s + ty,
        accPx: isNum(pose.planAcc) ? pose.planAcc * s : null,
        h: isNum(pose.planHeading) ? pose.planHeading * DEG : null,
        ...meStyle(pose),
      };
    }
    return scene;
  }

  function drawPlaceholder(c) {
    const x0 = T.tx, y0 = T.ty, w = W * T.scale, h = H * T.scale;
    ctx.fillStyle = '#fff';
    ctx.fillRect(x0, y0, w, h);
    if (imageState === 'none' && !image) return;
    const msg = imageState === 'failed' ? 'This plan could not be shown on this phone.' : 'Loading the plan…';
    const cx = clamp(x0 + w / 2, 20, vw - 20), cy = clamp(y0 + h / 2, 20, vh - 20);
    ctx.font = `600 ${interactive ? 15 : 11}px ${c.font}`;
    ctx.fillStyle = '#5d6e80';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(msg, cx, cy);
  }

  function draw() {
    if (!vw || !vh || destroyed || !ctx) return;
    const c = markerColors();
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = c.planBg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (interactive) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.14)';  // the sheet's shadow
        ctx.fillRect(T.tx + 1, T.ty + 2, W * T.scale, H * T.scale);
      }
      let drew = false;
      if (imageState === 'ready' && pyr) {
        try {
          drew = drawPlanImage(ctx, pyr, W, H, [T.scale, 0, 0, T.scale, T.tx, T.ty], { dpr, viewW: vw, viewH: vh, quality });
        } catch (err) {
          // A closed ImageBitmap or a lost GPU context: say so instead of a blank sheet.
          console.warn('[plan-view] the plan image could not be drawn', err);
          imageState = 'failed';
        }
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!drew) drawPlaceholder(c);
      drawScene(ctx, buildScene(), { viewW: vw, viewH: vh, light: !interactive });
      if (interactive && showScale && pxPerMeter && !pick) drawScaleBar(ctx, 14, vh - 14, pxPerMeter * T.scale, units);
      if (pick) drawLoupe();
    } catch (err) {
      if (!drawWarned) { drawWarned = true; console.warn('[plan-view] draw failed', err); }
    }
  }

  function drawLoupe() {
    const size = pick.ov.size;
    const g = pick.ctx;
    if (!size || !g) return;
    const lc = pick.ov.loupe;
    const px = Math.max(1, Math.round(size * dpr));
    if (lc.width !== px) { lc.width = px; lc.height = px; }
    const c = markerColors();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = c.planBg;
    g.fillRect(0, 0, px, px);
    const z = T.scale * LOUPE_ZOOM;
    const cp = screenToPlan(T, vw / 2, vh / 2);
    const m = [z, 0, 0, z, size / 2 - cp.x * z, size / 2 - cp.y * z];
    if (imageState === 'ready' && pyr) {
      try { drawPlanImage(g, pyr, W, H, m, { dpr, viewW: size, viewH: size, quality: 'high' }); } catch { /* shown as blank */ }
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const l of lines) {
      if (validPt(l?.a) && validPt(l?.b)) drawLineMark(g, applyAffine(m, l.a.x, l.a.y), applyAffine(m, l.b.x, l.b.y), { color: l.color, dashed: l.dashed, light: true });
    }
    for (const mk of marks) {
      if (validPt(mk)) { const q = applyAffine(m, mk.x, mk.y); drawMark(g, q.x, q.y, { color: mk.color, kind: mk.kind, light: true }); }
    }
    drawCrosshair(g, size / 2, size / 2, { arm: Math.round(size * 0.16), gap: 5 });
  }

  // ---- animation -------------------------------------------------------------------

  function stopAnim() { anim = null; }

  /** Glide to transform `target` (centre and zoom move together; zoom changes evenly in log space). */
  function animateTo(target, dur = 300) {
    target = constrain(target);
    if (prefersReducedMotion() || !sized) { anim = null; setT(target); return; }
    anim = {
      kind: 'tween', t0: performance.now(), dur,
      s0: T.scale, s1: target.scale,
      c0: screenToPlan(T, vw / 2, vh / 2), c1: screenToPlan(target, vw / 2, vh / 2),
    };
    requestFrame();
  }

  /** Zoom to scale s1 keeping the plan point under screen (sx, sy) still. */
  function zoomAtAnimated(sx, sy, s1, dur = 260) {
    s1 = clampScale(s1);
    if (prefersReducedMotion()) { anim = null; setT(constrain(zoomAround(T, s1, sx, sy))); return; }
    anim = { kind: 'zoomAt', t0: performance.now(), dur, s0: T.scale, s1, sx, sy, anchor: screenToPlan(T, sx, sy) };
    quality = 'medium';
    requestFrame();
  }

  function stepAnim(now, dt) {
    if (anim.kind === 'fling') {
      const nx = T.tx + anim.vx * dt, ny = T.ty + anim.vy * dt;
      const next = constrain({ scale: T.scale, tx: nx, ty: ny });
      if (Math.abs(next.tx - nx) > 0.5) anim.vx = 0;   // reached the edge of what can be shown
      if (Math.abs(next.ty - ny) > 0.5) anim.vy = 0;
      setT(next);
      const decay = Math.exp(-dt / 325);
      anim.vx *= decay;
      anim.vy *= decay;
      if (Math.hypot(anim.vx, anim.vy) < 0.02) { anim = null; return false; }
      return true;
    }
    const e = easeOutCubic(clamp((now - anim.t0) / anim.dur, 0, 1));
    const s = anim.s0 * Math.pow(anim.s1 / anim.s0, e);
    if (anim.kind === 'zoomAt') {
      setT(constrain({ scale: s, tx: anim.sx - anim.anchor.x * s, ty: anim.sy - anim.anchor.y * s }));
    } else {
      const c = { x: anim.c0.x + (anim.c1.x - anim.c0.x) * e, y: anim.c0.y + (anim.c1.y - anim.c0.y) * e };
      setT(constrain(centerTransform(c, s, vw, vh)));
    }
    if (e >= 1) { anim = null; return false; }
    return true;
  }

  /** Follow me: ease the view toward the person (about 0.15 s time constant), never jump. */
  function stepFollow(dt) {
    if (!validPt(pose?.plan)) return false;
    const target = constrain(centerTransform(pose.plan, T.scale, vw, vh));
    const dx = target.tx - T.tx, dy = target.ty - T.ty;
    if (Math.abs(dx) < 0.3 && Math.abs(dy) < 0.3) {
      if (dx || dy) setT(target);
      return false;
    }
    const k = 1 - Math.exp(-dt / 150);
    setT({ scale: T.scale, tx: T.tx + dx * k, ty: T.ty + dy * k });
    return true;
  }

  function startFling(samples, tUp) {
    if (prefersReducedMotion() || !samples?.length) return;
    const recent = samples.filter((s) => tUp - s.t <= 100);
    if (recent.length < 2) return;
    const a = recent[0], b = recent[recent.length - 1];
    if (tUp - b.t > 50) return;                 // the finger had stopped before lifting
    const dt = Math.max(8, b.t - a.t);
    let vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt;
    const sp = Math.hypot(vx, vy);
    if (sp < 0.35) return;
    if (sp > 4.5) { vx *= 4.5 / sp; vy *= 4.5 / sp; }
    anim = { kind: 'fling', vx, vy };
    requestFrame();
  }

  // ---- the mini-map (interactive: false) ------------------------------------------------

  function insetScale() {
    if (pxPerMeter) return clampScale(Math.min(vw, vh) / (metersAcross * pxPerMeter));
    return clampScale(fitScale() * 3);
  }

  /** The mini-map snaps to the person on every update: smoothness matters less there than the battery. */
  function insetUpdate(resized = false) {
    if (interactive || !sized) return;
    if (validPt(pose?.plan)) {
      const s = insetZoomed ? clampScale(T.scale) : insetScale();
      insetZoomed = true;
      anim = null;
      setT(constrain(centerTransform(pose.plan, s, vw, vh)));
    } else if (resized || insetZoomed) {
      insetZoomed = false;
      setT(constrain(fitTransform(vw, vh, W, H, FIT_PAD)));
    }
  }

  // ---- gestures ---------------------------------------------------------------------

  const pointers = new Map();
  let gesture = null;          // {kind: 'pan', …} | {kind: 'pinch', …}
  let press = null;            // the touch that may become a tap or a long press
  let twoTap = null;           // a two-finger tap in progress
  let longTimer = 0, tapTimer = 0, lastTap = null, longFired = false;
  let lastPointerType = 'mouse', lastDownAt = 0;
  let rect = null;
  let safariGesture = null;

  const gesturesOn = () => !destroyed && (interactive || !!pick);
  const local = (e) => ({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  const viewCenter = () => ({ x: vw / 2, y: vh / 2 });

  function cancelPendingTap() {
    clearTimeout(tapTimer);
    tapTimer = 0;
  }

  function pushSample(samples, p, t) {
    samples.push({ x: p.x, y: p.y, t });
    if (samples.length > 10) samples.shift();
  }

  function startPinch() {
    const [a, b] = [...pointers.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    gesture = { kind: 'pinch', anchor: screenToPlan(T, mid.x, mid.y), s0: T.scale, d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), m0: mid, moved: false };
  }

  function onDown(e) {
    if (!gesturesOn() || !sized) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    rect = root.getBoundingClientRect();
    if (e.pointerType === 'mouse') {
      e.preventDefault();            // no text selection while dragging
      try { root.focus({ preventScroll: true }); } catch { /* old browser */ }
    }
    try { root.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    lastPointerType = e.pointerType || 'touch';
    lastDownAt = performance.now();
    stopAnim();
    quality = 'medium';
    const p = local(e);
    pointers.set(e.pointerId, p);
    if (pointers.size === 1) {
      gesture = { kind: 'pan', id: e.pointerId, x0: p.x, y0: p.y, lastX: p.x, lastY: p.y, started: false, samples: [] };
      pushSample(gesture.samples, p, e.timeStamp);
      press = { id: e.pointerId, x: p.x, y: p.y, t: e.timeStamp };
      longFired = false;
      clearTimeout(longTimer);
      if (!pick) longTimer = setTimeout(onLongPress, LONG_PRESS_MS);
    } else if (pointers.size === 2) {
      clearTimeout(longTimer);
      press = null;
      cancelPendingTap();
      twoTap = { t: e.timeStamp, moved: false, mid: null };
      startPinch();
      twoTap.mid = gesture.m0;
    }
  }

  function onMove(e) {
    if (!pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse' && !e.buttons) hover(e);
      return;
    }
    const p = local(e);
    pointers.set(e.pointerId, p);
    if (gesture?.kind === 'pan' && e.pointerId === gesture.id) {
      const slop = TAP_SLOP[e.pointerType] ?? 8;
      const far = Math.hypot(p.x - gesture.x0, p.y - gesture.y0) > slop;
      if (far && twoTap) twoTap.moved = true;
      if (!gesture.started && far) {
        gesture.started = true;
        clearTimeout(longTimer);
        press = null;
        cancelPendingTap();
        if (following && interactive) setFollowing(false);
        // Pan by the whole distance moved so far, so the plan does not lag the finger.
        gesture.lastX = gesture.x0;
        gesture.lastY = gesture.y0;
      }
      if (gesture.started) {
        setT(constrain({ scale: T.scale, tx: T.tx + p.x - gesture.lastX, ty: T.ty + p.y - gesture.lastY }));
        gesture.lastX = p.x;
        gesture.lastY = p.y;
        pushSample(gesture.samples, p, e.timeStamp);
      }
    } else if (gesture?.kind === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      if (!gesture.moved) {
        if (Math.abs(d - gesture.d0) <= 8 && Math.hypot(mid.x - gesture.m0.x, mid.y - gesture.m0.y) <= 8) return;
        gesture.moved = true;
        if (twoTap) twoTap.moved = true;
        if (following && interactive) setFollowing(false);
        // Start from here, so crossing the dead zone does not make the plan jump.
        gesture.anchor = screenToPlan(T, mid.x, mid.y);
        gesture.s0 = T.scale;
        gesture.d0 = d;
      }
      const s = clampScale(gesture.s0 * d / gesture.d0);
      setT(constrain({ scale: s, tx: mid.x - gesture.anchor.x * s, ty: mid.y - gesture.anchor.y * s }));
    }
  }

  function onUp(e) {
    if (!pointers.has(e.pointerId)) return;
    const cancelled = e.type !== 'pointerup';
    const p = rect ? local(e) : pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    try { root.releasePointerCapture(e.pointerId); } catch { /* already released */ }

    if (gesture?.kind === 'pinch') {
      if (pointers.size === 1) {
        // Carry on as a one-finger pan with the finger still down, without a jump.
        const [id, q] = [...pointers.entries()][0];
        gesture = { kind: 'pan', id, x0: q.x, y0: q.y, lastX: q.x, lastY: q.y, started: true, samples: [] };
      } else if (pointers.size === 0) {
        gesture = null;
        finishTwoTap(e, cancelled);
      }
      return;
    }
    if (gesture?.kind === 'pan' && e.pointerId === gesture.id) {
      clearTimeout(longTimer);
      const wasTap = !!press && press.id === e.pointerId && !gesture.started && !longFired && !cancelled && e.timeStamp - press.t < 650;
      if (gesture.started && !cancelled) startFling(gesture.samples, e.timeStamp);
      gesture = null;
      press = null;
      if (pointers.size === 0) {
        if (twoTap) finishTwoTap(e, cancelled);
        else if (wasTap && p) handleTap(p.x, p.y);
      }
    }
  }

  function finishTwoTap(e, cancelled) {
    const t = twoTap;
    twoTap = null;
    if (!t || t.moved || cancelled || e.timeStamp - t.t > 400) return;
    const c = following ? viewCenter() : t.mid || viewCenter();
    zoomAtAnimated(c.x, c.y, T.scale / 2.2);
  }

  function handleTap(x, y) {
    const now = performance.now();
    if (!pick) {
      const hit = hitTest(x, y);
      if (hit) {
        cancelPendingTap();
        lastTap = null;
        emitter.emit('tapitem', hit);
        return;
      }
    }
    if (lastTap && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(x - lastTap.x, y - lastTap.y) < 36) {
      cancelPendingTap();
      lastTap = null;
      doubleTapZoom(x, y);
      return;
    }
    lastTap = { x, y, t: now };
    cancelPendingTap();
    const pt = screenToPlan(T, x, y);
    tapTimer = setTimeout(() => {
      tapTimer = 0;
      if (destroyed) return;
      if (pick) animateTo(centerTransform(pt, T.scale, vw, vh), 260);   // bring the tapped spot under the cross
      else emitter.emit('tap', { x: pt.x, y: pt.y });
    }, TAP_DELAY_MS);
  }

  function doubleTapZoom(x, y) {
    const max = maxScale();
    const at = following ? viewCenter() : { x, y };
    if (T.scale >= max * 0.98) {
      if (following) zoomAtAnimated(at.x, at.y, fitScale());
      else animateTo(fitTransform(vw, vh, W, H, FIT_PAD));
    } else {
      zoomAtAnimated(at.x, at.y, Math.min(max, T.scale * 2.5));
    }
  }

  function onLongPress() {
    longTimer = 0;
    if (!press || gesture?.started || pick || destroyed || pointers.size !== 1) return;
    longFired = true;
    cancelPendingTap();
    const pt = screenToPlan(T, press.x, press.y);
    buzz(20);
    emitter.emit('longpress', { x: pt.x, y: pt.y });
  }

  function onContextMenu(e) {
    e.preventDefault();
    if (!gesturesOn() || pick || !sized) return;
    // A touch long press is handled by our own timer (same event); here only a mouse right-click counts.
    if (lastPointerType !== 'mouse' && performance.now() - lastDownAt < 1500) return;
    rect = root.getBoundingClientRect();
    const pt = screenToPlan(T, e.clientX - rect.left, e.clientY - rect.top);
    emitter.emit('longpress', { x: pt.x, y: pt.y });
  }

  function onWheel(e) {
    if (!gesturesOn() || !sized) return;
    e.preventDefault();
    stopAnim();
    rect = root.getBoundingClientRect();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= vh || 600;
    dy = clamp(dy, -240, 240);
    const k = e.ctrlKey ? 0.012 : 0.0022;   // ctrl + wheel = a trackpad pinch: finer steps
    const s = clampScale(T.scale * Math.exp(-dy * k));
    const at = following ? viewCenter() : local(e);
    quality = 'medium';
    setT(constrain(zoomAround(T, s, at.x, at.y)));
  }

  // Safari on a Mac sends trackpad pinches as gesture events, not ctrl + wheel.
  // On an iPhone the same events come with a touch pinch, which the pointer
  // handlers already do — so they only count when no finger is down.
  function onGestureStart(e) {
    e.preventDefault();
    if (!gesturesOn() || pointers.size || !sized) return;
    rect = root.getBoundingClientRect();
    const at = following || !isNum(e.clientX) ? viewCenter() : { x: e.clientX - rect.left, y: e.clientY - rect.top };
    safariGesture = { s0: T.scale, at };
  }
  function onGestureChange(e) {
    e.preventDefault();
    if (!safariGesture || pointers.size || !isNum(e.scale)) return;
    setT(constrain(zoomAround(T, clampScale(safariGesture.s0 * e.scale), safariGesture.at.x, safariGesture.at.y)));
  }
  function onGestureEnd(e) {
    e.preventDefault();
    safariGesture = null;
  }

  function onKey(e) {
    if (!gesturesOn() || e.target !== root || e.altKey || e.metaKey || e.ctrlKey || !sized) return;
    const c = viewCenter();
    const pan = (dx, dy) => {
      if (following) setFollowing(false);
      animateTo({ scale: T.scale, tx: T.tx + dx, ty: T.ty + dy }, 180);
    };
    switch (e.key) {
      case '+': case '=': zoomAtAnimated(c.x, c.y, T.scale * 1.6); break;
      case '-': case '_': zoomAtAnimated(c.x, c.y, T.scale / 1.6); break;
      case '0': if (following) setFollowing(false); animateTo(fitTransform(vw, vh, W, H, FIT_PAD)); break;
      case 'ArrowLeft': pan(90, 0); break;
      case 'ArrowRight': pan(-90, 0); break;
      case 'ArrowUp': pan(0, 90); break;
      case 'ArrowDown': pan(0, -90); break;
      default: return;
    }
    e.preventDefault();
  }

  function hover(e) {
    if (!gesturesOn() || !sized) return;
    rect = root.getBoundingClientRect();
    const p = local(e);
    root.classList.toggle('pv-hot', !pick && !!hitTest(p.x, p.y));
  }

  // ---- sizing --------------------------------------------------------------------------

  function measure() {
    const w = root.clientWidth, h = root.clientHeight;
    let d = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    d = Math.min(d, 3);
    if (w * h * d * d > MAX_CANVAS_PX) d = Math.max(0.75, Math.sqrt(MAX_CANVAS_PX / Math.max(1, w * h)));
    return { w, h, d };
  }

  function updateEdges() {
    try {
      const r = root.getBoundingClientRect();
      root.classList.toggle('pv-at-top', r.top < 24);
      root.classList.toggle('pv-at-bottom', r.bottom > (window.innerHeight || r.bottom) - 24);
    } catch { /* detached */ }
  }

  /** Re-measure the view (the container changed size, the phone turned). Called by a ResizeObserver too. */
  function resize() {
    if (destroyed) return;
    const { w, h, d } = measure();
    if (!w || !h) return;
    if (sized && w === vw && h === vh && d === dpr) { updateEdges(); return; }
    const wasFit = sized && Math.abs(T.scale / fitScale() - 1) < 0.01;
    const center = sized ? screenToPlan(T, vw / 2, vh / 2) : null;
    vw = w; vh = h; dpr = d;
    canvas.width = Math.max(1, Math.round(w * d));
    canvas.height = Math.max(1, Math.round(h * d));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    recomputeContent();
    if (!sized) {
      sized = true;
      if (pendingView) { const v = pendingView; pendingView = null; applyView(v, false); }
      else setT(constrain(fitTransform(vw, vh, W, H, FIT_PAD)));
    } else if (wasFit) {
      setT(constrain(fitTransform(vw, vh, W, H, FIT_PAD)));
    } else {
      setT(constrain(centerTransform(center, clampScale(T.scale), vw, vh)));
    }
    insetUpdate(true);
    updateEdges();
    if (pick) pick.ov.layout(vw, vh);
    // A resized canvas is blank until drawn: draw now, before the browser paints.
    dirty = false;
    draw();
  }

  // ---- image ------------------------------------------------------------------------------

  function onPyramidLevel() { requestDraw(); }

  function onImageLoad() {
    if (destroyed || !image) return;
    if (!imageWidth(image)) { imageState = 'failed'; requestDraw(); return; }
    attachPyramid();
  }
  function onImageError() {
    if (destroyed) return;
    imageState = 'failed';
    requestDraw();
  }

  function attachPyramid() {
    if (pyr) { releasePyramid(pyr, onPyramidLevel); pyr = null; }
    pyr = acquirePyramid(image, onPyramidLevel);
    imageState = 'ready';
    requestDraw();
  }

  function detachImage() {
    if (image?.removeEventListener) {
      image.removeEventListener('load', onImageLoad);
      image.removeEventListener('error', onImageError);
    }
    if (pyr) { releasePyramid(pyr, onPyramidLevel); pyr = null; }
    image = null;
    imageState = 'none';
  }

  /**
   * Show a different image of the same plan (a quick thumbnail first, the
   * full image when it has decoded), or a new plan of width × height.
   */
  function setImage(img, width, height) {
    if (destroyed) return;
    detachImage();
    const w = posNum(width), h = posNum(height);
    if (w && h && (w !== W || h !== H)) {
      W = w; H = h;
      recomputeContent();
      if (sized) setT(constrain(fitTransform(vw, vh, W, H, FIT_PAD)));
    }
    image = img || null;
    if (!image) { requestDraw(); return; }
    const pending = typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement && !image.complete;
    if (pending) {
      imageState = 'loading';
      image.addEventListener('load', onImageLoad);
      image.addEventListener('error', onImageError);
    } else if (!imageWidth(image)) {
      imageState = 'failed';
    } else {
      attachPyramid();
    }
    requestDraw();
  }

  // ---- public: content ----------------------------------------------------------------------

  /**
   * The items to show: photo pins (with the camera wedge from
   * pose.planHeading), video paths (track x, y), note pins. Items without a
   * plan position (not calibrated yet) are left out. {selectedId} draws that
   * one on top, bigger. Call again whenever items change (a live recording's
   * track included).
   */
  function setItems(list, { selectedId: sel = null } = {}) {
    if (destroyed) return;
    selectedId = sel ?? null;
    const nextPins = [], nextVideos = [];
    let b = null;
    const grow = (x, y) => {
      if (!b) b = { x0: x, y0: y, x1: x, y1: y };
      else { b.x0 = Math.min(b.x0, x); b.y0 = Math.min(b.y0, y); b.x1 = Math.max(b.x1, x); b.y1 = Math.max(b.y1, y); }
    };
    for (const it of Array.isArray(list) ? list : []) {
      if (!it || it.deletedAt) continue;
      const ps = it.pose || null;
      if (it.type === 'video') {
        const pts = [];
        for (const tp of it.track || []) if (validPt(tp)) pts.push({ x: tp.x, y: tp.y });
        if (!pts.length && validPt(ps?.plan)) pts.push({ x: ps.plan.x, y: ps.plan.y });
        if (!pts.length) continue;
        for (const q of pts) grow(q.x, q.y);
        nextVideos.push({ item: it, n: it.seq ?? null, pts, screen: null, stamp: -1 });
      } else {
        if (!validPt(ps?.plan)) continue;
        grow(ps.plan.x, ps.plan.y);
        nextPins.push({
          item: it,
          kind: it.type === 'note' ? 'note' : 'photo',
          x: ps.plan.x,
          y: ps.plan.y,
          h: it.type !== 'note' && isNum(ps.planHeading) ? ps.planHeading * DEG : null,
          n: it.seq ?? null,
          annotated: isAnnotated(it),
        });
      }
    }
    nextPins.sort((a, b2) => (a.n ?? 0) - (b2.n ?? 0));
    pins = nextPins;
    videos = nextVideos;
    itemsB = b;
    recomputeContent();
    requestDraw();
  }

  /** The person: blue dot at pose.plan, accuracy circle (pose.planAcc), heading cone (pose.planHeading). null hides it. */
  function setPose(p) {
    if (destroyed) return;
    pose = p || null;
    recomputeContent();
    if (!interactive) insetUpdate();
    requestDraw();
  }

  /** Points marked on the plan: [{x, y, label, color, kind: 'calib'|'scale'|'temp'}]. */
  function setMarks(list) {
    if (destroyed) return;
    marks = Array.isArray(list) ? list.filter(Boolean) : [];
    requestDraw();
  }

  /** Lines on the plan: [{a: {x, y}, b: {x, y}, label, color, dashed}] (a scale line, a wall). */
  function setLines(list) {
    if (destroyed) return;
    lines = Array.isArray(list) ? list.filter(Boolean) : [];
    requestDraw();
  }

  /**
   * Video playback: highlight `item`'s path and put the moving marker + cone
   * where the camera was at `tMs` (ms since the video started). null ends it.
   * The marker is kept on screen unless {keepInView: false} or the person is
   * moving the plan.
   */
  function setPlayback(item, tMs = 0, { keepInView = true } = {}) {
    if (destroyed) return;
    if (!item) {
      if (play) { play = null; requestDraw(); }
      return;
    }
    // The path is rebuilt only for another video (or a track that changed), not on every tick of the player.
    if (!play || play.item.id !== item.id || play.item.track !== item.track || play.len !== (item.track?.length || 0)) {
      const pts = [];
      for (const tp of item.track || []) if (validPt(tp)) pts.push({ x: tp.x, y: tp.y });
      if (!pts.length && validPt(item.pose?.plan)) pts.push({ x: item.pose.plan.x, y: item.pose.plan.y });
      play = { item, len: item.track?.length || 0, pt: null, video: pts.length ? { item, n: item.seq ?? null, pts, screen: null, stamp: -1 } : null };
    }
    play.item = item;
    let pt = interpolateTrack(item.track, tMs);
    if (!validPt(pt) && validPt(item.pose?.plan)) {
      pt = { x: item.pose.plan.x, y: item.pose.plan.y, planHeading: item.pose.planHeading ?? null };
    }
    play.pt = validPt(pt) ? pt : null;
    if (keepInView && play.pt && interactive && sized && !gesture && !anim && !following && !pick) {
      const s = planToScreen(T, play.pt.x, play.pt.y);
      const m = Math.min(56, vw / 4, vh / 4);
      if (s.x < m || s.y < m || s.x > vw - m || s.y > vh - m) animateTo(centerTransform(play.pt, T.scale, vw, vh), 420);
    }
    requestDraw();
  }

  // ---- public: view --------------------------------------------------------------------------

  /** Follow me: keep the person in the middle. Dragging or pinching turns it off (followchange). */
  function setFollowing(on) {
    if (destroyed || !interactive) return;
    on = !!on;
    if (following === on) return;
    following = on;
    if (on) { anim = null; requestFrame(); }
    emitter.emit('followchange', on);
  }

  /** Show the whole sheet. */
  function fit({ animate = true } = {}) {
    if (destroyed) return;
    if (interactive && following) setFollowing(false);
    if (!sized) { pendingView = null; return; }
    const t = fitTransform(vw, vh, W, H, FIT_PAD);
    if (animate) animateTo(t);
    else { anim = null; setT(constrain(t)); }
  }

  /** Bring plan point p to the middle, optionally at `scale` (CSS px per plan px). */
  function centerOn(p, scale, { animate = true } = {}) {
    if (destroyed || !validPt(p)) return;
    if (!sized) { pendingView = { x: p.x, y: p.y, scale: isNum(scale) ? scale : null }; return; }
    if (!interactive) {
      // The mini-map stays on the person; centerOn only sets its zoom.
      if (isNum(scale)) { T = { ...T, scale: clampScale(scale) }; insetZoomed = true; }
      if (validPt(pose?.plan)) { insetUpdate(); return; }
    }
    if (interactive && following) setFollowing(false);
    const t = centerTransform(p, clampScale(isNum(scale) ? scale : T.scale), vw, vh);
    if (animate) animateTo(t);
    else { anim = null; setT(constrain(t)); }
  }

  /** {x, y (plan point in the middle), scale (CSS px per plan px), zoom (scale ÷ fit scale)} */
  function getView() {
    if (!sized) return pendingView ? { ...pendingView } : { x: W / 2, y: H / 2, scale: null, zoom: 1 };
    const c = screenToPlan(T, vw / 2, vh / 2);
    return { x: c.x, y: c.y, scale: T.scale, zoom: T.scale / fitScale() };
  }

  function applyView(v, animate) {
    const s = clampScale(isNum(v.scale) ? v.scale : isNum(v.zoom) ? v.zoom * fitScale() : T.scale);
    const c = validPt(v) ? v : screenToPlan(T, vw / 2, vh / 2);
    const t = centerTransform(c, s, vw, vh);
    if (animate) animateTo(t);
    else { anim = null; setT(constrain(t)); }
  }

  /** Restore a view from getView() ({x, y} and scale or zoom). */
  function setView(v, { animate = false } = {}) {
    if (destroyed || !v) return;
    if (!sized) { pendingView = { ...v }; return; }
    applyView(v, animate);
  }

  /** The item under screen point (sx, sy) — CSS px from the view's top-left corner — or null. */
  function hitTest(sx, sy) {
    if (!sized) return null;
    const targets = [];
    for (const v of videos) targets.push({ kind: 'path', pts: screenPath(v), item: v.item });
    for (const v of videos) {
      const s = screenPath(v)[0];
      if (s) targets.push({ kind: 'pin', x: s.x, y: s.y, item: v.item, selected: v.item.id === selectedId });
    }
    for (const p of pins) {
      const s = planToScreen(T, p.x, p.y);
      targets.push({ kind: 'pin', x: s.x, y: s.y, item: p.item, selected: p.item.id === selectedId });
    }
    return hitTestTargets(targets, sx, sy)?.item || null;
  }

  // ---- public: precise placement ---------------------------------------------------------------

  /**
   * Precise placement: a fixed cross in the middle, the plan moves under it,
   * a 3× magnifier, Set / Cancel. Resolves {x, y} in plan px (kept on the
   * sheet), or null when cancelled. opts: {title, hint, initial: {x, y},
   * setLabel}. Starting another pick (or destroy) cancels this one.
   */
  function pickPoint({ title = 'Place the point', hint = 'Move the plan until the cross is exactly on the spot.', initial = null, setLabel = 'Set' } = {}) {
    if (destroyed) return Promise.resolve(null);
    pick?.finish(null);
    return new Promise((resolve) => {
      const wasFollowing = following && interactive;
      if (wasFollowing) setFollowing(false);
      stopAnim();
      cancelPendingTap();
      const pointUnderCross = () => {
        const c = screenToPlan(T, vw / 2, vh / 2);
        return { x: round2(clamp(c.x, 0, W)), y: round2(clamp(c.y, 0, H)) };
      };
      const ov = createPickOverlay({
        title, hint, setLabel,
        onSet: () => finish(sized ? pointUnderCross() : null),
        onCancel: () => finish(null),
      });
      const key = (e) => {
        if (overlayOpen() || isTypingTarget(e.target)) return;
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); finish(sized ? pointUnderCross() : null); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
      };
      document.addEventListener('keydown', key, true);
      root.append(ov.el);
      root.classList.add('pv-picking');
      root.classList.remove('pv-static');
      pick = { finish, ov, ctx: ov.loupe.getContext('2d') };
      if (sized) ov.layout(vw, vh);
      if (validPt(initial) && sized) {
        // The cross starts on the given spot, zoomed in enough to be precise.
        const s = clampScale(Math.max(T.scale, fitScale() * 3));
        anim = null;
        setT(constrain(centerTransform(initial, s, vw, vh)));
      }
      requestDraw();
      if (interactive) { try { root.focus({ preventScroll: true }); } catch { /* old browser */ } }

      function finish(value) {
        if (!pick || pick.finish !== finish) return;
        document.removeEventListener('keydown', key, true);
        pick = null;
        ov.destroy();
        root.classList.remove('pv-picking');
        if (!interactive) root.classList.add('pv-static');
        if (value) buzz(15);
        if (!destroyed) {
          animateTo(T, 200);            // back to the normal limits (a small plan re-centres)
          requestDraw();
          if (wasFollowing) setFollowing(true);
        }
        resolve(value);
      }
    });
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  let ro = null;
  let darkMql = null;
  let themeObs = null;
  const onTheme = () => { markerColors({ refresh: true }); requestDraw(); };
  const onWindowResize = () => resize();

  function destroy() {
    if (destroyed) return;
    // Mark destroyed first: ending a pending pick here must not glide the view
    // or tell the (closing) screen that Follow me came back on.
    destroyed = true;
    pick?.finish(null);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    clearTimeout(tapTimer);
    clearTimeout(longTimer);
    clearTimeout(settleTimer);
    ro?.disconnect();
    window.removeEventListener('resize', onWindowResize);
    try { darkMql?.removeEventListener('change', onTheme); } catch { /* old Safari */ }
    themeObs?.disconnect();
    for (const [t, fn, o] of listeners) root.removeEventListener(t, fn, o);
    detachImage();
    pointers.clear();
    try { canvas.width = 0; canvas.height = 0; } catch { /* gone */ }
    root.remove();
    for (const off of offs) off();
    offs.clear();
  }

  const listeners = [
    ['pointerdown', onDown, false],
    ['pointermove', onMove, false],
    ['pointerup', onUp, false],
    ['pointercancel', onUp, false],
    ['lostpointercapture', onUp, false],
    ['wheel', onWheel, { passive: false }],
    ['contextmenu', onContextMenu, false],
    ['keydown', onKey, false],
    ['gesturestart', onGestureStart, false],
    ['gesturechange', onGestureChange, false],
    ['gestureend', onGestureEnd, false],
    ['pointerleave', () => root.classList.remove('pv-hot'), false],
  ];
  for (const [t, fn, o] of listeners) root.addEventListener(t, fn, o);

  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => resize());
    ro.observe(root);
  }
  window.addEventListener('resize', onWindowResize);
  try {
    darkMql = matchMedia('(prefers-color-scheme: dark)');
    darkMql.addEventListener('change', onTheme);
  } catch { darkMql = null; }
  if (typeof MutationObserver === 'function') {
    themeObs = new MutationObserver(onTheme);
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  setImage(opts.image || null);
  resize();

  return {
    el: root,
    setItems,
    setPose,
    setMarks,
    setLines,
    setPlayback,
    setFollow: setFollowing,
    isFollowing: () => following,
    fit,
    centerOn,
    getView,
    setView,
    pickPoint,
    hitTest,
    /** Listen: 'tapitem' | 'tap' | 'longpress' | 'viewchange' | 'followchange'. Returns the function that stops listening. */
    on(type, fn) {
      const off = emitter.on(type, fn);
      offs.add(off);
      return () => { offs.delete(off); off(); };
    },
    off(type, fn) { emitter.off(type, fn); },
    resize,
    destroy,
    // Beyond docs/SPEC.md §7 (optional):
    setImage,
    setUnits(u) { units = u || 'imperial'; requestDraw(); },
    setPxPerMeter(v) { pxPerMeter = posNum(v) || null; requestDraw(); },
    planToScreen: (x, y) => planToScreen(T, x, y),
    screenToPlan: (x, y) => screenToPlan(T, x, y),
    isPicking: () => !!pick,
  };
}
