// zip.js — .zip files: write a job walk out, read one back in.
//
// Our own, because the app has no build step and no dependencies
// (docs/SPEC.md §1), and the zip libraries that exist either hold the whole
// archive in memory or need a worker. A job walk can be gigabytes of video on
// a phone, so:
//
//  - The writer never copies a photo or video into an ArrayBuffer. It reads
//    each Blob once, as a stream, to compute its CRC-32, then hands that same
//    Blob to the final `new Blob([...parts])`, which only references it. The
//    finished zip is small header Uint8Arrays interleaved with the media
//    Blobs themselves.
//  - Media is stored (method 0): JPEG, MP4 and WebM are already compressed,
//    so deflating them would cost minutes of phone CPU to save ~1 %. Text
//    (JSON, the viewer page) can be deflated with the browser's own
//    CompressionStream('deflate-raw').
//  - ZIP64 records are written when a size or an offset reaches 4 GB, or
//    there are 65,535 files or more, so a long video walk still unzips on
//    Windows, macOS, iOS and Android.
//  - Names are UTF-8 with the language-encoding flag (bit 11) set, so
//    "Café" or "2° floor" survive on every system.
//
// The reader parses the end record and the central directory (ZIP64
// included) and returns entries whose bytes are only read when asked for
// (blob() / text() / json()), so importing a 3 GB backup never holds more
// than one file at a time. Stored and deflated entries are both read
// (DecompressionStream('deflate-raw')), so a backup that someone unzipped and
// zipped again with Windows, macOS or 7-Zip still imports. With `verify`,
// each file's CRC-32 is checked so a damaged backup is caught before the app
// trusts it.
//
// Nothing here touches the DOM or the database; the Node tests import it.

const SIG = {
  local: 0x04034b50,
  central: 0x02014b50,
  eocd: 0x06054b50,
  zip64Eocd: 0x06064b50,
  zip64Locator: 0x07064b50,
};
const MAX16 = 0xFFFF;
const MAX32 = 0xFFFFFFFF;
const TWO32 = 0x100000000;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
const VERSION_DEFAULT = 20;      // 2.0: deflate and folders
const VERSION_ZIP64 = 45;        // 4.5: ZIP64
const MADE_BY_UNIX = 3 << 8;     // "made by Unix", so the external attributes carry a file mode (rw-r--r--)
const SMALL_READ = 1 << 20;      // Blobs up to 1 MB are read in one go; larger ones are streamed
const EXTRA_ZIP64 = 0x0001;
const EXTRA_TIME = 0x5455;       // "UT": the exact modification time in UTC (DOS times are local and 2 s coarse)
const EXTRA_UNICODE_PATH = 0x7075;

const encoder = new TextEncoder();

// ---- CRC-32 ------------------------------------------------------------------------------
//
// The standard zip/PNG CRC (polynomial 0xEDB88320), table driven and eight
// bytes at a time ("slicing by 8"): about four times faster than the
// byte-at-a-time loop, which matters when a phone checks 2 GB of video.

const CRC_TABLES = (() => {
  const t = new Uint32Array(256 * 8);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  for (let n = 0; n < 256; n++) {
    let c = t[n];
    for (let k = 1; k < 8; k++) {
      c = t[c & 0xff] ^ (c >>> 8);
      t[k * 256 + n] = c;
    }
  }
  return t;
})();

/**
 * CRC-32 of some bytes. Pass the previous result as `crc` to continue a
 * running checksum over several chunks. Accepts a Uint8Array (or any
 * ArrayBufferView / ArrayBuffer) or a string (encoded as UTF-8).
 */
export function crc32(data, crc = 0) {
  const b = toBytes(data);
  const T = CRC_TABLES;
  let c = (crc ^ MAX32) >>> 0;
  const n = b.length;
  const end8 = n - (n & 7);
  let i = 0;
  for (; i < end8; i += 8) {
    const lo = (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) ^ c;
    const hi = b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24);
    c = T[1792 + (lo & 0xff)] ^ T[1536 + ((lo >>> 8) & 0xff)] ^ T[1280 + ((lo >>> 16) & 0xff)] ^ T[1024 + (lo >>> 24)] ^
      T[768 + (hi & 0xff)] ^ T[512 + ((hi >>> 8) & 0xff)] ^ T[256 + ((hi >>> 16) & 0xff)] ^ T[hi >>> 24];
  }
  for (; i < n; i++) c = T[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ MAX32) >>> 0;
}

