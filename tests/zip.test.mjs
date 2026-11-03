// zip.test.mjs — js/core/zip.js: the writer, the reader, CRC-32 and ZIP64.
//
// A backup the phone writes must open in every unzip tool, and a zip made
// by another tool (someone unzipped the backup and zipped it again) must
// import. So besides round trips, these tests hand our zips to Python's
// zipfile (when Python is installed) and read zips that Python made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

const zip = await import('../js/core/zip.js');
const { createZipWriter, readZip, crc32, crc32Blob, sanitizeName, dosDateTime, fromDosDateTime, mimeFromName } = zip;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jw-zip-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function randomBytes(n, seed = 1) {
  const b = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b[i] = x & 0xff; }
  return b;
}

async function bytesOf(blob) { return new Uint8Array(await blob.arrayBuffer()); }

function findPython() {
  for (const cmd of ['python3', 'python']) {
    try {
      const r = spawnSync(cmd, ['-I', '-c', 'import sys, zipfile; print(sys.version_info[0], sys.version_info[1])'], { encoding: 'utf8', timeout: 20000 });
      if (r.status === 0) {
        const [maj, min] = r.stdout.trim().split(' ').map(Number);
        if (maj === 3 && min >= 8) return cmd;
      }
    } catch { /* not installed */ }
  }
  return null;
}
const PYTHON = findPython();

