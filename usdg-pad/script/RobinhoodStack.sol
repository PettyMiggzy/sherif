// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {TrollHook} from "../src/TrollHook.sol";
import {TrollPortal} from "../src/TrollPortal.sol";
import {TrollPadFactory} from "../src/TrollPadFactory.sol";
import {PadPortal} from "../src/PadPortal.sol";
import {PadRevenueSplitter} from "../src/PadRevenueSplitter.sol";
import {TrollTreasury} from "../src/TrollTreasury.sol";
import {HolderTokenDeployer} from "../src/HolderTokenDeployer.sol";
import {HolderPadTemplate} from "../src/HolderPadTemplate.sol";
import {HolderPadPortal} from "../src/HolderPadPortal.sol";

/// @notice The whole pad stack for Robinhood Chain, from nothing, in the
/// state Arc's live deployment reached after its three incremental deploys
/// (DeployTrollPad -> DeployPadFactory -> DeployHolderPad): shared hook and
/// treasury, the white-label factory with the holder-dividends template
/// approved, and the house pad built from that template. Shared by
/// DeployRobinhood.s.sol and test/ForkRobinhood.t.sol so the fork test runs
/// the exact deploy path, not a copy of it.
///
/// `owner` must be whoever makes the calls (the broadcaster in a script,
/// the test contract in a test): it becomes the hook's bootstrapper, the
/// treasury and factory owner and the house pad's owner, and it calls the
/// bootstrap/approve functions below directly.
///
/// `create2Deployer` is who a salted `new` actually deploys from: the
/// canonical CREATE2 proxy when forge broadcasts, the calling contract
/// itself in a test. The hook address is mined against it.
abstract contract RobinhoodStack {
    // Uniswap v4 PoolManager on Robinhood Chain (chain 4663). Same address as
    // on Arc; verified on-chain before this port.
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    // USDG (Global Dollar, Paxos), 6 decimals like USDC, so every raw amount
    // in the contracts ($100 = 100e6) means the same dollars.
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    // 0x28CC — see TrollHook's contract comment and DeployTrollPad.s.sol.
    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
            | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    struct Stack {
        TrollTreasury treasury;
        TrollHook hook;
        TrollPortal mainPortal;
        PadRevenueSplitter splitterImpl;
        TrollPadFactory factory;
        HolderTokenDeployer tokenDeployer;
        HolderPadTemplate holderTemplate;
        HolderPadPortal housePad;
    }

    /// The house pad's terms, same as Arc's live house pad: platform takes
    /// its fixed 10%, creators pick any tax 0-10%, opening market cap
    /// $100-$10k, no launch fee, open to everyone.
    function _housePadSettings() internal pure returns (PadPortal.PadSettings memory) {
        return PadPortal.PadSettings({
            padOwnerShareBps: 0,
            minTaxBps: 0,
            maxTaxBps: 1_000,
            launchFee: 0,
            minStartingMarketCapQuote: 100e6,
            launchesPaused: false,
            inviteOnly: false,
            maxStartingMarketCapQuote: 10_000e6
        });
    }

    function _deployStack(address owner, address create2Deployer, uint256 setupFee, string memory housePadName)
        internal
        returns (Stack memory s)
    {
        s.treasury = new TrollTreasury(owner);

        bytes memory args = abi.encode(POOL_MANAGER, owner);
        (address predictedHook, bytes32 salt) = HookMiner.find(create2Deployer, HOOK_FLAGS, type(TrollHook).creationCode, args);
        require(predictedHook.code.length == 0, "mined hook address already has code - re-mine");
        s.hook = new TrollHook{salt: salt}(POOL_MANAGER, owner);
        require(address(s.hook) == predictedHook, "hook address mismatch - build differs from the one mined against");
        require(uint160(address(s.hook)) & Hooks.ALL_HOOK_MASK == HOOK_FLAGS, "hook address lacks the required flags");

        // The main-portal slot is one-shot and, unlike the factory slot, has
        // no renounce. Filling it is the only way to close it, so the fresh
        // deploy fills it the way Arc did, with the original TrollPortal.
        s.mainPortal = new TrollPortal(POOL_MANAGER, address(s.hook), address(s.treasury), USDG, true);
        s.hook.bootstrapMainPortal(address(s.mainPortal));

        s.splitterImpl = new PadRevenueSplitter();
        s.factory = new TrollPadFactory(
            POOL_MANAGER, address(s.hook), address(s.treasury), USDG, address(s.splitterImpl), setupFee, owner
        );
        s.hook.bootstrapFactory(address(s.factory)); // closes the factory slot for good

        s.tokenDeployer = new HolderTokenDeployer();
        s.holderTemplate = new HolderPadTemplate(
            address(s.factory),
            POOL_MANAGER,
            address(s.hook),
            address(s.treasury),
            USDG,
            address(s.splitterImpl),
            address(s.tokenDeployer)
        );
        s.factory.setTemplateApproved(address(s.holderTemplate), true);
        s.housePad = HolderPadPortal(
            s.factory.deployHousePadFromTemplate(
                address(s.holderTemplate), housePadName, owner, abi.encode(_housePadSettings())
            )
        );

        _checkStack(s, owner);
    }

    /// Read everything back off the chain; any miswiring reverts here.
    function _checkStack(Stack memory s, address owner) internal view {
        require(s.hook.mainPortalBootstrapped() && s.hook.factoryBootstrapped(), "a hook slot is still open");
        require(s.hook.factory() == address(s.factory), "factory not plugged into the hook");
        require(s.hook.isAuthorizedPortal(address(s.mainPortal)), "main portal not authorized");
        require(s.hook.isAuthorizedPortal(address(s.housePad)), "house pad not authorized");
        require(s.mainPortal.quoteAsset() == USDG && s.factory.quoteAsset() == USDG, "quote is not USDG");
        require(s.factory.owner() == owner && s.treasury.owner() == owner, "wrong owner");
        require(s.factory.isApprovedTemplate(address(s.holderTemplate)), "holders template not approved");
        require(s.factory.isHousePad(address(s.housePad)), "not a house pad");
        require(s.factory.templateOf(address(s.housePad)) == address(s.holderTemplate), "house pad not from the holders template");
        require(s.housePad.platformShareBps() == 1_000 && s.housePad.padOwner() == owner, "wrong house pad share or owner");
        require(s.housePad.holderTokenDeployer() == address(s.tokenDeployer), "wrong holder token deployer");
    }
}
