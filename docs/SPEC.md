# DCR Job Walk — build spec (v1.0)

DCR Framing (a framing sub-contractor) is invited to **job walks**: the
estimator walks a project and records what must be estimated. This app is
that walk's camera and notebook:

1. Load a floor plan for each level — from a PDF, an image, a screenshot,
   a pasted image, or a photo of a printed plan. No plan yet? Use a
   satellite map; the plan can be added later.
2. **Calibrate** the plan on site: mark 3 spots on the plan, stand on each
   one and press **Set location**. The app learns the plan's scale,
   rotation and position against GPS. Optional: a known dimension (scale
   line) and a compass alignment along a wall, which make it more precise.
   Off site, a plan can be aligned to the satellite map instead.
3. Walk and capture. The plan shows **where you are and which way the
   camera faces**. Every photo saves its exact position on the plan,
   compass heading, camera tilt and altitude. Every video saves its path
   and camera direction over time, drawn on the plan.
4. Mark up photos (pen, highlighter, lines, arrows, boxes, ellipses,
   revision clouds, text, dimensions, numbered callouts), add text notes,
   voice notes and tags.
5. Everything is saved **on the phone** and is never lost (see Durability).
   A job walk exports as one `.zip` that opens in any browser (a
   self-contained viewer is inside it), can be uploaded to a website, and
   imports back into the app on any device.

**The owner's words:** "It is important not to lose any pictures or notes."
Durability beats every other concern.

---

## 1. Platform and conventions

- Static PWA: **vanilla JavaScript ES modules, no build step, no framework,
  no npm runtime dependencies**. Served from a sub-path on GitHub Pages
  (use relative URLs everywhere — never a leading `/`).
- Targets: **iPhone Safari 16.4+** (in a tab and installed to the Home
  Screen) and **Android Chrome 110+**; desktop Chrome/Edge/Safari/Firefox
  for the office (view, align plan to map, export).
- Content Security Policy (index.html): `script-src 'self'` — **no inline
  scripts, no `eval`/`new Function`, no external script URLs**. Inline
  styles are allowed. External requests are limited to map tiles
  (Esri `server.arcgisonline.com` / `services.arcgisonline.com`,
  OpenStreetMap `*.tile.openstreetmap.org`, Google `tile.googleapis.com`)
  and address search (`nominatim.openstreetmap.org`).
- Vendored libraries (already in `vendor/`): **pdf.js 3.11.174** (UMD,
  `vendor/pdfjs/build/pdf.min.js`, global `pdfjsLib`; worker
  `pdf.worker.min.js`; `cmaps/`, `standard_fonts/`) and **Leaflet 1.9.4**
  (`vendor/leaflet/leaflet.js`, global `L`; `leaflet.css` is linked in
  index.html). Load them with a `<script src>` element added at runtime
  (allowed by CSP since they are same-origin). When creating a pdf.js
  document pass `isEvalSupported: false`.
- Code style: match `js/core/store.js` — a header comment that says what
  the module is for and why, in plain language; JSDoc on exports; small
  functions; `const`/`let`; no semicolon-free style; 2-space indent; single
  quotes. Comments explain *why*, for a future maintainer.
- User-facing text: plain, short, friendly English for a construction
  estimator. Say what happened and what to do. Never say "error occurred".
- Touch first: every control ≥ 44px (use `--tap`), works one-handed,
  readable in sun. Also works with a mouse and keyboard on desktop.
- Units: store **meters** and **degrees**. Display through
  `formatLength / formatAccuracy` from `js/core/util.js` with
  `getSettings().units` (`'imperial'` default: feet-inches).

## 2. Files and ownership

```
index.html, manifest.webmanifest, sw.js           foundation (integration)
css/app.css                                         foundation: tokens + shared components
js/main.js        router + app context              foundation
js/version.js                                       foundation
js/core/util.js   ids, angles, lengths, dates       foundation
js/core/bus.js    Emitter + app bus                 foundation
js/core/db.js     IndexedDB                         foundation
js/core/store.js  records + media (durability)      foundation
js/core/settings.js                                 foundation
js/ui/shell.js    el(), toast, dialogs, sheets      foundation
js/ui/icons.js    icon(name)                        foundation

js/core/geo.js, orientation.js, motion.js, positioning.js, sim.js,
  vendor/geomagnetism/                                                 POSITIONING
js/core/calibration.js, js/ui/calibrate-screen.js, css/calibrate.css   CALIBRATION
js/ui/plan-view.js, js/ui/map-view.js, js/ui/markers.js, css/views.css VIEWS
js/core/media.js, capture.js, recorder.js,
  js/ui/camera-screen.js, css/camera.css                               CAMERA
js/core/annotations.js, js/ui/annotate-screen.js, css/annotate.css     ANNOTATE
js/core/voice.js, js/ui/item-screen.js, css/item.css                   ITEM
js/core/plan-import.js, js/ui/plan-import-dialog.js,
  js/ui/projects-screen.js, project-screen.js, settings-screen.js,
  trash-screen.js, items-panel.js, css/screens.css                     SCREENS
js/core/zip.js, js/core/package.js, js/ui/export-screen.js,
  css/export.css, viewer/viewer.html, viewer/viewer.css, viewer/viewer.js  EXPORT
tests/*.test.mjs  (node --test; each workstream adds its own)
```

