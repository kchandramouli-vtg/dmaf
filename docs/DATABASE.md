# Accounts and My Library's IPFS files (PostgreSQL)

DMAF keeps user accounts, sign-in sessions and the list of files each user put on IPFS in PostgreSQL. The dev server
(`npm run serve`) connects to it through `DATABASE_URL`. Without it, everything else still works and sign-in falls back to
the old demo (any email, nothing stored).

```
browser ──/auth-api────► server/auth.mjs ──┐
        ──/library-api─► server/library.mjs ├──► PostgreSQL (server/db.mjs)
        ──/ipfs-api/add► tools/serve.mjs ───┘    users · sessions · auth_nonces · ipfs_files
                              └──────────────► IPFS node (Kubo) — the files themselves
```

## 1. Set up on macOS (once)

```bash
brew install postgresql@16
echo 'export PATH="$(brew --prefix postgresql@16)/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc   # postgresql@16 isn't linked by default
brew services start postgresql@16          # runs now and at login
createdb dmaf                              # an empty database called dmaf
```

Then start the dev server with the database:

```bash
cd ~/Software/"dmaf 2"
npm install                                # adds the pg driver (once)
export DATABASE_URL=postgres://localhost:5432/dmaf
npm run serve
```

`npm run serve` creates the tables the first time and prints `✓ database  PostgreSQL at postgres://localhost:5432/dmaf`.
To avoid typing the export every time, add the `export DATABASE_URL=…` line to `~/.zshrc`.

