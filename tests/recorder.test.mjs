// recorder.test.mjs — js/core/recorder.js on a fake IndexedDB with a fake
// MediaRecorder, clock and timers: the row is written before recording
// starts, pieces are written in order, the finished video is joined from
// what is on disk, nothing is lost when a write fails or the app is hidden,
// and recovery after a crash (complete, with a gap, empty, already saved).
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = await import('../js/core/store.js');
const rec = await import('../js/core/recorder.js');

// ---- fakes ----------------------------------------------------------------------------------

class FakeMR {
  static supported = ['video/webm;codecs=vp8,opus', 'video/webm', 'audio/mp4', 'audio/webm'];
  static isTypeSupported(t) { return FakeMR.supported.includes(t); }
  static last = null;
  constructor(stream, opts = {}) {
    this.stream = stream;
    this.opts = opts;
    this.mimeType = opts.mimeType || 'video/webm';
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
    this.tail = null;
    FakeMR.last = this;
  }
  start(timeslice) {
    this.timeslice = timeslice;
    this.state = 'recording';
    // What is on disk at the moment recording begins (the row must be).
    this.rowsAtStart = store.listRecordings();
  }
  piece(text) { this.ondataavailable?.({ data: new Blob([text], { type: this.mimeType }) }); }
  requestData() { if (this.tail) { const t = this.tail; this.tail = null; this.piece(t); } }
  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    setTimeout(() => { this.ondataavailable?.({ data: new Blob([], { type: this.mimeType }) }); this.onstop?.(); }, 5);
  }
}

function fakeTrack(kind = 'video') {
  const t = new EventTarget();
  t.kind = kind;
  t.readyState = 'live';
  t.muted = false;
  t.stopped = false;
  t.stop = () => { t.stopped = true; t.readyState = 'ended'; };
  return t;
}

function fakeStream(...tracks) {
  const all = tracks.length ? tracks : [fakeTrack('video')];
  return { getTracks: () => all, getVideoTracks: () => all.filter((t) => t.kind === 'video'), getAudioTracks: () => all.filter((t) => t.kind === 'audio') };
}

function harness() {
  let clock = 1000;
  const intervals = new Map();
  let nextId = 1;
  const h = {
    now: () => clock,
    setInterval: (fn, ms) => { const id = nextId++; intervals.set(id, { fn, ms }); return id; },
    clearInterval: (id) => intervals.delete(id),
    /** Move the clock on, firing the 200 ms path samples (not the 2 s flush). */
    advance(ms) {
      const steps = Math.round(ms / 200);
      for (let i = 0; i < steps; i++) {
        clock += 200;
        for (const it of intervals.values()) if (it.ms === rec.SAMPLE_MS) it.fn();
      }
    },
    flushTimers: () => { for (const it of intervals.values()) if (it.ms === rec.FLUSH_MS) it.fn(); },
    intervals,
  };
  return h;
}

let walkX = 100;
const getPose = () => {
  walkX += 1;
  return {
    t: Date.now(), geo: { lat: 38.58, lng: -121.49, acc: 2, alt: null, altAcc: null }, enu: { e: walkX / 10, n: 0 },
    plan: { x: walkX, y: 200 }, planAcc: 5, heading: 90, planHeading: 90, pitch: -5, source: 'fused', quality: 'good',
  };
};

const fakeInfo = async () => ({ width: 1920, height: 1080, duration: Infinity, posterBlob: new Blob([new Uint8Array(20).fill(3)], { type: 'image/jpeg' }), playable: true });
const fakeThumb = async () => new Blob([new Uint8Array(12).fill(9)], { type: 'image/jpeg' });

function deps(h, extra = {}) {
  return {
    MediaRecorder: FakeMR, now: h.now, setInterval: h.setInterval, clearInterval: h.clearInterval,
    document: null, window: null, locks: null, videoInfo: fakeInfo, makeThumb: fakeThumb, ...extra,
  };
}

