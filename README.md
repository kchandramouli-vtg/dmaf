# DMAF — Decentralised Media Application Framework

> **Guides:** [docs/EDITING-TEXT.md](docs/EDITING-TEXT.md) (changing any wording in the app) ·
> [docs/DATABASE.md](docs/DATABASE.md) (PostgreSQL accounts, MetaMask sign-in, My Library's IPFS files) ·
> [docs/STEMS-AND-IMAF.md](docs/STEMS-AND-IMAF.md) (stems → ffmpeg/MP4Box IMAF package, stem visualiser) · [docs/](docs/README.md)

Standardised frontend for publishing, streaming and monetising interactive
multi-track media, built on three ecosystem engines:

| Engine | Standard | Role in the UI |
|---|---|---|
| **IMAF Engine** | ISO/IEC 23000-12 (Interactive Music Application Format) | Packages multiple stems + preset mixes + interactivity rules into one container |
| **DASH Engine** | ISO/IEC 23009-1 (Dynamic Adaptive Streaming over HTTP) | Adaptive streaming renditions of the package |
| **DLT Engine** | Distributed Ledger (your Hardhat/Ethereum contracts) | Registers authorship, contract terms and settles reuse payments |

**ISO/IEC 21000-23 (Smart Contracts for Media).** Agreements are MPEG-21 MCO contracts that run
on Ethereum as the standard's Smart Contracts for Media: the standard's OpenAPI is served at `/api`,
the reference `Contract.sol` / `NFToken.sol` are deployed byte for byte, and paid plays are settled
by the standard's `Contract.payTo`. Agreements `payTo` can't settle (parties sharing a wallet, contract
wallets, fractional percentages) — or a dev server started without `npm install` — still get paid per play:
the registry then pays each party's wallet its share itself (the *direct split*, as in the original PoC,
with withdraw for wallets that refuse ETH). What that means in detail, the test evidence and every deviation from
the reference software: **[mpeg21/CONFORMANCE.md](mpeg21/CONFORMANCE.md)**.

