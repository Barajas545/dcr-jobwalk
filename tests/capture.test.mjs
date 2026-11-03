// capture.test.mjs — js/core/capture.js on a fake IndexedDB: the pose
// snapshot, the save order (bytes before the item), what happens when a step
// fails, gallery imports with EXIF GPS, notes, and the upright maths.
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = await import('../js/core/store.js');
const { bus } = await import('../js/core/bus.js');
const { updateSettings } = await import('../js/core/settings.js');
const capture = await import('../js/core/capture.js');
const media = await import('../js/core/media.js');

const fakeThumb = async () => new Blob([new Uint8Array(64).fill(7)], { type: 'image/jpeg' });
const photoBlob = (n = 5000) => new Blob([new Uint8Array(n).map((_, i) => i % 251)], { type: 'image/jpeg' });

function fullPose(extra = {}) {
  return {
    t: 1_762_000_000_000,
    geo: { lat: 38.5816, lng: -121.4944, acc: 3.2, alt: 9.1, altAcc: 4, platform: 'android' },
    enu: { e: 12.345, n: -6.789 },
    plan: { x: 1234.5, y: 678.9 },
    planAcc: 41,
    planLocked: false,
    heading: 370,
    headingAcc: 8,
    planHeading: -20,
    pitch: -12.5,
    roll: 1.5,
    facing: 'camera',
    source: 'fused',
    quality: 'fair',
    magHeading: 0.5,
    declination: 13.4,
    headingSource: 'wmm',
    raw: { alpha: 10, beta: 85, gamma: 2, absolute: true, src: 'abs', compass: null, compassAcc: null, screenAngle: 0, t: 99, extraNum: 5, nested: { no: 1 } },
    zoom: null,
    fix: { lat: 38.58161, lng: -121.49441, acc: 4.8, alt: 10, altAcc: null, speed: 0.4, t: 1_761_999_999_500 },
    someFn: () => 1,
    ...extra,
  };
}

const POSE_KEYS = ['t', 'geo', 'enu', 'plan', 'planAcc', 'planLocked', 'heading', 'headingAcc', 'planHeading', 'pitch', 'roll',
  'facing', 'source', 'quality', 'magHeading', 'declination', 'headingSource', 'raw', 'zoom', 'fix'].sort();

// ---- snapshotPose ---------------------------------------------------------------------------

test('snapshotPose: every Pose field, plain values, angles folded, odd things dropped', () => {
  const level = { id: 'l_1', plan: { mediaId: 'm', width: 2000, height: 1000 } };
  const s = capture.snapshotPose(fullPose(), level);
  assert.deepEqual(Object.keys(s).sort(), POSE_KEYS);
  assert.equal(s.t, 1_762_000_000_000);
  assert.deepEqual(s.geo, { lat: 38.5816, lng: -121.4944, acc: 3.2, alt: 9.1, altAcc: 4, platform: 'android' });
  assert.deepEqual(s.enu, { e: 12.345, n: -6.789 });
  assert.deepEqual(s.plan, { x: 1234.5, y: 678.9 });
  assert.equal(s.heading, 10);
  assert.equal(s.planHeading, 340);
  assert.equal(s.raw.alpha, 10);
  assert.equal(s.raw.extraNum, 5, 'extra plain sensor values are kept');
  assert.equal('nested' in s.raw, false, 'objects inside raw are not');
  assert.equal(s.source, 'fused');
  assert.equal(s.quality, 'fair');
  assert.equal(s.headingSource, 'wmm');
  assert.deepEqual(s.fix, { lat: 38.58161, lng: -121.49441, acc: 4.8, alt: 10, altAcc: null, speed: 0.4, t: 1_761_999_999_500 }, 'the raw GPS fix is kept');
  // It is a copy: changing the live pose afterwards changes nothing.
  const live = fullPose();
  const snap = capture.snapshotPose(live, level);
  live.geo.lat = 0;
  live.plan.x = 0;
  assert.equal(snap.geo.lat, 38.5816);
  assert.equal(snap.plan.x, 1234.5);
  assert.doesNotThrow(() => structuredClone(snap));
});

