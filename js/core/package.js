// package.js — a job walk as one .zip: the backup, the thing you share, and
// what another phone imports.
//
// One format for everything (docs/SPEC.md §12), so a backup is always
// viewable and a shared copy is always importable:
//
//   index.html                the viewer: opens in any browser, offline, from the unzipped folder
//   jobwalk.json              every record (project, items, Recently Deleted items, media index)
//   media/plans/<levelId>.<ext>              floor plans (replaced plans too: <levelId>-old-1.<ext>)
//   media/photos/<seq>-<itemId>.jpg          originals, untouched
//   media/annotated/<seq>-<itemId>.jpg       as shown in the viewer: markup burned in, plus the
//                                            date/position stamp when settings.stampExports
//   media/thumbs/<itemId>.jpg                thumbnails (-markup, -poster variants)
//   media/videos/<seq>-<itemId>.<webm|mp4>
//   media/voice/<voiceId>.<webm|m4a|ogg>
//   media/other/<mediaId>.<ext>              bytes no record points at any more (kept: a backup is complete)
//   media/recordings/<recId>/<seq>.<ext>     pieces of a video the app has not finished saving
//   README.txt
//
// Why it is built this way:
//  - "It is important not to lose any pictures or notes." A backup holds
//    EVERY byte of the job walk on this phone, including Recently Deleted
//    items (jobwalk.json `deletedItems`) and replaced plans, so restoring it
//    on a new phone loses nothing. Only the viewer data leaves those out.
//  - Media is never copied into memory: the zip is assembled from the Blobs
//    IndexedDB already holds (js/core/zip.js). Only the stamped viewer copies
//    are new images, and those are downscaled.
//  - The backup is "covered" up to the project's changeSeq read when the
//    export STARTED, so a photo taken while the zip is being made still
//    counts as not backed up.
//  - Import never overwrites anything. Every id is re-made (so two copies of
//    the same walk can live side by side), every file is written AND verified
//    before the records that point at it, and "replace" moves the old copy
//    to Recently Deleted only after the new one is completely saved.

import * as store from './store.js';
import * as db from './db.js';
import { getSettings } from './settings.js';
import { uid, safeFileName, todayISO, formatAccuracy, formatDateTime, formatBytes, compassPoint, normDeg } from './util.js';
import { APP_VERSION } from '../version.js';
import { createZipWriter, readZip, mimeFromName } from './zip.js';

export const PACKAGE_FORMAT = 'dcr-jobwalk';
export const PACKAGE_SCHEMA = 1;

/**
 * Above about this size the share sheet gets unreliable: WebKit reads every
 * shared file into memory whole before handing it over (docs/RESEARCH.md,
 * "Storage durability"), so a big backup can run the phone out of memory.
 * The export screen puts Download first above it.
 */
export const SHARE_SHEET_COMFORT_BYTES = 512 * 1024 * 1024;

const VIEWER_MAX_SIDE = 2560;       // stamped viewer copies: plenty for a screen or a printed page
const VIEWER_MAX_SIDE_MANY = 1920;  // …and smaller when there are very many photos (phone memory)
const VIEWER_QUALITY = 0.86;
const PLACEHOLDERS = ['<!--VIEWER_CSS-->', '<!--VIEWER_JS-->', '<!--VIEWER_DATA-->'];
const ITEM_TYPES = new Set(['photo', 'video', 'note']);

// ---- small helpers ------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');
const seq3 = (n) => String(Math.max(0, Math.floor(Number(n) || 0))).padStart(3, '0');
const bySeq = (a, b) => (a.seq || 0) - (b.seq || 0) || (a.createdAt || 0) - (b.createdAt || 0);

const EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/heic': 'heic', 'image/heif': 'heif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'webm', 'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'application/pdf': 'pdf',
};
const ROLE_EXT = {
  original: 'jpg', annotated: 'jpg', thumb: 'jpg', annotatedThumb: 'jpg', poster: 'jpg', annotatedOld: 'jpg', annotatedThumbOld: 'jpg',
  plan: 'jpg', planThumb: 'jpg', planOld: 'jpg', planOldThumb: 'jpg', video: 'webm', voice: 'webm', voiceRemoved: 'webm',
};

/** The file extension for a media type ('video/webm;codecs=vp9' → 'webm'), from its name, or by role. */
export function extFor(type, name = '', role = '') {
  const base = String(type || '').split(';')[0].trim().toLowerCase();
  if (EXT[base]) return EXT[base];
  const m = /\.([a-z0-9]{1,5})$/i.exec(String(name || ''));
  if (m) return m[1].toLowerCase();
  return ROLE_EXT[role] || 'bin';
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Cancelled', 'AbortError');
}

function reporter(onProgress) {
  return (phase, message, fraction) => {
    try { onProgress?.({ phase, message, fraction: Math.max(0, Math.min(1, fraction)) }); } catch { /* display only */ }
  };
}

function notOnPhone() {
  const e = new Error('That job walk is not on this phone.');
  e.notFound = true;
  return e;
}

/** How precise a pose is, in meters (GPS accuracy, or the plan accuracy through the calibration). */
export function poseAccuracy(pose, level) {
  if (!pose) return null;
  if (pose.geo && Number.isFinite(pose.geo.acc)) return pose.geo.acc;
  const ppm = level?.calibration?.pxPerMeter;
  if (Number.isFinite(pose.planAcc) && ppm) return pose.planAcc / ppm;
  return null;
}

// ---- what goes into the zip ------------------------------------------------------------------

async function snapshot(projectId) {
  const project = await store.getProject(projectId);
  if (!project) throw notOnPhone();
  const all = await store.listItems(projectId, { includeDeleted: true });
  const records = new Map((await store.listMediaForProject(projectId)).map((r) => [r.id, r]));
  return {
    project,
    live: all.filter((i) => !i.deletedAt).sort(bySeq),
    deleted: all.filter((i) => i.deletedAt).sort(bySeq),
    records,
  };
}

// Videos still in pieces (js/core/recorder.js): the app was closed while
// filming and the video could not be rebuilt yet (rebuilding a long one can
// run a phone out of memory), or pieces were kept after a gap. Those pieces
// are the only copy, so a backup carries them as they are —
// media/recordings/<recId>/<seq>.<ext>, with the recording row in
// jobwalk.json `recordings` — and an import puts them back, for the app to
// rebuild the next time it starts.

const RECORDING_READ_BATCH = 16; // pieces read per transaction (~16 s of video), as recorder.js does

/** The recordings of a job walk whose pieces are not just a saved video waiting to be tidied up. */
async function unsavedRecordings(projectId) {
  const out = [];
  for (const row of await store.listRecordings()) {
    if (!row?.recId || row.projectId !== projectId) continue;
    // Saved as a video item already; the next start only removes the pieces.
    if (row.itemId && !row.recoveredPrefix && (await store.getItem(row.itemId))) continue;
    out.push(row);
  }
  return out;
}

