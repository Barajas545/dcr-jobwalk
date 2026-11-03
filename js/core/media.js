// media.js — pictures, video and sound: open, shrink, thumbnails, the facts
// of a recorded video, which recording format to use, and the EXIF of photos
// that come from the gallery.
//
// Why it is careful:
//  - iPhones run short of memory on big pictures and then fail quietly
//    (toBlob hands back null, a canvas over the size limit draws nothing).
//    So every canvas here stays under the iOS limit, is freed as soon as it
//    is done, and encoding retries smaller instead of giving up.
//  - A broken file must never hang the app: everything that waits on the
//    browser (decoding, video metadata, seeking) has a timeout.
//  - Recording formats come from an ordered list that matches what Safari
//    and Chrome really accept (docs/RESEARCH.md "camera"): H.264/AAC in MP4
//    first because it plays everywhere, WebM after. 'h264'/'aac' codec names
//    are never used — WebKit rejects them.
//  - Photos are turned upright by EXIF orientation, never by re-encoding, so
//    the original camera bytes are kept as they were taken.
//
// The parsers (EXIF, JPEG/PNG size, orientation), the size maths and the
// format choice are pure and run in Node (tests/media.test.mjs). Anything
// that needs a canvas or a <video> touches the browser only inside the
// function that needs it.

/** The canvas area every iPhone we support can handle (iOS 17 and older: 4096×4096). */
export const IOS_SAFE_CANVAS_AREA = 16_777_216;

/**
 * Recording formats in order of preference (docs/RESEARCH.md "camera",
 * verified). Explicit codec strings only: a bare 'video/mp4' lets Chrome
 * write VP9 inside MP4, which may not play on an iPhone. When none of these
 * is accepted the browser's own default is used ('' — WebKit: H.264 MP4).
 */
export const VIDEO_MIME_CANDIDATES = Object.freeze([
  'video/mp4;codecs=avc1.640028,mp4a.40.2', // H.264 High + AAC: iOS 14.3+, Chrome 126+ where an encoder exists
  'video/mp4;codecs=avc1.42E01F,mp4a.40.2', // H.264 Baseline + AAC
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/webm;codecs=vp9,opus',            // Chrome; iOS 18.4+ when VP9 is on
  'video/webm;codecs=vp8,opus',
]);

/** Voice note formats in order of preference: AAC in MP4 (.m4a) plays everywhere, then Opus. */
export const AUDIO_MIME_CANDIDATES = Object.freeze([
  'audio/mp4;codecs=mp4a.40.2',
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/webm',
]);

// ---- small shared helpers ---------------------------------------------------------------

/**
 * Resolve or reject like `promise`, but reject with `message` after `ms`.
 * The work itself is not cancelled — this only stops the caller waiting forever.
 */
export function withTimeout(promise, ms, message = 'This took too long.') {
  if (!ms || !isFinite(ms)) return Promise.resolve(promise);
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(message);
      e.name = 'TimeoutError';
      reject(e);
    }, ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

/** 'video/mp4;codecs=avc1' → 'video/mp4' */
export function baseMime(mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase();
}

/** A file extension for a media type: video/mp4 → mp4, audio/mp4 → m4a, image/jpeg → jpg. */
export function extForMime(mime, fallback = 'bin') {
  const m = baseMime(mime);
  const map = {
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
    'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'webm', 'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/wave': 'wav', 'audio/x-wav': 'wav',
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'image/heic': 'heic', 'image/heif': 'heif', 'image/avif': 'avif',
  };
  return map[m] || fallback;
}

/**
 * The size that fits inside `maxSide` (longest side) and `maxArea` (pixels),
 * never larger than the original. → {width, height, scale}
 */
export function scaleToFit(width, height, maxSide = Infinity, maxArea = Infinity) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (w <= 0 || h <= 0) return { width: 0, height: 0, scale: 1 };
  let s = 1;
  if (isFinite(maxSide) && maxSide > 0) s = Math.min(s, maxSide / Math.max(w, h));
  if (isFinite(maxArea) && maxArea > 0) s = Math.min(s, Math.sqrt(maxArea / (w * h)));
  if (s >= 1) return { width: w, height: h, scale: 1 };
  return { width: Math.max(1, Math.floor(w * s)), height: Math.max(1, Math.floor(h * s)), scale: s };
}

function toView(bytes) {
  if (bytes instanceof DataView) return bytes;
  if (bytes instanceof ArrayBuffer) return new DataView(bytes);
  if (ArrayBuffer.isView(bytes)) return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new TypeError('Expected bytes (ArrayBuffer or typed array)');
}