Check any time with `npm run db:migrate` (creates/upgrades the tables and prints what's there), or
http://localhost:5173/__status (`"db":{"ok":true}`).

| Problem (`npm run serve` / the sign-in page says) | Fix |
|---|---|
| `DATABASE_URL is not set — demo sign-in` | `export DATABASE_URL=postgres://localhost:5432/dmaf` in the same Terminal, restart `npm run serve` |
| `PostgreSQL isn't running at …` | `brew services start postgresql@16` |
| `database doesn't exist — create it: createdb dmaf` | `createdb dmaf` |
| `PostgreSQL rejected the credentials` | Homebrew's Postgres trusts your macOS user; if you set a password: `postgres://USER:PASSWORD@localhost:5432/dmaf` |
| `missing npm packages (pg)` | `npm install`, restart |

Postgres.app or Docker (`docker run -p 5432:5432 -e POSTGRES_PASSWORD=dmaf postgres:16`, then
`DATABASE_URL=postgres://postgres:dmaf@localhost:5432/postgres`) work the same way.

## 2. What needs signing in

| Open to everyone | Needs a signed-in account |
|---|---|
| **Sign in** and **Discover** (the catalogue reads the chain and the IPFS gateway) | **My Library, Studio, Publish, Royalties, asset pages** (Pay & play, the stem visualiser, Verify) and the player |

Signed out, the menu shows only *Discover* and *Sign in*, Discover's cards say **Sign in to play**, and a link to a gated page
opens *Sign in* with a note ("Sign in to open the Studio…") and goes straight to that page afterwards (`js/app.js`, *sign-in
gate*). Signing out — or the session ending — while on a gated page sends you to *Sign in* the same way.

**On the dev server (PostgreSQL mode):** without a session cookie these answer `401 {"errorType":"Unauthorized","signIn":true}`:

| Refused without a session | Still open |
|---|---|
| every `/studio-api/…` route (stem upload, packaging, IMAF read-back, waveforms) | `POST /ipfs-api/version` |
| every `/ipfs-api/…` command except `version` (add, pin, unpin…) | `GET /ipfs/<cid>` (the gateway — Discover reads metadata through it) |
| `POST`/`PUT`/`DELETE` on `/api/…` (the ISO/IEC 21000-23 API's writes: parser, contracts, deploy checks) | `GET /api/…` (reads, `/api/openapi.yaml`) |
| `/library-api/…` | `/auth-api/…`, `/__status`, the app's files |

So the Studio and Publish workflows can't be run by calling the APIs directly. The app notices a 401 (expired session,
signed out in another tab), says *Your session has ended*, and sends you to *Sign in* and back. For scripts or tools that
need the ISO/IEC 21000-23 API without signing in, run the standalone server: `npm run scm` (`tools/scm-server.mjs`).

**In demo mode** (no `DATABASE_URL`) the server can't tell who is signed in, so only the pages are gated. And whatever
the mode, the contracts on the chain can be called by any wallet directly — the gate is the app's, not the chain's.

## 3. Signing in

| Way | How it works |
|---|---|
| **Email + password** | *Create an account* on `#/login`. The password is hashed with scrypt (N=2¹⁵, r=8, p=1, random 16-byte salt) — the database never holds it. 8 characters minimum. 8 wrong attempts in 10 minutes from one address lock that email out for a while. |
| **Sign in with MetaMask** | MetaMask signs a short [EIP-4361](https://eips.ethereum.org/EIPS/eip-4361) message ("localhost:5173 wants you to sign in with your Ethereum account…") containing a one-time nonce from the server. The server checks the signature, the site, the nonce (single use, 10 minutes) and the time. No transaction, no gas. The first time, it creates an account for that wallet. |
| **Linking a wallet** | When you register (tick *Link my MetaMask wallet now*) or later from the account card: the same signed message, but it attaches the wallet to your signed-in account. One wallet belongs to one account. |

A session is a random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie (`dmaf_session`, 30 days); the database keeps
only its SHA-256. *Sign out* deletes it. Requests that change anything must come from the app's own page (Origin check)
and be JSON. The dev server listens on `127.0.0.1` only.

## 4. My Library ▸ IPFS files

While you're signed in, every file you put on IPFS through DMAF is recorded against your account:

| Recorded when | Kind shown |
|---|---|
| Publish uploads the MP3, the agreement JSON-LD and the metadata JSON | Audio (MP3) · Agreement (MCO) · Asset metadata |
| The Studio packages stems (on the dev server) | Stem mix (MP3) · IMAF package · IMAF description · Waveforms |
| A Smart Contract for Media is deployed (its NFT metadata) | Smart-contract token |
| You add files on My Library | Upload |

After a publish, the files are linked to the asset (*Used by: Asset #3*). On My Library you can:

* **Filter** — Media & documents (default: everything except smart-contract tokens), Audio & mixes, Stem packages,
  Metadata & agreements, Smart-contract tokens, Uploads, Everything.
* **See whether each file is pinned on your IPFS node**, and **Pin / Unpin** it. Unpinning lets your node delete the file at its
  next garbage collection; if an asset uses it, the app asks first, because listeners couldn't fetch it any more unless
  another node pins it.
* **Hide / Show** — hides a row from My Library only (nothing changes on IPFS or the chain). *Include hidden files* shows them.
* **＋ Add files to IPFS** — uploads and pins files without registering anything on-chain.

Files you added before signing in (or in demo mode) aren't in the list — the database only learns about uploads made while
you're signed in.

## 5. Tables

Created by migration 1 in `server/db.mjs` (`schema_migrations` records which migrations ran).

| Table | Columns |
|---|---|
| `users` | `id`, `email` (unique, case-insensitive), `password_hash` (`scrypt$N$r$p$salt$hash`, null for wallet-only accounts), `first_name`, `last_name`, `artist_name`, `wallet` (unique, lower-case), `created_at`, `last_login_at` |
| `sessions` | `token_hash` (SHA-256 of the cookie), `user_id`, `created_at`, `expires_at`, `user_agent` |
| `auth_nonces` | `nonce`, `created_at`, `used_at` — one per MetaMask sign-in attempt, deleted after a day |
| `ipfs_files` | `user_id`, `cid` (unique per user), `name`, `mime`, `size`, `kind`, `source`, `agreement_id`, `asset_id`, `hidden`, `created_at`, `updated_at` |

To change the schema, **add** a migration to the end of `MIGRATIONS` in `server/db.mjs` (`{ version: 2, name, sql }`); never edit
one that has already run. It runs once, in a transaction, the next time the server starts or `npm run db:migrate` runs.

Useful queries (`psql dmaf`):

```sql
select id, email, artist_name, wallet, last_login_at from users;
select kind, count(*), pg_size_pretty(sum(size)) from ipfs_files group by kind;
delete from sessions;                       -- sign everyone out
```

## 6. HTTP API (dev server)

| Method & path | Body | Answer |
|---|---|---|
| `GET /auth-api/status` | — | `{ db: { ok, error? }, user }` |
| `POST /auth-api/register` | `{ email, password, firstName?, lastName?, artistName? }` | `{ user }` + session cookie |
| `POST /auth-api/login` | `{ email, password }` | `{ user }` + cookie |
| `POST /auth-api/logout` | `{}` | clears the cookie |
| `GET /auth-api/nonce` | — | `{ nonce }` |
| `POST /auth-api/siwe` | `{ message, signature, link? }` | `{ user, created? }` (+ cookie when signing in) |
| `GET /auth-api/me` · `PATCH /auth-api/me` | `{ firstName?, lastName?, artistName? }` | `{ user }` |
| `POST /auth-api/wallet/unlink` | `{}` | `{ user }` (only for accounts with a password) |
| `GET /library-api/files[?hidden=1]` | — | `{ files: [{ cid, name, size, kind, assetId, pinned, hidden, … }], totals, ipfsError }` |
| `POST /library-api/pin` · `/unpin` | `{ cid }` | `{ file }` |
| `POST /library-api/hide` | `{ cid, hidden }` | `{ file }` |
| `POST /library-api/link` | `{ assetId, cids }` | `{ linked }` |

Uploads are recorded by the dev server's IPFS proxy: the browser sends `x-dmaf-kind`, `x-dmaf-name`, `x-dmaf-size`,
`x-dmaf-mime`, `x-dmaf-source`, `x-dmaf-agreement` headers with `/ipfs-api/add` (see `ipfsAdd()` in `js/web3.js`); the server
reads Kubo's answer, records each CID for the signed-in user and strips those headers before Kubo sees the request.

## 7. Going beyond a local proof of concept

* Serve over HTTPS and add `Secure` to the session cookie (`startSession()` in `server/auth.mjs`).
* Email verification and password reset need an email service — not included.
* Pinning is on your own node; for files other people can fetch reliably, also pin to a pinning service.
* Back up the database (`pg_dump dmaf > dmaf.sql`).
