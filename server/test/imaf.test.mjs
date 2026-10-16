/* IMAF writer/reader (server/imaf.mjs) on a real ffmpeg multitrack MP4.
   Skips when ffmpeg isn't on PATH.   Run: node --test server/test/imaf.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { finalizeImaf, readImaf, describeStudio, levelToVolume, UNITY, GROUP_ID_BASE } from "../imaf.mjs";

let ffmpeg = true;
try { execFileSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" }); } catch { ffmpeg = false; }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imaf-"));
const STEMS = [
  { name: "Lead vocals", group: "Vocals", level: 70, hz: 220 },
  { name: "Backing vocals", group: "Vocals", level: 50, hz: 330 },
  { name: "Drums", group: "Rhythm", level: 85, hz: 110 },
  { name: "Bass", group: "Rhythm", level: 70, hz: 55 },
];
function multitrack(brand = "im02") {
  const inputs = STEMS.flatMap(s => ["-f", "lavfi", "-i", `sine=frequency=${s.hz}:duration=2`]);
  const out = path.join(dir, `mt-${brand}.mp4`);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...inputs, ...STEMS.flatMap((s, i) => ["-map", `${i}:a:0`]),
    "-c:a", "aac", "-b:a", "96k", ...STEMS.flatMap((s, i) => [`-metadata:s:a:${i}`, `handler_name=${s.name}`]), "-brand", brand, "-f", "mp4", out]);
  return fs.readFileSync(out);
}

test("levels map to IMAF volume units (70 → unity)", () => {
  assert.equal(levelToVolume(70), UNITY);
  assert.equal(levelToVolume(0), 0);
  assert.equal(levelToVolume(100), 71);
  assert.equal(levelToVolume(1000), 255);
});

test("finalizeImaf adds grco/prco/ruco, enables every track; readImaf reads it back", { skip: !ffmpeg && "ffmpeg not installed" }, () => {
  const src = multitrack();
  const before = readImaf(src);
  assert.ok(before.tracks.slice(1).some(t => !t.enabled || t.alternateGroup), "ffmpeg marks extra audio tracks as alternatives");
  const { file, description } = finalizeImaf(src, describeStudio(STEMS, ["producer", "karaoke", "acappella", "rhythm"], "limit6db"));
  const r = readImaf(file);
  assert.equal(r.brand, "im02");
  assert.deepEqual(r.tracks.map(t => [t.name, t.enabled, t.alternateGroup]), STEMS.map(s => [s.name, true, 0]));
  assert.deepEqual(r.groups.map(g => [g.groupId, g.name, g.elements]), [[GROUP_ID_BASE + 1, "Vocals", [1, 2]], [GROUP_ID_BASE + 2, "Rhythm", [3, 4]]]);
  assert.deepEqual(r.presets.map(p => [p.name, p.volumes]), [
    ["Producer mix", [50, 36, 61, 50]], ["Karaoke", [0, 36, 61, 50]], ["A-cappella", [50, 36, 0, 0]], ["Rhythm section", [0, 0, 61, 50]],
  ]);
  assert.equal(r.defaultPresetId, 1);
  assert.deepEqual(r.rules.mixing.map(x => [x.element, x.type, x.minVolume, x.maxVolume]), [[1, 3, 25, 100], [2, 3, 18, 72], [3, 3, 31, 122], [4, 3, 25, 100]]);
  assert.deepEqual(r.presets.map(p => p.volumes), description.presets.map(p => p.volumes));
  // still an ordinary ISO BMFF file: the audio data offsets are untouched
  fs.writeFileSync(path.join(dir, "out.ima"), file);
  const streams = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", path.join(dir, "out.ima")]).toString().trim().split("\n");
  assert.deepEqual(streams, ["aac", "aac", "aac", "aac"]);
  execFileSync("ffmpeg", ["-v", "error", "-i", path.join(dir, "out.ima"), "-map", "0:a:3", "-f", "null", "-"]);
});

test("free mixing writes no rules box; 'presets only' pins every level", { skip: !ffmpeg && "ffmpeg not installed" }, () => {
  const free = readImaf(finalizeImaf(multitrack(), describeStudio(STEMS, ["producer"], "free")).file);
  assert.equal(free.rules.mixing.length, 0);
  const fixed = readImaf(finalizeImaf(multitrack(), describeStudio(STEMS, ["producer"], "presets")).file);
  assert.ok(fixed.rules.mixing.every(x => x.minVolume === x.maxVolume));
});

test("refuses files that aren't ffmpeg's im02 multitrack output, or already IMAF", { skip: !ffmpeg && "ffmpeg not installed" }, () => {
  assert.throws(() => finalizeImaf(multitrack("isom"), describeStudio(STEMS, [], "free")), /major brand/);
  const once = finalizeImaf(multitrack(), describeStudio(STEMS, [], "free")).file;
  assert.throws(() => finalizeImaf(once, describeStudio(STEMS, [], "free")), /already an IMAF/);
  assert.throws(() => readImaf(Buffer.from("not an mp4 at all")), /Malformed|Not an ISO/);
});