function python(code, ...args) {
  const r = spawnSync(PYTHON, ['-I', '-c', code, ...args], { encoding: 'utf8', timeout: 120000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  if (r.status !== 0) throw new Error(`python failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

const PY_READ = `
import sys, zipfile, json
with zipfile.ZipFile(sys.argv[1]) as z:
    bad = z.testzip()
    infos = z.infolist()
    out = {'bad': bad, 'count': len(infos), 'first': [], 'comment': z.comment.decode('utf-8', 'replace')}
    for i in infos[:20]:
        data = z.read(i.filename)
        out['first'].append({'name': i.filename, 'size': i.file_size, 'crc': i.CRC, 'method': i.compress_type, 'hex': data[:32].hex(), 'utf8': bool(i.flag_bits & 0x800), 'date': list(i.date_time)})
print(json.dumps(out))
`;

// ---- CRC ---------------------------------------------------------------------------------

test('CRC-32 known vectors', () => {
  assert.equal(crc32(''), 0);
  assert.equal(crc32('123456789'), 0xCBF43926);
  assert.equal(crc32('The quick brown fox jumps over the lazy dog'), 0x414FA339);
  assert.equal(crc32(new Uint8Array([0])), 0xD202EF8D);
});

test('CRC-32 matches zlib for every tail length and in chunks', () => {
  const data = randomBytes(5 * 1024 * 1024 + 13, 7);
  for (let n = 0; n < 40; n++) assert.equal(crc32(data.subarray(0, n)), zlib.crc32(data.subarray(0, n)) >>> 0, `length ${n}`);
  assert.equal(crc32(data), zlib.crc32(data) >>> 0);
  let running = 0;
  for (let i = 0; i < data.length; i += 777777) running = crc32(data.subarray(i, i + 777777), running);
  assert.equal(running, zlib.crc32(data) >>> 0);
});

test('crc32Blob streams a large Blob and reports progress', async () => {
  const data = randomBytes(3 * 1024 * 1024 + 5, 3);
  const seen = [];
  const c = await crc32Blob(new Blob([data]), { onProgress: (done, total) => seen.push([done, total]) });
  assert.equal(c, zlib.crc32(data) >>> 0);
  assert.ok(seen.length >= 1);
  assert.deepEqual(seen.at(-1), [data.length, data.length]);
});

// ---- names and dates --------------------------------------------------------------------

test('names are sanitised: forward slashes, no .., no leading slash or drive', () => {
  assert.equal(sanitizeName('media\\photos\\a.jpg'), 'media/photos/a.jpg');
  assert.equal(sanitizeName('../../etc/passwd'), 'etc/passwd');
  assert.equal(sanitizeName('/abs/./x.txt'), 'abs/x.txt');
  assert.equal(sanitizeName('C:\\Users\\x.txt'), 'Users/x.txt');
  assert.equal(sanitizeName('folder/'), 'folder/');
  assert.equal(sanitizeName('a\u0000b\u001f.txt'), 'ab.txt');
  assert.equal(sanitizeName('Cafe\u0301.txt'), 'Caf\u00e9.txt'); // NFD → NFC
  assert.throws(() => sanitizeName('../..'), /needs a name/);
  assert.throws(() => sanitizeName(''), /needs a name/);
});

test('DOS date/time round trip, clamped before 1980', () => {
  const d = new Date(2026, 10, 2, 10, 32, 15);
  const { date, time } = dosDateTime(d);
  assert.deepEqual(fromDosDateTime(date, time), new Date(2026, 10, 2, 10, 32, 14));
  const old = dosDateTime(new Date(1970, 0, 1));
  assert.deepEqual(fromDosDateTime(old.date, old.time), new Date(1980, 0, 1, 0, 0, 0));
});

test('MIME types from names', () => {
  assert.equal(mimeFromName('media/photos/001-x.JPG'), 'image/jpeg');
  assert.equal(mimeFromName('v.webm'), 'video/webm');
  assert.equal(mimeFromName('a.m4a'), 'audio/mp4');
  assert.equal(mimeFromName('noext'), '');
});

test('the CP437 table is complete', () => {
  assert.equal(zip._CP437_LENGTH, 128);
});

// ---- round trips ---------------------------------------------------------------------------

test('round trip: text, binary (streamed), unicode names, empty file, folder, deflated text', async () => {
  const w = createZipWriter();
  const big = randomBytes(2 * 1024 * 1024 + 99, 11); // > 1 MB: the streamed CRC path
  const json = JSON.stringify({ hello: 'world', list: Array.from({ length: 2000 }, (_, i) => i) });
  const when = new Date(2026, 10, 2, 10, 32, 0);
  w.add('README.txt', 'Hello, job walk!\r\n', { date: when });
  w.add('media/photos/001-i_abc.jpg', new Blob([big], { type: 'image/jpeg' }), { date: when });
  w.add('Café/Plan – 2° étage ✓ 日本語 🏗️.txt', 'unicode', { date: when });
  w.add('empty.bin', new Uint8Array(0));
  w.add('folder/', null);
  w.add('jobwalk.json', json, { compress: true });
  const blob = await w.finish();
  assert.equal(blob.type, 'application/zip');

  const z = await readZip(blob, { verify: true });
  assert.deepEqual(z.entries.map((e) => e.name), ['README.txt', 'media/photos/001-i_abc.jpg', 'Café/Plan – 2° étage ✓ 日本語 🏗️.txt', 'empty.bin', 'folder/', 'jobwalk.json']);
  assert.equal(await z.entry('README.txt').text(), 'Hello, job walk!\r\n');
  assert.deepEqual(await bytesOf(await z.entry('media/photos/001-i_abc.jpg').blob()), big);
  assert.equal((await z.entry('media/photos/001-i_abc.jpg').blob()).type, 'image/jpeg');
  assert.equal(await z.entry('Café/Plan – 2° étage ✓ 日本語 🏗️.txt').text(), 'unicode');
  assert.equal((await z.entry('empty.bin').blob()).size, 0);
  assert.equal(z.entry('folder/').isDirectory, true);
  const j = z.entry('jobwalk.json');
  assert.equal(j.method, 8, 'text is deflated');
  assert.ok(j.compressedSize < j.size);
  assert.deepEqual(await j.json(), JSON.parse(json));
  assert.equal(z.entry('media/photos/001-i_abc.jpg').method, 0, 'media is stored');
  assert.equal(z.entry('README.txt').date.getTime(), when.getTime(), 'exact time from the UT extra');
});

test('a media Blob is passed through, not copied, and the archive is exactly headers + data', async () => {
  const data = randomBytes(50000, 5);
  const w = createZipWriter();
  const name = w.add('a.bin', new Blob([data]));
  assert.equal(name, 'a.bin');
  const blob = await w.finish();
  // 30 + name + UT extra (9) + data + central (46 + name + 9) + EOCD 22
  assert.equal(blob.size, 30 + 5 + 9 + data.length + 46 + 5 + 9 + 22);
});

test('duplicate names get " (2)" (ignoring case) instead of overwriting', async () => {
  const w = createZipWriter();
  assert.equal(w.add('photos/a.jpg', 'x'), 'photos/a.jpg');
  assert.equal(w.add('photos/A.JPG', 'y'), 'photos/A (2).JPG');
  assert.equal(w.add('photos/a.jpg', 'z'), 'photos/a (3).jpg');
  assert.equal(w.add('noext', '1'), 'noext');
  assert.equal(w.add('noext', '2'), 'noext (2)');
  const z = await readZip(await w.finish());
  assert.equal(await z.entry('photos/a (3).jpg').text(), 'z');
});

test('many files round trip', async () => {
  const w = createZipWriter();
  for (let i = 0; i < 1500; i++) w.add(`media/thumbs/${String(i).padStart(4, '0')}.txt`, `file ${i}`);
  const z = await readZip(await w.finish(), { verify: true });
  assert.equal(z.entries.length, 1500);
  assert.equal(await z.entries[1234].text(), 'file 1234');
});

test('65,535 files or more switch to ZIP64 end records, and read back', async () => {
  const w = createZipWriter();
  const n = 65536;
  const one = new Uint8Array([65]);
  for (let i = 0; i < n; i++) w.add(`f/${i}`, one);
  const blob = await w.finish();
  const tail = await bytesOf(blob.slice(blob.size - 98));
  const v = new DataView(tail.buffer);
  assert.equal(v.getUint32(0, true), 0x06064b50, 'ZIP64 end record');
  assert.equal(v.getUint32(56, true), 0x07064b50, 'ZIP64 locator');
  assert.equal(v.getUint32(76, true), 0x06054b50, 'end record');
  assert.equal(v.getUint16(76 + 10, true), 0xFFFF, 'count is in the ZIP64 record');
  const z = await readZip(blob);
  assert.equal(z.entries.length, n);
  assert.equal(z.entries[n - 1].name, `f/${n - 1}`);
  assert.equal(await z.entries[n - 1].text(), 'A');
  if (PYTHON) {
    const p = path.join(tmp, 'many.zip');
    fs.writeFileSync(p, await bytesOf(blob));
    const out = JSON.parse(python(PY_READ, p));
    assert.equal(out.bad, null);
    assert.equal(out.count, n);
  }
});

test('forceZip64 writes ZIP64 extras and end records that read back', async () => {
  const w = createZipWriter({ forceZip64: true });
  const data = randomBytes(1500000, 9);
  w.add('big.bin', new Blob([data]));
  w.add('note.txt', 'ZIP64 everywhere', { compress: true });
  const blob = await w.finish();
  const head = new DataView((await bytesOf(blob.slice(0, 64))).buffer);
  assert.equal(head.getUint32(0, true), 0x04034b50);
  assert.equal(head.getUint16(4, true), 45, 'version needed 4.5');
  assert.equal(head.getUint32(18, true), 0xFFFFFFFF, 'compressed size in the extra');
  assert.equal(head.getUint32(22, true), 0xFFFFFFFF, 'size in the extra');
  assert.equal(head.getUint16(30 + 7, true), 0x0001, 'ZIP64 extra first');
  const tail = new DataView((await bytesOf(blob.slice(blob.size - 98))).buffer);
  assert.equal(tail.getUint32(0, true), 0x06064b50);
  assert.equal(tail.getUint32(76 + 16, true), 0xFFFFFFFF, 'directory offset in the ZIP64 record');
  const z = await readZip(blob, { verify: true });
  assert.equal(z.entries.length, 2);
  assert.deepEqual(await bytesOf(await z.entry('big.bin').blob()), data);
  assert.equal(await z.entry('note.txt').text(), 'ZIP64 everywhere');
  assert.equal(z.entry('big.bin').size, data.length);
  if (PYTHON) {
    const p = path.join(tmp, 'force64.zip');
    fs.writeFileSync(p, await bytesOf(blob));
    const out = JSON.parse(python(PY_READ, p));
    assert.equal(out.bad, null, 'Python finds no bad CRC');
    assert.deepEqual(out.first.map((f) => f.size), [data.length, 16]);
  }
});

test('a damaged file is caught by verify; a truncated zip is refused', async () => {
  const w = createZipWriter();
  w.add('photo.jpg', new Blob([randomBytes(4000, 2)]));
  const good = await bytesOf(await w.finish());
  const bad = good.slice();
  bad[30 + 9 + 9 + 100] ^= 0xff; // a byte inside photo.jpg's data
  const z = await readZip(new Blob([bad]), { verify: true });
  await assert.rejects(z.entries[0].blob(), /check-sum/);
  const unverified = await readZip(new Blob([bad]));
  assert.equal((await unverified.entries[0].blob()).size, 4000, 'without verify the bytes are returned');
  await assert.rejects(readZip(new Blob([good.slice(0, good.length - 30)])), /not a \.zip|partly/);
  await assert.rejects(readZip(new Blob(['not a zip at all, just some text that is long enough'])), /not a \.zip/);
  await assert.rejects(readZip(new Blob([])), /too small/);
});

test('finish can be cancelled and reports progress to the end', async () => {
  const w = createZipWriter();
  w.add('a.bin', new Blob([randomBytes(3 * 1024 * 1024, 4)]));
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(w.finish({ signal: ac.signal }), (e) => e.name === 'AbortError');

  const w2 = createZipWriter();
  w2.add('a.bin', new Blob([randomBytes(3 * 1024 * 1024, 4)]));
  w2.add('b.txt', 'b');
  const seen = [];
  await w2.finish({ onProgress: (p) => seen.push(p) });
  assert.ok(seen.length >= 1);
  assert.equal(seen.at(-1).fraction, 1);
  assert.throws(() => w2.add('c.txt', 'late'), /already finished/);
});

// ---- other tools -------------------------------------------------------------------------

test('a hand-made zip (stored, no extras, comment) is read', async () => {
  // Built byte by byte from the format, independently of the writer.
  const name = new TextEncoder().encode('hello.txt');
  const body = new TextEncoder().encode('Hello from a hand-made zip');
  const crc = zlib.crc32(body) >>> 0;
  const comment = new TextEncoder().encode('PK\x05\x06 inside the comment');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(10, 4);
  local.writeUInt16LE(0x5a21, 10); local.writeUInt16LE(0x5d62, 12); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
  const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(10, 6);
  cen.writeUInt16LE(0x5a21, 12); cen.writeUInt16LE(0x5d62, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(body.length, 20);
  cen.writeUInt32LE(body.length, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(0, 42);
  const cdStart = 30 + name.length + body.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(cdStart, 16); end.writeUInt16LE(comment.length, 20);
  const blob = new Blob([local, name, body, cen, name, end, comment]);
  const z = await readZip(blob, { verify: true });
  assert.equal(z.comment, 'PK\x05\x06 inside the comment');
  assert.equal(z.entries.length, 1);
  assert.equal(await z.entry('hello.txt').text(), 'Hello from a hand-made zip');
  assert.deepEqual(z.entries[0].date, fromDosDateTime(0x5d62, 0x5a21));
});

test('Python zipfile reads our zip: CRCs, sizes, UTF-8 names, dates', { skip: PYTHON ? false : 'Python 3 is not installed' }, async () => {
  const w = createZipWriter();
  const big = randomBytes(1200000, 21);
  const when = new Date(2026, 10, 2, 10, 32, 8);
  w.add('index.html', '<!doctype html><title>x</title>'.repeat(200), { compress: true, date: when });
  w.add('media/videos/002-i_v.webm', new Blob([big], { type: 'video/webm' }), { date: when });
  w.add('Café ✓.txt', 'unicode', { date: when });
  const p = path.join(tmp, 'ours.zip');
  fs.writeFileSync(p, await bytesOf(await w.finish()));
  const out = JSON.parse(python(PY_READ, p));
  assert.equal(out.bad, null);
  assert.deepEqual(out.first.map((f) => f.name), ['index.html', 'media/videos/002-i_v.webm', 'Café ✓.txt']);
  assert.deepEqual(out.first.map((f) => f.method), [8, 0, 0]);
  assert.equal(out.first[1].crc, zlib.crc32(big) >>> 0);
  assert.equal(out.first[1].hex, Buffer.from(big.subarray(0, 32)).toString('hex'));
  assert.ok(out.first.every((f) => f.utf8));
  assert.deepEqual(out.first[0].date, [2026, 11, 2, 10, 32, 8]);
});

test('we read a zip Python made: stored, deflated, unicode, comment, folder, ZIP64 local extra', { skip: PYTHON ? false : 'Python 3 is not installed' }, async () => {
  const p = path.join(tmp, 'python.zip');
  python(`
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    z.comment = b'made by python'
    z.writestr(zipfile.ZipInfo('stored.txt', (2026, 11, 2, 10, 32, 0)), 'hello stored', compress_type=zipfile.ZIP_STORED)
    z.writestr('deflated.json', '{"n": [' + ','.join(str(i) for i in range(5000)) + ']}', compress_type=zipfile.ZIP_DEFLATED)
    z.writestr('folder/Café ünï ✓.txt', 'unicode name', compress_type=zipfile.ZIP_DEFLATED)
    z.writestr(zipfile.ZipInfo('emptydir/'), '')
    with z.open('force64.bin', 'w', force_zip64=True) as f:
        f.write(bytes(range(256)) * 400)
`, p);
  const z = await readZip(new Blob([fs.readFileSync(p)]), { verify: true });
  assert.equal(z.comment, 'made by python');
  assert.equal(await z.entry('stored.txt').text(), 'hello stored');
  assert.deepEqual(z.entry('stored.txt').date, new Date(2026, 10, 2, 10, 32, 0));
  assert.equal(z.entry('deflated.json').method, 8);
  assert.equal((await z.entry('deflated.json').json()).n.length, 5000);
  assert.equal(await z.entry('folder/Café ünï ✓.txt').text(), 'unicode name');
  assert.equal(z.entry('emptydir/').isDirectory, true);
  const b = await bytesOf(await z.entry('force64.bin').blob());
  assert.equal(b.length, 256 * 400);
  assert.equal(b[257], 1);
});

test('we read a ZIP64 archive Python made (more than 65,535 files)', { skip: PYTHON ? false : 'Python 3 is not installed' }, async () => {
  const p = path.join(tmp, 'python64.zip');
  python(`
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    for i in range(65540):
        z.writestr('d/%d' % i, 'x%d' % i)
`, p);
  const z = await readZip(new Blob([fs.readFileSync(p)]));
  assert.equal(z.entries.length, 65540);
  assert.equal(await z.entry('d/65539').text(), 'x65539');
});
