#!/usr/bin/env node
/* Creates services/cel-server/.venv and installs the CEL Server's requirements. */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "services", "cel-server");
const py = process.platform === "win32" ? "python" : "python3";
const pip = path.join(dir, ".venv", process.platform === "win32" ? "Scripts/pip" : "bin/pip");
execFileSync(py, ["-m", "venv", ".venv"], { cwd: dir, stdio: "inherit" });
execFileSync(pip, ["install", "-r", "requirements.txt"], { cwd: dir, stdio: "inherit" });
console.log("CEL Server ready — start it with `npm run cel` (needs `npm run compile` once for the Cel/MediaToken artifacts).");
