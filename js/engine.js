// Sound maths for the mix: waveform peaks, loudness, the timeline, scheduling, rendering and WAV files.
// Nothing here touches the page, so the tests can load this file in Node.

export const PEAKS_PER_SEC = 200;  // waveform detail: enough for the editor's closest zoom
export const BLOCK_SEC = 0.1;      // loudness is measured in 100 ms blocks, then combined per clip
export const TARGET_LUFS = -16;    // every clip is brought to this loudness when matching is on
export const MAX_AUTO_DB = 18;     // matching never boosts or cuts a clip by more than this
export const MIN_CLIP = 0.2;       // shortest clip, in seconds
const MICRO = 0.004;               // tiny fade at every hard cut so it doesn't click

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const dbToGain = db => Math.pow(10, db / 20);

// 0:42.3 (decimals = 1) or 2:41 (decimals = 0)
export function fmtTime(t, decimals = 1) {
  if (!isFinite(t) || t < 0) t = 0;
  const p = Math.pow(10, decimals);
  const r = Math.round(t * p) / p;
  const m = Math.floor(r / 60);
  const s = r - m * 60;
  const ss = s.toFixed(decimals);
  return `${m}:${s < 10 ? '0' : ''}${ss}`;
}

// Safari won't read the sound in QuickTime (.mov) files, the iPhone's video format, unless the file says it's MP4.
// Inside, the two formats are the same, so relabelling the file's first box is enough. Changes the bytes in place.
export function relabelQuickTime(arrayBuffer) {
  const u = new Uint8Array(arrayBuffer);
  if (u.length < 16) return false;
  const tag = o => String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);
  if (tag(4) !== 'ftyp' || tag(8) !== 'qt  ') return false;
  const size = Math.min(u.length, new DataView(arrayBuffer).getUint32(0));
  const put = (o, s) => { for (let i = 0; i < 4; i++) u[o + i] = s.charCodeAt(i); };
  put(8, 'mp42');
  for (let o = 16; o + 4 <= size; o += 4) if (tag(o) === 'qt  ') put(o, 'isom');
  return true;
}

export function decodeAudio(ctx, arrayBuffer) {
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(arrayBuffer, resolve, err => reject(err || new Error('decode failed')));
    if (p && p.catch) p.catch(reject);
  });
}

// Loudest sample in each 1/200 s slice (both channels), for drawing the waveform.
export function computePeaks(buffer, pps = PEAKS_PER_SEC) {
  const n = buffer.length, per = buffer.sampleRate / pps;
  const count = Math.max(1, Math.ceil(n / per));
  const out = new Float32Array(count);
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
    const d = buffer.getChannelData(c);
    for (let b = 0; b < count; b++) {
      const a = Math.floor(b * per), e = Math.min(n, Math.floor((b + 1) * per));
      let m = out[b];
      for (let i = a; i < e; i++) { const v = d[i] < 0 ? -d[i] : d[i]; if (v > m) m = v; }
      out[b] = m;
    }
  }
  return out;
}

