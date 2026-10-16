/* ============================================================
   Stem visualiser (asset page)

   One waveform lane per stem of the asset's IMAF package, plus the mix,
   with a playhead and a level meter per lane that follow the MP3 as it
   plays. The data is waveforms.json (server/stems.mjs, computed with
   ffmpeg from the IMAF tracks and the mix): 50 frames a second of peak and
   RMS levels, base64-encoded bytes (255 = full scale).

   Meters show each stem at the package's default preset (the producer's
   mix), so a stem the mix turns down reads lower.

   DMAF_STEMVIZ.mount(container, audioElement, data, { canSeek }) → { destroy() }
   ============================================================ */
(() => {
/* A family of hues per group, so stems in one group stay related but distinct. */
const GROUP_COLORS = {
  Vocals: ["#7c3aed", "#c026d3", "#4f46e5"], Rhythm: ["#d97706", "#dc2626", "#92400e", "#65a30d"], Lead: ["#e11d48", "#be123c"],
  Keys: ["#059669", "#0d9488"], Strings: ["#0284c7", "#2563eb"], FX: ["#db2777", "#9333ea"], Other: ["#475569", "#64748b"],
};
const MIX_COLOR = "#0f2742";
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const b64 = s => Uint8Array.from(atob(s || ""), c => c.charCodeAt(0));
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const METER_FLOOR_DB = -48;

function mount(root, audio, data, opts = {}) {
  const fps = data.fps || 50;
  const preset = (data.presets || []).find(p => p.presetId === data.defaultPresetId) || (data.presets || [])[0];
  const lanes = [
    ...(data.mix ? [{ name: "Mix", sub: "the MP3 you hear", color: MIX_COLOR, peak: b64(data.mix.peak), rms: b64(data.mix.rms), weight: 1, mix: true }] : []),
    ...data.tracks.map((t, n) => {
      const i = preset ? preset.elements.indexOf(t.trackId) : -1;
      const weight = i >= 0 ? preset.volumes[i] / 50 : 1;
      const fam = GROUP_COLORS[t.group] || GROUP_COLORS.Other;
      const nth = data.tracks.slice(0, n).filter(x => (GROUP_COLORS[x.group] || GROUP_COLORS.Other) === fam).length;
      return { name: t.name, sub: t.group || "", color: fam[nth % fam.length], peak: b64(t.peak), rms: b64(t.rms), weight };
    }),
  ];
  const frames = Math.max(...lanes.map(l => l.peak.length));
  const duration = data.durationSec || frames / fps;

  root.innerHTML = `<div class="sv" role="group" aria-label="Stem waveforms">
    ${lanes.map((l, i) => `<div class="sv-row${l.mix ? " sv-mix" : ""}" style="--c:${l.color}">
      <div class="sv-label"><b>${esc(l.name)}</b><span>${esc(l.sub)}${!l.mix && l.weight !== 1 ? ` · ${l.weight === 0 ? "muted" : Math.round(l.weight * 100) + "%"} in the mix` : ""}</span></div>
      <canvas class="sv-wave" data-i="${i}" role="img" aria-label="${esc(l.name)} waveform"></canvas>
      <div class="sv-meter" aria-hidden="true"><i data-m="${i}"></i></div>
    </div>`).join("")}
    <div class="sv-foot"><span class="sv-time">0:00 / ${fmt(duration)}</span><span class="help sv-hint">${opts.canSeek ? "Click a lane to jump." : ""}</span></div>
  </div>`;
  const canvases = [...root.querySelectorAll("canvas.sv-wave")];
  const meters = [...root.querySelectorAll(".sv-meter i")];
  const timeEl = root.querySelector(".sv-time");
  const layers = [];                       // per lane: { dim, bright } offscreen canvases
  const levels = lanes.map(() => 0);

  function prerender() {
    const dpr = window.devicePixelRatio || 1;
    canvases.forEach((c, i) => {
      const w = Math.max(50, c.clientWidth), h = c.clientHeight || 44;
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      const l = lanes[i], max = Math.max(1, ...l.peak);
      const draw = alpha => {
        const o = document.createElement("canvas"); o.width = c.width; o.height = c.height;
        const g = o.getContext("2d");
        g.fillStyle = l.color; g.globalAlpha = alpha;
        const mid = c.height / 2, cols = c.width;
        for (let x = 0; x < cols; x++) {
          const a = Math.floor((x / cols) * frames), b = Math.max(a + 1, Math.floor(((x + 1) / cols) * frames));
          let p = 0; for (let f = a; f < b && f < l.peak.length; f++) if (l.peak[f] > p) p = l.peak[f];
          const hh = Math.max(dpr * 0.5, (p / max) * (mid - dpr));
          g.fillRect(x, mid - hh, 1, hh * 2);
        }
        return o;
      };
      layers[i] = { dim: draw(0.28), bright: draw(0.95) };
    });
    paint();
  }

  function paint() {
    const t = audio && Number.isFinite(audio.currentTime) && audio.src ? audio.currentTime : 0;
    const frac = Math.min(1, t / duration);
    const f = Math.min(frames - 1, Math.floor(t * fps));
    canvases.forEach((c, i) => {
      const g = c.getContext("2d"), L = layers[i];
      if (!L) return;
      g.clearRect(0, 0, c.width, c.height);
      g.drawImage(L.dim, 0, 0);
      const x = Math.round(frac * c.width);
      if (x > 0) g.drawImage(L.bright, 0, 0, x, c.height, 0, 0, x, c.height);
      g.fillStyle = "#0f2742"; g.globalAlpha = 0.85; g.fillRect(x, 0, Math.max(1, (window.devicePixelRatio || 1)), c.height); g.globalAlpha = 1;
    });
    const playing = audio && !audio.paused && !audio.ended;
    lanes.forEach((l, i) => {
      const amp = playing ? ((l.rms[f] || 0) / 255) * l.weight : 0;
      const db = amp > 0 ? 20 * Math.log10(amp) : -Infinity;
      const target = Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
      levels[i] = target > levels[i] ? target : Math.max(target, levels[i] - 0.035);   // fast attack, slow fall
      meters[i].style.width = (levels[i] * 100).toFixed(1) + "%";
      canvases[i].parentElement.classList.toggle("is-active", levels[i] > 0.45);
    });
    timeEl.textContent = `${fmt(t)} / ${fmt(duration)}`;
  }

  let raf = 0;
  const loop = () => { paint(); raf = audio && !audio.paused && !audio.ended ? requestAnimationFrame(loop) : 0; };
  const start = () => { if (!raf) raf = requestAnimationFrame(loop); };
  const once = () => { if (!raf) paint(); };
  const events = { play: start, playing: start, pause: once, seeked: once, timeupdate: once, ended: once, emptied: once };
  if (audio) for (const [e, fn] of Object.entries(events)) audio.addEventListener(e, fn);
  const onClick = e => {
    if (!opts.canSeek?.() || !audio?.src) return;
    const r = e.currentTarget.getBoundingClientRect();
    audio.currentTime = Math.max(0, Math.min(duration, ((e.clientX - r.left) / r.width) * duration));
    paint();
  };
  canvases.forEach(c => c.addEventListener("click", onClick));
  const ro = new ResizeObserver(() => prerender());
  ro.observe(root);
  prerender();
  if (audio && !audio.paused) start();

  return {
    destroy() {
      cancelAnimationFrame(raf); ro.disconnect();
      if (audio) for (const [e, fn] of Object.entries(events)) audio.removeEventListener(e, fn);
      root.innerHTML = "";
    },
    refresh: paint,
  };
}

window.DMAF_STEMVIZ = { mount };
})();
