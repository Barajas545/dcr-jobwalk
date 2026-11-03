// capture.js — turning a picture (or a typed note) into a saved item.
//
// The owner's rule is "never lose a picture or a note", so the order of the
// steps matters more than anything else here:
//
//  1. The photo's bytes are saved and READ BACK (store.putMedia verifies
//     them) before anything else. From that moment the photo is on the phone.
//  2. The thumbnail is made and saved — a missing thumbnail is fine, the app
//     shows the photo without one, so a thumbnail problem never stops step 3.
//  3. The item is created pointing at the saved bytes.
//
// If step 3 fails, the error carries `retry()` (it resumes after the bytes
// that were already saved — nothing is saved twice) and `blob` (so the
// camera can offer "Download this photo"). The caller keeps the Blob in
// memory until a save resolves.
//
// The facts of the photo (level, time, size, pose, who) are saved WITH its
// bytes (putMedia `meta`), so if the app dies between steps 1 and 3,
// store.recoverOrphans() rebuilds the item at the next start.
//
// The position saved with a photo is a snapshot taken AT THE SHUTTER TAP
// (snapshotPose), copied field by field into plain values so a later sensor
// update can never change it and nothing odd (NaN, class instances) reaches
// the database. The raw sensor values come along, so headings can be
// recomputed later if the maths is ever improved.

import * as realStore from './store.js';
import { getSettings } from './settings.js';
import { uid, normDeg } from './util.js';
import { readExif, readImageHeader, makeThumb as realMakeThumb, imageSize as realImageSize, resizeImage as realResizeImage, baseMime } from './media.js';

const SOURCES = ['fused', 'gps', 'manual', 'sim', 'none'];
const QUALITIES = ['good', 'fair', 'poor', 'none'];
const HEADING_SOURCES = ['compass-aligned', 'wmm', 'setting', 'none'];
const RAW_SOURCES = ['abs', 'ios', 'rel', 'sim'];

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const oneOf = (v, list, dflt) => (list.includes(v) ? v : dflt);
const isPrimitive = (v) => v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && isFinite(v));

/** Copy the listed fields, plus any other plain (primitive) values the engine added, so nothing measured is dropped. */
function copyPlain(src, fields) {
  const out = {};
  for (const [k, fn] of Object.entries(fields)) out[k] = fn(src[k]);
  for (const [k, v] of Object.entries(src)) {
    if (!(k in fields) && isPrimitive(v) && typeof v !== 'undefined') out[k] = v;
  }
  return out;
}

function copyGeo(g) {
  if (!g || typeof g !== 'object' || num(g.lat) == null || num(g.lng) == null) return null;
  return copyPlain(g, { lat: num, lng: num, acc: num, alt: num, altAcc: num });
}

function copyXY(p, kx, ky) {
  if (!p || typeof p !== 'object' || num(p[kx]) == null || num(p[ky]) == null) return null;
  return { [kx]: p[kx], [ky]: p[ky] };
}

function copyRaw(r) {
  if (!r || typeof r !== 'object') return null;
  return copyPlain(r, {
    alpha: num, beta: num, gamma: num,
    absolute: (v) => (typeof v === 'boolean' ? v : null),
    // Known values: 'abs' | 'ios' | 'rel' | 'sim'; any other name is kept as it came (it is a measurement fact).
    src: (v) => (RAW_SOURCES.includes(v) || typeof v === 'string' ? v : null),
    compass: num, compassAcc: num, screenAngle: num, t: num,
    // The iPhone's learned alpha offset and the gravity hold angle: without
    // them an upright iPhone photo's heading cannot be recomputed from raw alpha.
    alphaOffset: num, holdAngle: num,
  });
}

const angle = (v) => (num(v) == null ? null : normDeg(v));

/** A pose for "no position known": the item still records when it was made. */
export function emptyPose(t = Date.now()) {
  return {
    t, geo: null, enu: null, plan: null, planAcc: null, planLocked: false,
    heading: null, headingAcc: null, planHeading: null, pitch: null, roll: null,
    facing: 'camera', source: 'none', quality: 'none',
    magHeading: null, declination: null, headingSource: 'none', raw: null, zoom: null,
    fix: null,
  };
}

