# Stems → mix MP3 + IMAF package, and the stem visualiser

## 1. What runs, and with which tool

Studio ▸ *Deliver stems* uploads the WAVs to the dev server (`.data/stems/<agreement>/`). Step 5 ▸ *Build mix + IMAF package*
runs `server/stems.mjs`:

| Output | Tool | Command (simplified) |
|---|---|---|
| **Mix MP3** — what listeners pay to play | ffmpeg | `ffmpeg -i s1.wav … -filter_complex "amix=inputs=N:duration=longest:normalize=1:weights='w1 … wN'" -c:a libmp3lame -b:a 320k mix.mp3` (weights = Studio level ÷ 70) |
| **AAC tracks** | ffmpeg | `ffmpeg -i stem.wav -c:a aac -b:a 256k stem.m4a` — one per stem |
| **Multitrack file** | **MP4Box** (GPAC) when installed | `MP4Box -brand im02 -add stem1.m4a#audio:name=Lead vocals … -new package.mp4` |
| | ffmpeg otherwise | `ffmpeg -i s1.wav … -map 0:a -map 1:a … -c:a aac -brand im02 -f mp4 package.mp4` |
| **IMAF boxes** | DMAF (`server/imaf.mjs`) | enables every track, clears `alternate_group` (both muxers mark extra audio tracks as *alternatives* — players would play only one), adds `grco` / `prco` / `ruco` to `moov`, shifts chunk offsets when `moov` precedes `mdat` (MP4Box's layout) |
| **Check** | MP4Box `-info` (when installed) + DMAF's reader | must report N tracks, brand `im02`; DMAF re-reads its own boxes |
| **Waveforms** | ffmpeg + DMAF | each IMAF track and the mix decoded to 8 kHz mono → 50 frames/s of peak and RMS → `waveforms.json` |
| **Pinning** | Kubo | mix, `.ima`, `imaf.json`, `waveforms.json` (and, when you're signed in, recorded in My Library) |

So: **MP4Box muxes the package when it's on your PATH; ffmpeg encodes the audio either way.** Neither tool writes IMAF's
group/preset/rule boxes — DMAF does. Install MP4Box with `brew install gpac`; `npm run serve` then prints
`✓ MP4Box GPAC …`, the Studio shows an *MP4Box* pill and step 5 shows *Muxed by MP4Box … · MP4Box -info reads N tracks*.
`DMAF_MP4BOX=0 npm run serve` forces the ffmpeg path; `MP4BOX=/path/to/MP4Box` points at a specific binary.

## 2. IMAF boxes written

| Box | Contents |
|---|---|
| `ftyp` | major brand `im02` |
| `trak` × N | one AAC-LC 256 kbps track per stem, handler name = deliverable name, enabled, `alternate_group` 0 |
| `grco` → `grup` | one group per Studio group (Vocals, Rhythm…) listing its track IDs; group IDs 0x80000000 + n |
| `prco` → `prst` | one static-volume preset per ticked preset (Producer mix — the default, Karaoke, A-cappella, Rhythm section); volumes are linear gain in 0.02 steps (50 = as delivered) |
| `ruco` → `rumx` | the listener rule: *Preset switching only* = each track's volume fixed; *±6 dB* = each track between half and double its level; *Free mixing* = no rules box |

The syntax follows our reading of ISO/IEC 23000-12; it hasn't been validated against the reference IMAF software
(not in the repository). `npm run test:imaf` checks the writer and reader, including MP4Box-style files.

## 3. The stem visualiser (asset page)

Assets published from the Studio show a **Stems** card: the mix and one lane per stem with its waveform, a playhead
and a level meter. The lanes follow the MP3 `<audio>` element — they move while it plays, and clicking a lane jumps there
(after paying). Meters read each stem at the default preset's level (a stem the mix turns down reads lower), on a
−48…0 dB scale with a slow fall. Colours are per group (`GROUP_COLORS` in `js/stemviz.js`).

The data is `waveforms.json` on IPFS (CID in the asset metadata, `imaf.waveforms`):

```json
{ "version": 1, "fps": 50, "durationSec": 34.02,
  "mix":    { "peak": "<base64 bytes>", "rms": "<base64 bytes>", "frames": 1701 },
  "tracks": [{ "trackId": 1, "name": "Lead vocals", "group": "Vocals", "peak": "…", "rms": "…", "frames": 1701 }],
  "presets": [{ "presetId": 1, "name": "Producer mix", "elements": [1,2,3,4,5], "volumes": [50,50,50,50,50] }],
  "defaultPresetId": 1 }
```

Each byte is a level for 1/50 s, 255 = full scale. For assets packaged before waveforms existed, the page asks the dev server
(`GET /studio-api/waveforms/<IMAF CID>?mix=<MP3 CID>`), which computes them from the IMAF file on IPFS once and caches them in
`.data/waveforms/`.

What you hear is always the MP3 mix; the lanes show what each stem contributes to it. Playing the stems themselves
(mute/solo/presets in the browser) is the next step — the IMAF file already carries what that player needs.

## 4. Files

`server/stems.mjs` (upload, mix, mux, waveforms, pinning) · `server/imaf.mjs` (IMAF writer/reader) · `server/test/imaf.test.mjs` ·
`js/agreement.js` (step 2 upload) · `js/app.js` (step 5) · `js/media.js` (`attachPackage()`, `drawStems()`) · `js/stemviz.js` (lanes and meters).
