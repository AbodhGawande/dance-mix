// Dance Mix: trim and join songs and videos into one seamless track, on the phone.
// Files never leave the phone; everything is saved in its browser storage (store.js).
import {
  PEAKS_PER_SEC, TARGET_LUFS, MAX_AUTO_DB, MIN_CLIP, clamp, dbToGain, fmtTime,
  decodeAudio, relabelQuickTime, computePeaks, loudnessBlocks, regionLoudness, layout, renderMix,
} from './engine.js';
import { Player } from './player.js';
import { store } from './store.js';
import { wavBlob, m4aBlob, videoBlob } from './exporter.js';
import { icon } from './icons.js';

const APP_VERSION = 2;          // keep in step with VERSION in sw.js
const CARD_HANDLE = 12;         // trim handle width on the list waveforms (px)
const ED_HANDLE = 16;           // trim handle width in the editor (px)
const MIN_SPAN = 1.5;           // closest editor zoom: this many seconds across the screen
const NUDGE = 0.1;
const FADE_STEPS = [0, 0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
const GAP_STEP = 0.5, GAP_MAX = 60;
const LIMIT_STEP = 5;
// iPhone greys out every audio file in the Files picker when asked for "audio/*", so each type is named.
// Asking only for audio also makes it open Files straight away, without the Photos/Camera menu.
const SONG_TYPES = '.mp3,.m4a,.aac,.wav,.aif,.aiff,.aifc,.caf,.flac,.ogg,.oga,.opus,.wma,.amr,'
  + 'audio/mpeg,audio/mp3,audio/mp4,audio/x-m4a,audio/aac,audio/wav,audio/x-wav,audio/aiff,audio/x-aiff,audio/flac,audio/ogg';
const VIDEO_TYPES = 'video/*,.mov,.mp4,.m4v';

const DEFAULTS = {
  xfadeOn: false, xfadeSec: 2,      // fade between clips, for each clip added
  fadeInOn: false, fadeInSec: 2,    // mix start, for each new mix
  fadeOutOn: false, fadeOutSec: 3,  // mix end, for each new mix
  autoLevel: true,                  // loudness matching
  limitOn: false, limitSec: 180,    // time limit, for each new mix
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const secs = v => `${Math.round((v || 0) * 100) / 100} s`;
const isVideoFile = f => /^video\//.test(f.type) || /\.(mov|mp4|m4v|webm|3gp)$/i.test(f.name);
function stepFade(v, dir) {
  if (dir > 0) return FADE_STEPS.find(s => s > v + 1e-6) ?? FADE_STEPS[FADE_STEPS.length - 1];
  const lower = FADE_STEPS.filter(s => s < v - 1e-6);
  return lower.length ? lower[lower.length - 1] : 0;
}
const dbText = db => (db > 0 ? `+${db}` : db < 0 ? `−${-db}` : '0');

const S = {
  settings: { ...DEFAULTS },
  project: null,
  plan: { entries: [], total: 0, fadeIn: 0, fadeOut: 0 },
  rt: new Map(),          // per source: { status, buffer, peaks, peakMax, blocks, url }
  history: [],            // undo snapshots
  heads: new Map(),       // clip id → its playhead (seconds into its file)
  mixPos: 0,
  pending: [],            // files still being read, shown as placeholder cards
  cards: new Map(),       // clip id → its card's elements
  colors: {},
  ed: null,               // the open editor: { id, v0, v1, head, loop, video }
  job: null,              // export in progress
  levelCache: new Map(),
  sheetLocked: false,
};
const player = new Player();

/* ---------------- project ---------------- */

function newProject(name) {
  const s = S.settings;
  return {
    id: uid(), name, created: Date.now(), updated: Date.now(), sources: [], items: [],
    fadeIn: s.fadeInOn ? s.fadeInSec : 0,
    fadeOut: s.fadeOutOn ? s.fadeOutSec : 0,
    limit: s.limitOn ? s.limitSec : null,
  };
}
const srcOf = id => S.project.sources.find(s => s.id === id);
const itemOf = id => S.project.items.find(i => i.id === id);
function rtOf(id) {
  let r = S.rt.get(id);
  if (!r) S.rt.set(id, (r = { status: 'idle' }));
  return r;
}
const getBuf = id => S.rt.get(id)?.buffer || null;
const newXfade = () => (S.settings.xfadeOn ? S.settings.xfadeSec : 0);

// Loudness matching: how much this clip is raised or lowered to sit at the target loudness.
function autoDb(it) {
  if (!S.settings.autoLevel) return 0;
  const r = S.rt.get(it.src);
  if (!r || !r.blocks) return 0;
  const key = `${it.src}|${it.start.toFixed(2)}|${it.end.toFixed(2)}`;
  let v = S.levelCache.get(key);
  if (v === undefined) {
    const L = regionLoudness(r.blocks, it.start, it.end);
    v = L == null ? 0 : clamp(TARGET_LUFS - L, -MAX_AUTO_DB, MAX_AUTO_DB);
    if (S.levelCache.size > 600) S.levelCache.clear();
    S.levelCache.set(key, v);
  }
  return v;
}
const clipGain = it => dbToGain(autoDb(it) + (it.gain || 0));

function replan() {
  S.plan = layout(S.project);
  for (const e of S.plan.entries) if (e.it.kind === 'clip') e.gain = clipGain(e.it);
  S.mixPos = Math.min(S.mixPos, S.plan.total);
  return S.plan;
}

function snapshot() {
  const p = S.project;
  return JSON.stringify({ items: p.items, fadeIn: p.fadeIn, fadeOut: p.fadeOut, limit: p.limit });
}
function remember() {
  S.history.push(snapshot());
  if (S.history.length > 80) S.history.shift();
  updateUndo();
}
function undo() {
  const snap = S.history.pop();
  updateUndo();
  if (!snap) return;
  Object.assign(S.project, JSON.parse(snap));
  if (S.ed && !itemOf(S.ed.id)) { closeEditor(); }
  afterChange(true);
  if (S.ed) { renderEdControls(); drawEditor(); }
  toast('Undone');
}
function updateUndo() {
  const off = !S.history.length;
  $('#undoBtn').classList.toggle('off', off);
  $('#edUndo')?.classList.toggle('off', off);
}

// After any edit: work out the timeline again, save, and redraw what changed.
function afterChange(structure = true) {
  replan();
  save();
  if (structure) renderList();
  else for (const id of S.cards.keys()) drawCard(id);
  renderMeter();
  renderPlayerBar();
  if (player.mode === 'mix') restartMix();
}

/* ---------------- saving ---------------- */

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  setSaveState('saving');
  saveTimer = setTimeout(flushSave, 400);
}
async function flushSave() {
  clearTimeout(saveTimer);
  const p = S.project;
  if (!p) return;
  p.updated = Date.now();
  try {
    await store.putProject(JSON.parse(JSON.stringify(p)));
    const missing = p.sources.some(s => rtOf(s.id).status === 'missing');
    const failed = p.sources.some(s => s.saved === false);
    const busy = p.sources.some(s => s.saved === undefined);
    setSaveState(missing ? 'missing' : failed ? 'partial' : busy ? 'saving' : 'saved');
  } catch {
    setSaveState('error');
  }
}
function setSaveState(kind) {
  const el = $('#saveState');
  el.classList.toggle('bad', kind === 'error' || kind === 'partial' || kind === 'missing');
  el.textContent = {
    saving: 'Saving…',
    saved: 'Saved on this phone',
    partial: "Some files couldn't be saved on this phone",
    missing: 'Some files need adding again',
    error: "Couldn't save. Phone storage may be full",
  }[kind] || '';
}
function saveBlob(src, file) {
  src.saved = undefined;
  store.putBlob(src.id, file).then(() => { src.saved = true; save(); }).catch(() => {
    src.saved = false; save();
    toast(`Couldn't keep “${src.name}” on this phone. It works until you close the app.`);
  });
}
const saveSettings = () => store.set('settings', S.settings).catch(() => {});

/* ---------------- opening mixes and reading files ---------------- */

async function openProject(p, isNew = false) {
  stopAll();
  for (const r of S.rt.values()) if (r.url) URL.revokeObjectURL(r.url);
  S.rt.clear(); S.heads.clear(); S.history = []; S.mixPos = 0; S.pending = [];
  S.project = p;
  // files no clip uses any more are dropped
  const used = new Set(p.items.filter(i => i.kind === 'clip').map(i => i.src));
  const unused = p.sources.filter(s => !used.has(s.id));
  if (unused.length) {
    p.sources = p.sources.filter(s => used.has(s.id));
    unused.forEach(s => store.deleteBlob(s.id).catch(() => {}));
  }
  for (const s of p.sources) rtOf(s.id).status = 'loading';
  store.set('last', p.id).catch(() => {});
  if (isNew || unused.length) save(); else setSaveState('saved');
  renderAll();
  for (const src of p.sources) {
    let blob = null;
    try { blob = await store.getBlob(src.id); } catch {}
    if (S.project !== p) return;
    if (!blob) { rtOf(src.id).status = 'missing'; refreshSource(src.id); setSaveState('missing'); continue; }
    src.saved = true;
    enqueueDecode(src, blob);
  }
}

let queue = Promise.resolve();
function enqueueDecode(src, blob, after) {
  const r = rtOf(src.id);
  r.status = 'loading';
  const proj = S.project;
  queue = queue
    .then(() => (S.project === proj ? decodeSource(src, blob) : null))
    .then(() => after && after())
    .catch(err => console.error(err));
  return queue;
}

async function decodeSource(src, blob) {
  const r = rtOf(src.id);
  const proj = S.project;
  try {
    if (src.kind === 'video') {
      if (r.url) URL.revokeObjectURL(r.url);
      r.url = URL.createObjectURL(blob);
      if (!src.width) {
        Object.assign(src, await videoMeta(r.url));
        if (!src.width) { src.kind = 'audio'; URL.revokeObjectURL(r.url); r.url = null; }
      }
    }
    const ctx = player.context();
    const ab = await blob.arrayBuffer();
    relabelQuickTime(ab);
    let buf;
    try {
      buf = await decodeAudio(ctx, ab);
    } catch (err) {
      if (src.kind !== 'video' || !src.vdur) throw err;
      // a video with no sound: silence for its whole length
      buf = ctx.createBuffer(1, Math.max(1, Math.round(src.vdur * ctx.sampleRate)), ctx.sampleRate);
      src.silent = true;
    }
    r.buffer = buf;
    r.peaks = computePeaks(buf);
    let pm = 0;
    for (let i = 0; i < r.peaks.length; i++) if (r.peaks[i] > pm) pm = r.peaks[i];
    r.peakMax = pm || 1;
    r.blocks = loudnessBlocks(buf);
    src.duration = buf.duration;
    r.status = 'ready';
  } catch (err) {
    console.warn('could not read', src.name, err);
    r.status = 'error';
  }
  if (S.project === proj) refreshSource(src.id);
}

function videoMeta(url) {
  return new Promise(resolve => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'metadata';
    let t = 0;
    const done = res => { clearTimeout(t); v.removeAttribute('src'); v.load(); resolve(res); };
    t = setTimeout(() => done({}), 10000);
    v.onloadedmetadata = () => done({ width: v.videoWidth, height: v.videoHeight, vdur: isFinite(v.duration) ? v.duration : 0 });
    v.onerror = () => done({});
    v.src = url;
  });
}