async function headBytes(blob, n) {
  return new Uint8Array(await blob.slice(0, Math.min(blob.size, n)).arrayBuffer());
}

// ---- JPEG structure ------------------------------------------------------------------------
//
// A JPEG is a list of segments (FF xx, length, data) up to the image data
// (SOS). The size is in the SOF segment; EXIF is an APP1 segment that
// starts with "Exif\0\0" followed by a TIFF structure.

const isSof = (m) => m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC;

function isExifHeader(dv, start, len) {
  return len >= 14 && start + 6 <= dv.byteLength &&
    dv.getUint32(start) === 0x45786966 && dv.getUint16(start + 4) === 0x0000; // "Exif\0\0"
}

/**
 * Walk the segments before the image data.
 * → {jpeg, truncated, sof: {width, height} | null, exif: {start, end, segEnd} | null}
 * `truncated` says the bytes ran out before the image data (read more).
 */
function scanJpeg(dv) {
  const out = { jpeg: false, truncated: false, sof: null, exif: null };
  const n = dv.byteLength;
  if (n < 4 || dv.getUint16(0) !== 0xFFD8) return out;
  out.jpeg = true;
  let p = 2;
  for (let guard = 0; guard < 4096; guard++) {
    if (p + 4 > n) { out.truncated = true; return out; }
    if (dv.getUint8(p) !== 0xFF) return out; // lost the thread: corrupt, stop here
    let m = dv.getUint8(p + 1);
    while (m === 0xFF) { // fill bytes before a marker
      p++;
      if (p + 4 > n) { out.truncated = true; return out; }
      m = dv.getUint8(p + 1);
    }
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { p += 2; continue; }
    if (m === 0xD9 || m === 0xDA) return out; // end of image / start of image data
    const len = dv.getUint16(p + 2);
    if (len < 2) return out;
    const start = p + 4;
    const dataLen = len - 2;
    if (m === 0xE1 && !out.exif && isExifHeader(dv, start, dataLen)) {
      out.exif = { start: start + 6, end: Math.min(n, start + dataLen), segEnd: start + dataLen };
    }
    if (isSof(m)) {
      if (start + 5 > n) { out.truncated = true; return out; }
      out.sof = { height: dv.getUint16(start + 1), width: dv.getUint16(start + 3) };
      return out;
    }
    p = start + dataLen;
  }
  return out;
}

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/**
 * A reader for the TIFF structure inside EXIF, bounds-checked everywhere:
 * a damaged or hostile file gives nulls, never an exception or a hang.
 */
