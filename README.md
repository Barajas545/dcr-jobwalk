# DCR Job Walk

Photos, videos and notes placed on the floor plan during a job walk —
for DCR Framing's estimators.

## What it does

- **Floor plan first.** Load the plan for each level from a PDF, an image,
  a screenshot, a pasted image, or a photo of a printed sheet. No plan yet?
  The job walk starts on a satellite map and the plan can be added later.
- **Calibrate on site.** Mark three spots on the plan you can stand on (slab
  corners, columns), stand on each one and press **Set location**. The app
  learns the plan's scale and rotation against GPS. For the best accuracy
  also mark one **known dimension** (e.g. a 24' wall) and **align the
  compass** along a wall. In the office you can align a plan to the
  satellite map instead.
- **Walk and shoot.** The plan shows where you are and which way the camera
  faces. Every photo keeps its spot on the plan, the compass direction, the
  camera tilt and the altitude. Videos keep the whole path, drawn on the
  plan, with the camera direction along it. Tap **I'm here** on the plan any
  time to correct the position — the next few minutes of photos get more
  accurate too.
- **Mark up.** Pen, highlighter, arrows, lines, boxes, ellipses, revision
  clouds, text, dimensions and numbered callouts. Text notes, dictation,
  voice notes and tags (Walls, Headers/Beams, Shear/Hold-downs, Issue/RFI…).
  The original photo is always kept untouched.
- **Share.** **Back up & export** makes one `.zip`: unzip it and open
  `index.html` in any browser to see the plan with every photo, note, voice
  note and video path — and print a report. Upload the unzipped folder to a
  website to view it online, or import the `.zip` into DCR Job Walk on
  another phone or PC.

## Keeping every photo and note safe

Everything is saved on the phone the moment it is taken — the app only says
"Saved" after it has read the photo back from storage. Videos are saved a
second at a time while recording, so a dead battery or a crash loses at most
a second. Deleted things go to **Recently Deleted** first.

To be safe:

1. **Install it to the Home Screen.** iPhone: Safari → Share → *Add to Home
   Screen*. Android: Chrome → ⋮ → *Install app*. Installed apps keep their
   storage; Safari may clear website data of sites that are not installed
   and have not been used for a while.
2. **Back up after each walk** (Back up & export → share to OneDrive, Google
   Drive, Files or email). The job walk list shows which walks have changes
   that are not backed up.
3. Don't clear Safari/Chrome "website data" for the app's site — that is
   where the photos live until you back them up.

## How precise is the position?

Phone GPS outdoors is typically within 3–5 m (10–16 ft). Under a roof it is
worse. The app combines GPS with step counting and the compass, and lets
you correct it by tapping **I'm here**. A known dimension makes the plan's
scale exact; the compass alignment makes the camera direction match the
plan. The position chip always shows the current accuracy (e.g. `±4 ft`).

## For developers

- Static PWA: vanilla JavaScript modules, no build step. `docs/SPEC.md` is
  the design; `docs/RESEARCH.md` the platform facts it relies on.
- Run locally: `npm run dev` → http://127.0.0.1:8795/ (localhost is a
  secure origin, so camera and location work in a desktop browser; turn on
  **Demo mode** in Settings to simulate walking). The service worker only
  runs on localhost with `?sw=1`.
- Tests: `npm install` once (fake-indexeddb, dev only), then `npm test`.
- Shipping: bump `APP_VERSION` in `js/version.js` and `CACHE` in `sw.js`;
  a new file goes in `PROGRAM` in `sw.js` (the tests check it).
