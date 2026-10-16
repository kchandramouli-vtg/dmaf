/* Live tests against the patched MPEG-21 CEL Server (services/cel-server) and a
   local chain. Skipped unless both are running:
     npm run chain   ·   npm run cel   ·   npm run compile (once)
   Run: npm run test:mpeg21 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CelBridge } from "../../server/cel-bridge.mjs";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "standard", "cel");
const cel = new CelBridge(process.env.CEL_URL || "http://127.0.0.1:5000");
const health = await cel.status();
const skip = !(health.ok && health.chain?.ok) && "CEL Server or chain not running";
const norm = x => Array.isArray(x) ? x.map(norm) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map(k => [k, norm(x[k])])) : x;
const clauses = c => Object.values(c.deontics).map(d => [d.type, d.actedBySubject, c.actions[d.act].type, d.issuer || "",
  c.actions[d.act].incomePercentage ?? "", (c.actions[d.act].beneficiaries || []).join()].join("|")).sort();

for (const f of fs.readdirSync(DIR)) {
  const xml = fs.readFileSync(path.join(DIR, f), "utf8");
  test(`${f}: CEL → Media Contractual Objects → CEL → same objects (live CEL Server)`, { skip }, async () => {
    const a = (await cel.parse(xml)).contracts[0];
    const b = (await cel.parse(await cel.generate(a))).contracts[0];
    assert.deepEqual(norm(b), norm(a));
  });
  test(`${f}: CEL → Ethereum (Cel + MediaToken) → CEL keeps every clause`, { skip }, async () => {
    const a = (await cel.parse(xml)).contracts[0];
    const dep = await cel.deploy(xml);
    assert.match(dep.contract_address, /^0x[0-9a-fA-F]{40}$/);
    const back = (await cel.parse((await cel.reverse(a.identifier, dep.contract_address)).xml)).contracts[0];
    assert.deepEqual(clauses(back), clauses(a));
    assert.deepEqual(Object.keys(back.parties).sort(), Object.keys(a.parties).sort());
    assert.equal(back.metadata["dc:title"], a.metadata["dc:title"]);
  });
}
