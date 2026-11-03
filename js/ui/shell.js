// shell.js — the pieces every screen shares: a DOM helper, toasts, dialogs,
// bottom sheets, a busy overlay.
//
// All of them are plain DOM with classes styled in css/app.css, appended to
// #overlays so they sit above any screen. Dialogs return Promises, so a
// screen writes `if (await confirmDialog({...})) …`.

import { icon } from './icons.js';
import { escapeHtml, isIOS as isIOSDevice } from '../core/util.js';

// The screens build their DOM as `node.append(a, cond ? b : null, …)`, the
// same way el() takes children. The browser's own append / prepend /
// replaceChildren would print a null as the word "null" on screen, so here
// they skip null, undefined and false exactly as el() does. Done once, when
// this module loads (every screen imports it).
if (typeof Element !== 'undefined' && !Element.prototype.__jwSkipsEmpty) {
  for (const proto of [Element.prototype, DocumentFragment.prototype, Document.prototype]) {
    for (const name of ['append', 'prepend', 'replaceChildren']) {
      const native = proto[name];
      if (typeof native !== 'function') continue;
      Object.defineProperty(proto, name, {
        configurable: true,
        writable: true,
        value(...nodes) { return native.apply(this, nodes.filter((n) => n != null && n !== false)); },
      });
    }
  }
  Object.defineProperty(Element.prototype, '__jwSkipsEmpty', { value: true });
}

/**
 * el('button', {class: 'btn', onclick: fn, 'aria-label': 'Close'}, 'Text', childNode)
 * Attributes: `class`, `style` (string or object), `html` (innerHTML, trusted
 * strings only — e.g. icon()), `on<event>` handlers, `dataset` (object),
 * booleans (true → present, false/null → absent); everything else via
 * setAttribute. Children: strings become text nodes (never parsed as HTML).
 */
export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else n.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

/** A button with an icon and optional label. */
export function iconButton(name, { label = '', cls = 'icon-btn', title = label, onclick, size = 22 } = {}) {
  return el('button', {
    type: 'button', class: cls, title: title || null, 'aria-label': title || label || name, onclick,
    html: icon(name, { size }) + (label ? `<span>${escapeHtml(label)}</span>` : ''),
  });
}

function overlays() {
  let o = document.getElementById('overlays');
  if (!o) { o = el('div', { id: 'overlays' }); document.body.append(o); }
  return o;
}

// ---- toasts -------------------------------------------------------------------

/**
 * A short message at the bottom of the screen.
 * type: 'info' | 'ok' | 'err' | 'warn'. Errors stay until tapped.
 * action: {label, onclick} adds a button (e.g. Undo).
 */
export function toast(message, { type = 'info', ms, action } = {}) {
  let host = document.getElementById('toasts');
  if (!host) { host = el('div', { id: 'toasts', 'aria-live': 'polite' }); overlays().append(host); }
  const ic = { ok: 'check', err: 'warning', warn: 'warning', info: 'info' }[type] || 'info';
  const t = el('div', { class: `toast toast-${type}`, role: type === 'err' ? 'alert' : 'status' },
    el('span', { class: 'toast-ic', html: icon(ic, { size: 18 }) }),
    el('span', { class: 'toast-msg' }, message));
  const close = () => { t.classList.add('out'); setTimeout(() => t.remove(), 250); };
  if (action) {
    t.append(el('button', { type: 'button', class: 'toast-act', onclick: (e) => { e.stopPropagation(); close(); action.onclick?.(); } }, action.label));
  }
  t.addEventListener('click', close);
  host.append(t);
  const life = ms ?? (type === 'err' ? 0 : type === 'warn' ? 6000 : 2600);
  if (life) setTimeout(close, life);
  return { close };
}

// ---- open overlays -------------------------------------------------------------------
//
// Dialogs and sheets stack (a password prompt over the plan sheet). Only the
// top one answers Escape/Enter, and the router closes them all — as if the
// person had cancelled — when the screen changes, so a dialog never stays
// over the next screen after the phone's back button.

const stack = [];

function pushOverlay(back, cancel) {
  const entry = { back, cancel };
  stack.push(entry);
  return () => {
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
  };
}

const isTop = (back) => stack[stack.length - 1]?.back === back;

/** Cancel every open dialog and sheet (top first). Busy overlays are left alone. */
export function closeAllOverlays() {
  for (const entry of [...stack].reverse()) {
    try { entry.cancel(); } catch (err) { console.error('[shell] closing an overlay failed', err); }
  }
}

// ---- modal dialogs ------------------------------------------------------------------

