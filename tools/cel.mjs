#!/usr/bin/env node
/* Starts the patched MPEG-21 CEL Server (services/cel-server, Python).
   First run: npm run cel:setup (creates services/cel-server/.venv). */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "services", "cel-server");
const venv = path.join(dir, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const py = fs.existsSync(venv) ? venv : (process.platform === "win32" ? "python" : "python3");
if (!fs.existsSync(venv)) console.warn("No services/cel-server/.venv — run `npm run cel:setup` first (using system Python).");
const p = spawn(py, ["main.py"], { cwd: dir, stdio: "inherit", env: { ...process.env, CEL_PORT: process.env.CEL_PORT || "5000" } });
p.on("exit", code => process.exit(code ?? 0));
