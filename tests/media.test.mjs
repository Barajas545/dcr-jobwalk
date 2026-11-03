// media.test.mjs — the pure parts of js/core/media.js: EXIF and JPEG header
// parsing (with hand-built bytes, damaged ones included), orientation
// patching, size maths and recording-format choice.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const media = await import('../js/core/media.js');

// ---- byte builders -----------------------------------------------------------------------

const TSIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function encodeValues(e, le) {
  const { type, values } = e;
  if (type === 2) {
    const s = String(values);
    const b = new Uint8Array(s.length + 1);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  }
  const n = type === 5 || type === 10 ? values.length / 2 : values.length;
  const b = new Uint8Array(TSIZE[type] * n);
  const dv = new DataView(b.buffer);
  values.forEach((v, i) => {
    if (type === 1 || type === 7) dv.setUint8(i, v);
    else if (type === 3) dv.setUint16(i * 2, v, le);
    else if (type === 4) dv.setUint32(i * 4, v, le);
    else if (type === 9) dv.setInt32(i * 4, v, le);
    else if (type === 5) dv.setUint32(i * 4, v, le);
    else if (type === 10) dv.setInt32(i * 4, v, le);
  });
  return b;
}

/** A TIFF block: IFD0 (+ Exif IFD + GPS IFD), offsets computed. Entries: {tag, type, values}. */
function buildTiff({ le = true, ifd0 = [], exif = null, gps = null }) {
  const ifds = [{ name: 'ifd0', entries: ifd0.map((e) => ({ ...e })) }];
  if (exif) ifds.push({ name: 'exif', entries: exif.map((e) => ({ ...e })) });
  if (gps) ifds.push({ name: 'gps', entries: gps.map((e) => ({ ...e })) });
  if (exif) ifds[0].entries.push({ tag: 0x8769, type: 4, values: [0], ptr: 'exif' });
  if (gps) ifds[0].entries.push({ tag: 0x8825, type: 4, values: [0], ptr: 'gps' });
  for (const ifd of ifds) ifd.entries.sort((a, b) => a.tag - b.tag);
  let off = 8;
  for (const ifd of ifds) { ifd.offset = off; off += 2 + ifd.entries.length * 12 + 4; }
  for (const ifd of ifds) {
    for (const e of ifd.entries) {
      if (e.ptr) e.values = [ifds.find((x) => x.name === e.ptr).offset];
      e.bytes = encodeValues(e, le);
      if (e.bytes.length > 4) { e.dataOffset = off; off += e.bytes.length + (e.bytes.length % 2); }
    }
  }
  const out = new Uint8Array(off);
  const dv = new DataView(out.buffer);
  out.set(le ? [0x49, 0x49] : [0x4D, 0x4D], 0);
  dv.setUint16(2, 42, le);
  dv.setUint32(4, 8, le);
  for (const ifd of ifds) {
    let p = ifd.offset;
    dv.setUint16(p, ifd.entries.length, le);
    p += 2;
    for (const e of ifd.entries) {
      const count = e.type === 2 ? e.bytes.length : (e.type === 5 || e.type === 10 ? e.values.length / 2 : e.values.length);
      dv.setUint16(p, e.tag, le);
      dv.setUint16(p + 2, e.type, le);
      dv.setUint32(p + 4, count, le);
      if (e.bytes.length > 4) {
        dv.setUint32(p + 8, e.dataOffset, le);
        out.set(e.bytes, e.dataOffset);
      } else {
        out.set(e.bytes, p + 8);
      }
      p += 12;
    }
    dv.setUint32(p, 0, le);
  }
  return out;
}

function segment(marker, data) {
  const b = new Uint8Array(4 + data.length);
  b[0] = 0xFF;
  b[1] = marker;
  new DataView(b.buffer).setUint16(2, data.length + 2);
  b.set(data, 4);
  return b;
}

function concat(...parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function sof(width, height) {
  const d = new Uint8Array(15);
  const dv = new DataView(d.buffer);
  d[0] = 8;
  dv.setUint16(1, height);
  dv.setUint16(3, width);
  d[5] = 3;
  d.set([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], 6);
  return segment(0xC0, d);
}

/** A JPEG-shaped file: SOI, [APP0], [APP1 Exif], [extra segments], SOF0, SOS, some "image" bytes, EOI. */
function buildJpeg({ tiff = null, width = 4032, height = 3024, app0 = true, before = [], imageBytes = 200 } = {}) {
  const parts = [new Uint8Array([0xFF, 0xD8])];
  if (app0) parts.push(segment(0xE0, new Uint8Array([0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])));
  for (const b of before) parts.push(b);
  if (tiff) parts.push(segment(0xE1, concat(new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0]), tiff)));
  parts.push(sof(width, height));
  parts.push(segment(0xDA, new Uint8Array([3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3F, 0])));
  const img = new Uint8Array(imageBytes);
  for (let i = 0; i < img.length; i++) img[i] = (i * 37 + 11) & 0x7F; // never 0xFF
  parts.push(img, new Uint8Array([0xFF, 0xD9]));
  return concat(...parts);
}