function refreshSource(srcId) {
  if (S.project.items.some(i => i.src === srcId)) {
    replan();
    renderList();
    renderMeter();
    renderPlayerBar();
  }
}

function pickFiles(kind) {
  const inp = $(kind === 'video' ? '#videoPick' : '#songPick');
  inp.value = '';
  inp.click();
}

function addFiles(files) {
  if (!files.length) return;
  try { navigator.storage?.persist?.().catch(() => {}); } catch {}
  const p = S.project;
  for (const f of files) {
    // the same file picked again reuses the copy already in this mix
    let src = p.sources.find(s => s.name === f.name && s.size === f.size && s.lastModified === f.lastModified);
    if (src && rtOf(src.id).status === 'ready') { addClipFor(src); continue; }
    if (!src) {
      src = { id: uid(), name: f.name, kind: isVideoFile(f) ? 'video' : 'audio', type: f.type, size: f.size, lastModified: f.lastModified, duration: 0 };
      p.sources.push(src);
      saveBlob(src, f);
    }
    const key = uid();
    S.pending.push({ key, name: f.name });
    enqueueDecode(src, f, () => {
      S.pending = S.pending.filter(x => x.key !== key);
      if (S.project !== p) return;
      if (rtOf(src.id).status === 'ready') {
        addClipFor(src);
      } else {
        toast(`Couldn't read the sound in “${f.name}”.`);
        if (!p.items.some(i => i.src === src.id)) {
          p.sources = p.sources.filter(s => s !== src);
          store.deleteBlob(src.id).catch(() => {});
        }
        renderList();
      }
    });
  }
  renderList();
  scrollListToEnd();
}

function addClipFor(src) {
  remember();
  S.project.items.push({ id: uid(), kind: 'clip', src: src.id, start: 0, end: src.duration, gain: 0, fadeIn: 0, fadeOut: 0, xfade: newXfade() });
  afterChange(true);
  scrollListToEnd();
}

function addGap() {
  remember();
  S.project.items.push({ id: uid(), kind: 'gap', dur: 2 });
  afterChange(true);
  scrollListToEnd();
}

function removeItem(id) {
  const items = S.project.items;
  const i = items.findIndex(x => x.id === id);
  if (i < 0) return;
  if (player.key === id) stopAll();
  remember();
  const [it] = items.splice(i, 1);
  afterChange(true);
  toast(it.kind === 'gap' ? 'Silence removed' : 'Clip removed', 'Undo', undo);
}

function duplicateItem(id) {
  const items = S.project.items;
  const i = items.findIndex(x => x.id === id);
  if (i < 0) return;
  remember();
  items.splice(i + 1, 0, { ...items[i], id: uid(), xfade: newXfade() });
  afterChange(true);
}

function adjustGap(id, dir) {
  const it = itemOf(id);
  if (!it) return;
  remember();
  it.dur = clamp(Math.round((it.dur + dir * GAP_STEP) * 10) / 10, GAP_STEP, GAP_MAX);
  afterChange(true);
}

let relinkSrc = null;
function relink(srcId) {
  relinkSrc = srcId;
  const inp = $('#relinkPick');
  inp.value = '';
  inp.click();
}
function onRelink(f) {
  const src = relinkSrc && srcOf(relinkSrc);
  if (!f || !src) return;
  Object.assign(src, { name: f.name, size: f.size, lastModified: f.lastModified, type: f.type, width: 0 });
  saveBlob(src, f);
  enqueueDecode(src, f, () => {
    if (rtOf(src.id).status !== 'ready') return;
    for (const it of S.project.items) {
      if (it.src !== src.id) continue;
      it.end = Math.min(it.end, src.duration);
      it.start = Math.min(it.start, Math.max(0, it.end - MIN_CLIP));
    }
    afterChange(true);
  });
  renderList();
}

function scrollListToEnd() {
  requestAnimationFrame(() => { const l = $('#list'); l.scrollTop = l.scrollHeight; });
}

/* ---------------- drawing waveforms ---------------- */

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = n => cs.getPropertyValue(n).trim();
  S.colors = { waveOn: v('--wave-on'), waveOff: v('--wave-off'), handle: v('--handle'), grip: v('--grip'), head: v('--head'), text: v('--text') };
}

function fillRound(g, x, y, w, h, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h);
  g.fill();
}

// o: { peaks, peakMax, v0, v1 (visible seconds), s, e (selection), head, handleW, pad, bar, gapPx, window }
function drawWave(cv, o) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const C = S.colors;
  const hw = o.handleW || 0;
  const pad = o.pad ?? hw;
  const inner = w - 2 * pad;
  const span = Math.max(1e-6, o.v1 - o.v0);
  const X = t => pad + (t - o.v0) / span * inner;
  const bar = o.bar || 2, step = bar + (o.gapPx ?? 1.5);
  const mid = h / 2, amp = h / 2 - (hw ? 7 : 3);
  const peaks = o.peaks, pm = o.peakMax || 1;
  for (let x = pad; x < pad + inner - 0.5; x += step) {
    const t0 = o.v0 + (x - pad) / inner * span, t1 = t0 + step / inner * span;
    const a = Math.max(0, Math.floor(t0 * PEAKS_PER_SEC));
    const b = Math.min(peaks.length, Math.max(a + 1, Math.ceil(t1 * PEAKS_PER_SEC)));
    let m = 0;
    for (let i = a; i < b; i++) if (peaks[i] > m) m = peaks[i];
    const bh = Math.max(1, Math.pow(m / pm, 0.7) * amp);
    const tc = (t0 + t1) / 2;
    g.fillStyle = tc >= o.s && tc <= o.e ? C.waveOn : C.waveOff;
    g.fillRect(x, mid - bh, bar, bh * 2);
  }
  if (hw) {
    const sx = X(o.s), ex = X(o.e);
    g.fillStyle = C.handle;
    // a frame along the top and bottom of the selection, like the iPhone's own trimmer
    if (ex > sx) { g.fillRect(sx, 0, ex - sx, 3); g.fillRect(sx, h - 3, ex - sx, 3); }
    fillRound(g, sx - hw, 0, hw, h, [7, 0, 0, 7]);
    fillRound(g, ex, 0, hw, h, [0, 7, 7, 0]);
    g.fillStyle = C.grip;
    fillRound(g, sx - hw / 2 - 1.25, mid - 10, 2.5, 20, 1.25);
    fillRound(g, ex + hw / 2 - 1.25, mid - 10, 2.5, 20, 1.25);
  }
  if (o.window) {
    const a = X(o.window[0]), b = X(o.window[1]);
    g.strokeStyle = C.text; g.lineWidth = 2;
    g.strokeRect(a + 1, 1, Math.max(4, b - a - 2), h - 2);
  }
  if (o.head != null && o.head >= o.v0 - 1e-6 && o.head <= o.v1 + 1e-6) {
    g.fillStyle = C.head;
    g.fillRect(X(o.head) - 1.25, 0, 2.5, h);
  }
}

