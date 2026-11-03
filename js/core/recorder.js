// recorder.js — videos (with the path walked, drawn on the plan) and voice notes.
//
// A video is the one thing that can be half-made when the phone dies, the
// app is swiped away, or iOS reloads the page for memory. So it is written
// to the phone WHILE it records (write-ahead), and only tidied up after the
// finished video is safely saved:
//
//  1. A recording row is written BEFORE the recorder starts
//     (store.beginRecording), with where the video started.
//  2. MediaRecorder.start(1000) hands over a piece every second; each piece
//     goes straight to store.putChunk, one write at a time, in order. A piece
//     the phone refuses is kept in memory and the person is told at once.
//  3. The path (5 samples a second) is added to the row every 2 seconds.
//  4. Stopping joins the pieces FROM THE STORE in order, saves the video
//     with store.putMedia (which reads it back), makes a poster and a
//     thumbnail, creates the item — and only then store.endRecording drops
//     the pieces. The item id and the saved video id are written on the row
//     first, so a crash at any step never makes two items or loses the video.
//  5. The next launch runs recoverRecordings(): anything left behind becomes
//     a video item marked 'recovered', with its saved path.
//
// iOS stops the camera when the app is hidden (it would record black), so
// a video is finished and saved on visibilitychange→hidden, pagehide, and
// when the camera track ends or stays muted.
//
// The duration stored is the one measured here: MediaRecorder files often
// carry none (WebM: Infinity, fragmented MP4: 0) — docs/RESEARCH.md "camera".
//
// Everything that varies is injectable through `deps` (MediaRecorder class,
// clocks, timers, the store, videoInfo/makeThumb), so tests/recorder.test.mjs
// runs the whole flow in Node on a fake IndexedDB.

import * as realStore from './store.js';
import * as db from './db.js';
import { Emitter } from './bus.js';
import { uid } from './util.js';
import { getSettings } from './settings.js';
import {
  pickVideoMime, pickAudioMime, baseMime, extForMime, withTimeout,
  videoInfo as realVideoInfo, makeThumb as realMakeThumb,
} from './media.js';
import { snapshotPose, emptyPose } from './capture.js';

export const TIMESLICE_MS = 1000;   // a piece on disk every second
export const SAMPLE_MS = 200;       // path samples: 5 a second
export const FLUSH_MS = 2000;       // the path is on disk at most 2 s behind
/** Video bit rates by settings.videoQuality (Chrome defaults to 2.5 Mbps, WebKit to 10 — set it ourselves). */
export const VIDEO_BITRATES = Object.freeze({ high: 6_000_000, standard: 3_000_000 });
/** Camera size to ask for while filming, landscape numbers (iOS records sideways otherwise — WebKit bug 323550). */
export const VIDEO_SIZES = Object.freeze({ high: { width: 1920, height: 1080 }, standard: { width: 1280, height: 720 } });
const AUDIO_BITRATE = 128_000;
const LOCK_PREFIX = 'jw-rec:';

