// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ElysiumStack} from "./ElysiumStack.sol";

/// @notice Deploys the pad on Kinetiq's Elysium. One broadcast; see
/// ElysiumStack.sol for what it builds.
///
///   Testnet (chain 99801), quoted in the bridged testnet USDC:
///   QUOTE_TOKEN=0x7d29d8047b905000459c0e80c34a26ceedcb47b2 \
///   ADMIN=<owner wallet> DEPLOYER_PRIVATE_KEY=<deployer key> \
///   forge script script/DeployElysium.s.sol:DeployElysium \
///     --rpc-url https://testnet-rpc.elysium.kinetiq.xyz --broadcast --slow
///
///   Mainnet: EXPECTED_CHAIN_ID=<the id from Kinetiq's own docs> and
///   QUOTE_TOKEN=<mainnet USDC>; never guess either. Prefer
///   --account/--ledger with --sender over a raw key.
///
/// Env:
///   QUOTE_TOKEN (required)  6-decimal USDC the pools pair with
///   EXPECTED_CHAIN_ID       default 99801 (testnet); the script refuses any other chain
///   ADMIN                   owner of the treasury, house pad, factory (offered) and PoolManager; default: the deployer
///   POOL_MANAGER            reuse a v4 PoolManager instead of deploying one
///   PERMIT2                 default: the canonical 0x000000000022D473030F116dDEE9F6B43aC78BA3
///   EXISTING_TREASURY       reuse a RobinTreasury owned by ADMIN
///   PAD_SETUP_FEE           white-label pad setup fee, raw USDC (default 100e6 = $100)
///   HOUSE_PAD_NAME          default "Elysium Pad" (stored on-chain)
contract DeployElysium is Script, ElysiumStack {
    address internal constant CANONICAL_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    function run() external returns (ElysiumDeploy memory d) {
        uint256 expectedChainId = vm.envOr("EXPECTED_CHAIN_ID", uint256(99801));
        require(block.chainid == expectedChainId, "connected chain is not EXPECTED_CHAIN_ID");
        require(CREATE2_DEPLOYER.code.length > 0, "CREATE2 deployer missing on this chain - hook mining would not match");

        uint256 deployerKey = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        address deployer = deployerKey != 0 ? vm.addr(deployerKey) : msg.sender;
        require(deployer != DEFAULT_SENDER, "pass --sender <address> with --account/--ledger (or set DEPLOYER_PRIVATE_KEY)");

        address quote = vm.envAddress("QUOTE_TOKEN");
        address admin = vm.envOr("ADMIN", deployer);
        address existingPoolManager = vm.envOr("POOL_MANAGER", address(0));
        address permit2 = vm.envOr("PERMIT2", CANONICAL_PERMIT2);
        address existingTreasury = vm.envOr("EXISTING_TREASURY", address(0));
        uint256 setupFee = vm.envOr("PAD_SETUP_FEE", uint256(100e6));
        string memory name = vm.envOr("HOUSE_PAD_NAME", string("Elysium Pad"));

        console2.log("Chain id:", block.chainid);
        console2.log("Deploying as:", deployer);
        console2.log("Admin:", admin);
        console2.log("Quote (USDC):", quote);

        if (deployerKey != 0) vm.startBroadcast(deployerKey);
        else vm.startBroadcast();
        d = _deployElysium(deployer, CREATE2_DEPLOYER, admin, quote, existingPoolManager, permit2, setupFee, name, existingTreasury);
        vm.stopBroadcast();

        console2.log("PoolManager (Uniswap v4 core):", d.poolManager);
        console2.log("PadRouter (swaps; UniversalRouter-compatible):", d.router);
        console2.log("Permit2:", permit2);
        console2.log("RobinTreasury:", address(d.stack.treasury));
        console2.log("RobinHook:", address(d.stack.hook));
        console2.log("RobinFeeDesk:", address(d.stack.feeDesk));
        console2.log("RobinPortal (main portal - the site's):", address(d.stack.mainPortal));
        console2.log("PadRevenueSplitter implementation:", address(d.stack.splitterImpl));
        console2.log("RobinPadFactory:", address(d.stack.factory));
        console2.log("HolderTokenDeployer:", address(d.stack.tokenDeployer));
        console2.log("HolderPadTemplate:", address(d.stack.holderTemplate));
        console2.log("House pad:", address(d.stack.housePad));
        console2.log("Block:", block.number);
    }
}
