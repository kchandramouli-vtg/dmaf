/* ============================================================
   PostgreSQL for DMAF — accounts, sessions and the IPFS library.

   Connection: DATABASE_URL, e.g.  postgres://localhost:5432/dmaf
   (docs/DATABASE.md has the macOS setup). The schema is created and
   upgraded automatically: every entry of MIGRATIONS runs once, in order,
   inside a transaction, and is recorded in schema_migrations.
   Never edit a migration that has run — add a new one at the end.
   ============================================================ */
import pg from "pg";

export const MIGRATIONS = [
  {
    version: 1,
    name: "accounts, sessions, sign-in nonces, IPFS library",
    sql: `
      create table users (
        id             bigserial primary key,
        email          text,
        password_hash  text,                       -- scrypt$N$r$p$salt$hash (server/auth.mjs); null for MetaMask-only accounts
        first_name     text,
        last_name      text,
        artist_name    text,
        wallet         text,                       -- lower-case 0x address, proven by a signed message
        created_at     timestamptz not null default now(),
        last_login_at  timestamptz
      );
      create unique index users_email_key  on users (lower(email))  where email  is not null;
      create unique index users_wallet_key on users (lower(wallet)) where wallet is not null;

      create table sessions (
        token_hash  text primary key,              -- sha256 of the cookie value; the token itself is never stored
        user_id     bigint not null references users(id) on delete cascade,
        created_at  timestamptz not null default now(),
        expires_at  timestamptz not null,
        user_agent  text
      );
      create index sessions_user on sessions (user_id);

      create table auth_nonces (                   -- one-time nonces for "Sign in with MetaMask" (EIP-4361 messages)
        nonce       text primary key,
        created_at  timestamptz not null default now(),
        used_at     timestamptz
      );

      create table ipfs_files (                    -- everything a user put on IPFS through DMAF
        id            bigserial primary key,
        user_id       bigint not null references users(id) on delete cascade,
        cid           text not null,
        name          text,
        mime          text,
        size          bigint,
        kind          text not null default 'file', -- audio · mix · imaf · imaf-description · waveforms · metadata · agreement · scm-token · upload · file
        source        text,                         -- publish · studio · library · smart-contract …
        agreement_id  text,
        asset_id      integer,                      -- DmafMediaRegistry asset the file belongs to
        hidden        boolean not null default false,
        created_at    timestamptz not null default now(),
        updated_at    timestamptz not null default now(),
        unique (user_id, cid)
      );
      create index ipfs_files_user on ipfs_files (user_id, created_at desc);
    `,
  },
];

/**
 * @returns {Promise<{ ok: boolean, error?: string, query?: Function, pool?: pg.Pool, status: Function, close: Function }>}
 */
export async function createDb({ url = process.env.DATABASE_URL } = {}) {
  if (!url) return { ok: false, error: "DATABASE_URL is not set — accounts use demo sign-in (see docs/DATABASE.md)", status: async () => ({ ok: false, error: "DATABASE_URL is not set" }), close: async () => {} };
  const pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 3000, idleTimeoutMillis: 30_000 });
  pool.on("error", () => {});                                   // a dropped idle connection must not crash the dev server
  const db = { ok: false, error: null, pool, url: redact(url) };
  db.query = (text, params) => pool.query(text, params);
  db.tx = async fn => {
    const c = await pool.connect();
    try { await c.query("begin"); const r = await fn(c); await c.query("commit"); return r; }
    catch (e) { await c.query("rollback").catch(() => {}); throw e; }
    finally { c.release(); }
  };
  db.close = () => pool.end();
  let checkedAt = 0;
  db.status = async () => {
    if (Date.now() - checkedAt < 5000) return { ok: db.ok, error: db.error || undefined, url: db.url };
    checkedAt = Date.now();
    try {
      await pool.query("select 1");
      if (!db.migrated) await migrate(db);
      db.ok = true; db.error = null;
    } catch (e) { db.ok = false; db.error = explain(e, db.url); }
    return { ok: db.ok, error: db.error || undefined, url: db.url };
  };
  await db.status();
  return db;
}

async function migrate(db) {
  await db.query(`create table if not exists schema_migrations (version integer primary key, name text not null, applied_at timestamptz not null default now())`);
  const done = new Set((await db.query("select version from schema_migrations")).rows.map(r => r.version));
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    await db.tx(async c => {
      await c.query(m.sql);
      await c.query("insert into schema_migrations (version, name) values ($1, $2)", [m.version, m.name]);
    });
    console.log(`✓ database     migration ${m.version} applied — ${m.name}`);
  }
  db.migrated = true;
}

const redact = u => { try { const x = new URL(u); if (x.password) x.password = "****"; return x.toString(); } catch { return "(invalid DATABASE_URL)"; } };
function explain(e, url) {
  const code = e.code || e.cause?.code;
  if (code === "ECONNREFUSED") return `PostgreSQL isn't running at ${url} — start it (brew services start postgresql@16)`;
  if (code === "3D000") return `database doesn't exist — create it: createdb ${(() => { try { return new URL(url).pathname.slice(1) || "dmaf"; } catch { return "dmaf"; } })()}`;
  if (code === "28P01" || code === "28000") return `PostgreSQL rejected the credentials in DATABASE_URL (${e.message})`;
  return e.message;
}
