#!/usr/bin/env node
/* ============================================================
   DMAF dev server — zero dependencies.

   • Serves the static UI on http://localhost:5173
     (MetaMask injects into http://localhost pages, not file://)
   • Proxies the local IPFS node so the browser needs no CORS setup:
       POST /ipfs-api/<cmd>   → $IPFS_API/api/v0/<cmd>     (Kubo RPC)
       GET  /ipfs/<cid>       → $IPFS_GATEWAY/ipfs/<cid>    (gateway, Range-aware)
   • Serves the ISO/IEC 21000-23 Smart Contracts for Media OpenAPI at /api
       (server/scm-api.mjs — every path of mpeg21/openapi/openapi.yaml).
       It needs the npm packages (npm install); without them the UI, IPFS
       proxy and pay-per-play by direct split still work and /api answers 503.
   • Studio stems → ffmpeg mix MP3 + IMAF package at /studio-api (server/stems.mjs,
       needs ffmpeg on PATH; MP4Box muxes the tracks when installed)
   • Accounts and the IPFS library in PostgreSQL (DATABASE_URL; docs/DATABASE.md):
       /auth-api (server/auth.mjs) and /library-api (server/library.mjs). Every file a
       signed-in user adds through /ipfs-api is recorded for My Library. Without
       DATABASE_URL (or without npm install) sign-in falls back to the demo.
   • Sign-in required: with PostgreSQL on, /studio-api, every /ipfs-api command except
       version, and the writes (POST/PUT/DELETE) of /api need a signed-in session (401
       otherwise), so the Studio and Publish workflows can't be run by calling the APIs
       directly. Discover's reads (/ipfs/ gateway, the chain) stay open. In demo mode the
       server can't tell who is signed in, so only the pages are gated (js/app.js).
   • GET /__status reports whether IPFS, the chain, the database, ffmpeg, MP4Box and the CEL Server are reachable.

   Env: PORT (5173) · IPFS_API (http://127.0.0.1:5001)
        IPFS_GATEWAY (http://127.0.0.1:8080) · RPC_URL (http://127.0.0.1:8545)
        CEL_URL (http://127.0.0.1:5000) · DATABASE_URL (postgres://localhost/dmaf)
        FFMPEG · FFPROBE · MP4BOX (paths) · DMAF_MP4BOX=0 (don't use MP4Box)
   ============================================================ */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStemsApi } from "../server/stems.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = +(process.env.PORT || 5173);
const IPFS_API = process.env.IPFS_API || "http://127.0.0.1:5001";
const IPFS_GATEWAY = process.env.IPFS_GATEWAY || "http://127.0.0.1:8080";
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const missingPkg = e => e.code === "ERR_MODULE_NOT_FOUND"
  ? `missing npm packages (${(String(e.message).match(/'([^']+)'/) || [])[1] || "see npm install"}) — run npm install, then restart npm run serve`
  : e.message;

/* PostgreSQL: accounts, sessions, IPFS library */
let db = { ok: false, error: "not loaded", status: async () => ({ ok: false, error: db.error }) }, auth = null, library = null;
try {
  const [{ createDb }, { createAuth }, { createLibrary }] = await Promise.all([
    import("../server/db.mjs"), import("../server/auth.mjs"), import("../server/library.mjs")]);
  db = await createDb();
  auth = createAuth({ db });
  library = createLibrary({ db, auth, ipfsApi: IPFS_API });
} catch (e) { db.error = missingPkg(e); }
const userOf = async req => (auth ? auth.userFromRequest(req).catch(() => null) : null);
/* Sign-in required (PostgreSQL mode). Answers 401 and returns false when there's no
   session; in demo mode (no database) it lets everything through. */
async function requireSignIn(req, res) {
  if (!auth || !db.ok) return true;
  let user = null;
  try { user = await auth.userFromRequest(req); }
  catch (e) {
    res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ errorType: "ServiceUnavailable", message: `Can't check your session — PostgreSQL: ${e.message}` }));
    return false;
  }
  if (user) { req.dmafUser = user; return true; }
  res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ errorType: "Unauthorized", signIn: true,
    message: "Sign in to DMAF first — you're signed out or your session has ended." }));
  return false;
}
async function recordFor(req, file) {
  const u = await userOf(req);
  if (u) await library.record(u.id, file);
}

