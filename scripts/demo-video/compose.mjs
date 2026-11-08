// Mixes the narration clips onto the recorded video, fast-forwards silent waits, outputs an MP4 for YouTube.
import ffmpeg from 'ffmpeg-static';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const out = process.argv[2] ?? 'FleetSpend-AI-demo.mp4';
const tl = JSON.parse(readFileSync('timeline.json', 'utf8'));
const fast = [...tl.fast].sort((a, b) => a.fromMs - b.fromMs);

// original time (ms) -> output time (ms)
const map = (t) => {
  let shift = 0;
  for (const f of fast) {
    if (t <= f.fromMs) break;
    if (t < f.toMs) return t - shift - (t - f.fromMs) * (1 - 1 / f.factor);
    shift += (f.toMs - f.fromMs) * (1 - 1 / f.factor);
  }
  return t - shift;
};

// video segments
const segs = [];
let cursor = 0;
for (const f of fast) {
  if (f.fromMs > cursor) segs.push({ a: cursor, b: f.fromMs, k: 1 });
  segs.push({ a: f.fromMs, b: f.toMs, k: f.factor });
  cursor = f.toMs;
}
segs.push({ a: cursor, b: null, k: 1 });

const s = (ms) => (ms / 1000).toFixed(3);
const parts = [`[0:v]split=${segs.length}${segs.map((_, i) => `[s${i}]`).join('')}`];
segs.forEach((g, i) => {
  const trim = g.b === null ? `trim=start=${s(g.a)}` : `trim=start=${s(g.a)}:end=${s(g.b)}`;
  parts.push(`[s${i}]${trim},setpts=(PTS-STARTPTS)/${g.k}[v${i}]`);
});
parts.push(`${segs.map((_, i) => `[v${i}]`).join('')}concat=n=${segs.length}:v=1:a=0,fps=30,format=yuv420p[v]`);

// audio: each clip delayed to its mapped scene start
const inputs = ['-i', tl.video];
tl.scenes.forEach((sc, i) => {
  inputs.push('-i', `audio/${sc.id}.wav`);
  const d = Math.max(0, Math.round(map(sc.atMs) + 250));
  parts.push(`[${i + 1}:a]aresample=48000,adelay=${d}:all=1[a${i}]`);
});
parts.push(`${tl.scenes.map((_, i) => `[a${i}]`).join('')}amix=inputs=${tl.scenes.length}:normalize=0:duration=longest,apad[a]`);

const totalMs = map(tl.endMs);
console.log('output length', (totalMs / 1000).toFixed(1), 's');
execFileSync(ffmpeg, [
  '-y', '-loglevel', 'error', ...inputs,
  '-filter_complex', parts.join(';'),
  '-map', '[v]', '-map', '[a]', '-t', s(totalMs),
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '160k',
  '-movflags', '+faststart', out,
], { stdio: 'inherit' });
console.log('wrote', out);
