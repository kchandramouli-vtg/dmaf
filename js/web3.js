/* ============================================================
   DMAF web3 layer — MetaMask, the DmafMediaRegistry contract
   (js/chain-config.js, written by `npm run deploy`) and the local
   IPFS node, reached through the dev server's /ipfs-api proxy.

   window.W3         → functions used by js/media.js
   window.dmafWallet → { account, chainId } of the connected wallet
   "dmaf:wallet" event fires whenever the account/network changes.
   ============================================================ */
(() => {
const CFG = window.DMAF_CHAIN || null;
const { ethers } = window;

/* Hardhat's deterministic test accounts (mnemonic "test test … junk").
   Public, well-known keys — never use them on a real network. */
window.HARDHAT_ACCOUNTS = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
  "0x976EA74026E726554dB657fA54763abd0C3a0aa9", "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
  "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f", "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
  "0xBcd4042DE499D14e55001CcbB24a551F3b954096", "0x71bE63f3384f5fb98995898A86B02Fb2426c5788",
].map((address, i) => ({ address, index: i,
  label: ["Deployer", "Producer", "Listener"][i] || "Party" }));

const state = window.dmafWallet = { account: null, chainId: null };
const emit = () => window.dispatchEvent(new CustomEvent("dmaf:wallet", { detail: { ...state } }));
const hexChain = CFG ? "0x" + CFG.chainId.toString(16) : null;

const readProvider = CFG ? new ethers.JsonRpcProvider(CFG.rpcUrl, CFG.chainId, { staticNetwork: true }) : null;
const read = CFG ? new ethers.Contract(CFG.address, CFG.abi, readProvider) : null;

/* ---------------- formatting ---------------- */
const short = a => a ? a.slice(0, 6) + "…" + a.slice(-4) : "—";
function fmtEth(wei, dp = 8) {
  const s = ethers.formatEther(wei ?? 0n);
  const [i, f = ""] = s.split(".");
  const t = f.slice(0, dp).replace(/0+$/, "");
  return t ? `${i}.${t}` : i;
}
function accountLabel(addr) {
  if (!addr) return "";
  const h = window.HARDHAT_ACCOUNTS.find(x => x.address.toLowerCase() === addr.toLowerCase());
  return h ? `Hardhat #${h.index}` : "";
}
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/* ---------------- errors ---------------- */
/* Every message in an error chain. ethers 6 wraps wallet/RPC failures as
   "could not coalesce error" and keeps MetaMask's or Hardhat's own reason
   in e.error / e.info.error / data.message / data.cause. */
function messages(e) {
  const out = [], seen = new Set();
  const walk = x => {
    if (!x || typeof x !== "object" || seen.has(x)) { if (typeof x === "string" && !/^0x[0-9a-f]*$/i.test(x)) out.push(x); return; }
    seen.add(x);
    for (const k of ["shortMessage", "message", "reason"]) if (typeof x[k] === "string") out.push(x[k]);
    for (const k of ["error", "info", "data", "cause", "originalError"]) walk(x[k]);
  };
  walk(e);
  return [...new Set(out)];
}
function errMsg(e) {
  const code = e?.code ?? e?.info?.error?.code ?? e?.error?.code;
  if (code === "ACTION_REJECTED" || code === 4001) return "Cancelled in MetaMask";
  if (e?.revert?.name) {
    const args = (e.revert.args || []).map(a => typeof a === "bigint" ? a.toString() : a).join(", ");
    if (e.revert.name === "WrongPayment") return "The price changed — reload the asset and try again";
    return `Contract rejected: ${e.revert.name}(${args})`;
  }
  const all = messages(e);
  const text = all.join(" · ") || String(e);
  try { console.warn("[DMAF]", text, e); } catch {}
  if (/open the app through/i.test(text)) return all.find(x => /open the app through/i.test(x));
  // IPFS first: the dev server's IPFS proxy reports ECONNREFUSED too
  if (/ipfs|:5001|:8080/i.test(text) && /ECONNREFUSED|can't reach|failed|offline|502/i.test(text))
    return "The IPFS node isn't running — start IPFS Desktop or run `ipfs daemon`, then retry";
  if (/insufficient funds/i.test(text)) return "Not enough ETH in this account";
  if (/nonce/i.test(text) || /invalid block tag/i.test(text))
    return "MetaMask still remembers the previous chain (Hardhat was restarted) — MetaMask ▸ Settings ▸ Advanced ▸ Clear activity tab data, then retry";
  if (/failed to fetch|ECONNREFUSED|could not detect network|connection refused/i.test(text))
    return "Can't reach the local chain at " + (CFG?.rpcUrl || "") + " — is `npm run chain` running?";
  // keep the most specific message (the wallet's or node's own reason), not ethers' wrapper
  const m = all.filter(x => !/could not coalesce|Internal JSON-RPC error/i.test(x)).pop() || all[0] || String(e);
  const out = /could not coalesce|Internal JSON-RPC/i.test(all[0] || "") && m !== all[0] ? `MetaMask / RPC error: ${m}` : m;
  return out.length > 240 ? out.slice(0, 240) + "…" : out;
}

/* ---------------- wallet ---------------- */
function setAccount(a) { state.account = a ? ethers.getAddress(a) : null; }
async function readChainId() {
  state.chainId = parseInt(await window.ethereum.request({ method: "eth_chainId" }), 16);
}
async function ensureChain() {
  const eth = window.ethereum;
  await readChainId();
  if (state.chainId === CFG.chainId) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexChain }] });
  } catch (e) {
    const code = e?.code ?? e?.data?.originalError?.code;
    if (code !== 4902) throw e;
    await eth.request({ method: "wallet_addEthereumChain", params: [{
      chainId: hexChain, chainName: "Hardhat Localhost", rpcUrls: [CFG.rpcUrl],
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } }] });
  }
  await readChainId();
  emit();
  if (state.chainId !== CFG.chainId) throw new Error(`MetaMask is on chain ${state.chainId}; switch it to Hardhat (${CFG.chainId})`);
}
async function connect() {
  if (!CFG) throw new Error("No contract configured — run `npm run deploy` (writes js/chain-config.js)");
  if (!window.ethereum) throw new Error("MetaMask not found — install the extension and open the app at http://localhost:5173");
  const accts = await window.ethereum.request({ method: "eth_requestAccounts" });
  setAccount(accts[0]);
  await ensureChain();
  emit();
  return state.account;
}
async function signerContract() {
  await connect();
  // a fresh provider each time: ethers' BrowserProvider pins the network it first saw
  const bp = new ethers.BrowserProvider(window.ethereum);
  const signer = await bp.getSigner(state.account);
  return new ethers.Contract(CFG.address, CFG.abi, signer);
}
if (window.ethereum) {
  window.ethereum.request({ method: "eth_accounts" }).then(async a => {
    setAccount(a[0]); if (a[0]) await readChainId(); emit();
  }).catch(() => {});
  window.ethereum.on?.("accountsChanged", a => { setAccount(a[0]); emit(); });
  window.ethereum.on?.("chainChanged", c => { state.chainId = parseInt(c, 16); emit(); });
}

