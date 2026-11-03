// markers.js — the pins, camera wedges, video paths and the "you are here"
// dot, drawn on a canvas.
//
// The plan view, the map view and the camera's live mini-map all draw with
// these functions (the exported viewer copies their look), so a marker means
// the same thing everywhere:
//
//   red numbered circle + pale wedge   a photo, and where the camera pointed
//   purple line with chevrons          the path a video was walked along,
//                                      numbered at its start, ring at its end
//   amber square with a folded corner  a note
//   blue dot, halo, cone               the person holding the phone: where,
//                                      how sure (the halo), which way (the cone)
//   small yellow dot on a pin          the photo has markup
//
// Conventions, so callers never have to think about zoom:
//  - Every size here is in CSS pixels. The caller sets the context's
//    transform to the device pixel ratio only (no zoom, no pan) and passes
//    SCREEN positions, so markers keep one size on screen at any zoom and stay
//    sharp on a high-density display.
//  - Headings are radians clockwise from screen-up (the way a compass reads);
//    null means "direction unknown" and no wedge or cone is drawn.
//  - Colours come from the CSS tokens in css/app.css (--pin-photo, --pin-video,
//    --pin-note, --me …), read once and cached, with built-in fallbacks so this
//    also works in a test or a page without the stylesheet.
//  - No shadowBlur: it is slow on phones with many pins. A soft offset disc
//    under each marker does the same job for a fraction of the cost.
//
// Nothing here touches the DOM at import time, so the Node tests import it.

const DEG = Math.PI / 180;
const WEDGE_HALF = 30 * DEG;        // a photo wedge is 60° wide (a phone camera's view, roughly)
const ME_CONE_HALF = 26 * DEG;
const MARKUP_DOT = '#ffd23f';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ---- colours ------------------------------------------------------------------

const FALLBACK = Object.freeze({
  me: '#1a73e8',
  meHalo: 'rgba(26, 115, 232, 0.18)',
  photo: '#c8371f',
  video: '#7b3fd1',
  note: '#d98a00',
  accent: '#1f6fc8',
  ok: '#1f9d55',
  warn: '#c98a00',
  planBg: '#e3e8ed',
  surface: '#ffffff',
  text: '#17212b',
  stale: '#8796a6',
  font: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
});

const TOKENS = {
  me: '--me', meHalo: '--me-halo', photo: '--pin-photo', video: '--pin-video', note: '--pin-note',
  accent: '--accent', ok: '--ok', warn: '--warn', planBg: '--surface-3', surface: '--surface',
  text: '--text', stale: '--text-faint', font: '--font',
};

let colorCache = null;

/**
 * The marker colours (and the UI font) from the CSS tokens, read once and
 * cached. Pass {refresh: true} after the light/dark theme changed (the plan
 * view does this itself).
 */
export function markerColors({ refresh = false } = {}) {
  if (colorCache && !refresh) return colorCache;
  const out = { ...FALLBACK };
  try {
    if (typeof document !== 'undefined' && typeof getComputedStyle === 'function') {
      const cs = getComputedStyle(document.documentElement);
      for (const [k, v] of Object.entries(TOKENS)) {
        const val = cs.getPropertyValue(v).trim();
        if (val) out[k] = val;
      }
    }
  } catch { /* no stylesheet (tests, a bare page): keep the fallbacks */ }
  colorCache = Object.freeze(out);
  return colorCache;
}

const alphaCache = new Map();

/**
 * `color` (#rgb, #rrggbb, #rrggbbaa, rgb(), rgba()) with its alpha multiplied
 * by `a`, as an rgba() string — gradients need real colour stops, not
 * globalAlpha. A colour it cannot read (a named colour) comes back as is.
 */
export function rgba(color, a) {
  const key = `${color}|${a}`;
  const hit = alphaCache.get(key);
  if (hit) return hit;
  const s = String(color ?? '').trim();
  let r, g, b, base = 1, m;
  if ((m = s.match(/^#([0-9a-f]{3,8})$/i)) && [3, 4, 6, 8].includes(m[1].length)) {
    let h = m[1];
    if (h.length <= 4) h = h.split('').map((ch) => ch + ch).join('');
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
    if (h.length === 8) base = parseInt(h.slice(6, 8), 16) / 255;
  } else if ((m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i))) {
    r = +m[1]; g = +m[2]; b = +m[3];
    if (m[4]) base = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4];
  } else {
    return s;
  }
  const out = `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${+Math.max(0, Math.min(1, a * base)).toFixed(3)})`;
  if (alphaCache.size > 500) alphaCache.clear();
  alphaCache.set(key, out);
  return out;
}