/**
 * CRC-32 of a Blob, read as a stream (a 2 GB video never sits in memory).
 * onProgress(bytesDone, totalBytes); signal: an AbortSignal.
 */
export async function crc32Blob(blob, { onProgress, signal } = {}) {
  let crc = 0;
  let done = 0;
  await eachChunk(blob, (chunk) => {
    crc = crc32(chunk, crc);
    done += chunk.length;
    onProgress?.(done, blob.size);
  }, signal);
  return crc;
}

// ---- names and dates ----------------------------------------------------------------------

/**
 * A safe path inside a zip: forward slashes, no leading slash or drive
 * letter, no "." or ".." parts (an archive must never write outside the
 * folder it is unzipped into), no control characters, Unicode NFC. A
 * trailing "/" (a folder) is kept. Throws when nothing is left.
 */
export function sanitizeName(name) {
  let s = String(name ?? '').normalize('NFC').replace(/\\/g, '/').replace(/[\u0000-\u001f\u007f]/g, '');
  const folder = s.endsWith('/');
  const parts = s.split('/').map((p) => p.trim()).filter((p) => p && p !== '.' && p !== '..');
  if (parts.length && /^[A-Za-z]:$/.test(parts[0])) parts.shift();
  s = parts.join('/');
  if (!s) throw new Error('Every file in a zip needs a name.');
  return folder ? `${s}/` : s;
}

/** A Date (or ms) as MS-DOS date and time words, in local time like every zip tool. Clamped to 1980–2107. */
export function dosDateTime(when = Date.now()) {
  const d = when instanceof Date ? when : new Date(when);
  const y = d.getFullYear();
  if (!Number.isFinite(y) || y < 1980) return { date: (1 << 5) | 1, time: 0 };
  if (y > 2107) return { date: (127 << 9) | (12 << 5) | 31, time: (23 << 11) | (59 << 5) | 29 };
  return {
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

/** The reverse of dosDateTime (local time; seconds are even). */
export function fromDosDateTime(date, time) {
  return new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2);
}

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic',
  svg: 'image/svg+xml', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  m4a: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav',
  json: 'application/json', html: 'text/html', htm: 'text/html', txt: 'text/plain', csv: 'text/csv', css: 'text/css',
  js: 'text/javascript', pdf: 'application/pdf', zip: 'application/zip',
};

/** A MIME type guessed from a file name's extension ('' when unknown). */
export function mimeFromName(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
  return (m && MIME[m[1].toLowerCase()]) || '';
}

// ---- writer -----------------------------------------------------------------------------

/**
 * Build a zip from parts.
 *
 *   const zip = createZipWriter();
 *   zip.add('jobwalk.json', jsonText, {compress: true});
 *   zip.add('media/photos/001-i_x.jpg', photoBlob, {date: item.createdAt});
 *   const blob = await zip.finish({onProgress, signal});
 *
 * add(name, data, {date, compress}) — data: Blob | Uint8Array | ArrayBuffer |
 * string (UTF-8). `compress` deflates it (use for text; media is stored).
 * Returns the name actually used: names are sanitised, and a name already
 * in the zip (ignoring case, as Windows does) gets " (2)" before its
 * extension instead of overwriting the first file when unzipped.
 *
 * finish({onProgress, signal}) reads every part once (CRC-32), and resolves
 * the zip as one Blob. onProgress({done, total, fraction, name, index, count}).
 *
 * forceZip64 writes ZIP64 records even for a small zip (tests; tools).
 */
