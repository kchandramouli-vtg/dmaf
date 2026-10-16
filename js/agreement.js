/* ============================================================
   DMAF Studio · Agreement (step 1) + Stems delivery (step 2)

   Step 1 builds an MPEG-21 Media Contract Ontology (MCO) contract
   between the parties from one of six use-case templates
   (js/mco-templates.js). Every element — parties, permissions,
   provide-material and payment obligations, deliverable stems —
   is editable, and the model re-serialises to JSON-LD using the
   templates' @context.

   Lifecycle:  draft → signing → signed → active (on-chain)
   Once active the artists go away and make the music; Step 2
   later checks uploaded stems against the agreement's deliverables.
   ============================================================ */

(() => {
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pretty = l => String(l || "").toLowerCase().replace(/(^|[\s/])\w/g, m => m.toUpperCase());
const uid = () => Math.random().toString(36).slice(2, 9);
const clone = o => JSON.parse(JSON.stringify(o));

const ROLE_TYPES = [
  ["mvco:Creator", "Creator"], ["mvco:Producer", "Producer"], ["mvco:Distributor", "Distributor"],
  ["mvco:Instantiator", "Instantiator"], ["mvco:Adaptor", "Adaptor"], ["mvco:EndUser", "End user"],
];
/* Action classes the ISO/IEC 21000-23 parser knows (its lookup tables),
   spelt as in the standard's templates. */
const ACTIONS = [
  ["mco-rele:Play", "play"], ["mvco:distribute", "distribute"], ["mvco:stream", "stream"], ["mvco:download", "download"],
  ["mco-rele:Adapt", "adapt"], ["mvco:synchronise", "synchronise"], ["mvco:makeCopy", "copy"], ["mvco:produce", "produce"],
];
/* Spellings used by earlier DMAF versions / the standard's JSON-LD templates
   that are not MCO terms → the term the parser knows. */
const LEGACY_ACTIONS = { "mvco:play": "mco-rele:Play", "mvco:adapt": "mco-rele:Adapt", "mvco:synchronize": "mvco:synchronise",
  "mvco-ipre:provideMaterial": "mco-core:Provide", "mco-ipre:provideMaterial": "mco-core:Provide", "mco-ipre:Payment": "mco-pane:Payment" };
function normalize(a) {
  if (!a) return a;
  a.permissions?.forEach(p => { p.action = LEGACY_ACTIONS[p.action] || p.action; });
  a.obligations?.forEach(o => { o.action = LEGACY_ACTIONS[o.action] || o.action || (o.kind === "payment" ? "mco-pane:Payment" : "mco-core:Provide"); });
  return a;
}
const UNITS = ["EUR", "USD", "GBP", "EUR cents", "USD cents", "GBP cents", "ETH"];
const GROUPS = ["Vocals", "Rhythm", "Lead", "Keys", "Strings", "FX"];
const FORMATS = ["WAV 48 kHz / 24-bit", "WAV 44.1 kHz / 16-bit", "FLAC", "MP3 320 kbps"];
const QUICK_STEMS = [["Lead vocals", "Vocals"], ["Backing vocals", "Vocals"], ["Guitars", "Rhythm"], ["Bass", "Rhythm"],
  ["Drums", "Rhythm"], ["Keys", "Keys"], ["Synths", "Lead"], ["Strings", "Strings"], ["FX", "FX"]];
const STATUS = {
  draft:   ["warn", "Draft"],
  signing: ["warn", "Awaiting signatures"],
  signed:  ["", "Signed — not yet on-chain"],
  active:  ["ok", "Active — awaiting stems"],
  delivered: ["ok", "Stems delivered"],
};

let ag = null;           // agreement being edited
let chainCheck = { key: null, state: null, at: 0 };   // is ag.chain still on the chain? (checkChainRecord)
let deploying = false;   // Register is deploying: don't re-render its chain box
let templates = [];
/* Template labels as shown: without the service names some of the standard's labels mention. */
const cleanLabel = l => String(l || "").replace(/\s*(and\s+)?use services like CD Baby or TuneCore\.?/i, "").replace(/\s+$/, "");
let mode = "new";

/* ---------------- model helpers ---------------- */
const party = id => ag.parties.find(p => p.id === id);
const signers = () => ag.parties.filter(p => !p.types.includes("mvco:EndUser"));
const isLocked = () => ag && ag.status && ag.status !== "draft";
const objects = () => [
  { id: "Song", label: ag.work.title ? `${ag.work.title} (${ag.work.type.toLowerCase()})` : "The work" },
  { id: "Stems", label: "Stems (deliverables)" },
];
function newPartyId(label) {
  const base = (label || "Party").replace(/[^a-z0-9]+/gi, " ").trim().split(" ")
    .map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join("") || "Party";
  let id = base, n = 2; while (party(id)) id = base + n++;
  return id;
}
function fromTemplate(t) {
  const me = mockUser();
  const creator = t.parties.find(p => /AUTHOR|ARTIST/.test(p.label));
  const labelParty = t.parties.find(p => /LABEL|AGGREGATOR/.test(p.label) && p.id !== creator?.id);
  const a = {
    id: null, status: "draft", templateKey: t.key, templateLabel: t.sourceLabel,
    title: `${t.modelLabel} agreement · ${t.tierLabel}`,
    work: { title: "", type: "Album", tracks: 10, genre: "Electronic" },
    due: new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10), territory: "Worldwide", term: "Perpetual",
    parties: t.parties.map(p => ({ uid: uid(), id: p.id, label: p.label, types: [...p.types],
      name: p.id === creator?.id ? me.artistName : "", wallet: p.id === creator?.id ? me.wallet : "", email: p.id === creator?.id ? me.email : "" })),
    permissions: t.permissions.map(p => ({ uid: uid(), ...p })),
    obligations: t.obligations.map(o => o.kind === "payment"
      ? { uid: uid(), kind: "payment", label: o.label, issuer: o.issuer, action: o.action, payer: o.payer, beneficiary: o.beneficiary,
          basis: o.percentage != null ? "percent" : "fixed", value: o.percentage ?? o.amount, unit: o.currency || "EUR" }
      : { uid: uid(), ...o }),
    deliverables: [],
    signatures: {}, delivered: {},
  };
  const by = creator?.id || a.parties[0].id, to = labelParty?.id || by;
  a.deliverables = QUICK_STEMS.slice(0, 5).map(([name, group]) =>
    ({ uid: uid(), name, group, by, to, format: FORMATS[0], required: true }));
  return a;
}
/* Why Contract.payTo can't settle this agreement (js/scm.js); unbound parties use the signed-in wallet. */
function payToIssues(a) { return window.SCM?.payToIssues(a, mockUser().wallet || window.W3?.state.account) || []; }
function mockUser() {
  // "me" (the creator's payout wallet) is, in order: the payout wallet linked to the
  // signed-in account (My account), the connected MetaMask account, or Hardhat
  // test account #1, the producer wallet the PoC runbook imports into MetaMask.
  // The linked wallet comes first so switching MetaMask to the Listener to test a
  // play doesn't make the Listener the creator of the next agreement.
  const u = window.DMAF_ACCOUNT?.user;                  // the signed-in account, when there is one
  const wallet = u?.wallet || window.dmafWallet?.account || window.HARDHAT_ACCOUNTS?.[1]?.address || "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  return { artistName: u?.artistName || "KS Audio", wallet, email: u?.email || "krishna@example.com" };
}
/* Hardhat test accounts #3… for the other parties (#0 deploys, #1 is the
   producer, #2 is the listener in the PoC runbook). */
/* Not offered in the Studio (which lists only the six ISO/IEC 21000-23 use
   cases): the one-party agreement behind Publish ▸ "No agreement", where the
   listener pays the publisher for each play. Same shape as js/mco-templates.js. */
const POC_TEMPLATES = [{
  key: "direct-producer", sourceId: "contract-direct",
  sourceLabel: "DMAF — publisher only. The listener pays the publisher per play.",
  model: "direct", tier: "self", modelLabel: "Publisher only", tierLabel: "No agreement",
  description: "The listener pays the publisher for every play.",
  parties: [
    { id: "Consumer", label: "CONSUMER", types: ["mvco:EndUser"] },
    { id: "Producer", label: "ARTIST/PRODUCER", types: ["mvco:Producer", "mvco:Creator"] },
  ],
  permissions: [
    { label: "Consumer can play the song", issuer: "Producer", action: "mco-rele:Play", actionLabel: "Consumer plays the song", actor: "Consumer", object: "Song" },
  ],
  obligations: [
    { kind: "provide", label: "Producer provides the song to the consumer", issuer: "Producer", action: "mco-core:Provide",
      actionLabel: "Producer provides the song", actor: "Producer", object: "Song", recipient: "Consumer" },
    { kind: "payment", label: "Consumer pays the producer per play", issuer: "Consumer", action: "mco-pane:Payment",
      payer: "Consumer", beneficiary: "Producer", amount: 1, currency: "EUR", percentage: null },
  ],
}];

/* Placeholder organisations for the PoC, keyed by MCO party id. */
const DEMO_NAMES = { StreamingService: "Any DSP", PerformingRighthsOrganisation: "PRS for Music", Publisher: "Garden Songs Publishing",
  RecordLabel: "Low Orbit Records", Aggregator: "TuneRoute", MechanicalLicenseAgent: "MLC Agent Ltd", DigitalSale: "Any Download Store",
  SongWriter: "J. Rivers (songwriter)", Musicians: "Session Players Co-op", Author: "KS Audio", ArtistBand: "KS Audio" };
function testWalletPool(exclude = []) {
  const used = new Set(exclude.filter(Boolean).map(w => w.toLowerCase()));
  return (window.HARDHAT_ACCOUNTS || []).slice(3).map(a => a.address).filter(a => !used.has(a.toLowerCase()));
}

/* ---------------- JSON-LD (MPEG-21 MCO) ----------------
   The flat MCO JSON-LD profile of mpeg21/lib/jsonld-profile.mjs: one node
   per element, deontic expressions linked with mco-core:issuedIn, actions
   with mvco:actedBy / mvco:actedOver, payments with the mco-pane terms.
   It is what the ISO/IEC 21000-23 parser (POST /api/parser/mco) reads, and
   RDF-equivalent to the standard's Turtle templates. DMAF-only details
   (names, wallets, stems) are dmaf: properties, which the parser keeps as
   metadata. */
const lit = (v, type) => ({ "@value": v, "@type": type });
const num = v => lit(+v, Number.isInteger(+v) ? "xsd:integer" : "xsd:decimal");
const stemId = d => "stem-" + d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
function toJSONLD() {
  const graph = [];
  const ref = id => ({ "@id": id });
  const contract = "contract";
  let pn = 0, on = 0, an = 0, payn = 0;
  const workLabel = ag.work.title || "SONG";
  graph.push({
    "@id": contract, "@type": "mco-core:Contract", "rdfs:label": ag.title,
    "mco-core:hasParty": ag.parties.map(p => ref(p.id)),
    "dmaf:basedOnTemplate": ag.templateKey, "dmaf:territory": ag.territory, "dmaf:term": ag.term,
    ...(ag.due ? { "dmaf:deliveryDeadline": ag.due } : {}),
  });
  for (const p of ag.parties) graph.push({
    "@id": p.id, "@type": [...p.types, "mco-core:Party"], "rdfs:label": p.label,
    ...(p.name ? { "dmaf:name": p.name } : {}), ...(p.wallet ? { "dmaf:wallet": p.wallet } : {}), ...(p.email ? { "dmaf:email": p.email } : {}),
  });
  graph.push({ "@id": "Song", "@type": "mvco:Work", "rdfs:label": workLabel, "dmaf:workType": ag.work.type,
    "dmaf:tracks": num(ag.work.tracks || 1), ...(ag.work.genre ? { "dmaf:genre": ag.work.genre } : {}) });
  if (ag.permissions.some(p => p.object === "Stems") || ag.obligations.some(o => o.object === "Stems"))
    graph.push({ "@id": "Stems", "@type": "mvco:Manifestation", "rdfs:label": "STEMS" });
  const deontic = (id, type, label, issuer, verb, actId) =>
    graph.push({ "@id": id, "@type": type, "rdfs:label": label, "mco-core:issuedIn": ref(contract), "mvco:issuedBy": ref(issuer), [verb]: ref(actId) });
  ag.permissions.forEach(p => {
    const act = "action" + ++an;
    deontic("permission" + ++pn, "mvco:Permission", p.label, p.issuer, "mco-core:permitsAction", act);
    graph.push({ "@id": act, "@type": p.action, "rdfs:label": p.actionLabel || `${pretty(party(p.actor)?.label)} ${actionName(p.action)}s ${p.object === "Stems" ? "the stems" : workLabel}`,
      "mvco:actedBy": ref(p.actor), "mvco:actedOver": ref(p.object) });
  });
  ag.obligations.forEach(o => {
    if (o.kind === "provide") {
      const act = "action" + ++an;
      deontic("obligation" + ++on, "mco-core:Obligation", o.label, o.issuer, "mco-core:obligatesAction", act);
      graph.push({ "@id": act, "@type": o.action || "mco-core:Provide", "rdfs:label": o.actionLabel || o.label,
        "mvco:actedBy": ref(o.actor), "mvco:actedOver": ref(o.object || "Song"), ...(o.recipient ? { "mco-core:hasRecipient": ref(o.recipient) } : {}) });
    } else {
      const act = "pay" + ++payn;
      deontic("obligation" + ++on, "mco-core:Obligation", o.label, o.issuer, "mco-core:obligatesAction", act);
      graph.push({ "@id": act, "@type": "mco-pane:Payment", "rdfs:label": "Payment", "mvco:actedBy": ref(o.payer), "mco-pane:hasBeneficiary": ref(o.beneficiary),
        ...(o.basis === "percent" ? { "mco-pane:hasIncomePercentage": num(o.value) } : { "mco-pane:hasAmount": num(o.value), "mco-pane:hasCurrency": o.unit }) });
    }
  });
  ag.deliverables.forEach(d => {
    const act = "action" + ++an;
    deontic("obligation" + ++on, "mco-core:Obligation", `${pretty(party(d.by)?.label)} delivers stem “${d.name}”`, d.to, "mco-core:obligatesAction", act);
    graph.push({ "@id": act, "@type": "mco-core:Provide", "rdfs:label": `Deliver stem: ${d.name}`, "mvco:actedBy": ref(d.by),
      "mco-core:hasRecipient": ref(d.to), "mvco:actedOver": ref(stemId(d)), ...(ag.due ? { "dmaf:dueDate": ag.due } : {}) });
    graph.push({ "@id": stemId(d), "@type": "mvco:Manifestation", "rdfs:label": d.name, "dmaf:group": d.group, "dmaf:format": d.format,
      "dmaf:required": lit(!!d.required, "xsd:boolean") });
  });
  return {
    "@context": { ...window.MCO_CONTEXT, "@base": `https://dmaf.io/agreements/${ag.id || "draft"}/` },
    "@graph": graph,
  };
}
const actionName = a => (ACTIONS.find(x => x[0] === a) || [a, a.split(":").pop()])[1];

/* ---------------- revenue flow (indicative) ---------------- */
function toBase(value, unit, baseUnit) {
  const cents = /cents?$/i.test(unit || "");
  return cents ? value / 100 : value;
}
function computeFlow() {
  const pays = ag.obligations.filter(o => o.kind === "payment" && party(o.payer) && party(o.beneficiary) && o.payer !== o.beneficiary);
  const fixedIn = pays.filter(o => o.basis === "fixed");
  const consumerPay = fixedIn.find(o => party(o.payer)?.types.includes("mvco:EndUser")) || fixedIn[0];
  const baseUnit = consumerPay ? consumerPay.unit.replace(/\s*cents?$/i, "") : "units";
  const inject = consumerPay ? 0 : 100;
  let income = {}, out = {};
  const firstPayer = pays[0]?.payer;
  for (let iter = 0; iter < 12; iter++) {
    const inc = {}, o2 = {};
    if (inject && firstPayer) inc[firstPayer] = inject;
    pays.forEach(p => {
      const amt = p.basis === "fixed" ? toBase(+p.value || 0, p.unit, baseUnit) : ((+p.value || 0) / 100) * (income[p.payer] || 0);
      inc[p.beneficiary] = (inc[p.beneficiary] || 0) + amt;
      o2[p.payer] = (o2[p.payer] || 0) + amt;
    });
    income = inc; out = o2;
  }
  const gross = consumerPay ? toBase(+consumerPay.value || 0, consumerPay.unit) : inject;
  const rows = ag.parties.filter(p => !p.types.includes("mvco:EndUser"))
    .map(p => ({ p, inc: income[p.id] || 0, out: out[p.id] || 0, net: (income[p.id] || 0) - (out[p.id] || 0) }))
    .filter(r => r.inc || r.out);
  const pctByPayer = {};
  pays.filter(p => p.basis === "percent").forEach(p => pctByPayer[p.payer] = (pctByPayer[p.payer] || 0) + (+p.value || 0));
  return { rows, gross, baseUnit, consumerPay, pctByPayer };
}
const fmt = (n, u) => (Math.abs(n) >= 1 ? n.toFixed(2) : n.toFixed(3)) + " " + u;

/* ---------------- validation ---------------- */
function checks() {
  const c = [];
  const add = (lvl, msg) => c.push([lvl, msg]);
  if (!ag.work.title.trim()) add("err", "Give the work a title (Agreement details).");
  const L = ps => ps.map(p => pretty(p.label)).join(", ");
  const noName = signers().filter(p => !p.name.trim());
  const badWallet = signers().filter(p => p.wallet && !/^0x[0-9a-fA-F]{40}$/.test(p.wallet));
  const noWallet = signers().filter(p => !p.wallet);
  const hint = window.HARDHAT_ACCOUNTS ? " Local demo: click “Fill test wallets & names” under Parties." : "";
  if (noName.length) add("err", `Name every party: ${L(noName)}.${hint}`);
  if (badWallet.length) add("err", `Invalid wallet address: ${L(badWallet)}.`);
  if (noWallet.length) add("warn", `No wallet yet — their share of each play would go to the publisher: ${L(noWallet)}.${hint}`);
  /* PoC runbook: Hardhat #2 is the account that pays for plays. A payee on that wallet
     gets its share of every play it pays for straight back, which hides the transfer. */
  const listenerHH = window.HARDHAT_ACCOUNTS?.[2]?.address?.toLowerCase();
  const onListener = signers().filter(p => listenerHH && p.wallet?.toLowerCase() === listenerHH);
  if (onListener.length) add("warn", `${onListener.map(p => `${p.name || pretty(p.label)} (${pretty(p.label)})`).join(", ")} ${onListener.length === 1 ? "uses" : "use"} Hardhat #2 — the Listener account that pays for plays — so ${onListener.length === 1 ? "its" : "their"} share of each play goes straight back to the wallet paying for it. Give ${onListener.length === 1 ? "it" : "them"} another wallet (the creator normally uses the Producer, Hardhat #1 0x7099…79C8).`);
  const ids = new Set(ag.parties.map(p => p.id));
  const refs = [...ag.permissions.flatMap(p => [p.issuer, p.actor]),
    ...ag.obligations.flatMap(o => o.kind === "payment" ? [o.issuer, o.payer, o.beneficiary] : [o.issuer, o.actor, o.recipient]),
    ...ag.deliverables.flatMap(d => [d.by, d.to])];
  const dangling = [...new Set(refs.filter(r => !ids.has(r)))];
  if (dangling.length) add("err", `Rows refer to removed parties: ${dangling.join(", ")}. In the ⚠ dropdowns pick a remaining party, or delete those rows with ✕ — or start again from a use case.`);
  ag.obligations.filter(o => o.kind === "payment" && o.payer === o.beneficiary).forEach(o => add("err", `“${o.label}” pays itself — choose a different payer or beneficiary (Payments).`));
  const f = computeFlow();
  Object.entries(f.pctByPayer).forEach(([id, pct]) => { if (pct > 100) add("err", `${pretty(party(id)?.label || id)} pays out ${pct}% of its income.`); });
  /* ISO/IEC 21000-23 on Ethereum: Contract.sol stores whole percents and
     Contract.payTo pays recursively from wallet to wallet. Agreements it
     can't settle still work: plays then use the registry's direct split. */
  const direct = " Plays will use the direct split (the registry pays each wallet its share) instead of a Smart Contract for Media.";
  ag.obligations.filter(o => o.kind === "payment" && o.basis === "percent").forEach(o => {
    const v = +o.value;
    if (!Number.isInteger(v) || v < 0 || v > 100) add("warn", `“${o.label}”: ${o.value}% — the Smart Contract for Media stores whole percents (0–100).${direct}`);
  });
  const me = mockUser().wallet;
  const addr = id => (party(id)?.wallet || me || "").toLowerCase();
  ag.obligations.filter(o => o.kind === "payment" && o.basis === "percent" && o.payer !== o.beneficiary && party(o.payer) && party(o.beneficiary))
    .forEach(o => { if (addr(o.payer) && addr(o.payer) === addr(o.beneficiary))
      add("warn", `${pretty(party(o.payer).label)} and ${pretty(party(o.beneficiary).label)} would share one wallet, so “${o.label}” pays a wallet to itself — Contract.payTo can't settle that.${direct} Give them different wallets to use the Smart Contract for Media.`); });
  try { window.SCM?.previewFromModel(ag); } catch (e) { add("err", e.message + "."); }
  if (window.SCM && !window.SCM.entryParty(ag)) add("warn", "No fixed payment by the end user — add one so plays know which party the listener pays.");
  if (!ag.deliverables.length) add("err", "List at least one stem to deliver.");
  if (!ag.deliverables.some(d => d.required)) add("warn", "No stems are marked as required.");
  if (!ag.due) add("warn", "No delivery deadline set.");
  if (!c.some(x => x[0] === "err")) add("ok", "Contract is complete and consistent.");
  return c;
}

/* ---------------- rendering: template picker ---------------- */
function renderTemplates() {
  const grid = $("#uc-grid");
  const models = [["stream", "On-demand stream"], ["download", "Digital sale"]];
  const tiers = [["big", "Big label"], ["indie", "Indie label"], ["self", "Self-released"]];
  grid.innerHTML = `<span></span>${tiers.map(([, l]) => `<span class="uc-col">${l}</span>`).join("")}` +
    models.map(([m, ml]) => `<span class="uc-row">${ml}</span>` + tiers.map(([t]) => {
      const tp = templates.find(x => x.model === m && x.tier === t);
      if (!tp) return "<span></span>";
      const sel = ag?.templateKey === tp.key;
      const pays = tp.obligations.filter(o => o.kind === "payment").length;
      return `<button class="uc ${sel ? "selected" : ""}" role="radio" aria-checked="${sel}" data-key="${tp.key}">
        <b>${ml} · ${tp.tierLabel}</b><span>${esc(tp.description)}</span>
        <small>${tp.parties.length} parties · ${tp.permissions.length} permissions · ${pays} payments</small></button>`;
    }).join("")).join("");
  $$(".uc", grid).forEach(b => b.addEventListener("click", () => {
    // a signed/registered agreement is already saved under My agreements, so
    // picking a use case simply starts a fresh one
    const fresh = isLocked();
    if (fresh) { ag = null; $("#ag-next").hidden = true; $("#ag-register").textContent = "Register agreement on-chain"; }
    const t = templates.find(x => x.key === b.dataset.key);
    const keep = ag && ag.templateKey ? { title: ag.work.title } : null;
    ag = fromTemplate(t);
    if (keep) ag.work.title = keep.title;
    renderEditor();
    $("#ag-body").hidden = false;
    renderTemplates();
    if (fresh) toast("New agreement started — the signed one is under My agreements");
  }));
}

/* ---------------- rendering: editor tables ---------------- */
const partyOpts = sel => ag.parties.map(p => `<option value="${esc(p.id)}" ${p.id === sel ? "selected" : ""}>${esc(pretty(p.label))}${p.name ? " · " + esc(p.name) : ""}</option>`).join("")
  + (sel && !party(sel) ? `<option value="${esc(sel)}" selected>⚠ ${esc(sel)} (removed)</option>` : "");
const opts = (list, sel) => list.map(x => Array.isArray(x)
  ? `<option value="${esc(x[0])}" ${x[0] === sel ? "selected" : ""}>${esc(x[1])}</option>`
  : `<option ${x === sel ? "selected" : ""}>${esc(x)}</option>`).join("");
const actionOpts = sel => opts(ACTIONS.some(a => a[0] === sel) ? ACTIONS : [...ACTIONS, [sel, sel]], sel);
const rm = (kind, u) => `<button class="iconbtn" data-rm="${kind}" data-uid="${u}" aria-label="Remove row" title="Remove">✕</button>`;

function renderParties() {
  $("#tb-parties tbody").innerHTML = ag.parties.map(p => {
    const role = p.types[0] || "";
    const end = p.types.includes("mvco:EndUser");
    return `<tr data-uid="${p.uid}" data-kind="party">
      <td><input data-f="label" value="${esc(p.label)}" aria-label="Role"></td>
      <td><select data-f="role" aria-label="MVCO role"><option value="">—</option>${opts(ROLE_TYPES, role)}</select>
        ${p.types.length > 1 ? `<span class="help">+ ${p.types.slice(1).map(t => t.split(":")[1]).join(", ")}</span>` : ""}</td>
      <td><input data-f="name" value="${esc(p.name)}" placeholder="${end ? "Any listener" : "Legal / artist name"}" aria-label="Name" ${end ? "disabled" : ""}></td>
      <td><input data-f="wallet" class="mono" value="${esc(p.wallet)}" placeholder="${end ? "—" : "0x…"}" aria-label="Wallet" ${end ? "disabled" : ""}></td>
      <td><input data-f="email" type="email" value="${esc(p.email)}" placeholder="${end ? "—" : "for signature request"}" aria-label="Email" ${end ? "disabled" : ""}></td>
      <td>${rm("party", p.uid)}</td></tr>`;
  }).join("");
}
function renderPerms() {
  $("#tb-perms tbody").innerHTML = ag.permissions.map(p => `<tr data-uid="${p.uid}" data-kind="perm">
    <td><select data-f="issuer">${partyOpts(p.issuer)}</select></td>
    <td><select data-f="action">${actionOpts(p.action)}</select></td>
    <td><select data-f="actor">${partyOpts(p.actor)}</select></td>
    <td><select data-f="object">${opts(objects().map(o => [o.id, o.label]), p.object)}</select></td>
    <td><input data-f="label" value="${esc(p.label)}"></td>
    <td>${rm("perm", p.uid)}</td></tr>`).join("");
}
function renderProvide() {
  $("#tb-provide tbody").innerHTML = ag.obligations.filter(o => o.kind === "provide").map(o => `<tr data-uid="${o.uid}" data-kind="ob">
    <td><select data-f="issuer">${partyOpts(o.issuer)}</select></td>
    <td><select data-f="actor">${partyOpts(o.actor)}</select></td>
    <td><select data-f="object">${opts(objects().map(x => [x.id, x.label]), o.object)}</select></td>
    <td><select data-f="recipient">${partyOpts(o.recipient)}</select></td>
    <td><input data-f="label" value="${esc(o.label)}"></td>
    <td>${rm("ob", o.uid)}</td></tr>`).join("");
}
function renderPay() {
  $("#tb-pay tbody").innerHTML = ag.obligations.filter(o => o.kind === "payment").map(o => `<tr data-uid="${o.uid}" data-kind="ob">
    <td><select data-f="issuer">${partyOpts(o.issuer)}</select></td>
    <td><select data-f="payer">${partyOpts(o.payer)}</select></td>
    <td><select data-f="beneficiary">${partyOpts(o.beneficiary)}</select></td>
    <td><select data-f="basis">${opts([["percent", "% income"], ["fixed", "Fixed"]], o.basis)}</select></td>
    <td><input data-f="value" type="number" min="0" step="any" value="${esc(o.value)}" class="num"></td>
    <td>${o.basis === "percent" ? `<span class="help">%</span>` : `<select data-f="unit">${opts(UNITS.includes(o.unit) ? UNITS : [...UNITS, o.unit], o.unit)}</select>`}</td>
    <td><input data-f="label" value="${esc(o.label)}"></td>
    <td>${rm("ob", o.uid)}</td></tr>`).join("");
}
function renderDeliv() {
  $("#tb-deliv tbody").innerHTML = ag.deliverables.map(d => `<tr data-uid="${d.uid}" data-kind="deliv">
    <td><input data-f="name" value="${esc(d.name)}"></td>
    <td><select data-f="group">${opts(GROUPS, d.group)}</select></td>
    <td><select data-f="by">${partyOpts(d.by)}</select></td>
    <td><select data-f="to">${partyOpts(d.to)}</select></td>
    <td><select data-f="format">${opts(FORMATS, d.format)}</select></td>
    <td style="text-align:center"><input data-f="required" type="checkbox" ${d.required ? "checked" : ""} style="width:auto" aria-label="Required"></td>
    <td>${rm("deliv", d.uid)}</td></tr>`).join("");
  const have = new Set(ag.deliverables.map(d => d.name));
  $("#dl-quick").innerHTML = `<span class="help">Quick add:</span>` + QUICK_STEMS.filter(([n]) => !have.has(n))
    .map(([n, g]) => `<button class="chip" data-quick="${esc(n)}" data-g="${g}">＋ ${esc(n)}</button>`).join("");
  $$("#dl-quick .chip").forEach(b => b.addEventListener("click", () => {
    const def = ag.deliverables[0] || {};
    ag.deliverables.push({ uid: uid(), name: b.dataset.quick, group: b.dataset.g, by: def.by || ag.parties[0].id, to: def.to || ag.parties[0].id, format: FORMATS[0], required: true });
    renderDeliv(); refresh();
  }));
}
function renderFlow() {
  const f = computeFlow();
  if (!f.rows.length) { $("#rev-flow").innerHTML = ""; return; }
  const max = Math.max(...f.rows.map(r => Math.abs(r.net)), 1e-9);
  const head = f.consumerPay
    ? `Indicative split of one consumer payment of <b>${f.gross} ${esc(f.baseUnit)}</b>`
    : `Indicative split of <b>100 units</b> entering at ${esc(pretty(party(ag.obligations.find(o => o.kind === "payment")?.payer)?.label))}`;
  $("#rev-flow").innerHTML = `<h3 class="subh">Revenue flow</h3><p class="help" style="margin-bottom:.6rem">${head}. Percentages are applied to each payer's income; figures update as you edit.</p>
    <div class="flowrows">${f.rows.sort((a, b) => b.net - a.net).map(r => `
      <div class="flowrow">
        <span class="who"><b>${esc(pretty(r.p.label))}</b>${r.p.name ? `<small>${esc(r.p.name)}</small>` : ""}</span>
        <span class="bar"><i class="${r.net < 0 ? "neg" : ""}" style="width:${Math.max(2, Math.abs(r.net) / max * 100)}%"></i></span>
        <span class="num">${fmt(r.net, f.baseUnit)}</span>
        <span class="help">in ${fmt(r.inc, "")}· out ${fmt(r.out, "")}</span>
      </div>`).join("")}</div>`;
}
function renderChecks() {
  const c = checks();
  $("#ag-checks").innerHTML = c.map(([l, m]) => `<li class="${l}">${esc(m)}</li>`).join("");
  const hasErr = c.some(x => x[0] === "err");
  $("#ag-sign").disabled = hasErr || (ag.status !== "draft");
  const stale = chainStale();
  const onChain = ag.chain?.standard === "ISO/IEC 21000-23" && !stale;
  const issues = payToIssues(ag);
  const deployable = ag.status === "signed" || ((ag.status === "active" || ag.status === "delivered") && !onChain && !!window.DMAF_CHAIN?.scm && !issues.length);
  $("#ag-register").disabled = hasErr || !deployable;
  $("#ag-register").textContent = onChain ? "Deployed on-chain" : ag.status === "signed" ? "Register agreement on-chain"
    : issues.length && ag.status !== "draft" ? "Live · direct split" : stale ? "Deploy again on this chain" : "Deploy as Smart Contract for Media";
}
/* The chain record stays with the agreement, but a Hardhat restart wipes the chain (and then reuses
   the same addresses for new deployments). Check the record against the chain (js/scm.js chainStatus);
   a stale one is shown as such and the agreement can be deployed again. */
// (a redeployment after a restart can get the same address and even the same tx hash: include the time)
const chainKey = a => a?.chain?.standard === "ISO/IEC 21000-23"
  ? [a.id, a.chain.contractAddress, a.chain.txHash, a.chain.deployedAt || a.chain.importedAt].join("|") : null;
function chainStale() {
  return !!ag && chainCheck.key === chainKey(ag) && (chainCheck.state === "gone" || chainCheck.state === "other");
}
async function checkChainRecord() {
  const k = chainKey(ag);
  if (!k || !window.SCM?.chainStatus) return;
  if (chainCheck.key === k && Date.now() - chainCheck.at < 15000) return;   // renders come often: ask at most every 15 s
  const before = chainStale();
  chainCheck = { key: k, state: chainCheck.key === k ? chainCheck.state : null, at: Date.now() };
  const state = await window.SCM.chainStatus(ag).catch(() => "unknown");
  if (chainCheck.key !== k) return;                    // another agreement (or a new deployment) meanwhile
  if (state !== "unknown") chainCheck.state = state;   // chain unreachable: keep what we knew
  if (chainStale() !== before && !deploying && chainKey(ag) === k) { renderChecks(); renderSigs(); }
}
function renderSigs() {
  const s = ag.signatures || {};
  const show = ag.status !== "draft";
  $("#ag-sigs").innerHTML = !show ? "" : `<h3 class="subh">Signatures</h3>` + signers().map(p => {
    const sig = s[p.id];
    return `<div class="sigrow"><span><b>${esc(pretty(p.label))}</b> ${esc(p.name)}</span>
      ${sig ? `<span class="pill ok">✓ Signed</span><span class="mono help">${esc(sig.sig)}</span>` : `<span class="pill warn">Pending</span><span></span>`}</div>`;
  }).join("");
  const ch = ag.chain;
  const directLive = !ch && ag.settlement?.mode === "direct" && (ag.status === "active" || ag.status === "delivered");
  $("#ag-chain").hidden = !(ch || directLive || ag.status === "registering");
  if (directLive) {
    $("#ag-chain").className = "chainbox confirmed";
    $("#ag-chain-title").innerHTML = `<span class="tick">✓</span> Agreement live — plays settle by direct split`;
    const row = (k, v) => `<div class="chainrow"><span>${k}</span><span>${v}</span></div>`;
    $("#ag-chain-rows").innerHTML = [
      row("Agreement ID", `<span class="mono">${esc(ag.id)}</span>`),
      row("Settlement", "Each paid play is split by the DmafMediaRegistry in the listener's transaction: every party's wallet gets its net share; a wallet that can't take ETH withdraws later."),
      row("Why not a Smart Contract for Media", esc((ag.settlement.reasons || []).join("; ") || "—")),
    ].join("");
  }
  if (ch) {
    const scm = ch.standard === "ISO/IEC 21000-23";
    const stale = scm && chainStale();
    $("#ag-chain").className = stale ? "chainbox pending" : "chainbox confirmed";
    $("#ag-chain-title").innerHTML = stale
      ? (chainCheck.state === "gone"
        ? `✕ Not on this chain any more — the chain was restarted since this was deployed, so the contract below is gone. Deploy it again.`
        : `✕ The contract at ${esc(String(ch.contractAddress).slice(0, 10))}… isn't this agreement's — the restarted chain reused the address for another deployment. Deploy it again.`)
      : scm
      ? `<span class="tick">✓</span> Deployed as an ISO/IEC 21000-23 Smart Contract for Media`
      : `<span class="tick">✓</span> Agreement registered (demo mode — simulated)`;
    const row = (k, v) => `<div class="chainrow"><span>${k}</span><span class="mono">${v}</span></div>`;
    $("#ag-chain-rows").innerHTML = [
      row("Agreement ID", esc(ag.id)),
      row("Transaction", esc(ch.txHash)),
      row(scm ? "Smart Contract for Media" : "Contract address", esc(ch.contractAddress)),
      ...(scm ? [
        row("NFToken (deontics + objects)", `${esc(ch.nfToken)} · ${ch.deonticTokens} + ${ch.objectTokens} tokens`),
        row("Content (IPFS) · keccak256", `${esc(ch.contentUri)} · ${esc(String(ch.contentHash).slice(0, 18))}…`),
        row("Listener pays", ch.entry ? `${esc(pretty(party(ch.entry.party)?.label || ch.entry.party))} · ${esc(ch.entry.address)}` : "—"),
        row("Network", esc(ch.network || "") + (stale ? " · previous chain" : "")),
      ] : []),
    ].join("") + (scm && !stale ? `<div class="rowbtns" style="margin-top:.7rem"><button class="btn secondary sm" id="ag-verify">Read it back from the chain</button>
      <span class="help inline" id="ag-verify-out"></span></div>` : "");
    $("#ag-verify")?.addEventListener("click", () => verifyOnChain(ag));
  }
  $("#ag-next").hidden = !(ag.status === "active" || ag.status === "delivered");
  if (!$("#ag-next").hidden)
    $("#ag-next-msg").textContent = `Publish a finished MP3 to IPFS and the chain now, or deliver the ${ag.deliverables.length} stems the agreement lists (by ${ag.due || "the deadline"}) from Studio → My agreements.`;
  $("#ag-to-publish").href = "#/publish/" + (ag.id || "");
}
function refresh() {
  renderFlow(); renderChecks(); renderSigs();
  $("#ag-json").textContent = JSON.stringify(toJSONLD(), null, 2);
  checkChainRecord();
}
function applyLock() {
  const lock = isLocked();
  $("#ag-body").classList.toggle("locked", lock);
  $$("#ag-body .card:not(:last-child) :is(input,select,button)").forEach(el => {
    if (lock) { el.dataset.wasDisabled = el.disabled ? "1" : ""; el.disabled = true; }
    else if (el.dataset.wasDisabled !== undefined) { el.disabled = el.dataset.wasDisabled === "1"; delete el.dataset.wasDisabled; }
  });
  $("#ag-save").disabled = lock;
}
function renderEditor() {
  $("#ag-title").value = ag.title; $("#ag-work").value = ag.work.title; $("#ag-worktype").value = ag.work.type;
  $("#ag-tracks").value = ag.work.tracks; $("#ag-due").value = ag.due || ""; $("#ag-territory").value = ag.territory;
  $("#ag-genre").value = ag.work.genre; $("#ag-term").value = ag.term;
  $("#ag-basedon").textContent = `Template: ${cleanLabel(ag.templateLabel)}`;
  renderParties(); renderPerms(); renderProvide(); renderPay(); renderDeliv(); refresh(); applyLock();
}

/* ---------------- editor events (delegated) ---------------- */
const detailMap = { "ag-title": v => ag.title = v, "ag-work": v => ag.work.title = v, "ag-worktype": v => ag.work.type = v,
  "ag-tracks": v => ag.work.tracks = v, "ag-due": v => ag.due = v, "ag-territory": v => ag.territory = v,
  "ag-genre": v => ag.work.genre = v, "ag-term": v => ag.term = v };
Object.entries(detailMap).forEach(([id, fn]) => {
  $("#" + id).addEventListener("input", e => { fn(e.target.value); refresh(); });
  $("#" + id).addEventListener("change", () => { if (id === "ag-work" || id === "ag-worktype") { renderPerms(); renderProvide(); } });
});
function rowTarget(el) {
  const tr = el.closest("tr[data-uid]"); if (!tr) return null;
  const u = tr.dataset.uid, k = tr.dataset.kind;
  const list = k === "party" ? ag.parties : k === "perm" ? ag.permissions : k === "ob" ? ag.obligations : ag.deliverables;
  return { item: list.find(x => x.uid === u), kind: k };
}
$("#ag-body").addEventListener("input", e => {
  const f = e.target.dataset.f; if (!f) return;
  const t = rowTarget(e.target); if (!t) return;
  const v = e.target.type === "checkbox" ? e.target.checked : e.target.value;
  if (t.kind === "party" && f === "role") {
    t.item.types = v ? [v, ...t.item.types.slice(1).filter(x => x !== v)] : t.item.types.slice(1);
  } else t.item[f] = v;
  refresh();
});
$("#ag-body").addEventListener("change", e => {
  const f = e.target.dataset.f; if (!f) return;
  const t = rowTarget(e.target); if (!t) return;
  if (t.kind === "party") {
    if (f === "role") renderParties();
    renderPerms(); renderProvide(); renderPay(); renderDeliv(); refresh();
  }
  if (t.kind === "ob" && f === "basis") { if (t.item.basis === "fixed" && !t.item.unit) t.item.unit = "EUR"; renderPay(); refresh(); }
});
$("#ag-body").addEventListener("click", e => {
  const b = e.target.closest("[data-rm]"); if (!b || isLocked()) return;
  const u = b.dataset.uid, k = b.dataset.rm;
  if (k === "party") ag.parties = ag.parties.filter(x => x.uid !== u);
  if (k === "perm") ag.permissions = ag.permissions.filter(x => x.uid !== u);
  if (k === "ob") ag.obligations = ag.obligations.filter(x => x.uid !== u);
  if (k === "deliv") ag.deliverables = ag.deliverables.filter(x => x.uid !== u);
  renderEditor();
});
$$("#ag-body [data-add]").forEach(b => b.addEventListener("click", () => {
  const p0 = ag.parties[0]?.id, p1 = ag.parties[1]?.id || p0;
  const k = b.dataset.add;
  if (k === "party") { const label = "NEW PARTY"; ag.parties.push({ uid: uid(), id: newPartyId("Party"), label, types: [], name: "", wallet: "", email: "" }); }
  if (k === "perm") ag.permissions.push({ uid: uid(), label: "New permission", issuer: p0, action: "mvco:distribute", actor: p1, object: "Song" });
  if (k === "provide") ag.obligations.push({ uid: uid(), kind: "provide", label: "New obligation", issuer: p0, action: "mco-ipre:provideMaterial", actor: p1, object: "Song", recipient: p0 });
  if (k === "pay") ag.obligations.push({ uid: uid(), kind: "payment", label: "New payment", issuer: p0, action: "mco-ipre:Payment", payer: p0, beneficiary: p1, basis: "percent", value: 10, unit: "EUR" });
  if (k === "deliv") { const d = ag.deliverables[0] || {}; ag.deliverables.push({ uid: uid(), name: "New stem", group: "FX", by: d.by || p0, to: d.to || p0, format: FORMATS[0], required: true }); }
  renderEditor();
  const tb = b.previousElementSibling?.querySelector?.("tbody tr:last-child input, tbody tr:last-child select");
  tb?.focus();
}));

/* PoC helper: fill empty wallets with Hardhat test accounts (so payouts land in
   accounts you can import into MetaMask and watch) and empty names with
   placeholder organisations. Connecting MetaMask only identifies *you*; the
   other parties' wallets have to come from somewhere. */
$("#ag-hh-wallets").addEventListener("click", () => {
  if (isLocked()) return;
  if (!window.HARDHAT_ACCOUNTS) { toast("Test accounts not loaded"); return; }
  const me = mockUser().wallet;
  const pool = testWalletPool([me, ...ag.parties.map(p => p.wallet)]);
  let n = 0, named = 0;
  signers().forEach(p => {
    if (!p.name.trim()) { p.name = DEMO_NAMES[p.id] || `${pretty(p.label)} (test)`; named++; }
    if (p.wallet) return;
    const creator = p.types.includes("mvco:Creator") || /AUTHOR|ARTIST/.test(p.label);
    const mine = creator && !ag.parties.some(x => x.wallet && x.wallet.toLowerCase() === me.toLowerCase());
    p.wallet = mine ? me : pool.shift() || "";
    if (p.wallet) n++;
  });
  renderParties(); renderPerms(); renderProvide(); renderPay(); renderDeliv(); refresh();
  toast(n || named ? `Filled ${n} wallet${n === 1 ? "" : "s"} (Hardhat #3 onwards) and ${named} name${named === 1 ? "" : "s"}`
    : "Every party already has a name and wallet");
});

/* ---------------- save / sign / register ---------------- */
$("#ag-save").addEventListener("click", async () => {
  ag = await api.saveAgreement(persistable()); toast("Draft saved to My agreements"); refreshCount(); refresh();
});
$("#ag-download").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(toJSONLD(), null, 2)], { type: "application/ld+json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = (ag.work.title || "agreement").toLowerCase().replace(/[^a-z0-9]+/g, "-") + ".mco.jsonld";
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$("#ag-sign").addEventListener("click", async () => {
  ag.status = "signing"; ag = await api.saveAgreement(persistable()); applyLock(); refresh(); refreshCount();
  toast(`Signature requests sent to ${signers().length} parties`);
  for (const p of signers()) {
    if (ag.signatures?.[p.id]) continue;
    ag = await api.signAgreement(ag.id, p.id); refresh();
  }
  ag.status = "signed"; ag = await api.saveAgreement(persistable()); refresh();
  toast("All parties have signed");
});
/* Register = ISO/IEC 21000-23 forward conversion: the agreement becomes a
   reference Contract + NFTs on the chain (js/scm.js). Without a chain/API
   (demo mode) the registration is simulated as before. */
$("#ag-register").addEventListener("click", async () => {
  const btn = $("#ag-register"), label = btn.textContent; btn.disabled = true; btn.textContent = "Deploying…";
  deploying = true;
  $("#ag-chain").hidden = false; $("#ag-chain").className = "chainbox pending";
  $("#ag-chain-rows").innerHTML = "";
  const stage = (k, msg) => { $("#ag-chain-title").innerHTML = `<span class="pulse"></span> ${esc(msg)}`; };
  stage("", "Preparing…");
  try {
    if (!ag.id) ag = await api.saveAgreement(persistable());
    await api.saveAgreement({ ...persistable(), jsonld: toJSONLD() });
    const issues = payToIssues(ag);
    if (issues.length && window.DMAF_CHAIN?.scm) {
      // Contract.payTo can't settle this agreement: it goes live for the registry's direct split
      ag.status = ag.status === "delivered" ? "delivered" : "active";
      ag.settlement = { mode: "direct", reasons: issues, at: new Date().toISOString() };
      ag = await api.saveAgreement(persistable());
      toast("Agreement is live — plays will use the direct split");
    } else if (await window.SCM?.available()) {
      // the deployment publishes the NFT metadata on IPFS and needs the chain: check both first
      const svc = await window.W3.services(true);
      if (!svc.chain?.ok) throw new Error("Can't reach the local chain at " + (window.DMAF_CHAIN?.rpcUrl || "") + " — is `npm run chain` running?");
      if (!svc.ipfs?.ok) throw new Error("The IPFS node isn't running — start IPFS Desktop or run `ipfs daemon`, then retry (the agreement's NFT metadata goes on IPFS)");
      ag.chain = await window.SCM.deployAgreement(ag, stage);
      chainCheck = { key: null, state: null, at: 0 };  // a fresh record: check it anew
      ag.status = ag.status === "delivered" ? "delivered" : "active";
      delete ag.settlement;
      ag = await api.saveAgreement(persistable());
      toast(`Smart Contract for Media deployed at ${ag.chain.contractAddress.slice(0, 10)}…`);
    } else {
      ag = await api.registerAgreement(ag.id);
      toast("Agreement is live (demo mode) — go make the music!");
    }
    deploying = false;
    refresh(); refreshCount();
    $("#ag-next").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (e) {
    deploying = false;
    btn.disabled = false; btn.textContent = label;
    $("#ag-chain").className = "chainbox"; $("#ag-chain-title").textContent = window.W3?.errMsg(e) || e.message;
    toast(window.W3?.errMsg(e) || e.message);
  }
});

/* Backward conversion check: parse the deployed contract (POST /api/x-dmaf/eth/inspect,
   i.e. /dlt/eth/parse) and compare with what this agreement serialises to now. */
async function verifyOnChain(a) {
  const out = $("#ag-verify-out"); out.textContent = "reading the contract and its NFTs…";
  try {
    const [{ contract, onChain }, mine] = await Promise.all([window.SCM.inspect(a.chain.contractAddress), window.SCM.toContractObjects(a)]);
    const strip = c => JSON.stringify({ ...c, metadata: { ...c.metadata, "dmaf:status": undefined }, idRef: undefined });
    const same = strip(contract) === strip(mine.contract);
    out.innerHTML = `${onChain.contentHashVerified ? `<span class="pill ok">✓ content hash</span>` : `<span class="pill no">✕ content hash</span>`}
      <span class="pill ${same ? "ok" : "warn"}">${same ? "✓ same Media Contractual Objects as this agreement" : "differs from the current edit"}</span>
      · ${Object.keys(contract.deontics).length} deontic expressions · ${Object.keys(onChain.tokens).length} NFTs`;
  } catch (e) { out.innerHTML = `<span class="pill no">✕ ${esc(e.message)}</span>`; }
}

/* exports through the standard's generators (GET /api/generator/mco|cel/{id}) */
async function downloadVia(format, ext, type) {
  try {
    const body = await window.SCM.exportAs(ag, format);
    const blob = new Blob([typeof body === "string" ? body : JSON.stringify(body, null, 2)], { type });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = (ag.work.title || "agreement").toLowerCase().replace(/[^a-z0-9]+/g, "-") + ext;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) { toast(e.message); }
}
$("#ag-download-ttl")?.addEventListener("click", () => downloadVia("turtle", ".mco.ttl", "text/turtle"));
$("#ag-download-cel")?.addEventListener("click", () => downloadVia("cel", ".cel.xml", "application/xml"));

/* Import: an on-chain Smart Contract for Media → a new agreement in My agreements */
$("#ag-import-btn")?.addEventListener("click", async () => {
  const addr = $("#ag-import-addr").value.trim(), btn = $("#ag-import-btn");
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) { toast("Paste the 0x… address of a Smart Contract for Media"); return; }
  btn.disabled = true; btn.textContent = "Reading…";
  try {
    const { contract, onChain } = await window.SCM.inspect(addr);
    let a = window.SCM.agreementFromObjects(contract, onChain);
    a.chain = { standard: "ISO/IEC 21000-23", contractAddress: onChain.address, txHash: "(imported)", chainId: window.DMAF_CHAIN?.chainId,
      network: `${window.DMAF_CHAIN?.chainName} · ${window.DMAF_CHAIN?.chainId}`, nfToken: onChain.nfToken, contentUri: onChain.contentUri,
      contentHash: onChain.contentHash, deonticTokens: Object.keys(contract.deontics).length, objectTokens: Object.keys(contract.objects || {}).length,
      bindings: onChain.bindings, entry: null, importedAt: new Date().toISOString() };
    const entry = window.SCM.entryParty(a);
    if (entry) a.chain.entry = { party: entry, address: a.parties.find(p => p.id === entry)?.wallet || "" };
    a = await api.saveAgreement(a);
    toast(`Imported “${a.title}” — ${onChain.contentHashVerified ? "content hash verified" : "content hash does NOT match"}`);
    $("#ag-import-addr").value = ""; renderList(); refreshCount();
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; btn.textContent = "Import"; }
});
function persistable() { return clone(ag); }
$("#to-w2").addEventListener("click", () => startDelivery(ag));

/* ---------------- mode switch + existing list ---------------- */
$$("#wstep-1 .seg").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));
function setMode(m) {
  mode = m;
  $$("#wstep-1 .seg").forEach(b => { const on = b.dataset.mode === m; b.classList.toggle("active", on); b.setAttribute("aria-selected", on); });
  $("#ag-existing").hidden = m !== "existing";
  $("#ag-editor").hidden = m !== "new";
  if (m === "existing") { renderList(); $("#ag-next").hidden = true; } else if (ag) renderSigs();
}
async function refreshCount() { $("#ag-count").textContent = (await api.agreements()).length; }
function agCard(a, compact) {
  const [cls, txt] = STATUS[a.status] || STATUS.draft;
  const done = Object.keys(a.delivered || {}).filter(k => a.deliverables.some(d => d.uid === k)).length;
  const who = a.parties.filter(p => !p.types.includes("mvco:EndUser") && p.name).map(p => p.name).join(", ");
  return `<div class="agcard">
    <div>
      <h3>${esc(a.work.title || "Untitled")} <span class="help">· ${esc(a.work.type)}</span></h3>
      <p class="help">${esc(a.title)} · ${esc(a.id)}</p>
      <div class="tags"><span class="pill ${cls}">${txt}</span><span class="pill mco">MCO</span>
        <span class="pill">${a.deliverables.length ? `${done}/${a.deliverables.length} stems delivered` : "no deliverables"}</span>
        ${a.due ? `<span class="pill">Due ${esc(a.due)}</span>` : ""}</div>
      ${who ? `<p class="help" style="margin-top:.4rem">Parties: ${esc(who)}</p>` : ""}
    </div>
    <div class="rowbtns">
      ${compact ? "" : `<button class="btn secondary sm" data-open="${a.id}">${a.status === "draft" ? "Edit" : "View"}</button>`}
      ${a.status === "active" || a.status === "delivered" ? `<a class="btn secondary sm" href="#/publish/${a.id}">Publish MP3</a>` : ""}
      ${a.status === "active" || a.status === "delivered"
        ? `<a class="btn primary sm" href="#/studio/${a.id}">Deliver stems</a>`
        : compact ? `<a class="btn secondary sm" href="#/studio">Open Studio</a>` : ""}
    </div></div>`;
}
async function renderList() {
  const list = await api.agreements();
  $("#ag-count").textContent = list.length;
  $("#ag-list").innerHTML = list.length ? list.map(a => agCard(a)).join("")
    : `<div class="empty">No agreements yet. Create one from a use-case template.</div>`;
  $$("#ag-list [data-open]").forEach(b => b.addEventListener("click", async () => {
    ag = normalize(await api.agreement(b.dataset.open));
    setMode("new"); $("#ag-body").hidden = false; renderTemplates(); renderEditor();
  }));
}
window.renderLibraryAgreements = async () => {
  const list = await api.agreements();
  $("#library-agreements").innerHTML = list.length ? list.map(a => agCard(a, true)).join("")
    : `<div class="empty">No agreements yet. <a href="#/studio">Create one in the Studio</a>.</div>`;
};