function tiffReader(dv, start, end) {
  if (end - start < 8 || end > dv.byteLength) return null;
  const bo = dv.getUint16(start);
  const le = bo === 0x4949 ? true : bo === 0x4D4D ? false : null;
  if (le === null) return null;
  if (dv.getUint16(start + 2, le) !== 42) return null;
  const ok = (abs, size) => abs >= start && size >= 0 && abs + size <= end;
  const seen = new Set();

  function readIfd(rel) {
    if (typeof rel !== 'number' || !rel || seen.has(rel)) return null;
    const abs = start + rel;
    if (!ok(abs, 2)) return null;
    seen.add(rel);
    const count = dv.getUint16(abs, le);
    const fit = Math.min(count, 1000, Math.floor((end - abs - 2) / 12));
    const tags = new Map();
    for (let i = 0; i < fit; i++) {
      const e = abs + 2 + i * 12;
      const tag = dv.getUint16(e, le);
      const type = dv.getUint16(e + 2, le);
      const n = dv.getUint32(e + 4, le);
      const unit = TYPE_SIZE[type];
      if (!unit || !n || n > 65535) continue;
      const size = unit * n;
      const at = size <= 4 ? e + 8 : start + dv.getUint32(e + 8, le);
      if (!ok(at, size)) continue;
      if (!tags.has(tag)) tags.set(tag, { type, n, at, entry: e });
    }
    return tags;
  }

  function uint(t, i = 0) {
    if (!t || i >= t.n) return null;
    if (t.type === 1 || t.type === 7) return dv.getUint8(t.at + i);
    if (t.type === 3) return dv.getUint16(t.at + i * 2, le);
    if (t.type === 4) return dv.getUint32(t.at + i * 4, le);
    if (t.type === 9) return dv.getInt32(t.at + i * 4, le);
    return null;
  }

  function rational(t, i = 0) {
    if (!t || i >= t.n) return null;
    if (t.type === 5 || t.type === 10) {
      const o = t.at + i * 8;
      const num = t.type === 5 ? dv.getUint32(o, le) : dv.getInt32(o, le);
      const den = t.type === 5 ? dv.getUint32(o + 4, le) : dv.getInt32(o + 4, le);
      if (!den) return null;
      const v = num / den;
      return isFinite(v) ? v : null;
    }
    const u = uint(t, i);
    return u == null ? null : u;
  }

  function ascii(t) {
    if (!t || (t.type !== 2 && t.type !== 7)) return null;
    let s = '';
    for (let i = 0; i < t.n; i++) {
      const c = dv.getUint8(t.at + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    s = s.trim();
    return s || null;
  }

  return { le, readIfd, uint, rational, ascii, firstIfd: () => readIfd(dv.getUint32(start + 4, le)) };
}

/** EXIF "YYYY:MM:DD HH:MM:SS" (+ optional "+02:00" offset and sub-seconds) → ms since epoch, or null. */
export function parseExifDate(text, offset = null, subsec = null) {
  if (!text) return null;
  const m = String(text).match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  let ms = 0;
  if (subsec && /^\d+$/.test(subsec)) ms = Math.round(Number(`0.${subsec}`) * 1000);
  const om = offset && String(offset).match(/^([+-])(\d{2}):?(\d{2})$/);
  if (om) {
    const sign = om[1] === '-' ? -1 : 1;
    const off = sign * (Number(om[2]) * 60 + Number(om[3]));
    return Date.UTC(y, mo - 1, d, h, mi, s, ms) - off * 60000;
  }
  // No offset: the camera's local time. On a job walk that is the phone's own zone.
  const t = new Date(y, mo - 1, d, h, mi, s, ms).getTime();
  return isFinite(t) ? t : null;
}

function dmsToDeg(r, t) {
  if (!t) return null;
  const d = r.rational(t, 0);
  if (d == null) return null;
  const m = t.n > 1 ? r.rational(t, 1) ?? 0 : 0;
  const s = t.n > 2 ? r.rational(t, 2) ?? 0 : 0;
  const v = d + m / 60 + s / 3600;
  return isFinite(v) ? v : null;
}

function exifFromTiff(dv, start, end) {
  const r = tiffReader(dv, start, end);
  if (!r) return null;
  const ifd0 = r.firstIfd();
  if (!ifd0) return null;
  const out = {
    lat: null, lng: null, alt: null, acc: null,
    heading: null, headingRef: null,
    takenAt: null, orientation: null,
    make: r.ascii(ifd0.get(0x010F)), model: r.ascii(ifd0.get(0x0110)),
  };
  const o = r.uint(ifd0.get(0x0112));
  if (o >= 1 && o <= 8) out.orientation = o;

  const exif = r.readIfd(r.uint(ifd0.get(0x8769)));
  const gps = r.readIfd(r.uint(ifd0.get(0x8825)));

  if (gps) {
    let lat = dmsToDeg(r, gps.get(0x0002));
    let lng = dmsToDeg(r, gps.get(0x0004));
    const latRef = (r.ascii(gps.get(0x0001)) || 'N').toUpperCase();
    const lngRef = (r.ascii(gps.get(0x0003)) || 'E').toUpperCase();
    if (lat != null && latRef.startsWith('S')) lat = -lat;
    if (lng != null && lngRef.startsWith('W')) lng = -lng;
    // 0,0 is what a camera writes when it had no fix.
    const valid = lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
    if (valid) {
      out.lat = lat;
      out.lng = lng;
      const alt = r.rational(gps.get(0x0006));
      if (alt != null) out.alt = r.uint(gps.get(0x0005)) === 1 ? -alt : alt;
      const hpe = r.rational(gps.get(0x001F)); // GPSHPositioningError, meters (iPhone writes it)
      if (hpe != null && hpe >= 0) out.acc = hpe;
    }
    const dir = r.rational(gps.get(0x0011));
    if (dir != null && dir >= 0 && dir <= 360) {
      out.heading = dir % 360;
      out.headingRef = (r.ascii(gps.get(0x0010)) || 'T').toUpperCase().startsWith('M') ? 'M' : 'T';
    }
  }

  // When it was taken: the original time with its zone, else that time as
  // local time, else the GPS clock (UTC), else the file's own date.
  let takenAt = null;
  if (exif) {
    const dto = r.ascii(exif.get(0x9003));
    takenAt = parseExifDate(dto, r.ascii(exif.get(0x9011)), r.ascii(exif.get(0x9291)));
  }
  if (takenAt == null && gps) {
    const ds = r.ascii(gps.get(0x001D));
    const ts = gps.get(0x0007);
    const dm = ds && ds.match(/^(\d{4}):(\d{2}):(\d{2})/);
    if (dm && ts && ts.n >= 3) {
      const h = r.rational(ts, 0), mi = r.rational(ts, 1), s = r.rational(ts, 2);
      if (h != null && mi != null && s != null) {
        const t = Date.UTC(+dm[1], +dm[2] - 1, +dm[3], 0, 0, 0) + Math.round(((h * 60 + mi) * 60 + s) * 1000);
        if (isFinite(t) && +dm[1] >= 1900) takenAt = t;
      }
    }
  }
  if (takenAt == null) {
    takenAt = parseExifDate(r.ascii(ifd0.get(0x0132)), exif ? r.ascii(exif.get(0x9010)) : null);
  }
  out.takenAt = takenAt;
  return out;
}

/**
 * The EXIF facts of a JPEG, from its bytes: {lat, lng, alt, acc, heading,
 * headingRef ('T' true | 'M' magnetic), takenAt (ms), orientation (1–8),
 * make, model}, any of them null. null when there is no EXIF at all.
 * Never throws on damaged data.
 */
export function parseExif(bytes) {
  let dv;
  try { dv = toView(bytes); } catch { return null; }
  try {
    const s = scanJpeg(dv);
    if (!s.jpeg || !s.exif) return null;
    return exifFromTiff(dv, s.exif.start, s.exif.end);
  } catch {
    return null; // a reader bug must never break an import
  }
}

/**
 * readExif(blob) → {lat, lng, alt, takenAt, orientation, …} | null — for
 * photos imported from the gallery. Reads only the start of the file.
 */
export async function readExif(blob) {
  if (!(blob instanceof Blob) || !blob.size) return null;
  try {
    let bytes = await headBytes(blob, 256 * 1024);
    let dv = toView(bytes);
    let s = scanJpeg(dv);
    if (!s.jpeg) return null;
    const need = s.exif ? s.exif.segEnd : (s.truncated ? 2 * 1024 * 1024 : 0);
    if (need > bytes.byteLength && blob.size > bytes.byteLength) {
      bytes = await headBytes(blob, need);
      dv = toView(bytes);
      s = scanJpeg(dv);
    }
    if (!s.exif) return null;
    return exifFromTiff(dv, s.exif.start, s.exif.end);
  } catch {
    return null;
  }
}

const SWAPS_SIDES = (o) => o >= 5 && o <= 8;

function orientationOf(dv, s) {
  if (!s.exif) return 1;
  try {
    const r = tiffReader(dv, s.exif.start, s.exif.end);
    const ifd0 = r?.firstIfd();
    const o = ifd0 ? r.uint(ifd0.get(0x0112)) : null;
    return o >= 1 && o <= 8 ? o : 1;
  } catch { return 1; }
}

/**
 * Size of a JPEG from its header, without decoding it:
 * {width, height (as shown, EXIF rotation applied), rawWidth, rawHeight, orientation} | null.
 */
export function parseJpegInfo(bytes) {
  let dv;
  try { dv = toView(bytes); } catch { return null; }
  const s = scanJpeg(dv);
  if (!s.jpeg || !s.sof || !s.sof.width || !s.sof.height) return null;
  const orientation = orientationOf(dv, s);
  const swap = SWAPS_SIDES(orientation);
  return {
    width: swap ? s.sof.height : s.sof.width,
    height: swap ? s.sof.width : s.sof.height,
    rawWidth: s.sof.width,
    rawHeight: s.sof.height,
    orientation,
  };
}

/** Size of a PNG from its header: {width, height} | null. */
export function parsePngSize(bytes) {
  let dv;
  try { dv = toView(bytes); } catch { return null; }
  if (dv.byteLength < 24) return null;
  if (dv.getUint32(0) !== 0x89504E47 || dv.getUint32(4) !== 0x0D0A1A0A || dv.getUint32(12) !== 0x49484452) return null;
  const width = dv.getUint32(16), height = dv.getUint32(20);
  return width && height ? { width, height, rawWidth: width, rawHeight: height, orientation: 1 } : null;
}

/** parseJpegInfo for a Blob: reads only as much of the file as the header needs. */
export async function readJpegInfo(blob) {
  if (!(blob instanceof Blob) || blob.size < 4) return null;
  let bytes = await headBytes(blob, 256 * 1024);
  let dv = toView(bytes);
  let s = scanJpeg(dv);
  if (!s.jpeg) return null;
  if (!s.sof && s.truncated && blob.size > bytes.byteLength) {
    bytes = await headBytes(blob, 4 * 1024 * 1024);
    dv = toView(bytes);
    s = scanJpeg(dv);
  }
  return parseJpegInfo(dv);
}

/** Header-only size of a JPEG or PNG Blob, or null for anything else. */
export async function readImageHeader(blob) {
  if (!(blob instanceof Blob) || blob.size < 24) return null;
  const jpeg = await readJpegInfo(blob);
  if (jpeg) return jpeg;
  return parsePngSize(await headBytes(blob, 64));
}

// ---- orientation --------------------------------------------------------------------------
//
// EXIF orientation says how to turn the stored pixels to show them upright.
// 1 = as stored, 6 = turn 90° clockwise, 3 = 180°, 8 = 90° counter-clockwise;
// 2, 4, 5, 7 are mirrored (front cameras, scanners) and are left alone.

const ROT_OF = { 1: 0, 6: 90, 3: 180, 8: 270 };
const ORIENT_OF = { 0: 1, 90: 6, 180: 3, 270: 8 };

/** Clockwise degrees an orientation turns the stored pixels (null when mirrored). */
export function rotationOfOrientation(o) {
  return ROT_OF[o] ?? null;
}

/** The orientation that turns the pixels `deg` clockwise (0/90/180/270). */
export function orientationOfRotation(deg) {
  const d = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return ORIENT_OF[d];
}

/** Turn an already-oriented picture a further `extraCW` degrees clockwise: the new orientation, or null (mirrored). */
export function composeOrientation(orientation, extraCW) {
  const r = rotationOfOrientation(orientation || 1);
  if (r == null) return null;
  return orientationOfRotation(r + extraCW);
}

function minimalExifApp1(orientation) {
  // FFE1, length 34, "Exif\0\0", big-endian TIFF, one IFD entry: Orientation (SHORT).
  const b = new Uint8Array(36);
  const dv = new DataView(b.buffer);
  dv.setUint16(0, 0xFFE1);
  dv.setUint16(2, 34);
  b.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
  b.set([0x4D, 0x4D, 0x00, 0x2A, 0, 0, 0, 8], 10);
  dv.setUint16(18, 1);          // one entry
  dv.setUint16(20, 0x0112);     // Orientation
  dv.setUint16(22, 3);          // SHORT
  dv.setUint32(24, 1);          // count
  dv.setUint16(28, orientation);
  dv.setUint32(32, 0);          // no next IFD
  return b;
}

/**
 * Set a JPEG's EXIF orientation without touching its picture data, so a
 * photo held sideways shows upright and keeps every original byte of image.
 * Patches the existing tag, or adds a minimal EXIF block to a JPEG that has
 * none (a canvas JPEG). Resolves the new Blob, or null when the file is not
 * a JPEG or has EXIF without an orientation tag (rewriting that is not worth
 * the risk to the file).
 */
export async function setJpegOrientation(blob, orientation) {
  if (!(orientation >= 1 && orientation <= 8)) throw new Error('Orientation must be 1–8');
  const bytes = await headBytes(blob, 256 * 1024);
  const dv = toView(bytes);
  const s = scanJpeg(dv);
  if (!s.jpeg) return null;
  const type = blob.type || 'image/jpeg';
  if (!s.exif) {
    return new Blob([blob.slice(0, 2), minimalExifApp1(orientation), blob.slice(2)], { type });
  }
  const r = tiffReader(dv, s.exif.start, s.exif.end);
  const ifd0 = r?.firstIfd();
  const t = ifd0?.get(0x0112);
  if (!t || (t.type !== 3 && t.type !== 4)) return null;
  const patch = new Uint8Array(t.type === 3 ? 2 : 4);
  const pv = new DataView(patch.buffer);
  if (t.type === 3) pv.setUint16(0, orientation, r.le); else pv.setUint32(0, orientation, r.le);
  return new Blob([blob.slice(0, t.at), patch, blob.slice(t.at + patch.length)], { type });
}

// ---- decoding -------------------------------------------------------------------------------

/** {width, height} of anything drawable. */
export function sourceSize(src) {
  if (!src) return { width: 0, height: 0 };
  const width = src.naturalWidth || src.videoWidth || src.displayWidth || src.width || 0;
  const height = src.naturalHeight || src.videoHeight || src.displayHeight || src.height || 0;
  return { width, height };
}

/** Free a decoded picture (ImageBitmaps hold their pixels until closed). */
export function releaseImage(img) {
  try { img?.close?.(); } catch { /* already closed */ }
}

function decodeWithImg(blob, timeoutMs) {
  return withTimeout(new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    const done = (ok) => {
      img.onload = img.onerror = null;
      // The decoded picture stays usable after the URL is let go.
      URL.revokeObjectURL(url);
      if (ok && img.naturalWidth) resolve(img);
      else reject(new Error('This picture could not be opened. The file may be damaged, or in a format this browser cannot show (such as HEIC).'));
    };
    img.onload = () => {
      if (img.decode) img.decode().then(() => done(true), () => done(true));
      else done(true);
    };
    img.onerror = () => done(false);
    img.src = url;
  }), timeoutMs, 'Opening this picture took too long.');
}

