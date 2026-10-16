/* ============================================================
   The ISO/IEC 21000-23 OpenAPI document (mpeg21/openapi/openapi.yaml,
   copied verbatim from the standard) as a router table and a JSON
   Schema validator for its component schemas. Node only.
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import Ajv from "ajv";

export const OPENAPI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "openapi", "openapi.yaml");

export function loadOpenApi(file = OPENAPI_PATH) {
  const text = fs.readFileSync(file, "utf8");
  const doc = yaml.load(text);

  /* routes: "/contracts/{contractIdref}/parties/" → regex; trailing slash optional */
  const routes = [];
  for (const [p, ops] of Object.entries(doc.paths)) {
    const names = [];
    const rx = p.replace(/\/$/, "").replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{(\w+)\}/g, (_, n) => { names.push(n); return "([^/]+)"; });
    for (const [method, op] of Object.entries(ops)) {
      routes.push({ method: method.toUpperCase(), path: p, re: new RegExp("^" + rx + "/?$"), params: names, operationId: op.operationId, op });
    }
  }

  /* OpenAPI 3.0 schema → JSON Schema for Ajv */
  const strip = s => {
    if (Array.isArray(s)) return s.map(strip);
    if (!s || typeof s !== "object") return s;
    const out = {};
    for (const [k, v] of Object.entries(s)) {
      if (k === "discriminator" || k === "example" || k === "examples" || k.startsWith("x-")) continue;
      out[k] = strip(v);
    }
    return out;
  };
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  ajv.addSchema({ $id: "openapi", components: { schemas: strip(doc.components.schemas) } });
  const cache = {};
  const validate = (schemaName, data) => {
    const v = (cache[schemaName] ||= ajv.compile({ $ref: `openapi#/components/schemas/${schemaName}` }));
    const ok = v(data);
    return { ok, errors: ok ? [] : v.errors.map(e => `${e.instancePath || "/"} ${e.message}${e.params?.allowedValues ? " (" + e.params.allowedValues.join(", ") + ")" : ""}`) };
  };

  const match = (method, pathname) => {
    let pathMatched = false;
    for (const r of routes) {
      const m = pathname.match(r.re);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = Object.fromEntries(r.params.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      return { route: r, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  };

  return { doc, text, routes, validate, match };
}