A workstream edits **only its own files**. If it needs something from
another module that the spec does not give, it codes against the spec,
and lists the need under "integration notes" in its report.

## 3. App context and screens

`js/main.js` routes by hash (see its header). A screen module exports:

```js
export async function open(ctx) { …; return cleanup; }   // cleanup: () => void | Promise<void>
```

`ctx`:

| field | meaning |
|---|---|
| `root` | an empty `<section class="screen">` already in the DOM (full screen, flex column). Build the screen inside it. |
| `params` | route params: `pid`, `iid`, `lid` |
| `query` | hash query, e.g. `{mode: 'video'}` |
| `navigate(path, {replace})` | go to `'p/<pid>/camera?mode=video'` etc. (no leading `#/`) |
| `back(fallbackPath)` | history back inside the app, or `fallbackPath` when there is none |
| `setGuard(async () => boolean)` | block leaving (return false to stay) — unsaved markup, a recording |
| `isCurrent()` | false once the person has left this screen (stop async work) |
| `app.store` | `js/core/store.js` module |
| `app.positioning` | the positioning engine (§5) |
| `app.bus` | app event bus |
| `app.shell` | `js/ui/shell.js` module |
| `app.getSettings()`, `app.updateSettings(patch)` | settings (§4.4) |
| `app.cache` | a `Map` that lives as long as the page (e.g. decoded plan images by media id) |
| `app.enterProject(pid)` | re-read the project, refresh the positioning context; main.js already calls it before any `p/:pid…` screen opens |

Standard screen layout: a `.topbar` (back button `iconButton('back')`,
`.topbar-title` with `h1` + `.sub`, actions), a body (`.screen-body` for
scrolling screens, or a full-bleed view), an optional `.bottombar`.
The cleanup must remove listeners, stop timers/streams, release object
URLs (`store.createUrlScope().release()`), and destroy views.

Events on `app.bus`:

| event | payload |
|---|---|
| `store:change` | `{kind: 'project'|'item'|'media', action, id, projectId, remote?}` after every committed write |
| `settings:change` | full settings object |

## 4. Data model

All records live in IndexedDB through `js/core/store.js` (read its header
and exports — they are the API; do not touch `db.js` directly from UI).

### 4.1 Project (a job walk)

```js
{
  id: 'p_…', schema: 1,
  name, address, gc, number /* DCR job # e.g. A302 */, walkDate /* 'YYYY-MM-DD' */, notes,
  createdAt, updatedAt, deletedAt /* null | ms */, createdBy,
  origin: null | {lat, lng, setAt},   // local east/north origin; set ONCE (store.setOriginOnce)
  compassOffset: null | deg,          // true heading = magnetic heading + compassOffset
  compassAlignedAt: null | ms,
  mapView: null | {lat, lng, zoom},   // last map position (quiet update)
  levels: [Level], activeLevelId,
  nextSeq,                            // next item number (#1, #2, …)
  changeSeq, backup: {lastAt, changeSeq, fileName},
}
```

### 4.2 Level

```js
{
  id: 'l_…', name: 'Level 1', order,
  plan: null | {mediaId, thumbId, width, height /* px of the stored image */, source: 'pdf'|'image'|'paste'|'camera', fileName, page, addedAt},
  planHistory: [{…plan, calibration, replacedAt}],   // replaced plans are kept
  calibration: null | Calibration,                   // §6
  calibrationHistory: [Calibration],
}
```

A level with `plan: null` is in **map mode** (satellite map, positions by
lat/lng). Plan pixel coordinates: origin top-left of the stored image,
x right, y down, in that image's pixels.

### 4.3 Item (photo, video, note)

```js
{
  id: 'i_…', projectId, levelId, type: 'photo'|'video'|'note',
  seq,                                   // #number in this job walk (assigned by store)
  createdAt, updatedAt, deletedAt,
  title: '', text: '', tags: ['Walls', …],
  media: {original, thumb, annotated, annotatedThumb, poster},   // media ids (null when absent)
  width, height, duration /* s, video */, mimeType,
  pose: Pose | null,                     // where and which way (photo: at the shutter; video: at start; note: where placed)
  track: [TrackPoint] | null,            // video path
  annotations: null | Annotations,       // §8
  voiceNotes: [{id: 'v_…', mediaId, duration, mimeType, createdAt, transcript: ''}],
  source: 'camera'|'device-camera'|'import'|'recovered',
  capturedBy: '',                        // settings.userName at capture
}
```

**Pose** (stored on items; also what positioning emits — §5):

