// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {LaunchToken} from "./LaunchToken.sol";
import {LaunchTokenDeployer, CurvePoolDeployer} from "./deployers/CurveDeployers.sol";
import {PadBrand} from "./PadBrand.sol";
import {IUniswapV3Pool, IUniswapV3SwapCallback, IWETH9} from "./interfaces/IUniswapV3.sol";
import {PoolMath} from "./libraries/PoolMath.sol";

interface ICurvePool {
    function pool() external view returns (address);
    function seed() external;
}

interface IPadRouter {
    function register(
        address token,
        address pool,
        address curve,
        address projectWallet,
        uint16 buyBps,
        uint16 sellBps,
        uint16 walletBps,
        uint16 floorBps,
        uint16 burnBps
    ) external;
    function registerWithStaking(
        address token,
        address pool,
        address curve,
        address projectWallet,
        uint16 buyBps,
        uint16 sellBps,
        uint16 walletBps,
        uint16 floorBps,
        uint16 burnBps,
        uint16 stakingBps,
        uint16 robinBps
    ) external;
}

/// @title CurvePadFactory — DEX-day-one launchpad (the NOXA-style model, plus the Bond)
/// @notice One `launch()` call: deploys a clean anti-snipe token, creates a REAL Uniswap v3 pool, seeds the
/// token as a single-sided "curve" position, enables trading, and (optionally) executes the creator's own
/// **dev buy** in the same transaction — before anyone else can trade — so the dev is never sniped on their
/// own coin. The dev buy is uncapped by supply (bounded only by the curve ceiling + the ETH sent). Token is
/// on Uniswap + DexScreener from block one. Free to launch; the platform
/// funds nothing (the token seeds its own liquidity); the dev buy is optional and paid by the dev.
contract CurvePadFactory is Ownable2Step, ReentrancyGuard, IUniswapV3SwapCallback {
    using SafeERC20 for IERC20;

    uint16 public constant AMBUSH_BPS = 2500; // 25% -> the Bond's Ambush; 75% is the curve
    uint24 public constant POOL_FEE = 10000;
    // The dev's atomic opening buy is uncapped by supply — it's bounded only by the curve itself
    // (it can climb to the graduation ceiling, never past) and by how much ETH the dev sends.

    address public immutable WETH;
    address public immutable v3Factory;
    address public immutable router; // PadRouter — the swap desk + project tax
    LaunchTokenDeployer public immutable tokenDeployer;
    CurvePoolDeployer public immutable curveDeployer;
    address public immutable bondDeployer;
    address public immutable feeConfig; // owner-governed LP/swap split source, handed to every curve

    address public platform;
    bool private _swapping; // guards the swap callback (WETH is only ever transient, mid-launch)
    address private _activePool; // the pool we're mid-swap with (callback authenticity check)

    // ---- fixed terms ----
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;
    // Curve geometry is set at deploy so we can run a cheap TEST factory (small width -> graduates after a
    // few $ of buys) next to the real PRODUCTION factory, sharing the same audited code + router.
    int24 public immutable START_TICK_MAG; // e.g. 201600 -> ~$4k start FDV; sign set by ordering
    int24 public immutable CURVE_WIDTH; // span to the curve CEILING (buys can climb here, never past)
    int24 public immutable MIN_GRAD_WIDTH; // span to the MINIMUM graduation price (< CURVE_WIDTH); "let it ride" above

    /// @notice A project's self-chosen tax. Both rates are hard-capped at 4% by the router; the platform
    /// always takes 25% of whatever is collected. The three allocation splits are of the PROJECT'S 75% share
    /// and must sum to 100% (10000 bps): to the project wallet, to deepening the Bond floor, and to auto-burn.
    struct TaxParams {
        uint16 buyBps; // ≤ 400
        uint16 sellBps; // ≤ 400
        uint16 walletBps; // project-share split \_
        uint16 floorBps; //                       > sum to 10000
        uint16 burnBps; //                      _/
        address projectWallet; // 0 => the dev
    }

    struct LaunchParams {
        string name;
        string symbol;
        address dev;
        TaxParams tax;
    }

    struct Record {
        address token;
        address curve;
        address dev;
        uint256 at;
    }

    mapping(address => Record) public recordOf;
    address[] public allTokens;

    // ---- creator-chosen supply: bound the VALUATION, not the token count ----
    // TOTAL_SUPPLY above is now a DEFAULT, not a law: `launchWithSupply` lets a creator pick any supply and any
    // launch price. Supply alone carries no information — what has to stay sane is supply x price, the implied
    // fully-diluted value at launch. So the band below is the only thing checked, and supply is unbounded.
    //
    // WEI, not USD: this chain has no USD oracle, so the owner retunes the band as ETH moves and a launch client
    // must READ it. It is seeded in the constructor to +/-32x of whatever THIS factory's own default geometry
    // implies, so a fresh deploy is immediately sane without a second governance step.
    uint256 public minFdvWei;
    uint256 public maxFdvWei;
    // A constant rail above the owner-tunable ceiling. This is a FAT-FINGER GUARD, not a policy: at ~10,000x
    // the band this factory seeds itself with it never binds a real retune, it only stops maxFdvWei being set
    // to something absurd. Deliberately loose, because the band is WEI on a chain with no USD oracle and the
    // owner has to stay free to move it a long way in either direction as ETH moves.
    uint256 public constant HARD_MAX_FDV_WEI = 1_000_000 ether;

    error BadValue();
    error MarketCapOutOfRange(uint256 fdvWei);
    /// @notice Thrown by the salt-less entrypoints. Every coin address must end in `1ab5` (PadBrand), which
    /// requires a salt the caller mined off-chain — so `launch` and `launchWithSupply` cannot succeed and
    /// say so up front. Use `launchWithSalt` / `launchWithSupplyAndSalt`.
    error SaltRequired();
    error FeeBelowFloor();

    event FdvBandChanged(uint256 minWei, uint256 maxWei);
    event Launched(address indexed token, address indexed curve, address indexed pool, address dev, uint256 devBought);
    event PlatformChanged(address platform);

    constructor(
        address weth_,
        address v3Factory_,
        address platform_,
        address owner_,
        address router_,
        address tokenDeployer_,
        address curveDeployer_,
        address bondDeployer_,
        address feeConfig_,
        int24 startTickMag_,
        int24 curveWidth_,
        int24 minGradWidth_
    ) Ownable(owner_) {
        require(
            weth_ != address(0) && v3Factory_ != address(0) && platform_ != address(0) && router_ != address(0)
                && tokenDeployer_ != address(0) && curveDeployer_ != address(0) && bondDeployer_ != address(0),
            "zero"
        );
        require(
            startTickMag_ > 0 && curveWidth_ > 0 && startTickMag_ % 200 == 0 && curveWidth_ % 200 == 0
                && minGradWidth_ > 0 && minGradWidth_ % 200 == 0 && minGradWidth_ < curveWidth_
                // derived grad tick magnitude must stay inside the usable full-range bound (spacing-200 → 887200),
                // or seed()/getSqrtRatioAtTick would revert at the FIRST launch instead of failing here at deploy
                && startTickMag_ + curveWidth_ <= 887200,
            "curve"
        );
        WETH = weth_;
        v3Factory = v3Factory_;
        platform = platform_;
        router = router_;
        tokenDeployer = LaunchTokenDeployer(tokenDeployer_);
        curveDeployer = CurvePoolDeployer(curveDeployer_);
        bondDeployer = bondDeployer_;
        feeConfig = feeConfig_; // may be address(0) → curves default to 100% LP fee to the platform
        START_TICK_MAG = startTickMag_;
        CURVE_WIDTH = curveWidth_;
        MIN_GRAD_WIDTH = minGradWidth_;
        // seed the valuation band around this factory's OWN default launch, so the default `launch()` is always
        // in band by construction and a creator gets a 32x window either side of it before governance touches it
        uint256 f = PoolMath.fdvWei(TOTAL_SUPPLY, startTickMag_);
        minFdvWei = f / 32;
        maxFdvWei = f * 32;
        emit FdvBandChanged(minFdvWei, maxFdvWei);
    }

    /// @notice Retune the launch valuation band. Owner-only, takes effect on FUTURE launches only (a live pad's
    /// geometry is immutable). Denominated in wei — this chain has no USD oracle, so the band has to move as ETH does.
    /// @notice The two slices of every trade that fund staking, stamped into each coin at launch.
    ///
    ///   stakingBps — off the SELL fee, to that coin's own pool. Its own holders, its own stakers.
    ///   robinBps   — off the BUY fee, to the flagship $ROBIN pool, pooled across every coin.
    ///
    /// Both come out of the ABOVE-BASELINE part of their side, so neither the creator's 1% nor the
    /// platform's 1% can be touched. Changing these affects FUTURE launches only: a coin's slices are
    /// written once at registration and the router refuses to overwrite them, so nobody's economics
    /// move after they launch.
    uint16 public constant DEFAULT_FEE_BPS = 100;
    /// @notice Every coin on this pad pays at least 1.25% a side. The first 1% is the creator's (sell)
    /// or the platform's (buy); the 25 bps above it is what funds staking. Making it a FLOOR rather
    /// than a default is the difference between "coins fund their stakers" and "coins fund their
    /// stakers unless the creator picks the cheap option", which is the same thing as not having it.
    uint16 public constant MIN_FEE_BPS = 125;
    uint16 public constant MAX_SHARE_BPS = 100; // mirrors the router's own ceiling
    uint16 public stakingBps = 25; // 0.25% of a sell
    uint16 public robinBps = 25;   // 0.25% of a buy

    event StakingSharesSet(uint16 stakingBps, uint16 robinBps);

    function setStakingShares(uint16 stakingBps_, uint16 robinBps_) external onlyOwner {
        if (stakingBps_ > MAX_SHARE_BPS || robinBps_ > MAX_SHARE_BPS) revert BadValue();
        stakingBps = stakingBps_;
        robinBps = robinBps_;
        emit StakingSharesSet(stakingBps_, robinBps_);
    }

    function setFdvBand(uint256 minWei, uint256 maxWei) external onlyOwner {
        if (minWei == 0 || maxWei < minWei || maxWei > HARD_MAX_FDV_WEI) revert BadValue();
        minFdvWei = minWei;
        maxFdvWei = maxWei;
        emit FdvBandChanged(minWei, maxWei);
    }

    /// @notice The implied FDV, in wei, of `supply` tokens launched at `startTickMag` — EXACTLY the value
    /// `launchWithSupply` checks against the band. A UI can price a creator's choice before they spend gas.
    function quoteFdvWei(uint256 supply, int24 startTickMag) external pure returns (uint256) {
        return PoolMath.fdvWei(supply, startTickMag);
    }

    receive() external payable {} // for WETH.withdraw refunds during a dev buy

    /// @notice DEPRECATED — always reverts `SaltRequired`. Use `launchWithSalt`.
    /// @dev Kept so the published ABI still resolves and old callers get a named error rather than a
    /// function-not-found. Every coin address must carry the `1ab5` brand (PadBrand), and the only way to
    /// reach a branded address is a salt the caller mined, so a salt-less launch cannot succeed.
    function launch(LaunchParams calldata p) external payable nonReentrant returns (address token, address curve, address pool) {
        return _launch(p, 0, 0, bytes32(0));
    }

    /// @notice THE launch entrypoint. `tokenSalt` is a salt the caller mined off-chain so the coin's address
    /// ends in `1ab5` — the Robin brand. That ending is a RULE, not a creator preference: `PadBrand` enforces
    /// it on every path and there is no way to opt out, so this is the only way to open a pad.
    /// @dev It stayed separate from `launch` rather than becoming a fifth `LaunchParams` field because that
    /// tuple is a published ABI the bots, the SDK and the site all encode; moving the selector would have
    /// broken every one of them silently.
    /// @param tokenSalt mined over `keccak256(abi.encodePacked(msg.sender, candidate))` — the fold below binds
    /// the address to the CALLER, so a salt someone else publishes is worthless to you and yours to them.
    function launchWithSalt(LaunchParams calldata p, bytes32 tokenSalt)
        external
        payable
        nonReentrant
        returns (address token, address curve, address pool)
    {
        return _launch(p, 0, 0, tokenSalt);
    }

    /// @notice Creator-chosen SUPPLY and LAUNCH PRICE, with the mandatory mined salt.
    /// @param supply total token units to mint; 0 = this factory's default (1,000,000,000e18).
    /// @param startTickMag positive launch-price magnitude in ticks (multiple of 200); 0 = the factory default.
    ///        A HIGHER magnitude is a CHEAPER token, so raising it while holding supply lowers the valuation.
    /// @dev Supply is bounded by NOTHING. What is checked is supply x launch price — the implied FDV — against
    /// [minFdvWei, maxFdvWei], reverting `MarketCapOutOfRange` before a single byte of state is written. That is
    /// what makes supply cosmetic: at equal FDV a 10,000-token coin and a 1,000,000,000-token coin take the same
    /// money for the same percentage of the coin. `CURVE_WIDTH` stays factory-wide, so every coin still graduates
    /// at the same multiple of its own launch price no matter what supply or valuation was chosen.
    function launchWithSupplyAndSalt(LaunchParams calldata p, uint256 supply, int24 startTickMag, bytes32 tokenSalt)
        external
        payable
        nonReentrant
        returns (address token, address curve, address pool)
    {
        return _launch(p, supply, startTickMag, tokenSalt);
    }

    /// @notice DEPRECATED — always reverts `SaltRequired`. Use `launchWithSupplyAndSalt`, which carries the
    /// supply/price documentation this function used to hold.
    /// @dev Kept for ABI compatibility only; see `launch` above for why a salt-less entrypoint cannot work.
    function launchWithSupply(LaunchParams calldata p, uint256 supply, int24 startTickMag)
        external
        payable
        nonReentrant
        returns (address token, address curve, address pool)
    {
        return _launch(p, supply, startTickMag, bytes32(0));
    }

    function _launch(LaunchParams calldata p, uint256 supply_, int24 startTickMag_, bytes32 tokenSalt_)
        internal
        returns (address token, address curve, address pool)
    {
        if (p.dev == address(0)) revert BadValue();

        uint256 totalSupply = supply_ == 0 ? TOTAL_SUPPLY : supply_;
        int24 mag = startTickMag_ == 0 ? START_TICK_MAG : startTickMag_;
        // The same bounds the constructor enforces on the factory default, re-run per launch: a caller-supplied
        // magnitude must be positive, spacing-aligned, and leave the derived ceiling inside the usable range —
        // otherwise CurvePool's seed() would revert mid-launch instead of failing here, before anything exists.
        if (mag <= 0 || mag % 200 != 0 || mag + CURVE_WIDTH > 887200) revert BadValue();
        {
            uint256 fdv = PoolMath.fdvWei(totalSupply, mag);
            if (fdv < minFdvWei || fdv > maxFdvWei) revert MarketCapOutOfRange(fdv);
        }

        uint256 ambushAmt = (totalSupply * AMBUSH_BPS) / 10_000;
        uint256 curveAmt = totalSupply - ambushAmt;
        if (ambushAmt == 0 || curveAmt == 0) revert BadValue(); // a supply too small to split 75/25 at all

        // ── NO ANTI-SNIPE GUARD. An all-zero GuardConfig, deliberately and permanently. ────────────────────
        //
        // Robinhood Chain is a single-sequencer FCFS L2 with no public mempool, so the attack the guard was
        // built for — watch a pending buy, jump ahead of it — is not reachable here. The dev's opening buy is
        // already atomic inside this launch tx, ahead of the field, so the guard was never protecting the dev.
        //
        // BE HONEST ABOUT WHAT THIS GIVES UP. FCFS removes mempool front-running; it does NOT remove launch
        // sniping. A bot polling for new pools can still buy in the block after launch, and on FCFS the FASTEST
        // bot wins deterministically every time rather than probabilistically. Every coin on this factory opens
        // with no per-wallet cap, no max-tx, no cooldown and no dead window: first block, any size, any wallet.
        // That is the product decision, taken with the trade understood.
        //
        // Mechanically zero is a complete off switch, not a weak setting: LaunchToken gates its entire guard
        // block on `block.timestamp < launchTime + antiSnipeSecs`, which is false from the launch block onward,
        // so maxTxNow()/maxWalletNow() report type(uint256).max and no guard branch is ever taken. It also makes
        // `seedBlocklist` permanently unusable (it reverts WindowOver once the window is past) — correct for a
        // factory that has no window at all, and worth knowing before anyone reaches for it.
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
        // A creator who mined an address ending supplies the salt; everyone else gets the old behaviour.
        //
        // The salt is bound to msg.sender HERE, at the factory. That is load-bearing and was got wrong once:
        // `LaunchTokenDeployer.deploy` also folds msg.sender in, but on this path msg.sender IS THE FACTORY —
        // one constant address for every creator — so that fold separates a direct caller of the public
        // deployer from the factory, and separates nothing between two creators going through `launch()`.
        //
        // Without this binding the CREATE2 preimage is (deployer, keccak(factory, tokenSalt), keccak(initcode ++
        // name, symbol, supply, factory, guard)) — every component public or caller-supplied, and `p.dev` in
        // none of them, because LaunchToken's constructor does not take it. So anyone who learned a salt could
        // land on that exact address with THEMSELVES as dev and their own tax settings. A salt leaks the moment
        // a launch tx is mined, including a REVERTED one, whose calldata is in block history forever.
        //
        // Folding msg.sender in makes the address unreproducible by anyone else: a different caller mining the
        // same target ending gets a different salt and a different address. Mining still works — the client
        // mines over `keccak(msg.sender, candidate)`.
        // [BRAND] A mined salt is now MANDATORY, so the old entropy fallback is gone. It derived the salt
        // from block.number/block.timestamp, which nobody can mine against ahead of time — under the brand
        // rule it could only ever produce an unbranded address and revert. Rejecting it here names the real
        // problem instead of failing later with a suffix error the caller cannot act on.
        //
        // This is a BREAKING change to `launch(p)` and `launchWithSupply(p, supply, mag)`: both are now
        // salt-less entrypoints on a pad that requires a salt, so they always revert. They are kept rather
        // than deleted so the published ABI still resolves and callers get `SaltRequired` instead of a
        // function-not-found. Every client must move to `launchWithSalt` / `launchWithSupplyAndSalt`.
        if (tokenSalt_ == bytes32(0)) revert SaltRequired();
        bytes32 salt = keccak256(abi.encodePacked(msg.sender, tokenSalt_));
        token = tokenDeployer.deploy(p.name, p.symbol, totalSupply, address(this), g, salt);
        // [BRAND] Every Robin coin address ends in `1ab5`. Checked here, before the pool, the curve or a
        // single token transfer exists, so an unmined salt wastes gas and can never half-create a pad.
        PadBrand.requireBrand(token);

        int24 startTick = token < WETH ? -mag : mag;
        curve = curveDeployer.deploy(
            token, WETH, v3Factory, platform, p.dev, bondDeployer, feeConfig, curveAmt, ambushAmt, startTick, CURVE_WIDTH, MIN_GRAD_WIDTH
        );
        pool = ICurvePool(curve).pool();

        IERC20(token).safeTransfer(curve, totalSupply);
        LaunchToken(token).setCurve(curve); // lets the curve exempt the Bond it posts at graduation
        LaunchToken(token).enableTrading(pool, curve, uint64(block.timestamp));
        LaunchToken(token).exemptAddress(router); // router receives tokens on burnDev/flushBurn — never a sniper
        ICurvePool(curve).seed();

        // register the project's tax with the swap desk (router enforces the 4% caps + 100% allocation)
        address projWallet = p.tax.projectWallet == address(0) ? p.dev : p.tax.projectWallet;
        // Rejected with a NAMED error rather than silently raised. Quietly charging a creator more
        // than they chose would be worse than refusing, and the site's own minimum is 1.25% so this is
        // only reachable by a caller going around it.
        if (p.tax.buyBps < MIN_FEE_BPS || p.tax.sellBps < MIN_FEE_BPS) revert FeeBelowFloor();

        // The two staking slices are stamped at registration and are IMMUTABLE for the life of the
        // coin — the router registers once and refuses to be overwritten. A buyer can therefore read
        // what funds the stakers off the chain and know it cannot be changed afterwards, which is the
        // whole reason it is set here rather than governed later.
        IPadRouter(router).registerWithStaking(
            token, pool, curve, projWallet, p.tax.buyBps, p.tax.sellBps,
            p.tax.walletBps, p.tax.floorBps, p.tax.burnBps,
            _bounded(stakingBps, p.tax.sellBps), _bounded(robinBps, p.tax.buyBps)
        );

        // optional dev buy (uncapped by supply), atomic and ahead of the field
        uint256 devBought;
        if (msg.value > 0) devBought = _devBuy(token, pool, startTick, p.dev);

        recordOf[token] = Record(token, curve, p.dev, block.timestamp);
        allTokens.push(token);
        emit Launched(token, curve, pool, p.dev, devBought);
    }

    /// @dev Clamp a configured slice to what a coin's own fee can actually give up.
    ///
    /// A creator may set their sell fee to the 1% floor, which leaves NOTHING above the baseline —
    /// and the router rejects a slice that would eat into it. Without this, a launch at the minimum
    /// fee would revert at `register` with a tax error, which is a baffling failure for someone who
    /// simply chose the cheapest option. Clamping degrades the funding instead of the launch: a coin
    /// at the floor funds its stakers nothing, and one above the floor funds them the configured
    /// slice. Nobody is ever blocked from launching by a platform-level setting.
    function _bounded(uint16 want, uint16 sideBps) internal pure returns (uint16) {
        if (sideBps <= DEFAULT_FEE_BPS) return 0;
        uint16 room = sideBps - DEFAULT_FEE_BPS;
        return want > room ? room : want;
    }

    function _devBuy(address token, address pool, int24 startTick, address dev) internal returns (uint256 bought) {
        bool tokenIsToken0 = token < WETH;
        bool zeroForOne = !tokenIsToken0; // buying the token: WETH-in. WETH is token0 iff !tokenIsToken0.
        // no supply cap on the dev buy: let it climb the whole curve up to the graduation ceiling
        // (buys can never go past it). Any ETH beyond what fills the curve is refunded.
        int24 capTick = tokenIsToken0 ? startTick + CURVE_WIDTH : startTick - CURVE_WIDTH;
        uint160 sqrtLimit = PoolMath.getSqrtRatioAtTick(capTick);

        IWETH9(WETH).deposit{value: msg.value}();
        _swapping = true;
        _activePool = pool;
        IUniswapV3Pool(pool).swap(address(this), zeroForOne, int256(msg.value), sqrtLimit, "");
        _activePool = address(0);
        _swapping = false;

        // deliver bought tokens to the dev; refund any unused ETH (no supply cap on the dev buy)
        bought = IERC20(token).balanceOf(address(this));
        if (bought > 0) IERC20(token).safeTransfer(dev, bought);
        uint256 leftWeth = IERC20(WETH).balanceOf(address(this));
        if (leftWeth > 0) {
            IWETH9(WETH).withdraw(leftWeth);
            (bool ok,) = dev.call{value: leftWeth}("");
            require(ok, "refund");
        }
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external override {
        require(_swapping && msg.sender == _activePool, "no swap");
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        IERC20(WETH).safeTransfer(msg.sender, owed); // msg.sender is the pool mid-swap
    }

    function setPlatform(address p_) external onlyOwner {
        require(p_ != address(0), "zero");
        platform = p_;
        emit PlatformChanged(p_);
    }

    // [v2] `seedBlocklist` IS DELIBERATELY GONE. It was an owner pass-through for seeding a coin's buy-side
    // sniper blocklist during its anti-snipe window. This factory launches every coin with a zero GuardConfig,
    // so there is no window and the token freezes its blocklist immediately — the call could only ever revert
    // `WindowOver`. An owner-only entrypoint that always reverts is worse than no entrypoint: it advertises a
    // protection this factory cannot provide. If a guarded variant is ever wanted, it comes back with the guard.

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }
}
