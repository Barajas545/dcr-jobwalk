// camera-screen.js — the camera (route p/:pid/camera?mode=photo|video).
//
// Built for speed on a job site: point, tap, next. What it promises:
//
//  - The position, compass heading and tilt are read AT THE TAP, before
//    anything is awaited (positioning.getPose() is synchronous), so a photo
//    is placed where it was taken even if the camera takes a moment.
//  - The shutter is ready again at once. Photos are saved in the
//    background, one at a time (an iPhone runs out of memory holding many
//    full-size pictures), each with its own "Saving… / Saved ✓". A photo
//    whose save fails stays in memory with a red badge — "Tap to retry /
//    download" — and leaving the screen asks first. Nothing is dropped
//    until its save has resolved.
//  - ONE long-lived rear camera stream (docs/RESEARCH.md "camera"): landscape
//    size numbers (iOS records sideways otherwise), the real size read after
//    the first frame, full-resolution ImageCapture.takePhoto() where the
//    browser has it (checked: big enough, not black; one retry), else a
//    video frame on a canvas kept under the iOS size limit.
//  - A photo held sideways while the screen did not turn (rotation lock) is
//    turned upright by its EXIF orientation — the picture bytes are kept.
//  - Videos are written to the phone a second at a time while recording
//    (js/core/recorder.js) and are finished and saved when the app is hidden.
//  - The camera is let go when the page is hidden or the screen is left, and
//    turned on again on return.
//  - "Pin check": tap the little plan to put the last photo's pin exactly
//    where you stood. That also tells positioning where you are
//    (positioning.fixHere), so the next photos are more accurate too.
//
// Layout: a black full-screen viewfinder; top: back, level, position chip,
// heading, tilt (and a horizon line when the phone is upright); a live plan
// or map inset; bottom: Photo / Video, the shutter, the last capture. Works
// in portrait and landscape, inside the safe areas (css/camera.css).

import { el, iconButton, toast, confirmDialog, choose, openSheet, busy, pickFiles, saveBlob } from './shell.js';
import { icon } from './icons.js';
import { formatAccuracy, formatDuration, formatTime, compassPoint, normDeg, clamp, uid, isIOS, safeFileName, buzz, debounce } from '../core/util.js';
import * as media from '../core/media.js';
import { snapshotPose, savePhoto, uprightCorrection, holdAngle, emptyPose } from '../core/capture.js';
import { createVideoRecorder, VIDEO_SIZES } from '../core/recorder.js';

const PHOTO_SIZE = { width: 4032, height: 3024 };   // landscape numbers (WebKit bug 323550)
const MAX_PENDING_PHOTOS = 6;                        // photos held in memory while saving, at most
const PIN_CHECK_KEY = 'jw.camera.pinCheck';
const LENS_KEY = 'jw.camera.lens';
const DEVICE_PENDING_KEY = 'camera.devicePending';  // store kv: the phone's own camera is open
const ZOOM_STOPS = [0.5, 1, 2];
const MAIN_CAMERA_FOV = { long: 69, short: 54 };     // degrees across a phone's main camera (approximate)
const STALL_MS = 4000;                               // no new frame for this long: the camera stopped
const PIN_FIX_MAX_AGE_MS = 120_000;                  // a pin check corrects the position only this soon after the photo
const PIN_FIX_MAX_WALK_M = 4;                        // … and only if the person has not walked on

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const safe = (fn, dflt = null) => { try { return fn(); } catch { return dflt; } };

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) {
  try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode: not remembered */ }
}

/**
 * How the screen is turned against the phone's sensor axes, counter-clockwise
 * (0 portrait, 90 = top edge left …). The legacy window.orientation comes
 * first: it is counted from the same frame as the motion sensors on iPhone,
 * iPad and Android, while screen.orientation.angle reads 90 for an iPad held
 * upright and may be rounded to 0/90 for privacy (docs/RESEARCH.md).
 */
function screenAngle() {
  const w = typeof window !== 'undefined' ? window.orientation : undefined;
  if (typeof w === 'number' && isFinite(w)) return ((w % 360) + 360) % 360;
  try {
    if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  } catch { /* old browser */ }
  return 0;
}