export function createZipWriter({ forceZip64 = false } = {}) {
  const entries = [];
  const used = new Set();
  let finished = false;

  function uniqueName(name) {
    if (!used.has(name.toLowerCase())) return name;
    const folder = name.endsWith('/');
    const base = folder ? name.slice(0, -1) : name;
    const dot = base.lastIndexOf('.');
    const slash = base.lastIndexOf('/');
    const hasExt = dot > slash + 1;
    const stem = hasExt ? base.slice(0, dot) : base;
    const ext = hasExt ? base.slice(dot) : '';
    for (let n = 2; ; n++) {
      const candidate = `${stem} (${n})${ext}${folder ? '/' : ''}`;
      if (!used.has(candidate.toLowerCase())) return candidate;
    }
  }

  return {
    get count() { return entries.length; },

    add(name, data, { date = Date.now(), compress = false } = {}) {
      if (finished) throw new Error('This zip is already finished; start a new one.');
      const clean = uniqueName(sanitizeName(name));
      const folder = clean.endsWith('/');
      const body = folder ? new Uint8Array(0) : normalizeData(data);
      const nameBytes = encoder.encode(clean);
      if (nameBytes.length > MAX16) throw new Error(`The file name is too long for a zip: ${clean.slice(0, 60)}…`);
      const when = date instanceof Date ? date : new Date(date ?? Date.now());
      const ms = when.getTime();
      const mtime = Number.isFinite(ms) && ms >= 0 && ms / 1000 < MAX32 ? Math.floor(ms / 1000) : null;
      used.add(clean.toLowerCase());
      entries.push({
        name: clean, nameBytes, data: body, size: sizeOf(body), folder,
        compress: !!compress && !folder, dos: dosDateTime(when), mtime,
      });
      return clean;
    },

    async finish({ onProgress, signal } = {}) {
      if (finished) throw new Error('This zip is already finished.');
      finished = true;
      const parts = [];
      const central = [];
      const total = entries.reduce((n, e) => n + e.size, 0);
      const tick = throttledProgress(onProgress, total, entries.length);
      let offset = 0;
      let done = 0;
      for (let i = 0; i < entries.length; i++) {
        throwIfAborted(signal);
        const e = entries[i];
        const crc = await crcOf(e.data, (n) => tick(done + n, e.name, i), signal);
        let payload = e.data;
        let method = 0;
        let csize = e.size;
        if (e.compress && e.size > 64 && typeof CompressionStream !== 'undefined') {
          try {
            const packed = await deflate(e.data, signal);
            if (packed.size < e.size) { payload = packed; method = 8; csize = packed.size; }
          } catch (err) {
            if (err?.name === 'AbortError') throw err;
            // A browser that cannot deflate stores the text instead; the zip is still valid.
          }
        }
        done += e.size;
        tick(done, e.name, i);
        const zip64Sizes = forceZip64 || e.size >= MAX32 || csize >= MAX32;
        const local = localHeader(e, { crc, method, csize, zip64: zip64Sizes });
        central.push({ e, crc, method, csize, offset, zip64Sizes });
        parts.push(local, payload);
        offset += local.length + csize;
      }
      const cdStart = offset;
      for (const c of central) {
        const h = centralHeader(c, forceZip64);
        parts.push(h);
        offset += h.length;
      }
      parts.push(...endRecords({ count: entries.length, cdStart, cdSize: offset - cdStart, end: offset, force: forceZip64 }));
      tick(total, '', entries.length, true);
      return new Blob(parts, { type: 'application/zip' });
    },
  };
}

function localHeader(e, { crc, method, csize, zip64 }) {
  const extra = concatBytes([
    zip64 ? zip64Extra([e.size, csize]) : null,
    e.mtime != null ? timeExtra(e.mtime) : null,
  ]);
  const w = new ByteWriter(30 + e.nameBytes.length + extra.length);
  w.u32(SIG.local).u16(zip64 ? VERSION_ZIP64 : VERSION_DEFAULT).u16(FLAG_UTF8).u16(method)
    .u16(e.dos.time).u16(e.dos.date).u32(crc)
    .u32(zip64 ? MAX32 : csize).u32(zip64 ? MAX32 : e.size)
    .u16(e.nameBytes.length).u16(extra.length).bytes(e.nameBytes).bytes(extra);
  return w.buf;
}