/* ---------------- IPFS (through tools/serve.mjs) ---------------- */
const gateway = cid => "/ipfs/" + cid;
/* opts.kind / source / agreementId: how the file is listed in My Library when you're
   signed in (the dev server records it in PostgreSQL; Kubo never sees these headers). */
function ipfsAdd(blob, filename, onProgress, opts = {}) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("file", blob, filename);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/ipfs-api/add?cid-version=1&pin=true");
    const hint = { name: filename, size: blob.size, mime: blob.type || "", kind: opts.kind || "file", source: opts.source || "publish", agreement: opts.agreementId || "" };
    for (const [k, v] of Object.entries(hint)) if (v !== "" && v != null) xhr.setRequestHeader("x-dmaf-" + k, encodeURIComponent(String(v)));
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let body; try { body = JSON.parse(xhr.responseText.trim().split("\n").pop()); } catch { body = {}; }
      if (xhr.status === 401) window.DMAF_ACCOUNT?.sessionEnded?.();     // signed out / session ended (tools/serve.mjs)
      if (xhr.status !== 200 || !body.Hash) return reject(new Error(body.error || body.Message || `IPFS add failed (${xhr.status}) — is the IPFS node running?`));
      resolve({ cid: body.Hash, size: +body.Size });
    };
    xhr.onerror = () => reject(new Error("Can't reach /ipfs-api — open the app through `npm run serve`"));
    xhr.send(fd);
  });
}
async function ipfsJson(cid) {
  const r = await fetch(gateway(cid));
  if (!r.ok) throw new Error(`IPFS gateway ${r.status} for ${cid}`);
  return r.json();
}

/* ---------------- service status ---------------- */
let svcCache = null, svcAt = 0;
async function services(force) {
  if (!force && svcCache && Date.now() - svcAt < 4000) return svcCache;
  let s = { ipfs: { ok: false, error: "dev server not reachable" }, chain: { ok: false }, contract: false, block: null };
  try { const r = await fetch("/__status", { cache: "no-store" }); if (r.ok) s = { ...s, ...(await r.json()) }; } catch {}
  if (CFG) {
    try {
      const [code, block] = await Promise.all([readProvider.getCode(CFG.address), readProvider.getBlockNumber()]);
      s.chain = { ...s.chain, ok: true, chainId: CFG.chainId, rpc: CFG.rpcUrl };
      // a chain-config.js written before the ISO/IEC 21000-23 contracts existed: redeploy
      s.contract = code && code !== "0x" && !!CFG.scm; s.block = block;
      if (!CFG.scm) s.staleConfig = true;
    } catch (e) { s.chain = { ...s.chain, ok: false, error: e.message }; }
  }
  svcCache = s; svcAt = Date.now();
  return s;
}

