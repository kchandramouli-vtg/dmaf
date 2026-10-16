# MPEG-21 CEL Server (ISO/IEC 21000-23 reference software, patched for DMAF)

CEL (ISO/IEC 21000-20, XML) ↔ Ethereum, as in the reference "MPEG-21 CEL Server", with the defects that stopped
it from starting or silently dropped clause data fixed. Every change is listed in `mpeg21/CONFORMANCE.md`
(section "CEL Server") and marked `DMAF:` in the code.

```
npm run cel:setup      # once: python3 -m venv .venv && pip install -r requirements.txt
npm run compile        # once: Hardhat compiles Cel / MediaToken (solc 0.7.6) into chain/artifacts
npm run cel            # http://127.0.0.1:5000  (env: RPC_URL, CEL_PORT, CEL_ARTIFACTS)
```

| Endpoint | |
|---|---|
| `POST /parse` (text/plain CEL XML) | CEL contract model (JSON) |
| `POST /deploy[?bindings={"licensor":"0x…"}]` | Deploys `MediaToken` + `Cel` and writes every clause on-chain |
| `POST /reverse?contractId=…&contract_address=0x…` | `{"xml": …}` — CEL rebuilt from the chain |
| `GET /health` | Server + chain status |

DMAF's OpenAPI server uses it for `POST /api/parser/cel` and exposes `/api/x-dmaf/cel/deploy` and
`/api/x-dmaf/cel/reverse`. The templates in `cel/` are the standard's.
