/* ============================================================
   DMAF ↔ ISO/IEC 21000-23 Smart Contracts for Media (browser side)

   Forward:  agreement → MCO JSON-LD → POST /api/parser/mco → Media
             Contractual Objects → POST /api/contracts/ → GET
             /api/dlt/generate/{id} → token JSON on IPFS → one MetaMask
             transaction (Mpeg21ScmFactory) → reference Contract + NFTs
   Backward: SCM address → POST /api/x-dmaf/eth/inspect (= /dlt/eth/parse
             + bindings) → Media Contractual Objects → agreement

   The /api server is server/scm-api.mjs (mounted by `npm run serve`).
   On-chain code is mpeg21/lib/eth.mjs, shared with the server and tests.

   window.SCM → used by js/agreement.js and js/media.js
   ============================================================ */
(() => {
const CFG = window.DMAF_CHAIN || null;
const { ethers } = window;
let ethLib = null;
const eth = async () => (ethLib ||= await import("../mpeg21/lib/eth.mjs"));

/* ---------------- OpenAPI client ---------------- */
async function api(path, { method = "GET", body, type, accept } = {}) {
  const headers = {};
  if (type) headers["content-type"] = type;
  if (accept) headers.accept = accept;
  let r;
  try { r = await fetch("/api" + path, { method, headers, body }); }
  catch { throw new Error("Can't reach the ISO/IEC 21000-23 API at /api — open the app through `npm run serve`"); }
  if (r.status === 401) window.DMAF_ACCOUNT?.sessionEnded?.();       // signed out / session ended (tools/serve.mjs)
  const ct = r.headers.get("content-type") || "";
  const out = /json/.test(ct) ? await r.json() : await r.text();
  if (!r.ok) throw new Error(out?.message || out?.errorType || `API ${r.status} on ${path}`);
  return out;
}
let apiOk = null;
async function available() {
  if (!CFG?.scm?.factory) return false;
  if (apiOk === null) { try { await api("/x-dmaf/status"); apiOk = true; } catch { apiOk = false; } }
  return apiOk;
}

/* ---------------- agreement ↔ Media Contractual Objects ---------------- */
async function toContractObjects(ag) {
  const doc = window.DMAF_MCO.jsonld(ag);
  const r = await api("/parser/mco", { method: "POST", body: JSON.stringify(doc), type: "application/ld+json" });
  return { contract: r.contracts[0], jsonld: doc, warnings: r["x-dmaf"]?.warnings || [] };
}
async function exportAs(ag, format) {
  const { contract } = await toContractObjects(ag);
  const { contractIdref } = await api("/contracts/", { method: "POST", body: JSON.stringify(contract), type: "application/json" });
  if (format === "turtle") return api(`/generator/mco/${contractIdref}`);
  if (format === "cel") return api(`/generator/cel/${contractIdref}`);
  if (format === "objects") return contract;
  if (format === "spec") return api(`/dlt/generate/${contractIdref}`);
  throw new Error("unknown format " + format);
}

/** Party id (local) → wallet; unbound parties fall back to `fallback` (the publisher). */
function bindingsFor(ag, contract, fallback) {
  const byLocal = Object.fromEntries(ag.parties.map(p => [p.id, p.wallet]));
  const out = {};
  for (const iri of Object.keys(contract.parties)) {
    const w = byLocal[iri.split("/").pop()];
    out[iri] = /^0x[0-9a-fA-F]{40}$/.test(w || "") ? ethers.getAddress(w.toLowerCase()) : fallback;
  }
  return out;
}

/**
 * Forward conversion + deployment of an agreement as a Smart Contract for Media.
 * @param {object} ag  Studio agreement model
 * @param {(stage: string, detail?: string) => void} onStage
 */
async function deployAgreement(ag, onStage = () => {}) {
  if (!CFG?.scm) throw new Error("No ISO/IEC 21000-23 contracts on this chain — run `npm run deploy`, then reload");
  await window.W3.connect();
  const me = window.W3.state.account;

  onStage("parse", "MCO JSON-LD → Media Contractual Objects (POST /api/parser/mco)");
  const { contract, jsonld } = await toContractObjects(ag);
  const { contractIdref } = await api("/contracts/", { method: "POST", body: JSON.stringify(contract), type: "application/json" });

  onStage("spec", `Smart contract specification (GET /api/dlt/generate/${contractIdref})`);
  const spec = await api(`/dlt/generate/${contractIdref}`);
  const errs = spec["x-dmaf"]?.errors || [];
  if (errs.length) throw new Error(errs[0]);
  const bindings = bindingsFor(ag, contract, me);

  const lib = await eth();
  onStage("ipfs", "Publishing the deontic expressions and objects as NFT metadata on IPFS…");
  const args = await lib.prepareDeployment(spec, {
    ethers, bindings, deployer: me,
    publish: async text => (await window.W3.ipfsAdd(new Blob([text], { type: "application/json" }), "scm.json", null,
      { kind: "scm-token", source: "smart-contract", agreementId: ag.id })).cid,
    onProgress: (n, total) => onStage("ipfs", `Publishing token metadata on IPFS… ${n}/${total}`),
  });

  onStage("chain", `Confirm in MetaMask — mints ${args.deonticUris.length + args.objectUris.length} NFTs and deploys the Contract`);
  const signer = await new ethers.BrowserProvider(window.ethereum).getSigner(me);
  const d = await lib.deployWithFactory({ ethers, signer, factory: CFG.scm.factory, nfToken: CFG.scm.nfToken.address, args });

  const entryIri = spec["x-dmaf"]?.entry?.party;
  return {
    standard: "ISO/IEC 21000-23", contractAddress: d.address, txHash: d.txHash, block: d.receipt.blockNumber,
    gasUsed: String(d.receipt.gasUsed), chainId: CFG.chainId, network: `${CFG.chainName} · ${CFG.chainId}`,
    nfToken: CFG.scm.nfToken.address, contractIdref, identifier: contract.identifier,
    contentUri: args.contentUri, contentHash: args.contentHash,
    deonticTokens: d.deonticTokenIds.length, objectTokens: d.objectTokenIds.length,
    bindings: Object.fromEntries(Object.entries(args.bindings).map(([k, v]) => [k.split("/").pop(), v])),
    entry: entryIri ? { party: entryIri.split("/").pop(), address: args.bindings[entryIri] } : null,
    deployedAt: new Date().toISOString(), jsonldBytes: JSON.stringify(jsonld).length,
  };
}

/** Where this agreement's Smart Contract for Media stands on the configured chain:
 *   "live"     its contract is there (code at the address, same content hash)
 *   "gone"     no code at the address: the chain was restarted (Hardhat keeps it in memory)
 *   "other"    a different contract is at the address. A restarted Hardhat node hands out the same
 *              addresses again (the factory's first deployment always lands on the same one), so it
 *              can be another agreement's Smart Contract for Media
 *   "unknown"  the chain can't be reached right now
 *   null       no ISO/IEC 21000-23 record for this chain */
async function chainStatus(ag) {
  const ch = ag?.chain, a = ch?.contractAddress;
  if (!a || !CFG || ch.chainId !== CFG.chainId || ch.standard !== "ISO/IEC 21000-23") return null;
  const rp = window.W3?.readProvider;
  if (!rp) return "unknown";
  let code;
  try { code = await rp.getCode(a); } catch { return "unknown"; }
  if (!code || code === "0x") return "gone";
  if (!ch.contentHash) return "live";                  // a record without a hash: the code has to do
  try {
    const onChain = await new ethers.Contract(a, ["function _contentHash() view returns (bytes)"], rp)._contentHash();
    return String(onChain).toLowerCase() === String(ch.contentHash).toLowerCase() ? "live" : "other";
  } catch (e) {
    return e?.code === "CALL_EXCEPTION" || e?.code === "BAD_DATA" ? "other" : "unknown";
  }
}
/** Is this agreement's SCM deployed on the configured chain? */
async function isLive(ag) {
  return (await chainStatus(ag)) === "live";
}

/** Backward conversion: SCM address → { contract, onChain } (server reads chain + IPFS). */
async function inspect(address) {
  return api("/x-dmaf/eth/inspect", { method: "POST", body: String(address).trim(), type: "text/plain" });
}

/** Media Contractual Objects (as parsed back from the chain) → Studio agreement model. */
function agreementFromObjects(c, onChain) {
  const local = iri => String(iri || "").split(/[/#]/).pop();
  const meta = (o, k) => o?.metadata?.[k];
  const ROLE = r => (r ? [`mvco:${r}`] : []);
  const work = Object.values(c.objects || {}).find(o => o.type === "Work") || {};
  const stems = Object.values(c.objects || {}).filter(o => o.type === "Manifestation" && meta(o, "dmaf:group"));
  const actionIri = a => ({ Play: "mco-rele:Play", Distribute: "mvco:distribute", Adapt: "mco-rele:Adapt", Synchronise: "mvco:synchronise",
    MakeCopy: "mvco:makeCopy", Produce: "mvco:produce", Stream: "mvco:stream", Download: "mvco:download", Provide: "mco-core:Provide",
    Payment: "mco-pane:Payment" }[a.type] || "mvco:" + (a.type || "action")[0].toLowerCase() + (a.type || "action").slice(1));
  const ag = {
    id: null, status: "active", templateKey: meta(c, "dmaf:basedOnTemplate") || "imported", templateLabel: `Imported from ${onChain?.address || "chain"}`,
    title: meta(c, "rdfs:label") || local(c.identifier),
    work: { title: meta(work, "rdfs:label") || "", type: meta(work, "dmaf:workType") || "Single", tracks: +(meta(work, "dmaf:tracks") || 1), genre: meta(work, "dmaf:genre") || "" },
    due: meta(c, "dmaf:deliveryDeadline") || "", territory: meta(c, "dmaf:territory") || "Worldwide", term: meta(c, "dmaf:term") || "Perpetual",
    parties: Object.values(c.parties).map(p => ({ uid: Math.random().toString(36).slice(2, 9), id: local(p.identifier), label: meta(p, "rdfs:label") || local(p.identifier),
      types: ROLE(p.role), name: meta(p, "dmaf:name") || "", wallet: meta(p, "dmaf:wallet") || onChain?.bindings?.[p.identifier] || "", email: meta(p, "dmaf:email") || "" })),
    permissions: [], obligations: [], deliverables: [], signatures: {}, delivered: {},
  };
  for (const d of Object.values(c.deontics)) {
    const a = c.actions[d.act] || {};
    const uid = Math.random().toString(36).slice(2, 9);
    const stem = stems.find(s => (a.actedOver || []).includes(s.identifier));
    if (stem) {
      ag.deliverables.push({ uid, name: meta(stem, "rdfs:label"), group: meta(stem, "dmaf:group") || "", by: local(a.actedBy), to: local((a.recipients || [d.issuer])[0]),
        format: meta(stem, "dmaf:format") || "", required: meta(stem, "dmaf:required") !== "false" });
    } else if (d.type === "MCOPermission") {
      ag.permissions.push({ uid, label: meta(d, "rdfs:label") || "", issuer: local(d.issuer), action: actionIri(a), actionLabel: meta(a, "rdfs:label") || "",
        actor: local(a.actedBy), object: local((a.actedOver || ["Song"])[0]) === local(work.identifier) ? "Song" : "Stems" });
    } else if (a.type === "Payment") {
      ag.obligations.push({ uid, kind: "payment", label: meta(d, "rdfs:label") || "", issuer: local(d.issuer), action: "mco-pane:Payment", payer: local(a.actedBy),
        beneficiary: local((a.beneficiaries || [])[0]), basis: a.incomePercentage !== undefined ? "percent" : "fixed",
        value: a.incomePercentage ?? a.amount ?? 0, unit: a.currency || "EUR" });
    } else {
      ag.obligations.push({ uid, kind: "provide", label: meta(d, "rdfs:label") || "", issuer: local(d.issuer), action: actionIri(a), actionLabel: meta(a, "rdfs:label") || "",
        actor: local(a.actedBy), object: "Song", recipient: local((a.recipients || [])[0]) });
    }
  }
  return ag;
}

/* ---------------- splits ----------------
   Same integer arithmetic as Contract.payTo: each income beneficiary gets
   amount * pct / 100 of what its payer receives, recursively; the payer
   keeps the rest. Works on the agreement model before deployment and on
   the chain after it. */
function incomeEdges(ag) {
  const m = {};
  for (const o of ag.obligations) {
    if (o.kind !== "payment" || o.basis !== "percent" || !o.payer || !o.beneficiary || o.payer === o.beneficiary) continue;
    (m[o.payer] ||= {})[o.beneficiary] = ((m[o.payer] || {})[o.beneficiary] || 0) + (+o.value || 0);
  }
  return m;
}
function entryParty(ag) {
  const pays = ag.obligations.filter(o => o.kind === "payment" && o.basis === "fixed");
  const end = id => ag.parties.find(p => p.id === id)?.types.includes("mvco:EndUser");
  return (pays.find(o => end(o.payer)) || pays[0])?.beneficiary || null;
}
function previewFromModel(ag, amount = 10000n) {
  const edges = incomeEdges(ag), out = [], seen = [];
  const walk = (who, amt) => {
    if (seen.includes(who) || seen.length > 16) throw new Error(`Income percentages loop back to ${who} — Contract.payTo would never finish`);
    seen.push(who);
    let kept = amt;
    for (const [to, pct] of Object.entries(edges[who] || {})) { const sub = (amt * BigInt(Math.round(pct))) / 100n; walk(to, sub); kept -= sub; }
    seen.pop();
    out.push({ party: who, amount: kept });
  };
  const entry = entryParty(ag);
  if (!entry) return { entry: null, rows: [] };
  walk(entry, amount);
  const merged = {};
  for (const r of out) merged[r.party] = (merged[r.party] || 0n) + r.amount;
  return { entry, rows: Object.entries(merged).map(([party, amount]) => ({ party, amount })) };
}

/** Why Contract.payTo can't settle this agreement's plays ([] = it can).
    Parties without a wallet are bound to `fallback` (the publisher). Plays
    of such agreements use the registry's direct split instead (js/media.js). */
function payToIssues(ag, fallback) {
  const out = [];
  const label = id => window.DMAF_MCO?.pretty(ag.parties.find(p => p.id === id)?.label || id) ?? id;
  const wallet = id => {
    const w = ag.parties.find(p => p.id === id)?.wallet;
    return (/^0x[0-9a-fA-F]{40}$/.test(w || "") ? w : fallback || "").toLowerCase();
  };
  for (const o of ag.obligations) {
    if (o.kind !== "payment" || o.basis !== "percent") continue;
    const v = +o.value;
    if (!Number.isInteger(v) || v < 0 || v > 100) out.push(`“${o.label}” is ${o.value}% — the Smart Contract for Media stores whole percents (0–100)`);
  }
  for (const [payer, m] of Object.entries(incomeEdges(ag)))
    for (const b of Object.keys(m))
      if (wallet(payer) && wallet(payer) === wallet(b))
        out.push(`${label(payer)} and ${label(b)} share a wallet, so Contract.payTo would pay a wallet to itself`);
  try { if (!previewFromModel(ag).entry) out.push("no fixed payment by the end user, so a play has no party to pay"); }
  catch (e) { out.push(e.message); }
  return out;
}

window.SCM = { api, available, toContractObjects, exportAs, deployAgreement, isLive, chainStatus, inspect, agreementFromObjects,
  previewFromModel, incomeEdges, entryParty, payToIssues, eth, CFG };
})();
