/* ============================================================
   Payout check — independent proof that a paid play moved the ETH it claims.

   For one access() transaction it compares, for every wallet involved, the
   balance in the block just before the play with the balance just after it
   (the chain's own state — not the app's events), against what the play
   should have done:
     · each payee receives exactly its Payout amount,
     · the listener pays the price + the gas for the transaction,
     · the registry and the Smart Contract for Media keep nothing
       (except direct-split payouts held for withdraw()),
     · the payouts add up to the price, and match the split the contract
       computes for that amount (previewSplit at the block before).

   Used by the asset page (js/media.js, "Verify" in the access log) and by
   `npm run verify:payouts` (tools/verify-payouts.mjs). No imports: pass ethers in.
   ============================================================ */

/**
 * @param {{ ethers: object, provider: object, registry: object, txHash: string }} o
 *        registry: an ethers Contract for DmafMediaRegistry connected to `provider`
 */
export async function checkPlay({ ethers, provider, registry, txHash }) {
  const [rc, tx] = await Promise.all([provider.getTransactionReceipt(txHash), provider.getTransaction(txHash)]);
  if (!rc) throw new Error(`No transaction ${txHash} on this chain (was the chain restarted?)`);
  const regAddr = (await registry.getAddress()).toLowerCase();
  const events = rc.logs.filter(l => l.address.toLowerCase() === regAddr)
    .map(l => { try { return registry.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
  const acc = events.find(e => e.name === "Accessed");
  if (!acc) throw new Error("That transaction isn't a paid play (no Accessed event)");
  const block = rc.blockNumber, before = block - 1;
  const assetId = acc.args.assetId, paid = acc.args.amount, listener = acc.args.listener;
  const gasPrice = rc.gasPrice ?? rc.effectiveGasPrice ?? tx.gasPrice ?? 0n;
  const gasCost = rc.gasUsed * gasPrice;
  const asset = await registry.getAsset(assetId, { blockTag: block });
  const scm = asset.scm && asset.scm !== ethers.ZeroAddress ? asset.scm : null;
  const payouts = events.filter(e => e.name === "Payout");
  const deferred = events.filter(e => e.name === "PayoutDeferred");

  // what each wallet's balance should have done in this block
  const exp = new Map(), roles = new Map();
  const add = (addr, v, role) => {
    const k = addr.toLowerCase();
    exp.set(k, (exp.get(k) || 0n) + v);
    if (role) roles.set(k, [...(roles.get(k) || []), role]);
  };
  for (const p of payouts) add(p.args.payee, p.args.amount, "payee");
  for (const d of deferred) add(d.args.payee, 0n, "payee (held)");
  add(listener, -(paid + gasCost), "listener");
  add(regAddr, deferred.reduce((s, d) => s + d.args.amount, 0n), "registry");
  if (scm) add(scm, 0n, "Smart Contract for Media");

  const blockInfo = await provider.getBlock(block);
  const rows = await Promise.all([...exp.entries()].map(async ([addr, expected]) => {
    const [b0, b1] = await Promise.all([provider.getBalance(addr, before), provider.getBalance(addr, block)]);
    const actual = b1 - b0;
    const of = list => list.filter(p => p.args.payee.toLowerCase() === addr).reduce((s, p) => s + p.args.amount, 0n);
    const received = of(payouts), held = of(deferred);  // held: credited to the payee, kept by the registry for withdraw()
    return { address: ethers.getAddress(addr), roles: roles.get(addr) || [], expected, actual, ok: expected === actual,
      received, held, share: paid > 0n ? Number(((received + held) * 1_000_000n) / paid) / 10_000 : 0 };
  }));

  // the split the contract itself computes for this price, just before the play
  const sum = (list, key) => list.reduce((s, e) => s + e.args[key], 0n);
  const totalOut = sum(payouts, "amount") + sum(deferred, "amount");
  let splitOk = null, splitDiff = [];
  try {
    const [accts, amts] = await registry.previewSplit(assetId, paid, { blockTag: before });
    const want = new Map();
    accts.forEach((a, i) => want.set(a.toLowerCase(), (want.get(a.toLowerCase()) || 0n) + amts[i]));
    const got = new Map();
    [...payouts, ...deferred].forEach(p => { const k = p.args.payee.toLowerCase(); got.set(k, (got.get(k) || 0n) + p.args.amount); });
    for (const k of new Set([...want.keys(), ...got.keys()])) {
      if ((want.get(k) || 0n) !== (got.get(k) || 0n)) splitDiff.push({ address: k, expected: want.get(k) || 0n, paid: got.get(k) || 0n });
    }
    splitOk = splitDiff.length === 0;
  } catch { /* previewSplit isn't in older registries */ }

  const got = r => r.received + r.held;
  rows.sort((a, b) => (got(b) > got(a) ? 1 : got(b) < got(a) ? -1 : 0));
  const balancesOk = rows.every(r => r.ok);
  const sumOk = totalOut === paid;
  return {
    txHash, block, assetId: Number(assetId), playNo: Number(acc.args.playNo), listener, paid, gasCost,
    mode: scm ? "scm" : "direct", scm, rows, totalOut, sumOk, splitOk, splitDiff,
    otherTxsInBlock: Math.max(0, (blockInfo?.transactions?.length || 1) - 1),
    ok: balancesOk && sumOk && splitOk !== false,
  };
}
