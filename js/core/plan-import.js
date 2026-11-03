// plan-import.js — turning a PDF, a picture or a screenshot into a floor plan image.
//
// A level's plan is ONE stored image (store.setLevelPlan). Every pin, the
// calibration and the "I'm here" fixes are in that image's pixels, so the
// image has to be exactly what the person saw when they chose it:
//
//  - PDFs are rendered once with pdf.js, at a resolution good for zooming
//    (longest side about 6000 px) but never past what a phone can hold.
//  - Pictures are "normalized": EXIF rotation is baked into the pixels (a
//    stored plan never carries an orientation flag that one browser honours
//    and another ignores), and anything over the size limits is scaled down.
//    A JPEG or PNG that needs none of that is kept byte for byte.
//  - Rotate and crop are applied in one pass at the end (applyEdits), so a
//    JPEG plan is re-encoded at most once.
//
// Size limits (why PLAN_LIMITS is the same on every device): iPhone Safari
// refuses canvases over 16,777,216 px (it hands back a blank or null canvas),
// Android phones run out of memory around there too, and a plan rendered on
// a desktop must still open on the phone after an export/import. So plans
// are capped at 16 M px and 8192 px on a side everywhere.
//
// Encoding (chooseEncoding): a photo of a plan (JPEG/HEIC source) stays a
// JPEG (quality 0.92). A rendered PDF or a screenshot is PNG up to 4 M px —
// lossless, crisp lines, small because drawings are mostly white — and JPEG
// at 0.9 above that, because a 16 M px PNG of an anti-aliased drawing is
// 10–30 MB and takes seconds to encode on a phone, while JPEG 0.9 keeps lines
// sharp at 3–6 MB.
//
// Everything that needs the DOM (canvas, <script>, createImageBitmap) is
// inside functions; the pure helpers at the top are tested in Node
// (tests/plan-import.test.mjs).

import { isIOS, clamp } from './util.js';

/** The size cap for every stored plan image (see the header). */
export const PLAN_LIMITS = Object.freeze({ maxSide: 8192, maxPixels: 16_000_000 });

/** The longest side a PDF page is rendered at, before the pixel cap. */
export const PDF_TARGET_SIDE = 6000;

/** Up to this many pixels a drawing is stored as PNG; above it, JPEG. */
export const PNG_MAX_PIXELS = 4_000_000;

/** Long side of the small plan picture shown in lists. */
export const PLAN_THUMB_SIDE = 480;

// ---- errors -------------------------------------------------------------------
//
// Every failure a person can hit carries a `code` (so the dialog can react,
// e.g. ask for a PDF password) and a message they can act on.

export function planError(code, message, cause) {
  const e = new Error(message);
  e.code = code;
  if (cause) e.cause = cause;
  return e;
}

const MSG = {
  heic: 'This picture is in Apple\'s HEIC format, which this browser cannot open. On an iPhone, pick it from Photos (it is converted automatically) or take a screenshot of it. On Android or a PC, save it as JPG first, or use a screenshot.',
  decode: 'This picture could not be opened. It may be damaged or in a format this browser does not read. Try a JPG, PNG or PDF of the plan, or a screenshot.',
  tooLarge: 'This plan is too large for this phone to process. Try cropping it smaller, a lower-resolution copy, or a screenshot of the plan.',
  pdfLib: 'The PDF reader could not be loaded. Check the connection and try again (once loaded, it also works offline).',
  pdfDamaged: 'This PDF looks damaged, or is not really a PDF. Download it again, or use a screenshot of the plan.',
  cancelled: 'Cancelled.',
};

// ---- pure: size limits ------------------------------------------------------------

/**
 * Canvas limits for a kind of device. Conservative on purpose: going over
 * fails silently on iPhone (a blank image), which would be a lost plan.
 */
export function limitsFor({ ios = false, mobile = false } = {}) {
  if (ios) return { maxSide: 8192, maxPixels: 16_000_000 };      // WebKit's hard cap is 16,777,216 px
  if (mobile) return { maxSide: 8192, maxPixels: 16_000_000 };   // Android: memory, not a fixed cap
  return { maxSide: 16384, maxPixels: 40_000_000 };              // desktop Chrome/Edge/Firefox/Safari
}