```js
{
  t,                                     // ms epoch
  geo: null | {lat, lng, acc /* m */, alt /* m or null */, altAcc},
  enu: null | {e, n},                    // meters east/north of project.origin
  plan: null | {x, y},                   // plan px on the item's level
  planAcc: null | px,
  planLocked: false,                     // true when the person placed/moved the pin by hand
  heading: null | deg,                   // camera direction, clockwise from TRUE north
  headingAcc: null | deg,
  planHeading: null | deg,               // camera direction, clockwise from plan "up" (−y)
  pitch: null | deg,                     // camera tilt above the horizon (+up, −down, −90 straight down)
  roll: null | deg,
  facing: 'camera'|'top',                // 'top' when the phone is flat (heading = where the top edge points)
  source: 'fused'|'gps'|'manual'|'sim'|'none',
  quality: 'good'|'fair'|'poor'|'none',  // good ≤ 1.5 m, fair ≤ 5 m, poor > 5 m
  magHeading: null | deg,                // the same direction against MAGNETIC north (as measured)
  declination: null | deg,               // east-positive, what was added (WMM2025 or the compass alignment)
  headingSource: 'compass-aligned'|'wmm'|'setting'|'none',
  raw: null | {alpha, beta, gamma, absolute, src: 'abs'|'ios'|'rel'|'sim', compass /* webkitCompassHeading */, compassAcc, screenAngle, t},
                                         // the sensor values behind it, so headings can be recomputed later
  zoom: null | number,                   // camera zoom when the photo was taken (set by the camera)
}
```

**TrackPoint** (video): `{t /* ms since video start */, e, n, x, y, lat, lng, acc, heading, planHeading, pitch}` —
any field may be null; sampled at 4–5 Hz.

Rule for pins after a re-calibration: an item whose `pose.planLocked` is
false gets `pose.plan` (and track `x,y`) recomputed from `enu` with the new
calibration (`calibration.js` `reprojectItems`, run by the calibration
screen when it saves). Locked pins stay.

### 4.4 Settings

See `DEFAULT_SETTINGS` in `js/core/settings.js` (userName, units,
stepLength, declination, photoMaxSize, esriKey, photoQuality, videoQuality,
shutterSound, vibrate, keepAwake, mapProvider, googleMapsKey,
stampExports, backupReminder, simulate, onboarded).

### 4.5 Tags

Framing estimating tags (suggested; the person can add their own, stored
per project as they are used): `Walls`, `Headers/Beams`, `Floor framing`,
`Roof/Trusses`, `Sheathing`, `Shear/Hold-downs`, `Blocking`, `Stairs`,
`Decks/Balconies`, `Hardware`, `Existing conditions`, `Demo`, `Access/Site`,
`Issue/RFI`, `Safety`. The list is `export const DEFAULT_TAGS` in
`js/ui/items-panel.js`.

## 5. Positioning engine (POSITIONING)

`js/core/positioning.js` exports a singleton `positioning` (an `Emitter`
from bus.js):

```js
positioning.start()                    // idempotent; begins GPS watch + sensors
positioning.stop()                     // idempotent
positioning.setContext({project, level, onOrigin})   // origin, calibration, compassOffset; onOrigin({lat,lng}) when the project has no origin and the first good fix arrives
positioning.getPose()                  // latest Pose (§4.3) — synchronous, never throws
positioning.getStatus()                // {gps: 'off'|'waiting'|'ok'|'denied'|'unavailable'|'error', compass: 'off'|'ok'|'needs-permission'|'denied'|'unavailable'|'uncalibrated', motion: same set, message}
positioning.needsPermission()          // true on iOS until requestPermission() succeeded
positioning.requestPermission()        // Promise<boolean>; MUST be called from a tap handler (iOS rule)
positioning.fixHere({plan}|{geo}|{enu}) // "I'm here": the person tells the app exactly where they stand
positioning.clearFix()
positioning.sampleStationary({minSeconds=8, maxSeconds=30, targetAcc=1.0, onProgress, signal})
   // Promise<{lat, lng, enu, acc /* estimated 1σ of the mean, m */, alt, n /* fixes used */, spread /* m */}>
   // averages fixes while the person stands still (calibration). onProgress({n, elapsed, acc, spread, lastFix})
positioning.sampleHeading({seconds=3, onProgress, signal})
   // Promise<{magnetic, true /* null if no offset */, spread}> — circular mean of the camera heading
positioning.on('pose', fn)             // ≤ 10 Hz
positioning.on('status', fn)
```

Engine design (required):

- **GPS**: `navigator.geolocation.watchPosition` with
  `{enableHighAccuracy: true, maximumAge: 0, timeout: 27000}`; reject fixes
  older than 10 s; keep the last raw fix.
- **Local frame**: `geo.js` — `toEnu(origin, lat, lng) → {e, n}` and
  `fromEnu(origin, e, n) → {lat, lng}` (local tangent plane; accurate to
  mm over a few km), `distance`, `bearing`. If the project has no origin
  yet, the first fix with `acc ≤ 50 m` becomes a provisional origin and
  `onOrigin` is called (the project then stores it once).