/** The piece numbers on disk for a recording. */
async function chunkRows(recId) {
  return (await store.getRecordingChunkSeqs(recId)).map((seq) => ({ seq }));
}

async function textOf(blob) { return new TextDecoder().decode(await blob.arrayBuffer()); }

/** A job walk whose level has a plan (so plan spots are kept), unless {map: true}. */
async function newProject(name, { map = false } = {}) {
  let p = await store.createProject({ name });
  if (!map) {
    await store.updateLevel(p.id, p.activeLevelId, (l) => { l.plan = { mediaId: 'm_plan', width: 2000, height: 1500 }; });
    p = await store.getProject(p.id);
  }
  return { p, level: store.activeLevel(p) };
}

// ---- pure helpers -------------------------------------------------------------------------------

test('contiguousPrefix: the playable run from piece 0', () => {
  assert.deepEqual(rec.contiguousPrefix([0, 1, 2]), { count: 3, total: 3, complete: true, missingFirst: false });
  assert.deepEqual(rec.contiguousPrefix([2, 0, 1, 4, 5]), { count: 3, total: 5, complete: false, missingFirst: false });
  assert.deepEqual(rec.contiguousPrefix([1, 2]), { count: 0, total: 2, complete: false, missingFirst: true });
  assert.deepEqual(rec.contiguousPrefix([]), { count: 0, total: 0, complete: false, missingFirst: false });
});

test('trackPoint: the SPEC fields, rounded, nulls when unknown', () => {
  const pt = rec.trackPoint({ enu: { e: 1.23456, n: -2.5 }, plan: { x: 10.06, y: 20 }, geo: { lat: 38.123456789, lng: -121.987654321, acc: 3.456 }, heading: 359.96, planHeading: 12.34, pitch: -45.67 }, 1234.6);
  assert.deepEqual(pt, { t: 1235, e: 1.235, n: -2.5, x: 10.1, y: 20, lat: 38.1234568, lng: -121.9876543, acc: 3.46, heading: 360, planHeading: 12.3, pitch: -45.7 });
  const empty = rec.trackPoint(null, -5);
  assert.equal(empty.t, 0);
  for (const k of ['e', 'n', 'x', 'y', 'lat', 'lng', 'acc', 'heading', 'planHeading', 'pitch']) assert.equal(empty[k], null);
});

// ---- recording ----------------------------------------------------------------------------------