/* ---------------- step 2 · stems against deliverables ----------------
   Stems are uploaded to the dev server (server/stems.mjs, /studio-api),
   which later mixes them with ffmpeg and packages them as IMAF. Opened
   without the dev server (demo mode) only the file names are recorded. */
let pendingRow = null;
const extras = [];   // stems uploaded that the agreement doesn't list
const studio = { ffmpeg: null, stems: {}, uploading: {} };   // dev-server state for the open agreement
/* 401 = signed out or the session ended (PostgreSQL mode, tools/serve.mjs): back to Sign in. */
const signedOut = r => { if (r.status === 401) window.DMAF_ACCOUNT?.sessionEnded?.(); return r; };
const studioApi = {
  async status() {
    try {
      const r = signedOut(await fetch("/studio-api/status", { cache: "no-store" }));
      if (!r.ok) return null;
      const j = await r.json();
      return j.ffmpeg ? { ...j.ffmpeg, mp4box: j.mp4box || null } : null;      // ffmpeg + whether MP4Box will mux
    } catch { return null; }
  },
  async list(agId) {
    try { const r = signedOut(await fetch(`/studio-api/stems/${encodeURIComponent(agId)}`, { cache: "no-store" })); return r.ok ? r.json() : []; } catch { return []; }
  },
  upload(agId, key, file, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("PUT", `/studio-api/stems/${encodeURIComponent(agId)}/${encodeURIComponent(key)}`);
      x.setRequestHeader("x-filename", encodeURIComponent(file.name));
      x.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
      x.onload = () => {
        let j = {}; try { j = JSON.parse(x.responseText); } catch {}
        signedOut(x);
        x.status === 200 ? resolve(j) : reject(new Error(j.message || `upload failed (${x.status})`));
      };
      x.onerror = () => reject(new Error("Can't reach the dev server — open the app through `npm run serve`"));
      x.send(file);
    });
  },
  async package(agId, body) {
    let r;
    try { r = signedOut(await fetch(`/studio-api/stems/${encodeURIComponent(agId)}/package`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })); }
    catch { throw new Error("Can't reach the dev server — open the app through `npm run serve`"); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || `packaging failed (${r.status})`);
    return j;
  },
  async readImaf(cid) {
    const r = signedOut(await fetch(`/studio-api/imaf/${encodeURIComponent(cid)}`, { cache: "no-store" }));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || `read failed (${r.status})`);
    return j;
  },
};
async function syncStudio(a) {
  const [ff, list] = await Promise.all([studioApi.status(), studioApi.list(a.id)]);
  if (wiz.agreement !== a) return;
  studio.ffmpeg = ff;
  studio.stems = Object.fromEntries(list.map(x => [x.key, x]));
  // stems delivered as extras in an earlier session are still on the dev server
  for (const x of list) if (!a.deliverables.some(d => d.uid === x.key) && !extras.some(e => e.key === x.key))
    extras.push({ key: x.key, name: x.name.replace(/\.[a-z0-9]+$/i, "").replace(/[_\-]+/g, " "), group: "FX", file: { name: x.name } });
  renderStems();
}
function startDelivery(a) {
  wiz.agreement = a;
  extras.length = 0;
  studio.ffmpeg = null; studio.stems = {}; studio.uploading = {};
  $("#pk-title").value = a.work.title || $("#pk-title").value;
  $("#pk-genre").value = a.work.genre || $("#pk-genre").value;
  a.levels = a.levels || {};
  renderStems();
  wizGo(2);
  syncStudio(a);
}
const fmtDur = s => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");
function stemCell(r) {
  const up = studio.uploading[r.key];
  if (up != null) return `<span class="pulse"></span> <span class="mono">${esc(r.file?.name || "")}</span><span class="stemfacts">uploading to the dev server… ${Math.round(up * 100)}%</span>`;
  if (!r.file) return `<button class="btn secondary sm" data-pick="${r.key}">Choose file</button>`;
  const f = studio.stems[r.key];
  const name = `<span class="pill ok">✓</span> <span class="mono">${esc(f?.name || r.file.name)}</span>`;
  if (f) return name + `<span class="stemfacts">on the dev server · ${[f.sampleRate ? f.sampleRate / 1000 + " kHz" : "", f.bits ? f.bits + "-bit" : "", f.channels ? f.channels + " ch" : "", fmtDur(f.durationSec)].filter(Boolean).join(" · ")}</span>`;
  if (studio.ffmpeg) return name + `<span class="stemfacts"><span class="pill warn">not on the dev server</span> <button class="btn secondary sm" data-pick="${r.key}">Choose the file again</button></span>`;
  return name + `<span class="stemfacts">demo mode — name only (open the app through <code>npm run serve</code> to upload)</span>`;
}
function stemRows() {
  const a = wiz.agreement;
  return [
    ...a.deliverables.map(d => ({ key: d.uid, name: d.name, group: d.group, by: a.parties.find(p => p.id === d.by), required: d.required,
      file: a.delivered?.[d.uid], extra: false, format: d.format })),
    ...extras.map(x => ({ key: x.key, name: x.name, group: x.group, by: null, required: false, file: x.file, extra: true })),
  ];
}
function renderStems() {
  const a = wiz.agreement; if (!a) return;
  const rows = stemRows();
  $("#stem-to-publish").href = "#/publish/" + a.id;
  $("#stem-agbanner").innerHTML = `<span class="pill mco">MCO</span> <b>${esc(a.work.title)}</b> · ${esc(a.title)}
    <span class="mono help">${esc(a.chain?.contractAddress?.slice(0, 12) || a.id)}…</span>
    <button class="btn secondary sm" id="stem-switch">Switch agreement</button>`;
  $("#stem-switch").addEventListener("click", () => { wizGo(1); setMode("existing"); });
  $("#stem-table tbody").innerHTML = rows.map(r => `<tr class="${r.file ? "" : "missing"}">
    <td><b>${esc(r.name)}</b>${r.required ? "" : ` <span class="help">(optional)</span>`}
      ${r.extra ? `<span class="pill warn">Not in agreement</span>` : `<br><span class="help">${esc(r.format || "")}</span>`}</td>
    <td>${r.by ? esc(r.by.name || pretty(r.by.label)) : "—"}</td>
    <td>${stemCell(r)}</td>
    <td><select class="grp-sel" data-k="${r.key}">${GROUPS.map(g => `<option ${g === r.group ? "selected" : ""}>${g}</option>`).join("")}</select></td>
    <td><input type="range" class="vol" min="0" max="100" value="${a.levels[r.key] ?? 70}" data-k="${r.key}" ${r.file ? "" : "disabled"} aria-label="Default level"></td>
    <td>${r.file ? `<button class="iconbtn" data-clear="${r.key}" title="Remove file" aria-label="Remove file">✕</button>` : ""}</td>
  </tr>`).join("");
  $$("#stem-table [data-pick]").forEach(b => b.addEventListener("click", () => { pendingRow = b.dataset.pick; $("#stem-file-one").click(); }));
  $$("#stem-table [data-clear]").forEach(b => b.addEventListener("click", () => {
    const k = b.dataset.clear;
    delete studio.stems[k];
    if (a.delivered?.[k]) { delete a.delivered[k]; api.saveAgreement(a); }
    const i = extras.findIndex(x => x.key === k); if (i >= 0) extras.splice(i, 1);
    renderStems();
  }));
  $$("#stem-table .grp-sel").forEach(s => s.addEventListener("change", () => {
    const d = a.deliverables.find(x => x.uid === s.dataset.k) || extras.find(x => x.key === s.dataset.k); if (d) d.group = s.value; syncWiz();
  }));
  $$("#stem-table input.vol").forEach(r => r.addEventListener("input", () => { a.levels[r.dataset.k] = +r.value; syncWiz(); }));
  const onServer = r => !studio.ffmpeg || !!studio.stems[r.key];
  const req = rows.filter(r => r.required), got = req.filter(r => r.file && onServer(r));
  const total = rows.filter(r => r.file).length;
  $("#stem-progress").innerHTML = esc(`${got.length} of ${req.length} required stems delivered` + (extras.length ? ` · ${extras.length} extra` : ""))
    + (studio.ffmpeg === null ? "" : studio.ffmpeg?.ok ? ` · <span class="pill ok">ffmpeg ${esc(studio.ffmpeg.version)}</span>`
        + (studio.ffmpeg.mp4box?.ok ? ` <span class="pill imaf">MP4Box ${esc(studio.ffmpeg.mp4box.version)}</span>` : "") + " ready to mix and package"
      : ` · <span class="pill warn">ffmpeg unavailable</span> ${esc(studio.ffmpeg?.error || "")}`);
  $("#stem-drop strong").textContent = total ? `${total} stem${total > 1 ? "s" : ""} delivered — drop more, or continue` : "Drop audio stems here, or click to add";
  $("#to-w3").disabled = got.length < req.length || Object.keys(studio.uploading).length > 0;
  syncWiz();
}
function syncWiz() {
  const a = wiz.agreement;
  wiz.stems = stemRows().filter(r => r.file).map(r => ({ key: r.key, name: r.name, group: r.group, vol: a.levels[r.key] ?? 70, onServer: !!studio.stems[r.key] }));
}
function score(filename, name) {
  const f = filename.toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[_\-.]+/g, " ");
  return name.toLowerCase().split(/\s+/).map(w => w.replace(/s$/, "")).filter(w => w.length > 1)
    .reduce((n, w) => n + (f.includes(w) ? 1 : 0), 0);
}
async function deliverFiles(files, forcedKey) {
  const a = wiz.agreement;
  for (const file of files) {
    let key = forcedKey;
    if (!key) {
      const open = a.deliverables.filter(d => !a.delivered?.[d.uid]);
      const best = open.map(d => [d, score(file.name, d.name)]).sort((x, y) => y[1] - x[1])[0];
      if (best && best[1] > 0) key = best[0].uid;
    }
    if (!key) {
      key = "x_" + uid();
      extras.push({ key, name: file.name.replace(/\.[a-z0-9]+$/i, "").replace(/[_\-]+/g, " "), group: "FX", file: null });
    }
    if (studio.ffmpeg) {                      // dev server: upload the stem itself
      studio.uploading[key] = 0; renderStems();
      try {
        studio.stems[key] = await studioApi.upload(a.id, key, file, p => { studio.uploading[key] = p; renderStems(); });
      } catch (e) {
        delete studio.uploading[key];
        const i = extras.findIndex(x => x.key === key && !x.file); if (i >= 0) extras.splice(i, 1);
        renderStems(); toast(e.message); continue;
      }
      delete studio.uploading[key];
    }
    if (a.deliverables.some(d => d.uid === key)) {
      const r = await api.deliverStem(a.id, key, file);
      a.delivered = r?.delivered || { ...(a.delivered || {}), [key]: { name: file.name } };
    } else {
      const x = extras.find(e => e.key === key); if (x) x.file = { name: file.name };
    }
  }
  const all = a.deliverables.filter(d => d.required).every(d => a.delivered?.[d.uid]);
  if (all && a.status === "active") { a.status = "delivered"; await api.saveAgreement(a); }
  renderStems();
  if (extras.length) toast(`${extras.length} file(s) didn't match a stem in the agreement. To release a finished MP3, use Publish (link above).`);
}
$("#stem-drop").addEventListener("click", () => $("#stem-file").click());
$("#stem-drop").addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#stem-file").click(); } });
$("#stem-drop").addEventListener("dragover", e => { e.preventDefault(); $("#stem-drop").classList.add("over"); });
$("#stem-drop").addEventListener("dragleave", () => $("#stem-drop").classList.remove("over"));
$("#stem-drop").addEventListener("drop", e => { e.preventDefault(); $("#stem-drop").classList.remove("over"); deliverFiles([...e.dataTransfer.files]); });
$("#stem-file").addEventListener("change", e => { deliverFiles([...e.target.files]); e.target.value = ""; });
$("#stem-file-one").addEventListener("change", e => { if (e.target.files[0]) deliverFiles([e.target.files[0]], pendingRow); e.target.value = ""; });
$("#to-w3").addEventListener("click", () => wizGo(3));

