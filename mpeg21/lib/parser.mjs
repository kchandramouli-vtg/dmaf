/* ============================================================
   MCO → Media Contractual Objects   (ISO/IEC 21000-23, POST /parser/mco)

   Same algorithm, lookup tables and output shape as the reference
   "MPEG-21 MCO Parser" (handlers/ + generators/), with its defects
   fixed. Each fix is tagged [FIX n] and listed in mpeg21/CONFORMANCE.md:

    1  Works on IRIs, not prefix names: any prefixes, Turtle or JSON-LD.
    2  A node's class is its most specific known rdf:type, not the first
       one written (RDF has no type order).
    3  Unknown or untyped nodes that are never referenced are ignored;
       a referenced one is a 400 with its IRI (reference: TypeError).
    4  Deontic expressions without mco-core:issuedIn are attached through
       mco-core:issues, or to the only contract in the document.
    5  Constraints, text clauses and resulting objects of a deontic are
       followed (reference: ReferenceError parentContractId).
    6  Facts use the Fact table (reference: Action table → all fact
       properties dropped); Interval/Timeline use their own tables.
    7  belongsToCollective follows its own list; sellsDeontic is followed.
    8  Party properties are matched case-insensitively like every other class.
    9  signatories stays an array of ids (OpenAPI Contract.signatories).
   10  The misspelt mco-pane:hasCurency is read as currency.
   11  [extension] Properties outside the tables are kept in `metadata`
       for every class (reference: kept for some, dropped with a warning
       for others — e.g. every action's rdfs:label).
   12  Metadata values are strings (OpenAPI WithMetadata), IRIs as IRIs.
   ============================================================ */
import { LUT, MODELS, FACT_SUBFIELD, LUT_FOR, EXTRA_PROPS, CONTRACT_ISSUES } from "./vocab.mjs";
import { toTriples, compactGraph, sniffFormat, MCOInputError } from "./rdf.mjs";

export { MCOInputError, sniffFormat };

/**
 * Parse an MCO contract.
 * @param {string|object} input  Turtle text, JSON-LD text, or a JSON-LD object
 * @param {{format?: "turtle"|"jsonld"}} [opts]
 * @returns {Promise<{contracts: object[], warnings: string[]}>}
 */
export async function getContractFromMCO(input, opts = {}) {
  const graph = compactGraph(await toTriples(input, opts.format));
  return parseGraph(graph);
}

/* ---------------- helpers (reference: handlers/lib/Utils.js, AddElement.js) ---------------- */

const ids = v => [].concat(v ?? []).map(x => (x && typeof x === "object" ? x["@id"] : x)).filter(x => x !== undefined);

function classDataOf(el) {
  if (!el) return null;
  let best = null;
  for (const t of [].concat(el["@type"] || [])) {
    const d = LUT.AllClasses[String(t).toLowerCase()];
    if (d && (!best || d.length > best.length)) best = d; // [FIX 2]
  }
  return best;
}

function metaString(v) { // [FIX 12]
  const one = x => (x && typeof x === "object" ? x["@id"] ?? JSON.stringify(x) : String(x));
  const arr = [].concat(v);
  return arr.length === 1 ? one(arr[0]) : arr.map(one).join("\n");
}

function addElement(model, obj, key, value, origKey) {
  const kind = model[key];
  if (kind === undefined) throw new MCOInputError("Generation error, key:" + key);
  const str = x => (x && typeof x === "object" ? x["@id"] : x);
  switch (kind) {
    case "string": {
      const v = [].concat(value)[0];
      obj[key] = typeof v === "number" ? String(v) : str(v);
      break;
    }
    case "array":
      obj[key] ||= [];
      for (const v of [].concat(value)) { const s = str(v); if (!obj[key].includes(s)) obj[key].push(s); }
      break;
    case "map":
      obj[key] ||= {};
      obj[key][origKey] = key === "metadata" ? metaString(value) : value;
      break;
    case "boolean": {
      const v = [].concat(value)[0];
      obj[key] = v === true || v === "true" || v === "True";
      break;
    }
    case "number":
      obj[key] = Number([].concat(value)[0]);
      break;
    default:
      throw new MCOInputError("Generation error");
  }
}

