/* ============================================================
   DMAF app logic — hash router + view renderers.
   All data access goes through window.api (js/api.js).
   ============================================================ */

document.getElementById("year").textContent = new Date().getFullYear();
document.getElementById("mocknote").textContent =
  window.DMAF_MOCK ? "Sign-in, signatures and the Royalties overview are demo data. Studio agreements, stems and packages, Publish, Discover, My Library and live Royalties use your local IPFS node and Hardhat chain through MetaMask." : "";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2600);
}

/* ---------------- sign-in gate ----------------
   Visitors can open Sign in and Discover. Every other page — My Library, Studio,
   Publish, Royalties, asset pages, the player — needs a signed-in account
   (js/account.js): its menu link is hidden, and a link to it opens Sign in and
   comes back to that page afterwards. With PostgreSQL on, the dev server also
   refuses the Studio, IPFS-upload and contract APIs without a session
   (tools/serve.mjs), so the workflows can't be run by calling them directly. */
const PUBLIC_VIEWS = new Set(["login", "discover"]);
const GATED_NAMES = { library: "My Library", studio: "the Studio", publish: "Publish", royalties: "Royalties",
  asset: "this track", player: "the player" };
const signedIn = () => !!window.DMAF_ACCOUNT?.user;
const authKnown = () => !!window.DMAF_ACCOUNT?.settled;     // js/account.js has asked the server who you are
let waitingForAuth = false;
const NEXT_KEY = "dmaf_next";
let nextPage = null;                                        // the page to open after signing in
function setNext(hash) { nextPage = hash; try { hash ? sessionStorage.setItem(NEXT_KEY, hash) : sessionStorage.removeItem(NEXT_KEY); } catch {} }
function peekNext() { if (nextPage) return nextPage; try { return sessionStorage.getItem(NEXT_KEY); } catch { return null; } }
/* Called by js/account.js after signing in or registering: where to go next. */
window.DMAF_AFTER_SIGNIN = () => { const h = peekNext(); setNext(null); return h ? "#/" + h : "#/library"; };
function applyNav() {
  $$("#topnav a[data-nav]").forEach(a => { if (!PUBLIC_VIEWS.has(a.dataset.nav)) a.hidden = !signedIn(); });
}
function gateNote() {
  const el = $("#auth-next"), next = peekNext();
  const show = !signedIn() && !!next;
  el.hidden = !show;
  if (show) el.textContent = `Sign in to open ${GATED_NAMES[next.split("/")[0]] || "that page"} — you'll go straight there afterwards. Discover is open to everyone.`;
}

/* ---------------- router ---------------- */
const routes = ["login", "library", "discover", "studio", "publish", "asset", "player", "royalties"];
function route() {
  const hash = location.hash.replace("#/", "") || "login";
  const [name, arg] = hash.split("/");
  const view = routes.includes(name) ? name : "login";
  if (!PUBLIC_VIEWS.has(view) && !signedIn()) {
    $$(".view").forEach(v => v.classList.remove("active"));
    if (!authKnown()) { waitingForAuth = true; return; }    // decided when js/account.js knows (dmaf:account)
    setNext(hash);
    location.replace("#/login");                            // → hashchange → route()
    return;
  }
  if (view === "discover") setNext(null);                    // went browsing instead of signing in
  if (view === "login") gateNote();
  $$(".view").forEach(v => v.classList.remove("active"));
  $("#view-" + view).classList.add("active");
  $$("#topnav a").forEach(a => a.classList.toggle("active", a.dataset.nav === view));
  window.scrollTo({ top: 0 });
  if (view === "library") renderLibrary();
  window.leaveAsset?.(view);
  if (view === "discover") window.renderChainAssets?.();
  if (view === "royalties") { renderRoyalties(); window.renderLiveRoyalties?.(); }
  if (view === "publish") window.renderPublish?.(arg);
  if (view === "asset") window.renderAsset?.(arg);
  if (view === "player") renderPlayer(arg);
  if (view === "studio") { renderContracts(); window.studioEnter?.(arg); }
}
window.addEventListener("hashchange", route);
/* Signed in or out (or the session ended): update the menu, and leave a gated page when signed out. */
window.addEventListener("dmaf:account", () => {
  applyNav();
  const name = (location.hash.replace("#/", "") || "login").split("/")[0];
  const view = routes.includes(name) ? name : "login";
  if (waitingForAuth || (!PUBLIC_VIEWS.has(view) && !signedIn())) { waitingForAuth = false; route(); }
  else if (view === "login") gateNote();
  else if (view === "discover") window.renderChainAssets?.();   // "Pay & play" ↔ "Sign in to play"
});

/* ---------------- auth ----------------
   Sign-in, registration and the account card live in js/account.js. */