// ITU-R BS.1770 "K-weighting" filters, worked out for this sample rate (the same way libebur128 does).
function kWeighting(fs) {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / fs);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const pb = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0];
  const pa = [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan(Math.PI * f0 / fs);
  a0 = 1 + K / Q + K * K;
  const rb = [1, -2, 1];
  const ra = [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  return { pb, pa, rb, ra };
}

// Weighted energy of every 100 ms block of the file. A clip's loudness is worked out from the blocks it covers,
// so moving a trim handle never needs the whole file measured again.
export function loudnessBlocks(buffer) {
  const fs = buffer.sampleRate, n = buffer.length;
  const bl = Math.max(1, Math.round(fs * BLOCK_SEC));
  const nb = Math.max(1, Math.ceil(n / bl));
  const out = new Float64Array(nb);
  const { pb, pa, rb, ra } = kWeighting(fs);
  const chans = Math.min(2, buffer.numberOfChannels);
  for (let c = 0; c < chans; c++) {
    const x = buffer.getChannelData(c);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0;
    for (let i = 0; i < n; i++) {
      const xi = x[i];
      const y = pb[0] * xi + pb[1] * x1 + pb[2] * x2 - pa[1] * y1 - pa[2] * y2;
      const z = rb[0] * y + rb[1] * y1 + rb[2] * y2 - ra[1] * z1 - ra[2] * z2;
      x2 = x1; x1 = xi; y2 = y1; y1 = y; z2 = z1; z1 = z;
      out[(i / bl) | 0] += z * z;
    }
  }
  // A mono file plays from both speakers, so it counts twice (as stereo would).
  const k = chans === 1 ? 2 : 1;
  const res = new Float32Array(nb);
  for (let b = 0; b < nb; b++) {
    const len = Math.min(bl, n - b * bl);
    res[b] = len > 0 ? (out[b] * k) / len : 0;
  }
  return res;
}

const lufs = ms => -0.691 + 10 * Math.log10(ms);

// Loudness (LUFS) of the part of the file between start and end; null if it's silent.
export function regionLoudness(blocks, start, end) {
  const a = Math.max(0, Math.floor(start / BLOCK_SEC));
  const b = Math.min(blocks.length, Math.ceil(end / BLOCK_SEC));
  if (b - a <= 0) return null;
  const wins = [];
  if (b - a < 4) {
    let s = 0; for (let i = a; i < b; i++) s += blocks[i];
    wins.push(s / (b - a));
  } else {
    for (let i = a; i + 4 <= b; i++) wins.push((blocks[i] + blocks[i + 1] + blocks[i + 2] + blocks[i + 3]) / 4);
  }
  const mean = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
  let gated = wins.filter(ms => ms > 0 && lufs(ms) > -70);
  if (!gated.length) return null;
  const rel = lufs(mean(gated)) - 10;
  gated = gated.filter(ms => lufs(ms) > rel);
  return gated.length ? lufs(mean(gated)) : null;
}

// Where everything sits in the finished mix.
// Clips next to each other overlap by their fade ("xfade"); silence items push the next clip later.
export function layout(project) {
  const entries = [];
  let cursor = 0, prev = null;
  project.items.forEach((it, i) => {
    if (it.kind === 'gap') {
      entries.push({ it, i, len: it.dur, t0: cursor, t1: cursor + it.dur, x: 0 });
      cursor += it.dur; prev = null;
      return;
    }
    const len = Math.max(0, it.end - it.start);
    const x = prev ? Math.max(0, Math.min(it.xfade || 0, prev.len / 2, len / 2)) : 0;
    const e = { it, i, len, x, xout: 0, t0: cursor - x, t1: cursor - x + len };
    if (prev) prev.xout = x;
    entries.push(e);
    cursor = e.t1; prev = e;
  });
  for (const e of entries) {
    if (e.it.kind !== 'clip') continue;
    let fi = Math.max(e.it.fadeIn || 0, e.x), fo = Math.max(e.it.fadeOut || 0, e.xout);
    if (fi + fo > e.len && fi + fo > 0) { const k = e.len / (fi + fo); fi *= k; fo *= k; }
    e.fi = fi; e.fo = fo;
    // fades that are part of a join use equal-power curves so the join doesn't dip in volume
    e.fiEq = e.x > 0 && e.x >= (e.it.fadeIn || 0);
    e.foEq = e.xout > 0 && e.xout >= (e.it.fadeOut || 0);
    e.gain = 1;
  }
  const total = cursor;
  return {
    entries, total,
    fadeIn: Math.min(project.fadeIn || 0, total / 2),
    fadeOut: Math.min(project.fadeOut || 0, total / 2),
  };
}

function shape(u, eq) {
  u = clamp(u, 0, 1);
  return eq ? Math.sin(u * Math.PI / 2) : 0.5 - 0.5 * Math.cos(u * Math.PI);
}

export function envAt(x, len, fi, fo, fiEq, foEq) {
  let g = 1;
  if (fi > 0 && x < fi) g *= shape(x / fi, fiEq);
  if (fo > 0 && x > len - fo) g *= shape((len - x) / fo, foEq);
  return g;
}

// Volume over a clip's life (fade in, steady, fade out) on an AudioParam.
// `off` is how far into the clip playback begins, `when` the context time that moment plays.
export function applyEnvelope(param, { len, fi, fo, fiEq, foEq, level, when, off }) {
  fi = Math.max(fi, MICRO); fo = Math.max(fo, MICRO);
  if (fi + fo > len) { const k = len / (fi + fo); fi *= k; fo *= k; }
  const at = x => level * envAt(x, len, fi, fo, fiEq, foEq);
  const curve = (x0, x1, t) => {
    const d = x1 - x0;
    if (d <= 1e-4) return;
    const n = clamp(Math.ceil(d * 60), 2, 2000);
    const v = new Float32Array(n);
    for (let k = 0; k < n; k++) v[k] = at(x0 + d * k / (n - 1));
    param.setValueCurveAtTime(v, t, d);
  };
  const foStart = len - fo;
  let x = off;
  if (x < fi) {
    curve(x, fi, when);
    x = fi;
  } else if (x < foStart) {
    // starting part-way through a clip: rise quickly instead of jumping, so it doesn't click
    const r = Math.min(0.012, (foStart - x) / 2);
    param.setValueAtTime(0, when);
    param.linearRampToValueAtTime(at(x + r), when + r);
    x += r;
  }
  const s = Math.max(x, foStart);
  curve(s, len, when + (s - off));
}

// Volume for the whole mix (start fade-in, end fade-out) followed by a limiter that stops loud parts distorting.
export function makeMaster(ctx, plan, from, when) {
  const input = ctx.createGain();
  if (plan.total > 0) {
    applyEnvelope(input.gain, { len: plan.total, fi: plan.fadeIn, fo: plan.fadeOut, fiEq: false, foEq: false, level: 1, when, off: from });
  }
  const output = ctx.createDynamicsCompressor();
  output.threshold.value = -1.5;
  output.knee.value = 0;
  output.ratio.value = 20;
  output.attack.value = 0.003;
  output.release.value = 0.15;
  input.connect(output);
  return { input, output };
}

// Starts every clip that plays at or after `from` (mix time), with mix time `from` landing at context time `when`.
export function scheduleMix(ctx, dest, plan, getBuffer, from, when) {
  const nodes = [];
  for (const e of plan.entries) {
    if (e.it.kind !== 'clip' || e.t1 <= from + 1e-3) continue;
    const buf = getBuffer(e.it.src);
    if (!buf) continue;
    const off = Math.max(0, from - e.t0);
    const at = when + Math.max(0, e.t0 - from);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    applyEnvelope(g.gain, { len: e.len, fi: e.fi, fo: e.fo, fiEq: e.fiEq, foEq: e.foEq, level: e.gain, when: at, off });
    src.connect(g);
    g.connect(dest);
    src.start(at, e.it.start + off, Math.max(0.001, e.len - off));
    nodes.push(src, g);
  }
  return nodes;
}

// The finished mix as one stereo AudioBuffer (faster than real time).
export async function renderMix(plan, getBuffer, sampleRate) {
  const frames = Math.max(1, Math.ceil(plan.total * sampleRate));
  const oc = new OfflineAudioContext(2, frames, sampleRate);
  const m = makeMaster(oc, plan, 0, 0);
  m.output.connect(oc.destination);
  scheduleMix(oc, m.input, plan, getBuffer, 0, 0);
  return oc.startRendering();
}

// 16-bit PCM WAV file bytes.
export function encodeWav(buffer) {
  const ch = buffer.numberOfChannels, n = buffer.length, sr = buffer.sampleRate;
  const bytes = n * ch * 2;
  const view = new DataView(new ArrayBuffer(44 + bytes));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, ch, true);
  view.setUint32(24, sr, true); view.setUint32(28, sr * ch * 2, true); view.setUint16(32, ch * 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, bytes, true);
  const data = [];
  for (let c = 0; c < ch; c++) data.push(buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      let v = data[c][i];
      v = v < -1 ? -1 : v > 1 ? 1 : v;
      view.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return view.buffer;
}
