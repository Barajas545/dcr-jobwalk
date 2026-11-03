// voice.test.mjs — js/core/voice.js (dictation and voice notes, on a fake IndexedDB and a fake
// speech recogniser) and the pure helpers of js/ui/item-screen.js (labels, track maths, file
// names, text merging, the autosaver that keeps typed notes safe).
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = await import('../js/core/store.js');
const voice = await import('../js/core/voice.js');
const screen = await import('../js/ui/item-screen.js');

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in for SpeechRecognition: the test says what the "browser" heard.
class FakeRec {
  static all = [];
  constructor() { FakeRec.all.push(this); this.started = 0; this.stopped = 0; this.aborted = 0; this.endOnStop = true; }
  start() { this.started++; }
  stop() { this.stopped++; if (this.endOnStop) queueMicrotask(() => this.onend?.()); }
  abort() { this.aborted++; }
  /** list: [[transcript, isFinal], …] */
  say(list, resultIndex = 0) {
    const results = list.map(([t, f]) => Object.assign([{ transcript: t }], { isFinal: !!f }));
    this.onresult?.({ resultIndex, results });
  }
  end() { this.onend?.(); }
  fail(code) { this.onerror?.({ error: code }); this.onend?.(); }
}

function dictation(opts = {}) {
  FakeRec.all = [];
  const out = { texts: [], interims: [], errors: [], ended: 0 };
  out.d = voice.createDictation({
    Recognition: FakeRec,
    dedupe: false,
    onText: (t) => out.texts.push(t),
    onInterim: (t) => out.interims.push(t),
    onError: (e) => out.errors.push(e),
    onEnd: () => out.ended++,
    ...opts,
  });
  return out;
}

// ---- dictation ---------------------------------------------------------------------------

test('no speech recognition in the browser: createDictation returns null (the button is hidden)', () => {
  assert.equal(voice.speechRecognitionClass(), null);
  assert.equal(voice.createDictation({ onText() {} }), null);
});

test('dictation passes each finished phrase once, and in-progress words separately', async () => {
  const o = dictation();
  assert.equal(o.d.supported, true);
  o.d.start();
  const r = FakeRec.all[0];
  assert.equal(r.started, 1);
  assert.equal(r.continuous, true);
  assert.equal(r.interimResults, true);
  r.say([['header over', false]]);
  r.say([['header over garage', true]]);
  r.say([['header over garage', true], ['needs a', false]], 0); // index 0 delivered again
  assert.deepEqual(o.texts, ['header over garage']);
  assert.equal(o.interims.at(-1), 'needs a');
  o.d.stop();
  await tick();
  // Words still in progress when listening stops are kept, not dropped.
  assert.deepEqual(o.texts, ['header over garage', 'needs a']);
  assert.equal(o.ended, 1);
  assert.equal(o.d.listening, false);
});

test('when the phone ends a session early, a new one starts until Stop', async () => {
  const o = dictation();
  o.d.start();
  FakeRec.all[0].say([['first part', false]]);
  FakeRec.all[0].end(); // iPhone: session over, last words never marked final
  assert.deepEqual(o.texts, ['first part']);
  await sleep(120);
  assert.equal(FakeRec.all.length, 2);
  assert.equal(FakeRec.all[1].started, 1);
  assert.equal(o.ended, 0);
  assert.equal(o.d.listening, true);
  FakeRec.all[1].say([['second part', true]]);
  o.d.stop();
  await tick();
  assert.deepEqual(o.texts, ['first part', 'second part']);
  assert.equal(o.ended, 1);
  await sleep(100);
  assert.equal(FakeRec.all.length, 2, 'no restart after Stop');
});

test('a blocked microphone stops dictation with a plain message, no retry loop', async () => {
  const o = dictation();
  o.d.start();
  FakeRec.all[0].fail('not-allowed');
  await sleep(100);
  assert.equal(FakeRec.all.length, 1);
  assert.equal(o.errors.length, 1);
  assert.equal(o.errors[0].code, 'not-allowed');
  assert.match(o.errors[0].message, /microphone/i);
  assert.equal(o.ended, 1);
  assert.equal(o.d.listening, false);
});