test('snapshotPose: NaN and junk become null; unknown enums fall back; null pose is "no position"', () => {
  const s = capture.snapshotPose(fullPose({ pitch: NaN, heading: Infinity, source: 'warp', quality: 'great', facing: 'up', planLocked: 'yes', geo: { lat: NaN, lng: 1 } }));
  assert.equal(s.pitch, null);
  assert.equal(s.heading, null);
  assert.equal(s.source, 'none');
  assert.equal(s.quality, 'none');
  assert.equal(s.facing, 'camera');
  assert.equal(s.planLocked, false);
  assert.equal(s.geo, null);
  const e = capture.snapshotPose(null);
  assert.deepEqual(Object.keys(e).sort(), POSE_KEYS);
  assert.equal(e.source, 'none');
  assert.equal(e.quality, 'none');
  assert.ok(Math.abs(e.t - Date.now()) < 5000);
});

test('snapshotPose: plan spot dropped on a map-mode level or a pose for another level', () => {
  const mapLevel = { id: 'l_1', plan: null };
  const s = capture.snapshotPose(fullPose({ planLocked: true }), mapLevel);
  assert.equal(s.plan, null);
  assert.equal(s.planAcc, null);
  assert.equal(s.planLocked, false);
  assert.ok(s.geo, 'the GPS position stays');
  const other = capture.snapshotPose(fullPose({ levelId: 'l_2' }), { id: 'l_1', plan: { mediaId: 'm' } });
  assert.equal(other.plan, null);
  const same = capture.snapshotPose(fullPose({ levelId: 'l_1' }), { id: 'l_1', plan: { mediaId: 'm' } });
  assert.deepEqual(same.plan, { x: 1234.5, y: 678.9 });
});

// ---- savePhoto ----------------------------------------------------------------------------------

test('savePhoto saves the original (verified) BEFORE the thumbnail and the item', async () => {
  await updateSettings({ userName: 'Cris' });
  const p = await store.createProject({ name: 'Order' });
  const level = store.activeLevel(p);
  const events = [];
  const off = bus.on('store:change', (ev) => events.push(ev));
  const takenAt = Date.now() - 1000;
  const item = await capture.savePhoto({
    project: p, level, blob: photoBlob(), width: 4032, height: 3024,
    pose: fullPose(), source: 'camera', zoom: 2, takenAt,
    captureInfo: { method: 'takePhoto' }, deps: { makeThumb: fakeThumb },
  });
  off();
  const mine = events.filter((e) => e.projectId === p.id);
  const kinds = mine.map((e) => `${e.kind}:${e.action}`);
  assert.deepEqual(kinds, ['media:create', 'media:create', 'item:create']);
  assert.equal(item.type, 'photo');
  assert.equal(item.seq, 1);
  assert.equal(item.levelId, level.id);
  assert.equal(item.width, 4032);
  assert.equal(item.height, 3024);
  assert.equal(item.mimeType, 'image/jpeg');
  assert.equal(item.source, 'camera');
  assert.equal(item.capturedBy, 'Cris');
  assert.equal(item.createdAt, takenAt);
  assert.equal(item.pose.zoom, 2);
  assert.equal(item.pose.heading, 10);
  assert.equal(item.captureInfo.method, 'takePhoto');
  assert.equal(mine[0].id, item.media.original);
  assert.equal(mine[1].id, item.media.thumb);
  const orig = await store.getMediaRecord(item.media.original);
  assert.equal(orig.kind, 'original');
  assert.equal(orig.itemId, item.id, 'bytes belong to the item (so purge removes them)');
  assert.equal((await store.getMediaBlob(item.media.original)).size, 5000);
  assert.equal((await store.getMediaRecord(item.media.thumb)).kind, 'thumb');
  const back = await store.getItem(item.id);
  assert.equal(back.media.original, item.media.original);
});

test('a thumbnail that fails does not stop the photo being saved', async () => {
  const p = await store.createProject({ name: 'No thumb' });
  const warnings = [];
  const item = await capture.savePhoto({
    project: p, level: store.activeLevel(p), blob: photoBlob(), width: 100, height: 80, pose: null,
    onWarning: (m) => warnings.push(m),
    deps: { makeThumb: async () => { throw new Error('out of memory'); } },
  });
  assert.ok(item.media.original);
  assert.equal(item.media.thumb, null);
  assert.equal(item.pose.source, 'none');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /saved/);
});