/** Canvas arc angle (radians from +x, clockwise because y points down) for a heading clockwise from screen-up. */
export function canvasAngle(headingRad) {
  return headingRad - Math.PI / 2;
}

// ---- small shapes --------------------------------------------------------------------

const widthCache = new Map();

/** Text width, cached: measureText per pin per frame adds up with a few hundred pins. */
function textWidth(ctx, text, font) {
  const k = `${font}|${text}`;
  let w = widthCache.get(k);
  if (w == null) {
    ctx.font = font;
    w = ctx.measureText(text).width || 0;
    if (widthCache.size > 2000) widthCache.clear();
    widthCache.set(k, w);
  }
  return w;
}

function disc(ctx, x, y, r, fill, ring = 0, ringColor = '#fff') {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  if (ring) {
    ctx.lineWidth = ring;
    ctx.strokeStyle = ringColor;
    ctx.stroke();
  }
}

/** A rounded rectangle path (own version: older Safari has no ctx.roundRect, and it keeps the tests simple). */
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

/** The outline of a pin body: a circle (or a pill for long numbers), or a note's dog-eared square. */
function bodyPath(ctx, shape, x, y, halfW, r) {
  if (shape === 'note') {
    const f = r * 0.62;                  // the folded corner
    const x0 = x - halfW, x1 = x + halfW, y0 = y - r, y1 = y + r, k = 3;
    ctx.beginPath();
    ctx.moveTo(x0 + k, y0);
    ctx.lineTo(x1 - f, y0);
    ctx.lineTo(x1, y0 + f);
    ctx.lineTo(x1, y1 - k);
    ctx.arcTo(x1, y1, x1 - k, y1, k);
    ctx.lineTo(x0 + k, y1);
    ctx.arcTo(x0, y1, x0, y1 - k, k);
    ctx.lineTo(x0, y0 + k);
    ctx.arcTo(x0, y0, x0 + k, y0, k);
    ctx.closePath();
  } else if (halfW > r + 0.5) {
    roundRectPath(ctx, x - halfW, y - r, halfW * 2, r * 2, r);
  } else {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
}

/**
 * The numbered body of a pin. Returns its half width and half height so a
 * caller can place a badge (the markup dot) on its corner.
 */
function drawBody(ctx, x, y, label, color, k, selected, shape) {
  const c = markerColors();
  const text = label == null || label === '' ? '' : String(label);
  const fs = Math.round((text.length >= 3 ? 10.5 : 12) * k);
  const font = `700 ${fs}px ${c.font}`;
  const r = 12 * k;
  const tw = text ? textWidth(ctx, text, font) : 0;
  const halfW = shape === 'note' ? Math.max(r, tw / 2 + 5 * k) : Math.max(r, tw / 2 + 6 * k);

  // Soft shadow, then a halo for the selected one, then the body with a white ring.
  bodyPath(ctx, shape, x, y + 1.6 * k, halfW + 1.4, r + 1.4);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.24)';
  ctx.fill();
  if (selected) {
    bodyPath(ctx, shape, x, y, halfW + 6 * k, r + 6 * k);
    ctx.fillStyle = rgba(color, 0.3);
    ctx.fill();
  }
  bodyPath(ctx, shape, x, y, halfW, r);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = selected ? 3 : 2.25;
  ctx.strokeStyle = '#fff';
  ctx.stroke();

  if (shape === 'note') {
    const f = r * 0.62;
    ctx.beginPath();
    ctx.moveTo(x + halfW - f, y - r);
    ctx.lineTo(x + halfW - f, y - r + f);
    ctx.lineTo(x + halfW, y - r + f);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.fill();
  }
  if (text) {
    ctx.font = font;
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 0.5 * k);
  }
  return { halfW, r };
}

/** A translucent wedge from (x, y) toward `headingRad`, fading with distance. */
function drawWedge(ctx, x, y, headingRad, radius, half, color, alpha) {
  const a = canvasAngle(headingRad);
  const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
  g.addColorStop(0, rgba(color, alpha));
  g.addColorStop(1, rgba(color, alpha * 0.15));
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.arc(x, y, radius, a - half, a + half);
  ctx.closePath();
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = rgba(color, Math.min(1, alpha + 0.25));
  ctx.stroke();
}

