/* ============================================================
   Studio stems → mix MP3 + IMAF package (dev server, /studio-api)

   PUT  /studio-api/stems/:agreementId/:key   raw file body, header x-filename
        → stores .data/stems/<agreementId>/<key>.<ext>, returns ffprobe facts + sha256
   GET  /studio-api/stems/:agreementId         stems delivered so far
   POST /studio-api/stems/:agreementId/package { title, artist, genre, stems:[{key,name,group,level}],
                                                 presets:[…], rule }
        → ffmpeg amix  → <title>.mp3   (320 kbps, the Studio's levels; what listeners pay to play)
        → IMAF         → <title>.ima   (one AAC track per stem + groups/presets/rules, server/imaf.mjs):
                         ffmpeg encodes the AAC; MP4Box (GPAC) muxes the tracks when it's installed,
                         otherwise ffmpeg does; MP4Box -info then checks the result
        → waveforms    → waveforms.json (per-stem and mix level envelopes for the asset page's visualiser)
        → all pinned to the local IPFS node; returns CIDs, sizes, sha256, the commands run
   GET  /studio-api/imaf/:cid                   reads an IMAF file back from IPFS (groups, presets, rules)
   GET  /studio-api/waveforms/:imafCid[?mix=cid] waveforms of a published package (computed once, cached in .data/waveforms)
   GET  /studio-api/status                      ffmpeg and MP4Box availability

   Needs ffmpeg + ffprobe on PATH (or FFMPEG / FFPROBE env). MP4Box is optional
   (MP4BOX env for its path; DMAF_MP4BOX=0 to ignore it). No npm packages.
   ============================================================ */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { finalizeImaf, readImaf, describeStudio, PRESET_DEFS, IMAF_BRAND } from "./imaf.mjs";

const SAFE = /^[A-Za-z0-9_-]{1,64}$/;
const AUDIO_EXT = /\.(wav|wave|flac|aif|aiff|mp3|m4a|aac|ogg|opus)$/i;
const MAX_STEM = 500 * 1024 * 1024;

