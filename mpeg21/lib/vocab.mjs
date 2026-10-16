/* ============================================================
   MPEG-21 vocabularies used by ISO/IEC 21000-23 (Smart Contracts
   for Media): namespaces, the reference lookup tables (lut.mjs),
   the field models of each Media Contractual Object class, and the
   canonical spelling used when DMAF writes MCO back out.

   Parsing is case-insensitive on compact IRIs, exactly like the
   reference parser. Writing uses the ontology spelling (camelCase
   properties, PascalCase classes, lower-camel MVCO actions as in the
   standard's own templates) — the reference generator wrote
   everything lower-case, which yields IRIs that are not MCO terms.
   ============================================================ */
import LUT from "./lut.mjs";

export { LUT };

export const NS = {
  "mco-core": "urn:mpeg:mpeg21:mco:core:2012#",
  "mco-ipre": "urn:mpeg:mpeg21:mco:ipre:2012#",
  "mco-pane": "urn:mpeg:mpeg21:mco:pane:2015#",
  "mco-rele": "urn:mpeg:mpeg21:mco:rele:2015#",
  mvco: "http://purl.oclc.org/NET/mvco.owl#",
  // AVCO (ISO/IEC 21000-19/AMD1). The reference software uses the prefix but
  // never declares its namespace; a document's own @prefix wins over this.
  avco: "urn:mpeg:mpeg21:avco:2018#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  owl: "http://www.w3.org/2002/07/owl#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
  dc: "http://purl.org/dc/elements/1.1/",
  vcard: "http://www.w3.org/2006/vcard/ns#",
  dmaf: "https://dmaf.io/ns#",
};
export const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
export const XSD = NS.xsd;

/* ---------- canonical spelling ---------- */

/* Property local names, keyed by the lower-case form used in the lookup tables. */
const PROP_CASE = Object.fromEntries([
  "actedBy", "actedOver", "resultsIn", "impliesAlso", "rightGivenBy", "sellsDeontic", "isOnLoan", "hasRecipient",
  "hasBeneficiary", "hasIncomeSource", "hasAmount", "hasCurrency", "hasIncomePercentage", "isAbout", "description",
  "hasParty", "hasGoverningLaw", "hasCourt", "isCourtJurisdictionExclusive", "textVersion", "encryptedContractPart",
  "supersedes", "cancels", "isAmendmentOf", "prevailsOver", "isSignedBy", "isTrue", "hasFact", "hasValidity", "withDelay",
  "makesTrue", "withIPEntity", "partOf", "hasLanguages", "hasMaxLength", "matchesFormatComplianceProfile", "hasAspectRatio",
  "hasAudioFormat", "hasFormat", "hasMaxBitrate", "hasMaxLines", "hasMinBitrate", "hasMinLines", "hasVideoFormat",
  "hasNumberOfRuns", "hasNumberOfRepetitions", "hasServicesAndChannels", "inCountry", "afterDate", "beforeDate",
  "hasSocialTag", "isDigital", "hasRightsOwner", "isMadeUpOf", "resultedFrom", "isAudio", "hasSegment", "hasTrack",
  "interval", "segmentOf", "contains", "onTrack", "start", "end", "duration", "onTimeline", "implements", "issuedIn",
  "obligatesAction", "permitsAction", "forbidsAction", "hasRequired", "issuedBy", "hasPercentage", "isExclusive",
  "hasSublicenseRight", "hasVCard", "address", "signature", "actOnBehalfOf", "belongsTo", "isRightsOwnerOf",
  "hasSignatory", "text", "trackNumber", "label", "issues",
].map(n => [n.toLowerCase(), n]));

/* Class local names whose spelling can't be read off the lookup table. */
const CLASS_NAME_OVERRIDE = {
  "mco-core:deonticexpression": "DeonticExpression",
  "mvco:permission": "Permission",
  "mco-core:textualclause": "TextualClause",
  "mvco:user": "User",
  "vcard:vcard": "VCard",
};

/** "mco-core:hasparty" → "mco-core:hasParty" */
export function canonProp(lc) {
  const [p, l] = lc.split(":");
  return `${p}:${PROP_CASE[l] || l}`;
}

