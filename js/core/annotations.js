// annotations.js — photo markup: the shapes, their geometry, and drawing them.
//
// Markup is kept as SHAPES next to the untouched original photo
// (item.annotations), plus a flattened JPEG copy with the markup burned in
// (item.media.annotated) for sharing, export and the viewer. Keeping the
// shapes, not just pixels, means a markup can be edited again later and
// re-flattened at any size — and the original photo is never altered.
//
// Coordinates and sizes are PHOTO pixels of the original (EXIF-oriented)
// image: x right, y down, origin top-left. Stroke widths and text sizes
// default to a fraction of the photo's long side (strokeWidthFor,
// fontSizeFor), so "M" looks the same on a 4000 px photo and a 1000 px one,
// and a markup scales cleanly with its photo.
//
//   Annotations = {v: 1, width, height, shapes: [Shape], updatedAt}
//   Shape       = {id, type, color, width /* stroke px in photo pixels */, …}
//     pen        {points: [[x, y], …], mode: 'pen'|'highlight'}
//     line|arrow|rect|ellipse|cloud|dimension {a: {x, y}, b: {x, y}, label? (dimension), size? (label font px)}
//     text       {at: {x, y} /* top-left of the box */, text, size /* font px */, bg: true}
//     badge      {at: {x, y} /* centre */, n, size? /* font px */}
//
// Shapes are treated as immutable values: every helper that "changes" one
// returns a new copy. The editor's undo stack relies on that.
//
// Everything except decodeImageBlob / flatten and the default text
// measurer is pure, so tests/annotations.test.mjs runs it in
// Node (which has no canvas). Browser globals are only touched inside
// functions, never at module load.

import { uid, parseLength, formatLength } from './util.js';

export const ANNOTATIONS_VERSION = 1;

export const SHAPE_TYPES = Object.freeze(['pen', 'line', 'arrow', 'rect', 'ellipse', 'cloud', 'dimension', 'text', 'badge']);

/** The markup colours, in toolbar order. Red first: it is the default and reads best on a job site. */
export const COLORS = Object.freeze([
  { id: 'red', label: 'Red', value: '#e53935' },
  { id: 'yellow', label: 'Yellow', value: '#fdd835' },
  { id: 'blue', label: 'Blue', value: '#1e88e5' },
  { id: 'green', label: 'Green', value: '#43a047' },
  { id: 'white', label: 'White', value: '#ffffff' },
  { id: 'black', label: 'Black', value: '#111111' },
]);
export const DEFAULT_COLOR = COLORS[0].value;

/**
 * S / M / L as fractions of the photo's long side. `stroke` is a pen or
 * line width, `font` a text size. Picked so that, with the photo fitted to
 * a phone screen, S is a fine line and L is easy to see at arm's length.
 */
export const SIZE_PRESETS = Object.freeze({
  S: Object.freeze({ stroke: 0.0025, font: 0.024 }),
  M: Object.freeze({ stroke: 0.005, font: 0.034 }),
  L: Object.freeze({ stroke: 0.009, font: 0.048 }),
});
export const SIZE_KEYS = Object.freeze(['S', 'M', 'L']);

/** A highlighter stroke is this many times wider than a pen of the same size, and drawn at this opacity. */
export const HIGHLIGHT_FACTOR = 5;
export const HIGHLIGHT_ALPHA = 0.4;

/** Revision-cloud scallops: chord length per stroke width, and how far each one bulges (fraction of its chord). */
export const CLOUD_ARC_PER_WIDTH = 7;
export const CLOUD_BULGE = 0.38;

/** The largest canvas iPhone Safari will draw (4096 × 4096 pixels of area); bigger ones come out blank. */
export const MAX_CANVAS_PIXELS = 16_777_216;
/** The longest side any browser we target allows a canvas to have. */
export const MAX_CANVAS_SIDE = 16_384;

export const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const OUT_OF_MEMORY = 'The phone ran out of memory while drawing the marked-up copy. Close other apps and try again.';
const LINE_TYPES = new Set(['line', 'arrow', 'dimension']);
const BOX_TYPES = new Set(['rect', 'ellipse', 'cloud']);
const TWO_POINT_TYPES = new Set(['line', 'arrow', 'rect', 'ellipse', 'cloud', 'dimension']);
const SIZED_TYPES = new Set(['text', 'badge', 'dimension']);

const round1 = (v) => Math.round(v * 10) / 10;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPt = (p) => !!p && isNum(p.x) && isNum(p.y);

// ---- sizes -----------------------------------------------------------------------

function longSide(width, height) {
  return Math.max(width || 0, height || 0) || 1000;
}

function preset(key) {
  return SIZE_PRESETS[key] || SIZE_PRESETS.M;
}

/** Pen / line stroke width in photo pixels for size S, M or L on a photo of this size. */
export function strokeWidthFor(key, width, height) {
  return round1(Math.max(1, longSide(width, height) * preset(key).stroke));
}

/** Highlighter stroke width in photo pixels. */
export function highlightWidthFor(key, width, height) {
  return round1(Math.max(4, longSide(width, height) * preset(key).stroke * HIGHLIGHT_FACTOR));
}

/** Font size (text, dimension labels, callout numbers) in photo pixels. */
export function fontSizeFor(key, width, height) {
  return round1(Math.max(10, longSide(width, height) * preset(key).font));
}

/** The font size of a dimension label; older shapes without `size` derive it from the stroke. */
export function labelSize(shape) {
  return shape.size > 0 ? shape.size : Math.max(12, (shape.width || 2) * 6.5);
}

/** Radius of a numbered callout circle. */
export function badgeRadius(shape) {
  return (shape.size > 0 ? shape.size : Math.max(12, (shape.width || 2) * 6.5)) * 0.72;
}

/** Which of S / M / L a shape was drawn with (the closest one), so the toolbar can show it. */
export function nearestSizeKey(shape, width, height) {
  if (!shape) return 'M';
  let target;
  let f;
  if (SIZED_TYPES.has(shape.type)) {
    target = shape.type === 'dimension' ? labelSize(shape) : (shape.size || fontSizeFor('M', width, height));
    f = (k) => fontSizeFor(k, width, height);
  } else if (shape.type === 'pen' && shape.mode === 'highlight') {
    target = shape.width;
    f = (k) => highlightWidthFor(k, width, height);
  } else {
    target = shape.width;
    f = (k) => strokeWidthFor(k, width, height);
  }
  if (!(target > 0)) return 'M';
  let best = 'M';
  let bestErr = Infinity;
  for (const k of SIZE_KEYS) {
    const err = Math.abs(Math.log(target / f(k)));
    if (err < bestErr) { bestErr = err; best = k; }
  }
  return best;
}

