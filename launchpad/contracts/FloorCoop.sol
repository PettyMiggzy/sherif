// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IUniswapV3Factory, IUniswapV3Pool, IUniswapV3MintCallback, IUniswapV3SwapCallback, IWETH9} from "./interfaces/IUniswapV3.sol";
import {PoolMath} from "./libraries/PoolMath.sol";

interface IFloorCoopFactory {
    function treasury() external view returns (address);
}

/// @title FloorCoop — locked liquidity staking for ANY token on the chain
/// @notice A per-token vault. You send ETH and pick a lock term (30/60/90/365 days or forever). The vault
/// takes a 10% protocol fee, then zaps the rest into the token's REAL full-range Uniswap v3 liquidity — the
/// same liquidity everyone trades against. Your stake is time-locked, so it can only ever DEEPEN the coin's
/// market; it can't be yanked out from under it. You earn your share of every swap's fee for as long as it's
/// locked (the protocol keeps 5% of fees). Longer locks earn a bigger reward weight (1.0x -> 3x). Early exit
/// costs a 15% penalty. Works for any token with a WETH pool — not just pad launches.
///
/// SECURITY POSTURE: this is a market-making vault that SWAPS (to pair single-sided ETH into full-range LP).
/// Every deposit/withdraw is TWAP-guarded, and price-sensitive pool ops (zap swap, mint, burn) run with NO
/// caller-facing external call before them (harvest is pool-locked; fee payouts are deferred to the end) so
/// spot can't be manipulated mid-op via a reentrancy window. The zap swap is bounded to a TWAP-derived price
/// limit (the primary sandwich bound, ~MAX_DEV) plus a fee-aware min-out floor — a sandwich is *bounded* (to
/// roughly the MAX_DEV band), not eliminated. Accounting is NAV-based with a MasterChef-style, lock-weighted
/// fee distributor and strictly-segregated fee/protocol reserves. Full-range bounds are derived from the
/// selected pool's tickSpacing (any fee tier).
///
/// SCOPE / LIMITATIONS: supports STANDARD ERC-20 tokens only. Fee-on-transfer, rebasing, and pause/blacklist
/// tokens are NOT supported — they revert (unusable) or can freeze a single vault's principal; a vault is
/// per-token and independent, so this never affects other vaults. TWAP_WINDOW/cardinality, MAX_DEV/SWAP_BOUND,
/// and the min-out tolerance are economic parameters to TUNE in simulation. STILL PENDING the full pre-deploy
/// external audit + simulations before real funds.
contract FloorCoop is IUniswapV3MintCallback, IUniswapV3SwapCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────── constants ──
    uint128 internal constant U128_MAX = type(uint128).max;
    uint256 internal constant ACC = 1e27;   // fee-accumulator fixed-point (high, since weights can be large)
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10000;

    uint256 public constant OPEN_FEE_BPS = 1000;      // 10% protocol fee taken on open
    uint256 public constant FEE_CUT_BPS = 500;        // 5% of earned trading fees -> protocol
    uint256 public constant EARLY_PENALTY_BPS = 1500; // 15% penalty on early (pre-unlock) withdrawal
    uint256 public constant MIN_FIRST_DEPOSIT = 1e15; // 0.001 ETH floor on the very first deposit

    int24 public constant MAX_DEV = 300;              // ~3% max spot-vs-TWAP deviation (manipulation guard)
    int24 public constant SWAP_BOUND = 300;           // zap swap may move price at most ~3% past the TWAP (>= MAX_DEV so the limit is always beyond spot)
    int24 internal constant TICK_MAX = 887272;        // getSqrtRatioAtTick's hard bound
    uint32 public constant TWAP_WINDOW = 300;         // 5-min TWAP — manipulation-resistant (audit/sim should tune per chain block time)

    // full-range position bounds — derived from the SELECTED pool's tickSpacing in the constructor, because a
    // token's deepest pool may be the 0.3% tier (spacing 60) etc. where ±887200 is NOT a valid tick.
    int24 public immutable LO;
    int24 public immutable HI;

    // lock tiers (days => reward-weight multiplier in bps); 0 days == forever
    // resolved in _tier(); kept here for reference: 30->1.0x 60->1.25x 90->1.5x 365->2x forever->3x

    // ─────────────────────────────────────────────────────────────── immutables ──
    IERC20 public immutable token;
    address public immutable WETH;
    IUniswapV3Pool public immutable pool;
    address public immutable token0;
    address public immutable token1;
    bool public immutable tokenIsToken0;
    bool public immutable wethIsToken0;
    address public immutable factory; // reads the live treasury from here (rotatable by the factory owner)

    // ─────────────────────────────────────────────────────────────── position ──
    uint128 public bandL; // the vault's full-range liquidity at [LO,HI]

    // per-user staking position
    struct Pos {
        uint256 shares;    // principal shares (claim on NAV; used for withdraw)
        uint256 weight;    // shares * multiplier/BPS (used for fee distribution)
        uint256 multBps;   // this position's locked reward multiplier
        uint256 lockUntil; // timestamp the lock ends (type(uint).max for forever)
    }
    mapping(address => Pos) public pos;
    uint256 public totalShares;
    uint256 public totalWeight;

    // lock-weighted fee distributor (MasterChef pattern, per WEIGHT)
    uint256 public accWethPerWeight;
    uint256 public accTokenPerWeight;
    mapping(address => uint256) public debtWeth;
    mapping(address => uint256) public debtToken;

    // strictly-segregated reserves (never counted as principal)
    uint256 public feeReserveWeth;   // stakers' unclaimed fees (WETH)
    uint256 public feeReserveToken;  // stakers' unclaimed fees (token)
    uint256 public protocolWeth;     // protocol's cut (open fees + 5% + penalties), WETH — swept to treasury
    uint256 public protocolToken;    // protocol's cut, token — swept to treasury

    bool private _minting;
    bool private _swapping;

    // ─────────────────────────────────────────────────────────────── errors/events ──
    error NoPool();
    error NotPool();
    error Manipulated();
    error Zero();
    error Locked();
    error TooMuch();
    error Slippage();
    error PayFail();
    error MinDeposit();
    error BadTerm();

    event Opened(address indexed user, uint256 ethIn, uint256 netIn, uint256 sharesMinted, uint256 multBps, uint256 lockUntil);
    event Withdrawn(address indexed user, uint256 sharesBurned, uint256 wethOut, uint256 tokenOut, uint256 penaltyWeth, uint256 penaltyToken);
    event Claimed(address indexed user, uint256 wethOut, uint256 tokenOut);
    event Harvested(uint256 wethFees, uint256 tokenFees);
    event Compounded(uint128 addedLiquidity);
    event ProtocolSwept(uint256 weth, uint256 token);

    // ─────────────────────────────────────────────────────────────── constructor ──
    constructor(address token_, address weth_, address v3Factory_, address factory_) {
        require(token_ != address(0) && weth_ != address(0) && factory_ != address(0), "zero");
        address p = _deepestPool(v3Factory_, token_, weth_);
        if (p == address(0)) revert NoPool();
        (uint160 sp,,,,,,) = IUniswapV3Pool(p).slot0();
        if (sp == 0) revert NoPool();
        token = IERC20(token_);
        WETH = weth_;
        pool = IUniswapV3Pool(p);
        factory = factory_;
        bool tIs0 = token_ < weth_;
        tokenIsToken0 = tIs0;
        wethIsToken0 = !tIs0;
        (token0, token1) = tIs0 ? (token_, weth_) : (weth_, token_);
        // full-range bounds valid for THIS pool's spacing: snap the max tick down to a multiple of spacing
        int24 spacing = IUniswapV3Pool(p).tickSpacing();
        int24 maxUsable = (TICK_MAX / spacing) * spacing;
        LO = -maxUsable;
        HI = maxUsable;
        // grow the oracle so the TWAP window is available for the manipulation guard (fills over subsequent blocks)
        try IUniswapV3Pool(p).increaseObservationCardinalityNext(100) {} catch {}
    }

    /// pick the token's deepest WETH pool across the standard fee tiers (works for arbitrary chain tokens,
    /// whose main pool may not be the pad's 1% tier).
    function _deepestPool(address v3Factory_, address token_, address weth_) internal view returns (address best) {
        uint24[4] memory tiers = [uint24(100), 500, 3000, 10000];
        uint128 bestLiq;
        for (uint256 i = 0; i < tiers.length; i++) {
            address p = IUniswapV3Factory(v3Factory_).getPool(token_, weth_, tiers[i]);
            if (p == address(0)) continue;
            uint128 liq = IUniswapV3Pool(p).liquidity();
            // strict > : ties keep the FIRST (lower, typically deeper) tier, not the last (thinnest)
            if (liq > bestLiq) { bestLiq = liq; best = p; }
        }
        // require real depth — a 0-liquidity (initialized-but-empty) pool has an attacker-set price and no
        // fills to earn; reject it so the vault is never built on an unusable/manipulable pool
        if (bestLiq == 0) best = address(0);
    }

    receive() external payable {} // WETH.withdraw

    // ─────────────────────────────────────────────────────────────── deposit ──
    /// @notice Open (or add to) a locked LP position. `lockDays` ∈ {30,60,90,365,0(forever)}. `minSharesOut`
    /// guards slippage. Returns the principal shares minted.
    function deposit(uint256 lockDays, uint256 minSharesOut)
        external
        payable
        nonReentrant
        returns (uint256 sharesMinted)
    {
        if (msg.value == 0) revert Zero();
        (uint256 multBps, uint256 lockUntil) = _tier(lockDays); // reverts on an unknown term
        (, int24 spotTick) = _spot();
        int24 tw = _requireUnmanipulated(spotTick); // guard EVERY placement, returns the TWAP tick

        _harvest(); // pool-locked collect — no manipulation window

        uint256 navBefore = _navWeth(tw); // AFTER harvest, BEFORE the new money

        if (totalShares == 0 && msg.value < MIN_FIRST_DEPOSIT) revert MinDeposit();
        // degenerate state (value fully evaporated but shares outstanding): reject rather than divide-by-zero.
        // Self-heals once the residual holder exits (totalShares -> 0 restores the bootstrap branch).
        if (totalShares > 0 && navBefore == 0) revert Zero();

        // 10% protocol fee off the top; the rest becomes working capital
        IWETH9(WETH).deposit{value: msg.value}();
        uint256 fee = (msg.value * OPEN_FEE_BPS) / BPS;
        protocolWeth += fee;
        uint256 net = msg.value - fee;

        // zap: swap half the net WETH -> token (TWAP-bounded), then mint full-range with the pair. No external
        // call reaches the caller between the TWAP guard and these price-sensitive ops (harvest is pool-locked;
        // the swap/mint callbacks only touch the pool + token while the pool is locked) — so spot can't be
        // manipulated mid-deposit. _payPending (which hands control to the caller) is deferred until AFTER.
        (uint256 wethForLp, uint256 tokenForLp) = _zapHalf(net, tw);
        _mintFullRange(wethForLp, tokenForLp); // reads the live post-swap price; leftover stays loose (in NAV)

        _payPending(msg.sender); // settle the caller's fees AFTER the price-sensitive ops, before their weight changes

        // NAV-based share price against `net` WETH committed. Real NAV added is `net` minus swap fee/slippage,
        // so this can over-mint by at most the TWAP-vs-spot gap (<= MAX_DEV ≈ 3%) — fully absorbed by the 10%
        // open fee. If OPEN_FEE_BPS is ever lowered, re-derive this bound before trusting it.
        sharesMinted = totalShares == 0 ? net : Math.mulDiv(net, totalShares, navBefore);
        if (sharesMinted == 0 || sharesMinted < minSharesOut) revert Slippage();

        Pos storage pp = pos[msg.sender];
        // adding to an existing position can only lengthen the lock / raise the multiplier (never shorten)
        uint256 newMult = multBps > pp.multBps ? multBps : pp.multBps;
        uint256 newLock = lockUntil > pp.lockUntil ? lockUntil : pp.lockUntil;

        totalShares += sharesMinted;
        pp.shares += sharesMinted;
        pp.multBps = newMult;
        pp.lockUntil = newLock;

        // recompute this user's weight wholesale at the (possibly raised) multiplier
        totalWeight = totalWeight - pp.weight;
        pp.weight = Math.mulDiv(pp.shares, newMult, BPS);
        totalWeight += pp.weight;

        _syncDebt(msg.sender);
        emit Opened(msg.sender, msg.value, net, sharesMinted, newMult, newLock);
    }

    // ─────────────────────────────────────────────────────────────── withdraw ──
    /// @notice Withdraw `shareAmt` of principal. Before your lock ends this costs a 15% penalty (to the
    /// protocol); after it, no penalty. Pays the pro-rata slice of the LP position + loose principal.
    function withdraw(uint256 shareAmt, uint256 minWethOut, uint256 minTokenOut)
        external
        nonReentrant
        returns (uint256 wethOut, uint256 tokenOut)
    {
        Pos storage pp = pos[msg.sender];
        if (shareAmt == 0 || shareAmt > pp.shares) revert TooMuch();
        (, int24 spotTick) = _spot();
        _requireUnmanipulated(spotTick);
        _harvest(); // pool-locked collect — no manipulation window

        uint256 ts = totalShares;
        // (a) pro-rata of loose principal (net of BOTH reserves), read BEFORE the burn adds to balance
        uint256 shareW = Math.mulDiv(_looseWeth(), shareAmt, ts);
        uint256 shareT = Math.mulDiv(_looseToken(), shareAmt, ts);
        // (b) pro-rata of the live full-range band. CRITICAL: the burn runs with NO caller-facing external call
        // before it (harvest is pool-locked), so the caller cannot manipulate spot between the TWAP guard and
        // this price-sensitive burn. _payPending (which hands the caller control) is deferred until AFTER.
        (uint256 posW, uint256 posT) = _burnShare(shareAmt, ts);

        wethOut = shareW + posW;
        tokenOut = shareT + posT;

        _payPending(msg.sender); // now safe to hand control out — the price-sensitive burn is already done

        // update position + weight BEFORE paying out
        bool early = block.timestamp < pp.lockUntil;
        pp.shares -= shareAmt;
        totalShares = ts - shareAmt;
        totalWeight = totalWeight - pp.weight;
        pp.weight = Math.mulDiv(pp.shares, pp.multBps, BPS);
        totalWeight += pp.weight;
        _syncDebt(msg.sender);

        uint256 penW;
        uint256 penT;
        if (early) {
            penW = (wethOut * EARLY_PENALTY_BPS) / BPS;
            penT = (tokenOut * EARLY_PENALTY_BPS) / BPS;
            protocolWeth += penW;
            protocolToken += penT;
            wethOut -= penW;
            tokenOut -= penT;
        }

        if (wethOut < minWethOut || tokenOut < minTokenOut) revert Slippage();
        if (wethOut > 0) {
            IWETH9(WETH).withdraw(wethOut);
            (bool ok,) = msg.sender.call{value: wethOut}("");
            if (!ok) revert PayFail();
        }
        if (tokenOut > 0) token.safeTransfer(msg.sender, tokenOut);
        emit Withdrawn(msg.sender, shareAmt, wethOut, tokenOut, penW, penT);
    }

    // ─────────────────────────────────────────────────────────────── claim ──
    /// @notice Claim your accrued fee share (real ETH + any token) without touching your locked principal.
    function claim() external nonReentrant {
        _harvest();
        _payPending(msg.sender);
    }

    // ─────────────────────────────────────────────────────────────── keeper ──
    /// @notice Permissionless: realize fees and fold any loose principal back into the full-range position.
    function compound() external nonReentrant {
        (, int24 spotTick) = _spot();
        int24 tw = _requireUnmanipulated(spotTick);
        _harvest();
        uint256 looseW = _looseWeth();
        if (looseW == 0) return;
        (uint256 wethForLp, uint256 tokenForLp) = _zapHalf(looseW, tw);
        uint128 before = bandL;
        _mintFullRange(wethForLp, tokenForLp);
        emit Compounded(bandL - before);
    }

    /// @notice Permissionless: push the protocol's accumulated cut to the treasury.
    function sweepProtocol() external nonReentrant {
        uint256 w = protocolWeth;
        uint256 t = protocolToken;
        protocolWeth = 0;
        protocolToken = 0;
        address to = treasury();
        if (w > 0) {
            IWETH9(WETH).withdraw(w);
            (bool ok,) = to.call{value: w}("");
            if (!ok) revert PayFail();
        }
        if (t > 0) token.safeTransfer(to, t);
        emit ProtocolSwept(w, t);
    }

    // ─────────────────────────────────────────────────────────────── views ──
    /// live protocol-fee recipient (rotatable by the factory owner)
    function treasury() public view returns (address) { return IFloorCoopFactory(factory).treasury(); }

    function shares(address user) external view returns (uint256) { return pos[user].shares; }

    function pending(address user) external view returns (uint256 wethOwed, uint256 tokenOwed) {
        uint256 w = pos[user].weight;
        wethOwed = Math.mulDiv(w, accWethPerWeight, ACC) - debtWeth[user];
        tokenOwed = Math.mulDiv(w, accTokenPerWeight, ACC) - debtToken[user];
    }

    /// @notice Total vault value in WETH (full-range band + loose principal), valued at the TWAP.
    function totalNav() external view returns (uint256) {
        return _navWeth(_twapTick());
    }

    // ─────────────────────────────────────────────────────── internals: NAV ──
    function _navWeth(int24 twapTick) internal view returns (uint256) {
        uint160 sqrtTwap = PoolMath.getSqrtRatioAtTick(twapTick);
        uint256 bandWeth;
        uint256 bandToken;
        if (bandL > 0) {
            (uint256 a0, uint256 a1) = PoolMath.getAmountsForLiquidity(
                sqrtTwap, PoolMath.getSqrtRatioAtTick(LO), PoolMath.getSqrtRatioAtTick(HI), bandL
            );
            (bandWeth, bandToken) = tokenIsToken0 ? (a1, a0) : (a0, a1);
        }
        uint256 price = PoolMath.twapPriceWethPerToken(twapTick, tokenIsToken0); // WETH per token, 1e18
        return bandWeth + _looseWeth() + Math.mulDiv(bandToken + _looseToken(), price, WAD);
    }

    function _looseWeth() internal view returns (uint256) {
        return IERC20(WETH).balanceOf(address(this)) - feeReserveWeth - protocolWeth;
    }

    function _looseToken() internal view returns (uint256) {
        return token.balanceOf(address(this)) - feeReserveToken - protocolToken;
    }

    // ─────────────────────────────────────────────────── internals: fees ──
    function _harvest() internal {
        if (bandL == 0 || totalWeight == 0) return;
        pool.burn(LO, HI, 0); // poke: credits owed fees to the position
        (uint128 c0, uint128 c1) = pool.collect(address(this), LO, HI, U128_MAX, U128_MAX);
        (uint256 wethFee, uint256 tokenFee) = tokenIsToken0 ? (uint256(c1), uint256(c0)) : (uint256(c0), uint256(c1));
        if (wethFee > 0) {
            uint256 cut = (wethFee * FEE_CUT_BPS) / BPS;
            protocolWeth += cut;
            uint256 dist = wethFee - cut;
            accWethPerWeight += Math.mulDiv(dist, ACC, totalWeight);
            feeReserveWeth += dist;
        }
        if (tokenFee > 0) {
            uint256 cut = (tokenFee * FEE_CUT_BPS) / BPS;
            protocolToken += cut;
            uint256 dist = tokenFee - cut;
            accTokenPerWeight += Math.mulDiv(dist, ACC, totalWeight);
            feeReserveToken += dist;
        }
        if (wethFee > 0 || tokenFee > 0) emit Harvested(wethFee, tokenFee);
    }

    function _payPending(address user) internal {
        uint256 w = pos[user].weight;
        uint256 wethOwed = Math.mulDiv(w, accWethPerWeight, ACC) - debtWeth[user];
        uint256 tokenOwed = Math.mulDiv(w, accTokenPerWeight, ACC) - debtToken[user];
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
        uint256 w = pos[user].weight;
        debtWeth[user] = Math.mulDiv(w, accWethPerWeight, ACC);
        debtToken[user] = Math.mulDiv(w, accTokenPerWeight, ACC);
    }

    // ─────────────────────────────────────────── internals: position ──
    function _burnShare(uint256 shareAmt, uint256 ts) internal returns (uint256 wethAmt, uint256 tokenAmt) {
        uint128 removeL = uint128(Math.mulDiv(bandL, shareAmt, ts));
        if (removeL == 0) return (0, 0);
        (uint256 a0, uint256 a1) = pool.burn(LO, HI, removeL);
        // collect the full owed (U128_MAX) — _harvest already swept fees, so tokensOwed is exactly this burn's
        // principal; requesting the max avoids the uint128(a0) truncation edge for large token amounts.
        pool.collect(address(this), LO, HI, U128_MAX, U128_MAX);
        bandL -= removeL;
        (wethAmt, tokenAmt) = tokenIsToken0 ? (a1, a0) : (a0, a1);
    }

    function _mintFullRange(uint256 wethAmt, uint256 tokenAmt) internal {
        if (wethAmt == 0 || tokenAmt == 0) return;
        (uint160 sqrtP,) = _spot(); // live price NOW — the pool prices the owed amounts at this, so L must too
        (uint256 amount0, uint256 amount1) = tokenIsToken0 ? (tokenAmt, wethAmt) : (wethAmt, tokenAmt);
        // liquidity at THIS pool's spacing-derived full-range bounds (not the hardcoded ±887200)
        uint128 L = PoolMath.getLiquidityForAmounts(
            sqrtP, PoolMath.getSqrtRatioAtTick(LO), PoolMath.getSqrtRatioAtTick(HI), amount0, amount1
        );
        if (L == 0) return; // dust — stays loose for the next compound
        bandL += L;
        _minting = true;
        pool.mint(address(this), LO, HI, L, "");
        _minting = false;
    }

    // ─────────────────────────────────────────── internals: zap swap ──
    /// swap half of `wethAmt` into token, bounded to a TWAP-derived price limit + a min-out floor so a
    /// sandwich can't force a bad fill. Returns the (weth, token) now available to add as liquidity.
    function _zapHalf(uint256 wethAmt, int24 tw) internal returns (uint256 wethLeft, uint256 tokenGot) {
        uint256 sellW = wethAmt / 2;
        if (sellW == 0) return (wethAmt, 0);
        bool zeroForOne = wethIsToken0; // selling WETH
        // price limit: allow the swap to move at most SWAP_BOUND ticks past the TWAP. Clamp the TICK into
        // getSqrtRatioAtTick's domain BEFORE the call (extreme-priced tokens can push tw±SWAP_BOUND past ±887272).
        int24 limitTick = zeroForOne ? tw - SWAP_BOUND : tw + SWAP_BOUND;
        if (limitTick > TICK_MAX) limitTick = TICK_MAX;
        if (limitTick < -TICK_MAX) limitTick = -TICK_MAX;
        uint160 limit = PoolMath.getSqrtRatioAtTick(limitTick);
        if (limit <= PoolMath.MIN_SQRT_RATIO) limit = PoolMath.MIN_SQRT_RATIO + 1;
        if (limit >= PoolMath.MAX_SQRT_RATIO) limit = PoolMath.MAX_SQRT_RATIO - 1;

        _swapping = true;
        (int256 a0, int256 a1) = pool.swap(address(this), zeroForOne, int256(sellW), limit, "");
        _swapping = false;

        // deltas: positive = we paid, negative = we received
        (int256 wethDelta, int256 tokenDelta) = wethIsToken0 ? (a0, a1) : (a1, a0);
        uint256 wethSpent = wethDelta > 0 ? uint256(wethDelta) : 0;
        tokenGot = tokenDelta < 0 ? uint256(-tokenDelta) : 0;
        wethLeft = wethAmt - wethSpent; // any un-spent WETH (partial fill at the limit) stays as working capital

        // min-out floor vs the TWAP-implied amount for the WETH actually spent. The tick price-limit above is
        // the PRIMARY sandwich bound (caps the fill to ~SWAP_BOUND ticks past TWAP); this floor is the secondary
        // catch. Its tolerance must budget for the legit worst case — the ~3% price band + the pool's own swap
        // fee — or honest deposits near the band edge on a high-fee pool would spuriously revert.
        if (wethSpent > 0) {
            uint256 price = PoolMath.twapPriceWethPerToken(tw, tokenIsToken0); // WETH per token, 1e18
            uint256 expTok = Math.mulDiv(wethSpent, WAD, price);               // token expected at TWAP
            uint256 feeBps = uint256(pool.fee()) / 100;                        // 10000->100(1%), 3000->30, ...
            uint256 tolBps = 305 + feeBps + 50;                               // band (~3.05%) + pool fee + buffer
            uint256 minOut = Math.mulDiv(expTok, BPS - tolBps, BPS);
            if (tokenGot < minOut) revert Slippage();
        }
    }

    // ─────────────────────────────────────────── internals: guards/math ──
    function _spot() internal view returns (uint160 sqrtP, int24 tick) {
        (sqrtP, tick,,,,,) = pool.slot0();
    }

    function _twapTick() internal view returns (int24) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = TWAP_WINDOW;
        ago[1] = 0;
        (int56[] memory cum,) = pool.observe(ago);
        return PoolMath.meanTick(cum[0], cum[1], TWAP_WINDOW);
    }

    /// @dev reverts if spot deviates from the TWAP mean by more than MAX_DEV; returns the TWAP tick.
    function _requireUnmanipulated(int24 spotTick) internal view returns (int24 mean) {
        mean = _twapTick();
        int24 d = spotTick > mean ? spotTick - mean : mean - spotTick;
        if (d > MAX_DEV) revert Manipulated();
    }

    function _tier(uint256 lockDays) internal view returns (uint256 multBps, uint256 lockUntil) {
        if (lockDays == 30) return (10000, block.timestamp + 30 days);
        if (lockDays == 60) return (12500, block.timestamp + 60 days);
        if (lockDays == 90) return (15000, block.timestamp + 90 days);
        if (lockDays == 365) return (20000, block.timestamp + 365 days);
        if (lockDays == 0) return (30000, type(uint256).max); // forever
        revert BadTerm();
    }

    // ─────────────────────────────────────────── callbacks ──
    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata) external override {
        if (msg.sender != address(pool)) revert NotPool();
        require(_minting, "no mint");
        if (amount0Owed > 0) IERC20(token0).safeTransfer(msg.sender, amount0Owed);
        if (amount1Owed > 0) IERC20(token1).safeTransfer(msg.sender, amount1Owed);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external override {
        if (msg.sender != address(pool)) revert NotPool();
        require(_swapping, "no swap");
        // pay the positive delta side (what we owe the pool for the swap)
        if (amount0Delta > 0) IERC20(token0).safeTransfer(msg.sender, uint256(amount0Delta));
        if (amount1Delta > 0) IERC20(token1).safeTransfer(msg.sender, uint256(amount1Delta));
    }
}