test('when the item cannot be created, retry() finishes it without saving the bytes twice', async () => {
  const p = await store.createProject({ name: 'Retry' });
  let failsLeft = 2; // the first call and savePhoto's own quick second try
  let originals = 0;
  const flaky = {
    ...store,
    putMedia: (blob, meta) => { if (meta.kind === 'original') originals++; return store.putMedia(blob, meta); },
    createItem: (pid, fields) => (failsLeft-- > 0 ? Promise.reject(new Error('database busy')) : store.createItem(pid, fields)),
  };
  const blob = photoBlob(3000);
  const err = await capture.savePhoto({ project: p, level: store.activeLevel(p), blob, width: 10, height: 10, deps: { store: flaky, makeThumb: fakeThumb } })
    .then(() => null, (e) => e);
  assert.ok(err, 'it rejected');
  assert.match(err.message, /stored on the phone but could not be added/);
  assert.equal(err.savedOriginal, true);
  assert.equal(err.blob, blob, 'the bytes are handed back for a download');
  assert.equal(typeof err.retry, 'function');
  assert.equal((await store.listItems(p.id)).length, 0);
  const item = await err.retry();
  assert.equal(item.type, 'photo');
  assert.equal(originals, 1, 'the original was saved once');
  assert.equal((await store.listItems(p.id)).length, 1);
  assert.equal(item.id, err.itemId);
});

test('when the bytes cannot be saved, nothing is created and the photo is handed back', async () => {
  const p = await store.createProject({ name: 'Full' });
  let created = 0;
  const full = {
    ...store,
    putMedia: () => Promise.reject(Object.assign(new Error('The phone is out of storage space'), { name: 'QuotaExceededError' })),
    createItem: (...a) => { created++; return store.createItem(...a); },
  };
  const blob = photoBlob();
  const err = await capture.savePhoto({ project: p, level: null, blob, width: 10, height: 10, deps: { store: full, makeThumb: fakeThumb } }).then(() => null, (e) => e);
  assert.match(err.message, /NOT saved.*out of storage/);
  assert.equal(err.savedOriginal, false);
  assert.equal(err.blob, blob);
  assert.equal(err.stage, 'original');
  assert.equal(created, 0);
  assert.equal(capture.isStorageFull(err), true, 'the camera can tell the phone is full');
  await assert.rejects(capture.savePhoto({ project: p, blob: new Blob([]) }), /empty/);
});

test('isStorageFull: a full phone, also wrapped as the cause; other failures are not', () => {
  const quota = Object.assign(new Error('out of space'), { name: 'QuotaExceededError' });
  assert.equal(capture.isStorageFull(quota), true);
  assert.equal(capture.isStorageFull(Object.assign(new Error('The photo was NOT saved'), { cause: quota })), true);
  assert.equal(capture.isStorageFull(new Error('The phone closed the app\'s storage')), false);
  assert.equal(capture.isStorageFull(Object.assign(new Error('x'), { cause: new Error('y') })), false);
  assert.equal(capture.isStorageFull(null), false);
  assert.equal(capture.isStorageFull('QuotaExceededError'), false);
});

test('a photo larger than the size setting is shrunk; if shrinking fails the full photo is kept', async () => {
  await updateSettings({ photoMaxSize: 4032, photoQuality: 0.9 });
  const p = await store.createProject({ name: 'Resize' });
  const small = new Blob([new Uint8Array(1234)], { type: 'image/jpeg' });
  let asked = null;
  const item = await capture.savePhoto({
    project: p, level: store.activeLevel(p), blob: photoBlob(9000), width: 8064, height: 6048,
    deps: { makeThumb: fakeThumb, resizeImage: async (b, o) => { asked = o; return { blob: small, width: 4032, height: 3024, resized: true }; } },
  });
  assert.deepEqual(asked, { maxSide: 4032, quality: 0.9 });
  assert.equal(item.width, 4032);
  assert.equal(item.height, 3024);
  assert.equal((await store.getMediaBlob(item.media.original)).size, 1234);
  const kept = await capture.savePhoto({
    project: p, level: store.activeLevel(p), blob: photoBlob(9000), width: 8064, height: 6048,
    deps: { makeThumb: fakeThumb, resizeImage: async () => { throw new Error('no memory'); } },
  });
  assert.equal(kept.width, 8064);
  assert.equal((await store.getMediaBlob(kept.media.original)).size, 9000);
});