/**
 * snapshotPose(pose, level) → a clean copy of a Pose (docs/SPEC.md §4.3) for
 * storage: plain numbers/strings only, every field present. Plan
 * coordinates are dropped when they cannot belong to `level` (a level in
 * map mode, or a pose computed for another level). `fix` — the last raw
 * GPS fix the engine used ({lat, lng, acc, alt, altAcc, speed, t}) — is kept
 * too, so a position can be recomputed later (docs/RESEARCH.md maps).
 */
export function snapshotPose(pose, level = null) {
  if (!pose || typeof pose !== 'object') return emptyPose();
  const out = emptyPose(num(pose.t) ?? Date.now());
  out.geo = copyGeo(pose.geo);
  out.enu = copyXY(pose.enu, 'e', 'n');
  out.plan = copyXY(pose.plan, 'x', 'y');
  out.planAcc = num(pose.planAcc);
  out.planLocked = pose.planLocked === true;
  const wrongLevel = level && ((level.plan === null) || (pose.levelId && level.id && pose.levelId !== level.id));
  if (wrongLevel) {
    out.plan = null;
    out.planAcc = null;
    out.planLocked = false;
  }
  out.heading = angle(pose.heading);
  out.headingAcc = num(pose.headingAcc);
  out.planHeading = angle(pose.planHeading);
  out.pitch = num(pose.pitch);
  out.roll = num(pose.roll);
  out.facing = oneOf(pose.facing, ['camera', 'top'], 'camera');
  out.source = oneOf(pose.source, SOURCES, 'none');
  out.quality = oneOf(pose.quality, QUALITIES, 'none');
  out.magHeading = angle(pose.magHeading);
  out.declination = num(pose.declination);
  out.headingSource = oneOf(pose.headingSource, HEADING_SOURCES, 'none');
  out.raw = copyRaw(pose.raw);
  out.zoom = num(pose.zoom);
  out.fix = pose.fix && copyGeo(pose.fix) ? { ...copyGeo(pose.fix), ...copyPlain(pose.fix, { t: num, speed: num }) } : null;
  return out;
}

// ---- which way is up ------------------------------------------------------------------------

/**
 * How the phone is held, from gravity (docs/RESEARCH.md orientation:
 * holdAngle = atan2(m31, m32)): degrees counter-clockwise from portrait on
 * the screen.orientation scale (0 portrait, 90 top edge pointing left, 180
 * upside down, 270 top edge right), and its strength 0..1 (0 when the phone
 * lies flat and the angle means nothing). null without beta/gamma.
 */
export function holdAngle({ beta, gamma } = {}) {
  if (num(beta) == null || num(gamma) == null) return null;
  const D = Math.PI / 180;
  const ux = -Math.cos(beta * D) * Math.sin(gamma * D); // m31
  const uy = Math.sin(beta * D);                        // m32
  return { angle: normDeg(Math.atan2(ux, uy) / D) || 0, strength: Math.hypot(ux, uy) };
}

/**
 * How far a picture must be turned to be upright, from the phone's tilt.
 *
 * The camera's picture is lined up with the SCREEN. When the screen does
 * not rotate with the phone (rotation lock on, or a turn the screen has not
 * followed yet) a photo held sideways comes out sideways. Gravity in the
 * phone's own frame (from the W3C beta/gamma angles: up = (−cos β·sin γ,
 * sin β) in screen-plane x/y) says which edge of the phone is really up.
 *
 * → {deviceAngle, rel, extraCW} where deviceAngle uses the
 * screen.orientation.angle convention (0 portrait, 90 = top edge pointing
 * left, …), rel = deviceAngle − screenAngle and extraCW = the clockwise turn
 * the picture needs (0 when it is fine). null when the phone is too flat
 * (pointing at the floor or the sky) or held diagonally to tell.
 */
