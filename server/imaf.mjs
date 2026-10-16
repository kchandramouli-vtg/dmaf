/* ============================================================
   IMAF — MPEG-A Interactive Music Application Format (ISO/IEC 23000-12)

   ffmpeg or MP4Box (GPAC) writes the multitrack ISO base media file (one
   audio track per stem, major brand 'im02'); this module finishes it as an
   IMAF file:

     ftyp        major brand 'im02' (set by ffmpeg -brand im02)
     moov
       trak × N  tkhd: every stem enabled, alternate_group 0 (tracks
                 play together, they are not alternatives)
       grco      Group Container   → grup per Studio group (Vocals, Rhythm…)
       prco      Preset Container  → prst per preset mix (Producer, Karaoke…)
       ruco      Rules Container   → rumx limits for the listener-control rule

   Box syntax follows our reading of ISO/IEC 23000-12 (§ group, preset and
   rules boxes); it has not been checked against the reference IMAF
   software, which isn't part of this repository. Conventions used here:
     · volumes are linear gain in 0.02 steps (50 = unity, 0 = mute)
     · group IDs are 0x80000000 + n, so they never collide with track IDs
   The same description is written next to the file as JSON (imaf.json).

   No dependencies — Node Buffers only. readImaf() parses a file back.
   ============================================================ */

export const IMAF_BRAND = "im02";
export const GROUP_ID_BASE = 0x80000000;
export const UNITY = 50;                         // volume units: 0.02 linear gain

/* ---------------- ISO BMFF basics ---------------- */
function boxes(buf, start = 0, end = buf.length) {
  const out = [];
  let i = start;
  while (i + 8 <= end) {
    let size = buf.readUInt32BE(i), hdr = 8;
    const type = buf.toString("latin1", i + 4, i + 8);
    if (size === 1) { size = Number(buf.readBigUInt64BE(i + 8)); hdr = 16; }
    else if (size === 0) size = end - i;
    if (size < hdr || i + size > end) throw new Error(`Malformed box '${type}' at ${i}`);
    out.push({ type, start: i, size, hdr, body: i + hdr, end: i + size });
    i += size;
  }
  return out;
}
const child = (buf, box, type) => boxes(buf, box.body, box.end).find(b => b.type === type);

class W {
  constructor() { this.parts = []; }
  u8(v) { const b = Buffer.alloc(1); b.writeUInt8(v & 0xff); this.parts.push(b); return this; }
  u16(v) { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff); this.parts.push(b); return this; }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); this.parts.push(b); return this; }
  str(s) { this.parts.push(Buffer.from(String(s ?? ""), "utf8"), Buffer.from([0])); return this; }
  raw(b) { this.parts.push(b); return this; }
  get buf() { return Buffer.concat(this.parts); }
}
function box(type, payload) {
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + payload.length); h.write(type, 4, "latin1");
  return Buffer.concat([h, payload]);
}
function fullBox(type, version, flags, payload) {
  const vf = Buffer.alloc(4);
  vf.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff));
  return box(type, Buffer.concat([vf, payload]));
}

