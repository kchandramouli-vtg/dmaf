/* ============================================================
   Media Contractual Objects → Smart Contract for Media specification
   (ISO/IEC 21000-23, GET /dlt/generate/{contractIdref})

   Same output as the reference generateSmartContractSpecification()
   (scmgenerator-dltmanager/lib/generator.js): the deontic and object
   JSON that become NFT token URIs is built identically, so it is
   byte-for-byte the same text. Differences, tagged [SPEC n] and
   listed in mpeg21/CONFORMANCE.md:

    1  parties carry their wallet bindings when known (from the
       `bindings` argument or a party's dmaf:wallet metadata);
       reference: always "".
    2  an object's receiver also reads OpenAPI `rightsOwner`
       (reference reads only the parser's `rightsOwners`).
    3  two payments from the same actor to the same beneficiary add up
       (reference: the last one silently wins).
    4  problems that would break deployment or settlement are reported
       in "x-dmaf".warnings / errors instead of failing on-chain.
   Extensions live under "x-dmaf" only; reference keys are unchanged.
   Browser-safe: pass a keccak256(text) function (ethers.id).
   ============================================================ */

const isAddress = a => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

/** Party wallets declared in the contract itself (metadata "dmaf:wallet"). */
export function bindingsFromMetadata(contract) {
  const out = {};
  for (const [id, p] of Object.entries(contract.parties || {})) {
    const w = p?.metadata?.["dmaf:wallet"] || p?.metadata?.["https://dmaf.io/ns#wallet"];
    if (isAddress(w)) out[id] = w;
  }
  return out;
}

/**
 * @param {object} contractObj  one Media Contractual Objects contract
 * @param {{ keccak256: (text: string) => string, bindings?: Record<string,string> }} opts
 */
export function generateSmartContractSpecification(contractObj, { keccak256, bindings } = {}) {
  if (typeof keccak256 !== "function") throw new Error("generateSmartContractSpecification needs a keccak256(text) function");
  const clone = x => JSON.parse(JSON.stringify(x));
  const warnings = [], errors = [];
  const bind = { ...bindingsFromMetadata(contractObj), ...(bindings || {}) };
  const mediaSC = {};

  // Identifier
  mediaSC.identifier = contractObj.identifier;

  // Parties
  mediaSC.parties = {};
  Object.keys(contractObj.parties || {}).forEach(p => { mediaSC.parties[p] = bind[p] || ""; }); // [SPEC 1]

  // Deontic expressions: act (and impliesAlso) and constraints inlined — reference order of keys
  mediaSC.deontics = {};
  Object.keys(contractObj.deontics || {}).forEach(deonticId => {
    const tmpDeontic = clone(contractObj.deontics[deonticId]);
    const act = contractObj.actions?.[tmpDeontic.act];
    if (!act) errors.push(`Deontic expression ${deonticId} refers to action ${tmpDeontic.act}, which is not in the contract`);
    tmpDeontic.act = act ? clone(act) : tmpDeontic.act;
    if (act && tmpDeontic.act.impliesAlso !== undefined) {
      for (let i = 0; i < tmpDeontic.act.impliesAlso.length; i++) tmpDeontic.act.impliesAlso[i] = clone(contractObj.actions[tmpDeontic.act.impliesAlso[i]]);
    }
    if (tmpDeontic.constraints !== undefined) {
      for (let i = 0; i < tmpDeontic.constraints.length; i++) tmpDeontic.constraints[i] = clone(contractObj.facts?.[tmpDeontic.constraints[i]] ?? tmpDeontic.constraints[i]);
    }
    mediaSC.deontics[deonticId] = { uri: JSON.stringify(tmpDeontic), receiver: contractObj.deontics[deonticId].actedBySubject };
    if (!contractObj.deontics[deonticId].actedBySubject) warnings.push(`${deonticId} has no subject; its token goes to the deployer`);
  });

  // Objects
  if (contractObj.objects !== undefined) {
    mediaSC.objects = {};
    Object.keys(contractObj.objects).forEach(objectId => {
      const o = contractObj.objects[objectId];
      const owners = o.rightsOwners ?? o.rightsOwner; // [SPEC 2]
      mediaSC.objects[objectId] = { uri: JSON.stringify(o), receiver: owners !== undefined ? owners[0] : undefined };
    });
  }

  // Contract relations (reference: TODO) — carried to the deployer, see eth.mjs
  // Income percentages
  mediaSC.incomePercentage = {};
  Object.keys(contractObj.actions || {}).forEach(actId => {
    const act = contractObj.actions[actId];
    if (act.type !== "Payment") return;
    const actor = act.actedBy;
    const beneficiary = (act.beneficiaries || [])[0];
    if (act.incomePercentage === undefined) return;
    if (!actor || !beneficiary) { errors.push(`Payment ${actId} has an income percentage but no payer or beneficiary`); return; }
    if (actor === beneficiary) { errors.push(`Payment ${actId}: ${actor} would pay a share of its income to itself — Contract.payTo would recurse forever`); return; }
    if ((act.beneficiaries || []).length > 1) warnings.push(`Payment ${actId} names ${act.beneficiaries.length} beneficiaries; only the first receives the income percentage (as in the reference)`);
    if (mediaSC.incomePercentage[actor] === undefined) mediaSC.incomePercentage[actor] = {};
    const prev = mediaSC.incomePercentage[actor][beneficiary];
    if (prev !== undefined) warnings.push(`Two income payments from ${actor} to ${beneficiary}: ${prev}% + ${act.incomePercentage}% are added up`);
    mediaSC.incomePercentage[actor][beneficiary] = (prev || 0) + act.incomePercentage; // [SPEC 3]
  });
  for (const [actor, m] of Object.entries(mediaSC.incomePercentage)) {
    const sum = Object.values(m).reduce((s, v) => s + v, 0);
    for (const [b, v] of Object.entries(m)) if (!Number.isInteger(v) || v < 0 || v > 100)
      errors.push(`Income percentage ${v}% from ${actor} to ${b} can't be stored on-chain: Contract.sol keeps whole percents (uint256, amount * pct / 100)`);
    if (sum > 100) errors.push(`${actor} pays out ${sum}% of its income; Contract.payTo would revert`);
  }

  // Content URI + hash
  mediaSC.contentURI = JSON.stringify(contractObj);
  mediaSC.hash = keccak256(mediaSC.contentURI);

  // [SPEC 4]
  const consumerPay = Object.values(contractObj.actions || {}).find(a => a.type === "Payment" && a.amount !== undefined &&
    /EndUser/.test(contractObj.parties?.[a.actedBy]?.class || ""));
  const unbound = Object.keys(mediaSC.parties).filter(p => !mediaSC.parties[p]);
  if (unbound.length) warnings.push(`No wallet for ${unbound.length} part${unbound.length === 1 ? "y" : "ies"}: ${unbound.join(", ")}`);
  mediaSC["x-dmaf"] = {
    entry: consumerPay ? { party: consumerPay.beneficiaries?.[0], payment: consumerPay.identifier, amount: consumerPay.amount, currency: consumerPay.currency } : null,
    warnings, errors,
  };
  return mediaSC;
}

/** The reference keys only (what the reference generator returns). */
export function referenceView(mediaSC) {
  const { "x-dmaf": _, ...rest } = mediaSC;
  return rest;
}