export function uprightCorrection({ beta, gamma, screenAngle = 0 } = {}) {
  const h = holdAngle({ beta, gamma });
  if (!h || h.strength < 0.5) return null; // within ~30° of flat
  const phi = h.angle;
  const snapped = Math.round(phi / 90) * 90;
  if (Math.abs(phi - snapped) > 30) return null; // diagonal: not sure
  const deviceAngle = normDeg(snapped) || 0; // `|| 0` turns −0 into 0
  const rel = normDeg(deviceAngle - (num(screenAngle) ?? 0)) || 0;
  return { deviceAngle, rel, extraCW: normDeg(360 - rel) || 0 };
}

// ---- photos -----------------------------------------------------------------------------------

function captureError(message, cause, extra = {}) {
  const e = new Error(message);
  e.cause = cause;
  Object.assign(e, extra);
  return e;
}

/**
 * Whether a save failed because the phone is out of storage space
 * (QuotaExceededError, also when wrapped: savePhoto's error carries the
 * storage error as `cause`). The camera stops taking photos then — each new
 * one could only live in memory (docs/RESEARCH.md storage).
 */
export function isStorageFull(err) {
  for (let e = err, depth = 0; e && typeof e === 'object' && depth < 4; e = e.cause, depth++) {
    if (e.name === 'QuotaExceededError') return true;
  }
  return false;
}

