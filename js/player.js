// Plays either the whole mix or one clip, and says where playback has got to.
import { makeMaster, scheduleMix, clamp } from './engine.js';

export class Player {
  constructor() {
    this.ctx = null;
    this.nodes = [];
    this.mode = null;      // null, 'mix' or 'clip'
    this.key = null;       // which clip is playing (mode 'clip')
    this.stopAt = null;    // mix time to stop at (used by "Listen to this join")
  }

  context() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      try { this.ctx = new AC({ latencyHint: 'playback' }); } catch { this.ctx = new AC(); }
    }
    return this.ctx;
  }

  // Call straight from a tap, before any await: iPhone only lets sound start inside a tap.
  // Saying the page plays media also stops the silent switch muting it.
  unlock() {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    const ctx = this.context();
    if (ctx.state !== 'running') return ctx.resume().catch(() => {});
    return Promise.resolve();
  }

  halt() {
    for (const n of this.nodes) {
      try { if (n.stop) n.stop(); } catch {}
      try { n.disconnect(); } catch {}
    }
    this.nodes = [];
    this.mode = null;
    this.key = null;
    this.stopAt = null;
  }

  playMix(plan, getBuffer, from, stopAt = null) {
    const ctx = this.context();
    this.halt();
    from = clamp(from, 0, plan.total);
    const when = ctx.currentTime + 0.06;
    const m = makeMaster(ctx, plan, from, when);
    m.output.connect(ctx.destination);
    this.nodes = [m.input, m.output, ...scheduleMix(ctx, m.input, plan, getBuffer, from, when)];
    this.mode = 'mix';
    this.base = when - from;
    this.end = plan.total;
    this.stopAt = stopAt;
  }

  // One clip on its own, from `from` to `to` (seconds in its file), optionally looping its selection.
  playClip({ buffer, from, to, level, key, loop, loopStart, loopEnd }) {
    const ctx = this.context();
    this.halt();
    const when = ctx.currentTime + 0.04;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(level, when + 0.01);
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -1.5; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.003; lim.release.value = 0.15;
    src.connect(g); g.connect(lim); lim.connect(ctx.destination);
    loop = !!loop && loopEnd - loopStart > 0.05 && from >= loopStart && from < loopEnd;
    if (loop) {
      src.loop = true; src.loopStart = loopStart; src.loopEnd = loopEnd;
      src.start(when, from);
    } else {
      src.start(when, from, Math.max(0.01, to - from));
    }
    this.nodes = [src, g, lim];
    this.mode = 'clip';
    this.key = key;
    this.clip = { when, from, to, loop, loopStart, loopEnd };
  }

  pos() {
    if (!this.ctx || !this.mode) return 0;
    const now = this.ctx.currentTime;
    if (this.mode === 'mix') return clamp(now - this.base, 0, this.end);
    const c = this.clip;
    let p = c.from + Math.max(0, now - c.when);
    if (c.loop) {
      if (p >= c.loopEnd) p = c.loopStart + ((p - c.loopEnd) % (c.loopEnd - c.loopStart));
      return p;
    }
    return Math.min(p, c.to);
  }

  ended() {
    if (this.mode === 'mix') return this.pos() >= this.end - 0.005 || (this.stopAt != null && this.pos() >= this.stopAt);
    if (this.mode === 'clip') return !this.clip.loop && this.pos() >= this.clip.to - 0.002;
    return false;
  }
}