function run(cmd, args, { timeoutMs = 10 * 60_000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return reject(e); }
    const out = [], err = [];
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    p.stdout.on("data", d => out.push(d)); p.stderr.on("data", d => err.push(d));
    p.on("error", e => {
      clearTimeout(t);
      reject(e.code === "ENOENT" ? new Error(/mp4box/i.test(cmd) ? `${cmd} not found — install GPAC (brew install gpac) or set MP4BOX`
        : `${cmd} not found — install ffmpeg (brew install ffmpeg) or set FFMPEG/FFPROBE`) : e);
    });
    p.on("close", code => {
      clearTimeout(t);
      const stderr = Buffer.concat(err).toString();
      if (code !== 0) return reject(new Error(`${path.basename(cmd)} failed (${code}): ${stderr.trim().split("\n").slice(-3).join(" ")}`));
      const buf = Buffer.concat(out);
      resolve({ stdout: binary ? buf : buf.toString(), stderr });
    });
  });
}
const sha256File = file => new Promise((resolve, reject) => {
  const h = crypto.createHash("sha256");
  fs.createReadStream(file).on("data", d => h.update(d)).on("error", reject).on("end", () => resolve("0x" + h.digest("hex")));
});
const quote = a => (/^[\w./:=@%+-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`);
const slug = s => String(s || "untitled").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled";

/* Level envelopes: FPS frames a second, peak and RMS as bytes (255 = full scale), base64 in JSON. */
export const WAVE_FPS = 50;
const WAVE_RATE = 8000;
function envelope(f32) {
  const hop = WAVE_RATE / WAVE_FPS, n = Math.ceil(f32.length / hop);
  const peak = new Uint8Array(n), rms = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let mx = 0, sq = 0;
    const a = i * hop, b = Math.min(f32.length, a + hop);
    for (let k = a; k < b; k++) { const v = f32[k]; const av = v < 0 ? -v : v; if (av > mx) mx = av; sq += v * v; }
    peak[i] = Math.min(255, Math.round(mx * 255));
    rms[i] = Math.min(255, Math.round(Math.sqrt(sq / Math.max(1, b - a)) * Math.SQRT2 * 255));
  }
  return { peak: Buffer.from(peak).toString("base64"), rms: Buffer.from(rms).toString("base64"), frames: n };
}

export function createStemsApi({ root, ipfsApi = "http://127.0.0.1:5001", ffmpeg = process.env.FFMPEG || "ffmpeg", ffprobe = process.env.FFPROBE || "ffprobe",
  mp4box = process.env.MP4BOX || "MP4Box", onPinned = null }) {
  const base = path.join(root, ".data", "stems");
  const waveCache = path.join(root, ".data", "waveforms");
  let ffmpegInfo = null, mp4boxInfo = null;

  async function mp4boxStatus() {
    if (process.env.DMAF_MP4BOX === "0") return { ok: false, disabled: true, error: "turned off (DMAF_MP4BOX=0)" };
    if (!mp4boxInfo || (!mp4boxInfo.ok && Date.now() - mp4boxInfo.at > 30_000)) {
      try {
        const { stdout, stderr } = await run(mp4box, ["-version"], { timeoutMs: 5000 });
        mp4boxInfo = { ok: true, version: ((stdout + stderr).match(/GPAC version (\S+)/) || [])[1] || "?", at: Date.now() };
      } catch (e) { mp4boxInfo = { ok: false, error: e.message.replace(/\s+/g, " ").slice(0, 160), at: Date.now() }; }
    }
    const { at, ...info } = mp4boxInfo;
    return info;
  }

  async function status() {
    if (!ffmpegInfo || !ffmpegInfo.ok) {
      try {
        const { stdout } = await run(ffmpeg, ["-hide_banner", "-version"], { timeoutMs: 5000 });
        const { stdout: enc } = await run(ffmpeg, ["-hide_banner", "-encoders"], { timeoutMs: 5000 });
        ffmpegInfo = { ok: /libmp3lame/.test(enc), version: (stdout.match(/ffmpeg version (\S+)/) || [])[1] || "?", mp3: /libmp3lame/.test(enc), aac: /\baac\b/.test(enc) };
        if (!ffmpegInfo.mp3) ffmpegInfo.error = "this ffmpeg has no libmp3lame (MP3 encoder)";
      } catch (e) { ffmpegInfo = { ok: false, error: e.message }; }
    }
    return ffmpegInfo;
  }

  async function probe(file) {
    const { stdout } = await run(ffprobe, ["-v", "error", "-show_entries", "format=duration,format_name:stream=codec_type,codec_name,sample_rate,channels,bits_per_raw_sample,bits_per_sample", "-of", "json", file], { timeoutMs: 30_000 });
    const j = JSON.parse(stdout);
    const a = (j.streams || []).find(s => s.codec_type === "audio");
    if (!a) throw new Error("no audio stream in this file");
    return { codec: a.codec_name, sampleRate: +a.sample_rate || null, channels: a.channels || null,
      bits: +(a.bits_per_raw_sample || a.bits_per_sample) || null, durationSec: j.format?.duration ? +(+j.format.duration).toFixed(3) : null, container: j.format?.format_name };
  }

  async function pin(file, name, type, rec) {
    let blob;
    try { blob = fs.openAsBlob ? await fs.openAsBlob(file, { type }) : new Blob([await fsp.readFile(file)], { type }); }
    catch { blob = new Blob([await fsp.readFile(file)], { type }); }
    const fd = new FormData(); fd.append("file", blob, name);
    let r;
    try { r = await fetch(`${ipfsApi}/api/v0/add?cid-version=1&pin=true`, { method: "POST", body: fd, headers: { "user-agent": "dmaf-dev-server" } }); }
    catch (e) { throw new Error(`Can't reach the IPFS node at ${ipfsApi} — is it running? (${e.cause?.code || e.message})`); }
    const t = await r.text();
    if (!r.ok) throw new Error(`IPFS add failed (${r.status}): ${t.slice(0, 200)}`);
    const cid = JSON.parse(t.trim().split("\n").pop()).Hash;
    if (rec && onPinned) await onPinned(rec.req, { cid, name, mime: type, size: (await fsp.stat(file)).size, source: "studio", ...rec.meta });
    return cid;
  }

  /** Waveforms of every audio track of an (IMAF) file, plus an optional mix file. */
  async function waveforms(imaFile, mixFile, names = []) {
    const info = readImaf(await fsp.readFile(imaFile));
    const audio = info.tracks.filter(t => t.handler === "soun");
    const groupOf = id => info.groups.find(g => g.elements.includes(id))?.name || null;
    const decode = async (file, map) => {
      const { stdout } = await run(ffmpeg, ["-v", "error", "-i", file, ...(map != null ? ["-map", `0:a:${map}`] : []), "-ac", "1", "-ar", String(WAVE_RATE), "-f", "f32le", "-"], { binary: true });
      return new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 4));
    };
    const tracks = [];
    for (let i = 0; i < audio.length; i++) {
      const e = envelope(await decode(imaFile, i));
      tracks.push({ trackId: audio[i].trackId, name: names[i] || audio[i].name || `Track ${i + 1}`, group: groupOf(audio[i].trackId), ...e });
    }
    const mix = mixFile ? envelope(await decode(mixFile, null)) : null;
    const frames = Math.max(...tracks.map(t => t.frames), mix?.frames || 0);
    return { version: 1, fps: WAVE_FPS, durationSec: +(frames / WAVE_FPS).toFixed(2), mix, tracks,
      presets: info.presets.map(p => ({ presetId: p.presetId, name: p.name, elements: p.elements, volumes: p.volumes })), defaultPresetId: info.defaultPresetId };
  }

  /* ---- GET /waveforms/:imafCid[?mix=cid] (published packages; cached) ---- */
  async function waveformsFor(cid, mixCid) {
    if (!/^[A-Za-z0-9]{10,100}$/.test(cid) || (mixCid && !/^[A-Za-z0-9]{10,100}$/.test(mixCid))) throw Object.assign(new Error("bad CID"), { status: 400 });
    await fsp.mkdir(waveCache, { recursive: true });
    const cached = path.join(waveCache, `${cid}${mixCid ? "+" + mixCid : ""}.json`);
    try { return JSON.parse(await fsp.readFile(cached, "utf8")); } catch {}
    const ff = await status();
    if (!ff.ok) throw Object.assign(new Error(`ffmpeg isn't usable: ${ff.error}`), { status: 503 });
    const fetchTo = async (c, f) => {
      let r;
      try { r = await fetch(`${ipfsApi}/api/v0/cat?arg=${encodeURIComponent(c)}`, { method: "POST", headers: { "user-agent": "dmaf-dev-server" } }); }
      catch (e) { throw new Error(`Can't reach the IPFS node at ${ipfsApi} — is it running? (${e.cause?.code || e.message})`); }
      if (!r.ok) throw Object.assign(new Error(`IPFS cat ${c} failed (${r.status})`), { status: 404 });
      await fsp.writeFile(f, Buffer.from(await r.arrayBuffer()));
      return f;
    };
    const tmp = await fsp.mkdtemp(path.join(waveCache, ".tmp-"));
    try {
      const w = await waveforms(await fetchTo(cid, path.join(tmp, "p.ima")), mixCid ? await fetchTo(mixCid, path.join(tmp, "m.mp3")) : null);
      await fsp.writeFile(cached, JSON.stringify(w));
      return w;
    } finally { await fsp.rm(tmp, { recursive: true, force: true }); }
  }

  async function readIndex(dir) {
    try { return JSON.parse(await fsp.readFile(path.join(dir, "index.json"), "utf8")); } catch { return {}; }
  }

  /* ---- PUT /stems/:ag/:key ---- */
  async function upload(req, ag, key) {
    const name = decodeURIComponent(req.headers["x-filename"] || "stem.wav").split(/[\\/]/).pop();
    if (!AUDIO_EXT.test(name)) throw Object.assign(new Error("WAV, FLAC, AIFF, MP3, M4A/AAC or OGG/Opus files only"), { status: 415 });
    const dir = path.join(base, ag);
    await fsp.mkdir(dir, { recursive: true });
    const ext = path.extname(name).toLowerCase();
    const tmp = path.join(dir, `.${key}.${process.pid}.${Date.now()}.part`);
    let size = 0;
    await new Promise((resolve, reject) => {
      const w = fs.createWriteStream(tmp);
      req.on("data", d => { size += d.length; if (size > MAX_STEM) { req.destroy(); w.destroy(); reject(Object.assign(new Error("stem larger than 500 MB"), { status: 413 })); } });
      req.pipe(w); w.on("finish", resolve); w.on("error", reject); req.on("error", reject);
    });
    let facts;
    try { facts = await probe(tmp); }
    catch (e) { await fsp.rm(tmp, { force: true }); throw Object.assign(new Error(`${name}: not a readable audio file (${e.message.split(tmp).join("").replace(/^.*?:\s*/, "").trim()})`), { status: 422 }); }
    const index = await readIndex(dir);
    for (const f of await fsp.readdir(dir)) if (f.startsWith(key + ".")) await fsp.rm(path.join(dir, f), { force: true });
    const file = path.join(dir, key + ext);
    await fsp.rename(tmp, file);
    index[key] = { key, name, file: key + ext, size, sha256: await sha256File(file), ...facts, at: new Date().toISOString() };
    await fsp.writeFile(path.join(dir, "index.json"), JSON.stringify(index, null, 2));
    return index[key];
  }

  /* ---- POST /stems/:ag/package ---- */
  async function makePackage(ag, body, req) {
    const ff = await status();
    if (!ff.ok) throw Object.assign(new Error(`ffmpeg isn't usable: ${ff.error}`), { status: 503 });
    const dir = path.join(base, ag), index = await readIndex(dir);
    const stems = (body.stems || []).filter(s => s && SAFE.test(s.key || ""));
    if (!stems.length) throw Object.assign(new Error("no stems to package"), { status: 400 });
    const missing = stems.filter(s => !index[s.key]);
    if (missing.length) throw Object.assign(new Error(`not delivered to the dev server yet: ${missing.map(s => s.name || s.key).join(", ")} — add the file(s) again`), { status: 409 });
    if (stems.length > 64) throw Object.assign(new Error("at most 64 stems"), { status: 400 });
    const levels = stems.map(s => Math.max(0, Math.min(100, Number.isFinite(+s.level) ? +s.level : 70)));
    if (!levels.some(l => l > 0)) throw Object.assign(new Error("every stem is at level 0 — nothing to mix"), { status: 400 });

    const title = String(body.title || "Untitled").slice(0, 200), artist = String(body.artist || "").slice(0, 200);
    const out = path.join(dir, "package"); await fsp.mkdir(out, { recursive: true });
    const name = slug(title);
    const inputs = stems.flatMap(s => ["-i", path.join(dir, index[s.key].file)]);
    const mp3 = path.join(out, `${name}.mp3`), mp4 = path.join(out, `.${name}.mp4`), ima = path.join(out, `${name}.ima`);

    // 1. the mix: amix with the Studio's levels as weights (70 = as delivered); normalize like `amix … normalize=1`
    const weights = levels.map(l => +(l / 70).toFixed(4)).join(" ");
    const mixArgs = ["-hide_banner", "-loglevel", "error", "-y", ...inputs,
      "-filter_complex", `amix=inputs=${stems.length}:duration=longest:normalize=1:weights='${weights}'`,
      "-c:a", "libmp3lame", "-b:a", "320k", "-id3v2_version", "3",
      "-metadata", `title=${title}`, ...(artist ? ["-metadata", `artist=${artist}`] : []),
      ...(body.genre ? ["-metadata", `genre=${String(body.genre).slice(0, 60)}`] : []),
      "-metadata", `comment=DMAF mix of ${stems.length} stems (IMAF package alongside)`, mp3];
    await run(ffmpeg, mixArgs);

    // 2. the IMAF package: one AAC track per stem, named after the deliverable, brand im02.
    //    With MP4Box: ffmpeg encodes each stem to AAC, MP4Box muxes them. Without: ffmpeg does both.
    const mb = await mp4boxStatus();
    let muxArgs, muxCmd, mp4boxArgs = null;
    if (mb.ok) {
      const aac = stems.map((s, i) => path.join(out, `.stem-${i}.m4a`));
      muxArgs = [];
      for (let i = 0; i < stems.length; i++) {
        const a = ["-hide_banner", "-loglevel", "error", "-y", "-i", path.join(dir, index[stems[i].key].file), "-vn", "-map_metadata", "-1", "-c:a", "aac", "-b:a", "256k", aac[i]];
        await run(ffmpeg, a);
        muxArgs.push(a);
      }
      const trackName = s => String(s.name || s.key).replace(/[:#]/g, "-");
      mp4boxArgs = ["-noprog", "-brand", IMAF_BRAND, "-tmp", out, ...stems.flatMap((s, i) => ["-add", `${aac[i]}#audio:name=${trackName(s)}`]), "-new", mp4];
      await run(mp4box, mp4boxArgs);
      await Promise.all(aac.map(f => fsp.rm(f, { force: true })));
      muxCmd = [...muxArgs.map(a => ["ffmpeg", ...a].map(quote).join(" ")), [mp4box, ...mp4boxArgs].map(quote).join(" ")].join("\n");
    } else {
      muxArgs = ["-hide_banner", "-loglevel", "error", "-y", ...inputs,
        ...stems.flatMap((s, i) => ["-map", `${i}:a:0`]),
        "-c:a", "aac", "-b:a", "256k",
        ...stems.flatMap((s, i) => [`-metadata:s:a:${i}`, `handler_name=${s.name || s.key}`, `-metadata:s:a:${i}`, `title=${s.name || s.key}`]),
        "-metadata", `title=${title}`, ...(artist ? ["-metadata", `artist=${artist}`] : []),
        "-brand", IMAF_BRAND, "-f", "mp4", mp4];
      await run(ffmpeg, muxArgs);
      muxCmd = ["ffmpeg", ...muxArgs].map(quote).join(" ");
    }
    const presets = (body.presets || []).filter(k => PRESET_DEFS[k]);
    const rule = ["free", "presets", "limit6db"].includes(body.rule) ? body.rule : "free";
    const studio = stems.map((s, i) => ({ name: s.name || s.key, group: s.group || "Other", level: levels[i] }));
    const { file, description } = finalizeImaf(await fsp.readFile(mp4), describeStudio(studio, presets, rule));
    await fsp.writeFile(ima, file); await fsp.rm(mp4, { force: true });
    const check = readImaf(file);                                    // read our own output back
    let mp4boxCheck = null;                                         // and let MP4Box read it too
    if (mb.ok) {
      const { stdout, stderr } = await run(mp4box, ["-info", ima], { timeoutMs: 60_000 });
      const info = (stdout + stderr).replace(/\x1b\[[0-9;]*m/g, "");
      mp4boxCheck = { tracks: +((info.match(/Movie Info - (\d+) tracks?/) || [])[1] || 0), brand: (info.match(/Major Brand (\S+)/) || [])[1] || null,
        alternateGroups: (info.match(/Alternate Group ID/g) || []).length, summary: info.split("\n").filter(l => /Movie Info|Major Brand|Media Type|MPEG-4 Audio|Track flags/.test(l)).slice(0, 4 * stems.length + 2) };
      if (mp4boxCheck.tracks !== stems.length || mp4boxCheck.brand !== IMAF_BRAND) throw new Error(`MP4Box -info disagrees: ${mp4boxCheck.tracks} tracks, brand ${mp4boxCheck.brand}`);
    }

    const [mixFacts, imaFacts] = await Promise.all([probe(mp3), probe(ima)]);
    const [mixSha, imaSha] = await Promise.all([sha256File(mp3), sha256File(ima)]);
    const rec = kind => ({ req, meta: { kind, agreementId: ag } });
    const [mixCid, imaCid] = [await pin(mp3, `${name}.mp3`, "audio/mpeg", rec("mix")), await pin(ima, `${name}.ima`, "audio/mp4", rec("imaf"))];
    // 3. waveforms for the asset page's visualiser: every stem (from the IMAF tracks) and the mix
    const wf = await waveforms(ima, mp3, studio.map(s => s.name));
    const wfFile = path.join(out, "waveforms.json");
    await fsp.writeFile(wfFile, JSON.stringify(wf));
    await fsp.mkdir(waveCache, { recursive: true });
    await fsp.writeFile(path.join(waveCache, `${imaCid}+${mixCid}.json`), JSON.stringify(wf));
    const wfCid = await pin(wfFile, "waveforms.json", "application/json", rec("waveforms"));
    const tracks = check.tracks.filter(t => t.handler === "soun").map((t, i) => ({
      trackId: t.trackId, key: stems[i].key, name: studio[i].name, group: studio[i].group, level: levels[i],
      source: { file: index[stems[i].key].name, sha256: index[stems[i].key].sha256, sampleRate: index[stems[i].key].sampleRate, bits: index[stems[i].key].bits, durationSec: index[stems[i].key].durationSec },
    }));
    const manifest = {
      standard: "ISO/IEC 23000-12 (MPEG-A Interactive Music Application Format)", brand: description.brand,
      title, artist, rule, tracks, groups: description.groups, presets: description.presets,
      defaultPresetId: description.defaultPresetId, rules: description.rules,
      package: { cid: imaCid, fileName: `${name}.ima`, size: file.length, sha256: imaSha, codec: "aac", bitrate: 256000 },
      mix: { cid: mixCid, fileName: `${name}.mp3`, size: (await fsp.stat(mp3)).size, sha256: mixSha, codec: "mp3", bitrate: 320000, weights: levels.map(l => l / 70) },
      waveforms: { cid: wfCid, fps: WAVE_FPS },
      muxer: mb.ok ? `MP4Box ${mb.version} (AAC by ffmpeg)` : `ffmpeg ${ff.version}`,
      createdAt: new Date().toISOString(),
    };
    const mf = path.join(out, "imaf.json");
    await fsp.writeFile(mf, JSON.stringify(manifest, null, 2));
    const manifestCid = await pin(mf, "imaf.json", "application/json", rec("imaf-description"));
    return {
      mix: { ...manifest.mix, durationSec: mixFacts.durationSec, sampleRate: mixFacts.sampleRate },
      imaf: { ...manifest.package, brand: check.brand, compatible: check.compatible, durationSec: imaFacts.durationSec,
        tracks, groups: check.groups, presets: check.presets, defaultPresetId: check.defaultPresetId, rules: check.rules, rule },
      manifest: { cid: manifestCid },
      waveforms: { cid: wfCid, fps: WAVE_FPS, tracks: wf.tracks.length },
      muxer: manifest.muxer,
      mp4box: mb.ok ? { version: mb.version, check: mp4boxCheck } : { used: false, reason: mb.error },
      ffmpeg: { version: ff.version, mix: ["ffmpeg", ...mixArgs].map(quote).join(" "), mux: muxCmd },
    };
  }

  async function imafFromIpfs(cid) {
    let r;
    try { r = await fetch(`${ipfsApi}/api/v0/cat?arg=${encodeURIComponent(cid)}`, { method: "POST", headers: { "user-agent": "dmaf-dev-server" } }); }
    catch (e) { throw new Error(`Can't reach the IPFS node at ${ipfsApi} — is it running? (${e.cause?.code || e.message})`); }
    if (!r.ok) throw Object.assign(new Error(`IPFS cat failed (${r.status})`), { status: 404 });
    const buf = Buffer.from(await r.arrayBuffer());
    return { cid, size: buf.length, sha256: "0x" + crypto.createHash("sha256").update(buf).digest("hex"), ...readImaf(buf) };
  }

  const send = (res, status, obj) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
  const readJson = req => new Promise((resolve, reject) => {
    const c = []; let n = 0;
    req.on("data", d => { n += d.length; if (n > 1e6) { req.destroy(); reject(new Error("body too large")); } else c.push(d); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(c).toString() || "{}")); } catch { reject(Object.assign(new Error("invalid JSON"), { status: 400 })); } });
    req.on("error", reject);
  });

  async function handle(req, res, p) {
    try {
      const seg = p.split("/").filter(Boolean);
      if (seg[0] === "status" && req.method === "GET") return send(res, 200, { ffmpeg: await status(), mp4box: await mp4boxStatus() });
      if (seg[0] === "waveforms" && seg[1] && req.method === "GET")
        return send(res, 200, await waveformsFor(seg[1], new URL(req.url, "http://x").searchParams.get("mix")));
      if (seg[0] === "imaf" && seg[1] && req.method === "GET") return send(res, 200, await imafFromIpfs(seg[1]));
      if (seg[0] === "stems" && SAFE.test(seg[1] || "")) {
        const dir = path.join(base, seg[1]);
        if (seg.length === 2 && req.method === "GET") return send(res, 200, Object.values(await readIndex(dir)));
        if (seg.length === 3 && seg[2] === "package" && req.method === "POST") return send(res, 200, await makePackage(seg[1], await readJson(req), req));
        if (seg.length === 3 && SAFE.test(seg[2]) && req.method === "PUT") return send(res, 200, await upload(req, seg[1], seg[2]));
      }
      send(res, 404, { errorType: "NotFound", message: `No route ${req.method} /studio-api/${p}` });
    } catch (e) {
      send(res, e.status || 500, { errorType: e.status === 503 ? "ServiceUnavailable" : "PackagingError", message: e.message });
    }
  }
  return { handle, status, mp4boxStatus };
}