test('a video: row before start, pieces in order, joined into a verified video, then tidied up', async () => {
  const { p, level } = await newProject('Video');
  const h = harness();
  // Slow first write: a later piece must still wait its turn.
  const order = [];
  const slowFirst = {
    ...store,
    putChunk: async (recId, seq, blob) => {
      if (seq === 0) await new Promise((r) => setTimeout(r, 40));
      await store.putChunk(recId, seq, blob);
      order.push(seq);
    },
  };
  const r = rec.createVideoRecorder({ stream: fakeStream(), project: p, level, getPose, quality: 'high', size: { width: 1920, height: 1080 }, deps: deps(h, { store: slowFirst }) });
  const states = [];
  const saved = [];
  r.on('state', (s) => states.push(s));
  r.on('saved', (i) => saved.push(i));
  await r.start();
  const mr = FakeMR.last;
  assert.equal(mr.timeslice, 1000);
  assert.equal(mr.opts.mimeType, 'video/webm;codecs=vp8,opus');
  assert.equal(mr.opts.videoBitsPerSecond, 6_000_000);
  assert.ok((await mr.rowsAtStart).some((row) => row.recId === r.recId), 'the recording row was on disk before recording began');
  const row0 = (await store.listRecordings()).find((x) => x.recId === r.recId);
  assert.equal(row0.projectId, p.id);
  assert.equal(row0.levelId, level.id);
  assert.equal(row0.mimeType, 'video/webm;codecs=vp8,opus');
  assert.equal(row0.quality, 'high');
  assert.ok(row0.startPose && row0.startPose.plan, 'where the video started');

  mr.piece('AAAA');
  h.advance(1000);
  mr.piece('BBBB');
  h.advance(1000);
  h.flushTimers();
  mr.piece('CCCC');
  h.advance(600);
  mr.tail = 'DD';
  assert.ok(r.elapsedMs() >= 2600);
  const item = await r.stop();

  assert.deepEqual(order, [0, 1, 2, 3], 'written one at a time, in order');
  assert.equal(item.type, 'video');
  assert.equal(item.source, 'camera');
  assert.equal(item.levelId, level.id);
  assert.equal(item.mimeType, 'video/webm;codecs=vp8,opus');
  assert.equal(item.duration, 2.6, 'the measured duration, not the file\'s (Infinity)');
  assert.equal(item.width, 1920);
  assert.ok(item.media.original && item.media.poster && item.media.thumb);
  assert.equal(await textOf(await store.getMediaBlob(item.media.original)), 'AAAABBBBCCCCDD');
  const vrec = await store.getMediaRecord(item.media.original);
  assert.equal(vrec.kind, 'video');
  assert.equal(vrec.itemId, item.id);
  assert.equal(vrec.meta.levelId, level.id, 'the facts are saved with the bytes (store.recoverOrphans)');
  assert.equal(vrec.meta.duration, 2.6);
  assert.ok(vrec.meta.track.length >= 13);
  assert.ok(item.track.length >= 13, `path samples: ${item.track.length}`);
  assert.ok(item.track.every((pt, i) => i === 0 || pt.t >= item.track[i - 1].t));
  assert.ok(item.track.at(-1).x > item.track[0].x, 'the path moves');
  assert.equal(item.pose.plan.x, row0.startPose.plan.x, 'the item pose is where it started');
  assert.equal((await store.listRecordings()).some((x) => x.recId === r.recId), false, 'row removed after the item exists');
  assert.equal((await chunkRows(r.recId)).length, 0, 'pieces removed');
  assert.equal(saved.length, 1);
  assert.deepEqual(states.slice(0, 2), ['starting', 'recording']);
  assert.equal(states.at(-1), 'saved');
  assert.equal(h.intervals.size, 0, 'timers stopped');
});

test('the finished video is joined from what is ON DISK, in order', async () => {
  const { p, level } = await newProject('From disk');
  const h = harness();
  const disk = { ...store, putChunk: (recId, seq) => store.putChunk(recId, seq, new Blob([`[disk${seq}]`])) };
  const r = rec.createVideoRecorder({ stream: fakeStream(), project: p, level, getPose, deps: deps(h, { store: disk }) });
  await r.start();
  FakeMR.last.piece('mem0');
  FakeMR.last.piece('mem1');
  h.advance(400);
  const item = await r.stop();
  assert.equal(await textOf(await store.getMediaBlob(item.media.original)), '[disk0][disk1]');
});

test('a piece the phone refuses is kept in memory, reported, and still ends up in the video', async () => {
  const { p, level } = await newProject('Refused');
  const h = harness();
  const refuse1 = { ...store, putChunk: (recId, seq, blob) => (seq === 1 ? Promise.reject(new Error('QuotaExceededError')) : store.putChunk(recId, seq, blob)) };
  const r = rec.createVideoRecorder({ stream: fakeStream(), project: p, level, getPose, deps: deps(h, { store: refuse1 }) });
  const errors = [];
  r.on('error', (e) => errors.push(e));
  await r.start();
  FakeMR.last.piece('one-');
  FakeMR.last.piece('two-');
  FakeMR.last.piece('three');
  h.advance(1000);
  const item = await r.stop();
  assert.ok(errors.some((e) => e.fatal === false && /kept in memory/.test(e.message)), 'the person was told');
  assert.equal(await textOf(await store.getMediaBlob(item.media.original)), 'one-two-three');
  assert.deepEqual((await chunkRows(r.recId)).map((c) => c.seq), [], 'tidied up after the video was saved');
});

