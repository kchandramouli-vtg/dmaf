/* ============================================================
   DMAF · IPFS + chain proof of concept

   Publish  → MP3 to IPFS, MCO agreement (JSON-LD) to IPFS,
              metadata JSON to IPFS, then registerAsset() on the
              DmafMediaRegistry contract through MetaMask.
   Discover → assets read live from the contract (+ metadata from IPFS).
   Asset    → pay-per-play: access() sends ETH, the contract records
              the play and pays the agreement's parties in the same
              transaction — through the agreement's ISO/IEC 21000-23
              Smart Contract for Media (Contract.payTo) or the
              registry's direct split; the MP3 then streams from IPFS.
   Royalties→ live earnings / plays for the connected wallet.

   Uses window.W3 (js/web3.js) and window.DMAF_MCO (js/agreement.js).
   ============================================================ */
(() => {
const { ethers } = window;
const W = window.W3;
const { short, fmtEth, accountLabel, same } = W;
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pretty = l => window.DMAF_MCO?.pretty(l) ?? l;
const view = () => location.hash.replace("#/", "").split("/")[0] || "login";
const shortCid = c => (c ? c.slice(0, 10) + "…" + c.slice(-6) : "—");
const pct = bps => (bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 }) + "%";
const when = ts => new Date(ts * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const fmtDur = s => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");
const roleLabel = r => String(r || "").split("+").map(x => x.replace(/([a-z])([A-Z])/g, "$1 $2")).join(" + ");
const slug = s => String(s || "untitled").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const addrCell = a => a ? `<span class="mono" title="${esc(a)}">${esc(short(a))}</span>${accountLabel(a) ? ` <span class="help inline">${accountLabel(a)}</span>` : ""}` : "—";
const cidLink = (cid, text) => cid ? `<a class="mono cid" href="${W.gateway(cid)}" target="_blank" rel="noopener" title="${esc(cid)}">${esc(text || shortCid(cid))}</a>` : "—";
const empty = html => `<div class="empty" style="grid-column:1/-1">${html}</div>`;
const parseLogs = (c, rc) => rc.logs.map(l => { try { return c.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
async function sha256Hex(blob) {
  const h = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return "0x" + [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/* ============================================================
   Service status (wallet · network · chain · contract · IPFS)
   ============================================================ */
async function renderServices(el) {
  const s = await W.services(true);
  const st = W.state, CFG = W.CFG, hasMM = !!window.ethereum;
  const onChain = st.chainId === CFG.chainId;
  const row = (name, ok, text, action = "") => `<div class="svcrow">
    <span class="svcname">${name}</span>
    <span class="pill ${ok === true ? "ok" : ok === "warn" ? "warn" : "no"}">${ok === true ? "✓" : ok === "warn" ? "!" : "✕"}</span>
    <span class="svctext">${text}</span><span>${action}</span></div>`;
  el.innerHTML = [
    row("MetaMask", hasMM ? (st.account ? true : "warn") : false,
      !hasMM ? "Not detected — install the extension, then reload" : st.account ? addrCell(st.account) : "Not connected",
      hasMM && !st.account ? `<button class="btn secondary sm" data-act="connect">Connect</button>` : ""),
    row("Network", !st.account ? "warn" : onChain ? true : "warn",
      !st.account ? "—" : onChain ? `Hardhat local · chain ${CFG.chainId}` : `MetaMask is on chain ${st.chainId}`,
      st.account && !onChain ? `<button class="btn secondary sm" data-act="switch">Switch to Hardhat</button>` : ""),
    row("Local chain", s.chain.ok, s.chain.ok ? `${esc(CFG.rpcUrl)} · block ${s.block}` : "Offline — run <code>npm run chain</code>"),
    row("Registry contract", s.chain.ok && s.contract,
      s.contract ? addrCell(CFG.address) : s.chain.ok ? "Not deployed on this chain — run <code>npm run deploy</code>, then reload" : "—"),
    row("ISO/IEC 21000-23 API", s.scm?.ok ? true : "warn", s.scm?.ok
      ? `${s.scm.operations} operations at <code>/api</code> · Smart Contracts for Media can be deployed`
      : `Not loaded${s.scm?.error ? ` (${esc(s.scm.error)})` : ""} — plays use the direct split`),
    (() => {
      const A = window.DMAF_ACCOUNT || {};
      return row("Account", A.user && A.mode === "postgres" ? true : "warn",
        A.mode === "postgres"
          ? (A.user ? `Signed in as ${esc(A.user.artistName || A.user.email || short(A.user.wallet || ""))} · files you add appear in My Library` : "Not signed in — files you add won't appear in My Library")
          : "Demo sign-in (no PostgreSQL) — My Library can't list your IPFS files",
        A.mode === "postgres" && !A.user ? `<a class="btn secondary sm" href="#/login">Sign in</a>` : "");
    })(),
    row("IPFS node", s.ipfs.ok, s.ipfs.ok ? `Kubo ${esc(s.ipfs.version)} · gateway ${esc(s.ipfs.gateway)}`
      : s.ipfs.error === "dev server not reachable" ? "Open the app through <code>npm run serve</code> (it proxies your IPFS node)"
      : "Offline — start IPFS Desktop or <code>ipfs daemon</code>"),
  ].join("");
  el.querySelector("[data-act=connect]")?.addEventListener("click", () => W.connect().catch(e => toast(W.errMsg(e))));
  el.querySelector("[data-act=switch]")?.addEventListener("click", () => W.ensureChain().catch(e => toast(W.errMsg(e))));
  return s;
}

/* ============================================================
   MCO agreement → who gets what from one play

   Every paid play is settled on-chain in the listener's access()
   transaction, one of two ways (chosen per asset at publish):

   scm    — the agreement's ISO/IEC 21000-23 Smart Contract for Media.
            The listener pays the party the end user's payment
            obligation names (e.g. the streaming service) and
            Contract.payTo passes each income percentage down the chain.
            Needs distinct, ordinary (EOA) wallets along every income
            percentage, and the /api server to deploy the contract.
   direct — the registry pays each wallet its net share of one consumer
            payment (Studio · revenue flow) in basis points. Works for
            any agreement: parties without a wallet are paid through the
            publisher, shared wallets are merged, and a payee that can't
            take ETH is credited for withdraw().
   ============================================================ */
const toAddr = w => { try { if (/^0x[0-9a-fA-F]{40}$/.test(w || "")) return ethers.getAddress(w.toLowerCase()); } catch {} return null; };

/* direct: the working PoC's split, unchanged */
function directSplit(a, publisher) {
  const out = { mode: "direct", rows: [], payees: [], warnings: [], errors: [], needsWallet: false, flow: null };
  if (!a) {
    out.rows = [{ id: "Publisher", label: "Publisher", name: "Your wallet", bps: 10000, account: publisher, fallback: !publisher }];
  } else {
    const f = out.flow = window.DMAF_MCO.flow(a);
    let rows = f.rows.map(r => ({ id: r.p.id, label: pretty(r.p.label), name: r.p.name, wallet: r.p.wallet, net: r.net }));
    if (rows.some(r => r.net < -1e-9)) out.warnings.push("Some parties pay out more than they receive in this agreement; they get no share of plays.");
    rows = rows.filter(r => r.net > 1e-12);
    const total = rows.reduce((s, r) => s + r.net, 0);
    if (!rows.length || !total) { out.errors.push("This agreement has no payment flow to split — add payment obligations in the Studio."); return out; }
    // largest-remainder rounding so the basis points sum to exactly 10 000
    rows.forEach(r => { r.exact = (r.net / total) * 10000; r.bps = Math.floor(r.exact); });
    let rem = 10000 - rows.reduce((s, r) => s + r.bps, 0);
    [...rows].sort((x, y) => (y.exact - y.bps) - (x.exact - x.bps)).forEach(r => { if (rem > 0) { r.bps++; rem--; } });
    rows.forEach(r => { const acct = toAddr(r.wallet); r.account = acct || publisher; r.fallback = !acct; });
    out.rows = rows.filter(r => r.bps > 0).sort((x, y) => y.bps - x.bps);
    const nw = out.rows.filter(r => r.fallback);
    if (nw.length) out.warnings.push(`${nw.map(r => r.label).join(", ")} ${nw.length > 1 ? "have" : "has"} no wallet in the agreement — that share goes to the publisher (the connected wallet).`);
    if (publisher && !a.parties.some(p => same(p.wallet, publisher)))
      out.warnings.push("Your connected wallet isn't a party to this agreement — you'd be publishing on the parties' behalf.");
  }
  const merged = new Map();
  for (const r of out.rows) {
    if (!r.account) { out.needsWallet = true; continue; }
    const k = r.account.toLowerCase();
    const e = merged.get(k) || { account: r.account, shareBps: 0, roles: [] };
    e.shareBps += r.bps; e.roles.push(r.id); merged.set(k, e);
  }
  out.payees = [...merged.values()].map(e => ({ account: e.account, shareBps: e.shareBps, role: e.roles.join("+") }));
  if (out.payees.length > 16) out.errors.push("The registry accepts at most 16 distinct payee wallets per asset.");
  return out;
}

/* scm: Contract.payTo arithmetic on the agreement model (js/scm.js) */
function scmSplit(a, publisher, contracts = new Set()) {
  const out = { mode: "scm", rows: [], warnings: [], errors: [], needsWallet: !publisher, entry: null };
  if (!a) {
    out.entry = "Producer";
    out.rows = [{ id: "Producer", label: "Publisher", name: "Your wallet", bps: 10000, account: publisher, fallback: false }];
  } else {
    // a deployed SCM keeps the wallets it was deployed with
    const bound = id => toAddr(a.parties.find(p => p.id === id)?.wallet) || toAddr(a.chain?.standard ? a.chain.bindings?.[id] : null);
    out.errors.push(...window.SCM.payToIssues(a, publisher).map(m => m[0].toUpperCase() + m.slice(1) + "."));
    let pv = { entry: null, rows: [] };
    try { pv = window.SCM.previewFromModel(a, 10000n); } catch {}
    out.entry = pv.entry;
    out.rows = pv.rows.filter(r => r.amount > 0n).map(r => {
      const p = a.parties.find(x => x.id === r.party) || {};
      const acct = bound(r.party);
      return { id: r.party, label: pretty(p.label || r.party), name: p.name, account: acct || publisher, fallback: !acct, bps: Number(r.amount) };
    }).sort((x, y) => y.bps - x.bps);
    const nw = out.rows.filter(r => r.fallback);
    if (nw.length) out.warnings.push(`${nw.map(r => r.label).join(", ")} ${nw.length > 1 ? "have" : "has"} no wallet in the agreement — bound to the publisher (the connected wallet) in the Smart Contract for Media.`);
    if (publisher && !a.parties.some(p => same(p.wallet, publisher)))
      out.warnings.push("Your connected wallet isn't a party to this agreement — you'd be publishing on the parties' behalf.");
  }
  const cw = out.rows.filter(r => r.account && contracts.has(r.account.toLowerCase()));
  if (cw.length) out.errors.push(`${cw.map(r => r.label).join(", ")} ${cw.length > 1 ? "are" : "is"} paid to a contract wallet — Contract.payTo pays with transfer() (2,300 gas), which most contract wallets can't accept.`);
  return out;
}

/* Pick the settlement for this publish: the Smart Contract for Media when it
   can settle the agreement (and the user hasn't chosen the direct split),
   otherwise the direct split. */
function computeSplits(a, publisher) {
  const scm = scmSplit(a, publisher, pub.contracts);
  const direct = directSplit(a, publisher);
  const why = [...scm.errors];
  if (!pub.api && !pub.live) why.unshift("The ISO/IEC 21000-23 API isn't running — run npm install, then npm run serve, to deploy Smart Contracts for Media.");
  const scmOk = !why.length;
  const mode = pub.mode === "direct" || !scmOk ? "direct" : "scm";
  return { ...(mode === "scm" ? scm : direct), scmOk, why, auto: pub.mode == null };
}

/* ============================================================
   Publish view
   ============================================================ */
const pub = { file: null, url: null, duration: null, agreement: null, agreements: [], busy: false, splits: null, lastAg: undefined,
  mode: null,              // null = automatic · "scm" · "direct" (the user's choice)
  api: false,              // ISO/IEC 21000-23 API reachable (needed to deploy an SCM)
  live: false,             // the selected agreement's SCM is already on this chain
  contracts: new Set(),    // party wallets that are contracts (lower-case)
  pkg: null, pkgFile: null };  // Studio stems → ffmpeg mix + IMAF package (js/app.js step 5), and the mix as a File
const STEPS = [
  ["audio", "Upload the MP3 to IPFS"],
  ["agreement", "Pin the MCO agreement (JSON-LD) to IPFS"],
  ["scm", "Smart Contract for Media (ISO/IEC 21000-23)"],
  ["meta", "Pin the metadata JSON to IPFS"],
  ["chain", "Register the asset — confirm in MetaMask"],
];
const stepState = {};
function setStep(k, status, detail = "") { stepState[k] = { status, detail }; renderSteps(); }
function renderSteps() {
  $("#pub-steps").innerHTML = STEPS.map(([k, label], i) => {
    const s = stepState[k] || { status: "idle" };
    const dot = s.status === "done" ? "✓" : s.status === "err" ? "✕" : s.status === "skip" ? "–" : s.status === "run" ? `<span class="pulse"></span>` : i + 1;
    return `<li class="${s.status}"><span class="dot">${dot}</span><span><b>${label}</b>${s.detail ? `<span class="help">${s.detail}</span>` : ""}</span></li>`;
  }).join("");
}
function priceWei() {
  try { const v = String($("#pub-price").value || "").trim(); if (!v || +v < 0) return null; return ethers.parseEther(v); } catch { return null; }
}
function renderSplits() {
  const sp = pub.splits = computeSplits(pub.agreement, W.state.account);
  const price = priceWei();
  const seg = (m, label, sub, disabled, title = "") => `<button type="button" role="radio" class="seg${sp.mode === m ? " active" : ""}" data-settle="${m}"
    aria-checked="${sp.mode === m}" ${disabled ? "disabled" : ""} title="${esc(title)}">${label} <span class="segsub">${sub}</span></button>`;
  const picker = `<div class="segmented settle" role="radiogroup" aria-label="How plays are paid">
      ${seg("scm", "Smart Contract for Media", "Contract.payTo · ISO/IEC 21000-23", !sp.scmOk, sp.why[0] || "")}
      ${seg("direct", "Direct split", "the registry pays each wallet")}
    </div>`;
  let head;
  if (sp.mode === "scm") {
    const entryLabel = pub.agreement ? pretty(pub.agreement.parties.find(p => p.id === sp.entry)?.label || sp.entry || "") : "you";
    head = !pub.agreement
      ? `<p class="help" style="margin-bottom:.6rem">No agreement — a one-party Smart Contract for Media is deployed for you and receives 100% of every play.</p>`
      : `<p class="help" style="margin-bottom:.6rem">Each play pays <b>${esc(entryLabel)}</b> (the end user's payment obligation); the Smart Contract for Media's <span class="mono">payTo</span> then passes every income percentage down the chain of payment obligations. Shares below use the same arithmetic.</p>`;
  } else {
    const f = sp.flow;
    head = !pub.agreement
      ? `<p class="help" style="margin-bottom:.6rem">No agreement — the publisher wallet receives 100% of every play.</p>`
      : `<p class="help" style="margin-bottom:.6rem">Derived from the agreement's payment obligations: ${f?.consumerPay
          ? `one consumer payment of <b>${esc(f.gross)} ${esc(f.baseUnit)}</b> flows through the chain of obligations`
          : `100 units entering at the first payer flow through the chain of obligations`}; each party's net becomes its share of every ETH play, paid by the registry in the same transaction.</p>`;
    if (!sp.scmOk && sp.why.length)
      head += `<p class="help" style="margin:-.2rem 0 .6rem">Direct split because Contract.payTo can't settle this one: ${esc(sp.why.join(" "))}</p>`;
  }
  const table = sp.rows.length ? `<div class="tablewrap"><table class="table">
    <thead><tr><th>Party</th><th>Wallet (receives ETH)</th><th class="r">Share</th><th class="r">Per play</th></tr></thead>
    <tbody>${sp.rows.map(r => `<tr>
      <td><b>${esc(r.label)}</b>${r.name ? `<br><span class="help inline">${esc(r.name)}</span>` : ""}</td>
      <td>${r.fallback ? `<span class="pill warn">no wallet</span> → ${r.account ? addrCell(r.account) : "publisher"}` : addrCell(r.account)}</td>
      <td class="r num">${pct(r.bps)}</td>
      <td class="r num">${price != null ? fmtEth((price * BigInt(r.bps)) / 10000n) + " ETH" : "—"}</td></tr>`).join("")}
    </tbody></table></div>` : "";
  const notes = [...sp.errors.map(m => ["err", m]), ...sp.warnings.map(m => ["warn", m])];
  if (sp.needsWallet && !sp.errors.length) notes.push(["warn", "Connect MetaMask — the publisher wallet receives any unassigned share."]);
  if (!notes.length && sp.rows.length) notes.push(["ok", sp.mode === "scm"
    ? `${new Set(sp.rows.map(r => r.account?.toLowerCase())).size} payee wallet${sp.rows.length > 1 ? "s" : ""} · shares sum to 100% · settled by Contract.payTo`
    : `${sp.payees.length} payee wallet${sp.payees.length > 1 ? "s" : ""} · shares sum to 100% · paid by the registry`]);
  $("#pub-splits").innerHTML = picker + head + table + (notes.length ? `<ul class="checks" style="margin-top:.9rem">${notes.map(([l, m]) => `<li class="${l}">${esc(m)}</li>`).join("")}</ul>` : "");
  $("#pub-splits").querySelectorAll("[data-settle]").forEach(b => b.addEventListener("click", () => {
    pub.mode = b.dataset.settle; renderSplits(); updateGo();
  }));
}
function updateGo() {
  const missing = !pub.file ? "Choose an MP3 to publish." : !$("#pub-title").value.trim() ? "Give the track a title."
    : priceWei() == null ? "Set a valid price per play." : pub.splits?.errors.length ? pub.splits.errors[0] : "";
  $("#pub-go").disabled = pub.busy || !!missing;
  $("#pub-hint").textContent = pub.busy ? "Publishing…" : missing
    || (pub.splits?.mode === "direct" || pub.live ? "Ready — MetaMask will ask you to confirm one transaction."
      : "Ready — MetaMask will ask you to confirm two transactions: deploy the Smart Contract for Media, then register the asset.");
}
function pickAgreement() {
  const id = $("#pub-ag").value;
  if (id !== pub.lastAg) pub.mode = null;           // a new agreement starts on the automatic choice
  pub.lastAg = id;
  pub.agreement = id ? pub.agreements.find(a => a.id === id) || null : null;
  pub.live = false; pub.contracts = new Set();
  const t = $("#pub-title");
  if (pub.agreement && !t.dataset.touched) t.value = pub.agreement.work.title || t.value;
  if (pub.agreement && pub.agreement.work.genre) $("#pub-genre").value = pub.agreement.work.genre;
  renderSplits(); updateGo();
  checkWallets(pub.agreement);
  attachPackage();
}
/* ---------------- a Studio package (stems → mix + IMAF) waiting to be published ---------------- */
function storedPackage() {
  if (window.DMAF_PACKAGE) return window.DMAF_PACKAGE;
  try { return JSON.parse(sessionStorage.getItem("dmaf_pkg") || "null"); } catch { return null; }
}
function forgetPackage() {
  try { sessionStorage.removeItem("dmaf_pkg"); } catch {}
  window.DMAF_PACKAGE = null;
  const wasMix = pub.file && pub.file === pub.pkgFile;
  pub.pkg = null; pub.pkgFile = null; $("#pub-pkg").hidden = true;
  if (wasMix) {
    pub.file = null; $("#pub-fileinfo").hidden = true; $("#pub-drop strong").textContent = "Drop an MP3 here, or click to choose";
  }
  updateGo();
}
async function attachPackage() {
  const k = storedPackage(), el = $("#pub-pkg");
  pub.pkg = k && pub.agreement && k.agreementId === pub.agreement.id ? k : null;
  if (!pub.pkg) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<b>From the Studio:</b> “${esc(k.title)}” — ffmpeg mix of ${k.imaf.tracks.length} stems (MP3 320 kbps · ${cidLink(k.mix.cid)})
    and its IMAF package (${esc(k.imaf.brand)} · ${k.imaf.tracks.length} tracks · ${cidLink(k.imaf.cid)}). Publishing registers the mix for
    pay-per-play and records the IMAF package in the asset's metadata.
    <button class="btn secondary sm" id="pub-pkg-drop" style="margin-left:.3rem">Publish a different MP3 instead</button>`;
  $("#pub-pkg-drop").addEventListener("click", forgetPackage);
  const t = $("#pub-title");
  if (!t.dataset.touched) t.value = k.title;
  if (k.genre) $("#pub-genre").value = k.genre;
  if (k.artist) $("#pub-artist").value = k.artist;
  if (pub.file && pub.file === pub.pkgFile) return;
  try {
    const r = await fetch(W.gateway(k.mix.cid));
    if (!r.ok) throw new Error(`gateway ${r.status}`);
    const f = new File([await r.blob()], k.mix.fileName || "mix.mp3", { type: "audio/mpeg" });
    if (pub.pkg !== k) return;                       // the user moved on meanwhile
    pub.pkgFile = f; setFile(f);
  } catch (e) {
    el.insertAdjacentHTML("beforeend", `<br><span class="pill warn">couldn't load the mix from IPFS (${esc(e.message)}) — is the IPFS node running?</span>`);
  }
}
/* Async facts the split needs: is the agreement's SCM already deployed, and
   which party wallets are contracts (Contract.payTo can't pay those). */
async function checkWallets(a) {
  const wallets = [...new Set([...(a?.parties || []).map(p => toAddr(p.wallet)), toAddr(W.state.account)].filter(Boolean))];
  const [live, codes] = await Promise.all([
    a ? window.SCM.isLive(a).catch(() => false) : false,
    Promise.all(wallets.map(w => W.readProvider.getCode(w).catch(() => "0x"))),
  ]);
  if (a !== pub.agreement) return;                  // the user picked another agreement meanwhile
  pub.live = live;
  pub.contracts = new Set(wallets.filter((w, i) => codes[i] && codes[i] !== "0x").map(w => w.toLowerCase()));
  renderSplits(); updateGo();
}
window.renderPublish = async (agId) => {
  renderSteps();
  renderServices($("#pub-svc"));
  await window.DMAF_MCO?.ready?.();
  pub.api = await window.SCM.available().catch(() => false);
  pub.agreements = (await api.agreements()).filter(a => a.status === "active" || a.status === "delivered");
  const sel = $("#pub-ag");
  sel.innerHTML = pub.agreements.map(a => `<option value="${esc(a.id)}">${esc(a.work.title || "Untitled")} — ${esc(a.title)}</option>`).join("")
    + `<option value="">No agreement — 100% to my wallet</option>`;
  const want = agId ?? pub.lastAg;
  if (want !== undefined && [...sel.options].some(o => o.value === want)) sel.value = want;
  pickAgreement();
};
function setFile(f) {
  if (!f) return;
  if (!/audio\/(mpeg|mp3)/i.test(f.type) && !/\.mp3$/i.test(f.name)) { toast("Please choose an MP3 file"); return; }
  if (pub.pkg && f !== pub.pkgFile) { pub.pkg = null; pub.pkgFile = null; $("#pub-pkg").hidden = true; }   // the user chose their own MP3
  pub.file = f; pub.duration = null;
  if (pub.url) URL.revokeObjectURL(pub.url);
  pub.url = URL.createObjectURL(f);
  const info = $("#pub-fileinfo");
  info.hidden = false;
  info.innerHTML = `<div><b>${esc(f.name)}</b> <span class="help inline">· ${(f.size / 1048576).toFixed(2)} MB · <span id="pub-dur">reading…</span></span></div>
    <audio controls preload="metadata" src="${pub.url}"></audio>`;
  const au = info.querySelector("audio");
  au.addEventListener("loadedmetadata", () => { pub.duration = au.duration; $("#pub-dur").textContent = fmtDur(au.duration); });
  const t = $("#pub-title");
  if (!t.value.trim()) t.value = f.name.replace(/\.mp3$/i, "").replace(/[_-]+/g, " ");
  $("#pub-drop strong").textContent = "Replace the MP3";
  STEPS.forEach(([k]) => delete stepState[k]); renderSteps(); $("#pub-done").hidden = true;
  updateGo();
}
$("#pub-drop").addEventListener("click", () => $("#pub-file").click());
$("#pub-drop").addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#pub-file").click(); } });
$("#pub-drop").addEventListener("dragover", e => { e.preventDefault(); $("#pub-drop").classList.add("over"); });
$("#pub-drop").addEventListener("dragleave", () => $("#pub-drop").classList.remove("over"));
$("#pub-drop").addEventListener("drop", e => { e.preventDefault(); $("#pub-drop").classList.remove("over"); setFile(e.dataTransfer.files[0]); });
$("#pub-file").addEventListener("change", e => { setFile(e.target.files[0]); e.target.value = ""; });
$("#pub-ag").addEventListener("change", pickAgreement);
$("#pub-title").addEventListener("input", e => { e.target.dataset.touched = "1"; updateGo(); });
$("#pub-price").addEventListener("input", () => { renderSplits(); updateGo(); });
$("#pub-go").addEventListener("click", publishNow);

async function publishNow() {
  if (pub.busy) return;
  pub.busy = true; updateGo();
  STEPS.forEach(([k]) => delete stepState[k]); renderSteps(); $("#pub-done").hidden = true;
  let cur = null;
  try {
    await W.connect();
    const s = await renderServices($("#pub-svc"));
    if (!s.contract) throw new Error("The registry contract isn't deployed on this chain — run `npm run deploy`, then reload");
    if (!s.ipfs.ok) throw new Error("The IPFS node is offline — start IPFS Desktop or `ipfs daemon`");
    const publisher = W.state.account;
    await checkWallets(pub.agreement);
    renderSplits();
    const sp = pub.splits;
    if (sp.errors.length) throw new Error(sp.errors[0]);
    if (!sp.rows.length || sp.needsWallet) throw new Error("Connect MetaMask — the publisher wallet is needed for the split");
    const price = priceWei();
    const title = $("#pub-title").value.trim(), artist = $("#pub-artist").value.trim(), genre = $("#pub-genre").value;
    const description = $("#pub-desc").value.trim();
    const file = pub.file;

    const pkg = pub.pkg && file === pub.pkgFile ? pub.pkg : null;     // the Studio's ffmpeg mix of the stems
    cur = "audio";
    let audio, sha256;
    if (pkg) {
      audio = { cid: pkg.mix.cid }; sha256 = pkg.mix.sha256;
      setStep(cur, "done", `CID ${cidLink(audio.cid, audio.cid)} · ffmpeg mix of ${pkg.imaf.tracks.length} stems, pinned with its IMAF package ${cidLink(pkg.imaf.cid)}`);
    } else {
      setStep(cur, "run", "Uploading… 0%");
      audio = await W.ipfsAdd(file, file.name, p => setStep("audio", "run", `Uploading… ${Math.round(p * 100)}%`), { kind: "audio", agreementId: pub.agreement?.id });
      sha256 = await sha256Hex(file);
      setStep(cur, "done", `CID ${cidLink(audio.cid, audio.cid)}`);
    }

    cur = "agreement";
    const agreement = pub.agreement ? window.DMAF_MCO.normalize(pub.agreement) : window.DMAF_MCO.direct(title, publisher);
    setStep(cur, "run", "Serialising the MCO contract…");
    const bytes = new TextEncoder().encode(JSON.stringify(window.DMAF_MCO.jsonld(agreement), null, 2));
    const r = await W.ipfsAdd(new Blob([bytes], { type: "application/ld+json" }), slug(agreement.work.title || title) + ".mco.jsonld", null, { kind: "agreement", agreementId: pub.agreement?.id });
    const ag = { cid: r.cid, hash: ethers.keccak256(bytes), id: pub.agreement ? agreement.id : "" };
    setStep(cur, "done", `CID ${cidLink(r.cid, r.cid)} · keccak256 <span class="mono">${esc(short(ag.hash))}</span>${pub.agreement ? "" : " · no agreement — 100% to your wallet"}`);

    cur = "scm";
    let scm = null;
    if (sp.mode === "direct") {
      setStep(cur, "skip", `Direct split — the registry pays ${sp.payees.length} wallet${sp.payees.length > 1 ? "s" : ""} itself; no Smart Contract for Media needed`);
    } else if (pub.agreement && await window.SCM.isLive(agreement)) {
      scm = agreement.chain;
      setStep(cur, "done", `Already on-chain at ${addrCell(scm.contractAddress)}`);
    } else {
      setStep(cur, "run", "Converting the agreement (ISO/IEC 21000-23 forward conversion)…");
      scm = await window.SCM.deployAgreement(agreement, (k, msg) => setStep("scm", "run", esc(msg)));
      if (pub.agreement) { pub.agreement.chain = scm; await api.saveAgreement(pub.agreement); }
      setStep(cur, "done", `${addrCell(scm.contractAddress)} · ${scm.deonticTokens + scm.objectTokens} NFTs · tx <span class="mono">${esc(short(scm.txHash))}</span>`);
    }
    if (scm && !scm.entry?.address) throw new Error("The Smart Contract for Media has no party for the listener to pay");

    cur = "meta"; setStep(cur, "run", "Pinning…");
    const meta = {
      name: title, description, artist, genre,
      animation_url: `ipfs://${audio.cid}`,
      properties: {
        audio: { cid: audio.cid, uri: `ipfs://${audio.cid}`, mimeType: file.type || "audio/mpeg", fileName: file.name,
          size: file.size, durationSec: pub.duration ? +pub.duration.toFixed(2) : null, sha256,
          ...(pkg ? { mixedFrom: { stems: pkg.imaf.tracks.length, tool: `ffmpeg ${pkg.ffmpeg.version} amix (normalize=1, weights = Studio levels / 70)`,
            weights: pkg.mix.weights, imaf: pkg.imaf.cid } } : {}) },
        ...(pkg ? {
          imaf: { standard: "ISO/IEC 23000-12 (MPEG-A Interactive Music Application Format)", brand: pkg.imaf.brand,
            cid: pkg.imaf.cid, uri: `ipfs://${pkg.imaf.cid}`, mimeType: "audio/mp4", fileName: pkg.imaf.fileName, size: pkg.imaf.size, sha256: pkg.imaf.sha256,
            description: { cid: pkg.manifest.cid, uri: `ipfs://${pkg.manifest.cid}` },
            ...(pkg.waveforms ? { waveforms: { cid: pkg.waveforms.cid, uri: `ipfs://${pkg.waveforms.cid}`, fps: pkg.waveforms.fps } } : {}),
            muxer: pkg.muxer || null,
            tracks: pkg.imaf.tracks.map(t => ({ trackId: t.trackId, name: t.name, group: t.group, level: t.level, source: t.source })),
            groups: pkg.imaf.groups.map(g => ({ groupId: g.groupId, name: g.name, elements: g.elements })),
            presets: pkg.imaf.presets.map(p => ({ presetId: p.presetId, name: p.name, volumes: p.volumes })),
            defaultPresetId: pkg.imaf.defaultPresetId, rule: pkg.imaf.rule, mixingRules: pkg.imaf.rules.mixing.length },
          reuseLicence: pkg.reuse || null,
        } : {}),
        pricePerPlay: { wei: price.toString(), eth: ethers.formatEther(price) },
        agreement: { id: ag.id || null, title: agreement.title, template: agreement.templateKey,
          standard: "MPEG-21 Media Contract Ontology (ISO/IEC 21000-21)", cid: ag.cid, uri: `ipfs://${ag.cid}`, keccak256: ag.hash },
        settlement: scm ? "iso21000-23-payTo" : "direct-split",
        ...(scm ? { smartContract: { standard: "ISO/IEC 21000-23 Smart Contracts for Media", address: scm.contractAddress, nfToken: scm.nfToken,
          contentUri: scm.contentUri, contentHash: scm.contentHash, entry: scm.entry, bindings: scm.bindings } } : {}),
        splits: sp.rows.map(r => ({ party: r.id, role: r.label, name: r.name || null, wallet: r.account, shareBps: r.bps,
          ...(r.fallback ? { note: scm ? "no wallet in the agreement; bound to the publisher" : "no wallet in the agreement; paid to the publisher" } : {}) })),
        publisher, chainId: W.CFG.chainId, registry: W.CFG.address, publishedAt: new Date().toISOString(),
      },
    };
    const m = await W.ipfsAdd(new Blob([JSON.stringify(meta, null, 2)], { type: "application/json" }), "metadata.json", null, { kind: "metadata", agreementId: pub.agreement?.id });
    setStep(cur, "done", `CID ${cidLink(m.cid, m.cid)}`);

    cur = "chain"; setStep(cur, "run", "Waiting for you to confirm in MetaMask…");
    const c = await W.signerContract();
    const input = { audioCid: audio.cid, metadataCid: m.cid, agreementCid: ag.cid, agreementHash: ag.hash, agreementId: ag.id, pricePerPlay: price,
      scm: scm ? scm.contractAddress : ethers.ZeroAddress, entry: scm ? scm.entry.address : ethers.ZeroAddress };
    // Smart Contract for Media: payees come from its income percentages · direct split: wallet + basis points
    const tx = await c.registerAsset(input, scm ? [] : sp.payees);
    setStep(cur, "run", `Broadcast <span class="mono">${esc(short(tx.hash))}</span> — waiting for the block…`);
    const rc = await tx.wait();
    const ev = parseLogs(c, rc).find(e => e.name === "AssetRegistered");
    const id = Number(ev.args.assetId);
    if (window.DMAF_ACCOUNT?.user && window.DMAF_ACCOUNT.mode === "postgres")       // My Library: these files belong to asset #id
      fetch("/library-api/link", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ assetId: id, cids: [audio.cid, m.cid, ag.cid, pkg?.imaf.cid, pkg?.manifest.cid, pkg?.waveforms?.cid].filter(Boolean) }) }).catch(() => {});
    setStep(cur, "done", `Asset #${id} · block ${rc.blockNumber} · ${Number(rc.gasUsed).toLocaleString()} gas`);

    const done = $("#pub-done");
    done.hidden = false;
    done.innerHTML = `<h3><span class="tick">✓</span> “${esc(title)}” is live as asset #${id}</h3>
      <div class="chainrow"><span>Transaction</span><span class="mono">${esc(rc.hash)}</span></div>
      <div class="chainrow"><span>Price · settlement</span><span>${fmtEth(price)} ETH per play · ${scm
        ? `Contract.payTo of ${addrCell(scm.contractAddress)}`
        : `direct split to ${sp.payees.length} wallet${sp.payees.length > 1 ? "s" : ""}`}</span></div>
      <div class="chainrow"><span>Metadata</span><span>${cidLink(m.cid, m.cid)}</span></div>
      <div class="donebtns"><a class="btn primary sm" href="#/asset/${id}">Open the asset page</a><a class="btn secondary sm" href="#/discover">See it in Discover</a></div>`;
    toast(`Published “${title}” on-chain as asset #${id}`);
    W.refreshChip();
    if (pkg) forgetPackage();                          // published: the package is now part of the asset
    pub.file = null;                                   // a new upload needs a new file
    $("#pub-drop strong").textContent = "Choose another MP3 to publish";
  } catch (e) {
    if (cur) setStep(cur, "err", esc(W.errMsg(e)));
    toast(W.errMsg(e));
  } finally {
    pub.busy = false; updateGo();
  }
}

/* ============================================================
   Discover · on-chain assets
   ============================================================ */
let pendingPlay = null;
function assetCard(a) {
  const m = a.meta || {}, p = m.properties || {};
  const mine = same(a.publisher, W.state.account);
  return `<div class="pkg">
    <div class="cover" style="filter:hue-rotate(${(a.id * 47) % 360}deg)"><div class="stems">${stemBars(a.id + 7)}</div><span class="cover-id">#${a.id}</span></div>
    <div class="body">
      <h3>${esc(m.name || "Untitled")}</h3>
      <div class="meta">${esc(m.artist || short(a.publisher))}${p.audio?.durationSec ? " · " + fmtDur(p.audio.durationSec) : ""} · ${a.plays} paid play${a.plays === 1 ? "" : "s"}</div>
      <div class="tags">
        <span class="pill ipfsp">IPFS</span><span class="pill dlt">DLT</span>${p.imaf ? `<span class="pill imaf" title="Mixed from ${p.imaf.tracks?.length || "?"} stems; IMAF package on IPFS">IMAF</span>` : ""}
        ${a.agreementId ? `<span class="pill mco">MCO · ${a.payees.length} payee${a.payees.length === 1 ? "" : "s"}</span>` : `<span class="pill">No agreement</span>`}
        ${a.mode === "scm" ? `<span class="pill dlt" title="Settled by Contract.payTo of the ISO/IEC 21000-23 Smart Contract for Media ${esc(a.scm)}">SCM · payTo</span>`
          : `<span class="pill" title="The registry pays each payee wallet its share">Direct split</span>`}
        <span class="pill ok">${fmtEth(a.price)} ETH / play</span>
        ${mine ? `<span class="pill">Yours</span>` : ""}${a.active ? "" : `<span class="pill no">Paused</span>`}
      </div>
    </div>
    <div class="rowbtns">
      <button class="btn primary sm" data-play="${a.id}" ${a.active ? "" : "disabled"}>${window.DMAF_ACCOUNT?.user ? "▶ Pay &amp; play" : "Sign in to play"}</button>
      <a class="btn secondary sm" href="#/asset/${a.id}">Details</a>
    </div></div>`;
}
/* Asset grid from the registry: every asset (Discover) or only the connected wallet's (My Library). */
async function renderAssetGrid(grid, note, { mine = false } = {}) {
  grid.innerHTML = `<p class="help">Reading the registry…</p>`; note.textContent = "";
  const s = await W.services();
  if (!s.chain.ok) { grid.innerHTML = empty(`The local chain is offline. Start it with <code>npm run chain</code>, then <code>npm run deploy</code>.`); return; }
  if (!s.contract) { grid.innerHTML = empty(`DmafMediaRegistry isn't deployed on this chain. Run <code>npm run deploy</code> and reload.`); return; }
  const acct = W.state.account;
  if (mine && !acct) {
    grid.innerHTML = empty(`Connect MetaMask to see what this wallet has published. <button class="btn secondary sm" data-act="connect">Connect MetaMask</button>`);
    grid.querySelector("[data-act=connect]")?.addEventListener("click", () => W.connect().catch(e => toast(W.errMsg(e))));
    return;
  }
  let list;
  try { list = await W.getAssets(); } catch (e) { grid.innerHTML = empty(esc(W.errMsg(e))); return; }
  if (mine) list = list.filter(a => same(a.publisher, acct));
  note.innerHTML = mine
    ? `${list.length} asset${list.length === 1 ? "" : "s"} published by ${addrCell(acct)}`
    : `${list.length} asset${list.length === 1 ? "" : "s"} · registry <span class="mono">${esc(short(W.CFG.address))}</span>`;
  if (!list.length) {
    grid.innerHTML = empty(mine
      ? `Nothing published from this wallet yet. <a href="#/publish">Publish an MP3</a>, or deliver stems from an agreement in the <a href="#/studio">Studio</a>.`
      : window.DMAF_ACCOUNT?.user ? `Nothing published yet. <a href="#/publish">Publish an MP3</a> and it shows up here.`
      : `Nothing published yet. <a href="#/login">Sign in</a> to publish an MP3.`);
    return;
  }
  grid.innerHTML = list.map(assetCard).join("");
  grid.querySelectorAll("[data-play]").forEach(b => b.addEventListener("click", () => {
    pendingPlay = +b.dataset.play;
    location.hash = "#/asset/" + b.dataset.play;
  }));
}
window.renderChainAssets = () => { pendingPlay = null; return renderAssetGrid($("#chain-grid"), $("#chain-note")); };
window.renderMyAssets = () => renderAssetGrid($("#library-grid"), $("#library-note"), { mine: true });

/* ============================================================
   Asset view · pay-per-play
   ============================================================ */
let asset = null, unlocked = false, playing = false;
const nameFor = acct => {
  const sp = (asset?.meta?.properties?.splits || []).filter(s => same(s.wallet, acct));
  if (sp.length) return sp.map(s => s.name || s.role).join(" + ");
  const role = asset?.payees.find(p => same(p.account, acct))?.role;
  return role ? roleLabel(role) : same(acct, asset?.publisher) ? "Publisher" : W.accountLabel(acct) || "Party";
};
function payBtnIdle(again) {
  const b = $("#as-pay");
  if (!asset) { b.disabled = true; b.textContent = "Pay & play"; return; }
  b.disabled = !asset.active;
  b.textContent = asset.active ? `${again ? "Play again" : "Pay & play"} · ${fmtEth(asset.price)} ETH` : "Paused by the publisher";
}
function lockPlayer() {
  const au = $("#as-audio");
  au.pause(); au.removeAttribute("src"); au.load();
  $("#as-player").hidden = true; playing = false;
}
window.leaveAsset = v => { if (v !== "asset" && playing) { lockPlayer(); payBtnIdle(true); } };
$("#as-audio").addEventListener("ended", () => {
  lockPlayer(); payBtnIdle(true);
  toast("Play finished — the next play is a new payment");
});

async function drawHeader() {
  const m = asset.meta || {}, p = m.properties || {};
  $("#as-title").textContent = m.name || `Asset #${asset.id}`;
  $("#as-sub").innerHTML = [esc(m.artist || ""), esc(m.genre || ""), p.audio?.durationSec ? fmtDur(p.audio.durationSec) : "",
    `published ${when(asset.createdAt)}`].filter(Boolean).join(" · ")
    + `<br><span class="tagsrow"><span class="pill ipfsp">IPFS</span> <span class="pill dlt">DLT · asset #${asset.id}</span> ${asset.agreementId ? `<span class="pill mco">MCO agreement</span>` : ""}${p.imaf ? ` <span class="pill imaf" title="ISO/IEC 23000-12">IMAF · ${p.imaf.tracks?.length || "?"} stems</span>` : ""}</span>`;
  $("#as-price").textContent = `${fmtEth(asset.price)} ETH`;
  let mine = "";
  if (W.state.account) {
    try { const n = Number(await W.read.playsBy(asset.id, W.state.account)); mine = ` · ${n} by you`; } catch {}
  }
  $("#as-plays").innerHTML = `<b>${asset.plays}</b> paid play${asset.plays === 1 ? "" : "s"}${mine}<br>${fmtEth(asset.totalPaid)} ETH paid out`;
  if (!playing) payBtnIdle(unlocked);
}
async function drawSplit() {
  const f = W.read.filters;
  const evs = (await Promise.all([W.events(f.Payout(asset.id)), W.events(f.PayoutDeferred(asset.id))]).catch(() => [[], []])).flat();
  const got = {};
  evs.forEach(e => { const k = e.args.payee.toLowerCase(); got[k] = (got[k] || 0n) + e.args.amount; });
  const roleOf = acct => asset.mode === "direct"
    ? roleLabel(asset.payees.find(p => same(p.account, acct))?.role)
    : (asset?.meta?.properties?.splits || []).filter(x => same(x.wallet, acct)).map(x => x.role).join(" + ");
  $("#as-split-note").innerHTML = asset.mode === "scm"
    ? `Settled by <span class="mono">Contract.payTo</span> of the ISO/IEC 21000-23 Smart Contract for Media ${addrCell(asset.scm)}: the listener pays ${addrCell(asset.entry)}, and each income percentage is passed on in the same transaction.${asset.agreementId ? ` Agreement ${esc(asset.agreementId)}.` : ""}`
    : asset.agreementId
      ? `Direct split from agreement ${esc(asset.agreementId)}: each paid play is split in these proportions inside the <span class="mono">access()</span> transaction. A payee that can't receive ETH is credited and withdraws later.`
      : "No agreement — the publisher receives every play.";
  const mine = W.state.account && asset.payees.find(p => same(p.account, W.state.account));
  if (mine) $("#as-split-note").innerHTML += ` <span class="pill warn">Note</span> Your connected wallet ${addrCell(W.state.account)} is a payee (${esc(nameFor(W.state.account))}, ${pct(mine.shareBps)}): if you pay from it, that share comes straight back to you, so your balance drops by less than the price.`;
  $("#as-split").innerHTML = `<thead><tr><th>Party</th><th>Wallet</th><th class="r">Share</th><th class="r">Received</th></tr></thead>
    <tbody>${asset.payees.map(p => `<tr><td><b>${esc(nameFor(p.account))}</b><br><span class="help inline">${esc(roleOf(p.account))}</span></td>
      <td>${addrCell(p.account)}</td><td class="r num">${pct(p.shareBps)}</td>
      <td class="r num amount-in">${fmtEth(got[p.account.toLowerCase()] || 0n)} ETH</td></tr>`).join("")}</tbody>`;
}
async function drawRefs() {
  const a = asset;
  const item = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
  $("#as-refs").innerHTML = [
    // the publisher can always see (and verify) its own file; listeners after paying
    item("Audio (MP3) on IPFS", unlocked || same(a.publisher, W.state.account)
      ? `${cidLink(a.audioCid, a.audioCid)}<br><button class="btn secondary sm" id="as-verify-audio" style="margin-top:.35rem">Verify the MP3 on IPFS</button> <span id="as-audio-check" class="help inline"></span>`
      : `<span class="pill warn">Shown after a paid play</span>`),
    ...(a.meta?.properties?.imaf ? [(() => {
      const im = a.meta.properties.imaf;
      const open = unlocked || same(a.publisher, W.state.account);
      return item("IMAF package (ISO/IEC 23000-12)", open
        ? `<a class="mono cid" href="${W.gateway(im.cid)}?filename=${encodeURIComponent(im.fileName || "package.ima")}&download=true" title="${esc(im.cid)}">${esc(im.cid)}</a>
           <span class="help inline">${esc(im.brand)} · ${im.tracks.length} tracks (${im.tracks.map(t => esc(t.name)).join(", ")}) · presets: ${im.presets.map(x => esc(x.name)).join(", ")}</span>
           <br><button class="btn secondary sm" id="as-verify-imaf" style="margin-top:.35rem">Read the IMAF package back</button> <span id="as-imaf-check" class="help inline"></span>`
        : `<span class="pill warn">Shown after a paid play</span> <span class="help inline">${im.tracks.length} stems · ${im.presets.length} presets</span>`);
    })()] : []),
    item("Metadata JSON", cidLink(a.metadataCid, a.metadataCid)),
    item("MCO agreement (JSON-LD)", a.agreementCid ? `${cidLink(a.agreementCid, a.agreementCid)} <span id="as-verify" class="help inline">checking hash…</span>` : "—"),
    item("Agreement keccak256 (on-chain)", a.agreementCid ? `<span class="mono">${esc(a.agreementHash)}</span>` : "—"),
    ...(a.mode === "scm" ? [
      item("Smart Contract for Media (ISO/IEC 21000-23)", `${addrCell(a.scm)}<br><button class="btn secondary sm" id="as-verify-scm" style="margin-top:.35rem">Read it back from the chain</button> <span id="as-scm-check" class="help inline"></span>`),
      item("Listener pays", addrCell(a.entry)),
    ] : [
      item("Settlement", `Direct split · ${a.payees.length} payee wallet${a.payees.length === 1 ? "" : "s"} paid by the registry`),
    ]),
    item("Publisher", addrCell(a.publisher)),
    item("Registry contract", `${addrCell(W.CFG.address)} · chain ${W.CFG.chainId}`),
  ].join("");
  $("#as-verify-audio")?.addEventListener("click", verifyAudio);
  $("#as-verify-scm")?.addEventListener("click", verifyScm);
  $("#as-verify-imaf")?.addEventListener("click", verifyImaf);
  if (a.agreementCid) {
    try {
      const buf = new Uint8Array(await (await fetch(W.gateway(a.agreementCid))).arrayBuffer());
      const ok = ethers.keccak256(buf) === a.agreementHash;
      $("#as-verify").innerHTML = ok ? `<span class="pill ok">✓ matches the IPFS copy</span>` : `<span class="pill no">✕ IPFS copy doesn't match</span>`;
    } catch { $("#as-verify").textContent = "couldn't fetch from IPFS"; }
  }
}
/* Backward conversion of the asset's Smart Contract for Media (POST /api/x-dmaf/eth/inspect). */
async function verifyScm() {
  const out = $("#as-scm-check"), btn = $("#as-verify-scm");
  btn.disabled = true; out.textContent = "reading the contract, its NFTs and IPFS content…";
  try {
    const { contract, onChain } = await window.SCM.inspect(asset.scm);
    out.innerHTML = `${onChain.contentHashVerified ? `<span class="pill ok">✓ content hash matches IPFS</span>` : `<span class="pill no">✕ content hash mismatch</span>`}
      <span class="pill mco">${esc(contract.metadata?.["rdfs:label"] || contract.identifier)}</span>
      ${Object.keys(contract.parties).length} parties · ${Object.keys(contract.deontics).length} deontic expressions · ${Object.keys(onChain.tokens).length} NFTs`;
  } catch (e) { out.innerHTML = `<span class="pill no">✕ ${esc(e.message)}</span>`; }
  finally { btn.disabled = false; }
}
/* Stem visualiser (js/stemviz.js): waveforms.json from IPFS, or computed by the dev server
   from the published IMAF package for assets packaged before waveforms existed. */
let viz = null;
async function drawStems() {
  const card = $("#as-stems-card"), box = $("#as-stems"), note = $("#as-stems-note");
  viz?.destroy(); viz = null;
  const a = asset, im = a?.meta?.properties?.imaf;
  card.hidden = !im;
  if (!im) return;
  box.innerHTML = `<p class="help">Loading the stem waveforms…</p>`; note.textContent = "";
  let data;
  try {
    if (im.waveforms?.cid) {
      const r = await fetch(W.gateway(im.waveforms.cid));
      if (!r.ok) throw new Error(`IPFS gateway ${r.status}`);
      data = await r.json();
    } else {
      const r = await fetch(`/studio-api/waveforms/${encodeURIComponent(im.cid)}?mix=${encodeURIComponent(a.audioCid)}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || `dev server ${r.status}`);
      data = j;
    }
  } catch (e) { if (asset === a) box.innerHTML = `<p class="help">Couldn't load the stem waveforms: ${esc(e.message)}</p>`; return; }
  if (asset !== a) return;                                       // the user opened another asset meanwhile
  viz = window.DMAF_STEMVIZ.mount(box, $("#as-audio"), data, { canSeek: () => playing });
  note.textContent = `${data.tracks.length} stems from the IMAF package · each lane follows the MP3 as it plays`;
}
/* Read the IMAF file back from IPFS on the dev server (server/imaf.mjs) and compare with the metadata. */
async function verifyImaf() {
  const out = $("#as-imaf-check"), btn = $("#as-verify-imaf"), want = asset.meta.properties.imaf;
  btn.disabled = true; out.textContent = "reading the package from IPFS…";
  try {
    const r = await window.DMAF_STUDIO.readImaf(want.cid);
    const audio = r.tracks.filter(t => t.handler === "soun");
    const ok = r.sha256 === want.sha256 && r.brand === want.brand && audio.length === want.tracks.length && audio.every(t => t.enabled && !t.alternateGroup);
    out.innerHTML = `<span class="pill ${ok ? "ok" : "no"}">${ok ? "✓" : "✕"} ${esc(r.brand)} · ${audio.length} tracks${audio.every(t => t.enabled) ? ", all enabled" : ""}${r.sha256 === want.sha256 ? " · sha256 matches the metadata" : " · sha256 differs"}</span>
      groups ${r.groups.map(g => esc(g.name)).join(", ")} · presets ${r.presets.map(p => esc(p.name)).join(", ")}${r.rules.mixing.length ? ` · ${r.rules.mixing.length} mixing rules` : ""}`;
  } catch (e) { out.innerHTML = `<span class="pill no">✕ ${esc(e.message)}</span>`; }
  finally { btn.disabled = false; }
}
/* Fetch the MP3 back from the IPFS gateway by its CID and compare it with the
   size and SHA-256 recorded in the metadata JSON at publish time. */
async function verifyAudio() {
  const out = $("#as-audio-check"), btn = $("#as-verify-audio");
  const want = asset.meta?.properties?.audio || {};
  btn.disabled = true; out.textContent = "fetching from IPFS…";
  try {
    const r = await fetch(W.gateway(asset.audioCid));
    if (!r.ok) throw new Error(`gateway ${r.status}`);
    const blob = await r.blob();
    const sha = await sha256Hex(blob);
    const okHash = want.sha256 ? sha === want.sha256 : null;
    const sizeTxt = (blob.size / 1048576).toFixed(2) + " MB";
    out.innerHTML = okHash === false
      ? `<span class="pill no">✕ found ${sizeTxt}, but SHA-256 differs from the metadata</span>`
      : `<span class="pill ok">✓ on IPFS · ${sizeTxt} · ${esc(r.headers.get("content-type") || "audio")}${okHash ? " · SHA-256 matches the metadata" : ""}</span>`;
  } catch (e) {
    out.innerHTML = `<span class="pill no">✕ not retrievable: ${esc(e.message)}</span>`;
  } finally { btn.disabled = false; }
}
async function drawLog() {
  const evs = (await W.events(W.read.filters.Accessed(asset.id)).catch(() => [])).reverse();
  if (!evs.length) { $("#as-log").innerHTML = `<tbody><tr><td class="help">No plays yet — be the first.</td></tr></tbody>`; return; }
  const times = await Promise.all(evs.map(e => W.blockTime(e.blockNumber).catch(() => 0)));
  $("#as-log").innerHTML = `<thead><tr><th>Play</th><th>Listener</th><th class="r">Paid</th><th>When</th><th>Block</th><th>Transaction</th><th></th></tr></thead>
    <tbody>${evs.map((e, i) => `<tr${same(e.args.listener, W.state.account) ? ` class="me"` : ""}>
      <td>#${e.args.playNo}</td><td>${addrCell(e.args.listener)}</td>
      <td class="r num amount-out">${fmtEth(e.args.amount)} ETH</td><td>${times[i] ? when(times[i]) : "—"}</td>
      <td>${e.blockNumber}</td><td class="mono" title="${esc(e.transactionHash)}">${esc(short(e.transactionHash))}</td>
      <td class="r">${e.args.amount > 0n ? `<button class="btn secondary sm" data-verify="${esc(e.transactionHash)}" title="Compare every wallet's balance before and after this play">Verify</button>` : ""}</td></tr>`).join("")}</tbody>`;
  $("#as-log").onclick = async ev => {
    const b = ev.target.closest("[data-verify]");
    if (!b) return;
    const tr = b.closest("tr"), open = tr.nextElementSibling?.classList.contains("vrow") ? tr.nextElementSibling : null;
    if (open) { open.remove(); b.textContent = "Verify"; return; }
    const row = document.createElement("tr");
    row.className = "vrow";
    row.innerHTML = `<td colspan="7"><div class="verify help">Reading balances from the chain…</div></td>`;
    tr.after(row);
    b.textContent = "Hide";
    const box = row.querySelector(".verify");
    try { box.className = "verify"; box.innerHTML = verifyHtml(await verifyPlay(b.dataset.verify)); }
    catch (e) { box.className = "verify help"; box.textContent = "Couldn't check this play: " + W.errMsg(e); }
  };
}

/* ---------- Payout check: every wallet's balance just before and just after a play ----------
   js/payout-check.mjs reads the chain's own state (not the app's events) and compares it with
   what the play should have done. The same check runs from Terminal: npm run verify:payouts. */
let payoutCheck = null;
async function verifyPlay(txHash) {
  payoutCheck ||= import(new URL("js/payout-check.mjs", document.baseURI).href).then(m => m.checkPlay);
  const checkPlay = await payoutCheck.catch(e => { payoutCheck = null; throw e; });
  return checkPlay({ ethers: window.ethers, provider: W.readProvider, registry: W.read, txHash });
}
const exactEth = v => v === 0n ? "0 ETH" : `${v < 0n ? "−" : "+"}${fmtEth(v < 0n ? -v : v, 18)} ETH`;
function verifyHtml(r) {
  const party = row => row.roles.map(x =>
    x === "payee" || x === "payee (held)" ? nameFor(row.address) + (x === "payee (held)" ? " (held for withdraw)" : "")
    : x === "listener" ? "Listener (pays the price + gas)"
    : x === "registry" ? `DmafMediaRegistry — ${row.expected > 0n ? "holds payouts for withdraw()" : "keeps nothing"}`
    : "Smart Contract for Media — keeps nothing").join(" + ");
  const li = (ok, t) => `<li class="${ok === null ? "warn" : ok ? "ok" : "err"}">${t}</li>`;
  const both = r.rows.find(x => same(x.address, r.listener) && x.received > 0n);
  const notes = [
    `The listener's change is the price (${fmtEth(r.paid, 18)} ETH) plus the gas for the transaction (${fmtEth(r.gasCost, 18)} ETH).`,
    both ? `The listener's wallet is also a payee here — ${both.share.toFixed(2)}% of the price came straight back to it, so its balance dropped by less than the price. Pay from a wallet that isn't in the split to see the full amount move.` : "",
    r.otherTxsInBlock ? `${r.otherTxsInBlock} other transaction(s) are in the same block, so balance changes may include them.` : "",
  ].filter(Boolean);
  return `<ul class="checks">
      ${li(r.rows.every(x => x.ok), (r.rows.every(x => x.ok) ? "Every wallet's balance changed exactly as this play says" : "Some balances didn't change as this play says (✕ below)") + ` — balances read at block ${r.block - 1} and block ${r.block}`)}
      ${li(r.sumOk, `The payouts add up to the price: ${fmtEth(r.totalOut, 18)} of ${fmtEth(r.paid, 18)} ETH`)}
      ${li(r.splitOk, r.splitOk === null ? "Split not compared (this registry has no previewSplit)"
        : r.splitOk ? `The payouts match the split the contract computes for this price (${r.mode === "scm" ? "Contract.payTo of the Smart Contract for Media" : "direct split"})`
        : `The payouts differ from the contract's split for ${r.splitDiff.map(d => esc(short(d.address))).join(", ")}`)}
    </ul>
    <div class="tablewrap"><table class="table vtable"><thead><tr><th>Wallet</th><th>Party</th><th class="r">Share</th><th class="r">Should change by</th><th class="r">Balance changed by</th><th></th></tr></thead>
    <tbody>${r.rows.map(x => `<tr><td>${addrCell(x.address)}</td><td>${esc(party(x))}</td>
      <td class="r num">${x.received + x.held > 0n ? x.share.toFixed(2) + "%" : ""}</td>
      <td class="r num">${exactEth(x.expected)}</td><td class="r num">${exactEth(x.actual)}</td>
      <td>${x.ok ? `<span class="pill ok">✓</span>` : `<span class="pill no">✕</span>`}</td></tr>`).join("")}</tbody></table></div>
    ${notes.map(n => `<p class="help">${n}</p>`).join("")}`;
}

window.renderAsset = async (idArg) => {
  const id = Number(idArg);
  if (playing) lockPlayer();
  unlocked = false; asset = null; viz?.destroy(); viz = null; $("#as-stems-card").hidden = true;
  $("#as-chain").hidden = true; $("#as-player").hidden = true;
  ["#as-split", "#as-log"].forEach(s => ($(s).innerHTML = ""));
  $("#as-refs").innerHTML = ""; $("#as-split-note").textContent = "";
  $("#as-title").textContent = "Loading…"; $("#as-sub").textContent = ""; $("#as-price").textContent = "—"; $("#as-plays").textContent = "";
  payBtnIdle();
  try { asset = await W.getAssetFull(id); }
  catch (e) {
    $("#as-title").textContent = "Asset not found";
    $("#as-sub").innerHTML = `There is no asset #${esc(idArg)} in the registry at <span class="mono">${esc(short(W.CFG.address))}</span>. If you restarted the local chain, run <code>npm run deploy</code> and publish again.`;
    return;
  }
  await drawHeader();
  await Promise.all([drawSplit(), drawRefs(), drawLog(), drawStems()]);
  if (pendingPlay === id) { pendingPlay = null; payAndPlay(); }
};

async function payAndPlay() {
  if (!asset || playing) return;
  const btn = $("#as-pay"), box = $("#as-chain");
  btn.disabled = true; btn.textContent = "Confirm in MetaMask…";
  box.hidden = false; box.className = "chainbox pending";
  $("#as-chain-title").innerHTML = `<span class="pulse"></span> Waiting for your confirmation in MetaMask`;
  ["#as-tx", "#as-block", "#as-playno"].forEach(s => ($(s).textContent = "—"));
  $("#as-payouts").innerHTML = "";
  try {
    const c = await W.signerContract();
    const fresh = await W.read.getAsset(asset.id);              // price as of now
    const tx = await c.access(asset.id, { value: fresh.pricePerPlay });
    btn.textContent = "Confirming…";
    $("#as-chain-title").innerHTML = `<span class="pulse"></span> Payment broadcast — waiting for the block`;
    $("#as-tx").textContent = tx.hash;
    const rc = await tx.wait();
    const logs = parseLogs(c, rc);
    const acc = logs.find(l => l.name === "Accessed");
    const pays = logs.filter(l => l.name === "Payout" || l.name === "PayoutDeferred");
    box.className = "chainbox confirmed";
    $("#as-chain-title").innerHTML = `<span class="tick">✓</span> Paid ${fmtEth(acc.args.amount)} ETH — play recorded on-chain`;
    $("#as-block").textContent = `#${rc.blockNumber} · ${Number(rc.gasUsed).toLocaleString()} gas`;
    $("#as-playno").textContent = `#${acc.args.playNo}`;
    $("#as-payouts").innerHTML = `<h3 class="subh" style="margin-top:.8rem">Ether transferred in this transaction</h3>`
      + `<div class="chainrow"><span>From you ${addrCell(acc.args.listener)}</span><span class="amount-out">−${fmtEth(acc.args.amount)} ETH</span></div>`
      + pays.map(p => `<div class="chainrow"><span>${esc(nameFor(p.args.payee))} ${addrCell(p.args.payee)}</span>
          <span class="amount-in">+${fmtEth(p.args.amount)} ETH${p.name === "PayoutDeferred" ? " (held for withdraw)" : ""}</span></div>`).join("")
      + `<p class="scmnote">${asset.mode === "scm" ? `Paid by Contract.payTo of ${addrCell(asset.scm)} (ISO/IEC 21000-23).` : "Paid by the registry's direct split."}</p>`
      + `<p style="margin-top:.5rem"><button class="btn secondary sm" id="as-verify-pay">Check every wallet's balance on-chain</button></p><div id="as-verify-out"></div>`;
    $("#as-verify-pay").onclick = async () => {
      const out = $("#as-verify-out");
      out.className = "help"; out.textContent = "Reading balances from the chain…";
      try { out.className = "verify"; out.innerHTML = verifyHtml(await verifyPlay(rc.hash)); }
      catch (e) { out.className = "help"; out.textContent = "Couldn't check this play: " + W.errMsg(e); }
    };

    unlocked = true; playing = true;
    const au = $("#as-audio");
    au.src = W.gateway(asset.audioCid);
    $("#as-player").hidden = false;
    $("#as-player-note").textContent = "Streaming from your IPFS node. When the track ends it locks again — the next play is a new payment.";
    btn.textContent = "Playing — paid";
    au.play().catch(() => {});
    toast("Payment confirmed — playing from IPFS");

    asset = await W.getAssetFull(asset.id);
    drawHeader(); drawSplit(); drawLog(); drawRefs();
    W.refreshChip();
  } catch (e) {
    box.className = "chainbox";
    $("#as-chain-title").textContent = W.errMsg(e);
    toast(W.errMsg(e));
    playing = false; payBtnIdle(unlocked);
  }
}
$("#as-pay").addEventListener("click", payAndPlay);

/* ============================================================
   Royalties · live for the connected wallet
   ============================================================ */
window.renderLiveRoyalties = async () => {
  const box = $("#live-royalties");
  const head = `<h2>Live on-chain <span class="pill dlt">DLT</span> <span class="pill ipfsp">IPFS</span></h2>`;
  const s = await W.services();
  if (!s.chain.ok || !s.contract) {
    box.innerHTML = head + `<p class="help">The local chain or registry isn't available — <code>npm run chain</code>, then <code>npm run deploy</code>.</p>`; return;
  }
  const acct = W.state.account;
  if (!acct) {
    box.innerHTML = head + `<p class="help" style="margin-bottom:.8rem">Connect MetaMask to see what this wallet earned from plays and what it paid to listen.</p>
      <button class="btn primary sm" id="lr-connect">Connect MetaMask</button>`;
    $("#lr-connect").addEventListener("click", () => W.connect().catch(e => toast(W.errMsg(e))));
    return;
  }
  box.innerHTML = head + `<p class="help">Reading events…</p>`;
  const r = W.read, f = r.filters;
  const [bal, earned, pending, payouts, deferred, plays, allAcc] = await Promise.all([
    W.readProvider.getBalance(acct), r.totalEarned(acct), r.pendingWithdrawals(acct),
    W.events(f.Payout(null, acct)), W.events(f.PayoutDeferred(null, acct)), W.events(f.Accessed(null, acct)), W.events(f.Accessed()),
  ]);
  const listenerByTx = new Map(allAcc.map(e => [e.transactionHash, e.args.listener]));
  const ids = [...new Set([...payouts, ...deferred, ...plays].map(e => Number(e.args.assetId)))];
  const assets = Object.fromEntries(await Promise.all(ids.map(async id => [id, await W.getAssetFull(id).catch(() => null)])));
  const title = id => assets[id]?.meta?.name || `Asset #${id}`;
  const rows = [
    ...payouts.map(e => ({ e, dir: "in", amount: e.args.amount, who: listenerByTx.get(e.transactionHash),
      what: e.args.role
        ? `Play of “${title(Number(e.args.assetId))}” · ${roleLabel(e.args.role)} share ${pct(Number(e.args.shareBps))}`
        : `Play of “${title(Number(e.args.assetId))}” · ${pct(Number(e.args.shareBps))} via Contract.payTo` })),
    ...deferred.map(e => ({ e, dir: "in", amount: e.args.amount, who: listenerByTx.get(e.transactionHash),
      what: `Payout held for withdraw — “${title(Number(e.args.assetId))}”` })),
    ...plays.map(e => ({ e, dir: "out", amount: e.args.amount, who: assets[Number(e.args.assetId)]?.publisher,
      what: `You played “${title(Number(e.args.assetId))}” (play #${e.args.playNo})` })),
  ].sort((a, b) => b.e.blockNumber - a.e.blockNumber || b.e.index - a.e.index);
  const times = await Promise.all(rows.map(x => W.blockTime(x.e.blockNumber).catch(() => 0)));
  const paid = plays.reduce((s, e) => s + e.args.amount, 0n);
  box.innerHTML = head + `<p class="help" style="margin:-.4rem 0 1rem">${addrCell(acct)} — read directly from the DmafMediaRegistry contract and its events (paid by the registry's direct split or by each asset's Smart Contract for Media).</p>
    <div class="grid4">
      <div class="stat"><div class="big">${Number(fmtEth(bal, 4)).toLocaleString(undefined, { maximumFractionDigits: 4 })}</div><div class="lbl">ETH in this wallet</div></div>
      <div class="stat"><div class="big amount-in">${fmtEth(earned)}</div><div class="lbl">ETH earned from ${payouts.length} payout${payouts.length === 1 ? "" : "s"}</div></div>
      <div class="stat"><div class="big amount-out">${fmtEth(paid)}</div><div class="lbl">ETH paid for ${plays.length} play${plays.length === 1 ? "" : "s"}</div></div>
      <div class="stat"><div class="big">${fmtEth(pending)}</div><div class="lbl">ETH awaiting withdraw</div>
        ${pending > 0n ? `<button class="btn secondary sm" id="lr-withdraw" style="margin-top:.4rem">Withdraw</button>` : ""}</div>
    </div>
    ${rows.length ? `<div class="tablewrap" style="margin-top:1.2rem"><table class="table"><thead>
      <tr><th>When</th><th>Event</th><th>Counterparty</th><th class="r">Amount</th><th>Tx</th></tr></thead><tbody>
      ${rows.map((x, i) => `<tr><td>${times[i] ? when(times[i]) : "—"}</td><td>${esc(x.what)}</td><td>${addrCell(x.who)}</td>
        <td class="r ${x.dir === "in" ? "amount-in" : "amount-out"}">${x.dir === "in" ? "+" : "−"}${fmtEth(x.amount)} ETH</td>
        <td class="mono" title="${esc(x.e.transactionHash)}">${esc(short(x.e.transactionHash))}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="empty" style="margin-top:1.2rem">No on-chain activity for this wallet yet.</p>`}`;
  $("#lr-withdraw")?.addEventListener("click", async () => {
    try { const c = await W.signerContract(); await (await c.withdraw()).wait(); toast("Withdrawn"); window.renderLiveRoyalties(); W.refreshChip(); }
    catch (e) { toast(W.errMsg(e)); }
  });
};

/* ---------------- react to wallet / network changes ---------------- */
window.addEventListener("dmaf:wallet", () => {
  const v = view();
  if (v === "publish") { renderServices($("#pub-svc")); renderSplits(); updateGo(); checkWallets(pub.agreement); }
  if (v === "royalties") window.renderLiveRoyalties();
  if (v === "discover") window.renderChainAssets();
  if (v === "library") window.renderMyAssets();
  if (v === "asset" && asset) { drawHeader(); drawLog(); drawRefs(); }
});

window.addEventListener("dmaf:account", () => { if (view() === "publish") renderServices($("#pub-svc")); });

/* app.js routed before this file loaded — render a direct entry now */
if (["publish", "asset", "discover", "royalties", "library"].includes(view())) route();
})();
