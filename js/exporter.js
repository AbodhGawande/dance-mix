// Turning the finished mix into files: WAV, M4A, and a video (MP4) with a black screen where there's only music.
import { encodeWav, clamp } from './engine.js';

export const wavBlob = mix => new Blob([encodeWav(mix)], { type: 'audio/wav' });

const pickMime = list => (typeof MediaRecorder === 'undefined' ? null : list.find(m => MediaRecorder.isTypeSupported(m)) || null);
const pause = ms => new Promise(r => setTimeout(r, ms));
const cancelled = () => Object.assign(new Error('cancelled'), { cancelled: true });
const hasCodecs = () => typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined' && !!window.Mp4Muxer;

// Safari's encoder hands over a whole MPEG-4 ES descriptor where the MP4 writer wants only the
// AudioSpecificConfig inside it (a couple of bytes). Other browsers already give just those bytes.
export function audioSpecificConfig(desc) {
  const u = desc instanceof ArrayBuffer ? new Uint8Array(desc) : new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength);
  if (u[0] !== 0x03) return u;
  let i = 0;
  const len = () => { let n = 0, b; do { b = u[i++]; n = (n << 7) | (b & 0x7f); } while (b & 0x80 && i < u.length); return n; };
  while (i < u.length) {
    const tag = u[i++];
    const n = len();
    if (tag === 0x03) {            // ES_Descriptor: id, flags, optional fields, then the descriptors we want
      const flags = u[i + 2]; i += 3;
      if (flags & 0x80) i += 2;
      if (flags & 0x40) i += 1 + u[i];
      if (flags & 0x20) i += 2;
    } else if (tag === 0x04) {     // DecoderConfigDescriptor: fixed 13 bytes, then the specific info
      i += 13;
    } else if (tag === 0x05) {     // DecoderSpecificInfo = AudioSpecificConfig
      return u.slice(i, i + n);
    } else {
      i += n;
    }
  }
  return u;
}
const aacMeta = meta => (meta && meta.decoderConfig && meta.decoderConfig.description
  ? { ...meta, decoderConfig: { ...meta.decoderConfig, description: audioSpecificConfig(meta.decoderConfig.description) } }
  : meta);

async function aacEncoder(mix, bitrate, onChunk) {
  const config = { codec: 'mp4a.40.2', sampleRate: mix.sampleRate, numberOfChannels: mix.numberOfChannels, bitrate };
  if (!(await AudioEncoder.isConfigSupported(config)).supported) throw new Error('AAC not supported');
  const state = { failure: null };
  const enc = new AudioEncoder({ output: (chunk, meta) => onChunk(chunk, aacMeta(meta)), error: e => { state.failure = e; } });
  enc.configure(config);
  return { enc, state };
}

// Feeds the whole mix to an audio encoder (much faster than real time).
async function encodeAudio({ enc, state }, mix, job, onProgress) {
  const sr = mix.sampleRate, ch = mix.numberOfChannels;
  const chans = Array.from({ length: ch }, (_, c) => mix.getChannelData(c));
  const F = 4096;
  for (let i = 0, k = 0; i < mix.length; i += F, k++) {
    if (job.cancel) { try { enc.close(); } catch {} throw cancelled(); }
    if (state.failure) throw state.failure;
    const n = Math.min(F, mix.length - i);
    const data = new Float32Array(n * ch);
    for (let c = 0; c < ch; c++) data.set(chans[c].subarray(i, i + n), c * n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round(i / sr * 1e6), data });
    enc.encode(ad);
    ad.close();
    while (enc.encodeQueueSize > 16) await pause(1);
    if (k % 40 === 0) { if (onProgress) onProgress(i / mix.length); await pause(0); }
  }
  await enc.flush();
  if (state.failure) throw state.failure;
  enc.close();
}

export async function m4aBlob(mix, ctx, onProgress, job) {
  if (hasCodecs()) {
    try {
      const muxer = new Mp4Muxer.Muxer({
        target: new Mp4Muxer.ArrayBufferTarget(),
        audio: { codec: 'aac', numberOfChannels: mix.numberOfChannels, sampleRate: mix.sampleRate },
        fastStart: 'in-memory',
      });
      await encodeAudio(await aacEncoder(mix, 256000, (c, m) => muxer.addAudioChunk(c, m)), mix, job, onProgress);
      muxer.finalize();
      onProgress(1);
      return new Blob([muxer.target.buffer], { type: 'audio/mp4' });
    } catch (err) {
      if (err.cancelled) throw err;
      console.warn('AAC encoder unavailable, recording instead', err);
    }
  }
  const mime = pickMime(['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac']);
  if (!mime) throw new Error("This browser can't make M4A files. Try WAV instead.");
  return record({ ctx, mix, mime, onProgress, job });
}

