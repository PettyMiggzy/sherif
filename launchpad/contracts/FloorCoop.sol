// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IUniswapV3Factory, IUniswapV3Pool, IUniswapV3MintCallback, IWETH9} from "./interfaces/IUniswapV3.sol";
import {PoolMath} from "./libraries/PoolMath.sol";

/// @title FloorCoop — the community floor: add liquidity, earn fees, can't hurt the coin
/// @notice A per-coin *sibling* to the Bond (never touches the sealed Bond, so the Bond's un-ruggability proof
/// stays intact). Anyone deposits ETH; the vault places it as a **single-sided WETH buy-wall** on the "coin
/// gets cheaper" side of the current price (below price when the coin is token0, above when it's token1).
/// Depositors earn the 1% swap fee on every dip that trades into the wall.
///
/// Why pulling this liquidity can't hurt the coin: the wall sits on the cheaper-than-spot side, so removing an
/// unfilled bid there does NOT move the price — it only thins the floor (never a rug). If a dip trades through
/// the wall first, the depositor's WETH has already become the coin (they're a holder now). The coin's core
/// price-supporting liquidity is the Bond's Sherwood LP, which has no withdraw path and can never be pulled.
/// (Honest caveat: while a dip is *inside* the band, pulling removes live support — still not a rug, but real
/// depth; disclosed in the UI.)
///
/// Accounting is **NAV-based** (v2, hardened after the deep review): shares price against the vault's total
/// value in WETH — the band position (valued at TWAP) plus loose WETH and loose caught-token (valued at TWAP),
/// net of the fee reserve. This makes entry and exit symmetric, so a new depositor can never mint cheap shares
/// against caught token they didn't fund. Every mint/burn is TWAP-guarded and consolidates to ONE position at
/// its recorded range; fee reserves are strictly segregated from principal. Still pending the pre-deploy deep
/// audit + simulations before any real deposit.
contract FloorCoop is IUniswapV3MintCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint24 public constant POOL_FEE = 10000;
    int24 public constant SPACING = 200;
    uint128 internal constant U128_MAX = type(uint128).max;
    uint256 internal constant ACC = 1e18;
    uint256 internal constant WAD = 1e18;

    int24 public constant WALL_NEAR = 200; //  one spacing off spot
    int24 public constant WALL_FAR = 6800; //  ~-49% wide buy wall
    int24 public constant MAX_DEV = 300; //     ~3% max spot-vs-TWAP deviation
    uint32 public constant TWAP_WINDOW = 15;
    int24 internal constant TICK_BOUND = 887200;
    uint256 public constant COOLDOWN = 2 days; // withdrawal lock after each deposit (smoothing + anti-JIT)
    uint256 public constant MIN_FIRST_DEPOSIT = 1e15; // 0.001 ETH — raises the bar on share-inflation games

    IERC20 public immutable token;
    address public immutable WETH;
    IUniswapV3Pool public immutable pool;
    address public immutable token0;
    address public immutable token1;
    bool public immutable tokenIsToken0;
    bool public immutable wallBelow; // WETH wall is on the below-price side iff WETH is token1

    // the ONE WETH band the vault owns (invariant: bandL is the liquidity that lives at exactly [bandLo,bandHi])
    int24 public bandLo;
    int24 public bandHi;
    uint128 public bandL;

    uint256 public totalShares;
    mapping(address => uint256) public shares;
    mapping(address => uint256) public depositAt;

    // fee accumulators (two: a filled wall earns fees in token, an unfilled one in WETH)
    uint256 public accWethPerShare;
    uint256 public accTokenPerShare;
    mapping(address => uint256) public debtWeth;
    mapping(address => uint256) public debtToken;
    // fees collected but not yet claimed — kept strictly apart from principal
    uint256 public feeReserveWeth;
    uint256 public feeReserveToken;

    bool private _minting;

    error NoPool();
    error NotPool();
    error Manipulated();
    error Zero();
    error Locked();
    error TooMuch();
    error Slippage();
    error PayFail();
    error MinDeposit();

    event Deposited(address indexed user, uint256 wethIn, uint256 sharesMinted);
    event Withdrawn(address indexed user, uint256 sharesBurned, uint256 wethOut, uint256 tokenOut);
    event Claimed(address indexed user, uint256 wethOut, uint256 tokenOut);
    event Recentered(int24 tick, int24 lo, int24 hi, uint128 liquidity);
    event Harvested(uint256 wethFees, uint256 tokenFees);

    constructor(address token_, address weth_, address v3Factory_) {
        require(token_ != address(0) && weth_ != address(0), "zero");
        address p = IUniswapV3Factory(v3Factory_).getPool(token_, weth_, POOL_FEE);
        if (p == address(0)) revert NoPool();
        (uint160 sp,,,,,,) = IUniswapV3Pool(p).slot0();
        if (sp == 0) revert NoPool();
        token = IERC20(token_);
        WETH = weth_;
        pool = IUniswapV3Pool(p);
        bool tIs0 = token_ < weth_;
        tokenIsToken0 = tIs0;
        wallBelow = tIs0;
        (token0, token1) = tIs0 ? (token_, weth_) : (weth_, token_);
    }

    receive() external payable {} // WETH.withdraw

    // ─────────────────────────────────────────────────────────────── deposit ──
    /// @notice Add ETH to the coin's floor buy-wall. Shares are priced against the vault's total NAV (WETH),
    /// so you can never mint cheap shares against value others funded. `minSharesOut` guards slippage.
    function deposit(uint256 minSharesOut) external payable nonReentrant returns (uint256 sharesMinted) {
        if (msg.value == 0) revert Zero();
        (, int24 spot,,,,,) = pool.slot0();
        int24 tw = _requireUnmanipulated(spot); // guard EVERY placement (H5), returns the TWAP tick
        _harvest();
        _payPending(msg.sender); // settle the caller's fees before their share count changes (H6)

        // consolidate the existing position to ONE band at the current price (C3), using principal WETH only (C2)
        _recenterInternal(spot);
        uint256 navBefore = _navWeth(tw); // AFTER recenter, BEFORE the new ETH

        if (totalShares == 0 && msg.value < MIN_FIRST_DEPOSIT) revert MinDeposit();
        IWETH9(WETH).deposit{value: msg.value}();
        uint128 addL = _addWethToWall(msg.value); // adds to the just-recentered band (same range)
        if (addL == 0) revert Zero();

        sharesMinted = totalShares == 0 ? msg.value : Math.mulDiv(msg.value, totalShares, navBefore);
        if (sharesMinted == 0 || sharesMinted < minSharesOut) revert Slippage();

        totalShares += sharesMinted;
        shares[msg.sender] += sharesMinted;
        depositAt[msg.sender] = block.timestamp;
        _syncDebt(msg.sender);
        emit Deposited(msg.sender, msg.value, sharesMinted);
    }

    // ────────────────────────────────────────────────────────────── withdraw ──
    /// @notice Withdraw `shareAmt` after the cooldown — the pro-rata slice of the band + loose principal (WETH
    /// if untouched, token if a dip filled it). `minWethOut`/`minTokenOut` guard slippage.
    function withdraw(uint256 shareAmt, uint256 minWethOut, uint256 minTokenOut)
        external
        nonReentrant
        returns (uint256 wethOut, uint256 tokenOut)
    {
        uint256 bal = shares[msg.sender];
        if (shareAmt == 0 || shareAmt > bal) revert TooMuch();
        if (block.timestamp < depositAt[msg.sender] + COOLDOWN) revert Locked();
        (, int24 spot,,,,,) = pool.slot0();
        _requireUnmanipulated(spot); // guard (H5/H7)
        _harvest();
        _payPending(msg.sender); // pay fees + shrink the reserve, before splitting principal

        uint256 ts = totalShares;
        // (a) pro-rata of LOOSE principal (caught token, or WETH freed by a recenter) — balance net of reserves
        uint256 looseW = IERC20(WETH).balanceOf(address(this)) - feeReserveWeth;
        uint256 looseT = token.balanceOf(address(this)) - feeReserveToken;
        uint256 shareW = Math.mulDiv(looseW, shareAmt, ts);
        uint256 shareT = Math.mulDiv(looseT, shareAmt, ts);
        // (b) pro-rata of the live band, freed by burning their fraction of the liquidity
        uint128 removeL = uint128(Math.mulDiv(bandL, shareAmt, ts));
        uint256 posW;
        uint256 posT;
        if (removeL > 0) {
            (uint256 a0, uint256 a1) = pool.burn(bandLo, bandHi, removeL);
            pool.collect(address(this), bandLo, bandHi, uint128(a0), uint128(a1));
            bandL -= removeL;
            (posW, posT) = tokenIsToken0 ? (a1, a0) : (a0, a1);
        }

        shares[msg.sender] = bal - shareAmt;
        totalShares = ts - shareAmt;
        _syncDebt(msg.sender);

        wethOut = shareW + posW;
        tokenOut = shareT + posT;
        if (wethOut < minWethOut || tokenOut < minTokenOut) revert Slippage();
        if (wethOut > 0) {
            IWETH9(WETH).withdraw(wethOut);
            (bool ok,) = msg.sender.call{value: wethOut}("");
            if (!ok) revert PayFail();
        }
        if (tokenOut > 0) token.safeTransfer(msg.sender, tokenOut);
        emit Withdrawn(msg.sender, shareAmt, wethOut, tokenOut);
    }

    // ───────────────────────────────────────────────────────────────── claim ──
    /// @notice Claim your accrued dip-buy fees (real ETH + any token from filled dips) without withdrawing.
    function claim() external nonReentrant {
        _harvest();
        _payPending(msg.sender);
    }

    // ─────────────────────────────────────────────────────────────── recenter ──
    /// @notice Permissionless keeper: realize fees and re-place the wall at the current price so the floor
    /// tracks the coin. TWAP-guarded.
    function recenter() external nonReentrant {
        (, int24 spot,,,,,) = pool.slot0();
        _requireUnmanipulated(spot);
        _harvest();
        _recenterInternal(spot);
    }

    // ─────────────────────────────────────────────────────────────── views ────
    function pending(address user) external view returns (uint256 wethOwed, uint256 tokenOwed) {
        uint256 s = shares[user];
        wethOwed = (s * accWethPerShare) / ACC - debtWeth[user];
        tokenOwed = (s * accTokenPerShare) / ACC - debtToken[user];
    }

    /// @notice Total vault value in WETH (band + loose principal), valued at TWAP.
    function totalNav() external view returns (uint256) {
        return _navWeth(_twapTick());
    }

    // ─────────────────────────────────────────────────────── internals: NAV ──
    function _twapTick() internal view returns (int24) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = TWAP_WINDOW;
        ago[1] = 0;
        (int56[] memory cum,) = pool.observe(ago);
        return PoolMath.meanTick(cum[0], cum[1], TWAP_WINDOW);
    }

    /// vault NAV in WETH at the given (TWAP) tick: band position + loose principal, token priced at TWAP
    function _navWeth(int24 twapTick) internal view returns (uint256) {
        uint160 sqrtTwap = PoolMath.getSqrtRatioAtTick(twapTick);
        uint256 bandWeth;
        uint256 bandToken;
        if (bandL > 0) {
            (uint256 a0, uint256 a1) = PoolMath.getAmountsForLiquidity(
                sqrtTwap, PoolMath.getSqrtRatioAtTick(bandLo), PoolMath.getSqrtRatioAtTick(bandHi), bandL
            );
            (bandWeth, bandToken) = tokenIsToken0 ? (a1, a0) : (a0, a1);
        }
        uint256 looseW = IERC20(WETH).balanceOf(address(this)) - feeReserveWeth;
        uint256 looseT = token.balanceOf(address(this)) - feeReserveToken;
        uint256 price = PoolMath.twapPriceWethPerToken(twapTick, tokenIsToken0); // WETH per token, 1e18
        return bandWeth + looseW + Math.mulDiv(bandToken + looseT, price, WAD);
    }

    // ─────────────────────────────────────────────────── internals: fees ──
    function _harvest() internal {
        if (bandL == 0 || totalShares == 0) return;
        pool.burn(bandLo, bandHi, 0);
        (uint128 c0, uint128 c1) = pool.collect(address(this), bandLo, bandHi, U128_MAX, U128_MAX);
        (uint256 wethFee, uint256 tokenFee) = tokenIsToken0 ? (uint256(c1), uint256(c0)) : (uint256(c0), uint256(c1));
        if (wethFee > 0) {
            accWethPerShare += (wethFee * ACC) / totalShares;
            feeReserveWeth += wethFee;
        }
        if (tokenFee > 0) {
            accTokenPerShare += (tokenFee * ACC) / totalShares;
            feeReserveToken += tokenFee;
        }
        if (wethFee > 0 || tokenFee > 0) emit Harvested(wethFee, tokenFee);
    }

    function _payPending(address user) internal {
        uint256 s = shares[user];
        uint256 wethOwed = (s * accWethPerShare) / ACC - debtWeth[user];
        uint256 tokenOwed = (s * accTokenPerShare) / ACC - debtToken[user];
        _syncDebt(user);
        if (wethOwed > 0) {
            feeReserveWeth -= wethOwed;
            IWETH9(WETH).withdraw(wethOwed);
            (bool ok,) = user.call{value: wethOwed}("");
            if (!ok) revert PayFail();
        }
        if (tokenOwed > 0) {
            feeReserveToken -= tokenOwed;
            token.safeTransfer(user, tokenOwed);
        }
        if (wethOwed > 0 || tokenOwed > 0) emit Claimed(user, wethOwed, tokenOwed);
    }

    function _syncDebt(address user) internal {
        uint256 s = shares[user];
        debtWeth[user] = (s * accWethPerShare) / ACC;
        debtToken[user] = (s * accTokenPerShare) / ACC;
    }

    // ─────────────────────────────────────────── internals: position ──
    /// burn the current band, pull principal back here, re-place ONLY principal WETH (never the fee reserve)
    /// as a fresh single-sided wall at the current price. Caught token stays loose (valued in NAV).
    function _recenterInternal(int24 tick) internal {
        if (bandL > 0) {
            pool.burn(bandLo, bandHi, bandL);
            pool.collect(address(this), bandLo, bandHi, U128_MAX, U128_MAX);
            bandL = 0;
        }
        uint256 principalWeth = IERC20(WETH).balanceOf(address(this)) - feeReserveWeth; // C2: exclude reserve
        if (principalWeth > 0) _placeWall(tick, principalWeth);
        emit Recentered(tick, bandLo, bandHi, bandL);
    }

    /// add WETH to the band at the current tick. Precondition: bandL is 0 OR the recomputed range equals the
    /// stored range (guaranteed because callers recenter first) — so bandL always matches [bandLo,bandHi] (C3).
    function _addWethToWall(uint256 wethAmt) internal returns (uint128 addL) {
        (, int24 tick,,,,,) = pool.slot0();
        (int24 lo, int24 hi, bool above) = _band(tick, wallBelow ? false : true, WALL_NEAR, WALL_FAR);
        addL = PoolMath.singleSidedLiquidityOrZero(PoolMath.getSqrtRatioAtTick(lo), PoolMath.getSqrtRatioAtTick(hi), wethAmt, above);
        if (addL == 0) return 0;
        // never accumulate liquidity at a different range than what's stored
        require(bandL == 0 || (lo == bandLo && hi == bandHi), "range");
        bandLo = lo;
        bandHi = hi;
        bandL += addL;
        _mint(lo, hi, addL);
    }

    function _placeWall(int24 tick, uint256 wethAmt) internal {
        (int24 lo, int24 hi, bool above) = _band(tick, wallBelow ? false : true, WALL_NEAR, WALL_FAR);
        uint128 L = PoolMath.singleSidedLiquidityOrZero(PoolMath.getSqrtRatioAtTick(lo), PoolMath.getSqrtRatioAtTick(hi), wethAmt, above);
        if (L == 0) return; // dust — WETH stays loose for the next placement
        bandLo = lo;
        bandHi = hi;
        bandL = L;
        _mint(lo, hi, L);
    }

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
        if (r != 0 && t < 0) return t - r - SPACING;
        return t - r;
    }

    /// @dev reverts if spot deviates from the TWAP mean by more than MAX_DEV; returns the TWAP tick.
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
}