/* Fill an object from a graph node with the class lookup table. */
function fill(obj, model, lutName, el) {
  const table = LUT[lutName];
  const extra = EXTRA_PROPS[lutName] || {};
  for (const k of Object.keys(el)) {
    if (k === "@type") continue;
    const lk = k === "@id" ? k : k.toLowerCase(); // [FIX 8]
    const hit = table[lk] || table[k] || extra[lk]; // [FIX 10]
    if (hit) {
      if (hit[0] === "contractRelations") { // OpenAPI: map contractIdref → ContractRelationsEnum (reference: throws)
        obj.contractRelations ||= {};
        ids(el[k]).forEach(other => { obj.contractRelations[other] = hit[1]; });
      } else if (model[hit[0]] !== undefined) addElement(model, obj, hit[0], el[k], k);
      else if (model.metadata) addElement(model, obj, "metadata", el[k], k);
    } else if (model.metadata) addElement(model, obj, "metadata", el[k], k); // [FIX 11]
  }
  return obj;
}

/* ---------------- generators (reference: generators/lib/classes/*.js) ---------------- */

function generate(classData, el) {
  const top = classData[0];
  const obj = { class: top };
  let model = MODELS[top] || MODELS.Fact;
  switch (top) {
    case "Contract":
      return fill(obj, MODELS.Contract, "Contract", el);
    case "Party":
      if (classData.length > 1) {
        obj.class = classData[1];
        if (classData[1] === "MCOUser") {
          model = MODELS.MCOUser;
          if (classData.length > 2) { obj.class = classData[2]; addElement(model, obj, "role", classData[2]); }
        } else if (classData[1] === "Organization") model = MODELS.Organization;
      }
      return fill(obj, model, "Party", el);
    case "MCODeonticExpression": {
      let type = "MCODeonticExpression";
      if (classData.length > 1) { obj.class = type = classData[1]; if (type === "MCOPermission") model = MODELS.MCOPermission; }
      addElement(model, obj, "type", type);
      return fill(obj, model, "MCODeonticExpression", el);
    }
    case "Action": {
      let type = "Simple";
      if (classData.length > 1) { obj.class = type = classData[1]; model = MODELS[type] && ["Trade", "Provide", "Payment", "Notify"].includes(type) ? MODELS[type] : MODELS.Action; }
      addElement(model, obj, "type", type);
      return fill(obj, model, "Action", el);
    }
    case "IPEntity": {
      let type = "Simple";
      if (classData.length > 1) { obj.class = type = classData[1]; if (type === "Segment") model = MODELS.Segment; }
      addElement(model, obj, "type", type);
      return fill(obj, model, "IPEntity", el);
    }
    case "Fact": {
      let type = "Simple";
      model = MODELS.Fact;
      if (classData.length > 1) {
        obj.class = type = classData[1];
        model = MODELS[type] || MODELS.Fact;
        const sub = FACT_SUBFIELD[type];
        if (sub && classData.length > 2) { obj.class = classData[2]; addElement(model, obj, sub, classData[2]); } // [FIX 6] DeliveryModality spelt right
      }
      addElement(model, obj, "type", type);
      return fill(obj, model, "Fact", el); // [FIX 6]
    }
    case "Service": {
      let type = "Simple";
      if (classData.length > 1) { obj.class = type = classData[1]; }
      addElement(MODELS.Service, obj, "type", type);
      return fill(obj, MODELS.Service, "Service", el);
    }
    case "TextClause": case "Track": case "Interval": case "Timeline":
      return fill(obj, MODELS[top], LUT_FOR[top], el); // [FIX 6]
    default:
      return fill(obj, MODELS.Fact, "Fact", el);
  }
}

/* ---------------- handlers (reference: handlers/lib/classes/*.js) ---------------- */