// Touch handling for a waveform: drag a handle to trim, drag anywhere else to move the playhead,
// pinch to zoom (editor only).
function attachWave(cv, o) {
  const pts = new Map();
  let g = null;
  const geo = () => {
    const r = cv.getBoundingClientRect();
    const { v0, v1 } = o.view();
    const pad = o.handleW, inner = r.width - 2 * pad;
    return { r, v0, v1, pad, inner, tAt: x => v0 + (x - pad) / inner * (v1 - v0), xOf: t => pad + (t - v0) / (v1 - v0) * inner };
  };
  cv.addEventListener('pointerdown', e => {
    const it = itemOf(o.id());
    if (!it || rtOf(it.src).status !== 'ready') return;
    pts.set(e.pointerId, e.clientX);
    try { cv.setPointerCapture(e.pointerId); } catch {}
    if (pts.size === 2 && o.pinch) { if (g) g.end(false); g = pinch(); return; }
    if (pts.size === 1) g = single(e, it);
  });
  cv.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, e.clientX);
    if (g) g.move(e);
  });
  const finish = (e, cancel) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (!g) return;
    if (!g.isPinch || pts.size < 2) { g.end(cancel); g = null; }
  };
  cv.addEventListener('pointerup', e => finish(e, false));
  cv.addEventListener('pointercancel', e => finish(e, true));
  cv.addEventListener('lostpointercapture', e => finish(e, false));

  function single(e, it) {
    const G = geo();
    const dur = srcOf(it.src).duration;
    const x0 = e.clientX - G.r.left;
    const hw = o.handleW, hit = o.hit;
    const dS = Math.abs(x0 - (G.xOf(it.start) - hw / 2));
    const dE = Math.abs(x0 - (G.xOf(it.end) + hw / 2));
    const mode = Math.min(dS, dE) <= hit ? (dS <= dE ? 'start' : 'end') : 'scrub';
    const orig = { start: it.start, end: it.end };
    const origHead = o.getHead();
    const grab = mode === 'start' ? orig.start - G.tAt(x0) : mode === 'end' ? orig.end - G.tAt(x0) : 0;
    let moved = false, lastX = x0, panRaf = 0;
    if (mode === 'scrub') {
      const t = clamp(G.tAt(x0), 0, dur);
      o.setHead(t); o.redraw(); o.onScrub && o.onScrub(t, false);
    }
    const setHandle = x => {
      const t = geo().tAt(x) + grab;
      if (mode === 'start') it.start = clamp(t, 0, it.end - MIN_CLIP);
      else it.end = clamp(t, it.start + MIN_CLIP, dur);
      o.redraw();
    };
    // editor: keep scrolling the zoomed view while the finger rests near an edge
    const edgePan = () => {
      panRaf = 0;
      const G2 = geo(), edge = 30;
      const dir = lastX < G2.pad + edge ? -1 : lastX > G2.r.width - G2.pad - edge ? 1 : 0;
      if (!dir) return;
      o.pan(dir * (G2.v1 - G2.v0) * 0.012);
      setHandle(lastX);
      panRaf = requestAnimationFrame(edgePan);
    };
    return {
      move(ev) {
        const x = ev.clientX - G.r.left;
        lastX = x;
        if (mode === 'scrub') {
          const t = clamp(geo().tAt(x), 0, dur);
          o.setHead(t); o.redraw(); o.onScrub && o.onScrub(t, true);
          return;
        }
        if (!moved) {
          if (Math.abs(x - x0) < 3) return;
          moved = true;
          remember();
        }
        setHandle(x);
        if (o.pan && !panRaf) panRaf = requestAnimationFrame(edgePan);
      },
      end(cancel) {
        cancelAnimationFrame(panRaf); panRaf = 0;
        if (mode === 'scrub') {
          if (cancel) { o.setHead(origHead); o.redraw(); }
          else if (o.onScrub) o.onScrub(o.getHead(), false, true);
          return;
        }
        if (!moved) return;
        if (cancel) {
          it.start = orig.start; it.end = orig.end;
          S.history.pop(); updateUndo(); o.redraw();
          return;
        }
        // put the playhead where tapping play lets her hear the new cut
        o.setHead(mode === 'start' ? it.start : Math.max(it.start, it.end - 3));
        afterChange(false);
        o.redraw();
      },
    };
  }

  function pinch() {
    const G = geo();
    const [a, b] = [...pts.values()];
    const d0 = Math.max(12, Math.abs(a - b));
    const tc = G.tAt((a + b) / 2 - G.r.left);
    const span0 = G.v1 - G.v0;
    return {
      isPinch: true,
      move() {
        const [p, q] = [...pts.values()];
        if (q === undefined) return;
        const d = Math.max(12, Math.abs(p - q));
        o.zoomTo(span0 * d0 / d, tc, ((p + q) / 2 - G.r.left - G.pad) / G.inner);
      },
      end() {},
    };
  }
}

/* ---------------- the clip list ---------------- */

function renderAll() {
  $('#mixName').textContent = S.project.name;
  replan();
  renderList();
  renderMeter();
  renderPlayerBar();
  updateUndo();
  updateTransport();
}

function edgeChip(which) {
  const v = which === 'in' ? S.plan.fadeIn : S.plan.fadeOut;
  const label = which === 'in' ? 'Fade in at start' : 'Fade out at end';
  return `<button class="join ${v > 0 ? 'set' : ''}" data-act="mixfade" data-which="${which}">${icon('fade')}${label} · ${secs(v)}</button>`;
}

function itemHtml(it, prev, e) {
  const grip = `<span class="grip" aria-label="Drag to move">${icon('grip')}</span>`;
  if (it.kind === 'gap') {
    return `<div class="item" data-id="${it.id}"><div class="card gap-card">${grip}<span class="name">Silence</span>
      <div class="stepper"><button data-act="gap" data-d="-1" aria-label="Shorter silence">−</button><output>${secs(it.dur)}</output><button data-act="gap" data-d="1" aria-label="Longer silence">+</button></div>
      <button class="icon-btn danger" data-act="del" aria-label="Remove silence">${icon('trash')}</button></div></div>`;
  }
  const src = srcOf(it.src), r = rtOf(it.src);
  const x = e ? e.x : 0;
  const join = prev && prev.kind === 'clip'
    ? `<button class="join ${x > 0 ? 'set' : ''}" data-act="xfade">${icon('fade')}Fade ${secs(Math.round(x * 100) / 100)}</button>` : '';
  let body;
  if (r.status === 'ready') {
    body = `<canvas class="wave"></canvas><div class="card-bottom"><button class="play-btn" data-act="play" aria-label="Play this clip">${icon('play')}</button><span class="t-start"></span>${src.silent ? '<span class="badge">No sound</span>' : ''}<span class="lvl"></span><span class="t-end"></span></div>`;
  } else if (r.status === 'missing') {
    body = `<div class="card-msg bad">This file isn't saved on this phone any more.<button class="small-btn" data-act="relink">Find the file</button><button class="small-btn" data-act="del">Remove</button></div>`;
  } else if (r.status === 'error') {
    body = `<div class="card-msg bad">Couldn't read the sound in this file.<button class="small-btn" data-act="del">Remove</button></div>`;
  } else {
    body = '<div class="card-msg"><span class="spinner"></span>Reading the sound…</div>';
  }
  return `<div class="item" data-id="${it.id}">${join}<div class="card"><div class="card-top">${grip}<span class="kind">${icon(src.kind === 'video' ? 'video' : 'music')}</span><span class="name">${esc(src.name)}</span><span class="len"></span><button class="edit-btn" data-act="edit" aria-label="Edit clip">${icon('scissors')}Edit</button></div>${body}</div></div>`;
}

function renderList() {
  const list = $('#list');
  const p = S.project;
  S.cards.clear();
  nowId = null;
  if (!p.items.length && !S.pending.length) {
    list.innerHTML = `<div class="empty"><div class="empty-ic">${icon('music')}</div><h2>Start your mix</h2>
      <p>Pick songs or videos from your phone. You can use the same file more than once to take different parts.</p>
      <button class="wide primary" data-act="add-songs">${icon('music')}Add songs</button>
      <button class="wide" data-act="add-videos">${icon('video')}Add videos</button>
      <button class="wide quiet" data-act="intro">${icon('info')}How it works</button></div>`;
    return;
  }
  const entryOf = new Map(S.plan.entries.map(e => [e.it.id, e]));
  const hasClips = p.items.some(i => i.kind === 'clip');
  const out = [];
  if (hasClips) out.push(edgeChip('in'));
  p.items.forEach((it, i) => out.push(itemHtml(it, p.items[i - 1], entryOf.get(it.id))));
  for (const pd of S.pending) out.push(`<div class="item"><div class="card"><div class="card-msg"><span class="spinner"></span>Reading “${esc(pd.name)}”…</div></div></div>`);
  if (hasClips) out.push(edgeChip('out'));
  out.push(`<div class="list-foot"><button class="wide" data-act="add-songs">${icon('music')}Songs</button><button class="wide" data-act="add-videos">${icon('video')}Videos</button><button class="wide" data-act="add-gap">${icon('silence')}Silence</button></div>`);
  list.innerHTML = out.join('');
  $$('.item[data-id]', list).forEach(bindItem);
  for (const id of S.cards.keys()) drawCard(id);
  markNow();
}

function bindItem(el) {
  const id = el.dataset.id;
  const it = itemOf(id);
  const grip = $('.grip', el);
  if (grip) grip.addEventListener('pointerdown', e => startReorder(e, el));
  if (!it || it.kind !== 'clip') return;
  const cv = $('canvas.wave', el);
  S.cards.set(id, { el, card: $('.card', el), cv, len: $('.len', el), start: $('.t-start', el), end: $('.t-end', el), lvl: $('.lvl', el), play: $('.play-btn', el), playing: null });
  if (cv) {
    attachWave(cv, {
      id: () => id,
      view: () => ({ v0: 0, v1: srcOf(itemOf(id).src).duration }),
      handleW: CARD_HANDLE, hit: 26,
      getHead: () => S.heads.get(id),
      setHead: t => S.heads.set(id, t),
      redraw: () => drawCard(id),
      onScrub: (t, dragging, final) => { if (player.mode === 'clip' && player.key === id) scrubRestart(id, t, final); },
    });
  }
}

function drawCard(id) {
  const c = S.cards.get(id), it = itemOf(id);
  if (!c || !it) return;
  c.len.textContent = fmtTime(it.end - it.start);
  const r = rtOf(it.src);
  if (!c.cv || !r.peaks) return;
  drawWave(c.cv, { peaks: r.peaks, peakMax: r.peakMax, v0: 0, v1: srcOf(it.src).duration, s: it.start, e: it.end, head: S.heads.get(id), handleW: CARD_HANDLE });
  c.start.textContent = `Start ${fmtTime(it.start)}`;
  c.end.textContent = `End ${fmtTime(it.end)}`;
  const g = it.gain || 0;
  const lvl = g ? `<span class="badge">${dbText(g)} dB</span>` : '';
  if (c.lvl.innerHTML !== lvl) c.lvl.innerHTML = lvl;
  const on = player.mode === 'clip' && player.key === id;
  if (c.playing !== on) {
    c.playing = on;
    c.play.classList.toggle('on', on);
    c.play.innerHTML = icon(on ? 'pause' : 'play');
    c.play.setAttribute('aria-label', on ? 'Pause' : 'Play this clip');
  }
}