/* ---------------- entry ---------------- */
let booted = false;
async function boot() {
  templates = await api.contractTemplates();      // the six ISO/IEC 21000-23 use cases
  if (window.DMAF_MOCK) await seedDemo();
  renderTemplates(); refreshCount(); booted = true;
}
let bootP = null;
const bootOnce = () => (bootP ||= boot());
window.studioEnter = async (arg) => {
  await bootOnce();
  if (arg) {
    const a = normalize(await api.agreement(arg));
    if (!a) { toast("Agreement not found"); return; }
    if (a.status !== "active" && a.status !== "delivered") { toast("That agreement isn't active yet"); return; }
    startDelivery(a);
  }
};

/* demo seed: one active agreement awaiting stems, so the "come back later" path is visible */
async function seedDemo() {
  try { if (localStorage.getItem("dmaf_ag_seeded")) return; localStorage.setItem("dmaf_ag_seeded", "1"); } catch { return; }
  if ((await api.agreements()).length) return;
  const t = templates.find(x => x.key === "stream-small-label"); if (!t) return;
  const a = fromTemplate(t);
  a.work = { title: "Night Signals", type: "EP", tracks: 4, genre: "Electronic" };
  a.title = "Night Signals EP — indie release";
  const names = DEMO_NAMES;
  const pool = testWalletPool(a.parties.map(p => p.wallet));
  a.parties.forEach(p => { if (names[p.id] && !p.wallet) { p.name = names[p.id]; p.wallet = pool.shift() || hexAddr(); } });
  a.status = "active";
  a.signatures = Object.fromEntries(a.parties.filter(p => !p.types.includes("mvco:EndUser")).map(p => [p.id, { sig: "0x" + uid() + uid() + "…" }]));
  // Not deployed yet: Studio ▸ "Deploy as Smart Contract for Media", or Publish, deploys it for real.
  // In demo mode (no chain) a simulated registration record is shown instead.
  if (!window.DMAF_CHAIN?.scm) a.chain = { txHash: hexAddr() + "e4d2", contractAddress: hexAddr(), network: "demo (simulated)" };
  await api.saveAgreement(a);
}
function hexAddr() { return "0x" + Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join(""); }

