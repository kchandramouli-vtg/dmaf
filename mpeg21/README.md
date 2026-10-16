# mpeg21/ — ISO/IEC 21000-23 Smart Contracts for Media in DMAF

```
MCO (Turtle / JSON-LD) ──parser.mjs──► Media Contractual Objects ──scspec.mjs──► specification
        ▲                                    │        ▲                               │
        └──────────generator.mjs─────────────┘        │                        eth.mjs prepareDeployment
                                                      │                               ▼
                                     eth.mjs parseSmartContract ◄── Ethereum: NFToken + Contract (reference .sol)
```

| File | What it is | Reference counterpart |
|---|---|---|
| `lib/parser.mjs` | MCO → Media Contractual Objects (`POST /parser/mco`) | MPEG-21 MCO Parser |
| `lib/rdf.mjs` | Turtle (n3) / JSON-LD (jsonld.js) → RDF → the graph the parser walks | ttl2jsonld |
| `lib/generator.mjs` | Media Contractual Objects → MCO Turtle or JSON-LD (`GET /generator/mco/{id}`) | MPEG-21 MCO Generator |
| `lib/jsonld-profile.mjs` | The flat MCO JSON-LD profile DMAF writes; upgrades the older nested shape | — |
| `lib/scspec.mjs` | Objects → Smart Contract for Media specification (`GET /dlt/generate/{id}`) | `generateSmartContractSpecification` |
| `lib/eth.mjs` | Deploy (factory or one tx per token), parse (`POST /dlt/eth/parse/`), `payTo` simulation — ethers 6, browser + Node | `EthereumDeployer`, `EthereumParser` |
| `lib/offchain.mjs` | IPFS (Kubo) storage for token URIs and content | `OffChainStorage` |
| `lib/openapi.mjs` | Router + JSON Schema validator built from `openapi/openapi.yaml` | oas3-tools |
| `lib/vocab.mjs`, `lib/lut.mjs` | Namespaces, field models, the reference lookup tables (verbatim) | `lookup-tables/` |
| `openapi/openapi.yaml` | The standard's OpenAPI document, verbatim | `OpenAPI/openapi.yaml` |
| `test/` | Conformance suite, OpenAPI server tests, live CEL tests; fixtures = the standard's templates + the reference software's outputs; `reference/mco-parser` = the unmodified reference parser (oracle) | — |
| `CONFORMANCE.md` | Results, evidence, every deviation, defects found in the reference | — |

Parsing, generation and the specification are byte-compatible with the reference software on the standard's
template contracts; see `CONFORMANCE.md`. `lib/lut.mjs`, `test/reference/` and the reference contracts are
BSD-licensed (Universidad Politécnica de Madrid) — see `REFERENCE-LICENSE.txt`.