async function bitmapOrNull(blob, opts, timeoutMs) {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    return await withTimeout(opts ? createImageBitmap(blob, opts) : createImageBitmap(blob), timeoutMs);
  } catch {
    return null;
  }
}

/**
 * Open a picture for drawing, turned upright by its EXIF orientation:
 * an ImageBitmap where the browser can, else an <img>. Call
 * releaseImage() when done with it.
 */
export async function decodeImage(blob, { timeoutMs = 30000 } = {}) {
  if (!(blob instanceof Blob)) throw new Error('decodeImage needs a Blob');
  let header = null;
  try { header = await readImageHeader(blob); } catch { header = null; }
  let bmp = await bitmapOrNull(blob, { imageOrientation: 'from-image' }, timeoutMs);
  if (!bmp) bmp = await bitmapOrNull(blob, null, timeoutMs);
  if (bmp) {
    // Some browsers ignore EXIF rotation in createImageBitmap; the sides then
    // come out swapped. An <img> always honours it.
    const ignoredRotation = header && SWAPS_SIDES(header.orientation) &&
      header.rawWidth !== header.rawHeight && bmp.width === header.rawWidth && bmp.height === header.rawHeight;
    if (!ignoredRotation) return bmp;
    releaseImage(bmp);
  }
  if (typeof Image === 'undefined') throw new Error('This picture could not be opened here.');
  return decodeWithImg(blob, timeoutMs);
}

