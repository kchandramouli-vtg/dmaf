/* ============================================================
   ISO/IEC 21000-23 Smart Contracts for Media — OpenAPI server

   Every path and operationId comes from mpeg21/openapi/openapi.yaml
   (the standard's OpenAPI, verbatim). Each operation is implemented;
   the reference "MPEG-21 MCO OpenAPI Server" left the CEL operations
   as stubs and tagged the sub-resources "(Not working)".

   Mounted by tools/serve.mjs at /api (same origin as the UI) and run
   on its own by tools/scm-server.mjs.

   DMAF extensions live under /x-dmaf/… and in "x-dmaf" keys; nothing
   in the standard's paths or schemas changes shape.
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ethers } from "ethers";
import { loadOpenApi } from "../mpeg21/lib/openapi.mjs";
import { getContractFromMCO, sniffFormat } from "../mpeg21/lib/parser.mjs";
import { toTurtle, toJsonLd } from "../mpeg21/lib/generator.mjs";
import { generateSmartContractSpecification } from "../mpeg21/lib/scspec.mjs";
import { parseSmartContract } from "../mpeg21/lib/eth.mjs";
import { OffChainStorage } from "../mpeg21/lib/offchain.mjs";
import { CelBridge } from "./cel-bridge.mjs";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const random = n => Array.from(crypto.randomBytes(n), b => ALNUM[b % ALNUM.length]).join("");

class ApiError extends Error {
  constructor(status, errorType, message) { super(message || errorType); this.status = status; this.errorType = errorType; }
}
const notFound = () => new ApiError(400, "Id not found"); // reference: 400 {errorType: "Id not found"}

/* ---------------- contract store (reference: in-memory map) ---------------- */
class ContractStore {
  constructor(file) {
    this.file = file;
    this.m = {};
    if (file) try { this.m = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  }
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.m));
  }
  get(id) { if (this.m[id] === undefined) throw notFound(); return this.m[id]; }
  add(body) {
    const id = "cont-" + random(22); // reference: 'cont-' + Str.random(22)
    body.idRef = id;
    this.m[id] = body;
    this.save();
    return id;
  }
}

/**
 * @param {object} o
 * @param {string} [o.rpcUrl]   Ethereum JSON-RPC for /dlt/eth/parse
 * @param {object} [o.storage]  { publish, retrieve } (default: local IPFS)
 * @param {string} [o.dataFile] where POST /contracts persists (default: none, memory only)
 * @param {string} [o.celUrl]   MPEG-21 CEL Server base URL
 */
