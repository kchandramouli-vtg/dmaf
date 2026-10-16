/* ============================================================
   Smart Contract for Media on Ethereum — deploy and parse
   (ISO/IEC 21000-23 forward and backward conversion).

   Ports of the reference EthereumDeployer / EthereumParser
   (scmgenerator-dltmanager/lib/eth/*.js) from web3 1.x to ethers 6,
   for the browser (MetaMask) and Node. ethers is passed in, so this
   file has no imports and runs in both. Differences, tagged [ETH n]
   and listed in mpeg21/CONFORMANCE.md:

    1  identifier = UTF-8 bytes of the contract IRI (reference: the
       literal string "identifier" for every contract).
    2  contentHash = keccak256 of the content JSON, i.e. the spec's
       `hash` (reference: overwrote it with the IPFS CID's ASCII).
    3  The NFToken address is read from the contract's _nfToken()
       (reference: from a build artifact for one fixed network).
    4  Unbound parties and receivers fall back to the deployer instead
       of failing to encode.
    5  Contract relations whose target is an Ethereum address are
       written (reference: always empty).
    6  parse also returns the party ↔ wallet bindings and checks the
       content hash.
   Token URIs and contentUri stay bare IPFS CIDs, as the reference
   parser expects.
   ============================================================ */

const RELATIONS = ["supersedes", "cancels", "prevailsOver", "isAmendmentOf"]; // OpenAPI ContractRelationsEnum order

/**
 * Publish the spec's JSON documents and build the Contract constructor arguments.
 * @param {object} spec      generateSmartContractSpecification() output
 * @param {object} o
 * @param {object} o.ethers  ethers v6
 * @param {(text: string) => Promise<string>} o.publish   store text off-chain, return its CID
 * @param {Record<string,string>} [o.bindings]  party id → address (overrides spec.parties)
 * @param {string} o.deployer  fallback address
 */
export async function prepareDeployment(spec, { ethers, publish, bindings = {}, deployer, onProgress = () => {} }) {
  const errs = spec["x-dmaf"]?.errors || [];
  if (errs.length) throw new Error(errs[0]);
  const addr = id => {
    const a = bindings[id] || spec.parties?.[id];
    return a && ethers.isAddress(a) ? ethers.getAddress(a) : ethers.getAddress(deployer); // [ETH 4]
  };
  const partyIds = Object.keys(spec.parties || {});
  const deontics = Object.entries(spec.deontics || {});
  const objects = Object.entries(spec.objects || {});
  const total = deontics.length + objects.length + 1;
  let done = 0;
  const pub = async (text, what) => { const cid = await publish(text); onProgress(++done, total, what, cid); return cid; };

  const deonticUris = [], deonticReceivers = [];
  for (const [id, d] of deontics) { deonticUris.push(await pub(d.uri, id)); deonticReceivers.push(addr(d.receiver)); }
  const objectUris = [], objectReceivers = [];
  for (const [id, o] of objects) { objectUris.push(await pub(o.uri, id)); objectReceivers.push(o.receiver !== undefined ? addr(o.receiver) : ethers.getAddress(deployer)); }

  const incomeBeneficiaries = [], incomePercentages = [];
  for (const actor of Object.keys(spec.incomePercentage || {})) {
    const m = spec.incomePercentage[actor];
    incomeBeneficiaries.push(addr(actor));
    incomePercentages.push(BigInt(Object.keys(m).length));
    for (const b of Object.keys(m)) { incomeBeneficiaries.push(addr(b)); incomePercentages.push(BigInt(m[b])); }
  }

  const relatedContracts = [], relations = []; // [ETH 5]
  let content = {};
  try { content = JSON.parse(spec.contentURI); } catch {}
  for (const [other, rel] of Object.entries(content.contractRelations || {})) {
    if (ethers.isAddress(other) && RELATIONS.includes(rel)) { relatedContracts.push(ethers.getAddress(other)); relations.push(BigInt(RELATIONS.indexOf(rel))); }
  }

  const contentUri = await pub(spec.contentURI, "contract");
  return {
    identifier: ethers.hexlify(ethers.toUtf8Bytes(spec.identifier)), // [ETH 1]
    parties: partyIds.map(addr),
    deonticReceivers, deonticUris, objectReceivers, objectUris,
    relatedContracts, relations, incomeBeneficiaries, incomePercentages,
    contentUri,
    contentHash: spec.hash, // [ETH 2]
    bindings: Object.fromEntries(partyIds.map(p => [p, addr(p)])),
  };
}

