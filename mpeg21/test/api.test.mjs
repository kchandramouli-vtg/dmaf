/* The ISO/IEC 21000-23 OpenAPI server (server/scm-api.mjs), exercised over
   HTTP. The chain-dependent operation (/dlt/eth/parse) is covered by
   chain/test/Mpeg21Scm.test.js. Run: npm run test:mpeg21 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createScmApi } from "../../server/scm-api.mjs";
import { MemoryStorage } from "../lib/offchain.mjs";
import { mapCelModel, toCelXml } from "../../server/cel-bridge.mjs";

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const TTL = fs.readFileSync(path.join(FX, "standard", "rdf", "use-case-stream-small-label.ttl"), "utf8");
const CEL_XML = fs.readFileSync(path.join(FX, "standard", "cel", "use-case-stream-small-label.xml"), "utf8");
const CEL_MODEL = JSON.parse(fs.readFileSync(path.join(FX, "cel-server-parse", "use-case-stream-small-label.json"), "utf8"));

/* CEL Server stand-in: returns the recorded /parse output of the real (patched) server */
const fakeCel = {
  async parse(xml) { assert.match(xml, /cel-core:Contract/); const { contract, warnings } = mapCelModel(CEL_MODEL); return { contracts: [contract], warnings }; },
  async generate(c) { return toCelXml(c); },
  async status() { return { ok: true }; },
};