test('"no speech" is not fatal: listening carries on', async () => {
  const o = dictation();
  o.d.start();
  FakeRec.all[0].say([['one', true]]);
  FakeRec.all[0].fail('no-speech');
  await sleep(120);
  assert.equal(FakeRec.all.length, 2);
  assert.equal(o.errors.length, 0);
  o.d.stop();
  await tick();
  assert.equal(o.ended, 1);
});

test('a recogniser that keeps ending at once gives up with a message', async () => {
  const o = dictation();
  o.d.start();
  for (let i = 1; i <= 5; i++) {
    FakeRec.all.at(-1).end();
    if (i < 5) await sleep(150 * i + 40);
  }
  assert.equal(FakeRec.all.length, 5);
  assert.equal(o.errors.length, 1);
  assert.match(o.errors[0].message, /keeps stopping/);
  assert.equal(o.ended, 1);
});

test('stop() finishes even when the browser never reports the end', async () => {
  const o = dictation();
  o.d.start();
  FakeRec.all[0].endOnStop = false;
  FakeRec.all[0].say([['almost', false]]);
  o.d.stop();
  await sleep(2100);
  assert.equal(FakeRec.all[0].aborted, 1);
  assert.deepEqual(o.texts, ['almost']);
  assert.equal(o.ended, 1);
});

test('with dedupe on (Android), a phrase delivered again with new words is not doubled', async () => {
  const o = dictation({ dedupe: true });
  o.d.start();
  const r = FakeRec.all[0];
  r.say([['two by', true]]);
  r.say([['two by', true], ['two by twelve header', true]], 1);
  r.say([['two by', true], ['two by twelve header', true], ['at the garage', true]], 2);
  assert.deepEqual(o.texts, ['two by', 'twelve header', 'at the garage']);
  o.d.stop();
  await tick();
});

test('dedupeFinal keeps new words only', () => {
  assert.equal(voice.dedupeFinal('', 'hello there'), 'hello there');
  assert.equal(voice.dedupeFinal('two by', 'two by twelve', 500), 'twelve');
  assert.equal(voice.dedupeFinal('Two by.', 'two by twelve', 500), 'twelve');
  assert.equal(voice.dedupeFinal('two', 'two by six', 500), 'two by six', 'one word is too little to call it a repeat');
  assert.equal(voice.dedupeFinal('two by', 'two by twelve', 10_000), 'two by twelve', 'long after: a new phrase');
  assert.equal(voice.dedupeFinal('same words', 'same words', 1000), '');
  assert.equal(voice.dedupeFinal('same words', 'same words', 9000), 'same words');
  assert.equal(voice.dedupeFinal('header', 'joist', 100), 'joist');
});

test('joinDictated adds the space and the capital a sentence needs', () => {
  assert.equal(voice.joinDictated('', 'header over garage'), 'Header over garage');
  assert.equal(voice.joinDictated('Header over garage', 'needs a 4x12'), ' needs a 4x12');
  assert.equal(voice.joinDictated('Done. ', 'next one'), 'Next one');
  assert.equal(voice.joinDictated('Line one\n', 'line two'), 'Line two');
  assert.equal(voice.joinDictated('a ', 'b', 'c'), 'b ');
  assert.equal(voice.joinDictated('a', 'b', '.'), ' b');
  assert.equal(voice.joinDictated('x', '   '), '');
});

// ---- voice notes ---------------------------------------------------------------------------

async function makeItem(type = 'photo') {
  const p = await store.createProject({ name: 'Voice notes' });
  const it = await store.createItem(p.id, { type, levelId: p.activeLevelId });
  return { p, it };
}

test('addVoiceNote saves verified bytes, then lists the note on the item', async () => {
  const { p, it } = await makeItem();
  const bytes = new Uint8Array(3000).map((_, i) => i % 199);
  const updated = await voice.addVoiceNote(it.id, { blob: new Blob([bytes], { type: 'audio/webm' }), duration: 4.2, mimeType: 'audio/webm;codecs=opus' });
  assert.equal(updated.voiceNotes.length, 1);
  const v = updated.voiceNotes[0];
  assert.match(v.id, /^v_/);
  assert.equal(v.duration, 4.2);
  assert.equal(v.mimeType, 'audio/webm;codecs=opus');
  assert.equal(v.transcript, '');
  assert.ok(v.createdAt > 0);
  const rec = await store.getMediaRecord(v.mediaId);
  assert.equal(rec.kind, 'voice');
  assert.equal(rec.itemId, it.id);
  assert.equal(rec.projectId, p.id);
  assert.deepEqual(new Uint8Array(await (await store.getMediaBlob(v.mediaId)).arrayBuffer()), bytes);
  assert.equal((await store.getItem(it.id)).voiceNotes.length, 1);
  const after = await store.getProject(p.id);
  assert.ok(store.backupState(after).needed, 'a voice note counts as a change to back up');
});

