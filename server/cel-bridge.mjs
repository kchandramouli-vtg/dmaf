/* ============================================================
   CEL ↔ Media Contractual Objects, through the MPEG-21 CEL Server.

   POST /parser/cel      CEL XML → CEL Server /parse → mapCelModel() → Contract
   GET  /generator/cel   Contract → toCelXml() (the reference has no
                          MCO → CEL generator; this one writes the same
                          element structure the CEL Server parses)

   The mapping follows the OpenAPI schemas: CEL parties become CELPerson
   / Organization parties, clauses become CELPermission / Obligation /
   Prohibition / StatementSimple deontics (CELDeonticStructuredClause),
   their acts become Actions, items become Items, constraints Facts.
   ============================================================ */

export class CelError extends Error {
  constructor(message, status = 400) { super(message); this.name = "CELError"; this.status = status; }
}

const CLAUSE_TYPE = { Statement: "StatementSimple", Permission: "CELPermission", Obligation: "Obligation", Prohibition: "Prohibition" };
const CLAUSE_ELEMENT = { StatementSimple: "cel-core:Statement", CELPermission: "cel-ipre:Permission", MCOPermission: "cel-ipre:Permission",
  Permission: "cel-ipre:Permission", Obligation: "cel-core:Obligation", Prohibition: "cel-core:Prohibition", MCODeonticExpression: "cel-core:Statement" };
const camel = s => String(s || "").split(/\s+/).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w[0].toUpperCase() + w.slice(1))).join("");