// ---- shapes: create, copy, check ---------------------------------------------------

/** A deep copy of a shape (shapes are plain JSON). */
export function cloneShape(shape) {
  return JSON.parse(JSON.stringify(shape));
}

/**
 * A new shape with a fresh id. `fields` are copied, so the caller's objects
 * are never shared with the shape.
 */
export function createShape(type, fields = {}) {
  const s = { id: uid('s_'), type, color: DEFAULT_COLOR, width: 4, ...cloneShape(fields) };
  if (type === 'pen' && !s.mode) s.mode = 'pen';
  if (type === 'text' && s.bg === undefined) s.bg = true;
  return s;
}

/** True when a shape has everything it needs to be drawn (guards against a damaged draft or import). */
export function isValidShape(s) {
  if (!s || typeof s !== 'object' || typeof s.type !== 'string') return false;
  if (typeof s.color !== 'string' || !isNum(s.width) || s.width < 0) return false;
  if (s.type === 'pen') {
    return Array.isArray(s.points) && s.points.length > 0 &&
      s.points.every((p) => Array.isArray(p) && isNum(p[0]) && isNum(p[1]));
  }
  if (TWO_POINT_TYPES.has(s.type)) return isPt(s.a) && isPt(s.b);
  if (s.type === 'text') return isPt(s.at) && typeof s.text === 'string' && isNum(s.size) && s.size > 0;
  if (s.type === 'badge') return isPt(s.at) && isNum(s.n);
  return false;
}

