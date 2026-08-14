// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {PresaleVault} from "./PresaleVault.sol";
import {ICurvePadFactoryV4, LaunchConfig} from "../interfaces/ICurvePadFactoryV4.sol";

/// @title PresaleVaultFactory — mints per-presale EIP-1167 clones of PresaleVault
/// @notice A creator opens a presale for a not-yet-launched Robin V4 curve: pass the full LaunchConfig, a
/// commit-reveal salt commitment, and the presale terms (target/deadline/per-wallet cap/min contribution/finalize
/// grace). The factory clones the audited implementation and initializes it in the SAME tx (no init front-run
/// window). Heavy geometry/reserve validation is deferred to CurvePadFactoryV4.launch() at finalize; the vault's
/// initialize() enforces the presale-term bounds. Holds only immutable references + a registry — no funds, no admin.
contract PresaleVaultFactory {
    address public immutable curvePadFactory;
    address public immutable implementation; // the PresaleVault clone template

    address[] public presales;
    mapping(address => bool) public isPresale;

    event PresaleCreated(address indexed vault, address indexed creator, uint256 target, uint64 deadline);

    error BadParams();

    constructor(address curvePadFactory_, address implementation_) {
        if (curvePadFactory_ == address(0) || implementation_ == address(0)) revert BadParams();
        curvePadFactory = curvePadFactory_;
        implementation = implementation_;
    }

    /// @notice Open a new presale. `saltCommitment` = keccak256(abi.encode(tokenSalt, hookSalt, curveSalt)); the raw
    /// salts are revealed only in the finalize tx, so the freshly-launched pool is un-addressable (un-front-runnable)
    /// until then. Reverts pass through PresaleVault.initialize()'s BadParams bounds checks.
    function createPresale(
        LaunchConfig calldata cfg,
        bytes32 saltCommitment,
        uint256 target,
        uint64 deadline,
        uint256 perWalletCap,
        uint256 minContribution,
        uint64 finalizeGrace
    ) external returns (address vault) {
        if (saltCommitment == bytes32(0)) revert BadParams();
        // [L-21] Re-run the FIVE pure-cfg checks CurvePadFactoryV4.launch enforces (its lines 126-129) up front, so a
        // config that `launch` rejects unconditionally can't reach a live presale and strand contributor ETH until
        // finalize inevitably fails. These are pure functions of cfg — no geometry, no FeeConfig, no timing — so they
        // are stable across any governed retune. The retunable reserve-margin check (launch line 154) is deliberately
        // NOT hoisted (that is M-12 territory): it reads governed defaults + tick math and can move under a live presale.
        if (
            cfg.creator == address(0) || cfg.supply == 0 || cfg.curveSupply == 0 || cfg.reserveSupply == 0
                || cfg.curveSupply + cfg.reserveSupply != cfg.supply
        ) revert BadParams();
        vault = Clones.clone(implementation);
        PresaleVault(vault).initialize(
            curvePadFactory, cfg, saltCommitment, target, deadline, perWalletCap, minContribution, finalizeGrace
        );
        presales.push(vault);
        isPresale[vault] = true;
        emit PresaleCreated(vault, cfg.creator, target, deadline);
    }

    function presaleCount() external view returns (uint256) {
        return presales.length;
    }
}