/** The limits of this device's browser (see limitsFor). */
export function canvasLimits() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  const ios = isIOS();
  const mobile = ios || /Android|Mobi/i.test(ua);
  return limitsFor({ ios, mobile });
}

/** The tighter of two limit sets. */
export function intersectLimits(a, b) {
  return {
    maxSide: Math.min(a?.maxSide ?? Infinity, b?.maxSide ?? Infinity),
    maxPixels: Math.min(a?.maxPixels ?? Infinity, b?.maxPixels ?? Infinity),
  };
}

/**
 * The integer size that fits `width × height` within {maxSide, maxPixels},
 * keeping the aspect ratio. Never enlarges unless allowUpscale.
 * → {width, height, scale}
 */
export function fitWithin(width, height, { maxSide = Infinity, maxPixels = Infinity } = {}, { allowUpscale = false } = {}) {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0, scale: 0 };
  let s = Math.min(maxSide / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
  if (!allowUpscale) s = Math.min(1, s);
  if (s === 1 && Number.isInteger(width) && Number.isInteger(height)) return { width, height, scale: 1 };
  let w = Math.max(1, Math.floor(width * s));
  let h = Math.max(1, Math.floor(height * s));
  // Rounding can leave the product a hair over the cap; step down until it fits.
  while (w * h > maxPixels && w > 1 && h > 1) {
    if (w >= h) { w -= 1; h = Math.max(1, Math.floor(w * height / width)); } else { h -= 1; w = Math.max(1, Math.floor(h * width / height)); }
  }
  return { width: w, height: h, scale: w / width };
}

/**
 * The pdf.js scale (pixels per PDF point) to render a page of
 * `pageW × pageH` points at: aim for `targetSide` on the long side, within
 * the limits. A page smaller than the target is enlarged — that is the point.
 */
export function pdfRenderScale(pageW, pageH, { targetSide = PDF_TARGET_SIDE, maxSide = PLAN_LIMITS.maxSide, maxPixels = PLAN_LIMITS.maxPixels } = {}) {
  if (!(pageW > 0) || !(pageH > 0)) return 1;
  const fit = fitWithin(pageW, pageH, { maxSide: Math.min(targetSide, maxSide), maxPixels }, { allowUpscale: true });
  return fit.scale;
}

/** How to encode a plan image of this size from this kind of source (see the header). */
export function chooseEncoding(width, height, sourceType = '') {
  if (/jpe?g|heic|heif|avif/i.test(sourceType)) return { type: 'image/jpeg', quality: 0.92 };
  if (width * height <= PNG_MAX_PIXELS) return { type: 'image/png', quality: undefined };
  return { type: 'image/jpeg', quality: 0.9 };
}

// ---- pure: file sniffing --------------------------------------------------------------

const ascii = (b, at, n) => String.fromCharCode(...b.subarray(at, at + n));

/**
 * What a file really is, from its first bytes (names and MIME types lie,
 * and dropped or pasted files often have none).
 * → 'jpeg' | 'png' | 'gif' | 'webp' | 'bmp' | 'tiff' | 'heic' | 'avif' | 'pdf' | null
 */
export function sniffImageType(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length < 4) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (ascii(b, 0, 4) === 'GIF8') return 'gif';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  if (b[0] === 0x42 && b[1] === 0x4d && b.length >= 26) return 'bmp';
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a)) return 'tiff';
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return 'heic';
    if (/^(avif|avis)$/.test(brand)) return 'avif';
  }
  // A PDF may have a few junk bytes before its header; the format allows 1 KB.
  const n = Math.min(b.length - 4, 1024);
  for (let i = 0; i <= n; i++) {
    if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46) return 'pdf';
  }
  return null;
}

/**
 * 'pdf' | 'image' | 'heic' | 'unknown' — what the plan dialog should do
 * with a file, from its bytes first and its name/type second.
 */