export function createScmApi(o = {}) {
  const api = loadOpenApi();
  const store = new ContractStore(o.dataFile);
  const storage = o.storage || new OffChainStorage(o.ipfsApi);
  const rpcUrl = o.rpcUrl || process.env.RPC_URL || "http://127.0.0.1:8545";
  let provider = o.provider || null; // created on first use, so the API starts without a chain
  const getProvider = () => (provider ||= new ethers.JsonRpcProvider(rpcUrl));
  const dropProvider = () => { if (!o.provider && provider) { provider.destroy(); provider = null; } };
  const cel = o.cel || new CelBridge(o.celUrl);

  const requireValid = (schema, body) => {
    const r = api.validate(schema, body);
    if (!r.ok) throw new ApiError(400, "ValidationError", `Body is not a valid ${schema}: ${r.errors.slice(0, 5).join("; ")}`);
  };
  const jsonBody = body => {
    if (body && typeof body === "object") return body;
    try { return JSON.parse(body); } catch { throw new ApiError(400, "SyntaxError", "Body must be JSON"); }
  };

  /* generic map sub-resource: /contracts/{id}/<field>/ */
  const sub = (field, schema, prefix) => ({
    list: ({ contractIdref }) => ({ json: Object.keys(store.get(contractIdref)[field] || {}) }),
    add: ({ contractIdref }, body) => {
      const c = store.get(contractIdref);
      const b = jsonBody(body);
      requireValid(schema, b);
      const id = b.identifier || b.idRef || `${prefix}-${random(22)}`;
      (c[field] ||= {})[id] = b;
      store.save();
      return { text: id };
    },
    get: (params, idName) => {
      const v = (store.get(params.contractIdref)[field] || {})[params[idName]];
      if (v === undefined) throw notFound();
      return { json: v };
    },
  });
  const parties = sub("parties", "Party", "part"), users = sub("otherPersonUsers", "PersonUser", "user"),
    deontics = sub("deontics", "Deontic", "deon"), actions = sub("actions", "Action", "acti"),
    objects = sub("objects", "Object", "obje"), facts = sub("facts", "Fact", "fact"),
    blocks = sub("operativePart", "CELDeonticStructuredBlock", "dsbl");

  const deonticOf = p => {
    const d = (store.get(p.contractIdref).deontics || {})[p.deonticIdref];
    if (!d) throw notFound();
    return d;
  };

  /* operationId → implementation (params, body, req) → { json | text | xml | status, headers } */
  const ops = {
    /* ---- Parser ---- */
    async getContractFromMCO(_, body, req) {
      const text = typeof body === "string" ? body : JSON.stringify(body);
      if (!text.trim()) throw new ApiError(400, "EmptyBody", "Send the MCO contract as Turtle (text/plain) or JSON-LD (application/ld+json)");
      const fmt = sniffFormat(text, req.headers["content-type"]);
      const { contracts, warnings } = await getContractFromMCO(text, { format: fmt });
      return { json: warnings.length ? { contracts, "x-dmaf": { warnings } } : { contracts } };
    },
    async getContractFromCEL(_, body) {
      const { contracts, warnings } = await cel.parse(String(body || ""));
      return { json: warnings?.length ? { contracts, "x-dmaf": { warnings } } : { contracts } };
    },

    /* ---- Generator ---- */
    async generateMCOContract({ contractIdref }, _, req) {
      const c = store.get(contractIdref);
      if (/ld\+json|application\/json/.test(req.headers.accept || "")) return { ldjson: toJsonLd(c) };
      return { text: toTurtle(c) };
    },
    async generateCELContract({ contractIdref }) {
      return { xml: await cel.generate(store.get(contractIdref)) };
    },

    /* ---- DLT and Smart Contract Manager ---- */
    async generateSmartContract({ contractIdref }) {
      return { json: generateSmartContractSpecification(store.get(contractIdref), { keccak256: ethers.id }) };
    },
    async parseSmartContract(_, body) {
      const r = await parseEth(String(body ?? "").replace(/^"|"$/g, ""));
      return { json: r.contract, headers: { "x-scm-content-hash-verified": String(r.onChain.contentHashVerified), "x-scm-nftoken": r.onChain.nfToken } };
    },
    async parseSmartContractAlgo() {
      throw new ApiError(501, "NotImplemented", "DMAF targets Ethereum; Algorand (TEAL) smart contracts are not supported");
    },

    /* ---- Media Contractual Objects | Contract ---- */
    async setContract(_, body) {
      const b = jsonBody(body);
      requireValid("Contract", b);
      return { json: { contractIdref: store.add(b) } };
    },
    async getContract({ contractIdref }) { return { json: store.get(contractIdref) }; },

    /* ---- sub-resources ---- */
    getParties: p => parties.list(p), setParties: (p, b) => parties.add(p, b), getPartyBy: p => parties.get(p, "partyIdref"),
    getOtherPersonUsers: p => users.list(p), setOtherPersonUsers: (p, b) => users.add(p, b), getOtherPersonUsersBy: p => users.get(p, "personUserIdref"),
    getDeontics: p => deontics.list(p), setDeontics: (p, b) => deontics.add(p, b), getDeonticBy: p => deontics.get(p, "deonticIdref"),
    getActions: p => actions.list(p), setActions: (p, b) => actions.add(p, b), getActionBy: p => actions.get(p, "actionIdref"),
    getObject: p => objects.list(p), setObject: (p, b) => objects.add(p, b), getObjectBy: p => objects.get(p, "objectIdref"),
    getFacts: p => facts.list(p), setFacts: (p, b) => facts.add(p, b), getFactBy: p => facts.get(p, "factIdref"),
    getOperativePart: p => blocks.list(p), setOperativePart: (p, b) => blocks.add(p, b), getDeonticStructuredBlock: p => blocks.get(p, "deonticStructuredBlockIdref"),
    getPrePostConditions(p) {
      const d = deonticOf(p);
      return { json: [...Object.keys(d.preCondition || {}), ...(d.postCondition?.identifier ? [d.postCondition.identifier] : [])] };
    },
    setPrePostConditions(p, body) {
      const d = deonticOf(p);
      const b = jsonBody(body);
      requireValid("CELCondition", b);
      const id = b.identifier || `cond-${random(22)}`;
      (d.preCondition ||= {})[id] = b;
      store.save();
      return { text: id };
    },
    getPrePostCondition(p) {
      const d = deonticOf(p);
      const c = d.preCondition?.[p.conditionIdref] || (d.postCondition?.identifier === p.conditionIdref ? d.postCondition : undefined);
      if (!c) throw notFound();
      return { json: c };
    },
  };

  async function parseEth(address) {
    if (!ethers.isAddress(String(address).trim())) throw new ApiError(400, "invalid Ethereum address", `"${String(address).slice(0, 60)}" is not an Ethereum address`);
    const p = getProvider();
    try {
      await Promise.race([p.getBlockNumber(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000))]);
    } catch {
      dropProvider();
      throw new ApiError(503, "ChainUnavailable", `Can't reach the Ethereum node at ${rpcUrl} — is \`npm run chain\` running?`);
    }
    try {
      return await parseSmartContract({ ethers, provider: p, address, retrieve: cid => storage.retrieve(cid) });
    } catch (e) {
      if (e.name === "InvalidEthereumAddress") throw new ApiError(400, "invalid Ethereum address", e.message);
      if (e.code === "CALL_EXCEPTION" || e.code === "BAD_DATA") throw new ApiError(400, "invalid Ethereum address", `${address} is not an ISO/IEC 21000-23 Smart Contract for Media (${e.shortMessage || e.message})`);
      throw e;
    }
  }

  /* DMAF extensions (not in the standard's OpenAPI) */
  const extensions = {
    "GET /openapi.yaml": async () => ({ yaml: api.text }),
    "POST /x-dmaf/eth/inspect": async (body) => ({ json: await parseEth(String(body ?? "").trim()) }),
    "POST /x-dmaf/mco/jsonld": async (body, req) => { // MCO (any format) → canonical MCO JSON-LD profile
      const text = typeof body === "string" ? body : JSON.stringify(body);
      const { contracts, warnings } = await getContractFromMCO(text, { format: sniffFormat(text, req.headers["content-type"]) });
      return { json: { jsonld: contracts.map(toJsonLd), turtle: contracts.map(toTurtle), warnings } };
    },
    "GET /x-dmaf/status": async () => ({ json: { operations: api.routes.length, implemented: api.routes.filter(r => ops[r.operationId]).length, cel: await cel.status() } }),
    "POST /x-dmaf/cel/deploy": async (body, req, q) => ({ json: await cel.deploy(String(body || ""), q.get("bindings") ? JSON.parse(q.get("bindings")) : undefined) }),
    "POST /x-dmaf/cel/reverse": async (body, req, q) => ({ xml: (await cel.reverse(q.get("contractId") || "", q.get("contract_address") || "")).xml }),
  };

  /** Node http handler for paths relative to the API base. */
  async function handle(req, res, pathname) {
    const send = (status, out = {}) => {
      const h = { "access-control-allow-origin": "*", "cache-control": "no-store", ...(out.headers || {}) };
      if (out.json !== undefined) { h["content-type"] = "application/json"; res.writeHead(status, h); return res.end(JSON.stringify(out.json)); }
      if (out.ldjson !== undefined) { h["content-type"] = "application/ld+json"; res.writeHead(status, h); return res.end(JSON.stringify(out.ldjson, null, 2)); }
      if (out.xml !== undefined) { h["content-type"] = "application/xml"; res.writeHead(status, h); return res.end(out.xml); }
      if (out.yaml !== undefined) { h["content-type"] = "application/yaml"; res.writeHead(status, h); return res.end(out.yaml); }
      h["content-type"] = "text/plain; charset=utf-8"; res.writeHead(status, h); res.end(out.text ?? "");
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, accept" });
      return res.end();
    }
    try {
      const raw = await readBody(req);
      const ext = extensions[`${req.method} ${pathname.replace(/\/$/, "")}`];
      if (ext) return send(200, await ext(raw, req, new URL(req.url, "http://x").searchParams));
      const m = api.match(req.method, pathname);
      if (!m) return send(404, { json: { errorType: "NotFound", message: `No ISO/IEC 21000-23 operation at ${pathname}` } });
      if (m.methodNotAllowed) return send(405, { json: { errorType: "MethodNotAllowed" } });
      const fn = ops[m.route.operationId];
      const out = await fn(m.params, raw, req);
      send(out.status || 200, out);
    } catch (e) {
      if (e instanceof ApiError) return send(e.status, { json: { errorType: e.errorType, ...(e.message !== e.errorType ? { message: e.message } : {}) } });
      if (e.name === "MCOInputError") return send(400, { json: { errorType: e.name, message: e.message } }); // reference: parserError {errorType}
      if (e.name === "CELError") return send(e.status || 400, { json: { errorType: e.name, message: e.message } });
      console.error("[scm-api]", e);
      send(500, { json: { errorType: e.name || "Error", message: e.shortMessage || e.message } });
    }
  }

  return { handle, api, ops, store };
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    if (req.method === "GET" || req.method === "HEAD") return resolve("");
    const chunks = []; let n = 0;
    req.on("data", c => { n += c.length; if (n > limit) { reject(new ApiError(413, "PayloadTooLarge")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