/** Copies of the valid shapes of a list (anything damaged is dropped, missing ids are filled in). */
export function sanitizeShapes(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const s of list) {
    if (!isValidShape(s)) continue;
    const c = cloneShape(s);
    if (typeof c.id !== 'string' || !c.id || seen.has(c.id)) c.id = uid('s_');
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

/** The record stored on item.annotations. */
export function toAnnotations(width, height, shapes, updatedAt = Date.now()) {
  return { v: ANNOTATIONS_VERSION, width, height, shapes: (shapes || []).map(cloneShape), updatedAt };
}

/** Same shapes, same order, same values. */
export function sameShapes(a, b) {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}

/** A shape scaled by sx, sy (photo resized). Line widths and text sizes scale by the mean factor. */
export function scaleShape(shape, sx, sy) {
  const s = cloneShape(shape);
  const k = Math.sqrt(Math.abs(sx * sy)) || 1;
  const sp = (p) => ({ x: p.x * sx, y: p.y * sy });
  if (s.type === 'pen') s.points = s.points.map(([x, y]) => [round1(x * sx), round1(y * sy)]);
  if (s.a) s.a = sp(s.a);
  if (s.b) s.b = sp(s.b);
  if (s.at) s.at = sp(s.at);
  if (isNum(s.width)) s.width = round1(s.width * k);
  if (isNum(s.size)) s.size = round1(s.size * k);
  return s;
}

/**
 * Annotations fitted to a photo of width × height. A markup made on a copy
 * of a different size (an import, a resized original) keeps its place on
 * the picture. Returns a new object with sanitized copies of the shapes.
 */
export function rescaleAnnotations(ann, width, height) {
  if (!ann) return null;
  const shapes = sanitizeShapes(ann.shapes);
  const aw = ann.width > 0 ? ann.width : width;
  const ah = ann.height > 0 ? ann.height : height;
  const out = { v: ANNOTATIONS_VERSION, width, height, shapes, updatedAt: ann.updatedAt || null };
  if (aw === width && ah === height) return out;
  out.shapes = shapes.map((s) => scaleShape(s, width / aw, height / ah));
  return out;
}

// ---- saving and drafts (the item fields) ------------------------------------------
//
// item.annotations         the saved markup (Annotations) or null
// item.media.annotated     the flattened JPEG, item.media.annotatedThumb its thumbnail
// item.annotationHistory   [{mediaId, thumbId, at, annotations}] — every earlier
//                          marked-up copy, kept (their bytes are never deleted)
// item.annotationsDraft    unsaved shapes, autosaved while the editor is open

/**
 * Point an item at newly saved markup — the mutator passed to
 * store.updateItem, so it runs inside one transaction. The previous
 * marked-up copy (and the shapes it was made from) moves to
 * annotationHistory, never dropped; the draft is cleared; media.original is
 * never touched. No shapes (all markup cleared) → annotations and
 * media.annotated become null.
 */
export function applySavedMarkup(item, { annotations, annotatedId = null, thumbId = null, at = Date.now() }) {
  const media = { ...(item.media || {}) };
  const history = Array.isArray(item.annotationHistory) ? [...item.annotationHistory] : [];
  if (media.annotated && media.annotated !== annotatedId) {
    history.push({ mediaId: media.annotated, thumbId: media.annotatedThumb || null, at, annotations: item.annotations || null });
  }
  const has = !!annotations?.shapes?.length && !!annotatedId;
  media.annotated = has ? annotatedId : null;
  media.annotatedThumb = has ? thumbId || null : null;
  item.media = media;
  item.annotationHistory = history;
  item.annotations = annotations?.shapes?.length ? annotations : null;
  item.annotationsDraft = null;
  return item;
}

/** The record autosaved to item.annotationsDraft while editing. */
export function makeDraft(width, height, shapes, baseUpdatedAt = null) {
  return { v: ANNOTATIONS_VERSION, width, height, shapes: (shapes || []).map(cloneShape), updatedAt: Date.now(), baseUpdatedAt };
}

/**
 * The unsaved draft worth offering when the editor opens ("Continue your
 * markup?"), fitted to a photo of width × height — or null when there is
 * none, it is older than the saved markup, or it is the same as it.
 */
export function draftToOffer(item, width, height) {
  const d = item?.annotationsDraft;
  if (!d || !Array.isArray(d.shapes)) return null;
  const savedAt = item.annotations?.updatedAt || 0;
  if ((d.updatedAt || 0) < savedAt) return null;
  const draft = rescaleAnnotations(d, width, height);
  const saved = item.annotations ? rescaleAnnotations(item.annotations, width, height).shapes : [];
  if (sameShapes(draft.shapes, saved)) return null;
  return { shapes: draft.shapes, updatedAt: d.updatedAt || null };
}

/** The number the next callout gets: one more than the highest so far (1 for the first). */
export function nextBadgeNumber(shapesOrAnn) {
  const shapes = Array.isArray(shapesOrAnn) ? shapesOrAnn : shapesOrAnn?.shapes || [];
  let max = 0;
  for (const s of shapes) {
    if (s?.type === 'badge' && isNum(s.n) && s.n > max) max = Math.floor(s.n);
  }
  return max + 1;
}

/** A copy in another colour. */
export function applyColor(shape, color) {
  const s = cloneShape(shape);
  s.color = color;
  return s;
}

/**
 * A copy drawn at size S, M or L. Text keeps its centre where it was, so it
 * grows or shrinks in place instead of drifting to the right.
 */
export function applySize(shape, key, width, height, measure = measureText) {
  let s = cloneShape(shape);
  s.width = s.type === 'pen' && s.mode === 'highlight'
    ? highlightWidthFor(key, width, height)
    : strokeWidthFor(key, width, height);
  if (SIZED_TYPES.has(s.type)) s.size = fontSizeFor(key, width, height);
  if (s.type === 'text') {
    const before = textLayout(shape, measure);
    const after = textLayout(s, measure);
    s = moveShape(s, (before.w - after.w) / 2, (before.h - after.h) / 2);
  }
  return s;
}

/**
 * Tidy a dimension label: a plain length the person typed ("12 6", "12-6",
 * "12ft 6in", "150in", "3.81m") is written the standard way (12' 6",
 * 3.81 m). Anything else — a lone number, words, fractions, "TYP",
 * "16\" o.c." — is kept exactly as typed, and so is any length that would
 * change by being rewritten.
 */
export function formatDimensionLabel(text, units = 'imperial') {
  const t = String(text ?? '').trim();
  if (!t) return '';
  const lower = t.toLowerCase();
  const bare = lower.replace(/feet|foot|ft|inches|inch|in|meters?|metres?|mm|cm|m/g, '');
  if (!/^[\d\s.,'"’′”″-]*$/.test(bare) || !/\d/.test(bare)) return t;
  const metricTyped = /\d\s*(mm|cm|m|meters?|metres?)$/.test(lower);
  const imperialTyped = /['"’′”″]|ft|feet|foot|in/.test(lower);
  // A lone number ("16") could be feet or inches: leave it as typed.
  if (!metricTyped && !imperialTyped && /^\s*\d+(?:[.,]\d+)?\s*$/.test(t)) return t;
  const system = metricTyped ? 'metric' : imperialTyped ? 'imperial' : units;
  const meters = parseLength(t, units);
  if (meters == null || !(meters > 0)) return t;
  const out = formatLength(meters, system, { precisionIn: 0.5 });
  const back = parseLength(out, system);
  if (back == null || Math.abs(back - meters) > 1e-4) return t;
  return out;
}

// ---- geometry --------------------------------------------------------------------------

export function dist(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Shortest distance from point p to the segment a–b (a point when a = b). */
export function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Shortest distance from p to a polyline of [x, y] points (closed = also the last-to-first segment). */
export function distToPolyline(p, points, closed = false) {
  if (!points?.length) return Infinity;
  if (points.length === 1) return Math.hypot(p.x - points[0][0], p.y - points[0][1]);
  let best = Infinity;
  const n = points.length;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % n];
    const d = distToSegment(p, { x: ax, y: ay }, { x: bx, y: by });
    if (d < best) best = d;
  }
  return best;
}

/** The rectangle between two corner points, whichever way they were dragged: {x, y, w, h} with w, h ≥ 0. */
export function normalizeRect(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/** Is p inside rect r (grown by pad on every side)? */
export function pointInRect(p, r, pad = 0) {
  return p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;
}

function distToRectOutline(p, r) {
  const c = [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];
  let best = Infinity;
  for (let i = 0; i < 4; i++) best = Math.min(best, distToSegment(p, c[i], c[(i + 1) % 4]));
  return best;
}

function pointInTriangle(p, a, b, c) {
  const s = (p1, p2, p3) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  const d1 = s(p, a, b);
  const d2 = s(p, b, c);
  const d3 = s(p, c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** b moved so the line a→b points at the nearest multiple of stepDeg (Shift while drawing). Length is kept. */
export function snapAngle(a, b, stepDeg = 45) {
  const len = dist(a, b);
  if (!len) return { x: b.x, y: b.y };
  const step = stepDeg * Math.PI / 180;
  const ang = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / step) * step;
  return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
}

/** b moved so a–b is a square (Shift while drawing a box, circle or cloud). */
export function squareFrom(a, b) {
  const s = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  return { x: a.x + (b.x >= a.x ? s : -s), y: a.y + (b.y >= a.y ? s : -s) };
}

/**
 * Drop points closer than minDist to the last one kept (a finger reports
 * far more points than a smooth line needs). The first and last points are
 * always kept, so a stroke ends exactly where the finger lifted.
 */
export function decimatePoints(points, minDist) {
  if (!points || points.length <= 2) return (points || []).map((p) => [p[0], p[1]]);
  const out = [[points[0][0], points[0][1]]];
  const md2 = minDist * minDist;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const [lx, ly] = out[out.length - 1];
    if ((x - lx) ** 2 + (y - ly) ** 2 >= md2) out.push([x, y]);
  }
  const last = points[points.length - 1];
  const [lx, ly] = out[out.length - 1];
  if (last[0] !== lx || last[1] !== ly) out.push([last[0], last[1]]);
  return out;
}

/**
 * Ramer–Douglas–Peucker: keep only the points needed to stay within
 * `epsilon` of the stroke. Iterative, so a very long stroke cannot overflow
 * the call stack.
 */
export function simplifyPath(points, epsilon) {
  if (!points || points.length <= 2 || !(epsilon > 0)) return (points || []).map((p) => [p[0], p[1]]);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const a = { x: points[s][0], y: points[s][1] };
    const b = { x: points[e][0], y: points[e][1] };
    let maxD = -1;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = distToSegment({ x: points[i][0], y: points[i][1] }, a, b);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx > 0 && maxD > epsilon) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push([points[i][0], points[i][1]]);
  return out;
}

/** Points rounded to `decimals` places (keeps saved markup small). */
export function roundPoints(points, decimals = 1) {
  const f = 10 ** decimals;
  return (points || []).map(([x, y]) => [Math.round(x * f) / f, Math.round(y * f) / f]);
}

/** The outline of the ellipse inscribed in rect r, as n [x, y] points. */
export function ellipsePoints(r, n = 72) {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push([cx + Math.cos(t) * r.w / 2, cy + Math.sin(t) * r.h / 2]);
  }
  return out;
}

/**
 * An arrowhead at b for the arrow a→b: a filled triangle {tip, left, right,
 * base}, and `shaftEnd`, where the line should stop so its round cap stays
 * hidden inside the head. The head is about 4 stroke widths long, and never
 * more than 60 % of a short arrow. null when a = b.
 */
export function arrowHead(a, b, width) {
  const len = dist(a, b);
  if (len < 1e-6) return null;
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const hl = Math.min(Math.max(width * 4.2, 8), len * 0.6);
  const hw = hl * Math.tan(26 * Math.PI / 180);
  const base = { x: b.x - ux * hl, y: b.y - uy * hl };
  const nx = -uy;
  const ny = ux;
  return {
    tip: { x: b.x, y: b.y },
    base,
    left: { x: base.x + nx * hw, y: base.y + ny * hw },
    right: { x: base.x - nx * hw, y: base.y - ny * hw },
    shaftEnd: { x: b.x - ux * hl * 0.7, y: b.y - uy * hl * 0.7 },
    length: hl,
  };
}

/**
 * A dimension line |<—— 12' 6" ——>| from a to b: end ticks across the line,
 * small arrowheads pointing out to them, the midpoint, and the angle for
 * the label, kept upright (between −90° and 90°) so it never reads upside
 * down.
 */
export function dimensionGeometry(a, b, width) {
  const len = dist(a, b);
  const ux = len ? (b.x - a.x) / len : 1;
  const uy = len ? (b.y - a.y) / len : 0;
  const nx = -uy;
  const ny = ux;
  const tick = Math.max(width * 4, 6);
  const head = Math.min(Math.max(width * 3.4, 6), len * 0.3);
  const hw = head * 0.45;
  const headAt = (p, dir) => {
    const base = { x: p.x + ux * head * dir, y: p.y + uy * head * dir };
    return { tip: { x: p.x, y: p.y }, left: { x: base.x + nx * hw, y: base.y + ny * hw }, right: { x: base.x - nx * hw, y: base.y - ny * hw } };
  };
  let angle = Math.atan2(uy, ux);
  if (angle > Math.PI / 2) angle -= Math.PI;
  else if (angle <= -Math.PI / 2) angle += Math.PI;
  return {
    length: len,
    ticks: [
      [{ x: a.x + nx * tick, y: a.y + ny * tick }, { x: a.x - nx * tick, y: a.y - ny * tick }],
      [{ x: b.x + nx * tick, y: b.y + ny * tick }, { x: b.x - nx * tick, y: b.y - ny * tick }],
    ],
    heads: head > 0.5 ? [headAt(a, 1), headAt(b, -1)] : [],
    mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    angle,
  };
}

/** The label box of a dimension (centred on the line, rotated with it), or null when it has no label. */
export function dimensionLabelBox(shape, measure = measureText) {
  const label = String(shape.label ?? '').trim();
  if (!label) return null;
  const g = dimensionGeometry(shape.a, shape.b, shape.width);
  const size = labelSize(shape);
  const w = measure(label, size) + size * 0.7;
  const h = size * 1.45;
  const c = Math.cos(g.angle);
  const s = Math.sin(g.angle);
  const corners = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
    .map(([lx, ly]) => ({ x: g.mid.x + lx * c - ly * s, y: g.mid.y + lx * s + ly * c }));
  return { cx: g.mid.x, cy: g.mid.y, angle: g.angle, w, h, size, label, corners, radius: h * 0.28 };
}

function pointInBox(p, box, pad = 0) {
  const dx = p.x - box.cx;
  const dy = p.y - box.cy;
  const c = Math.cos(-box.angle);
  const s = Math.sin(-box.angle);
  const lx = dx * c - dy * s;
  const ly = dx * s + dy * c;
  return Math.abs(lx) <= box.w / 2 + pad && Math.abs(ly) <= box.h / 2 + pad;
}

/** Chord length of one revision-cloud scallop for a cloud drawn with this stroke width. */
export function cloudArcSize(width) {
  return Math.max((width || 1) * CLOUD_ARC_PER_WIDTH, 6);
}

/**
 * The scallops of a revision cloud around the rectangle a–b, walking the
 * outline clockwise from the top-left corner. Each side is split into
 * equal chords close to `arcSize`; each chord gets a circular arc bulging
 * OUT of the rectangle (sagitta = CLOUD_BULGE × chord). The end of each arc
 * is the start of the next, so they draw as one closed path:
 *   ctx.moveTo(arcs[0].x0, arcs[0].y0); for (const c of arcs) ctx.arc(c.cx, c.cy, c.r, c.a0, c.a1, false);
 * Returns [{x0, y0, x1, y1, cx, cy, r, a0, a1, peak}] — [] for an empty rectangle.
 */
export function cloudArcs(a, b, arcSize) {
  const r = normalizeRect(a, b);
  if (r.w < 1e-6 && r.h < 1e-6) return [];
  const target = Math.max(1, arcSize || 1);
  const corners = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
  const arcs = [];
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = corners[i];
    const [x1, y1] = corners[(i + 1) % 4];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1e-6) continue; // a flat cloud has two sides of zero length
    const n = Math.max(1, Math.round(len / target));
    const ux = (x1 - x0) / len;
    const uy = (y1 - y0) / len;
    // Walking clockwise on screen (y down), "outside" is the direction turned −90°.
    const nx = uy;
    const ny = -ux;
    const chord = len / n;
    const sag = chord * CLOUD_BULGE;
    const rad = (chord * chord / 4 + sag * sag) / (2 * sag);
    for (let k = 0; k < n; k++) {
      const sx = x0 + ux * chord * k;
      const sy = y0 + uy * chord * k;
      const ex = k === n - 1 ? x1 : sx + ux * chord;
      const ey = k === n - 1 ? y1 : sy + uy * chord;
      const mx = (sx + ex) / 2;
      const my = (sy + ey) / 2;
      const cx = mx - nx * (rad - sag);
      const cy = my - ny * (rad - sag);
      arcs.push({
        x0: sx, y0: sy, x1: ex, y1: ey, cx, cy, r: rad,
        a0: Math.atan2(sy - cy, sx - cx),
        a1: Math.atan2(ey - cy, ex - cx),
        peak: { x: mx + nx * sag, y: my + ny * sag },
      });
    }
  }
  return arcs;
}

