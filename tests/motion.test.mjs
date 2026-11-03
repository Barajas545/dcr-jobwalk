// motion.test.mjs — the step detector (js/core/motion.js) on synthetic accelerometer signals.
//
// A missed step moves the dot short; a counted jiggle moves it when the
// estimator is standing still. Both put photos in the wrong spot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStepState, processSample, createMotionSource, stepLengthFor, G } from '../js/core/motion.js';

function rng(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gauss(r) { return Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r()); }

/**
 * |a| over time as segments: {kind: 'still'|'walk'|'jiggle'|'bump', seconds, hz, amp}.
 * Walking is a heel-strike-shaped bounce (fundamental + 2nd harmonic) with cadence and
 * amplitude wandering a little, plus sensor noise; samples at ~60 Hz with jitter.
 */
function synth(segments, { seed = 3, rate = 60, noise = 0.15, axisSplit = true } = {}) {
  const r = rng(seed);
  const out = [];
  let t = 1_000_000;
  let phase = 0;
  let cycles = 0;
  for (const seg of segments) {
    const end = t + seg.seconds * 1000;
    while (t < end) {
      const dt = (1000 / rate) * (0.9 + 0.2 * r());
      t += dt;
      let m = G + gauss(r) * noise;
      if (seg.kind === 'walk') {
        const hz = seg.hz * (1 + 0.04 * Math.sin(t / 3000));
        const before = Math.floor(phase);
        phase += hz * dt / 1000;
        cycles += Math.floor(phase) - before;
        const ph = 2 * Math.PI * phase;
        m += seg.amp * (Math.sin(ph) + 0.35 * Math.sin(2 * ph + 0.6));
      } else if (seg.kind === 'jiggle') {
        m += seg.amp * Math.sin(2 * Math.PI * seg.hz * t / 1000) + gauss(r) * 0.4;
      } else if (seg.kind === 'bump' && end - t > seg.seconds * 1000 - 250) {
        m += seg.amp * Math.sin(Math.PI * (seg.seconds * 1000 - (end - t)) / 250);
      }
      // Spread the magnitude over the axes (phone tilted), with the iOS z sign flip on odd seeds.
      const zs = seed % 2 ? -1 : 1;
      out.push(axisSplit ? { t, x: m * 0.3, y: m * 0.8, z: zs * m * Math.sqrt(1 - 0.09 - 0.64) } : { t, mag: m });
    }
    if (seg.kind === 'walk') phase = Math.ceil(phase - 1e-9); // finish on a whole step
  }
  return { samples: out, cycles };
}

function run(samples, opts) {
  const st = createStepState(opts);
  const steps = [];
  const states = [];
  for (const s of samples) {
    const r = processSample(st, s);
    steps.push(...r.steps);
    if (r.changed) states.push({ t: s.t, motion: r.motion });
  }
  return { st, steps, states };
}

test('50 steps at 1.8 Hz are counted within ±1, starting and stopping from standing', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { samples } = synth([{ kind: 'still', seconds: 3 }, { kind: 'walk', seconds: 50 / 1.8, hz: 1.8, amp: 2.6 }, { kind: 'still', seconds: 3 }], { seed });
    const { steps } = run(samples);
    assert.ok(Math.abs(steps.length - 50) <= 1, `seed ${seed}: ${steps.length} steps`);
  }
});

test('slow and brisk walks, soft and bouncy, are counted within ±1 per 50 steps', () => {
  for (const [hz, amp] of [[1.4, 1.9], [2.2, 4.5], [1.8, 6]]) {
    const { samples } = synth([{ kind: 'still', seconds: 2 }, { kind: 'walk', seconds: 50 / hz, hz, amp }, { kind: 'still', seconds: 2 }], { seed: 9 });
    const { steps } = run(samples);
    assert.ok(Math.abs(steps.length - 50) <= 1, `${hz} Hz amp ${amp}: ${steps.length}`);
  }
});

test('standing still counts nothing and is reported as stationary', () => {
  const { samples } = synth([{ kind: 'still', seconds: 30 }], { seed: 4, noise: 0.08 });
  const { steps, st } = run(samples);
  assert.equal(steps.length, 0);
  assert.equal(st.motion, 'stationary');
});

test('jiggling the phone (fast shaking) and sensor noise count no steps', () => {
  for (const [hz, amp] of [[4.5, 4], [6, 5], [8, 3]]) {
    const { samples } = synth([{ kind: 'still', seconds: 2 }, { kind: 'jiggle', seconds: 15, hz, amp }, { kind: 'still', seconds: 2 }], { seed: 6 });
    const { steps, states } = run(samples);
    assert.equal(steps.length, 0, `${hz} Hz jiggle counted ${steps.length}`);
    assert.ok(states.some((s) => s.motion === 'moving'), 'shaking is "moving", not "stationary"');
  }
  const noisy = synth([{ kind: 'still', seconds: 20 }], { seed: 8, noise: 0.45 });
  assert.equal(run(noisy.samples).steps.length, 0);
});

test('a single bump (phone set down) is not a step', () => {
  const { samples } = synth([{ kind: 'still', seconds: 3 }, { kind: 'bump', seconds: 3, amp: 6 }, { kind: 'still', seconds: 3 }], { seed: 10 });
  assert.equal(run(samples).steps.length, 0);
});

test('walking → standing: "walking" while stepping, "stationary" about 2 s after the last step', () => {
  const { samples } = synth([{ kind: 'still', seconds: 3 }, { kind: 'walk', seconds: 10, hz: 1.8, amp: 3 }, { kind: 'still', seconds: 6 }], { seed: 12 });
  const { steps, states } = run(samples);
  const walking = states.find((s) => s.motion === 'walking');
  assert.ok(walking, 'became walking');
  const lastStep = steps[steps.length - 1].t;
  const still = states.filter((s) => s.motion === 'stationary').pop();
  assert.ok(still && still.t - lastStep >= 2000 && still.t - lastStep < 3000, `stationary ${still && still.t - lastStep} ms after the last step`);
});