function centralHeader({ e, crc, method, csize, offset, zip64Sizes }, force) {
  const zip64Offset = force || offset >= MAX32;
  // The ZIP64 extra holds only the fields that are 0xFFFFFFFF in the record, in this fixed order.
  const big = [];
  if (zip64Sizes) big.push(e.size, csize);
  if (zip64Offset) big.push(offset);
  const extra = concatBytes([big.length ? zip64Extra(big) : null, e.mtime != null ? timeExtra(e.mtime) : null]);
  const needed = big.length ? VERSION_ZIP64 : VERSION_DEFAULT;
  const mode = e.folder ? ((0o40755 << 16) | 0x10) : (0o100644 << 16);
  const w = new ByteWriter(46 + e.nameBytes.length + extra.length);
  w.u32(SIG.central).u16(MADE_BY_UNIX | needed).u16(needed).u16(FLAG_UTF8).u16(method)
    .u16(e.dos.time).u16(e.dos.date).u32(crc)
    .u32(zip64Sizes ? MAX32 : csize).u32(zip64Sizes ? MAX32 : e.size)
    .u16(e.nameBytes.length).u16(extra.length).u16(0).u16(0).u16(0).u32(mode)
    .u32(zip64Offset ? MAX32 : offset).bytes(e.nameBytes).bytes(extra);
  return w.buf;
}

function endRecords({ count, cdStart, cdSize, end, force }) {
  const bigCount = force || count >= MAX16;
  const bigSize = force || cdSize >= MAX32;
  const bigStart = force || cdStart >= MAX32;
  const out = [];
  if (bigCount || bigSize || bigStart) {
    const rec = new ByteWriter(56);
    rec.u32(SIG.zip64Eocd).u64(44).u16(MADE_BY_UNIX | VERSION_ZIP64).u16(VERSION_ZIP64)
      .u32(0).u32(0).u64(count).u64(count).u64(cdSize).u64(cdStart);
    const loc = new ByteWriter(20);
    loc.u32(SIG.zip64Locator).u32(0).u64(end).u32(1);
    out.push(rec.buf, loc.buf);
  }
  const eocd = new ByteWriter(22);
  eocd.u32(SIG.eocd).u16(0).u16(0)
    .u16(bigCount ? MAX16 : count).u16(bigCount ? MAX16 : count)
    .u32(bigSize ? MAX32 : cdSize).u32(bigStart ? MAX32 : cdStart).u16(0);
  out.push(eocd.buf);
  return out;
}

function zip64Extra(values) {
  const w = new ByteWriter(4 + 8 * values.length);
  w.u16(EXTRA_ZIP64).u16(8 * values.length);
  for (const v of values) w.u64(v);
  return w.buf;
}

function timeExtra(mtime) {
  const w = new ByteWriter(9);
  w.u16(EXTRA_TIME).u16(5).u8(1).u32(mtime);
  return w.buf;
}

// ---- reader -------------------------------------------------------------------------------

/**
 * Open a zip (a File or Blob). Resolves
 *   {entries: [Entry], comment, entry(name) → Entry | null}
 * Entry: {name, size, compressedSize, method, crc32, date, isDirectory,
 *   encrypted, comment, blob({verify, type, signal, onProgress}), text(),
 *   json(), arrayBuffer()}.
 * Only the end of the file and the central directory are read here; each
 * entry's bytes are read when asked for. `verify` (default for every entry)
 * checks the CRC-32 of what is read and rejects on a mismatch.
 */