// ---- text ------------------------------------------------------------------------------

/** The canvas font for markup text of `size` photo pixels. */
export function fontFor(size) {
  return `700 ${Math.round(size * 100) / 100}px ${FONT_STACK}`;
}

let measureCtx = null; // null = not tried yet, false = no canvas here (Node)

/**
 * Width of `text` in the markup font at `size` px. Uses a real canvas when
 * there is one (so hit boxes match what is drawn), else a close estimate.
 */
export function measureText(text, size) {
  if (measureCtx === null) {
    measureCtx = false;
    // Safari before 16.4 has OffscreenCanvas without a 2D context: fall back to a DOM canvas.
    try {
      if (typeof OffscreenCanvas !== 'undefined') measureCtx = new OffscreenCanvas(1, 1).getContext('2d') || false;
    } catch { measureCtx = false; }
    try {
      if (!measureCtx && typeof document !== 'undefined') measureCtx = document.createElement('canvas').getContext('2d') || false;
    } catch { measureCtx = false; }
  }
  if (measureCtx) {
    measureCtx.font = fontFor(size);
    return measureCtx.measureText(String(text)).width;
  }
  return String(text).length * size * 0.56;
}

/**
 * Where a text shape's box and lines go: {x, y, w, h, pad, lineH, ascent,
 * size, lines, radius}. `at` is the top-left of the box.
 */