function markupDot(ctx, x, y, k) {
  disc(ctx, x, y, 4.6 * k, MARKUP_DOT, 1.6);
}

// ---- pins -----------------------------------------------------------------------------

/**
 * A photo: a numbered circle and a 60° wedge pointing where the camera
 * looked. opts: {selected, n (the #seq), annotated, light (small, unlabeled —
 * the camera's mini-map), dim (another item is playing), color}
 */
export function drawPhotoPin(ctx, x, y, headingRad, { selected = false, n = null, annotated = false, light = false, dim = false, color } = {}) {
  const col = color || markerColors().photo;
  const k = selected ? 1.2 : 1;
  ctx.save();
  if (dim) ctx.globalAlpha = 0.42;
  if (isNum(headingRad)) {
    drawWedge(ctx, x, y, headingRad, (light ? 22 : 46) * k, WEDGE_HALF, col, selected ? 0.62 : light ? 0.4 : 0.46);
  }
  if (light) {
    disc(ctx, x, y, 4.6, col, 1.6);
  } else {
    const { halfW, r } = drawBody(ctx, x, y, n, col, k, selected, 'circle');
    if (annotated) markupDot(ctx, x + Math.max(halfW - 3 * k, r * 0.72), y - r * 0.72, k);
  }
  ctx.restore();
}

/** A note: a numbered amber square with a folded corner. opts as drawPhotoPin (no heading). */
export function drawNotePin(ctx, x, y, { selected = false, n = null, light = false, dim = false, color } = {}) {
  const col = color || markerColors().note;
  ctx.save();
  if (dim) ctx.globalAlpha = 0.42;
  if (light) {
    ctx.beginPath();
    ctx.rect(x - 4.2, y - 4.2, 8.4, 8.4);
    ctx.fillStyle = col;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  } else {
    drawBody(ctx, x, y, n, col, selected ? 1.2 : 1, selected, 'note');
  }
  ctx.restore();
}

/** Trace a polyline path (no stroke). */
function tracePath(ctx, points) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
}

/** Small white chevrons along the path every `spacing` px, pointing the way it was walked. */
function drawChevrons(ctx, points, spacing, size) {
  let carry = spacing * 0.6;          // the first one a little after the start badge
  ctx.beginPath();
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.01) continue;
    const ux = dx / len, uy = dy / len;
    let at = carry;
    while (at <= len) {
      const px = a.x + ux * at, py = a.y + uy * at;
      ctx.moveTo(px - ux * size - uy * size, py - uy * size + ux * size);
      ctx.lineTo(px + ux * size * 0.6, py + uy * size * 0.6);
      ctx.lineTo(px - ux * size + uy * size, py - uy * size - ux * size);
      at += spacing;
    }
    carry = at - len;
  }
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.stroke();
}

/**
 * A video's path: a purple line with a white casing (readable on any plan or
 * satellite image), chevrons showing the walking direction, a numbered badge
 * at the start and a ring at the end. `points` are screen positions
 * [{x, y}]; a single point draws only the start badge.
 * opts: {selected, n, light, dim, color}
 */
export function drawVideoPath(ctx, points, { selected = false, n = null, light = false, dim = false, color } = {}) {
  if (!points?.length) return;
  const col = color || markerColors().video;
  ctx.save();
  if (dim) ctx.globalAlpha = 0.42;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (points.length >= 2) {
    tracePath(ctx, points);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.lineWidth = light ? 4 : selected ? 9.5 : 6.5;
    ctx.stroke();
    ctx.strokeStyle = col;
    ctx.lineWidth = light ? 2.2 : selected ? 6 : 3.6;
    ctx.stroke();
    if (!light) drawChevrons(ctx, points, selected ? 64 : 84, selected ? 3.6 : 2.8);
    const e = points[points.length - 1];
    disc(ctx, e.x, e.y, light ? 3 : selected ? 6.5 : 5.2, '#fff', light ? 1.6 : 3, col);
  }
  const s = points[0];
  if (light) disc(ctx, s.x, s.y, 4, col, 1.5);
  else drawBody(ctx, s.x, s.y, n, col, selected ? 1.15 : 0.95, selected, 'circle');
  ctx.restore();
}