export function classifyFile({ name = '', type = '' } = {}, headBytes) {
  const kind = sniffImageType(headBytes);
  if (kind === 'pdf') return 'pdf';
  if (kind === 'heic') return 'heic';
  if (kind) return 'image';
  if (/pdf/i.test(type) || /\.pdf$/i.test(name)) return 'pdf';
  if (/hei[cf]/i.test(type) || /\.hei[cf]$/i.test(name)) return 'heic';
  if (/^image\//i.test(type) || /\.(jpe?g|png|gif|webp|bmp|tiff?|avif)$/i.test(name)) return 'image';
  return 'unknown';
}

const u16 = (b, at, le) => (le ? b[at] | (b[at + 1] << 8) : (b[at] << 8) | b[at + 1]);
const u32 = (b, at, le) => (le
  ? (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0
  : ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0);

/**
 * The pixel size written in an image's header (before any EXIF rotation),
 * or null. Lets the app check a huge picture before decoding it.
 */
export function readImageSize(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const kind = sniffImageType(b);
  try {
    if (kind === 'png' && b.length >= 24 && ascii(b, 12, 4) === 'IHDR') return { width: u32(b, 16, false), height: u32(b, 20, false) };
    if (kind === 'gif' && b.length >= 10) return { width: u16(b, 6, true), height: u16(b, 8, true) };
    if (kind === 'bmp') {
      const w = u32(b, 18, true) | 0, h = u32(b, 22, true) | 0;
      return { width: Math.abs(w), height: Math.abs(h) };
    }
    if (kind === 'webp' && b.length >= 30) {
      const chunk = ascii(b, 12, 4);
      if (chunk === 'VP8 ') return { width: u16(b, 26, true) & 0x3fff, height: u16(b, 28, true) & 0x3fff };
      if (chunk === 'VP8L') {
        const v = u32(b, 21, true);
        return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8X') {
        return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
      }
    }
    if (kind === 'jpeg') {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m === 0xff) { i++; continue; }                       // fill byte
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; } // no length
        if (m === 0xda || m === 0xd9) break;                      // image data starts: no SOF before it
        const len = u16(b, i + 2, false);
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { width: u16(b, i + 7, false), height: u16(b, i + 5, false) };
        }
        i += 2 + len;
      }
    }
  } catch { /* truncated header */ }
  return null;
}

/**
 * The EXIF orientation of a JPEG (1–8; 1 = upright, 6 = rotate 90° clockwise
 * to view, 8 = 90° counter-clockwise, 3 = 180°, 2/4/5/7 mirrored). 1 when
 * there is none.
 */
export function readJpegOrientation(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (sniffImageType(b) !== 'jpeg') return 1;
  try {
    let i = 2;
    while (i + 4 < b.length) {
      if (b[i] !== 0xff) return 1;
      const m = b[i + 1];
      if (m === 0xda || m === 0xd9) return 1;
      const len = u16(b, i + 2, false);
      if (m === 0xe1 && ascii(b, i + 4, 6) === 'Exif\0\0') {
        const t = i + 10;                                 // TIFF header
        const le = b[t] === 0x49;
        if (!le && b[t] !== 0x4d) return 1;
        const ifd = t + u32(b, t + 4, le);
        const count = u16(b, ifd, le);
        for (let k = 0; k < count; k++) {
          const e = ifd + 2 + k * 12;
          if (e + 12 > b.length) return 1;
          if (u16(b, e, le) === 0x0112) {
            const v = u16(b, e + 8, le);
            return v >= 1 && v <= 8 ? v : 1;
          }
        }
        return 1;
      }
      i += 2 + len;
    }
  } catch { /* truncated */ }
  return 1;
}

/** The upright size of a `w × h` image with EXIF orientation `o` (5–8 swap the sides). */
export function orientedSize(w, h, o = 1) {
  return o >= 5 && o <= 8 ? { width: h, height: w } : { width: w, height: h };
}

