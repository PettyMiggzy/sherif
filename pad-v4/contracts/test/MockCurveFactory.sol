// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {LockVault} from "../core/LockVault.sol";

interface ISeedable {
    function seed() external;
}

/// @title MockCurveFactory — TEST-ONLY factory stand-in so a directly-deployed curve can seed + graduate.
/// @notice The curve gates seed() on msg.sender==factory and routes onGraduated() through the factory to the
/// LockVault (the vault's sole registrar). This mock provides both hooks so a focused local graduation test can
/// run the FULL waterfall without the production factory's flag-mining / deployer machinery.
contract MockCurveFactory {
    LockVault public lockVault;

    function setLockVault(address lv) external {
        lockVault = LockVault(payable(lv));
    }

    function seedCurve(address curve) external {
        ISeedable(curve).seed();
    }

    function onGraduated(uint256 lpTokenId, Currency c0, Currency c1, address staking) external {
        lockVault.registerLaunch(lpTokenId, c0, c1, staking);
    }
}
