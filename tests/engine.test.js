import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtTime, layout, envAt, applyEnvelope, loudnessBlocks, regionLoudness, computePeaks, encodeWav } from '../js/engine.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}±${tol}, got ${a}`);

function fakeBuffer(channels, seconds, sr, fn) {
  const n = Math.round(seconds * sr);
  const data = Array.from({ length: channels }, (_, c) => {
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = fn(i / sr, c);
    return d;
  });
  return { sampleRate: sr, length: n, numberOfChannels: channels, duration: n / sr, getChannelData: c => data[c] };
}

const clip = (start, end, extra = {}) => ({ id: Math.random().toString(36), kind: 'clip', src: 's', start, end, gain: 0, fadeIn: 0, fadeOut: 0, xfade: 0, ...extra });

test('times read like a stopwatch', () => {
  assert.equal(fmtTime(0), '0:00.0');
  assert.equal(fmtTime(42.34), '0:42.3');
  assert.equal(fmtTime(59.96), '1:00.0');
  assert.equal(fmtTime(161, 0), '2:41');
  assert.equal(fmtTime(65, 0), '1:05');
  assert.equal(fmtTime(-3), '0:00.0');
});

test('clips play one after another; a fade overlaps them', () => {
  const p = { items: [clip(0, 10), clip(5, 15, { xfade: 2 }), { id: 'g', kind: 'gap', dur: 3 }, clip(0, 4, { xfade: 1 })], fadeIn: 0, fadeOut: 0 };
  const { entries, total } = layout(p);
  assert.deepEqual(entries.map(e => [e.t0, e.t1]), [[0, 10], [8, 18], [18, 21], [21, 25]]);
  assert.equal(total, 25);
  // the fade after a silence is ignored: nothing to overlap with
  assert.equal(entries[3].x, 0);
  // both sides of the join fade over the overlap, with equal-power curves
  assert.equal(entries[0].fo, 2);
  assert.equal(entries[1].fi, 2);
  assert.ok(entries[0].foEq && entries[1].fiEq);
});

test('a fade never overlaps more than half of either clip', () => {
  const { entries, total } = layout({ items: [clip(0, 3), clip(0, 10, { xfade: 8 })] });
  assert.equal(entries[1].x, 1.5);
  assert.equal(total, 11.5);
});

test('start and end fades are limited to half the mix', () => {
  const plan = layout({ items: [clip(0, 6)], fadeIn: 5, fadeOut: 2 });
  assert.equal(plan.fadeIn, 3);
  assert.equal(plan.fadeOut, 2);
});

test('clip fades that would overlap are shrunk to fit', () => {
  const { entries } = layout({ items: [clip(0, 4, { fadeIn: 3, fadeOut: 3 })] });
  near(entries[0].fi + entries[0].fo, 4, 1e-9);
});

test('equal-power joins keep the combined power steady', () => {
  for (const u of [0, 0.25, 0.5, 0.75, 1]) {
    const out = envAt(10 - 2 + 2 * u, 10, 0, 2, false, true);  // outgoing clip's last 2 s
    const inn = envAt(2 * u, 10, 2, 0, true, false);            // incoming clip's first 2 s
    near(out * out + inn * inn, 1, 1e-9, `u=${u}`);
  }
});