/**
 * Canvas transform [a, b, c, d, e, f] that draws an image stored with EXIF
 * orientation `o` upright into a W × H canvas (W × H = the upright size).
 * Draw the raw image at (0, 0) with its raw (scaled) size after setting it.
 */
export function exifMatrix(o, W, H) {
  switch (o) {
    case 2: return [-1, 0, 0, 1, W, 0];
    case 3: return [-1, 0, 0, -1, W, H];
    case 4: return [1, 0, 0, -1, 0, H];
    case 5: return [0, 1, 1, 0, 0, 0];
    case 6: return [0, 1, -1, 0, W, 0];
    case 7: return [0, -1, -1, 0, W, H];
    case 8: return [0, -1, 1, 0, 0, H];
    default: return [1, 0, 0, 1, 0, 0];
  }
}

// ---- pure: rotate and crop ---------------------------------------------------------------

/** 0 | 90 | 180 | 270 for any multiple of 90 (clockwise). */
export function normalizeRotation(deg) {
  const r = ((Math.round((deg || 0) / 90) * 90) % 360 + 360) % 360;
  return r;
}

/** The size of a `w × h` image after turning it `rotation` degrees clockwise. */
export function rotatedSize(w, h, rotation) {
  return normalizeRotation(rotation) % 180 ? { width: h, height: w } : { width: w, height: h };
}

/**
 * Canvas transform [a, b, c, d, e, f] mapping a `srcW × srcH` image into the
 * frame of that image turned `rotation` degrees clockwise.
 */
export function rotationMatrix(rotation, srcW, srcH) {
  switch (normalizeRotation(rotation)) {
    case 90: return [0, 1, -1, 0, srcH, 0];
    case 180: return [-1, 0, 0, -1, srcW, srcH];
    case 270: return [0, -1, 1, 0, 0, srcW];
    default: return [1, 0, 0, 1, 0, 0];
  }
}

/** Apply a canvas-style matrix to a point (used by the tests and the preview). */
export function applyMatrix(m, x, y) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/**
 * A crop rectangle in 0–1 units of the (rotated) image, {x, y, w, h}, after
 * the image is turned 90° more: dir 1 = clockwise, −1 = counter-clockwise.
 * The crop stays on the same part of the drawing.
 */
export function rotateNormRect(r, dir) {
  if (!r) return r;
  return dir > 0
    ? { x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w }
    : { x: r.y, y: 1 - r.x - r.w, w: r.h, h: r.w };
}

/**
 * Move or resize a 0–1 crop rectangle by a drag of (dx, dy) in 0–1 units.
 * mode: 'move', or the edges being dragged: 'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'.
 * The rectangle stays inside the image and at least `min` wide and tall.
 */
export function adjustCrop(r, mode, dx, dy, min = 0.05) {
  let x1 = r.x, y1 = r.y, x2 = r.x + r.w, y2 = r.y + r.h;
  if (mode === 'move') {
    const x = clamp(x1 + dx, 0, 1 - r.w), y = clamp(y1 + dy, 0, 1 - r.h);
    return { x, y, w: r.w, h: r.h };
  }
  if (mode.includes('w')) x1 = clamp(x1 + dx, 0, x2 - min);
  if (mode.includes('e')) x2 = clamp(x2 + dx, x1 + min, 1);
  if (mode.includes('n')) y1 = clamp(y1 + dy, 0, y2 - min);
  if (mode.includes('s')) y2 = clamp(y2 + dy, y1 + min, 1);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** True when a 0–1 crop covers (almost) the whole image, i.e. there is nothing to crop. */
export function isFullCrop(r) {
  return !r || (r.x <= 0.002 && r.y <= 0.002 && r.w >= 0.996 && r.h >= 0.996);
}

/** A 0–1 crop → whole pixels of a `w × h` image, inside it and at least 1 px. */
export function cropToPixels(r, w, h) {
  if (isFullCrop(r)) return { x: 0, y: 0, width: w, height: h };
  const x = clamp(Math.round(r.x * w), 0, w - 1);
  const y = clamp(Math.round(r.y * h), 0, h - 1);
  const x2 = clamp(Math.round((r.x + r.w) * w), x + 1, w);
  const y2 = clamp(Math.round((r.y + r.h) * h), y + 1, h);
  return { x, y, width: x2 - x, height: y2 - y };
}

/** A pixel rectangle of a `w × h` image → 0–1 units (the inverse of cropToPixels). */
export function pixelsToCrop(rect, w, h) {
  if (!rect) return null;
  const x = clamp(rect.x / w, 0, 1), y = clamp(rect.y / h, 0, 1);
  return { x, y, w: clamp(rect.width / w, 0, 1 - x), h: clamp(rect.height / h, 0, 1 - y) };
}

// ---- browser: decoding and encoding --------------------------------------------------------

/** The size of anything drawImage accepts. */
function sizeOf(src) {
  return { w: src.naturalWidth || src.videoWidth || src.width || 0, h: src.naturalHeight || src.videoHeight || src.height || 0 };
}

function release(src) {
  try { src?.close?.(); } catch { /* already closed */ }
}

function decodeWithImg(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.src = url;
  });
}