let nowId = null;
function markNow() {
  let id = null;
  if (player.mode === 'mix') {
    for (const e of S.plan.entries) if (e.it.kind === 'clip' && S.mixPos >= e.t0 && S.mixPos < e.t1) id = e.it.id;
  }
  if (id === nowId) return;
  if (nowId) S.cards.get(nowId)?.card.classList.remove('now');
  nowId = id;
  if (id) S.cards.get(id)?.card.classList.add('now');
}

// Drag ⋮⋮ to move a clip up or down.
function startReorder(e, el) {
  e.preventDefault();
  e.stopPropagation();
  const list = $('#list');
  const els = $$('.item[data-id]', list);
  const idx = els.indexOf(el);
  if (idx < 0) return;
  const grip = e.currentTarget;
  try { grip.setPointerCapture(e.pointerId); } catch {}
  const rects = els.map(x => x.getBoundingClientRect());
  const spacing = idx + 1 < rects.length ? rects[idx + 1].top - rects[idx].bottom : idx > 0 ? rects[idx].top - rects[idx - 1].bottom : 0;
  const h = rects[idx].height + Math.max(0, spacing);
  const startY = e.clientY, startScroll = list.scrollTop;
  let lastY = startY, target = idx, raf = 0;
  el.classList.add('dragging');
  els.forEach((x, j) => { if (j !== idx) x.classList.add('shift'); });
  const update = () => {
    const dy = lastY - startY + (list.scrollTop - startScroll);
    el.style.transform = `translateY(${dy}px)`;
    const c = rects[idx].top + rects[idx].height / 2 + dy;
    target = idx;
    for (let j = 0; j < idx; j++) if (c < rects[j].top + rects[j].height / 2) { target = j; break; }
    if (target === idx) for (let j = els.length - 1; j > idx; j--) if (c > rects[j].top + rects[j].height / 2) { target = j; break; }
    els.forEach((x, j) => {
      if (j === idx) return;
      let s = 0;
      if (target > idx && j > idx && j <= target) s = -h;
      if (target < idx && j >= target && j < idx) s = h;
      x.style.transform = s ? `translateY(${s}px)` : '';
    });
  };
  const loop = () => {
    const lr = list.getBoundingClientRect();
    let v = 0;
    if (lastY < lr.top + 70) v = -Math.ceil((lr.top + 70 - lastY) / 6);
    else if (lastY > lr.bottom - 70) v = Math.ceil((lastY - (lr.bottom - 70)) / 6);
    if (v) list.scrollTop += v;
    update();
    raf = requestAnimationFrame(loop);
  };
  const move = ev => { lastY = ev.clientY; };
  const done = () => {
    cancelAnimationFrame(raf);
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', done);
    grip.removeEventListener('pointercancel', done);
    els.forEach(x => { x.classList.remove('dragging', 'shift'); x.style.transform = ''; });
    if (target !== idx) {
      remember();
      const items = S.project.items;
      const [it] = items.splice(idx, 1);
      items.splice(target, 0, it);
      afterChange(true);
    }
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', done);
  grip.addEventListener('pointercancel', done);
  raf = requestAnimationFrame(loop);
}

/* ---------------- length meter and mix player ---------------- */

function renderMeter() {
  const total = S.plan.total, lim = S.project.limit;
  const m = $('#meter');
  if (!lim) {
    m.innerHTML = `<div class="m-row"><span>Mix length <b>${fmtTime(total, 0)}</b></span><span class="m-link">Set a time limit</span></div>`;
    return;
  }
  const max = Math.max(total, lim) || 1;
  const over = total > lim + 0.05;
  const left = over ? `${fmtTime(total - lim, 0)} over` : `${fmtTime(lim - total, 0)} left`;
  m.innerHTML = `<div class="m-row"><span>Mix length <b>${fmtTime(total, 0)}</b> of ${fmtTime(lim, 0)} limit</span><span class="m-left ${over ? 'over' : ''}">${left}</span></div>
    <div class="m-bar"><div class="m-fill ${over ? 'over' : ''}" style="width:${(total / max) * 100}%"></div><div class="m-limit" style="left:${(lim / max) * 100}%"></div></div>`;
}

function renderPlayerBar() {
  const p = S.plan;
  let k = 0;
  $('#segs').innerHTML = p.total ? p.entries.map(e => {
    const l = (e.t0 / p.total) * 100, w = ((e.t1 - e.t0) / p.total) * 100;
    const cls = e.it.kind === 'gap' ? 'gapseg' : k++ % 2 ? 'alt' : '';
    return `<div class="seg ${cls}" style="left:${l}%;width:${w}%"></div>`;
  }).join('') : '';
  $('#mixTotal').textContent = fmtTime(p.total, 0);
  renderHead();
}

function renderHead() {
  const p = S.plan;
  $('#mixHead').style.left = `${p.total ? (S.mixPos / p.total) * 100 : 0}%`;
  $('#mixPos').textContent = fmtTime(S.mixPos);
}

function setIcon(el, name) {
  if (el.dataset.ic === name) return;
  el.dataset.ic = name;
  el.innerHTML = icon(name);
}

function updateTransport() {
  const mixOn = player.mode === 'mix';
  setIcon($('#mixPlay'), mixOn ? 'pause' : 'play');
  $('#mixPlay').setAttribute('aria-label', mixOn ? 'Pause' : 'Play the mix');
  for (const id of S.cards.keys()) drawCard(id);
  if (S.ed) setIcon($('#edPlay'), player.mode === 'clip' && player.key === S.ed.id ? 'pause' : 'play');
  markNow();
}

function stopAll() {
  player.halt();
  const v = $('#edVideo');
  if (v && !v.paused) v.pause();
  updateTransport();
}

function toggleMix() {
  if (player.mode === 'mix') { stopAll(); return; }
  const p = replan();
  if (!p.total) { toast('Add a clip first.'); return; }
  player.unlock();
  if ($('#edVideo') && !$('#edVideo').paused) $('#edVideo').pause();
  let from = S.mixPos;
  if (from >= p.total - 0.05) from = 0;
  player.playMix(p, getBuf, from);
  updateTransport();
}

let restartTimer = 0;
function restartMix() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    if (player.mode === 'mix') player.playMix(S.plan, getBuf, player.pos(), player.stopAt);
  }, 120);
}

let lastSeek = 0;
function seekMix(t, final) {
  S.mixPos = clamp(t, 0, S.plan.total);
  renderHead();
  if (player.mode === 'mix') {
    const now = performance.now();
    if (final || now - lastSeek > 150) {
      lastSeek = now;
      player.playMix(S.plan, getBuf, S.mixPos);
    }
  }
  markNow();
}

function bindScrub() {
  const el = $('#mixScrub');
  let active = false;
  const tAt = x => { const r = el.getBoundingClientRect(); return clamp((x - r.left) / r.width, 0, 1) * S.plan.total; };
  el.addEventListener('pointerdown', e => {
    if (!S.plan.total) return;
    active = true;
    try { el.setPointerCapture(e.pointerId); } catch {}
    seekMix(tAt(e.clientX), false);
  });
  el.addEventListener('pointermove', e => { if (active) seekMix(tAt(e.clientX), false); });
  el.addEventListener('pointerup', e => { if (active) { active = false; seekMix(tAt(e.clientX), true); } });
  el.addEventListener('pointercancel', () => { active = false; });
}

/* ---------------- playing one clip ---------------- */

function startClip(id, from) {
  const it = itemOf(id);
  if (!it) return;
  const r = rtOf(it.src);
  if (r.status !== 'ready') return;
  const dur = srcOf(it.src).duration;
  const loop = !!(S.ed && S.ed.id === id && S.ed.loop);
  if (from == null || from >= dur - 0.05 || Math.abs(from - it.end) < 0.05) from = it.start;
  if (loop && (from < it.start || from >= it.end)) from = it.start;
  const to = from < it.end ? it.end : dur;
  player.playClip({ buffer: r.buffer, from, to, level: clipGain(it), key: id, loop, loopStart: it.start, loopEnd: it.end });
  S.heads.set(id, from);
  if (S.ed && S.ed.id === id) { S.ed.head = from; syncVideo(true); }
  updateTransport();
}

function toggleClip(id) {
  if (player.mode === 'clip' && player.key === id) { stopAll(); return; }
  player.unlock();
  startClip(id, S.heads.get(id));
}

let lastScrub = 0;
function scrubRestart(id, t, final) {
  const now = performance.now();
  if (!final && now - lastScrub < 150) return;
  lastScrub = now;
  startClip(id, t);
}

/* ---------------- editor ---------------- */

const edItem = () => (S.ed ? itemOf(S.ed.id) : null);
const edDur = () => srcOf(edItem().src).duration;

function selectionView(it, dur) {
  const len = it.end - it.start;
  const m = Math.max(len * 0.25, 1.5);
  const v0 = Math.max(0, it.start - m), v1 = Math.min(dur, it.end + m);
  return v1 - v0 >= Math.min(MIN_SPAN, dur) ? [v0, v1] : [0, dur];
}

function openEditor(id) {
  const it = itemOf(id);
  if (!it || it.kind !== 'clip') return;
  const src = srcOf(it.src), r = rtOf(it.src);
  if (r.status !== 'ready') { toast('This file is still loading.'); return; }
  stopAll();
  const dur = src.duration;
  const [v0, v1] = it.end - it.start < dur * 0.6 ? selectionView(it, dur) : [0, dur];
  S.ed = { id, v0, v1, head: it.start, loop: false, video: src.kind === 'video' && !!r.url };
  const clips = S.project.items.filter(i => i.kind === 'clip');
  $('#edTitle').textContent = `Clip ${clips.indexOf(it) + 1} of ${clips.length}`;
  $('#edFile').textContent = src.name;
  const v = $('#edVideo');
  $('#edVideoBox').hidden = !S.ed.video;
  $('#editor').classList.toggle('audio-only', !S.ed.video);
  if (S.ed.video) {
    v.addEventListener('loadedmetadata', () => { if (S.ed) seekVideo(S.ed.head); }, { once: true });
    v.src = r.url;
    v.load();
  }
  $('#editor').hidden = false;
  $('#editor .scr-body').scrollTop = 0;
  updateUndo();
  renderEdControls();
  drawEditor();
  updateTransport();
}