test('the app going to the background finishes and saves the video at once', async () => {
  const { p, level } = await newProject('Hidden');
  const h = harness();
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  const r = rec.createVideoRecorder({ stream: fakeStream(), project: p, level, getPose, deps: deps(h, { document: doc }) });
  const interrupted = [];
  r.on('interrupted', (e) => interrupted.push(e.reason));
  const saved = new Promise((res) => r.on('saved', res));
  await r.start();
  FakeMR.last.piece('xyz');
  h.advance(400);
  doc.visibilityState = 'hidden';
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(FakeMR.last.state, 'inactive', 'the recorder was stopped inside the event, before the page can freeze');
  assert.deepEqual(interrupted, ['hidden']);
  const item = await saved;
  assert.equal(await textOf(await store.getMediaBlob(item.media.original)), 'xyz');
  assert.equal(r.state, 'saved');
});

test('the camera track ending also finishes the video', async () => {
  const { p, level } = await newProject('Ended');
  const h = harness();
  const track = fakeTrack('video');
  const r = rec.createVideoRecorder({ stream: fakeStream(track), project: p, level, getPose, deps: deps(h) });
  const saved = new Promise((res) => r.on('saved', res));
  await r.start();
  FakeMR.last.piece('abc');
  track.dispatchEvent(new Event('ended'));
  const item = await saved;
  assert.equal(item.type, 'video');
});

test('cancel: discard (confirmed) keeps nothing; without discard it saves', async () => {
  const { p, level } = await newProject('Cancel');
  const h = harness();
  const a = rec.createVideoRecorder({ stream: fakeStream(), project: p, level, getPose, deps: deps(h) });
  await a.start();
  FakeMR.last.piece('gone');
  await a.cancel({ discard: true });
  assert.equal(a.state, 'discarded');
  assert.equal((await store.listRecordings()).some((x) => x.recId === a.recId), false);
  assert.equal((await chunkRows(a.recId)).length, 0);
  assert.equal((await store.listItems(p.id)).length, 0);

  const b = rec.createVideoRecorder({ stream: fakeStream(), project: p, level, getPose, deps: deps(h) });
  await b.start();
  FakeMR.last.piece('kept');
  const item = await b.cancel();
  assert.equal(item.type, 'video');
  assert.equal((await store.listItems(p.id)).length, 1);
});

test('a failed save keeps the pieces, hands back the video, and retry() finishes it', async () => {
  const { p, level } = await newProject('Retry video');
  const h = harness();
  let fail = true;
  const flaky = { ...store, putMedia: (b, m) => (fail && m.kind === 'video' ? Promise.reject(new Error('The phone is out of storage space')) : store.putMedia(b, m)) };
  const r = rec.createVideoRecorder({ stream: fakeStream(), project: p, level, getPose, deps: deps(h, { store: flaky }) });
  const fatal = [];
  r.on('error', (e) => { if (e.fatal) fatal.push(e); });
  await r.start();
  FakeMR.last.piece('12345');
  const err = await r.stop().then(() => null, (e) => e);
  assert.match(err.message, /out of storage/);
  assert.equal(await textOf(err.blob), '12345', 'the video can be downloaded');
  assert.equal(fatal.length, 1);
  assert.equal((await chunkRows(r.recId)).length, 1, 'pieces kept on disk');
  assert.ok((await store.listRecordings()).some((x) => x.recId === r.recId), 'row kept for recovery');
  fail = false;
  const item = await err.retry();
  assert.equal(await textOf(await store.getMediaBlob(item.media.original)), '12345');
  assert.equal((await chunkRows(r.recId)).length, 0);
});