/**
 * Decode a picture into something drawImage accepts (ImageBitmap, or an
 * <img> when createImageBitmap is missing or fails). EXIF orientation is
 * applied with imageOrientation 'from-image'. The caller closes it (release).
 */
export async function decodeImage(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch (err) {
      // Older engines reject the option value itself; try once without it.
      if (err?.name === 'TypeError') {
        try { return await createImageBitmap(blob); } catch { /* try an <img> below */ }
      }
    }
  }
  return decodeWithImg(blob);
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Give a canvas's memory back now (iPhone Safari counts all canvases against one budget). */
function freeCanvas(c) {
  try { c.width = 0; c.height = 0; } catch { /* gone */ }
}

function context2d(c) {
  const ctx = c.getContext('2d', { alpha: false });
  if (!ctx) throw planError('too-large', MSG.tooLarge);
  return ctx;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b && b.size ? resolve(b) : reject(planError('too-large', MSG.tooLarge))), type, quality);
    } catch (err) {
      reject(planError('too-large', MSG.tooLarge, err));
    }
  });
}

function whiteFill(ctx, w, h) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
}

const typeOfKind = (k) => ({ jpeg: 'image/jpeg', png: 'image/png' }[k] || '');

async function headOf(blob, n = 256 * 1024) {
  return new Uint8Array(await blob.slice(0, Math.min(n, blob.size)).arrayBuffer());
}

/**
 * Make a picture safe to store as a plan: upright (EXIF baked in), within
 * the limits, JPEG or PNG. A JPEG/PNG that is already fine is returned
 * unchanged (no quality loss).
 * opts: {maxSide, maxPixels} (default PLAN_LIMITS, tightened by this device's canvas limits)
 * → {blob, width, height, reencoded}
 */