/**
 * Open a picture already shrunk to width × height (as shown), so a phone
 * never holds a 48-megapixel bitmap just to make a small copy. Falls back to
 * a full decode when the browser cannot shrink while decoding.
 */
async function decodeAtSize(blob, width, height, header = null, timeoutMs = 30000) {
  const bmp = await bitmapOrNull(blob, {
    imageOrientation: 'from-image', resizeWidth: width, resizeHeight: height, resizeQuality: 'high',
  }, timeoutMs);
  if (bmp) {
    // Trust it when it came out the size (and so the rotation) asked for —
    // or at the full upright size (a browser that ignores resizeWidth): the
    // caller draws it smaller, no need to decode the photo twice.
    if (bmp.width === width && bmp.height === height) return bmp;
    if (header && bmp.width === header.width && bmp.height === header.height) return bmp;
    releaseImage(bmp);
  }
  return decodeImage(blob, { timeoutMs });
}

/** {width, height} of a picture as shown (EXIF rotation applied). Reads the header when it can. */
export async function imageSize(blob) {
  const h = await readImageHeader(blob).catch(() => null);
  if (h) return { width: h.width, height: h.height };
  const img = await decodeImage(blob);
  try { return sourceSize(img); } finally { releaseImage(img); }
}

// ---- canvas ---------------------------------------------------------------------------------

