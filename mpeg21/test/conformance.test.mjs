/* ISO/IEC 21000-23 conformance tests for the DMAF MCO library.
   Golden files in fixtures/reference-output were produced by running the
   unmodified reference software on the standard's six template contracts.
   Run: npm run test:mpeg21 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { getContractFromMCO } from "../lib/parser.mjs";
import { toTurtle, toJsonLd } from "../lib/generator.mjs";
import { generateSmartContractSpecification, referenceView } from "../lib/scspec.mjs";
import { loadOpenApi } from "../lib/openapi.mjs";
import { mapCelModel, toCelXml } from "../../server/cel-bridge.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(here, "fixtures");
const read = (...p) => fs.readFileSync(path.join(FX, ...p), "utf8");
const CASES = fs.readdirSync(path.join(FX, "standard", "rdf")).map(f => f.replace(".ttl", ""));
const require = createRequire(import.meta.url);
const referenceParser = require("./reference/mco-parser"); // unmodified reference MCO Parser
const api = loadOpenApi();

/* the two documented extensions, removed for like-for-like comparison */
const withoutExtensions = c => {
  const x = JSON.parse(JSON.stringify(c));
  for (const a of Object.values(x.actions || {})) { delete a.metadata; delete a.currency; }
  return x;
};
const norm = x => Array.isArray(x) ? x.map(norm).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1))
  : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map(k => [k, norm(x[k])])) : x;
const quiet = fn => { const l = console.log; console.log = () => {}; try { return fn(); } finally { console.log = l; } };