export async function normalizeImage(blob, { maxSide, maxPixels } = {}) {
  if (!(blob instanceof Blob) || !blob.size) throw planError('decode', 'That file is empty.');
  const limits = intersectLimits(canvasLimits(), { maxSide: maxSide ?? PLAN_LIMITS.maxSide, maxPixels: maxPixels ?? PLAN_LIMITS.maxPixels });
  const head = await headOf(blob);
  const kind = sniffImageType(head);
  if (kind === 'pdf') throw planError('is-pdf', 'This is a PDF, not a picture.');
  const orientation = kind === 'jpeg' ? readJpegOrientation(head) : 1;
  const raw = readImageSize(head);

  let src;
  try {
    src = await decodeImage(blob);
  } catch (err) {
    if (kind === 'heic') throw planError('heic', MSG.heic, err);
    if (raw && raw.width * raw.height > 4 * limits.maxPixels) throw planError('too-large', MSG.tooLarge, err);
    throw planError('decode', MSG.decode, err);
  }
  try {
    const { w, h } = sizeOf(src);
    if (!w || !h) throw planError('decode', MSG.decode);

    // createImageBitmap should have turned the picture upright. If the sides
    // were not swapped for a 90° orientation, this browser ignored the flag:
    // turn it ourselves. (180° and mirror flags cannot be checked this way;
    // every supported browser honours them.)
    let manual = 1;
    if (orientation >= 5 && raw && raw.width !== raw.height && w === raw.width && h === raw.height) manual = orientation;
    const upright = orientedSize(w, h, manual);
    const fit = fitWithin(upright.width, upright.height, limits);

    const keep = orientation === 1 && fit.scale === 1 && (kind === 'jpeg' || kind === 'png');
    if (keep) {
      const out = blob.type === typeOfKind(kind) ? blob : new Blob([blob], { type: typeOfKind(kind) });
      return { blob: out, width: w, height: h, reencoded: false };
    }

    const canvas = makeCanvas(fit.width, fit.height);
    try {
      const ctx = context2d(canvas);
      whiteFill(ctx, fit.width, fit.height);
      if (manual > 1) {
        ctx.setTransform(...exifMatrix(manual, fit.width, fit.height));
        const s = fit.scale;
        ctx.drawImage(src, 0, 0, w * s, h * s);
      } else {
        ctx.drawImage(src, 0, 0, fit.width, fit.height);
      }
      const enc = chooseEncoding(fit.width, fit.height, kind === 'jpeg' || kind === 'heic' || kind === 'avif' ? 'image/jpeg' : '');
      const out = await canvasToBlob(canvas, enc.type, enc.quality);
      return { blob: out, width: fit.width, height: fit.height, reencoded: true };
    } finally {
      freeCanvas(canvas);
    }
  } finally {
    release(src);
  }
}

/**
 * Rotate (clockwise, multiple of 90°) and crop a plan image in one pass.
 * crop: {x, y, w, h} in 0–1 units of the ROTATED image, or null.
 * → {blob, width, height}
 */
export async function applyEdits(blob, { rotation = 0, crop = null, cropPx = null, maxSide, maxPixels } = {}) {
  const rot = normalizeRotation(rotation);
  const limits = intersectLimits(canvasLimits(), { maxSide: maxSide ?? PLAN_LIMITS.maxSide, maxPixels: maxPixels ?? PLAN_LIMITS.maxPixels });
  const head = await headOf(blob, 64 * 1024);
  const kind = sniffImageType(head);
  let src;
  try { src = await decodeImage(blob); } catch (err) { throw planError('decode', MSG.decode, err); }
  try {
    const { w, h } = sizeOf(src);
    const R = rotatedSize(w, h, rot);
    const norm = cropPx ? pixelsToCrop(cropPx, R.width, R.height) : crop;
    const c = cropToPixels(norm, R.width, R.height);
    if (!rot && c.width === R.width && c.height === R.height) {
      const fit0 = fitWithin(w, h, limits);
      if (fit0.scale === 1) return { blob, width: w, height: h };
    }
    const fit = fitWithin(c.width, c.height, limits);
    const canvas = makeCanvas(fit.width, fit.height);
    try {
      const ctx = context2d(canvas);
      whiteFill(ctx, fit.width, fit.height);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(fit.scale, fit.scale);
      ctx.translate(-c.x, -c.y);
      ctx.transform(...rotationMatrix(rot, w, h));
      ctx.drawImage(src, 0, 0, w, h);
      const enc = chooseEncoding(fit.width, fit.height, kind === 'jpeg' ? 'image/jpeg' : '');
      const out = await canvasToBlob(canvas, enc.type, enc.quality);
      return { blob: out, width: fit.width, height: fit.height };
    } finally {
      freeCanvas(canvas);
    }
  } finally {
    release(src);
  }
}

/** Turn a plan image 90°: dir 1 = clockwise, −1 = counter-clockwise. → {blob, width, height} */
export function rotate90(blob, dir = 1) {
  return applyEdits(blob, { rotation: dir < 0 ? 270 : 90 });
}

/** Crop a plan image to a pixel rectangle {x, y, width, height}. → {blob, width, height} */
export function cropImage(blob, rect) {
  return applyEdits(blob, { cropPx: rect });
}