/** A recording's pieces as Blobs, [{seq, blob}] in order — read a few at a time, so a long video is never in memory twice. */
async function recordingPieces(recId) {
  const seqs = await store.getRecordingChunkSeqs(recId);
  const out = [];
  if (typeof IDBKeyRange === 'undefined') {
    for (const b of await store.getRecordingChunks(recId)) if (b.size) out.push({ seq: b.seq, blob: b });
    return out;
  }
  for (let i = 0; i < seqs.length; i += RECORDING_READ_BATCH) {
    const lo = seqs[i];
    const hi = seqs[Math.min(seqs.length, i + RECORDING_READ_BATCH) - 1];
    for (const r of await db.getAll('chunks', IDBKeyRange.bound([recId, lo], [recId, hi]))) {
      const bytes = r.data ?? r.blob;
      if (bytes && (r.size ?? bytes.byteLength ?? bytes.size)) out.push({ seq: r.seq, blob: new Blob([bytes], { type: r.type || '' }) });
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/**
 * Decide the path of every media file (pure — no bytes are read).
 * Returns {files, byMedia, omitted, missing}: files [{id, base, path, role,
 * kind, itemId, levelId, type, size, name, createdAt}], byMedia: Map
 * mediaId → file, omitted: left out on purpose (options), missing:
 * referenced but not on this phone.
 */
export function layoutFiles({ project, live, deleted, records }, { includeVideos = true, includeOriginals = true } = {}) {
  const files = [];
  const byMedia = new Map();
  const seen = new Set();
  const omitted = [];
  const missing = [];

  const take = (id, base, role, { itemId = null, levelId = null } = {}) => {
    if (!id || seen.has(id)) return byMedia.get(id) || null;
    seen.add(id);
    const rec = records.get(id);
    if (!rec) { missing.push({ id, role, itemId, levelId }); return null; }
    const f = {
      id, base, role, path: `${base}.${extFor(rec.type, rec.name, role)}`,
      kind: rec.kind || role, itemId: rec.itemId ?? itemId, levelId,
      type: rec.type || '', size: rec.size ?? rec.blob?.size ?? 0, name: rec.name || '', createdAt: rec.createdAt || null,
    };
    files.push(f);
    byMedia.set(id, f);
    return f;
  };
  const leaveOut = (id, role, reason, itemId = null) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const rec = records.get(id);
    if (!rec) { missing.push({ id, role, itemId }); return; }
    omitted.push({ id, role, reason, itemId, kind: rec.kind || role, size: rec.size ?? 0 });
  };

  for (const l of project.levels || []) {
    if (l.plan) {
      take(l.plan.mediaId, `media/plans/${l.id}`, 'plan', { levelId: l.id });
      take(l.plan.thumbId, `media/plans/${l.id}-thumb`, 'planThumb', { levelId: l.id });
    }
    (l.planHistory || []).forEach((h, n) => {
      take(h?.mediaId, `media/plans/${l.id}-old-${n + 1}`, 'planOld', { levelId: l.id });
      take(h?.thumbId, `media/plans/${l.id}-old-${n + 1}-thumb`, 'planOldThumb', { levelId: l.id });
    });
  }

  for (const it of [...live, ...deleted]) {
    const s = seq3(it.seq);
    const m = it.media || {};
    const o = { itemId: it.id };
    if (it.type === 'video') {
      if (includeVideos) take(m.original, `media/videos/${s}-${it.id}`, 'video', o);
      else leaveOut(m.original, 'video', 'videos-not-included', it.id);
    } else if (m.original) {
      if (!includeOriginals && m.annotated && records.has(m.annotated)) leaveOut(m.original, 'original', 'originals-not-included', it.id);
      else take(m.original, `media/photos/${s}-${it.id}`, 'original', o);
    }
    take(m.annotated, `media/annotated/${s}-${it.id}`, 'annotated', o);
    take(m.thumb, `media/thumbs/${it.id}`, 'thumb', o);
    take(m.annotatedThumb, `media/thumbs/${it.id}-markup`, 'annotatedThumb', o);
    take(m.poster, `media/thumbs/${it.id}-poster`, 'poster', o);
    // Slots a later version may add: kept, so nothing is ever left behind.
    for (const [slot, id] of Object.entries(m)) {
      if (!['original', 'annotated', 'thumb', 'annotatedThumb', 'poster'].includes(slot) && typeof id === 'string') {
        take(id, `media/other/${id}`, slot, o);
      }
    }
    for (const v of it.voiceNotes || []) take(v?.mediaId, `media/voice/${v.id}`, 'voice', o);
    // Removed voice notes and earlier marked-up copies keep their bytes on the
    // phone (js/core/voice.js, js/core/annotations.js), so the backup keeps them too.
    for (const v of it.removedVoiceNotes || []) take(v?.mediaId, `media/voice/${v.id}`, 'voiceRemoved', o);
    (it.annotationHistory || []).forEach((h, n) => {
      take(h?.mediaId, `media/annotated/${s}-${it.id}-old-${n + 1}`, 'annotatedOld', o);
      take(h?.thumbId, `media/thumbs/${it.id}-markup-old-${n + 1}`, 'annotatedThumbOld', o);
    });
  }

  // Bytes nothing points at any more (a removed voice note keeps its bytes
  // until the item is purged; a save interrupted half way). Still the
  // person's, so still in the backup.
  for (const rec of records.values()) {
    if (seen.has(rec.id)) continue;
    if (rec.kind === 'video' && !includeVideos) leaveOut(rec.id, 'other', 'videos-not-included', rec.itemId ?? null);
    else take(rec.id, `media/other/${rec.id}`, 'other', { itemId: rec.itemId ?? null });
  }

  return { files, byMedia, omitted, missing };
}

/**
 * What a backup of this job walk holds, and roughly how big it is — for the
 * export screen, before anything is read.
 * → {counts: {photos, videos, notes, voice, plans, deleted, unsavedVideos},
 *    bytes: {total, videos, withoutVideos, photos}, stamp}
 * unsavedVideos: videos still in pieces (see unsavedRecordings); they count
 * as videos for "Include videos" and the sizes.
 */
export async function estimateExport(projectId) {
  const snap = await snapshot(projectId);
  const { files } = layoutFiles(snap, { includeVideos: true });
  const settings = getSettings();
  let total = 0;
  let videos = 0;
  let photos = 0;
  for (const f of files) {
    total += f.size;
    if (f.role === 'video' || (f.role === 'other' && f.kind === 'video')) videos += f.size;
    if (f.role === 'original' || f.role === 'annotated') photos += f.size;
  }
  // Pieces are not read here: one a second, at the bit rate it was filmed at.
  const recordings = await unsavedRecordings(projectId);
  for (const r of recordings) {
    const n = (await store.getRecordingChunkSeqs(r.recId)).length;
    const bytes = Math.round(n * (Number(r.videoBitsPerSecond) || 6_000_000) / 8);
    total += bytes;
    videos += bytes;
  }
  const livePhotos = snap.live.filter((i) => i.type === 'photo');
  const stamp = !!settings.stampExports;
  // Stamped viewer copies (downscaled JPEGs) are new bytes; about 0.6 MB each.
  const stampBytes = stamp ? livePhotos.length * 600 * 1024 : 0;
  const overhead = 200 * 1024 + (snap.live.length + snap.deleted.length) * 3 * 1024;
  return {
    counts: {
      photos: livePhotos.length,
      videos: snap.live.filter((i) => i.type === 'video').length,
      notes: snap.live.filter((i) => i.type === 'note').length,
      voice: snap.live.reduce((n, i) => n + (i.voiceNotes?.length || 0), 0),
      plans: (snap.project.levels || []).filter((l) => l.plan).length,
      levels: (snap.project.levels || []).length,
      deleted: snap.deleted.length,
      unsavedVideos: recordings.length,
    },
    bytes: {
      total: total + stampBytes + overhead,
      videos,
      withoutVideos: total - videos + stampBytes + overhead,
      photos: photos + stampBytes,
    },
    stamp,
  };
}

// ---- the export stamp -----------------------------------------------------------------------
//
// A dark strip ADDED below the photo (nothing in the picture is covered):
// "#12 · Riverside Lofts · Level 1" over "Nov 2, 2026 10:32 AM · Position
// good ±4 ft · Facing NE 42°". Drawn on a copy; the original is never
// touched.

const STAMP_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** True where images can be decoded and redrawn (browsers; not Node). */
export function canDrawImages() {
  return typeof createImageBitmap === 'function' && (typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined');
}

/** The two lines of text printed on an exported photo. Pure (Node-tested). */
export function stampLines(item, { project, level, units = 'imperial', company = '' } = {}) {
  const pose = item.pose || null;
  const top = [`#${item.seq || '?'}`, project?.name || '', level?.name || ''].filter(Boolean).join(' · ');
  const bits = [formatDateTime(item.createdAt)];
  const acc = poseAccuracy(pose, level);
  if (pose && pose.quality && pose.quality !== 'none') {
    bits.push(`Position ${pose.quality}${acc != null ? ` ${formatAccuracy(acc, units)}` : ''}${pose.planLocked ? ' (placed by hand)' : ''}`);
  } else if (pose?.planLocked) {
    bits.push('Position placed by hand');
  } else {
    bits.push('No position');
  }
  if (pose && Number.isFinite(pose.heading)) bits.push(`Facing ${compassPoint(pose.heading)} ${Math.round(normDeg(pose.heading))}°`);
  return { top, bottom: bits.join(' · '), brand: company ? `${company} · DCR Job Walk` : 'DCR Job Walk' };
}

async function decodeImage(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch { /* some browsers refuse the options or the type; try an <img> */ }
  if (typeof document === 'undefined') throw new Error('This photo could not be opened.');
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** One canvas reused for every photo (a phone has little canvas memory), released at the end. */
function createSurface() {
  let c = null;
  return {
    get(w, h) {
      if (!c) c = typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(w, h);
      c.width = w;
      c.height = h;
      return c;
    },
    release() { if (c) { c.width = 1; c.height = 1; c = null; } },
  };
}

function canvasToJpeg(c, quality) {
  if (typeof c.convertToBlob === 'function') return c.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('The photo could not be saved as a JPEG.'))), 'image/jpeg', quality);
  });
}