/* ---------------- library ---------------- */
function stemBars(n) {
  let s = "";
  for (let i = 0; i < 18; i++) s += `<i style="height:${20 + Math.abs(Math.sin(i * .7 + n)) * 60}%"></i>`;
  return s;
}
/* My Library: the connected wallet's on-chain assets (js/media.js), the signed-in user's
   IPFS files (js/library.js) and its agreements (js/agreement.js). */
function renderLibrary() {
  window.renderLibraryAgreements?.();
  window.renderMyAssets?.();
  window.renderIpfsLibrary?.();     // js/library.js — needs PostgreSQL + sign-in
}

/* ---------------- studio wizard ---------------- */
const wiz = { unlocked: new Set([1]), stems: [], contract: null, agreement: null };

function wizGo(step) {
  wiz.unlocked.add(step);
  $$(".wstep").forEach(w => (w.hidden = true));
  $("#wstep-" + step).hidden = false;
  $$("#studio-stepper .stp").forEach(el => {
    const n = +el.dataset.step;
    el.classList.toggle("current", n === step);
    el.classList.toggle("done", wiz.unlocked.has(n) && n < step);
    el.disabled = !wiz.unlocked.has(n);
  });
}
$$("#studio-stepper .stp").forEach(el =>
  el.addEventListener("click", () => { const n = +el.dataset.step; if (wiz.unlocked.has(n)) wizGo(n); }));
$$("[data-back]").forEach(b => b.addEventListener("click", () => wizGo(+b.dataset.back)));

/* step 1 (agreement) and step 2 (stems) live in js/agreement.js */
$("#to-w4").addEventListener("click", () => wizGo(4));

/* step 4 — reuse licence (rendered from API so templates are data, not markup) */
let contractsLoaded = false;
async function renderContracts() {
  if (contractsLoaded) return;
  const list = $("#contract-list");
  const cs = await api.contracts();
  list.innerHTML = cs.map(c => `
    <button class="contract" data-id="${c.id}" data-name="${c.name}" role="radio" aria-checked="false">
      <span class="radio"></span>
      <span><h3>${c.name}</h3><p>${c.blurb}</p>
        <span class="tags" style="display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.6rem">
          ${c.terms.map(([k, t]) => `<span class="pill ${k}">${t}</span>`).join("")}
        </span></span>
      <span class="price">${c.price}<small>${c.priceNote}</small></span>
    </button>`).join("");
  $$(".contract", list).forEach(el => el.addEventListener("click", () => {
    $$(".contract", list).forEach(x => { x.classList.remove("selected"); x.setAttribute("aria-checked", "false"); });
    el.classList.add("selected"); el.setAttribute("aria-checked", "true");
    wiz.contract = { id: el.dataset.id, name: el.dataset.name };
    $("#to-w5").disabled = false;
  }));
  contractsLoaded = true;
}
const escH = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const PRESET_NAMES = { producer: "Producer mix", karaoke: "Karaoke", acappella: "A-cappella", rhythm: "Rhythm section" };
const studioPresets = () => $$("#wstep-3 [data-preset]").filter(c => c.checked).map(c => c.dataset.preset);
const studioRule = () => $("#rule-limits").value;
/* What the package is built from — a change means the built package is stale. */
const packageInputs = () => JSON.stringify({ ag: wiz.agreement?.id, title: $("#pk-title").value, genre: $("#pk-genre").value,
  stems: wiz.stems.map(s => [s.key, s.name, s.group, s.vol]), presets: studioPresets(), rule: studioRule() });

$("#to-w5").addEventListener("click", () => {
  $("#sum-title").textContent = $("#pk-title").value + " · " + $("#pk-genre").value;
  $("#sum-stems").textContent = wiz.stems.length + " stems · " + [...new Set(wiz.stems.map(s => s.group))].join(", ");
  $("#sum-contract").textContent = wiz.contract?.name || "—";
  $("#sum-presets").textContent = studioPresets().map(k => PRESET_NAMES[k]).join(", ") + " · " + $("#rule-limits").selectedOptions[0].textContent;
  const ag = wiz.agreement;
  $("#sum-agreement").textContent = ag ? `${ag.title} · ${ag.id}` : "—";
  $("#sum-parties").textContent = ag ? ag.parties.filter(p => !p.types.includes("mvco:EndUser")).map(p => p.name || p.label).join(", ") : "—";
  $("#sum-wallet").textContent = window.W3?.state.account || "the connected MetaMask wallet";
  if (wiz.pkg && wiz.pkg.inputs !== packageInputs()) resetPackage();     // stems or settings changed since
  wizGo(5);
});
function resetPackage() {
  wiz.pkg = null;
  $("#chainbox").className = "chainbox";
  $("#chain-title").textContent = "Package with ffmpeg";
  $("#pkg-rows").innerHTML = `<p class="help">Mixes the stems into a 320 kbps MP3 at their default levels (ffmpeg) and packages them as one IMAF file — an AAC track per stem, with the groups, presets and rule above; MP4Box muxes it when installed. Also computes the waveforms for the asset page's stem visualiser, then pins everything to your IPFS node. Runs on the dev server.</p>`;
  $("#sum-fingerprint").textContent = "sha256 of the IMAF file — after packaging";
  $("#btn-package").disabled = false; $("#btn-package").textContent = "Build mix + IMAF package";
  $("#btn-publish").setAttribute("aria-disabled", "true");
}