test('a duration the browser could not measure is kept as null, the type from the blob', async () => {
  const { it } = await makeItem('video');
  const updated = await voice.addVoiceNote(it.id, { blob: new Blob([new Uint8Array(10)], { type: 'audio/mp4' }), duration: Infinity });
  assert.equal(updated.voiceNotes[0].duration, null);
  assert.equal(updated.voiceNotes[0].mimeType, 'audio/mp4');
});

test('an empty recording is refused and the item is unchanged', async () => {
  const { it } = await makeItem();
  await assert.rejects(voice.addVoiceNote(it.id, { blob: new Blob([]), duration: 0 }), /empty/);
  assert.equal((await store.getItem(it.id)).voiceNotes.length, 0);
});

test('a voice note for an item that is gone is refused before anything is saved', async () => {
  await assert.rejects(voice.addVoiceNote('i_missing', { blob: new Blob([new Uint8Array(5)]) }), /no longer exists/);
});

test('removing a voice note keeps its recording; restore brings it back; purge erases it', async () => {
  const { it } = await makeItem();
  const a = await voice.addVoiceNote(it.id, { blob: new Blob([new Uint8Array(100)]), duration: 1 });
  await sleep(2);
  const b = await voice.addVoiceNote(it.id, { blob: new Blob([new Uint8Array(200)]), duration: 2 });
  const [first, second] = b.voiceNotes;
  assert.equal(a.voiceNotes[0].id, first.id);

  const r = await voice.removeVoiceNote(it.id, first.id);
  assert.deepEqual(r.voiceNotes.map((v) => v.id), [second.id]);
  assert.equal(r.removedVoiceNotes.length, 1);
  assert.equal(r.removedVoiceNotes[0].id, first.id);
  assert.ok(r.removedVoiceNotes[0].removedAt > 0);
  assert.ok(await store.getMediaBlob(first.mediaId), 'the recording itself is still on the phone');

  // A second remove (double tap, another tab) is harmless.
  const again = await voice.removeVoiceNote(it.id, first.id);
  assert.equal(again.voiceNotes.length, 1);

  const back = await voice.restoreVoiceNote(it.id, first.id);
  assert.deepEqual(back.voiceNotes.map((v) => v.id), [first.id, second.id], 'back in time order');
  assert.equal(back.removedVoiceNotes.length, 0);
  assert.equal(back.voiceNotes[0].removedAt, undefined);

  await voice.removeVoiceNote(it.id, first.id);
  await store.softDeleteItem(it.id);
  await store.purgeItem(it.id);
  assert.equal(await store.getMediaBlob(first.mediaId), null);
  assert.equal(await store.getMediaBlob(second.mediaId), null);
});

test('removing a voice note that is not on the item says so', async () => {
  const { it } = await makeItem();
  await assert.rejects(voice.removeVoiceNote(it.id, 'v_nope'), /not on this item/);
  await assert.rejects(voice.restoreVoiceNote(it.id, 'v_nope'), /can no longer be brought back/);
});

// ---- item screen helpers ---------------------------------------------------------------------

test('tilt, heading and altitude read the way a person says them', () => {
  assert.equal(screen.describeTilt(0.5), 'Level');
  assert.equal(screen.describeTilt(-35.4), 'Looking down 35°');
  assert.equal(screen.describeTilt(12), 'Looking up 12°');
  assert.equal(screen.describeTilt(-89), 'Straight down');
  assert.equal(screen.describeTilt(88), 'Straight up');
  assert.equal(screen.describeTilt(null), null);
  assert.equal(screen.describeHeading(42.4), 'NE 42°');
  assert.equal(screen.describeHeading(359.7), 'N 0°');
  assert.equal(screen.describeHeading(-90), 'W 270°');
  assert.equal(screen.describeHeading(null), null);
  assert.equal(screen.formatAltitude(312.2), '1,024 ft');
  assert.equal(screen.formatAltitude(12.34, 'metric'), '12.3 m');
  assert.equal(screen.formatAltitude(null), null);
});

