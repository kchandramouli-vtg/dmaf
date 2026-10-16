"""MPEG-21 CEL Server (ISO/IEC 21000-23 reference software), patched for DMAF.

Endpoints (same as the reference):
  POST /parse    text/plain CEL XML  -> CEL contract model (JSON)
  POST /deploy   text/plain CEL XML  -> deploys MediaToken + Cel on the chain
  POST /reverse  ?contractId&contract_address -> {"xml": CEL XML read back from the chain}
  POST /tezos-deploy                 -> SmartPy links for the six use cases (unchanged)
DMAF additions:
  GET  /health                       -> {"ok": true, "chain": …}
  POST /deploy?bindings={"licensor": "0x…", …}  party id -> wallet overrides

What changed from the reference, and why, is listed in mpeg21/CONFORMANCE.md
(section "CEL Server"). In short: it no longer needs a running chain to start,
reverse_Alex*.py (not shipped with the reference) are not imported, web3 v6,
precompiled contracts instead of downloading solc per request, and the XML
parsing defect that dropped every Subject/Issuer/Address (empty elements are
falsy in ElementTree) is fixed.

Run:  python main.py            (env: RPC_URL, CEL_PORT=5000, CEL_ARTIFACTS)
"""
import json
import os
from enum import Enum
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import Body, FastAPI, HTTPException
from fastapi.encoders import jsonable_encoder
from pydantic.main import BaseModel
from pydantic.types import Json
from starlette.responses import JSONResponse
from web3 import Web3

from bindings import set_bindings
from models.Contract import Contract
from reverse import generateCELconytract

app = FastAPI(title="MPEG-21 CEL Server (DMAF)")

TOTAL_SUPPLY = 10000  # maximum number of tokens
RPC_URL = os.environ.get("RPC_URL", "http://127.0.0.1:8545")
_w3 = None


def w3():
    """Connect lazily: the reference connected (and read accounts) at import time,
    so the server could not start without a chain."""
    global _w3
    if _w3 is None or not _w3.is_connected():
        _w3 = Web3(Web3.HTTPProvider(RPC_URL))
        if not _w3.is_connected():
            raise HTTPException(503, f"Can't reach the Ethereum node at {RPC_URL} - is `npm run chain` running?")
    return _w3


class DeployOut(BaseModel):
    contract_address: str
    media_token_address: str
    details: Json


class XMLContract(BaseModel):
    xml: str


class TezosDeployOut(BaseModel):
    mco: Contract
    link: Path
    details: Path


links = {
    "Download big label": Path("https://smartpy.io/ide?cid=Qma8ECvWkD7chbzrkqtzags5u2xwZZJ9PyDLt1sPhn82oV&k=a25667d5b2e04e8e983c"),
    "Download small label": Path("https://smartpy.io/ide?cid=QmbJyjs2WfAi8Dxo8eDAVCYMC2C53WQrppuSfvD9CB7qWi&k=264229eda720974ce0ee"),
    "Download no label": Path("https://smartpy.io/ide?cid=QmXDA5wCTTSa3TmFLx93qQz7ZpK4y7YXtBvxvFFFQjqdfj&k=3a0779f1247de60d5f29"),
    "Stream big label": Path("https://smartpy.io/ide?cid=QmbiREA4V7CQGQYxKtfx6SN8J2fcfgHteMRpt149mgiK7d&k=2e56fa9ae7e349ded3f2"),
    "Stream small label": Path("https://smartpy.io/ide?cid=QmQy7K4vowQpEbvZhamWX5u91Ve4i5foDCuxHgGa4r8tsE&k=2fda33493e0b0a0680af"),
    "Stream no label": Path("https://smartpy.io/ide?cid=QmTcfXt7z9yv3ARX2cbsBvRC34RsL4xUsNcio3kDaXqViW&k=31febcbbca303b206945"),
}


def _parse(ttext):
    try:
        contract = Contract(**{"data": ttext})
        contract.parse()
        return contract
    except HTTPException:
        raise
    except Exception as e:  # reference: 500 with a traceback
        raise HTTPException(400, f"Invalid CEL contract: {type(e).__name__}: {e}")


@app.get("/health")
def health():
    try:
        chain = {"ok": True, "chainId": w3().eth.chain_id, "rpc": RPC_URL}
    except HTTPException as e:
        chain = {"ok": False, "error": e.detail}
    return {"ok": True, "chain": chain}


@app.post("/parse", response_model=Contract)
async def info(ttext: str = Body(..., media_type="text/plain")):
    contract = _parse(ttext)
    json_compatible = jsonable_encoder(contract, exclude_defaults=True, exclude_none=True, exclude=["data", "namespace"])
    return JSONResponse(json_compatible)


@app.post("/deploy", response_model=DeployOut)
async def deployEthereum(ttext: str = Body(..., media_type="text/plain"), bindings: Optional[str] = None):
    contract = _parse(ttext)
    try:
        set_bindings(json.loads(bindings) if bindings else {})
    except ValueError:
        raise HTTPException(400, "bindings must be a JSON object {partyId: address}")
    contract_address, media_token_address, details = contract.toEthereum(
        w3(), TOTAL_SUPPLY, "Ethereum_Media_Token.sol", "Ethereum_Smart.sol"
    )
    result = DeployOut(**{"contract_address": contract_address, "media_token_address": media_token_address,
                          "details": json.dumps(details, default=str)})
    return JSONResponse(jsonable_encoder(result))


@app.post("/reverse", response_model=XMLContract)
async def reverse(contractId: str, contract_address: str):
    try:
        address = Web3.to_checksum_address(contract_address)
    except ValueError:
        raise HTTPException(400, "invalid Ethereum address")
    xml = generateCELconytract(w3=w3(), contractId=contractId, contract_address=address)
    return XMLContract(**{"xml": xml.decode("utf8") if isinstance(xml, bytes) else xml})


@app.post("/tezos-deploy", response_model=TezosDeployOut)
async def tezosDeploy(ttext: str = Body(..., media_type="text/plain")):
    contract = _parse(ttext)
    link = links.get(contract.contractId, Path("https://smartpy.io/ide?cid=QmcMuL44m4ijwqgNjSX12cbMnBpJbg9twEQLCyLFPacSrg&k=f3ffb67ff7402a6aa5ab"))
    details = "https://link/to/future/online/document"
    result = TezosDeployOut(**{"mco": contract, "link": link, "details": details})
    return JSONResponse(jsonable_encoder(result, exclude_defaults=True, exclude_none=True, exclude=["data", "namespace"]))


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("CEL_PORT", "5000")))