test('start() fails cleanly when the phone will not save the row (no recorder is started)', async () => {
  const { p, level } = await newProject('No row');
  const h = harness();
  FakeMR.last = null;
  const broken = { ...store, beginRecording: () => Promise.reject(new Error('quota')) };
  const r = rec.createVideoRecorder({ stream: fakeStream(), project: p, level, getPose, deps: deps(h, { store: broken }) });
  await assert.rejects(r.start(), /could not start/);
  assert.equal(FakeMR.last, null);
  assert.equal(r.state, 'idle');
});

// ---- recovery -------------------------------------------------------------------------------------

async function leftover(p, level, seqs, extra = {}) {
  const row = await store.beginRecording({
    projectId: p.id, levelId: level.id, mimeType: 'video/mp4', startedAt: Date.now() - 60_000, quality: 'high',
    state: 'recording', aliveAt: Date.now() - 50_000,
    startPose: { t: 1, geo: { lat: 1, lng: 2, acc: 3 }, plan: { x: 7, y: 8 }, source: 'fused', quality: 'good' },
    track: [{ t: 0, x: 7, y: 8 }, { t: 1800, x: 9, y: 8 }], ...extra,
  });
  for (const s of seqs) await store.putChunk(row.recId, s, new Blob([`<${s}>`], { type: 'video/mp4' }));
  return row;
}

const recDeps = { videoInfo: fakeInfo, makeThumb: fakeThumb };

test('recovery: a complete leftover becomes a "Recovered video" with its path; its row goes', async () => {
  const { p, level } = await newProject('Recover all');
  const row = await leftover(p, level, [0, 1, 2]);
  const items = await rec.recoverRecordings({ deps: recDeps });
  const it = items.find((i) => i.projectId === p.id);
  assert.ok(it, 'recovered');
  assert.equal(it.source, 'recovered');
  assert.equal(it.title, 'Recovered video');
  assert.equal(it.type, 'video');
  assert.equal(it.mimeType, 'video/mp4');
  assert.deepEqual(it.track.map((t) => t.x), [7, 9]);
  assert.equal(it.pose.plan.x, 7);
  assert.equal(it.duration, 1.8, 'no measured time: the last path sample');
  assert.equal(await textOf(await store.getMediaBlob(it.media.original)), '<0><1><2>');
  assert.equal((await store.listRecordings()).some((x) => x.recId === row.recId), false);
  assert.equal((await chunkRows(row.recId)).length, 0);
  // Running again makes nothing new.
  const again = await rec.recoverRecordings({ deps: recDeps });
  assert.equal(again.filter((i) => i.projectId === p.id).length, 0);
});

test('recovery: a gap → the playable start is saved, the rest is kept, and it is not done twice', async () => {
  const { p, level } = await newProject('Recover gap');
  const row = await leftover(p, level, [0, 1, 3, 4]);
  const items = await rec.recoverRecordings({ deps: recDeps });
  const it = items.find((i) => i.projectId === p.id);
  assert.equal(await textOf(await store.getMediaBlob(it.media.original)), '<0><1>');
  assert.equal(it.duration, 2, 'two one-second pieces');
  const kept = (await store.listRecordings()).find((x) => x.recId === row.recId);
  assert.ok(kept?.recoveredPrefix, 'row kept and marked');
  assert.equal(kept.recoveredPrefix.itemId, it.id);
  assert.equal(kept.recoveredPrefix.upToSeq, 1);
  assert.deepEqual((await chunkRows(row.recId)).map((c) => c.seq), [0, 1, 3, 4], 'no bytes deleted');
  const again = await rec.recoverRecordings({ deps: recDeps });
  assert.equal(again.filter((i) => i.projectId === p.id).length, 0);
  assert.equal((await store.listItems(p.id)).length, 1);
});

test('recovery: no pieces → the row is removed; first piece missing → everything is kept, nothing made', async () => {
  const { p, level } = await newProject('Recover odd');
  const empty = await leftover(p, level, []);
  const headless = await leftover(p, level, [1, 2]);
  const items = await rec.recoverRecordings({ deps: recDeps });
  assert.equal(items.filter((i) => i.projectId === p.id).length, 0);
  const rows = await store.listRecordings();
  assert.equal(rows.some((x) => x.recId === empty.recId), false);
  assert.ok(rows.some((x) => x.recId === headless.recId));
  assert.equal((await chunkRows(headless.recId)).length, 2);
});

