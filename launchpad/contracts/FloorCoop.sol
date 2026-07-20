// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IUniswapV3Factory, IUniswapV3Pool, IUniswapV3MintCallback, IWETH9} from "./interfaces/IUniswapV3.sol";
import {PoolMath} from "./libraries/PoolMath.sol";

/// @title FloorCoop — the community floor: add liquidity, earn fees, can't hurt the coin
/// @notice A per-coin *sibling* to the Bond (it NEVER touches the sealed Bond, so the Bond's un-ruggability
/// proof stays intact). Anyone deposits WETH; the vault places it as a **single-sided buy-wall BELOW the
/// current price** — exactly like the Bond's Bounty, but withdrawable. Depositors earn the 1% Uniswap swap
/// fee on every dip that trades into the wall, tracked on-chain (accPerShare, no indexer/Merkle needed).
///
/// Why pulling this liquidity can't hurt the coin — the whole point:
///   • The wall sits BELOW price. Removing a bid that's under the price does NOT move the price down — it just
///     thins the floor. That is categorically different from removing at-price LP (which craters the price =
///     the rug). So a withdrawal here can never dump the token.
///   • If a dip trades through the wall first, the depositor's WETH has already become the token (they're a
///     holder now, and the wall did its job absorbing the dip). Their later exit is a normal token sale, their
///     own tokens — not a liquidity rug.
///   • The coin's core price-supporting liquidity is the Bond's Sherwood LP, which has NO withdraw function
///     anywhere and can never be pulled by anyone. This vault only ever adds *below-price* depth on top of it.
///   • A cooldown smooths withdrawals so the floor can't vanish in a single block (also kills JIT skimming).
///
/// Share accounting is by LIQUIDITY (objective, manipulation-resistant), not spot NAV: you get shares in
/// proportion to the liquidity your WETH mints, and you withdraw the pro-rata slice of the position — WETH if
/// the wall is untouched, or token if it filled. Honest range-order semantics; disclosed, never "safe yield".
///
/// SECURITY: this is a first implementation pending the pre-deploy deep audit + simulations. Do not deploy
/// without it. The mint/burn/collect + TWAP-guard patterns are lifted verbatim from the audited Bond.
contract FloorCoop is IUniswapV3MintCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint24 public constant POOL_FEE = 10000;
    int24 public constant SPACING = 200;
    uint128 internal constant U128_MAX = type(uint128).max;
    uint256 internal constant ACC = 1e18; // accumulator scale

    // buy-wall geometry: a WETH band just below spot down to ~-49% (mirrors the Bond Bounty)
    int24 public constant WALL_NEAR = 200; //  one spacing under spot
    int24 public constant WALL_FAR = 6800; //  down to ~half price
    int24 public constant MAX_DEV = 300; //    max spot-vs-TWAP deviation for a placement (~3%)
    uint32 public constant TWAP_WINDOW = 15;
    int24 internal constant TICK_BOUND = 887200;
    uint256 public constant COOLDOWN = 2 days; // withdrawal lock after each deposit (smoothing + anti-JIT)

    IERC20 public immutable token;
    address public immutable WETH;
    IUniswapV3Pool public immutable pool;
    address public immutable token0;
    address public immutable token1;
    bool public immutable tokenIsToken0;
    bool public immutable wallBelow; // WETH wall sits below price iff WETH is token1 (i.e. token is token0)

    // the single below-price WETH band the vault currently owns
    int24 public bandLo;
    int24 public bandHi;
    uint128 public bandL;

    // share accounting (shares ∝ liquidity contributed)
    uint256 public totalShares;
    mapping(address => uint256) public shares;
    mapping(address => uint256) public depositAt;

    // fee accounting — two accumulators because a filled wall pays fees in token, an unfilled one in WETH
    uint256 public accWethPerShare;
    uint256 public accTokenPerShare;
    mapping(address => uint256) public debtWeth;
    mapping(address => uint256) public debtToken;
    // WETH/token collected as fees but not yet claimed — kept apart from principal so a withdrawal can never
    // pay out another depositor's unclaimed fees
    uint256 public feeReserveWeth;
    uint256 public feeReserveToken;

    bool private _minting;

    error NoPool();
    error NotPool();
    error Manipulated();
    error Zero();
    error Locked();
    error TooMuch();
    error PayFail();

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
        wallBelow = tIs0; // WETH is token1 → its band is the below-price side
        (token0, token1) = tIs0 ? (token_, weth_) : (weth_, token_);
    }

    receive() external payable {} // WETH.withdraw

    // ─────────────────────────────────────────────────────────────── deposit ──
    /// @notice Add ETH to the coin's floor buy-wall and start earning dip-buy fees. Shares ∝ the liquidity
    /// your WETH mints into the below-price band.
    function deposit() external payable nonReentrant returns (uint256 sharesMinted) {
        if (msg.value == 0) revert Zero();
        _harvest();
        (, int24 tick,,,,,) = pool.slot0();
        // Re-place the EXISTING wall below price first (single-sided WETH needs price above the band). Done
        // before wrapping the new ETH so the new deposit's liquidity is measured on its own.
        if (bandL > 0 && !_wallIsBelow(tick)) _recenterInternal(tick);

        uint256 lBefore = bandL;
        IWETH9(WETH).deposit{value: msg.value}();
        uint128 addL = _addWethToWall(msg.value);
        if (addL == 0) revert Zero(); // dust — nothing minted

        sharesMinted = (totalShares == 0 || lBefore == 0) ? addL : (uint256(addL) * totalShares) / lBefore;
        if (sharesMinted == 0) revert Zero();

        totalShares += sharesMinted;
        shares[msg.sender] += sharesMinted;
        depositAt[msg.sender] = block.timestamp;
        _syncDebt(msg.sender);
        emit Deposited(msg.sender, msg.value, sharesMinted);
    }

    // ────────────────────────────────────────────────────────────── withdraw ──
    /// @notice Withdraw `shareAmt` of your position after the cooldown. You receive the pro-rata slice of the
    /// wall — WETH if it's untouched, token if a dip filled it. Harmless to the coin either way (see header).
    function withdraw(uint256 shareAmt) external nonReentrant returns (uint256 wethOut, uint256 tokenOut) {
        uint256 bal = shares[msg.sender];
        if (shareAmt == 0 || shareAmt > bal) revert TooMuch();
        if (block.timestamp < depositAt[msg.sender] + COOLDOWN) revert Locked();

        _harvest();
        // pay out this user's accrued fees first, and shrink the fee reserve accordingly
        _payPending(msg.sender);

        uint256 ts = totalShares;
        // (a) their pro-rata slice of any LOOSE principal the vault holds (e.g. token caught from a prior
        //     fill, or WETH pulled out of the band on a recenter) — balance minus the untouched fee reserve
        uint256 looseW = IERC20(WETH).balanceOf(address(this)) - feeReserveWeth;
        uint256 looseT = token.balanceOf(address(this)) - feeReserveToken;
        uint256 shareW = (looseW * shareAmt) / ts;
        uint256 shareT = (looseT * shareAmt) / ts;
        // (b) their slice of the live band position, freed by burning their fraction of the liquidity
        uint128 removeL = uint128((uint256(bandL) * shareAmt) / ts);
        uint256 posW; uint256 posT;
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
        if (wethOut > 0) { IWETH9(WETH).withdraw(wethOut); (bool ok,) = msg.sender.call{value: wethOut}(""); if (!ok) revert PayFail(); }
        if (tokenOut > 0) token.safeTransfer(msg.sender, tokenOut);
        emit Withdrawn(msg.sender, shareAmt, wethOut, tokenOut);
    }

    // ───────────────────────────────────────────────────────────────── claim ──
    /// @notice Claim your accrued dip-buy fees (real ETH, plus any token from filled dips) without withdrawing.
    function claim() external nonReentrant {
        _harvest();
        _payPending(msg.sender);
    }

    // ─────────────────────────────────────────────────────────────── recenter ──
    /// @notice Permissionless keeper: realize fees and re-place the wall just below the current price so the
    /// floor tracks the coin upward. TWAP-guarded so it can't be run at a manipulated price.
    function recenter() external nonReentrant {
        _harvest();
        (, int24 tick,,,,,) = pool.slot0();
        _requireUnmanipulated(tick);
        _recenterInternal(tick);
    }

    // ─────────────────────────────────────────────────────────────── views ────
    function pending(address user) external view returns (uint256 wethOwed, uint256 tokenOwed) {
        uint256 s = shares[user];
        wethOwed = (s * accWethPerShare) / ACC - debtWeth[user];
        tokenOwed = (s * accTokenPerShare) / ACC - debtToken[user];
    }

    // ─────────────────────────────────────────────────────────── internals ────
    function _wallIsBelow(int24 tick) internal view returns (bool) {
        // wall is valid (single-sided WETH) only while the whole band is below spot
        return bandL > 0 && tick > bandHi;
    }

    /// realize the position's swap fees and book them to the per-share accumulators
    function _harvest() internal {
        if (bandL == 0 || totalShares == 0) return;
        pool.burn(bandLo, bandHi, 0); // poke → move earned fees into "owed"
        (uint128 c0, uint128 c1) = pool.collect(address(this), bandLo, bandHi, U128_MAX, U128_MAX);
        (uint256 wethFee, uint256 tokenFee) =
            tokenIsToken0 ? (uint256(c1), uint256(c0)) : (uint256(c0), uint256(c1));
        if (wethFee > 0) { accWethPerShare += (wethFee * ACC) / totalShares; feeReserveWeth += wethFee; }
        if (tokenFee > 0) { accTokenPerShare += (tokenFee * ACC) / totalShares; feeReserveToken += tokenFee; }
        if (wethFee > 0 || tokenFee > 0) emit Harvested(wethFee, tokenFee);
    }

    function _payPending(address user) internal {
        uint256 s = shares[user];
        uint256 wethOwed = (s * accWethPerShare) / ACC - debtWeth[user];
        uint256 tokenOwed = (s * accTokenPerShare) / ACC - debtToken[user];
        _syncDebt(user);
        if (wethOwed > 0) { feeReserveWeth -= wethOwed; IWETH9(WETH).withdraw(wethOwed); (bool ok,) = user.call{value: wethOwed}(""); if (!ok) revert PayFail(); }
        if (tokenOwed > 0) { feeReserveToken -= tokenOwed; token.safeTransfer(user, tokenOwed); }
        if (wethOwed > 0 || tokenOwed > 0) emit Claimed(user, wethOwed, tokenOwed);
    }

    function _syncDebt(address user) internal {
        uint256 s = shares[user];
        debtWeth[user] = (s * accWethPerShare) / ACC;
        debtToken[user] = (s * accTokenPerShare) / ACC;
    }

    /// tear down the current band, pull everything here, re-place all WETH as a fresh below-price wall
    function _recenterInternal(int24 tick) internal {
        if (bandL > 0) {
            pool.burn(bandLo, bandHi, bandL);
            pool.collect(address(this), bandLo, bandHi, U128_MAX, U128_MAX);
            bandL = 0;
        }
        uint256 wbal = IERC20(WETH).balanceOf(address(this));
        if (wbal > 0) _addWethToWall(wbal);
        emit Recentered(tick, bandLo, bandHi, bandL);
    }

    /// mint a single-sided WETH band just below the current price; returns the liquidity added
    function _addWethToWall(uint256 wethAmt) internal returns (uint128 addL) {
        (, int24 tick,,,,,) = pool.slot0();
        (int24 lo, int24 hi, bool above) = _band(tick, wallBelow ? false : true, WALL_NEAR, WALL_FAR);
        addL = PoolMath.singleSidedLiquidityOrZero(PoolMath.getSqrtRatioAtTick(lo), PoolMath.getSqrtRatioAtTick(hi), wethAmt, above);
        if (addL == 0) return 0;
        bandLo = lo;
        bandHi = hi;
        bandL += addL;
        _mint(lo, hi, addL);
    }

    function _band(int24 tick, bool above, int24 near, int24 far) internal pure returns (int24 lo, int24 hi, bool isAbove) {
        int24 base = _snapDown(tick);
        if (above) { lo = _clamp(base + near); hi = _clamp(base + far); }
        else { lo = _clamp(base - far); hi = _clamp(base - near); }
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
}