- **Fusion**: a 2-D Kalman filter on `{e, n}`: predict on every detected
  step (`motion.js` step detector on `devicemotion`) by
  `settings.stepLength` along the walking heading, with process noise
  growing over time; update on each GPS fix with σ derived from
  `coords.accuracy`; Mahalanobis gate outliers (accept anyway after 5
  rejects in a row — the filter was wrong). When standing still (no steps
  for 2 s) do not drift.
- **Manual fix** (`fixHere`): snap the state to that point with σ ≈ 0.3 m
  and remember the GPS bias at that moment (`fixedPoint − currentGPS`),
  applied to later GPS fixes and fading out over ~10 minutes (GPS error is
  correlated over minutes, so this genuinely improves the next few
  minutes of positions).
- **Heading**: `orientation.js` — from `deviceorientationabsolute`
  (Android) or `deviceorientation` + `webkitCompassHeading` (iOS);
  compute the back-camera direction (device −Z axis) heading and pitch
  from the full W3C rotation matrix (alpha/beta/gamma); when the phone is
  nearly flat (|pitch| > 65° looking down/up) report the device-top
  heading with `facing: 'top'`. Walking heading = camera heading when
  upright, top heading when flat. Smooth on the circle (no 359→0 jumps).
  True heading = magnetic + declination, where declination is, in order:
  `project.compassOffset` (the compass alignment on site — best: it also
  absorbs local steel and phone bias), else `settings.declination` when
  the person typed one, else **WMM2025** computed for the position (vendor
  `geomagnetism` 0.2.0, Apache-2.0, ported to an ES module in
  `vendor/geomagnetism/` with its LICENSE — POSITIONING owns that folder),
  else 0. Record which one in `pose.headingSource`. Follow
  docs/RESEARCH.md "orientation" exactly (iOS alpha offset learned from
  `webkitCompassHeading` while the phone is flat-ish; Android
  `deviceorientationabsolute`; never detect iOS by `requestPermission`).
  `planHeading = heading + calibration.northAngle` when calibrated (northAngle is clockwise from plan up to true north; use `calibration.headingToPlan`).
- **Plan position**: `calibration.enuToPlan(level.calibration, enu)`;
  `planAcc = acc × calibration.pxPerMeter`.
- **Quality**: from the filter σ: good ≤ 1.5 m, fair ≤ 5 m, poor > 5 m.
- **Simulation** (`sim.js`, when `settings.simulate`): fake GPS fixes
  (walking a rectangle around the origin or Sacramento, CA 38.5816,
  −121.4944 when there is none, with realistic noise) and a fake compass
  that follows the walk — so the whole app can be demoed and tested on a
  desktop. `pose.source = 'sim'`.
- Pure math must be importable in Node (no DOM at module top level) and
  covered by tests: `tests/geo.test.mjs`, `tests/orientation.test.mjs`,
  `tests/positioning.test.mjs` (filter behavior, gating, bias fade).

## 6. Calibration (CALIBRATION)

`js/core/calibration.js` (pure):

```js
solveCalibration({pairs: [{plan: {x, y}, enu: {e, n}, sigma /* m */}], scaleLine: null | {a: {x,y}, b: {x,y}, meters}, method: 'gps'|'map'})
  → Calibration
enuToPlan(cal, {e, n}) → {x, y}
planToEnu(cal, {x, y}) → {e, n}
headingToPlan(cal, trueHeadingDeg) → planHeadingDeg
planHeadingToTrue(cal, planHeadingDeg) → trueHeadingDeg
reprojectItems(items, level, origin) → [{id, pose, track}]  // new plan coords for unlocked items on that level
describeQuality(cal) → {label, detail, level: 'good'|'fair'|'poor'}
```

Calibration:

```js
{
  version: 1, method: 'gps'|'map', createdAt,
  toPlan: [a, b, c, d, tx, ty],   // x = a·e + b·n + tx ;  y = c·e + d·n + ty
  toEnu:  [a, b, c, d, tx, ty],   // the inverse
  pxPerMeter, northAngle /* deg clockwise from plan up to true north */,
  pairs, scaleLine,
  residuals: [meters per pair], rms, maxResidual, quality: 'good'|'fair'|'poor',
}
```

Solver: a **similarity** transform (uniform scale + rotation +
translation; plans are drawn to scale, so no shear) by weighted least
squares (weights 1/σ²). Plan y points down: solve in a y-up frame and
fold the flip into `toPlan`. With a `scaleLine`, the scale is fixed by it
(far more precise than GPS over a short distance) and only rotation and
translation are fit. 2 pairs are the minimum; 3 give a residual check.
Warn when points are nearly collinear or closer than ~5 m. Tests:
`tests/calibration.test.mjs` (exact recovery of known transforms, noise,
scale line, collinear warning, round trips, heading conversion).

`js/ui/calibrate-screen.js` (route `p/:pid/calibrate/:lid`, `?mode=gps|map|scale|compass`):

