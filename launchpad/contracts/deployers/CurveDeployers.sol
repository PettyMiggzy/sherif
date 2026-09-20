// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CurveToken} from "../CurveToken.sol";
import {BondingCurve} from "../BondingCurve.sol";
import {Bond} from "../Bond.sol";
import {CurvePool} from "../CurvePool.sol";
import {LaunchToken} from "../LaunchToken.sol";
import {OtcVault} from "../OtcVault.sol";
import {DailyAuctionVault} from "../DailyAuctionVault.sol";
import {RobinStaking} from "../RobinStaking.sol";

/// @notice Thin deployers so the big contracts' creation bytecode isn't inlined into CurveLaunchFactory
/// (24KB contract-size limit). Each is deployed once and its address handed to the factory.

contract CurveTokenDeployer {
    function deploy(string calldata name, string calldata symbol, uint256 supply, address recipient)
        external
        returns (address)
    {
        return address(new CurveToken(name, symbol, supply, recipient));
    }
}

contract BondingCurveDeployer {
    function deploy(
        address token,
        address weth,
        address v3Factory,
        address platform,
        address dev,
        uint256 virtEth,
        uint256 curveSupply,
        uint256 gradTarget,
        uint32 antiSnipeSecs,
        uint256 maxBuyWei,
        address bondDeployer,
        uint256 ambushSupply
    ) external returns (address) {
        return address(
            new BondingCurve(
                token, weth, v3Factory, platform, dev, virtEth, curveSupply, gradTarget, antiSnipeSecs, maxBuyWei,
                bondDeployer, ambushSupply
            )
        );
    }
}

/// @notice Deploys the Bond, and OWNS ITS WALL GEOMETRY.
/// @dev [J] `deploy(...)`'s signature is FROZEN: the already-deployed CurvePool bytecode calls it with exactly
/// these SIX arguments (token, weth, v3Factory, platform, curve, poolFee — this comment used to say five,
/// stale since poolFee was added), and that CurvePool is reused by every factory (the pool deployer is shared
/// and stateless). So the Bounty band cannot be threaded through the curve — it lives here instead, as
/// constructor immutables that this deployer stamps into every Bond it builds.
///
/// The upshot is that RETUNING THE WALL IS A ONE-CONTRACT DEPLOY: stand up another BondDeployer with different
/// numbers and hand it to a new factory. Nothing else in the stack changes, and no live coin is touched — a
/// coin's Bond geometry is fixed by whichever deployer its curve was born pointing at.
contract BondDeployer {
    int24 public immutable bountyNear;
    int24 public immutable bountyFar;

    /// @param bountyNear_ ticks BELOW spot where the WETH buy wall starts (deeper = harder to farm, see Bond)
    /// @param bountyFar_  ticks below spot where it ends.
    /// [J] Bond's OWN constructor re-validates both against the SPECIFIC pool it is being built for
    /// (`bountyNear_ % SPACING == 0`, where SPACING is THAT coin's real tick spacing for its chosen poolFee
    /// tier) — but that check only ever fires per-launch, at that coin's graduation, long after this deployer
    /// is already live and other coins may already be pointed at it. A band that happens to be a multiple of
    /// 10 (valid for the 0.05% tier) but not of 200 (the 1% tier — the DEFAULT) would deploy here cleanly,
    /// pass every 0.05%-tier smoke test, and then revert `'bounty geometry'` inside `graduate()` for every
    /// 1%-tier coin that ever points at it — permanently, and discovered only once someone tries to graduate.
    /// Validate here too, against 200 (the strictest of the two tiers this stack offers — a multiple of 200
    /// is automatically a multiple of 10), so a bad band can never be deployed in the first place.
    constructor(int24 bountyNear_, int24 bountyFar_) {
        // 300 mirrors Bond.MAX_DEV exactly (a `public constant` on Bond, but not reachable as `Bond.MAX_DEV`
        // from here — Solidity does not resolve a contract-level constant through a bare type name across
        // contracts). Keep this in sync if MAX_DEV is ever retuned.
        require(
            bountyNear_ > 300 && bountyFar_ > bountyNear_ && bountyNear_ % 200 == 0 && bountyFar_ % 200 == 0,
            "band must align to every offered tier"
        );
        bountyNear = bountyNear_;
        bountyFar = bountyFar_;
    }

    function deploy(address token, address weth, address v3Factory, address platform, address curve, uint24 poolFee)
        external
        returns (address)
    {
        return address(new Bond(token, weth, v3Factory, platform, curve, bountyNear, bountyFar, poolFee));
    }
}

