// map-view.js — the satellite (or street) map, with the same pins, paths,
// person and precise placement as the plan view.
//
// A job walk starts on the map when there is no floor plan yet, and the
// office uses it to line a plan up with the satellite image. It has the same
// interface as js/ui/plan-view.js, in geo coordinates ({lat, lng}) instead of
// plan pixels (docs/SPEC.md §7).
//
// How it is built. Leaflet 1.9.4 (vendored, loaded the first time a map
// opens) handles the tiles, panning and zooming. Everything of ours — pins,
// camera wedges, video paths, the person, calibration marks — is drawn on ONE
// canvas laid over the map with the plan view's drawing code
// (js/ui/markers.js), so a pin looks the same on the plan and on the map.
// That canvas is redrawn in the same frame Leaflet moves its tiles (on its
// 'move' / 'zoom' events), and during Leaflet's animated zooms the positions
// are interpolated exactly the way its CSS transition moves the tiles, so
// markers never slide behind the imagery.
//
// Base maps (docs/RESEARCH.md, "maps"):
//   esri    Esri World Imagery (default). With an ArcGIS key in Settings the
//           token endpoint is used (and if the key is refused, the public one,
//           with a message); without a key, the public server.arcgisonline.com
//           endpoint. Imagery is native to zoom 19 — past real data Esri sends
//           grey "Map data not yet available" tiles with HTTP 200, so tiles stop
//           at 19 and Leaflet stretches them; where Esri's tilemap service says
//           there is sharper imagery (20 or 21) the map uses it. The map zooms
//           to 22.
//   osm     OpenStreetMap streets.
//   google  Google satellite through the Map Tiles API (a key in Settings): a
//           session token (kept ~2 weeks, as Google allows), the "Google Maps"
//           mark and the copyright for the area on screen from the viewport
//           endpoint. Google's terms forbid showing it next to a non-Google
//           map, so when Google is the provider it is the ONLY base layer —
//           no switcher. If Google cannot start, Esri is shown instead.
// Every tile layer uses crossOrigin: true — the service worker keeps viewed
// tiles, and a non-CORS ("opaque") tile would count as ~7 MB of the storage
// the photos share.
//
// setPlanOverlay lays a calibrated floor plan over the imagery, rotated and
// scaled by its calibration, "multiplied" so the white paper is see-through
// and the lines stay dark (for checking a map alignment).
//
// searchAddress uses OpenStreetMap's Nominatim, only when the person asks:
// their policy allows no search-as-you-type and at most one request a second.

import { Emitter, bus } from '../core/bus.js';
import { getSettings } from '../core/settings.js';
import { clamp, DEG, escapeHtml, sleep, buzz } from '../core/util.js';
import { el, toast, iconButton } from './shell.js';
import { markerColors, drawCrosshair } from './markers.js';
import {
  interpolateTrack, hitTestTargets, simplifyScreenPath, drawScene, drawPlanImage, createPickOverlay,
  acquirePyramid, releasePyramid, imageWidth, imageHeight, affineFromCorners, isAnnotated, meStyle,
  isTypingTarget, overlayOpen, prefersReducedMotion,
} from './plan-view.js';

export const ESRI_PUBLIC = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';
export const ESRI_KEYED = 'https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer';
const ESRI_ATTRIBUTION = 'Powered by Esri | Esri, Maxar, Earthstar Geographics, and the GIS User Community';
const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
export const MAX_ZOOM = 22;
const ESRI_NATIVE = 19;
const GOOGLE_NATIVE = 20;          // until the viewport endpoint says more for this area
const DEFAULT_VIEW = { lat: 39.5, lng: -98.35, zoom: 4 };   // the continental US, until a position arrives
const EARTH_R = 6378137;           // the Web Mercator sphere every tile provider uses
const LOUPE_ZOOM = 3;
const TAP_DELAY_MS = 300;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const posNum = (v) => (isNum(v) && v > 0 ? v : 0);
const validLL = (p) => !!p && isNum(p.lat) && isNum(p.lng) && Math.abs(p.lat) <= 90;
const round7 = (v) => Math.round(v * 1e7) / 1e7;