test('device-camera photos keep where the phone was when the camera opened', async () => {
  const p = await store.createProject({ name: 'Device' });
  const item = await capture.savePhoto({
    project: p, level: store.activeLevel(p), blob: photoBlob(), width: 10, height: 10,
    pose: fullPose(), poseAtOpen: fullPose({ heading: 90 }), source: 'device-camera', deps: { makeThumb: fakeThumb },
  });
  assert.equal(item.source, 'device-camera');
  assert.equal(item.poseAtOpen.heading, 90);
  assert.equal(item.pose.heading, 10);
});

// ---- imports ---------------------------------------------------------------------------------------

function seg(marker, data) {
  const b = new Uint8Array(4 + data.length);
  b[0] = 0xFF; b[1] = marker;
  new DataView(b.buffer).setUint16(2, data.length + 2);
  b.set(data, 4);
  return b;
}
function cat(...parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
/** A small little-endian EXIF with GPS + DateTimeOriginal, wrapped in a JPEG-shaped file. */
function jpegWithGps({ lat, lng, when, width = 1600, height = 1200 }) {
  const b = new Uint8Array(400);
  const dv = new DataView(b.buffer);
  const le = true;
  b.set([0x49, 0x49], 0); dv.setUint16(2, 42, le); dv.setUint32(4, 8, le);
  // IFD0 @8: 2 entries (ExifIFD, GPS IFD)
  dv.setUint16(8, 2, le);
  const ent = (p, tag, type, count, value) => { dv.setUint16(p, tag, le); dv.setUint16(p + 2, type, le); dv.setUint32(p + 4, count, le); dv.setUint32(p + 8, value, le); };
  ent(10, 0x8769, 4, 1, 50);
  ent(22, 0x8825, 4, 1, 100);
  dv.setUint32(34, 0, le);
  // Exif IFD @50: DateTimeOriginal → @300
  dv.setUint16(50, 1, le);
  ent(52, 0x9003, 2, 20, 300);
  dv.setUint32(64, 0, le);
  for (let i = 0; i < 19; i++) b[300 + i] = when.charCodeAt(i);
  // GPS IFD @100: refs inline, lat @200, lng @224
  dv.setUint16(100, 4, le);
  ent(102, 0x0001, 2, 2, 0); b[110] = lat >= 0 ? 0x4E : 0x53;
  ent(114, 0x0002, 5, 3, 200);
  ent(126, 0x0003, 2, 2, 0); b[134] = lng >= 0 ? 0x45 : 0x57;
  ent(138, 0x0004, 5, 3, 224);
  dv.setUint32(150, 0, le);
  const put = (off, deg) => {
    dv.setUint32(off, Math.round(Math.abs(deg) * 1e6), le); dv.setUint32(off + 4, 1e6, le);
    dv.setUint32(off + 8, 0, le); dv.setUint32(off + 12, 1, le);
    dv.setUint32(off + 16, 0, le); dv.setUint32(off + 20, 1, le);
  };
  put(200, lat);
  put(224, lng);
  const sof = new Uint8Array(15);
  const sv = new DataView(sof.buffer);
  sof[0] = 8; sv.setUint16(1, height); sv.setUint16(3, width); sof[5] = 3;
  return cat(new Uint8Array([0xFF, 0xD8]), seg(0xE1, cat(new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0]), b)), seg(0xC0, sof),
    seg(0xDA, new Uint8Array([3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3F, 0])), new Uint8Array(300).fill(0x11), new Uint8Array([0xFF, 0xD9]));
}

