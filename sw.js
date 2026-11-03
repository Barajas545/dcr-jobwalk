/**
 * Service worker — so DCR Job Walk opens with no signal.
 *
 * A job walk happens in a building with no roof yet, a basement, or a lot
 * at the edge of town. So the whole program (PROGRAM below) is cached when
 * this worker installs, all or nothing, and served cache-first. pdf.js and
 * Leaflet come with it.
 *
 * Photos, videos and notes are NEVER in this cache — they live in
 * IndexedDB (js/core/db.js), which this worker does not touch.
 *
 * Map tiles: Esri satellite and OpenStreetMap tiles the person has already
 * looked at are kept in a separate, capped cache (TILE_CAP tiles), so the
 * map of the site still shows on a second visit without signal. They are
 * fetched with CORS (Leaflet crossOrigin), so each one counts at its real
 * size against the storage the photos share — an opaque response would
 * count as ~7 MB in Chrome. Google tiles are not cached here: Google's
 * terms only allow what their HTTP cache headers allow, which the browser's
 * own HTTP cache already does.
 *
 * Bump CACHE whenever the app changes, or an installed copy keeps serving
 * the old one. A new file the app loads goes in PROGRAM —
 * tests/sw-precache.test.mjs fails when one is missing or listed but absent.
 */
const CACHE = 'jobwalk-v1';
const TILES = 'jobwalk-tiles-v1';
const TILE_CAP = 3000;

const PROGRAM = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'css/app.css',
  'css/screens.css',
  'css/views.css',
  'css/calibrate.css',
  'css/camera.css',
  'css/annotate.css',
  'css/item.css',
  'css/export.css',
  'js/main.js',
  'js/version.js',
  'js/core/annotations.js',
  'js/core/bus.js',
  'js/core/calibration.js',
  'js/core/capture.js',
  'js/core/db.js',
  'js/core/geo.js',
  'js/core/media.js',
  'js/core/motion.js',
  'js/core/orientation.js',
  'js/core/package.js',
  'js/core/plan-import.js',
  'js/core/positioning.js',
  'js/core/recorder.js',
  'js/core/settings.js',
  'js/core/sim.js',
  'js/core/store.js',
  'js/core/util.js',
  'js/core/voice.js',
  'js/core/zip.js',
  'js/ui/annotate-screen.js',
  'js/ui/calibrate-screen.js',
  'js/ui/camera-screen.js',
  'js/ui/export-screen.js',
  'js/ui/icons.js',
  'js/ui/item-screen.js',
  'js/ui/items-panel.js',
  'js/ui/map-view.js',
  'js/ui/markers.js',
  'js/ui/plan-import-dialog.js',
  'js/ui/plan-view.js',
  'js/ui/project-screen.js',
  'js/ui/projects-screen.js',
  'js/ui/settings-screen.js',
  'js/ui/shell.js',
  'js/ui/trash-screen.js',
  'viewer/viewer.html',
  'viewer/viewer.css',
  'viewer/viewer.js',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
  'vendor/pdfjs/build/pdf.min.js',
  'vendor/pdfjs/build/pdf.worker.min.js',
  'vendor/geomagnetism/index.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'reload' skips the HTTP cache, so a new version never installs
    // with a stale copy of one of its own files.
    await cache.addAll(PROGRAM.map((u) => new Request(u, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k !== CACHE && k !== TILES && k.startsWith('jobwalk-')) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

const isTile = (url) =>
  /(^|\.)arcgisonline\.com$/.test(url.hostname) && url.pathname.includes('/tile/') ||
  url.hostname === 'ibasemaps-api.arcgis.com' && url.pathname.includes('/tile/') ||
  /(^|\.)tile\.openstreetmap\.org$/.test(url.hostname);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      // Navigations (a reload, a Home Screen launch) get the app page.
      if (req.mode === 'navigate') {
        const hit = await cache.match('index.html');
        if (hit) return hit;
      }
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try {
        const res = await fetch(req);
        // pdf.js fonts and character maps are fetched only for PDFs that need
        // them; keep each one the first time, so that PDF renders offline later.
        if (res.ok && url.pathname.includes('/vendor/pdfjs/')) cache.put(req, res.clone()).catch(() => {});
        return res;
      } catch {
        return new Response('Offline, and this file is not in the app cache.', { status: 503, headers: { 'content-type': 'text/plain' } });
      }
    })());
    return;
  }

  if (isTile(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(TILES);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      // Only real (CORS) responses: an opaque one would cost ~7 MB of quota.
      if (res.ok && res.type === 'cors') {
        cache.put(req, res.clone()).then(() => trimTiles(cache)).catch(() => { /* quota: skip caching */ });
      }
      return res;
    })());
  }
});

let trimming = false;
async function trimTiles(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    // Oldest first (insertion order); drop the overflow plus a margin.
    if (keys.length > TILE_CAP) {
      for (const k of keys.slice(0, keys.length - TILE_CAP + 200)) await cache.delete(k);
    }
  } finally {
    trimming = false;
  }
}

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