/** Recordings this page is making right now: recovery must never touch them. */
const activeRecIds = new Set();

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const round = (v, d) => (num(v) == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- pure helpers (tested) ----------------------------------------------------------------------

/**
 * One path sample from a Pose, `t` ms after the video started:
 * {t, e, n, x, y, lat, lng, acc, heading, planHeading, pitch} (docs/SPEC.md
 * TrackPoint), any field null. Rounded to what the sensors can resolve
 * (mm, 0.1 px, ~1 cm in lat/lng, 0.1°) to keep long videos' paths small.
 */
export function trackPoint(pose, t) {
  const p = pose || {};
  return {
    t: Math.max(0, Math.round(num(t) ?? 0)),
    e: round(p.enu?.e, 3),
    n: round(p.enu?.n, 3),
    x: round(p.plan?.x, 1),
    y: round(p.plan?.y, 1),
    lat: round(p.geo?.lat, 7),
    lng: round(p.geo?.lng, 7),
    acc: round(p.geo?.acc, 2),
    heading: round(p.heading, 1),
    planHeading: round(p.planHeading, 1),
    pitch: round(p.pitch, 1),
  };
}

/**
 * Which pieces of a recording can be joined: the run 0, 1, 2, … with no gap.
 * → {count, total, complete, missingFirst}. Pieces after a gap cannot be
 * played (they depend on what is missing) and are kept, not joined.
 */
export function contiguousPrefix(seqs) {
  const sorted = [...new Set((seqs || []).filter((s) => Number.isInteger(s) && s >= 0))].sort((a, b) => a - b);
  let count = 0;
  while (count < sorted.length && sorted[count] === count) count++;
  return {
    count,
    total: sorted.length,
    complete: sorted.length > 0 && count === sorted.length,
    missingFirst: sorted.length > 0 && sorted[0] !== 0,
  };
}

/** A start pose rebuilt from the first path sample (for recordings saved before startPose existed). */
function poseFromTrack(row) {
  const pt = Array.isArray(row?.track) ? row.track[0] : null;
  const pose = emptyPose(row?.startedAt || Date.now());
  if (!pt) return pose;
  if (num(pt.lat) != null && num(pt.lng) != null) pose.geo = { lat: pt.lat, lng: pt.lng, acc: num(pt.acc), alt: null, altAcc: null };
  if (num(pt.e) != null && num(pt.n) != null) pose.enu = { e: pt.e, n: pt.n };
  if (num(pt.x) != null && num(pt.y) != null) pose.plan = { x: pt.x, y: pt.y };
  pose.heading = num(pt.heading);
  pose.planHeading = num(pt.planHeading);
  pose.pitch = num(pt.pitch);
  if (pose.geo || pose.plan) { pose.source = 'fused'; pose.quality = 'poor'; }
  return pose;
}

function videoName(t) {
  const d = new Date(t || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `Video ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

// ---- store access ----------------------------------------------------------------------------

const READ_BATCH = 16; // pieces read per transaction (~16 s of video)

/** The numbers of a recording's pieces on disk, in order (keys only — cheap). */
async function chunkSeqs(st, recId) {
  if (typeof st.getRecordingChunkSeqs === 'function') return st.getRecordingChunkSeqs(recId);
  return (await st.getRecordingChunks(recId)).map((b) => b.seq);
}

/**
 * A recording's pieces WITH their numbers ([{seq, blob}], in order), read
 * from disk. Read a few at a time and turned into Blobs as they come, so a
 * long video never sits in memory twice over (store.getRecordingChunks
 * reads every piece at once). `only` limits it to those numbers.
 */
async function loadChunks(st, recId, only = null) {
  const seqs = only || (await chunkSeqs(st, recId));
  const out = [];
  if (typeof IDBKeyRange === 'undefined' || st.getRecordingChunkRange) {
    const blobs = st.getRecordingChunkRange ? await st.getRecordingChunkRange(recId, seqs[0], seqs[seqs.length - 1]) : await st.getRecordingChunks(recId);
    const want = new Set(seqs);
    for (const b of blobs) if (want.has(b.seq) && b.size) out.push({ seq: b.seq, blob: b });
    return out.sort((a, b) => a.seq - b.seq);
  }
  for (let i = 0; i < seqs.length; i += READ_BATCH) {
    const lo = seqs[i];
    const hi = seqs[Math.min(seqs.length, i + READ_BATCH) - 1];
    const rows = await db.getAll('chunks', IDBKeyRange.bound([recId, lo], [recId, hi]));
    for (const r of rows.sort((a, b) => a.seq - b.seq)) {
      const bytes = r.data ?? r.blob;
      if (!bytes || !(r.size ?? bytes.byteLength ?? bytes.size)) continue;
      out.push({ seq: r.seq, blob: new Blob([bytes], { type: r.type || '' }) });
    }
  }
  return out;
}

/**
 * Turn joined pieces into a saved video item. Shared by stop() and
 * recoverRecordings(). Each step is written down on the row before the
 * next, so running it again after a crash continues instead of repeating.
 */
async function buildVideoItem(st, row, chunks, { track, durationMs, fallbackMs, pose, source, title, vInfo, thumbFn }) {
  let itemId = row.itemId;
  if (!itemId) {
    itemId = uid('i_');
    await st.updateRecording(row.recId, { itemId });
    row.itemId = itemId;
  }
  const existing = await st.getItem(itemId);
  if (existing) return existing;

  const type = baseMime(row.mimeType) || baseMime(chunks[0]?.blob?.type) || 'video/webm';
  let mediaId = null;
  let blob = null;
  if (row.mediaId) {
    try {
      if (await st.getMediaRecord(row.mediaId)) {
        mediaId = row.mediaId;
        blob = await st.getMediaBlob(mediaId);
      }
    } catch { mediaId = null; }
  }
  let duration = num(durationMs) != null ? durationMs / 1000 : null;
  if (!mediaId || !blob) {
    blob = new Blob(chunks.map((c) => c.blob), { type });
    // The facts go WITH the bytes, so store.recoverOrphans() can rebuild the
    // item if the app dies before it is created.
    const meta = {
      levelId: row.levelId ?? null, createdAt: row.startedAt || Date.now(),
      width: row.width || null, height: row.height || null,
      duration: duration ?? (num(fallbackMs) ? fallbackMs / 1000 : null),
      pose: pose || null, track: Array.isArray(track) ? track : [], capturedBy: row.capturedBy || '', source,
    };
    mediaId = await st.putMedia(blob, {
      kind: 'video', projectId: row.projectId, itemId,
      name: `${videoName(row.startedAt)}.${extForMime(type, 'webm')}`, meta,
    });
    row.mediaId = mediaId;
    try { await st.updateRecording(row.recId, { mediaId }); } catch (err) { console.warn('[recorder] could not note the saved video on its row', err); }
  }

  // Poster and thumbnail: nice to have. A video without them still plays.
  let info = null;
  try { info = await withTimeout(vInfo(blob), 25000, 'Reading the video took too long.'); } catch (err) { console.warn('[recorder] video facts', err); }
  let posterId = null;
  let thumbId = null;
  if (info?.posterBlob?.size) {
    try { posterId = await st.putMedia(info.posterBlob, { kind: 'poster', projectId: row.projectId, itemId }); } catch (err) { console.warn('[recorder] poster not saved', err); }
    try {
      const tb = await thumbFn(info.posterBlob, 400, 0.8);
      if (tb?.size) thumbId = await st.putMedia(tb, { kind: 'thumb', projectId: row.projectId, itemId });
    } catch (err) { console.warn('[recorder] thumbnail not saved', err); }
  }

  if (duration == null && num(info?.duration) != null && info.duration > 0) duration = info.duration;
  if (duration == null && num(fallbackMs) != null && fallbackMs > 0) duration = fallbackMs / 1000;

  return st.createItem(row.projectId, {
    id: itemId,
    type: 'video',
    levelId: row.levelId ?? null,
    createdAt: row.startedAt || Date.now(),
    title: title || '',
    media: { original: mediaId, poster: posterId, thumb: thumbId },
    width: info?.width || row.width || null,
    height: info?.height || row.height || null,
    duration,
    mimeType: row.mimeType || type,
    pose: pose || emptyPose(row.startedAt),
    track: Array.isArray(track) ? track : [],
    source,
    capturedBy: row.capturedBy || '',
  });
}

// ---- video -----------------------------------------------------------------------------------

/**
 * createVideoRecorder({stream, project, level, getPose, quality, size, mimeType,
 * videoBitsPerSecond, deps}) → {
 *   start() → Promise                     the row is on disk and recording has begun
 *   stop() → Promise<item>                finish and save (also runs by itself on interruptions)
 *   cancel({discard}) → Promise           discard: true (the person confirmed) keeps nothing; otherwise = stop()
 *   elapsedMs(), track, state, recId, mimeType, startPose
 *   on('state'|'sample'|'error'|'interrupted'|'saved', fn) → off()
 *   dispose()                             let go of a video whose save failed (it stays on disk for recovery)
 * }
 * 'error' gives {fatal, message, error, retry?, blob?}: fatal false while
 * recording (a piece could not be written — still kept in memory), fatal
 * true when the finished video could not be saved (retry() and blob let the
 * person keep it). stop() rejects with the same error.
 */
export function createVideoRecorder({ stream, project, level, getPose, quality = 'high', size = null, mimeType = null, videoBitsPerSecond = null, deps = {} } = {}) {
  const st = deps.store || realStore;
  const MR = deps.MediaRecorder || globalThis.MediaRecorder;
  const now = deps.now || (() => (globalThis.performance?.now ? globalThis.performance.now() : Date.now()));
  const setI = deps.setInterval || ((fn, ms) => setInterval(fn, ms));
  const clearI = deps.clearInterval || ((id) => clearInterval(id));
  const doc = 'document' in deps ? deps.document : (typeof document !== 'undefined' ? document : null);
  const win = 'window' in deps ? deps.window : (typeof window !== 'undefined' ? window : null);
  const locks = 'locks' in deps ? deps.locks : (globalThis.navigator?.locks || null);
  const vInfo = deps.videoInfo || realVideoInfo;
  const thumbFn = deps.makeThumb || realMakeThumb;
  const poseFn = typeof getPose === 'function' ? getPose : () => null;

  const em = new Emitter();
  const recId = uid('r_');
  const projectId = project?.id || (typeof project === 'string' ? project : null);
  const levelId = level?.id ?? null;

  let state = 'idle';            // idle → starting → recording → stopping → saving → saved | failed | empty | discarded
  let rec = null;
  let row = null;
  let chosenMime = '';
  let usedMime = '';
  let t0 = null;
  let tEnd = null;
  let measuredMs = null;
  let nextSeq = 0;
  let closed = false;            // after the recorder stopped: late pieces are not expected
  const track = [];
  let flushedUpTo = 0;
  let flushing = null;
  let writes = Promise.resolve();
  const unsaved = new Map();     // seq → Blob: pieces not (yet) on disk
  let savedChunks = 0;
  let failedWrites = 0;
  let failStreak = 0;
  let sampleTimer = null;
  let flushTimer = null;
  let mrStopped = null;
  let resolveMrStopped = () => {};
  let startPromise = null;
  let finishPromise = null;
  let startPose = null;
  let lock = null;
  let detachers = [];
  const muteTimers = new Set();

  const setState = (s) => { state = s; em.emit('state', s); };
  const safePose = () => { try { return poseFn(); } catch { return null; } };

  function holdLock() {
    // A Web Lock tells other tabs (and their recovery at launch) that this
    // recording is alive. It is let go automatically if the page dies.
    if (!locks?.request) return;
    let release = null;
    let wanted = true;
    lock = { release: () => { wanted = false; release?.(); } };
    locks.request(LOCK_PREFIX + recId, () => new Promise((res) => { release = res; if (!wanted) res(); }))
      .catch(() => { /* no lock: recovery falls back to activeRecIds */ });
  }

  function letGo() {
    activeRecIds.delete(recId);
    lock?.release();
    lock = null;
  }

  function makeRecorder(mime, bps) {
    const base = { videoBitsPerSecond: bps, audioBitsPerSecond: AUDIO_BITRATE };
    const tries = mime ? [{ ...base, mimeType: mime }, base, {}] : [base, {}];
    let last = null;
    for (const o of tries) {
      try { return new MR(stream, o); } catch (err) { last = err; }
    }
    throw last || new Error('MediaRecorder could not be created');
  }

  // -- pieces --

  /** The type the recorder really writes: read when it starts and again at the first piece (docs/RESEARCH.md). */
  function noteMime() {
    const m = rec?.mimeType || '';
    if (!m || m === usedMime) return;
    usedMime = m;
    if (row) {
      row.mimeType = m;
      st.updateRecording(recId, { mimeType: m }).catch(() => { /* the pieces carry their own type too */ });
    }
  }

  function onData(e) {
    const blob = e?.data;
    if (!blob || !blob.size) return;
    if (closed && state === 'saved') {
      // Only a broken recorder sends data after it said it stopped and the
      // video was already saved; there is nothing left to add it to.
      console.warn('[recorder] a piece arrived after the video was saved');
      return;
    }
    if (nextSeq === 0) noteMime();
    const seq = nextSeq++;
    unsaved.set(seq, blob); // in memory until it is on disk
    writes = writes.then(() => writeChunk(seq, blob));
  }

  async function writeChunk(seq, blob) {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await st.putChunk(recId, seq, blob);
        unsaved.delete(seq);
        savedChunks++;
        failStreak = 0;
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) await pause(150 * (attempt + 1));
      }
    }
    failedWrites++;
    failStreak++;
    if (failedWrites === 1 || failedWrites % 10 === 0) {
      em.emit('error', {
        fatal: false,
        message: `Part of this video could not be saved to the phone (${lastErr?.message || 'storage problem'}). It is kept in memory — stop the video soon so it can be saved.`,
        error: lastErr,
      });
    }
    if (failStreak >= 3 && state === 'recording') {
      em.emit('error', { fatal: false, message: 'The phone stopped accepting the video (is the storage full?). Recording was stopped so what was filmed can be kept.', error: lastErr });
      stop({ reason: 'storage' });
    }
  }

  async function drainWrites() {
    let w;
    do { w = writes; await w; } while (w !== writes);
  }

  async function retryUnsaved() {
    for (const seq of [...unsaved.keys()].sort((a, b) => a - b)) {
      try {
        await st.putChunk(recId, seq, unsaved.get(seq));
        unsaved.delete(seq);
        savedChunks++;
      } catch { /* still in memory; it goes into the video from there */ }
    }
  }

  // -- path --

  function sample() {
    if (t0 == null) return;
    const pt = trackPoint(safePose(), now() - t0);
    track.push(pt);
    em.emit('sample', pt);
  }

  async function flush(extra = null) {
    while (flushing) {
      try { await flushing; } catch { /* reported below */ }
      if (!extra) return;
    }
    const upTo = track.length;
    const points = track.slice(flushedUpTo, upTo);
    if (!points.length && !extra) return;
    const count = savedChunks;
    flushing = st.updateRecording(recId, (cur) => {
      if (!cur) return undefined;
      cur.track = Array.isArray(cur.track) ? cur.track : [];
      for (const p of points) cur.track.push(p);
      cur.chunkCount = count;
      cur.aliveAt = Date.now();
      if (extra) Object.assign(cur, extra);
      return cur;
    }).then(() => { flushedUpTo = Math.max(flushedUpTo, upTo); }, (err) => {
      console.warn('[recorder] the path could not be saved this time; it will be tried again', err);
    }).finally(() => { flushing = null; });
    return flushing;
  }

  // -- interruptions --

  function listen(target, type, fn) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, fn);
    detachers.push(() => target.removeEventListener(type, fn));
  }

  function attachInterruptions() {
    listen(doc, 'visibilitychange', () => {
      if (doc.visibilityState === 'hidden' || doc.hidden === true) interrupt('hidden');
    });
    listen(win, 'pagehide', () => interrupt('pagehide'));
    for (const t of stream?.getTracks?.() || []) {
      listen(t, 'ended', () => interrupt('track-ended'));
      // A short mute can be a hiccup; one that lasts means iOS took the
      // camera or the microphone away (a call, Siri, the app hidden).
      listen(t, 'mute', () => {
        const timer = setTimeout(() => { muteTimers.delete(timer); if (t.muted !== false) interrupt('track-muted'); }, 1000);
        muteTimers.add(timer);
      });
    }
  }

  function detachAll() {
    for (const d of detachers) { try { d(); } catch { /* gone */ } }
    detachers = [];
    for (const t of muteTimers) clearTimeout(t);
    muteTimers.clear();
  }

  function clearTimers() {
    if (sampleTimer != null) clearI(sampleTimer);
    if (flushTimer != null) clearI(flushTimer);
    sampleTimer = flushTimer = null;
  }

  function interrupt(reason) {
    if (state !== 'recording') return;
    em.emit('interrupted', { reason });
    stop({ reason });
  }

  // -- recorder events --

  function onMrStop() {
    if (tEnd == null) tEnd = now();
    resolveMrStopped();
    // The browser stopped by itself (camera gone, encoder error): finish and save.
    if (state === 'recording') stop({ reason: 'recorder-stopped' });
  }

  function onMrError(e) {
    const err = e?.error || e;
    console.error('[recorder] MediaRecorder error', err);
    em.emit('error', { fatal: false, message: `The recorder reported a problem (${err?.message || err?.name || 'unknown'}). The video so far is being saved.`, error: err });
    if (state === 'recording') stop({ reason: 'recorder-error' });
  }

  // -- start --

  async function doStart() {
    if (!MR) throw new Error('This browser cannot record video. Use "Use phone camera" to film with the phone\'s own camera.');
    const tracks = stream?.getTracks?.() || [];
    if (!tracks.some((t) => t.kind === 'video' && t.readyState !== 'ended')) {
      throw new Error('The camera is not on yet. Wait for the picture, then try again.');
    }
    if (!projectId) throw new Error('The video needs a job walk to belong to.');
    setState('starting');
    chosenMime = mimeType ?? pickVideoMime(MR);
    const bps = videoBitsPerSecond ?? VIDEO_BITRATES[quality] ?? VIDEO_BITRATES.high;
    startPose = snapshotPose(safePose(), level);
    const startedAt = Date.now();
    // 1. The row first: a recording that dies in its first second is still
    //    found at the next launch.
    try {
      row = await st.beginRecording({
        recId, projectId, levelId, mimeType: chosenMime, startedAt, quality,
        videoBitsPerSecond: bps, startPose,
        width: num(size?.width), height: num(size?.height),
        capturedBy: getSettings().userName || '',
        state: 'recording', aliveAt: startedAt, track: [], chunkCount: 0,
      });
    } catch (err) {
      setState('idle');
      throw new Error(`The video could not start: the phone would not save it (${err.message}).`);
    }
    activeRecIds.add(recId);
    holdLock();
    // 2. The recorder.
    try {
      rec = makeRecorder(chosenMime, bps);
      rec.ondataavailable = onData;
      rec.onstop = onMrStop;
      rec.onerror = onMrError;
      rec.onstart = noteMime;
      mrStopped = new Promise((res) => { resolveMrStopped = res; });
      t0 = now();
      rec.start(TIMESLICE_MS);
    } catch (err) {
      rec = null;
      t0 = null;
      try { await st.endRecording(recId); } catch { /* an empty row is dropped at the next launch */ }
      letGo();
      setState('idle');
      throw new Error(`This phone could not start recording video (${err?.message || err?.name || 'unknown problem'}). Try again, or use "Use phone camera".`);
    }
    usedMime = rec.mimeType || chosenMime || '';
    if (usedMime && usedMime !== row.mimeType) {
      row.mimeType = usedMime;
      st.updateRecording(recId, { mimeType: usedMime }).catch(() => { /* the joined Blob's own type covers it */ });
    }
    setState('recording');
    sample();
    sampleTimer = setI(sample, SAMPLE_MS);
    flushTimer = setI(() => { flush(); }, FLUSH_MS);
    attachInterruptions();
  }

  function start() {
    if (!startPromise) startPromise = doStart();
    return startPromise;
  }

  // -- stop and save --

  async function finish(reason) {
    // Everything up to rec.stop() runs synchronously, so a 'hidden' event
    // gets the recorder stopped before the page is frozen.
    setState('stopping');
    clearTimers();
    detachAll();
    sample();
    if (rec && rec.state !== 'inactive') {
      try { if (rec.state === 'recording') rec.requestData(); } catch { /* optional */ }
      try { rec.stop(); } catch { /* already stopping */ }
    }
    try {
      await withTimeout(mrStopped, 6000);
    } catch {
      console.warn('[recorder] the recorder never said it stopped; saving what is on the phone');
    }
    closed = true;
    if (tEnd == null) tEnd = now();
    measuredMs = Math.max(0, Math.round(tEnd - t0));
    await drainWrites();
    await retryUnsaved();
    await flush({ durationMs: measuredMs, stoppedAt: Date.now(), state: 'stopped', stopReason: reason, mimeType: usedMime || chosenMime });
    return saveNow();
  }

  async function saveNow() {
    setState('saving');
    let chunks = [];
    try {
      // From the STORE, in order — what is on disk is what is saved. Pieces
      // the phone would not store are filled in from memory.
      const rows = await loadChunks(st, recId);
      const bySeq = new Map(rows.map((c) => [c.seq, c]));
      for (const [seq, blob] of unsaved) if (!bySeq.has(seq)) bySeq.set(seq, { seq, blob });
      chunks = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
      if (!chunks.length) {
        try { await st.endRecording(recId); } catch { /* dropped at the next launch */ }
        letGo();
        setState('empty');
        const e = new Error('Nothing was recorded — the camera sent no video. Try again.');
        e.code = 'empty';
        throw e;
      }
      const { count } = contiguousPrefix(chunks.map((c) => c.seq));
      if (!count) throw new Error('The start of the video is missing, so it cannot be played. Its pieces are kept on the phone.');
      const usable = chunks.slice(0, count);
      const complete = count === chunks.length;
      const item = await buildVideoItem(st, row, usable, {
        track, durationMs: complete ? measuredMs : null, fallbackMs: count * TIMESLICE_MS,
        pose: startPose, source: 'camera', title: '', vInfo, thumbFn,
      });
      if (complete) {
        try { await st.endRecording(recId); } catch (err) { console.warn('[recorder] saved; the pieces will be tidied up at the next launch', err); }
      } else {
        try {
          await st.updateRecording(recId, { recoveredPrefix: { itemId: item.id, upToSeq: usable[usable.length - 1].seq, keptChunks: chunks.length - count, at: Date.now() } });
        } catch { /* recovery sees the item and leaves it */ }
        console.warn(`[recorder] ${chunks.length - count} piece(s) after a gap were kept on the phone`);
      }
      unsaved.clear();
      letGo();
      setState('saved');
      return item;
    } catch (err) {
      if (state === 'empty') throw err;
      setState('failed');
      err.recId = recId;
      err.blob = chunks.length ? new Blob(chunks.map((c) => c.blob), { type: baseMime(usedMime || chosenMime) || 'video/webm' }) : null;
      err.retry = () => saveNow().then((item) => { em.emit('saved', item); return item; });
      throw err;
    }
  }

  function stop({ reason = 'user' } = {}) {
    if (!finishPromise && !startPromise) return Promise.reject(new Error('The video has not started.'));
    if (!finishPromise) {
      finishPromise = (async () => {
        if (state === 'starting') await startPromise;
        if (state !== 'recording') throw new Error('The video is not recording.');
        return finish(reason);
      })();
      finishPromise.then(
        (item) => em.emit('saved', item),
        (err) => {
          if (state === 'failed' || state === 'empty') {
            em.emit('error', { fatal: true, message: err.message, error: err, retry: err.retry || null, blob: err.blob || null });
          }
        });
    }
    return finishPromise;
  }

  async function cancel({ discard = false } = {}) {
    if (!discard) return stop({ reason: 'cancel' });
    if (finishPromise) return finishPromise; // already saving: keep it
    if (state === 'starting') {
      try { await startPromise; } catch { return undefined; }
    }
    if (state !== 'recording') return undefined;
    setState('stopping');
    clearTimers();
    detachAll();
    try { rec.stop(); } catch { /* already stopped */ }
    try { await withTimeout(mrStopped, 3000); } catch { /* carry on */ }
    closed = true;
    await drainWrites();
    await st.endRecording(recId);
    unsaved.clear();
    letGo();
    setState('discarded');
    return undefined;
  }

  function dispose() {
    if (state === 'recording' || state === 'starting') { stop({ reason: 'dispose' }); return; }
    clearTimers();
    detachAll();
    if (state === 'failed') letGo(); // its pieces stay on disk; the next launch rebuilds it
  }

  function elapsedMs() {
    if (t0 == null) return 0;
    if (tEnd != null) return Math.max(0, tEnd - t0);
    return Math.max(0, now() - t0);
  }

  // The handle the camera keeps. `catch` on the internal promise only marks
  // it handled; callers of stop() still see a rejection.
  return {
    recId,
    start,
    stop: (o) => { const p = stop(o); p.catch(() => {}); return p; },
    cancel,
    dispose,
    elapsedMs,
    on: (type, fn) => em.on(type, fn),
    off: (type, fn) => em.off(type, fn),
    get track() { return track; },
    get state() { return state; },
    get mimeType() { return usedMime || chosenMime; },
    get startPose() { return startPose; },
    get unsavedChunks() { return unsaved.size; },
  };
}

// ---- recovery ---------------------------------------------------------------------------------
//
// Rebuilding a long video needs memory. If the phone kills the app while it
// does (iOS does that under memory pressure), the next launch would try the
// same video again and be killed again — the app could never open. So each
// try is counted on the row BEFORE the heavy work, and taken back when the
// try ends in an ordinary error. Only tries that never came back (a crash)
// stay counted; after MAX_RECOVERY_TRIES the video is left for
// recoverRecordings({force: true}) — its pieces are never deleted.

export const MAX_RECOVERY_TRIES = 3;

async function recoverOne(st, row, vInfo, thumbFn, force) {
  // Already saved (the app closed between saving and tidying up): tidy up.
  if (row.itemId) {
    const it = await st.getItem(row.itemId);
    if (it) {
      if (!row.recoveredPrefix) await st.endRecording(row.recId);
      return { item: null };
    }
  }
  // Its playable part is already a video; the pieces after the gap are kept.
  if (row.recoveredPrefix) return { item: null };
  if (row.projectId && !(await st.getProject(row.projectId))) {
    // The job walk was erased for good (Recently Deleted → Delete forever);
    // its unfinished video goes with it.
    console.warn('[recorder] removing an unfinished video of a job walk that was erased', row.recId);
    await st.endRecording(row.recId);
    return { item: null };
  }
  const seqs = await chunkSeqs(st, row.recId);
  if (!seqs.length) {
    await st.endRecording(row.recId); // nothing was ever recorded
    return { item: null };
  }
  const { count, total } = contiguousPrefix(seqs);
  if (!count) {
    console.warn(`[recorder] recording ${row.recId}: its first piece is missing, so it cannot be played; its ${total} piece(s) are kept`);
    return { item: null };
  }
  const tries = num(row.recoveryTries) || 0;
  if (tries >= MAX_RECOVERY_TRIES && !force) {
    console.warn(`[recorder] recording ${row.recId} stopped the app ${tries} times while being rebuilt; it is kept and skipped at launch`);
    return { item: null, skipped: true };
  }
  await st.updateRecording(row.recId, { recoveryTries: tries + 1, lastRecoveryAt: Date.now() });
  try {
    const loaded = await loadChunks(st, row.recId, seqs.slice(0, count));
    const usable = loaded.slice(0, contiguousPrefix(loaded.map((c) => c.seq)).count);
    if (!usable.length) throw new Error('The saved pieces of this video could not be read.');
    const complete = usable.length === total;
    const track = Array.isArray(row.track) ? row.track : [];
    const lastT = track.length ? num(track[track.length - 1].t) : null;
    const item = await buildVideoItem(st, row, usable, {
      track,
      durationMs: complete ? num(row.durationMs) : null,
      fallbackMs: complete && lastT ? lastT : usable.length * TIMESLICE_MS,
      pose: row.startPose ? snapshotPose(row.startPose) : poseFromTrack(row),
      source: 'recovered',
      title: 'Recovered video',
      vInfo,
      thumbFn,
    });
    if (complete) {
      await st.endRecording(row.recId);
    } else {
      await st.updateRecording(row.recId, {
        recoveredPrefix: { itemId: item.id, upToSeq: usable[usable.length - 1].seq, keptChunks: total - usable.length, at: Date.now() },
      });
      console.warn(`[recorder] recovered the first ${usable.length} of ${total} pieces of ${row.recId}; the ${total - usable.length} after the gap are kept on the phone`);
    }
    return { item };
  } catch (err) {
    // An ordinary failure (storage full, say) is not a crash: take the try back.
    try { await st.updateRecording(row.recId, { recoveryTries: tries }); } catch { /* counted; harmless */ }
    throw err;
  }
}

async function recoverAll(st, locks, vInfo, thumbFn, force) {
  const rows = await st.listRecordings();
  const items = [];
  const errors = [];
  let skipped = 0;
  if (!rows?.length) return Object.assign(items, { errors, skipped });
  const held = new Set();
  if (locks?.query) {
    try {
      const q = await locks.query();
      for (const l of q?.held || []) if (l.name?.startsWith(LOCK_PREFIX)) held.add(l.name.slice(LOCK_PREFIX.length));
    } catch { /* no lock list: activeRecIds still protects this page */ }
  }
  for (const row of [...rows].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))) {
    if (!row?.recId || activeRecIds.has(row.recId) || held.has(row.recId)) continue;
    // Without Web Locks another tab may still be filming: leave fresh ones for the next launch.
    if (!locks && row.state === 'recording' && Date.now() - (row.aliveAt || 0) < 6000) continue;
    try {
      const r = await recoverOne(st, row, vInfo, thumbFn, force);
      if (r.item) items.push(r.item);
      if (r.skipped) skipped++;
    } catch (err) {
      console.error('[recorder] could not rebuild a video yet; its pieces are kept', row.recId, err);
      errors.push(err);
    }
  }
  if (errors.length && !items.length) {
    const e = new Error(errors[0].message);
    e.errors = errors;
    throw e;
  }
  return Object.assign(items, { errors, skipped });
}

/**
 * Rebuild every video left behind by an app that was closed while filming
 * (main.js calls this at launch). A run of pieces from the first one with no
 * gap becomes a video item: source 'recovered', title 'Recovered video', its
 * saved path and start position. Pieces after a gap are kept on the phone.
 * A recording with no pieces is removed. Recordings another tab is still
 * making are left alone (Web Locks). A video that crashed the app
 * MAX_RECOVERY_TRIES times while being rebuilt is skipped (counted in
 * `skipped`) unless {force: true}.
 * Resolves the recovered items, with `errors` (videos that could not be
 * rebuilt yet — their pieces are kept) and `skipped`; rejects only when
 * nothing could be rebuilt and something failed.
 */
export async function recoverRecordings({ force = false, deps = {} } = {}) {
  const st = deps.store || realStore;
  const locks = 'locks' in deps ? deps.locks : (globalThis.navigator?.locks || null);
  const vInfo = deps.videoInfo || realVideoInfo;
  const thumbFn = deps.makeThumb || realMakeThumb;
  const job = () => recoverAll(st, locks, vInfo, thumbFn, force);
  if (locks?.request) {
    let out = Object.assign([], { errors: [], skipped: 0 });
    // One tab at a time: two tabs launching together must not both rebuild the same video.
    await locks.request('jw-recovery', { ifAvailable: true }, async (l) => { if (l) out = await job(); });
    return out;
  }
  return job();
}

// ---- voice notes -----------------------------------------------------------------------------

/** A plain-English microphone error that keeps the browser's error name (callers may switch on it). */
function micError(err) {
  const name = err?.name || '';
  let message;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    message = 'The microphone is blocked for this site. iPhone: Settings → Safari → Microphone → Allow (or aA → Website Settings). Android: tap the lock by the address → Permissions → Microphone.';
  } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    message = 'No microphone was found on this device.';
  } else if (name === 'NotReadableError' || name === 'AbortError') {
    message = 'The microphone is in use by another app (a call?). Close it and try again.';
  } else if (name === 'NotSupportedError') {
    message = 'This browser cannot record sound.';
  } else {
    message = `The microphone did not start (${err?.message || name || 'unknown problem'}).`;
  }
  const e = new Error(message);
  if (name) e.name = name;
  e.cause = err;
  return e;
}

/**
 * createAudioRecorder() → {start(stream?), stop() → Promise<{blob, duration, mimeType}>,
 * cancel(), level() (0..1, for a meter), elapsedMs(), state}.
 * Voice notes are short, so the pieces stay in memory; the microphone is
 * let go as soon as it stops. Call start() from a tap (iOS only lets sound
 * start from one).
 */
export function createAudioRecorder({ deps = {} } = {}) {
  const MR = deps.MediaRecorder || globalThis.MediaRecorder;
  const now = deps.now || (() => (globalThis.performance?.now ? globalThis.performance.now() : Date.now()));
  const AC = 'AudioContext' in deps ? deps.AudioContext : (globalThis.AudioContext || globalThis.webkitAudioContext || null);
  const gum = deps.getUserMedia || ((c) => {
    if (!globalThis.navigator?.mediaDevices?.getUserMedia) {
      const e = new Error('no microphone API');
      e.name = 'NotSupportedError';
      return Promise.reject(e);
    }
    return globalThis.navigator.mediaDevices.getUserMedia(c);
  });

  let state = 'idle';
  let stream = null;
  let ownStream = false;
  let rec = null;
  let chunks = [];
  let mime = '';
  let t0 = null;
  let tEnd = null;
  let stopped = null;
  let resolveStopped = () => {};
  let ctx = null;
  let analyser = null;
  let nodes = [];
  let buf = null;

  function release() {
    for (const n of nodes) { try { n.disconnect(); } catch { /* gone */ } }
    nodes = [];
    analyser = null;
    if (ctx) { try { ctx.close?.(); } catch { /* closed */ } ctx = null; }
    if (ownStream && stream) for (const t of stream.getTracks()) { try { t.stop(); } catch { /* stopped */ } }
    stream = null;
  }

  function meter() {
    if (!ctx || !stream) return;
    try {
      const src = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      // A silent sink keeps the graph running without playing the mic back.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      src.connect(analyser);
      analyser.connect(sink);
      sink.connect(ctx.destination);
      nodes = [src, analyser, sink];
      buf = new Float32Array(analyser.fftSize);
    } catch (err) {
      console.warn('[recorder] no level meter', err);
      analyser = null;
    }
  }

  async function start(given = null) {
    if (state !== 'idle') throw new Error('This voice recorder is already in use.');
    if (!MR) throw new Error('This browser cannot record sound.');
    state = 'starting';
    // Made now, inside the tap: iOS lets an audio context run only from one.
    if (AC && !ctx) {
      try { ctx = new AC(); ctx.resume?.()?.catch?.(() => {}); } catch { ctx = null; }
    }
    try {
      if (given) { stream = given; ownStream = false; } else {
        stream = await gum({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        ownStream = true;
      }
    } catch (err) {
      state = 'idle';
      release();
      throw micError(err);
    }
    if (state !== 'starting') { release(); throw new Error('The recording was cancelled.'); }
    mime = pickAudioMime(MR);
    try {
      const tries = mime ? [{ mimeType: mime, audioBitsPerSecond: AUDIO_BITRATE }, { audioBitsPerSecond: AUDIO_BITRATE }, {}] : [{ audioBitsPerSecond: AUDIO_BITRATE }, {}];
      let last = null;
      for (const o of tries) { try { rec = new MR(stream, o); break; } catch (err) { last = err; } }
      if (!rec) throw last;
      chunks = [];
      rec.ondataavailable = (e) => { if (e?.data?.size) chunks.push(e.data); };
      stopped = new Promise((res) => { resolveStopped = res; });
      rec.onstop = () => { if (tEnd == null) tEnd = now(); resolveStopped(); };
      t0 = now();
      rec.start(1000);
    } catch (err) {
      rec = null;
      release();
      state = 'idle';
      throw new Error(`The phone could not start recording sound (${err?.message || err?.name || 'unknown problem'}).`);
    }
    meter();
    state = 'recording';
  }

  async function stop() {
    if (state !== 'recording') throw new Error('Nothing is recording.');
    state = 'stopping';
    try { rec.stop(); } catch { /* already stopped */ }
    try { await withTimeout(stopped, 4000); } catch { /* use what arrived */ }
    if (tEnd == null) tEnd = now();
    const durationMs = Math.max(0, tEnd - t0);
    const type = baseMime(rec.mimeType || mime) || baseMime(chunks[0]?.type) || 'audio/webm';
    const blob = new Blob(chunks, { type });
    const mimeType = rec.mimeType || mime || type;
    chunks = [];
    release();
    state = 'done';
    if (!blob.size) throw new Error('Nothing was recorded. Check that the microphone is allowed for this site, then try again.');
    return { blob, duration: durationMs / 1000, mimeType };
  }

  function cancel() {
    if (state === 'starting') { state = 'cancelled'; return; }
    if (state === 'recording') {
      try { rec.onstop = null; rec.stop(); } catch { /* stopped */ }
    }
    chunks = [];
    release();
    state = 'cancelled';
  }

  function level() {
    if (!analyser || state !== 'recording') return 0;
    try {
      let rms = 0;
      if (analyser.getFloatTimeDomainData) {
        analyser.getFloatTimeDomainData(buf);
        for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
        rms = Math.sqrt(rms / buf.length);
      } else {
        const b = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(b);
        for (let i = 0; i < b.length; i++) { const v = (b[i] - 128) / 128; rms += v * v; }
        rms = Math.sqrt(rms / b.length);
      }
      if (rms <= 0) return 0;
      const dB = 20 * Math.log10(rms);
      return Math.max(0, Math.min(1, (dB + 60) / 60));
    } catch { return 0; }
  }

  return {
    start,
    stop,
    cancel,
    level,
    elapsedMs: () => (t0 == null ? 0 : Math.max(0, (tEnd ?? now()) - t0)),
    get state() { return state; },
    get mimeType() { return rec?.mimeType || mime; },
  };
}