const dms = (deg) => {
  const d = Math.floor(deg);
  const mFull = (deg - d) * 60;
  const m = Math.floor(mFull);
  const s = Math.round((mFull - m) * 60 * 10000);
  return [d, 1, m, 1, s, 10000];
};

function iphoneTiff({ le = true, lat = 38.5816, lng = -121.4944, alt = 9.5, altRef = 0, orientation = 6, dto = '2026:11:02 10:32:15', offset = '-08:00', subsec = '250', heading = 123.45, hpe = 4.2 } = {}) {
  return buildTiff({
    le,
    ifd0: [
      { tag: 0x010F, type: 2, values: 'Apple' },
      { tag: 0x0110, type: 2, values: 'iPhone 15 Pro' },
      { tag: 0x0112, type: 3, values: [orientation] },
      { tag: 0x0132, type: 2, values: '2026:11:02 10:40:00' },
    ],
    exif: [
      { tag: 0x9003, type: 2, values: dto },
      ...(offset ? [{ tag: 0x9011, type: 2, values: offset }] : []),
      ...(subsec ? [{ tag: 0x9291, type: 2, values: subsec }] : []),
    ],
    gps: [
      { tag: 0x0001, type: 2, values: lat >= 0 ? 'N' : 'S' },
      { tag: 0x0002, type: 5, values: dms(Math.abs(lat)) },
      { tag: 0x0003, type: 2, values: lng >= 0 ? 'E' : 'W' },
      { tag: 0x0004, type: 5, values: dms(Math.abs(lng)) },
      { tag: 0x0005, type: 1, values: [altRef] },
      { tag: 0x0006, type: 5, values: [Math.round(alt * 100), 100] },
      { tag: 0x0010, type: 2, values: 'T' },
      { tag: 0x0011, type: 5, values: [Math.round(heading * 100), 100] },
      { tag: 0x001F, type: 5, values: [Math.round(hpe * 1000), 1000] },
    ],
  });
}

// ---- EXIF ---------------------------------------------------------------------------------

test('an iPhone-style EXIF (little-endian) gives position, altitude, accuracy, direction, time and rotation', () => {
  const jpeg = buildJpeg({ tiff: iphoneTiff() });
  const x = media.parseExif(jpeg);
  assert.ok(x);
  assert.ok(Math.abs(x.lat - 38.5816) < 1e-6, `lat ${x.lat}`);
  assert.ok(Math.abs(x.lng - -121.4944) < 1e-6, `lng ${x.lng}`);
  assert.equal(x.alt, 9.5);
  assert.ok(Math.abs(x.acc - 4.2) < 1e-9);
  assert.ok(Math.abs(x.heading - 123.45) < 1e-9);
  assert.equal(x.headingRef, 'T');
  assert.equal(x.orientation, 6);
  assert.equal(x.make, 'Apple');
  assert.equal(x.model, 'iPhone 15 Pro');
  // 10:32:15.250 at UTC−8 = 18:32:15.250 UTC
  assert.equal(x.takenAt, Date.UTC(2026, 10, 2, 18, 32, 15, 250));
});

test('big-endian EXIF, south/west, below sea level, no time zone (local time)', () => {
  const jpeg = buildJpeg({ tiff: iphoneTiff({ le: false, lat: -33.8568, lng: -151.2153 + 0, alt: 12.25, altRef: 1, orientation: 1, offset: null, subsec: null }) });
  const x = media.parseExif(jpeg);
  assert.ok(Math.abs(x.lat - -33.8568) < 1e-6);
  assert.ok(Math.abs(x.lng - -151.2153) < 1e-6);
  assert.equal(x.alt, -12.25);
  assert.equal(x.orientation, 1);
  assert.equal(x.takenAt, new Date(2026, 10, 2, 10, 32, 15).getTime());
});

