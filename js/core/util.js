// util.js — small helpers every module shares: ids, numbers, lengths, dates, HTML.
//
// Nothing here touches the DOM or the database, so the Node tests can import
// it as it is.

/**
 * A new id: time-ordered, so a list sorted by id is sorted by when things
 * were made, with 64 random bits so two phones (or two quick taps) never
 * collide. `prefix` says what it names: p_ project, l_ level, i_ item,
 * m_ media, r_ recording, v_ voice note.
 */
export function uid(prefix = '') {
  const t = Date.now().toString(36).padStart(9, '0');
  const r = new Uint32Array(2);
  globalThis.crypto.getRandomValues(r);
  return `${prefix}${t}${r[0].toString(36).padStart(7, '0')}${r[1].toString(36).padStart(7, '0')}`;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const DEG = Math.PI / 180;

/** An angle in degrees folded into [0, 360). */
export function normDeg(d) {
  const r = d % 360;
  const v = r < 0 ? r + 360 : r;
  return v >= 360 ? 0 : v; // -1e-15 % 360 + 360 rounds to exactly 360
}

/** The signed difference b − a in degrees, folded into (−180, 180]. */
export function deltaDeg(a, b) {
  let d = normDeg(b - a);
  if (d > 180) d -= 360;
  return d;
}

/** "N", "NE", … for a heading in degrees clockwise from north. */
export function compassPoint(deg) {
  const pts = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return pts[Math.round(normDeg(deg) / 45) % 8];
}

export function debounce(fn, ms) {
  let t = null;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  };
  d.flush = (...args) => { if (t) { clearTimeout(t); t = null; fn(...args); } };
  d.cancel = () => { clearTimeout(t); t = null; };
  return d;
}

export function throttle(fn, ms) {
  let last = 0, timer = null, pending = null;
  return (...args) => {
    const now = Date.now();
    pending = args;
    if (now - last >= ms) {
      last = now;
      fn(...pending);
      pending = null;
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        if (pending) { fn(...pending); pending = null; }
      }, ms - (now - last));
    }
  };
}

/** Text safe to put inside HTML (element content or a quoted attribute). */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---- lengths -------------------------------------------------------------
//
// Everything is stored in meters. What the user sees follows the Units
// setting: 'imperial' (feet and inches, the default — this is a US framing
// company) or 'metric'.

export const M_PER_FT = 0.3048;

/** 3.81 m → `12' 6"` (imperial) or `3.81 m` (metric). */
export function formatLength(meters, units = 'imperial', { precisionIn = 1 } = {}) {
  if (meters == null || !isFinite(meters)) return '—';
  if (units === 'metric') {
    const a = Math.abs(meters);
    return a >= 100 ? `${meters.toFixed(0)} m` : a >= 10 ? `${meters.toFixed(1)} m` : `${meters.toFixed(2)} m`;
  }
  const neg = meters < 0;
  let totalIn = Math.abs(meters) / M_PER_FT * 12;
  totalIn = Math.round(totalIn / precisionIn) * precisionIn;
  let ft = Math.floor(totalIn / 12);
  let inch = totalIn - ft * 12;
  if (inch >= 12 - 1e-9) { ft += 1; inch = 0; }
  const inStr = Number.isInteger(inch) ? String(inch) : inch.toFixed(1);
  const s = ft ? (inch ? `${ft}' ${inStr}"` : `${ft}'`) : `${inStr}"`;
  return neg ? `-${s}` : s;
}

/** A short accuracy figure: `±4 ft` / `±1.2 m`. */
export function formatAccuracy(meters, units = 'imperial') {
  if (meters == null || !isFinite(meters)) return '—';
  if (units === 'metric') return `±${meters < 10 ? meters.toFixed(1) : Math.round(meters)} m`;
  const ft = meters / M_PER_FT;
  return `±${ft < 10 ? ft.toFixed(1) : Math.round(ft)} ft`;
}

/**
 * What a person types for a length → meters, or null when it is not one.
 * Accepts `12'6"`, `12' 6`, `12 6`, `12ft 6in`, `12.5'`, `150"`, `12-6`,
 * `3.81m`, `381cm`, `3810mm`, and a bare number in the current units
 * (feet for imperial, meters for metric).
 */
export function parseLength(text, units = 'imperial') {
  if (text == null) return null;
  let s = String(text).trim().toLowerCase().replace(/[’′]/g, "'").replace(/[”″]/g, '"').replace(/,/g, '.');
  if (!s) return null;
  let m;
  if ((m = s.match(/^(-?\d+(?:\.\d+)?)\s*(mm|cm|m|meters?|metres?)$/))) {
    const v = parseFloat(m[1]);
    return m[2] === 'mm' ? v / 1000 : m[2] === 'cm' ? v / 100 : v;
  }
  if ((m = s.match(/^(-?\d+(?:\.\d+)?)\s*(?:"|in|inch|inches)$/))) return parseFloat(m[1]) / 12 * M_PER_FT;
  if ((m = s.match(/^(-?\d+(?:\.\d+)?)\s*(?:'|ft|feet|foot)\s*(?:-\s*)?(?:(\d+(?:\.\d+)?)\s*(?:"|in|inch|inches)?)?$/))) {
    const ft = parseFloat(m[1]);
    const inch = m[2] ? parseFloat(m[2]) : 0;
    return (Math.abs(ft) + inch / 12) * Math.sign(ft || 1) * M_PER_FT;
  }
  if ((m = s.match(/^(\d+)\s*[- ]\s*(\d+(?:\.\d+)?)$/)) && units !== 'metric') {
    return (parseFloat(m[1]) + parseFloat(m[2]) / 12) * M_PER_FT;
  }
  if ((m = s.match(/^-?\d+(?:\.\d+)?$/))) {
    const v = parseFloat(s);
    return units === 'metric' ? v : v * M_PER_FT;
  }
  return null;
}

// ---- dates and sizes -----------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

/** Today in the phone's own time zone: 2026-11-02. */
export function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Nov 2, 2026 3:41 PM */
export function formatDateTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function formatDate(msOrIso) {
  if (!msOrIso) return '';
  const d = typeof msOrIso === 'string' ? new Date(msOrIso + (msOrIso.length === 10 ? 'T12:00:00' : '')) : new Date(msOrIso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatTime(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** 0:07, 1:32, 1:02:05 */
export function formatDuration(seconds) {
  if (seconds == null || !isFinite(seconds)) return '';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

export function formatBytes(n) {
  if (n == null || !isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

/** A file name that is safe on Windows, macOS, iOS and Android. */
export function safeFileName(s, fallback = 'file') {
  const out = String(s ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  return out.slice(0, 120) || fallback;
}

/** Wait, cancellable through an AbortSignal. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason || new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

export const isIOS = () => typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

export const isStandalone = () => typeof window !== 'undefined' &&
  (window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true);

/** Light haptic tick where the phone supports it (Android); silent elsewhere. */
export function buzz(pattern = 15) {
  try { navigator.vibrate?.(pattern); } catch { /* not supported */ }
}