function modal({ title, body, buttons, onKey, cls = '' }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const back = el('div', { class: 'modal-back' });
    const box = el('div', { class: `modal ${cls}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' });
    if (title) box.append(el('h2', { class: 'modal-title' }, title));
    if (body) box.append(body instanceof Node ? body : el('div', { class: 'modal-body' }, body));
    const row = el('div', { class: 'modal-btns' });
    let finished = false;
    const done = (v) => {
      if (finished) return;
      finished = true;
      unregister();
      document.removeEventListener('keydown', key, true);
      back.classList.add('out');
      setTimeout(() => back.remove(), 180);
      try { prevFocus?.focus?.(); } catch { /* gone */ }
      resolve(v);
    };
    for (const b of buttons) {
      row.append(el('button', { type: 'button', class: b.cls || 'btn', onclick: () => done(typeof b.value === 'function' ? b.value() : b.value) }, b.label));
    }
    box.append(row);
    back.append(box);
    const cancel = () => done(buttons.find((b) => b.cancel)?.value ?? null);
    back.addEventListener('click', (e) => { if (e.target === back) cancel(); });
    const key = (e) => {
      if (!isTop(back)) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
      else onKey?.(e, done);
    };
    const unregister = pushOverlay(back, cancel);
    document.addEventListener('keydown', key, true);
    overlays().append(back);
    requestAnimationFrame(() => {
      const f = box.querySelector('input, textarea, select') || row.lastElementChild;
      f?.focus?.();
    });
  });
}

/** Yes/no. Resolves true or false. `danger` makes the OK button red. */
export function confirmDialog({ title = 'Are you sure?', message = '', okText = 'OK', cancelText = 'Cancel', danger = false } = {}) {
  return modal({
    title,
    body: message ? el('div', { class: 'modal-body' }, message) : null,
    buttons: [
      { label: cancelText, value: false, cancel: true, cls: 'btn btn-ghost' },
      { label: okText, value: true, cls: danger ? 'btn btn-danger' : 'btn btn-primary' },
    ],
    onKey: (e, done) => { if (e.key === 'Enter') { e.preventDefault(); done(true); } },
  });
}

/** A message with one button. */
export function alertDialog({ title = '', message = '', okText = 'OK' } = {}) {
  return modal({ title, body: el('div', { class: 'modal-body' }, message), buttons: [{ label: okText, value: true, cancel: true, cls: 'btn btn-primary' }] });
}

/** Ask for text. Resolves the text (trimmed) or null when cancelled. */
export function promptDialog({ title = '', label = '', value = '', placeholder = '', okText = 'OK', multiline = false, inputmode, type = 'text' } = {}) {
  const input = multiline
    ? el('textarea', { class: 'input', rows: 4, placeholder })
    : el('input', { class: 'input', type, placeholder, inputmode, autocomplete: 'off' });
  input.value = value ?? '';
  const body = el('label', { class: 'field' }, label ? el('span', { class: 'field-label' }, label) : null, input);
  return modal({
    title,
    body,
    buttons: [
      { label: 'Cancel', value: null, cancel: true, cls: 'btn btn-ghost' },
      { label: okText, value: () => input.value.trim(), cls: 'btn btn-primary' },
    ],
    onKey: (e, done) => { if (e.key === 'Enter' && !multiline) { e.preventDefault(); done(input.value.trim()); } },
  });
}

/**
 * A form in a dialog. fields: [{name, label, value, type ('text'|'date'|'number'|'textarea'|'select'), options, placeholder, inputmode}]
 * Resolves {name: value} or null.
 */
export function formDialog({ title = '', fields = [], okText = 'Save', intro = '' } = {}) {
  const inputs = {};
  const body = el('div', { class: 'modal-body form' }, intro ? el('p', { class: 'muted' }, intro) : null);
  for (const f of fields) {
    let input;
    if (f.type === 'textarea') input = el('textarea', { class: 'input', rows: f.rows || 3, placeholder: f.placeholder || '' });
    else if (f.type === 'select') input = el('select', { class: 'input' }, (f.options || []).map((o) => el('option', { value: o.value }, o.label)));
    else input = el('input', { class: 'input', type: f.type || 'text', placeholder: f.placeholder || '', inputmode: f.inputmode, autocomplete: 'off' });
    input.value = f.value ?? '';
    inputs[f.name] = input;
    body.append(el('label', { class: 'field' }, el('span', { class: 'field-label' }, f.label), input));
  }
  return modal({
    title,
    body,
    buttons: [
      { label: 'Cancel', value: null, cancel: true, cls: 'btn btn-ghost' },
      { label: okText, value: () => Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value.trim()])), cls: 'btn btn-primary' },
    ],
  });
}

/**
 * An action sheet: pick one option. options: [{value, label, icon, detail, danger, disabled}]
 * Resolves the value, or null.
 */
export function choose({ title = '', options = [], cancelText = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    const sh = openSheet({ title, onClose: () => resolve(null) });
    const list = el('div', { class: 'choose-list' });
    for (const o of options) {
      list.append(el('button', {
        type: 'button',
        class: `choose-opt${o.danger ? ' danger' : ''}`,
        disabled: !!o.disabled,
        onclick: () => { sh.close(true); resolve(o.value); },
      },
      o.icon ? el('span', { class: 'choose-ic', html: icon(o.icon, { size: 22 }) }) : null,
      el('span', { class: 'choose-txt' }, el('span', { class: 'choose-label' }, o.label), o.detail ? el('span', { class: 'choose-detail' }, o.detail) : null)));
    }
    sh.body.append(list, el('button', { type: 'button', class: 'btn btn-ghost btn-block', onclick: () => sh.close() }, cancelText));
  });
}

/**
 * A bottom sheet. Returns {el, body, close(silent)}. onClose runs when the
 * person dismisses it (tap outside, Escape, close button) — not when
 * close(true) is called by code that already handled the result.
 */
export function openSheet({ title = '', onClose, cls = '', closeButton = true } = {}) {
  const back = el('div', { class: 'sheet-back' });
  const sheet = el('div', { class: `sheet ${cls}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Panel' });
  const head = el('div', { class: 'sheet-head' },
    el('div', { class: 'sheet-grip' }),
    title ? el('h2', { class: 'sheet-title' }, title) : null,
    closeButton ? iconButton('close', { title: 'Close', onclick: () => close() }) : null);
  const body = el('div', { class: 'sheet-body' });
  sheet.append(head, body);
  back.append(sheet);
  let closed = false;
  const key = (e) => {
    if (e.key === 'Escape' && isTop(back)) { e.preventDefault(); e.stopPropagation(); close(); }
  };
  const unregister = pushOverlay(back, () => close());
  function close(silent = false) {
    if (closed) return;
    closed = true;
    unregister();
    document.removeEventListener('keydown', key, true);
    back.classList.add('out');
    setTimeout(() => back.remove(), 220);
    if (!silent) onClose?.();
  }
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', key, true);
  overlays().append(back);
  return { el: sheet, body, close };
}

// ---- busy -----------------------------------------------------------------------------

/**
 * A blocking progress overlay for work that must not be interrupted
 * (export, import, PDF rendering). busy('Exporting…') → {update(text, fraction), done()}
 */
export function busy(text = 'Working…', { cancellable = false, onCancel } = {}) {
  const msg = el('div', { class: 'busy-msg' }, text);
  const bar = el('div', { class: 'busy-bar' }, el('div', { class: 'busy-fill' }));
  const box = el('div', { class: 'busy-box' }, el('div', { class: 'spinner' }), msg, bar);
  if (cancellable) box.append(el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => onCancel?.() }, 'Cancel'));
  const back = el('div', { class: 'busy-back' }, box);
  overlays().append(back);
  return {
    update(t, fraction) {
      if (t != null) msg.textContent = t;
      if (fraction != null && isFinite(fraction)) {
        bar.classList.add('on');
        bar.firstChild.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
      }
    },
    done() { back.remove(); },
  };
}