// Runs `step(pos)` on every screen refresh for `total` seconds of real time.
function realTime(total, job, step, onProgress, lostMessage) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now() + 150;
    const tick = () => {
      if (job.cancel) return reject(cancelled());
      if (job.lost) return reject(new Error(lostMessage));
      const pos = (performance.now() - t0) / 1000;
      try { step(Math.max(0, pos)); } catch (e) { return reject(e); }
      onProgress(clamp(pos / total, 0, 1));
      if (pos >= total) return resolve();
      if (document.visibilityState === 'visible') requestAnimationFrame(tick); else setTimeout(tick, 33);
    };
    tick();
  });
}
const LOST = 'The export stopped because the app went into the background. Keep the screen on and try again.';

// Fallback: plays the finished mix (silently) into the browser's recorder, in real time.
async function record({ ctx, mix, mime, video, onProgress, job }) {
  const dest = ctx.createMediaStreamDestination();
  const src = ctx.createBufferSource();
  src.buffer = mix;
  src.connect(dest);
  const tracks = [...(video ? video.stream.getVideoTracks() : []), ...dest.stream.getAudioTracks()];
  const opts = { mimeType: mime, audioBitsPerSecond: 192000 };
  if (video) opts.videoBitsPerSecond = 6000000;
  const rec = new MediaRecorder(new MediaStream(tracks), opts);
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(r => { rec.onstop = r; });
  if (video) video.draw(0);
  rec.start(1000);
  const t0 = ctx.currentTime + 0.25;
  src.start(t0);
  const total = mix.duration;
  try {
    await new Promise((resolve, reject) => {
      const step = () => {
        if (job.cancel) return reject(cancelled());
        if (job.lost) return reject(new Error(LOST));
        const pos = ctx.currentTime - t0;
        if (video) video.draw(Math.max(0, pos));
        onProgress(clamp(pos / total, 0, 1));
        if (pos >= total + 0.3) return resolve();
        if (video && document.visibilityState === 'visible') requestAnimationFrame(step);
        else setTimeout(step, 33);
      };
      step();
    });
  } finally {
    try { src.stop(); } catch {}
    src.disconnect();
    if (rec.state !== 'inactive') rec.stop();
    await stopped;
  }
  return new Blob(chunks, { type: mime.split(';')[0] });
}

// Video size: the first video clip's shape, at most 1920 px on the long side. Music-only mixes are portrait 1080×1920.
export function videoSize(infos) {
  const v = infos.find(i => i && i.width && i.height);
  if (!v) return [1080, 1920];
  const k = Math.min(1, 1920 / Math.max(v.width, v.height));
  const even = x => Math.max(2, Math.round(x * k / 2) * 2);
  return [even(v.width), even(v.height)];
}