test('readExif works on a Blob, also when big segments push EXIF past the first read', async () => {
  const big = [];
  for (let i = 0; i < 5; i++) big.push(segment(0xE2, new Uint8Array(60000)));
  const jpeg = buildJpeg({ tiff: iphoneTiff(), before: big });
  assert.ok(jpeg.length > 256 * 1024);
  const x = await media.readExif(new Blob([jpeg], { type: 'image/jpeg' }));
  assert.ok(x && Math.abs(x.lat - 38.5816) < 1e-6);
  const info = await media.readJpegInfo(new Blob([jpeg]));
  assert.deepEqual([info.width, info.height], [3024, 4032]);
});

test('GPS 0,0 (no fix) is no position; no EXIF is null; not a JPEG is null', async () => {
  const x = media.parseExif(buildJpeg({ tiff: iphoneTiff({ lat: 0, lng: 0 }) }));
  assert.equal(x.lat, null);
  assert.equal(x.lng, null);
  assert.equal(x.orientation, 6);
  assert.equal(media.parseExif(buildJpeg({ tiff: null })), null);
  assert.equal(media.parseExif(new Uint8Array([1, 2, 3, 4, 5, 6])), null);
  assert.equal(await media.readExif(new Blob(['hello world, not a photo'])), null);
  assert.equal(await media.readExif(new Blob([])), null);
});

test('the GPS clock is used when there is no original time', () => {
  const tiff = buildTiff({
    ifd0: [{ tag: 0x0112, type: 3, values: [1] }],
    gps: [
      { tag: 0x0001, type: 2, values: 'N' }, { tag: 0x0002, type: 5, values: dms(10) },
      { tag: 0x0003, type: 2, values: 'E' }, { tag: 0x0004, type: 5, values: dms(20) },
      { tag: 0x0007, type: 5, values: [18, 1, 5, 1, 30, 1] },
      { tag: 0x001D, type: 2, values: '2026:11:02' },
    ],
  });
  const x = media.parseExif(buildJpeg({ tiff }));
  assert.equal(x.takenAt, Date.UTC(2026, 10, 2, 18, 5, 30));
  assert.equal(x.alt, null);
});

test('damaged EXIF never throws or hangs: truncation, bad offsets, loops, zero denominators', () => {
  const good = buildJpeg({ tiff: iphoneTiff() });
  for (let n = 0; n < good.length; n += 7) {
    assert.doesNotThrow(() => media.parseExif(good.slice(0, n)));
    assert.doesNotThrow(() => media.parseJpegInfo(good.slice(0, n)));
  }
  // Random garbage after a JPEG start.
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let k = 0; k < 200; k++) {
    const junk = new Uint8Array(400);
    for (let i = 0; i < junk.length; i++) junk[i] = Math.floor(rnd() * 256);
    junk.set([0xFF, 0xD8, 0xFF, 0xE1, 0x01, 0x80, 0x45, 0x78, 0x69, 0x66, 0, 0], 0);
    assert.doesNotThrow(() => media.parseExif(junk));
  }
  // An IFD whose "next" pointers loop back on themselves.
  const loop = buildTiff({ ifd0: [{ tag: 0x0112, type: 3, values: [3] }, { tag: 0x8769, type: 4, values: [8] }, { tag: 0x8825, type: 4, values: [8] }] });
  const x = media.parseExif(buildJpeg({ tiff: loop }));
  assert.equal(x.orientation, 3);
  assert.equal(x.lat, null);
  // Offsets far past the end and a rational with a zero denominator.
  const bad = buildTiff({
    ifd0: [{ tag: 0x0112, type: 3, values: [6] }],
    gps: [
      { tag: 0x0001, type: 2, values: 'N' }, { tag: 0x0002, type: 5, values: [38, 0, 0, 1, 0, 1] },
      { tag: 0x0003, type: 2, values: 'W' }, { tag: 0x0004, type: 5, values: dms(121) },
      { tag: 0x0006, type: 5, values: [100, 0] },
    ],
  });
  const xb = media.parseExif(buildJpeg({ tiff: bad }));
  assert.equal(xb.lat, null, 'a zero denominator for degrees means no position');
  const corrupt = bad.slice();
  new DataView(corrupt.buffer).setUint32(4, 0x7fffff00, true); // IFD0 offset way out of range
  assert.equal(media.parseExif(buildJpeg({ tiff: corrupt })), null);
});