export async function readZip(blob, { verify = false } = {}) {
  if (!blob || typeof blob.slice !== 'function' || typeof blob.size !== 'number') throw new TypeError('readZip needs a File or Blob');
  const size = blob.size;
  if (size < 22) throw zipError('This file is not a .zip (it is empty or too small).');

  // The end record sits in the last 22 bytes plus an optional comment of up
  // to 64 KB, so search backwards. Prefer a record whose comment length runs
  // exactly to the end of the file (a signature can appear inside a comment).
  const tailStart = Math.max(0, size - (22 + MAX16 + 20));
  const tail = await bytesAt(blob, tailStart, size - tailStart);
  const tv = viewOf(tail);
  let at = -1;
  let loose = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) !== SIG.eocd) continue;
    const clen = tv.getUint16(i + 20, true);
    if (i + 22 + clen === tail.length) { at = i; break; }
    if (loose < 0 && i + 22 + clen <= tail.length) loose = i;
  }
  if (at < 0) at = loose;
  if (at < 0) throw zipError('This file is not a .zip, or it was only partly copied.');

  let count = tv.getUint16(at + 10, true);
  let cdSize = tv.getUint32(at + 12, true);
  let cdStart = tv.getUint32(at + 16, true);
  const clen = tv.getUint16(at + 20, true);
  const comment = decodeText(tail.subarray(at + 22, at + 22 + clen), true);
  let recordsStart = tailStart + at;

  if (at >= 20 && tv.getUint32(at - 20, true) === SIG.zip64Locator) {
    const recAt = readU64(tv, at - 20 + 8);
    const rec = await bytesAt(blob, recAt, 56);
    const rv = viewOf(rec);
    if (rec.length < 56 || rv.getUint32(0, true) !== SIG.zip64Eocd) throw zipError('The end of this .zip is damaged (ZIP64 record missing).');
    count = readU64(rv, 32);
    cdSize = readU64(rv, 40);
    cdStart = readU64(rv, 48);
    recordsStart = recAt;
  } else if (count === MAX16 && cdStart === MAX32) {
    throw zipError('The end of this .zip is damaged (ZIP64 locator missing).');
  }
  if (cdSize > size) throw zipError('This .zip is damaged (its file list is larger than the file).');

  // Data placed before the archive (a self-extractor) shifts every offset.
  // The directory always ends where the end records start, which gives the shift.
  let shift = 0;
  let cd = await bytesAt(blob, cdStart, cdSize);
  if (count > 0 && (cd.length < 4 || viewOf(cd).getUint32(0, true) !== SIG.central)) {
    shift = recordsStart - cdSize - cdStart;
    if (shift === 0) throw zipError('This .zip is damaged (its file list cannot be found).');
    cd = await bytesAt(blob, cdStart + shift, cdSize);
    if (cd.length < 4 || viewOf(cd).getUint32(0, true) !== SIG.central) throw zipError('This .zip is damaged (its file list cannot be found).');
  }

  const dv = viewOf(cd);
  const entries = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || dv.getUint32(p, true) !== SIG.central) {
      throw zipError(`This .zip is damaged (file ${i + 1} of ${count} in its list cannot be read).`);
    }
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const time = dv.getUint16(p + 12, true);
    const date = dv.getUint16(p + 14, true);
    const crc = dv.getUint32(p + 16, true);
    let csize = dv.getUint32(p + 20, true);
    let usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const mlen = dv.getUint16(p + 32, true);
    const extAttr = dv.getUint32(p + 38, true);
    let offset = dv.getUint32(p + 42, true);
    if (p + 46 + nlen + xlen + mlen > cd.length) throw zipError('This .zip is damaged (its file list is cut short).');
    const nameBytes = cd.subarray(p + 46, p + 46 + nlen);
    const extras = parseExtras(cd.subarray(p + 46 + nlen, p + 46 + nlen + xlen));
    const commentBytes = cd.subarray(p + 46 + nlen + xlen, p + 46 + nlen + xlen + mlen);

    const z = extras.get(EXTRA_ZIP64);
    if (z) {
      const zv = viewOf(z);
      let q = 0;
      const next = () => {
        if (q + 8 > z.length) throw zipError('This .zip is damaged (a ZIP64 size is missing).');
        const v = readU64(zv, q);
        q += 8;
        return v;
      };
      if (usize === MAX32) usize = next();
      if (csize === MAX32) csize = next();
      if (offset === MAX32) offset = next();
    }
    let when = null;
    const ut = extras.get(EXTRA_TIME);
    if (ut && ut.length >= 5 && (ut[0] & 1)) when = new Date(viewOf(ut).getUint32(1, true) * 1000);
    if (!when) when = fromDosDateTime(date, time);

    const name = decodeName(nameBytes, flags, extras.get(EXTRA_UNICODE_PATH));
    const isDirectory = name.endsWith('/') || (extAttr & 0x10) !== 0;
    entries.push(makeEntry(blob, {
      name, size: usize, compressedSize: csize, method, crc32: crc, date: when, isDirectory,
      encrypted: (flags & FLAG_ENCRYPTED) !== 0, comment: decodeText(commentBytes, (flags & FLAG_UTF8) !== 0),
      offset: offset + shift,
    }, verify));
    p += 46 + nlen + xlen + mlen;
  }

  const byName = new Map();
  for (const e of entries) if (!byName.has(e.name)) byName.set(e.name, e);
  return { entries, comment, entry: (name) => byName.get(name) || null };
}