const stems = createStemsApi({ root: ROOT, ipfsApi: IPFS_API, onPinned: recordFor });
let scm = null, scmError = null;
try {
  const { createScmApi } = await import("../server/scm-api.mjs");
  scm = createScmApi({ rpcUrl: RPC_URL, ipfsApi: IPFS_API, dataFile: path.join(ROOT, ".data", "scm-contracts.json") });
} catch (e) {
  scmError = missingPkg(e);
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".jsonld": "application/ld+json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".mp3": "audio/mpeg", ".md": "text/markdown; charset=utf-8",
};
const BLOCKED = /^\/(node_modules|chain\/(cache|artifacts)|\.git|\.data|services)(\/|$)/;

function proxy(req, res, target, onBody) {
  const url = new URL(target);
  const headers = { ...req.headers, host: url.host };
  // Kubo rejects browser RPC calls (browser User-Agent / Origin) unless CORS is
  // configured; this hop is server-to-server, so drop the browser headers
  // (and DMAF's own x-dmaf-* hints, which are for the library, not for Kubo).
  for (const h of Object.keys(headers)) if (h === "origin" || h === "referer" || h === "cookie" || h.startsWith("sec-") || h.startsWith("x-dmaf-")) delete headers[h];
  headers["user-agent"] = "dmaf-dev-server";
  const up = http.request(url, { method: req.method, headers }, r => {
    const h = { ...r.headers };
    if (r.statusCode >= 300 && r.statusCode < 400 && h.location) {
      // keep gateway redirects (e.g. to subdomain gateway) inside this server
      try { const loc = new URL(h.location, url); if (loc.pathname.startsWith("/ipfs/")) h.location = loc.pathname + loc.search; } catch {}
    }
    res.writeHead(r.statusCode, h);
    if (onBody && r.statusCode === 200) {
      const chunks = [];
      r.on("data", c => chunks.push(c));
      r.on("end", () => onBody(Buffer.concat(chunks).toString()).catch(e => console.warn("library:", e.message)));
    }
    r.pipe(res);
  });
  up.on("error", e => {
    warnOnce(url.origin, `✕ ${url.origin} unreachable (${e.code || e.message}) — ${url.port === new URL(IPFS_API).port || url.port === new URL(IPFS_GATEWAY).port
      ? "start IPFS Desktop or run `ipfs daemon`" : "is it running?"}`);
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `Can't reach ${url.origin} — is your IPFS node running? (${e.code || e.message})` }));
  });
  req.pipe(up);
}

const warned = new Map();
function warnOnce(key, msg) {                       // at most once a minute per target
  if (Date.now() - (warned.get(key) || 0) < 60_000) return;
  warned.set(key, Date.now()); console.warn(msg);
}
async function ping(fn) {
  try { return await fn(); } catch (e) { return { ok: false, error: e.cause?.code || e.message }; }
}
async function probe() {
  const [ipfs, chain, cel] = await Promise.all([
    ping(async () => {
      const r = await fetch(IPFS_API + "/api/v0/version", { method: "POST", signal: AbortSignal.timeout(2500) });
      const j = await r.json(); return { ok: r.ok, version: j.Version, api: IPFS_API, gateway: IPFS_GATEWAY };
    }),
    ping(async () => {
      const r = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(2500),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      const j = await r.json(); return { ok: !!j.result, chainId: parseInt(j.result, 16), rpc: RPC_URL };
    }),
    ping(async () => {
      const r = await fetch((process.env.CEL_URL || "http://127.0.0.1:5000") + "/health", { signal: AbortSignal.timeout(2500) });
      return { ok: r.ok };
    }),
  ]);
  return { ipfs, chain, cel };
}
/* Kubo's add answer (one JSON line per file) → ipfs_files rows for the signed-in user. */
function recordAdds(user, req) {
  const h = k => { const v = req.headers["x-dmaf-" + k]; return v == null ? undefined : decodeURIComponent(String(v)); };
  return async text => {
    for (const line of text.split("\n")) {
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (!j.Hash) continue;
      await library.record(user.id, { cid: j.Hash, name: h("name") || j.Name, size: h("size") != null ? +h("size") : +j.Size,
        mime: h("mime"), kind: h("kind") || "file", source: h("source") || "publish", agreementId: h("agreement") });
    }
  };
}
async function status(res) {
  const [{ ipfs, chain, cel }, ffmpeg, mp4box, database] = await Promise.all([probe(), stems.status(), stems.mp4boxStatus(), db.status()]);
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ ipfs, chain, cel, ffmpeg, mp4box, db: database, scm: scm ? { ok: true, base: "/api", operations: scm.api.routes.length } : { ok: false, error: scmError } }));
}

