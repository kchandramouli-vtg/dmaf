/* Off-chain storage for Smart Contracts for Media: a local IPFS (Kubo) node,
   like the reference OffChainStorage (lib/offChainStorage.js) but pointed at
   your own node instead of scm.linkeddata.es. Node only. */

export class OffChainStorage {
  constructor(api = process.env.IPFS_API || "http://127.0.0.1:5001") { this.api = api.replace(/\/$/, ""); }

  async #fetch(url, init) {
    try { return await fetch(url, init); }
    catch (e) { throw new Error(`Can't reach the IPFS node at ${this.api} — is it running? (${e.cause?.code || e.message})`); }
  }

  async publish(payload) {
    if (typeof payload === "object") payload = JSON.stringify(payload);
    const fd = new FormData();
    fd.append("file", new Blob([payload], { type: "application/json" }), "payload.json");
    const r = await this.#fetch(`${this.api}/api/v0/add?cid-version=1&pin=true`, { method: "POST", body: fd, headers: { "user-agent": "dmaf-scm" } });
    const t = await r.text();
    if (!r.ok) throw new Error(`IPFS add failed (${r.status}): ${t.slice(0, 200)}`);
    return JSON.parse(t.trim().split("\n").pop()).Hash;
  }

  async retrieve(cid) {
    const r = await this.#fetch(`${this.api}/api/v0/cat?arg=${encodeURIComponent(cid)}`, { method: "POST", headers: { "user-agent": "dmaf-scm" } });
    if (!r.ok) throw new Error(`IPFS cat ${cid} failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
    return r.text();
  }
}

/** In-memory stand-in (tests): CIDs are "mem-<sha256>". */
export class MemoryStorage {
  constructor() { this.m = new Map(); }
  async publish(payload) {
    if (typeof payload === "object") payload = JSON.stringify(payload);
    const { createHash } = await import("node:crypto");
    const cid = "mem-" + createHash("sha256").update(payload).digest("hex").slice(0, 46);
    this.m.set(cid, payload);
    return cid;
  }
  async retrieve(cid) {
    if (!this.m.has(cid)) throw new Error("unknown CID " + cid);
    return this.m.get(cid);
  }
}