/** Pick files with the system picker. Resolves an array (empty when cancelled, where detectable). */
export function pickFiles({ accept = '', multiple = false, capture } = {}) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept, multiple, capture, style: { position: 'fixed', left: '-1000px', top: '0', opacity: '0' } });
    let settled = false;
    const finish = (files) => { if (settled) return; settled = true; input.remove(); resolve(files); };
    input.addEventListener('change', () => finish([...(input.files || [])]));
    input.addEventListener('cancel', () => finish([]));
    document.body.append(input);
    input.click();
  });
}

/** What Chrome's share sheet takes (it refuses other files, a .zip among them, even when canShare() says yes). */
const CHROME_SHAREABLE = /^(image\/(jpeg|png|webp|gif|bmp|avif)|video\/(mp4|webm|mpeg|ogg)|audio\/[a-z0-9.+-]+|text\/(plain|csv)|application\/pdf)$/;
/** Chrome on Android shares at most about this much. */
const CHROME_SHARE_MAX_BYTES = 50 * 1024 * 1024;
/** Types the share sheet refused this session: saved another way from then on, so "tap again" cannot loop. */
const shareRefused = new Set();

const baseType = (type) => String(type || '').split(';')[0].trim().toLowerCase();

/**
 * The share sheet with one file. → 'shared' | 'cancelled' | 'needs-tap', or
 * null when the file should be saved another way. Builds the File and calls
 * share() before any await, so the tap still counts.
 */
