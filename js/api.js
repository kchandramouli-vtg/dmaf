/* ============================================================
   DMAF API layer — the ONLY file you need to touch to wire the
   interface to your backend.

   MOCK = true  → everything is simulated in-browser (demo mode)
   MOCK = false → calls your media-backend at API_BASE

   Endpoints marked [EXISTS] map to routes already in your
   media-backend. Endpoints marked [NEW] are proposed additions
   for the IMAF/DASH/DLT scope — implement them server-side and
   the UI works unchanged.
   ============================================================ */

const MOCK = true;
const API_BASE = "http://localhost:3000";

/* ---------- tiny fetch helper (real mode) ---------- */
async function http(method, path, body, isForm = false) {
  const headers = {};
  const token = localStorage.getItem("dmaf_token");
  if (token) headers["Authorization"] = "Bearer " + token;
  if (!isForm && body) headers["Content-Type"] = "application/json";
  const res = await fetch(API_BASE + path, {
    method,
    headers,
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || err.message || `${method} ${path} failed (${res.status})`);
  }
  return res.json();
}

/* ---------- mock database (demo mode) ---------- */
const mockDB = {
  user: { firstName: "Krishna", artistName: "KS Audio", email: "krishna@example.com",
          wallet: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" },  // Hardhat test account #1 (PoC producer)
  packages: [],    // My Library now lists the wallet's on-chain assets (js/media.js)
  discover: [],    // Discover lists the registry's on-chain assets (js/media.js)
  contracts: [
    { id: "c1", name: "Reserved rights", blurb: "Listening only. Nobody may sample, remix or redistribute. Authorship and date are still registered on-chain.", terms: [["no","Reuse not allowed"],["","On-chain proof of authorship"]], price: "Free", priceNote: "to register" },
    { id: "c2", name: "Licensed sample", blurb: "Creators may reuse excerpts. The contract measures the exact percentage used and charges proportionally against your base price.", terms: [["ok","Reuse with payment"],["","Royalty ∝ % used"],["","Credit required"]], price: "0.010 ETH", priceNote: "base price" },
    { id: "c3", name: "Remix partnership", blurb: "Full remixes welcome. Small upfront fee plus a 30% ongoing share of revenue the remix earns on the platform.", terms: [["ok","Remixing allowed"],["","0.005 ETH upfront"],["","30% revenue share"]], price: "0.005 ETH", priceNote: "+ 30% of remix" },
    { id: "c4", name: "Open attribution", blurb: "Free for anyone to reuse with credit. Every reuse is still recorded on-chain, so your influence is provable.", terms: [["ok","Free reuse"],["","Credit required"],["","Tracked on-chain"]], price: "Free", priceNote: "credit only" },
  ],
  royalties: {
    balance: "0.142 ETH", month: "0.036 ETH", reuses: 4,
    events: [
      { date: "2026-09-01", what: "Reuse · 22% of Midnight Garden", who: "Nia Flux", amount: "+0.0022 ETH", dir: "in", tx: "0x91ac…44e0" },
      { date: "2026-08-27", what: "Remix revenue share (30%)", who: "beatsmith.eth", amount: "+0.0090 ETH", dir: "in", tx: "0x33b7…9a12" },
      { date: "2026-08-20", what: "Reuse · 8% of Midnight Garden", who: "L. Costa", amount: "+0.0008 ETH", dir: "in", tx: "0x5fd0…1c88" },
      { date: "2026-08-14", what: "You reused 12% of Sofia's Waltz", who: "M. Pinheiro", amount: "−0.0012 ETH", dir: "out", tx: "0xa2c4…7be3" },
    ],
  },
  stems: [
    { name: "Lead vocals",   group: "Vocals",  vol: 80 },
    { name: "Backing vocals",group: "Vocals",  vol: 60 },
    { name: "Guitars",       group: "Rhythm",  vol: 72 },
    { name: "Bass",          group: "Rhythm",  vol: 66 },
    { name: "Drums",         group: "Rhythm",  vol: 75 },
  ],
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const hex = (n) => "0x" + Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");

/* Agreements persist in localStorage in demo mode, so the
   "agree → go away and make music → come back and deliver stems"
   flow survives a page reload. */
const AG_KEY = "dmaf_agreements";
const agStore = {
  all() { try { return JSON.parse(localStorage.getItem(AG_KEY)) || []; } catch { return []; } },
  save(list) { try { localStorage.setItem(AG_KEY, JSON.stringify(list)); } catch {} },
  upsert(a) { const l = agStore.all(); const i = l.findIndex(x => x.id === a.id); if (i >= 0) l[i] = a; else l.unshift(a); agStore.save(l); return a; },
  get(id) { return agStore.all().find(a => a.id === id); },
};

/* A fresh Studio for a fresh chain. Hardhat keeps the chain in memory, so after a restart (./dmaf.sh,
   or npm run chain + npm run deploy) nothing from before is on it — and the Studio clears what it kept
   from then: agreements last saved before the current contracts were deployed, and the stem package
   waiting for Publish. Only when the chain itself is new: redeploying the contracts onto the same
   running chain keeps everything. Agreement reads wait for this check (studioReady). */
const CHAIN_SEEN_KEY = "dmaf_chain_seen";
async function freshStudioForNewChain() {
  const cfg = window.DMAF_CHAIN, rp = window.W3?.readProvider;
  if (!cfg?.deployedAt || !rp) return;
  let seen = null;
  try { seen = JSON.parse(localStorage.getItem(CHAIN_SEEN_KEY) || "null"); } catch { return; }
  if (seen && seen.deployedAt === cfg.deployedAt && seen.address === cfg.address) return;   // same deployment as last time
  let current, restarted = true;                     // first check in this browser: whatever predates the deployment is old
  try {
    current = await rp.getBlock(cfg.deployBlock);
    if (!current) return;                            // the configured contracts aren't on the running chain (yet)
    if (seen?.blockHash) restarted = (await rp.getBlock(seen.deployBlock))?.hash !== seen.blockHash;
  } catch { return; }                                // chain unreachable: check again on the next load
  let cleared = 0;
  if (restarted) {
    const all = agStore.all(), keep = all.filter(a => (a.updatedAt || "") >= cfg.deployedAt);
    cleared = all.length - keep.length;
    if (cleared) agStore.save(keep);
    try { sessionStorage.removeItem("dmaf_pkg"); } catch {}
  }
  try {
    localStorage.setItem(CHAIN_SEEN_KEY, JSON.stringify({ chainId: cfg.chainId, address: cfg.address, deployedAt: cfg.deployedAt,
      deployBlock: cfg.deployBlock, blockHash: current.hash }));
  } catch {}
  if (cleared) {
    console.info(`[DMAF] new chain: cleared ${cleared} Studio agreement(s) from the previous chain`);
    setTimeout(() => window.toast?.(`New chain — the Studio starts fresh (${cleared} agreement${cleared === 1 ? "" : "s"} from the previous chain cleared)`), 800);
  }
}
const studioReady = MOCK ? freshStudioForNewChain().catch(() => {}) : Promise.resolve();

/* ============================================================
   PUBLIC API — call these from app.js
   ============================================================ */
const api = {

  /* ---- auth ------------------------------------------------ */
  // [EXISTS] POST /api/users/register
  async register(payload) {
    if (MOCK) { await wait(400); mockDB.user = { ...mockDB.user, ...payload }; return { ok: true }; }
    return http("POST", "/api/users/register", payload);
  },
  // [EXISTS] POST /api/users/login  → { token, user }
  async login(email, password) {
    if (MOCK) { await wait(400); localStorage.setItem("dmaf_token", "mock"); return { user: mockDB.user }; }
    const r = await http("POST", "/api/users/login", { email, password });
    localStorage.setItem("dmaf_token", r.token);
    return r;
  },
  // [EXISTS] GET /api/users/me
  async me() {
    if (MOCK) return mockDB.user;
    return http("GET", "/api/users/me");
  },

  /* ---- packages (multi-track media assets) ----------------- */
  // [EXISTS] GET /api/tracks/my — single tracks today; treat each as a 1-stem package
  // [NEW]    GET /api/packages — IMAF packages with stems + format info
  async myPackages() {
    if (MOCK) { await wait(250); return mockDB.packages; }
    return http("GET", "/api/packages");
  },
  // [EXISTS] GET /api/tracks/feed?sort=recent
  // [NEW]    GET /api/packages/feed
  async discover() {
    if (MOCK) { await wait(250); return mockDB.discover; }
    return http("GET", "/api/packages/feed");
  },
  // [EXISTS] POST /api/tracks (multipart: file, title, genre, price…) — single file
  // [NEW]    POST /api/packages (multipart: stems[], groups, presets, dashProfiles)
  //          → server muxes stems into an IMAF (.ima) container and
  //            generates DASH renditions, returns { packageId }
  async createPackage(formData) {
    if (MOCK) { await wait(900); return { packageId: "pkg_new" }; }
    return http("POST", "/api/packages", formData, true);
  },

  /* ---- contracts ------------------------------------------- */
  // [NEW] GET /api/contracts — the predefined smart-media-contract templates.
  //       (Today the contract terms are implicit in trackRoutes; serving them
  //        as data lets you add templates without a frontend release.)
  async contracts() {
    if (MOCK) { await wait(150); return mockDB.contracts; }
    return http("GET", "/api/contracts");
  },

  /* ---- agreements (MPEG-21 MCO contracts between parties) --- */
  // [NEW] GET /api/mco/templates — the six use-case templates (JSON-LD, normalised)
  async contractTemplates() {
    if (MOCK) { await wait(120); return window.MCO_TEMPLATES; }
    return http("GET", "/api/mco/templates");
  },
  // [NEW] GET /api/agreements — agreements the signed-in user is a party to
  async agreements() {
    if (MOCK) { await studioReady; await wait(150); return agStore.all(); }
    return http("GET", "/api/agreements");
  },
  // [NEW] GET /api/agreements/:id
  async agreement(id) {
    if (MOCK) { await studioReady; await wait(80); return agStore.get(id); }
    return http("GET", `/api/agreements/${id}`);
  },
  // [NEW] POST /api/agreements  (create) · PUT /api/agreements/:id (update draft)
  //       body: { model, jsonld } → { id, status }
  async saveAgreement(ag) {
    if (MOCK) {
      await wait(250);
      if (!ag.id) ag.id = "ag_" + Date.now().toString(36);
      ag.updatedAt = new Date().toISOString();
      return agStore.upsert(ag);
    }
    return ag.id ? http("PUT", `/api/agreements/${ag.id}`, ag) : http("POST", "/api/agreements", ag);
  },
  // [NEW] POST /api/agreements/:id/sign { partyId } — each party signs with its wallet
  //       (EIP-712 typed-data signature over the contract hash)
  async signAgreement(id, partyId) {
    if (MOCK) {
      await wait(450 + Math.random() * 500);
      const a = agStore.get(id); a.signatures = a.signatures || {};
      a.signatures[partyId] = { sig: hex(16) + "…", at: new Date().toISOString() };
      return agStore.upsert(a);
    }
    return http("POST", `/api/agreements/${id}/sign`, { partyId });
  },
  // [NEW] POST /api/agreements/:id/register — deploys the MCO contract to the DLT engine
  async registerAgreement(id, onStage) {
    onStage?.("pending");
    if (MOCK) {
      await wait(1800);
      const a = agStore.get(id);
      a.status = "active";
      a.chain = { txHash: hex(64), contractAddress: hex(40), network: "Hardhat local · 31337", at: new Date().toISOString() };
      return agStore.upsert(a);
    }
    return http("POST", `/api/agreements/${id}/register`);
  },
  // [NEW] POST /api/agreements/:id/deliverables (multipart: file, deliverableId)
  async deliverStem(id, deliverableId, file) {
    if (MOCK) {
      await wait(200);
      const a = agStore.get(id); a.delivered = a.delivered || {};
      a.delivered[deliverableId] = { name: file.name, size: file.size || 0, at: new Date().toISOString() };
      return agStore.upsert(a);
    }
    const fd = new FormData(); fd.append("deliverableId", deliverableId); fd.append("file", file);
    return http("POST", `/api/agreements/${id}/deliverables`, fd, true);
  },

  /* ---- publishing / DLT ------------------------------------ */
  // [EXISTS] your upload flow already deploys via utils/blockchain*.js
  // [NEW]    POST /api/packages/:id/publish { contractId }
  //          body { contractId, agreementId }
  //          → registers fingerprint + reuse terms on-chain, links the package
  //            to the MCO agreement so revenue splits follow its obligations
  async publish(packageId, contractId, onStage, agreementId) {
    if (MOCK) {
      onStage?.("pending"); await wait(2100);
      return { txHash: "0x7d3cf0a199e24b6d81c55e02b9a4f7e3d8c61a0f4b2e9d7c3a15f8b6e4d2c0a19",
               contractAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
               gasUsed: "412,388", latency: "2.1 s", network: "Hardhat local · 31337" };
    }
    onStage?.("pending");
    return http("POST", `/api/packages/${packageId}/publish`, { contractId, agreementId });
  },

  /* ---- playback / streaming -------------------------------- */
  // [EXISTS] GET /api/tracks/:id/audio (full file via GridFS)
  // [NEW]    GET /api/packages/:id/manifest.mpd  (DASH manifest)
  //          GET /api/packages/:id/stems         (per-stem stream URLs + groups)
  async stems(packageId) {
    if (MOCK) { await wait(200); return mockDB.stems; }
    return http("GET", `/api/packages/${packageId}/stems`);
  },

  /* ---- royalties / payments -------------------------------- */
  // [EXISTS] GET /api/tracks/payments (name may differ in your routes)
  // [NEW]    GET /api/royalties — balance + on-chain event feed
  async royalties() {
    if (MOCK) { await wait(250); return mockDB.royalties; }
    return http("GET", "/api/royalties");
  },
};

window.api = api;
window.DMAF_MOCK = MOCK;