test('coordinates and the Google Maps link', () => {
  assert.equal(screen.formatCoords(38.58161234, -121.4944), '38.581612, -121.494400');
  assert.equal(screen.googleMapsUrl(38.5816, -121.4944), 'https://www.google.com/maps/search/?api=1&query=38.5816000,-121.4944000');
});

test('quality badges', () => {
  assert.deepEqual(screen.qualityBadge('good'), { cls: 'ok', label: 'Good' });
  assert.deepEqual(screen.qualityBadge('poor'), { cls: 'err', label: 'Poor' });
  assert.equal(screen.qualityBadge(undefined).label, 'No GPS');
});

test('previous / next go by time and skip deleted items', () => {
  const a = { id: 'a', createdAt: 1, seq: 1 };
  const b = { id: 'b', createdAt: 2, seq: 2, deletedAt: 9 };
  const c = { id: 'c', createdAt: 3, seq: 3 };
  const d = { id: 'd', createdAt: 4, seq: 4 };
  const list = [d, c, b, a];
  assert.deepEqual(screen.neighbors(list, c), { prev: a, next: d, index: 1, count: 3 });
  assert.equal(screen.neighbors(list, a).prev, null);
  assert.equal(screen.neighbors(list, d).next, null);
  const n = screen.neighbors(list, b); // opened from Recently Deleted
  assert.equal(n.prev, a);
  assert.equal(n.next, c);
  assert.equal(n.index, -1);
  assert.equal(n.count, 3);
});

test('the nearest point of a video path, on the plan and on the map', () => {
  const track = [
    { t: 0, x: 0, y: 0, lat: 38.58, lng: -121.49 },
    { t: 1000, x: 100, y: 0, lat: 38.58, lng: -121.4899 },
    { t: 2000, x: 100, y: 100, lat: 38.5801, lng: -121.4899 },
    { t: null, x: 101, y: 101 },
    { t: 3000, x: null, y: null, lat: null, lng: null },
  ];
  const p = screen.nearestTrackPoint(track, { x: 95, y: 90 }, 'plan');
  assert.equal(p.point.t, 2000);
  assert.ok(Math.abs(p.distance - Math.hypot(5, 10)) < 1e-9);
  const g = screen.nearestTrackPoint(track, { lat: 38.58, lng: -121.48991 }, 'geo');
  assert.equal(g.point.t, 1000);
  assert.ok(g.distance < 1.5, 'about 0.9 m');
  assert.equal(screen.nearestTrackPoint([], { x: 0, y: 0 }), null);
  assert.deepEqual(screen.trackBounds(track), { minX: 0, minY: 0, maxX: 101, maxY: 101, n: 4 });
  assert.equal(screen.trackBounds([{ t: 0 }]), null);
});

test('a screen offset on the map becomes the right lat/lng (tap on a video path)', () => {
  const same = screen.offsetLatLng({ lat: 38.58, lng: -121.49, zoom: 19 }, 0, 0);
  assert.ok(Math.abs(same.lat - 38.58) < 1e-9 && Math.abs(same.lng + 121.49) < 1e-9);
  const q = screen.offsetLatLng({ lat: 0, lng: 0, zoom: 1 }, 128, 0); // a quarter of a 512 px world
  assert.ok(Math.abs(q.lng - 90) < 1e-9 && Math.abs(q.lat) < 1e-9);
  // 100 px east at zoom 19 in Sacramento is ~23.3 m; 100 px down is ~23.3 m south.
  const e = screen.offsetLatLng({ lat: 38.58, lng: -121.49, zoom: 19 }, 100, 100);
  const mE = (e.lng + 121.49) * 111320 * Math.cos(38.58 * Math.PI / 180);
  const mS = (38.58 - e.lat) * 110574;
  assert.ok(Math.abs(mE - 23.34) < 0.1, `east ${mE}`);
  assert.ok(Math.abs(mS - 23.34) < 0.2, `south ${mS}`);
});