function makeEntry(zip, info, verifyDefault) {
  let dataStart = null;
  const entry = {
    ...info,
    async blob({ verify = verifyDefault, type, signal, onProgress } = {}) {
      throwIfAborted(signal);
      if (info.encrypted) throw zipError(`"${info.name}" is password-protected. Unzip it on a computer and zip it again without a password.`);
      if (info.isDirectory) return new Blob([], { type: type || '' });
      if (dataStart == null) {
        const h = await bytesAt(zip, info.offset, 30);
        const hv = viewOf(h);
        if (h.length < 30 || hv.getUint32(0, true) !== SIG.local) throw zipError(`"${info.name}" in this .zip is damaged (its header is missing).`);
        dataStart = info.offset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
      }
      if (dataStart + info.compressedSize > zip.size) throw zipError(`"${info.name}" is cut short — the .zip was only partly copied.`);
      const mime = type ?? mimeFromName(info.name);
      let out;
      if (info.method === 0) {
        out = zip.slice(dataStart, dataStart + info.compressedSize, mime);
      } else if (info.method === 8) {
        out = await inflate(zip.slice(dataStart, dataStart + info.compressedSize), mime, signal, info.name);
      } else {
        throw zipError(`"${info.name}" uses a kind of compression this app cannot read (method ${info.method}). Unzip it on a computer and zip it again.`);
      }
      if (out.size !== info.size) throw zipError(`"${info.name}" in this .zip is damaged (${out.size} of ${info.size} bytes).`);
      if (verify) {
        const c = await crc32Blob(out, { signal, onProgress });
        if (c !== info.crc32) throw zipError(`"${info.name}" in this .zip is damaged (its check-sum does not match).`);
      }
      return out;
    },
    async text(opts = {}) { return (await entry.blob({ ...opts, type: 'text/plain' })).text(); },
    async json(opts = {}) { return JSON.parse(await entry.text(opts)); },
    async arrayBuffer(opts = {}) { return (await entry.blob(opts)).arrayBuffer(); },
  };
  return entry;
}

function parseExtras(bytes) {
  const out = new Map();
  const v = viewOf(bytes);
  let q = 0;
  while (q + 4 <= bytes.length) {
    const id = v.getUint16(q, true);
    const len = v.getUint16(q + 2, true);
    if (q + 4 + len > bytes.length) break;
    if (!out.has(id)) out.set(id, bytes.subarray(q + 4, q + 4 + len));
    q += 4 + len;
  }
  return out;
}

// Code page 437, the original IBM PC character set: what a zip name without
// the UTF-8 flag means by the standard (APPNOTE appendix D).
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0';

function decodeName(bytes, flags, unicodeExtra) {
  if (flags & FLAG_UTF8) return decodeText(bytes, true);
  // Info-ZIP "Unicode Path" extra: a UTF-8 copy of the name, valid while its CRC matches the plain name.
  if (unicodeExtra && unicodeExtra.length > 5 && unicodeExtra[0] === 1 &&
      viewOf(unicodeExtra).getUint32(1, true) === crc32(bytes)) {
    return decodeText(unicodeExtra.subarray(5), true);
  }
  return decodeText(bytes, false);
}

function decodeText(bytes, utf8) {
  if (!bytes.length) return '';
  let ascii = true;
  for (const b of bytes) if (b > 0x7f) { ascii = false; break; }
  if (utf8 || ascii) return new TextDecoder('utf-8').decode(bytes);
  // Many tools write UTF-8 without the flag; trust it when it decodes cleanly.
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* not UTF-8 */ }
  let s = '';
  for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
  return s;
}

/** For tests: the CP437 table must have exactly 128 characters. */
export const _CP437_LENGTH = CP437_HIGH.length;

// ---- streams and bytes ---------------------------------------------------------------------