export function textLayout(shape, measure = measureText) {
  const size = shape.size > 0 ? shape.size : 24;
  const lines = String(shape.text ?? '').split(/\r?\n/);
  const pad = size * 0.38;
  const lineH = size * 1.22;
  let tw = 0;
  for (const l of lines) tw = Math.max(tw, measure(l, size));
  const w = tw + pad * 2;
  const h = pad * 2 + size * 1.08 + (lines.length - 1) * lineH;
  return { x: shape.at.x, y: shape.at.y, w, h, pad, lineH, ascent: size * 0.86, size, lines, radius: Math.min(size * 0.35, h / 2) };
}

/** Is this colour light (white, yellow)? Decides dark-on-light or light-on-dark for labels and numbers. */
export function isLightColor(color) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || '').trim());
  if (!m) return false;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6;
}

/**
 * Colours for a text box or dimension label: the text in the markup colour
 * on a solid box that contrasts with it — white for dark colours (with a
 * border in the colour), near-black for white and yellow. Readable on any
 * photo, in bright sun.
 */
export function textColors(color) {
  if (isLightColor(color)) return { fg: color, bg: 'rgba(17, 17, 17, 0.85)', border: null };
  return { fg: color, bg: 'rgba(255, 255, 255, 0.94)', border: color };
}

// ---- bounds, handles, moving --------------------------------------------------------------

function boundsOfPoints(pts, pad = 0) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    const x = Array.isArray(p) ? p[0] : p.x;
    const y = Array.isArray(p) ? p[1] : p.y;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
}

/** The box a shape covers on the photo, strokes, arrowheads, scallops and labels included: {x, y, w, h}. */
export function shapeBounds(s, measure = measureText) {
  const half = (s.width || 0) / 2;
  switch (s.type) {
    case 'pen':
      return boundsOfPoints(s.points, half);
    case 'line':
      return boundsOfPoints([s.a, s.b], half);
    case 'arrow': {
      const h = arrowHead(s.a, s.b, s.width);
      return boundsOfPoints(h ? [s.a, s.b, h.left, h.right] : [s.a, s.b], half);
    }
    case 'rect':
    case 'ellipse':
      return boundsOfPoints([s.a, s.b], half);
    case 'cloud':
      return boundsOfPoints([s.a, s.b], half + cloudArcSize(s.width) * CLOUD_BULGE);
    case 'dimension': {
      const g = dimensionGeometry(s.a, s.b, s.width);
      const pts = [s.a, s.b, ...g.ticks.flat()];
      const lb = dimensionLabelBox(s, measure);
      if (lb) pts.push(...lb.corners);
      return boundsOfPoints(pts, half);
    }
    case 'text': {
      const L = textLayout(s, measure);
      return { x: L.x, y: L.y, w: L.w, h: L.h };
    }
    case 'badge': {
      const r = badgeRadius(s) * 1.08;
      return { x: s.at.x - r, y: s.at.y - r, w: r * 2, h: r * 2 };
    }
    default:
      return { x: 0, y: 0, w: 0, h: 0 };
  }
}

/**
 * The drag handles of a shape, in photo pixels: the two ends of a line,
 * arrow or dimension ('a', 'b'); the four corners of a box, circle or cloud
 * ('nw', 'ne', 'se', 'sw'). Pen strokes, text and numbers only move.
 */
export function shapeHandles(s) {
  if (LINE_TYPES.has(s.type)) return [{ id: 'a', x: s.a.x, y: s.a.y }, { id: 'b', x: s.b.x, y: s.b.y }];
  if (BOX_TYPES.has(s.type)) {
    const r = normalizeRect(s.a, s.b);
    return [
      { id: 'nw', x: r.x, y: r.y },
      { id: 'ne', x: r.x + r.w, y: r.y },
      { id: 'se', x: r.x + r.w, y: r.y + r.h },
      { id: 'sw', x: r.x, y: r.y + r.h },
    ];
  }
  return [];
}

/**
 * A copy of `s` with handle `id` dragged to p. Always pass the shape as it
 * was when the drag started: the opposite corner is taken from it, so a
 * corner dragged past its opposite flips the box cleanly.
 */
