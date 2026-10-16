# DMAF — ISO/IEC 21000-23 (Smart Contracts for Media) conformance report

**Date:** 2026-10-14 · **Yardstick:** the reference software and OpenAPI shipped with ISO/IEC 21000-23 ed. 1
(`ISO_IEC_21000-23_ed-1.zip`: MPEG-21 MCO OpenAPI Server, MPEG-21 CEL Server, OpenAPI, MCO Parser / Generator,
scmgenerator-dltmanager for Ethereum, template contracts).

The standard's normative text isn't part of the package, so "compliant" here means: the same interface
(OpenAPI paths, schemas, Media Contractual Objects, Solidity ABI) and the same results as the reference
software on the standard's own template contracts — with every place where DMAF differs listed below.

## Result

| Area | Reference component | DMAF | Evidence |
|---|---|---|---|
| OpenAPI | `OpenAPI/openapi.yaml` | Same file, verbatim (`mpeg21/openapi/openapi.yaml`). All **33** operations implemented (`server/scm-api.mjs`); reference server stubbed CEL and marked 26 sub-resource operations "(Not working)" | `api.test.mjs` — every operationId routed and implemented; bodies validated against the spec's schemas |
| MCO → Media Contractual Objects | MCO Parser (`POST /parser/mco`) | `mpeg21/lib/parser.mjs` | Output **byte-identical** (incl. key order) to the reference parser on all 6 standard templates, after removing two documented extensions |
| Media Contractual Objects → MCO | MCO Generator (`GET /generator/mco/{id}`) | `mpeg21/lib/generator.mjs` — Turtle and JSON-LD | Lossless round trip Turtle→objects→Turtle and →JSON-LD for all 6; the **unmodified reference parser** reads DMAF's Turtle back to the reference objects |
| Objects → smart contract specification | `generateSmartContractSpecification` (`GET /dlt/generate/{id}`) | `mpeg21/lib/scspec.mjs` | Output **byte-identical** to the reference (incl. the keccak256 hash) for all 6 |
| Forward conversion on Ethereum | `EthereumDeployer`, `Contract.sol`, `NFToken.sol` | Reference `.sol` files **byte for byte** (`chain/contracts/mpeg21/`, sha256 below) + `Mpeg21ScmFactory` (same calls, one transaction) + `mpeg21/lib/eth.mjs` | One NFT per deontic/object minted to the bound party, token URIs = the reference JSON, income percentages on-chain = MCO payment obligations, for all 6 |
| Backward conversion on Ethereum | `EthereumParser` (`POST /dlt/eth/parse/`) | `mpeg21/lib/eth.mjs` `parseSmartContract` | Deploy → parse returns the **same Media Contractual Objects** for all 6; same result for the reference one-tx-per-token deployment |
| Interop with the reference itself | — | — | **Unmodified reference EthereumParser** (web3 1.x) reading a DMAF-deployed contract → identical objects. **DMAF parser** reading a contract deployed by the **unmodified reference EthereumDeployer** → identical objects (and flags the reference's content-hash defect) |
| Settlement | `Contract.payTo` | Every paid play of an asset linked to a Smart Contract for Media calls its `payTo` (agreements `payTo` can't settle use the registry's direct split — not part of the standard, see below) | Balances move exactly as `payTo`'s integer arithmetic says, for all 6; Night Signals = DSP 39 %, label 38.25 %, aggregator 7.5 %, publisher 5 %, mech. agent 5 %, author 4.25 %, PRO 1 % |
| CEL → objects / objects → CEL | CEL Server `/parse` (`POST /parser/cel`, `GET /generator/cel/{id}`) | `server/cel-bridge.mjs` + patched CEL Server | CEL → objects → CEL → objects equal for all 6 CEL templates, through the live CEL Server |
| CEL on Ethereum | CEL Server `/deploy`, `/reverse` (`Cel`, `MediaToken`, solc 0.7.6) | `services/cel-server/` (patched), reference Solidity compiled by Hardhat | CEL → `Cel` contract → CEL keeps every clause, party and title, for all 6 |
| Algorand (TEAL) | `POST /dlt/algo/parse/` | **Not supported** — returns 501 | DMAF targets Ethereum |

Tests: `npm test` → 57 Hardhat tests (`chain/test/`) + 84 Node tests (`mpeg21/test/`; the 12 CEL live tests skip
unless `npm run chain` and `npm run cel` are running). All 141 pass.

Reference contracts, unchanged (sha256):

```
dcb21180d6b5a2f784f52dc2f84936f555aad1c243c8d056ca51fe8a9c2fd5fa  chain/contracts/mpeg21/Contract.sol
c9428b36ad3befc3a1f9d6155ea0e284b263a08eebb1a456b9ed0fff8b72ef2e  chain/contracts/mpeg21/NFToken.sol
b6a285672cb31c065da4ce4cc42390fad22df03e160d2010e6a1a22f37e7b95a  chain/contracts/mpeg21/EnumerableMapAddressToUint.sol
```

Compiled with solc 0.8.28 and OpenZeppelin 4.9.6 (the reference used 0.8.3 / OZ ^4.0.0; OZ 5 removed
`Counters` and `SafeMath`, which the reference needs).

## Where DMAF differs from the reference software

Same interface, defects fixed. Each item is tagged in the code.

### Parser — `mpeg21/lib/parser.mjs`

| Tag | Reference behaviour | DMAF |
|---|---|---|
| FIX 1 | Matches prefix *names* from ttl2jsonld, so any other prefix, or any JSON-LD, fails | Works on IRIs; Turtle or JSON-LD, any prefixes |
| FIX 2 | Class = first `rdf:type` written | Most specific known type (RDF has no type order) |
| FIX 3 | Untyped/unknown node → `TypeError`; *any* such node in the graph breaks parsing | Ignored unless referenced; a referenced one is a 400 naming the IRI |
| FIX 4 | Deontic expressions need `mco-core:issuedIn` | Also linked through `mco-core:issues`, or to the only contract |
| FIX 5 | Constraints, text clauses, resulting objects → `ReferenceError: parentContractId` | Followed |
| FIX 6 | Facts parsed with the Action table (every fact property dropped); Interval/Timeline with the Track table; `DeliverModality` typo | Right tables |
| FIX 7 | `belongsToCollective` iterates `actOnBehalfOf`; `sellsDeontic` → `ReferenceError` | Fixed |
| FIX 8 | Party properties matched case-sensitively, everything else case-insensitively | Case-insensitive throughout |
| FIX 9 | `signatories` turned into a map | Array of ids (OpenAPI) |
| FIX 10 | The standard's templates spell `mco-pane:hasCurency`; the reference drops **every currency** | Both spellings read as `currency` *(extension)* |
| FIX 11 | Non-table properties kept for some classes, dropped for others (every action's `rdfs:label`) | Kept in `metadata` for every class *(extension: Action/Fact `metadata`, allowed by the schemas)* |
| FIX 12 | Metadata values raw (objects/arrays) | Strings, per `WithMetadata` |

The byte-identical comparison removes exactly the FIX 10/11 additions (`actions.*.metadata`, `actions.*.currency`).

### Generator — `mpeg21/lib/generator.mjs`

| Tag | Reference | DMAF |
|---|---|---|
| GEN 1 | Writes lower-case IRIs (`mco-core:hasparty`, `mvco:distributor`) — not MCO terms; its own parser can't read them back (shown in `conformance.test.mjs`) | Ontology spelling (`mco-core:hasParty`, `mvco:Distributor`; MVCO actions lower-camel as in the standard's templates) |
| GEN 2 | rdflib auto-prefixes (`mpe:`, `mvc:`, `@prefix : </#>`) | Standard prefixes |
| GEN 3 | Numbers as strings (`"19"`) | Typed literals |
| GEN 4 | Facts and text clauses dropped | Written |
| GEN 5 | Invents `mco-core:actedover` on deontics | Object links carried by the action (`mvco:actedOver`) |
| GEN 6 | — | Parties keep `mco-core:Party` beside their role, as in the templates |
| — | Turtle only | Also the flat MCO JSON-LD profile (`Accept: application/ld+json`) |

### Specification — `mpeg21/lib/scspec.mjs`

Reference keys and values unchanged (byte-identical); additions only under `"x-dmaf"`.

| Tag | Reference | DMAF |
|---|---|---|
| SPEC 1 | `parties` always `""` | Wallet bindings filled when known (`dmaf:wallet` metadata) |
| SPEC 2 | Object receiver read from `rightsOwners` only | Also OpenAPI `rightsOwner` |
| SPEC 3 | Two payments actor→beneficiary: last one wins | Added up (with a warning) |
| SPEC 4 | Problems surface as failed transactions | `x-dmaf.errors`: non-integer or >100 % percentages (Contract.sol stores whole percents), self-payments (would make `payTo` recurse forever) |

### Ethereum — `mpeg21/lib/eth.mjs`, `chain/contracts/Mpeg21ScmFactory.sol`

| Tag | Reference | DMAF |
|---|---|---|
| ETH 1 | `identifier` = the literal string `"identifier"` for every contract | UTF-8 bytes of the contract IRI |
| ETH 2 | `contentHash` overwritten with the IPFS CID's ASCII | keccak256 of the content JSON (the spec's `hash`); parse checks it |
| ETH 3 | NFToken address read from a build artifact for one fixed network | Read from the contract's `_nfToken()` |
| ETH 4 | Unbound parties → encoding error | Bound to the deployer (publisher) |
| ETH 5 | Contract relations never written | Written when the target is an Ethereum address |
| ETH 6 | — | Parse also returns bindings, token owners, income map, hash check (extension endpoint `POST /api/x-dmaf/eth/inspect`; the standard endpoint returns only the Contract object) |
| — | deontics + objects + 1 transactions | `Mpeg21ScmFactory.deploy` makes the same calls in one; the per-token path is kept (`deployLikeReference`) and tested equal |
| — | Reference `getIncomePercentagesBy` reverts `"Empty Map"` for a party that shares no income | Treated as "no beneficiaries" everywhere DMAF reads it |