- **GPS (on site)**: for points 1–3: "Move the plan so the cross is on a
  spot you can stand on (a slab corner, a column)" → **Mark on plan** (uses
  `planView.pickPoint`) → "Walk there and stand still" → **Set location**
  (runs `positioning.sampleStationary`, shows live samples / precision /
  a countdown, **Done** when good enough or **Keep averaging**). Suggest
  spreading points (a triangle as large as the building). Allow redoing a
  point. After 3: show the result (scale, rotation, error per point in
  ft/m, quality) → **Save** (store.setCalibration + reproject items) or
  **Redo**.
- **Scale line** (optional, recommended): mark two points of a known
  dimension on the plan (e.g. a 24' wall) and type the length
  (`parseLength`). Used by the solver.
- **Compass alignment** (optional): pick two points along a wall on the
  plan, hold the phone flat-upright pointing along that wall, **Set
  direction** (`positioning.sampleHeading`) → saves
  `project.compassOffset` so headings match the plan exactly.
- **Map (office)**: align a plan with the satellite map without being on
  site: pick a point on the plan, then the same point on the map
  (`mapView.pickPoint`), 2–4 times → solve with `method: 'map'`.
- If the plan has no calibration, a photo still saves (positions come from
  GPS lat/lng; plan pins appear once it is calibrated).

## 7. Plan and map views (VIEWS)

`js/ui/plan-view.js`:

```js
createPlanView(container, {image /* HTMLImageElement|ImageBitmap|HTMLCanvasElement */, width, height, interactive = true, units})
  → PlanView {
    el,
    setItems(items, {selectedId} = {}),     // photo pins with direction wedge, video paths, note pins
    setPose(pose | null),                   // blue dot + accuracy circle + heading cone (pose.plan, planAcc, planHeading)
    setMarks(marks),                        // [{x, y, label, color, kind: 'calib'|'scale'|'temp'}] calibration points etc.
    setLines(lines),                        // [{a: {x,y}, b: {x,y}, label, color, dashed}] scale line, wall line
    setPlayback(item | null, tMs),          // highlight a video's path; marker + cone at time tMs
    setFollow(on), isFollowing(),
    fit(), centerOn({x, y}, scale?), getView(), setView(view),
    pickPoint({title, hint, initial}) → Promise<{x, y} | null>,   // a fixed cross in the centre; the plan pans under it; magnifier; Set / Cancel buttons
    hitTest(screenX, screenY) → item | null,
    on('tapitem', item), on('tap', {x, y}), on('longpress', {x, y}), on('viewchange'), on('followchange', on),
    resize(), destroy(),
  }
```

Canvas-based, crisp on high-DPI screens, smooth pinch-zoom/pan (pointer
events; two-finger pinch; mouse wheel; double-tap zoom), inertia optional.
Large plans (up to ~8000 px) must stay smooth on a phone: draw the image
with transforms, redraw only on change (rAF), keep the overlay cheap.
Following mode keeps the person's dot in view (stops when they pan).

`js/ui/map-view.js` — the same interface on Leaflet with geo coordinates:
`createMapView(container, {center: {lat, lng}, zoom, provider, googleKey})`;
`setItems` uses `pose.geo` / track `lat,lng`; `setPose` uses `pose.geo` /
`pose.heading`; `pickPoint` → `{lat, lng}`; `tap` → `{lat, lng}`; plus
`setPlanOverlay({image, calibration, origin, opacity} | null)` (shows a
calibrated plan over the satellite, for map alignment) and
`searchAddress(query) → Promise<[{label, lat, lng}]>` (Nominatim, user
triggered only). Base layers: Esri World Imagery (satellite, default,
attribution "Esri, Maxar, Earthstar Geographics"; with `settings.esriKey`
use the token endpoint, else the public `server.arcgisonline.com` one),
OpenStreetMap streets, and Google satellite through the Map Tiles API when
`settings.googleMapsKey` is set and `mapProvider === 'google'` (create a
session, `mapType: 'satellite'`, show the Google logo + copyright from the
viewport endpoint; **Google's terms forbid showing it next to a non-Google
map, so when Google is the provider it is the only base layer — no
switcher with Esri/OSM**). Every tile layer uses `crossOrigin: true` (an
opaque tile would cost ~7 MB of the storage the photos share). Esri:
`maxNativeZoom: 19` (past real data Esri returns grey placeholder tiles
with HTTP 200), map `maxZoom: 22` (overzoom). Leaflet is loaded on demand.
See docs/RESEARCH.md "maps".

`js/ui/markers.js` — shared drawing of pins/cones/paths for canvas
(plan view, camera mini-map, viewer may copy it): `drawPhotoPin(ctx, x, y, headingRad, {selected, n, annotated})`,
`drawVideoPath(ctx, points, {selected})`, `drawNotePin`, `drawMe(ctx, x, y, accPx, headingRad, facing)`.
Colours from the CSS tokens (`--pin-photo`, `--pin-video`, `--pin-note`, `--me`).

## 8. Camera, media and recording (CAMERA)

`js/ui/camera-screen.js` (route `p/:pid/camera?mode=photo|video`):
full-screen viewfinder (`getUserMedia` rear camera, highest resolution
the phone gives; ImageCapture `takePhoto()` where available for full
resolution, else a video frame), overlay: back, level name, position chip
(`±4 ft`), heading (`NE 42°`), tilt, a small live plan/map inset showing
the person and cone (`createPlanView(…, {interactive: false})` or a small
canvas), mode switch Photo/Video, shutter, last thumbnail (tap → item),
torch, zoom (when supported), and **Use phone camera** (`<input
type=file capture>` fallback; pose taken when it returns, marked
`source: 'device-camera'`). Rapid shooting: the shutter is ready again
immediately; saving happens in the background with a visible "Saving… /
Saved ✓" per shot and a loud error if a save fails (keep the blob and
offer **Download this photo** so nothing is lost). **Pin check** (precision):
tapping the inset opens a larger plan centred on the last photo's pin;
the person drags the plan under the cross to the exact spot → the photo
gets `pose.plan` with `planLocked: true` AND `positioning.fixHere` is
called, so the following shots are more accurate too. A setting-free
toggle "Check pin after each photo" (kept in `app.cache`/localStorage) opens
it automatically after every shot. Video: shows REC timer
and the path being drawn live; stopping saves. Handles iOS and Android
camera quirks and orientation (portrait/landscape). Wake lock is handled
by main.js. Guard: leaving while recording asks first.