Open `index.html` in a browser — it runs fully in **demo mode** (no backend needed).
The **IPFS + chain proof of concept** (real MP3 on IPFS, Solidity contract on a local
Hardhat chain, pay-per-play through MetaMask) needs the dev server — see
[IPFS + chain proof of concept](#ipfs--chain-proof-of-concept-metamask) below.

## Screen inventory

| # | Screen | Route | Purpose |
|---|---|---|---|
| 1 | Sign in / Register | `#/login` | Email + password or MetaMask sign-in (PostgreSQL, see docs/DATABASE.md); artist name; linked payout wallet |
| 2 | My Library | `#/library` | Assets the connected wallet published on-chain, and its agreements |
| 3 | Discover | `#/discover` | Every asset in the on-chain registry; pay & play |
| 4 | Studio · Agreement | `#/studio` step 1 | Create an MPEG-21 MCO contract between the parties from a use-case template; edit parties, permissions, obligations, payments and deliverable stems; sign and register on-chain |
| 5 | Studio · Stems | step 2 · `#/studio/:agreementId` | Deliver the stems the agreement calls for (files auto-matched by name, uploaded to the dev server), set groups and default levels |
| 6 | Studio · Package | step 3 | IMAF presets (Producer/Karaoke/…) and listener-control rule (DASH renditions: not generated yet) |
| 7 | Studio · Reuse licence | step 4 | How other creators may reuse the package (served as data) |
| 8 | Studio · Publish | step 5 | ffmpeg mixes the stems into an MP3 and packages them as IMAF, both pinned to IPFS; then **Publish** registers the mix pay-per-play with the IMAF package in its metadata |
| 8 | Player | `#/player/:id` | Interactive playback: per-stem volume/mute, preset switching |
| 9 | Royalties | `#/royalties` | Balance, monthly income, on-chain event feed (in/out); **live** earnings/plays for the connected wallet |
| 10 | Publish (PoC) | `#/publish/:agreementId?` | MP3 → IPFS, MCO agreement → IPFS, `registerAsset()` on-chain via MetaMask |
| 11 | Asset (PoC) | `#/asset/:id` | Pay-per-play via MetaMask, ETH split per the agreement, on-chain access log, IPFS/hash verification |

Screens that naturally come next (not yet built): package detail/licensing page,
profile & wallet settings, admin/contract-template editor.

## Agreements (MPEG-21 MCO)

The Studio starts with a contract, not an upload: **agree → make the music → deliver stems → package → publish.**

- The six use cases (on-demand stream / digital sale × big label / indie label / self-released) are the
  standard's template contracts. `js/mco-templates.js` is generated from its Turtle files through the
  ISO/IEC 21000-23 parser (`npm run templates`); `contracts/templates/` keeps the standard's JSON-LD variants.
- Step 1 edits every contract element and serialises it to the **flat MCO JSON-LD profile**
  (`mpeg21/lib/jsonld-profile.mjs`) — what the standard's parser reads, RDF-equivalent to its Turtle
  templates — plus `dmaf:` properties for work details, party names/wallets and deliverable stems
  (stems are `mco-core:Provide` obligations over `mvco:Manifestation`s). Download it as JSON-LD,
  Turtle or CEL XML (the last two through the standard's generators).
- **Register agreement on-chain** runs the standard's forward conversion: JSON-LD → `POST /api/parser/mco`
  → Media Contractual Objects → `GET /api/dlt/generate/{id}` → deontic/object JSON on IPFS → one MetaMask
  transaction that mints an NFT per deontic expression and object and deploys the reference `Contract`.
  **Read it back from the chain** and **My agreements ▸ Import from the chain** run the backward conversion.
- Lifecycle: `draft → signing → signed → active → delivered`. In demo mode agreements persist in
  `localStorage`, and one active agreement ("Night Signals") is seeded so the "come back later" path is visible.
- The revenue-flow panel is indicative: fixed amounts flow as-is (cents converted), percentages apply to the payer's income.

## Wiring to your backend

Everything goes through **`js/api.js`** — the only file you touch.

1. Set `MOCK = false` and `API_BASE = "http://localhost:3000"`.
2. Endpoints marked `[EXISTS]` already map to your media-backend routes
   (`/api/users/*`, `/api/tracks/*`).
3. Endpoints marked `[NEW]` are the proposed additions for the IMAF/DASH scope:

| Method & path | Purpose |
|---|---|
| `GET /api/packages` | Creator's packages (stems count, formats, status, tx) |
| `GET /api/packages/feed` | Public discover feed |
| `POST /api/packages` | Multipart: `stems[]`, groups, presets, rules → server muxes IMAF + generates DASH |
| `GET /api/contracts` | The predefined contract templates as JSON |
| `POST /api/packages/:id/publish` | Body `{contractId}` → on-chain registration, returns `{txHash, contractAddress, gasUsed}` |
| `GET /api/packages/:id/stems` | Per-stem stream URLs + groups for the player |
| `GET /api/packages/:id/manifest.mpd` | DASH manifest |
| `GET /api/royalties` | Balance + settled event feed |
| `GET /api/mco/templates` | The six MCO use-case templates (normalised from `contracts/templates/*.json`) |
| `GET /api/agreements` · `GET /api/agreements/:id` | Agreements the user is a party to |
| `POST /api/agreements` · `PUT /api/agreements/:id` | Create / update a draft (`{ …model, jsonld }`) |
| `POST /api/agreements/:id/sign` | `{partyId}` — party signs the contract hash with its wallet |
| `POST /api/agreements/:id/register` | Deploy the MCO contract to the DLT engine → `{txHash, contractAddress}` |
| `POST /api/agreements/:id/deliverables` | Multipart `file`, `deliverableId` — deliver a stem against the agreement |

### ISO/IEC 21000-23 OpenAPI (`/api`)

`npm run serve` also serves the standard's OpenAPI (`server/scm-api.mjs`, spec at `/api/openapi.yaml`);
`npm run scm` runs it alone on :8081.

| Method & path | Purpose |
|---|---|
| `POST /api/parser/mco` | MCO (Turtle, or JSON-LD with `application/ld+json`) → Media Contractual Objects |
| `POST /api/parser/cel` | MPEG-21 CEL XML → Media Contractual Objects (via the CEL Server) |
| `POST /api/contracts/` · `GET /api/contracts/{id}` | Store / read a Media Contractual Objects contract (`cont-…`) |
| `GET/POST /api/contracts/{id}/parties|otherPersonUsers|deontics|actions|objects|facts|operativePart/…` | Sub-resources, incl. deontic `conditions/` |
| `GET /api/generator/mco/{id}` | → MCO Turtle (`Accept: application/ld+json` → JSON-LD) |
| `GET /api/generator/cel/{id}` | → CEL XML |
| `GET /api/dlt/generate/{id}` | → Smart Contract for Media specification (token JSON, income percentages, content + hash) |
| `POST /api/dlt/eth/parse/` | Ethereum address → Media Contractual Objects (reads the contract, its NFTs and IPFS) |
| `POST /api/dlt/algo/parse/` | 501 — Algorand isn't supported |
| `/api/x-dmaf/…` | DMAF extensions: `eth/inspect` (parse + bindings + hash check), `mco/jsonld`, `cel/deploy`, `cel/reverse`, `status` |

Auth: the helper attaches `Authorization: Bearer <token>` from
`localStorage.dmaf_token` — same JWT scheme your backend already uses.

## Design

Carries the SoundSlice visual language (navy `#091a2b`, cyan `#00a2fd`,
white cards on gray-50) so existing pages and this app feel like one product.


## IPFS + chain proof of concept (MetaMask)

```
Studio ─ MCO agreement (parties, wallets, payment obligations)
   └─ Register ─► /api/parser/mco ─► /api/dlt/generate ─► token JSON on IPFS
                  └─► Mpeg21ScmFactory  [MetaMask tx]  → NFToken × (deontics + objects)
                                                       → Contract (ISO/IEC 21000-23 reference)
Publish ─┬─ MP3 ───────────────► IPFS  (audio CID)
         ├─ agreement JSON-LD ──► IPFS  (agreement CID + keccak256)
         ├─ Smart Contract for Media (SCM settlement: deployed now if not on this chain yet)
         ├─ metadata JSON ──────► IPFS  (metadata CID → audio + agreement + SCM)
         └─ registerAsset() ────► DmafMediaRegistry  [MetaMask tx · producer]
                                   CIDs, agreement hash, price/play, and either
                                   SCM address + entry party   or   payees (wallet + bps + role)
Discover ─ reads assets from the contract, metadata from IPFS
Asset ──── Pay & play: access(id) + price  [MetaMask tx · listener]
              → play recorded on-chain (Accessed event + access log)
              → SCM:    Contract.payTo(entry, price): every income percentage paid down the chain, same tx
              → direct: the registry pays each payee wallet its bps share, same tx
                        (a wallet that refuses ETH is credited → Royalties ▸ Withdraw)
              → MP3 streams from the IPFS gateway; next play is a new payment
Royalties ─ live earnings / plays of the connected wallet (contract events)
```

### One-time setup

1. **Node.js 20+**, then in this folder: `npm install`
2. **IPFS** — [IPFS Desktop](https://docs.ipfs.tech/install/ipfs-desktop/) or Kubo
   (`brew install ipfs && ipfs init`). No CORS setup needed: the dev server proxies the node.
3. **MetaMask** browser extension.
4. *Optional:* **PostgreSQL** for real accounts and My Library's IPFS files (`brew install postgresql@16`, `createdb dmaf`,
   `export DATABASE_URL=postgres://localhost:5432/dmaf` — [docs/DATABASE.md](docs/DATABASE.md)); **ffmpeg** for the Studio's stem
   route (`brew install ffmpeg`); **MP4Box** to mux IMAF packages with GPAC (`brew install gpac`). Without them the rest works.

### Run it — one command (macOS and Linux)

```bash
cd ~/Software/"dmaf 2"
./dmaf.sh            # or: bash dmaf.sh
```

`dmaf.sh` starts each service as its own process and shows their output in one terminal, each line labelled
`db` · `ipfs` · `chain` · `deploy` · `app`; **Ctrl-C stops them all**. It starts **PostgreSQL** (Homebrew's database on
macOS, or a data directory just for DMAF in `.data/postgres` on Linux) and creates the `dmaf` database, **IPFS**
(`ipfs daemon`, or opens IPFS Desktop), the **Hardhat chain**, then runs `npm run deploy` when the contracts aren't
on it, and finally the **app** on http://localhost:5173. Anything already running — `brew services` PostgreSQL, IPFS
Desktop, a chain in another terminal — is reused and left running when you stop.

| Command | |
|---|---|
| `./dmaf.sh` | Start everything and follow the logs (`--open` opens the browser, `--verbose` shows every chain RPC line, including the read-only `eth_call` reverts it hides, `--no-db`, `--no-ipfs`) |
| `./dmaf.sh status` | ✓/✕ for the chain (and whether the contracts are deployed), database, IPFS and app |
| `./dmaf.sh stop` | Stops what an earlier `./dmaf.sh` started, if its terminal was closed |

Full logs are in `.data/logs/` (`chain.log`, `db.log`, `ipfs.log`, `deploy.log`, `app.log`). It uses `DATABASE_URL` if you
set it (default `postgres://localhost:5432/dmaf`), and `PORT`. If it says port 5173 is in use, stop the `npm run serve`
you started by hand. A new chain means a fresh Studio and publishing again (it reminds you); MetaMask needs no reset.

### Run it (four terminals)

The same, by hand:

| # | Command | What it does |
|---|---|---|
| 1 | `ipfs daemon` *(or open IPFS Desktop)* | IPFS API on :5001, gateway on :8080 |
| 2 | `npm run chain` | Hardhat node on http://127.0.0.1:8545, chain id 31337, 20 funded test accounts |
| 3 | `npm run deploy` | Deploys `NFToken`, `Mpeg21ScmFactory` and `DmafMediaRegistry`, writes `js/chain-config.js` |
| 4 | `npm run serve` | UI on **http://localhost:5173** (MetaMask doesn't inject into `file://`) + the ISO/IEC 21000-23 API at `/api`; with `DATABASE_URL` set, accounts and My Library's IPFS files. It prints a ✓/✕ line for the chain, IPFS, database, ffmpeg and MP4Box |
| 5 *(optional)* | `npm run cel` | MPEG-21 CEL Server on :5000, for CEL import/export (first time: `npm run cel:setup`, Python 3.9–3.12) |

`npm test` runs 147 tests: the contracts and the forward/backward conversion of the standard's six template
contracts on an in-process chain (Hardhat), and the conformance suite against the reference software's
outputs plus the OpenAPI server (Node), plus the IMAF writer/reader (needs ffmpeg) and the password/sign-in-message checks. The 12 CEL tests that need a
live CEL Server skip unless `npm run chain` and `npm run cel` are running.

### MetaMask

* **Network** — clicking *Connect MetaMask* offers to add/switch to *Hardhat Localhost*
  (RPC `http://127.0.0.1:8545`, chain id `31337`, symbol ETH). You can also add it by hand.
* **Accounts** — import Hardhat's test accounts (*account menu ▸ Add account or hardware wallet ▸ Import account ▸
  paste the private key*). These keys are published by Hardhat for testing; never put real funds on them.
  Accounts MetaMask creates itself (*Account 2*, *Account 3*, … from *Add account*) are **not** Hardhat accounts:
  they hold 0 ETH on the local chain and no agreement pays them, whatever their number. Rename each imported
  account after its party (account menu ▸ ⋮ ▸ *Account details*) to keep track.

| Hardhat # | Role in the PoC | Address | Private key |
|---|---|---|---|
| #1 | Producer · KS Audio (publishes, receives the creator's share) | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d` |
| #2 | Listener (pays to play) | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` | `0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a` |
| #3 | Other parties, in the agreement's party order (*Fill test wallets & names*) | `0x90F79bf6EB2c4f870365E785982E1f101E93b906` | `0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6` |
| #4 | 〃 | `0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65` | `0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a` |
| #5 | 〃 | `0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc` | `0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba` |
| #6 | 〃 | `0x976EA74026E726554dB657fA54763abd0C3a0aa9` | `0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e` |
| #7 | 〃 | `0x14dC79964da2C08b23698B3D3cc7Ca32193d9955` | `0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356` |
| #8 | 〃 | `0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f` | `0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97` |

Which party sits on which wallet is in the agreement (Studio ▸ Parties) and on the asset page (*Revenue split*,
with the Hardhat number next to each wallet). `npm run chain` prints all 20 accounts and keys.

### Walkthrough

0. **Sign in** (*Sign in* in the menu). Signed out, only *Discover* is open; My Library, Studio, Publish, Royalties
   and the asset pages need an account ([docs/DATABASE.md](docs/DATABASE.md) § 2). Without PostgreSQL any email works (demo).
1. **Producer (#1)** — *Studio ▸ My agreements*: *Night Signals* is already active, with
   Hardhat wallets #3–#8 for the label, aggregator, DSP, publisher, PRO and mechanical agent.
   (Or make your own: pick one of the six use cases, give the work a title, click **Fill test wallets & names** under Parties, then **Send for signature** and **Register agreement on-chain**.)
   The creator (Author/Band) gets the payout wallet of the account you're signed in with (*Sign in ▸ My account*),
   or else the wallet MetaMask is on — so be on the Producer (#1), not the Listener, when you start an agreement.
   The Studio warns if any party is on #2: that party's share of every play would go straight back to the listener.
2. *Publish* (or **Publish MP3** on the agreement card) ▸ pick the agreement ▸ choose how plays are paid
   (**Smart Contract for Media** or **Direct split** — picked for you, see below) ▸ drop
   `samples/night-signals-demo.mp3` ▸ set the price ▸ **Publish to IPFS + chain** ▸ confirm in MetaMask.
3. **Listener (#2)** — switch account in MetaMask ▸ *Discover* ▸ **▶ Pay & play** ▸ confirm.
   The asset page shows the transaction, the ETH sent to each party, the on-chain access log,
   and verifies the agreement on IPFS against the hash stored on-chain.
4. Switch to #1 (or any party) ▸ *Royalties* ▸ *Live on-chain* shows what that wallet earned, and a
   **Withdraw** button when a direct-split payout couldn't be pushed to it.

### Checking that the ETH really moved

The *Payout* events the app shows are what the contract *says* it paid. To check the chain itself, DMAF compares every
wallet's **balance in the block before a play with its balance in the block of the play** (Hardhat keeps every
block's state) against what the play should have done:

* each payee's balance went up by exactly its share;
* the listener's went down by the price **plus the gas** for the transaction (minus its own share, if the listener's
  wallet is also a payee);
* the registry and the Smart Contract for Media kept nothing (a direct-split payout that couldn't be pushed stays in
  the registry until the payee withdraws it);
* the payouts add up to the price and match the split the contract computes for that price (`previewSplit`).

Two ways to run it:

* **Asset page** — *Access log ▸ Verify* on any play, or **Check every wallet's balance on-chain** right after paying.
  Every wallet gets ✓ or ✕ with the exact amounts.
* **Terminal** — `npm run verify:payouts` checks every paid play of every asset (`npm run verify:payouts -- 3` for asset
  #3, or pass a transaction hash). It names each wallet (Hardhat #, party from the metadata) and exits with 1 if anything
  doesn't add up.

```
  Play #1 · tx 0x1792…d6d6 · block 14 · Contract.payTo of 0x948B…4F8F
  Wallet                  Party                         Share   Should change by           Balance changed by
  0x7099…79C8 Hardhat #1  KS Audio                      45.50%  +0.000455 ETH              +0.000455 ETH              ✓
  0x14dC…9955 Hardhat #7  Any DSP                       39.00%  +0.00039 ETH               +0.00039 ETH               ✓
  …
  0x3C44…93BC Hardhat #2  listener (pays price + gas)           −0.001324736084269852 ETH  −0.001324736084269852 ETH  ✓
  ✓ payouts add up to the price (0.001 of 0.001 ETH)
```

**In MetaMask**, import the party accounts (table above) to watch their balances. Two things make MetaMask look as if
nothing arrived: payments from a contract to a wallet are *internal* transfers, so they don't appear in the receiving
account's *Activity* (only its balance changes); and the balance is rounded (10 000 ETH + 0.00003 ETH still shows
10 000 ETH). *Royalties ▸ Live on-chain* shows each wallet's earnings exactly.

### How the agreement becomes a split

The agreement's Smart Contract for Media does it. Each `mco-pane:Payment` with an income percentage is stored
on-chain as "payer → beneficiary : pct" (`Contract.getIncomePercentagesBy`). A play pays the party the end user's
payment obligation names (the *entry*, e.g. the streaming service) through `Contract.payTo`, which hands each
beneficiary `amount × pct / 100` of what its payer receives, recursively; each party keeps the rest. For
*Night Signals* (indie stream template): streaming service 39%, label 38.25%, aggregator 7.5%, publisher 5%,
mechanical agent 5%, author 4.25%, PRO 1%. Parties without a wallet are bound to the publisher. Percentages must
be whole numbers (Contract.sol stores `uint256` percents); fixed fiat amounts in the MCO stay in the contract
content but don't move ETH. "No agreement" publishing deploys a one-party contract (100% of each play to the publisher).

**Direct split.** The original PoC's settlement, kept alongside: the agreement's payment obligations give each
party a net share of one consumer payment (*Studio ▸ revenue flow*), rounded to basis points that sum to 10 000.
The registry stores those payees (wallet + bps + MCO role) and pays them itself in the listener's transaction,
50 000 gas per payee; a payee that reverts is credited to `pendingWithdrawals` and pulls it with `withdraw()`
(*Royalties ▸ Withdraw*). Parties without a wallet are paid through the publisher and shared wallets are merged,
so any agreement works. Publish picks the Smart Contract for Media when `payTo` can settle the agreement and the
API is running, and the direct split otherwise — it says why, and you can switch to the direct split at any time.
In the Studio, an agreement `payTo` can't settle goes live for the direct split instead of being deployed.

### Contracts — `chain/contracts/`

| Contract | Role |
|---|---|
| `mpeg21/Contract.sol` · `mpeg21/NFToken.sol` · `mpeg21/EnumerableMapAddressToUint.sol` | ISO/IEC 21000-23 reference contracts, byte for byte (OpenZeppelin 4.9.6) |
| `Mpeg21ScmFactory.sol` | Mints the NFTs and deploys the `Contract` in one transaction (the reference's calls, batched) |
| `DmafMediaRegistry.sol` | Assets and pay-per-play; settles through the asset's `Contract.payTo`, or by its direct split |
| `cel/Ethereum_Smart.sol` · `cel/Ethereum_Media_Token.sol` | The CEL Server's contracts (`Cel`, `MediaToken`, solc 0.7.6) |

| Registry function / event | Purpose |
|---|---|
| `registerAsset(input, payees)` | CIDs, agreement keccak256 + id, price per play, `scm` and `entry`, and `payees`. **SCM:** `payees` empty; `scm` must have the reference `Contract`'s code hash (`scmCodehash`), and a cascade `payTo` can settle (entry is a party, no contract wallets, no cycles, ≤100%). **Direct split:** `scm` = 0; 1–16 payees (wallet, bps, role), bps sum to 10 000 |
| `access(assetId)` *payable* | Exact price; records the play, then calls `scm.payTo{value: price}(entry, price)` or pays each payee its share (last payee takes the rounding dust) |
| `withdraw()` | Pulls a direct-split payout that couldn't be pushed during `access()` |
| `previewSplit(assetId, amount)` | What each wallet receives — same arithmetic as `payTo` or the direct split |
| `setPrice` · `setActive` | Publisher only |
| `getAsset` · `getPayees` · `getAccessLog` · `accessCount` · `playsBy` · `totalEarned` · `pendingWithdrawals` | Views used by the UI |
| `AssetRegistered` · `ScmLinked` · `Accessed` · `Settled` · `Payout` · `PayoutDeferred` · `Withdrawn` | Events behind Discover, the access log and Royalties (`Payout` carries the share in bps and, for the direct split, the MCO role) |

### Stems → mix MP3 + IMAF package (ffmpeg)

The Studio's stem route is real when the app runs through `npm run serve` and **ffmpeg** is on your PATH
(`brew install ffmpeg`; check with `ffmpeg -version`, or the ✓ ffmpeg line `npm run serve` prints):

1. *Studio ▸ My agreements ▸* **Deliver stems (IMAF)** — drop the WAVs (FLAC, AIFF, MP3… also work). Each is
   uploaded to the dev server (`.data/stems/<agreement>/`, survives reloads), checked with ffprobe and matched
   to a deliverable by name. Set each stem's group and default level (70 = as delivered).
2. **Continue to packaging** — pick the preset mixes and the listener-control rule; pick a reuse licence.
3. **Build mix + IMAF package** runs on the dev server (`server/stems.mjs`):
   * the mix: `ffmpeg -i stem1.wav … -filter_complex "amix=inputs=N:duration=longest:normalize=1:weights='w1 … wN'" -c:a libmp3lame -b:a 320k mix.mp3`
     — your amix command, with the default levels as weights (level / 70);
   * the IMAF file (ISO/IEC 23000-12): `ffmpeg … -map 0:a … -c:a aac -b:a 256k -brand im02 -f mp4`, one AAC track per
     stem named after the deliverable, then `server/imaf.mjs` enables every track (ffmpeg marks extra audio
     tracks as alternatives) and adds the group (`grco`), preset (`prco`) and rules (`ruco`) boxes;
   * both, plus `imaf.json` describing them, are pinned to your IPFS node. The step shows the CIDs, the
     sha256 fingerprint of the IMAF file and the exact ffmpeg commands.
4. **Publish the mix on-chain →** opens Publish with the mix preloaded: pick the settlement (Smart Contract for
   Media or direct split), set the price, publish. The asset's metadata records the IMAF package (CID, sha256,
   tracks, groups, presets, rule). Listeners pay per play of the mix; after paying they see the IMAF package
   link and can **Read the IMAF package back** (parsed from IPFS on the dev server).

An MP3 holds one stereo mix, so the stems travel in the IMAF file, not inside the MP3. IMAF box syntax follows our
reading of ISO/IEC 23000-12 and hasn't been checked against reference IMAF software (volumes are linear gain in
0.02 steps, 50 = unity; group IDs are 0x80000000 + n). Without the dev server (demo mode) the stem route only
records file names. `npm run test:imaf` tests the IMAF writer/reader.

### Restarting the chain

Hardhat's chain lives in memory. After restarting `npm run chain`: run `npm run deploy` again
(`./dmaf.sh` does both), reload the app and publish again. Files stay pinned in your IPFS node.

- **The Studio starts fresh.** On the first load after a restart, agreements last saved before the new
  contracts were deployed are cleared (with the stem package waiting for Publish), so the Studio is as empty
  as the chain. Redeploying onto the same running chain keeps them. Delivered stem files stay in
  `.data/stems/` and on IPFS (My Library).
- **MetaMask needs no reset.** `npm run deploy` starts test accounts #1–#19 at a nonce no earlier chain
  used (the time in seconds). MetaMask remembers transactions across restarts, and one whose nonce it had
  already seen confirmed was shown as *Failed* even though the chain mined it (the ETH moved and the track
  played). Transactions from before this change can still show *Failed* in MetaMask's Activity:
  *Settings ▸ Advanced ▸ Clear activity tab data*, once per account, tidies them away.
- An agreement's Smart Contract for Media is checked by its content hash, not just its address: a restarted
  chain hands out the same addresses again. If one is missing, the Studio says **Not on this chain any more**
  and offers **Deploy again on this chain** (Publish also redeploys it).

### Troubleshooting

`npm run serve` prints a ✓/✕ line for the chain, the IPFS node, the database, ffmpeg and MP4Box when it starts, and
http://localhost:5173/__status shows the same as JSON at any time.

| Symptom | Cause · fix |
|---|---|
| `✕ IPFS … unreachable (ECONNREFUSED)`, *IPFS node ✕ Offline*, or "The IPFS node isn't running" | No IPFS node on 127.0.0.1:5001. Start **IPFS Desktop**, or install Kubo once (`brew install ipfs`, `ipfs init`) and keep `ipfs daemon` running in its own terminal. Check: `curl -X POST http://127.0.0.1:5001/api/v0/version`. Publishing and Studio ▸ Deploy both need it. |
| MetaMask shows a transaction as *Failed* but the asset page says ✓ (ETH moved, the track plays) | MetaMask's history had a confirmed transaction with the same nonce from an earlier chain. Fixed for new chains (test accounts start at fresh nonces); for old entries: MetaMask ▸ Settings ▸ Advanced ▸ *Clear activity tab data*, for each account. |
| "MetaMask still remembers the previous chain" | Hardhat was restarted: MetaMask ▸ Settings ▸ Advanced ▸ *Clear activity tab data*, then retry. |
| `Contract call: Mpeg21ScmFactory#<unrecognized-selector>` … `Error: Transaction reverted without a reason` (or `NFToken#tokenURI … invalid token ID`, `<UnrecognizedContract> … StackOverflow`) in the chain log | Harmless: read-only `eth_call`s from MetaMask probing the contract it's about to call (or NFTs it remembers from an earlier chain) for token standards. Nothing is sent or mined, and `From: 0xf39f…` is only Hardhat's default for calls without a sender. `./dmaf.sh` hides them; a failed **transaction** shows under `eth_sendRawTransaction` with an `Error:` line after its block. |
| "Can't reach the local chain" | `npm run chain` isn't running (or was restarted without `npm run deploy`). |
| *ISO/IEC 21000-23 API ✕ Not loaded* | `npm install`, then restart `npm run serve`. Plays still work by direct split meanwhile. |
| `✕ ffmpeg …` or "ffmpeg isn't usable" in the Studio | Install ffmpeg with MP3 support (`brew install ffmpeg`), or point `FFMPEG` / `FFPROBE` at the binaries, then restart `npm run serve`. |
| "not on the dev server" next to a stem | It was delivered in demo mode or another session: choose the file again. |
| "Demo sign-in. PostgreSQL isn't configured…" on the sign-in page | Set `DATABASE_URL` and restart `npm run serve` — [docs/DATABASE.md](docs/DATABASE.md) has the fixes for each database message. |
| The menu shows only *Discover*; Studio/Publish links open *Sign in* | You're signed out — sign in, and you go straight back to the page you wanted. |
| "Your session has ended — sign in again" | The session cookie expired (30 days) or you signed out in another tab: sign in again. |
| `401 … Sign in to DMAF first` from `curl` or a script | With PostgreSQL on, the Studio, IPFS-upload and `/api` write calls need a session — use the app, or `npm run scm` for the API alone. |
| My Library doesn't list a file you uploaded | Only uploads made while signed in (with PostgreSQL) are recorded. |
| MetaMask shows only the Producer and Listener; the parties' payouts are nowhere | MetaMask only shows accounts you import: import #3–#8 by private key (*MetaMask* table above). Its own *Account 3…7* are different wallets. Check with *Access log ▸ Verify* or `npm run verify:payouts`. |
| The creator's share is paid to the Listener (#2) | The agreement was started while MetaMask was on the Listener, so the creator got that wallet. Start a new agreement on the Producer (#1) — or sign in with a linked payout wallet — check the wallets under Parties, register and publish again. Plays already paid can't be redirected. |

The browser console (`[DMAF]` lines) has the full underlying error for anything else.

### PoC limits and next steps

* **Access control is app-level.** IPFS content is public to anyone with the CID (it's in the
  contract and metadata). Real gating: encrypt the MP3 before upload and release the key only
  after an `Accessed` event (e.g. Lit Protocol conditions on `playsBy`, or a key server).
* **The interactive player (`#/player`) and DASH are still simulated.** The IMAF file is real and on
  IPFS, but the in-app player doesn't play it yet: next is a Web Audio player that loads its tracks and
  applies the presets and rules, and ffmpeg DASH renditions of the mix.
* **Signatures are still mocked.** Registration is real (the agreement becomes an ISO/IEC 21000-23
  Smart Contract for Media), but the parties' signatures aren't collected. Next: EIP-712 signatures
  from each party (the MCO `signature` / `isSignedBy` fields are ready for them).
* **Gas** — the first play of an asset with 7 payees costs ≈480k gas through `payTo` and ≈315k by direct split;
  later plays ≈310k / ≈265k. Deploying Night Signals' contract (19 deontic + 6 object NFTs) costs ≈5.5M gas, a
  one-party one ≈1.5M; the direct split deploys nothing.
* **Contract wallets** can't be `payTo` payees: the standard's `payTo` uses `transfer()` (2 300 gas). The
  registry refuses such Smart Contracts for Media up front, and Publish uses the direct split for them.
* **Pinning** — files live on your local node only; use a pinning service for others to fetch them.

### Files

`docs/` — guides (editing text, database, stems/IMAF) ·
`mpeg21/` — ISO/IEC 21000-23 library (parser, generator, specification, Ethereum deploy/parse), the standard's
OpenAPI, conformance tests and report · `server/` — the OpenAPI server, the CEL bridge, accounts (`auth.mjs`, `db.mjs`),
the IPFS library (`library.mjs`), stem packaging (`stems.mjs`, `imaf.mjs`) ·
`services/cel-server/` — patched MPEG-21 CEL Server (Python) · `chain/` — contracts, tests, deploy script ·
`tools/` — dev server, standalone API server, CEL launcher, template generator, payout checker (`verify-payouts.mjs`) · `js/scm.js` — browser side of the
forward/backward conversion · `js/web3.js` (MetaMask, registry, IPFS) · `js/media.js` (Publish, Discover, Asset,
Royalties) · `js/agreement.js` (Studio) · `js/account.js` (sign-in) · `js/library.js` (My Library's IPFS files) ·
`js/stemviz.js` (stem visualiser) · `js/payout-check.mjs` (balance check behind *Verify* and `npm run verify:payouts`) · `js/chain-config.js` (generated) · `js/vendor/ethers.umd.min.js`
(ethers 6.17, MIT) · `samples/night-signals-demo.mp3` (generated test tone, free to use).
