/* ============================================================
   Media Contractual Objects → MCO   (ISO/IEC 21000-23, GET /generator/mco/{id})

   Reverse of parser.mjs. Output is Turtle (the reference format) or
   the flat MCO JSON-LD profile (jsonld-profile.mjs). Browser-safe.

   Differences from the reference "MPEG-21 MCO Generator", tagged
   [GEN n] and listed in mpeg21/CONFORMANCE.md:

    1  Terms are written with the ontology spelling (mco-core:hasParty,
       mvco:Distributor). The reference wrote lower-case IRIs
       (mco-core:hasparty, mvco:distributor) — not MCO terms, and its
       own parser can't read them back.
    2  Standard prefixes (mvco:, mco-core:, …), not rdflib's auto ones.
    3  Numbers and booleans are typed literals (reference: strings "19").
    4  Facts and text clauses are written (reference: dropped).
    5  Deontic → object links are carried by the action (mvco:actedOver),
       not an invented mco-core:actedOver on the deontic.
    6  Parties keep mco-core:Party next to their role class, as in the
       standard's templates.
   ============================================================ */
import { NS, LUT, CLASS_IRI_BY_NAME, canonClass, canonProp, expand, WRITE_PREFIXES, XSD } from "./vocab.mjs";
import { MCO_CONTEXT } from "./jsonld-profile.mjs";

const DEONTIC_ACT = { Obligation: "mco-core:obligatesaction", Prohibition: "mco-core:forbidsaction" };
const DEONTIC_CLASS = { MCOPermission: "mvco:permission", Permission: "mvco:permission", CELPermission: "mvco:permission",
  Obligation: "mco-core:obligation", Prohibition: "mco-core:prohibition", MCODeonticExpression: "mco-core:deonticexpression" };
const PARTY_BASE = "mco-core:party";

