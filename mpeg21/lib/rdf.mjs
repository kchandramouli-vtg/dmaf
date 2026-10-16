/* ============================================================
   Input layer for the MCO parser (Node only).

   The reference parser only takes Turtle, converts it with
   ttl2jsonld and then matches *prefix names* ("mco-core:hasParty"),
   so a document that uses other prefixes — or any JSON-LD — fails.
   Here every input is first reduced to RDF triples (n3 for Turtle,
   jsonld.js for JSON-LD), then re-compacted with the standard
   prefixes (plus the document's own), producing the same graph
   shape ttl2jsonld gives the reference parser:

     { "<iri>": { "@id": "<iri>", "@type": ["mvco:Distributor", …],
                  "mco-core:hasParty": [ {"@id": …}, … ],
                  "rdfs:label": ["AGGREGATOR"], … } }
   ============================================================ */
import N3 from "n3";
import jsonld from "jsonld";
import { NS, RDF_TYPE, XSD, compactor } from "./vocab.mjs";
import { upgradeLegacyJsonLd } from "./jsonld-profile.mjs";

export class MCOInputError extends Error {
  constructor(message) { super(message); this.name = "MCOInputError"; }
}

const NUMERIC = new Set(["integer", "decimal", "double", "float", "int", "long", "short", "byte", "nonNegativeInteger",
  "positiveInteger", "unsignedInt", "unsignedLong", "negativeInteger", "nonPositiveInteger"].map(t => XSD + t));

/** Detect the serialisation of a text body. */
export function sniffFormat(text, contentType = "") {
  const ct = String(contentType).toLowerCase();
  if (/json/.test(ct)) return "jsonld";
  if (/turtle|n3|trig/.test(ct)) return "turtle";
  return /^\s*[{[]/.test(text) ? "jsonld" : "turtle";
}

/** Turtle or JSON-LD text/object → { triples, prefixes } with absolute IRIs. */
export async function toTriples(input, format) {
  if (typeof input === "object" && input !== null) return fromJsonLd(input);
  const fmt = format || sniffFormat(input);
  if (fmt === "jsonld") {
    let doc;
    try { doc = JSON.parse(input); } catch (e) { throw new MCOInputError("Invalid JSON-LD: " + e.message); }
    return fromJsonLd(doc);
  }
  return fromTurtle(input);
}

function fromTurtle(text) {
  const prefixes = {};
  let quads;
  try {
    quads = new N3.Parser({ format: "text/turtle", baseIRI: "http://mpeg.org/" }).parse(text, null, (p, iri) => { prefixes[p] = iri.value; });
  } catch (e) { throw new MCOInputError("Invalid Turtle: " + e.message); }
  return { prefixes, triples: quads.map(q => ({ s: termOf(q.subject), p: q.predicate.value, o: termOf(q.object) })) };
}

async function fromJsonLd(doc) {
  doc = upgradeLegacyJsonLd(doc);
  const prefixes = {};
  const ctxs = [].concat(doc?.["@context"] || []);
  for (const c of ctxs) if (c && typeof c === "object") for (const [k, v] of Object.entries(c)) if (typeof v === "string" && /[:/#]$/.test(v)) prefixes[k] = v;
  let quads;
  try {
    quads = await jsonld.toRDF(doc, { base: ctxs.find(c => c?.["@base"])?.["@base"] || "http://mpeg.org/",
      documentLoader: url => { throw new MCOInputError(`Remote JSON-LD contexts are not loaded (${url}) — inline the @context`); } });
  } catch (e) { throw e instanceof MCOInputError ? e : new MCOInputError("Invalid JSON-LD: " + (e.details?.cause?.message || e.message)); }
  return { prefixes, triples: quads.map(q => ({ s: termOf(q.subject), p: q.predicate.value, o: termOf(q.object) })) };
}

function termOf(t) {
  if (t.termType === "Literal") return { literal: t.value, datatype: t.datatype?.value, language: t.language || undefined };
  if (t.termType === "BlankNode") return { iri: "_:" + t.value };
  return { iri: t.value };
}

/** Literal → JS value the way ttl2jsonld presents it to the reference parser. */
function literalValue(o) {
  if (o.datatype && NUMERIC.has(o.datatype) && o.literal.trim() !== "" && !isNaN(+o.literal)) return +o.literal;
  if (o.datatype === XSD + "boolean") return o.literal === "true" || o.literal === "1";
  return o.literal;
}

/**
 * Build the compact node graph the parser walks.
 * IRIs written as "<mco-core:Provide>" in a Turtle file (as in the standard's
 * own templates) are already compact and are kept as such.
 */
export function compactGraph({ triples, prefixes }) {
  // Only the standard namespaces are compacted (whatever prefix the document
  // used for them), so metadata keys don't depend on the author's prefixes.
  // The AVCO namespace isn't fixed by the reference software: a document's
  // own avco: binding is honoured.
  const nsMap = { ...NS };
  if (prefixes?.avco) nsMap.avco = prefixes.avco;
  const compact = compactor(nsMap);
  const known = Object.keys(nsMap);
  const cIri = iri => {
    const pre = iri.split(":")[0];
    if (known.includes(pre) && !iri.startsWith(pre + "://")) return iri; // already compact, e.g. <mco-core:Provide>
    return compact(iri);
  };
  const graph = {};
  const node = id => (graph[id] ||= { "@id": id });
  for (const { s, p, o } of triples) {
    const n = node(s.iri);
    if (p === RDF_TYPE) {
      if (o.iri) (n["@type"] ||= []).push(cIri(o.iri));
      continue;
    }
    const key = cIri(p);
    const v = o.iri !== undefined ? { "@id": o.iri } : literalValue(o);
    const arr = (n[key] ||= []);
    if (!arr.some(x => JSON.stringify(x) === JSON.stringify(v))) arr.push(v);
  }
  return graph;
}
