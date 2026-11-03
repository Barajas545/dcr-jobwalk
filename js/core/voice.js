// voice.js — talking instead of typing: dictation into a note, and voice notes.
//
// On a job site the estimator often has gloves on, a tape in one hand and
// the phone in the other. Two ways to get words onto an item without typing:
//
//  1. Dictation (createDictation): the browser's own speech recognition
//     (Web Speech API) turns speech into text that goes straight into the
//     note. Not every browser has it (Firefox does not; an iPhone needs
//     Siri & Dictation turned on), so createDictation returns null when it
//     is missing and the screen hides the button. iPhone ends a recognition
//     session on its own after a pause or about a minute; while the person
//     has not pressed Stop a new session is started at once, so it feels
//     like one long dictation. Words still "in progress" when a session
//     ends are kept as final text — iPhone often never marks its last
//     words final — so nothing that was said is dropped.
//
//  2. Voice notes (addVoiceNote / removeVoiceNote): a recording kept with
//     the item. Same rule as photos: the bytes are saved AND read back
//     (store.putMedia) before the item points at them. Removing a voice note
//     only takes it off the item's list — the entry moves to
//     item.removedVoiceNotes and the recording stays on the phone until the
//     whole item is deleted for good from Recently Deleted (store.purgeItem
//     erases every byte saved with the item's id). So a mis-tap never
//     destroys a recording, and restoreVoiceNote can bring it back.
//
// Browser globals are only touched inside functions, so the Node tests can
// import this module (and pass a fake recognition class).

import * as store from './store.js';
import { uid } from './util.js';

// ---- dictation ------------------------------------------------------------------------

/** The browser's speech recognition class, or null where there is none (Firefox, Node). */
export function speechRecognitionClass() {
  const g = typeof window !== 'undefined' ? window : globalThis;
  return g.SpeechRecognition || g.webkitSpeechRecognition || null;
}

// Error codes after which listening again cannot help: the person has to
// change something first. Every other code (no-speech, aborted, …) just ends
// the session, and a new one starts while dictation is still wanted.
const FATAL = {
  'not-allowed': 'Dictation needs the microphone. Allow it for this site in the browser settings, or use the microphone key on the keyboard.',
  'service-not-allowed': 'Dictation is not available here. On iPhone, turn on Siri & Dictation in Settings, or use the microphone key on the keyboard.',
  'audio-capture': 'No microphone was found for dictation.',
  network: 'Dictation needs a data connection on this phone. Type the note, or use the microphone key on the keyboard.',
  'language-not-supported': "Dictation does not support this phone's language. Use the microphone key on the keyboard instead.",
};
const GENERIC = 'Dictation stopped. Tap Dictate to try again.';
const KEEPS_STOPPING = 'Dictation keeps stopping on this phone. Tap Dictate to try again, or use the microphone key on the keyboard.';

const isAndroid = () => typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');

/**
 * Turn speech into text, for as long as the person wants.
 *
 *   const d = createDictation({onText, onInterim, onEnd, onError});
 *   if (d) button.onclick = () => d.start();      // start() from a tap (permission prompt)
 *
 * onText(text)      a finished phrase, to insert into the note
 * onInterim(text)   the words being recognised right now ('' when none) — show them, don't save them
 * onEnd()           listening has stopped (after stop(), or after a problem)
 * onError(err)      err.message is a plain sentence for the person; err.code the browser's code
 * lang              BCP-47 language, default the phone's language
 * dedupe            drop repeated phrases (some Android versions deliver every phrase again,
 *                   with the next words added); default: on Android only
 * Recognition       a SpeechRecognition class to use instead of the browser's (tests)
 *
 * Returns null when the browser cannot recognise speech.
 * @returns {{start: () => void, stop: () => void, supported: true, readonly listening: boolean} | null}
 */
