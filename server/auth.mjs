/* ============================================================
   Accounts (PostgreSQL) — /auth-api

   Email + password                 Sign in with MetaMask (EIP-4361)
   POST /auth-api/register          GET  /auth-api/nonce
   POST /auth-api/login             POST /auth-api/siwe   { message, signature, link? }
   POST /auth-api/logout                  link=false: sign in (creates a wallet-only account the first time)
   GET  /auth-api/status                  link=true:  link the wallet to the signed-in account
   PATCH /auth-api/me               POST /auth-api/wallet/unlink

   Passwords: scrypt (N=2^15, r=8, p=1, 16-byte salt), compared in constant time.
   Sessions: a random 256-bit token in an HttpOnly, SameSite=Lax cookie; only
   its sha256 is stored (sessions table), 30 days. State-changing requests
   must be same-origin (Origin header) and JSON.
   ============================================================ */
import crypto from "node:crypto";
import { promisify } from "node:util";
import { ethers } from "ethers";

const scrypt = promisify(crypto.scrypt);
const COOKIE = "dmaf_session";
const SESSION_DAYS = 30;
const NONCE_MINUTES = 10;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}
export async function verifyPassword(pw, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || "").split("$");
  if (alg !== "scrypt") return false;
  const want = Buffer.from(hash, "base64");
  const got = await scrypt(pw, Buffer.from(salt, "base64"), want.length, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(want, got);
}
const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** EIP-4361 message → fields (only what DMAF checks). */
export function parseSiwe(message) {
  const lines = String(message || "").split("\n");
  const m = /^(\S+) wants you to sign in with your Ethereum account:$/.exec(lines[0] || "");
  const field = k => (new RegExp(`^${k}: (.+)$`, "m").exec(message) || [])[1];
  return { domain: m?.[1], address: (lines[1] || "").trim(), uri: field("URI"), version: field("Version"),
    chainId: field("Chain ID"), nonce: field("Nonce"), issuedAt: field("Issued At") };
}