function normalizeData(data) {
  if (data == null) return new Uint8Array(0);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data;
  if (typeof data === 'string') return encoder.encode(data);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError('A zip entry must be a Blob, bytes or a string.');
}

function sizeOf(data) {
  return data instanceof Uint8Array ? data.length : data.size;
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof data === 'string') return encoder.encode(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError('crc32 needs bytes or a string');
}

async function crcOf(data, onBytes, signal) {
  if (data instanceof Uint8Array) {
    // In-memory text: still in 1 MB steps, so progress moves and Cancel works.
    let crc = 0;
    for (let i = 0; i < data.length; i += SMALL_READ) {
      throwIfAborted(signal);
      crc = crc32(data.subarray(i, i + SMALL_READ), crc);
      onBytes(Math.min(data.length, i + SMALL_READ));
    }
    return crc;
  }
  return crc32Blob(data, { onProgress: (n) => onBytes(n), signal });
}

/** Call fn(chunk) for every chunk of a Blob, in order. Small Blobs are read in one go. */
async function eachChunk(blob, fn, signal) {
  throwIfAborted(signal);
  if (blob.size <= SMALL_READ || typeof blob.stream !== 'function') {
    const b = new Uint8Array(await blob.arrayBuffer());
    throwIfAborted(signal);
    if (b.length !== blob.size) throw new Error('A file could not be read completely.');
    fn(b);
    return;
  }
  const reader = blob.stream().getReader();
  let read = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      read += value.length;
      fn(value);
    }
  } catch (err) {
    try { await reader.cancel(); } catch { /* already closed */ }
    throw err;
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  if (read !== blob.size) throw new Error(`A file could not be read completely (${read} of ${blob.size} bytes).`);
}

async function collect(stream, type, signal) {
  const reader = stream.getReader();
  const chunks = [];
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch (err) {
    try { await reader.cancel(); } catch { /* already closed */ }
    throw err;
  }
  return new Blob(chunks, { type: type || '' });
}

async function deflate(data, signal) {
  const blob = data instanceof Uint8Array ? new Blob([data]) : data;
  return collect(blob.stream().pipeThrough(new CompressionStream('deflate-raw')), '', signal);
}

async function inflate(blob, type, signal, name) {
  if (typeof DecompressionStream === 'undefined') {
    throw zipError('This browser cannot unpack compressed .zip files. Update the browser, or use the .zip exactly as DCR Job Walk made it.');
  }
  try {
    return await collect(blob.stream().pipeThrough(new DecompressionStream('deflate-raw')), type, signal);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw zipError(`"${name}" in this .zip is damaged (it cannot be unpacked).`);
  }
}

async function bytesAt(blob, start, length) {
  if (length <= 0) return new Uint8Array(0);
  return new Uint8Array(await blob.slice(start, start + length).arrayBuffer());
}

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readU64(view, at) {
  return view.getUint32(at, true) + view.getUint32(at + 4, true) * TWO32;
}

function concatBytes(list) {
  const parts = list.filter(Boolean);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

class ByteWriter {
  constructor(n) {
    this.buf = new Uint8Array(n);
    this.view = new DataView(this.buf.buffer);
    this.p = 0;
  }
  u8(v) { this.view.setUint8(this.p, v); this.p += 1; return this; }
  u16(v) { this.view.setUint16(this.p, v, true); this.p += 2; return this; }
  u32(v) { this.view.setUint32(this.p, v >>> 0, true); this.p += 4; return this; }
  u64(v) { this.u32(v % TWO32); this.u32(Math.floor(v / TWO32)); return this; }
  bytes(b) { this.buf.set(b, this.p); this.p += b.length; return this; }
}

function throttledProgress(onProgress, total, count) {
  if (!onProgress) return () => {};
  let last = 0;
  return (done, name, index, force = false) => {
    const now = Date.now();
    if (!force && now - last < 80) return;
    last = now;
    try {
      onProgress({ done, total, fraction: total ? Math.min(1, done / total) : 1, name, index, count });
    } catch { /* a progress display must never break the zip */ }
  };
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Cancelled', 'AbortError');
}

function zipError(message) {
  const e = new Error(message);
  e.name = 'ZipError';
  return e;
}