function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT + path.sep) || BLOCKED.test(p)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "content-length": st.size, "cache-control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer(async (req, res) => {
  const u = req.url;
  if (u.startsWith("/ipfs-api/")) {
    if (req.method !== "POST") { res.writeHead(405); return res.end(); }
    const cmd = u.slice("/ipfs-api/".length);
    if (!/^version(\?|$)/.test(cmd) && !(await requireSignIn(req, res))) return;
    const user = library && /^add(\?|$)/.test(cmd) ? req.dmafUser || await userOf(req) : null;   // signed in: record the upload for My Library
    return proxy(req, res, IPFS_API + "/api/v0/" + cmd, user ? recordAdds(user, req) : undefined);
  }
  if (u.startsWith("/ipfs/")) return proxy(req, res, IPFS_GATEWAY + u);
  if (u === "/__status") return status(res);
  if (u.startsWith("/studio-api/")) return (await requireSignIn(req, res)) && stems.handle(req, res, new URL(u, "http://x").pathname.slice("/studio-api/".length));
  if (u.startsWith("/auth-api/") || u.startsWith("/library-api/")) {
    const [, prefix, ...rest] = new URL(u, "http://x").pathname.split("/");
    const p = rest.join("/");
    if (prefix === "auth-api" && auth) return auth.handle(req, res, p);
    if (prefix === "library-api" && library) return library.handle(req, res, p);
    if (prefix === "auth-api" && p === "status") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ db: { ok: false, error: db.error }, user: null }));
    }
    res.writeHead(503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ errorType: "ServiceUnavailable", message: `Accounts and My Library's IPFS files need PostgreSQL: ${db.error}` }));
  }
  if (u === "/api" || u.startsWith("/api/") || u.startsWith("/api?")) {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !(await requireSignIn(req, res))) return;   // reads stay open
    if (scm) return scm.handle(req, res, new URL(u, "http://x").pathname.slice(4) || "/");
    res.writeHead(503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ errorType: "ServiceUnavailable", message: `The ISO/IEC 21000-23 API isn't loaded: ${scmError}` }));
  }
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
  serveStatic(req, res);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`DMAF UI        http://localhost:${PORT}`);
  console.log(`IPFS API  ←    ${IPFS_API}   (proxied at /ipfs-api)`);
  console.log(`IPFS gateway ← ${IPFS_GATEWAY} (proxied at /ipfs)`);
  console.log(`Chain RPC      ${RPC_URL}`);
  console.log(scm
    ? `SCM OpenAPI    http://localhost:${PORT}/api  (ISO/IEC 21000-23, ${scm.api.routes.length} operations · spec at /api/openapi.yaml)`
    : `SCM OpenAPI    not loaded — ${scmError}\n               (plays still settle by the registry's direct split)`);
  probe().then(({ ipfs, chain }) => {
    console.log("");
    console.log(chain.ok ? `✓ chain        ${RPC_URL} · chain id ${chain.chainId}` : `✕ chain        ${RPC_URL} unreachable (${chain.error}) — run \`npm run chain\`, then \`npm run deploy\``);
    stems.status().then(f => console.log(f.ok ? `✓ ffmpeg       ${f.version} (Studio stems → mix MP3 + IMAF package)` : `✕ ffmpeg       ${f.error} — the Studio's stem packaging needs it`));
    stems.mp4boxStatus().then(m => console.log(m.ok ? `✓ MP4Box       GPAC ${m.version} (muxes and checks IMAF packages)` : `– MP4Box       ${m.error} — ffmpeg muxes IMAF packages instead (optional: brew install gpac)`));
    db.status().then(d => console.log(d.ok ? `✓ database     PostgreSQL at ${d.url} (accounts + My Library's IPFS files)` : `– database     ${d.error || db.error} — demo sign-in`));
    console.log(ipfs.ok ? `✓ IPFS         Kubo ${ipfs.version} at ${IPFS_API}` : `✕ IPFS         ${IPFS_API} unreachable (${ipfs.error}) — start IPFS Desktop or run \`ipfs daemon\` (publishing and SCM deployment need it)`);
  });
});