/** A canvas: a <canvas> on a page, an OffscreenCanvas in a worker. */
export function makeCanvas(width, height) {
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  throw new Error('Pictures cannot be drawn here (no canvas).');
}

/** Give a canvas's memory back now (iOS keeps it until the canvas is collected otherwise). */
export function freeCanvas(c) {
  try { c.width = 0; c.height = 0; } catch { /* detached */ }
}

function toBlobOnce(c, type, quality) {
  if (typeof c.convertToBlob === 'function' && typeof c.toBlob !== 'function') {
    return c.convertToBlob({ type, quality }).catch(() => null);
  }
  return new Promise((resolve) => {
    try { c.toBlob((b) => resolve(b), type, quality); } catch { resolve(null); }
  });
}

/**
 * Encode a canvas. iOS hands back null when it is short of memory; then a
 * smaller copy is tried (up to twice) rather than losing the picture.
 * → {blob, width, height} (the size actually encoded)
 */
export async function encodeCanvas(canvas, type = 'image/jpeg', quality = 0.92) {
  let src = canvas;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const blob = await withTimeout(toBlobOnce(src, type, quality), 30000).catch(() => null);
      if (blob && blob.size) return { blob, width: src.width, height: src.height };
      const w = Math.floor(src.width * 0.7), h = Math.floor(src.height * 0.7);
      if (w < 64 || h < 64) break;
      const next = makeCanvas(w, h);
      const g = next.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(src, 0, 0, w, h);
      if (src !== canvas) freeCanvas(src);
      src = next;
    }
  } finally {
    if (src !== canvas) freeCanvas(src);
  }
  throw new Error('The phone ran out of memory turning the picture into a file. Close other apps and try again.');
}