let server, base, scm;
before(async () => {
  scm = createScmApi({ storage: new MemoryStorage(), cel: fakeCel, rpcUrl: "http://127.0.0.1:1" });
  server = http.createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    if (p.startsWith("/api")) return scm.handle(req, res, p.slice(4) || "/");
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

const call = async (method, p, body, headers = {}) => {
  const r = await fetch(base + p, { method, body, headers });
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, ct, headers: r.headers, body: /json/.test(ct) ? await r.json() : await r.text() };
};

let cid;
test("POST /parser/mco (Turtle) → arrayOfContracts", async () => {
  const r = await call("POST", "/parser/mco", TTL, { "content-type": "text/plain" });
  assert.equal(r.status, 200);
  assert.equal(r.body.contracts.length, 1);
  assert.equal(r.body.contracts[0].identifier, "http://mpeg.org/contract2");
});

test("POST /parser/mco (JSON-LD) → same contract as Turtle", async () => {
  const a = (await call("POST", "/parser/mco", TTL, { "content-type": "text/plain" })).body.contracts[0];
  const jl = (await call("POST", "/x-dmaf/mco/jsonld", TTL, { "content-type": "text/plain" })).body.jsonld[0];
  const b = (await call("POST", "/parser/mco", JSON.stringify(jl), { "content-type": "application/ld+json" })).body.contracts[0];
  assert.deepEqual(Object.keys(b.deontics).sort(), Object.keys(a.deontics).sort());
  assert.deepEqual(b.actions["http://mpeg.org/pay4"], a.actions["http://mpeg.org/pay4"]);
});

test("POST /parser/mco with a broken document → 400 parserError", async () => {
  const r = await call("POST", "/parser/mco", "@prefix x: <", { "content-type": "text/plain" });
  assert.equal(r.status, 400);
  assert.equal(r.body.errorType, "MCOInputError");
});

test("POST /contracts/ → contractIdref (cont-…); GET /contracts/{id}", async () => {
  const c = (await call("POST", "/parser/mco", TTL, { "content-type": "text/plain" })).body.contracts[0];
  const r = await call("POST", "/contracts/", JSON.stringify(c), { "content-type": "application/json" });
  assert.equal(r.status, 200);
  assert.match(r.body.contractIdref, /^cont-[A-Za-z0-9]{22}$/);
  cid = r.body.contractIdref;
  const g = await call("GET", `/contracts/${cid}`);
  assert.equal(g.body.identifier, c.identifier);
  assert.equal(g.body.idRef, cid);
});

test("POST /contracts/ rejects a body that is not an OpenAPI Contract", async () => {
  const r = await call("POST", "/contracts/", JSON.stringify({ identifier: "x" }), { "content-type": "application/json" });
  assert.equal(r.status, 400);
  assert.equal(r.body.errorType, "ValidationError");
});

test("unknown contract id → 400 {errorType: 'Id not found'} (reference behaviour)", async () => {
  const r = await call("GET", "/contracts/cont-nope");
  assert.equal(r.status, 400);
  assert.equal(r.body.errorType, "Id not found");
});

test("GET /generator/mco/{id} → Turtle; with Accept: application/ld+json → JSON-LD", async () => {
  const t = await call("GET", `/generator/mco/${cid}`);
  assert.match(t.ct, /text\/plain/);
  assert.match(t.body, /mco-core:hasParty/);
  const j = await call("GET", `/generator/mco/${cid}`, undefined, { accept: "application/ld+json" });
  assert.match(j.ct, /ld\+json/);
  assert.ok(j.body["@graph"].length > 20);
});

test("GET /dlt/generate/{id} → smart contract specification", async () => {
  const r = await call("GET", `/dlt/generate/${cid}`);
  assert.equal(r.status, 200);
  assert.equal(Object.keys(r.body.deontics).length, 14);
  assert.deepEqual(r.body.incomePercentage["http://mpeg.org/StreamingService"],
    { "http://mpeg.org/Aggregator": 50, "http://mpeg.org/PerformingRighthsOrganisation": 1, "http://mpeg.org/MechanicalLicenseAgent": 10 });
  assert.match(r.body.hash, /^0x[0-9a-f]{64}$/);
  assert.equal(r.body["x-dmaf"].entry.party, "http://mpeg.org/StreamingService");
});

test("POST /dlt/eth/parse/ with a bad address → 400 invalid Ethereum address", async () => {
  const r = await call("POST", "/dlt/eth/parse/", "not-an-address", { "content-type": "text/plain" });
  assert.equal(r.status, 400);
  assert.equal(r.body.errorType, "invalid Ethereum address");
});

test("POST /dlt/algo/parse/ → 501 (DMAF is Ethereum-only)", async () => {
  const r = await call("POST", "/dlt/algo/parse/", JSON.stringify({ address: "X", appId: 1 }), { "content-type": "application/json" });
  assert.equal(r.status, 501);
});

test("POST /parser/cel → arrayOfContracts; GET /generator/cel/{id} → CEL XML", async () => {
  const r = await call("POST", "/parser/cel", CEL_XML, { "content-type": "application/xml" });
  assert.equal(r.status, 200);
  const c = r.body.contracts[0];
  assert.equal(c.deontics.O3.type, "Obligation");
  const id = (await call("POST", "/contracts/", JSON.stringify(c), { "content-type": "application/json" })).body.contractIdref;
  const x = await call("GET", `/generator/cel/${id}`);
  assert.match(x.ct, /application\/xml/);
  assert.match(x.body, /<cel-pane:Payment incomePercentage="85" amount="2">/);
});

test("sub-resources: parties, otherPersonUsers, deontics, conditions, operativePart, actions, objects, facts", async () => {
  const ids = async p => (await call("GET", `/contracts/${cid}/${p}/`)).body;
  assert.equal((await ids("parties")).length, 8);
  assert.equal((await call("GET", `/contracts/${cid}/parties/${encodeURIComponent("http://mpeg.org/Aggregator")}`)).body.role, "Distributor");
  assert.equal((await ids("deontics")).length, 14);
  assert.equal((await ids("actions")).length, 13);
  assert.deepEqual(await ids("objects"), ["http://mpeg.org/Song"]);
  assert.deepEqual(await ids("facts"), []);
  assert.deepEqual(await ids("otherPersonUsers"), []);
  assert.deepEqual(await ids("operativePart"), []);

  const post = (p, b) => call("POST", `/contracts/${cid}/${p}/`, JSON.stringify(b), { "content-type": "application/json" });
  assert.equal((await post("parties", { identifier: "http://mpeg.org/Label2", role: "Distributor" })).body, "http://mpeg.org/Label2");
  assert.equal((await post("otherPersonUsers", { identifier: "u1", signature: "0x00" })).body, "u1");
  assert.equal((await post("actions", { identifier: "a1", type: "Play" })).body, "a1");
  assert.equal((await post("actions", { identifier: "a2", type: "NotAnAction" })).status, 400);
  assert.match((await post("objects", { name: "x" })).body, /^obje-/);
  assert.equal((await post("facts", { identifier: "f1", type: "SpatialContext", countries: ["ES"] })).body, "f1");
  assert.equal((await post("deontics", { identifier: "d1", type: "Obligation", act: "a1", actedBySubject: "u1" })).body, "d1");
  assert.equal((await post("operativePart", { identifier: "b1", deontics: ["d1"] })).body, "b1");
  assert.equal((await call("POST", `/contracts/${cid}/deontics/d1/conditions/`, JSON.stringify({ identifier: "k1", actionStatus: "ActionDone" }), { "content-type": "application/json" })).body, "k1");
  assert.deepEqual((await call("GET", `/contracts/${cid}/deontics/d1/conditions/`)).body, ["k1"]);
  assert.equal((await call("GET", `/contracts/${cid}/deontics/d1/conditions/k1`)).body.actionStatus, "ActionDone");
  for (const [p, id] of [["otherPersonUsers", "u1"], ["actions", "a1"], ["facts", "f1"], ["deontics", "d1"], ["operativePart", "b1"]])
    assert.equal((await call("GET", `/contracts/${cid}/${p}/${id}`)).body.identifier, id);
});

test("every operationId in the standard's OpenAPI has an implementation", () => {
  const missing = scm.api.routes.filter(r => typeof scm.ops[r.operationId] !== "function").map(r => r.operationId);
  assert.deepEqual(missing, []);
});

test("GET /openapi.yaml serves the standard's document unchanged", async () => {
  const r = await call("GET", "/openapi.yaml");
  assert.equal(r.body, fs.readFileSync(path.join(FX, "..", "..", "openapi", "openapi.yaml"), "utf8"));
});