function closeEditor() {
  stopAll();
  const v = $('#edVideo');
  v.pause();
  v.removeAttribute('src');
  v.load();
  S.ed = null;
  $('#editor').hidden = true;
  renderList();
  renderMeter();
  renderPlayerBar();
}

function renderEdControls() {
  const it = edItem();
  if (!it) return;
  $('#edStart').textContent = fmtTime(it.start);
  $('#edEnd').textContent = fmtTime(it.end);
  const g = it.gain || 0;
  $('#edLevel').value = g;
  $('#edLevelVal').textContent = g === 0 ? 'Normal' : g > 0 ? `${dbText(g)} dB louder` : `${dbText(g)} dB quieter`;
  const a = Math.round(autoDb(it));
  $('#edAuto').textContent = !S.settings.autoLevel ? 'Auto level is off (Settings)'
    : a > 0 ? `Auto level adds ${a} dB to match the other clips`
    : a < 0 ? `Auto level lowers it ${-a} dB to match the other clips`
    : 'Auto level: no change needed';
  $$('#editor [data-fade]').forEach(st => { $('output', st).textContent = secs(it[st.dataset.fade] || 0); });
  $('#edLoop').setAttribute('aria-pressed', String(!!S.ed.loop));
}

function drawEditor() {
  const ed = S.ed, it = edItem();
  if (!ed || !it) return;
  const src = srcOf(it.src), r = rtOf(it.src);
  if (!r.peaks) return;
  drawWave($('#edWave'), { peaks: r.peaks, peakMax: r.peakMax, v0: ed.v0, v1: ed.v1, s: it.start, e: it.end, head: ed.head, handleW: ED_HANDLE, bar: 2, gapPx: 1 });
  const zoomed = ed.v1 - ed.v0 < src.duration - 0.01;
  drawWave($('#edOver'), { peaks: r.peaks, peakMax: r.peakMax, v0: 0, v1: src.duration, s: it.start, e: it.end, head: ed.head, pad: 0, bar: 1.5, gapPx: 0.5, window: zoomed ? [ed.v0, ed.v1] : null });
  $('#edHead').textContent = `Playhead ${fmtTime(ed.head)}`;
  $('#edSel').textContent = `Selected ${fmtTime(it.end - it.start)}`;
}

function zoomTo(span, t, f) {
  const ed = S.ed, dur = edDur();
  span = clamp(span, Math.min(MIN_SPAN, dur), dur);
  const v0 = clamp(t - f * span, 0, dur - span);
  ed.v0 = v0; ed.v1 = v0 + span;
  drawEditor();
}
function panBy(dt) {
  const ed = S.ed, span = ed.v1 - ed.v0;
  const v0 = clamp(ed.v0 + dt, 0, edDur() - span);
  ed.v0 = v0; ed.v1 = v0 + span;
}
function showTime(t) {
  const ed = S.ed, span = ed.v1 - ed.v0;
  if (t < ed.v0 || t > ed.v1) { const v0 = clamp(t - span / 2, 0, edDur() - span); ed.v0 = v0; ed.v1 = v0 + span; }
}
function followHead() {
  const ed = S.ed, span = ed.v1 - ed.v0;
  if (ed.head > ed.v1 || ed.head < ed.v0) { const v0 = clamp(ed.head - span * 0.1, 0, edDur() - span); ed.v0 = v0; ed.v1 = v0 + span; }
}

let pendingSeek = null;
function seekVideo(t) {
  const v = $('#edVideo');
  if (!S.ed || !S.ed.video || v.readyState < 1) return;
  if (v.seeking) { pendingSeek = t; return; }
  if (Math.abs(v.currentTime - t) > 0.01) v.currentTime = t;
}
function syncVideo(playing) {
  const v = $('#edVideo');
  if (!S.ed || !S.ed.video) return;
  const t = S.ed.head;
  if (playing) {
    if (v.paused) { if (v.readyState >= 1) v.currentTime = t; v.play().catch(() => {}); }
    else if (!v.seeking && Math.abs(v.currentTime - t) > 0.2) v.currentTime = t;
  } else {
    if (!v.paused) v.pause();
    seekVideo(t);
  }
}

function edScrub(t, final) {
  S.ed.head = t;
  if (player.mode === 'clip' && player.key === S.ed.id) scrubRestart(S.ed.id, t, final);
  else seekVideo(t);
}

function toggleEdPlay() {
  if (!S.ed) return;
  if (player.mode === 'clip' && player.key === S.ed.id) { stopAll(); syncVideo(false); return; }
  player.unlock();
  startClip(S.ed.id, S.ed.head);
}

// Hold a button to keep stepping.
function repeatPress(btn, fn, done) {
  let t1 = 0, t2 = 0, active = false;
  const stop = () => {
    clearTimeout(t1); clearInterval(t2);
    if (active) { active = false; done(); }
  };
  btn.addEventListener('pointerdown', e => {
    e.preventDefault();
    active = true;
    fn(true);
    t1 = setTimeout(() => { t2 = setInterval(() => fn(false), 70); }, 420);
  });
  btn.addEventListener('pointerup', stop);
  btn.addEventListener('pointercancel', stop);
  btn.addEventListener('pointerleave', stop);
  btn.addEventListener('contextmenu', e => e.preventDefault());
}

function bindEditor() {
  $('#edDone').onclick = closeEditor;
  $('#edUndo').onclick = undo;
  $('#edDup').onclick = () => { duplicateItem(S.ed.id); toast('Copy added after this clip'); };
  $('#edDel').onclick = () => { const id = S.ed.id; closeEditor(); removeItem(id); };
  $('#edPlay').onclick = toggleEdPlay;
  $('#edVideo').addEventListener('click', toggleEdPlay);
  $('#edVideo').addEventListener('seeked', () => {
    if (pendingSeek != null) { const t = pendingSeek; pendingSeek = null; seekVideo(t); }
  });
  $('#edToStart').onclick = () => {
    const it = edItem();
    if (!it) return;
    S.ed.head = it.start;
    showTime(it.start);
    if (player.mode === 'clip' && player.key === S.ed.id) startClip(S.ed.id, it.start); else seekVideo(it.start);
    drawEditor();
  };
  $('#edLoop').onclick = () => {
    S.ed.loop = !S.ed.loop;
    renderEdControls();
    if (player.mode === 'clip' && player.key === S.ed.id) startClip(S.ed.id, player.pos());
  };
  $('#edZoomIn').onclick = () => { const ed = S.ed; const t = ed.head >= ed.v0 && ed.head <= ed.v1 ? ed.head : (ed.v0 + ed.v1) / 2; zoomTo((ed.v1 - ed.v0) / 2, t, (t - ed.v0) / (ed.v1 - ed.v0)); };
  $('#edZoomOut').onclick = () => { const ed = S.ed; const c = (ed.v0 + ed.v1) / 2; zoomTo((ed.v1 - ed.v0) * 2, c, 0.5); };
  $('#edFit').onclick = () => zoomTo(edDur(), 0, 0);
  $('#edSelZoom').onclick = () => { const [v0, v1] = selectionView(edItem(), edDur()); S.ed.v0 = v0; S.ed.v1 = v1; drawEditor(); };

  attachWave($('#edWave'), {
    id: () => (S.ed ? S.ed.id : null),
    view: () => ({ v0: S.ed.v0, v1: S.ed.v1 }),
    handleW: ED_HANDLE, hit: 30, pinch: true,
    getHead: () => S.ed.head,
    setHead: t => { S.ed.head = t; },
    redraw: () => { drawEditor(); renderEdControls(); },
    onScrub: (t, dragging, final) => edScrub(t, final),
    zoomTo, pan: panBy,
  });

  const over = $('#edOver');
  let overOn = false;
  const overMove = e => {
    const ed = S.ed;
    if (!ed) return;
    const r = over.getBoundingClientRect();
    const dur = edDur();
    const t = clamp((e.clientX - r.left) / r.width, 0, 1) * dur;
    const span = ed.v1 - ed.v0;
    if (span >= dur - 0.01) edScrub(t, true);
    else { const v0 = clamp(t - span / 2, 0, dur - span); ed.v0 = v0; ed.v1 = v0 + span; }
    drawEditor();
  };
  over.addEventListener('pointerdown', e => { if (!S.ed) return; overOn = true; try { over.setPointerCapture(e.pointerId); } catch {} overMove(e); });
  over.addEventListener('pointermove', e => { if (overOn) overMove(e); });
  over.addEventListener('pointerup', () => { overOn = false; });
  over.addEventListener('pointercancel', () => { overOn = false; });

  $$('#editor [data-nudge]').forEach(btn => {
    const which = btn.dataset.nudge, dir = +btn.dataset.dir;
    let changed = false;
    repeatPress(btn, first => {
      const it = edItem();
      if (!it) return;
      if (first) { remember(); changed = true; }
      const dur = edDur();
      if (which === 'start') it.start = clamp(Math.round((it.start + dir * NUDGE) * 100) / 100, 0, it.end - MIN_CLIP);
      else it.end = clamp(Math.round((it.end + dir * NUDGE) * 100) / 100, it.start + MIN_CLIP, dur);
      S.ed.head = which === 'start' ? it.start : Math.max(it.start, it.end - 2);
      showTime(which === 'start' ? it.start : it.end);
      renderEdControls();
      drawEditor();
      seekVideo(S.ed.head);
    }, () => { if (changed) { changed = false; afterChange(false); } });
  });
  $$('#editor [data-set]').forEach(btn => {
    btn.onclick = () => {
      const it = edItem(), t = S.ed.head;
      if (btn.dataset.set === 'start') {
        if (t > it.end - MIN_CLIP) { toast('The start has to be before the end.'); return; }
        remember(); it.start = Math.round(t * 100) / 100;
      } else {
        if (t < it.start + MIN_CLIP) { toast('The end has to be after the start.'); return; }
        remember(); it.end = Math.round(t * 100) / 100;
      }
      afterChange(false);
      renderEdControls();
      drawEditor();
    };
  });

  const lvl = $('#edLevel');
  let lvlTouched = false;
  lvl.addEventListener('input', () => {
    const it = edItem();
    if (!it) return;
    if (!lvlTouched) { remember(); lvlTouched = true; }
    it.gain = +lvl.value;
    renderEdControls();
  });
  lvl.addEventListener('change', () => {
    lvlTouched = false;
    afterChange(false);
    if (player.mode === 'clip' && player.key === S.ed.id) startClip(S.ed.id, player.pos());
  });
  $('#edLevelReset').onclick = () => {
    const it = edItem();
    if (!it || !it.gain) return;
    remember(); it.gain = 0;
    afterChange(false);
    renderEdControls();
    if (player.mode === 'clip' && player.key === S.ed.id) startClip(S.ed.id, player.pos());
  };
  $$('#editor [data-fade]').forEach(st => {
    st.addEventListener('click', e => {
      const b = e.target.closest('button');
      const it = edItem();
      if (!b || !it) return;
      const key = st.dataset.fade;
      const v = stepFade(it[key] || 0, +b.dataset.d);
      if (v === (it[key] || 0)) return;
      remember();
      it[key] = v;
      afterChange(false);
      renderEdControls();
    });
  });
}