`js/core/media.js`: `decodeImage(blob) → ImageBitmap|HTMLImageElement`,
`imageSize(blob)`, `makeThumb(source, max = 400) → Blob (jpeg)`,
`canvasToBlob(canvas, type, quality)`, `resizeToMax(blob, maxSide, quality)`,
`videoInfo(blob) → {width, height, duration, posterBlob}` (fix the webm
Infinity-duration bug), `pickVideoMime()`, `pickAudioMime()`,
`readExif(blob) → {lat, lng, alt, takenAt, orientation} | null` (minimal
JPEG EXIF parser for imported photos).

`js/core/capture.js`:

```js
snapshotPose(pose, level) → Pose            // a clean copy for storage
savePhoto({project, level, blob, width, height, pose, source}) → Promise<item>   // original (verified) → thumb → item
importPhotos(files, {project, level}) → Promise<item[]>                         // gallery imports; EXIF GPS when present
saveNote({project, level, pose, text, title}) → Promise<item>
```

`js/core/recorder.js`:

```js
createVideoRecorder({stream, project, level, getPose, quality}) → {
  start(), stop() → Promise<item>, cancel(), elapsedMs(), track, on('sample'|'error'|'saved')
}
recoverRecordings() → Promise<item[]>      // main.js calls at boot
createAudioRecorder() → {start(stream?), stop() → Promise<{blob, duration, mimeType}>, cancel(), level() /* 0..1 */}
```

Write-ahead: `MediaRecorder.start(1000)`; every chunk goes straight to
`store.putChunk`; the track is flushed to `store.updateRecording` every
2 s; on stop the chunks are joined, saved with `store.putMedia` (verified),
poster + thumb made, the item created, and only then `store.endRecording`.
`recoverRecordings` rebuilds any recording left behind (app killed) into a
video item with `source: 'recovered'` and its saved track.

## 9. Markup (ANNOTATE)

`js/core/annotations.js` (pure model + canvas rendering, Node-testable
geometry):

```js
Annotations = {v: 1, width, height /* of the original photo */, shapes: [Shape], updatedAt}
Shape = {id, type, color, width /* stroke px in photo pixels */, …}
  pen        {points: [[x, y], …], mode: 'pen'|'highlight'}
  line|arrow|rect|ellipse|cloud|dimension {a: {x,y}, b: {x,y}, label? (dimension)}
  text       {at: {x,y}, text, size, bg: true}
  badge      {at: {x,y}, n}            // numbered callout ① ② ③ (n auto-increments)
renderAnnotations(ctx, annotations, {scale = 1})   // draw in photo pixel space × scale
flatten(originalBlob, annotations, {maxSide, quality}) → Promise<Blob>   // JPEG with markup burned in
hitShape(annotations, x, y, tolerance) → shape | null
```

`js/ui/annotate-screen.js` (route `p/:pid/i/:iid/annotate`): toolbar
(select/move, pen, highlighter, arrow, line, rectangle, ellipse, cloud,
text, dimension, callout number, eraser), colours (red, yellow, blue,
green, white, black), stroke width S/M/L, undo/redo, pinch-zoom/pan while
drawing with two fingers, edit/move/delete shapes, **Save** → store
`annotations`, `media.annotated` (flattened, verified) and
`media.annotatedThumb`; never alters `media.original`. Autosave a draft
(the shapes) to the item every few seconds while editing, so a crash
loses nothing; guard on unsaved changes. Works for photos only (videos:
the item screen gets notes and voice notes).

