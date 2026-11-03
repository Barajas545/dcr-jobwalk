// db.js — IndexedDB: where every job walk lives on this phone.
//
// The one rule: a write has happened when its transaction has COMMITTED, not
// when a request inside it succeeded. Every write below resolves on
// `oncomplete` and asks for strict durability (flushed to disk before
// `oncomplete`, where the browser supports the flag), so when the app says
// "Saved" the photo is really on the phone. A photo that cannot be saved
// rejects loudly instead of vanishing.
//
// Bytes are stored as ArrayBuffers, never as Blob objects. iOS Safari has
// several Blob-in-IndexedDB bugs that lose data — "Error preparing Blob/File
// data" (reported again on iOS 18.7 and 26.5), "WebKitBlobResource error 1"
// after a relaunch, a network-process crash reading Blobs through an index
// (iOS 18.4) — and plain bytes avoid all of them (docs/RESEARCH.md,
// "Storage durability"). Big files are split into parts of PART_SIZE so no
// single write is huge and a phone never needs the whole video in one buffer
// to save it.
//
// Stores (DB_VERSION 1):
//   projects    {id, …}                          a job walk, its levels, plans and calibrations
//   items       {id, projectId, …}               a photo, video or note        index: projectId
//   media       {id, projectId, itemId, kind, type, size, partCount, meta}
//                                                what a file is (no bytes)   indexes: projectId, itemId
//   parts       {mediaId, seq, data, size, sha}  a file's bytes, PART_SIZE at a time
//                                                                              key [mediaId, seq]
//   chunks      {recId, seq, data, size, type}   a video while it is recording (write-ahead)
//                                                                              key [recId, seq]
//   recordings  {recId, …}                       the recording each set of chunks belongs to
//   kv          {key, value}                     settings and small app state

export const DB_NAME = 'dcr-jobwalk';
export const DB_VERSION = 1;
export const PART_SIZE = 4 * 1024 * 1024;

let dbPromise = null;

/** Open (and on first run, create) the database. Shared by every caller. */
export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      reject(new Error('This browser cannot store data on the device. On iPhone, Lockdown Mode turns storage off for websites — exclude this site in Settings > Privacy & Security > Lockdown Mode, or use Safari normally.'));
      return;
    }
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (err) { dbPromise = null; reject(err); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('items')) {
        const s = db.createObjectStore('items', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId');
      }
      if (!db.objectStoreNames.contains('media')) {
        const s = db.createObjectStore('media', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId');
        s.createIndex('itemId', 'itemId');
      }
      if (!db.objectStoreNames.contains('parts')) db.createObjectStore('parts', { keyPath: ['mediaId', 'seq'] });
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: ['recId', 'seq'] });
      if (!db.objectStoreNames.contains('recordings')) db.createObjectStore('recordings', { keyPath: 'recId' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab opened a newer version of the app: let it upgrade rather
      // than block it, and reload into the new version.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
        if (typeof location !== 'undefined') location.reload();
      };
      // The browser closed the connection (iOS does this when it kills its
      // storage process in the background): the next call reopens it.
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error || new Error('Could not open the database')); };
    req.onblocked = () => {
      console.warn('[db] open is blocked by another copy of this app — close other tabs of DCR Job Walk');
    };
  });
  return dbPromise;
}

/** Errors that mean "the connection is gone" — safe to reopen and retry, because an aborted transaction wrote nothing. */
function isLostConnection(err) {
  const name = err?.name || '';
  const msg = String(err?.message || '');
  return name === 'InvalidStateError' || (name === 'UnknownError' && /connection|server lost|closed/i.test(msg)) || /database connection is closing/i.test(msg);
}

/**
 * Run one transaction. `body(tx, box, fail)` issues its requests
 * synchronously (or from their own onsuccess callbacks — never after an
 * unrelated await, or the transaction will have committed already) and may
 * put its result in `box.value`. Resolves with box.value once the
 * transaction COMMITS; rejects if anything inside it fails, in which case
 * nothing in it was written. A lost connection is reopened and the
 * transaction tried once more.
 */
export async function run(storeNames, mode, body, _retried = false) {
  let db;
  try { db = await openDb(); } catch (err) { throw friendlyError(err); }
  try {
    return await new Promise((resolve, reject) => {
      let tx;
      try {
        tx = mode === 'readwrite'
          ? db.transaction(storeNames, mode, { durability: 'strict' })
          : db.transaction(storeNames, mode);
      } catch (err) {
        reject(err);
        return;
      }
      const box = { value: undefined };
      let failed = null;
      tx.oncomplete = () => resolve(box.value);
      tx.onabort = () => reject(failed || tx.error || new DOMException('The save was cancelled', 'AbortError'));
      tx.onerror = (e) => { failed = failed || e.target?.error || tx.error; };
      try {
        body(tx, box, (err) => { failed = err; try { tx.abort(); } catch { /* already finished */ } });
      } catch (err) {
        failed = err;
        try { tx.abort(); } catch { /* already finished */ }
      }
    });
  } catch (err) {
    if (!_retried && isLostConnection(err)) {
      try { db.close(); } catch { /* already closed */ }
      dbPromise = null;
      return run(storeNames, mode, body, true);
    }
    throw friendlyError(err);
  }
}