test('where an item can be shown', () => {
  const planLevel = { plan: { mediaId: 'm', width: 100, height: 100 } };
  const mapLevel = { plan: null };
  const onPlan = { type: 'photo', pose: { plan: { x: 1, y: 2 }, geo: { lat: 1, lng: 2 } } };
  const gpsOnly = { type: 'photo', pose: { plan: null, geo: { lat: 1, lng: 2 } } };
  const nowhere = { type: 'note', pose: null };
  const video = { type: 'video', pose: null, track: [{ t: 0, x: 5, y: 5 }] };
  assert.equal(screen.placeKind(onPlan, planLevel), 'plan');
  assert.equal(screen.placeKind(gpsOnly, planLevel), 'map');
  assert.equal(screen.placeKind(gpsOnly, mapLevel), 'map');
  assert.equal(screen.placeKind(nowhere, planLevel), 'plan-empty');
  assert.equal(screen.placeKind(nowhere, mapLevel), 'map-empty');
  assert.equal(screen.placeKind(video, planLevel), 'plan');
  assert.equal(screen.hasPlanTrack(video), true);
  assert.equal(screen.hasGeoTrack(video), false);
});

test('file names say what the file is', () => {
  const createdAt = new Date(2026, 10, 2, 10, 32).getTime();
  const photo = { seq: 12, createdAt, title: '', tags: ['Headers/Beams'], type: 'photo', mimeType: 'image/jpeg' };
  assert.equal(screen.fileNameFor(photo, { levelName: 'Level 1' }), '012 - Level 1 - Headers Beams - 2026-11-02 10.32.jpg');
  assert.equal(screen.fileNameFor({ ...photo, title: 'Header: garage?' }, { levelName: 'Level 1', variant: 'annotated' }),
    '012 - Level 1 - Header garage - 2026-11-02 10.32 - markup.jpg');
  assert.equal(screen.fileNameFor({ seq: 3, createdAt, type: 'note' }, { mimeType: 'text/plain' }), '003 - Note - 2026-11-02 10.32.txt');
  assert.equal(screen.fileNameFor({ seq: 4, createdAt, type: 'video', mimeType: 'video/webm;codecs=vp9' }), '004 - Video - 2026-11-02 10.32.webm');
  assert.equal(screen.extForMime('audio/mp4'), '.m4a');
  assert.equal(screen.extForMime('x/unknown'), '');
  assert.equal(screen.describeMime('image/jpeg'), 'JPEG photo');
  assert.equal(screen.describeMime(''), 'Unknown');
});

test("mergeText keeps everybody's words", () => {
  assert.deepEqual(screen.mergeText('a', 'a b', 'a'), { text: 'a b', conflict: false }, 'only here changed');
  assert.deepEqual(screen.mergeText('a', 'a', 'a c'), { text: 'a c', conflict: false }, 'only elsewhere changed');
  assert.deepEqual(screen.mergeText('a', 'x', 'x'), { text: 'x', conflict: false }, 'same change');
  assert.deepEqual(screen.mergeText('a', 'a b c', 'a b'), { text: 'a b c', conflict: false }, 'ours contains theirs');
  assert.deepEqual(screen.mergeText('a', 'a b', 'a b c'), { text: 'a b c', conflict: false }, 'theirs contains ours');
  assert.deepEqual(screen.mergeText('a', 'mine', 'theirs'), { text: 'mine\n\ntheirs', conflict: true }, 'both kept');
  assert.deepEqual(screen.mergeText(undefined, 'new', ''), { text: 'new', conflict: false });
});