/* step 5 — build the mix + IMAF package (server/stems.mjs), then publish the mix (js/media.js) */
$("#btn-package").addEventListener("click", async () => {
  const btn = $("#btn-package"), box = $("#chainbox"), ag = wiz.agreement;
  const S = window.DMAF_STUDIO;
  btn.disabled = true; btn.textContent = "Packaging…";
  box.className = "chainbox pending";
  $("#chain-title").innerHTML = `<span class="pulse"></span> Mixing and packaging ${wiz.stems.length} stems with ffmpeg…`;
  try {
    if (!ag) throw new Error("Pick an agreement first (step 1)");
    const ff = await S.status();
    if (!ff) throw new Error("The dev server isn't reachable — open the app through `npm run serve`");
    if (!ff.ok) throw new Error(`ffmpeg isn't usable on the dev server: ${ff.error}`);
    const missing = wiz.stems.filter(s => !s.onServer);
    if (missing.length) throw new Error(`Not on the dev server yet: ${missing.map(s => s.name).join(", ")} — go back to step 2 and choose those files again`);
    const artist = ag.parties.find(p => /Author|ArtistBand|Artist/.test(p.id))?.name || "";
    const inputs = packageInputs();
    const r = await S.package(ag.id, {
      title: $("#pk-title").value.trim() || ag.work.title, artist, genre: $("#pk-genre").value,
      stems: wiz.stems.map(s => ({ key: s.key, name: s.name, group: s.group, level: s.vol })),
      presets: studioPresets(), rule: studioRule(),
    });
    wiz.pkg = { ...r, inputs, agreementId: ag.id, title: $("#pk-title").value.trim() || ag.work.title, artist, genre: $("#pk-genre").value,
      reuse: wiz.contract, builtAt: new Date().toISOString() };
    try { sessionStorage.setItem("dmaf_pkg", JSON.stringify(wiz.pkg)); } catch {}
    window.DMAF_PACKAGE = wiz.pkg;
    const kb = n => (n / 1048576).toFixed(2) + " MB";
    const dur = s => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");
    const cid = c => `<a class="mono cid" href="/ipfs/${escH(c)}" target="_blank" rel="noopener">${escH(c)}</a>`;
    const row = (k, v) => `<div class="pkgrow"><span>${k}</span><span>${v}</span></div>`;
    box.className = "chainbox confirmed";
    $("#chain-title").innerHTML = `<span class="tick">✓</span> Mix and IMAF package built and pinned to IPFS`;
    $("#pkg-rows").innerHTML = [
      row("Mix (MP3 · 320 kbps)", `${cid(r.mix.cid)}<br>${kb(r.mix.size)} · ${dur(r.mix.durationSec)} · ${r.mix.sampleRate / 1000} kHz`),
      row(`IMAF package (${escH(r.imaf.brand)})`, `${cid(r.imaf.cid)}<br>${kb(r.imaf.size)} · ${r.imaf.tracks.length} AAC tracks: ${r.imaf.tracks.map(t => escH(t.name)).join(", ")}`),
      row("Groups", r.imaf.groups.map(g => `${escH(g.name)} (${g.elements.length})`).join(" · ")),
      row("Presets", r.imaf.presets.map(p => escH(p.name) + (p.presetId === r.imaf.defaultPresetId ? " (default)" : "")).join(" · ")),
      row("Listener rule", r.imaf.rules.mixing.length ? `${r.imaf.rules.mixing.length} volume limits (${escH($("#rule-limits").selectedOptions[0].textContent)})` : "Free mixing — no limits"),
      row("Muxed by", escH(r.muxer || "ffmpeg") + (r.mp4box?.check ? ` · MP4Box -info reads ${r.mp4box.check.tracks} tracks, brand ${escH(r.mp4box.check.brand)}` : "")),
      row("Waveforms (visualiser)", r.waveforms ? `${cid(r.waveforms.cid)}<br>${r.waveforms.tracks} stems + mix · ${r.waveforms.fps} frames/s` : "—"),
      row("Description (JSON)", cid(r.manifest.cid)),
      row("Commands", `<details><summary>what ran</summary><div class="pkgcmd">${escH(r.ffmpeg.mix)}\n\n${escH(r.ffmpeg.mux)}</div></details>`),
    ].join("");
    $("#sum-fingerprint").textContent = "sha256 · " + r.imaf.sha256;
    btn.textContent = "Rebuild"; btn.disabled = false;
    const pubBtn = $("#btn-publish");
    pubBtn.href = "#/publish/" + ag.id; pubBtn.removeAttribute("aria-disabled");
    toast("Mix + IMAF package ready — publish the mix on-chain next");
  } catch (e) {
    box.className = "chainbox";
    $("#chain-title").textContent = e.message;
    btn.disabled = false; btn.textContent = "Build mix + IMAF package";
    toast(e.message);
  }
});