/* field → property (lower-case compact) for each object kind */
const P = {
  contract: { governingLaw: "mco-core:hasgoverninglaw", court: "mco-core:hascourt",
    isCourtJurisdictionExclusive: "mco-core:iscourtjurisdictionexclusive", textVersion: "mco-core:textversion",
    encryptedTextVersion: "mco-core:encryptedcontractpart", signatories: "mco-core:issignedby" },
  party: { address: "mco-core:address", signature: "mco-core:signature", socialTag: "mvco:hassocialtag",
    actOnBehalfOf: "mvco:actonbehalfof", belongsToCollective: "mvco:belongsto", isRightsOwnerOf: "mvco:isrightsownerof",
    signatory: "mvco:hassignatory" },
  deontic: { issuedIn: "mco-core:issuedin", issuer: "mvco:issuedby", textClauses: "mco-core:implements", constraints: "mco-core:hasrequired",
    percentage: "mco-ipre:haspercentage", incomePercentage: "mco-ipre:hasincomepercentage", isExclusive: "mco-ipre:isexclusive",
    hasSublicenseRight: "mco-ipre:hassublicenseright" },
  action: { actedBy: "mvco:actedby", actedOver: "mvco:actedover", resultsIn: "mvco:resultsin", impliesAlso: "mvco:impliesalso",
    rightGivenBy: "mvco:rightgivenby", sellsDeontic: "mco-ipre:sellsdeontic", isOnLoan: "mco-core:isonloan",
    beneficiaries: "mco-pane:hasbeneficiary", incomeSources: "mco-pane:hasincomesource", amount: "mco-pane:hasamount",
    currency: "mco-pane:hascurrency", incomePercentage: "mco-pane:hasincomepercentage", isAbout: "mco-pane:isabout" },
  ipentity: { socialTag: "mvco:hassocialtag", isDigital: "avco:isdigital", rightsOwners: "mvco:hasrightsowner", rightsOwner: "mvco:hasrightsowner",
    isMadeUpOf: "mvco:ismadeupof", resultedFrom: "mvco:resultedfrom", isAudio: "avco:isaudio", segments: "avco:hassegment",
    tracks: "avco:hastrack", interval: "avco:interval", intervals: "avco:interval", segmentOf: "avco:segmentof", contains: "avco:contains", onTrack: "avco:ontrack" },
  fact: { isTrue: "mvco:istrue", composedFacts: "mco-core:hasfact", validity: "mco-ipre:hasvalidity", withDelay: "mco-ipre:withdelay",
    makesTrue: "mco-core:makestrue", withIPEntity: "mco-ipre:withipentity", partOf: "mco-ipre:partof", languages: "mco-ipre:haslanguages",
    maxLength: "mco-ipre:hasmaxlength", matchesFormatComplianceProfile: "mco-ipre:matchesformatcomplianceprofile",
    aspectRatio: "mco-ipre:hasaspectratio", audioFormat: "mco-ipre:hasaudioformat", format: "mco-ipre:hasformat",
    maxBitrate: "mco-ipre:hasmaxbitrate", maxLines: "mco-ipre:hasmaxlines", minBitrate: "mco-ipre:hasminbitrate",
    minLines: "mco-ipre:hasminlines", videoFormat: "mco-ipre:hasvideoformat", numberOfRuns: "mco-ipre:hasnumberofruns",
    numberOfRepetitions: "mco-ipre:hasnumberofrepetitions", servicesAndChannels: "mco-ipre:hasservicesandchannels",
    countries: "mco-ipre:incountry", afterDate: "mco-ipre:afterdate", beforeDate: "mco-ipre:beforedate" },
  textClause: { text: "mco-core:text" },
  track: { trackNumber: "avco:tracknumber" },
  interval: { start: "avco:start", end: "avco:end", duration: "avco:duration", onTimeline: "avco:ontimeline" },
};
const REF_FIELDS = new Set(["parties", "signatories", "actOnBehalfOf", "belongsToCollective", "isRightsOwnerOf", "signatory",
  "issuedIn", "issuer", "textClauses", "constraints", "actedBy", "actedOver", "resultsIn", "impliesAlso", "rightGivenBy",
  "sellsDeontic", "beneficiaries", "incomeSources", "isAbout", "recipients", "rightsOwners", "rightsOwner", "isMadeUpOf",
  "resultedFrom", "segments", "tracks", "interval", "intervals", "segmentOf", "contains", "onTrack", "composedFacts",
  "makesTrue", "withIPEntity", "partOf", "onTimeline"]);
const RELATION = { supersedes: "mco-core:supersedes", cancels: "mco-core:cancels", isAmendmentOf: "mco-core:isamendmentof", prevailsOver: "mco-core:prevailsover" };

/** class name of a Media Contractual Object → canonical compact class IRI */
function classIri(o, kind) {
  const name = kind === "deontic" ? (o.type || o.class) : (o.class || o.type);
  if (kind === "deontic") return canonClass(DEONTIC_CLASS[name] || "mco-core:deonticexpression");
  let lc = CLASS_IRI_BY_NAME[name];
  if (!lc) {
    if (kind === "party") lc = name === "Organization" ? "mco-core:organization" : PARTY_BASE;
    else if (kind === "action") lc = "mvco:action";
    else if (kind === "ipentity") lc = "mvco:ipentity";
    else if (kind === "fact") lc = "mvco:fact";
    else if (kind === "service") lc = "mco-core:service";
    else throw new Error(`Unknown class "${name}"`);
  }
  return canonClass(lc);
}

const kindOf = (field, o) => {
  if (field === "objects") {
    const top = LUT.AllClasses[CLASS_IRI_BY_NAME[o.class] || ""]?.[0];
    return { Service: "service", Track: "track", Interval: "interval", Timeline: "timeline" }[top] || "ipentity";
  }
  return { parties: "party", otherPersonUsers: "party", deontics: "deontic", actions: "action", facts: "fact", textClauses: "textClause" }[field];
};