async function shareFile(blob, fileName, type, title) {
  const file = new File([blob], fileName, { type });
  let can = false;
  try { can = !!navigator.canShare?.({ files: [file] }); } catch { can = false; }
  if (!can) return null;
  try {
    await navigator.share({ files: [file], title: title || fileName });
    return 'shared';
  } catch (err) {
    if (err?.name === 'AbortError') return 'cancelled';
    // iPhone: the tap was used up (or the pre-27.2 bug that drops it on the first try).
    if (err?.name === 'NotAllowedError' && isIOSDevice()) return 'needs-tap';
    shareRefused.add(baseType(type));
    console.warn('[saveBlob] the share sheet refused the file, saving it instead', err);
    // A picker or download started after the tap was used up is refused, or
    // does nothing while looking started — ask for a fresh tap instead.
    if (navigator.userActivation && !navigator.userActivation.isActive) return 'needs-tap';
    return null;
  }
}

// Object URLs of downloads started here. The browser can take a while to
// fetch one (iPhone first asks "Download?"), so each is kept for
// DOWNLOAD_URL_LIFE_MS (the browser drops them all when the page goes away),
// or until the screen that started it calls releaseDownloads() — not cut
// off after a minute.
const DOWNLOAD_URL_LIFE_MS = 10 * 60 * 1000;
const downloads = new Set();

/** Let go of every download started by saveBlob (a screen holding big files calls this when it closes). */
export function releaseDownloads() {
  for (const d of [...downloads]) d.release();
}

/**
 * Save a Blob as a file the person keeps. MUST be called straight from a tap
 * (no long await before it): the picker and the share sheet both need a
 * fresh tap, so build the file first, then show a "Save" button.
 *
 *  - Chrome (Android 132+, desktop): the "Save as" picker, so the person
 *    chooses the folder (Drive, Downloads…) and the file is written there.
 *    Not the share sheet: Chrome on Android refuses .zip files there.
 *  - iPhone/iPad: the share sheet ("Save to Files", OneDrive, Mail…).
 *  - Otherwise: a normal download.
 *
 * `share: true` is for a Share button: the share sheet first on every
 * browser that takes the file (Android too, for a photo, video or voice
 * note), else saved as above. `preferShare` only chooses the share sheet
 * on iPhone, so Download and the rescue saves keep the picker on Android.
 *
 * Resolves 'saved' | 'shared' | 'downloaded' | 'cancelled' | 'needs-tap'.
 * Only 'saved' and 'shared' prove the file exists; 'downloaded' means a
 * download was started (the person may still refuse it). 'needs-tap': the
 * browser wanted a fresh tap and nothing was saved — show a "Tap to save"
 * button that calls saveBlob again.
 */
export async function saveBlob(blob, fileName, { preferShare = true, share = false, title = '', types } = {}) {
  const type = blob.type || 'application/octet-stream';
  let shareTried = false;
  if (share && typeof File === 'function' && typeof navigator.share === 'function' && !shareRefused.has(baseType(type)) &&
      (isIOSDevice() || (CHROME_SHAREABLE.test(baseType(type)) && blob.size <= CHROME_SHARE_MAX_BYTES))) {
    shareTried = true;
    const r = await shareFile(blob, fileName, type, title);
    if (r) return r;
  }
  if (typeof window.showSaveFilePicker === 'function' && !isIOSDevice()) {
    try {
      const ext = (fileName.match(/\.[a-z0-9]+$/i) || [''])[0];
      const handle = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: types || (ext ? [{ description: ext.slice(1).toUpperCase() + ' file', accept: { [type]: [ext] } }] : undefined),
      });
      const w = await handle.createWritable();
      await blob.stream().pipeTo(w);
      return 'saved';
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled';
      if (err?.name === 'SecurityError' || err?.name === 'NotAllowedError') return 'needs-tap';
      console.warn('[saveBlob] picker failed, downloading instead', err);
    }
  } else if ((preferShare || share) && !shareTried && isIOSDevice() && typeof File === 'function' && !shareRefused.has(baseType(type))) {
    const r = await shareFile(blob, fileName, type, title);
    if (r) return r;
    // Otherwise a download.
  }
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: fileName, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  let timer = null;
  const d = {
    release() {
      if (!downloads.delete(d)) return;
      clearTimeout(timer);
      a.remove();
      URL.revokeObjectURL(url);
    },
  };
  downloads.add(d);
  timer = setTimeout(() => d.release(), DOWNLOAD_URL_LIFE_MS);
  return 'downloaded';
}
