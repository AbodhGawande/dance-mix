# Dance Mix

Trim and join songs and videos into one seamless track for a dance performance, right on the phone.
A Home Screen web app (PWA): plain HTML/CSS/JS, no build step. Files never leave the phone.

**Open it:** https://abodhgawande.github.io/dance-mix/

## Install on iPhone
1. Open the link above in **Safari**.
2. Share ▸ **Add to Home Screen**.
3. Launch it from the Home Screen icon. It runs full screen and works offline.
   Mixes are saved on the phone. Safari can clear saved data for websites you haven't opened in a week;
   the Home Screen app keeps its own storage and avoids that.

## What it does
- **Add songs** (Files: iCloud Drive, On My iPhone…; opens the Files picker directly) or **add videos** (Photos or
  Files), several at once. The same file can be used any number of times, each clip taking a different part
  (Edit ▸ copy button, or pick the file again).
- **Vertical list of clips**, each with its own waveform (videos show their sound only), green trim handles,
  a play button and its own playhead (tap or drag the waveform). Drag ⋮⋮ to reorder.
- **Edit screen** per clip: the video itself, a zoomable waveform (pinch, ± buttons, or drag the overview strip),
  −0.1 / +0.1 nudges (hold to repeat), **Set here** at the playhead, loop, level, and per-clip fade in/out.
- **Fades:** a fade chip sits between every two clips, at the start and at the end. They show 0 s (a straight cut)
  unless turned on in Settings. Between clips it's an equal-power crossfade (the clips overlap).
- **Loudness matching** (on by default): every clip is brought to −16 LUFS (ITU-R BS.1770, measured on the part
  of the file the clip uses; max ±18 dB), then a limiter catches peaks. The Level slider adds ±12 dB on top.
- **Silence** items for pauses between parts.
- **Mix player** at the bottom plays the whole mix at any time; the clip playing is outlined in the list.
- **Time limit** (tap the length bar): shows length against the limit, red when over.
- **Export:** WAV (16-bit, for venue sound systems), M4A (AAC, small), or MP4 video (the video clips, black where
  there's only music). Then "Save or share" opens the iPhone share sheet.
- **Settings:** default fades (off, with durations), loudness matching, default time limit, intro again.
- **Intro:** four swipeable pages on first launch, with Skip.
- Several mixes (tap the title), undo, and auto-save (IndexedDB) of mixes and the original files.

## Files
- `index.html`, `style.css`: the page.
- `js/app.js`: everything on screen: list, gestures, editor, sheets, settings, intro, saving.
- `js/engine.js`: sound maths (no page code, tested in Node): peaks, loudness, timeline layout, fades, rendering, WAV.
- `js/player.js`: live playback of the mix or one clip.
- `js/exporter.js`: M4A (WebCodecs AAC + mp4-muxer) and MP4 video (WebCodecs H.264 + AAC; MediaRecorder fallback).
- `js/store.js`: IndexedDB. `vendor/mp4-muxer.js`: MIT, v5.2.2.
- `sw.js`: offline cache. **Bump `VERSION` (and `APP_VERSION` in app.js) on every deploy.**
- `tools/make_icons.py`: draws the icons. `tests/`: `npm test`.

## Safari notes (found while testing in WebKit and the iOS Simulator)
- The iPhone Files picker greys out **every** audio file (MP3, M4A, WAV) when the input asks for `audio/*`.
  The Songs input names each type instead (`SONG_TYPES` in app.js); asking only for audio also skips the
  Photos/Camera menu and opens Files directly. Videos use `video/*` (keeps the Photo Library option).
- `decodeAudioData` refuses QuickTime `.mov` (the iPhone video format) but reads MP4; the two are the same inside,
  so `relabelQuickTime()` rewrites the `ftyp` brand before decoding.
- IndexedDB may refuse to store `File` objects (private browsing); `store.putBlob` falls back to raw bytes.
- Safari's `AudioEncoder` gives a whole ES descriptor as its AAC description; `audioSpecificConfig()` unwraps it
  for the MP4 writer.
- MediaRecorder MP4s from Safari lack a proper duration, so video export encodes frames with WebCodecs instead.
- `navigator.audioSession.type = 'playback'` lets sound play with the silent switch on.