## 10. Item detail, notes and voice (ITEM)

`js/ui/item-screen.js` (route `p/:pid/i/:iid`): photo (pinch-zoom; markup
shown by default, toggle Original), or video player with the plan below
showing its path and a moving marker + cone synced to playback
(`planView.setPlayback`), or a note. Below: #seq, title (editable),
when, who, level, position (quality, `±`), heading `NE 42°`, tilt,
altitude; a mini plan/map with the pin (tap → open the plan centred on
it; **Move pin** places it by hand → `planLocked: true`), tags (chips;
add custom), text notes (autosave as you type, debounced, flushed on
leave/visibilitychange), **Dictate** (Web Speech API when available),
voice notes (record, play, delete → to item's voiceNotes; recorded with
`createAudioRecorder`), actions: Mark up, Share (the annotated JPEG via
Web Share), Download, Delete (→ Recently Deleted, with Undo toast),
previous/next item (swipe).

`js/core/voice.js`: `createDictation({onText, onEnd, lang}) | null` (Web
Speech API wrapper), `addVoiceNote(itemId, {blob, duration, mimeType}) → item`,
`removeVoiceNote(itemId, voiceId)` (bytes kept until the item is purged).

## 11. Screens, plans, items panel (SCREENS)

- `projects-screen.js` (home `#/`): DCR Job Walk header (brand bar), list
  of job walks (cover thumbnail, name, address, date, counts of photos /
  videos / notes, **backup status** "Backed up Nov 2" or "12 changes not
  backed up"), **New job walk** (name, address, GC/client, DCR job #,
  date) → then the plan-source chooser, **Import a job walk** (`.zip`
  from package.js), settings, Recently Deleted; storage meter ("2.1 GB
  free · storage protected ✓"); first-run card (what the app does, give
  your name); iPhone "Add to Home Screen" card when not installed (Safari
  can clear website data of sites that are not installed — installed is
  safer).
