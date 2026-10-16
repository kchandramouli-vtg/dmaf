/* DmafMediaRegistry: pay-per-play, settled either
     - directly by the registry (wallet + basis-point payees from the MCO
       payment obligations, push with deferred withdraw) — the working
       version's flow, kept unchanged; or
     - through the ISO/IEC 21000-23 Contract.payTo cascade of the asset's
       Smart Contract for Media. */
const { expect } = require("chai");
const { ethers } = require("hardhat");

const AUDIO = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const META = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const AGREEMENT = "bafkreie5cvv4h45feadgeuwhbcutmh6t2ceseocckahdoe6uat64zmz454";
const price = ethers.parseEther("0.001");
const NO_SCM = { scm: ethers.ZeroAddress, entry: ethers.ZeroAddress };

describe("DmafMediaRegistry", () => {
  let reg, nft, s, publisher, listener, dsp, aggregator, label, author, pro, mla, publisherCo;
  const other = () => s[15];

  beforeEach(async () => {
    s = await ethers.getSigners();
    [, publisher, listener, dsp, aggregator, label, author, pro, mla, publisherCo] = s;
    nft = await ethers.deployContract("NFToken", ["NFToken", "NFT"]);
    const codehash = ethers.keccak256((await hre.artifacts.readArtifact("Contract")).deployedBytecode);
    reg = await ethers.deployContract("DmafMediaRegistry", [codehash]);
  });

  const base = (over = {}) => ({
    audioCid: AUDIO, metadataCid: META, agreementCid: AGREEMENT,
    agreementHash: ethers.keccak256(ethers.toUtf8Bytes('{"@type":"mco-core:Contract"}')),
    agreementId: "ag_test", pricePerPlay: price, ...NO_SCM, ...over,
  });

  /* ------------------------------------------------------------------ */
  describe("direct split (ETH from listener to each party's wallet)", () => {
    const splits = () => [
      { account: publisher.address, shareBps: 5000, role: "Author" },
      { account: label.address, shareBps: 3333, role: "RecordLabel" },
      { account: publisherCo.address, shareBps: 1667, role: "Publisher" },
    ];
    async function register(over, payees = splits()) {
      await reg.connect(publisher).registerAsset(base(over), payees);
      return reg.assetCount();
    }

    it("registers an asset with its IPFS references and MCO splits", async () => {
      await expect(reg.connect(publisher).registerAsset(base(), splits()))
        .to.emit(reg, "AssetRegistered").withArgs(1n, publisher.address, AUDIO, META, "ag_test", price)
        .and.not.to.emit(reg, "ScmLinked");
      const a = await reg.getAsset(1);
      expect(a.publisher).to.equal(publisher.address);
      expect(a.audioCid).to.equal(AUDIO);
      expect(a.metadataCid).to.equal(META);
      expect(a.agreementCid).to.equal(AGREEMENT);
      expect(a.active).to.equal(true);
      expect(a.scm).to.equal(ethers.ZeroAddress);
      const ps = await reg.getPayees(1);
      expect(ps.map(p => p.role)).to.deep.equal(["Author", "RecordLabel", "Publisher"]);
      expect(ps.map(p => p.shareBps)).to.deep.equal([5000n, 3333n, 1667n]);
    });

    it("rejects bad payee sets and empty CIDs", async () => {
      const bad = splits(); bad[0].shareBps = 4000;
      await expect(reg.registerAsset(base(), bad)).to.be.revertedWithCustomError(reg, "BadPayees").withArgs("shares must sum to 10000");
      await expect(reg.registerAsset(base(), [])).to.be.revertedWithCustomError(reg, "BadPayees").withArgs("count");
      const zero = splits(); zero[1].account = ethers.ZeroAddress;
      await expect(reg.registerAsset(base(), zero)).to.be.revertedWithCustomError(reg, "BadPayees").withArgs("zero address");
      const nil = splits(); nil[2].shareBps = 0; nil[0].shareBps = 6667;
      await expect(reg.registerAsset(base(), nil)).to.be.revertedWithCustomError(reg, "BadPayees").withArgs("zero share");
      const many = Array.from({ length: 17 }, (_, i) => ({ account: s[i + 1].address, shareBps: i ? 588 : 592, role: "" }));
      await expect(reg.registerAsset(base(), many)).to.be.revertedWithCustomError(reg, "BadPayees").withArgs("count");
      await expect(reg.registerAsset(base({ audioCid: "" }), splits())).to.be.revertedWithCustomError(reg, "EmptyCid");
    });

    it("charges per play, records the access and pays each party its share in the same tx", async () => {
      const id = await register();
      const before = await Promise.all([publisher, label, publisherCo].map(w => ethers.provider.getBalance(w.address)));

      await expect(reg.connect(listener).access(id, { value: price }))
        .to.emit(reg, "Accessed").withArgs(id, listener.address, price, 1n)
        .and.to.emit(reg, "Payout").withArgs(id, label.address, price * 3333n / 10000n, 3333, "RecordLabel")
        .and.not.to.emit(reg, "Settled");
      await reg.connect(listener).access(id, { value: price });

      const after = await Promise.all([publisher, label, publisherCo].map(w => ethers.provider.getBalance(w.address)));
      const got = after.map((b, i) => b - before[i]);
      expect(got[1]).to.equal(2n * (price * 3333n / 10000n));
      expect(got[2]).to.equal(2n * (price * 1667n / 10000n));
      expect(got[0] + got[1] + got[2]).to.equal(2n * price); // nothing stuck in the contract
      expect(await ethers.provider.getBalance(await reg.getAddress())).to.equal(0n);

      const a = await reg.getAsset(id);
      expect(a.plays).to.equal(2n);
      expect(a.totalPaid).to.equal(2n * price);
      expect(await reg.playsBy(id, listener.address)).to.equal(2n);
      const log = await reg.getAccessLog(id, 0, 10);
      expect(log.length).to.equal(2);
      expect(log[0].listener).to.equal(listener.address);
      expect(await reg.totalEarned(label.address)).to.equal(got[1]);
    });

    it("previewSplit matches the Payout events (last payee takes the rounding dust)", async () => {
      const odd = 1_000_003n;
      const id = await register({ pricePerPlay: odd });
      const [accounts, amounts] = await reg.previewSplit(id, odd);
      const rc = await (await reg.connect(listener).access(id, { value: odd })).wait();
      const payouts = rc.logs.map(l => { try { return reg.interface.parseLog(l); } catch { return null; } }).filter(e => e?.name === "Payout");
      expect(payouts.map(e => e.args.payee)).to.deep.equal([...accounts]);
      expect(payouts.map(e => e.args.amount)).to.deep.equal([...amounts]);
      expect(amounts.reduce((x, y) => x + y, 0n)).to.equal(odd);
    });

    it("requires the exact price and an active asset", async () => {
      const id = await register();
      await expect(reg.connect(listener).access(id, { value: price - 1n }))
        .to.be.revertedWithCustomError(reg, "WrongPayment").withArgs(price, price - 1n);
      await expect(reg.connect(listener).access(99, { value: price }))
        .to.be.revertedWithCustomError(reg, "UnknownAsset");
      await reg.connect(publisher).setActive(id, false);
      await expect(reg.connect(listener).access(id, { value: price }))
        .to.be.revertedWithCustomError(reg, "AssetInactive");
    });

    it("only the publisher can change price or status", async () => {
      const id = await register();
      await expect(reg.connect(other()).setPrice(id, 1)).to.be.revertedWithCustomError(reg, "NotPublisher");
      await expect(reg.connect(publisher).setPrice(id, 7)).to.emit(reg, "PriceChanged").withArgs(id, 7);
      await expect(reg.connect(listener).access(id, { value: 7 })).to.emit(reg, "Accessed");
    });

    it("free assets still record plays", async () => {
      const id = await register({ pricePerPlay: 0 });
      await expect(reg.connect(listener).access(id)).to.emit(reg, "Accessed").withArgs(id, listener.address, 0, 1n);
      expect(await reg.accessCount(id)).to.equal(1n);
    });

    it("a payee that refuses ETH doesn't block plays; it can withdraw later", async () => {
      const bad = await ethers.deployContract("RevertingPayee");
      const badAddr = await bad.getAddress();
      const id = await register({}, [
        { account: publisher.address, shareBps: 6000, role: "Author" },
        { account: badAddr, shareBps: 4000, role: "Distributor" },
      ]);
      await expect(reg.connect(listener).access(id, { value: price }))
        .to.emit(reg, "PayoutDeferred").withArgs(id, badAddr, price * 4000n / 10000n);
      expect(await reg.pendingWithdrawals(badAddr)).to.equal(price * 4000n / 10000n);
      await expect(reg.connect(other()).withdraw()).to.be.revertedWithCustomError(reg, "NothingToWithdraw");

      await bad.setAccept(true);
      await expect(bad.pull(await reg.getAddress())).to.emit(reg, "Withdrawn").withArgs(badAddr, price * 4000n / 10000n);
      expect(await reg.pendingWithdrawals(badAddr)).to.equal(0n);
      expect(await ethers.provider.getBalance(badAddr)).to.equal(price * 4000n / 10000n);
      expect(await ethers.provider.getBalance(await reg.getAddress())).to.equal(0n);
    });
  });

  /* ------------------------------------------------------------------ */
  describe("Smart Contract for Media (Contract.payTo)", () => {
    /* Deploy a reference Contract with the given income edges: [[from, [[to, pct], …]], …] */
    async function scm(parties, edges) {
      const benef = [], pct = [];
      for (const [from, list] of edges) {
        benef.push(from.address); pct.push(list.length);
        for (const [to, p] of list) { benef.push(to.address); pct.push(p); }
      }
      return ethers.deployContract("Contract", [ethers.toUtf8Bytes("urn:test"), parties.map(p => p.address), await nft.getAddress(),
        [], [], [], [], benef, pct, "bafy-content", ethers.id("content")]);
    }
    /* stream-small-label (the Night Signals agreement): DSP → aggregator 50, PRO 1, MLA 10; aggregator → label 85;
       label → author 10; MLA → publisher 50 */
    const nightSignals = () => scm([dsp, aggregator, label, author, pro, mla, publisherCo], [
      [dsp, [[aggregator, 50], [pro, 1], [mla, 10]]], [aggregator, [[label, 85]]], [label, [[author, 10]]], [mla, [[publisherCo, 50]]],
    ]);
    const input = (c, over = {}) => base({ scm: c, entry: dsp.address, ...over });
    const register = async (over = {}) => {
      const c = over.scm || await (await nightSignals()).getAddress();
      await reg.connect(publisher).registerAsset(input(c, over), []);
      return { id: await reg.assetCount(), scm: c };
    };

    it("registers an asset linked to its Smart Contract for Media", async () => {
      const c = await (await nightSignals()).getAddress();
      await expect(reg.connect(publisher).registerAsset(input(c), []))
        .to.emit(reg, "AssetRegistered").withArgs(1n, publisher.address, AUDIO, META, "ag_test", price)
        .and.to.emit(reg, "ScmLinked").withArgs(1n, c, dsp.address);
      const a = await reg.getAsset(1);
      expect(a.publisher).to.equal(publisher.address);
      expect(a.scm).to.equal(c);
      expect(a.entry).to.equal(dsp.address);
      expect(a.agreementCid).to.equal(AGREEMENT);
      expect(a.active).to.equal(true);
      expect(await reg.getPayees(1)).to.deep.equal([]);
    });

    it("rejects empty CIDs, direct payees, an EOA as SCM, and an entry that is not a party", async () => {
      const c = await (await nightSignals()).getAddress();
      await expect(reg.registerAsset(input(c, { audioCid: "" }), [])).to.be.revertedWithCustomError(reg, "EmptyCid");
      await expect(reg.registerAsset(input(c), [{ account: dsp.address, shareBps: 10000, role: "" }]))
        .to.be.revertedWithCustomError(reg, "BadPayees").withArgs("payees come from the Smart Contract for Media");
      await expect(reg.registerAsset(input(other().address), [])).to.be.revertedWithCustomError(reg, "BadScm").withArgs("not a contract");
      await expect(reg.registerAsset(input(c, { entry: listener.address }), [])).to.be.revertedWithCustomError(reg, "BadScm").withArgs("entry is not a party");
      await expect(reg.registerAsset(input(c, { entry: ethers.ZeroAddress }), [])).to.be.revertedWithCustomError(reg, "BadScm").withArgs("no entry party");
    });

    it("only accepts the ISO/IEC 21000-23 reference Contract (runtime code hash)", async () => {
      const lookalike = await ethers.deployContract("NFToken", ["x", "y"]);
      await expect(reg.registerAsset(input(await lookalike.getAddress()), [])).to.be.revertedWithCustomError(reg, "BadScm")
        .withArgs("not the ISO/IEC 21000-23 reference Contract");
      const viaFactory = await ethers.deployContract("Mpeg21ScmFactory");
      const tx = await viaFactory.deploy(await nft.getAddress(), { identifier: "0x01", parties: [dsp.address], deonticReceivers: [], deonticUris: [],
        objectReceivers: [], objectUris: [], relatedContracts: [], relations: [], incomeBeneficiaries: [], incomePercentages: [], contentUri: "c", contentHash: "0x02" });
      const ev = (await tx.wait()).logs.map(l => { try { return viaFactory.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === "ScmDeployed");
      expect(ethers.keccak256(await ethers.provider.getCode(ev.args.scm))).to.equal(await reg.scmCodehash());
      await expect(reg.connect(publisher).registerAsset(input(ev.args.scm), [])).to.emit(reg, "AssetRegistered");
    });

    it("rejects cascades payTo can't settle: contract payees, cycles, more than 100%", async () => {
      const bad = await ethers.deployContract("RevertingPayee");
      const withContract = await scm([dsp, label], [[dsp, [[{ address: await bad.getAddress() }, 10]]]]);
      await expect(reg.registerAsset(input(await withContract.getAddress()), [])).to.be.revertedWithCustomError(reg, "BadScm").withArgs("payee is a contract");
      const cycle = await scm([dsp, label], [[dsp, [[label, 10]]], [label, [[dsp, 10]]]]);
      await expect(reg.registerAsset(input(await cycle.getAddress()), [])).to.be.revertedWithCustomError(reg, "BadScm").withArgs("cycle in income percentages");
      const over = await scm([dsp, label, author], [[dsp, [[label, 60], [author, 50]]]]);
      await expect(reg.registerAsset(input(await over.getAddress()), [])).to.be.revertedWithCustomError(reg, "BadScm").withArgs("income percentages above 100");
    });

    it("charges per play, records the access and settles through Contract.payTo", async () => {
      const { id, scm: c } = await register();
      const wallets = [dsp, aggregator, label, author, pro, mla, publisherCo];
      const before = await Promise.all(wallets.map(w => ethers.provider.getBalance(w.address)));
      await expect(reg.connect(listener).access(id, { value: price }))
        .to.emit(reg, "Accessed").withArgs(id, listener.address, price, 1n)
        .and.to.emit(reg, "Settled").withArgs(id, c, dsp.address, price)
        .and.to.emit(reg, "Payout").withArgs(id, label.address, price * 3825n / 10000n, 3825, "");
      const after = await Promise.all(wallets.map(w => ethers.provider.getBalance(w.address)));
      const got = after.map((b, i) => b - before[i]);
      // DSP 39%, aggregator 7.5%, label 38.25%, author 4.25%, PRO 1%, MLA 5%, publisher 5%
      expect(got).to.deep.equal([3900n, 750n, 3825n, 425n, 100n, 500n, 500n].map(bps => (price * bps) / 10000n));
      expect(await ethers.provider.getBalance(c)).to.equal(0n);
      expect(await ethers.provider.getBalance(await reg.getAddress())).to.equal(0n);
      const a = await reg.getAsset(id);
      expect(a.plays).to.equal(1n);
      expect(a.totalPaid).to.equal(price);
      expect(await reg.playsBy(id, listener.address)).to.equal(1n);
    });

    it("Payout events and previewSplit mirror what payTo actually sent", async () => {
      const { id } = await register();
      const [accounts, amounts] = await reg.previewSplit(id, price);
      const rc = await (await reg.connect(listener).access(id, { value: price })).wait();
      const payouts = rc.logs.map(l => { try { return reg.interface.parseLog(l); } catch { return null; } }).filter(e => e?.name === "Payout");
      expect(payouts.map(e => e.args.payee)).to.deep.equal([...accounts]);
      expect(payouts.map(e => e.args.amount)).to.deep.equal([...amounts]);
      expect(amounts.reduce((x, y) => x + y, 0n)).to.equal(price);
      expect(await reg.totalEarned(label.address)).to.equal((price * 3825n) / 10000n);
    });

    it("requires the exact price and an active asset", async () => {
      const { id } = await register();
      await expect(reg.connect(listener).access(id, { value: price - 1n })).to.be.revertedWithCustomError(reg, "WrongPayment");
      await reg.connect(publisher).setActive(id, false);
      await expect(reg.connect(listener).access(id, { value: price })).to.be.revertedWithCustomError(reg, "AssetInactive");
      await expect(reg.access(99, { value: price })).to.be.revertedWithCustomError(reg, "UnknownAsset");
    });

    it("only the publisher can change price or status", async () => {
      const { id } = await register();
      await expect(reg.connect(listener).setPrice(id, 1)).to.be.revertedWithCustomError(reg, "NotPublisher");
      await expect(reg.connect(listener).setActive(id, false)).to.be.revertedWithCustomError(reg, "NotPublisher");
      await expect(reg.connect(publisher).setPrice(id, 7)).to.emit(reg, "PriceChanged").withArgs(id, 7);
    });

    it("free assets still record plays (no payTo call)", async () => {
      const { id } = await register({ pricePerPlay: 0n });
      await expect(reg.connect(listener).access(id)).to.emit(reg, "Accessed").and.not.to.emit(reg, "Settled");
      expect((await reg.getAsset(id)).plays).to.equal(1n);
      const log = await reg.getAccessLog(id, 0, 10);
      expect(log[0].listener).to.equal(listener.address);
    });

    it("a party with no income shares is a valid single-payee SCM (direct to fan)", async () => {
      const solo = await scm([dsp], []);
      const { id } = await register({ scm: await solo.getAddress() });
      const b = await ethers.provider.getBalance(dsp.address);
      await reg.connect(listener).access(id, { value: price });
      expect((await ethers.provider.getBalance(dsp.address)) - b).to.equal(price);
    });
  });

  it("both modes side by side: one registry, one listener, each asset paid its own way", async () => {
    const solo = await ethers.deployContract("Contract", [ethers.toUtf8Bytes("urn:solo"), [dsp.address], await nft.getAddress(),
      [], [], [], [], [], [], "bafy", ethers.id("c")]);
    await reg.connect(publisher).registerAsset(base({ scm: await solo.getAddress(), entry: dsp.address }), []);
    await reg.connect(publisher).registerAsset(base(), [{ account: label.address, shareBps: 10000, role: "RecordLabel" }]);
    const b = await Promise.all([dsp, label].map(w => ethers.provider.getBalance(w.address)));
    await expect(reg.connect(listener).access(1, { value: price })).to.emit(reg, "Settled");
    await expect(reg.connect(listener).access(2, { value: price })).to.emit(reg, "Payout").withArgs(2n, label.address, price, 10000, "RecordLabel");
    const a = await Promise.all([dsp, label].map(w => ethers.provider.getBalance(w.address)));
    expect([a[0] - b[0], a[1] - b[1]]).to.deep.equal([price, price]);
  });
});