export function createDictation({ onText, onInterim, onEnd, onError, lang, dedupe, Recognition } = {}) {
  const Rec = Recognition || speechRecognitionClass();
  if (!Rec) return null;
  const language = lang || (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
  const dropRepeats = dedupe ?? isAndroid();

  let wanted = false;       // between start() and stop(): keep listening, session after session
  let running = false;      // start() was called and onEnd has not been delivered yet
  let active = null;        // the session in progress
  let restartTimer = null;
  let stopTimer = null;
  let quickEnds = 0;        // sessions in a row that ended at once without hearing anything

  const call = (fn, ...args) => {
    try { fn?.(...args); } catch (err) { console.error('[voice] dictation callback failed', err); }
  };

  function finish() {
    clearTimeout(restartTimer); restartTimer = null;
    clearTimeout(stopTimer); stopTimer = null;
    if (!running) return;
    running = false;
    call(onEnd);
  }

  function fail(code, message) {
    wanted = false;
    const err = new Error(message || FATAL[code] || GENERIC);
    err.code = code || 'error';
    call(onError, err);
  }

  function begin() {
    let rec;
    try {
      rec = new Rec();
      rec.lang = language;
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
    } catch {
      fail('start');
      finish();
      return;
    }
    const s = { rec, startedAt: Date.now(), heard: false, done: new Set(), interim: '', lastFinal: '', lastFinalAt: 0 };
    active = s;
    rec.onresult = (e) => onResult(s, e);
    rec.onerror = (e) => onSessionError(s, e);
    rec.onend = () => onSessionEnd(s);
    try {
      rec.start();
    } catch (err) {
      active = null;
      fail(err?.name === 'NotAllowedError' ? 'not-allowed' : 'start');
      finish();
    }
  }

  function emitFinal(s, raw) {
    const now = Date.now();
    const text = dropRepeats ? dedupeFinal(s.lastFinal, raw, now - s.lastFinalAt) : String(raw || '').trim();
    s.lastFinal = String(raw || '').trim();
    s.lastFinalAt = now;
    if (text) call(onText, text);
  }

  function onResult(s, e) {
    if (s !== active) return;
    s.heard = true;
    const results = e?.results || [];
    let interim = '';
    for (let i = e?.resultIndex || 0; i < results.length; i++) {
      const r = results[i];
      const t = r?.[0]?.transcript || '';
      if (r?.isFinal) {
        // Each result index is final once; some browsers send it again in later events.
        if (!s.done.has(i)) { s.done.add(i); emitFinal(s, t); }
      } else {
        interim += t;
      }
    }
    s.interim = interim.trim();
    call(onInterim, s.interim);
  }

  function onSessionError(s, e) {
    if (s !== active) return;
    const code = e?.error || 'error';
    if (FATAL[code]) fail(code);
    // The session ends next (onend), and onSessionEnd decides what happens.
  }

  function onSessionEnd(s) {
    if (s !== active) return;
    active = null;
    clearTimeout(stopTimer); stopTimer = null;
    // iPhone often ends a session before marking its last words final: keep them.
    if (s.interim) { const words = s.interim; s.interim = ''; emitFinal(s, words); }
    call(onInterim, '');
    if (!wanted) { finish(); return; }
    // Ended on its own while the person still wants to talk: listen again.
    const quick = !s.heard && Date.now() - s.startedAt < 1500;
    quickEnds = quick ? quickEnds + 1 : 0;
    if (quickEnds >= 5) { fail('ended', KEEPS_STOPPING); finish(); return; }
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (wanted) begin(); else finish();
    }, quick ? 150 * quickEnds : 60);
  }

  return {
    supported: true,
    get listening() { return wanted; },
    start() {
      if (wanted) return;
      wanted = true;
      running = true;
      quickEnds = 0;
      // A session that is still finishing after stop() ends soon and, now
      // that listening is wanted again, starts the next one by itself.
      if (active) return;
      clearTimeout(restartTimer); restartTimer = null;
      begin();
    },
    stop() {
      if (!wanted && !active && !restartTimer) return;
      wanted = false;
      clearTimeout(restartTimer); restartTimer = null;
      const s = active;
      if (!s) { finish(); return; }
      try { s.rec.stop(); } catch { /* already stopping */ }
      // stop() lets the last words arrive, then the browser says "end". If it
      // never does (seen on some phones), end it here.
      clearTimeout(stopTimer);
      stopTimer = setTimeout(() => {
        stopTimer = null;
        if (active !== s) return;
        try { s.rec.abort(); } catch { /* gone */ }
        onSessionEnd(s);
      }, 2000);
    },
  };
}

/**
 * The new words of a finished phrase, given the phrase finished just before it.
 * Some Android versions deliver every phrase again with the next words added
 * ("two by", "two by twelve header") — that keeps only "twelve header".
 * A phrase repeated word for word within 3 s is a repeat, not new speech.
 * Only applied where that happens (createDictation's `dedupe`), because a
 * person may really say the same words twice.
 */
export function dedupeFinal(prev, next, sinceMs = Infinity) {
  const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean);
  const n = words(next);
  if (!n.length) return '';
  const p = words(prev);
  if (!p.length) return n.join(' ');
  const key = (w) => w.toLowerCase().replace(/[.,!?;:]+$/, '');
  const isPrefix = p.length <= n.length && p.every((w, i) => key(w) === key(n[i]));
  if (!isPrefix) return n.join(' ');
  if (n.length === p.length) return sinceMs < 3000 ? '' : n.join(' ');
  if (p.length >= 2 && sinceMs < 4000) return n.slice(p.length).join(' ');
  return n.join(' ');
}