contract LaunchTokenDeployer {
    /// @dev CREATE2 with a caller-supplied salt so the token (and therefore its Uniswap pool) address is not
    /// a predictable function of this deployer's nonce. That closes a launch-DoS where an attacker precreates
    /// AND initializes the token's WETH pool at the next predictable address, making CurvePool's own
    /// initialize() revert and permanently bricking every launch that reuses that address.
    function deploy(
        string calldata name,
        string calldata symbol,
        uint256 supply,
        address factory,
        LaunchToken.GuardConfig calldata g,
        bytes32 salt
    ) external returns (address) {
        // Bind the CREATE2 salt to the CALLER so the token's address depends on who deploys it. This deployer is
        // public and stateless (reused across factories), so without this an attacker could call deploy() directly
        // with the victim's exact salt+args and occupy the target address first, bricking the launch. Folding
        // msg.sender into the salt makes an attacker's address differ from the factory's — the collision is gone.
        bytes32 s = keccak256(abi.encodePacked(msg.sender, salt));
        return address(new LaunchToken{salt: s}(name, symbol, supply, factory, g));
    }

    /// @notice The `keccak256` of the exact init-code this deployer builds for a factory launch.
    /// @dev Every coin address must end in `1ab5` (PadBrand), so every launch needs a salt mined off-chain
    /// against the address the factory will really reach — and mining ~65k candidates cannot be done with
    /// `eth_call`, so the client reproduces the CREATE2 chain locally and needs this hash.
    ///
    /// It lives HERE rather than in a standalone lens on purpose. This contract is the one that embeds
    /// `type(LaunchToken).creationCode`, so the hash it returns is by construction the code it will deploy.
    /// A separate helper — or a copy of the bytecode shipped inside the website bundle — could be compiled
    /// from different source or settings than the deployer that is actually live, and the only symptom would
    /// be every launch reverting `BadTokenSuffix` with nothing pointing at the cause.
    ///
    /// The GuardConfig is hardcoded all-zero because that is what `CurvePadFactory._launch` passes and no
    /// entrypoint passes anything else — anti-snipe is off permanently. Taking it as a parameter would invite
    /// a client to predict an address no launch can produce.
    function tokenInitCodeHash(string calldata name, string calldata symbol, uint256 supply, address factory)
        public
        pure
        returns (bytes32)
    {
        LaunchToken.GuardConfig memory g = LaunchToken.GuardConfig({
            deadSecs: 0,
            phase1Secs: 0,
            antiSnipeSecs: 0,
            maxTxBps1: 0,
            maxWalletBps1: 0,
            maxTxBps2: 0,
            maxWalletBps2: 0,
            cooldownSecs: 0
        });
        return keccak256(abi.encodePacked(type(LaunchToken).creationCode, abi.encode(name, symbol, supply, factory, g)));
    }

    /// @notice The address `factory.launchWithSalt(p, tokenSalt)` deploys `creator`'s coin to.
    /// @dev The whole chain in one call, so a client can check its local arithmetic once against the chain
    /// before it starts looping. This is NOT the mining loop — 65k round-trips is not a thing you do over RPC.
    ///   inner = keccak256(abi.encodePacked(creator, tokenSalt))   the factory binds the CALLER
    ///   outer = keccak256(abi.encodePacked(factory, inner))       this deployer binds ITS caller
    ///   addr  = CREATE2(this, outer, tokenInitCodeHash(...))
    function predict(
        address factory,
        address creator,
        bytes32 tokenSalt,
        string calldata name,
        string calldata symbol,
        uint256 supply
    ) external view returns (address) {
        bytes32 inner = keccak256(abi.encodePacked(creator, tokenSalt));
        bytes32 outer = keccak256(abi.encodePacked(factory, inner));
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff), address(this), outer, tokenInitCodeHash(name, symbol, supply, factory)
                        )
                    )
                )
            )
        );
    }
}

contract CurvePoolDeployer {
    function deploy(
        address token,
        address weth,
        address v3Factory,
        address platform,
        address dev,
        address bondDeployer,
        address feeConfig,
        uint256 curveSupply,
        uint256 ambushSupply,
        int24 startTick,
        int24 curveWidth,
        int24 minGradWidth,
        uint24 poolFee
    ) external returns (address) {
        return address(
            new CurvePool(
                token, weth, v3Factory, platform, dev, bondDeployer, feeConfig, curveSupply, ambushSupply, startTick, curveWidth, minGradWidth, poolFee
            )
        );
    }
}

/// @notice Deploys `RobinStaking` on demand. Exists so a `RobinStaking` contract's ~8.6KB creation bytecode
/// lives HERE, not inlined into `DailyAuctionVault` (which would bloat every auction-enabled launch's
/// deployment gas even though most auction days never touch a staking pool at all) — same "thin deployer"
/// reasoning as every other deployer in this file, just discovered the hard way (measured: an inlined `new
/// RobinStaking(...)` pushed a whole auction launch transaction past Robinhood Chain's real 16.7M-per-tx cap).
contract RobinStakingDeployer {
    function deploy(address stakeToken, address owner) external returns (address) {
        return address(new RobinStaking(stakeToken, owner));
    }
}

contract DailyAuctionVaultDeployer {
    /// @notice Shared across every vault this deployer creates — baked in at ITS OWN construction (like
    /// BondDeployer bakes in bountyNear/bountyFar) so CurvePadFactory's own deploy-call shape never needs to
    /// change if the staking-deployer wiring ever does.
    address public immutable robinStakingDeployer;

    constructor(address robinStakingDeployer_) {
        robinStakingDeployer = robinStakingDeployer_;
    }

    function deploy(address token, address weth, address curve, address platform, uint8 auctionDays, uint256 auctionAmt)
        external
        returns (address)
    {
        return address(new DailyAuctionVault(token, weth, curve, platform, robinStakingDeployer, auctionDays, auctionAmt));
    }
}

contract OtcVaultDeployer {
    function deploy(
        address v3Factory,
        address token,
        address weth,
        address sheriff,
        address platform,
        uint32 twapWindow,
        uint256 otcPrice,
        uint256 burnRatio
    ) external returns (address) {
        return address(new OtcVault(v3Factory, token, weth, sheriff, platform, twapWindow, otcPrice, burnRatio));
    }
}
