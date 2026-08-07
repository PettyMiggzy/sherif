// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Pull the real Uniswap V4 core + test harness into our compilation unit so Hardhat emits
// artifacts for them. This lets the local integration test deploy a genuine PoolManager
// (identical bytecode/compiler to the live 0x8366) and drive real swaps — proving the A3
// afterSwapReturnDelta skim idiom closes the unlock cleanly, without needing the fork RPC.
// TEST-ONLY: never deployed to mainnet.
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {TestERC20} from "@uniswap/v4-core/src/test/TestERC20.sol";