/* ---------------- contract reads ---------------- */
const metaCache = new Map();
const blockCache = new Map();
async function blockTime(n) {
  if (!blockCache.has(n)) blockCache.set(n, readProvider.getBlock(n).then(b => Number(b.timestamp)));
  return blockCache.get(n);
}
/* Who receives what from one play of an asset settled by its ISO/IEC
   21000-23 Smart Contract for Media: the registry's previewSplit() mirrors
   Contract.payTo. (Direct-split assets list their payees: getPayees().) */
async function splitOf(id, price) {
  const base = price > 0n ? price : 10000n;
  const [accounts, amounts] = await read.previewSplit(id, base);
  const m = new Map();
  accounts.forEach((acc, i) => { const k = acc.toLowerCase(); const e = m.get(k) || { account: acc, amount: 0n }; e.amount += amounts[i]; m.set(k, e); });
  return [...m.values()].filter(e => e.amount > 0n).map(e => ({ ...e, shareBps: Number((e.amount * 10000n) / base) })).sort((x, y) => (y.amount > x.amount ? 1 : -1));
}
async function getAssetFull(id) {
  const a = await read.getAsset(id);
  const scm = a.scm && a.scm !== ethers.ZeroAddress ? a.scm : null;
  const payees = scm
    ? await splitOf(id, a.pricePerPlay).catch(() => [])
    : (await read.getPayees(id)).map(p => ({ account: p.account, shareBps: Number(p.shareBps), role: p.role }));
  let meta = metaCache.get(a.metadataCid);
  if (!meta) {
    try { meta = await ipfsJson(a.metadataCid); metaCache.set(a.metadataCid, meta); } catch { meta = null; }
  }
  return {
    id: Number(id), publisher: a.publisher, price: a.pricePerPlay, audioCid: a.audioCid, metadataCid: a.metadataCid,
    agreementCid: a.agreementCid, agreementHash: a.agreementHash, agreementId: a.agreementId,
    createdAt: Number(a.createdAt), active: a.active, plays: Number(a.plays), totalPaid: a.totalPaid,
    // "scm": Contract.payTo of the Smart Contract for Media · "direct": the registry pays each payee
    mode: scm ? "scm" : "direct", scm, entry: scm ? a.entry : null,
    payees,
    meta,
  };
}
async function getAssets() {
  const n = Number(await read.assetCount());
  return Promise.all(Array.from({ length: n }, (_, i) => getAssetFull(n - i))); // newest first
}
async function events(filter) {
  return read.queryFilter(filter, CFG.deployBlock || 0, "latest");
}

/* ---------------- header chip ---------------- */
async function renderChip() {
  const b = document.getElementById("mm-btn"); if (!b) return;
  b.classList.remove("warn", "on");
  if (!window.ethereum) { b.textContent = "Install MetaMask"; b.title = "MetaMask extension not detected"; return; }
  if (!state.account) { b.textContent = "Connect MetaMask"; b.title = ""; return; }
  if (CFG && state.chainId !== CFG.chainId) { b.classList.add("warn"); b.textContent = "Switch to Hardhat"; b.title = `MetaMask is on chain ${state.chainId}`; return; }
  b.classList.add("on");
  let bal = "";
  try { bal = " · " + Number(fmtEth(await readProvider.getBalance(state.account), 4)).toLocaleString(undefined, { maximumFractionDigits: 4 }) + " ETH"; } catch {}
  const lbl = accountLabel(state.account);
  b.textContent = short(state.account) + bal;
  b.title = (lbl ? lbl + " · " : "") + state.account;
  const old = document.getElementById("walletchip"); if (old) old.hidden = true;
}
window.addEventListener("dmaf:wallet", renderChip);
document.getElementById("mm-btn")?.addEventListener("click", async () => {
  if (!window.ethereum) { window.open("https://metamask.io/download/", "_blank", "noopener"); return; }
  try { await connect(); window.toast?.(`Connected ${short(state.account)} on Hardhat local`); }
  catch (e) { window.toast?.(errMsg(e)); }
});
renderChip();

/* footer engine dots reflect live service status */
async function renderEngines() {
  const s = await services(true);
  document.querySelector("#eng-ipfs i")?.classList.toggle("off", !s.ipfs?.ok);
  document.querySelector(".engine.dlt i")?.classList.toggle("off", !(s.chain?.ok && s.contract));
}
renderEngines(); setInterval(renderEngines, 15000);

window.W3 = {
  CFG, read, readProvider, state, connect, ensureChain, signerContract,
  ipfsAdd, ipfsJson, gateway, services, getAssetFull, getAssets, events, blockTime,
  errMsg, short, fmtEth, accountLabel, same, refreshChip: renderChip,
};
})();