/** canvasToBlob(canvas, type, quality) → Promise<Blob>, retrying smaller under memory pressure. */
export async function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.92) {
  return (await encodeCanvas(canvas, type, quality)).blob;
}

function draw(img, width, height, { background = '#fff' } = {}) {
  const c = makeCanvas(width, height);
  const g = c.getContext('2d');
  if (!g) throw new Error('The phone could not make room for this picture.');
  // JPEG has no transparency: a see-through PNG would otherwise turn black.
  if (background) {
    g.fillStyle = background;
    g.fillRect(0, 0, width, height);
  }
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, width, height);
  return c;
}

/**
 * A small JPEG copy (longest side `max`) of a Blob, ImageBitmap, <img>,
 * <canvas> or <video>.
 */
export async function makeThumb(source, max = 400, quality = 0.8) {
  let img = source;
  let owned = false;
  if (source instanceof Blob) {
    const h = await readImageHeader(source).catch(() => null);
    const t = h ? scaleToFit(h.width, h.height, max) : null;
    img = t ? await decodeAtSize(source, t.width, t.height, h) : await decodeImage(source);
    owned = true;
  }
  let c = null;
  try {
    const { width: sw, height: sh } = sourceSize(img);
    if (!sw || !sh) throw new Error('This picture has no size.');
    const { width, height } = scaleToFit(sw, sh, max);
    c = draw(img, width, height);
    return (await encodeCanvas(c, 'image/jpeg', quality)).blob;
  } finally {
    if (c) freeCanvas(c);
    if (owned) releaseImage(img);
  }
}

/**
 * Shrink a picture so its longest side is at most `maxSide` (and its area
 * fits the iOS canvas limit). Pictures already small enough come back
 * untouched — same bytes — unless `force` (e.g. HEIC → JPEG).
 * → {blob, width, height, resized}
 */
export async function resizeImage(blob, { maxSide = Infinity, quality = 0.92, maxArea = IOS_SAFE_CANVAS_AREA, force = false, type = 'image/jpeg' } = {}) {
  const size = await imageSize(blob);
  const target = scaleToFit(size.width, size.height, maxSide, maxArea);
  if (!force && target.scale >= 1) return { blob, width: size.width, height: size.height, resized: false };
  const img = await decodeAtSize(blob, target.width, target.height, size);
  let c = null;
  try {
    c = draw(img, target.width, target.height);
    releaseImage(img);
    const out = await encodeCanvas(c, type, quality);
    return { ...out, resized: true };
  } finally {
    if (c) freeCanvas(c);
    releaseImage(img);
  }
}

/** resizeToMax(blob, maxSide, quality) → Promise<Blob> (the same Blob when already small enough). */
export async function resizeToMax(blob, maxSide, quality = 0.92) {
  return (await resizeImage(blob, { maxSide, quality })).blob;
}

/** Average brightness 0–255 of a picture (to catch the all-black first photo some iPhones give). */
export function meanLuminance(source) {
  const c = makeCanvas(16, 16);
  try {
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(source, 0, 0, 16, 16);
    const d = g.getImageData(0, 0, 16, 16).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    return sum / (d.length / 4);
  } finally {
    freeCanvas(c);
  }
}

// ---- video ------------------------------------------------------------------------------------