test('importPhotos: EXIF GPS becomes a poor-quality pose with east/north and a plan spot; numbered by when taken', async () => {
  let p = await store.createProject({ name: 'Import' });
  await store.setOriginOnce(p.id, { lat: 38.58, lng: -121.49 });
  const lid = p.activeLevelId;
  // A calibration that maps 1 m east → +10 px x, 1 m north → −10 px y, origin at (500, 500).
  await store.updateLevel(p.id, lid, (l) => {
    l.plan = { mediaId: 'm_plan', width: 1000, height: 1000 };
    l.calibration = { version: 1, toPlan: [10, 0, 0, -10, 500, 500], toEnu: [0.1, 0, 0, -0.1, -50, 50], pxPerMeter: 10, northAngle: 0 };
  });
  p = await store.getProject(p.id);
  const level = store.activeLevel(p);
  const later = new File([jpegWithGps({ lat: 38.5801, lng: -121.4899, when: '2026:11:02 10:45:00' })], 'IMG_0002.JPG', { type: 'image/jpeg', lastModified: 1 });
  const earlier = new File([jpegWithGps({ lat: 38.5800, lng: -121.4900, when: '2026:11:02 10:30:00' })], 'IMG_0001.JPG', { type: 'image/jpeg', lastModified: 2 });
  const notPhoto = new File(['hello'], 'notes.txt', { type: 'text/plain' });
  const progress = [];
  const items = await capture.importPhotos([later, notPhoto, earlier], {
    project: p, level, onProgress: (x) => progress.push(x), deps: { makeThumb: fakeThumb },
  });
  assert.equal(items.length, 2);
  assert.equal(items.errors.length, 1);
  assert.equal(items.errors[0].fileName, 'notes.txt');
  assert.equal(items[0].fileName, 'IMG_0001.JPG', 'the earlier photo gets the lower number');
  assert.ok(items[0].seq < items[1].seq);
  const a = items[0];
  assert.equal(a.source, 'import');
  assert.equal(a.createdAt, new Date(2026, 10, 2, 10, 30, 0).getTime());
  assert.equal(a.width, 1600);
  assert.equal(a.height, 1200);
  assert.equal(a.pose.quality, 'poor');
  assert.equal(a.pose.source, 'gps');
  assert.ok(Math.abs(a.pose.geo.lat - 38.58) < 1e-9);
  assert.ok(a.pose.enu, 'east/north from the job walk origin');
  assert.ok(Math.abs(a.pose.enu.n) < 0.5 && Math.abs(a.pose.enu.e - -0.0) < 1, `enu ${JSON.stringify(a.pose.enu)}`);
  // 0.0001° east ≈ 8.7 m → x ≈ 500 + 87
  const b = items[1];
  assert.ok(b.pose.enu.e > 8 && b.pose.enu.e < 9.5, `east ${b.pose.enu.e}`);
  assert.ok(Math.abs(b.pose.plan.x - (500 + b.pose.enu.e * 10)) < 1e-6);
  assert.ok(Math.abs(b.pose.plan.y - (500 - b.pose.enu.n * 10)) < 1e-6);
  // The bytes are kept as they were (EXIF included).
  const bytes = new Uint8Array(await (await store.getMediaBlob(a.media.original)).arrayBuffer());
  assert.ok(Math.abs(media.parseExif(bytes).lat - 38.58) < 1e-9);
  assert.equal(progress.at(-1).done, 3);
});

test('importPhotos: a photo without GPS is saved with no position; all failing rejects with the reasons', async () => {
  const p = await store.createProject({ name: 'Import 2' });
  const plainJpeg = cat(new Uint8Array([0xFF, 0xD8]), seg(0xC0, new Uint8Array([8, 0, 100, 0, 200, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])),
    seg(0xDA, new Uint8Array([3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3F, 0])), new Uint8Array(50), new Uint8Array([0xFF, 0xD9]));
  const items = await capture.importPhotos([new File([plainJpeg], 'scan.jpg', { type: 'image/jpeg', lastModified: 1_700_000_000_000 })], {
    project: p, level: store.activeLevel(p), deps: { makeThumb: fakeThumb },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].pose.geo, null);
  assert.equal(items[0].pose.quality, 'none');
  assert.equal(items[0].createdAt, 1_700_000_000_000);
  assert.equal(items[0].width, 200);
  await assert.rejects(
    capture.importPhotos([new File(['x'], 'a.txt'), new File(['y'], 'b.doc')], { project: p, level: null }),
    (err) => err.errors.length === 2 && /None of the 2 photos/.test(err.message));
});