/**
 * Media Contractual Objects (one contract) → RDF graph as a list of nodes
 * { "@id", "@type": [compact], props: { compactProp: [values] } }.
 */
export function contractToNodes(contract) {
  const nodes = new Map();
  const node = (id, types = []) => {
    if (!nodes.has(id)) nodes.set(id, { "@id": id, "@type": [], props: {} });
    const n = nodes.get(id);
    for (const t of types) if (!n["@type"].includes(t)) n["@type"].push(t);
    return n;
  };
  const add = (n, lcProp, values, isRef) => {
    const key = lcProp.includes(":") && !/^[a-z][a-z0-9+.-]*:\/\//i.test(lcProp) ? canonProp(lcProp.toLowerCase()) : lcProp;
    for (const v of [].concat(values ?? [])) {
      if (v === undefined || v === null || v === "") continue;
      const val = isRef ? { "@id": v } : v;
      const arr = (n.props[key] ||= []);
      if (!arr.some(x => JSON.stringify(x) === JSON.stringify(val))) arr.push(val);
    }
  };
  const meta = (n, m) => {
    for (const [k, v] of Object.entries(m || {})) {
      if (v === undefined || v === null) continue;
      const arr = (n.props[k] ||= []); // compact (rdfs:label, dmaf:wallet) or absolute IRI
      for (const s of String(v).split("\n")) if (!arr.includes(s)) arr.push(s);
    }
  };
  const fields = (n, o, map) => {
    for (const [f, lc] of Object.entries(map)) if (o[f] !== undefined) add(n, lc, o[f], REF_FIELDS.has(f));
  };

  const c = contract;
  const cn = node(c.identifier, [canonClass("mco-core:contract")]);
  meta(cn, c.metadata);
  fields(cn, c, P.contract);
  add(cn, "mco-core:hasparty", Object.keys(c.parties || {}), true);
  for (const [other, rel] of Object.entries(c.contractRelations || {})) if (RELATION[rel]) add(cn, RELATION[rel], other, true);

  const actionsById = c.actions || {};
  const write = (field, o) => {
    const kind = kindOf(field, o);
    switch (kind) {
      case "party": {
        const n = node(o.identifier, [classIri(o, "party")]);
        if (n["@type"][0] !== canonClass(PARTY_BASE) && o.class !== "Organization") node(o.identifier, [canonClass(PARTY_BASE)]); // [GEN 6]
        meta(n, o.metadata);
        fields(n, o, P.party);
        meta(n, o.details);
        return;
      }
      case "deontic": {
        const n = node(o.identifier, [classIri(o, "deontic")]);
        meta(n, o.metadata);
        fields(n, o, P.deontic);
        if (!o.issuedIn) add(n, "mco-core:issuedin", c.identifier, true);
        if (o.act) add(n, DEONTIC_ACT[o.type] || "mco-core:permitsaction", o.act, true);
        // actedBySubject / actObjects / resultantObject are derived from the action; carry them there if missing [GEN 5]
        const a = actionsById[o.act];
        if (a) {
          const an = node(a.identifier);
          if (!a.actedBy && o.actedBySubject) add(an, "mvco:actedby", o.actedBySubject, true);
          if (!(a.actedOver || []).length && (o.actObjects || []).length) add(an, "mvco:actedover", o.actObjects, true);
          if (!(a.resultsIn || []).length && (o.resultantObject || []).length) add(an, "mvco:resultsin", o.resultantObject, true);
        }
        return;
      }
      case "action": {
        const n = node(o.identifier, [classIri(o, "action")]);
        meta(n, o.metadata);
        fields(n, o, P.action);
        if (o.recipients) add(n, o.type === "Notify" ? "mco-pane:hasrecipient" : "mco-core:hasrecipient", o.recipients, true);
        return;
      }
      case "fact": { // [GEN 4]
        const n = node(o.identifier, [classIri(o, "fact")]);
        meta(n, o.metadata);
        fields(n, o, P.fact);
        return;
      }
      case "textClause": {
        const n = node(o.identifier, [canonClass("mco-core:textualclause")]);
        meta(n, o.metadata);
        fields(n, o, P.textClause);
        return;
      }
      case "service": { const n = node(o.identifier, [classIri(o, "service")]); meta(n, o.metadata); return; }
      case "track": { const n = node(o.identifier, [canonClass("avco:track")]); meta(n, o.metadata); fields(n, o, P.track); return; }
      case "interval": {
        const n = node(o.identifier, [canonClass("avco:interval")]);
        meta(n, o.metadata);
        const tl = o.onTimeline && /^\s*\{/.test(o.onTimeline) ? JSON.parse(o.onTimeline) : null;
        fields(n, { ...o, onTimeline: tl ? tl.identifier : o.onTimeline }, P.interval);
        if (tl) node(tl.identifier, [canonClass("avco:timeline")]);
        return;
      }
      default: { // ipentity
        const n = node(o.identifier, [classIri(o, "ipentity")]);
        meta(n, o.metadata);
        fields(n, o, P.ipentity);
      }
    }
  };
  for (const field of ["parties", "otherPersonUsers", "deontics", "actions", "objects", "facts", "textClauses"]) {
    for (const o of Object.values(c[field] || {})) if (o && typeof o === "object") write(field, o);
  }
  return [...nodes.values()];
}

/* ---------------- serialisers ---------------- */

const literalTurtle = v => {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : `"${v}"^^xsd:decimal`;
  if (typeof v === "boolean") return String(v);
  return JSON.stringify(String(v));
};
const termTurtle = (t, prefixes) => {
  const iri = expand(t, prefixes);
  for (const p of WRITE_PREFIXES) {
    const ns = prefixes[p];
    if (iri.startsWith(ns)) { const local = iri.slice(ns.length); if (/^[A-Za-z_][\w-]*$/.test(local)) return `${p}:${local}`; }
  }
  return `<${iri}>`;
};

/** Media Contractual Objects → Turtle */
export function toTurtle(contract) {
  const prefixes = { ...NS };
  const nodes = contractToNodes(contract);
  const lines = WRITE_PREFIXES.map(p => `@prefix ${p}: <${prefixes[p]}> .`);
  for (const n of nodes) {
    const po = [];
    if (n["@type"].length) po.push(`a ${n["@type"].map(t => termTurtle(t, prefixes)).join(" , ")}`);
    for (const [k, vals] of Object.entries(n.props)) {
      po.push(`${termTurtle(k, prefixes)} ${vals.map(v => (v && typeof v === "object" ? `<${v["@id"]}>` : literalTurtle(v))).join(" , ")}`);
    }
    if (!po.length) continue;
    lines.push("", `<${n["@id"]}>\n        ${po.join(" ;\n        ")} .`);
  }
  return lines.join("\n") + "\n";
}

/** Media Contractual Objects → flat MCO JSON-LD (jsonld-profile.mjs) */
export function toJsonLd(contract) {
  const graph = contractToNodes(contract).map(n => {
    const out = { "@id": n["@id"] };
    if (n["@type"].length) out["@type"] = n["@type"].length === 1 ? n["@type"][0] : n["@type"];
    for (const [k, vals] of Object.entries(n.props)) {
      const conv = vals.map(v => {
        if (v && typeof v === "object") return v;
        if (typeof v === "number") return { "@value": v, "@type": Number.isInteger(v) ? "xsd:integer" : "xsd:decimal" };
        return v;
      });
      out[k] = conv.length === 1 ? conv[0] : conv;
    }
    return out;
  }).filter(n => Object.keys(n).length > 1);
  return { "@context": MCO_CONTEXT, "@graph": graph };
}

/** Reference API: getMCOFromContract(contract) → Turtle string. */
export async function getMCOFromContract(contract, { format = "turtle" } = {}) {
  return format === "jsonld" ? toJsonLd(contract) : toTurtle(contract);
}

export { XSD };
