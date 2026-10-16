// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Test helper: a contract wallet that refuses ETH until switched on.
///  - direct split: checks that a bad payee never blocks a listener's play
///    (its share is deferred and pulled later with withdraw());
///  - Smart Contract for Media: Contract.payTo pays with transfer(), so the
///    registry must refuse SCMs whose cascade reaches a contract wallet.
contract RevertingPayee {
    bool public accept;

    function setAccept(bool a) external { accept = a; }

    function pull(address registry) external {
        (bool ok, ) = registry.call(abi.encodeWithSignature("withdraw()"));
        require(ok, "withdraw failed");
    }

    receive() external payable {
        require(accept, "no thanks");
    }
}
