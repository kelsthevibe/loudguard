// Run any audio file through the detector to see if it would be muted — no Discord needed.
//   npm run calibrate -- path/to/clip.mp3 [thresholdDb] [triggerMs]
// Needs ffmpeg on your PATH.
import { spawn } from 'node:child_process';
import { LoudnessDetector, SAMPLE_RATE, CHANNELS, frameStats } from '../src/analyzer.js';

const [file, thr = '-8', trig = '1500'] = process.argv.slice(2);
if (!file) {
  console.log('Usage: npm run calibrate -- <audio file> [thresholdDb=-8] [triggerMs=1500]');
  process.exit(1);
}

const det = new LoudnessDetector({ thresholdDb: Number(thr), triggerMs: Number(trig) });
const ff = spawn('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-ac', String(CHANNELS), '-ar', String(SAMPLE_RATE), '-']);
ff.on('error', () => { console.error('ffmpeg not found — install it and make sure it is on your PATH.'); process.exit(1); });

const BYTES_PER_SEC = SAMPLE_RATE * CHANNELS * 2;
let t = 0; // virtual ms
let secBuf = Buffer.alloc(0);
let sec = 0;
let triggers = 0;

const bar = (db) => {
  const n = Math.max(0, Math.round((db + 60) / 2)); // -60..0 dBFS -> 0..30 chars
  return '█'.repeat(n).padEnd(30, '·');
};

ff.stdout.on('data', (chunk) => {
  for (const tr of det.push(chunk, t)) {
    triggers++;
    console.log(`  🔇 TRIGGER near ${(t / 1000).toFixed(1)}s — avg ${tr.avgDb.toFixed(1)} dBFS, peak ${tr.peakDb.toFixed(1)}, clipping ${(tr.clipRatio * 100).toFixed(1)}%, loud ${tr.loudMs} ms`);
  }
  t += (chunk.length / BYTES_PER_SEC) * 1000;

  secBuf = Buffer.concat([secBuf, chunk]);
  while (secBuf.length >= BYTES_PER_SEC) {
    const one = secBuf.subarray(0, BYTES_PER_SEC);
    const st = frameStats(new Int16Array(one.buffer, one.byteOffset, one.length / 2));
    const mark = st.db >= Number(thr) ? ' ⚠️' : '';
    console.log(`${String(sec).padStart(4)}s ${bar(st.db)} ${st.db.toFixed(1).padStart(6)} dBFS  clip ${(st.clipRatio * 100).toFixed(1).padStart(5)}%${mark}`);
    secBuf = Buffer.from(secBuf.subarray(BYTES_PER_SEC));
    sec++;
  }
});

ff.on('close', () => {
  console.log(`\nThreshold ${thr} dBFS / ${trig} ms → ${triggers ? `would MUTE (${triggers} trigger${triggers > 1 ? 's' : ''})` : 'would NOT mute'}`);
});