export function dragHandle(s, id, p) {
  const out = cloneShape(s);
  if (id === 'a' || id === 'b') {
    out[id] = { x: p.x, y: p.y };
    return out;
  }
  if (!BOX_TYPES.has(s.type)) return out;
  const r = normalizeRect(s.a, s.b);
  const opposite = {
    nw: { x: r.x + r.w, y: r.y + r.h },
    ne: { x: r.x, y: r.y + r.h },
    se: { x: r.x, y: r.y },
    sw: { x: r.x + r.w, y: r.y },
  }[id];
  if (!opposite) return out;
  const n = normalizeRect(opposite, p);
  out.a = { x: n.x, y: n.y };
  out.b = { x: n.x + n.w, y: n.y + n.h };
  return out;
}

/** A copy of `s` moved by dx, dy photo pixels. */
export function moveShape(s, dx, dy) {
  const out = cloneShape(s);
  const mv = (p) => ({ x: p.x + dx, y: p.y + dy });
  if (out.type === 'pen') out.points = out.points.map(([x, y]) => [x + dx, y + dy]);
  if (out.a) out.a = mv(out.a);
  if (out.b) out.b = mv(out.b);
  if (out.at) out.at = mv(out.at);
  return out;
}

function clampAxis(start, size, d, limit, allowCurrent) {
  let lo = Math.min(0, limit - size);
  let hi = Math.max(0, limit - size);
  if (allowCurrent) { lo = Math.min(lo, start); hi = Math.max(hi, start); }
  return Math.min(hi, Math.max(lo, start + d)) - start;
}

/**
 * Limit a move (dx, dy) of something whose box is `bounds` so it stays on
 * the photo (width × height) — markup off the picture would be cut off in
 * the saved copy. With allowCurrent (the default) a shape that already
 * pokes past an edge is not snapped back; without it (placing new text or
 * a number) the result is pulled fully inside.
 */
export function clampMoveDelta(bounds, dx, dy, width, height, { allowCurrent = true } = {}) {
  return {
    dx: clampAxis(bounds.x, bounds.w, dx, width, allowCurrent),
    dy: clampAxis(bounds.y, bounds.h, dy, height, allowCurrent),
  };
}

// ---- hit testing -----------------------------------------------------------------------------

/**
 * Does point p touch shape s? 'edge' when it is on the stroke (or anywhere
 * on solid things: text, numbers, labels), 'inside' when it is within an
 * outline shape (box, circle, cloud), else null. `tol` is in photo pixels
 * (a finger's width at the current zoom); the stroke's own width is added.
 */
export function hitTestShape(s, p, tol = 0, measure = measureText) {
  if (!isValidShape(s)) return null;
  const reach = tol + (s.width || 0) / 2;
  switch (s.type) {
    case 'pen':
      return distToPolyline(p, s.points) <= reach ? 'edge' : null;
    case 'line':
      return distToSegment(p, s.a, s.b) <= reach ? 'edge' : null;
    case 'arrow': {
      if (distToSegment(p, s.a, s.b) <= reach) return 'edge';
      const h = arrowHead(s.a, s.b, s.width);
      return h && pointInTriangle(p, h.tip, h.left, h.right) ? 'edge' : null;
    }
    case 'dimension': {
      if (distToSegment(p, s.a, s.b) <= reach) return 'edge';
      const g = dimensionGeometry(s.a, s.b, s.width);
      if (g.ticks.some(([u, v]) => distToSegment(p, u, v) <= reach)) return 'edge';
      const lb = dimensionLabelBox(s, measure);
      return lb && pointInBox(p, lb, tol) ? 'edge' : null;
    }
    case 'rect':
    case 'cloud': {
      const r = normalizeRect(s.a, s.b);
      const extra = s.type === 'cloud' ? cloudArcSize(s.width) * CLOUD_BULGE : 0;
      if (distToRectOutline(p, r) <= reach + extra) return 'edge';
      return pointInRect(p, r) ? 'inside' : null;
    }
    case 'ellipse': {
      const r = normalizeRect(s.a, s.b);
      if (distToPolyline(p, ellipsePoints(r, 72), true) <= reach) return 'edge';
      const rx = r.w / 2;
      const ry = r.h / 2;
      if (rx < 1e-6 || ry < 1e-6) return null;
      const k = ((p.x - r.x - rx) / rx) ** 2 + ((p.y - r.y - ry) / ry) ** 2;
      return k <= 1 ? 'inside' : null;
    }
    case 'text':
      return pointInRect(p, textLayout(s, measure), tol) ? 'edge' : null;
    case 'badge':
      return dist(p, s.at) <= badgeRadius(s) + tol ? 'edge' : null;
    default:
      return null;
  }
}

/**
 * The shape under the point (x, y), topmost first, or null. Strokes and
 * solid shapes win over the inside of an outline, so a line drawn inside a
 * box can still be picked; among outlines that contain the point the
 * smallest wins. {interior: false} ignores insides (the eraser rubs out
 * only what it touches). Takes Annotations or a plain array of shapes.
 */
export function hitShape(annotations, x, y, tolerance = 10, { interior = true, measure = measureText } = {}) {
  const shapes = Array.isArray(annotations) ? annotations : annotations?.shapes || [];
  const p = { x, y };
  const inside = [];
  for (let i = shapes.length - 1; i >= 0; i--) {
    const hit = hitTestShape(shapes[i], p, tolerance, measure);
    if (hit === 'edge') return shapes[i];
    if (hit === 'inside') inside.push(shapes[i]);
  }
  if (!interior || !inside.length) return null;
  let best = null;
  let bestArea = Infinity;
  for (const s of inside) {
    const r = normalizeRect(s.a, s.b);
    const area = r.w * r.h;
    if (area < bestArea) { bestArea = area; best = s; }
  }
  return best;
}

// ---- drawing --------------------------------------------------------------------------------

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

function ctxMeasure(ctx) {
  return (text, size) => {
    ctx.font = fontFor(size);
    return ctx.measureText(String(text)).width;
  };
}

function fillTriangle(ctx, t) {
  ctx.beginPath();
  ctx.moveTo(t.tip.x, t.tip.y);
  ctx.lineTo(t.left.x, t.left.y);
  ctx.lineTo(t.right.x, t.right.y);
  ctx.closePath();
  ctx.fill();
}