/** The small picture of a plan shown in lists (JPEG, about 480 px on the long side). */
export async function makePlanThumb(blob, maxSide = PLAN_THUMB_SIDE) {
  const src = await decodeImage(blob);
  try {
    const { w, h } = sizeOf(src);
    const fit = fitWithin(w, h, { maxSide });
    const canvas = makeCanvas(fit.width, fit.height);
    try {
      const ctx = context2d(canvas);
      whiteFill(ctx, fit.width, fit.height);
      ctx.drawImage(src, 0, 0, fit.width, fit.height);
      return await canvasToBlob(canvas, 'image/jpeg', 0.82);
    } finally {
      freeCanvas(canvas);
    }
  } finally {
    release(src);
  }
}

/**
 * A smaller copy of a picture for showing on screen (the plan preview while
 * rotating and cropping), as a canvas. The full-size decode is let go at once.
 */
export async function previewCanvas(blob, maxSide = 2048) {
  const src = await decodeImage(blob);
  try {
    const { w, h } = sizeOf(src);
    const fit = fitWithin(w, h, { maxSide });
    const canvas = makeCanvas(fit.width, fit.height);
    const ctx = context2d(canvas);
    whiteFill(ctx, fit.width, fit.height);
    ctx.drawImage(src, 0, 0, fit.width, fit.height);
    return canvas;
  } finally {
    release(src);
  }
}

// ---- browser: PDF ----------------------------------------------------------------------------

const vendor = (rel) => new URL(`../../vendor/pdfjs/${rel}`, import.meta.url).href;
let pdfJsPromise = null;

/**
 * Load the vendored pdf.js (once) and point it at its worker, character maps
 * and fonts. Resolves the pdfjsLib global.
 */
export function loadPdfJs() {
  if (pdfJsPromise) return pdfJsPromise;
  pdfJsPromise = new Promise((resolve, reject) => {
    const configure = (lib) => {
      lib.GlobalWorkerOptions.workerSrc = vendor('build/pdf.worker.min.js');
      return lib;
    };
    const ready = globalThis.pdfjsLib || globalThis['pdfjs-dist/build/pdf'];
    if (ready?.getDocument) { resolve(configure(ready)); return; }
    const s = document.createElement('script');
    s.src = vendor('build/pdf.min.js');
    s.async = true;
    s.onload = () => {
      const lib = globalThis.pdfjsLib || globalThis['pdfjs-dist/build/pdf'];
      if (lib?.getDocument) resolve(configure(lib));
      else reject(planError('pdf-lib', MSG.pdfLib));
    };
    s.onerror = () => { s.remove(); reject(planError('pdf-lib', MSG.pdfLib)); };
    document.head.append(s);
  }).catch((err) => {
    pdfJsPromise = null; // let a later try load it again (e.g. back in signal)
    throw err;
  });
  return pdfJsPromise;
}

/**
 * Open a PDF from its bytes. opts.password for a locked one.
 * Rejects with code 'pdf-password' (a password is needed), 'pdf-password-wrong',
 * 'pdf-damaged' or 'pdf-open'.
 */
export async function openPdf(data, { password } = {}) {
  const lib = await loadPdfJs();
  // pdf.js hands the bytes to its worker (the buffer is detached), so give
  // it a copy: the dialog may need to try again with a password.
  const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0));
  const task = lib.getDocument({
    data: bytes,
    password: password || undefined,
    isEvalSupported: false,
    cMapUrl: vendor('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: vendor('standard_fonts/'),
  });
  try {
    return await task.promise;
  } catch (err) {
    try { task.destroy(); } catch { /* already gone */ }
    if (err?.name === 'PasswordException') {
      const wrong = err.code === (lib.PasswordResponses?.INCORRECT_PASSWORD ?? 2);
      throw planError(wrong ? 'pdf-password-wrong' : 'pdf-password',
        wrong ? 'That password did not open the PDF.' : 'This PDF is locked with a password.', err);
    }
    if (err?.name === 'InvalidPDFException' || err?.name === 'FormatError') throw planError('pdf-damaged', MSG.pdfDamaged, err);
    throw planError('pdf-open', `This PDF could not be opened (${err?.message || err}). Try downloading it again, or use a screenshot of the plan.`, err);
  }
}

