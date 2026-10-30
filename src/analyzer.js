// LoudnessDetector: turns raw PCM into "is this person blasting earrape?" decisions.
//
// Input:  16-bit signed little-endian PCM, 48 kHz, stereo interleaved
//         (exactly what the Opus decoder hands us from Discord).
// Output: a trigger object when someone has been too loud for too long.
//
// How it decides (a "leaky bucket"):
//   - Audio is cut into 20 ms frames.
//   - Each frame gets a loudness in dBFS (0 = digital max, -20 = normal talking-ish).
//   - Loud frame  -> bucket fills by 20 ms (x1.5 if the frame is heavily clipped).
//   - Quiet frame -> bucket drains by 20 ms * drainRate.
//   - Bucket reaches triggerMs -> TRIGGER.
// A loud laugh fills the bucket for half a second, then drains. A soundboard
// blast keeps it full until it overflows.

export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;
export const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS * CHANNELS; // 1920
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * 2; // 3840
const CLIP_LEVEL = 32000; // |sample| at/above this counts as clipped (max is 32767)
const SILENCE_DB = -100;

export function frameStats(int16, start = 0, length = int16.length - start) {
  let sumSq = 0;
  let peak = 0;
  let clipped = 0;
  for (let i = start; i < start + length; i++) {
    const s = int16[i];
    const a = s < 0 ? -s : s;
    sumSq += s * s;
    if (a > peak) peak = a;
    if (a >= CLIP_LEVEL) clipped++;
  }
  const rms = Math.sqrt(sumSq / length);
  return {
    db: rms > 0 ? 20 * Math.log10(rms / 32768) : SILENCE_DB,
    peakDb: peak > 0 ? 20 * Math.log10(peak / 32768) : SILENCE_DB,
    clipRatio: clipped / length,
  };
}

export class LoudnessDetector {
  /**
   * @param {object} opts
   * @param {number} opts.thresholdDb  RMS dBFS a frame must reach to count as "loud" (default -8)
   * @param {number} opts.triggerMs    how much loud time fills the bucket (default 1500)
   * @param {number} opts.clipRatio    fraction of clipped samples that marks a frame as "distorted" (default 0.05)
   * @param {number} opts.drainRate    how fast quiet frames empty the bucket, relative to fill (default 0.5)
   */
  constructor({ thresholdDb = -8, triggerMs = 1500, clipRatio = 0.05, drainRate = 0.5 } = {}) {
    this.configure({ thresholdDb, triggerMs, clipRatio, drainRate });
    this.leftover = Buffer.alloc(0);
    this.reset();
    this.recent = []; // [{t, db}] last ~10 s, for the /guard meter command
  }

  configure({ thresholdDb, triggerMs, clipRatio, drainRate }) {
    if (thresholdDb !== undefined) this.thresholdDb = thresholdDb;
    if (triggerMs !== undefined) this.triggerMs = triggerMs;
    if (clipRatio !== undefined) this.clipRatioLimit = clipRatio;
    if (drainRate !== undefined) this.drainRate = drainRate;
  }

  reset() {
    this.bucketMs = 0;
    this.episode = null; // stats for the current loud stretch
  }

  /** Call when the user's audio stream stops (they went silent). */
  silence() {
    this.leftover = Buffer.alloc(0);
    this.reset();
  }

  /**
   * Feed decoded PCM. Returns an array of triggers (usually empty).
   * @param {Buffer} pcm
   * @param {number} now  timestamp in ms (injectable for tests)
   */
  push(pcm, now = Date.now()) {
    const buf = this.leftover.length ? Buffer.concat([this.leftover, pcm]) : pcm;
    const frames = Math.floor(buf.length / BYTES_PER_FRAME);
    const triggers = [];
    const view = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));

    for (let f = 0; f < frames; f++) {
      const st = frameStats(view, f * SAMPLES_PER_FRAME, SAMPLES_PER_FRAME);
      const t = now + f * FRAME_MS;
      this._remember(t, st.db);
      const trig = this._step(st);
      if (trig) triggers.push(trig);
    }

    const used = frames * BYTES_PER_FRAME;
    this.leftover = used < buf.length ? Buffer.from(buf.subarray(used)) : Buffer.alloc(0);
    return triggers;
  }

  _step(st) {
    const loud = st.db >= this.thresholdDb;
    const distorted = st.clipRatio >= this.clipRatioLimit;

    if (loud) {
      this.bucketMs += FRAME_MS * (distorted ? 1.5 : 1);
      const e = (this.episode ??= { frames: 0, sumDb: 0, peakDb: SILENCE_DB, clipSum: 0 });
      e.frames++;
      e.sumDb += st.db;
      e.clipSum += st.clipRatio;
      if (st.peakDb > e.peakDb) e.peakDb = st.peakDb;
    } else {
      this.bucketMs = Math.max(0, this.bucketMs - FRAME_MS * this.drainRate);
      if (this.bucketMs === 0) this.episode = null;
    }

    if (this.bucketMs >= this.triggerMs && this.episode) {
      const e = this.episode;
      const trig = {
        avgDb: e.sumDb / e.frames,
        peakDb: e.peakDb,
        clipRatio: e.clipSum / e.frames,
        loudMs: e.frames * FRAME_MS,
      };
      this.reset();
      return trig;
    }
    return null;
  }

  _remember(t, db) {
    this.recent.push({ t, db });
    const cutoff = t - 10_000;
    while (this.recent.length && this.recent[0].t < cutoff) this.recent.shift();
  }

  /** Loudest frame and average loudness over the last 10 s (for calibration). */
  meter(now = Date.now()) {
    const pts = this.recent.filter((p) => p.t >= now - 10_000 && p.db > SILENCE_DB);
    if (!pts.length) return null;
    const max = Math.max(...pts.map((p) => p.db));
    const avg = pts.reduce((a, p) => a + p.db, 0) / pts.length;
    return { maxDb: max, avgDb: avg, frames: pts.length };
  }
}