function stopTracks(stream) {
  for (const t of stream?.getTracks?.() || []) { try { t.stop(); } catch { /* already stopped */ } }
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function stamp(t) {
  const d = new Date(t || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

/** The field of view along one side, for a zoom factor (lens or crop): tan(half-angle) shrinks with zoom. */
function fovAt(baseDeg, zoom) {
  const D = Math.PI / 180;
  return 2 * Math.atan(Math.tan((baseDeg / 2) * D) / Math.max(0.3, zoom || 1)) / D;
}

/**
 * Where the horizon is on screen, from gravity in the phone's frame
 * (W3C beta/gamma: up = (−cos β·sin γ, sin β)) turned into screen axes.
 * → {roll (deg; + = the real "up" leans right on screen), pitch} or null.
 */
function horizonOf(p) {
  const r = p?.raw;
  if (!r || num(r.beta) == null || num(r.gamma) == null || num(p.pitch) == null || Math.abs(p.pitch) > 35) return null;
  const D = Math.PI / 180;
  const ux = -Math.cos(r.beta * D) * Math.sin(r.gamma * D);
  const uy = Math.sin(r.beta * D);
  const th = screenAngle() * D;
  const sx = ux * Math.cos(th) - uy * Math.sin(th);   // up · screen-right
  const sy = ux * Math.sin(th) + uy * Math.cos(th);   // up · screen-up
  if (Math.hypot(sx, sy) < 0.5) return null;
  return { roll: Math.atan2(sx, sy) / D, pitch: p.pitch };
}

function cameraErrorText(err) {
  const name = err?.name || '';
  const ios = isIOS();
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return {
      title: 'The camera is blocked',
      text: ios
        ? 'Allow the camera for this app. In Safari: tap aA in the address bar → Website Settings → Camera → Allow. On the Home Screen app: iPhone Settings → Apps → Safari → Camera → Allow. Then tap Try again.'
        : 'Allow the camera: tap the icon next to the address (or ⋮ → Settings → Site settings) → Camera → Allow. Then tap Try again.',
    };
  }
  if (name === 'SecurityError' || (typeof isSecureContext !== 'undefined' && !isSecureContext)) {
    return { title: 'The camera needs a secure page', text: 'Open DCR Job Walk at its https:// address (or install it to the Home Screen) to use the camera.' };
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    return { title: 'No camera found', text: 'This device has no camera the app can use. You can still add photos with "Use phone camera".' };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return { title: 'The camera is busy', text: 'Another app is using the camera — a call, FaceTime, another camera app or another browser tab. Close it, then tap Try again.' };
  }
  if (name === 'NotSupportedError') {
    return { title: 'No camera here', text: 'This browser cannot show the camera. Use Safari on iPhone or Chrome on Android — or tap "Use phone camera".' };
  }
  return { title: 'The camera did not start', text: `${err?.message || 'Something stopped the camera.'} Tap Try again.` };
}

/** The decoded plan, shared with the other screens in app.cache under 'plan:<mediaId>' (the drawable itself). */
function drawableOf(x) {
  if (!x || typeof x !== 'object') return null;
  const img = x.image && typeof x.image === 'object' ? x.image : x;
  const w = img.naturalWidth || img.width || 0;
  return w > 0 && (typeof img.close === 'function' || 'naturalWidth' in img || typeof img.getContext === 'function') ? img : null;
}

/**
 * Open the camera screen. Returns the cleanup the router runs when the
 * person leaves (docs/SPEC.md §3).
 */
export async function open(ctx) {
  const { app } = ctx;
  const { store, positioning, bus } = app;
  const S = () => app.getSettings();
  const pid = ctx.params.pid;
  let project = await store.getProject(pid);
  if (!project) {
    const e = new Error('That job walk is not on this phone.');
    e.notFound = true;
    throw e;
  }
  let level = store.activeLevel(project);
  let mode = ctx.query.mode === 'video' ? 'video' : 'photo';
  const units = () => S().units || 'imperial';
  const urls = store.createUrlScope();

  let closed = false;
  const offs = [];
  const listen = (target, type, fn, opts) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, fn, opts);
    offs.push(() => target.removeEventListener(type, fn, opts));
  };
  const timeouts = new Set();
  const later = (fn, ms) => {
    const t = setTimeout(() => { timeouts.delete(t); if (!closed) fn(); }, ms);
    timeouts.add(t);
    return t;
  };

  // ---- the page ---------------------------------------------------------------------------------

  const video = el('video', { class: 'cam-video', playsinline: true, muted: true, autoplay: true, 'aria-label': 'Camera view' });
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.setAttribute('webkit-playsinline', '');

  const horizonEl = el('div', { class: 'cam-horizon', hidden: true, 'aria-hidden': 'true' });
  const flash = el('div', { class: 'cam-flash', 'aria-hidden': 'true' });
  const zoomLabel = el('div', { class: 'cam-zoomlabel', hidden: true, 'aria-live': 'polite' });
  const viewArea = el('div', { class: 'cam-view' }, video, horizonEl, flash, zoomLabel);

  const backBtn = iconButton('back', { title: 'Back to the plan', cls: 'icon-btn cam-btn', onclick: () => ctx.back(`p/${pid}`) });
  const titleMain = el('div', { class: 't' }, level?.name || 'Level');
  const titleSub = el('div', { class: 's' }, project.name || '');
  const demoBadge = el('span', { class: 'cam-demo', hidden: true, title: 'Demo mode: the position and compass are simulated' }, 'DEMO');
  const gearBtn = iconButton('settings', { title: 'Camera settings', cls: 'icon-btn cam-btn', onclick: () => openSettings() });
  const top = el('header', { class: 'cam-top' }, backBtn, el('div', { class: 'cam-title' }, titleMain, titleSub), demoBadge, gearBtn);

  const chipTxt = el('span', { class: 'cam-chip-txt' }, 'Finding position…');
  const chip = el('button', { type: 'button', class: 'pos-chip cam-chip', 'aria-label': 'Position accuracy — tap for details', onclick: () => showPositionInfo() },
    el('span', { class: 'dot' }), chipTxt);
  const headingEl = el('span', { class: 'cam-pill cam-heading', title: 'Camera direction' }, '—');
  const tiltEl = el('span', { class: 'cam-pill cam-tilt', title: 'Camera tilt', hidden: true });
  const compassBtn = el('button', { type: 'button', class: 'cam-pill cam-compass-btn', hidden: true, onclick: () => onCompassTap(), html: `${icon('compass', { size: 16 })}<span>Turn on compass</span>` });
  const hud = el('div', { class: 'cam-hud' }, chip, headingEl, tiltEl, compassBtn);

  const recTime = el('span', { class: 'cam-rec-time' }, '0:00');
  const recBadge = el('div', { class: 'cam-rec', hidden: true, role: 'status' }, el('span', { class: 'cam-rec-dot' }), el('span', {}, 'REC'), recTime);

  const insetHost = el('div', { class: 'cam-inset-view' });
  const insetNote = el('span', { class: 'cam-inset-note' }, 'Check pin');
  const insetBtn = el('button', { type: 'button', class: 'cam-inset-tap', 'aria-label': 'Check the spot of the last photo on the plan', onclick: () => openPinCheck() });
  const inset = el('div', { class: 'cam-inset' }, insetHost, insetNote, insetBtn);

  const torchBtn = iconButton('flash', { title: 'Light', cls: 'icon-btn cam-tool', onclick: () => toggleTorch() });
  torchBtn.hidden = true;
  const side = el('div', { class: 'cam-side' }, torchBtn);
  const zoomBar = el('div', { class: 'cam-zoom', hidden: true, role: 'group', 'aria-label': 'Zoom' });

  const photoSeg = el('button', { type: 'button', onclick: () => setMode('photo') }, 'Photo');
  const videoSeg = el('button', { type: 'button', onclick: () => setMode('video') }, 'Video');
  const modes = el('div', { class: 'seg cam-modes', role: 'group', 'aria-label': 'Photo or video' }, photoSeg, videoSeg);
  const shutterBtn = el('button', { type: 'button', class: 'cam-shutter', 'aria-label': 'Take photo' }, el('span', { class: 'cam-shutter-core' }));
  const thumbImg = el('span', { class: 'cam-thumb-img' });
  const thumbStatus = el('span', { class: 'cam-thumb-status' });
  const thumbCount = el('span', { class: 'cam-thumb-count', hidden: true });
  const thumbBtn = el('button', { type: 'button', class: 'cam-thumb', 'aria-label': 'Last photo', dataset: { state: 'empty' }, onclick: () => onThumbTap() }, thumbImg, thumbStatus, thumbCount);
  const thumbCap = el('div', { class: 'cam-thumb-cap', 'aria-live': 'polite' });
  const phoneBtn = el('button', { type: 'button', class: 'cam-phone', onclick: () => onPhoneCamera(), html: `${icon('phone', { size: 22 })}<span>Use phone camera</span>` });
  const controls = el('div', { class: 'cam-controls' },
    el('div', { class: 'cam-thumb-wrap' }, thumbBtn, thumbCap), shutterBtn, el('div', { class: 'cam-end' }, phoneBtn));
  const bottom = el('footer', { class: 'cam-bottom' }, modes, controls);

  const msg = el('div', { class: 'cam-msg', hidden: true });
  const camEl = el('div', { class: 'cam', dataset: { mode, cam: 'starting' } }, viewArea, top, hud, recBadge, inset, side, zoomBar, bottom, msg);
  ctx.root.classList.add('cam-screen');
  ctx.root.append(camEl);

  function showPanel({ ic = 'camera', title = '', text = '', buttons = [], spinner = false } = {}) {
    msg.replaceChildren(el('div', { class: 'cam-msg-box' },
      spinner ? el('div', { class: 'spinner' }) : el('span', { class: 'cam-msg-ic', html: icon(ic, { size: 30 }) }),
      title ? el('h2', {}, title) : null,
      text ? el('p', {}, text) : null,
      buttons.length ? el('div', { class: 'cam-msg-btns' }, buttons.map((b) => el('button', { type: 'button', class: b.primary ? 'btn btn-primary' : 'btn', onclick: b.onclick }, b.label))) : null));
    msg.hidden = false;
  }
  function hidePanel() { msg.hidden = true; msg.replaceChildren(); }

  // ---- state ---------------------------------------------------------------------------------------

  const cam = {
    stream: null, track: null, caps: {}, ic: null, photoCaps: null,
    takePhotoOk: true, takePhotoFails: 0, grabFrameOk: true, firstPhoto: true,
    torch: false, zoom: null, deviceId: '', label: '',
    photoInFlight: false, lastFrameAt: 0, rvfc: 0, opening: null, gen: 0,
  };
  let camState = 'starting';     // starting | live | paused | gate (no tap yet) | tap (preview needs a tap) | error | device
  let trackOffs = [];
  let watchTimer = null;
  let pollTimer = null;
  let muteTimer = null;
  let restarts = [];
  let mic = null;
  let micPromise = null;
  let micBlocked = false;
  let recorder = null;            // the video being recorded (null once it has stopped)
  let startingVideo = false;
  let recTimer = null;
  let deviceCamOpen = false;
  let pinOpen = false;
  let pinView = null;
  const jobs = [];                // every capture of this visit: {id, kind, state, …}
  let saveQueue = Promise.resolve();
  let savedCount = 0;
  let lastItem = null;            // newest photo/video of the job walk (for the tile on arrival)
  let levelItems = [];
  let lastPose = safe(() => positioning.getPose());
  let status = safe(() => positioning.getStatus(), {});
  let insetView = null;
  let insetKind = '';
  let insetKey = '';
  let audioCtx = null;
  let noiseBuf = null;

  const pinCheckOn = () => lsGet(PIN_CHECK_KEY) === '1';
  function loadLens() {
    try { const v = JSON.parse(lsGet(LENS_KEY) || 'null'); return v && (v.deviceId || v.label) ? v : null; } catch { return null; }
  }
  const saveLens = (v) => lsSet(LENS_KEY, v ? JSON.stringify({ deviceId: v.deviceId || '', label: v.label || '' }) : null);

  function setCamState(s) {
    camState = s;
    camEl.dataset.cam = s;
    if (s === 'live') hidePanel();
    else if (s === 'starting') showPanel({ spinner: true, text: 'Starting the camera…' });
    else if (s === 'paused') showPanel({ ic: 'camera', title: 'Camera paused', text: 'The camera turns off while the app is in the background.', buttons: [{ label: 'Turn the camera on', primary: true, onclick: () => openCamera() }] });
    renderShutter();
  }

  function camReady() {
    return camState === 'live' && cam.track && cam.track.readyState === 'live' && video.videoWidth > 0;
  }

  // ---- the camera stream -------------------------------------------------------------------------

  function sizeForMode(m = mode) {
    return m === 'video' ? (VIDEO_SIZES[S().videoQuality] || VIDEO_SIZES.high) : PHOTO_SIZE;
  }

  function constraints(deviceId) {
    const size = sizeForMode();
    const v = { width: { ideal: size.width }, height: { ideal: size.height }, frameRate: { ideal: 30 } };
    if (deviceId) v.deviceId = { exact: deviceId };
    else v.facingMode = { ideal: 'environment' };
    return { audio: false, video: v };
  }

  function stopWatchdog() {
    clearInterval(watchTimer); watchTimer = null;
    clearInterval(pollTimer); pollTimer = null;
    clearTimeout(muteTimer); muteTimer = null;
    if (cam.rvfc && video.cancelVideoFrameCallback) { try { video.cancelVideoFrameCallback(cam.rvfc); } catch { /* gone */ } }
    cam.rvfc = 0;
  }

  /** Let go of the camera (another app, the phone's own camera, or the page being hidden can then have it). */
  function stopStream() {
    cam.gen++;
    stopWatchdog();
    for (const off of trackOffs) off();
    trackOffs = [];
    if (cam.stream) stopTracks(cam.stream);
    cam.stream = null;
    cam.track = null;
    cam.ic = null;
    cam.photoCaps = null;
    cam.torch = false;
    try { video.pause(); } catch { /* fine */ }
    video.srcObject = null;
    renderControls();
  }

  function firstFrame(ms) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(t); resolve(); } };
      const t = setTimeout(finish, ms);
      if (video.requestVideoFrameCallback) {
        try { video.requestVideoFrameCallback(() => finish()); return; } catch { /* fall through */ }
      }
      const check = () => {
        if (done) return;
        if (video.readyState >= 2 && video.videoWidth) finish();
        else requestAnimationFrame(check);
      };
      check();
    });
  }

  async function listCameras() {
    try {
      const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      // Front cameras are of no use on a job walk. Labels are localized, so
      // this only removes the ones that clearly say so.
      return all.filter((d) => !/front|user|facetime|selfie/i.test(d.label || ''));
    } catch { return []; }
  }

  /** Turn the camera on (or again). Shows what went wrong, in plain words, if it cannot. */
  function openCamera() {
    if (closed) return Promise.resolve();
    if (cam.opening) return cam.opening;
    const p = (async () => {
      stopStream();
      const gen = cam.gen;
      if (document.visibilityState === 'hidden') { setCamState('paused'); return; }
      setCamState('starting');
      if (!navigator.mediaDevices?.getUserMedia) {
        showCamError({ name: typeof isSecureContext !== 'undefined' && !isSecureContext ? 'SecurityError' : 'NotSupportedError' });
        return;
      }
      const lens = loadLens();
      let stream = null;
      let err = null;
      try { stream = await navigator.mediaDevices.getUserMedia(constraints(lens?.deviceId || null)); } catch (e) { err = e; }
      if (!stream && lens?.deviceId && ['OverconstrainedError', 'NotFoundError', 'NotReadableError'].includes(err?.name)) {
        // The locked lens is not there today (or its id changed): use the default back camera.
        try { stream = await navigator.mediaDevices.getUserMedia(constraints(null)); err = null; } catch (e) { err = e; }
      }
      if (!stream) { if (gen === cam.gen && !closed) showCamError(err); return; }
      if (gen !== cam.gen || closed || document.visibilityState === 'hidden') {
        stopTracks(stream);
        if (!closed && document.visibilityState === 'hidden') setCamState('paused');
        return;
      }
      // A lens locked by name: device ids can change, names do not.
      const tr = stream.getVideoTracks()[0];
      if (lens?.label && tr && tr.label !== lens.label) {
        const d = (await listCameras()).find((x) => x.label === lens.label);
        if (d && gen === cam.gen && !closed) {
          stopTracks(stream);
          stream = null;
          try {
            stream = await navigator.mediaDevices.getUserMedia(constraints(d.deviceId));
            saveLens({ deviceId: d.deviceId, label: d.label });
          } catch {
            try { stream = await navigator.mediaDevices.getUserMedia(constraints(null)); } catch (e) { if (gen === cam.gen) showCamError(e); return; }
          }
          if (gen !== cam.gen || closed) { stopTracks(stream); return; }
        }
      }
      await attach(stream, gen);
    })();
    cam.opening = p;
    p.catch((err) => { if (!closed) showCamError(err); }).finally(() => { if (cam.opening === p) cam.opening = null; });
    return p;
  }

  async function attach(stream, gen) {
    video.srcObject = stream;
    let playBlocked = false;
    try { await video.play(); } catch (err) { playBlocked = err?.name === 'NotAllowedError'; }
    if (!playBlocked) await firstFrame(5000);
    if (gen !== cam.gen || closed) { stopTracks(stream); return; }
    const track = stream.getVideoTracks()[0];
    if (!track || track.readyState !== 'live') { stopTracks(stream); showCamError(new Error('The camera turned off as it started.')); return; }
    cam.stream = stream;
    cam.track = track;
    cam.deviceId = safe(() => track.getSettings().deviceId, '') || '';
    cam.label = track.label || '';
    // Capabilities are only reported once the camera is really streaming.
    cam.caps = safe(() => track.getCapabilities?.() || {}, {}) || {};
    cam.ic = null;
    if (typeof ImageCapture === 'function') { try { cam.ic = new ImageCapture(track); } catch { cam.ic = null; } }
    cam.takePhotoOk = !!cam.ic;
    cam.takePhotoFails = 0;
    cam.grabFrameOk = true;
    cam.firstPhoto = true;
    cam.photoCaps = null;
    cam.torch = false;
    const z = safe(() => track.getSettings().zoom);
    cam.zoom = num(z) ?? (cam.caps.zoom ? Math.max(1, cam.caps.zoom.min) : null);

    const onEnded = () => {
      if (closed || cam.track !== track) return;
      console.warn('[camera] the camera track ended');
      // A recording finishes by itself (recorder.js). Start the camera again.
      later(() => { if (document.visibilityState === 'visible' && !deviceCamOpen) restartCamera('ended'); }, 400);
    };
    const onMute = () => {
      if (cam.photoInFlight) return; // takePhoto may mute the track on purpose (WebKit)
      clearTimeout(muteTimer);
      muteTimer = setTimeout(() => {
        if (closed || cam.track !== track || !track.muted || cam.photoInFlight) return;
        if (document.visibilityState === 'visible' && !deviceCamOpen) restartCamera('muted');
      }, 2500);
    };
    const onUnmute = () => { clearTimeout(muteTimer); muteTimer = null; };
    track.addEventListener('ended', onEnded);
    track.addEventListener('mute', onMute);
    track.addEventListener('unmute', onUnmute);
    trackOffs.push(() => {
      track.removeEventListener('ended', onEnded);
      track.removeEventListener('mute', onMute);
      track.removeEventListener('unmute', onUnmute);
    });
    if (playBlocked || video.paused) {
      // iOS Low Power Mode can refuse to play even a muted preview until a tap.
      setCamState('tap');
      showPanel({
        ic: 'camera', title: 'Tap to show the camera', text: 'The phone is waiting for a tap before it shows the camera picture.',
        buttons: [{ label: 'Show the camera', primary: true, onclick: () => {
          if (cam.track !== track || track.readyState !== 'live') { openCamera(); return; }
          video.play().then(async () => {
            await firstFrame(5000);
            if (closed || cam.track !== track) return;
            startWatchdog();
            setCamState('live');
            scheduleHud();
          }, (err) => showCamError(err));
        } }],
      });
      renderControls();
      if (mode === 'video') ensureMic();
      return;
    }
    startWatchdog();
    setCamState('live');
    renderControls();
    scheduleHud();
    if (mode === 'video') ensureMic();
  }

  /** Chrome on Android can stop sending frames without saying so (Camera2 disconnects): notice and restart. */
  function startWatchdog() {
    stopWatchdog();
    cam.lastFrameAt = performance.now();
    if (video.requestVideoFrameCallback) {
      const onFrame = () => {
        cam.lastFrameAt = performance.now();
        if (cam.track && !closed) cam.rvfc = video.requestVideoFrameCallback(onFrame);
      };
      cam.rvfc = video.requestVideoFrameCallback(onFrame);
    } else {
      let lastT = -1;
      pollTimer = setInterval(() => {
        if (video.currentTime !== lastT) { lastT = video.currentTime; cam.lastFrameAt = performance.now(); }
      }, 500);
    }
    watchTimer = setInterval(() => {
      // While the pin check covers the picture the browser may stop drawing it: not a stall.
      if (closed || !cam.track || document.visibilityState !== 'visible' || cam.photoInFlight || deviceCamOpen || pinOpen) {
        cam.lastFrameAt = performance.now();
        return;
      }
      if (performance.now() - cam.lastFrameAt > STALL_MS) {
        console.warn('[camera] no new picture for a few seconds — restarting the camera');
        if (recorder) stopVideo('camera-stalled');
        restartCamera('stalled');
      }
    }, 1000);
  }

  function restartCamera(why) {
    const now = Date.now();
    restarts = restarts.filter((t) => now - t < 30000);
    restarts.push(now);
    if (restarts.length > 3) {
      stopStream();
      setCamState('error');
      showPanel({
        ic: 'warning',
        title: 'The camera keeps stopping',
        text: 'The camera stopped sending pictures several times. Close other apps that use the camera, then tap Try again.',
        buttons: [{ label: 'Try again', primary: true, onclick: () => { restarts = []; openCamera(); } }, { label: 'Use phone camera', onclick: () => onPhoneCamera() }],
      });
      return;
    }
    console.info('[camera] restarting:', why);
    openCamera();
  }

  function showCamError(err) {
    console.warn('[camera] could not start', err);
    stopStream();
    setCamState('error');
    const t = cameraErrorText(err);
    showPanel({
      ic: 'warning', title: t.title, text: t.text,
      buttons: [
        { label: 'Try again', primary: true, onclick: () => { restarts = []; openCamera(); } },
        { label: 'Use phone camera', onclick: () => onPhoneCamera() },
        { label: 'Back', onclick: () => ctx.back(`p/${pid}`) },
      ],
    });
  }

  // ---- torch and zoom ----------------------------------------------------------------------------

  function advancedState() {
    const a = [];
    if (cam.caps.zoom && num(cam.zoom) != null) a.push({ zoom: cam.zoom });
    if (cam.caps.torch && cam.torch) a.push({ torch: true });
    return a;
  }

  async function toggleTorch() {
    if (!cam.track || !cam.caps.torch) return;
    const want = !cam.torch;
    try {
      await cam.track.applyConstraints({ advanced: [{ torch: want }] });
      cam.torch = want; // our own state: getSettings().torch was stale before iOS 18.4
    } catch (err) {
      toast(`The light could not be turned ${want ? 'on' : 'off'} (${err.message || err.name}).`, { type: 'warn' });
    }
    renderControls();
  }

  let zoomBusy = false;
  let zoomWanted = null;
  let zoomLabelTimer = 0;
  async function setZoom(z, { showLabel = false } = {}) {
    const c = cam.caps.zoom;
    if (!c || !cam.track) return;
    const step = c.step || 0.01;
    zoomWanted = Math.round(clamp(z, c.min, c.max) / step) * step;
    if (showLabel) {
      zoomLabel.hidden = false;
      zoomLabel.textContent = `${zoomWanted.toFixed(1)}×`;
      clearTimeout(zoomLabelTimer);
      zoomLabelTimer = setTimeout(() => { zoomLabel.hidden = true; }, 900);
    }
    if (zoomBusy) return;
    zoomBusy = true;
    try {
      // The latest value wins: pinching sends many, the camera takes them one at a time.
      while (zoomWanted != null && cam.track) {
        const v = zoomWanted;
        zoomWanted = null;
        await cam.track.applyConstraints({ advanced: [{ zoom: v }] });
        cam.zoom = v;
      }
    } catch (err) {
      console.warn('[camera] zoom', err);
    } finally {
      zoomBusy = false;
      renderControls();
    }
  }

  function renderControls() {
    torchBtn.hidden = !(cam.track && cam.caps.torch);
    torchBtn.classList.toggle('on', !!cam.torch);
    torchBtn.innerHTML = icon(cam.torch ? 'flash' : 'flashOff', { size: 22 });
    torchBtn.setAttribute('aria-pressed', cam.torch ? 'true' : 'false');
    const c = cam.caps.zoom;
    const stops = c && cam.track ? ZOOM_STOPS.filter((z) => z >= c.min - 0.01 && z <= c.max + 0.01) : [];
    zoomBar.hidden = stops.length < 2;
    if (!zoomBar.hidden) {
      const cur = num(cam.zoom) ?? 1;
      const nearest = stops.reduce((a, b) => (Math.abs(b - cur) < Math.abs(a - cur) ? b : a), stops[0]);
      zoomBar.replaceChildren(...stops.map((z) => el('button', {
        type: 'button',
        class: `cam-zoom-chip${z === nearest ? ' on' : ''}`,
        'aria-pressed': z === nearest ? 'true' : 'false',
        onclick: () => setZoom(z),
      }, z === nearest && Math.abs(cur - z) > 0.05 ? `${cur.toFixed(1)}×` : `${z}×`)));
    }
  }

  // Two fingers on the picture zoom.
  const pointers = new Map();
  let pinch = null;
  listen(viewArea, 'pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && cam.caps.zoom) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: num(cam.zoom) ?? 1 };
    }
  });
  listen(viewArea, 'pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      setZoom(pinch.z * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d), { showLabel: true });
    }
  });
  const pointerGone = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; };
  listen(viewArea, 'pointerup', pointerGone);
  listen(viewArea, 'pointercancel', pointerGone);

  // ---- position, heading, tilt -------------------------------------------------------------------

  let hudRaf = 0;
  function scheduleHud() {
    if (!hudRaf && !closed) hudRaf = requestAnimationFrame(() => { hudRaf = 0; renderHud(); });
  }

  function renderHud() {
    if (closed) return;
    const p = lastPose || {};
    const s = status || {};
    const q = p.quality || 'none';
    chip.classList.remove('good', 'fair', 'poor');
    if (q !== 'none') chip.classList.add(q);
    let txt;
    if (s.gps === 'denied') txt = 'Location off';
    else if (p.geo && num(p.geo.acc) != null) txt = `${formatAccuracy(p.geo.acc, units())}${p.source === 'manual' ? ' · set' : ''}`;
    else if (s.gps === 'off' || s.gps === 'unavailable') txt = 'No location';
    else txt = 'Finding position…';
    setText(chipTxt, txt);

    let h = '—';
    if (num(p.heading) != null) h = `${compassPoint(p.heading)} ${Math.round(normDeg(p.heading))}°`;
    else if (s.compass === 'needs-permission') h = 'No compass yet';
    setText(headingEl, h);

    let tl = '';
    if (num(p.pitch) != null) {
      const pt = Math.round(p.pitch);
      if (Math.abs(pt) > 65) tl = pt < 0 ? 'Pointing down' : 'Pointing up';
      else tl = `Tilt ${pt > 0 ? '+' : pt < 0 ? '−' : ''}${Math.abs(pt)}°`;
    }
    setText(tiltEl, tl);
    tiltEl.hidden = !tl;
    compassBtn.hidden = !safe(() => positioning.needsPermission(), false);
    demoBadge.hidden = !S().simulate;
    renderHorizon(p);
  }

  function renderHorizon(p) {
    const hz = horizonOf(p);
    const vw = video.videoWidth, vh = video.videoHeight;
    const W = viewArea.clientWidth, H = viewArea.clientHeight;
    if (!hz || camState !== 'live' || !vw || !vh || !W || !H) { horizonEl.hidden = true; return; }
    // Pixels per degree on screen: the picture is scaled to cover the screen.
    const scale = Math.max(W / vw, H / vh);
    const fov = fovAt(vh >= vw ? MAIN_CAMERA_FOV.long : MAIN_CAMERA_FOV.short, num(cam.zoom) ?? 1);
    const off = clamp(hz.pitch * ((vh * scale) / fov), -H, H);
    horizonEl.hidden = false;
    horizonEl.style.transform = `translate(-50%, -50%) rotate(${hz.roll.toFixed(1)}deg) translateY(${off.toFixed(0)}px)`;
    horizonEl.classList.toggle('level', Math.abs(hz.roll) < 1.5);
  }

  function showPositionInfo() {
    const s = safe(() => positioning.getStatus(), {}) || {};
    toast(s.message || 'Looking for your position…', { type: s.level === 'error' ? 'err' : s.level === 'warn' ? 'warn' : 'info', ms: 6000 });
  }

  function onCompassTap() {
    // Must run inside the tap (iPhone).
    let p;
    try { p = positioning.requestPermission(); } catch { p = Promise.resolve(false); }
    Promise.resolve(p).then((ok) => {
      if (closed) return;
      if (ok) toast('Compass on — photos save which way they face.', { type: 'ok' });
      else toast('The compass was not allowed. Photos still save where they were taken, without the direction.', { type: 'warn', ms: 6000 });
      scheduleHud();
    });
  }

  offs.push(positioning.on('pose', (p) => {
    lastPose = p;
    scheduleHud();
    try { insetView?.setPose(p); } catch { /* the inset is a courtesy */ }
  }));
  offs.push(positioning.on('status', (s) => { status = s; scheduleHud(); }));
  offs.push(bus.on('settings:change', () => scheduleHud()));
  listen(window, 'resize', () => scheduleHud());
  if (screen.orientation?.addEventListener) listen(screen.orientation, 'change', () => scheduleHud());
  listen(video, 'resize', () => scheduleHud());

  // ---- the plan / map inset ----------------------------------------------------------------------

  const planCacheKey = () => (level?.plan?.mediaId ? `plan:${level.plan.mediaId}` : '');
  let planLoad = null;

  /** The decoded plan: {image, width, height}, decoded once and shared through app.cache. */
  async function loadPlanImage() {
    const plan = level?.plan;
    if (!plan?.mediaId) return null;
    const key = planCacheKey();
    const hit = drawableOf(app.cache.get(key)) || drawableOf(app.cache.get(plan.mediaId));
    const sized = (img) => ({ image: img, width: plan.width || media.sourceSize(img).width, height: plan.height || media.sourceSize(img).height });
    if (hit) return sized(hit);
    if (!planLoad) {
      planLoad = (async () => {
        const blob = await store.getMediaBlob(plan.mediaId);
        if (!blob) throw new Error('The plan image is missing on this phone. Add it again from Levels & plans (your photos are not affected).');
        const img = await media.decodeImage(blob);
        app.cache.set(key, img);
        return img;
      })().finally(() => { planLoad = null; });
    }
    return sized(await planLoad);
  }

  function liveVideoItem() {
    const r = recorder;
    if (!r || !r.track?.length) return null;
    return { id: 'live-video', type: 'video', seq: null, track: r.track, pose: r.startPose, media: {}, tags: [] };
  }

  function insetItems() {
    const list = levelItems.slice();
    const live = liveVideoItem();
    if (live) list.push(live);
    return list;
  }

  function refreshInsetItems() {
    if (!insetView) return;
    try { insetView.setItems(insetItems(), { selectedId: recorder ? 'live-video' : null }); } catch (err) { console.warn('[camera] inset items', err); }
  }
  let insetTrackTimer = 0;
  function scheduleInsetTrack() {
    if (insetTrackTimer) return;
    insetTrackTimer = setTimeout(() => { insetTrackTimer = 0; if (!closed) refreshInsetItems(); }, 800);
  }

  function renderInsetNote() {
    const calibrated = !!level?.calibration;
    if (level?.plan && !calibrated) setText(insetNote, 'Not calibrated');
    else setText(insetNote, pinCheckOn() ? 'Pin check on' : 'Check pin');
  }

  async function setupInset() {
    const key = `${level?.id}|${level?.plan?.mediaId || 'map'}|${level?.calibration?.createdAt || ''}|${level?.calibration?.pxPerMeter || ''}`;
    if (insetView && key === insetKey) return;
    insetKey = key;
    try { insetView?.destroy(); } catch { /* gone */ }
    insetView = null;
    insetHost.replaceChildren();
    renderInsetNote();
    try {
      if (level?.plan) {
        const img = await loadPlanImage();
        if (closed || insetKey !== key || !img) return;
        const { createPlanView } = await import('./plan-view.js');
        if (closed || insetKey !== key) return;
        insetView = createPlanView(insetHost, {
          image: img.image, width: img.width, height: img.height, interactive: false, units: units(),
          pxPerMeter: level.calibration?.pxPerMeter || null, metersAcross: 20, scaleBar: false,
        });
        insetKind = 'plan';
      } else {
        const { createMapView } = await import('./map-view.js');
        if (closed || insetKey !== key) return;
        const p = lastPose;
        const center = p?.geo ? { lat: p.geo.lat, lng: p.geo.lng } : (project.origin || project.mapView || null);
        insetView = createMapView(insetHost, { center: center ? { lat: center.lat, lng: center.lng } : undefined, zoom: 19, interactive: false });
        insetKind = 'map';
      }
      refreshInsetItems();
      if (lastPose) insetView.setPose(lastPose);
    } catch (err) {
      console.warn('[camera] the plan inset could not be shown', err);
      insetHost.replaceChildren(el('div', { class: 'cam-inset-fail' }, level?.plan ? 'Plan not shown' : 'Map not shown'));
    }
  }

  async function loadItems() {
    try {
      const all = await store.listItems(pid);
      if (closed) return;
      levelItems = all.filter((i) => i.levelId === level?.id);
      lastItem = null;
      for (let i = all.length - 1; i >= 0; i--) {
        if (all[i].type === 'photo' || all[i].type === 'video') { lastItem = all[i]; break; }
      }
      refreshInsetItems();
      renderTile();
    } catch (err) {
      console.warn('[camera] could not list the photos', err);
    }
  }
  const reloadItems = debounce(loadItems, 600);

  async function reloadProject() {
    try {
      const p = await store.getProject(pid);
      if (!p || closed) return;
      project = p;
      level = store.getLevel(p, level?.id) || store.activeLevel(p);
      setText(titleMain, level?.name || 'Level');
      setText(titleSub, project.name || '');
      setupInset();
    } catch (err) { console.warn('[camera] project', err); }
  }
  const reloadProjectSoon = debounce(reloadProject, 400);
  offs.push(bus.on('store:change', (ev) => {
    if (ev?.projectId !== pid) return;
    if (ev.kind === 'item') reloadItems();
    else if (ev.kind === 'project') reloadProjectSoon();
  }));

  // ---- feedback ------------------------------------------------------------------------------------

  function sound(kind) {
    if (!S().shutterSound) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      const t = audioCtx.currentTime + 0.005;
      if (kind === 'shutter') {
        // Two short bursts of filtered noise: a mechanical shutter's click-clack.
        if (!noiseBuf) {
          const n = Math.floor(audioCtx.sampleRate * 0.045);
          noiseBuf = audioCtx.createBuffer(1, n, audioCtx.sampleRate);
          const d = noiseBuf.getChannelData(0);
          for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 3;
        }
        for (const [at, gain] of [[0, 0.7], [0.075, 0.45]]) {
          const src = audioCtx.createBufferSource();
          src.buffer = noiseBuf;
          const f = audioCtx.createBiquadFilter();
          f.type = 'bandpass';
          f.frequency.value = 3000;
          f.Q.value = 0.8;
          const g = audioCtx.createGain();
          g.gain.value = gain;
          src.connect(f); f.connect(g); g.connect(audioCtx.destination);
          src.start(t + at);
        }
      } else {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.frequency.value = kind === 'start' ? 880 : 620;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.22, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(t);
        o.stop(t + 0.16);
      }
    } catch { /* sound is only a courtesy */ }
  }

  function feedback(kind = 'shutter') {
    sound(kind);
    if (S().vibrate) buzz(kind === 'shutter' ? 25 : 45);
    if (kind === 'shutter') {
      flash.classList.remove('on');
      void flash.offsetWidth; // restart the animation
      flash.classList.add('on');
    }
  }

  // ---- taking a photo ------------------------------------------------------------------------------

  async function looksBlack(blob) {
    let bmp = null;
    try {
      bmp = await createImageBitmap(blob, { resizeWidth: 16, resizeHeight: 12, resizeQuality: 'low' });
      if (media.meanLuminance(bmp) >= 4) return false;
      // A dark room is dark in the preview too: only call it black when the preview is not.
      return media.meanLuminance(video) > 12;
    } catch {
      return false;
    } finally {
      media.releaseImage(bmp);
    }
  }

  /**
   * The size to ask takePhoto for. Chrome reports real photo sizes (ask for
   * the largest). WebKit reports the VIDEO ranges; asking past the current
   * stream switches the camera format for the shot (mute, torch flicker), so
   * ask for the current stream size, in landscape numbers.
   */
  function photoSettings(pc, track) {
    const wr = pc?.imageWidth, hr = pc?.imageHeight;
    if (!num(wr?.max) || !num(hr?.max)) return null;
    let w = wr.max, h = hr.max;
    const tc = cam.caps || {};
    if (tc.width?.max === wr.max && tc.height?.max === hr.max) {
      const s = safe(() => track.getSettings(), {}) || {};
      const a = Math.max(s.width || 0, s.height || 0, video.videoWidth, video.videoHeight);
      const b = Math.max(Math.min(s.width || 0, s.height || 0), Math.min(video.videoWidth, video.videoHeight));
      if (a && b) { w = a; h = b; }
    }
    return {
      imageWidth: Math.round(clamp(w, num(wr.min) || 1, wr.max)),
      imageHeight: Math.round(clamp(h, num(hr.min) || 1, hr.max)),
    };
  }

  async function takeFullPhoto() {
    const track = cam.track;
    const ic = cam.ic;
    if (!track || !ic || track.readyState !== 'live' || !track.enabled) throw new Error('The camera is not live.');
    cam.photoInFlight = true;
    try {
      if (!cam.photoCaps) cam.photoCaps = await media.withTimeout(ic.getPhotoCapabilities(), 3000).catch(() => null);
      const opts = photoSettings(cam.photoCaps, track);
      const frameArea = video.videoWidth * video.videoHeight;
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const blob = await media.withTimeout(opts ? ic.takePhoto(opts) : ic.takePhoto(), 8000, 'The camera took too long.');
          if (!blob?.size) throw new Error('The camera gave an empty photo.');
          const info = (await media.readImageHeader(blob)) || (await media.imageSize(blob).catch(() => null));
          if (!info?.width) throw new Error('The camera gave a photo that cannot be read.');
          if (frameArea && info.width * info.height < frameArea * 0.9) throw new Error(`The photo (${info.width}×${info.height}) is smaller than the preview.`);
          if (cam.firstPhoto) {
            cam.firstPhoto = false;
            if (await looksBlack(blob)) throw new Error('The first photo came out black.');
          }
          cam.takePhotoFails = 0;
          return { blob, width: info.width, height: info.height, orientation: info.orientation || 1, method: 'takePhoto' };
        } catch (err) {
          lastErr = err;
          if (track.readyState !== 'live') break;
        }
      }
      cam.takePhotoFails++;
      if (cam.takePhotoFails >= 2) {
        cam.takePhotoOk = false;
        console.warn('[camera] full-resolution photos keep failing on this phone; using the video picture from now on', lastErr);
      }
      throw lastErr || new Error('The photo could not be taken.');
    } finally {
      cam.photoInFlight = false;
      cam.lastFrameAt = performance.now(); // the preview may pause while a photo is taken
    }
  }

  async function grabFrame() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) throw new Error('The camera has not shown a picture yet.');
    let src = video;
    let method = 'canvas';
    let bmp = null;
    if (cam.ic?.grabFrame && cam.grabFrameOk) {
      try {
        bmp = await media.withTimeout(cam.ic.grabFrame(), 2000);
        // Use it only when it is the picture on screen (some browsers hand back the sensor's unturned frame).
        if (bmp && bmp.width === vw && bmp.height === vh) { src = bmp; method = 'grabFrame'; } else { media.releaseImage(bmp); bmp = null; cam.grabFrameOk = false; }
      } catch { bmp = null; cam.grabFrameOk = false; }
    }
    const { width, height } = media.scaleToFit(vw, vh, Infinity, media.IOS_SAFE_CANVAS_AREA);
    const c = media.makeCanvas(width, height);
    try {
      c.getContext('2d').drawImage(src, 0, 0, width, height);
      media.releaseImage(bmp);
      bmp = null;
      const out = await media.encodeCanvas(c, 'image/jpeg', num(S().photoQuality) ?? 0.92);
      return { blob: out.blob, width: out.width, height: out.height, orientation: 1, method };
    } finally {
      media.freeCanvas(c);
      media.releaseImage(bmp);
    }
  }

  /**
   * A photo held sideways while the screen did not turn comes out sideways.
   * Turn it with its EXIF orientation (no re-encoding). Video frames always
   * follow the screen; a takePhoto result is only turned when it came out
   * lined up with the screen (otherwise the camera already did it).
   */
  async function turnUpright(shot, upright, sa) {
    const extra = upright?.extraCW || 0;
    if (!extra) return { ...shot, rotated: 0 };
    // Only when the picture on screen agrees with the screen angle (an
    // upright screen shows a tall picture): otherwise the angle is not to be
    // trusted here, and an unturned photo is better than a wrongly turned one.
    const screenPortrait = (((sa ?? 0) % 180) + 180) % 180 === 0;
    if (screenPortrait !== (video.videoHeight > video.videoWidth)) return { ...shot, rotated: 0 };
    if (shot.method === 'takePhoto') {
      const photoPortrait = shot.height > shot.width;
      const viewPortrait = video.videoHeight > video.videoWidth;
      if ((extra !== 90 && extra !== 270) || photoPortrait !== viewPortrait) return { ...shot, rotated: 0 };
    }
    const target = media.composeOrientation(shot.orientation || 1, extra);
    if (!target) return { ...shot, rotated: 0 };
    const turned = await media.setJpegOrientation(shot.blob, target).catch(() => null);
    if (!turned) return { ...shot, rotated: 0 };
    const swap = extra === 90 || extra === 270;
    return { ...shot, blob: turned, width: swap ? shot.height : shot.width, height: swap ? shot.width : shot.height, orientation: target, rotated: extra };
  }

  function makePreview(rotate = 0) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const { width, height } = media.scaleToFit(vw, vh, 180);
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    try { c.getContext('2d').drawImage(video, 0, 0, width, height); } catch { return null; }
    return { canvas: c, rotate };
  }

  const pendingCount = () => jobs.filter((j) => j.state === 'capturing' || j.state === 'saving').length;
  const pendingPhotos = () => jobs.filter((j) => j.kind === 'photo' && (j.state === 'capturing' || j.state === 'saving')).length;
  const failedJobs = () => jobs.filter((j) => j.state === 'failed');

  /** The camera's facts at the tap (which lens, zoom, preview size) — saved with the photo. */
  function cameraFacts() {
    return {
      deviceId: cam.deviceId || '',
      lens: cam.label || '',
      lensLocked: !!loadLens(),
      zoom: num(cam.zoom),
      videoWidth: video.videoWidth || null,
      videoHeight: video.videoHeight || null,
    };
  }

  function captureInfo(job) {
    return {
      ...(job.camInfo || cameraFacts()),
      method: job.method || 'canvas',
      screenAngle: job.screenAngle ?? null,
      deviceAngle: job.upright?.deviceAngle ?? null,
      holdAngle: job.hold ? Math.round(job.hold.angle * 10) / 10 : null,
      holdStrength: job.hold ? Math.round(job.hold.strength * 100) / 100 : null,
      rotated: job.rotated || 0,
    };
  }

  function photoFields(job) {
    return {
      project, level, blob: job.blob, width: job.width, height: job.height,
      pose: job.pose, source: job.source || 'camera', zoom: job.pose?.zoom ?? null, takenAt: job.tapAt,
      poseAtOpen: job.poseAtOpen || null,
      captureInfo: job.source === 'device-camera' ? { method: 'device-camera', openedAt: job.openedAt || null } : captureInfo(job),
      onWarning: (m) => { if (!closed) toast(m, { type: 'warn' }); },
    };
  }

  async function runPhotoSave(job) {
    try {
      const item = job.retry ? await job.retry() : await savePhoto(photoFields(job));
      onPhotoSaved(job, item);
    } catch (err) {
      onJobFailed(job, err);
    }
  }

  /** Saves run one after another: a phone holding several full-size photos at once runs out of memory. */
  function enqueuePhotoSave(job) {
    saveQueue = saveQueue.then(() => runPhotoSave(job));
    return saveQueue;
  }

  function onPhotoSaved(job, item) {
    job.state = 'saved';
    job.item = item;
    job.blob = null;          // saved and read back: the memory can go
    job.retry = null;
    job.error = null;
    savedCount++;
    flagSaved(job);
    if (job.pendingPin) applyPin(job, job.pendingPin);
    if (!closed) {
      lastItem = item;
      reloadItems();
    }
  }

  function onJobFailed(job, err) {
    job.state = 'failed';
    job.error = err;
    job.retry = typeof err?.retry === 'function' ? err.retry : null;
    if (err?.blob) job.blob = err.blob;
    console.error('[camera] save failed', err);
    const what = job.kind === 'video' ? 'video' : 'photo';
    const base = err?.message || `The ${what} was not saved.`;
    if (closed) {
      // The screen is gone; the toast is the only way left to keep it.
      toast(`${base} Download it now so it is not lost.`, { type: 'err', action: job.blob ? { label: 'Download', onclick: () => downloadJob(job) } : undefined });
      return;
    }
    toast(`${base} Tap the red thumbnail to try again or to download it.`, { type: 'err', action: job.blob ? { label: 'Download', onclick: () => downloadJob(job) } : undefined });
    renderTile();
    renderShutter();
  }

  function flagSaved(job) {
    job.justSaved = true;
    pruneJobs();
    renderTile();
    later(() => { job.justSaved = false; renderTile(); }, 1600);
  }

  /**
   * A long walk is hundreds of photos: keep memory flat. Saved ones are on
   * the phone, so their little preview canvases are let go (the tile shows
   * the stored thumbnail) and only the newest few are remembered here.
   * Failed and unsaved ones are never touched.
   */
  function pruneJobs() {
    const done = (j) => j.state === 'saved' || j.state === 'lost' || j.state === 'gone';
    const latest = latestJob();
    for (const j of jobs) {
      if (j !== latest && done(j) && j.preview) { media.freeCanvas(j.preview.canvas); j.preview = null; }
    }
    let kept = 0;
    for (let i = jobs.length - 1; i >= 0; i--) {
      if (done(jobs[i]) && ++kept > 20) jobs.splice(i, 1);
    }
  }

  /** Get the picture for a shot. Resolves true when it is in memory and ready to save. */
  async function capturePhoto(job) {
    let shot;
    try {
      const fast = cam.photoInFlight || !cam.ic || !cam.takePhotoOk;
      if (!fast) {
        try { shot = await takeFullPhoto(); } catch (err) { console.warn('[camera] full-resolution photo failed; using the video picture', err); }
      }
      if (!shot) shot = await grabFrame();
    } catch (err) {
      job.state = 'lost';
      job.error = err;
      if (!closed) {
        toast(`The photo was not taken: ${err.message} Take it again.`, { type: 'err' });
        renderTile();
        renderShutter();
      }
      return false;
    }
    try {
      shot = await turnUpright(shot, job.upright, job.screenAngle);
    } catch { /* keep it as it came */ }
    job.blob = shot.blob;
    job.width = shot.width;
    job.height = shot.height;
    job.method = shot.method;
    job.rotated = shot.rotated || 0;
    job.state = 'saving';
    renderTile();
    return true;
  }

  function shutterPhoto(rawPose, tapAt) {
    if (!camReady()) {
      toast(camState === 'error' ? 'The camera is off — see the message on screen.' : 'The camera is not ready yet — one moment.', { type: 'warn', ms: 2500 });
      return;
    }
    if (pendingPhotos() >= MAX_PENDING_PHOTOS) {
      toast('Still saving the last photos — one moment, then take the next.', { type: 'warn', ms: 2500 });
      buzz([30, 40, 30]);
      return;
    }
    const pose = snapshotPose(rawPose, level);
    pose.zoom = num(cam.zoom);
    const sa = screenAngle();
    const upright = uprightCorrection({ beta: rawPose?.raw?.beta, gamma: rawPose?.raw?.gamma, screenAngle: sa });
    feedback('shutter');
    const job = {
      id: uid('j_'), kind: 'photo', state: 'capturing', source: 'camera',
      pose, tapAt, upright, screenAngle: sa, camInfo: cameraFacts(),
      hold: holdAngle({ beta: rawPose?.raw?.beta, gamma: rawPose?.raw?.gamma }),
      preview: makePreview(upright?.extraCW || 0),
    };
    jobs.push(job);
    renderTile();
    renderShutter();
    if (pinCheckOn() && canPinCheck()) openPinCheck(job);
    // The save's place in the queue is taken now, so photos are saved (and
    // numbered) in the order they were taken, even when a quick second shot
    // is ready before a slower full-resolution first one.
    const captured = capturePhoto(job);
    saveQueue = saveQueue.then(async () => { if (await captured) await runPhotoSave(job); });
  }

  // ---- the shutter -------------------------------------------------------------------------------

  // The pose is read FIRST in the press handler, before anything else runs.
  let ignoreClick = false;
  let ignoreTimer = 0;
  function onShutterPress() {
    const rawPose = safe(() => positioning.getPose());
    const tapAt = Date.now();
    if (mode === 'video') {
      if (recorder) stopVideo('user'); else startVideo();
      return;
    }
    shutterPhoto(rawPose, tapAt);
  }
  listen(shutterBtn, 'pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    ignoreClick = true;
    clearTimeout(ignoreTimer);
    ignoreTimer = setTimeout(() => { ignoreClick = false; }, 1500);
    onShutterPress();
  });
  listen(shutterBtn, 'pointercancel', () => { ignoreClick = false; });
  // Keyboards and screen readers send a click without a pointer press.
  listen(shutterBtn, 'click', (e) => {
    if (ignoreClick) { ignoreClick = false; return; }
    void e;
    onShutterPress();
  });

  function renderShutter() {
    const recording = !!recorder;
    shutterBtn.classList.toggle('video', mode === 'video');
    shutterBtn.classList.toggle('rec', recording);
    shutterBtn.classList.toggle('busy', mode === 'photo' && pendingPhotos() >= MAX_PENDING_PHOTOS);
    shutterBtn.disabled = startingVideo;
    shutterBtn.setAttribute('aria-label', mode === 'video' ? (recording ? 'Stop recording and save' : 'Start recording') : 'Take photo');
    photoSeg.classList.toggle('on', mode === 'photo');
    videoSeg.classList.toggle('on', mode === 'video');
    photoSeg.setAttribute('aria-pressed', mode === 'photo' ? 'true' : 'false');
    videoSeg.setAttribute('aria-pressed', mode === 'video' ? 'true' : 'false');
    modes.classList.toggle('locked', recording);
    camEl.dataset.mode = mode;
    camEl.classList.toggle('recording', recording);
  }

  async function setMode(m) {
    if (m === mode) return;
    if (recorder || startingVideo) { toast('Stop the video first.', { type: 'warn', ms: 2000 }); return; }
    mode = m;
    renderShutter();
    // Remember it in the address, so a reload or relaunch opens the same mode.
    try {
      const h = `#/p/${encodeURIComponent(pid)}/camera?mode=${mode}`;
      if (location.hash !== h) history.replaceState(history.state, '', h);
    } catch { /* fine */ }
    if (mode === 'video') ensureMic(); else releaseMic();
    const track = cam.track;
    if (track && track.readyState === 'live') {
      const size = sizeForMode();
      try {
        await track.applyConstraints({ width: { ideal: size.width }, height: { ideal: size.height }, frameRate: { ideal: 30 }, advanced: advancedState() });
        cam.photoCaps = null;
        cam.caps = safe(() => track.getCapabilities?.() || {}, {}) || cam.caps;
        renderControls();
        scheduleHud();
      } catch (err) {
        console.warn('[camera] could not change the camera size; starting it again', err);
        openCamera();
      }
    }
  }

  // ---- video ---------------------------------------------------------------------------------------

  function ensureMic() {
    if (mic || micBlocked || closed) return Promise.resolve(mic);
    if (micPromise) return micPromise;
    if (!navigator.mediaDevices?.getUserMedia) return Promise.resolve(null);
    micPromise = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
      .then((s) => {
        if (closed || mode !== 'video' || document.visibilityState === 'hidden') { stopTracks(s); return null; }
        mic = s;
        return s;
      }, (err) => {
        micBlocked = true;
        if (!closed) {
          toast(err?.name === 'NotAllowedError'
            ? 'Videos will have no sound: the microphone is blocked for this site.'
            : 'Videos will have no sound: the microphone did not start.', { type: 'warn', ms: 6000 });
        }
        return null;
      })
      .finally(() => { micPromise = null; });
    return micPromise;
  }

  function releaseMic() {
    if (mic && !recorder) { stopTracks(mic); mic = null; }
  }

  async function startVideo() {
    if (recorder || startingVideo) return;
    if (!camReady()) { toast('The camera is not ready yet — one moment.', { type: 'warn', ms: 2500 }); return; }
    startingVideo = true;
    renderShutter();
    let r = null;
    try {
      const m = await ensureMic();
      if (closed) return;
      if (!camReady()) throw new Error('The camera stopped. Wait for the picture, then try again.');
      const tracks = [cam.track, ...((m?.getAudioTracks?.() || []).filter((t) => t.readyState === 'live'))];
      r = createVideoRecorder({
        stream: new MediaStream(tracks), project, level,
        getPose: () => positioning.getPose(),
        quality: S().videoQuality || 'high',
        size: { width: video.videoWidth, height: video.videoHeight },
      });
      wireRecorder(r);
      recorder = r;
      await r.start();
      if (closed) { r.stop().catch(() => {}); return; }
      feedback('start');
      recBadge.hidden = false;
      recTime.textContent = '0:00';
      clearInterval(recTimer);
      recTimer = setInterval(() => { if (recorder) setText(recTime, formatDuration(recorder.elapsedMs() / 1000)); }, 250);
    } catch (err) {
      if (recorder === r) recorder = null;
      toast(err?.message || 'The video could not start.', { type: 'err' });
    } finally {
      startingVideo = false;
      renderShutter();
      refreshInsetItems();
    }
  }

  function stopVideo(reason = 'user') {
    const r = recorder;
    if (!r) return;
    r.stop({ reason }).catch(() => { /* reported through the recorder's events */ });
  }

  function wireRecorder(r) {
    const job = { id: uid('j_'), kind: 'video', state: 'recording', recorder: r, tapAt: Date.now(), pose: null, preview: null };
    let reason = 'user';
    r.on('sample', () => scheduleInsetTrack());
    r.on('interrupted', (e) => { reason = e?.reason || 'interrupted'; });
    r.on('state', (s) => {
      if (s === 'stopping' && job.state === 'recording') {
        // Finished — by the person, or by itself (app hidden, camera gone, storage full).
        job.state = 'saving';
        job.pose = r.startPose;
        job.preview = makePreview(0);
        jobs.push(job);
        if (recorder === r) recorder = null;
        clearInterval(recTimer);
        recTimer = null;
        recBadge.hidden = true;
        if (!closed) {
          feedback('stop');
          if (reason !== 'user' && reason !== 'leave' && document.visibilityState === 'visible') {
            toast(reason === 'storage' ? 'The video was stopped: the phone is not saving it (storage full?).' : 'The video was stopped (the camera was interrupted). What was filmed is being saved.', { type: 'warn', ms: 6000 });
          }
          renderShutter();
          renderTile();
          refreshInsetItems();
          if (mode !== 'video') releaseMic();
        }
      } else if (s === 'empty') {
        job.state = 'gone';
        if (!closed) renderTile();
      }
    });
    r.on('saved', (item) => onVideoSaved(job, item));
    r.on('error', (e) => {
      if (!e?.fatal) { if (!closed) toast(e?.message || 'The video had a problem.', { type: 'warn', ms: 7000 }); return; }
      if (e.error?.code === 'empty') { if (!closed) toast(e.message, { type: 'warn' }); return; }
      onJobFailed(job, Object.assign(e.error || new Error(e.message), { retry: e.retry || e.error?.retry, blob: e.blob || e.error?.blob }));
    });
    return job;
  }

  function onVideoSaved(job, item) {
    if (job.state === 'saved') return;
    job.state = 'saved';
    job.item = item;
    job.blob = null;
    job.retry = null;
    job.error = null;
    savedCount++;
    flagSaved(job);
    if (!closed) {
      lastItem = item;
      toast(`Video saved (${formatDuration(item.duration || 0)}).`, { type: 'ok' });
      reloadItems();
    }
  }

  // ---- the last capture --------------------------------------------------------------------------

  function latestJob() {
    for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].state !== 'lost' && jobs[i].state !== 'gone') return jobs[i];
    return null;
  }

  function previewNode(job, size) {
    const p = job?.preview;
    if (!p?.canvas) return el('span', { class: 'cam-prev-empty', html: icon(job?.kind === 'video' ? 'video' : 'image', { size: 20 }) });
    const c = document.createElement('canvas');
    const s = media.scaleToFit(p.canvas.width, p.canvas.height, size * 2);
    c.width = s.width;
    c.height = s.height;
    try { c.getContext('2d').drawImage(p.canvas, 0, 0, s.width, s.height); } catch { /* blank */ }
    c.className = 'cam-prev';
    if (p.rotate) c.style.transform = `rotate(${p.rotate}deg)`;
    return c;
  }

  let thumbShownKey = '';
  async function showThumbImage(job) {
    const thumbId = job?.item?.media?.thumb || (!job ? lastItem?.media?.thumb : null);
    const key = thumbId ? `t:${thumbId}` : job ? `p:${job.id}` : '';
    if (key === thumbShownKey) return;
    thumbShownKey = key;
    if (thumbId) {
      const u = await urls.url(thumbId).catch(() => null);
      if (closed || thumbShownKey !== key) return;
      thumbImg.replaceChildren(u ? el('img', { src: u, alt: '' }) : previewNode(job, 56));
    } else if (job) {
      thumbImg.replaceChildren(previewNode(job, 56));
    } else {
      thumbImg.replaceChildren();
    }
  }

  function renderTile() {
    if (closed) return;
    const failed = failedJobs();
    const saving = jobs.filter((j) => j.state === 'capturing' || j.state === 'saving');
    const show = failed[failed.length - 1] || latestJob();
    let state = 'empty';
    let cap = '';
    if (failed.length) {
      state = 'failed';
      cap = failed.length > 1 ? `${failed.length} not saved — tap to retry / download` : 'Not saved — tap to retry / download';
    } else if (saving.length) {
      state = 'saving';
      cap = saving.some((j) => j.kind === 'video') ? 'Saving video…' : saving.length > 1 ? `Saving ${saving.length}…` : 'Saving…';
    } else if (show) {
      state = 'saved';
      cap = show.justSaved ? 'Saved ✓' : '';
    } else if (lastItem) {
      state = 'saved';
    }
    thumbBtn.dataset.state = state;
    thumbCap.dataset.state = state;
    setText(thumbCap, cap);
    const statusKey = `${state}|${show?.justSaved ? 1 : 0}`;
    if (thumbStatus.dataset.key !== statusKey) {
      thumbStatus.dataset.key = statusKey;
      thumbStatus.replaceChildren(
        state === 'saving' ? el('span', { class: 'spinner' })
          : state === 'failed' ? el('span', { class: 'cam-badge-err', html: icon('warning', { size: 18 }) })
            : show?.justSaved ? el('span', { class: 'cam-badge-ok', html: icon('check', { size: 18 }) }) : '');
    }
    thumbCount.hidden = !savedCount;
    setText(thumbCount, String(savedCount));
    thumbBtn.setAttribute('aria-label', state === 'failed' ? 'Not saved — tap to try again or download' : state === 'saving' ? 'Saving the last capture' : 'Open the last photo');
    showThumbImage(show);
  }

  function onThumbTap() {
    if (failedJobs().length) { openFailedSheet(); return; }
    const j = latestJob();
    if (j && (j.state === 'capturing' || j.state === 'saving')) { toast('Still saving — one moment.', { ms: 1500 }); return; }
    const item = j?.item || lastItem;
    if (item) ctx.navigate(`p/${pid}/i/${item.id}`);
  }

  function retryJob(job) {
    if (job.state !== 'failed') return Promise.resolve();
    job.state = 'saving';
    renderTile();
    if (job.kind === 'photo') return enqueuePhotoSave(job);
    const run = async () => {
      try {
        if (!job.retry) throw job.error || new Error('This video cannot be saved again here. Download it instead.');
        onVideoSaved(job, await job.retry());
      } catch (err) {
        onJobFailed(job, Object.assign(err, { retry: err.retry || job.retry, blob: err.blob || job.blob }));
      }
    };
    return run();
  }

  async function downloadJob(job) {
    if (!job.blob) { toast('There is nothing to download for this one — take it again.', { type: 'warn' }); return; }
    const ext = job.kind === 'video' ? media.extForMime(job.blob.type, 'mp4') : 'jpg';
    const name = `${safeFileName(project.name || 'Job walk')} ${stamp(job.tapAt)}.${ext}`;
    try {
      const r = await saveBlob(job.blob, name, { title: name });
      if (r !== 'cancelled') {
        job.downloaded = true;
        toast(r === 'shared' ? 'A copy was saved.' : 'Downloaded — look in Downloads (Files on iPhone).', { type: 'ok' });
      }
    } catch (err) {
      toast(`The download did not start: ${err?.message || err}`, { type: 'err' });
    }
  }

  function openFailedSheet() {
    const failed = failedJobs();
    if (!failed.length) return;
    const sh = openSheet({ title: failed.length > 1 ? `${failed.length} not saved yet` : 'Not saved yet' });
    sh.body.append(el('p', { class: 'muted' }, 'These are only on this screen, not on the phone yet. Try again, or download them so you keep a copy.'));
    for (const j of failed) {
      sh.body.append(el('div', { class: 'cam-failed-row' },
        el('span', { class: 'cam-failed-prev' }, previewNode(j, 56)),
        el('div', { class: 'grow' },
          el('div', { class: 't' }, `${j.kind === 'video' ? 'Video' : 'Photo'} · ${formatTime(j.tapAt)}`, j.downloaded ? ' · downloaded' : ''),
          el('div', { class: 's' }, j.error?.message || 'Not saved.')),
        el('div', { class: 'cam-failed-btns' },
          el('button', { type: 'button', class: 'btn btn-sm btn-primary', onclick: () => { sh.close(true); retryJob(j); } }, 'Try again'),
          el('button', { type: 'button', class: 'btn btn-sm', disabled: !j.blob, onclick: () => downloadJob(j) }, 'Download'))));
    }
    if (failed.length > 1) {
      sh.body.append(el('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: () => { sh.close(true); failed.forEach((j) => retryJob(j)); } }, 'Try all again'));
    }
  }

  // ---- pin check -----------------------------------------------------------------------------------

  const canPinCheck = () => !!level?.plan || !!lastPose?.geo || !!project.origin;

  function lastPhotoJob() {
    for (let i = jobs.length - 1; i >= 0; i--) {
      const j = jobs[i];
      if (j.kind === 'photo' && j.state !== 'lost' && j.state !== 'gone') return j;
    }
    return null;
  }

  /**
   * Whether "I'm here" should be told too: only right after the photo, and
   * only if the person has not walked on (else the spot is where the photo
   * was taken, not where they stand now).
   */
  function shouldFixPosition(job) {
    if (!job) return true;
    if (Date.now() - (job.tapAt || 0) > PIN_FIX_MAX_AGE_MS) return false;
    const a = job.pose?.enu, b = lastPose?.enu;
    if (a && b) return Math.hypot(a.e - b.e, a.n - b.n) < PIN_FIX_MAX_WALK_M;
    return Date.now() - (job.tapAt || 0) < 30_000;
  }

  /** Full-screen plan (or map) with the cross: put the last photo's pin exactly where it was taken. */
  async function openPinCheck(job = null) {
    if (pinOpen || closed) return;
    const target = job || lastPhotoJob();
    if (!level?.plan && !lastPose?.geo && !project.origin) {
      toast('There is no plan or map position yet to check the pin on.', { type: 'warn' });
      return;
    }
    pinOpen = true;
    const viewHost = el('div', { class: 'cam-pin-view' });
    const host = el('div', { class: 'cam-pin', role: 'dialog', 'aria-label': 'Check the pin' }, viewHost);
    camEl.append(host);
    let view = null;
    try {
      let where = null;
      const n = target?.item?.seq ? ` #${target.item.seq}` : '';
      const title = target ? `Where was this photo${n} taken?` : 'Where are you standing?';
      const hint = 'Move the plan until the cross is exactly where you stood. Set saves it — and makes the next photos more accurate.';
      if (level?.plan) {
        const img = await loadPlanImage();
        if (!img || closed) return;
        const { createPlanView } = await import('./plan-view.js');
        if (closed) return;
        view = createPlanView(viewHost, { image: img.image, width: img.width, height: img.height, interactive: true, units: units(), pxPerMeter: level.calibration?.pxPerMeter || null });
        pinView = view;
        view.setItems(levelItems);
        if (lastPose) view.setPose(lastPose);
        const initial = target?.pose?.plan || target?.item?.pose?.plan || lastPose?.plan || { x: img.width / 2, y: img.height / 2 };
        const pt = await view.pickPoint({ title, hint, initial, setLabel: 'Set spot' });
        if (pt) where = { plan: { x: pt.x, y: pt.y } };
      } else {
        const { createMapView } = await import('./map-view.js');
        if (closed) return;
        const c = target?.pose?.geo || lastPose?.geo || project.origin;
        view = createMapView(viewHost, { center: c ? { lat: c.lat, lng: c.lng } : undefined, zoom: 20, interactive: true });
        pinView = view;
        view.setItems(levelItems);
        if (lastPose) view.setPose(lastPose);
        await view.ready;
        if (closed) return;
        const pt = await view.pickPoint({ title, hint, initial: c ? { lat: c.lat, lng: c.lng } : null, setLabel: 'Set spot' });
        if (pt) where = { geo: { lat: pt.lat, lng: pt.lng } };
      }
      if (!where || closed) return;
      let fixed = false;
      let fixNote = '';
      if (shouldFixPosition(target)) {
        try { positioning.fixHere(where); fixed = true; } catch (err) { fixNote = err?.message || ''; }
      } else {
        fixNote = 'Your current position was not changed — you have walked on since this photo.';
      }
      if (target) {
        target.pendingPin = where;
        if (target.item) await applyPin(target, where);
        if (!closed) toast(fixed ? 'Pin set — the next photos use this spot too.' : `Pin set. ${fixNote}`.trim(), { type: fixed ? 'ok' : 'info', ms: fixNote ? 6000 : 2600 });
      } else if (fixed) {
        toast('Position set.', { type: 'ok' });
      } else if (fixNote) {
        toast(fixNote, { type: 'warn', ms: 6000 });
      }
    } catch (err) {
      console.error('[camera] pin check', err);
      if (!closed) toast(`The plan could not be opened: ${err?.message || err}`, { type: 'err' });
    } finally {
      try { view?.destroy(); } catch { /* gone */ }
      if (pinView === view) pinView = null;
      host.remove();
      pinOpen = false;
    }
  }

  /** Save the hand-placed spot on the photo. What was measured is kept next to it (planAuto / geoAuto). */
  async function applyPin(job, where) {
    const id = job?.item?.id;
    if (!id) { if (job) job.pendingPin = where; return; }
    let enu = null;
    if (where.geo && project.origin) {
      try { const geo = await import('../core/geo.js'); enu = geo.toEnu(project.origin, where.geo.lat, where.geo.lng); } catch { enu = null; }
    }
    const ppm = num(level?.calibration?.pxPerMeter);
    try {
      const item = await store.updateItem(id, (it) => {
        const p = it.pose || emptyPose(it.createdAt);
        if (where.plan) {
          if (!('planAuto' in p)) p.planAuto = p.plan || null;
          p.plan = { x: where.plan.x, y: where.plan.y };
          p.planAcc = ppm ? 0.3 * ppm : 2;
        }
        if (where.geo) {
          if (!('geoAuto' in p)) p.geoAuto = p.geo || null;
          p.geo = { lat: where.geo.lat, lng: where.geo.lng, acc: 0.3, alt: p.geo?.alt ?? null, altAcc: p.geo?.altAcc ?? null };
          if (enu) {
            if (!('enuAuto' in p)) p.enuAuto = p.enu || null;
            p.enu = { e: enu.e, n: enu.n };
          }
        }
        p.planLocked = true;
        p.pinnedAt = Date.now();
        it.pose = p;
        return it;
      });
      job.item = item;
      job.pendingPin = null;
      job.pinned = true;
    } catch (err) {
      job.pendingPin = where;
      if (!closed) toast(`The pin could not be saved: ${err?.message || err}`, { type: 'err', action: { label: 'Try again', onclick: () => applyPin(job, where) } });
    }
  }

  // ---- the phone's own camera ----------------------------------------------------------------------

  function onPhoneCamera() {
    if (recorder) { toast('Stop the video first.', { type: 'warn', ms: 2000 }); return; }
    const sh = openSheet({ title: 'Use the phone\'s camera' });
    sh.body.append(
      el('p', {}, 'Your phone\'s own camera app takes the photo. DCR Job Walk saves where you stand and which way you face from this phone — when you tap Open camera, and again when the photo comes back.'),
      el('p', { class: 'muted small' }, isIOS()
        ? 'On iPhone the camera adds no location to the photo, so stay on the spot until the photo comes back here.'
        : 'Stay on the spot until the photo comes back here.'),
      // The tap on this button opens the camera directly (browsers only allow it from a tap).
      el('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: () => { sh.close(true); openDeviceCamera(); } }, el('span', { html: icon('camera', { size: 20 }) }), 'Open camera'),
      el('button', { type: 'button', class: 'btn btn-ghost btn-block', onclick: () => sh.close() }, 'Cancel'));
  }

  function openDeviceCamera() {
    // Inside the tap: read where the phone is, then open the picker at once.
    const poseAtOpen = snapshotPose(safe(() => positioning.getPose()), level);
    const tapAt = Date.now();
    // Android may close the browser while its camera app is in front; note
    // where we were, so the photo can still be placed when the app comes back.
    store.setKV(DEVICE_PENDING_KEY, { projectId: pid, levelId: level?.id || null, poseAtOpen, at: tapAt }).catch(() => {});
    deviceCamOpen = true;
    stopStream(); // the camera app needs the camera
    setCamState('device');
    showPanel({ ic: 'phone', title: 'Using the phone\'s camera', text: 'Take the photo in the camera app. It comes back here when you are done.', buttons: [{ label: 'Back to this camera', onclick: () => endDeviceCamera() }] });
    let settled = false;
    const picked = pickFiles({ accept: 'image/*', capture: 'environment' });
    // Some browsers never say the picker was cancelled: when the page comes back, carry on.
    const onBack = () => {
      if (document.visibilityState !== 'visible') return;
      later(() => { if (!settled) endDeviceCamera(); }, 1500);
    };
    document.addEventListener('visibilitychange', onBack);
    offs.push(() => document.removeEventListener('visibilitychange', onBack));
    picked.then(async (files) => {
      settled = true;
      document.removeEventListener('visibilitychange', onBack);
      const file = files?.[0];
      if (file) {
        const returnPose = snapshotPose(safe(() => positioning.getPose()), level);
        await saveDeviceFile(file, { poseAtOpen, returnPose, tapAt });
      } else {
        store.setKV(DEVICE_PENDING_KEY, null).catch(() => {});
      }
      endDeviceCamera();
    });
  }

  function endDeviceCamera() {
    if (!deviceCamOpen) return;
    deviceCamOpen = false;
    if (!closed) openCamera();
  }

  /** A photo from the phone's camera: its bytes are copied into memory first (iOS deletes picked files). */
  async function saveDeviceFile(file, { poseAtOpen, returnPose, tapAt }) {
    let blob;
    try {
      blob = new Blob([await file.arrayBuffer()], { type: file.type || 'image/jpeg' });
    } catch (err) {
      toast(`The photo could not be read from the camera app: ${err?.message || err}. Take it again.`, { type: 'err' });
      return;
    }
    if (!blob.size) { toast('The camera app sent an empty photo. Take it again.', { type: 'err' }); return; }
    const job = {
      id: uid('j_'), kind: 'photo', state: 'saving', source: 'device-camera',
      pose: returnPose, poseAtOpen, tapAt: Date.now(), openedAt: tapAt, blob, method: 'device-camera',
    };
    try {
      const s = await media.imageSize(blob);
      job.width = s.width;
      job.height = s.height;
      const t = await media.makeThumb(blob, 180, 0.7).catch(() => null);
      if (t) {
        const img = await media.decodeImage(t).catch(() => null);
        if (img) {
          const c = document.createElement('canvas');
          c.width = media.sourceSize(img).width;
          c.height = media.sourceSize(img).height;
          c.getContext('2d').drawImage(img, 0, 0);
          media.releaseImage(img);
          job.preview = { canvas: c, rotate: 0 };
        }
      }
    } catch { /* sizes are filled in by savePhoto */ }
    jobs.push(job);
    renderTile();
    feedback('shutter');
    if (pinCheckOn() && canPinCheck()) openPinCheck(job);
    await enqueuePhotoSave(job);
    if (job.state === 'saved') store.setKV(DEVICE_PENDING_KEY, null).catch(() => {});
  }

  async function checkDevicePending() {
    let rec = null;
    try { rec = await store.getKV(DEVICE_PENDING_KEY, null); } catch { rec = null; }
    if (!rec || rec.projectId !== pid || closed) return;
    try { await store.setKV(DEVICE_PENDING_KEY, null); } catch { /* shown once anyway */ }
    if (Date.now() - (rec.at || 0) > 6 * 3600 * 1000) return;
    toast('The phone\'s camera closed the app before your photo came back. If the photo is in your phone\'s Photos, add it here — it is placed where you were standing.', {
      type: 'warn', ms: 0,
      action: {
        label: 'Add photo',
        onclick: () => {
          pickFiles({ accept: 'image/*' }).then((files) => {
            if (files?.[0] && !closed) saveDeviceFile(files[0], { poseAtOpen: rec.poseAtOpen, returnPose: rec.poseAtOpen, tapAt: rec.at });
          });
        },
      },
    });
  }

  // ---- settings popover ------------------------------------------------------------------------------

  function switchRow(label, detail, checked, onChange) {
    const input = el('input', { type: 'checkbox', role: 'switch' });
    input.checked = !!checked;
    input.addEventListener('change', () => onChange(input.checked));
    return el('label', { class: 'switch cam-switch' },
      el('span', { class: 'grow' }, el('span', { class: 'cam-switch-label' }, label), detail ? el('span', { class: 'cam-switch-detail' }, detail) : null),
      input);
  }

  async function openSettings() {
    const sh = openSheet({ title: 'Camera', cls: 'cam-sheet' });
    const lensList = el('div', { class: 'choose-list' }, el('p', { class: 'small muted' }, 'Looking for cameras…'));
    sh.body.append(
      el('div', { class: 'section-title' }, 'Lens'),
      lensList,
      el('div', { class: 'section-title' }, 'While shooting'),
      switchRow('Check pin after each photo', 'Opens the plan after every photo so you can put its pin exactly where you stood.', pinCheckOn(), (on) => { lsSet(PIN_CHECK_KEY, on ? '1' : null); renderInsetNote(); }),
      switchRow('Shutter sound', '', !!S().shutterSound, (on) => { app.updateSettings({ shutterSound: on }).catch((e) => toast(e.message, { type: 'err' })); }),
      switchRow('Vibrate', '', !!S().vibrate, (on) => { app.updateSettings({ vibrate: on }).catch((e) => toast(e.message, { type: 'err' })); }),
      el('p', { class: 'small muted cam-diag' }, diagText()));

    const cams = await listCameras();
    const lock = loadLens();
    const virtual = !!(cam.caps.zoom && cam.caps.zoom.min < 1);
    const firstBack = cams.find((d) => /facing back/i.test(d.label || ''));
    const opt = (label, detail, selected, onPick, recommended = false) => el('button', {
      type: 'button', class: `choose-opt${selected ? ' cam-opt-on' : ''}`, 'aria-pressed': selected ? 'true' : 'false', onclick: onPick,
    },
    el('span', { class: 'choose-ic', html: icon(selected ? 'check' : 'camera', { size: 20 }) }),
    el('span', { class: 'choose-txt' },
      el('span', { class: 'choose-label' }, label, recommended ? el('span', { class: 'badge ok cam-rec-badge' }, 'Recommended') : null),
      detail ? el('span', { class: 'choose-detail' }, detail) : null));
    lensList.replaceChildren(opt('Automatic', virtual ? 'The phone picks — on iPhone it may switch lenses by itself near walls' : 'The phone picks the back camera', !lock, () => pickLens(null, sh)));
    let named = 0;
    for (const d of cams) {
      if (!d.label) continue;
      named++;
      const recommended = /^back camera$/i.test(d.label) || d === firstBack;
      const selected = !!lock && (lock.deviceId === d.deviceId || lock.label === d.label);
      lensList.append(opt(d.label, d.deviceId && d.deviceId === cam.deviceId ? 'In use now' : '', selected, () => pickLens(d, sh), recommended));
    }
    if (!named) lensList.append(el('p', { class: 'small muted' }, 'Lens names show once the camera is allowed.'));
    if (virtual) lensList.append(el('p', { class: 'small muted' }, 'iPhone tip: lock it to "Back Camera" so the picture does not jump between lenses. That keeps the camera direction on the plan right.'));
  }

  function pickLens(d, sh) {
    if (recorder || startingVideo) { toast('Stop the video first.', { type: 'warn', ms: 2000 }); return; }
    saveLens(d ? { deviceId: d.deviceId, label: d.label } : null);
    sh.close(true);
    restarts = [];
    openCamera();
  }

  function diagText() {
    const parts = [];
    if (video.videoWidth) parts.push(`Camera ${video.videoWidth}×${video.videoHeight}`);
    if (cam.label) parts.push(cam.label);
    parts.push(cam.ic && cam.takePhotoOk ? 'full-resolution photos' : 'photos from the video picture');
    if (num(cam.zoom) != null) parts.push(`zoom ${cam.zoom.toFixed(1)}×`);
    return parts.join(' · ');
  }

  // ---- leaving, hiding, coming back ----------------------------------------------------------------

  async function waitForSaves() {
    if (pendingCount()) {
      const n = pendingCount();
      const videoSaving = jobs.some((j) => j.kind === 'video' && j.state === 'saving');
      const b = busy(videoSaving ? 'Saving the video… keep this screen open.' : n > 1 ? `Photos are still saving… (${n})` : 'Photos are still saving…');
      try {
        const deadline = Date.now() + 20000;
        while (pendingCount() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 150));
      } finally { b.done(); }
      if (pendingCount()) {
        const leave = await confirmDialog({
          title: 'Still saving',
          message: 'Photos are still saving… They keep saving after you leave this screen; if one fails you will be asked to download it. Leave now?',
          okText: 'Leave', cancelText: 'Stay',
        });
        if (!leave) return false;
      }
    }
    const failed = failedJobs().filter((j) => !j.downloaded);
    if (failed.length) {
      const what = failed.length > 1 ? `${failed.length} photos or videos are` : `A ${failed[0].kind === 'video' ? 'video' : 'photo'} is`;
      const pick = await choose({
        title: `${what} not saved`,
        options: [
          { value: 'retry', icon: 'restore', label: 'Try saving again' },
          { value: 'download', icon: 'download', label: 'Download them', detail: 'Keeps a copy in Downloads (Files on iPhone)' },
          { value: 'stay', icon: 'close', label: 'Stay here' },
        ],
      });
      if (pick === 'retry') {
        await Promise.all(failed.map((j) => retryJob(j)));
        const still = failedJobs().filter((j) => !j.downloaded);
        if (still.length) { toast('Still not saved. Download them, or free some space and try again.', { type: 'err' }); return false; }
        return true;
      }
      if (pick === 'download') {
        for (const j of failed) await downloadJob(j);
        return failedJobs().every((j) => j.downloaded);
      }
      return false;
    }
    return true;
  }

  ctx.setGuard(async () => {
    if (recorder || startingVideo) {
      const ok = await confirmDialog({
        title: 'A video is recording',
        message: 'A video is recording — stop and save it first?',
        okText: 'Stop and save', cancelText: 'Keep recording',
      });
      if (!ok) return false;
      stopVideo('leave');
    }
    return waitForSaves();
  });

  function onHidden() {
    if (closed) return;
    // A recording finishes and saves (recorder.js does it too — this makes sure it happens before the camera stops).
    if (recorder) stopVideo('hidden');
    if (deviceCamOpen) return; // the phone's camera app is in front; ours is already off
    stopStream();
    if (!recorder) { if (mic) { stopTracks(mic); mic = null; } }
    if (camState !== 'gate' && camState !== 'error') setCamState('paused');
  }

  function onVisible() {
    if (closed || deviceCamOpen) return;
    if (camState === 'paused' && ctx.isCurrent()) openCamera();
    scheduleHud();
  }

  listen(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') onHidden(); else onVisible(); });
  listen(window, 'pagehide', () => onHidden());
  listen(window, 'pageshow', (e) => { if (e.persisted) onVisible(); });

  // ---- start ---------------------------------------------------------------------------------------

  renderShutter();
  renderControls();
  renderHud();
  renderTile();
  renderInsetNote();
  loadItems();
  setupInset();
  checkDevicePending();
  // A Home Screen app opened straight onto the camera has had no tap yet; asking
  // for the camera then would prompt out of nowhere (docs/RESEARCH.md), so wait for one.
  if (navigator.userActivation && navigator.userActivation.hasBeenActive === false) {
    setCamState('gate');
    showPanel({ ic: 'camera', title: 'Ready when you are', text: 'Tap to turn the camera on.', buttons: [{ label: 'Start camera', primary: true, onclick: () => openCamera() }] });
  } else {
    openCamera();
  }

  return async function cleanup() {
    closed = true;
    // A recording is finished and saved, not dropped.
    if (recorder) stopVideo('leave');
    for (const off of offs.splice(0)) { try { off(); } catch { /* gone */ } }
    for (const t of timeouts) clearTimeout(t);
    timeouts.clear();
    clearTimeout(insetTrackTimer);
    clearTimeout(ignoreTimer);
    clearTimeout(zoomLabelTimer);
    clearInterval(recTimer);
    if (hudRaf) cancelAnimationFrame(hudRaf);
    reloadItems.cancel?.();
    reloadProjectSoon.cancel?.();
    stopStream();
    if (mic) { stopTracks(mic); mic = null; }
    try { insetView?.destroy(); } catch { /* gone */ }
    insetView = null;
    try { pinView?.destroy(); } catch { /* gone */ }  // also cancels an open pin check
    pinView = null;
    if (audioCtx) { try { audioCtx.close(); } catch { /* closed */ } audioCtx = null; }
    urls.release();
    // Saves still running carry on; a failure then offers a download in a toast.
    for (const j of jobs) if (j.kind === 'video' && j.state === 'failed') { try { j.recorder?.dispose(); } catch { /* gone */ } }
  };
}