/* ---------------- sheets ---------------- */

function openSheet(html, bind, { locked = false } = {}) {
  const body = $('#sheetBody');
  body.innerHTML = html;
  body.onclick = null;
  S.sheetLocked = locked;
  $('#sheetWrap').hidden = false;
  if (bind) bind(body);
}
function closeSheet(force = false) {
  if (S.sheetLocked && !force) return;
  S.sheetLocked = false;
  $('#sheetWrap').hidden = true;
  $('#sheetBody').innerHTML = '';
}

function openAddSheet() {
  openSheet(`<h2>Add to the mix</h2>
    <button class="opt" data-act="song">${icon('music')}<span><b>Songs and audio</b><span>MP3, M4A, WAV and more, from iCloud Drive or On My iPhone. Pick several at once.</span></span></button>
    <button class="opt" data-act="video">${icon('video')}<span><b>Videos</b><span>From Photos, or video files in Files.</span></span></button>
    <button class="opt" data-act="gap">${icon('silence')}<span><b>Silence</b><span>A pause between parts, 2 s to start with.</span></span></button>
    <p class="note">Can't see iCloud Drive in the file picker? Tap Browse at the bottom, then the ‹ arrow at the top left.</p>`, root => {
    root.onclick = e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      closeSheet();
      if (b.dataset.act === 'gap') addGap(); else pickFiles(b.dataset.act);
    };
  });
}

function openFadeSheet(id, which) {
  const p = S.project;
  let touched = false;
  const get = () => (id ? itemOf(id)?.xfade || 0 : which === 'in' ? p.fadeIn || 0 : p.fadeOut || 0);
  const effective = () => {
    if (id) { const e = S.plan.entries.find(x => x.it.id === id); return e ? e.x : 0; }
    return which === 'in' ? S.plan.fadeIn : S.plan.fadeOut;
  };
  let title, help, listenLabel;
  if (id) {
    const clips = p.items.filter(i => i.kind === 'clip');
    const n = clips.indexOf(itemOf(id));
    title = `Fade between clips ${n} and ${n + 1}`;
    help = 'The clips overlap: one fades out while the next fades in. 0 s is a straight cut.';
    listenLabel = 'Listen to this join';
  } else if (which === 'in') {
    title = 'Fade in at the start';
    help = 'The mix starts silent and rises to full volume. 0 s starts at full volume.';
    listenLabel = 'Listen to the start';
  } else {
    title = 'Fade out at the end';
    help = 'The mix sinks to silence at the end. 0 s stops at full volume.';
    listenLabel = 'Listen to the ending';
  }
  const paint = () => {
    const v = get();
    $('#fv').textContent = secs(v);
    $$('#sheetBody .presets button').forEach(b => b.classList.toggle('on', Math.abs(+b.dataset.v - v) < 1e-6));
    const eff = effective();
    $('#fnote').textContent = eff < v - 0.01 ? `Shortened to ${secs(Math.round(eff * 10) / 10)}: a clip here is too short for a longer fade.` : '';
  };
  const set = v => {
    if (v === get()) return;
    if (!touched) { remember(); touched = true; }
    if (id) itemOf(id).xfade = v;
    else if (which === 'in') p.fadeIn = v;
    else p.fadeOut = v;
    afterChange(true);
    paint();
  };
  const listen = () => {
    player.unlock();
    const pl = replan();
    let from, stopAt;
    if (id) {
      const e = pl.entries.find(x => x.it.id === id);
      if (!e) return;
      from = Math.max(0, e.t0 - 4); stopAt = Math.min(pl.total, e.t0 + e.x + 4);
    } else if (which === 'in') {
      from = 0; stopAt = Math.min(pl.total, pl.fadeIn + 5);
    } else {
      from = Math.max(0, pl.total - pl.fadeOut - 5); stopAt = pl.total;
    }
    player.playMix(pl, getBuf, from, stopAt);
    updateTransport();
  };
  openSheet(`<h2>${title}</h2><p class="muted">${help}</p>
    <div class="stepper"><button data-d="-1" aria-label="Shorter">−</button><output id="fv"></output><button data-d="1" aria-label="Longer">+</button></div>
    <div class="presets">${[0, 0.5, 1, 2, 3, 5].map(v => `<button data-v="${v}">${secs(v)}</button>`).join('')}</div>
    <p class="note" id="fnote"></p>
    <button class="wide" data-act="listen">${icon('play')}${listenLabel}</button>
    <button class="wide primary" data-act="done">Done</button>`, root => {
    root.onclick = e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.d) set(stepFade(get(), +b.dataset.d));
      else if (b.dataset.v != null) set(+b.dataset.v);
      else if (b.dataset.act === 'listen') listen();
      else if (b.dataset.act === 'done') closeSheet();
    };
    paint();
  });
}

function openLimitSheet() {
  const p = S.project;
  let touched = false, last = p.limit || S.settings.limitSec || 180;
  const paint = () => {
    $('#limOn').checked = !!p.limit;
    $('#limBox').hidden = !p.limit;
    $('#limV').textContent = fmtTime(p.limit || last, 0);
    $$('#limBox .presets button').forEach(b => b.classList.toggle('on', +b.dataset.v === p.limit));
  };
  const set = v => {
    if (!touched) { remember(); touched = true; }
    p.limit = v;
    if (v) last = v;
    afterChange(false);
    paint();
  };
  openSheet(`<h2>Time limit</h2><p class="muted">Shows and competitions often cap the song length. The bar turns red if the mix runs over.</p>
    <label class="row-toggle"><span><b>Use a time limit</b></span><input type="checkbox" class="switch" id="limOn"></label>
    <div id="limBox"><div class="stepper" style="margin-top:12px"><button data-d="-1" aria-label="5 seconds less">−</button><output id="limV"></output><button data-d="1" aria-label="5 seconds more">+</button></div>
    <div class="presets">${[90, 120, 150, 180, 210, 240, 300].map(v => `<button data-v="${v}">${fmtTime(v, 0)}</button>`).join('')}</div></div>
    <button class="wide primary" data-act="done">Done</button>`, root => {
    $('#limOn', root).onchange = e => set(e.target.checked ? last : null);
    root.onclick = e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.d) set(clamp((p.limit || last) + +b.dataset.d * LIMIT_STEP, 15, 3600));
      else if (b.dataset.v) set(+b.dataset.v);
      else if (b.dataset.act === 'done') closeSheet();
    };
    paint();
  });
}

async function openMixes() {
  await flushSave();
  let all = [];
  try { all = await store.listProjects(); } catch {}
  all = all.filter(m => m.id !== S.project.id);
  all.push(S.project);
  all.sort((a, b) => b.updated - a.updated);
  const row = m => {
    const n = m.items.filter(i => i.kind === 'clip').length;
    const date = new Date(m.updated).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return `<div class="mrow ${m.id === S.project.id ? 'current' : ''}"><button class="mrow-main" data-open="${m.id}"><b>${esc(m.name)}</b><span>${n} clip${n === 1 ? '' : 's'} · ${fmtTime(layout(m).total, 0)} · ${date}</span></button>
      <button class="icon-btn" data-rename="${m.id}" aria-label="Rename">${icon('pencil')}</button><button class="icon-btn danger" data-del="${m.id}" aria-label="Delete">${icon('trash')}</button></div>`;
  };
  openSheet(`<h2>Your mixes</h2><button class="wide primary" data-act="new">${icon('plus')}New mix</button><div class="rows">${all.map(row).join('')}</div>`, root => {
    root.onclick = async e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'new') {
        closeSheet();
        openProject(newProject(`Mix ${all.length + 1}`), true);
      } else if (b.dataset.open) {
        closeSheet();
        if (b.dataset.open === S.project.id) return;
        const m = await store.getProject(b.dataset.open).catch(() => null);
        if (m) openProject(m);
      } else if (b.dataset.rename) {
        const m = all.find(x => x.id === b.dataset.rename);
        const name = prompt('Name this mix', m.name);
        if (!name || !name.trim()) return;
        m.name = name.trim().slice(0, 60);
        if (m === S.project) { $('#mixName').textContent = m.name; await flushSave(); } else await store.putProject(m).catch(() => {});
        openMixes();
      } else if (b.dataset.del) {
        const m = all.find(x => x.id === b.dataset.del);
        if (!confirm(`Delete “${m.name}”? This can't be undone.`)) return;
        await deleteMix(m);
        openMixes();
      }
    };
  });
}