/** A longitude folded into [−180, 180). */
export function wrapLng(lng) {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

// ---- pure helpers (tested) ------------------------------------------------------------------

/** URL template and Leaflet options for a base map ('esri' | 'osm'); a key switches Esri to its token endpoint. */
export function baseLayerSpec(provider, { esriKey = '' } = {}) {
  if (provider === 'osm') {
    return {
      kind: 'osm',
      // a/b/c subdomains: the CSP allows *.tile.openstreetmap.org, which does not cover the bare host.
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      options: { subdomains: 'abc', maxZoom: MAX_ZOOM, maxNativeZoom: 19, crossOrigin: true, attribution: OSM_ATTRIBUTION },
    };
  }
  const key = String(esriKey || '').trim();
  return {
    kind: key ? 'esri-key' : 'esri',
    url: key ? `${ESRI_KEYED}/tile/{z}/{y}/{x}?token=${encodeURIComponent(key)}` : `${ESRI_PUBLIC}/tile/{z}/{y}/{x}`,
    options: { maxZoom: MAX_ZOOM, maxNativeZoom: ESRI_NATIVE, crossOrigin: true, attribution: ESRI_ATTRIBUTION },
  };
}

/** Google 2D tile URL template (note the x/y order). */
export function googleTileUrl(session, key) {
  return `https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${encodeURIComponent(session)}&key=${encodeURIComponent(key)}`;
}

/** Google viewport-info URL: the copyright to show and the best zoom for an area. */
export function googleViewportUrl(session, key, zoom, { north, south, east, west }) {
  const p = new URLSearchParams({
    session, key, zoom: String(Math.round(clamp(zoom, 0, MAX_ZOOM))),
    north: String(clamp(north, -85, 85)), south: String(clamp(south, -85, 85)),
    east: String(wrapLng(east)), west: String(wrapLng(west)),
  });
  return `https://tile.googleapis.com/tile/v1/viewport?${p}`;
}

/** The highest zoom with Google imagery at `ll`, from a viewport answer's maxZoomRects; null if none covers it. */
export function googleMaxZoomAt(rects, ll) {
  let best = null;
  // Fold only what is outside ±180: wrapping 180 itself to −180 would shrink a whole-world rect to a line.
  const fold = (v) => (v >= -180 && v <= 180 ? v : wrapLng(v));
  for (const r of Array.isArray(rects) ? rects : []) {
    if (!isNum(r?.maxZoom) || !isNum(r.north) || !isNum(r.south) || !isNum(r.east) || !isNum(r.west)) continue;
    const inLat = ll.lat <= r.north && ll.lat >= r.south;
    const e = fold(r.east), w = fold(r.west), x = fold(ll.lng);
    const inLng = w <= e ? x >= w && x <= e : x >= w || x <= e;   // a rect may cross the date line
    if (inLat && inLng) best = best == null ? r.maxZoom : Math.max(best, r.maxZoom);
  }
  return best;
}

/** The Web Mercator tile {x, y} that holds (lat, lng) at zoom z. */
export function tileXY(lat, lng, z) {
  const n = 2 ** z;
  const latR = clamp(lat, -85.0511, 85.0511) * DEG;
  const x = Math.floor(((wrapLng(lng) + 180) / 360) * n);
  const y = Math.floor(((1 - Math.asinh(Math.tan(latR)) / Math.PI) / 2) * n);
  return { x: clamp(x, 0, n - 1), y: clamp(y, 0, n - 1) };
}

/** Screen px per meter on the ground at latitude `lat` and map zoom `zoom` (256-px tiles). */
export function pxPerMeterAt(lat, zoom) {
  return (256 * 2 ** zoom) / (2 * Math.PI * EARTH_R * Math.cos(clamp(lat, -85.0511, 85.0511) * DEG));
}

/** A CSS cubic-bezier timing function as a JS function of progress 0…1. */
export function cubicBezier(x1, y1, x2, y2) {
  const at = (t, a, b) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
  return (x) => {
    if (!(x > 0)) return 0;
    if (x >= 1) return 1;
    let lo = 0, hi = 1, t = x;
    for (let i = 0; i < 48; i++) {
      t = (lo + hi) / 2;
      const v = at(t, x1, x2);
      if (Math.abs(v - x) < 1e-7) break;
      if (v < x) lo = t; else hi = t;
    }
    return at(t, y1, y2);
  };
}

/** Leaflet's zoom animation curve (leaflet.css: transform 0.25s cubic-bezier(0,0,0.25,1)). */
export const leafletZoomEase = cubicBezier(0, 0, 0.25, 1);
const LEAFLET_ZOOM_MS = 250;

/** "38.5816, -121.4944" (or with a space) → {lat, lng}; null for anything else, so an address goes to the search. */
export function parseLatLng(text) {
  const m = String(text ?? '').trim().match(/^(-?\d{1,3}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m || !(m[1].includes('.') || m[2].includes('.'))) return null;
  const lat = +m[1], lng = +m[2];
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** The Nominatim search URL for a typed address. */
export function nominatimUrl(query, { limit = 6, lang = 'en' } = {}) {
  const p = new URLSearchParams({ format: 'jsonv2', limit: String(limit), addressdetails: '0', q: String(query), 'accept-language': lang });
  return `https://nominatim.openstreetmap.org/search?${p}`;
}

/**
 * A calibrated plan's corners on the Earth: plan px → meters east/north of
 * the project origin (calibration.planToEnu) → lat/lng (geo.fromEnu).
 * fns: {planToEnu, fromEnu} (passed in so this stays testable).
 */
export function planCornersLatLng(calibration, origin, W, H, { planToEnu, fromEnu }) {
  const at = (x, y) => {
    const en = planToEnu(calibration, { x, y });
    return fromEnu(origin, en.e, en.n);
  };
  return { tl: at(0, 0), tr: at(W, 0), bl: at(0, H), br: at(W, H) };
}

// ---- loading Leaflet and the calibration math ------------------------------------------------

let leafletPromise = null;

/** Load vendor/leaflet/leaflet.js once (a same-origin <script>, which the CSP allows). Resolves window.L. */
export function loadLeaflet() {
  if (typeof window !== 'undefined' && window.L?.map) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('../../vendor/leaflet/leaflet.js', import.meta.url).href;
    s.async = true;
    s.onload = () => (window.L?.map ? resolve(window.L) : reject(new Error('The map program loaded but did not start.')));
    s.onerror = () => {
      s.remove();
      reject(new Error('The map program could not be loaded. Open the app once with a signal so it can finish installing, then try again.'));
    };
    document.head.append(s);
  }).catch((err) => {
    leafletPromise = null;   // let a later map try again
    throw err;
  });
  return leafletPromise;
}

let calGeoPromise = null;
function loadCalGeo() {
  if (!calGeoPromise) {
    calGeoPromise = Promise.all([import('../core/calibration.js'), import('../core/geo.js')])
      .then(([cal, geo]) => ({ planToEnu: cal.planToEnu, fromEnu: geo.fromEnu }))
      .catch((err) => { calGeoPromise = null; throw err; });
  }
  return calGeoPromise;
}

function safeSettings() {
  try { return getSettings() || {}; } catch { return {}; }
}

// ---- Google Map Tiles sessions ---------------------------------------------------------------

const GSESSION_KEY = 'jw.googleTilesSession';

/** A short tag of the key (not the key itself) so a stored session is only reused with the key it was made for. */
function keyTag(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

async function googleSession(key, { fresh = false } = {}) {
  const tag = keyTag(key);
  if (!fresh) {
    try {
      const c = JSON.parse(localStorage.getItem(GSESSION_KEY) || 'null');
      if (c?.tag === tag && c.session && Number(c.expiry) * 1000 - Date.now() > 86400e3) return c;
    } catch { /* storage blocked: make a new session */ }
  }
  const lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
  const region = ((lang.split('-')[1] || 'US').slice(0, 2) || 'US').toUpperCase();
  let res;
  try {
    res = await fetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mapType: 'satellite', language: lang, region }),
      credentials: 'omit',
    });
  } catch {
    throw new Error('Google Maps could not be reached (no signal?).');
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch { /* not JSON */ }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new Error(`Google did not accept the map key${detail ? ` (${detail})` : ''}. Check it in Settings: it needs the Map Tiles API turned on.`);
    }
    throw new Error(`Google Maps answered with error ${res.status}.`);
  }
  const j = await res.json();
  if (!j?.session) throw new Error('Google Maps sent an answer the app could not read.');
  const s = { tag, session: j.session, expiry: Number(j.expiry) || Math.round(Date.now() / 1000 + 13 * 86400) };
  try { localStorage.setItem(GSESSION_KEY, JSON.stringify(s)); } catch { /* fine: a new session next time */ }
  return s;
}

// ---- Esri: where is there imagery sharper than zoom 19? ------------------------------------------

const esriProbeCache = new Map();

async function esriMaxNative(lat, lng, signal) {
  for (const z of [21, 20]) {
    const { x, y } = tileXY(lat, lng, z);
    const r = await fetch(`${ESRI_PUBLIC}/tilemap/${z}/${y}/${x}/1/1?f=json`, { signal, credentials: 'omit' });
    if (!r.ok) continue;
    const j = await r.json();
    if (Array.isArray(j?.data) && j.data[0] === 1) return z;
  }
  return ESRI_NATIVE;
}

// ---- address search ----------------------------------------------------------------------------------

let lastNominatimAt = 0;

/**
 * Find an address (only when the person asks — no search as they type):
 * resolves [{label, lat, lng}] (best first; [] when nothing matched).
 * Coordinates typed as "38.5816, -121.4944" come back directly, even offline.
 * Rejects with a plain message when offline or the service does not answer.
 */