test('zoom to show the room around a pin, or a whole video path', () => {
  const box = { cw: 400, ch: 200, planW: 4000, planH: 2000 };
  assert.equal(screen.focusScale({ ...box, pxPerMeter: 20, meters: 10 }), 1, '200 px / (10 m × 20 px/m)');
  assert.equal(screen.focusScale({ ...box, meters: 10 }), 0.4, 'no calibration: 4× the fitted plan');
  assert.equal(screen.focusScale({ ...box, pxPerMeter: 1000 }), 0.1, 'never smaller than the whole plan');
  assert.equal(screen.focusScale({ ...box, pxPerMeter: 0.001 }), 2, 'never more than 2×');
  const bounds = { minX: 1000, minY: 1000, maxX: 1336, maxY: 1068 };
  const s = screen.trackFitScale({ ...box, bounds, pad: 32, pxPerMeter: 10 });
  assert.ok(Math.abs(s - 1) < 1e-9, '(400 − 64) / 336');
  const short = screen.trackFitScale({ ...box, bounds, pad: 32, pxPerMeter: 100 });
  assert.ok(Math.abs(short - 0.2) < 1e-9, 'a 3 m path still shows about 10 m around it');
  assert.equal(screen.trackFitScale({ ...box, bounds: null }), 0.1);
});

test('the autosaver saves once per pause, with the latest words', async () => {
  const saves = [];
  const states = [];
  const a = screen.createAutosaver({ delay: 30, save: async (v) => { saves.push(v); }, onState: (s) => states.push(s) });
  a.set('text', 'h');
  a.set('text', 'he');
  a.set('title', 'T');
  a.set('text', 'hello');
  assert.equal(a.dirty, true);
  assert.equal(a.isPending('text'), true);
  await sleep(90);
  assert.deepEqual(saves, [{ text: 'hello', title: 'T' }]);
  assert.equal(a.dirty, false);
  assert.equal(states.at(-1), 'saved');
  a.cancel();
});

test('flush saves at once, and waits for a save already running', async () => {
  const saves = [];
  let release = null;
  const a = screen.createAutosaver({ delay: 10_000, save: (v) => { saves.push(v); return new Promise((r) => { release = r; }); } });
  a.set('text', 'one');
  const f1 = a.flush();
  await tick();
  assert.equal(saves.length, 1);
  assert.equal(a.isPending('text'), true, 'in flight still counts as not saved');
  a.set('text', 'two');
  const f2 = a.flush();
  assert.equal(saves.length, 1, 'one save at a time');
  release();
  await f1;
  await tick();
  assert.deepEqual(saves[1], { text: 'two' });
  release();
  await f2;
  assert.equal(a.dirty, false);
  a.cancel();
});

test('a failed save keeps the words, says so, and the next flush saves them', async () => {
  let fail = true;
  const saved = [];
  const states = [];
  const a = screen.createAutosaver({
    delay: 10_000,
    save: async (v) => { if (fail) throw new Error('disk full'); saved.push(v); },
    onState: (s) => states.push(s),
  });
  a.set('text', 'keep me');
  await assert.rejects(a.flush(), /disk full/);
  assert.equal(states.at(-1), 'error');
  assert.equal(a.isPending('text'), true);
  assert.equal(a.failed, true);
  a.set('title', 'and me');
  fail = false;
  await a.flush();
  assert.deepEqual(saved, [{ text: 'keep me', title: 'and me' }]);
  assert.equal(a.failed, false);
  assert.equal(states.at(-1), 'saved');
  a.cancel();
});

test('tags reuse the spelling that exists; microphone problems are explained', () => {
  assert.equal(screen.cleanTag('  fire   blocking ', []), 'fire blocking');
  assert.equal(screen.cleanTag('walls', screen.FALLBACK_TAGS), 'Walls');
  assert.equal(screen.cleanTag('', ['Walls']), '');
  assert.equal(screen.cleanTag('x'.repeat(60)).length, 40);
  assert.equal(screen.FALLBACK_TAGS.length, 15);
  assert.match(screen.micErrorMessage({ name: 'NotAllowedError' }), /blocked/);
  assert.match(screen.micErrorMessage({ name: 'NotFoundError' }), /No microphone/);
  assert.match(screen.micErrorMessage({ name: 'NotReadableError' }), /busy/);
  assert.equal(screen.micErrorMessage(new Error('The microphone is in use by another app (a call?).')), 'The microphone is in use by another app (a call?).',
    "the recorder's own plain message is shown as it is");
  assert.match(screen.micErrorMessage(null), /could not start/);
  assert.equal(screen.typeLabel('video'), 'Video');
  assert.equal(screen.typeLabel('note'), 'Note');
  assert.equal(screen.typeLabel('photo'), 'Photo');
});