/* ---------------- IMAF boxes ---------------- */
/** GroupBox 'grup': elements are track_IDs (or group IDs). */
function grup(g) {
  const w = new W().u32(g.groupId).u16(g.elements.length);
  g.elements.forEach(e => w.u32(e));
  w.u8(0);                                   // group_activation_mode = 0 (all elements active), 7 reserved bits
  w.u16(g.referenceVolume ?? UNITY).str(g.name).str(g.description || "");
  return fullBox("grup", 0, g.flags || 0, w.buf);
}
/** PresetBox 'prst', preset_type 0 = static volume per element. */
function prst(p) {
  const w = new W().u8(p.presetId).u8(p.elements.length);
  p.elements.forEach(e => w.u32(e));
  w.u8(0).u8(p.globalVolume ?? UNITY);
  p.volumes.forEach(v => w.u8(Math.max(0, Math.min(255, Math.round(v)))));
  w.str(p.name);
  return fullBox("prst", 0, p.flags || 0, w.buf);
}
/** MixingRulesBox 'rumx', mixing_type 3 = volume limits of one element. */
function rumx(r) {
  const w = new W().u16(r.ruleId).u8(r.type).u32(r.element);
  if (r.type === 3) w.u16(r.minVolume).u16(r.maxVolume); else w.u32(r.keyElement);
  w.str(r.description || "");
  return fullBox("rumx", 0, 0, w.buf);
}
/** SelectionRulesBox 'rusc'. */
function rusc(r) {
  const w = new W().u16(r.ruleId).u8(r.type).u32(r.element);
  if (r.type === 0) w.u16(r.min).u16(r.max);
  if (r.type === 1 || r.type === 3) w.u32(r.keyElement);
  w.str(r.description || "");
  return fullBox("rusc", 0, 0, w.buf);
}
function imafBoxes(d) {
  const grco = box("grco", Buffer.concat([new W().u16(d.groups.length).buf, ...d.groups.map(grup)]));
  const prco = box("prco", Buffer.concat([new W().u8(d.presets.length).u8(d.defaultPresetId ?? d.presets[0]?.presetId ?? 0).buf, ...d.presets.map(prst)]));
  const sel = d.rules?.selection || [], mix = d.rules?.mixing || [];
  const ruco = box("ruco", Buffer.concat([new W().u16(sel.length).u16(mix.length).buf, ...sel.map(rusc), ...mix.map(rumx)]));
  return Buffer.concat([grco, prco, ...(sel.length || mix.length ? [ruco] : [])]);
}

/* ---------------- tracks ---------------- */
function tracksOf(buf, moov) {
  return boxes(buf, moov.body, moov.end).filter(b => b.type === "trak").map(trak => {
    const tkhd = child(buf, trak, "tkhd");
    const v = buf.readUInt8(tkhd.body);
    const idAt = tkhd.body + 4 + (v === 1 ? 16 : 8);
    const mdia = child(buf, trak, "mdia"), hdlr = mdia && child(buf, mdia, "hdlr");
    const handler = hdlr ? buf.toString("latin1", hdlr.body + 8, hdlr.body + 12) : "";
    const name = hdlr ? buf.toString("utf8", hdlr.body + 24, hdlr.end).replace(/\0.*$/s, "") : "";
    // after track_ID: reserved(4), duration(4|8), reserved(8), layer(2), alternate_group(2)
    const altAt = idAt + 4 + 4 + (v === 1 ? 8 : 4) + 8 + 2;
    return { trackId: buf.readUInt32BE(idAt), handler, name, flagsAt: tkhd.body + 1, altAt, flags: buf.readUIntBE(tkhd.body + 1, 3), alternateGroup: buf.readUInt16BE(altAt) };
  });
}

/** Add `delta` to every chunk offset (stco/co64) that points at or after `from` — the
    media data moves when boxes are inserted into a moov that comes before mdat. */
function shiftChunkOffsets(buf, moov, from, delta) {
  for (const trak of boxes(buf, moov.body, moov.end).filter(b => b.type === "trak")) {
    const mdia = child(buf, trak, "mdia"), minf = mdia && child(buf, mdia, "minf"), stbl = minf && child(buf, minf, "stbl");
    if (!stbl) continue;
    for (const t of boxes(buf, stbl.body, stbl.end)) {
      if (t.type !== "stco" && t.type !== "co64") continue;
      const n = buf.readUInt32BE(t.body + 4);
      for (let k = 0; k < n; k++) {
        if (t.type === "stco") {
          const at = t.body + 8 + 4 * k, v = buf.readUInt32BE(at);
          if (v >= from) { if (v + delta > 0xffffffff) throw new Error("file too large for 32-bit chunk offsets"); buf.writeUInt32BE(v + delta, at); }
        } else {
          const at = t.body + 8 + 8 * k, v = buf.readBigUInt64BE(at);
          if (v >= BigInt(from)) buf.writeBigUInt64BE(v + BigInt(delta), at);
        }
      }
    }
  }
}

/**
 * Turn a multitrack MP4 (ffmpeg or MP4Box output) into an IMAF file.
 * @param {Buffer} mp4  major brand im02; moov may come before or after mdat
 * @param {(trackIds: number[]) => object} describe  returns { groups, presets, defaultPresetId, rules } for the track IDs in file order
 * @returns {{ file: Buffer, description: object }}
 */