export async function searchAddress(query, { signal, limit = 6 } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const ll = parseLatLng(q);
  if (ll) return [{ label: `${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}`, lat: ll.lat, lng: ll.lng }];
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error('No signal right now. The address search needs the internet — or type coordinates like 38.5816, -121.4944.');
  }
  // Nominatim allows one request a second.
  const wait = lastNominatimAt + 1100 - Date.now();
  if (wait > 0) await sleep(wait, signal);
  lastNominatimAt = Date.now();
  const lang = ((typeof navigator !== 'undefined' && navigator.language) || 'en').split('-')[0];
  const init = { signal, headers: { Accept: 'application/json' }, credentials: 'omit', mode: 'cors' };
  try {
    // Nominatim asks apps to identify themselves; a browser cannot set User-Agent,
    // so the referrer carries the app's address (never the job walk's page).
    init.referrer = new URL('./', location.href).href;
    init.referrerPolicy = 'no-referrer-when-downgrade';
  } catch { /* no location (tests): the browser default is fine */ }
  let res;
  try {
    res = await fetch(nominatimUrl(q, { limit, lang }), init);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new Error('The address search could not be reached. Check the signal and try again.');
  }
  if (res.status === 429) throw new Error('The address search is busy. Wait a few seconds and try again.');
  if (!res.ok) throw new Error(`The address search did not answer (error ${res.status}). Try again in a minute.`);
  let data;
  try { data = await res.json(); } catch { throw new Error('The address search sent an answer the app could not read.'); }
  return (Array.isArray(data) ? data : [])
    .map((r) => ({ label: String(r.display_name || r.name || ''), lat: Number(r.lat), lng: Number(r.lon) }))
    .filter((r) => isNum(r.lat) && isNum(r.lng));
}

// ---- the view -------------------------------------------------------------------------------------------

/**
 * Create a map view inside `container` (which must have a size; the view
 * fills it). Returns at once; Leaflet loads in the background (`view.ready`
 * resolves true when the map is up, false if it could not load — the view
 * then says so itself). Everything set before then is shown when it is up.
 *
 * opts: {
 *   center: {lat, lng}, zoom   where to start (no center: the US until the
 *                              first position or item arrives)
 *   provider                   'esri' | 'osm' | 'google' (default: Settings,
 *                              and then it follows Settings changes)
 *   googleKey, esriKey         default: Settings
 *   interactive                false for a camera mini-map (no gestures, follows)
 *   layerSwitch                true: a Satellite / Streets button (never with Google)
 *   scaleBar, units            a Leaflet scale bar in feet or meters
 * }
 *
 * Same methods and events as the plan view, in {lat, lng}; plus
 * setPlanOverlay, searchAddress and setProvider. viewchange → {lat, lng,
 * zoom} after the map settles (for project.mapView).
 */