function fitText(ctx, text, maxWidth) {
  if (maxWidth <= 0) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) lo = mid; else hi = mid - 1;
  }
  return lo ? `${text.slice(0, lo).trimEnd()}…` : '';
}

/** A JPEG copy of `blob`, at most maxSide px, with the stamp strip below it. Browser only. */
async function stampImage(blob, lines, { maxSide, quality, surface }) {
  const src = await decodeImage(blob);
  try {
    const sw = src.width;
    const sh = src.height;
    if (!sw || !sh) throw new Error('This photo has no size.');
    const k = Math.min(1, maxSide / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * k));
    const h = Math.max(1, Math.round(sh * k));
    const fs = Math.max(13, Math.min(44, Math.round(w * 0.022)));
    const pad = Math.round(fs * 0.6);
    const lineH = Math.round(fs * 1.3);
    const bar = pad * 2 + lineH * 2;
    const accent = Math.max(4, Math.round(fs * 0.35));
    const c = surface.get(w, h + bar);
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0, w, h);
    ctx.fillStyle = '#141b22';
    ctx.fillRect(0, h, w, bar);
    ctx.fillStyle = '#c8371f';
    ctx.fillRect(0, h, accent, bar);
    const x0 = accent + pad;
    const right = w - pad;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.font = `700 ${Math.round(fs * 0.78)}px ${STAMP_FONT}`;
    let brandW = ctx.measureText(lines.brand).width;
    if (brandW > (right - x0) * 0.32) brandW = 0;       // a narrow photo: the facts matter more than the brand
    else {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.fillText(lines.brand, right, h + bar / 2);
    }
    const maxW = right - x0 - (brandW ? brandW + pad * 2 : 0);
    ctx.textAlign = 'left';
    ctx.font = `700 ${fs}px ${STAMP_FONT}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(fitText(ctx, lines.top, maxW), x0, h + pad + lineH / 2);
    ctx.font = `500 ${Math.round(fs * 0.9)}px ${STAMP_FONT}`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.86)';
    ctx.fillText(fitText(ctx, lines.bottom, maxW), x0, h + pad + lineH * 1.5);
    return await canvasToJpeg(c, quality);
  } finally {
    src.close?.();
  }
}

/** Markup burned into a copy of the original, when the item has shapes but no flattened copy (an edit the app closed during). */
async function flattenMarkup(item, originalBlob) {
  if (!canDrawImages() || !originalBlob || !item.annotations?.shapes?.length) return null;
  try {
    const mod = await import('./annotations.js');
    if (typeof mod.flatten !== 'function') return null;
    const s = getSettings();
    const maxSide = Math.max(item.width || 0, item.height || 0) || s.photoMaxSize || 4032;
    return await mod.flatten(originalBlob, item.annotations, { maxSide, quality: s.photoQuality || 0.92 });
  } catch (err) {
    console.warn('[package] markup could not be redrawn', err);
    return null;
  }
}

// ---- the viewer page --------------------------------------------------------------------------

let viewerAssets = null;

/**
 * viewer.html, viewer.css and viewer.js from the app's own files (the
 * service worker precaches them, so this works offline). Node tests read
 * them from disk.
 */
async function loadViewerAssets() {
  if (viewerAssets) return viewerAssets;
  const p = (async () => {
    const urls = ['viewer.html', 'viewer.css', 'viewer.js'].map((n) => new URL(`../../viewer/${n}`, import.meta.url));
    let texts;
    if (urls[0].protocol === 'file:') {
      const fs = await import('node:fs/promises');
      texts = await Promise.all(urls.map((u) => fs.readFile(u, 'utf8')));
    } else {
      texts = await Promise.all(urls.map(async (u) => {
        const res = await fetch(u);
        if (!res.ok) throw new Error(`${u.pathname} answered ${res.status}`);
        return res.text();
      }));
    }
    const [html, css, js] = texts;
    return { html, css, js };
  })();
  viewerAssets = p;
  p.catch(() => { if (viewerAssets === p) viewerAssets = null; });
  return p;
}

/**
 * JSON that is safe inside <script type="application/json">: every "<",
 * ">" and "&" becomes a \u escape (still the same JSON), so a note that
 * says "</script><script>…" cannot end the element and run.
 */
export function jsonForHtml(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * The self-contained viewer page: the template with its CSS, JS and the
 * job walk data put in. One pass over the template, so text inside the
 * inserted parts is never treated as a placeholder.
 */
export function buildViewerHtml({ html, css, js }, data) {
  for (const ph of PLACEHOLDERS) {
    if (html.split(ph).length !== 2) throw new Error(`The viewer template must contain ${ph} exactly once.`);
  }
  const parts = {
    CSS: String(css).replace(/<\/style/gi, '<\\/style'),
    JS: String(js).replace(/<\/script/gi, '<\\/script'),
    DATA: jsonForHtml(data),
  };
  return html.replace(/<!--VIEWER_(CSS|JS|DATA)-->/g, (_, k) => parts[k]);
}

const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const r7 = (v) => (Number.isFinite(v) ? Math.round(v * 1e7) / 1e7 : null);

function compactTrack(track) {
  if (!Array.isArray(track) || !track.length) return null;
  return track.map((p) => ({
    t: Number.isFinite(p?.t) ? Math.round(p.t) : null,
    x: r1(p?.x), y: r1(p?.y), e: r2(p?.e), n: r2(p?.n), lat: r7(p?.lat), lng: r7(p?.lng),
    acc: r1(p?.acc), heading: r1(p?.heading), planHeading: r1(p?.planHeading), pitch: r1(p?.pitch),
  }));
}

/**
 * What the viewer shows: live items only, with relative paths to their
 * files. Pure (Node-tested).
 */
export function buildViewerData({ project, items, pathOf, viewerPath = new Map(), settings = {}, exportedAt = Date.now() }) {
  const levels = [...(project.levels || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return {
    format: 'dcr-jobwalk-viewer',
    schema: PACKAGE_SCHEMA,
    appVersion: APP_VERSION,
    exportedAt,
    exportedBy: settings.userName || '',
    company: settings.company || '',
    units: settings.units === 'metric' ? 'metric' : 'imperial',
    project: {
      name: project.name || '', address: project.address || '', gc: project.gc || '', number: project.number || '',
      walkDate: project.walkDate || '', notes: project.notes || '', origin: project.origin || null,
    },
    levels: levels.map((l) => ({
      id: l.id,
      name: l.name || '',
      plan: l.plan ? { src: pathOf(l.plan.mediaId), width: l.plan.width || null, height: l.plan.height || null } : null,
      calibrated: !!l.calibration,
      northAngle: Number.isFinite(l.calibration?.northAngle) ? l.calibration.northAngle : null,
      pxPerMeter: Number.isFinite(l.calibration?.pxPerMeter) ? l.calibration.pxPerMeter : null,
    })),
    items: items.map((it) => {
      const m = it.media || {};
      const src = {};
      if (it.type === 'video') {
        src.video = pathOf(m.original);
        src.poster = pathOf(m.poster);
        src.thumb = pathOf(m.thumb) || src.poster;
      } else if (it.type === 'photo') {
        src.original = pathOf(m.original);
        src.image = viewerPath.get(it.id) || pathOf(m.annotated) || src.original;
        src.thumb = pathOf(m.annotatedThumb) || pathOf(m.thumb);
      }
      return {
        id: it.id, seq: it.seq, type: it.type, levelId: it.levelId,
        title: it.title || '', text: it.text || '', tags: Array.isArray(it.tags) ? it.tags : [],
        createdAt: it.createdAt || null, updatedAt: it.updatedAt || null, capturedBy: it.capturedBy || '', source: it.source || '',
        width: it.width || null, height: it.height || null, duration: it.duration ?? null, mimeType: it.mimeType || '',
        hasMarkup: !!(m.annotated || it.annotations?.shapes?.length),
        pose: it.pose || null,
        track: compactTrack(it.track),
        src,
        voiceNotes: (it.voiceNotes || []).map((v) => ({
          id: v.id, src: pathOf(v.mediaId), duration: v.duration ?? null, mimeType: v.mimeType || '',
          createdAt: v.createdAt || null, transcript: v.transcript || '',
        })),
      };
    }),
  };
}

function readmeText({ project, settings, exportedAt, counts, complete, omitted, hasViewer, hasRecordings = false }) {
  const lines = [
    `DCR Job Walk — ${project.name || 'Job walk'}`,
    [project.address, project.gc && `GC: ${project.gc}`, project.number && `DCR job # ${project.number}`, project.walkDate && `Walk date: ${project.walkDate}`].filter(Boolean).join(' · '),
    `Exported ${formatDateTime(exportedAt)}${settings.userName ? ` by ${settings.userName}` : ''} with DCR Job Walk ${APP_VERSION}.`,
    `${counts.photos} photos, ${counts.videos} videos, ${counts.notes} notes, ${counts.voice} voice notes, ${counts.plans} floor plans.`,
    '',
  ];
  if (!complete) {
    lines.push('NOTE: this is a shared copy, not a full backup —');
    if (omitted.some((o) => o.reason === 'videos-not-included')) lines.push('  the video files were left out to make it smaller.');
    if (omitted.some((o) => o.reason === 'originals-not-included')) lines.push('  the original photos were left out where a marked-up copy exists.');
    lines.push('');
  }
  lines.push(
    'TO VIEW IT ON A COMPUTER',
    '1. Unzip this file first (Windows: right-click > Extract All. Mac: double-click it).',
    hasViewer
      ? '2. Open index.html in the unzipped folder with any web browser (Chrome, Edge, Safari, Firefox).'
      : '2. (The viewer page could not be added to this copy. Import the .zip into DCR Job Walk to see it.)',
    '   You will see each floor plan with every photo, video and note on it, and can print a report.',
    '   Keep index.html next to the "media" folder: it shows the photos from there.',
    '   On an iPhone or iPad the Files app shows web pages without running them, so use a computer,',
    '   or import the .zip into DCR Job Walk.',
    '',
    'TO VIEW IT ONLINE',
    'Upload the whole unzipped folder to a website that serves plain web pages (for example GitHub',
    'Pages or Netlify) and open index.html there. SharePoint, OneDrive and Google Drive download or',
    'preview web pages instead of running them, so the viewer does not work from there.',
    '',
    'TO OPEN IT IN DCR JOB WALK (another phone or PC)',
    'Home screen > Import a job walk > choose this .zip file. Do not unzip it first.',
    'Nothing on that phone is overwritten: the job walk comes in as its own copy.',
    '',
    'WHAT IS INSIDE',
    'index.html                 the viewer (everything it needs is inside it)',
    'jobwalk.json               all the data: job info, plans, calibration, photos, notes, positions',
    'media/plans/               the floor plans (older replaced plans end in -old-1, -old-2, …)',
    'media/photos/              the original photos, untouched (named number-id)',
    'media/annotated/           the photos as shown in the viewer: markup drawn in,',
    '                           plus the date and position strip when that setting is on',
    'media/thumbs/              small previews',
    'media/videos/              the videos',
    'media/voice/               the voice notes',
    'media/other/               files kept for completeness (for example removed voice notes)',
    ...(hasRecordings ? [
      'media/recordings/          the recorded pieces of a video the app had not finished saving, in order.',
      '                           Import the .zip into DCR Job Walk and it rebuilds the video.',
    ] : []),
    '',
    'Items in Recently Deleted on the phone are in jobwalk.json ("deletedItems") and their files are',
    'in the folders above, so restoring this backup loses nothing. The viewer does not show them.',
  );
  return `${lines.join('\r\n')}\r\n`;
}