test('EXIF dates: zones, sub-seconds and junk', () => {
  assert.equal(media.parseExifDate('2026:11:02 10:00:00', '+02:00'), Date.UTC(2026, 10, 2, 8, 0, 0));
  assert.equal(media.parseExifDate('2026:11:02 10:00:00', '+0530', '5'), Date.UTC(2026, 10, 2, 4, 30, 0, 500));
  assert.equal(media.parseExifDate('0000:00:00 00:00:00'), null);
  assert.equal(media.parseExifDate('    '), null);
  assert.equal(media.parseExifDate(null), null);
});

// ---- JPEG header and orientation ------------------------------------------------------------

test('JPEG size comes from the header, turned by the EXIF orientation', () => {
  const plain = media.parseJpegInfo(buildJpeg({ width: 4032, height: 3024 }));
  assert.deepEqual(plain, { width: 4032, height: 3024, rawWidth: 4032, rawHeight: 3024, orientation: 1 });
  const turned = media.parseJpegInfo(buildJpeg({ tiff: iphoneTiff({ orientation: 6 }), width: 4032, height: 3024 }));
  assert.equal(turned.width, 3024);
  assert.equal(turned.height, 4032);
  assert.equal(turned.orientation, 6);
  assert.equal(media.parseJpegInfo(new Uint8Array([0x89, 0x50])), null);
});

test('PNG size from its header', () => {
  const png = new Uint8Array(33);
  const dv = new DataView(png.buffer);
  png.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0);
  dv.setUint32(16, 1920);
  dv.setUint32(20, 1080);
  assert.deepEqual(media.parsePngSize(png), { width: 1920, height: 1080, rawWidth: 1920, rawHeight: 1080, orientation: 1 });
  assert.equal(media.parsePngSize(new Uint8Array(10)), null);
});

test('setJpegOrientation patches the tag in place and keeps every image byte', async () => {
  const jpeg = buildJpeg({ tiff: iphoneTiff({ orientation: 1 }) });
  const out = await media.setJpegOrientation(new Blob([jpeg], { type: 'image/jpeg' }), 8);
  assert.ok(out);
  assert.equal(out.size, jpeg.length);
  assert.equal(out.type, 'image/jpeg');
  const bytes = new Uint8Array(await out.arrayBuffer());
  assert.equal(media.parseExif(bytes).orientation, 8);
  assert.equal(media.parseExif(bytes).model, 'iPhone 15 Pro');
  let diff = 0;
  for (let i = 0; i < jpeg.length; i++) if (jpeg[i] !== bytes[i]) diff++;
  assert.ok(diff <= 2, `only the orientation value changes (${diff} bytes)`);
  const info = media.parseJpegInfo(bytes);
  assert.deepEqual([info.width, info.height], [3024, 4032]);
});

test('setJpegOrientation adds EXIF to a canvas JPEG that has none', async () => {
  const jpeg = buildJpeg({ tiff: null, width: 1280, height: 960 });
  const out = await media.setJpegOrientation(new Blob([jpeg], { type: 'image/jpeg' }), 6);
  const bytes = new Uint8Array(await out.arrayBuffer());
  assert.equal(bytes.length, jpeg.length + 36);
  assert.equal(media.parseExif(bytes).orientation, 6);
  const info = media.parseJpegInfo(bytes);
  assert.deepEqual([info.width, info.height], [960, 1280]);
  // the image data after the header is untouched
  assert.deepEqual(bytes.slice(-50), jpeg.slice(-50));
  // not a JPEG
  assert.equal(await media.setJpegOrientation(new Blob(['nope']), 6), null);
  // EXIF with no orientation tag: left alone (null)
  const noTag = buildJpeg({ tiff: buildTiff({ ifd0: [{ tag: 0x010F, type: 2, values: 'X' }] }) });
  assert.equal(await media.setJpegOrientation(new Blob([noTag]), 6), null);
});

test('orientation arithmetic', () => {
  assert.equal(media.rotationOfOrientation(1), 0);
  assert.equal(media.rotationOfOrientation(6), 90);
  assert.equal(media.rotationOfOrientation(3), 180);
  assert.equal(media.rotationOfOrientation(8), 270);
  assert.equal(media.rotationOfOrientation(2), null);
  assert.equal(media.composeOrientation(1, 270), 8);
  assert.equal(media.composeOrientation(6, 90), 3);
  assert.equal(media.composeOrientation(8, 90), 1);
  assert.equal(media.composeOrientation(5, 90), null);
  assert.equal(media.orientationOfRotation(-90), 8);
});

// ---- sizes ------------------------------------------------------------------------------------