function drawPen(ctx, s) {
  const pts = s.points;
  if (s.mode === 'highlight') ctx.globalAlpha *= HIGHLIGHT_ALPHA;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (pts.length === 1 || (pts.length === 2 && first[0] === last[0] && first[1] === last[1])) {
    // A tap: a dot as wide as the pen.
    ctx.beginPath();
    ctx.arc(first[0], first[1], Math.max(0.5, s.width / 2), 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  // Quadratic curves through the midpoints between points: a smooth line
  // that still passes close to every point the finger reported.
  ctx.beginPath();
  ctx.moveTo(first[0], first[1]);
  if (pts.length === 2) {
    ctx.lineTo(last[0], last[1]);
  } else {
    for (let i = 1; i < pts.length - 1; i++) {
      const [x, y] = pts[i];
      const [nx, ny] = pts[i + 1];
      ctx.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
    }
    ctx.lineTo(last[0], last[1]);
  }
  ctx.stroke();
}

function drawArrow(ctx, s) {
  const h = arrowHead(s.a, s.b, s.width);
  if (!h) return;
  ctx.beginPath();
  ctx.moveTo(s.a.x, s.a.y);
  ctx.lineTo(h.shaftEnd.x, h.shaftEnd.y);
  ctx.stroke();
  fillTriangle(ctx, h);
  // A thin stroke round the head softens its corners to match the line caps.
  ctx.lineWidth = Math.max(1, s.width * 0.5);
  ctx.stroke();
}

function drawCloud(ctx, s) {
  const arcs = cloudArcs(s.a, s.b, cloudArcSize(s.width));
  if (!arcs.length) return;
  ctx.beginPath();
  ctx.moveTo(arcs[0].x0, arcs[0].y0);
  for (const c of arcs) ctx.arc(c.cx, c.cy, c.r, c.a0, c.a1, false);
  ctx.closePath();
  ctx.stroke();
}

function drawLabelBox(ctx, lb, color) {
  const tc = textColors(color);
  ctx.save();
  ctx.translate(lb.cx, lb.cy);
  ctx.rotate(lb.angle);
  roundRectPath(ctx, -lb.w / 2, -lb.h / 2, lb.w, lb.h, lb.radius);
  ctx.fillStyle = tc.bg;
  ctx.fill();
  if (tc.border) {
    ctx.lineWidth = Math.max(1, lb.size * 0.07);
    ctx.strokeStyle = tc.border;
    ctx.stroke();
  }
  ctx.font = fontFor(lb.size);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = tc.fg;
  ctx.fillText(lb.label, 0, lb.size * 0.36);
  ctx.restore();
}

function drawDimension(ctx, s, measure) {
  const g = dimensionGeometry(s.a, s.b, s.width);
  ctx.beginPath();
  ctx.moveTo(s.a.x, s.a.y);
  ctx.lineTo(s.b.x, s.b.y);
  for (const [u, v] of g.ticks) {
    ctx.moveTo(u.x, u.y);
    ctx.lineTo(v.x, v.y);
  }
  ctx.stroke();
  for (const h of g.heads) fillTriangle(ctx, h);
  const lb = dimensionLabelBox(s, measure);
  if (lb) drawLabelBox(ctx, lb, s.color);
}

function drawText(ctx, s, measure) {
  const L = textLayout(s, measure);
  const tc = textColors(s.color);
  if (s.bg !== false) {
    roundRectPath(ctx, L.x, L.y, L.w, L.h, L.radius);
    ctx.fillStyle = tc.bg;
    ctx.fill();
    if (tc.border) {
      ctx.lineWidth = Math.max(1, L.size * 0.06);
      ctx.strokeStyle = tc.border;
      ctx.stroke();
    }
  }
  ctx.font = fontFor(L.size);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  L.lines.forEach((line, i) => {
    const x = L.x + L.pad;
    const y = L.y + L.pad + L.ascent + i * L.lineH;
    if (s.bg === false) {
      // No box: a contrasting outline keeps the letters readable on a busy photo.
      ctx.lineWidth = L.size * 0.16;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = isLightColor(s.color) ? 'rgba(0, 0, 0, 0.8)' : 'rgba(255, 255, 255, 0.9)';
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = tc.fg;
    ctx.fillText(line, x, y);
  });
}

function drawBadge(ctx, s) {
  const r = badgeRadius(s);
  const light = isLightColor(s.color);
  ctx.beginPath();
  ctx.arc(s.at.x, s.at.y, r, 0, Math.PI * 2);
  ctx.fillStyle = s.color;
  ctx.fill();
  ctx.lineWidth = Math.max(1, r * 0.14);
  ctx.strokeStyle = light ? 'rgba(0, 0, 0, 0.6)' : '#ffffff';
  ctx.stroke();
  const label = String(Math.floor(s.n));
  const fs = r * (label.length <= 1 ? 1.15 : label.length === 2 ? 0.98 : 0.74);
  ctx.font = fontFor(fs);
  ctx.textAlign = 'center';
  ctx.fillStyle = light ? '#111111' : '#ffffff';
  const m = ctx.measureText(label);
  if (m && Number.isFinite(m.actualBoundingBoxAscent) && Number.isFinite(m.actualBoundingBoxDescent)) {
    // Centre the digits by their real ink box; 'middle' sits a little high in most fonts.
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(label, s.at.x, s.at.y + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2);
  } else {
    ctx.textBaseline = 'middle';
    ctx.fillText(label, s.at.x, s.at.y);
  }
}

/**
 * Draw one shape in photo pixel space (the caller sets any zoom/pan
 * transform first). Damaged shapes are skipped, never thrown on.
 */
export function renderShape(ctx, s) {
  if (!isValidShape(s)) return;
  ctx.save();
  try {
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = Math.max(0.5, s.width);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (ctx.setLineDash) ctx.setLineDash([]);
    const measure = ctxMeasure(ctx);
    switch (s.type) {
      case 'pen':
        drawPen(ctx, s);
        break;
      case 'line':
        ctx.beginPath();
        ctx.moveTo(s.a.x, s.a.y);
        ctx.lineTo(s.b.x, s.b.y);
        ctx.stroke();
        break;
      case 'arrow':
        drawArrow(ctx, s);
        break;
      case 'rect': {
        const r = normalizeRect(s.a, s.b);
        ctx.lineJoin = 'miter';
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        break;
      }
      case 'ellipse': {
        const r = normalizeRect(s.a, s.b);
        ctx.beginPath();
        ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(r.w / 2, 0.01), Math.max(r.h / 2, 0.01), 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'cloud':
        drawCloud(ctx, s);
        break;
      case 'dimension':
        drawDimension(ctx, s, measure);
        break;
      case 'text':
        drawText(ctx, s, measure);
        break;
      case 'badge':
        drawBadge(ctx, s);
        break;
      default:
        break;
    }
  } finally {
    ctx.restore();
  }
}

/**
 * Draw every shape, in order, in photo pixel space × scale. The editor
 * passes scale 1 with its own zoom transform already on the context;
 * flatten() passes the output size.
 */
export function renderAnnotations(ctx, annotations, { scale = 1 } = {}) {
  const shapes = Array.isArray(annotations) ? annotations : annotations?.shapes;
  if (!shapes?.length) return;
  ctx.save();
  if (scale !== 1) ctx.scale(scale, scale);
  for (const s of shapes) {
    try { renderShape(ctx, s); } catch (err) { console.warn('[annotations] a shape could not be drawn', err); }
  }
  ctx.restore();
}

// ---- images: decode, flatten, thumbnails -------------------------------------------------

/**
 * The size a canvas for a w × h image may have: no longer than maxSide,
 * no more than maxPixels in area (iPhone draws a bigger canvas blank), no
 * side over maxDim. Returns {width, height, scale} (whole pixels, scale ≤ 1).
 */
export function fitCanvasSize(w, h, { maxSide = Infinity, maxPixels = MAX_CANVAS_PIXELS, maxDim = MAX_CANVAS_SIDE } = {}) {
  const long = Math.max(w, h);
  let s = 1;
  if (maxSide > 0 && long > maxSide) s = maxSide / long;
  if (w * s * h * s > maxPixels) s = Math.sqrt(maxPixels / (w * h));
  if (long * s > maxDim) s = maxDim / long;
  const width = Math.max(1, Math.floor(w * s));
  const height = Math.max(1, Math.floor(h * s));
  return { width, height, scale: width / w };
}

function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('This photo could not be opened. Its file may be damaged.'));
    img.src = url;
  });
}