/** The PDF's own page names ("A2.1") when it has them, else null. */
export async function pdfPageLabels(doc) {
  try {
    const labels = await doc.getPageLabels();
    return Array.isArray(labels) && labels.some((l) => l && l.trim()) ? labels : null;
  } catch { return null; }
}

async function renderPageAt(page, scale, signal) {
  const lib = await loadPdfJs();
  const viewport = page.getViewport({ scale });
  const W = Math.max(1, Math.floor(viewport.width));
  const H = Math.max(1, Math.floor(viewport.height));
  const canvas = makeCanvas(W, H);
  try {
    const ctx = context2d(canvas);
    whiteFill(ctx, W, H);
    const task = page.render({
      canvasContext: ctx,
      viewport,
      background: '#ffffff',
      // Show markups saved as PDF annotations (architects' clouds and notes).
      annotationMode: lib.AnnotationMode?.ENABLE ?? 1,
    });
    const onAbort = () => { try { task.cancel(); } catch { /* finished */ } };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await task.promise;
    } catch (err) {
      if (signal?.aborted || err?.name === 'RenderingCancelledException') throw planError('cancelled', MSG.cancelled, err);
      throw planError('too-large', MSG.tooLarge, err);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    if (signal?.aborted) throw planError('cancelled', MSG.cancelled);
    return { canvas, W, H };
  } catch (err) {
    freeCanvas(canvas);
    throw err;
  }
}

/**
 * A small picture of page n (1-based) for the page picker.
 * → {blob (JPEG), width, height, sheet: {widthIn, heightIn}}
 */
export async function renderPdfPageThumbnail(doc, n, maxSide = 320, { signal } = {}) {
  const page = await doc.getPage(n);
  try {
    const base = page.getViewport({ scale: 1 });
    const scale = maxSide / Math.max(base.width, base.height);
    const { canvas, W, H } = await renderPageAt(page, scale, signal);
    try {
      const blob = await canvasToBlob(canvas, 'image/jpeg', 0.8);
      return { blob, width: W, height: H, sheet: { widthIn: base.width / 72, heightIn: base.height / 72 } };
    } finally {
      freeCanvas(canvas);
    }
  } finally {
    try { page.cleanup(); } catch { /* fine */ }
  }
}

/**
 * Render page n (1-based) as the plan image: longest side `maxSide` (6000),
 * within the plan and canvas limits. If the phone runs out of canvas memory
 * it tries again with half the pixels (twice) rather than give up.
 * opts.signal cancels (code 'cancelled').
 * → {blob, width, height}
 */
export async function renderPdfPage(doc, n, { maxSide = PDF_TARGET_SIDE, maxPixels, signal } = {}) {
  const limits = intersectLimits(canvasLimits(), { maxSide: PLAN_LIMITS.maxSide, maxPixels: maxPixels ?? PLAN_LIMITS.maxPixels });
  const page = await doc.getPage(n);
  try {
    const base = page.getViewport({ scale: 1 });
    let scale = pdfRenderScale(base.width, base.height, { targetSide: maxSide, maxSide: limits.maxSide, maxPixels: limits.maxPixels });
    for (let attempt = 0; ; attempt++) {
      try {
        const { canvas, W, H } = await renderPageAt(page, scale, signal);
        try {
          const enc = chooseEncoding(W, H, 'pdf');
          const blob = await canvasToBlob(canvas, enc.type, enc.quality);
          return { blob, width: W, height: H };
        } finally {
          freeCanvas(canvas);
        }
      } catch (err) {
        if (err.code === 'cancelled' || attempt >= 2) throw err;
        scale *= Math.SQRT1_2;
      }
    }
  } finally {
    try { page.cleanup(); } catch { /* fine */ }
  }
}