function nameFor(prefix, t) {
  const d = new Date(t || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${prefix} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

/**
 * Save a photo: original (verified) → thumbnail → item.
 *
 * opts: {project, level, blob, width, height, pose, source ('camera' |
 * 'device-camera' | 'import'), zoom, takenAt (shutter time, ms), title,
 * poseAtOpen (device camera: where the phone was when its camera opened),
 * captureInfo ({method, rotated, …} — how the picture was taken), extra
 * (more item fields), onWarning(message), deps (tests: {store, makeThumb,
 * imageSize, resizeImage})}.
 *
 * Resolves the new item. Rejects with an Error that has `retry()` (resumes
 * without saving anything twice), `blob` (the bytes, for a download) and
 * `savedOriginal` (true when the bytes are already on the phone).
 */
export async function savePhoto(opts) {
  const {
    project, level, blob, pose = null, source = 'camera', zoom = null,
    takenAt = Date.now(), title = '', poseAtOpen = null, captureInfo = null, extra = null,
    onWarning = null, deps = {},
  } = opts || {};
  const st = deps.store || realStore;
  const thumbFn = deps.makeThumb || realMakeThumb;
  const sizeFn = deps.imageSize || realImageSize;
  const resizeFn = deps.resizeImage || realResizeImage;
  const projectId = typeof project === 'string' ? project : project?.id;
  const levelId = typeof level === 'string' ? level : level?.id ?? null;
  const levelObj = typeof level === 'object' ? level : null;
  if (!projectId) throw new Error('savePhoto needs the job walk.');
  if (!(blob instanceof Blob) || !blob.size) throw new Error('The camera gave an empty picture. Take it again.');

  const settings = getSettings();
  const warn = (msg, err) => {
    console.warn('[capture]', msg, err || '');
    try { onWarning?.(msg); } catch { /* the warning is only a courtesy */ }
  };

  const shot = snapshotPose(pose, levelObj);
  if (num(zoom) != null) shot.zoom = zoom;

  // A File from a file input is only borrowed: iOS deletes it when the page
  // is torn down. Copy its bytes into memory before anything else.
  let photo = blob;
  if (typeof File !== 'undefined' && blob instanceof File) {
    try {
      photo = new Blob([await blob.arrayBuffer()], { type: blob.type || 'image/jpeg' });
    } catch (err) {
      throw captureError(`The photo could not be read from the phone's camera: ${err.message}`, err, { stage: 'read', blob, savedOriginal: false });
    }
  }
  let width = num(opts.width);
  let height = num(opts.height);
  if (!width || !height) {
    try {
      const s = await sizeFn(photo);
      width = s.width || null;
      height = s.height || null;
    } catch (err) {
      warn('The photo size could not be read.', err);
    }
  }

  // Bigger than the "photo size" setting: shrink it at the photo quality
  // setting. If the phone cannot (memory), the full-size photo is kept —
  // a big photo is better than none.
  const maxSide = num(settings.photoMaxSize);
  let resized = false;
  if (maxSide && width && height && Math.max(width, height) > maxSide) {
    try {
      const r = await resizeFn(photo, { maxSide, quality: num(settings.photoQuality) ?? 0.92 });
      if (r?.blob?.size) {
        photo = r.blob;
        width = r.width;
        height = r.height;
        resized = !!r.resized;
      }
    } catch (err) {
      warn('The photo was kept at full size (the phone could not shrink it).', err);
    }
  }

  const itemId = uid('i_');
  const name = `${nameFor('Photo', takenAt)}.jpg`;
  const state = { originalId: null, thumbId: null, thumbTried: false, item: null };

  async function run() {
    if (state.item) return state.item;
    // 1. The bytes, verified. After this the photo is safe on the phone.
    if (!state.originalId) {
      try {
        // The facts go WITH the bytes: if the app dies before step 3,
        // store.recoverOrphans() rebuilds the item from them.
        const meta = {
          levelId, createdAt: num(takenAt) ?? Date.now(), width: width || null, height: height || null,
          pose: shot, capturedBy: settings.userName || '', source,
        };
        state.originalId = await st.putMedia(photo, { kind: 'original', projectId, itemId, name, meta });
      } catch (err) {
        throw captureError(`The photo was NOT saved: ${err.message}`, err, { stage: 'original' });
      }
    }
    // 2. A thumbnail, best effort.
    if (!state.thumbTried) {
      state.thumbTried = true;
      try {
        const tb = await thumbFn(photo, 400, 0.8);
        if (tb?.size) state.thumbId = await st.putMedia(tb, { kind: 'thumb', projectId, itemId });
      } catch (err) {
        warn('The photo is saved, but its small preview could not be made.', err);
      }
    }
    // 3. The item that points at the bytes. One quick second try: a busy
    //    database can refuse a transaction now and accept it a moment later.
    const fields = {
      id: itemId,
      type: 'photo',
      levelId,
      createdAt: num(takenAt) ?? Date.now(),
      title: title || '',
      media: { original: state.originalId, thumb: state.thumbId },
      width: width || null,
      height: height || null,
      mimeType: baseMime(photo.type) || 'image/jpeg',
      pose: shot,
      source,
      capturedBy: settings.userName || '',
      ...(poseAtOpen ? { poseAtOpen: snapshotPose(poseAtOpen, levelObj) } : {}),
      ...(captureInfo ? { captureInfo: { ...captureInfo, resized } } : {}),
      ...(extra || {}),
    };
    try {
      state.item = await st.createItem(projectId, fields);
    } catch (err1) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        state.item = await st.createItem(projectId, fields);
      } catch (err) {
        throw captureError(`The photo is stored on the phone but could not be added to the job walk: ${err.message}`, err, { stage: 'item' });
      }
    }
    return state.item;
  }

  try {
    return await run();
  } catch (err) {
    err.retry = run;
    err.blob = photo;
    err.savedOriginal = !!state.originalId;
    err.itemId = itemId;
    throw err;
  }
}

// ---- gallery imports --------------------------------------------------------------------------

/** Local east/north meters, WGS84 radii (docs/RESEARCH.md maps) — used only if geo.js cannot be loaded. */
function fallbackToEnu(origin, lat, lng) {
  const A = 6378137, F = 1 / 298.257223563, E2 = F * (2 - F), D = Math.PI / 180;
  const s = Math.sin(origin.lat * D), w = 1 - E2 * s * s;
  const N = A / Math.sqrt(w), M = A * (1 - E2) / (w * Math.sqrt(w));
  return { e: (lng - origin.lng) * N * Math.cos(origin.lat * D) * D, n: (lat - origin.lat) * M * D };
}

let geoMod = null;
async function geo() {
  if (geoMod) return geoMod;
  try {
    const m = await import('./geo.js');
    if (typeof m.toEnu === 'function') return (geoMod = m);
  } catch { /* not loaded: use the local copy */ }
  return (geoMod = { toEnu: fallbackToEnu });
}