// ---- the person -----------------------------------------------------------------------

/**
 * The person: a blue dot with a white ring, a translucent accuracy circle of
 * radius `accPx` (screen px) and a cone toward `headingRad`. The cone fades
 * when the phone lies flat (facing === 'top': the heading is where the top
 * edge points, not the camera) or the heading is uncertain; with no heading
 * there is no cone. opts: {stale (grey: the position is old), uncertain, light}
 */
export function drawMe(ctx, x, y, accPx, headingRad, facing = 'camera', { stale = false, uncertain = false, light = false } = {}) {
  const c = markerColors();
  const col = stale ? c.stale : c.me;
  ctx.save();
  if (isNum(accPx) && accPx > 10) {
    ctx.beginPath();
    ctx.arc(x, y, Math.min(accPx, 20000), 0, Math.PI * 2);
    ctx.fillStyle = rgba(col, 0.15);
    ctx.fill();
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = rgba(col, 0.5);
    ctx.stroke();
  }
  if (isNum(headingRad)) {
    const faded = facing === 'top' || uncertain;
    const R = light ? 40 : 76;
    const half = uncertain ? 40 * DEG : ME_CONE_HALF;
    const a = canvasAngle(headingRad);
    const g = ctx.createRadialGradient(x, y, 0, x, y, R);
    g.addColorStop(0, rgba(col, faded ? 0.24 : 0.55));
    g.addColorStop(1, rgba(col, 0));
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, R, a - half, a + half);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
  }
  const r = light ? 6 : 7.5;
  disc(ctx, x, y + 1.2, r + 4.2, 'rgba(0, 0, 0, 0.22)');
  disc(ctx, x, y, r + 3, '#fff');
  disc(ctx, x, y, r, col);
  ctx.restore();
}

/**
 * The moving marker of a video being played back: where the camera was at
 * that moment and which way it looked. opts: {color}
 */
export function drawPlayhead(ctx, x, y, headingRad, { color } = {}) {
  const col = color || markerColors().video;
  ctx.save();
  if (isNum(headingRad)) {
    const a = canvasAngle(headingRad);
    const g = ctx.createRadialGradient(x, y, 0, x, y, 70);
    g.addColorStop(0, rgba(col, 0.6));
    g.addColorStop(1, rgba(col, 0));
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, 70, a - WEDGE_HALF, a + WEDGE_HALF);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
  }
  disc(ctx, x, y + 1.2, 12, 'rgba(0, 0, 0, 0.22)');
  disc(ctx, x, y, 10, col, 3);
  disc(ctx, x, y, 3.2, '#fff');
  ctx.restore();
}

// ---- calibration marks, lines, labels ---------------------------------------------------

/** A text label on a white pill (plan readouts: "1", "24' 0"", "±3 ft"). Returns its width. */
export function drawLabel(ctx, x, y, text, { color, bg = 'rgba(255, 255, 255, 0.94)', align = 'center', size = 12.5 } = {}) {
  const c = markerColors();
  const t = String(text ?? '');
  if (!t) return 0;
  const font = `700 ${size}px ${c.font}`;
  const w = textWidth(ctx, t, font) + 12;
  const h = size + 9;
  const x0 = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
  ctx.save();
  roundRectPath(ctx, x0, y - h / 2 + 1, w, h, h / 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
  ctx.fill();
  roundRectPath(ctx, x0, y - h / 2, w, h, h / 2);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.font = font;
  ctx.fillStyle = color || c.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(t, x0 + w / 2, y + 0.5);
  ctx.restore();
  return w;
}

/**
 * A point marked on the plan or map: kind 'calib' (a target ring with ticks,
 * so the exact spot shows), 'scale' (a scale-line end) or 'temp' (a dashed
 * ring). opts: {label, color, kind, light}
 */
export function drawMark(ctx, x, y, { label = '', color, kind = 'calib', light = false } = {}) {
  const c = markerColors();
  const col = color || (kind === 'scale' ? c.ok : kind === 'temp' ? c.warn : c.accent);
  ctx.save();
  if (kind === 'scale') {
    disc(ctx, x, y, light ? 3.5 : 5, col, 2);
  } else {
    const r = light ? 7 : 11;
    if (kind === 'temp') ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.stroke();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = col;
    ctx.stroke();
    ctx.setLineDash([]);
    if (!light) {
      ctx.beginPath();
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
        ctx.moveTo(x + dx * (r + 2), y + dy * (r + 2));
        ctx.lineTo(x + dx * (r + 8), y + dy * (r + 8));
      }
      ctx.lineCap = 'round';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.strokeStyle = col;
      ctx.stroke();
    }
    disc(ctx, x, y, 2.4, col, 1.2);
  }
  ctx.restore();
  if (label && !light) drawLabel(ctx, x + 16, y - 18, label, { color: col, align: 'left' });
}