test('poseFromExif: magnetic direction is turned true only with a known declination', async () => {
  const mag = await capture.poseFromExif({ lat: 10, lng: 20, heading: 100, headingRef: 'M' }, { declination: 13 });
  assert.equal(mag.magHeading, 100);
  assert.equal(mag.heading, 113);
  assert.equal(mag.headingSource, 'setting');
  const unknown = await capture.poseFromExif({ lat: 10, lng: 20, heading: 100, headingRef: 'M' });
  assert.equal(unknown.heading, null);
  const tru = await capture.poseFromExif({ lat: 10, lng: 20, heading: 100, headingRef: 'T', takenAt: 5 });
  assert.equal(tru.heading, 100);
  assert.equal(tru.t, 5);
  assert.equal(tru.enu, null, 'no origin, no east/north');
});

// ---- notes -------------------------------------------------------------------------------------

test('saveNote: a note item with its text and position', async () => {
  const p = await store.createProject({ name: 'Notes' });
  const level = store.activeLevel(p);
  const n = await capture.saveNote({ project: p, level, pose: fullPose(), text: 'Header over garage is 4x12', title: 'Garage', tags: ['Headers/Beams', '', 5] });
  assert.equal(n.type, 'note');
  assert.equal(n.text, 'Header over garage is 4x12');
  assert.equal(n.title, 'Garage');
  assert.deepEqual(n.tags, ['Headers/Beams']);
  assert.equal(n.levelId, level.id);
  assert.equal(n.pose.geo.lat, 38.5816);
  assert.equal((await store.getItem(n.id)).text, 'Header over garage is 4x12');
});

// ---- upright ---------------------------------------------------------------------------------------

test('uprightCorrection: how far a picture must turn, from the phone tilt and the screen', () => {
  const near = (o, deviceAngle, extraCW) => { assert.ok(o); assert.equal(o.deviceAngle, deviceAngle); assert.equal(o.extraCW, extraCW); };
  near(capture.uprightCorrection({ beta: 90, gamma: 0, screenAngle: 0 }), 0, 0);          // upright portrait
  near(capture.uprightCorrection({ beta: 0, gamma: -90, screenAngle: 0 }), 90, 270);      // top edge left, screen stuck in portrait
  near(capture.uprightCorrection({ beta: 0, gamma: -90, screenAngle: 90 }), 90, 0);       // …and the screen turned with it
  near(capture.uprightCorrection({ beta: 0, gamma: 90, screenAngle: 0 }), 270, 90);       // top edge right
  near(capture.uprightCorrection({ beta: -90, gamma: 0, screenAngle: 0 }), 180, 180);     // upside down
  near(capture.uprightCorrection({ beta: 70, gamma: 10, screenAngle: 0 }), 0, 0);         // a bit tilted is still portrait
  assert.equal(capture.uprightCorrection({ beta: 5, gamma: 3, screenAngle: 0 }), null);  // flat: can't tell
  assert.equal(capture.uprightCorrection({ beta: 45, gamma: -60 }), null);                // diagonal: can't tell
  assert.equal(capture.uprightCorrection({}), null);
});

test('holdAngle: portrait 0, top edge left 90, upside down 180, top edge right 270; weak when flat', () => {
  const a = (beta, gamma) => capture.holdAngle({ beta, gamma });
  assert.equal(Math.round(a(90, 0).angle), 0);
  assert.equal(Math.round(a(0, -90).angle), 90);
  assert.equal(Math.round(a(-90, 0).angle), 180);
  assert.equal(Math.round(a(0, 90).angle), 270);
  assert.ok(a(90, 0).strength > 0.99);
  assert.ok(a(2, 1).strength < 0.05);
  assert.equal(capture.holdAngle({ beta: null, gamma: 3 }), null);
});