function waitEvent(target, okTypes, ms, failTypes = ['error']) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const offAll = () => {
      clearTimeout(timer);
      for (const t of okTypes) target.removeEventListener(t, onOk);
      for (const t of failTypes) target.removeEventListener(t, onFail);
    };
    const onOk = (e) => { offAll(); resolve(e); };
    const onFail = () => { offAll(); reject(target.error || new Error('The video could not be read.')); };
    for (const t of okTypes) target.addEventListener(t, onOk);
    for (const t of failTypes) target.addEventListener(t, onFail);
    timer = setTimeout(() => {
      offAll();
      const e = new Error('The video took too long to open.');
      e.name = 'TimeoutError';
      reject(e);
    }, ms);
  });
}

/**
 * The facts of a video Blob: {width, height, duration, posterBlob, playable}.
 * `duration` is in seconds or null. MediaRecorder files often say Infinity
 * (chunked WebM) or 0 (fragmented MP4); the "seek to the end" trick is used
 * only as a display fallback — the recorder's own measured time is what the
 * app stores. The poster is a JPEG of the frame at ~0.1 s. Never rejects and
 * never hangs: a broken file gives nulls and playable: false.
 */
export async function videoInfo(blob, { timeoutMs = 15000, posterAt = 0.1, posterMax = 1280 } = {}) {
  const out = { width: null, height: null, duration: null, posterBlob: null, playable: false };
  if (!(blob instanceof Blob) || !blob.size || typeof document === 'undefined') return out;
  const v = document.createElement('video');
  v.muted = true;
  v.defaultMuted = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.setAttribute('muted', '');
  v.preload = 'auto';
  const url = URL.createObjectURL(blob);
  const deadline = Date.now() + timeoutMs;
  const left = (cap) => Math.max(200, Math.min(cap, deadline - Date.now()));
  try {
    v.src = url;
    await waitEvent(v, ['loadedmetadata'], left(8000));
    out.playable = true;
    out.width = v.videoWidth || null;
    out.height = v.videoHeight || null;
    let d = v.duration;
    if (!isFinite(d) || d <= 0) {
      try {
        v.currentTime = 1e101;
        await waitEvent(v, ['durationchange', 'seeked', 'timeupdate'], left(3000));
      } catch { /* keep what we have */ }
      d = v.duration;
      try {
        v.currentTime = 0;
        await waitEvent(v, ['seeked'], left(2000));
      } catch { /* the poster step seeks again */ }
    }
    out.duration = isFinite(d) && d > 0 ? d : null;

    if (out.width && out.height && Date.now() < deadline) {
      try {
        if (v.readyState < 2) await waitEvent(v, ['loadeddata', 'canplay'], left(4000)).catch(() => {});
        const t = Math.min(posterAt, out.duration ? out.duration / 2 : posterAt);
        if (Math.abs(v.currentTime - t) > 0.02) {
          v.currentTime = t;
          await waitEvent(v, ['seeked'], left(4000)).catch(() => {});
        }
        if (v.readyState < 2) {
          // iOS sometimes paints no frame until the video has played a moment.
          try {
            await withTimeout(v.play(), left(2000));
            await waitEvent(v, ['timeupdate'], left(1500)).catch(() => {});
            v.pause();
          } catch { /* no frame: no poster */ }
        }
        if (v.readyState >= 2) {
          const { width, height } = scaleToFit(v.videoWidth, v.videoHeight, posterMax);
          const c = draw(v, width, height);
          try { out.posterBlob = (await encodeCanvas(c, 'image/jpeg', 0.85)).blob; } finally { freeCanvas(c); }
        }
      } catch (err) {
        console.warn('[media] no poster frame', err);
      }
    }
  } catch (err) {
    out.error = err?.message || String(err);
  } finally {
    try { v.pause(); } catch { /* fine */ }
    v.removeAttribute('src');
    try { v.load(); } catch { /* fine */ }
    URL.revokeObjectURL(url);
  }
  return out;
}

// ---- recording formats ------------------------------------------------------------------------

function firstSupported(list, MR) {
  if (!MR || typeof MR.isTypeSupported !== 'function') return '';
  for (const t of list) {
    try { if (MR.isTypeSupported(t)) return t; } catch { /* treat as unsupported */ }
  }
  return '';
}

/**
 * The best video recording type this browser accepts, or '' (let the
 * browser choose). `MR` is the MediaRecorder class (injectable for tests).
 */
export function pickVideoMime(MR = globalThis.MediaRecorder) {
  return firstSupported(VIDEO_MIME_CANDIDATES, MR);
}

/** The best voice-note recording type this browser accepts, or ''. */
export function pickAudioMime(MR = globalThis.MediaRecorder) {
  return firstSupported(AUDIO_MIME_CANDIDATES, MR);
}
