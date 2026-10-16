"""Compiled CEL contracts (Cel in Ethereum_Smart.sol, MediaToken in
Ethereum_Media_Token.sol).

The reference CEL Server compiled them with py-solc-x at request time, which
downloads solc 0.7.6 on first use. DMAF compiles them with Hardhat
(`npm run compile`, solc 0.7.6, chain/contracts/cel/) and loads the artifacts.
py-solc-x is still used if it is installed and no artifact is found."""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "chain", "artifacts", "chain", "contracts", "cel"))


def load_artifact(source_file, contract_name):
    base = os.path.basename(source_file)
    if base.endswith(".json"):
        base = base[:-5] + ".sol"
    art_dir = os.environ.get("CEL_ARTIFACTS", DEFAULT_DIR)
    path = os.path.join(art_dir, base, contract_name + ".json")
    if os.path.exists(path):
        with open(path) as f:
            a = json.load(f)
        return {"abi": a["abi"], "bytecode": a["bytecode"]}
    try:
        import solcx  # reference behaviour
    except ImportError:
        raise RuntimeError(
            f"No compiled artifact at {path}. Run `npm run compile` in the DMAF folder "
            f"(or set CEL_ARTIFACTS), or `pip install py-solc-x`."
        )
    solcx.install_solc("0.7.6")
    out = solcx.compile_files([os.path.join(HERE, base)], output_values=["abi", "bin"], solc_version="0.7.6")
    key = next(k for k in out if k.endswith(":" + contract_name))
    return {"abi": out[key]["abi"], "bytecode": out[key]["bin"]}