for (const name of CASES) {
  const ttl = read("standard", "rdf", name + ".ttl");
  const golden = JSON.parse(read("reference-output", "mco", name + ".mco.json")).contracts[0];

  test(`${name}: parser output is byte-identical to the reference parser (key order included)`, async () => {
    const { contracts } = await getContractFromMCO(ttl);
    assert.equal(contracts.length, 1);
    assert.equal(JSON.stringify(withoutExtensions(contracts[0]), null, 1), JSON.stringify(golden, null, 1));
  });

  test(`${name}: extensions — action labels kept, misspelt hasCurency read as currency`, async () => {
    const c = (await getContractFromMCO(ttl)).contracts[0];
    const consumerPay = Object.values(c.actions).find(a => a.type === "Payment" && a.amount !== undefined && /Consumer/.test(a.actedBy));
    assert.ok(consumerPay.currency, "currency recovered");
    assert.ok(Object.values(c.actions).every(a => a.metadata?.["rdfs:label"]), "every action keeps its rdfs:label");
  });

  test(`${name}: output validates against the OpenAPI Contract schema`, async () => {
    const c = (await getContractFromMCO(ttl)).contracts[0];
    const r = api.validate("Contract", c);
    assert.ok(r.ok, r.errors.join("\n"));
  });

  test(`${name}: Turtle and JSON-LD round trips are lossless`, async () => {
    const a = (await getContractFromMCO(ttl)).contracts[0];
    const b = (await getContractFromMCO(toTurtle(a))).contracts[0];
    const c = (await getContractFromMCO(toJsonLd(a))).contracts[0];
    assert.deepEqual(norm(b), norm(a));
    assert.deepEqual(norm(c), norm(a));
  });

  test(`${name}: the reference parser reads DMAF's Turtle back to the same objects`, async () => {
    const a = (await getContractFromMCO(ttl)).contracts[0];
    const ref = quiet(() => referenceParser.getContractFromMCO(toTurtle(a))).contracts[0];
    // identical, except that the reference now also gets the currency (DMAF writes mco-pane:hasCurrency correctly)
    const noCurrency = JSON.parse(JSON.stringify(ref));
    for (const x of Object.values(noCurrency.actions)) delete x.currency;
    assert.deepEqual(norm(noCurrency), norm(golden));
  });

  test(`${name}: the reference generator's Turtle is not MCO (lower-case IRIs) — documented defect`, () => {
    const refTtl = read("reference-output", "generator-ttl", name + ".ttl");
    assert.match(refTtl, /mco:core:2012#hasparty>/);
    assert.throws(() => quiet(() => referenceParser.getContractFromMCO(refTtl)));
  });

  test(`${name}: smart contract specification is byte-identical to the reference generator`, () => {
    const spec = generateSmartContractSpecification(golden, { keccak256: ethers.id });
    assert.equal(JSON.stringify(referenceView(spec)), JSON.stringify(JSON.parse(read("reference-output", "scspec", name + ".scspec.json"))));
    assert.deepEqual(spec["x-dmaf"].errors, []);
  });

  test(`${name}: the standard's JSON-LD template parses to the same payments and parties`, async () => {
    const j = (await getContractFromMCO(read("standard", "jsonld", name + ".json"))).contracts[0];
    const t = (await getContractFromMCO(ttl)).contracts[0];
    const pays = c => Object.values(c.actions).filter(a => a.type === "Payment")
      .map(a => [a.actedBy, a.beneficiaries[0], a.incomePercentage ?? null, a.amount ?? null, a.currency ?? null].join("|")).sort();
    assert.deepEqual(pays(j), pays(t));
    assert.deepEqual(Object.keys(j.parties).sort(), Object.keys(t.parties).sort());
    assert.equal(Object.keys(j.deontics).length, Object.keys(t.deontics).length);
  });

  test(`${name}: CEL → Media Contractual Objects → CEL keeps every clause`, () => {
    const model = JSON.parse(read("cel-server-parse", name + ".json"));
    const { contract } = mapCelModel(model);
    assert.ok(api.validate("Contract", contract).ok, api.validate("Contract", contract).errors.join("\n"));
    const xml = toCelXml(contract);
    for (const d of Object.values(contract.deontics)) assert.match(xml, new RegExp(`id="${d.identifier}"`));
    for (const p of Object.keys(contract.parties)) assert.match(xml, new RegExp(`<cel-core:Party id="${p}">`));
    assert.equal((xml.match(/<cel-core:Subject /g) || []).length, model.body.operativePart.length);
  });
}

test("parser accepts any prefix names (works on IRIs, not prefix spelling)", async () => {
  const ttl = read("standard", "rdf", "use-case-stream-small-label.ttl")
    .replace(/@prefix mco-core:/, "@prefix core:").replace(/\bmco-core:/g, "core:").replace(/<core:Provide>/g, "core:Provide");
  const a = (await getContractFromMCO(ttl)).contracts[0];
  const b = (await getContractFromMCO(read("standard", "rdf", "use-case-stream-small-label.ttl"))).contracts[0];
  assert.deepEqual(norm(a), norm(b));
});

test("parser reports undescribed references as a 400-style input error", async () => {
  const bad = `@prefix mco-core: <urn:mpeg:mpeg21:mco:core:2012#> . @prefix mvco: <http://purl.oclc.org/NET/mvco.owl#> .
    <http://x/c> a mco-core:Contract ; mco-core:hasParty <http://x/ghost> .`;
  await assert.rejects(getContractFromMCO(bad), e => e.name === "MCOInputError" && /ghost/.test(e.message));
});

test("specification refuses income percentages Contract.sol cannot store", async () => {
  const c = (await getContractFromMCO(read("standard", "rdf", "use-case-stream-small-label.ttl"))).contracts[0];
  c.actions["http://mpeg.org/pay4"].incomePercentage = 42.5;
  const s = generateSmartContractSpecification(c, { keccak256: ethers.id });
  assert.ok(s["x-dmaf"].errors.some(e => /whole percents/.test(e)));
});

test("every operation of the standard's OpenAPI document is routed", () => {
  assert.equal(api.routes.length, 33);
  assert.ok(api.match("POST", "/parser/mco").route);
  assert.ok(api.match("GET", "/contracts/cont-x/deontics/abc/conditions").route);
});