/** CEL Server /parse JSON → one Media Contractual Objects contract */
export function mapCelModel(m) {
  const warnings = [];
  const cid = m.contractId || "cel-contract";
  const c = { class: "Contract", identifier: cid, metadata: {}, parties: {}, deontics: {}, actions: {}, objects: {}, facts: {} };
  const info = m.metadata?.information || "";
  for (const [, k, v] of info.matchAll(/<dc:(\w+)>([\s\S]*?)<\/dc:\1>/g)) c.metadata["dc:" + k] = v.trim();
  const tv = String(m.textVersion || "").trim();
  if (tv) c.textVersion = tv;
  for (const r of m.contractsRelated || []) (c.contractRelations ||= {})[r.contractIdref] = r.type;

  for (const p of m.party || []) {
    const org = p.part && "signatory" in p.part && Object.keys(p.part.signatory || {}).length;
    const party = { class: org ? "Organization" : "CELPerson", identifier: p.id, name: p.part?.name };
    if (p.part?.details) party.details = { "cel-core:Details": p.part.details };
    const meta = {};
    if (p.part?.identifier) meta["dc:identifier"] = p.part.identifier;
    if (p.part?.description) meta["dc:description"] = p.part.description;
    if (Object.keys(meta).length) party.metadata = meta;
    if (p.address) party.address = p.address;
    if (p.signature) party.signature = p.signature;
    if (org) {
      const sid = `${p.id}-signatory`;
      (c.otherPersonUsers ||= {})[sid] = { class: "CELPerson", identifier: sid, name: p.part.signatory.name };
      party.signatory = sid;
    }
    c.parties[p.id] = party;
  }
  const party = id => {
    if (!id) return undefined;
    if (!c.parties[id]) { warnings.push(`Clause refers to party "${id}", which is not declared`); c.parties[id] = { class: "CELPerson", identifier: id }; }
    return c.parties[id];
  };

  const clauses = m.body?.operativePart || [];
  const types = m.body?.type || [];
  clauses.forEach((cl, i) => {
    const type = CLAUSE_TYPE[types[i]] || "StatementSimple";
    const id = cl.id || `clause${i + 1}`;
    const d = { class: type, type, identifier: id };
    if (cl.number) d.number = cl.number;
    /* act */
    const a = cl.act || {};
    const actId = `${id}-act`;
    let act;
    if (a.payment && typeof a.payment === "object") {
      act = { class: "Payment", type: "Payment", identifier: actId, beneficiaries: a.payment.beneficiary ? [a.payment.beneficiary] : [] };
      if (a.payment.amount !== "" && a.payment.amount !== undefined) act.amount = Number(a.payment.amount);
      if (a.payment.incomePercentage !== "" && a.payment.incomePercentage !== undefined) act.incomePercentage = Number(a.payment.incomePercentage);
      if (a.payment.currency) act.currency = a.payment.currency;
      if (a.payment.incomeSource) act.incomeSources = [a.payment.incomeSource];
      act.beneficiaries.forEach(party);
    } else if ((a.provide || []).length) {
      act = { class: "Provide", type: "Provide", identifier: actId, recipients: a.provide.filter(x => x !== "true" && x !== "false") };
      act.recipients.forEach(party);
    } else if (a.relr) {
      act = { class: camel(a.relr), type: camel(a.relr), identifier: actId };
    } else if (a.action) {
      const t = a.action[0].toUpperCase() + a.action.slice(1);
      act = { class: t, type: t, identifier: actId };
    } else {
      act = { class: "Action", type: "Simple", identifier: actId };
    }
    if (cl.subject_partyRef) { act.actedBy = cl.subject_partyRef; d.actedBySubject = cl.subject_partyRef; party(cl.subject_partyRef); (c.parties[cl.subject_partyRef].actionsIsSubject ||= []).push(actId); }
    else warnings.push(`Clause ${id} has no Subject`);
    c.actions[actId] = act;
    d.act = actId;
    /* objects */
    for (const o of cl.object || []) {
      const it = o.item || o.event;
      if (!it || !it.name) continue;
      const oid = it.Identifier || it.name;
      c.objects[oid] ||= { class: o.event?.name ? "Event" : "Item", identifier: oid, name: it.name, ...(it.RelatedIdentifier ? { relatedIdentifiers: [it.RelatedIdentifier] } : {}) };
      (d.actObjects ||= []).includes(oid) || d.actObjects.push(oid);
      (act.actedOver ||= []).includes(oid) || act.actedOver.push(oid);
    }
    /* constraints → facts */
    const k = cl.constraint || {};
    const fact = (suffix, f) => { const fid = `${id}-${suffix}`; c.facts[fid] = { identifier: fid, ...f }; (d.constraints ||= []).push(fid); };
    if (k.deliveryModality) { const r = k.deliveryModality.split("#").pop(); fact("deliveryModality", { class: r, type: "DeliveryModality", restriction: r }); }
    if (k.accessPolicy) { const r = k.accessPolicy.split("#").pop(); fact("accessPolicy", { class: r, type: "AccessPolicy", restriction: r }); }
    if (k.runs) fact("runs", { class: "Runs", type: "Runs", numberOfRuns: Number(k.runs) });
    if (k.language) fact("language", { class: "Language", type: "Language", languages: [k.language] });
    if (k.beforeDate || k.afterDate) fact("temporal", { class: "TemporalContext", type: "TemporalContext", ...(k.afterDate ? { afterDate: k.afterDate } : {}), ...(k.beforeDate ? { beforeDate: k.beforeDate } : {}) });
    if (k.spatialLocation && Object.keys(k.spatialLocation).length) fact("spatial", { class: "SpatialContext", type: "SpatialContext", countries: [].concat(Object.values(k.spatialLocation)).flat().map(String) });
    [].concat(k.means || []).forEach((t, j) => { const r = String(t).split("#").pop(); fact(`means${j + 1}`, { class: r, type: "Means", restriction: r }); });
    if (k.isExclusive && type === "CELPermission") d.isExclusive = k.isExclusive === "true";
    if (cl.issuer) { d.issuer = cl.issuer; party(cl.issuer); (c.parties[cl.issuer].deonticsIssued ||= []).push(id); }
    d.issuedIn = cid;
    c.deontics[id] = d;
  });
  for (const k of ["objects", "facts"]) if (!Object.keys(c[k]).length) delete c[k];
  return { contract: c, warnings };
}

