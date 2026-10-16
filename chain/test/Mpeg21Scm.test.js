/* ISO/IEC 21000-23 on Ethereum: MCO → Media Contractual Objects → Smart
   Contract for Media (reference Contract.sol + NFToken.sol) → back again.

   For each of the standard's six template contracts:
     forward   parse the Turtle, build the specification, publish the token
               JSON off-chain, deploy (one-transaction factory and the
               reference's one-transaction-per-token sequence)
     backward  read the deployed contract the way the reference
               EthereumParser does and compare with what went in
     settle    Contract.payTo pays every party its income percentage */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const FX = path.join(__dirname, "..", "..", "mpeg21", "test", "fixtures", "standard", "rdf");
const CASES = fs.readdirSync(FX).map(f => f.replace(".ttl", ""));

describe("ISO/IEC 21000-23 Smart Contracts for Media on Ethereum", function () {
  let lib, signers, nft, factory, storage, contractArtifact;
  const parsed = {};

  before(async () => {
    lib = {
      ...(await import("../../mpeg21/lib/parser.mjs")),
      ...(await import("../../mpeg21/lib/scspec.mjs")),
      ...(await import("../../mpeg21/lib/eth.mjs")),
      ...(await import("../../mpeg21/lib/offchain.mjs")),
    };
    signers = await ethers.getSigners();
    nft = await ethers.deployContract("NFToken", ["NFToken", "NFT"]); // reference migration 2_deploy_token.js
    factory = await ethers.deployContract("Mpeg21ScmFactory");
    storage = new lib.MemoryStorage();
    contractArtifact = await hre.artifacts.readArtifact("Contract");
    for (const name of CASES) parsed[name] = (await lib.getContractFromMCO(fs.readFileSync(path.join(FX, name + ".ttl"), "utf8"))).contracts[0];
  });

  /* party i of the contract → Hardhat account 3 + i */
  const bindingsFor = c => Object.fromEntries(Object.keys(c.parties).map((p, i) => [p, signers[3 + i].address]));
  const specFor = (c, bindings) => lib.generateSmartContractSpecification(c, { keccak256: ethers.id, bindings });
  const prepare = (spec, bindings) => lib.prepareDeployment(spec, { ethers, publish: t => storage.publish(t), bindings, deployer: signers[1].address });
  const factoryInfo = async () => ({ address: await factory.getAddress(), abi: factory.interface.fragments });
  const nftInfo = async () => ({ address: await nft.getAddress(), abi: nft.interface.fragments });

  for (const name of CASES) {
    describe(name, () => {
      let c, bindings, spec, args, deployed;
      before(async () => {
        c = parsed[name];
        bindings = bindingsFor(c);
        spec = specFor(c, bindings);
        expect(spec["x-dmaf"].errors).to.deep.equal([]);
        args = await prepare(spec, bindings);
        deployed = await lib.deployWithFactory({ ethers, signer: signers[1], factory: await factoryInfo(), nfToken: await nft.getAddress(), args });
      });

      it("forward: one NFT per deontic expression and object, minted to the bound party", async () => {
        const scm = await ethers.getContractAt("Contract", deployed.address);
        const dIds = await scm.getDeonticExpressions();
        const oIds = await scm.getObjects();
        expect(dIds.length).to.equal(Object.keys(c.deontics).length);
        expect(oIds.length).to.equal(Object.keys(c.objects).length);
        const deontics = Object.values(spec.deontics);
        for (let i = 0; i < dIds.length; i++) {
          expect(await nft.ownerOf(dIds[i])).to.equal(bindings[deontics[i].receiver]);
          expect(await storage.retrieve(await nft.tokenURI(dIds[i]))).to.equal(deontics[i].uri); // token URI → the reference's deontic JSON
        }
        expect(await scm._nfToken()).to.equal(await nft.getAddress());
        expect(await scm.getParties()).to.deep.equal(Object.keys(c.parties).map(p => bindings[p]));
      });

      it("forward: income percentages on-chain equal the MCO payment obligations", async () => {
        const scm = await ethers.getContractAt("Contract", deployed.address);
        for (const [actor, m] of Object.entries(spec.incomePercentage)) {
          const [to, pct] = await scm.getIncomePercentagesBy(bindings[actor]);
          expect(Object.fromEntries(to.map((t, i) => [t, Number(pct[i])])))
            .to.deep.equal(Object.fromEntries(Object.entries(m).map(([b, v]) => [bindings[b], v])));
        }
      });

      it("forward: contentHash is keccak256 of the content JSON, contentUri its CID", async () => {
        const scm = await ethers.getContractAt("Contract", deployed.address);
        const uri = await scm._contentUri();
        expect(await storage.retrieve(uri)).to.equal(spec.contentURI);
        expect(await scm._contentHash()).to.equal(spec.hash);
      });

      it("backward: parsing the deployed contract returns the same Media Contractual Objects", async () => {
        const r = await lib.parseSmartContract({ ethers, provider: ethers.provider, address: deployed.address, retrieve: cid => storage.retrieve(cid) });
        expect(r.contract).to.deep.equal(c);
        expect(r.onChain.contentHashVerified).to.equal(true);
        expect(r.onChain.bindings).to.deep.equal(bindings);
      });

      it("the reference deployment sequence (a transaction per token) gives the same result", async () => {
        const ref = await lib.deployLikeReference({ ethers, signer: signers[1], nfToken: await nftInfo(), contractArtifact, args });
        const a = await lib.parseSmartContract({ ethers, provider: ethers.provider, address: ref.address, retrieve: cid => storage.retrieve(cid) });
        const b = await lib.parseSmartContract({ ethers, provider: ethers.provider, address: deployed.address, retrieve: cid => storage.retrieve(cid) });
        expect(a.contract).to.deep.equal(b.contract);
        expect(a.onChain.incomePercentages).to.deep.equal(b.onChain.incomePercentages);
      });

      it("settle: Contract.payTo splits a payment along the income percentages", async () => {
        const entry = spec["x-dmaf"].entry.party;
        const scm = await ethers.getContractAt("Contract", deployed.address);
        const amount = ethers.parseEther("1");
        const steps = await lib.simulatePayTo({ ethers, provider: ethers.provider, scm: deployed.address, entry: bindings[entry], amount });
        const expected = {}; // a party can be paid along more than one path (e.g. Author in stream-no-label)
        for (const st of steps) expected[st.account] = (expected[st.account] || 0n) + st.amount;
        const accounts = Object.keys(expected);
        const before = await Promise.all(accounts.map(a => ethers.provider.getBalance(a)));
        await scm.connect(signers[2]).payTo(bindings[entry], amount, { value: amount });
        const after = await Promise.all(accounts.map(a => ethers.provider.getBalance(a)));
        accounts.forEach((a, i) => expect(after[i] - before[i]).to.equal(expected[a]));
        expect(Object.values(expected).reduce((s, v) => s + v, 0n)).to.equal(amount);
        expect(await ethers.provider.getBalance(deployed.address)).to.equal(0n);
      });
    });
  }

  it("stream-small-label pays DSP 39%, label 38.25%, aggregator 7.5%, publisher 5%, mech. agent 5%, author 4.25%, PRO 1%", async () => {
    const c = parsed["use-case-stream-small-label"];
    const bindings = bindingsFor(c);
    const args = await prepare(specFor(c, bindings), bindings);
    const d = await lib.deployWithFactory({ ethers, signer: signers[1], factory: await factoryInfo(), nfToken: await nft.getAddress(), args });
    const split = await lib.simulatePayTo({ ethers, provider: ethers.provider, scm: d.address, entry: bindings["http://mpeg.org/StreamingService"], amount: 10000n });
    const byParty = Object.fromEntries(split.map(s => [Object.keys(bindings).find(k => bindings[k] === s.account).split("/").pop(), Number(s.amount) / 100]));
    expect(byParty).to.deep.equal({ StreamingService: 39, RecordLabel: 38.25, Aggregator: 7.5, Publisher: 5, MechanicalLicenseAgent: 5, Author: 4.25, PerformingRighthsOrganisation: 1 });
  });

  it("OpenAPI POST /dlt/eth/parse/ reads a deployed contract (server/scm-api.mjs)", async () => {
    const { createScmApi } = await import("../../server/scm-api.mjs");
    const api = createScmApi({ storage, provider: ethers.provider, cel: { status: async () => ({}) } });
    const c = parsed["use-case-download-big-label"];
    const b = bindingsFor(c);
    const d = await lib.deployWithFactory({ ethers, signer: signers[1], factory: await factoryInfo(), nfToken: await nft.getAddress(), args: await prepare(specFor(c, b), b) });
    const out = await api.ops.parseSmartContract({}, d.address);
    expect(out.json).to.deep.equal(c);
    expect(out.headers["x-scm-content-hash-verified"]).to.equal("true");
    const v = api.api.validate("Contract", out.json);
    expect(v.ok, v.errors.join("\n")).to.equal(true);
  });
});