// ---- export ----------------------------------------------------------------------------------------

/**
 * The whole job walk as one .zip.
 * → {blob, fileName, changeSeq, size, counts, warnings, complete, missingFiles}
 * complete: false when something was left out on purpose (includeVideos /
 * includeOriginals false) — a shared copy, which should not count as a backup.
 * Videos still in pieces are in it as pieces (manifest `recordings`); files
 * the phone could only partly read are in it as read, listed in `damaged`
 * and named in `warnings`.
 * changeSeq is the project's change count when the export STARTED: pass it
 * to store.markBackedUp once the file has been saved or shared.
 * onProgress({phase: 'prepare'|'stamp'|'zip', message, fraction}).
 */
export async function exportProject(projectId, { includeVideos = true, includeOriginals = true, onProgress, signal } = {}) {
  const report = reporter(onProgress);
  report('prepare', 'Reading the job walk…', 0);
  const snap = await snapshot(projectId);
  const changeSeq = snap.project.changeSeq || 0;
  const { project, live, deleted } = snap;
  const settings = getSettings();
  const exportedAt = Date.now();
  const warnings = [];
  throwIfAborted(signal);

  const layout = layoutFiles(snap, { includeVideos, includeOriginals });
  const { files, byMedia, omitted } = layout;
  const missing = [...layout.missing];
  const damaged = [];

  // Blob handles (not bytes) for every file.
  for (const f of files) {
    const blob = await store.getMediaBlob(f.id);
    if (blob && blob.size) {
      // Shorter (or longer) than when it was saved: a part of it is gone
      // from the phone. What is left still goes in — better than nothing —
      // but it is named, not passed off as whole (the check-sum in the zip
      // would make it import as if it were).
      const want = snap.records.get(f.id)?.size;
      if (Number.isFinite(want) && want > 0 && blob.size !== want) {
        damaged.push({ id: f.id, role: f.role, itemId: f.itemId, levelId: f.levelId, path: f.path, size: blob.size, expectedSize: want });
      }
      f.blob = blob;
      f.size = blob.size;
      if (!f.type) f.type = blob.type || mimeFromName(f.path);
    } else {
      missing.push({ id: f.id, role: f.role, itemId: f.itemId, levelId: f.levelId });
    }
  }
  const present = files.filter((f) => f.blob);

  // Videos still in pieces go in as pieces (left out, like every video, without videos).
  const recordings = [];
  for (const row of await unsavedRecordings(projectId)) {
    throwIfAborted(signal);
    if (!includeVideos) {
      omitted.push({ id: row.recId, role: 'recording', reason: 'videos-not-included', itemId: row.itemId ?? null, kind: 'video', size: 0 });
      continue;
    }
    const pieces = await recordingPieces(row.recId);
    if (!pieces.length) continue;
    recordings.push({
      row,
      chunks: pieces.map(({ seq, blob }) => ({
        seq, path: `media/recordings/${row.recId}/${seq}.${extFor(blob.type || row.mimeType, '', 'video')}`,
        type: blob.type || '', size: blob.size, blob,
      })),
    });
  }
  const fileOf = (id) => {
    const f = id ? byMedia.get(id) : null;
    return f?.blob ? f : null;
  };
  report('prepare', 'Reading the job walk…', 0.03);
  throwIfAborted(signal);

  // Viewer copies of the photos: markup burned in and the stamp added.
  const viewerFiles = [];
  const viewerPath = new Map();
  const livePhotos = live.filter((i) => i.type === 'photo');
  const stamp = !!settings.stampExports && canDrawImages();
  const draw = canDrawImages();
  const stampSpan = stamp && livePhotos.length ? 0.37 : 0;
  let stampFailed = 0;
  if (draw && livePhotos.length) {
    const surface = createSurface();
    const maxSide = livePhotos.length > 300 ? VIEWER_MAX_SIDE_MANY : VIEWER_MAX_SIDE;
    try {
      for (let n = 0; n < livePhotos.length; n++) {
        throwIfAborted(signal);
        const it = livePhotos[n];
        const annotated = fileOf(it.media?.annotated);
        const original = fileOf(it.media?.original);
        let base = annotated?.blob || null;
        let flattened = null;
        if (!base && original) {
          flattened = await flattenMarkup(it, original.blob);
          base = flattened || original.blob;
        }
        if (stamp && base) {
          report('stamp', `Adding the date and position to photo ${n + 1} of ${livePhotos.length}…`, 0.03 + stampSpan * (n / livePhotos.length));
          const level = store.getLevel(project, it.levelId);
          try {
            const stamped = await stampImage(base, stampLines(it, { project, level, units: settings.units, company: settings.company }),
              { maxSide, quality: VIEWER_QUALITY, surface });
            if (annotated) {
              // The viewer copy replaces the annotated file in the zip; import
              // redraws the clean markup from the shapes (importPackage).
              annotated.blob = stamped;
              annotated.size = stamped.size;
              annotated.type = 'image/jpeg';
              annotated.path = `${annotated.base}.jpg`;
              annotated.stamped = true;
              continue;
            }
            const path = `media/annotated/${seq3(it.seq)}-${it.id}.jpg`;
            viewerFiles.push({ itemId: it.id, path, blob: stamped, type: 'image/jpeg', size: stamped.size, stamped: true, markup: !!flattened });
            viewerPath.set(it.id, path);
            continue;
          } catch (err) {
            if (err?.name === 'AbortError') throw err;
            stampFailed++;
            console.warn('[package] stamp failed for', it.id, err);
          }
        }
        if (flattened) {
          const path = `media/annotated/${seq3(it.seq)}-${it.id}.jpg`;
          viewerFiles.push({ itemId: it.id, path, blob: flattened, type: flattened.type || 'image/jpeg', size: flattened.size, stamped: false, markup: true });
          viewerPath.set(it.id, path);
        }
      }
    } finally {
      surface.release();
    }
  }
  if (stampFailed) warnings.push(`${stampFailed} photo${stampFailed > 1 ? 's are' : ' is'} without the date and position strip (the phone could not redraw ${stampFailed > 1 ? 'them' : 'it'}). The photos themselves are all in the backup.`);
  if (missing.length) warnings.push(`${missing.length} file${missing.length > 1 ? 's' : ''} could not be read from this phone and ${missing.length > 1 ? 'are' : 'is'} not in the backup.`);
  if (damaged.length) {
    const itemOf = new Map([...live, ...deleted].map((i) => [i.id, i]));
    const named = damaged.slice(0, 5).map((d) => {
      const it = itemOf.get(d.itemId);
      const what = it ? `#${it.seq} ${it.type || 'item'}` : d.levelId ? `the plan of ${store.getLevel(project, d.levelId)?.name || 'a level'}` : 'a file';
      return `${what}: ${formatBytes(d.size)} of ${formatBytes(d.expectedSize)}`;
    });
    if (damaged.length > named.length) named.push(`and ${damaged.length - named.length} more`);
    warnings.push(`${damaged.length} file${damaged.length > 1 ? 's are' : ' is'} damaged on this phone, so only part of ${damaged.length > 1 ? 'each' : 'it'} could be read (${named.join('; ')}). What could be read is in the backup.`);
  }
  if (recordings.length) {
    const n = recordings.length;
    warnings.push(`${n} video${n > 1 ? 's' : ''} the app had not finished saving ${n > 1 ? 'are' : 'is'} in the backup as ${n > 1 ? 'their' : 'its'} recorded pieces. Importing the backup brings ${n > 1 ? 'them' : 'it'} back.`);
  }

  const pathOf = (id) => fileOf(id)?.path || null;
  const counts = {
    photos: livePhotos.length,
    videos: live.filter((i) => i.type === 'video').length,
    notes: live.filter((i) => i.type === 'note').length,
    voice: live.reduce((n, i) => n + (i.voiceNotes?.length || 0), 0),
    plans: (project.levels || []).filter((l) => l.plan).length,
    deleted: deleted.length,
  };

  // The viewer page. If it cannot be loaded (very rare: the app's own files
  // are cached), the backup is still made — the data matters more than the page.
  let indexHtml = null;
  try {
    const assets = await loadViewerAssets();
    indexHtml = buildViewerHtml(assets, buildViewerData({ project, items: live, pathOf, viewerPath, settings, exportedAt }));
  } catch (err) {
    console.warn('[package] viewer not added', err);
    warnings.push('The viewer page could not be added, so index.html is missing from this copy. The photos, notes and data are all in it and import normally.');
  }
  throwIfAborted(signal);

  // A full backup leaves nothing out on purpose. (Files already missing on
  // this phone are listed in `missing`; no backup could hold them, so they do
  // not stop a backup from counting.)
  const complete = !omitted.length;
  const manifest = {
    format: PACKAGE_FORMAT,
    schema: PACKAGE_SCHEMA,
    exportedAt,
    appVersion: APP_VERSION,
    exportedBy: settings.userName || '',
    company: settings.company || '',
    options: { includeVideos, includeOriginals, stamped: stamp },
    complete,
    project,
    items: live,
    deletedItems: deleted,
    media: present.map((f) => ({
      id: f.id, kind: f.kind, role: f.role, itemId: f.itemId, levelId: f.levelId, path: f.path,
      type: f.type, size: f.size, name: f.name, createdAt: f.createdAt, ...(f.stamped ? { stamped: true } : {}),
    })),
    viewerFiles: viewerFiles.map((v) => ({ itemId: v.itemId, path: v.path, type: v.type, size: v.size, stamped: v.stamped, markup: v.markup })),
    omitted,
    missing,
    damaged,
    recordings: recordings.map(({ row, chunks }) => ({ row, chunks: chunks.map(({ seq, path, type, size }) => ({ seq, path, type, size })) })),
  };

  const zip = createZipWriter();
  for (const f of present) {
    const used = zip.add(f.path, f.blob, { date: f.createdAt || exportedAt });
    if (used !== f.path) throw new Error(`Two files in the backup would have the same name (${f.path}).`);
  }
  for (const r of recordings) {
    for (const c of r.chunks) {
      const used = zip.add(c.path, c.blob, { date: r.row.startedAt || exportedAt });
      if (used !== c.path) throw new Error(`Two files in the backup would have the same name (${c.path}).`);
    }
  }
  for (const v of viewerFiles) zip.add(v.path, v.blob, { date: exportedAt });
  zip.add('README.txt', readmeText({ project, settings, exportedAt, counts, complete, omitted, hasViewer: !!indexHtml, hasRecordings: recordings.length > 0 }), { date: exportedAt, compress: true });
  if (indexHtml) zip.add('index.html', indexHtml, { date: exportedAt, compress: true });
  zip.add('jobwalk.json', JSON.stringify(manifest), { date: exportedAt, compress: true });

  const zipFrom = 0.03 + stampSpan;
  const blob = await zip.finish({
    signal,
    onProgress: (p) => report('zip', `Packing the backup… ${formatBytes(p.done)} of ${formatBytes(p.total)}`, zipFrom + (1 - zipFrom) * p.fraction),
  });
  report('zip', 'Backup ready', 1);
  const fileName = `${safeFileName(`DCR Job Walk - ${safeFileName(project.name, 'Job walk')} - ${todayISO()}`, 'DCR Job Walk')}.zip`;
  return { blob, fileName, changeSeq, size: blob.size, counts, warnings, complete, missingFiles: missing.length };
}