/** "mvco:distributor" → "mvco:Distributor", "mvco:distribute" → "mvco:distribute" */
export function canonClass(lc) {
  if (CLASS_NAME_OVERRIDE[lc]) return lc.split(":")[0] + ":" + CLASS_NAME_OVERRIDE[lc];
  const data = LUT.AllClasses[lc];
  const [p] = lc.split(":");
  let name = data ? data[data.length - 1] : lc.split(":")[1];
  // MVCO action classes are lower-camel in the standard's templates (mvco:distribute, mvco:play)
  if (p === "mvco" && data && data[0] === "Action" && data.length > 1) name = name[0].toLowerCase() + name.slice(1);
  return `${p}:${name}`;
}

/* Class name used in Media Contractual Objects ("Distributor", "Payment", "MCOPermission"...) → lower-case compact IRI */
export const CLASS_IRI_BY_NAME = (() => {
  const m = {};
  for (const [k, v] of Object.entries(LUT.AllClasses)) m[v[v.length - 1]] = k;
  return m;
})();

/* ---------- DMAF additions to the lookup tables ---------- */

/** Extra property spellings accepted on input (all lower-case). */
export const EXTRA_PROPS = {
  Action: {
    // The standard's own templates misspell the property ("hasCurency"), so the
    // reference parser silently drops every currency. Accept both.
    "mco-pane:hascurency": ["currency"],
  },
};

/** Properties that link a contract to its deontic expressions from the contract side. */
export const CONTRACT_ISSUES = ["mco-core:issues"];

/* ---------- field models (reference generators, verbatim) ---------- */

const contract = { identifier: "string", metadata: "map", governingLaw: "string", court: "string", isCourtJurisdictionExclusive: "boolean",
  textVersion: "string", encryptedTextVersion: "string", contractRelations: "map", parties: "array", otherPersonUsers: "array",
  deontics: "array", actions: "array", objects: "array", signatories: "array", facts: "array", textClauses: "array" };
const party = { identifier: "string", metadata: "map", name: "string", details: "map", address: "string", deonticsIssued: "array",
  actionsIsSubject: "array", signature: "string", extra: "map" };
const user = { ...party, role: "string", signature: "string", socialTag: "string", actOnBehalfOf: "array", belongsToCollective: "array", isRightsOwnerOf: "array" };
const organization = { ...party, signatory: "string" };
const deontic = { identifier: "string", type: "string", issuedIn: "string", metadata: "map", textClauses: "array", act: "string",
  actedBySubject: "string", actObjects: "array", resultantObject: "array", constraints: "array", issuer: "string", extra: "map" };
const permission = { ...deontic, percentage: "number", incomePercentage: "number", isExclusive: "boolean", hasSublicenseRight: "boolean" };
const action = { identifier: "string", type: "string", impliesAlso: "array", resultsIn: "array", rightGivenBy: "array", actedBy: "string",
  actedOver: "array", metadata: "map" };
const ipentity = { identifier: "string", type: "string", metadata: "map", socialTag: "string", isDigital: "boolean", rightsOwners: "array",
  isMadeUpOf: "array", resultedFrom: "array", isAudio: "boolean", segments: "array", tracks: "array", interval: "array", extra: "map" };
const fact = { identifier: "string", type: "string", isTrue: "boolean", metadata: "map" };
const restriction = { ...fact, restriction: "string" };