async function deleteMix(m) {
  for (const s of m.sources || []) await store.deleteBlob(s.id).catch(() => {});
  await store.deleteProject(m.id).catch(() => {});
  if (m.id === S.project.id) {
    clearTimeout(saveTimer);
    const rest = (await store.listProjects().catch(() => [])).sort((a, b) => b.updated - a.updated);
    await openProject(rest[0] || newProject('My mix'), !rest[0]);
  }
}

/* ---------------- export ---------------- */

function openExport() {
  const p = S.project;
  if (!p.items.some(i => i.kind === 'clip')) { toast('Add a clip first.'); return; }
  if (p.items.some(i => i.kind === 'clip' && rtOf(i.src).status !== 'ready')) { toast('Some files are still loading or missing.'); return; }
  const dur = fmtTime(replan().total, 0);
  openSheet(`<h2>Export the mix</h2><p class="muted">${dur} long. The file is made here on this phone.</p>
    <button class="opt" data-kind="wav">${icon('music')}<span><b>Audio · WAV</b><span>Best quality. Use this for the sound system at the venue.</span></span></button>
    <button class="opt" data-kind="m4a">${icon('share')}<span><b>Audio · M4A</b><span>Much smaller file. Easy to send on WhatsApp or by email.</span></span></button>
    <button class="opt" data-kind="video">${icon('video')}<span><b>Video · MP4</b><span>Your video clips, with a black screen where there's only music. Takes about ${dur} to make.</span></span></button>`, root => {
    root.onclick = e => {
      const b = e.target.closest('[data-kind]');
      if (!b) return;
      player.unlock();
      runExport(b.dataset.kind);
    };
  });
}

const fileName = ext => `${(S.project.name || 'Dance mix').replace(/[\\/:*?"<>|]+/g, '').trim() || 'Dance mix'}.${ext}`;

async function runExport(kind) {
  stopAll();
  const job = (S.job = { cancel: false, lost: false });
  const label = { wav: 'WAV audio', m4a: 'M4A audio', video: 'video' }[kind];
  openSheet(`<h2>Making the ${label}…</h2><div class="progress"><div id="expBar"></div></div><div id="expStatus" class="big-status">Mixing the clips…</div>
    ${kind === 'video' ? '<p class="muted">Keep the screen on and stay in this app until it finishes.</p>' : ''}
    <button class="wide" id="expCancel">Cancel</button>`, root => { $('#expCancel', root).onclick = () => { job.cancel = true; }; }, { locked: true });
  const bar = v => { const el = $('#expBar'); if (el) el.style.width = `${Math.round(clamp(v, 0, 1) * 100)}%`; };
  const status = t => { const el = $('#expStatus'); if (el) el.textContent = t; };
  let wake = null;
  try {
    if (kind === 'video') { try { wake = await navigator.wakeLock?.request('screen'); } catch {} }
    const ctx = player.context();
    const plan = replan();
    bar(0.03);
    const mix = await renderMix(plan, getBuf, ctx.sampleRate);
    if (job.cancel) throw Object.assign(new Error('cancelled'), { cancelled: true });
    let blob, ext;
    if (kind === 'wav') {
      bar(0.8);
      blob = wavBlob(mix); ext = 'wav';
    } else if (kind === 'm4a') {
      status('Making the M4A file…');
      blob = await m4aBlob(mix, ctx, v => bar(0.1 + v * 0.9), job); ext = 'm4a';
    } else {
      status('Recording the video…');
      blob = await videoBlob({
        ctx, mix, plan, job,
        info: id => ({ ...srcOf(id), url: rtOf(id).url }),
        onProgress: v => { bar(v); status(`Recording the video… ${fmtTime(v * plan.total, 0)} of ${fmtTime(plan.total, 0)}`); },
      });
      ext = blob.type.includes('webm') ? 'webm' : 'mp4';
    }
    bar(1);
    S.lastExport = new File([blob], fileName(ext), { type: blob.type });
    showExportDone(S.lastExport);
  } catch (err) {
    S.sheetLocked = false;
    if (err && err.cancelled) { closeSheet(true); toast('Export cancelled'); }
    else {
      console.error(err);
      openSheet(`<h2>That didn't work</h2><p class="muted">${esc(err && err.message && !/^[A-Z][a-zA-Z]+Error/.test(err.name || '') ? err.message : 'Something went wrong while making the file.')}</p>
        <p class="note">${esc(err && err.name ? `${err.name}: ${err.message || ''}` : '')}</p><button class="wide primary" data-act="done">OK</button>`, root => { root.onclick = e => { if (e.target.closest('[data-act]')) closeSheet(); }; });
    }
  } finally {
    S.job = null;
    try { if (wake) wake.release(); } catch {}
  }
}

function showExportDone(file) {
  const mb = file.size / 1048576;
  openSheet(`<h2>Your mix is ready</h2><p class="muted">${esc(file.name)} · ${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB</p>
    <button class="wide primary" data-act="share">${icon('share')}Save or share</button>
    <button class="wide" data-act="download">${icon('download')}Download to Files</button>
    <p class="note">“Save or share” lets you save a video to Photos, put a song in Files, or send it straight to someone.</p>
    <button class="wide" data-act="done">Done</button>`, root => {
    root.onclick = async e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'share') {
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          try { await navigator.share({ files: [file], title: file.name }); return; } catch (err) { if (err.name === 'AbortError') return; }
        }
        download(file);
      } else if (b.dataset.act === 'download') download(file);
      else closeSheet();
    };
  });
}

function download(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* ---------------- settings ---------------- */

function openSettings() {
  renderSettings();
  $('#settings').hidden = false;
  $('#setBody').scrollTop = 0;
}

function renderSettings() {
  const s = S.settings;
  const fadeRow = (key, label, help) => `<div class="setting"><label class="row-toggle"><span><b>${label}</b><small>${help}</small></span>
      <input type="checkbox" class="switch" data-toggle="${key}On" ${s[key + 'On'] ? 'checked' : ''}></label>
      <div class="stepper" data-step="${key}Sec" ${s[key + 'On'] ? '' : 'hidden'}><button data-d="-1" aria-label="Shorter">−</button><output>${secs(s[key + 'Sec'])}</output><button data-d="1" aria-label="Longer">+</button></div></div>`;
  $('#setBody').innerHTML = `
    <div class="set-h">Fades</div>
    <div class="group">
      ${fadeRow('xfade', 'Fade between clips', 'Used for each clip you add. Off means a straight cut (0 s).')}
      ${fadeRow('fadeIn', 'Fade in at the start', 'Used for each new mix. Off means 0 s.')}
      ${fadeRow('fadeOut', 'Fade out at the end', 'Used for each new mix. Off means 0 s.')}
    </div>
    <button class="wide" data-act="apply">Use these fades in “${esc(S.project.name)}”</button>
    <div class="set-h">Loudness</div>
    <div class="group"><div class="setting"><label class="row-toggle"><span><b>Match loudness automatically</b><small>Quiet recordings play as loud as studio songs. You can still make any clip louder or quieter in its Edit screen.</small></span>
      <input type="checkbox" class="switch" data-toggle="autoLevel" ${s.autoLevel ? 'checked' : ''}></label></div></div>
    <div class="set-h">Time limit</div>
    <div class="group"><div class="setting"><label class="row-toggle"><span><b>Time limit for new mixes</b><small>Change it for any mix by tapping the length bar.</small></span>
      <input type="checkbox" class="switch" data-toggle="limitOn" ${s.limitOn ? 'checked' : ''}></label>
      <div class="stepper" data-step="limitSec" ${s.limitOn ? '' : 'hidden'}><button data-d="-1" aria-label="5 seconds less">−</button><output>${fmtTime(s.limitSec, 0)}</output><button data-d="1" aria-label="5 seconds more">+</button></div></div></div>
    <div class="set-h">Tips</div>
    <ul class="tips">
      <li>Drag ⋮⋮ on a clip to move it up or down.</li>
      <li>Tap a waveform to move its playhead. Drag the green handles to trim.</li>
      <li>To use another part of the same file, tap Edit, then the copy button.</li>
      <li>Add this page to your Home Screen (Share, then Add to Home Screen) so your mixes stay saved. Safari can clear data for websites you haven't opened in a week.</li>
    </ul>
    <button class="wide" data-act="intro">${icon('info')}Show the intro again</button>
    <p class="about">Dance Mix · version ${APP_VERSION}<br>Your songs and videos never leave this phone.</p>`;
}

function bindSettings() {
  $('#setDone').onclick = () => { $('#settings').hidden = true; };
  const body = $('#setBody');
  body.addEventListener('change', e => {
    const key = e.target.dataset.toggle;
    if (!key) return;
    S.settings[key] = e.target.checked;
    saveSettings();
    if (key === 'autoLevel') afterChange(false);
    renderSettings();
  });
  body.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const step = b.closest('[data-step]');
    const s = S.settings;
    if (step && b.dataset.d) {
      const key = step.dataset.step, d = +b.dataset.d;
      if (key === 'limitSec') s.limitSec = clamp(s.limitSec + d * LIMIT_STEP, 15, 3600);
      else s[key] = Math.max(0.25, stepFade(s[key], d));
      saveSettings();
      renderSettings();
    } else if (b.dataset.act === 'apply') {
      remember();
      const p = S.project;
      p.items.forEach((it, i) => { if (it.kind === 'clip' && p.items[i - 1]?.kind === 'clip') it.xfade = s.xfadeOn ? s.xfadeSec : 0; });
      p.fadeIn = s.fadeInOn ? s.fadeInSec : 0;
      p.fadeOut = s.fadeOutOn ? s.fadeOutSec : 0;
      afterChange(true);
      toast('Fades updated in this mix');
    } else if (b.dataset.act === 'intro') {
      $('#settings').hidden = true;
      openIntro();
    }
  });
}