// Draws the picture for any moment of the mix onto a canvas, playing each video clip (muted) as its turn comes.
function makePainter(plan, info, W, H) {
  const vids = plan.entries.filter(e => e.it.kind === 'clip' && info(e.it.src).kind === 'video' && info(e.it.src).url);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d', { alpha: false });
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  const holder = document.createElement('div');
  holder.className = 'offscreen';
  document.body.appendChild(holder);
  const live = new Map();   // entry index → <video>, made shortly before each clip plays

  const make = e => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
    v.addEventListener('loadedmetadata', () => { v.currentTime = e.it.start; }, { once: true });
    v.src = info(e.it.src).url;
    holder.appendChild(v);
    return v;
  };
  const drop = k => { const v = live.get(k); if (!v) return; v.pause(); v.removeAttribute('src'); v.load(); v.remove(); live.delete(k); };

  const draw = pos => {
    g.globalAlpha = 1; g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    for (const e of vids) {
      const k = e.i;
      if (pos >= e.t1) { drop(k); continue; }
      if (pos < e.t0 - 2.5) continue;
      if (!live.has(k)) live.set(k, make(e));
      const v = live.get(k);
      if (pos < e.t0) continue;
      const want = e.it.start + (pos - e.t0);
      if (v.readyState >= 1) {
        if (v.paused && !v.ended) { v.currentTime = want; v.play().catch(() => {}); }
        else if (!v.seeking && Math.abs(v.currentTime - want) > 0.3) v.currentTime = want;
      }
      if (v.readyState >= 2 && v.videoWidth) {
        // a clip that overlaps the one before fades in over it
        g.globalAlpha = e.x > 0 && pos < e.t0 + e.x ? clamp((pos - e.t0) / e.x, 0, 1) : 1;
        const s = Math.min(W / v.videoWidth, H / v.videoHeight);
        const dw = v.videoWidth * s, dh = v.videoHeight * s;
        g.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
      }
    }
    let f = 1;
    if (plan.fadeIn > 0 && pos < plan.fadeIn) f = pos / plan.fadeIn;
    if (plan.fadeOut > 0 && pos > plan.total - plan.fadeOut) f = Math.min(f, (plan.total - pos) / plan.fadeOut);
    if (f < 1) { g.globalAlpha = 1 - clamp(f, 0, 1); g.fillStyle = '#000'; g.fillRect(0, 0, W, H); }
    g.globalAlpha = 1;
  };
  const dispose = () => { for (const k of [...live.keys()]) drop(k); holder.remove(); };
  return { canvas, draw, dispose };
}

const FPS = 30;

// Preferred: encode H.264 + AAC directly into a normal MP4 (proper length, plays everywhere).
async function encodeVideo({ mix, plan, painter, W, H, onProgress, job }) {
  let vconfig = null;
  for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.640033']) {
    const c = { codec, width: W, height: H, bitrate: 6000000, framerate: FPS, avc: { format: 'avc' } };
    try { if ((await VideoEncoder.isConfigSupported(c)).supported) { vconfig = c; break; } } catch {}
  }
  if (!vconfig) throw new Error('H.264 not supported');
  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.ArrayBufferTarget(),
    video: { codec: 'avc', width: W, height: H, frameRate: FPS },
    audio: { codec: 'aac', numberOfChannels: mix.numberOfChannels, sampleRate: mix.sampleRate },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  // sound first: it doesn't need real time
  await encodeAudio(await aacEncoder(mix, 192000, (c, m) => muxer.addAudioChunk(c, m)), mix, job, v => onProgress(v * 0.03));
  let failure = null;
  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => { failure = e; } });
  venc.configure(vconfig);
  let frame = 0;
  const total = plan.total;
  const frames = Math.max(1, Math.round(total * FPS));
  const emit = () => {
    const vf = new VideoFrame(painter.canvas, { timestamp: Math.round(frame * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
    venc.encode(vf, { keyFrame: frame % (FPS * 2) === 0 });
    vf.close();
    frame++;
  };
  try {
    await realTime(total, job, pos => {
      if (failure) throw failure;
      painter.draw(pos);
      // one frame for every 1/30 s that has passed (repeating the picture if the phone fell behind)
      while (frame < frames && frame / FPS <= pos) emit();
    }, v => onProgress(0.03 + v * 0.95), LOST);
    while (frame < frames) emit();
    await venc.flush();
    if (failure) throw failure;
  } finally {
    try { venc.close(); } catch {}
  }
  muxer.finalize();
  onProgress(1);
  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}

// `info(srcId)` gives { kind, url, width, height } for a source.
export async function videoBlob({ ctx, mix, plan, info, onProgress, job }) {
  const vids = plan.entries.filter(e => e.it.kind === 'clip' && info(e.it.src).kind === 'video');
  const [W, H] = videoSize(vids.map(e => info(e.it.src)));
  const painter = makePainter(plan, info, W, H);
  try {
    if (hasCodecs() && typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined') {
      try {
        return await encodeVideo({ mix, plan, painter, W, H, onProgress, job });
      } catch (err) {
        if (err.cancelled || err.message === LOST) throw err;
        console.warn('video encoder unavailable, recording instead', err);
      }
    }
    const mime = pickMime(['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']);
    if (!mime || !HTMLCanvasElement.prototype.captureStream) throw new Error("This browser can't make videos.");
    const stream = painter.canvas.captureStream(FPS);
    try {
      return await record({ ctx, mix, mime, video: { stream, draw: painter.draw }, onProgress, job });
    } finally {
      stream.getTracks().forEach(t => t.stop());
    }
  } finally {
    painter.dispose();
  }
}