/**
 * The text to insert for a dictated phrase between `before` and `after`
 * (the note's text on each side of the cursor): a space where one is
 * needed, and a capital letter at the start of a sentence.
 * joinDictated('Header over garage', 'needs a 4x12') → ' needs a 4x12'
 */
export function joinDictated(before, text, after = '') {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const b = String(before || '');
  const sentenceStart = !b.trim() || /[.!?]["')\]]?\s*$/.test(b) || /\n\s*$/.test(b);
  if (sentenceStart) t = t.charAt(0).toUpperCase() + t.slice(1);
  const lead = b && !/\s$/.test(b) ? ' ' : '';
  const a = String(after || '');
  const trail = a && !/^[\s.,;:!?)\]]/.test(a) ? ' ' : '';
  return lead + t + trail;
}

// ---- voice notes ------------------------------------------------------------------------

/**
 * Keep a recorded voice note with an item. The bytes are saved and verified
 * first (store.putMedia, kind 'voice'), then the item's voiceNotes list gets
 * {id, mediaId, duration, mimeType, createdAt, transcript: ''}.
 * Resolves with the updated item. Rejects with a plain message otherwise;
 * if only the second step failed, err.mediaId names the saved bytes (they
 * belong to the item and are kept).
 * @param {string} itemId
 * @param {{blob: Blob, duration?: number, mimeType?: string}} recording
 */
export async function addVoiceNote(itemId, { blob, duration, mimeType } = {}) {
  const item = await store.getItem(itemId);
  if (!item) throw new Error('That photo or note no longer exists on this phone, so the voice note could not be added to it.');
  if (!(blob instanceof Blob) || !blob.size) {
    throw new Error('The recording was empty. Tap Record, talk for a moment, then tap Stop.');
  }
  const mediaId = await store.putMedia(blob, { kind: 'voice', projectId: item.projectId, itemId, name: 'voice note' });
  const entry = {
    id: uid('v_'),
    mediaId,
    duration: Number.isFinite(duration) && duration >= 0 ? duration : null,
    mimeType: mimeType || blob.type || '',
    createdAt: Date.now(),
    transcript: '',
  };
  const attach = () => store.updateItem(itemId, (cur) => {
    cur.voiceNotes = [...(cur.voiceNotes || []).filter((v) => v.mediaId !== mediaId), entry];
  });
  try {
    return await attach();
  } catch {
    // The bytes are safe on the phone; only linking them failed (a busy
    // database, another tab). One more try before telling the person.
    try {
      return await attach();
    } catch (err) {
      err.mediaId = mediaId;
      throw err;
    }
  }
}

/**
 * Take a voice note off an item. The recording is NOT erased: the entry
 * moves to item.removedVoiceNotes (with removedAt) and its bytes stay until
 * the item itself is deleted for good. Resolves with the updated item.
 */
export async function removeVoiceNote(itemId, voiceId) {
  const item = await store.getItem(itemId);
  if (!item) throw new Error('That photo or note no longer exists on this phone.');
  if (!(item.voiceNotes || []).some((v) => v.id === voiceId)) {
    // Already removed (another tab, a double tap): nothing to do.
    if ((item.removedVoiceNotes || []).some((v) => v.id === voiceId)) return item;
    throw new Error('That voice note is not on this item any more.');
  }
  return store.updateItem(itemId, (cur) => {
    const list = cur.voiceNotes || [];
    const v = list.find((x) => x.id === voiceId);
    if (!v) return cur;
    cur.voiceNotes = list.filter((x) => x.id !== voiceId);
    cur.removedVoiceNotes = [...(cur.removedVoiceNotes || []), { ...v, removedAt: Date.now() }];
    return cur;
  });
}

/** Put a removed voice note back on its item (Undo). Resolves with the updated item. */
export async function restoreVoiceNote(itemId, voiceId) {
  return store.updateItem(itemId, (cur) => {
    const removed = cur.removedVoiceNotes || [];
    const v = removed.find((x) => x.id === voiceId);
    const list = cur.voiceNotes || [];
    if (!v) {
      if (list.some((x) => x.id === voiceId)) return cur; // already back
      throw new Error('That voice note can no longer be brought back here.');
    }
    const { removedAt, ...entry } = v; // eslint-disable-line no-unused-vars
    cur.removedVoiceNotes = removed.filter((x) => x.id !== voiceId);
    if (!list.some((x) => x.id === voiceId)) {
      cur.voiceNotes = [...list, entry].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    }
    return cur;
  });
}