/**
 * Deploy through Mpeg21ScmFactory: one transaction.
 * @returns {{address, txHash, deonticTokenIds, objectTokenIds, receipt}}
 */
export async function deployWithFactory({ ethers, signer, factory, nfToken, args }) {
  const f = new ethers.Contract(factory.address, factory.abi, signer);
  const tx = await f.deploy(nfToken, {
    identifier: args.identifier, parties: args.parties,
    deonticReceivers: args.deonticReceivers, deonticUris: args.deonticUris,
    objectReceivers: args.objectReceivers, objectUris: args.objectUris,
    relatedContracts: args.relatedContracts, relations: args.relations,
    incomeBeneficiaries: args.incomeBeneficiaries, incomePercentages: args.incomePercentages,
    contentUri: args.contentUri, contentHash: args.contentHash,
  });
  const receipt = await tx.wait();
  const ev = receipt.logs.map(l => { try { return f.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === "ScmDeployed");
  if (!ev) throw new Error("ScmDeployed event missing");
  return { address: ev.args.scm, txHash: receipt.hash, deonticTokenIds: ev.args.deonticTokenIds.map(String), objectTokenIds: ev.args.objectTokenIds.map(String), receipt };
}

/**
 * Deploy exactly like the reference EthereumDeployer: one newToken() per
 * deontic and object, then the Contract constructor (deontics + objects + 1 txs).
 */
export async function deployLikeReference({ ethers, signer, nfToken, contractArtifact, args }) {
  const token = new ethers.Contract(nfToken.address, nfToken.abi, signer);
  const mint = async (to, uri) => {
    const rc = await (await token.newToken(to, uri)).wait();
    const ev = rc.logs.map(l => { try { return token.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === "Transfer");
    return ev.args.tokenId;
  };
  const deonticIds = [];
  for (let i = 0; i < args.deonticUris.length; i++) deonticIds.push(await mint(args.deonticReceivers[i], args.deonticUris[i]));
  const objectIds = [];
  for (let i = 0; i < args.objectUris.length; i++) objectIds.push(await mint(args.objectReceivers[i], args.objectUris[i]));
  const cf = new ethers.ContractFactory(contractArtifact.abi, contractArtifact.bytecode, signer);
  const c = await cf.deploy(args.identifier, args.parties, nfToken.address, deonticIds, objectIds, args.relatedContracts, args.relations,
    args.incomeBeneficiaries, args.incomePercentages, args.contentUri, args.contentHash);
  await c.waitForDeployment();
  return { address: await c.getAddress(), txHash: c.deploymentTransaction().hash, deonticTokenIds: deonticIds.map(String), objectTokenIds: objectIds.map(String) };
}

/** Contract.getIncomePercentagesBy() reverts with "Empty Map" for a party that
    shares no income (reference EnumerableMap.getAll); read that as "none". */
export async function incomeOf(contract, who) {
  try {
    const [to, pct] = await contract.getIncomePercentagesBy(who);
    return [[...to], [...pct]];
  } catch (e) {
    if (/Empty Map/.test(e.reason || e.shortMessage || e.message || "")) return [[], []];
    throw e;
  }
}

/* Minimal ABIs of the reference contracts (enough to parse and settle). */
export const CONTRACT_ABI = [
  "function _contentUri() view returns (string)",
  "function _contentHash() view returns (bytes)",
  "function _nfToken() view returns (address)",
  "function getParties() view returns (address[])",
  "function getDeonticExpressions() view returns (uint256[])",
  "function getObjects() view returns (uint256[])",
  "function getContractRelations() view returns (address[], uint256[])",
  "function getIncomePercentagesBy(address sharer) view returns (address[], uint256[])",
  "function payTo(address beneficiary, uint256 amount) payable",
];
export const NFTOKEN_ABI = ["function tokenURI(uint256 tokenId) view returns (string)", "function ownerOf(uint256 tokenId) view returns (address)"];

/**
 * Backward conversion: an on-chain Smart Contract for Media → Media Contractual Objects.
 * Same steps as the reference EthereumParser.parseSmartContract().
 * @param {{ethers, provider, address: string, retrieve: (cid: string) => Promise<string>}} o
 */
export async function parseSmartContract({ ethers, provider, address, retrieve }) {
  if (!ethers.isAddress(String(address).trim())) throw Object.assign(new Error("Invalid Ethereum address"), { name: "InvalidEthereumAddress" });
  address = ethers.getAddress(String(address).trim());
  if ((await provider.getCode(address)) === "0x") throw Object.assign(new Error(`No contract at ${address}`), { name: "InvalidEthereumAddress" });
  const contract = new ethers.Contract(address, CONTRACT_ABI, provider);
  const token = new ethers.Contract(await contract._nfToken(), NFTOKEN_ABI, provider); // [ETH 3]

  // Get contract info
  const contractUri = await contract._contentUri();
  const contentText = await retrieve(contractUri);
  const mediaContract = JSON.parse(contentText);
  mediaContract.actions ||= {}; mediaContract.deontics ||= {}; mediaContract.objects ||= {};

  // Get deontics token info
  const deontics = [];
  const deonticsTokensIds = await contract.getDeonticExpressions();
  const tokenOwners = {};
  for (const id of deonticsTokensIds) {
    const tokenUri = await token.tokenURI(id);
    const d = JSON.parse(await retrieve(tokenUri));
    tokenOwners[d.identifier] = { tokenId: String(id), owner: await token.ownerOf(id), uri: tokenUri };
    deontics.push(d);
  }
  deontics.forEach(deontic => {
    const tmpAct = JSON.parse(JSON.stringify(deontic.act));
    if (tmpAct && typeof tmpAct === "object") {
      deontic.act = tmpAct.identifier;
      if (tmpAct.impliesAlso !== undefined) {
        for (let i = 0; i < tmpAct.impliesAlso.length; i++) {
          const t = JSON.parse(JSON.stringify(tmpAct.impliesAlso[i]));
          tmpAct.impliesAlso[i] = t.identifier;
          mediaContract.actions[t.identifier] = t;
        }
      }
      mediaContract.actions[tmpAct.identifier] = tmpAct;
    }
    if (deontic.constraints !== undefined) {
      mediaContract.facts ||= {};
      for (let i = 0; i < deontic.constraints.length; i++) {
        const t = JSON.parse(JSON.stringify(deontic.constraints[i]));
        if (t && typeof t === "object") { deontic.constraints[i] = t.identifier; mediaContract.facts[t.identifier] = t; }
      }
    }
    mediaContract.deontics[deontic.identifier] = deontic;
  });

  // Get objects token info
  const objectsTokensIds = await contract.getObjects();
  for (const id of objectsTokensIds) {
    const tokenUri = await token.tokenURI(id);
    const object = JSON.parse(await retrieve(tokenUri));
    tokenOwners[object.identifier] = { tokenId: String(id), owner: await token.ownerOf(id), uri: tokenUri };
    mediaContract.objects[object.identifier] = object;
  }

  // [ETH 6]
  const onChainParties = await contract.getParties();
  const partyIds = Object.keys(mediaContract.parties || {});
  const bindings = onChainParties.length === partyIds.length ? Object.fromEntries(partyIds.map((p, i) => [p, onChainParties[i]])) : null;
  const storedHash = await contract._contentHash();
  const hashOk = storedHash.toLowerCase() === ethers.id(contentText).toLowerCase();
  const income = {};
  for (const a of new Set(onChainParties)) {
    const [to, pct] = await incomeOf(contract, a);
    if (to.length) income[a] = Object.fromEntries(to.map((t, i) => [t, Number(pct[i])]));
  }
  return { contract: mediaContract, onChain: { address, nfToken: await token.getAddress(), contentUri: contractUri, contentHash: storedHash,
    contentHashVerified: hashOk, parties: [...onChainParties], bindings, tokens: tokenOwners, incomePercentages: income } };
}

/** Same integer arithmetic as Contract.payTo: [{account, amount}] in transfer order. */
export async function simulatePayTo({ ethers, provider, scm, entry, amount }) {
  const c = new ethers.Contract(scm, CONTRACT_ABI, provider);
  const out = [];
  const walk = async (who, amt, depth) => {
    if (depth > 16) throw new Error("payTo cascade deeper than 16 — cycle?");
    let kept = amt;
    const [to, pct] = await incomeOf(c, who);
    for (let i = 0; i < to.length; i++) {
      const sub = (amt * pct[i]) / 100n;
      await walk(to[i], sub, depth + 1);
      kept -= sub;
    }
    out.push({ account: who, amount: kept });
  };
  await walk(entry, BigInt(amount), 0);
  return out;
}
