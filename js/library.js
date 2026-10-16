/* ============================================================
   My Library · IPFS files

   Lists every file the signed-in user put on IPFS through DMAF — recorded
   in PostgreSQL by the dev server (server/library.mjs) — with whether it's
   still pinned on the local IPFS node. Pin / unpin, hide / show, and add
   new files to IPFS from here. Needs PostgreSQL + sign-in (js/account.js).
   ============================================================ */
(() => {
const $ = s => document.querySelector(s);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const KIND = {
  audio: "Audio (MP3)", mix: "Stem mix (MP3)", imaf: "IMAF package", "imaf-description": "IMAF description", waveforms: "Waveforms",
  metadata: "Asset metadata", agreement: "Agreement (MCO)", "scm-token": "Smart-contract token", upload: "Upload", file: "File",
};
const FILTERS = [
  ["media", "Media & documents", k => k !== "scm-token"],
  ["audio", "Audio & mixes", k => k === "audio" || k === "mix"],
  ["stems", "Stem packages", k => ["imaf", "imaf-description", "waveforms"].includes(k)],
  ["docs", "Metadata & agreements", k => k === "metadata" || k === "agreement"],
  ["tokens", "Smart-contract tokens", k => k === "scm-token"],
  ["uploads", "Uploads", k => k === "upload" || k === "file"],
  ["all", "Everything", () => true],
];
const state = { filter: "media", hidden: false, files: [], totals: null, ipfsError: null, confirm: null, busy: new Set() };
const mb = n => (n == null ? "—" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
const when = t => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

async function call(method, path, body) {
  const r = await fetch("/library-api" + path, { method, credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) window.DMAF_ACCOUNT?.sessionEnded?.();       // the session ended: back to Sign in
  if (!r.ok) throw Object.assign(new Error(j.message || `${path} failed (${r.status})`), { status: r.status });
  return j;
}

async function load() {
  const j = await call("GET", "/files" + (state.hidden ? "?hidden=1" : ""));
  state.files = j.files; state.totals = j.totals; state.ipfsError = j.ipfsError;
}

window.renderIpfsLibrary = async () => {
  const box = $("#ipfs-lib"), note = $("#ipfs-note");
  const A = window.DMAF_ACCOUNT;
  await A?.ready();
  note.textContent = "";
  if (!A || A.mode !== "postgres") {
    box.innerHTML = `<div class="empty">Your IPFS files are listed here when the dev server has PostgreSQL and you're signed in.
      ${A?.db?.error ? `<br><span class="help">${esc(A.db.error)}</span>` : ""}<br><span class="help">Setup: <code>docs/DATABASE.md</code></span></div>`;
    return;
  }
  if (!A.user) {
    box.innerHTML = `<div class="empty">Sign in to see the files you've put on IPFS. <a class="btn secondary sm" href="#/login">Sign in</a></div>`;
    return;
  }
  box.innerHTML = `<p class="help">Reading your library…</p>`;
  try { await load(); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  draw();
};

function draw() {
  const box = $("#ipfs-lib"), t = state.totals || {};
  const pass = (FILTERS.find(f => f[0] === state.filter) || FILTERS[0])[2];
  const list = state.files.filter(f => pass(f.kind));
  const pinned = state.files.filter(f => f.pinned).length;
  $("#ipfs-note").innerHTML = `${t.files || 0} file${t.files === 1 ? "" : "s"} · ${mb(t.bytes)}${state.ipfsError ? "" : ` · ${pinned} pinned on your node`}${t.hidden ? ` · ${t.hidden} hidden` : ""}`;
  box.innerHTML = `
    <div class="libbar">
      <label class="libfilter">Show <select id="lib-filter">${FILTERS.map(([k, l]) => `<option value="${k}" ${k === state.filter ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="libcheck"><input type="checkbox" id="lib-hidden" ${state.hidden ? "checked" : ""}> Include hidden files</label>
      <span class="libspacer"></span>
      <button class="btn primary sm" id="lib-add">＋ Add files to IPFS</button>
      <input type="file" id="lib-file" multiple hidden>
    </div>
    <div id="lib-progress" class="help" hidden></div>
    ${state.ipfsError ? `<p class="checks"><span class="pill warn">IPFS node unreachable</span> <span class="help">${esc(state.ipfsError)} — pin status unknown.</span></p>` : ""}
    ${list.length ? `<div class="tablewrap"><table class="table libtable">
      <thead><tr><th>File</th><th>CID</th><th class="r">Size</th><th>Added</th><th>Used by</th><th>On your node</th><th></th></tr></thead>
      <tbody>${list.map(row).join("")}</tbody></table></div>`
      : `<div class="empty">${state.files.length ? "Nothing in this view — pick another filter." : "Nothing on IPFS yet. Publish an MP3, package stems in the Studio, or add files here."}</div>`}`;
  $("#lib-filter").addEventListener("change", e => { state.filter = e.target.value; draw(); });
  $("#lib-hidden").addEventListener("change", async e => { state.hidden = e.target.checked; await window.renderIpfsLibrary(); });
  $("#lib-add").addEventListener("click", () => $("#lib-file").click());
  $("#lib-file").addEventListener("change", e => { upload([...e.target.files]); e.target.value = ""; });
  box.querySelectorAll("[data-act]").forEach(b => b.addEventListener("click", () => act(b.dataset.act, b.dataset.cid)));
  box.querySelectorAll("[data-copy]").forEach(b => b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast("CID copied"); } catch { toast(b.dataset.copy); }
  }));
}

function row(f) {
  const busy = state.busy.has(f.cid), confirm = state.confirm === f.cid;
  const pin = f.pinned == null ? `<span class="pill">unknown</span>`
    : f.pinned ? `<span class="pill ok">✓ pinned</span>` : `<span class="pill warn">not pinned</span>`;
  const pinBtn = f.pinned == null ? ""
    : f.pinned
      ? (confirm
          ? `<button class="btn danger sm" data-act="unpin-yes" data-cid="${esc(f.cid)}">Unpin anyway</button> <button class="btn secondary sm" data-act="cancel" data-cid="${esc(f.cid)}">Keep</button>
             <div class="help">${f.assetId ? `Asset #${f.assetId} uses it — once your node garbage-collects it, listeners can't fetch it unless another node pins it.` : "Your node may delete it at the next garbage collection."}</div>`
          : `<button class="btn secondary sm" data-act="unpin" data-cid="${esc(f.cid)}" ${busy ? "disabled" : ""}>Unpin</button>`)
      : `<button class="btn secondary sm" data-act="pin" data-cid="${esc(f.cid)}" ${busy ? "disabled" : ""}>Pin</button>`;
  return `<tr class="${f.hidden ? "is-hidden" : ""}">
    <td><b>${esc(f.name || "—")}</b><br><span class="pill kind-${esc(f.kind)}">${esc(KIND[f.kind] || f.kind)}</span>${f.hidden ? ` <span class="pill">hidden</span>` : ""}</td>
    <td><a class="mono cid" href="/ipfs/${esc(f.cid)}${f.name ? `?filename=${encodeURIComponent(f.name)}` : ""}" target="_blank" rel="noopener" title="${esc(f.cid)}">${esc(f.cid.slice(0, 10))}…${esc(f.cid.slice(-6))}</a>
      <button class="iconbtn" data-copy="${esc(f.cid)}" title="Copy CID" aria-label="Copy CID">⧉</button></td>
    <td class="r num">${mb(f.size)}</td>
    <td>${when(f.createdAt)}</td>
    <td>${f.assetId ? `<a href="#/asset/${f.assetId}">Asset #${f.assetId}</a>` : f.agreementId ? `<span class="help">agreement ${esc(f.agreementId)}</span>` : "—"}</td>
    <td>${pin}</td>
    <td class="libacts">${pinBtn}
      <button class="btn secondary sm" data-act="${f.hidden ? "show" : "hide"}" data-cid="${esc(f.cid)}" ${busy ? "disabled" : ""}>${f.hidden ? "Show" : "Hide"}</button></td>
  </tr>`;
}

async function act(what, cid) {
  if (what === "unpin") { state.confirm = cid; return draw(); }
  if (what === "cancel") { state.confirm = null; return draw(); }
  state.confirm = null; state.busy.add(cid); draw();
  try {
    if (what === "pin") { await call("POST", "/pin", { cid }); toast("Pinned on your IPFS node"); }
    if (what === "unpin-yes") { await call("POST", "/unpin", { cid }); toast("Unpinned"); }
    if (what === "hide" || what === "show") { await call("POST", "/hide", { cid, hidden: what === "hide" }); toast(what === "hide" ? "Hidden from My Library" : "Shown again"); }
    await load();
  } catch (e) { toast(e.message); }
  state.busy.delete(cid); draw();
}

async function upload(files) {
  const p = $("#lib-progress");
  for (const [i, f] of files.entries()) {
    p.hidden = false;
    try {
      const r = await window.W3.ipfsAdd(f, f.name, x => (p.textContent = `Adding ${f.name} (${i + 1}/${files.length})… ${Math.round(x * 100)}%`),
        { kind: "upload", source: "library" });
      toast(`${f.name} added · ${r.cid.slice(0, 12)}…`);
    } catch (e) { toast(`${f.name}: ${window.W3.errMsg(e)}`); }
  }
  p.hidden = true;
  await window.renderIpfsLibrary();
}

window.addEventListener("dmaf:account", () => { if ((location.hash.replace("#/", "").split("/")[0] || "login") === "library") window.renderIpfsLibrary(); });
if (location.hash.startsWith("#/library")) window.renderIpfsLibrary();
})();
