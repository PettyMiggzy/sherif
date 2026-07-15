// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IUniswapV3Factory, IUniswapV3Pool, IUniswapV3MintCallback} from "./interfaces/IUniswapV3.sol";
import {PoolMath} from "./libraries/PoolMath.sol";

/// @title Bond — "The Sheriff's Bond"
/// @notice A protocol-owned market maker posted on a token at graduation and locked forever. It holds three
/// Uniswap v3 positions and rebalances them so the pool has a floor it can't be rugged below:
///   - Keep     : a full-range LP (baseline liquidity). Principal is NEVER withdrawn; only its swap fees are
///                collected, to the platform. This is the permanent locked liquidity.
///   - Moat     : a single-sided WETH range order just BELOW the price (a falling ladder of bids). Buys dips.
///   - Ramparts : a single-sided token range order HIGH above the price (~3x–25x). Sells only into strength;
///                the WETH it earns funds the Moat.
/// A permissionless `poke()` recenters the Moat (all held WETH) and Ramparts (all held tokens) around the
/// current price — which both ratchets the floor up after a pump and recycles caught tokens after a dump.
///
/// Anti-rug by construction: there is NO function that sends WETH or tokens to an arbitrary address. Keep
/// principal is never burned; Moat/Ramparts funds only ever become pool positions or sit here awaiting the
/// next poke; only Keep swap fees leave, and only to the fixed platform wallet. No owner, setter, or drain.
contract Bond is IUniswapV3MintCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint24 public constant POOL_FEE = 10000;
    int24 public constant SPACING = 200; // 1% tier tick spacing
    uint128 internal constant U128_MAX = type(uint128).max;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // Band geometry (ticks from the current price; all multiples of SPACING). 1 tick ≈ 1.0001x.
    int24 public constant MOAT_NEAR = 200; //   ~+0%   : Moat starts one spacing off spot
    int24 public constant MOAT_FAR = 6800; //   ~-49%  : ...down to roughly half price (a wide buy wall)
    int24 public constant RAMP_NEAR = 11000; // ~3.0x  : Ramparts start ~3x
    int24 public constant RAMP_FAR = 32000; //  ~24.5x : ...up to ~25x
    int24 public constant MAX_DEV = 300; //     ~3%    : max spot-vs-TWAP deviation to allow a poke
    uint32 public constant TWAP_WINDOW = 900; //        15-min TWAP for the poke guard

    IERC20 public immutable token;
    address public immutable WETH;
    IUniswapV3Pool public immutable pool;
    address public immutable token0;
    address public immutable token1;
    address public immutable platform; // receives Keep swap fees
    address public immutable curve; // only the curve may post()
    bool public immutable tokenIsToken0;
    bool public immutable moatBelow; // Moat (WETH) sits below price iff WETH is token1

    bool public posted;
    int24 public keepLo;
    int24 public keepHi;
    uint128 public keepL;
    int24 public moatLo;
    int24 public moatHi;
    uint128 public moatL;
    int24 public rampLo;
    int24 public rampHi;
    uint128 public rampL;

    bool private _minting;

    error NotCurve();
    error AlreadyPosted();
    error NotPosted();
    error NoPool();
    error NotPool();
    error Manipulated();

    event Posted(uint128 keepL, uint128 moatL, uint128 rampL);
    event Poked(int24 tick, uint128 moatL, uint128 rampL, uint256 keepFees0, uint256 keepFees1);

    constructor(address token_, address weth_, address v3Factory_, address platform_, address curve_) {
        require(token_ != address(0) && weth_ != address(0) && platform_ != address(0) && curve_ != address(0), "zero");
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
        moatBelow = tIs0; // WETH is token1 -> Moat (WETH) is the below-price band
        (token0, token1) = tIs0 ? (token_, weth_) : (weth_, token_);
    }

    /// @notice Posted once by the curve at graduation. The Bond must already hold `keepWeth + moatWeth` WETH
    /// and `keepTokens + rampTokens` of the token. Mints the three positions.
    function post(uint256 keepWeth, uint256 keepTokens, uint256 moatWeth, uint256 rampTokens)
        external
        nonReentrant
    {
        if (msg.sender != curve) revert NotCurve();
        if (posted) revert AlreadyPosted();
        posted = true;

        (uint160 sp, int24 tick,,,,,) = pool.slot0();

        // 1) Keep — full-range baseline liquidity (locked; only fees ever leave)
        (uint256 a0, uint256 a1) = tokenIsToken0 ? (keepTokens, keepWeth) : (keepWeth, keepTokens);
        uint128 kL = PoolMath.fullRangeLiquidity(sp, a0, a1);
        keepLo = PoolMath.MIN_TICK;
        keepHi = PoolMath.MAX_TICK;
        keepL = kL;
        _mint(keepLo, keepHi, kL);

        // 2) Moat (WETH) + 3) Ramparts (token) — single-sided range orders
        _placeMoat(tick, moatWeth);
        _placeRamparts(tick, rampTokens);

        emit Posted(keepL, moatL, rampL);
    }

    /// @notice Permissionless keeper. Sweeps Keep swap fees to the platform, then recenters the Moat (all held
    /// WETH) and Ramparts (all held tokens) around the current price — ratcheting the floor and recycling
    /// caught supply. Guarded by a spot-vs-TWAP deviation check so it can't be poked at a manipulated price.
    function poke() external nonReentrant {
        if (!posted) revert NotPosted();
        (uint160 sp, int24 tick,,,,,) = pool.slot0();
        _requireUnmanipulated(tick);

        // Keep: poke the position to realize fees, then collect ONLY fees (principal stays — locked)
        pool.burn(keepLo, keepHi, 0);
        (uint128 kf0, uint128 kf1) = pool.collect(platform, keepLo, keepHi, U128_MAX, U128_MAX);

        // tear down Moat + Ramparts, pull everything back here
        if (moatL > 0) {
            pool.burn(moatLo, moatHi, moatL);
            pool.collect(address(this), moatLo, moatHi, U128_MAX, U128_MAX);
            moatL = 0;
        }
        if (rampL > 0) {
            pool.burn(rampLo, rampHi, rampL);
            pool.collect(address(this), rampLo, rampHi, U128_MAX, U128_MAX);
            rampL = 0;
        }

        // recenter around the current price: all WETH -> Moat, all tokens -> Ramparts
        uint256 wbal = IERC20(WETH).balanceOf(address(this));
        uint256 tbal = token.balanceOf(address(this));
        if (wbal > 0) _placeMoat(tick, wbal);
        if (tbal > 0) _placeRamparts(tick, tbal);
        sp; // silence unused
        emit Poked(tick, moatL, rampL, kf0, kf1);
    }

    // --------------------------------------------------------------- internals
    function _placeMoat(int24 tick, uint256 wethAmt) internal {
        // Moat holds WETH, on the "token gets cheaper" side (below price iff WETH is token1).
        (int24 lo, int24 hi, bool above) = _band(tick, moatBelow ? false : true, MOAT_NEAR, MOAT_FAR);
        uint128 L = PoolMath.singleSidedLiquidity(PoolMath.getSqrtRatioAtTick(lo), PoolMath.getSqrtRatioAtTick(hi), wethAmt, above);
        moatLo = lo;
        moatHi = hi;
        moatL = L;
        _mint(lo, hi, L);
    }

    function _placeRamparts(int24 tick, uint256 tokenAmt) internal {
        // Ramparts hold the token, on the "token gets more expensive" side (opposite of the Moat).
        (int24 lo, int24 hi, bool above) = _band(tick, moatBelow ? true : false, RAMP_NEAR, RAMP_FAR);
        uint128 L = PoolMath.singleSidedLiquidity(PoolMath.getSqrtRatioAtTick(lo), PoolMath.getSqrtRatioAtTick(hi), tokenAmt, above);
        rampLo = lo;
        rampHi = hi;
        rampL = L;
        _mint(lo, hi, L);
    }

    /// @dev A single-sided band `near..far` ticks away from the current price, on the ABOVE or BELOW side.
    /// `above` selects the side; token0Side == above (a band above the current tick holds only token0).
    function _band(int24 tick, bool above, int24 near, int24 far) internal pure returns (int24 lo, int24 hi, bool isAbove) {
        int24 base = _snapDown(tick);
        if (above) {
            lo = base + near;
            hi = base + far;
        } else {
            lo = base - far;
            hi = base - near;
        }
        return (lo, hi, above);
    }

    function _snapDown(int24 t) internal pure returns (int24) {
        int24 r = t % SPACING;
        if (r != 0 && t < 0) return t - r - SPACING; // floor toward -inf
        return t - r;
    }

    function _requireUnmanipulated(int24 spotTick) internal view {
        uint32[] memory ago = new uint32[](2);
        ago[0] = TWAP_WINDOW;
        ago[1] = 0;
        (int56[] memory cum,) = pool.observe(ago);
        int24 mean = PoolMath.meanTick(cum[0], cum[1], TWAP_WINDOW);
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

    /// @notice WETH currently standing under the price as the Moat floor (its principal side).
    function floorWeth() external view returns (uint256) {
        return IERC20(WETH).balanceOf(address(this)); // uncommitted; committed floor lives in the pool position
    }
}
