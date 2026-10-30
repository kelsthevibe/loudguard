import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoudnessDetector, frameStats } from '../src/analyzer.js';
import { HopTracker } from '../src/tracker.js';
import { Store } from '../src/store.js';
import { Moderator } from '../src/moderation.js';

const RATE = 48000;

/** Make stereo s16le PCM. gen(i) returns a sample in [-1, 1]. */
function pcm(seconds, gen) {
  const n = Math.round(RATE * seconds);
  const buf = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(gen(i) * 32767)));
    buf.writeInt16LE(v, i * 4);
    buf.writeInt16LE(v, i * 4 + 2);
  }
  return buf;
}
const sine = (amp, hz = 300) => (i) => amp * Math.sin((2 * Math.PI * hz * i) / RATE);
const silence = () => 0;
// "speech": 300 Hz tone with a syllable envelope (4 syllables/s) around -20 dBFS
const speech = (i) => 0.14 * Math.sin((2 * Math.PI * 300 * i) / RATE) * Math.abs(Math.sin((Math.PI * 4 * i) / RATE));
// earrape: sine driven 6x into the ceiling -> hard-clipped square-ish wave near 0 dBFS
const earrape = (i) => Math.max(-1, Math.min(1, 6 * Math.sin((2 * Math.PI * 200 * i) / RATE)));

/** Feed PCM in Discord-sized chunks (20 ms) and collect triggers. */
function run(det, buf, chunk = 3840) {
  const out = [];
  let t = 0;
  for (let o = 0; o < buf.length; o += chunk) {
    out.push(...det.push(buf.subarray(o, o + chunk), t));
    t += 20;
  }
  return out;
}

test('frameStats: full-scale sine ≈ -3 dBFS, silence = -100', () => {
  const s = frameStats(new Int16Array(pcm(0.02, sine(1)).buffer));
  assert.ok(Math.abs(s.db - -3.01) < 0.2, `got ${s.db}`);
  assert.equal(frameStats(new Int16Array(1920)).db, -100);
});

test('normal speech for 10 s never triggers', () => {
  assert.equal(run(new LoudnessDetector(), pcm(10, speech)).length, 0);
});

test('short shout / loud laugh (0.6 s at -4 dBFS) does not trigger', () => {
  const buf = Buffer.concat([pcm(1, speech), pcm(0.6, sine(0.9)), pcm(2, speech)]);
  assert.equal(run(new LoudnessDetector(), buf).length, 0);
});

test('sustained clipped earrape triggers within ~1.5 s', () => {
  const det = new LoudnessDetector();
  const t = run(det, Buffer.concat([pcm(1, speech), pcm(3, earrape)]));
  assert.ok(t.length >= 1, 'should trigger');
  assert.ok(t[0].clipRatio > 0.5, `clip ratio ${t[0].clipRatio}`);
  assert.ok(t[0].avgDb > -2, `avg ${t[0].avgDb}`);
  // clipped audio fills 1.5x faster -> ~1000 ms of loud audio to reach 1500 ms bucket
  assert.ok(t[0].loudMs <= 1100, `loudMs ${t[0].loudMs}`);
});

test('loud but clean tone needs the full trigger time', () => {
  const t = run(new LoudnessDetector(), pcm(3, sine(0.8)));
  assert.ok(t.length >= 1);
  assert.ok(t[0].loudMs >= 1480 && t[0].loudMs <= 1520, `loudMs ${t[0].loudMs}`);
});

test('pulsing earrape with gaps (on 300 ms / off 100 ms) still triggers', () => {
  const parts = [];
  for (let k = 0; k < 10; k++) parts.push(pcm(0.3, earrape), pcm(0.1, silence));
  assert.ok(run(new LoudnessDetector(), Buffer.concat(parts)).length >= 1);
});

test('odd chunk sizes are handled (leftover bytes carried over)', () => {
  const t = run(new LoudnessDetector(), pcm(3, earrape), 1234);
  assert.ok(t.length >= 1);
});

test('stricter threshold catches quieter blasting', () => {
  const buf = pcm(3, sine(0.3)); // ~ -13.5 dBFS
  assert.equal(run(new LoudnessDetector({ thresholdDb: -8 }), buf).length, 0);
  assert.ok(run(new LoudnessDetector({ thresholdDb: -15 }), buf).length >= 1);
});

test('hop tracker flags 5 joins in 2 min, once per window', () => {
  const h = new HopTracker();
  const opts = { hopLimit: 5, windowSec: 120 };
  const results = [0, 10, 20, 30, 40, 50, 60].map((s) => h.record('g', 'u', opts, s * 1000));
  assert.deepEqual(results.map((r) => !!r), [false, false, false, false, true, false, false]);
  assert.equal(h.record('g', 'slow', opts, 0), null);
  assert.equal(h.record('g', 'slow', opts, 200_000), null); // spread out = fine
});

test('store: strikes, suspicion score, watchlist, pardon', () => {
  const s = new Store(':memory:');
  const now = Date.now();
  const inc = (ts) => s.addIncident({ guildId: 'g', userId: 'u', channelId: 'c', ts, avgDb: -1, peakDb: 0, clipRatio: 0.6, loudMs: 1000, action: 'muted 30s', muteUntil: ts + 30_000 });
  inc(now - 1000);
  inc(now - 500);
  s.addFlag('g', 'u', 'hopping', '6 joins');
  assert.equal(s.strikes('g', 'u', now - 3_600_000), 2);
  assert.equal(s.suspicion('g', 'u'), 7);
  assert.equal(s.watchlist('g')[0].score, 7);
  assert.equal(s.pardon('g', 'u'), 2);
  assert.equal(s.strikes('g', 'u', now - 3_600_000), 0);
  assert.equal(s.updateSettings('g', { thresholdDb: -12 }).thresholdDb, -12);
});

test('moderator escalation ladder', () => {
  const m = new Moderator(new Store(':memory:'));
  const s = { escalate: true, muteSeconds: 30, timeoutMinutes: 10 };
  assert.deepEqual([1, 2, 3].map((n) => [m.decide(n, s).muteSec, m.decide(n, s).timeoutMin]), [[30, 0], [120, 0], [120, 10]]);
  assert.equal(m.decide(5, { ...s, escalate: false }).timeoutMin, 0);
});