/**
 * Decode a photo, turned upright the way its EXIF says (as every browser
 * shows it). Returns {source, width, height, close()} — `source` can be
 * passed to drawImage; call close() when done, so the phone frees the
 * decoded pixels.
 * createImageBitmap with imageOrientation 'from-image' is preferred (fast,
 * off the main thread); browsers that refuse the option get an <img>,
 * which applies EXIF orientation by default.
 */
export async function decodeImageBlob(blob) {
  if (!(blob instanceof Blob) || !blob.size) throw new Error('The photo file is empty or missing.');
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      if (bmp.width && bmp.height) {
        return { source: bmp, width: bmp.width, height: bmp.height, close: () => { try { bmp.close(); } catch { /* closed */ } } };
      }
      try { bmp.close(); } catch { /* closed */ }
    } catch { /* the option is not supported here, or the decode failed: try an <img> */ }
  }
  if (typeof Image === 'undefined' || typeof URL === 'undefined') throw new Error('This browser cannot open photos.');
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImageElement(url);
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('This photo could not be opened. Its file may be damaged.');
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      close: () => { URL.revokeObjectURL(url); },
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

function makeCanvas(w, h) {
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  throw new Error('This browser cannot draw images.');
}

/** Give a canvas's memory back now (iPhone counts every canvas against a small total until it is collected). */
function releaseCanvas(c) {
  if (!c) return;
  try { c.width = 0; c.height = 0; } catch { /* ignore */ }
}

function dataUrlToBlob(url) {
  const [head, data] = url.split(',');
  const type = /data:([^;]+)/.exec(head)?.[1] || 'image/jpeg';
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

async function canvasToJpeg(canvas, quality) {
  if (typeof canvas.toBlob !== 'function' && typeof canvas.convertToBlob === 'function') {
    const b = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    if (b?.size) return b;
    throw new Error(OUT_OF_MEMORY);
  }
  const blob = await new Promise((resolve) => {
    try { canvas.toBlob(resolve, 'image/jpeg', quality); } catch { resolve(null); }
  });
  if (blob?.size) return blob;
  // Some browsers hand back null instead of throwing when memory is short;
  // toDataURL sometimes still works then.
  try {
    const url = canvas.toDataURL('image/jpeg', quality);
    if (url && url.startsWith('data:image/jpeg')) return dataUrlToBlob(url);
  } catch { /* fall through */ }
  throw new Error(OUT_OF_MEMORY);
}

/**
 * The photo with its markup burned in, as a JPEG Blob. The original Blob
 * is only read. The copy keeps the photo's full size unless `maxSide` (or
 * the phone's canvas limit) asks for smaller; the markup is scaled to fit.
 *
 * `image`: a photo already decoded with decodeImageBlob (the editor has
 * one open). It is used instead of decoding `originalBlob` again — on an
 * iPhone a second decoded 12 MP copy costs ~50 MB — and is left open.
 * With `maxSide: 400` this also makes the marked-up thumbnail.
 */
export async function flatten(originalBlob, annotations, { maxSide = Infinity, quality = 0.92, image = null } = {}) {
  const img = image?.source && image.width && image.height ? image : await decodeImageBlob(originalBlob);
  const ownsImage = img !== image;
  let canvas = null;
  try {
    const { width, height } = fitCanvasSize(img.width, img.height, { maxSide });
    canvas = makeCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(OUT_OF_MEMORY);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img.source, 0, 0, width, height);
    const shapes = annotations?.shapes || [];
    if (shapes.length) {
      const aw = annotations.width > 0 ? annotations.width : img.width;
      const ah = annotations.height > 0 ? annotations.height : img.height;
      ctx.setTransform(width / aw, 0, 0, height / ah, 0, 0);
      renderAnnotations(ctx, annotations);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    return await canvasToJpeg(canvas, quality);
  } finally {
    if (ownsImage) img.close();
    releaseCanvas(canvas);
  }
}