let calMod = null;
async function calibration() {
  if (calMod) return calMod;
  try {
    const m = await import('./calibration.js');
    if (typeof m.enuToPlan === 'function') return (calMod = m);
  } catch { /* fall back to the formula in docs/SPEC.md §6 */ }
  return (calMod = {
    enuToPlan: (cal, { e, n }) => {
      const [a, b, c, d, tx, ty] = cal.toPlan;
      return { x: a * e + b * n + tx, y: c * e + d * n + ty };
    },
    headingToPlan: (cal, h) => normDeg(h + (cal.northAngle || 0)),
  });
}

/**
 * The pose of an imported photo, from its EXIF: GPS → geo (+ east/north
 * when the job walk has an origin, + a plan spot when the level is
 * calibrated). Phone GPS in a gallery photo is of unknown age and accuracy,
 * so the quality is always 'poor'. No GPS → a pose with no position.
 */
export async function poseFromExif(exif, { project = null, level = null, t = Date.now(), declination = null } = {}) {
  const pose = emptyPose(num(exif?.takenAt) ?? t);
  if (!exif || num(exif.lat) == null || num(exif.lng) == null) return pose;
  pose.geo = { lat: exif.lat, lng: exif.lng, acc: num(exif.acc), alt: num(exif.alt), altAcc: null };
  pose.source = 'gps';
  pose.quality = 'poor';
  if (num(exif.heading) != null) {
    if (exif.headingRef === 'M') {
      pose.magHeading = normDeg(exif.heading);
      if (num(declination) != null) {
        pose.heading = normDeg(exif.heading + declination);
        pose.declination = declination;
        pose.headingSource = 'setting';
      }
    } else {
      pose.heading = normDeg(exif.heading);
    }
  }
  const origin = project?.origin;
  if (origin && num(origin.lat) != null && num(origin.lng) != null) {
    const g = await geo();
    const enu = g.toEnu(origin, exif.lat, exif.lng);
    if (enu && num(enu.e) != null && num(enu.n) != null) {
      pose.enu = { e: enu.e, n: enu.n };
      const cal = level?.plan ? level.calibration : null;
      if (cal?.toPlan) {
        const c = await calibration();
        try {
          const p = c.enuToPlan(cal, pose.enu);
          if (p && num(p.x) != null && num(p.y) != null) {
            pose.plan = { x: p.x, y: p.y };
            if (pose.geo.acc != null && num(cal.pxPerMeter)) pose.planAcc = pose.geo.acc * cal.pxPerMeter;
          }
          if (pose.heading != null) {
            const ph = c.headingToPlan ? c.headingToPlan(cal, pose.heading) : pose.heading + (cal.northAngle || 0);
            pose.planHeading = num(ph) == null ? null : normDeg(ph);
          }
        } catch (err) {
          console.warn('[capture] imported photo could not be placed on the plan', err);
        }
      }
    }
  }
  return pose;
}

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic|heif|avif|bmp)$/i;

function isImageFile(f) {
  return (f?.type || '').startsWith('image/') || IMAGE_EXT.test(f?.name || '');
}

/**
 * Import photos from the gallery (or the files app) into a job walk.
 * Each file: EXIF read first (shrinking would drop it), then kept as it is
 * when it is a JPEG/PNG within the photo size setting, otherwise turned into
 * a JPEG of that size. GPS in the EXIF becomes the pose (quality 'poor'),
 * the EXIF time becomes the item's time, source 'import'. Files are done one
 * at a time (phones run out of memory on several big photos at once) and in
 * the order they were taken, so their #numbers follow the walk.
 *
 * Resolves the items that were saved. Files that failed are listed in
 * `result.errors` ([{file, fileName, error}]); when every file fails the
 * promise rejects with the first problem (its `errors` lists them all).
 * opts: {project, level, onProgress({done, total, fileName}), deps}
 */