export function finalizeImaf(mp4, describe) {
  const buf = Buffer.from(mp4);
  const top = boxes(buf);
  const ftyp = top.find(b => b.type === "ftyp"), moov = top.find(b => b.type === "moov");
  if (!ftyp || !moov) throw new Error("Not an ISO base media file (no ftyp/moov)");
  if (buf.toString("latin1", ftyp.body, ftyp.body + 4) !== IMAF_BRAND) throw new Error(`major brand must be '${IMAF_BRAND}' (ffmpeg -brand ${IMAF_BRAND})`);
  if (boxes(buf, moov.body, moov.end).some(b => ["grco", "prco", "ruco"].includes(b.type))) throw new Error("already an IMAF file");

  const audio = tracksOf(buf, moov).filter(t => t.handler === "soun");
  if (!audio.length) throw new Error("no audio tracks");
  for (const t of audio) {
    buf.writeUIntBE(t.flags | 0x7, t.flagsAt, 3);          // track_enabled | in_movie | in_preview
    buf.writeUInt16BE(0, t.altAt);                         // not alternatives: all stems play together
  }
  const description = { brand: IMAF_BRAND, ...describe(audio.map(t => t.trackId)) };
  const extra = imafBoxes(description);
  if (moov.hdr !== 8) throw new Error("64-bit moov size not supported");
  if (top.some(b => b.start > moov.start && b.type !== "free" && b.type !== "skip")) shiftChunkOffsets(buf, moov, moov.end, extra.length);
  const out = Buffer.concat([buf.subarray(0, moov.end), extra, buf.subarray(moov.end)]);   // the boxes go at the end of moov
  out.writeUInt32BE(moov.size + extra.length, moov.start);
  return { file: out, description };
}

/* ---------------- reading back ---------------- */
function readStr(buf, i, end) { const z = buf.indexOf(0, i); const e = z < 0 || z > end ? end : z; return [buf.toString("utf8", i, e), e + 1]; }

/** Parse an IMAF file: brand, tracks, groups, presets, rules. */
export function readImaf(input) {
  const buf = Buffer.from(input);
  const top = boxes(buf);
  const ftyp = top.find(b => b.type === "ftyp"), moov = top.find(b => b.type === "moov");
  if (!ftyp || !moov) throw new Error("Not an ISO base media file");
  const brand = buf.toString("latin1", ftyp.body, ftyp.body + 4);
  const compatible = [];
  for (let i = ftyp.body + 8; i + 4 <= ftyp.end; i += 4) compatible.push(buf.toString("latin1", i, i + 4));
  const tracks = tracksOf(buf, moov).map(({ trackId, handler, name, flags, alternateGroup }) => ({ trackId, handler, name, enabled: !!(flags & 1), alternateGroup }));
  const kids = boxes(buf, moov.body, moov.end);
  const out = { brand, compatible, tracks, groups: [], presets: [], defaultPresetId: null, rules: { selection: [], mixing: [] } };

  const grco = kids.find(b => b.type === "grco");
  if (grco) for (const g of boxes(buf, grco.body + 2, grco.end)) {
    let i = g.body + 4;
    const groupId = buf.readUInt32BE(i); i += 4;
    const n = buf.readUInt16BE(i); i += 2;
    const elements = []; for (let k = 0; k < n; k++, i += 4) elements.push(buf.readUInt32BE(i));
    const mode = buf.readUInt8(i) >> 7; i += 1;
    if (mode === 1) i += 2;
    const referenceVolume = buf.readUInt16BE(i); i += 2;
    let name, description; [name, i] = readStr(buf, i, g.end); [description, i] = readStr(buf, i, g.end);
    out.groups.push({ groupId, elements, referenceVolume, name, description });
  }
  const prco = kids.find(b => b.type === "prco");
  if (prco) {
    out.defaultPresetId = buf.readUInt8(prco.body + 1);
    for (const p of boxes(buf, prco.body + 2, prco.end)) {
      let i = p.body + 4;
      const presetId = buf.readUInt8(i++), n = buf.readUInt8(i++);
      const elements = []; for (let k = 0; k < n; k++, i += 4) elements.push(buf.readUInt32BE(i));
      const type = buf.readUInt8(i++), globalVolume = buf.readUInt8(i++);
      const volumes = []; if (type === 0) for (let k = 0; k < n; k++) volumes.push(buf.readUInt8(i++));
      const [name] = readStr(buf, i, p.end);
      out.presets.push({ presetId, type, elements, globalVolume, volumes, name });
    }
  }
  const ruco = kids.find(b => b.type === "ruco");
  if (ruco) for (const r of boxes(buf, ruco.body + 4, ruco.end)) {
    let i = r.body + 4;
    const ruleId = buf.readUInt16BE(i); i += 2;
    const type = buf.readUInt8(i++), element = buf.readUInt32BE(i); i += 4;
    const rule = { ruleId, type, element };
    if (r.type === "rumx") {
      if (type === 3) { rule.minVolume = buf.readUInt16BE(i); rule.maxVolume = buf.readUInt16BE(i + 2); i += 4; }
      else { rule.keyElement = buf.readUInt32BE(i); i += 4; }
      [rule.description] = readStr(buf, i, r.end);
      out.rules.mixing.push(rule);
    } else if (r.type === "rusc") {
      if (type === 0) { rule.min = buf.readUInt16BE(i); rule.max = buf.readUInt16BE(i + 2); i += 4; }
      if (type === 1 || type === 3) { rule.keyElement = buf.readUInt32BE(i); i += 4; }
      [rule.description] = readStr(buf, i, r.end);
      out.rules.selection.push(rule);
    }
  }
  return out;
}