/* ---------------- first-launch intro ---------------- */

function miniWave(seed, s = 0, e = 1, n = 44, handles = false) {
  let bars = '';
  for (let i = 0; i < n; i++) {
    const r = Math.abs(Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453) % 1;
    const a = 0.25 + 0.75 * Math.abs(Math.sin(i * 0.37 + seed)) * (0.45 + 0.55 * r);
    const h = a * 24, f = i / n;
    bars += `<rect x="${i * 4}" y="${(26 - h) / 2}" width="2.6" height="${h}" rx="1" style="fill:var(${f >= s && f <= e ? '--wave-on' : '--wave-off'})"/>`;
  }
  if (handles) {
    const sx = s * n * 4, ex = e * n * 4;
    bars += `<rect x="${sx - 5}" y="0" width="5" height="26" rx="2" style="fill:var(--handle)"/><rect x="${ex}" y="0" width="5" height="26" rx="2" style="fill:var(--handle)"/>`;
    bars += `<rect x="${sx}" y="0" width="${ex - sx}" height="1.6" style="fill:var(--handle)"/><rect x="${sx}" y="24.4" width="${ex - sx}" height="1.6" style="fill:var(--handle)"/>`;
  }
  return `<svg class="w" viewBox="-6 0 ${n * 4 + 12} 26" preserveAspectRatio="none" aria-hidden="true">${bars}</svg>`;
}

const INTRO = [
  {
    title: 'One track from many',
    text: 'Pick songs or videos from your phone. Use the same file as often as you like, taking a different part each time.',
    art: () => `<div class="ia-card">${icon('music')}<span>Intro beat</span>${miniWave(3, 0.1, 0.65)}<em>0:38</em></div>
      <div class="ia-card">${icon('video')}<span>Practice</span>${miniWave(7, 0.3, 0.85)}<em>0:48</em></div>
      <div class="ia-card">${icon('video')}<span>Practice</span>${miniWave(7, 0.05, 0.4)}<em>1:05</em></div>`,
  },
  {
    title: 'Trim with your thumb',
    text: 'Drag the green handles to keep just the part you want. For exact cuts, tap Edit: zoom in, nudge by a tenth of a second, or tap Set here.',
    art: () => `<div style="height:64px;display:flex">${miniWave(11, 0.22, 0.78, 44, true)}</div>
      <div class="ia-row"><span class="ia-btn">−0.1</span><span class="ia-val">0:42.3</span><span class="ia-btn">+0.1</span><span class="ia-btn accent">Set here</span></div>`,
  },
  {
    title: 'Smooth joins, even volume',
    text: 'Tap the fade between two clips to blend them. It starts at 0 s, a straight cut. Quiet recordings are matched to loud songs for you.',
    art: () => `<div class="ia-card">${icon('music')}<span>Song</span>${miniWave(5, 0, 1, 30)}</div>
      <div class="ia-join"><span>${icon('fade')}Fade 2 s</span></div>
      <div class="ia-card">${icon('video')}<span>Practice</span>${miniWave(9, 0, 1, 30)}</div>
      <div class="ia-level ia-head"><span></span><b>Before</b><b>After</b></div>
      <div class="ia-level"><span>Song</span><i style="--w:85%"></i><i style="--w:85%"></i></div>
      <div class="ia-level"><span>Practice</span><i style="--w:30%"></i><i style="--w:85%"></i></div>`,
  },
  {
    title: 'Listen any time, then export',
    text: 'The player at the bottom plays the whole mix while you work. Export a WAV, an M4A, or a video. Your files never leave this phone.',
    art: () => `<div class="segs" style="position:relative;top:0;height:14px"><div class="seg" style="left:0;width:30%"></div><div class="seg alt" style="left:29%;width:38%"></div><div class="seg" style="left:66%;width:34%"></div></div>
      <div style="display:flex;justify-content:center;margin:12px 0 4px"><span class="play-big" style="width:52px;height:52px">${icon('play')}</span></div>
      <div class="ia-exp"><div class="ia-card">${icon('music')}<span>Audio · WAV</span></div><div class="ia-card">${icon('share')}<span>Audio · M4A</span></div><div class="ia-card">${icon('video')}<span>Video · MP4</span></div></div>`,
  },
];

function openIntro() {
  const pages = $('#introPages');
  pages.innerHTML = INTRO.map(pg => `<div class="intro-page"><div class="intro-art">${pg.art()}</div><h2>${pg.title}</h2><p>${pg.text}</p></div>`).join('');
  $('#introDots').innerHTML = INTRO.map(() => '<span></span>').join('');
  $('#intro').hidden = false;
  pages.scrollLeft = 0;
  paintIntro(0);
}
const introIndex = () => { const el = $('#introPages'); return clamp(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)), 0, INTRO.length - 1); };
function paintIntro(i) {
  $$('#introDots span').forEach((d, j) => d.classList.toggle('on', j === i));
  $('#introNext').textContent = i === INTRO.length - 1 ? 'Start mixing' : 'Next';
}
function closeIntro() {
  $('#intro').hidden = true;
  store.set('introSeen', true).catch(() => {});
  try { localStorage.setItem('dm-intro-seen', '1'); } catch {}
}
function bindIntro() {
  const pages = $('#introPages');
  pages.addEventListener('scroll', () => paintIntro(introIndex()), { passive: true });
  $('#introSkip').onclick = closeIntro;
  $('#introNext').onclick = () => {
    const i = introIndex();
    if (i >= INTRO.length - 1) closeIntro();
    else pages.scrollTo({ left: (i + 1) * pages.clientWidth, behavior: 'smooth' });
  };
}
async function introSeen() {
  try { if (localStorage.getItem('dm-intro-seen')) return true; } catch {}
  try { return !!(await store.get('introSeen')); } catch { return false; }
}

/* ---------------- toast ---------------- */

let toastTimer = 0;
function toast(msg, actLabel, act) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${actLabel ? `<button>${esc(actLabel)}</button>` : ''}`;
  t.hidden = false;
  if (actLabel) t.querySelector('button').onclick = () => { t.hidden = true; act(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, actLabel ? 5000 : 3000);
}

/* ---------------- main loop and start-up ---------------- */

function frame() {
  requestAnimationFrame(frame);
  if (!player.mode) return;
  const pos = player.pos();
  if (player.mode === 'mix') {
    S.mixPos = pos;
    const done = player.ended();
    if (done) player.halt();
    renderHead();
    if (done) updateTransport(); else markNow();
  } else {
    const id = player.key;
    S.heads.set(id, pos);
    const done = player.ended();
    if (done) player.halt();
    if (S.ed && S.ed.id === id) {
      S.ed.head = pos;
      followHead();
      drawEditor();
      syncVideo(!done);
    } else drawCard(id);
    if (done) updateTransport();
  }
}

function redrawAll() {
  for (const id of S.cards.keys()) drawCard(id);
  drawEditor();
}

function bindMain() {
  $('#list').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.closest('.item')?.dataset.id;
    switch (b.dataset.act) {
      case 'add-songs': pickFiles('song'); break;
      case 'add-videos': pickFiles('video'); break;
      case 'add-gap': addGap(); break;
      case 'intro': openIntro(); break;
      case 'xfade': openFadeSheet(id); break;
      case 'mixfade': openFadeSheet(null, b.dataset.which); break;
      case 'edit': openEditor(id); break;
      case 'play': toggleClip(id); break;
      case 'gap': adjustGap(id, +b.dataset.d); break;
      case 'del': removeItem(id); break;
      case 'relink': relink(itemOf(id).src); break;
    }
  });
  $('#mixesBtn').onclick = openMixes;
  $('#undoBtn').onclick = undo;
  $('#settingsBtn').onclick = openSettings;
  $('#addBtn').onclick = openAddSheet;
  $('#exportBtn').onclick = openExport;
  $('#meter').onclick = openLimitSheet;
  $('#mixPlay').onclick = toggleMix;
  $('#mixBack').onclick = () => seekMix(S.mixPos - 5, true);
  $('#mixFwd').onclick = () => seekMix(S.mixPos + 5, true);
  $('#sheetScrim').onclick = () => closeSheet();
  $('#songPick').accept = SONG_TYPES;
  $('#videoPick').accept = VIDEO_TYPES;
  $('#relinkPick').accept = `${SONG_TYPES},${VIDEO_TYPES}`;
  $('#songPick').addEventListener('change', e => addFiles([...e.target.files]));
  $('#videoPick').addEventListener('change', e => addFiles([...e.target.files]));
  $('#relinkPick').addEventListener('change', e => onRelink(e.target.files[0]));
  bindScrub();
  let rt = 0;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(redrawAll, 100); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { readColors(); redrawAll(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (S.job) S.job.lost = true; flushSave(); }
  });
  window.addEventListener('pagehide', () => flushSave());
}

async function init() {
  $$('[data-icon]').forEach(el => {
    if (el.tagName === 'SPAN') el.outerHTML = icon(el.dataset.icon);
    else { el.innerHTML = icon(el.dataset.icon); el.dataset.ic = el.dataset.icon; }
  });
  // the editor's undo button sits beside Duplicate
  $('#edDup').insertAdjacentHTML('beforebegin', `<button id="edUndo" class="icon-btn off" aria-label="Undo">${icon('undo')}</button>`);
  readColors();
  bindMain();
  bindEditor();
  bindSettings();
  bindIntro();
  try { const s = await store.get('settings'); if (s) Object.assign(S.settings, s); } catch {}
  let p = null;
  try {
    const last = await store.get('last');
    if (last) p = await store.getProject(last);
    if (!p) p = (await store.listProjects()).sort((a, b) => b.updated - a.updated)[0] || null;
  } catch {}
  await openProject(p || newProject('My mix'), !p);
  if (!(await introSeen())) openIntro();
  requestAnimationFrame(frame);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  // for testing in a desktop browser
  window.__dm = { S, addFiles, player, afterChange };
}

init();
