// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// The parts of the ISO/IEC 21000-23 reference `Contract` (chain/contracts/mpeg21/Contract.sol)
/// the registry uses. The ABI is the reference one, unchanged.
interface IMpeg21Contract {
    function payTo(address payable beneficiary, uint256 amount) external payable;
    function getParties() external view returns (address[] memory);
    function getIncomePercentagesBy(address sharer) external view returns (address[] memory, uint256[] memory);
    function _contentUri() external view returns (string memory);
}

/**
 * @title  DMAF media registry (proof of concept)
 * @notice Registers media assets whose bytes live on IPFS, together with the
 *         MPEG-21 MCO agreement that governs them, and settles pay-per-play
 *         access: every play is paid in ETH, recorded on-chain, and paid out to
 *         the agreement's parties in the same transaction.
 *
 *         asset ── audioCid      → the MP3 on IPFS
 *               ── metadataCid   → JSON (title, artist, splits, agreement ref)
 *               ── agreementCid  → MCO contract as JSON-LD on IPFS
 *               ── agreementHash → keccak256 of those JSON-LD bytes (tamper check)
 *
 *         Each asset settles plays one of two ways, chosen at registration:
 *
 *         1. Smart Contract for Media (scm ≠ 0) — the agreement deployed as the
 *            ISO/IEC 21000-23 reference `Contract`. Every paid play calls
 *            scm.payTo{value: price}(entry, price), which pays each party its
 *            income percentage of what it receives, recursively. The registry
 *            mirrors that arithmetic to emit one Payout event per wallet.
 *
 *         2. Direct split (scm = 0) — the payees (wallet + basis points, sum
 *            10 000) worked out from the MCO payment obligations, paid by the
 *            registry itself. A payee that can't receive ETH is credited for
 *            withdraw() instead of blocking listeners. Used where payTo can't
 *            settle the agreement: parties sharing a wallet (e.g. no wallet →
 *            the publisher's), contract wallets as payees, or no ISO/IEC
 *            21000-23 API running.
 */
