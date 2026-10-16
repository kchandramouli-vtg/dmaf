#!/usr/bin/env node
/* ISO/IEC 21000-23 Smart Contracts for Media OpenAPI server on its own
   (the dev server also mounts it at http://localhost:5173/api).

   The standard's OpenAPI lists http://localhost:8080/api as the local server;
   8080 is the IPFS gateway's port, so the default here is 8081.
   Env: SCM_PORT (8081) · RPC_URL · IPFS_API · CEL_URL */
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createScmApi } from "../server/scm-api.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = +(process.env.SCM_PORT || 8081);
const scm = createScmApi({ dataFile: path.join(ROOT, ".data", "scm-contracts.json") });

http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p === "/api" || p.startsWith("/api/")) return scm.handle(req, res, p.slice(4) || "/");
  res.writeHead(404, { "content-type": "text/plain" }); res.end("ISO/IEC 21000-23 API is under /api — spec: /api/openapi.yaml");
}).listen(PORT, "127.0.0.1", () => console.log(`MPEG-21 SCM OpenAPI   http://localhost:${PORT}/api   (${scm.api.routes.length} operations)`));