export function createAuth({ db }) {
  const failures = new Map();                              // ip|email → [timestamps] (sign-in throttle)
  const throttled = key => {
    const now = Date.now(), list = (failures.get(key) || []).filter(t => now - t < 10 * 60_000);
    failures.set(key, list);
    return list.length >= 8;
  };
  const fail = key => failures.set(key, [...(failures.get(key) || []), Date.now()]);

  const userJson = u => u && ({ id: Number(u.id), email: u.email, firstName: u.first_name, lastName: u.last_name,
    artistName: u.artist_name, wallet: u.wallet ? ethers.getAddress(u.wallet) : null, hasPassword: !!u.password_hash,
    createdAt: u.created_at, lastLoginAt: u.last_login_at });

  function cookieOf(req) {
    const c = String(req.headers.cookie || "").split(/;\s*/).find(x => x.startsWith(COOKIE + "="));
    return c ? decodeURIComponent(c.slice(COOKIE.length + 1)) : null;
  }
  /** The signed-in user for this request, or null. */
  async function userFromRequest(req) {
    if (!db.ok) return null;
    const token = cookieOf(req);
    if (!token) return null;
    const r = await db.query(
      `select u.* from sessions s join users u on u.id = s.user_id where s.token_hash = $1 and s.expires_at > now()`, [sha256(token)]);
    return r.rows[0] || null;
  }
  async function startSession(res, req, userId) {
    const token = crypto.randomBytes(32).toString("base64url");
    await db.query(`insert into sessions (token_hash, user_id, expires_at, user_agent) values ($1, $2, now() + interval '${SESSION_DAYS} days', $3)`,
      [sha256(token), userId, String(req.headers["user-agent"] || "").slice(0, 200)]);
    await db.query("update users set last_login_at = now() where id = $1", [userId]);
    await db.query("delete from sessions where expires_at < now()");
    res.setHeader("set-cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
  }

  const send = (res, status, obj) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...(res._cookie || {}) }); res.end(JSON.stringify(obj)); };
  const err = (status, message) => Object.assign(new Error(message), { status });
  const readJson = req => new Promise((resolve, reject) => {
    if (!/application\/json/.test(req.headers["content-type"] || "")) return reject(err(415, "send JSON"));
    const c = []; let n = 0;
    req.on("data", d => { n += d.length; if (n > 64 * 1024) { req.destroy(); reject(err(413, "body too large")); } else c.push(d); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(c).toString() || "{}")); } catch { reject(err(400, "invalid JSON")); } });
    req.on("error", reject);
  });
  const sameOrigin = req => {
    const o = req.headers.origin;
    if (!o) return true;                                   // same-origin fetch from older browsers / curl
    try { return new URL(o).host === req.headers.host; } catch { return false; }
  };

  async function register(req, res) {
    const b = await readJson(req);
    const email = String(b.email || "").trim(), password = String(b.password || "");
    if (!EMAIL.test(email)) throw err(400, "Enter a valid email address");
    if (password.length < 8) throw err(400, "Use a password of at least 8 characters");
    const exists = await db.query("select 1 from users where lower(email) = lower($1)", [email]);
    if (exists.rowCount) throw err(409, "An account with this email already exists — sign in instead");
    const r = await db.query(
      `insert into users (email, password_hash, first_name, last_name, artist_name) values ($1, $2, $3, $4, $5) returning *`,
      [email, await hashPassword(password), clip(b.firstName), clip(b.lastName), clip(b.artistName)]);
    await startSession(res, req, r.rows[0].id);
    return { user: userJson(r.rows[0]) };
  }
  async function login(req, res) {
    const b = await readJson(req);
    const email = String(b.email || "").trim(), key = `${req.socket.remoteAddress}|${email.toLowerCase()}`;
    if (throttled(key)) throw err(429, "Too many attempts — wait a few minutes and try again");
    const u = (await db.query("select * from users where lower(email) = lower($1)", [email])).rows[0];
    if (!u || !u.password_hash || !(await verifyPassword(String(b.password || ""), u.password_hash))) {
      fail(key); throw err(401, "Email or password is incorrect");
    }
    failures.delete(key);
    await startSession(res, req, u.id);
    return { user: userJson(u) };
  }
  async function logout(req, res) {
    const token = cookieOf(req);
    if (token) await db.query("delete from sessions where token_hash = $1", [sha256(token)]);
    res.setHeader("set-cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return { ok: true };
  }
  async function nonce() {
    const n = crypto.randomBytes(12).toString("hex");
    await db.query("insert into auth_nonces (nonce) values ($1)", [n]);
    await db.query(`delete from auth_nonces where created_at < now() - interval '1 day'`);
    return { nonce: n };
  }
  async function siwe(req, res) {
    const b = await readJson(req);
    const f = parseSiwe(b.message);
    if (f.domain !== req.headers.host) throw err(400, `The message is for ${f.domain || "another site"}, not ${req.headers.host}`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(f.address) || f.version !== "1" || !f.nonce) throw err(400, "Not a valid sign-in message");
    const issued = Date.parse(f.issuedAt || "");
    if (!issued || Math.abs(Date.now() - issued) > NONCE_MINUTES * 60_000) throw err(400, "The sign-in message has expired — try again");
    let signer;
    try { signer = ethers.verifyMessage(b.message, b.signature); } catch { throw err(400, "Invalid signature"); }
    if (signer.toLowerCase() !== f.address.toLowerCase()) throw err(401, "The signature doesn't match the address in the message");
    const used = await db.query(
      `update auth_nonces set used_at = now() where nonce = $1 and used_at is null and created_at > now() - interval '${NONCE_MINUTES} minutes' returning nonce`, [f.nonce]);
    if (!used.rowCount) throw err(400, "This sign-in request was already used or has expired — try again");
    const wallet = f.address.toLowerCase();
    const owner = (await db.query("select * from users where lower(wallet) = $1", [wallet])).rows[0];
    if (b.link) {
      const me = await userFromRequest(req);
      if (!me) throw err(401, "Sign in first, then link your wallet");
      if (owner && owner.id !== me.id) throw err(409, "This wallet is already linked to another DMAF account");
      const r = await db.query("update users set wallet = $2 where id = $1 returning *", [me.id, wallet]);
      return { user: userJson(r.rows[0]) };
    }
    const u = owner || (await db.query("insert into users (wallet) values ($1) returning *", [wallet])).rows[0];
    await startSession(res, req, u.id);
    return { user: userJson(u), created: !owner };
  }
  async function updateMe(req, me) {
    const b = await readJson(req);
    const r = await db.query(
      `update users set first_name = coalesce($2, first_name), last_name = coalesce($3, last_name), artist_name = coalesce($4, artist_name)
       where id = $1 returning *`, [me.id, opt(b.firstName), opt(b.lastName), opt(b.artistName)]);
    return { user: userJson(r.rows[0]) };
  }
  async function unlinkWallet(me) {
    if (!me.password_hash) throw err(400, "This account signs in with its wallet — add an email and password before unlinking it");
    const r = await db.query("update users set wallet = null where id = $1 returning *", [me.id]);
    return { user: userJson(r.rows[0]) };
  }

  async function handle(req, res, p) {
    try {
      if (p === "status" && req.method === "GET") {
        const st = await db.status();
        return send(res, 200, { db: st, user: st.ok ? userJson(await userFromRequest(req)) : null });
      }
      if (!db.ok && !(await db.status()).ok) throw err(503, `Accounts need PostgreSQL: ${db.error}`);
      if (req.method !== "GET" && !sameOrigin(req)) throw err(403, "cross-site request refused");
      if (p === "register" && req.method === "POST") return send(res, 200, await register(req, res));
      if (p === "login" && req.method === "POST") return send(res, 200, await login(req, res));
      if (p === "logout" && req.method === "POST") return send(res, 200, await logout(req, res));
      if (p === "nonce" && req.method === "GET") return send(res, 200, await nonce());
      if (p === "siwe" && req.method === "POST") return send(res, 200, await siwe(req, res));
      const me = await userFromRequest(req);
      if (p === "me" && req.method === "GET") { if (!me) throw err(401, "not signed in"); return send(res, 200, { user: userJson(me) }); }
      if (p === "me" && req.method === "PATCH") { if (!me) throw err(401, "not signed in"); return send(res, 200, await updateMe(req, me)); }
      if (p === "wallet/unlink" && req.method === "POST") { if (!me) throw err(401, "not signed in"); return send(res, 200, await unlinkWallet(me)); }
      throw err(404, `No route ${req.method} /auth-api/${p}`);
    } catch (e) {
      if (!e.status) console.error("auth-api:", e);
      send(res, e.status || 500, { errorType: e.status ? "AuthError" : "ServerError", message: e.status ? e.message : "Something went wrong — see the dev server log" });
    }
  }
  return { handle, userFromRequest, userJson };
}
const clip = v => (v == null || String(v).trim() === "" ? null : String(v).trim().slice(0, 120));
const opt = v => (v === undefined ? null : clip(v) ?? "");