test('recovery: already saved before the crash → only tidied up; video saved but no item → that video is reused', async () => {
  const { p, level } = await newProject('Recover partial');
  // Crashed after the item was created, before the tidy-up.
  const item = await store.createItem(p.id, { type: 'video', levelId: level.id });
  const done = await leftover(p, level, [0, 1], { itemId: item.id });
  // Crashed after the video was saved, before the item.
  const half = await leftover(p, level, [0, 1, 2]);
  const vid = await store.putMedia(new Blob(['<saved video>'], { type: 'video/mp4' }), { kind: 'video', projectId: p.id });
  await store.updateRecording(half.recId, { itemId: 'i_fixed_for_test', mediaId: vid });
  const items = await rec.recoverRecordings({ deps: recDeps });
  const mine = items.filter((i) => i.projectId === p.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, 'i_fixed_for_test', 'the id written on the row is used');
  assert.equal(mine[0].media.original, vid, 'the saved video is reused, not saved twice');
  assert.equal((await store.listItems(p.id)).length, 2);
  const rows = await store.listRecordings();
  assert.equal(rows.some((x) => x.recId === done.recId), false);
  assert.equal(rows.some((x) => x.recId === half.recId), false);
  const videos = (await store.listMediaForProject(p.id)).filter((m) => m.kind === 'video');
  assert.equal(videos.length, 1);
});

test('recovery never touches a video that is still recording (this tab, or held by a Web Lock)', async () => {
  const { p, level } = await newProject('Recover live');
  const h = harness();
  const r = rec.createVideoRecorder({ stream: fakeStream(), project: p, level, getPose, deps: deps(h, { locks: globalThis.navigator?.locks || null }) });
  await r.start();
  FakeMR.last.piece('live');
  await new Promise((res) => setTimeout(res, 20));
  const items = await rec.recoverRecordings({ deps: recDeps });
  assert.equal(items.filter((i) => i.projectId === p.id).length, 0);
  assert.ok((await store.listRecordings()).some((x) => x.recId === r.recId));
  const item = await r.stop();
  assert.equal(await textOf(await store.getMediaBlob(item.media.original)), 'live');
  assert.equal((await store.listItems(p.id)).length, 1);
});

test('recovery drops leftovers of a job walk that was erased for good', async () => {
  const { p, level } = await newProject('Erased');
  const row = await leftover(p, level, [0]);
  await store.purgeProject(p.id);
  await rec.recoverRecordings({ deps: recDeps });
  assert.equal((await store.listRecordings()).some((x) => x.recId === row.recId), false);
});

// ---- voice notes ---------------------------------------------------------------------------------

test('voice notes: record, stop → {blob, duration, mimeType}, microphone let go', async () => {
  let clock = 0;
  const mic = fakeTrack('audio');
  const a = rec.createAudioRecorder({ deps: { MediaRecorder: FakeMR, now: () => clock, AudioContext: null, getUserMedia: async (c) => { assert.ok(c.audio); return fakeStream(mic); } } });
  await a.start();
  assert.equal(a.state, 'recording');
  assert.equal(FakeMR.last.opts.mimeType, 'audio/mp4');
  FakeMR.last.piece('hello ');
  FakeMR.last.piece('world');
  clock = 3500;
  const out = await a.stop();
  assert.equal(await textOf(out.blob), 'hello world');
  assert.equal(out.blob.type, 'audio/mp4');
  assert.equal(out.duration, 3.5);
  assert.equal(out.mimeType, 'audio/mp4');
  assert.equal(mic.stopped, true, 'the microphone is released');
  assert.equal(a.level(), 0);
});