/** Turn a storage error into one a person can act on. */
export function friendlyError(err) {
  if (!err) return new Error('Unknown storage error');
  if (err.friendly) return err;
  const name = err.name || '';
  let e;
  if (name === 'QuotaExceededError' || /quota/i.test(err.message || '')) {
    e = new Error('The phone is out of storage space for this app. Nothing new was saved. Back up and remove old job walks, or free space on the phone, then try again.');
    e.name = 'QuotaExceededError';
  } else if (isLostConnection(err)) {
    e = new Error('The phone closed the app\'s storage while it was in the background. Reload the app (your saved photos are safe) and try again.');
    e.name = 'ConnectionLost';
  } else {
    return err instanceof Error ? err : new Error(String(err.message || err));
  }
  e.cause = err;
  e.friendly = true;
  return e;
}

// ---- one-record helpers ------------------------------------------------------

export function get(store, key) {
  return run([store], 'readonly', (tx, box) => {
    tx.objectStore(store).get(key).onsuccess = (e) => { box.value = e.target.result; };
  });
}

export function getAll(store, range) {
  return run([store], 'readonly', (tx, box) => {
    tx.objectStore(store).getAll(range).onsuccess = (e) => { box.value = e.target.result || []; };
  });
}

/** Records by index. Only for stores that hold no bytes (see the iOS 18.4 note above). */
export function getAllByIndex(store, index, key) {
  return run([store], 'readonly', (tx, box) => {
    tx.objectStore(store).index(index).getAll(key).onsuccess = (e) => { box.value = e.target.result || []; };
  });
}

/** Keys only — cheap, no records read. */
export function getKeysByIndex(store, index, key) {
  return run([store], 'readonly', (tx, box) => {
    tx.objectStore(store).index(index).getAllKeys(key).onsuccess = (e) => { box.value = e.target.result || []; };
  });
}

export function getAllKeys(store, range) {
  return run([store], 'readonly', (tx, box) => {
    tx.objectStore(store).getAllKeys(range).onsuccess = (e) => { box.value = e.target.result || []; };
  });
}

export function put(store, value) {
  return run([store], 'readwrite', (tx) => { tx.objectStore(store).put(value); });
}

export function del(store, key) {
  return run([store], 'readwrite', (tx) => { tx.objectStore(store).delete(key); });
}

/**
 * Read-modify-write one record inside a single transaction, so two quick
 * edits can never overwrite each other. `fn(current)` returns the new record
 * (or mutates and returns `current`); returning undefined leaves it alone.
 */
export function update(store, key, fn) {
  return run([store], 'readwrite', (tx, box, fail) => {
    const os = tx.objectStore(store);
    os.get(key).onsuccess = (e) => {
      const cur = e.target.result;
      let next;
      try { next = fn(cur); } catch (err) { fail(err); return; }
      if (next === undefined) { box.value = cur; return; }
      os.put(next);
      box.value = next;
    };
  });
}

/** All keys [id, 0] … [id, ∞) of a compound-key store (parts, chunks). */
export function rangeFor(id) {
  return IDBKeyRange.bound([id, 0], [id, Infinity]);
}

// ---- bytes -----------------------------------------------------------------

/** SHA-256 of an ArrayBuffer, as hex. */
export async function sha256(buf) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  let s = '';
  for (const b of h) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Bytes of a part/chunk record as an ArrayBuffer (older records may hold a Blob). */
export async function bytesOf(rec) {
  if (!rec) return null;
  if (rec.data instanceof ArrayBuffer) return rec.data;
  if (ArrayBuffer.isView(rec.data)) return rec.data.buffer.slice(rec.data.byteOffset, rec.data.byteOffset + rec.data.byteLength);
  if (rec.blob && typeof rec.blob.arrayBuffer === 'function') return rec.blob.arrayBuffer();
  return null;
}

/** A Blob from part/chunk records, in seq order. */
export function blobFromRecords(records, type = '') {
  const sorted = [...records].sort((a, b) => a.seq - b.seq);
  return new Blob(sorted.map((r) => r.data ?? r.blob), { type });
}