export const MODELS = {
  Contract: contract,
  Party: party, MCOUser: user, Organization: organization,
  MCODeonticExpression: deontic, MCOPermission: permission,
  Action: action,
  Trade: { ...action, sellsDeontic: "string" },
  Provide: { ...action, isOnLoan: "boolean", recipients: "array" },
  Payment: { ...action, beneficiaries: "array", incomeSources: "array", amount: "number", currency: "string", incomePercentage: "number" },
  Notify: { ...action, recipients: "array", isAbout: "array" },
  IPEntity: ipentity, Segment: { ...ipentity, segmentOf: "string", contains: "array", onTrack: "array" },
  Fact: fact,
  FactComposition: { ...fact, compositionType: "string", composedFacts: "array" },
  ActionEventFact: { ...fact, validity: "string", withDelay: "string", status: "string", makesTrue: "array" },
  TogetherWith: { ...fact, withIPEntity: "string" },
  AccessPolicy: restriction, DeliveryModality: restriction, Device: restriction, Means: restriction, ServiceAccessPolicy: restriction,
  UserTimeAccess: { ...restriction, validity: "string" },
  IPEntityContext: { ...fact, partOf: "array" },
  Language: { ...fact, languages: "array" },
  Length: { ...fact, maxLength: "string" },
  MaterialFormat: { ...fact, matchesFormatComplianceProfile: "string", aspectRatio: "string", audioFormat: "string", format: "string",
    maxBitrate: "number", maxLines: "number", minBitrate: "number", minLines: "number", videoFormat: "string" },
  Runs: { ...fact, numberOfRuns: "number", validity: "string", numberOfRepetitions: "number" },
  ServiceChannelContext: { ...fact, servicesAndChannels: "array" },
  SpatialContext: { ...fact, countries: "array" },
  TemporalContext: { ...fact, afterDate: "string", beforeDate: "string" },
  TextClause: { identifier: "string", text: "string", extra: "map", metadata: "map" },
  Service: { identifier: "string", type: "string", metadata: "map" },
  Track: { identifier: "string", trackNumber: "number", extra: "map", metadata: "map" },
  Interval: { identifier: "string", start: "string", end: "string", duration: "string", onTimeline: "string", metadata: "map" },
  Timeline: { identifier: "string", extra: "map", metadata: "map" },
};

/* Fact sub-classes whose third lookup element is stored in a field. */
export const FACT_SUBFIELD = {
  FactComposition: "compositionType", ActionEventFact: "status", AccessPolicy: "restriction", DeliveryModality: "restriction",
  Device: "restriction", Means: "restriction", ServiceAccessPolicy: "restriction", UserTimeAccess: "restriction",
};

/* Which lookup table describes each top-level class. */
export const LUT_FOR = {
  Contract: "Contract", Party: "Party", MCODeonticExpression: "MCODeonticExpression", Action: "Action", IPEntity: "IPEntity",
  Fact: "Fact", TextClause: "TextClause", Service: "Service", Track: "Track", Interval: "Interval", Timeline: "Timeline",
};

/* ---------- writing: field → property, per class ---------- */

/* For every field, the compact (lower-case) property the writer uses when the
   lookup table offers more than one. */
export const WRITE_PREF = {
  MCODeonticExpression: { issuer: "mvco:issuedby" },
  Action: {},
};

/** Field → lower-case compact property for class `lutName`, inverted from the lookup table. */
export function fieldProps(lutName) {
  const out = {};
  for (const [k, [field]] of Object.entries(LUT[lutName])) {
    if (k === "@id") continue;
    if (k.toLowerCase() !== k) continue; // "mco-core:isOnLoan" duplicates are lower-cased below
    (out[field] ||= []).push(k);
  }
  for (const [k, [field]] of Object.entries(LUT[lutName])) if (k !== "@id" && k.toLowerCase() !== k && !out[field]) out[field] = [k.toLowerCase()];
  return out;
}

/* Prefixes the writer declares, in this order. */
export const WRITE_PREFIXES = ["mco-core", "mco-ipre", "mco-pane", "mco-rele", "mvco", "avco", "rdfs", "xsd", "dmaf"];

/** Expand a compact IRI using `prefixes` (falls back to the standard namespaces). */
export function expand(compact, prefixes = NS) {
  const i = compact.indexOf(":");
  if (i < 0) return compact;
  const p = compact.slice(0, i);
  const ns = prefixes[p] ?? NS[p];
  return ns && !compact.startsWith(p + "://") ? ns + compact.slice(i + 1) : compact;
}

/** Compact an absolute IRI with the given prefix map (longest namespace wins). */
export function compactor(prefixes) {
  const entries = Object.entries(prefixes).filter(([, ns]) => typeof ns === "string" && ns).sort((a, b) => b[1].length - a[1].length);
  return iri => {
    for (const [p, ns] of entries) if (iri.startsWith(ns) && iri.length > ns.length) return p + ":" + iri.slice(ns.length);
    return iri;
  };
}