function parseGraph(graph) {
  const objs = {};
  const warnings = [];
  const parsed = el => objs[el["@id"]]?.identifier !== undefined;
  const save = o => { objs[o.identifier] = objs[o.identifier] === undefined ? o : { ...objs[o.identifier], value: o }; };
  const push = (obj, field, value) => addElement({ [field]: "array" }, obj, field, value);
  const need = (id, what, from) => {
    const el = graph[id];
    const cd = classDataOf(el);
    if (!el || !el["@type"]) throw new MCOInputError(`${what} <${id}> referenced by <${from}> is not described in the document (no rdf:type)`); // [FIX 3]
    if (!cd) throw new MCOInputError(`${what} <${id}> has no MPEG-21 class (types: ${[].concat(el["@type"]).join(", ")})`);
    return [el, cd];
  };

  const handleParty = (id, contractId, from) => {
    const [el, cd] = need(id, "Party", from);
    if (cd[0] !== "Party") throw new MCOInputError(`<${id}> is used as a party but is a ${cd[0]}`);
    if (parsed(el)) return;
    const p = generate(cd, el);
    save(p);
    const c = objs[contractId];
    if (c && !(c.parties || []).includes(p.identifier) && cd[1] === "MCOUser") push(c, "otherPersonUsers", p.identifier);
    (p.actOnBehalfOf || []).forEach(x => handleParty(x, contractId, id));
    (p.belongsToCollective || []).forEach(x => handleParty(x, contractId, id)); // [FIX 7]
    (p.isRightsOwnerOf || []).forEach(x => handleIPEntity(x, contractId, id));
    if (p.signatory) handleParty(p.signatory, contractId, id);
  };

  const handleIPEntity = (id, contractId, from) => {
    const [el, cd] = need(id, "Object", from);
    if (parsed(el)) return;
    if (cd[0] === "Service") return handleSimple(el, cd, contractId, "objects");
    if (cd[0] === "Track") return handleSimple(el, cd, contractId, "objects");
    if (cd[0] === "Interval") return handleInterval(el, cd, contractId);
    const o = generate(cd, el);
    save(o);
    if (objs[contractId]) push(objs[contractId], "objects", o.identifier);
    (o.rightsOwners || []).forEach(x => handleParty(x, contractId, id));
    (o.isMadeUpOf || []).forEach(x => handleIPEntity(x, contractId, id));
    (o.resultedFrom || []).forEach(x => handleAction(x, contractId, id));
    (o.segments || []).forEach(x => handleIPEntity(x, contractId, id));
    (o.tracks || []).forEach(x => handleIPEntity(x, contractId, id));
    (o.interval || []).forEach(x => handleIPEntity(x, contractId, id));
    if (o.segmentOf) handleIPEntity(o.segmentOf, contractId, id);
    (o.contains || []).forEach(x => handleIPEntity(x, contractId, id));
    (o.onTrack || []).forEach(x => handleIPEntity(x, contractId, id));
  };

  const handleSimple = (el, cd, contractId, field) => {
    const o = generate(cd, el);
    save(o);
    if (objs[contractId]) push(objs[contractId], field, o.identifier);
    return o;
  };

  const handleInterval = (el, cd, contractId) => {
    const o = handleSimple(el, cd, contractId, "objects");
    if (o.onTimeline) {
      const [tel, tcd] = need(o.onTimeline, "Timeline", o.identifier);
      if (!parsed(tel)) save(generate(tcd, tel));
      addElement({ onTimeline: "string" }, o, "onTimeline", JSON.stringify(objs[tel["@id"]]));
    }
  };

  const handleFact = (id, contractId, from) => {
    const [el, cd] = need(id, "Fact", from);
    if (parsed(el)) return;
    const f = generate(cd, el);
    save(f);
    if (objs[contractId]) push(objs[contractId], "facts", f.identifier);
    (f.composedFacts || []).forEach(x => handleFact(x, contractId, id));
    (f.makesTrue || []).forEach(x => handleAction(x, contractId, id));
    if (f.withIPEntity) handleIPEntity(f.withIPEntity, contractId, id);
    (f.partOf || []).forEach(x => handleIPEntity(x, contractId, id));
  };

  const handleTextClause = (id, contractId, from) => {
    const [el, cd] = need(id, "Text clause", from);
    if (parsed(el)) return;
    handleSimple(el, cd, contractId, "textClauses");
  };

  const handleAction = (id, contractId, from) => {
    const [el, cd] = need(id, "Action", from);
    if (cd[0] !== "Action") throw new MCOInputError(`<${id}> is used as an action but is a ${cd[0]}`);
    if (parsed(el)) return;
    const a = generate(cd, el);
    save(a);
    if (objs[contractId]) push(objs[contractId], "actions", a.identifier);
    if (a.actedBy) {
      handleParty(a.actedBy, contractId, id);
      push(objs[a.actedBy], "actionsIsSubject", a.identifier);
    } else warnings.push(`Action <${id}> has no mvco:actedBy`);
    (a.impliesAlso || []).forEach(x => handleAction(x, contractId, id));
    (a.rightGivenBy || []).forEach(x => handleParty(x, contractId, id));
    if (a.sellsDeontic) handleDeontic(a.sellsDeontic, id); // [FIX 7]
    (a.recipients || []).forEach(x => handleParty(x, contractId, id));
    (a.beneficiaries || []).forEach(x => handleParty(x, contractId, id));
    (a.incomeSources || []).forEach(x => handleAction(x, contractId, id));
    (a.isAbout || []).forEach(x => handleAction(x, contractId, id));
  };

  const contractOf = new Map(); // deontic id → contract id, from mco-core:issues
  const handleDeontic = (id, from) => {
    const [el, cd] = need(id, "Deontic expression", from);
    if (parsed(el)) return;
    const d = generate(cd, el);
    if (!d.issuedIn) { // [FIX 4]
      const c = contractOf.get(id) || (contractIds.length === 1 ? contractIds[0] : undefined);
      if (!c) throw new MCOInputError(`Deontic expression <${id}> has no mco-core:issuedIn and there are ${contractIds.length} contracts`);
      d.issuedIn = c;
    }
    save(d);
    const contractId = d.issuedIn;
    if (!objs[contractId]) throw new MCOInputError(`Deontic expression <${id}> is issued in <${contractId}>, which is not a contract in the document`);
    push(objs[contractId], "deontics", d.identifier);
    if (d.issuer) {
      handleParty(d.issuer, contractId, id);
      push(objs[d.issuer], "deonticsIssued", d.identifier);
    } else warnings.push(`Deontic expression <${id}> has no issuer`);
    if (d.act) {
      handleAction(d.act, contractId, id);
      const a = objs[d.act];
      if (a.actedBy) addElement({ actedBySubject: "string" }, d, "actedBySubject", a.actedBy);
      (a.actedOver || []).forEach(x => { push(d, "actObjects", x); handleIPEntity(x, contractId, d.act); });
      (a.resultsIn || []).forEach(x => { push(d, "resultantObject", x); handleIPEntity(x, contractId, d.act); }); // [FIX 5]
    }
    (d.textClauses || []).forEach(x => handleTextClause(x, contractId, id)); // [FIX 5]
    (d.constraints || []).forEach(x => handleFact(x, contractId, id)); // [FIX 5]
  };

  /* contracts first, then deontic expressions — same order as the reference */
  const contractIds = [];
  for (const el of Object.values(graph)) {
    const cd = classDataOf(el);
    if (!cd || cd[0] !== "Contract") continue;
    const c = generate(cd, el);
    if (Array.isArray(c.signatories)) c.signatories = [...c.signatories]; // [FIX 9]
    save(c);
    contractIds.push(c.identifier);
    for (const k of Object.keys(el)) if (CONTRACT_ISSUES.includes(k.toLowerCase())) ids(el[k]).forEach(d => contractOf.set(d, c.identifier));
    (c.parties || []).forEach(p => handleParty(p, c.identifier, c.identifier));
  }
  if (!contractIds.length) throw new MCOInputError("No mco-core:Contract found in the document");
  for (const el of Object.values(graph)) {
    const cd = classDataOf(el);
    if (cd && cd[0] === "MCODeonticExpression") handleDeontic(el["@id"], "(document)");
  }

  /* reference: formatIntoMediaContractualObjects */
  const contracts = [];
  for (const cid of contractIds) {
    const c = objs[cid];
    for (const k of Object.keys(c)) {
      if (k === "signatories" || !Array.isArray(c[k]) || !c[k].length) continue; // [FIX 9]
      const m = {};
      c[k].forEach(id => { m[id] = objs[id]; });
      c[k] = m;
    }
    contracts.push(c);
  }
  return { contracts, warnings };
}
