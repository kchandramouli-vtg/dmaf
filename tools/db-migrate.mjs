#!/usr/bin/env node
/* Creates / upgrades the DMAF tables in PostgreSQL and reports what's there.
   Run: DATABASE_URL=postgres://localhost/dmaf npm run db:migrate
   (npm run serve does the same automatically when it starts.) */
import { createDb, MIGRATIONS } from "../server/db.mjs";

const db = await createDb();
const st = await db.status();
if (!st.ok) { console.error(`✕ ${st.error || db.error}`); process.exit(1); }
const applied = (await db.query("select version, name, applied_at from schema_migrations order by version")).rows;
console.log(`✓ PostgreSQL at ${st.url}`);
for (const m of applied) console.log(`  migration ${m.version} · ${m.name} · ${new Date(m.applied_at).toISOString()}`);
const counts = (await db.query(`select (select count(*) from users)::int as users, (select count(*) from sessions where expires_at > now())::int as sessions,
  (select count(*) from ipfs_files)::int as files`)).rows[0];
console.log(`  ${counts.users} users · ${counts.sessions} active sessions · ${counts.files} IPFS files recorded`);
console.log(`  schema is at version ${MIGRATIONS[MIGRATIONS.length - 1].version}`);
await db.close();
