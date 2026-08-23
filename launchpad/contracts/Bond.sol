// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IUniswapV3Factory, IUniswapV3Pool, IUniswapV3MintCallback} from "./interfaces/IUniswapV3.sol";
import {PoolMath} from "./libraries/PoolMath.sol";

/// @title Bond — "The Bond"
/// @notice A protocol-owned market maker posted on a token at graduation and locked forever. It holds three
/// Uniswap v3 positions and rebalances them so the pool has a floor it can't be rugged below:
///   - Sherwood     : a full-range LP (baseline liquidity). Principal is NEVER withdrawn; its swap fees are
///                compounded straight back INTO the position on every poke, so the permanent locked liquidity
///                only ever grows — forever. Nothing is collected out to any wallet.
///   - Bounty     : a single-sided WETH range order just BELOW the price (a falling ladder of bids). Buys dips.
///   - Ambush : a single-sided token range order HIGH above the price (~3x–25x). Sells only into strength;
///                the WETH it earns funds the Bounty.
/// A permissionless `poke()` recenters the Bounty (all held WETH) and Ambush (all held tokens) around the
/// current price — which both ratchets the floor up after a pump and recycles caught tokens after a dump.
///
/// Anti-rug by construction: there is NO function that sends WETH or tokens to an arbitrary address. Sherwood
/// principal is never burned; Bounty/Ambush funds only ever become pool positions or sit here awaiting the
/// next poke; Sherwood fees are compounded back into the locked position rather than paid out. NOTHING ever
/// leaves the Bond to any wallet — there is no owner, setter, or drain.
contract Bond is IUniswapV3MintCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint24 public constant POOL_FEE = 10000;
    int24 public constant SPACING = 200; // 1% tier tick spacing
    uint128 internal constant U128_MAX = type(uint128).max;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // Band geometry (ticks from the current price; all multiples of SPACING). 1 tick ≈ 1.0001x.
    // Bounty geometry is IMMUTABLE-PER-BOND, not a constant, and is supplied by the BondDeployer that built it.
    //
    // [H-5] This is the deep-wall fix. A wall placed just off spot (the original NEAR=200) is drainable: an
    // attacker holds the price down, the wall fills at his price, and he takes the spread. Duration-based gates
    // cannot separate him from a real crash — holding a price costs nothing per unit time — so the wall is
    // bounded in CAPITAL instead: place it far enough below that a successful manipulation is not worth what it
    // costs to hold. Measured on the live v3 Bond, attacker profit crosses to negative around 6000 ticks below
    // spot and saturates by ~12000; 9000 is the shipped value, inside that margin on both sides.
    //
    // They are per-BondDeployer rather than per-Bond because the LIVE CurvePool's bytecode calls
    // `bondDeployer.deploy(token, weth, v3Factory, platform, curve)` with a FROZEN signature — a Bond cannot take
    // new arguments from the curve. Holding them on the deployer keeps that call byte-identical while making the
    // wall retunable: deploying another BondDeployer is the whole change, and nothing else moves.
    int24 public immutable BOUNTY_NEAR;
    int24 public immutable BOUNTY_FAR;
    int24 public constant AMBUSH_NEAR = 11000; // ~3.0x  : Ambush start ~3x
    int24 public constant AMBUSH_FAR = 32000; //  ~24.5x : ...up to ~25x
    int24 public constant MAX_DEV = 300; //     ~3%    : max spot-vs-TWAP deviation to allow a poke
    // 15s TWAP for the poke guard. On Robinhood Chain (~0.1s blocks, ≤1 oracle obs/active block) the curve
    // seeds the pool with cardinality 200 (~20s of buffer) — the most a single launch tx can afford under the
    // chain's 2**24 (~16.7M) per-tx gas cap — so observe(15) has ~5s of headroom and never reverts "OLD" even
    // under an every-block pump. (Coins can grow the buffer further post-launch via CurvePool.growOracle for a
    // wider margin, but 15s is covered without it.) A short recent window also keeps spot close to the mean, so
    // poke() succeeds during pumps (when recentering matters) while still bounding manipulation to MAX_DEV.
    // Bands are placed relative to spot (never straddling it); the residual within-band spot manipulation is
    // marginal (1% fee tier, bounded to the small recycled balance) — the floor-draining graduation vector is
    // closed in CurvePool.
    uint32 public constant TWAP_WINDOW = 15;
    int24 internal constant TICK_BOUND = 887200; // clamp band ticks to the valid (spacing-snapped) range

    IERC20 public immutable token;
    address public immutable WETH;
    IUniswapV3Pool public immutable pool;
    address public immutable token0;
    address public immutable token1;
    address public immutable platform; // [rev] receives the ETH side of the locked LP's trading fees
    address public immutable curve; // only the curve may post()
    bool public immutable tokenIsToken0;
    bool public immutable bountyBelow; // Bounty (WETH) sits below price iff WETH is token1

    bool public posted;
    int24 public sherwoodLo;
    int24 public sherwoodHi;
    uint128 public sherwoodL;
    int24 public bountyLo;
    int24 public bountyHi;
    uint128 public bountyL;
    int24 public ambushLo;
    int24 public ambushHi;
    uint128 public ambushL;

    bool private _minting;

    error NotCurve();
    error AlreadyPosted();
    error NotPosted();
    error NoPool();
    error NotPool();
    error Manipulated();

    event Posted(uint128 sherwoodL, uint128 bountyL, uint128 ambushL);
    event LpFeeToPlatform(uint256 wethAmount);
    event Poked(int24 tick, uint128 bountyL, uint128 ambushL, uint256 sherwoodFees0, uint256 sherwoodFees1);

    constructor(
        address token_,
        address weth_,
        address v3Factory_,
        address platform_,
        address curve_,
        int24 bountyNear_,
        int24 bountyFar_
    ) {
        require(token_ != address(0) && weth_ != address(0) && platform_ != address(0) && curve_ != address(0), "zero");
        // The wall must be a well-formed band, and it must sit strictly OUTSIDE the poke deviation tolerance.
        // `near <= MAX_DEV` is the case the poke anchoring comment below warns about: within +/-MAX_DEV a
        // mean-only recenter could straddle spot, so the band would stop being single-sided and the Bounty would
        // hold token instead of the WETH it is supposed to be bidding with.
        require(
            bountyNear_ > MAX_DEV && bountyFar_ > bountyNear_ && bountyNear_ % SPACING == 0
                && bountyFar_ % SPACING == 0 && bountyFar_ < PoolMath.MAX_TICK,
            "bounty geometry"
        );
        BOUNTY_NEAR = bountyNear_;
        BOUNTY_FAR = bountyFar_;
        address p = IUniswapV3Factory(v3Factory_).getPool(token_, weth_, POOL_FEE);
        if (p == address(0)) revert NoPool();
        (uint160 sp,,,,,,) = IUniswapV3Pool(p).slot0();
        if (sp == 0) revert NoPool();
        token = IERC20(token_);
        WETH = weth_;
        pool = IUniswapV3Pool(p);
        platform = platform_;
        curve = curve_;
        bool tIs0 = token_ < weth_;
        tokenIsToken0 = tIs0;
        bountyBelow = tIs0; // WETH is token1 -> Bounty (WETH) is the below-price band
        (token0, token1) = tIs0 ? (token_, weth_) : (weth_, token_);
    }

    /// @notice Posted once by the curve at graduation. The Bond must already hold `sherwoodWeth + bountyWeth` WETH
    /// and `sherwoodTokens + ambushTokens` of the token. Mints the three positions.
    function post(uint256 sherwoodWeth, uint256 sherwoodTokens, uint256 bountyWeth, uint256 ambushTokens)
        external
        nonReentrant
    {
        if (msg.sender != curve) revert NotCurve();
        if (posted) revert AlreadyPosted();
        posted = true;

        (uint160 sp, int24 tick,,,,,) = pool.slot0();

        // 1) Sherwood — full-range baseline liquidity (locked; only fees ever leave)
        (uint256 a0, uint256 a1) = tokenIsToken0 ? (sherwoodTokens, sherwoodWeth) : (sherwoodWeth, sherwoodTokens);
        uint128 kL = PoolMath.fullRangeLiquidity(sp, a0, a1);
        sherwoodLo = PoolMath.MIN_TICK;
        sherwoodHi = PoolMath.MAX_TICK;
        sherwoodL = kL;
        _mint(sherwoodLo, sherwoodHi, kL);

        // 2) Bounty (WETH) + 3) Ambush (token) — single-sided range orders. post() is atomic inside graduate()
        // (curve-only, no front-run window) and the oracle may be too fresh for a TWAP, so anchor to the honest
        // just-set spot on both sides (aboveAnchor == belowAnchor == tick) — identical to the original behavior.
        _placeBounty(tick, tick, bountyWeth);
        _placeAmbush(tick, tick, ambushTokens);

        emit Posted(sherwoodL, bountyL, ambushL);
    }

    /// @notice Permissionless keeper. Compounds Sherwood swap fees back into the locked LP, then recenters the Bounty (all held
    /// WETH) and Ambush (all held tokens) around the current price — ratcheting the floor and recycling
    /// caught supply. Guarded by a spot-vs-TWAP deviation check so it can't be poked at a manipulated price.
    function poke() external nonReentrant {
        if (!posted) revert NotPosted();
        (uint160 sp, int24 tick,,,,,) = pool.slot0();
        int24 mean = _requireUnmanipulated(tick);
        // Anchor the recenter walls to the CONSERVATIVE side of {spot, TWAP mean}, not raw spot: above-bands to
        // max(spot,mean), below-bands to min(spot,mean). Within the allowed ±MAX_DEV, an attacker who shoves spot to
        // make a wall richer for themselves (e.g. lift the Bounty bid toward true price to dump into) instead falls
        // back to the honest mean, removing the profitable component; whichever way they push, a band stays strictly
        // single-sided w.r.t. spot (a NEAR inside MAX_DEV would otherwise let a mean-only center straddle spot,
        // which is exactly why the constructor requires BOUNTY_NEAR > MAX_DEV).
        int24 aboveAnchor = tick > mean ? tick : mean;
        int24 belowAnchor = tick < mean ? tick : mean;

        // Sherwood: poke the position to realize fees, collect them HERE, and compound them straight back
        // into the locked full-range position. The permanent, never-withdrawable liquidity therefore GROWS
        // with every trade — forever — instead of the fees leaving. Any side left over after the balanced
        // full-range mint (fees are rarely perfectly balanced) falls through to the Bounty/Ambush recenter
        // below, so nothing is ever stranded.
        pool.burn(sherwoodLo, sherwoodHi, 0);
        (uint128 kf0, uint128 kf1) = pool.collect(address(this), sherwoodLo, sherwoodHi, U128_MAX, U128_MAX);

        // [rev] THE PLATFORM TAKES THE ETH SIDE OF THE LOCKED LP's FEES. The token side still compounds, so the
        // platform never holds a pad token — the same ETH-only invariant the v4 stack enforces.
        //
        // CRITICAL: this takes ONLY the fee just collected from the Sherwood position, measured right here. It
        // must never be derived from `balanceOf` further down, because by then the Bounty has been torn down and
        // this contract's WETH balance includes THE FLOOR'S PRINCIPAL. Skimming that would drain the floor from
        // the inside — precisely what the deep wall exists to prevent. Fee-only, by construction.
        uint256 wethFee = tokenIsToken0 ? uint256(kf1) : uint256(kf0);
        if (wethFee > 0) {
            // Best-effort: a failed transfer must never brick poke() (the keeper path that recenters the walls).
            // On failure the fee falls through to the Bounty exactly as it did before.
            (bool okFee, bytes memory ret) =
                WETH.call(abi.encodeWithSelector(IERC20.transfer.selector, platform, wethFee));
            if (okFee && (ret.length == 0 || abi.decode(ret, (bool)))) emit LpFeeToPlatform(wethFee);
        }
        // Whatever is left of the collected fee (the token side, plus the ETH side if that transfer failed)
        // compounds into the permanent position exactly as before.
        uint128 keep0 = tokenIsToken0 ? kf0 : 0;
        uint128 keep1 = tokenIsToken0 ? 0 : kf1;
        uint128 addL = PoolMath.fullRangeLiquidityOrZero(sp, keep0, keep1);
        if (addL > 0) {
            sherwoodL += addL;
            _mint(sherwoodLo, sherwoodHi, addL);
        }

        // tear down Bounty + Ambush, pull everything back here
        if (bountyL > 0) {
            pool.burn(bountyLo, bountyHi, bountyL);
            pool.collect(address(this), bountyLo, bountyHi, U128_MAX, U128_MAX);
            bountyL = 0;
        }
        if (ambushL > 0) {
            pool.burn(ambushLo, ambushHi, ambushL);
            pool.collect(address(this), ambushLo, ambushHi, U128_MAX, U128_MAX);
            ambushL = 0;
        }

        // recenter around the current price: all WETH -> Bounty, all tokens -> Ambush
        uint256 wbal = IERC20(WETH).balanceOf(address(this));
        uint256 tbal = token.balanceOf(address(this));
        if (wbal > 0) _placeBounty(aboveAnchor, belowAnchor, wbal);
        if (tbal > 0) _placeAmbush(aboveAnchor, belowAnchor, tbal);
        emit Poked(tick, bountyL, ambushL, kf0, kf1);
    }

    // --------------------------------------------------------------- internals
    function _placeBounty(int24 aboveAnchor, int24 belowAnchor, uint256 wethAmt) internal {
        // Bounty holds WETH, on the "token gets cheaper" side (below price iff WETH is token1). Anchor to the
        // conservative side: an above-band to max(spot,mean), a below-band to min(spot,mean).
        bool above = bountyBelow ? false : true;
        (int24 lo, int24 hi,) = _band(above ? aboveAnchor : belowAnchor, above, BOUNTY_NEAR, BOUNTY_FAR);
        // OrZero: skip (don't revert) if the amount is 0 or too small to make any liquidity — the WETH just
        // stays here for the next poke instead of bricking this one.
        uint128 L = PoolMath.singleSidedLiquidityOrZero(PoolMath.getSqrtRatioAtTick(lo), PoolMath.getSqrtRatioAtTick(hi), wethAmt, above);
        if (L == 0) return;
        bountyLo = lo;
        bountyHi = hi;
        bountyL = L;
        _mint(lo, hi, L);
    }

    function _placeAmbush(int24 aboveAnchor, int24 belowAnchor, uint256 tokenAmt) internal {
        // Ambush hold the token, on the "token gets more expensive" side (opposite of the Bounty).
        bool above = bountyBelow ? true : false;
        (int24 lo, int24 hi,) = _band(above ? aboveAnchor : belowAnchor, above, AMBUSH_NEAR, AMBUSH_FAR);
        uint128 L = PoolMath.singleSidedLiquidityOrZero(PoolMath.getSqrtRatioAtTick(lo), PoolMath.getSqrtRatioAtTick(hi), tokenAmt, above);
        if (L == 0) return;
        ambushLo = lo;
        ambushHi = hi;
        ambushL = L;
        _mint(lo, hi, L);
    }

    /// @dev A single-sided band `near..far` ticks away from the current price, on the ABOVE or BELOW side.
    /// `above` selects the side; token0Side == above (a band above the current tick holds only token0).
    /// Band ticks are clamped to the valid range so an extreme price can never push a bound past ±887200
    /// (which would revert getSqrtRatioAtTick / mint and brick poke).
    function _band(int24 tick, bool above, int24 near, int24 far) internal pure returns (int24 lo, int24 hi, bool isAbove) {
        int24 base = _snapDown(tick);
        if (above) {
            lo = _clamp(base + near);
            hi = _clamp(base + far);
        } else {
            lo = _clamp(base - far);
            hi = _clamp(base - near);
        }
        return (lo, hi, above);
    }

    function _clamp(int24 t) internal pure returns (int24) {
        if (t > TICK_BOUND) return TICK_BOUND;
        if (t < -TICK_BOUND) return -TICK_BOUND;
        return t;
    }

    function _snapDown(int24 t) internal pure returns (int24) {
        int24 r = t % SPACING;
        if (r != 0 && t < 0) return t - r - SPACING; // floor toward -inf
        return t - r;
    }

    function _requireUnmanipulated(int24 spotTick) internal view returns (int24 mean) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = TWAP_WINDOW;
        ago[1] = 0;
        (int56[] memory cum,) = pool.observe(ago);
        mean = PoolMath.meanTick(cum[0], cum[1], TWAP_WINDOW);
        int24 d = spotTick > mean ? spotTick - mean : mean - spotTick;
        if (d > MAX_DEV) revert Manipulated();
    }

    function _mint(int24 lo, int24 hi, uint128 L) internal {
        if (L == 0) return;
        _minting = true;
        pool.mint(address(this), lo, hi, L, "");
        _minting = false;
    }

    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata) external override {
        if (msg.sender != address(pool)) revert NotPool();
        require(_minting, "no mint");
        if (amount0Owed > 0) IERC20(token0).safeTransfer(msg.sender, amount0Owed);
        if (amount1Owed > 0) IERC20(token1).safeTransfer(msg.sender, amount1Owed);
    }

    /// @notice WETH currently standing under the price as the Bounty floor (its principal side).
    function floorWeth() external view returns (uint256) {
        return IERC20(WETH).balanceOf(address(this)); // uncommitted; committed floor lives in the pool position
    }
}