/* ---------------- MCO → CEL XML ---------------- */
const esc = s => String(s ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[ch]));
const local = iri => String(iri || "").split(/[/#]/).filter(Boolean).pop() || String(iri);
const ncname = iri => local(iri).replace(/[^\w.-]/g, "_").replace(/^([^A-Za-z_])/, "_$1");

const NS_DECL = `xmlns:cel-core="urn:mpeg:mpeg21:cel:core:2015" xmlns:cel-ipre="urn:mpeg:mpeg21:cel:ipre:2015" xmlns:cel-pane="urn:mpeg:mpeg21:cel:pane:2015" xmlns:cel-rele="urn:mpeg:mpeg21:cel:rele:2015" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:dii="urn:mpeg:mpeg21:2002:01-DII-NS" xmlns:dsig="http://www.w3.org/2000/09/xmldsig#" xmlns:rel-r="urn:mpeg:mpeg21:2003:01-REL-R-NS" xmlns:rel-mx="urn:mpeg:mpeg21:2003:01-REL-MX-NS"`;

/** Media Contractual Objects contract → CEL XML (ISO/IEC 21000-20) */
export function toCelXml(c) {
  const L = [];
  const pid = id => ncname(id);
  const title = c.metadata?.["dc:title"] || c.metadata?.["rdfs:label"] || local(c.identifier);
  L.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  L.push(`<cel-core:Contract ${NS_DECL} contractId="${esc(c.identifier)}">`);
  L.push(`    <cel-core:TextVersion>${esc(c.textVersion || "")}</cel-core:TextVersion>`);
  L.push(`    <cel-core:Metadata>`, `        <cel-core:SimpleDC>`, `            <dc:title>${esc(title)}</dc:title>`);
  for (const k of ["date", "creator", "identifier", "description"]) if (c.metadata?.["dc:" + k]) L.push(`            <dc:${k}>${esc(c.metadata["dc:" + k])}</dc:${k}>`);
  L.push(`        </cel-core:SimpleDC>`, `    </cel-core:Metadata>`);
  const rel = Object.entries(c.contractRelations || {});
  if (rel.length) {
    L.push(`    <cel-core:ContractsRelated>`);
    for (const [other, type] of rel) L.push(`        <cel-core:ContractRelation type="${esc(type)}" contractIdref="${esc(other)}"/>`);
    L.push(`    </cel-core:ContractsRelated>`);
  }
  for (const p of Object.values(c.parties || {})) {
    const name = p.name || p.metadata?.["dmaf:name"] || p.metadata?.["rdfs:label"] || local(p.identifier);
    const details = p.details?.["cel-core:Details"] || p.metadata?.["rdfs:label"];
    const el = p.class === "Organization" ? "Organization" : "Person";
    L.push(`    <cel-core:Party id="${esc(pid(p.identifier))}">`, `        <cel-core:${el}>`, `            <cel-core:Name>${esc(name)}</cel-core:Name>`);
    if (p.metadata?.["dc:identifier"]) L.push(`            <dc:identifier>${esc(p.metadata["dc:identifier"])}</dc:identifier>`);
    if (details) L.push(`            <cel-core:Details>${esc(details)}</cel-core:Details>`);
    if (el === "Organization" && p.signatory) {
      const s = c.otherPersonUsers?.[p.signatory];
      L.push(`            <cel-core:Signatory>`, `                <cel-core:Name>${esc(s?.name || local(p.signatory))}</cel-core:Name>`, `            </cel-core:Signatory>`);
    }
    L.push(`        </cel-core:${el}>`);
    if (p.address) L.push(`        <cel-core:Address>${esc(p.address)}</cel-core:Address>`);
    L.push(`    </cel-core:Party>`);
  }
  L.push(`    <cel-core:Body>`, `        <cel-core:OperativePart>`);
  for (const d of Object.values(c.deontics || {})) {
    const el = CLAUSE_ELEMENT[d.type] || "cel-core:Statement";
    const a = c.actions?.[d.act] || {};
    const subject = d.actedBySubject || a.actedBy;
    L.push(`            <${el} id="${esc(ncname(d.identifier))}">`);
    if (subject) L.push(`                <cel-core:Subject partyRef="${esc(pid(subject))}"/>`);
    L.push(`                <cel-core:Act>`);
    if (a.type === "Payment") {
      const at = [a.incomePercentage !== undefined ? `incomePercentage="${a.incomePercentage}"` : "", a.amount !== undefined ? `amount="${a.amount}"` : "",
        a.currency ? `currency="${esc(a.currency)}"` : ""].filter(Boolean).join(" ");
      L.push(`                    <cel-pane:Payment${at ? " " + at : ""}>`);
      for (const b of a.beneficiaries || []) L.push(`                        <cel-pane:Beneficiary partyRef="${esc(pid(b))}"/>`);
      for (const s of a.incomeSources || []) L.push(`                        <cel-pane:IncomeSource actRef="${esc(ncname(s))}"/>`);
      L.push(`                    </cel-pane:Payment>`);
    } else if (a.type === "Provide") {
      L.push(`                    <cel-core:Provide${(a.recipients || []).length ? ` recipients="${esc(a.recipients.map(pid).join(" "))}"` : ""}/>`);
    } else if (a.type === "PossessProperty") {
      L.push(`                    <rel-r:possessProperty/>`);
    } else if (a.type === "Play") {
      L.push(`                    <rel-mx:play/>`);
    } else if (a.type && a.type !== "Simple") {
      L.push(`                    <cel-ipre:${esc(a.type)}/>`);
    }
    L.push(`                </cel-core:Act>`);
    for (const oid of d.actObjects || a.actedOver || []) {
      const o = c.objects?.[oid] || {};
      L.push(`                <cel-core:Object>`, `                    <cel-core:Item name="${esc(o.name || o.metadata?.["rdfs:label"] || local(oid))}">`,
        `                        <dii:Identifier>${esc(oid)}</dii:Identifier>`);
      for (const r of o.relatedIdentifiers || []) L.push(`                        <dii:RelatedIdentifier>${esc(r)}</dii:RelatedIdentifier>`);
      L.push(`                    </cel-core:Item>`, `                </cel-core:Object>`);
    }
    const facts = (d.constraints || []).map(f => c.facts?.[f]).filter(Boolean);
    if (facts.length) {
      L.push(`                <cel-core:Constraint>`);
      for (const f of facts) {
        if (f.type === "DeliveryModality") L.push(`                    <cel-ipre:DeliveryModality href="urn:mpeg:mpeg21:cel:ipre:2015/DeliveryModality#${esc(f.restriction)}"/>`);
        else if (f.type === "AccessPolicy") L.push(`                    <cel-ipre:AccessPolicy access="${esc(f.restriction)}"/>`);
        else if (f.type === "Runs") L.push(`                    <cel-ipre:Runs number="${esc(f.numberOfRuns)}"/>`);
        else if (f.type === "Language") L.push(`                    <cel-ipre:Language lang="${esc((f.languages || [])[0])}"/>`);
        else if (f.type === "Means") L.push(`                    <cel-ipre:Means tec="${esc(f.restriction)}"/>`);
      }
      if (d.isExclusive !== undefined) L.push(`                    <cel-ipre:isExclusive value="${d.isExclusive}"/>`);
      L.push(`                </cel-core:Constraint>`);
    }
    if (d.issuer) L.push(`                <cel-core:Issuer partyRef="${esc(pid(d.issuer))}"/>`);
    L.push(`            </${el}>`);
  }
  L.push(`        </cel-core:OperativePart>`, `    </cel-core:Body>`, `</cel-core:Contract>`, "");
  return L.join("\n");
}

/* ---------------- client for the CEL Server ---------------- */
export class CelBridge {
  constructor(url = process.env.CEL_URL || "http://127.0.0.1:5000") { this.url = url.replace(/\/$/, ""); }

  async call(path, init) {
    let r;
    try { r = await fetch(this.url + path, { ...init, signal: AbortSignal.timeout(120000) }); }
    catch (e) { throw new CelError(`Can't reach the MPEG-21 CEL Server at ${this.url} — start it with \`npm run cel\` (${e.cause?.code || e.message})`, 503); }
    const t = await r.text();
    if (!r.ok) { let m = t; try { m = JSON.parse(t).detail || t; } catch {} throw new CelError(`CEL Server: ${m}`, r.status === 503 ? 503 : 400); }
    return JSON.parse(t);
  }
  async parse(xml) {
    if (!xml.trim()) throw new CelError("Send the CEL contract as XML (application/xml)");
    const model = await this.call("/parse", { method: "POST", headers: { "content-type": "text/plain" }, body: xml });
    const { contract, warnings } = mapCelModel(model);
    return { contracts: [contract], warnings, model };
  }
  async generate(contract) { return toCelXml(contract); }
  async deploy(xml, bindings) {
    const q = bindings ? "?bindings=" + encodeURIComponent(JSON.stringify(bindings)) : "";
    return this.call("/deploy" + q, { method: "POST", headers: { "content-type": "text/plain" }, body: xml });
  }
  async reverse(contractId, address) {
    return this.call(`/reverse?contractId=${encodeURIComponent(contractId)}&contract_address=${encodeURIComponent(address)}`, { method: "POST" });
  }
  async status() {
    try { return await this.call("/health"); } catch (e) { return { ok: false, error: e.message }; }
  }
}
