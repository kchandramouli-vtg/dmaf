"""Party id → Ethereum address bindings for the CEL → Ethereum mapping.

The reference CEL Server hard-codes the four party ids of its templates to
Hardhat/Ganache accounts 2..5. DMAF keeps that as the default and lets a
deploy request override any of them (POST /deploy?bindings={...})."""
_overrides = {}


def set_bindings(bindings):
    _overrides.clear()
    _overrides.update(bindings or {})


def party_addresses(w3):
    accts = w3.eth.accounts
    default = {"licensor": accts[2], "licensee": accts[3], "revenue1": accts[4], "revenue2": accts[5]}
    default.update({k: w3.to_checksum_address(v) for k, v in _overrides.items()})
    return default