export function createMapView(container, opts = {}) {
  if (!container) throw new Error('createMapView needs a container element.');
  const settings = safeSettings();
  const interactive = opts.interactive !== false;
  const followSettings = opts.provider == null;
  let provider = opts.provider || settings.mapProvider || 'esri';
  let googleKey = String(opts.googleKey ?? settings.googleMapsKey ?? '').trim();
  let esriKey = String(opts.esriKey ?? settings.esriKey ?? '').trim();
  const units = opts.units || settings.units || 'imperial';

  const emitter = new Emitter();
  const offs = new Set();
  const root = el('div', { class: `mv${interactive ? '' : ' mv-static'}` });
  const mapEl = el('div', {
    class: 'mv-map',
    'aria-label': interactive ? 'Map. Drag to move, pinch or scroll to zoom.' : 'Map with your position',
  });
  const planCanvas = el('canvas', { class: 'mv-plan', 'aria-hidden': 'true' });
  const canvas = el('canvas', { class: 'mv-overlay', 'aria-hidden': 'true' });
  const statusEl = el('div', { class: 'mv-status', role: 'status', hidden: true });
  const loadingEl = el('div', { class: 'mv-loading' }, el('div', { class: 'spinner' }), el('div', {}, 'Loading the map…'));
  const gLogo = el('div', { class: 'mv-glogo', role: 'img', 'aria-label': 'Google Maps', hidden: true }, 'Google Maps');
  root.append(mapEl, loadingEl, statusEl);
  container.append(root);
  const ctx = canvas.getContext('2d');
  const pctx = planCanvas.getContext('2d');

  // ---- state ----------------------------------------------------------------
  let L = null, map = null, base = null, baseKind = '', baseToken = 0;
  let keyRejected = false, gSession = null, gAttr = '', gRefreshAt = 0;
  let pins = [], videos = [], selectedId = null;
  let pose = null, marks = [], lines = [];
  let play = null, overlay = null, overlayToken = 0;
  let following = !interactive;
  let autoCenter = !validLL(opts.center);
  let pending = null;            // a view asked for before the map was up
  let zoomAnim = null;
  let raf = 0, drawQueued = false, projStamp = 0;
  let cw = 0, ch = 0, cd = 1;
  let tapTimer = 0, viewTimer = 0, gTimer = 0, gAbort = null, probeAbort = null;
  let pick = null, destroyed = false, drawWarned = false;
  let layerBtn = null, scaleCtl = null;
  const touching = new Set();

  const ready = loadLeaflet()
    .then(() => {
      if (destroyed) return false;
      build();
      return true;
    })
    .catch((err) => {
      if (!destroyed) showFailure(err);
      return false;
    });

  function showFailure(err) {
    console.warn('[map-view] the map could not start', err);
    loadingEl.remove();
    root.append(el('div', { class: 'mv-fail' },
      el('h2', {}, 'The map could not be shown'),
      el('p', {}, err?.message || 'Something stopped the map from loading.'),
      el('p', { class: 'muted small' }, 'Your photos and notes are safe; they just cannot be drawn on a map right now.')));
  }

  // ---- building the map ----------------------------------------------------------

  function build() {
    L = window.L;
    const start = validLL(opts.center) ? opts.center : DEFAULT_VIEW;
    const zoom = isNum(opts.zoom) ? clamp(opts.zoom, 2, MAX_ZOOM) : validLL(opts.center) ? 18 : DEFAULT_VIEW.zoom;
    const o = {
      center: [start.lat, start.lng], zoom, minZoom: 2, maxZoom: MAX_ZOOM,
      zoomControl: false, attributionControl: true,
      zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 110,
      bounceAtZoomLimits: false, worldCopyJump: true,
    };
    // Only set what differs: Leaflet copies undefined values over its defaults.
    if (!interactive) Object.assign(o, { dragging: false, touchZoom: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, tapHold: false, inertia: false });
    map = L.map(mapEl, o);
    map.attributionControl.setPrefix('Leaflet');
    mapEl.append(planCanvas, canvas, gLogo);

    map.on('move zoom viewreset', syncDraw);
    map.on('resize', () => { sizeCanvases(); syncDraw(); });
    map.on('zoomanim', onZoomAnim);
    map.on('zoomend', () => { zoomAnim = null; syncDraw(); if (following) followNow(); });
    map.on('moveend', onMoveEnd);
    map.on('dragstart', () => { if (following && interactive) setFollowing(false); });
    map.on('click', onMapClick);
    map.on('dblclick', cancelPendingTap);
    map.on('contextmenu', onMapContext);
    map.on('mousemove', onHover);
    map.on('mouseout', () => mapEl.classList.remove('mv-hot'));

    if (interactive && opts.layerSwitch) {
      layerBtn = iconButton('layers', { cls: 'icon-btn mv-layers', title: 'Satellite or streets', onclick: toggleLayer });
      root.append(layerBtn);
    }
    if (opts.scaleBar) {
      scaleCtl = L.control.scale({ position: 'bottomleft', imperial: units !== 'metric', metric: units === 'metric' }).addTo(map);
    }

    setBase(provider);
    applyZoomMode();
    loadingEl.remove();
    sizeCanvases();
    if (pending) {
      const p = pending;
      pending = null;
      if (p.fit) fit({ animate: false });
      else if (validLL(p)) { autoCenter = false; map.setView([p.lat, p.lng], isNum(p.zoom) ? p.zoom : map.getZoom(), { animate: false }); }
    } else if (autoCenter) {
      if (validLL(poseLL())) { autoCenter = false; map.setView(toL(poseLL()), 19, { animate: false }); }
      else if (pins.length || videos.length) { autoCenter = false; fit({ animate: false }); }
    }
    syncDraw();
  }

  function removeBase() {
    if (base && map) {
      try { map.removeLayer(base); } catch { /* gone */ }
    }
    base = null;
    baseKind = '';
    if (gAttr && map) { map.attributionControl.removeAttribution(gAttr); gAttr = ''; }
    gLogo.hidden = true;
    root.classList.remove('mv-google');
    gSession = null;
  }

  /** Show base map `p`. Exactly one base layer at a time (Google's terms). Never rejects. */
  function setBase(p) {
    return showBase(p).catch((err) => {
      console.warn('[map-view] base map', err);
      if (!destroyed) setStatus('offline');
    });
  }

  async function showBase(p) {
    if (!map) return;
    const token = ++baseToken;
    removeBase();
    if (layerBtn) layerBtn.hidden = p === 'google';
    if (p === 'google') {
      if (!googleKey) {
        toast('The Google map needs a Google Maps key in Settings. Showing the Esri satellite map.', { type: 'warn' });
      } else {
        try {
          const s = await googleSession(googleKey);
          if (token !== baseToken || destroyed || !map) return;
          addGoogle(s);
          return;
        } catch (err) {
          if (token !== baseToken || destroyed || !map) return;
          toast(`The Google map could not be shown. ${err.message} Showing the Esri satellite map instead.`, { type: 'warn' });
        }
      }
      p = 'esri';
    }
    const spec = baseLayerSpec(p, { esriKey: keyRejected ? '' : esriKey });
    base = L.tileLayer(spec.url, spec.options);
    baseKind = spec.kind;
    hookTiles(base, baseKind);
    base.addTo(map);
    map.attributionControl.setPrefix('Leaflet');
    if (baseKind === 'esri') maybeProbeEsri();
  }

  function addGoogle(s) {
    gSession = s;
    base = L.tileLayer(googleTileUrl(s.session, googleKey), { maxZoom: MAX_ZOOM, maxNativeZoom: GOOGLE_NATIVE, tileSize: 256, crossOrigin: true, attribution: '' });
    baseKind = 'google';
    hookTiles(base, 'google');
    base.addTo(map);
    // Nothing may sit next to or over the Google mark: no Leaflet prefix, our own mark bottom-left.
    map.attributionControl.setPrefix(false);
    gLogo.hidden = false;
    root.classList.add('mv-google');
    setGoogleAttribution('Google');
    scheduleGoogleCopyright();
  }

  function setGoogleAttribution(text) {
    const html = escapeHtml(text);
    if (html === gAttr || !map) return;
    if (gAttr) map.attributionControl.removeAttribution(gAttr);
    gAttr = html;
    map.attributionControl.addAttribution(gAttr);
  }

  function scheduleGoogleCopyright() {
    clearTimeout(gTimer);
    gTimer = setTimeout(updateGoogleCopyright, 450);
  }

  async function updateGoogleCopyright() {
    if (!map || baseKind !== 'google' || !gSession) return;
    gAbort?.abort();
    gAbort = new AbortController();
    const b = map.getBounds();
    const url = googleViewportUrl(gSession.session, googleKey, map.getZoom(), { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() });
    try {
      const r = await fetch(url, { signal: gAbort.signal, credentials: 'omit' });
      if (!r.ok) return;
      const j = await r.json();
      if (destroyed || baseKind !== 'google' || !base) return;
      setGoogleAttribution(String(j?.copyright || 'Google'));
      const mz = googleMaxZoomAt(j?.maxZoomRects, map.getCenter());
      if (isNum(mz) && base.options.maxNativeZoom !== Math.min(MAX_ZOOM, mz)) {
        base.options.maxNativeZoom = Math.min(MAX_ZOOM, mz);
        base.redraw();
      }
    } catch { /* offline or aborted: keep the last copyright */ }
  }

  async function refreshGoogle() {
    try {
      const s = await googleSession(googleKey, { fresh: true });
      if (destroyed || baseKind !== 'google' || !base) return;
      gSession = s;
      base.setUrl(googleTileUrl(s.session, googleKey));
    } catch { /* keep trying the old one; the offline note explains */ }
  }

  function hookTiles(layer, kind) {
    let loads = 0, errs = 0, errsSinceLoad = 0;
    layer.on('tileload', () => {
      loads++;
      errsSinceLoad = 0;
      setStatus(null);
    });
    layer.on('tileerror', () => {
      if (layer !== base) return;
      errs++;
      errsSinceLoad++;
      const online = typeof navigator === 'undefined' || navigator.onLine !== false;
      if (kind === 'esri-key' && loads === 0 && errs >= 4 && online && !keyRejected) {
        keyRejected = true;
        toast('The ArcGIS key in Settings was not accepted, so the public Esri map is shown.', { type: 'warn' });
        setBase('esri');
        return;
      }
      if (kind === 'google' && errsSinceLoad >= 6 && online && Date.now() - gRefreshAt > 120000) {
        gRefreshAt = Date.now();
        refreshGoogle();
      }
      if (!online || errsSinceLoad >= 8) setStatus('offline');
    });
  }

  function setStatus(kind) {
    if (!kind) { statusEl.hidden = true; return; }
    statusEl.textContent = 'No signal — new map tiles cannot load right now. Your pins and position still show.';
    statusEl.hidden = false;
  }

  /** Where Esri has imagery sharper than zoom 19 here, use it. A failed check just keeps 19. */
  async function maybeProbeEsri() {
    try {
      if (!map || baseKind !== 'esri' || map.getZoom() < 18.5) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      const c = map.getCenter();
      const t = tileXY(c.lat, c.lng, 13);
      const k = `${t.x}/${t.y}`;
      let z = esriProbeCache.get(k);
      if (z == null) {
        probeAbort?.abort();
        const ac = new AbortController();
        probeAbort = ac;
        const timer = setTimeout(() => ac.abort(), 6000);
        try { z = await esriMaxNative(c.lat, c.lng, ac.signal); } finally { clearTimeout(timer); }
        esriProbeCache.set(k, z);
      }
      if (destroyed || !base || baseKind !== 'esri') return;
      if (base.options.maxNativeZoom !== z) {
        base.options.maxNativeZoom = z;
        base.redraw();
      }
    } catch { /* offline, aborted, or Esri changed its answer: stay at 19 */ }
  }

  function toggleLayer() {
    if (provider === 'google') return;
    provider = baseKind === 'osm' ? 'esri' : 'osm';
    setBase(provider);
  }

  // ---- drawing -------------------------------------------------------------------------

  function currentDpr() {
    const d = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 3);
    return cw * ch * d * d > 12e6 ? Math.max(0.75, Math.sqrt(12e6 / Math.max(1, cw * ch))) : d;
  }

  function sizeCanvases() {
    if (!map) return;
    const s = map.getSize();
    cw = s.x;
    ch = s.y;
    cd = currentDpr();
    for (const c of [canvas, planCanvas]) {
      c.width = Math.max(1, Math.round(cw * cd));
      c.height = Math.max(1, Math.round(ch * cd));
      c.style.width = `${cw}px`;
      c.style.height = `${ch}px`;
    }
    root.style.setProperty('--mv-w', `${cw}px`);   // views.css sizes the attribution against the map, not the window
    updateEdges();
    if (pick) pick.ov.layout(cw, ch);
  }

  /** Does the map reach the notch or the home bar? (The placement chrome and the Google mark keep clear.) */
  function updateEdges() {
    try {
      const r = root.getBoundingClientRect();
      root.classList.toggle('pv-at-top', r.top < 24);
      root.classList.toggle('pv-at-bottom', r.bottom > (window.innerHeight || r.bottom) - 24);
    } catch { /* detached */ }
  }

  /** Draw in the same task as Leaflet's move (it runs inside Leaflet's own animation frame), once. */
  function syncDraw() {
    if (drawQueued || destroyed) return;
    drawQueued = true;
    queueMicrotask(() => {
      drawQueued = false;
      draw(performance.now());
    });
  }

  function requestDraw() {
    if (raf || destroyed) return;
    raf = requestAnimationFrame((t) => {
      raf = 0;
      // Leaflet ends a zoom animation with 'zoomend'; if that never comes (the
      // map was torn down mid-zoom), stop on our own rather than spin forever.
      if (zoomAnim && t - zoomAnim.t0 > LEAFLET_ZOOM_MS + 400) zoomAnim = null;
      draw(t);
      if (zoomAnim) requestDraw();
    });
  }

  function onZoomAnim(e) {
    zoomAnim = { t0: performance.now(), center: e.center, zoom: e.zoom };
    requestDraw();
  }

  /**
   * lat/lng → container px for this frame. During an animated zoom Leaflet
   * moves the tiles with a CSS transition; a translate+scale transition moves
   * every point in a straight line from where it was to where it will be, on
   * Leaflet's easing curve — so that is what this does too.
   */
  function projector(now) {
    const z = map.getZoom();
    projStamp++;
    if (!zoomAnim) {
      return { stamp: projStamp, pt: (lat, lng) => map.latLngToContainerPoint([lat, lng]), ppm: (lat) => pxPerMeterAt(lat, z) };
    }
    // With reduced motion app.css turns CSS transitions off, so the tiles jump: so do we.
    const e = prefersReducedMotion() ? 1 : leafletZoomEase(clamp((now - zoomAnim.t0) / LEAFLET_ZOOM_MS, 0, 1));
    const size = map.getSize();
    const z1 = zoomAnim.zoom;
    const c1 = map.project(zoomAnim.center, z1);
    return {
      stamp: projStamp,
      pt: (lat, lng) => {
        const p0 = map.latLngToContainerPoint([lat, lng]);
        const q = map.project([lat, lng], z1);
        const x1 = q.x - c1.x + size.x / 2, y1 = q.y - c1.y + size.y / 2;
        return { x: p0.x + (x1 - p0.x) * e, y: p0.y + (y1 - p0.y) * e };
      },
      ppm: (lat) => { const a = pxPerMeterAt(lat, z), b = pxPerMeterAt(lat, z1); return a + (b - a) * e; },
    };
  }

  function screenPath(v, P) {
    if (v.stamp === P.stamp && v.screen) return v.screen;
    v.screen = simplifyScreenPath(v.pts, (p) => P.pt(p.lat, p.lng));
    v.stamp = P.stamp;
    return v.screen;
  }

  function buildScene(P) {
    const scene = { selectedId, playId: play?.item?.id ?? null, pins: [], videos: [], marks: [], lines: [], me: null, play: null };
    for (const v of videos) scene.videos.push({ item: v.item, n: v.n, screen: screenPath(v, P) });
    if (play?.video && !videos.some((v) => v.item.id === play.item.id)) {
      scene.videos.push({ item: play.item, n: play.video.n, screen: screenPath(play.video, P) });
    }
    for (const p of pins) {
      const s = P.pt(p.lat, p.lng);
      scene.pins.push({ item: p.item, kind: p.kind, sx: s.x, sy: s.y, h: p.h, n: p.n, annotated: p.annotated });
    }
    for (const l of lines) {
      if (validLL(l?.a) && validLL(l?.b)) scene.lines.push({ ...l, a: P.pt(l.a.lat, l.a.lng), b: P.pt(l.b.lat, l.b.lng) });
    }
    for (const m of marks) {
      if (validLL(m)) { const s = P.pt(m.lat, m.lng); scene.marks.push({ ...m, sx: s.x, sy: s.y }); }
    }
    if (play?.pt) {
      const s = P.pt(play.pt.lat, play.pt.lng);
      scene.play = { sx: s.x, sy: s.y, h: isNum(play.pt.heading) ? play.pt.heading * DEG : null };
    }
    const ll = poseLL();
    if (ll) {
      const s = P.pt(ll.lat, ll.lng);
      scene.me = {
        sx: s.x,
        sy: s.y,
        accPx: isNum(pose.geo.acc) ? pose.geo.acc * P.ppm(ll.lat) : null,
        h: isNum(pose.heading) ? pose.heading * DEG : null,      // the map is north-up: true heading as is
        ...meStyle(pose),
      };
    }
    return scene;
  }

  function drawOverlayPlan(P) {
    const g = pctx;
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, planCanvas.width, planCanvas.height);
    if (!overlay?.pyr) return;
    const { tl, tr, bl } = overlay.corners;
    const m = affineFromCorners(P.pt(tl.lat, tl.lng), P.pt(tr.lat, tr.lng), P.pt(bl.lat, bl.lng), overlay.W, overlay.H);
    try {
      drawPlanImage(g, overlay.pyr, overlay.W, overlay.H, m, { dpr: cd, viewW: cw, viewH: ch, quality: 'high' });
    } catch (err) {
      if (!drawWarned) { drawWarned = true; console.warn('[map-view] the plan overlay could not be drawn', err); }
    }
  }

  function draw(now) {
    if (!map || destroyed || !ctx) return;
    const size = map.getSize();
    if (!size.x || !size.y) return;
    if (cw !== size.x || ch !== size.y || cd !== currentDpr()) sizeCanvases();
    try {
      const P = projector(now);
      drawOverlayPlan(P);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(cd, 0, 0, cd, 0, 0);
      drawScene(ctx, buildScene(P), { viewW: cw, viewH: ch, light: !interactive });
      if (pick) drawLoupe();
    } catch (err) {
      if (!drawWarned) { drawWarned = true; console.warn('[map-view] draw failed', err); }
    }
  }

  /** The magnifier: the tiles under the cross (they are <img>s Leaflet already loaded), then our plan and markers, ×3. */
  function drawLoupe() {
    const size = pick.ov.size;
    const g = pick.ctx;
    if (!size || !g) return;
    const lc = pick.ov.loupe;
    const px = Math.max(1, Math.round(size * cd));
    if (lc.width !== px) { lc.width = px; lc.height = px; }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = markerColors().planBg;
    g.fillRect(0, 0, px, px);
    const cx = cw / 2, cy = ch / 2, r = size / 2 / LOUPE_ZOOM;
    const box = mapEl.getBoundingClientRect();
    g.setTransform(cd * LOUPE_ZOOM, 0, 0, cd * LOUPE_ZOOM, cd * (size / 2 - cx * LOUPE_ZOOM), cd * (size / 2 - cy * LOUPE_ZOOM));
    g.imageSmoothingEnabled = true;
    const levels = [...mapEl.querySelectorAll('.leaflet-tile-container')]
      .sort((a, b) => (Number(a.style.zIndex) || 0) - (Number(b.style.zIndex) || 0));
    for (const lvl of levels) {
      for (const img of lvl.querySelectorAll('img.leaflet-tile-loaded')) {
        const b = img.getBoundingClientRect();
        const x = b.left - box.left, y = b.top - box.top;
        if (x > cx + r || y > cy + r || x + b.width < cx - r || y + b.height < cy - r) continue;
        try { g.drawImage(img, x, y, b.width, b.height); } catch { /* not decoded yet */ }
      }
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    const sx = (cx - r) * cd, sy = (cy - r) * cd, sw = 2 * r * cd;
    try {
      if (overlay?.pyr) {
        g.globalAlpha = overlay.opacity;
        g.globalCompositeOperation = overlay.blend === 'multiply' ? 'multiply' : 'source-over';
        g.drawImage(planCanvas, sx, sy, sw, sw, 0, 0, px, px);
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'source-over';
      }
      g.drawImage(canvas, sx, sy, sw, sw, 0, 0, px, px);
    } catch { /* a zero-size canvas mid-resize */ }
    g.setTransform(cd, 0, 0, cd, 0, 0);
    drawCrosshair(g, size / 2, size / 2, { arm: Math.round(size * 0.16), gap: 5 });
  }

  // ---- map events --------------------------------------------------------------------------

  function onMoveEnd() {
    if (!map) return;
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => {
      if (!map || destroyed) return;
      emitter.emit('viewchange', getView());
    }, 500);
    if (baseKind === 'google') scheduleGoogleCopyright();
    if (baseKind === 'esri') maybeProbeEsri();
  }

  function cancelPendingTap() {
    clearTimeout(tapTimer);
    tapTimer = 0;
  }

  function onMapClick(e) {
    if (!interactive && !pick) return;
    cancelPendingTap();
    const ll = e.latlng;
    if (pick) {
      // A tap in placement mode brings that spot under the cross.
      tapTimer = setTimeout(() => { tapTimer = 0; if (pick && map) map.panTo(ll, { animate: !prefersReducedMotion() }); }, TAP_DELAY_MS);
      return;
    }
    const hit = hitTest(e.containerPoint.x, e.containerPoint.y);
    if (hit) { emitter.emit('tapitem', hit); return; }
    tapTimer = setTimeout(() => {
      tapTimer = 0;
      if (!destroyed) emitter.emit('tap', { lat: ll.lat, lng: wrapLng(ll.lng) });
    }, TAP_DELAY_MS);
  }

  function onMapContext(e) {
    if (!interactive || pick) return;
    cancelPendingTap();
    buzz(20);
    emitter.emit('longpress', { lat: e.latlng.lat, lng: wrapLng(e.latlng.lng) });
  }

  function onHover(e) {
    if (!interactive || pick) return;
    mapEl.classList.toggle('mv-hot', !!hitTest(e.containerPoint.x, e.containerPoint.y));
  }

  const onPointerDown = (e) => { if (e.pointerType !== 'mouse') touching.add(e.pointerId); };
  const onPointerEnd = (e) => {
    if (!touching.delete(e.pointerId)) return;
    if (!touching.size && following) setTimeout(followNow, 50);
  };

  // ---- following ----------------------------------------------------------------------------

  function poseLL() {
    return validLL(pose?.geo) ? { lat: pose.geo.lat, lng: pose.geo.lng } : null;
  }
  const toL = (ll) => [ll.lat, ll.lng];

  /** While following, zooming (pinch, wheel, double-tap) zooms around the person instead of the fingers. */
  function applyZoomMode() {
    if (!map || !interactive) return;
    const mode = following ? 'center' : true;
    map.options.touchZoom = mode;
    map.options.scrollWheelZoom = mode;
    map.options.doubleClickZoom = mode;
  }

  function followNow(first = false) {
    if (!map || !following || pick || zoomAnim || touching.size || destroyed) return;
    const ll = poseLL();
    if (!ll) return;
    if (!interactive) { map.panTo(toL(ll), { animate: false }); return; }
    if (first && map.getZoom() < 16) {
      map.setView(toL(ll), 19, { animate: !prefersReducedMotion() });
      return;
    }
    const p = map.latLngToContainerPoint(toL(ll));
    const s = map.getSize();
    const d = Math.hypot(p.x - s.x / 2, p.y - s.y / 2);
    if (d < 0.75) return;
    map.panTo(toL(ll), { animate: !prefersReducedMotion(), duration: d > Math.max(s.x, s.y) ? 0.6 : 0.35, easeLinearity: 0.6, noMoveStart: true });
  }

  function setFollowing(on) {
    if (destroyed || !interactive) return;
    on = !!on;
    if (following === on) return;
    following = on;
    applyZoomMode();
    if (on) followNow(true);
    emitter.emit('followchange', on);
  }

  // ---- public: content ------------------------------------------------------------------------

  /** Photo pins (pose.geo, wedge from pose.heading), video paths (track lat, lng), note pins. */
  function setItems(list, { selectedId: sel = null } = {}) {
    if (destroyed) return;
    selectedId = sel ?? null;
    const nextPins = [], nextVideos = [];
    for (const it of Array.isArray(list) ? list : []) {
      if (!it || it.deletedAt) continue;
      const ps = it.pose || null;
      if (it.type === 'video') {
        const pts = [];
        for (const tp of it.track || []) if (validLL(tp)) pts.push({ lat: tp.lat, lng: tp.lng });
        if (!pts.length && validLL(ps?.geo)) pts.push({ lat: ps.geo.lat, lng: ps.geo.lng });
        if (pts.length) nextVideos.push({ item: it, n: it.seq ?? null, pts, screen: null, stamp: -1 });
      } else if (validLL(ps?.geo)) {
        nextPins.push({
          item: it,
          kind: it.type === 'note' ? 'note' : 'photo',
          lat: ps.geo.lat,
          lng: ps.geo.lng,
          h: it.type !== 'note' && isNum(ps.heading) ? ps.heading * DEG : null,
          n: it.seq ?? null,
          annotated: isAnnotated(it),
        });
      }
    }
    nextPins.sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
    pins = nextPins;
    videos = nextVideos;
    if (map && autoCenter && !poseLL() && (pins.length || videos.length)) { autoCenter = false; fit({ animate: false }); }
    requestDraw();
  }

  /** The person: blue dot at pose.geo, accuracy circle (pose.geo.acc m), cone (pose.heading, true north). */
  function setPose(p) {
    if (destroyed) return;
    pose = p || null;
    const ll = poseLL();
    if (map && ll) {
      if (autoCenter) { autoCenter = false; map.setView(toL(ll), Math.max(map.getZoom(), 19), { animate: false }); }
      else if (following) followNow();
    }
    requestDraw();
  }

  /** [{lat, lng, label, color, kind}] */
  function setMarks(list) {
    marks = Array.isArray(list) ? list.filter(Boolean) : [];
    requestDraw();
  }

  /** [{a: {lat, lng}, b: {lat, lng}, label, color, dashed}] */
  function setLines(list) {
    lines = Array.isArray(list) ? list.filter(Boolean) : [];
    requestDraw();
  }

  /** Video playback on the map: highlight the path, marker + cone at tMs (track lat, lng, heading). */
  function setPlayback(item, tMs = 0, { keepInView = true } = {}) {
    if (destroyed) return;
    if (!item) {
      if (play) { play = null; requestDraw(); }
      return;
    }
    if (!play || play.item.id !== item.id || play.item.track !== item.track || play.len !== (item.track?.length || 0)) {
      const pts = [];
      for (const tp of item.track || []) if (validLL(tp)) pts.push({ lat: tp.lat, lng: tp.lng });
      if (!pts.length && validLL(item.pose?.geo)) pts.push({ lat: item.pose.geo.lat, lng: item.pose.geo.lng });
      play = { item, len: item.track?.length || 0, pt: null, video: pts.length ? { item, n: item.seq ?? null, pts, screen: null, stamp: -1 } : null };
    }
    play.item = item;
    let pt = interpolateTrack(item.track, tMs);
    if (!validLL(pt) && validLL(item.pose?.geo)) pt = { lat: item.pose.geo.lat, lng: item.pose.geo.lng, heading: item.pose.heading ?? null };
    play.pt = validLL(pt) ? pt : null;
    if (keepInView && play.pt && map && interactive && !following && !pick && !zoomAnim && !touching.size) {
      const s = map.latLngToContainerPoint([play.pt.lat, play.pt.lng]);
      const m = Math.min(56, cw / 4, ch / 4);
      if (s.x < m || s.y < m || s.x > cw - m || s.y > ch - m) map.panTo([play.pt.lat, play.pt.lng], { animate: !prefersReducedMotion() });
    }
    requestDraw();
  }

  /**
   * Lay a calibrated plan over the satellite image, or remove it with null.
   * o: {image, calibration, origin: project.origin, opacity (0…1, default
   * 0.8), width, height (the stored plan's px, when `image` is a smaller copy),
   * blend: 'multiply' (default: white paper see-through) | 'normal'}.
   * Resolves when it is shown.
   */
  async function setPlanOverlay(o) {
    const token = ++overlayToken;
    if (!o || !o.image || !o.calibration || !validLL(o.origin)) {
      clearOverlay();
      requestDraw();
      return;
    }
    let fns;
    try {
      if (typeof o.image.decode === 'function' && o.image.complete === false) await o.image.decode();
      fns = await loadCalGeo();
    } catch (err) {
      console.warn('[map-view] plan overlay', err);
      if (token === overlayToken && !destroyed) toast('The plan could not be laid over the map on this phone.', { type: 'warn' });
      return;
    }
    if (token !== overlayToken || destroyed) return;
    const W = posNum(o.width) || imageWidth(o.image);
    const H = posNum(o.height) || imageHeight(o.image);
    if (!W || !H) return;
    let corners;
    try { corners = planCornersLatLng(o.calibration, o.origin, W, H, fns); } catch (err) {
      console.warn('[map-view] plan corners', err);
      return;
    }
    if (![corners.tl, corners.tr, corners.bl].every(validLL)) return;
    clearOverlay();
    overlay = {
      image: o.image, W, H, corners,
      opacity: clamp(isNum(o.opacity) ? o.opacity : 0.8, 0.05, 1),
      blend: o.blend === 'normal' ? 'normal' : 'multiply',
      pyr: acquirePyramid(o.image, requestDraw),
    };
    planCanvas.style.opacity = String(overlay.opacity);
    planCanvas.classList.toggle('mv-plan-normal', overlay.blend === 'normal');
    requestDraw();
  }

  function clearOverlay() {
    if (overlay?.pyr) releasePyramid(overlay.pyr, requestDraw);
    overlay = null;
    if (pctx) { pctx.setTransform(1, 0, 0, 1, 0, 0); pctx.clearRect(0, 0, planCanvas.width, planCanvas.height); }
  }

  // ---- public: view ---------------------------------------------------------------------------

  /** Everything drawn (items, the person, the plan overlay) in view. */
  function fit({ animate = true } = {}) {
    if (destroyed) return;
    if (!map) { pending = { fit: true }; return; }
    if (interactive && following) setFollowing(false);
    const pts = [];
    for (const p of pins) pts.push([p.lat, p.lng]);
    for (const v of videos) for (const q of v.pts) pts.push([q.lat, q.lng]);
    const ll = poseLL();
    if (ll) pts.push(toL(ll));
    if (overlay) for (const c of Object.values(overlay.corners)) pts.push(toL(c));
    if (!pts.length) return;
    autoCenter = false;
    const b = L.latLngBounds(pts);
    const anim = animate && !prefersReducedMotion();
    if (b.getNorthEast().equals(b.getSouthWest())) map.setView(b.getCenter(), Math.max(map.getZoom(), 19), { animate: anim });
    else map.fitBounds(b, { padding: [44, 44], maxZoom: 20, animate: anim });
  }

  /** Bring {lat, lng} to the middle, optionally at `zoom`. */
  function centerOn(ll, zoom, { animate = true } = {}) {
    if (destroyed || !validLL(ll)) return;
    if (!map) { pending = { lat: ll.lat, lng: ll.lng, zoom: isNum(zoom) ? zoom : null }; return; }
    if (interactive && following) setFollowing(false);
    autoCenter = false;
    map.setView(toL(ll), isNum(zoom) ? clamp(zoom, 2, MAX_ZOOM) : map.getZoom(), { animate: animate && !prefersReducedMotion() });
  }

  /** {lat, lng, zoom} — what project.mapView stores. */
  function getView() {
    if (!map) {
      if (validLL(pending)) return { lat: pending.lat, lng: pending.lng, zoom: pending.zoom ?? opts.zoom ?? 18 };
      const c = validLL(opts.center) ? opts.center : DEFAULT_VIEW;
      return { lat: c.lat, lng: c.lng, zoom: isNum(opts.zoom) ? opts.zoom : validLL(opts.center) ? 18 : DEFAULT_VIEW.zoom };
    }
    const c = map.getCenter();
    return { lat: round7(c.lat), lng: round7(wrapLng(c.lng)), zoom: Math.round(map.getZoom() * 100) / 100 };
  }

  /** Restore a view from getView() / project.mapView. */
  function setView(v, { animate = false } = {}) {
    if (destroyed || !validLL(v)) return;
    if (!map) { pending = { lat: v.lat, lng: v.lng, zoom: isNum(v.zoom) ? v.zoom : null }; return; }
    autoCenter = false;
    map.setView(toL(v), isNum(v.zoom) ? clamp(v.zoom, 2, MAX_ZOOM) : map.getZoom(), { animate: animate && !prefersReducedMotion() });
  }

  /** The item under container point (sx, sy) in CSS px, or null. */
  function hitTest(sx, sy) {
    if (!map) return null;
    const P = projector(performance.now());
    const targets = [];
    for (const v of videos) {
      const pts = screenPath(v, P);
      targets.push({ kind: 'path', pts, item: v.item });
      if (pts[0]) targets.push({ kind: 'pin', x: pts[0].x, y: pts[0].y, item: v.item, selected: v.item.id === selectedId });
    }
    for (const p of pins) {
      const s = P.pt(p.lat, p.lng);
      targets.push({ kind: 'pin', x: s.x, y: s.y, item: p.item, selected: p.item.id === selectedId });
    }
    return hitTestTargets(targets, sx, sy)?.item || null;
  }

  // ---- public: precise placement ----------------------------------------------------------------

  /** Same as the plan view's pickPoint, on the map: resolves {lat, lng} under the cross, or null. */
  async function pickPoint({ title = 'Place the point', hint = 'Move the map until the cross is exactly on the spot.', initial = null, setLabel = 'Set' } = {}) {
    if (destroyed) return null;
    const ok = await ready;
    if (!ok || destroyed || !map) return null;
    pick?.finish(null);
    return new Promise((resolve) => {
      const wasFollowing = following && interactive;
      if (wasFollowing) setFollowing(false);
      cancelPendingTap();
      const centerLL = () => {
        const c = map.getCenter();
        return { lat: round7(c.lat), lng: round7(wrapLng(c.lng)) };
      };
      const ov = createPickOverlay({
        title, hint, setLabel,
        onSet: () => finish(map ? centerLL() : null),
        onCancel: () => finish(null),
      });
      const key = (e) => {
        if (overlayOpen() || isTypingTarget(e.target)) return;
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); finish(map ? centerLL() : null); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
      };
      document.addEventListener('keydown', key, true);
      root.append(ov.el);
      root.classList.add('mv-picking');
      if (!interactive) setHandlers(true);
      pick = { finish, ov, ctx: ov.loupe.getContext('2d') };
      ov.layout(cw, ch);
      if (validLL(initial)) map.setView(toL(initial), Math.max(map.getZoom(), 19), { animate: false });
      requestDraw();
      try { mapEl.focus({ preventScroll: true }); } catch { /* old browser */ }

      function finish(value) {
        if (!pick || pick.finish !== finish) return;
        document.removeEventListener('keydown', key, true);
        pick = null;
        ov.destroy();
        root.classList.remove('mv-picking');
        if (!interactive) setHandlers(false);
        if (value) buzz(15);
        if (!destroyed) {
          requestDraw();
          if (wasFollowing) setFollowing(true);
        }
        resolve(value);
      }
    });
  }

  /** Turn the map's gestures on or off (a mini-map gets them only while placing a point). */
  function setHandlers(on) {
    if (!map) return;
    for (const h of ['dragging', 'touchZoom', 'scrollWheelZoom', 'doubleClickZoom', 'keyboard']) {
      try { if (on) map[h]?.enable(); else map[h]?.disable(); } catch { /* handler missing */ }
    }
    root.classList.toggle('mv-static', !on && !interactive);
  }

  /** Switch the base map ('esri' | 'osm' | 'google'); Google replaces every other layer. */
  function setProvider(p, { googleKey: gk, esriKey: ek } = {}) {
    if (destroyed) return;
    provider = p || 'esri';
    if (gk != null) googleKey = String(gk).trim();
    if (ek != null) { esriKey = String(ek).trim(); keyRejected = false; }
    if (map) setBase(provider);
  }

  // ---- lifecycle -------------------------------------------------------------------------------------

  let ro = null;
  let offBus = null;
  const onOnline = () => { setStatus(null); try { base?.redraw(); } catch { /* not up */ } };
  const onOffline = () => setStatus('offline');
  const onTheme = () => { markerColors({ refresh: true }); requestDraw(); };
  let darkMql = null;

  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => {
      if (!map) return;
      map.invalidateSize({ pan: false });
      sizeCanvases();
      syncDraw();
    });
    ro.observe(root);
  }
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  mapEl.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointerup', onPointerEnd, true);
  window.addEventListener('pointercancel', onPointerEnd, true);
  try {
    darkMql = matchMedia('(prefers-color-scheme: dark)');
    darkMql.addEventListener('change', onTheme);
  } catch { darkMql = null; }
  if (followSettings) {
    offBus = bus.on('settings:change', (s) => {
      const np = s?.mapProvider || 'esri';
      const gk = String(s?.googleMapsKey || '').trim();
      const ek = String(s?.esriKey || '').trim();
      if (np === provider && gk === googleKey && ek === esriKey) return;
      provider = np;
      googleKey = gk;
      if (ek !== esriKey) keyRejected = false;
      esriKey = ek;
      if (map) setBase(provider);
    });
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) setStatus('offline');

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    pick?.finish(null);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    clearTimeout(tapTimer);
    clearTimeout(viewTimer);
    clearTimeout(gTimer);
    gAbort?.abort();
    probeAbort?.abort();
    offBus?.();
    ro?.disconnect();
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    window.removeEventListener('pointerup', onPointerEnd, true);
    window.removeEventListener('pointercancel', onPointerEnd, true);
    mapEl.removeEventListener('pointerdown', onPointerDown, true);
    try { darkMql?.removeEventListener('change', onTheme); } catch { /* old Safari */ }
    clearOverlay();
    try { map?.off(); map?.remove(); } catch { /* half built */ }
    map = null;
    base = null;
    for (const c of [canvas, planCanvas]) { try { c.width = 0; c.height = 0; } catch { /* gone */ } }
    root.remove();
    for (const off of offs) off();
    offs.clear();
  }

  return {
    el: root,
    ready,
    setItems,
    setPose,
    setMarks,
    setLines,
    setPlayback,
    setFollow: setFollowing,
    isFollowing: () => following,
    fit,
    centerOn,
    getView,
    setView,
    pickPoint,
    hitTest,
    setPlanOverlay,
    searchAddress: (query, o) => searchAddress(query, o),
    /** Listen: 'tapitem' | 'tap' | 'longpress' | 'viewchange' | 'followchange'. Returns the function that stops listening. */
    on(type, fn) {
      const off = emitter.on(type, fn);
      offs.add(off);
      return () => { offs.delete(off); off(); };
    },
    off(type, fn) { emitter.off(type, fn); },
    resize() {
      if (!map || destroyed) return;
      map.invalidateSize({ pan: false });
      sizeCanvases();
      syncDraw();
    },
    destroy,
    // Beyond docs/SPEC.md §7 (optional):
    setProvider,
    getProvider: () => (baseKind === 'google' ? 'google' : baseKind === 'osm' ? 'osm' : 'esri'),
    setPlanOpacity(v) {
      if (!overlay || !isNum(v)) return;
      overlay.opacity = clamp(v, 0.05, 1);
      planCanvas.style.opacity = String(overlay.opacity);
      requestDraw();
    },
    isPicking: () => !!pick,
    /** The Leaflet map once it is up (null before) — for anything this view does not cover. */
    get leaflet() { return map; },
  };
}