test('scaleToFit keeps the shape, never enlarges, respects the iOS canvas area', () => {
  assert.deepEqual(media.scaleToFit(8064, 6048, 4032), { width: 4032, height: 3024, scale: 0.5 });
  assert.deepEqual(media.scaleToFit(1000, 500, 4032), { width: 1000, height: 500, scale: 1 });
  const big = media.scaleToFit(5000, 5000, Infinity, media.IOS_SAFE_CANVAS_AREA);
  assert.ok(big.width * big.height <= media.IOS_SAFE_CANVAS_AREA);
  assert.ok(big.width >= 4095);
  assert.deepEqual(media.scaleToFit(0, 10, 100), { width: 0, height: 0, scale: 1 });
  const th = media.scaleToFit(3024, 4032, 400);
  assert.deepEqual([th.width, th.height], [300, 400]);
});

// ---- formats ----------------------------------------------------------------------------------

test('pickVideoMime: H.264/AAC MP4 first, WebM next, nothing when unsupported', () => {
  const only = (ok) => ({ isTypeSupported: (t) => ok.includes(t) });
  assert.equal(media.pickVideoMime(only(media.VIDEO_MIME_CANDIDATES)), 'video/mp4;codecs=avc1.640028,mp4a.40.2');
  // Chrome with only a Baseline H.264 encoder
  assert.equal(media.pickVideoMime(only(['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'video/webm;codecs=vp8,opus'])), 'video/mp4;codecs=avc1.42E01F,mp4a.40.2');
  // WebKit accepts any avc1… prefix; the plain one is tried after the profiles
  assert.equal(media.pickVideoMime(only(['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'])), 'video/mp4;codecs=avc1,mp4a.40.2');
  // Chrome without an H.264 encoder
  assert.equal(media.pickVideoMime(only(['video/webm;codecs=vp8,opus', 'video/webm'])), 'video/webm;codecs=vp8,opus');
  // Never a bare 'video/mp4' (Chrome may put VP9 in it): the browser default instead
  assert.equal(media.pickVideoMime(only(['video/mp4', 'video/webm'])), '');
  assert.ok(!media.VIDEO_MIME_CANDIDATES.includes('video/mp4'));
  assert.equal(media.pickVideoMime(only([])), '');
  assert.equal(media.pickVideoMime({ isTypeSupported: () => { throw new Error('boom'); } }), '');
  assert.equal(media.pickVideoMime(undefined), '');
  assert.equal(media.pickVideoMime({}), '');
  for (const t of media.VIDEO_MIME_CANDIDATES) assert.ok(!/h264|aac/i.test(t), 'WebKit rejects h264/aac names');
});

test('pickAudioMime: AAC (.m4a) first, then Opus', () => {
  const only = (ok) => ({ isTypeSupported: (t) => ok.includes(t) });
  assert.equal(media.pickAudioMime(only(['audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus'])), 'audio/mp4;codecs=mp4a.40.2');
  assert.equal(media.pickAudioMime(only(['audio/mp4', 'audio/webm;codecs=opus'])), 'audio/webm;codecs=opus', 'explicit Opus before a bare mp4');
  assert.equal(media.pickAudioMime(only(['audio/mp4'])), 'audio/mp4');
  assert.equal(media.pickAudioMime(only(['audio/webm;codecs=opus', 'audio/webm'])), 'audio/webm;codecs=opus');
  assert.equal(media.pickAudioMime(only(['audio/ogg;codecs=opus'])), 'audio/ogg;codecs=opus');
  assert.equal(media.pickAudioMime(null), '');
});

test('file extensions and base types', () => {
  assert.equal(media.baseMime('video/mp4;codecs=avc1,mp4a.40.2'), 'video/mp4');
  assert.equal(media.extForMime('video/mp4;codecs=avc1'), 'mp4');
  assert.equal(media.extForMime('video/webm;codecs=vp9,opus'), 'webm');
  assert.equal(media.extForMime('audio/mp4'), 'm4a');
  assert.equal(media.extForMime('audio/ogg;codecs=opus'), 'ogg');
  assert.equal(media.extForMime('image/jpeg'), 'jpg');
  assert.equal(media.extForMime('application/x-nope'), 'bin');
});

test('withTimeout rejects a promise that never settles, passes one that does', async () => {
  await assert.rejects(media.withTimeout(new Promise(() => {}), 30, 'too slow'), /too slow/);
  assert.equal(await media.withTimeout(Promise.resolve(7), 1000), 7);
});
