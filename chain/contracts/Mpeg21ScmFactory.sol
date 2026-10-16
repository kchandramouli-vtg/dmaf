// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./mpeg21/Contract.sol";
import "./mpeg21/NFToken.sol";

/**
 * @title  One-transaction deployer for ISO/IEC 21000-23 Smart Contracts for Media
 * @notice DMAF helper, not part of the standard. It performs exactly the calls
 *         the reference EthereumDeployer makes one transaction at a time
 *         (scmgenerator-dltmanager/lib/eth/deployer.js):
 *
 *           1. NFToken.newToken(receiver, uri) for every deontic expression
 *           2. NFToken.newToken(receiver, uri) for every object
 *           3. new Contract(identifier, parties, nfToken, deonticIds, objectIds,
 *                           relatedContracts, relations, incomeBeneficiaries,
 *                           incomePercentages, contentUri, contentHash)
 *
 *         The standard contracts (chain/contracts/mpeg21/*.sol) are the reference
 *         files byte for byte, so the resulting on-chain state is what the
 *         reference EthereumParser reads. Doing it in one call means one
 *         MetaMask confirmation instead of (deontics + objects + 1).
 */
contract Mpeg21ScmFactory {
    struct Spec {
        bytes identifier;
        address[] parties;
        address[] deonticReceivers;
        string[] deonticUris;
        address[] objectReceivers;
        string[] objectUris;
        address[] relatedContracts;
        uint256[] relations;
        address[] incomeBeneficiaries;
        uint256[] incomePercentages;
        string contentUri;
        bytes contentHash;
    }

    /// Every Smart Contract for Media deployed through this factory.
    address[] public deployed;
    mapping(address => bool) public isScm;

    event ScmDeployed(
        address indexed scm,
        address indexed deployer,
        address indexed nfToken,
        bytes identifier,
        string contentUri,
        uint256[] deonticTokenIds,
        uint256[] objectTokenIds
    );

    error LengthMismatch(string what);

    function deploy(NFToken nfToken, Spec calldata s)
        external
        returns (address scm, uint256[] memory deonticIds, uint256[] memory objectIds)
    {
        if (s.deonticReceivers.length != s.deonticUris.length) revert LengthMismatch("deontics");
        if (s.objectReceivers.length != s.objectUris.length) revert LengthMismatch("objects");
        if (s.relatedContracts.length != s.relations.length) revert LengthMismatch("relations");

        deonticIds = new uint256[](s.deonticUris.length);
        for (uint256 i; i < deonticIds.length; ++i) {
            deonticIds[i] = nfToken.newToken(s.deonticReceivers[i], s.deonticUris[i]);
        }
        objectIds = new uint256[](s.objectUris.length);
        for (uint256 i; i < objectIds.length; ++i) {
            objectIds[i] = nfToken.newToken(s.objectReceivers[i], s.objectUris[i]);
        }
        scm = _newContract(nfToken, s, deonticIds, objectIds);
        deployed.push(scm);
        isScm[scm] = true;
        emit ScmDeployed(scm, msg.sender, address(nfToken), s.identifier, s.contentUri, deonticIds, objectIds);
    }

    function _newContract(NFToken nfToken, Spec calldata s, uint256[] memory deonticIds, uint256[] memory objectIds)
        private
        returns (address)
    {
        Spec memory m = s; // memory refs take one stack slot each (calldata arrays take two)
        Contract c = new Contract(
            m.identifier,
            m.parties,
            nfToken,
            deonticIds,
            objectIds,
            m.relatedContracts,
            m.relations,
            m.incomeBeneficiaries,
            m.incomePercentages,
            m.contentUri,
            m.contentHash
        );
        return address(c);
    }

    function deployedCount() external view returns (uint256) {
        return deployed.length;
    }
}