// ---- photos only ------------------------------------------------------------------------------

/** A spreadsheet cell: quoted when needed, and text that a spreadsheet would run as a formula is defused. */
export function csvCell(v) {
  if (v == null) return '';
  let s;
  if (typeof v === 'number') s = Number.isFinite(v) ? String(v) : '';
  else {
    s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  }
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows (arrays) → CSV text with Windows line endings (RFC 4180). */
export function toCsv(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** "012 - Level 1 - Walls - 2026-11-02 10.32.jpg" (local time). */
export function photoFileName(item, levelName, ext = 'jpg') {
  const d = new Date(item.createdAt || Date.now());
  const when = `${todayISO(d)} ${pad2(d.getHours())}.${pad2(d.getMinutes())}`;
  const parts = [seq3(item.seq), levelName, item.tags?.[0], when].map((p) => safeFileName(p ?? '', '')).filter(Boolean);
  return `${safeFileName(parts.join(' - '), seq3(item.seq))}.${ext}`;
}

/**
 * The photos as plain JPEGs in one flat .zip, plus photos.csv.
 * annotated: markup burned in (and the stamp when settings.stampExports);
 * false: the untouched originals.
 * → {blob, fileName, count, warnings}
 */
export async function exportPhotos(projectId, { annotated = true, onProgress, signal } = {}) {
  const report = reporter(onProgress);
  report('prepare', 'Reading the photos…', 0);
  const snap = await snapshot(projectId);
  const { project } = snap;
  const photos = snap.live.filter((i) => i.type === 'photo');
  if (!photos.length) throw new Error('There are no photos in this job walk yet.');
  const settings = getSettings();
  const units = settings.units === 'metric' ? 'metric' : 'imperial';
  const stamp = annotated && !!settings.stampExports && canDrawImages();
  const zip = createZipWriter();
  const warnings = [];
  let skipped = 0;
  let stampFailed = 0;
  const rows = [[
    'seq', 'file', 'level', 'date', 'time', 'lat', 'lng', units === 'metric' ? 'accuracy (m)' : 'accuracy (ft)',
    'heading', 'tilt', 'tags', 'title', 'notes',
  ]];
  const surface = stamp ? createSurface() : null;
  // Stamped photos are new JPEGs held in memory until the zip is written, so
  // a big walk gets slightly smaller (still print quality) copies.
  const capSide = photos.length > 150 ? VIEWER_MAX_SIDE : 4032;
  const span = 0.6;
  try {
    for (let n = 0; n < photos.length; n++) {
      throwIfAborted(signal);
      const it = photos[n];
      report('stamp', `Preparing photo ${n + 1} of ${photos.length}…`, span * (n / photos.length));
      const level = store.getLevel(project, it.levelId);
      const originalBlob = await store.getMediaBlob(it.media?.original);
      let blob = null;
      if (annotated) blob = (await store.getMediaBlob(it.media?.annotated)) || (await flattenMarkup(it, originalBlob)) || originalBlob;
      else blob = originalBlob;
      if (!blob?.size) { skipped++; continue; }
      if (stamp) {
        try {
          blob = await stampImage(blob, stampLines(it, { project, level, units, company: settings.company }),
            { maxSide: Math.min(capSide, Math.max(it.width || 0, it.height || 0, 1600)), quality: settings.photoQuality || 0.92, surface });
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
          stampFailed++;
        }
      }
      const name = zip.add(photoFileName(it, level?.name || '', extFor(blob.type, '', 'original')), blob, { date: it.createdAt || Date.now() });
      const d = new Date(it.createdAt || Date.now());
      const pose = it.pose || {};
      const acc = poseAccuracy(pose, level);
      rows.push([
        it.seq, name, level?.name || '', todayISO(d), `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
        r7(pose.geo?.lat), r7(pose.geo?.lng),
        acc == null ? null : Math.round((units === 'metric' ? acc : acc / 0.3048) * 10) / 10,
        Number.isFinite(pose.heading) ? Math.round(normDeg(pose.heading)) : null,
        Number.isFinite(pose.pitch) ? Math.round(pose.pitch) : null,
        (it.tags || []).join('; '), it.title || '', it.text || '',
      ]);
    }
  } finally {
    surface?.release();
  }
  if (skipped) warnings.push(`${skipped} photo${skipped > 1 ? 's' : ''} could not be read from this phone and ${skipped > 1 ? 'are' : 'is'} not in the file.`);
  if (stampFailed) warnings.push(`${stampFailed} photo${stampFailed > 1 ? 's are' : ' is'} without the date and position strip.`);
  // A byte-order mark so Excel reads the notes as UTF-8.
  zip.add('photos.csv', `\uFEFF${toCsv(rows)}`, { compress: true });
  const blob = await zip.finish({
    signal,
    onProgress: (p) => report('zip', `Packing the photos… ${formatBytes(p.done)} of ${formatBytes(p.total)}`, span + (1 - span) * p.fraction),
  });
  report('zip', 'Photos ready', 1);
  const fileName = `${safeFileName(`DCR Job Walk - ${safeFileName(project.name, 'Job walk')} - photos - ${todayISO()}`, 'DCR Job Walk photos')}.zip`;
  return { blob, fileName, count: rows.length - 1, warnings };
}

// ---- import ---------------------------------------------------------------------------------------

function packageError(message) {
  const e = new Error(message);
  e.name = 'PackageError';
  return e;
}

/** Open a .zip and find and check its jobwalk.json. → {zip, prefix, data} */
async function openPackage(file) {
  if (!file || typeof file.slice !== 'function') throw packageError('Choose the .zip file that DCR Job Walk made.');
  let zip;
  try {
    zip = await readZip(file);
  } catch (err) {
    if (err?.name === 'ZipError') {
      throw packageError(`This is not a DCR Job Walk file, or it was only partly copied. Choose the .zip that DCR Job Walk made (do not unzip it). (${err.message})`);
    }
    throw err;
  }
  // The data may sit in a folder when someone unzipped the backup and zipped it again.
  const candidates = zip.entries
    .filter((e) => !e.isDirectory && /(^|\/)jobwalk\.json$/i.test(e.name) && !/(^|\/)__MACOSX\//.test(e.name))
    .sort((a, b) => a.name.split('/').length - b.name.split('/').length);
  const manifestEntry = candidates[0];
  if (!manifestEntry) {
    if (zip.entries.some((e) => /(^|\/)photos\.csv$/i.test(e.name))) {
      throw packageError('This is a "Photos only" .zip: it has the pictures but not the job walk data, so it cannot be imported. Use the backup .zip (Back up & share) instead.');
    }
    throw packageError('This .zip is not a DCR Job Walk export (there is no jobwalk.json inside).');
  }
  const prefix = manifestEntry.name.slice(0, manifestEntry.name.length - 'jobwalk.json'.length);
  let data;
  try {
    data = await manifestEntry.json({ verify: true });
  } catch {
    throw packageError('The job walk data inside this file is damaged, so it cannot be imported. Try another copy of the backup.');
  }
  if (!data || data.format !== PACKAGE_FORMAT) throw packageError('This .zip is not a DCR Job Walk export.');
  if (!Number.isInteger(data.schema) || data.schema > PACKAGE_SCHEMA) {
    throw packageError(`This file was made by a newer DCR Job Walk (${data.appVersion || 'unknown version'}). Update the app on this phone (close it and open it again with a connection), then import it again.`);
  }
  const p = data.project;
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !Array.isArray(p.levels) || !Array.isArray(data.items)) {
    throw packageError('The job walk data inside this file is incomplete, so it cannot be imported.');
  }
  if (!Array.isArray(data.deletedItems)) data.deletedItems = [];
  if (!Array.isArray(data.media)) data.media = [];
  return { zip, prefix, data };
}

const lineage = (p) => p?.importedFrom?.originId || p?.id;

/**
 * The job walk on this phone that a package is a copy of: the same id, or
 * imported from the same original (a walk that went phone → PC → phone).
 * A live one wins over one in Recently Deleted (that is the one "replace"
 * would mean), then the same id, then the most recently changed.
 */
async function findExisting(src) {
  const all = [...await store.listProjects(), ...await store.listDeletedProjects()];
  const lin = lineage(src);
  const related = all.filter((p) => p.id === src.id || lineage(p) === lin);
  related.sort((a, b) => (!!a.deletedAt - !!b.deletedAt) || ((b.id === src.id) - (a.id === src.id)) || (b.updatedAt || 0) - (a.updatedAt || 0));
  return related[0] || null;
}

function countsOf(data) {
  const items = data.items || [];
  return {
    photos: items.filter((i) => i.type === 'photo').length,
    videos: items.filter((i) => i.type === 'video').length,
    notes: items.filter((i) => i.type === 'note').length,
    voice: items.reduce((n, i) => n + (Array.isArray(i.voiceNotes) ? i.voiceNotes.length : 0), 0),
    plans: (data.project.levels || []).filter((l) => l?.plan).length,
    levels: (data.project.levels || []).length,
    deleted: (data.deletedItems || []).length,
  };
}

/**
 * Look inside a package before importing it.
 * → {project, counts: {photos, videos, notes, voice, plans, levels, deleted},
 *    exists, existing: {id, name, deleted, updatedAt, changeSeq, sameId} | null,
 *    appVersion, exportedAt, exportedBy, sizeBytes, complete, missingFiles}
 * `exists`: a copy of this job walk is already on this phone (same id, or
 * imported from the same original) — the import screen then offers
 * "Import as a copy" or "Replace the one on this phone". `existing` is that
 * copy (its id may differ from project.id); compare existing.changeSeq with
 * project.changeSeq to warn that the phone has newer changes.
 */
export async function inspectPackage(file) {
  const { zip, prefix, data } = await openPackage(file);
  const existing = await findExisting(data.project);
  const missingFiles = data.media.filter((m) => !zip.entry(prefix + m.path)).length;
  return {
    project: data.project,
    counts: countsOf(data),
    exists: !!existing,
    existing: existing ? {
      id: existing.id, name: existing.name, deleted: !!existing.deletedAt, updatedAt: existing.updatedAt || null,
      changeSeq: existing.changeSeq || 0, sameId: existing.id === data.project.id,
    } : null,
    appVersion: data.appVersion || '',
    exportedAt: data.exportedAt || null,
    exportedBy: data.exportedBy || '',
    sizeBytes: file.size,
    complete: data.complete !== false && !missingFiles,
    missingFiles,
  };
}

/**
 * A copy of a record with every old id swapped for its new one, wherever it
 * appears: media slots, voice notes, removed voice notes, earlier markup,
 * plan history — and any field a later version adds. Ids are random and
 * unique, so a string equal to an old id IS that id. lookup(string) → the
 * new id, null (a file that did not come through), or undefined (not an id:
 * kept as it is). Pure (Node-tested).
 */
export function remapIds(value, lookup) {
  if (typeof value === 'string') {
    const r = lookup(value);
    return r === undefined ? value : r;
  }
  if (Array.isArray(value)) return value.map((v) => remapIds(v, lookup));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = remapIds(v, lookup);
    return out;
  }
  return value;
}

/** Every media id the records point at, in the places the app keeps them. */
function mediaRefsOf(project, items) {
  const refs = new Set();
  const add = (id) => { if (typeof id === 'string' && id) refs.add(id); };
  for (const l of project.levels || []) {
    add(l?.plan?.mediaId); add(l?.plan?.thumbId);
    for (const h of l?.planHistory || []) { add(h?.mediaId); add(h?.thumbId); }
  }
  for (const i of items) {
    for (const id of Object.values(i.media || {})) add(id);
    for (const v of [...(i.voiceNotes || []), ...(i.removedVoiceNotes || [])]) add(v?.mediaId);
    for (const h of i.annotationHistory || []) { add(h?.mediaId); add(h?.thumbId); }
  }
  return refs;
}

/**
 * Bring a package into this phone as a new job walk. → the new project id.
 * mode 'copy': alongside anything already here ("(copy)" is added to the
 *   name when this job walk is already on the phone).
 * mode 'replace': the same, then the job walk it replaces goes to Recently
 *   Deleted (restorable) — only after the new one is completely saved.
 * Every id is new; every file is saved and verified (store.putMediaWithId)
 * before the records are written in one transaction. A file that is damaged
 * inside the .zip is left out like a missing one (what points at it becomes
 * empty, importedFrom.damagedFiles counts it), so one bad video cannot keep
 * every photo and note out; that copy then does not start as backed up.
 * Videos still in pieces come back as pieces, rebuilt at the next start.
 * onProgress({phase: 'read'|'media'|'save', message, fraction}).
 */
export async function importPackage(file, options = {}) {
  // The whole import holds the 'jw-import' lock. Its files are saved long
  // before the job walk record that owns them, and the app starting in
  // another tab meanwhile would otherwise take them for what an import the
  // phone killed left behind, and delete them (store.recoverOrphans).
  return store.withImportLock(() => importUnlocked(file, options));
}

/** A ZipError for bytes that are wrong — not for a zip this app cannot unpack at all. */
const isDamage = (err) => err?.name === 'ZipError' && err.code === 'damaged';

async function importUnlocked(file, { mode = 'copy', onProgress, signal } = {}) {
  if (mode !== 'copy' && mode !== 'replace') throw new TypeError("importPackage mode must be 'copy' or 'replace'");
  const report = reporter(onProgress);
  report('read', 'Opening the file…', 0);
  const { zip, prefix, data } = await openPackage(file);
  throwIfAborted(signal);
  const src = data.project;
  const existing = await findExisting(src);
  const settings = getSettings();
  const now = Date.now();

  // New ids for everything, decided up front, so files can be tied to their
  // new items as they are saved. Media ids join as each file is saved.
  const srcItems = [...data.items.map((i) => ({ i, deleted: false })), ...data.deletedItems.map((i) => ({ i, deleted: true }))]
    .filter(({ i }) => i && typeof i === 'object' && typeof i.id === 'string');
  const srcLevels = (src.levels || []).filter((l) => l && typeof l === 'object' && typeof l.id === 'string');
  const ids = new Map();
  const pid = uid('p_');
  ids.set(src.id, pid);
  for (const l of srcLevels) if (!ids.has(l.id)) ids.set(l.id, uid('l_'));
  for (const { i } of srcItems) {
    if (!ids.has(i.id)) ids.set(i.id, uid('i_'));
    for (const v of [...(Array.isArray(i.voiceNotes) ? i.voiceNotes : []), ...(Array.isArray(i.removedVoiceNotes) ? i.removedVoiceNotes : [])]) {
      if (v && typeof v.id === 'string' && !ids.has(v.id)) ids.set(v.id, uid('v_'));
    }
  }
  const itemIds = new Set(srcItems.map(({ i }) => i.id));
  const levelIds = new Set(srcLevels.map((l) => l.id));
  // Files the records point at that are not in this package: those references become null.
  const goneMedia = mediaRefsOf(src, srcItems.map(({ i }) => i));
  for (const o of [...(data.omitted || []), ...(data.missing || [])]) if (o?.id) goneMedia.add(o.id);

  // There is no "room for it?" check up front: estimate().quota is not free
  // space (Chrome reports usage + 10 GiB whatever the disk holds —
  // docs/RESEARCH.md), so it would refuse big backups a PC has room for. The
  // phone refusing a write (QuotaExceededError) is the real answer; it stops
  // the import below, with nothing of it left behind.
  const mediaList = data.media.filter((m) => m && typeof m.path === 'string' && typeof m.id === 'string');
  const recList = (Array.isArray(data.recordings) ? data.recordings : [])
    .filter((r) => r?.row && typeof r.row === 'object' && typeof r.row.recId === 'string' && Array.isArray(r.chunks));
  const totalBytes = mediaList.reduce((n, m) => n + (Number(m.size) || 0), 0) +
    recList.reduce((n, r) => n + r.chunks.reduce((k, c) => k + (Number(c?.size) || 0), 0), 0);

  // ---- 1. every file, saved and verified -------------------------------------------------------
  const written = [];      // new media ids, removed again if the import does not finish
  const recordings = [];   // {recId, src, kept, saved}: pieces saved; their rows are written last
  const missing = [];
  const damaged = [];      // damaged inside the .zip: left out like the missing ones
  const srcItemById = new Map(srcItems.map(({ i }) => [i.id, i]));
  const mediaByOldId = new Map(mediaList.map((m) => [m.id, m]));
  let recordsWritten = false;
  let done = 0;
  const step = (extra = 0) => report('media', `Saving photos and files… ${formatBytes(done + extra)} of ${formatBytes(totalBytes)}`,
    0.02 + 0.93 * (totalBytes ? (done + extra) / totalBytes : 1));
  // A damaged file is skipped, its bytes still counted as done, so the bar keeps going.
  const skipDamaged = (what, size, err) => {
    console.warn('[package] a damaged file in the .zip was left out', what.path, err);
    damaged.push(what);
    done += Number(size) || 0;
    step();
  };

  try {
    for (const m of mediaList) {
      throwIfAborted(signal);
      const entry = zip.entry(prefix + m.path);
      if (!entry) { missing.push(m); continue; }
      const type = m.type || mimeFromName(m.path);
      let blob;
      try {
        blob = await entry.blob({ verify: true, type, signal, onProgress: (n) => step(n) });
      } catch (err) {
        if (!isDamage(err)) throw err;
        skipDamaged(m, m.size, err);
        continue;
      }
      // The viewer copy of a marked-up photo carries the export stamp. Redraw
      // the clean markup from the shapes and the original, so the stamp does
      // not become part of the photo here (and is not stamped twice later).
      if (m.stamped) {
        const item = srcItemById.get(m.itemId);
        const origMeta = mediaByOldId.get(item?.media?.original);
        const origEntry = origMeta ? zip.entry(prefix + origMeta.path) : null;
        if (item && origEntry) {
          // A damaged original keeps the stamped copy: better than no markup at all.
          let orig = null;
          try { orig = await origEntry.blob({ verify: true, type: origMeta.type || 'image/jpeg', signal }); } catch (err) { if (!isDamage(err)) throw err; }
          const clean = orig ? await flattenMarkup(item, orig) : null;
          if (clean?.size) blob = clean;
        }
      }
      if (!blob.size) { missing.push(m); continue; }
      const id = uid('m_');
      const itemId = m.itemId && itemIds.has(m.itemId) ? ids.get(m.itemId) : null;
      await store.putMediaWithId(id, blob, { kind: m.kind || m.role || 'other', projectId: pid, itemId, name: m.name || '' });
      written.push(id);
      ids.set(m.id, id);
      done += Number(m.size) || blob.size;
      step();
    }
    for (const m of [...missing, ...damaged]) goneMedia.add(m.id);

    // Videos still in pieces: the pieces now, under a new recording id; the
    // recording row only once the job walk exists (the app starting in
    // another tab removes the pieces of a recording whose job walk is gone).
    for (const r of recList) {
      const rec = { recId: uid('r_'), src: r.row, kept: 0, saved: false };
      recordings.push(rec);
      for (const c of r.chunks) {
        throwIfAborted(signal);
        const entry = c && typeof c.path === 'string' && Number.isInteger(c.seq) ? zip.entry(prefix + c.path) : null;
        if (!entry) { missing.push({ path: c?.path || '' }); continue; }
        let blob;
        try {
          blob = await entry.blob({ verify: true, type: c.type || mimeFromName(c.path), signal, onProgress: (n) => step(n) });
        } catch (err) {
          if (!isDamage(err)) throw err;
          skipDamaged({ path: c.path }, c.size, err);
          continue;
        }
        if (!blob.size) continue;
        await store.putChunk(rec.recId, c.seq, blob);
        rec.kept++;
        done += Number(c.size) || blob.size;
        step();
      }
    }

    // ---- 2. the records, pointing only at files that are really here -------------------------
    report('save', 'Saving the job walk…', 0.96);
    const lookup = (s) => (ids.has(s) ? ids.get(s) : goneMedia.has(s) ? null : undefined);

    const levels = srcLevels.map((l, n) => {
      const out = remapIds(l, lookup);
      out.order = Number.isFinite(l.order) ? l.order : n;
      out.planHistory = Array.isArray(out.planHistory) ? out.planHistory.filter(Boolean) : [];
      out.calibrationHistory = Array.isArray(out.calibrationHistory) ? out.calibrationHistory : [];
      // A plan whose image did not come through is kept in the history (with its calibration), not shown.
      if (out.plan && !out.plan.mediaId) {
        out.planHistory.push({ ...out.plan, calibration: out.calibration ?? null, replacedAt: now });
        out.plan = null;
        out.calibration = null;
      }
      return out;
    });
    if (!levels.length) levels.push(store.newLevel('Level 1', 0));
    const firstLevel = levels[0].id;

    const items = srcItems.map(({ i }) => {
      const out = remapIds(i, lookup);
      out.projectId = pid;
      out.levelId = levelIds.has(i.levelId) ? ids.get(i.levelId) : firstLevel;
      out.type = ITEM_TYPES.has(i.type) ? i.type : 'note';
      out.media = {
        original: null, thumb: null, annotated: null, annotatedThumb: null, poster: null,
        ...(out.media && typeof out.media === 'object' ? out.media : {}),
      };
      out.tags = Array.isArray(out.tags) ? out.tags : [];
      out.voiceNotes = Array.isArray(out.voiceNotes) ? out.voiceNotes.filter(Boolean) : [];
      // A shared copy made without originals: the marked-up photo becomes this
      // phone's photo (its markup is in the pixels, so the shapes are dropped
      // rather than drawn a second time).
      const media = out.media;
      if (out.type === 'photo' && !media.original && media.annotated) {
        out.media = { ...media, original: media.annotated, thumb: media.annotatedThumb || media.thumb, annotated: null, annotatedThumb: null };
        out.annotations = null;
      }
      return out;
    });

    const name = String(src.name || 'Job walk');
    const project = {
      ...remapIds(src, lookup),
      id: pid,
      schema: store.SCHEMA,
      name: mode === 'copy' && existing ? `${name} (copy)` : name,
      levels,
      activeLevelId: levelIds.has(src.activeLevelId) ? ids.get(src.activeLevelId) : firstLevel,
      deletedAt: null,
      updatedAt: now,
      nextSeq: items.reduce((n, i) => Math.max(n, (Number(i.seq) || 0) + 1), Number(src.nextSeq) || 1),
      changeSeq: Number(src.changeSeq) || 1,
      importedFrom: {
        originId: lineage(src), sourceId: src.id, fileName: file.name || '', exportedAt: data.exportedAt || null,
        exportedBy: data.exportedBy || '', appVersion: data.appVersion || '', importedAt: now, importedBy: settings.userName || '',
        missingFiles: missing.length,
        damagedFiles: damaged.length,
      },
    };
    // The file it came from holds everything that is now here, so this copy
    // starts "backed up" — unless files in it were damaged: then that file
    // is not one to rely on, and a fresh backup of this copy is.
    project.backup = damaged.length ? null : { lastAt: data.exportedAt || now, changeSeq: project.changeSeq, fileName: file.name || '' };

    // Every file saved above must still be here. Where the browser has no
    // Web Locks, the app starting in another window can take them for
    // leftovers; the import then stops, rather than bring in a job walk
    // with holes in it.
    const here = new Set((await store.listMediaForProject(pid)).map((r) => r.id));
    if (written.some((id) => !here.has(id))) {
      throw packageError('Some of the files saved for this import were removed meanwhile (was DCR Job Walk opened in another window?), so nothing was imported. Close the other windows of DCR Job Walk, then import again.');
    }

    throwIfAborted(signal);
    await store.putProjectRecords(project, items);
    written.length = 0; // the records own the files now
    recordsWritten = true;

    for (const rec of recordings) {
      if (!rec.kept) continue;
      const row = remapIds(rec.src, lookup);
      try {
        await store.beginRecording({
          ...row,
          recId: rec.recId,
          projectId: pid,
          levelId: levelIds.has(rec.src.levelId) ? ids.get(rec.src.levelId) : firstLevel,
          // Built afresh on this phone: no item or file of the other phone's.
          // (recoveryTries is kept: a video that crashed the app while being
          // rebuilt waits for "Try again" here too, instead of being tried at
          // the next start.)
          itemId: rec.src.itemId && ids.has(rec.src.itemId) ? ids.get(rec.src.itemId) : null,
          mediaId: rec.src.mediaId && ids.has(rec.src.mediaId) ? ids.get(rec.src.mediaId) : null,
        });
        rec.saved = true;
      } catch (err) {
        throw packageError(`The job walk was imported, but a video it had not finished saving could not be put back on this phone (${err.message || err}). It is still in the .zip file.`);
      }
    }

    if (mode === 'replace' && existing && !existing.deletedAt) {
      report('save', 'Moving the old copy to Recently Deleted…', 0.99);
      await store.softDeleteProject(existing.id);
    }
    report('save', 'Imported', 1);
    return pid;
  } catch (err) {
    // Nothing points at the files saved so far (the records were never
    // written), so they would only fill the phone. They are copies of what
    // is still in the .zip, so removing them loses nothing. The same goes
    // for the pieces of a video whose recording row was not written.
    for (const id of written) {
      try { await store.deleteMedia(id); } catch { /* best effort */ }
    }
    for (const rec of recordings) {
      if (!rec.saved) { try { await store.endRecording(rec.recId); } catch { /* best effort */ } }
    }
    if (!recordsWritten && err?.name === 'QuotaExceededError') {
      const e = packageError(`There is not enough room on this phone for this job walk (it needs about ${formatBytes(totalBytes)}), so nothing was imported. Free some space, or remove old job walks after backing them up, then try again.`);
      e.cause = err;
      throw e;
    }
    if (err?.name === 'ZipError') {
      throw packageError(err.code === 'damaged'
        ? `This backup file is damaged, so nothing was imported. ${err.message} Try another copy of the backup.`
        : `${err.message} Nothing was imported.`);
    }
    throw err;
  }
}
