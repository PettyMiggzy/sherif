// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {RobinhoodStack} from "./RobinhoodStack.sol";

/// @notice Fresh deploy of the whole pad on Robinhood Chain (chain 4663),
/// quoted in USDG. One broadcast; see RobinhoodStack.sol for what it builds.
///
/// Arc reached the same state in three steps (DeployRobinPad.s.sol,
/// DeployPadFactory.s.sol, DeployHolderPad.s.sol). Those scripts upgrade
/// Arc's live contracts and hardcode Arc addresses, so they are Arc-only
/// history; on Robinhood run this one instead.
///
///   export PATH="$HOME/.foundry/bin:$PATH"
///   bash script/setup-deps.sh && forge build
///   forge script script/DeployRobinhood.s.sol:DeployRobinhood \
///     --rpc-url https://rpc.mainnet.chain.robinhood.com \
///     --broadcast --slow --legacy --with-gas-price 40000000 --account <keystore-name> --sender <address>
///
/// `--legacy` is required: Robinhood Chain takes type-0 transactions only.
/// Gas is ETH, not USDG. The deploy needs no USDG at all.
///
/// Env (optional): PAD_SETUP_FEE (raw USDG, default 100e6 = $100 per
/// white-label pad), HOUSE_PAD_NAME (default "Robin Labs Pad"; stored on-chain).
contract DeployRobinhood is Script, RobinhoodStack {
    function run() external returns (Stack memory s) {
        require(block.chainid == 4663 || vm.envOr("ALLOW_OTHER_CHAIN", false), "not Robinhood Chain (4663)");
        require(CREATE2_DEPLOYER.code.length > 0, "CREATE2 deployer missing on this chain - hook mining would not match");
        require(POOL_MANAGER.code.length > 0 && USDG.code.length > 0, "PoolManager or USDG missing on this chain");

        uint256 deployerKey = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        address deployer = deployerKey != 0 ? vm.addr(deployerKey) : msg.sender;
        require(deployer != DEFAULT_SENDER, "pass --sender <address> with --account/--ledger (or set DEPLOYER_PRIVATE_KEY)");
        require(deployer != 0xA95f339fde0fb6846e7d888f6A063EC2aB04C678, "leaked testnet key");

        uint256 setupFee = vm.envOr("PAD_SETUP_FEE", uint256(100e6));
        string memory name = vm.envOr("HOUSE_PAD_NAME", string("Robin Labs Pad"));
        console2.log("Deploying as:", deployer);

        if (deployerKey != 0) vm.startBroadcast(deployerKey);
        else vm.startBroadcast();
        s = _deployStack(deployer, CREATE2_DEPLOYER, setupFee, name);
        vm.stopBroadcast();

        console2.log("RobinTreasury:", address(s.treasury));
        console2.log("RobinHook:", address(s.hook));
        console2.log("RobinPortal (main portal, closes the hook's one-shot slot):", address(s.mainPortal));
        console2.log("PadRevenueSplitter implementation:", address(s.splitterImpl));
        console2.log("RobinPadFactory:", address(s.factory));
        console2.log("PadPortalTemplate (template #1):", s.factory.padPortalTemplate());
        console2.log("HolderTokenDeployer:", address(s.tokenDeployer));
        console2.log("HolderPadTemplate (template #2, approved):", address(s.holderTemplate));
        console2.log("House pad (holder dividends) - point the site's portal at this:", address(s.housePad));
        console2.log("Setup fee for white-label pads (raw USDG):", setupFee);
        console2.log("Block:", block.number);
        console2.log("Verify with: bash script/verify.sh mainnet (update its addresses to this run's first)");
    }
}