export async function importPhotos(files, { project, level, onProgress = null, deps = {} } = {}) {
  const list = [...(files || [])].filter(Boolean);
  const settings = getSettings();
  const resizeFn = deps.resizeImage || realResizeImage;
  const metas = [];
  for (const file of list) {
    let exif = null;
    try { exif = await readExif(file); } catch { exif = null; }
    metas.push({ file, exif, t: num(exif?.takenAt) ?? num(file.lastModified) ?? Date.now() });
  }
  metas.sort((a, b) => a.t - b.t);

  const items = [];
  const errors = [];
  for (let i = 0; i < metas.length; i++) {
    const { file, exif, t } = metas[i];
    const fileName = file.name || `photo ${i + 1}`;
    try { onProgress?.({ done: i, total: metas.length, fileName }); } catch { /* progress is cosmetic */ }
    try {
      if (!isImageFile(file)) throw new Error(`"${fileName}" is not a photo.`);
      const type = baseMime(file.type) || (/\.png$/i.test(fileName) ? 'image/png' : /\.jpe?g$/i.test(fileName) ? 'image/jpeg' : '');
      // Picked files are only borrowed (iOS deletes them when the page is
      // torn down): copy the bytes now, one photo at a time.
      let blob = new Blob([await file.arrayBuffer()], { type: type || 'image/jpeg' });
      const header = await readImageHeader(blob).catch(() => null);
      let width = header?.width || null;
      let height = header?.height || null;
      const maxSide = num(settings.photoMaxSize) || Infinity;
      // A JPEG within the size setting is kept byte for byte (its EXIF too).
      // Anything else (PNG screenshots, HEIC, oversize) becomes a JPEG, so
      // every photo in a job walk is a JPEG the viewer and markup can use.
      const keepAsIs = header && type === 'image/jpeg' && Math.max(width, height) <= maxSide;
      if (!keepAsIs) {
        let r;
        try {
          r = await resizeFn(blob, { maxSide, quality: num(settings.photoQuality) ?? 0.92, force: true });
        } catch (err) {
          const heic = /hei[cf]/i.test(type) || /\.hei[cf]$/i.test(fileName);
          throw new Error(heic
            ? `"${fileName}" is a HEIC photo, which this browser cannot open. On iPhone, share it as "Most Compatible" (JPEG), or import it from Safari.`
            : `"${fileName}" could not be opened: ${err.message}`);
        }
        blob = r.blob;
        width = r.width;
        height = r.height;
      }
      const pose = await poseFromExif(exif, { project, level, t, declination: num(settings.declination) });
      const item = await savePhoto({
        project, level, blob, width, height, pose,
        source: 'import', takenAt: t,
        extra: { fileName },
        deps,
      });
      items.push(item);
    } catch (err) {
      console.warn('[capture] import failed:', fileName, err?.message || err);
      errors.push({ file, fileName, error: err });
    }
  }
  try { onProgress?.({ done: metas.length, total: metas.length, fileName: '' }); } catch { /* cosmetic */ }
  items.errors = errors;
  if (!items.length && errors.length) {
    const e = new Error(errors.length === 1 ? errors[0].error.message : `None of the ${errors.length} photos could be imported. ${errors[0].error.message}`);
    e.errors = errors;
    throw e;
  }
  return items;
}

// ---- notes ------------------------------------------------------------------------------------

/**
 * A text note placed where the person is (or where they long-pressed the
 * plan — pass that pose). Resolves the new note item.
 */
export async function saveNote({ project, level, pose = null, text = '', title = '', tags = [], deps = {} } = {}) {
  const st = deps.store || realStore;
  const projectId = typeof project === 'string' ? project : project?.id;
  if (!projectId) throw new Error('saveNote needs the job walk.');
  const levelObj = typeof level === 'object' ? level : null;
  const levelId = typeof level === 'string' ? level : level?.id ?? null;
  return st.createItem(projectId, {
    type: 'note',
    levelId,
    title: String(title || ''),
    text: String(text || ''),
    tags: Array.isArray(tags) ? tags.filter((t) => typeof t === 'string' && t.trim()) : [],
    pose: snapshotPose(pose, levelObj),
    source: 'camera',
    capturedBy: getSettings().userName || '',
  });
}
