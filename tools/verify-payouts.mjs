#!/usr/bin/env node
/* Verify that paid plays moved the ETH they should have, straight from the chain.

     npm run verify:payouts            every play of every asset
     npm run verify:payouts -- 3       every play of asset #3
     npm run verify:payouts -- 0x…     one play, by its transaction hash

   For each play it compares every wallet's balance in the block before and the
   block of the play with what the play should have done (js/payout-check.mjs):
   payees get exactly their share, the listener pays price + gas, the contracts
   keep nothing, and the payouts add up to the price and match the contract's
   split. Exit code 1 if anything doesn't match.
   Env: RPC_URL (default: js/chain-config.js) · IPFS_GATEWAY (party names from the metadata, default http://127.0.0.1:8080) */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { checkPlay } from "../js/payout-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfgText = fs.readFileSync(path.join(ROOT, "js", "chain-config.js"), "utf8");
const CFG = JSON.parse(cfgText.slice(cfgText.indexOf("{"), cfgText.lastIndexOf("}") + 1));
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || CFG.rpcUrl, CFG.chainId, { staticNetwork: true });
const registry = new ethers.Contract(CFG.address, CFG.abi, provider);
const GATEWAY = process.env.IPFS_GATEWAY || "http://127.0.0.1:8080";

const mnemonic = ethers.Mnemonic.fromPhrase("test test test test test test test test test test test junk");
const HARDHAT = new Map(Array.from({ length: 20 }, (_, i) => [ethers.HDNodeWallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/${i}`).address.toLowerCase(), i]));
const eth = v => v === 0n ? "0 ETH" : `${v < 0n ? "−" : "+"}${ethers.formatEther(v < 0n ? -v : v)} ETH`;
const short = a => `${a.slice(0, 6)}…${a.slice(-4)}`;
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const C = process.stdout.isTTY ? { ok: "\x1b[32m", bad: "\x1b[31m", dim: "\x1b[2m", off: "\x1b[0m" } : { ok: "", bad: "", dim: "", off: "" };

async function names(assetId) {
  try {
    const a = await registry.getAsset(assetId);
    const r = await fetch(`${GATEWAY}/ipfs/${a.metadataCid}`, { signal: AbortSignal.timeout(3000) });
    const m = await r.json();
    const map = new Map();
    for (const s of m.properties?.splits || []) {
      const k = String(s.wallet || "").toLowerCase();
      map.set(k, [...(map.get(k) || []), s.name || s.role].filter(Boolean));
    }
    return { title: m.name, map };
  } catch { return { title: null, map: new Map() }; }
}

function print(r, nm) {
  const who = a => {
    const k = a.toLowerCase(), hh = HARDHAT.has(k) ? `Hardhat #${HARDHAT.get(k)}` : "";
    if (k === CFG.address.toLowerCase()) return "DmafMediaRegistry";
    if (r.scm && k === r.scm.toLowerCase()) return "Smart Contract for Media";
    return [short(a), hh].filter(Boolean).join(" ");
  };
  console.log(`\n  Play #${r.playNo} · tx ${short(r.txHash)} · block ${r.block} · ${r.mode === "scm" ? `Contract.payTo of ${short(r.scm)}` : "direct split"}`);
  console.log(`  Listener ${who(r.listener)} paid ${ethers.formatEther(r.paid)} ETH + ${ethers.formatEther(r.gasCost)} ETH gas`);
  console.log(C.dim + `  ${pad("Wallet", 30)}${pad("Party", 42)}${pad("Share", 9)}${pad("Should change by", 26)}${pad("Balance changed by", 26)}` + C.off);
  const party = row => row.roles.map(x =>
      x === "payee" || x === "payee (held)" ? (nm.get(row.address.toLowerCase()) || ["payee"]).join(" + ") + (x === "payee (held)" ? " (held for withdraw)" : "")
      : x === "listener" ? "listener (pays price + gas)"
      : x === "registry" ? (row.expected > 0n ? "holds payouts for withdraw()" : "keeps nothing")
      : "keeps nothing (passes it all on)").join(" + ");
  for (const row of r.rows) {
    console.log(`  ${pad(who(row.address), 30)}${pad(party(row), 42)}${pad(row.received + row.held > 0n ? row.share.toFixed(2) + "%" : "", 9)}${pad(eth(row.expected), 26)}${pad(eth(row.actual), 26)}${row.ok ? C.ok + "✓" : C.bad + "✕"}${C.off}`);
  }
  const lines = [
    [r.sumOk, `payouts add up to the price (${ethers.formatEther(r.totalOut)} of ${ethers.formatEther(r.paid)} ETH)`],
    [r.rows.every(x => x.ok), r.rows.every(x => x.ok) ? "every balance moved exactly as the play says" : "some balances didn't move as the play says (✕ above)"],
    [r.splitOk, r.splitOk === null ? "split not checked (older registry)" : "the payouts match the split the contract computes for this price"],
  ];
  for (const [ok, t] of lines) console.log(`  ${ok === null ? "–" : ok ? C.ok + "✓" : C.bad + "✕"}${C.off} ${t}`);
  if (r.otherTxsInBlock) console.log(`  ${C.dim}(${r.otherTxsInBlock} other transaction(s) in this block — balance changes may include them)${C.off}`);
  const listenerAlsoPaid = r.rows.find(x => x.address.toLowerCase() === r.listener.toLowerCase() && x.received > 0n);
  if (listenerAlsoPaid) console.log(`  ${C.dim}note: the listener's wallet is also a payee (${listenerAlsoPaid.share.toFixed(2)}% came back to it)${C.off}`);
}

const arg = process.argv[2];
let plays = [];
const fromBlock = CFG.deployBlock || 0;
if (arg && /^0x[0-9a-fA-F]{64}$/.test(arg)) plays = [{ tx: arg }];
else {
  const n = Number(await registry.assetCount());
  const ids = arg ? [Number(arg)] : Array.from({ length: n }, (_, i) => i + 1);
  for (const id of ids) {
    if (!(id >= 1 && id <= n)) { console.error(`No asset #${arg} (the registry has ${n})`); process.exit(2); }
    const evs = await registry.queryFilter(registry.filters.Accessed(id), fromBlock, "latest");
    plays.push(...evs.filter(e => e.args.amount > 0n).map(e => ({ tx: e.transactionHash, id })));
  }
}
console.log(`DmafMediaRegistry ${CFG.address} · chain ${CFG.chainId} · ${plays.length} paid play${plays.length === 1 ? "" : "s"}`);
let bad = 0, lastId = null, nm = new Map();
for (const p of plays) {
  const r = await checkPlay({ ethers, provider, registry, txHash: p.tx });
  if (r.assetId !== lastId) {
    const n = await names(r.assetId); nm = n.map; lastId = r.assetId;
    console.log(`\nAsset #${r.assetId}${n.title ? ` “${n.title}”` : ""}`);
  }
  print(r, nm);
  if (!r.ok) bad++;
}
console.log(plays.length ? `\n${bad ? C.bad + `✕ ${bad} play(s) don't add up` : C.ok + `✓ all ${plays.length} play(s) check out`}${C.off}` : "\nNo paid plays yet.");
process.exit(bad ? 1 : 0);