/* Read-only access to an agreement's MCO serialisation and revenue flow,
   used by the IPFS/chain publishing flow (js/media.js). */
function withAg(a, fn) { const prev = ag; ag = a; try { return fn(); } finally { ag = prev; } }
/* "No agreement" publishing: a one-party agreement in which the listener pays
   the publisher, so every asset still has an MCO agreement (and can have a
   Smart Contract for Media). */
function directAgreement(title, wallet) {
  const a = fromTemplate(POC_TEMPLATES[0]);
  a.id = "direct-" + Date.now().toString(36);
  a.title = `Publisher only · ${title || "untitled"}`;
  a.work = { ...a.work, title: title || "", type: "Single", tracks: 1 };
  a.parties.forEach(p => { if (p.id === "Producer") { p.wallet = wallet; p.name = p.name || "Publisher"; } });
  a.deliverables = [];
  a.status = "active";
  return a;
}
window.DMAF_STUDIO = studioApi;     // used by js/app.js (Studio step 5) and js/media.js (asset page)
window.DMAF_MCO = {
  jsonld: a => withAg(normalize(a), toJSONLD),
  normalize,
  direct: directAgreement,
  flow: a => withAg(a, computeFlow),
  pretty,
  ready: () => bootOnce(),   // loads templates + the demo seed agreement
};
})();

/* app.js routes before this file loads — catch a direct #/studio… entry */
if (location.hash.startsWith("#/studio")) window.studioEnter(location.hash.split("/")[2]);
