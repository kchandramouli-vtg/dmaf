/* ============================================================
   MCO JSON-LD profile used by DMAF.

   A flat @graph with one node per contract element, the standard
   prefixes, and the links the ISO/IEC 21000-23 parser follows:

     contract  mco-core:hasParty  party
     deontic   mco-core:issuedIn  contract ; mvco:issuedBy party ;
               mco-core:permitsAction | obligatesAction | forbidsAction  action
     action    mvco:actedBy party ; mvco:actedOver ipentity ;
               mco-pane:hasBeneficiary / hasIncomePercentage / hasAmount / hasCurrency
               mco-core:hasRecipient (Provide)

   It is RDF-equivalent to the standard's Turtle templates, so the
   same Media Contractual Objects come out of either.

   upgradeLegacyJsonLd() rewrites the older nested shape (the
   standard's JSON-LD templates and earlier DMAF exports) into it.
   Browser-safe: no dependencies.
   ============================================================ */
import { NS } from "./vocab.mjs";

export const MCO_CONTEXT = {
  "mco-core": NS["mco-core"], "mco-ipre": NS["mco-ipre"], "mco-pane": NS["mco-pane"], "mco-rele": NS["mco-rele"],
  mvco: NS.mvco, avco: NS.avco, rdfs: NS.rdfs, xsd: NS.xsd, dmaf: NS.dmaf,
};

/* Legacy action/class spellings → terms the lookup tables know. */
const LEGACY_TYPES = {
  "mvco-ipre:provideMaterial": "mco-core:Provide",
  "mco-ipre:provideMaterial": "mco-core:Provide",
  "mco-ipre:Payment": "mco-pane:Payment",
  "mvco:play": "mco-rele:Play",
  "mvco:adapt": "mco-rele:Adapt",
  "mvco:synchronize": "mvco:synchronise",
};

const isLegacy = doc => doc && typeof doc === "object" && !Array.isArray(doc) &&
  (Array.isArray(doc.issues) || Array.isArray(doc["mco-core:issues"]) || doc["@context"]?.issues !== undefined);

/**
 * Nested template shape → flat profile. Fixes, in order:
 *  - deontic expressions get mco-core:issuedIn (the parser only follows that link)
 *  - repeated @ids for *different* deontics are made unique (RDF would merge them)
 *  - undefined/unknown types (mvco-ipre:provideMaterial, mco-ipre:Payment, mvco:play) → MCO terms
 *  - "actedTo" (not in the @context, so silently dropped) → mco-core:hasRecipient
 *  - "hasCurrency" mapped to the misspelt mco-pane:hasCurency → mco-pane:hasCurrency
 */
export function upgradeLegacyJsonLd(doc) {
  if (!isLegacy(doc)) return doc;
  const ctx = { ...(Array.isArray(doc["@context"]) ? Object.assign({}, ...doc["@context"]) : doc["@context"] || {}) };
  ctx.hasCurrency = { "@id": "mco-pane:hasCurrency", "@type": "xsd:string" };
  ctx.hasRecipient = { "@id": "mco-core:hasRecipient", "@type": "@id" };
  ctx["mco-rele"] ||= NS["mco-rele"];
  delete ctx.issues;
  const graph = new Map();
  const put = n => {
    const id = n["@id"];
    const prev = graph.get(id);
    graph.set(id, prev ? { ...prev, ...n } : n);
  };
  const fixTypes = t => [].concat(t || []).map(x => LEGACY_TYPES[x] || x);
  /* flatten one node: nested objects become {"@id"} references */
  const flat = node => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return node;
    if (!node["@id"]) return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "@type") out["@type"] = fixTypes(v);
      else if (k === "actedTo") out.hasRecipient = [].concat(v).map(ref);
      else if (Array.isArray(v)) out[k] = v.map(x => (x && typeof x === "object" && x["@id"] ? ref(x) : x));
      else if (v && typeof v === "object" && v["@id"]) out[k] = ref(v);
      else out[k] = v;
    }
    put(out);
    return out;
  };
  const ref = x => { if (Object.keys(x).length > 1) flat(x); return { "@id": x["@id"] }; };

  const contractId = doc["@id"];
  const issues = [].concat(doc.issues || doc["mco-core:issues"] || []);
  const seen = new Map();
  const deontics = issues.map(d => {
    let id = d["@id"];
    const sig = JSON.stringify({ ...d, "@id": undefined });
    if (seen.has(id) && seen.get(id) !== sig) { let n = 2; while (seen.has(`${id}-${n}`)) n++; id = `${id}-${n}`; }
    seen.set(id, sig);
    const fixed = { ...d, "@id": id, issuedIn: { "@id": contractId } };
    if (!("issuedIn" in ctx)) ctx.issuedIn = { "@id": "mco-core:issuedIn", "@type": "@id" };
    return fixed;
  });
  const contract = { ...doc };
  delete contract["@context"]; delete contract.issues; delete contract["mco-core:issues"];
  flat(contract);
  deontics.forEach(flat);
  return { "@context": ctx, "@graph": [...graph.values()] };
}

/** Plain IRI-or-compact → JSON-LD node reference. */
export const idRef = id => ({ "@id": id });