test('volume curves never overlap each other (Safari rejects that)', () => {
  const calls = [];
  const param = {
    setValueAtTime: (v, t) => calls.push({ kind: 'set', t, d: 0 }),
    linearRampToValueAtTime: (v, t) => calls.push({ kind: 'ramp', t, d: 0 }),
    setValueCurveAtTime: (arr, t, d) => { assert.ok(arr.length >= 2); calls.push({ kind: 'curve', t, d }); },
  };
  const cases = [
    { len: 10, fi: 2, fo: 3, off: 0 }, { len: 10, fi: 2, fo: 3, off: 1 }, { len: 10, fi: 2, fo: 3, off: 5 },
    { len: 10, fi: 2, fo: 3, off: 8 }, { len: 10, fi: 0, fo: 0, off: 0 }, { len: 10, fi: 0, fo: 0, off: 4 },
    { len: 0.3, fi: 0, fo: 0, off: 0 }, { len: 4, fi: 2, fo: 2, off: 0 },
  ];
  for (const c of cases) {
    calls.length = 0;
    applyEnvelope(param, { ...c, fiEq: false, foEq: false, level: 1, when: 100 });
    const curves = calls.filter(x => x.kind === 'curve').sort((a, b) => a.t - b.t);
    for (let i = 1; i < curves.length; i++) assert.ok(curves[i].t >= curves[i - 1].t + curves[i - 1].d - 1e-9, JSON.stringify(c));
    for (const ev of calls.filter(x => x.kind !== 'curve')) {
      for (const cv of curves) assert.ok(!(ev.t > cv.t + 1e-9 && ev.t < cv.t + cv.d - 1e-9), `event inside a curve: ${JSON.stringify(c)}`);
    }
    for (const ev of calls) assert.ok(ev.t >= 100 - 1e-9 && ev.t + ev.d <= 100 + c.len - c.off + 1e-6, `outside the clip: ${JSON.stringify(c)}`);
  }
});

test('loudness of a 1 kHz tone at −20 dB in stereo reads −20 LUFS', () => {
  const buf = fakeBuffer(2, 5, 48000, t => 0.1 * Math.sin(2 * Math.PI * 1000 * t));
  near(regionLoudness(loudnessBlocks(buf), 0, 5), -20, 0.3);
});

test('a mono file counts as playing from both speakers', () => {
  const buf = fakeBuffer(1, 5, 48000, t => 0.1 * Math.sin(2 * Math.PI * 1000 * t));
  near(regionLoudness(loudnessBlocks(buf), 0, 5), -20, 0.3);
});

test('loudness only counts the part of the file that is used', () => {
  const buf = fakeBuffer(2, 10, 44100, t => (t < 5 ? 0.01 : 0.2) * Math.sin(2 * Math.PI * 1000 * t));
  const blocks = loudnessBlocks(buf);
  near(regionLoudness(blocks, 0, 5), -40, 0.4);
  near(regionLoudness(blocks, 5, 10), -14, 0.4);
  assert.equal(regionLoudness(fakeBuffer(2, 2, 44100, () => 0) && loudnessBlocks(fakeBuffer(2, 2, 44100, () => 0)), 0, 2), null);
});

test('waveform peaks follow the loudest sample in each slice', () => {
  const buf = fakeBuffer(2, 1, 1000, (t, c) => (t >= 0.5 && c === 1 ? -0.8 : 0.1));
  const p = computePeaks(buf, 10);
  assert.equal(p.length, 10);
  near(p[0], 0.1, 1e-6);
  near(p[9], 0.8, 1e-6);
});

test('WAV files have a proper header and 16-bit samples', () => {
  const buf = fakeBuffer(2, 0.01, 48000, (t, c) => (c ? -1 : 1));
  const bytes = new DataView(encodeWav(buf));
  const str = (o, n) => String.fromCharCode(...Array.from({ length: n }, (_, i) => bytes.getUint8(o + i)));
  assert.equal(str(0, 4), 'RIFF');
  assert.equal(str(8, 4), 'WAVE');
  assert.equal(bytes.getUint16(22, true), 2);
  assert.equal(bytes.getUint32(24, true), 48000);
  assert.equal(bytes.getUint32(40, true), 480 * 2 * 2);
  assert.equal(bytes.getInt16(44, true), 32767);
  assert.equal(bytes.getInt16(46, true), -32768);
});

test("Safari's AAC setup bytes are unwrapped to the two the MP4 writer needs", async () => {
  const { audioSpecificConfig } = await import('../js/exporter.js');
  const hex = s => Uint8Array.from(s.match(/../g), h => parseInt(h, 16));
  const safari = hex('038080802200000004808080144014001800000000000000000005808080021190068080800102');
  assert.deepEqual([...audioSpecificConfig(safari)], [0x11, 0x90]);
  assert.deepEqual([...audioSpecificConfig(hex('1190'))], [0x11, 0x90]);
});