Token URIs and `_contentUri` stay bare IPFS CIDs, as the reference parser expects.

### Pay-per-play — `chain/contracts/DmafMediaRegistry.sol`

Not part of the standard; it routes plays into it. Each asset settles one of two ways, fixed at `registerAsset(input, payees)`:

**Smart Contract for Media** (`input.scm` ≠ 0, `payees` empty). `access()` calls `Contract.payTo{value: price}(entry, price)`,
where `entry` is the beneficiary of the end user's `mco-pane:Payment` in the agreement. `registerAsset()` only accepts
a contract whose runtime code hash is the reference `Contract`'s (so an asset can't point at look-alike code that
splits differently), and refuses one whose cascade `payTo` can't settle: the entry not a party, a contract wallet in
the cascade (`payTo` uses `transfer()`'s 2 300 gas), cycles, or a party paying out more than 100 %. It mirrors `payTo`'s arithmetic to emit one
`Payout` event per wallet (royalties read those), with the wallet's share in basis points. The standard contract
decides who gets what. Gas: ~480 k for the first play of an asset, ~310 k after (7-party cascade); deploying a 25-NFT contract ~5.5 M.

**Direct split** (`input.scm` = 0) — the original DMAF PoC's settlement, kept so that every agreement can be paid
per play: 1–16 payees (wallet, basis points summing to 10 000, MCO role) computed in the browser from the agreement's
payment obligations (each party's net share of one consumer payment). `access()` pushes each share with 50 000 gas;
a payee that reverts is credited to `pendingWithdrawals` (`PayoutDeferred`) and pulls it with `withdraw()`.
Publish uses it when `payTo` can't settle the agreement — parties that would share a wallet (incl. parties without a
wallet, which are paid through the publisher), a contract wallet, fractional percentages — when the ISO/IEC
21000-23 API isn't running, or when the user picks it. The asset's MCO agreement is still pinned on IPFS with its
keccak256 on-chain; there is just no Smart Contract for Media behind the asset. For Night Signals both ways pay the
same shares. Gas: ~315 k first play, ~265 k after (7 payees).

### OpenAPI server — `server/scm-api.mjs`

- Same paths, request bodies and response shapes. Error bodies keep the reference's `{errorType}` and add `message`.
- `POST /contracts/` and sub-resource POSTs are validated against the spec's schemas (reference: none). For
  polymorphic bodies (`party`, `deontic`, `action`, `object`, `fact`) the base schema is used: the spec's `oneOf`s
  overlap (e.g. any MCOUser also matches CELPerson), so a strict `oneOf` would reject every valid body.
- `POST /parser/mco` also accepts JSON-LD (`application/ld+json`); `GET /generator/mco/{id}` returns JSON-LD with
  `Accept: application/ld+json`.
- Mounted at `/api` by `npm run serve`; standalone `npm run scm` on :8081 (the spec's `localhost:8080/api` clashes
  with the IPFS gateway).
- Extensions under `/api/x-dmaf/…` only: `eth/inspect`, `mco/jsonld`, `cel/deploy`, `cel/reverse`, `status`.

### CEL Server — `services/cel-server/` (patched copy of "MPEG-21 CEL Server")

| Reference | Patched |
|---|---|
| Imports `reverse_Alex*.py`, not shipped → doesn't start | Removed (with `/infoAlex`) |
| Connects to the chain and reads accounts at import → can't start without a node | Lazy connection, 503 when the chain is down |
| `if element:` on ElementTree elements — empty elements are falsy, so **every Subject, Issuer, Address** etc. was dropped (49 places) | `is not None` |
| Runs `number` check on children instead of attributes | Fixed |
| Acts other than possessProperty/Provide/Payment left unparsed ("todo") | Recorded by element name |
| Downloads solc 0.7.6 per request (py-solc-x); `NameError` when an artifact was passed | Precompiled artifacts (`npm run compile`), py-solc-x only as fallback |
| web3 5 camelCase API | web3 6 |
| Party ids → wallets hard-coded (licensor/licensee/revenue1/revenue2 → accounts 2–5) | Same default, overridable per deploy |
| `/reverse` loses TextVersion/Metadata (its own parser then crashes), writes `rel-r:PossessProperty` and `cel-core:Permission` (its parser reads `possessProperty`, `cel-ipre:Permission`) → permissions vanished | Fixed: reverse output re-parses to the same clauses |

The reference has no Media Contractual Objects ↔ CEL mapping; `server/cel-bridge.mjs` maps the CEL Server's parse
model to the OpenAPI Contract schema (CELPerson/Organization, CELPermission/Obligation/Prohibition/StatementSimple,
Payment/Provide/PossessProperty actions, Items, DeliveryModality/AccessPolicy/Runs/Language/… facts) and writes CEL
XML back in the element structure the CEL Server parses.

### Studio JSON-LD and templates

- The agreement export is now the flat MCO JSON-LD profile (`mpeg21/lib/jsonld-profile.mjs`), RDF-equivalent to the
  standard's Turtle templates. The earlier nested export used `mco-core:issues` (the parser follows `issuedIn`),
  repeated `@id`s for different deontics (RDF merges them), undefined types (`mvco-ipre:provideMaterial`,
  `mco-ipre:Payment`, `mvco:play`), an `actedTo` key the @context doesn't define (silently dropped) and the
  `hasCurency` typo. `upgradeLegacyJsonLd()` still reads that shape.
- `js/mco-templates.js` is generated from the standard's Turtle templates through the parser (`npm run templates`).

## Defects in the standard's own material

Found while testing; worth reporting to the editors.

1. JSON-LD templates: duplicate `@id`s for different deontics (e.g. three `permission1`), undefined prefix
   `mvco-ipre:`, `mvco:play` (not in the parser's tables), `actedTo` outside the @context, `hasCurrency` → `mco-pane:hasCurency`.
2. Turtle templates: `<mco-core:Provide>` written as an IRI (scheme `mco-core:`), `hasCurency` misspelt (currencies lost).
3. JSON-LD vs Turtle download templates disagree on one obligation's issuer (DigitalSale vs RecordLabel). Payments agree.
4. CEL templates: payment obligations whose Subject is also the Beneficiary (a party paying itself).
5. OpenAPI: `FactTypeEnum` has `FactCoposition` (parser emits `FactComposition`); responses reference schemas
   directly (`$ref: '#/components/schemas/partyIdref'` under `responses`); overlapping `oneOf`s (see above).
6. Reference generator output is not valid MCO (GEN 1) and its parser can't read it.
7. `Contract.getIncomePercentagesBy` reverts for parties without shares; `Contract.payTo` doesn't check
   `msg.value` (DMAF's registry always sends exactly `amount`, so nothing is left in the contract).

## Not covered

- Algorand/TEAL and Tezos/Michelson conversions (`/dlt/algo/parse/` → 501).
- AVCO's namespace isn't declared anywhere in the reference software; DMAF assumes `urn:mpeg:mpeg21:avco:2018#`
  and honours a document's own `avco:` binding.
- CEL operations need the Python CEL Server (`npm run cel:setup`, `npm run cel`).

## Re-running

```
npm test                      # Hardhat + Node suites
npm run chain & npm run cel   # then npm run test:mpeg21 also runs the 12 live CEL tests
```

The golden files in `mpeg21/test/fixtures/reference-output/` were produced by running the unmodified reference
software on `mpeg21/test/fixtures/standard/`. `mpeg21/test/reference/mco-parser/` is the unmodified reference parser,
used as an oracle.