- `plan-import-dialog.js`: `choosePlan({project, level, allowMap}) → Promise<{blob, width, height, source, fileName, page, thumbBlob} | 'map' | null>`:
  options **Upload PDF or image**, **Take a photo of the plan**, **Paste
  a screenshot** (Clipboard API button + paste event), drag-and-drop on
  desktop, **Use the map for now**. PDF → page picker (thumbnails) →
  rendered with pdf.js at a resolution good for zooming (longest side
  ≈ 6000 px, capped by the phone's canvas limit ≈ 16.7 M px on iOS) →
  JPEG/PNG. Optional rotate 90° and crop before saving.
  `js/core/plan-import.js` holds the non-UI parts (PDF load/render,
  image normalize, canvas limits).
- `project-screen.js` (`#/p/:pid`): top bar (back, job name, level switcher
  dropdown, menu); full-bleed plan view (or map view in map mode);
  overlay: position chip (tap → position details + "I'm here"), compass
  permission button (iOS), **Follow me**, **I'm here** (pickPoint then
  `positioning.fixHere`), "Calibrate this plan" banner when uncalibrated,
  "No plan yet — add one" in map mode; bottom bar: **Items** (opens the
  items panel), **Note** (a note at the current position — or long-press
  the plan to drop a note there), big **Photo** capture button (→
  camera), **Video**, **More**. Menu: Job info (edit), Levels & plans
  (add level, rename, add/replace plan, remove), Calibrate (GPS / map /
  scale / compass), Back up & export, Settings. Tapping a pin opens a
  preview card (thumb, #, tags, note excerpt) → item screen. Backup
  reminder banner when many changes are not backed up.
- `items-panel.js`: a sheet/panel listing the job walk's items as a grid
  or list with filters (type, tag, level, has notes), search in
  title/notes, sorted by time or #; `export const DEFAULT_TAGS`.
- `settings-screen.js`: every setting in §4.4, storage (used/free,
  protected state + **Protect storage** button + platform advice), app
  version, **Demo mode** switch, Recently Deleted link, "How positioning
  works" help.
- `trash-screen.js`: Recently Deleted — job walks and items, **Restore**,
  **Delete forever** (confirmation that names what is lost).

## 12. Export, backup, import, viewer (EXPORT)

`js/core/zip.js`: a ZIP writer that builds a `Blob` from parts without
copying media into memory (stored method; deflate optional via
`CompressionStream('deflate-raw')` for JSON/HTML), CRC-32 computed by
streaming each Blob, **ZIP64** when sizes/offsets exceed 4 GB/65535 files,
UTF-8 names (flag bit 11); and a reader (central directory, stored +
deflate via `DecompressionStream('deflate-raw')`, ZIP64) that returns
entries with lazy `blob()` / `text()`. Tests: `tests/zip.test.mjs`
(round trip, CRC vectors, ZIP64 headers, unicode names, a file made by
another zip tool if one is available in Node).

`js/core/package.js`:

```js
exportProject(projectId, {includeVideos = true, includeOriginals = true, onProgress, signal}) → Promise<{blob, fileName, changeSeq}>
exportPhotos(projectId, {annotated = true, onProgress}) → Promise<{blob, fileName}>     // flat zip of JPEGs: "012 - Level 1 - Walls - 2026-11-02 10.32.jpg"
inspectPackage(file) → Promise<{project, counts, exists /* same id on this phone */}>
importPackage(file, {mode: 'copy'|'replace', onProgress}) → Promise<projectId>
```

Package layout (one format for sharing and backup):

```
index.html                 the viewer, self-contained (inline CSS + JS + the job walk data)
jobwalk.json               full data, schema 1 (project, items, media index) — import reads this
media/plans/<levelId>.<ext>
media/photos/<seq>-<itemId>.jpg          originals
media/annotated/<seq>-<itemId>.jpg       markup burned in (and the export stamp when settings.stampExports)
media/thumbs/<itemId>.jpg
media/videos/<seq>-<itemId>.<webm|mp4>
media/voice/<voiceId>.<webm|m4a|ogg>
README.txt                 how to open, view and import
```

The viewer (`viewer/viewer.html` template + `viewer.css` + `viewer.js`,
classic script, **no modules, no fetch**) works opened straight from the
unzipped folder (`file://`) and from any static web host: data is inlined
in a `<script type="application/json">` (escape `</`), media referenced by
relative path. It shows the job info, level tabs, the plan with numbered
pins / camera wedges / video paths (pan/zoom), a grid of items, item detail
(annotated/original toggle, notes, tags, voice notes, video with the path
synced), filters, and **Print report** (print CSS: plan with pins, then
one card per item with its photo, notes and position). For map-mode
levels it shows a Leaflet map from unpkg when online (CSP-free context),
otherwise coordinates with "Open in Google Maps" links. Every text field
from the data is escaped (XSS: notes are user text).

`js/ui/export-screen.js` (`#/p/:pid/export`): **Back up / share this job
walk** (zip: download, or the share sheet to Files / Drive / OneDrive /
email), options (include videos), progress, size estimate, then
`store.markBackedUp(projectId, {changeSeq})` with the changeSeq read when
the export started; **Photos only (JPEGs)**; explanation of how to view it
online (unzip and open index.html, or upload the folder to a website, or
import into DCR Job Walk on another device). Import lives on the home
screen but uses `inspectPackage` / `importPackage`.

## 13. Durability (everyone)

- Save through `store` only; **await** each save and show success only
  after it resolves. On failure: a toast with the store's message, keep
  the data in memory, offer a way to retry or download it.
- Never delete bytes outside Recently Deleted. Replacing a plan keeps the
  old one. Markup never touches the original.
- Text the person types is saved within ~1 s (debounced) and on
  `visibilitychange`/`pagehide`/screen cleanup.
- A video's chunks are on disk within ~1 s of being recorded.
- `navigator.storage.persist()` is requested at boot; settings shows the
  state; the home screen nudges iPhone users to install to the Home Screen.
- Backups: the project tracks unbacked changes; the app reminds.

### 13.1 Storage facts that shape the code (docs/RESEARCH.md "Storage durability")

- Bytes are stored as ArrayBuffer parts with SHA-256 (db.js / store.js) —
  never as Blobs (iOS Blob-in-IndexedDB bugs). Use `store.putMedia` /
  `store.getMediaBlob`; never write bytes to the database another way.
- Files from `<input type=file>` are temporary on iOS: read them
  (`await file.arrayBuffer()` or save them) right away; never keep a File
  around for later.
- Pass `meta` to `store.putMedia` for originals and videos
  (`{itemId, levelId, pose, width, height, duration, track, createdAt,
  capturedBy}`, with the item id generated before the bytes are saved and
  passed to `createItem` as `id`), so `store.recoverOrphans()` can rebuild
  the item if the app dies between the two writes.
- `estimate().quota` is not free space (Chrome reports usage + 10 GiB):
  show usage only; treat QuotaExceededError as the real signal.
- Saving a file the person keeps (`shell.saveBlob`) needs a fresh tap:
  build the zip first, then show a **Save** button; handle `'needs-tap'`.
  Android uses the Save-as picker (the share sheet refuses .zip there);
  iPhone uses the share sheet.
- iPhone: data in a Safari tab and in the Home Screen app are separate,
  and Safari tabs can be wiped after 7 days without use. Push installing
  before the first job walk.

## 14. Testing

- `npm test` (= `node --test "tests/*.test.mjs"`) must pass. Pure modules (util, geo, orientation,
  positioning filter, calibration, annotations geometry, zip, package
  data mapping) are tested in Node 24 (it has Blob, CompressionStream,
  DecompressionStream, crypto). For IndexedDB in Node use the dev
  dependency `fake-indexeddb` if needed (`import 'fake-indexeddb/auto'`).
- Every module must parse: `node --check` does not support ESM imports of
  browser globals at top level, so keep browser globals inside functions.
- Browser testing happens at integration (Chrome with fake camera, the
  simulation mode for positioning).