/**
 * A line between two screen points (a scale line, a wall for compass
 * alignment): white casing, coloured core, end ticks, the label at the
 * middle. opts: {label, color, dashed, light}
 */
export function drawLineMark(ctx, a, b, { label = '', color, dashed = false, light = false } = {}) {
  if (!a || !b) return;
  const c = markerColors();
  const col = color || c.ok;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  if (!light) {
    ctx.moveTo(a.x + nx * 9, a.y + ny * 9); ctx.lineTo(a.x - nx * 9, a.y - ny * 9);
    ctx.moveTo(b.x + nx * 9, b.y + ny * 9); ctx.lineTo(b.x - nx * 9, b.y - ny * 9);
  }
  ctx.lineWidth = light ? 4 : 6;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.stroke();
  if (dashed) ctx.setLineDash([10, 7]);
  ctx.lineWidth = light ? 2 : 3;
  ctx.strokeStyle = col;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
  if (label && !light) drawLabel(ctx, (a.x + b.x) / 2, (a.y + b.y) / 2, label, { color: col });
}

/** A fine crosshair with a gap at the centre (the magnifier's aiming mark). */
export function drawCrosshair(ctx, x, y, { arm = 16, gap = 5, color } = {}) {
  const col = color || markerColors().photo;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x, y - gap - arm); ctx.lineTo(x, y - gap);
  ctx.moveTo(x, y + gap); ctx.lineTo(x, y + gap + arm);
  ctx.moveTo(x - gap - arm, y); ctx.lineTo(x - gap, y);
  ctx.moveTo(x + gap, y); ctx.lineTo(x + gap + arm, y);
  ctx.lineCap = 'round';
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = col;
  ctx.stroke();
  disc(ctx, x, y, 1.6, col, 1, 'rgba(255, 255, 255, 0.95)');
  ctx.restore();
}

// ---- scale bar ----------------------------------------------------------------------------

const M_PER_FT = 0.3048;

/**
 * A round length for a scale bar about `targetPx` long: {meters, px, label}.
 * Imperial picks 1, 2, 5, 10, 20, 50 … feet; metric 1, 2, 5 … meters (or
 * 10/20/50 cm when zoomed far in). Null when the scale is unknown.
 */
export function niceScaleLength(pxPerMeter, units = 'imperial', targetPx = 90) {
  if (!isNum(pxPerMeter) || pxPerMeter <= 0) return null;
  const imperial = units !== 'metric';
  const unit = imperial ? M_PER_FT : 1;
  const want = targetPx / pxPerMeter / unit;          // in feet or meters
  const p = Math.pow(10, Math.floor(Math.log10(want)));
  let n = p;
  for (const f of [1, 2, 5, 10]) { if (f * p <= want) n = f * p; }
  const meters = n * unit;
  let label;
  if (imperial) label = n >= 1 ? `${+n.toPrecision(3)} ft` : `${+(n * 12).toPrecision(3)} in`;
  else label = n >= 1 ? `${+n.toPrecision(3)} m` : `${+(n * 100).toPrecision(3)} cm`;
  return { meters, px: meters * pxPerMeter, label };
}

/** A scale bar with its left end at (x, y). Does nothing when the scale is unknown. */
export function drawScaleBar(ctx, x, y, pxPerMeter, units = 'imperial') {
  const s = niceScaleLength(pxPerMeter, units);
  if (!s) return;
  const c = markerColors();
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x, y - 6); ctx.lineTo(x, y); ctx.lineTo(x + s.px, y); ctx.lineTo(x + s.px, y - 6);
  ctx.lineCap = 'square';
  ctx.lineJoin = 'miter';
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = c.text;
  ctx.stroke();
  ctx.restore();
  drawLabel(ctx, x + s.px / 2, y - 16, s.label, { size: 11.5 });
}