test('step length: settings.stepLength without Weinberg; with it the average stays stepLength', () => {
  const { samples } = synth([{ kind: 'still', seconds: 2 }, { kind: 'walk', seconds: 40, hz: 1.8, amp: 3 }], { seed: 14 });
  const plain = run(samples, { weinberg: false, stepLength: 0.65 });
  assert.ok(plain.steps.every((s) => s.length === 0.65));
  const w = run(samples, { weinberg: true, stepLength: 0.65 });
  const mean = w.steps.reduce((a, s) => a + s.length, 0) / w.steps.length;
  assert.ok(Math.abs(mean - 0.65) < 0.65 * 0.05, `mean ${mean}`);
  assert.ok(w.steps.every((s) => s.length >= 0.65 * 0.8 && s.length <= 0.65 * 1.25));
  // A bouncier stretch makes longer steps.
  const st = createStepState({ stepLength: 0.7 });
  st.refLogAmp = Math.log(4);
  assert.ok(stepLengthFor(st, 8) > 0.7 && stepLengthFor(st, 2) < 0.7);
});

test('a pause in the samples (page hidden) restarts the filters instead of inventing a step', () => {
  const a = synth([{ kind: 'walk', seconds: 5, hz: 1.8, amp: 3 }], { seed: 16 }).samples;
  const b = synth([{ kind: 'walk', seconds: 5, hz: 1.8, amp: 3 }], { seed: 17 }).samples.map((s) => ({ ...s, t: s.t + 60_000 }));
  const { steps } = run([...a, ...b]);
  assert.ok(steps.length >= 15 && steps.length <= 19, `${steps.length}`);
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i].t > steps[i - 1].t);
});

test('createMotionSource: steps and states from devicemotion events; unavailable without them', async () => {
  const handlers = {};
  const win = {
    DeviceMotionEvent: function DeviceMotionEvent() {},
    addEventListener: (type, fn) => { handlers[type] = fn; },
    removeEventListener: (type) => { delete handlers[type]; },
    performance: { timeOrigin: 1_700_000_000_000 },
  };
  const timers = { setTimeout: () => 1, clearTimeout: () => {} };
  let clock = 1_700_000_000_000;
  const src = createMotionSource({ win, timers, now: () => clock, getStepLength: () => 0.7, weinberg: false });
  const steps = [];
  const states = [];
  src.on('step', (s) => steps.push(s));
  src.on('state', (s) => states.push(s.motion));
  src.start();
  assert.equal(typeof handlers.devicemotion, 'function');
  const { samples } = synth([{ kind: 'still', seconds: 2 }, { kind: 'walk', seconds: 20 / 1.8, hz: 1.8, amp: 3 }, { kind: 'still', seconds: 3 }], { seed: 20 });
  const t0 = samples[0].t;
  for (const s of samples) {
    clock = 1_700_000_000_000 + (s.t - t0);
    handlers.devicemotion({ timeStamp: s.t - t0 + 1, accelerationIncludingGravity: { x: s.x, y: s.y, z: s.z } });
  }
  assert.ok(Math.abs(steps.length - 20) <= 1, `${steps.length} steps`);
  assert.ok(steps.every((s) => s.length === 0.7));
  assert.ok(steps[0].t > 1_700_000_000_000, 'times are epoch ms');
  assert.equal(src.getStatus(), 'ok');
  assert.ok(states.includes('walking') && states[states.length - 1] === 'stationary');
  assert.equal(src.getState(clock), 'stationary');
  assert.equal(src.getState(clock + 5000), 'unknown');
  src.stop();
  assert.equal(handlers.devicemotion, undefined);
  assert.equal(src.getStatus(), 'off');

  const bare = createMotionSource({ win: { addEventListener() {} }, timers });
  bare.start();
  assert.equal(bare.getStatus(), 'unavailable');
});

test('createMotionSource: after the phone slept, event times run behind Date.now() — standing still is still "stationary"', () => {
  const handlers = {};
  const win = {
    DeviceMotionEvent: function DeviceMotionEvent() {},
    addEventListener: (type, fn) => { handlers[type] = fn; },
    removeEventListener: (type) => { delete handlers[type]; },
    performance: { timeOrigin: 1_700_000_000_000 },
  };
  const timers = { setTimeout: () => 1, clearTimeout: () => {} };
  let clock = 1_700_000_000_000;
  const src = createMotionSource({ win, timers, now: () => clock, weinberg: false });
  src.start();
  const feed = (samples, tsStart, sleptMs) => {
    const t0 = samples[0].t;
    for (const s of samples) {
      // event.timeStamp is on the monotonic clock, which does not count the time asleep.
      const ts = tsStart + (s.t - t0);
      clock = 1_700_000_000_000 + sleptMs + ts;
      handlers.devicemotion({ timeStamp: ts, accelerationIncludingGravity: { x: s.x, y: s.y, z: s.z } });
    }
  };
  feed(synth([{ kind: 'still', seconds: 4 }], { seed: 22, noise: 0.08 }).samples, 1, 0);
  assert.equal(src.getState(clock), 'stationary');
  // Locked for 5 minutes, then held still again.
  feed(synth([{ kind: 'still', seconds: 4 }], { seed: 23, noise: 0.08 }).samples, 5000, 300_000);
  assert.equal(src.getState(clock), 'stationary', 'not "unknown" for the rest of the walk');
  assert.equal(src.getState(clock + 2500), 'unknown', 'no sample for 2.5 s is still unknown');
  src.stop();
});