/* ---------------- Studio model → IMAF description ---------------- */
export const PRESET_DEFS = {
  producer: { name: "Producer mix", desc: "all stems at default levels", on: () => true },
  karaoke: { name: "Karaoke", desc: "lead vocals muted", on: (s, all) => s !== leadVocal(all) },
  acappella: { name: "A-cappella", desc: "vocals group only", on: s => s.group === "Vocals" },
  rhythm: { name: "Rhythm section", desc: "drums, bass, guitars", on: s => s.group === "Rhythm" },
};
function leadVocal(stems) {
  return stems.find(s => /lead/i.test(s.name) && /vocal|vox/i.test(s.name))
    || stems.find(s => s.group === "Vocals") || null;
}
/** Studio slider (0–100, 70 = as delivered) → IMAF volume units (50 = unity). */
export const levelToVolume = level => Math.max(0, Math.min(255, Math.round((+level / 70) * UNITY)));

/**
 * @param {{name, group, level}[]} stems  in track order
 * @param {string[]} presetKeys  keys of PRESET_DEFS
 * @param {"free"|"presets"|"limit6db"} rule
 */
export function describeStudio(stems, presetKeys, rule = "free") {
  return trackIds => {
    const byGroup = new Map();
    stems.forEach((s, i) => { const g = s.group || "Other"; byGroup.set(g, [...(byGroup.get(g) || []), trackIds[i]]); });
    const groups = [...byGroup].map(([name, elements], n) => ({
      groupId: GROUP_ID_BASE + n + 1, name, description: `${elements.length} stem${elements.length > 1 ? "s" : ""}`, elements, referenceVolume: UNITY,
    }));
    const keys = (presetKeys?.length ? presetKeys : ["producer"]).filter(k => PRESET_DEFS[k]);
    const presets = keys.map((k, n) => ({
      presetId: n + 1, key: k, name: PRESET_DEFS[k].name, description: PRESET_DEFS[k].desc, type: 0, globalVolume: UNITY,
      elements: [...trackIds], volumes: stems.map(s => (PRESET_DEFS[k].on(s, stems) ? levelToVolume(s.level) : 0)),
    }));
    const mixing = rule === "free" ? [] : stems.map((s, i) => {
      const v = levelToVolume(s.level);
      return rule === "presets"
        ? { ruleId: i + 1, type: 3, element: trackIds[i], minVolume: v, maxVolume: v, description: `${s.name}: fixed at the producer's level (preset switching only)` }
        : { ruleId: i + 1, type: 3, element: trackIds[i], minVolume: Math.round(v / 2), maxVolume: Math.min(0xffff, v * 2), description: `${s.name}: within ±6 dB of the producer's level` };
    });
    return { groups, presets, defaultPresetId: presets[0]?.presetId ?? 1, rules: { selection: [], mixing } };
  };
}