/* ---------------- player ---------------- */
const PRESETS = {
  "Producer mix": s => ({ vol: s.vol, muted: false }),
  "Karaoke":      s => ({ vol: s.vol, muted: s.name === "Lead vocals" }),
  "A-cappella":   s => ({ vol: s.vol, muted: s.group !== "Vocals" }),
  "Rhythm only":  s => ({ vol: s.vol, muted: s.group !== "Rhythm" }),
};
let playerStems = [], vuTimer = null;

async function renderPlayer(id) {
  $("#pl-title").textContent = "Player";
  playerStems = (await api.stems(id || "pkg1")).map(s => ({ ...s, muted: false }));
  const all = [...(await api.myPackages()), ...(await api.discover())];
  const pkg = all.find(p => p.id === id) || all[0];
  if (pkg) { $("#pl-title").textContent = pkg.title; $("#pl-sub").textContent = `${pkg.artist || "You"} · ${pkg.stems} stems · interactive playback under “${pkg.contract}” terms.`; }
  $("#pl-presets").innerHTML = Object.keys(PRESETS).map((p, i) =>
    `<button class="preset ${i === 0 ? "active" : ""}" data-p="${p}">${p}</button>`).join("");
  $$("#pl-presets .preset").forEach(b => b.addEventListener("click", () => {
    $$("#pl-presets .preset").forEach(x => x.classList.remove("active")); b.classList.add("active");
    playerStems = playerStems.map(s => ({ ...s, ...PRESETS[b.dataset.p](s) }));
    drawStems();
  }));
  drawStems();
}
function drawStems() {
  $("#pl-stems").innerHTML = playerStems.map((s, i) => `
    <div class="stem ${s.muted ? "is-muted" : ""}">
      <span><span class="name">${s.name}</span><br><span class="grp">${s.group}</span></span>
      <button class="mutebtn ${s.muted ? "muted" : ""}" data-i="${i}">${s.muted ? "MUTED" : "MUTE"}</button>
      <input type="range" class="vol" min="0" max="100" value="${s.vol}" data-i="${i}" ${s.muted ? "disabled" : ""}>
      <span class="vu" data-vu="${i}"></span>
    </div>`).join("");
  $$("#pl-stems .mutebtn").forEach(b => b.addEventListener("click", () => {
    const s = playerStems[+b.dataset.i]; s.muted = !s.muted; drawStems();
  }));
  $$("#pl-stems input.vol").forEach(r => r.addEventListener("input", () => {
    playerStems[+r.dataset.i].vol = +r.value;
  }));
}
$("#pl-play").addEventListener("click", () => {
  toast("Playing (simulated — wire to DASH manifest for real audio)");
  clearInterval(vuTimer);
  vuTimer = setInterval(() => {
    $$("#pl-stems .vu").forEach((vu, i) => {
      const s = playerStems[i]; if (!s) return;
      const amp = s.muted ? 0 : s.vol / 100;
      vu.innerHTML = Array.from({ length: 6 }, () =>
        `<i style="height:${4 + Math.random() * 22 * amp}px"></i>`).join("");
    });
  }, 140);
});
$("#pl-stop").addEventListener("click", () => { clearInterval(vuTimer); $$("#pl-stems .vu").forEach(v => v.innerHTML = ""); });

/* ---------------- royalties ---------------- */
async function renderRoyalties() {
  const r = await api.royalties();
  $("#royalty-stats").innerHTML = `
    <div class="stat"><div class="big">${r.balance}</div><div class="lbl">Wallet balance from contracts</div></div>
    <div class="stat"><div class="big">${r.month}</div><div class="lbl">Collected this month</div></div>
    <div class="stat"><div class="big">${r.reuses}</div><div class="lbl">Reuses of your work</div></div>`;
  $("#royalty-rows").innerHTML = r.events.map(e => `
    <tr><td>${e.date}</td><td>${e.what}</td><td>${e.who}</td>
      <td class="${e.dir === "in" ? "amount-in" : "amount-out"}">${e.amount}</td>
      <td class="mono">${e.tx}</td></tr>`).join("");
}

route();