contract DmafMediaRegistry {
    uint16 public constant BPS = 10_000;
    uint256 public constant MAX_PAYEES = 16;
    /// Gas forwarded to each direct-split payee. Enough for wallets and simple
    /// contracts; a payee that reverts or burns gas is credited for withdraw().
    uint256 public constant PAYOUT_GAS = 50_000;
    /// Limits for the payTo cascade walk (party graphs in the MCO use cases are 2–4 deep).
    uint256 public constant MAX_DEPTH = 8;
    uint256 public constant MAX_NODES = 64;

    struct Payee {
        address account;
        uint16 shareBps;
        string role; // MCO party id(s), e.g. "RecordLabel"
    }

    struct AssetInput {
        string audioCid;
        string metadataCid;
        string agreementCid;
        bytes32 agreementHash;
        string agreementId;
        uint256 pricePerPlay; // wei
        address scm; // ISO/IEC 21000-23 Contract for the agreement, or 0 for a direct split
        address entry; // party the consumer pays (scm mode)
    }

    struct Asset {
        address publisher;
        uint256 pricePerPlay;
        string audioCid;
        string metadataCid;
        string agreementCid;
        bytes32 agreementHash;
        string agreementId;
        uint64 createdAt;
        bool active;
        uint64 plays;
        uint256 totalPaid;
        address scm;
        address entry;
    }

    struct Access {
        address listener;
        uint64 at;
        uint256 amount;
    }

    /// Runtime code hash of the ISO/IEC 21000-23 reference `Contract` (chain/contracts/mpeg21/Contract.sol)
    /// as compiled for this deployment. Only contracts with exactly this code can settle plays, so a
    /// publisher can't link an asset to look-alike code that splits differently.
    bytes32 public immutable scmCodehash;

    uint256 public assetCount; // asset ids are 1..assetCount
    mapping(uint256 => Asset) private _assets;
    mapping(uint256 => Payee[]) private _payees;
    mapping(uint256 => Access[]) private _accessLog;
    mapping(uint256 => mapping(address => uint256)) public playsBy;
    mapping(address => uint256) public totalEarned;
    mapping(address => uint256) public pendingWithdrawals;

    uint256 private _lock = 1;

    event AssetRegistered(
        uint256 indexed assetId,
        address indexed publisher,
        string audioCid,
        string metadataCid,
        string agreementId,
        uint256 pricePerPlay
    );
    event ScmLinked(uint256 indexed assetId, address indexed scm, address indexed entry);
    event Accessed(uint256 indexed assetId, address indexed listener, uint256 amount, uint256 playNo);
    event Settled(uint256 indexed assetId, address indexed scm, address indexed entry, uint256 amount);
    event Payout(uint256 indexed assetId, address indexed payee, uint256 amount, uint16 shareBps, string role);
    event PayoutDeferred(uint256 indexed assetId, address indexed payee, uint256 amount);
    event PriceChanged(uint256 indexed assetId, uint256 pricePerPlay);
    event ActiveChanged(uint256 indexed assetId, bool active);
    event Withdrawn(address indexed payee, uint256 amount);

    error UnknownAsset(uint256 assetId);
    error NotPublisher(uint256 assetId);
    error AssetInactive(uint256 assetId);
    error WrongPayment(uint256 expected, uint256 sent);
    error EmptyCid();
    error BadPayees(string reason);
    error BadScm(string reason);
    error NothingToWithdraw();
    error Reentrancy();
    error TransferFailed();

    constructor(bytes32 scmCodehash_) {
        scmCodehash = scmCodehash_;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier exists(uint256 assetId) {
        if (assetId == 0 || assetId > assetCount) revert UnknownAsset(assetId);
        _;
    }

    modifier onlyPublisher(uint256 assetId) {
        if (_assets[assetId].publisher != msg.sender) revert NotPublisher(assetId);
        _;
    }

    /// The reference Contract.getIncomePercentagesBy() reverts ("Empty Map")
    /// for a party that shares no income; treat that as no beneficiaries.
    function _income(address scm, address who) private view returns (address[] memory to, uint256[] memory pct) {
        try IMpeg21Contract(scm).getIncomePercentagesBy(who) returns (address[] memory t, uint256[] memory p) {
            return (t, p);
        } catch {
            return (new address[](0), new uint256[](0));
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Publish                                                            */
    /* ------------------------------------------------------------------ */

    /// @param payees direct-split payees (wallet + bps summing to 10 000); must
    ///        be empty when `input.scm` is set — the Smart Contract for Media
    ///        then decides who gets what.
    function registerAsset(AssetInput calldata input, Payee[] calldata payees) external returns (uint256 assetId) {
        if (bytes(input.audioCid).length == 0 || bytes(input.metadataCid).length == 0) revert EmptyCid();
        if (input.scm != address(0)) {
            if (payees.length != 0) revert BadPayees("payees come from the Smart Contract for Media");
            _checkScm(input.scm, input.entry);
        } else {
            _checkPayees(payees);
        }

        assetId = ++assetCount;
        Asset storage a = _assets[assetId];
        a.publisher = msg.sender;
        a.pricePerPlay = input.pricePerPlay;
        a.audioCid = input.audioCid;
        a.metadataCid = input.metadataCid;
        a.agreementCid = input.agreementCid;
        a.agreementHash = input.agreementHash;
        a.agreementId = input.agreementId;
        a.createdAt = uint64(block.timestamp);
        a.active = true;
        if (input.scm != address(0)) {
            a.scm = input.scm;
            a.entry = input.entry;
        } else {
            for (uint256 i; i < payees.length; ++i) _payees[assetId].push(payees[i]);
        }

        emit AssetRegistered(assetId, msg.sender, input.audioCid, input.metadataCid, input.agreementId, input.pricePerPlay);
        if (input.scm != address(0)) emit ScmLinked(assetId, input.scm, input.entry);
    }

    function _checkPayees(Payee[] calldata payees) private pure {
        uint256 n = payees.length;
        if (n == 0 || n > MAX_PAYEES) revert BadPayees("count");
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            if (payees[i].account == address(0)) revert BadPayees("zero address");
            if (payees[i].shareBps == 0) revert BadPayees("zero share");
            sum += payees[i].shareBps;
        }
        if (sum != BPS) revert BadPayees("shares must sum to 10000");
    }

    /// The SCM must be the reference Contract, `entry` one of its parties, and the
    /// payTo cascade from `entry` must be payable: every wallet in it an EOA
    /// (payTo uses transfer(), whose 2300 gas most contract wallets can't
    /// receive with), no party paying out more than 100% of its income, and no
    /// cycles. The SCM's income percentages are immutable, so checking once at
    /// registration is enough.
    function _checkScm(address scm, address entry) private view {
        if (scm.code.length == 0) revert BadScm("not a contract");
        if (scm.codehash != scmCodehash) revert BadScm("not the ISO/IEC 21000-23 reference Contract");
        if (entry == address(0)) revert BadScm("no entry party");
        address[] memory parties = IMpeg21Contract(scm).getParties();
        bool found;
        for (uint256 i; i < parties.length; ++i) if (parties[i] == entry) { found = true; break; }
        if (!found) revert BadScm("entry is not a party");
        _checkNode(scm, entry, new address[](MAX_DEPTH + 1), 0, 0);
    }

    function _checkNode(address scm, address who, address[] memory path, uint256 depth, uint256 nodes)
        private
        view
        returns (uint256)
    {
        if (depth > MAX_DEPTH) revert BadScm("cascade too deep");
        if (++nodes > MAX_NODES) revert BadScm("cascade too large");
        if (who.code.length != 0) revert BadScm("payee is a contract");
        for (uint256 i; i < depth; ++i) if (path[i] == who) revert BadScm("cycle in income percentages");
        path[depth] = who;
        (address[] memory to, uint256[] memory pct) = _income(scm, who);
        uint256 sum;
        for (uint256 i; i < to.length; ++i) {
            sum += pct[i];
            nodes = _checkNode(scm, to[i], path, depth + 1, nodes);
        }
        if (sum > 100) revert BadScm("income percentages above 100");
        return nodes;
    }

    function setPrice(uint256 assetId, uint256 pricePerPlay) external exists(assetId) onlyPublisher(assetId) {
        _assets[assetId].pricePerPlay = pricePerPlay;
        emit PriceChanged(assetId, pricePerPlay);
    }

    function setActive(uint256 assetId, bool active) external exists(assetId) onlyPublisher(assetId) {
        _assets[assetId].active = active;
        emit ActiveChanged(assetId, active);
    }

    /* ------------------------------------------------------------------ */
    /*  Pay-per-play access                                                */
    /* ------------------------------------------------------------------ */

    /// @notice Pay for one play of `assetId`. Records the access and pays the
    ///         parties in the same transaction — through the asset's Smart
    ///         Contract for Media (Contract.payTo) or its direct split.
    function access(uint256 assetId) external payable nonReentrant exists(assetId) returns (uint256 playNo) {
        Asset storage a = _assets[assetId];
        if (!a.active) revert AssetInactive(assetId);
        if (msg.value != a.pricePerPlay) revert WrongPayment(a.pricePerPlay, msg.value);

        playNo = ++a.plays;
        a.totalPaid += msg.value;
        playsBy[assetId][msg.sender] += 1;
        _accessLog[assetId].push(Access(msg.sender, uint64(block.timestamp), msg.value));
        emit Accessed(assetId, msg.sender, msg.value, playNo);

        if (msg.value == 0) return playNo;
        if (a.scm != address(0)) {
            IMpeg21Contract(a.scm).payTo{value: msg.value}(payable(a.entry), msg.value);
            emit Settled(assetId, a.scm, a.entry, msg.value);
            _mirror(assetId, a.scm, a.entry, msg.value, msg.value);
        } else {
            _distribute(assetId, msg.value);
        }
    }

    /// Same arithmetic as Contract.payTo: each income beneficiary gets
    /// amount * pct / 100 of what `who` receives; `who` keeps the rest.
    function _mirror(uint256 assetId, address scm, address who, uint256 amount, uint256 total) private {
        uint256 kept = amount;
        (address[] memory to, uint256[] memory pct) = _income(scm, who);
        for (uint256 i; i < to.length; ++i) {
            uint256 sub = (amount * pct[i]) / 100;
            _mirror(assetId, scm, to[i], sub, total);
            kept -= sub;
        }
        if (kept > 0) {
            totalEarned[who] += kept;
            emit Payout(assetId, who, kept, uint16((kept * BPS) / total), "");
        }
    }

    /// Direct split: push each payee its share; the last payee takes the
    /// rounding dust so nothing stays in the contract.
    function _distribute(uint256 assetId, uint256 amount) private {
        Payee[] storage ps = _payees[assetId];
        uint256 n = ps.length;
        uint256 remaining = amount;
        for (uint256 i; i < n; ++i) {
            uint256 cut = i == n - 1 ? remaining : (amount * ps[i].shareBps) / BPS;
            remaining -= cut;
            if (cut == 0) continue;
            address to = ps[i].account;
            totalEarned[to] += cut;
            (bool ok, ) = payable(to).call{value: cut, gas: PAYOUT_GAS}("");
            if (ok) {
                emit Payout(assetId, to, cut, ps[i].shareBps, ps[i].role);
            } else {
                pendingWithdrawals[to] += cut;
                emit PayoutDeferred(assetId, to, cut);
            }
        }
    }

    /// @notice Pull any direct-split payout that could not be pushed during access().
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pendingWithdrawals[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    /* ------------------------------------------------------------------ */
    /*  Views                                                              */
    /* ------------------------------------------------------------------ */

    function getAsset(uint256 assetId) external view exists(assetId) returns (Asset memory) {
        return _assets[assetId];
    }

    /// @notice Direct-split payees (empty for an asset settled by a Smart Contract for Media).
    function getPayees(uint256 assetId) external view exists(assetId) returns (Payee[] memory) {
        return _payees[assetId];
    }

    /// @notice What each wallet receives when `amount` is paid for a play
    ///         (Contract.payTo arithmetic, or the direct split).
    function previewSplit(uint256 assetId, uint256 amount)
        external
        view
        exists(assetId)
        returns (address[] memory accounts, uint256[] memory amounts)
    {
        Asset storage a = _assets[assetId];
        if (a.scm == address(0)) {
            Payee[] storage ps = _payees[assetId];
            uint256 n = ps.length;
            accounts = new address[](n);
            amounts = new uint256[](n);
            uint256 remaining = amount;
            for (uint256 i; i < n; ++i) {
                uint256 cut = i == n - 1 ? remaining : (amount * ps[i].shareBps) / BPS;
                remaining -= cut;
                accounts[i] = ps[i].account;
                amounts[i] = cut;
            }
            return (accounts, amounts);
        }
        accounts = new address[](MAX_NODES);
        amounts = new uint256[](MAX_NODES);
        uint256 m = _preview(a.scm, a.entry, amount, accounts, amounts, 0);
        assembly {
            mstore(accounts, m)
            mstore(amounts, m)
        }
    }

    function _preview(address scm, address who, uint256 amount, address[] memory accounts, uint256[] memory amounts, uint256 n)
        private
        view
        returns (uint256)
    {
        uint256 kept = amount;
        (address[] memory to, uint256[] memory pct) = _income(scm, who);
        for (uint256 i; i < to.length; ++i) {
            uint256 sub = (amount * pct[i]) / 100;
            n = _preview(scm, to[i], sub, accounts, amounts, n);
            kept -= sub;
        }
        accounts[n] = who;
        amounts[n] = kept;
        return n + 1;
    }

    function accessCount(uint256 assetId) external view exists(assetId) returns (uint256) {
        return _accessLog[assetId].length;
    }

    /// @notice Page through the access log, oldest first.
    function getAccessLog(uint256 assetId, uint256 offset, uint256 limit)
        external
        view
        exists(assetId)
        returns (Access[] memory page)
    {
        Access[] storage log = _accessLog[assetId];
        if (offset >= log.length) return new Access[](0);
        uint256 end = offset + limit;
        if (end > log.length) end = log.length;
        page = new Access[](end - offset);
        for (uint256 i = offset; i < end; ++i) page[i - offset] = log[i];
    }
}