test('voice notes: a blocked microphone says what to do; nothing recorded is an error, not an empty note', async () => {
  const denied = rec.createAudioRecorder({ deps: { MediaRecorder: FakeMR, AudioContext: null, getUserMedia: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } } });
  await assert.rejects(denied.start(), /microphone is blocked/);
  assert.equal(denied.state, 'idle');
  const silent = rec.createAudioRecorder({ deps: { MediaRecorder: FakeMR, AudioContext: null, getUserMedia: async () => fakeStream(fakeTrack('audio')) } });
  await silent.start();
  await assert.rejects(silent.stop(), /Nothing was recorded/);
  const cancelled = rec.createAudioRecorder({ deps: { MediaRecorder: FakeMR, AudioContext: null, getUserMedia: async () => fakeStream(fakeTrack('audio')) } });
  await cancelled.start();
  cancelled.cancel();
  assert.equal(cancelled.state, 'cancelled');
});

test('recovery: a video that crashed the app while being rebuilt is skipped after 3 tries, and kept', async () => {
  const { p, level } = await newProject('Crash loop');
  const row = await leftover(p, level, [0, 1], { recoveryTries: rec.MAX_RECOVERY_TRIES });
  const items = await rec.recoverRecordings({ deps: recDeps });
  assert.equal(items.filter((i) => i.projectId === p.id).length, 0);
  assert.ok(items.skipped >= 1);
  assert.ok((await store.listRecordings()).some((x) => x.recId === row.recId), 'kept');
  assert.equal((await chunkRows(row.recId)).length, 2);
  const forced = await rec.recoverRecordings({ force: true, deps: recDeps });
  const it = forced.find((i) => i.projectId === p.id);
  assert.ok(it, 'rebuilt when asked');
  assert.equal(await textOf(await store.getMediaBlob(it.media.original)), '<0><1>');
});

test('recovery: an ordinary failure gives the try back (only crashes count)', async () => {
  const { p, level } = await newProject('Ordinary failure');
  const row = await leftover(p, level, [0]);
  const full = { ...store, putMedia: () => Promise.reject(new Error('The phone is out of storage space')) };
  await assert.rejects(rec.recoverRecordings({ deps: { ...recDeps, store: full } }), /out of storage/);
  const after = (await store.listRecordings()).find((x) => x.recId === row.recId);
  assert.equal(after.recoveryTries || 0, 0);
  assert.equal((await chunkRows(row.recId)).length, 1, 'pieces kept');
  const items = await rec.recoverRecordings({ deps: recDeps });
  assert.ok(items.some((i) => i.projectId === p.id));
});

test('recovery: a launch that fails still says how many videos wait for "Try again"; force rebuilds them', async () => {
  const { p, level } = await newProject('Skipped and failing');
  const crashed = await leftover(p, level, [0], { recoveryTries: rec.MAX_RECOVERY_TRIES });
  const failing = await leftover(p, level, [0, 1]);
  const mine = new Set([crashed.recId, failing.recId]);
  const onlyMine = async () => (await store.listRecordings()).filter((x) => mine.has(x.recId));
  const full = { ...store, listRecordings: onlyMine, putMedia: () => Promise.reject(new Error('The phone is out of storage space')) };
  const err = await rec.recoverRecordings({ deps: { ...recDeps, store: full } }).then(() => null, (e) => e);
  assert.ok(err, 'nothing rebuilt and something failed: rejects');
  assert.equal(err.skipped, 1, 'the skipped video is still counted');
  assert.equal(err.errors.length, 1);
  assert.equal((await chunkRows(crashed.recId)).length, 1, 'pieces kept');
  // "Try again" (force) once there is room: both are rebuilt.
  const items = await rec.recoverRecordings({ force: true, deps: { ...recDeps, store: { ...store, listRecordings: onlyMine } } });
  assert.equal(items.filter((i) => i.projectId === p.id).length, 2);
  assert.equal(items.skipped, 0);
});
