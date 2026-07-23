// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IUniswapV3Factory, IUniswapV3Pool, IUniswapV3MintCallback, IUniswapV3SwapCallback} from "./interfaces/IUniswapV3.sol";
import {PoolMath} from "./libraries/PoolMath.sol";

interface ICurveBondDeployer {
    function deploy(address token, address weth, address v3Factory, address platform, address curve)
        external
        returns (address);
}

interface ICurveBond {
    function post(uint256 sherwoodWeth, uint256 sherwoodTokens, uint256 bountyWeth, uint256 ambushTokens) external;
}

/// @title CurvePool — a bonding curve that IS a real Uniswap v3 pool (DEX + DexScreener from block one)
/// @notice Instead of a math curve holding ETH off-DEX, the launch seeds the token as a single-sided
/// concentrated v3 position spanning [start, grad] price. That position behaves like a bonding curve — buyers
/// swap WETH in and walk the price up the range — but it's a genuine Uniswap pool, so DexScreener indexes and
/// charts it the moment it's created. When price reaches the graduation end (the curve is bought out), anyone
/// calls `graduate()`: it collects the raised WETH + any unsold token and posts the Bond (Sherwood + Bounty +
/// Ambush) into the SAME pool. No ETH from the platform — the token seeds its own liquidity; buyers bring ETH.
contract CurvePool is IUniswapV3MintCallback, IUniswapV3SwapCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint24 public constant POOL_FEE = 10000;
    int24 public constant SPACING = 200;
    uint128 internal constant U128_MAX = type(uint128).max;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IERC20 public immutable token;
    address public immutable WETH;
    IUniswapV3Factory public immutable v3Factory;
    IUniswapV3Pool public immutable pool;
    address public immutable token0;
    address public immutable token1;
    address public immutable platform; // buy-side (LP) fees + graduation sweep
    address public immutable dev; // project dev
    address public immutable bondDeployer;
    bool public immutable tokenIsToken0;

    uint256 public immutable curveSupply; // seeded as the single-sided curve
    uint256 public immutable ambushSupply; // paired into the Bond + rolled with any unsold curve tokens
    int24 public immutable startTick; // price at launch (curve bottom)
    int24 public immutable gradTick; // the curve's CEILING — the ONLY graduation point; buys climb to here, never past it
    int24 public immutable minGradTick; // vestigial geometry marker (kept for reporting); graduation is ceiling-only

    uint16 public constant SHERWOOD_WETH_BPS = 6000; // 60% of the raise -> Sherwood LP, 40% -> Bounty floor
    // Graduation reward paid to BOTH the creator and the platform at graduation, in WETH. Capped at raise/4 each
    // (below) so the Bond floor always keeps >=50% of the raise. Graduation only ever happens at the full ceiling
    // (~4.2 ETH raised), so each side takes 0.5 and the floor keeps the rest (>=~3.2 ETH).
    uint256 public constant GRAD_REWARD = 0.5 ether;
    int24 public constant GRAD_MAX_DEV = 50; // graduation can't post above the ceiling by more than this (anti-manipulation)

    bool public seeded;
    bool public graduated;
    uint64 public seedTime; // when the curve was seeded
    address public bond;
    int24 public curveLo;
    int24 public curveHi;
    uint128 public curveL;
    int24 public gradTarget; // vestigial; fixed to gradTick at seed. Graduation is ceiling-only (see ready()).

    bool private _minting;
    bool private _swapping;

    error NotSeeded();
    error AlreadySeeded();
    error AlreadyGraduated();
    error NotReady();
    error NotPool();
    error BadPoolInit();

    event Seeded(int24 curveLo, int24 curveHi, uint128 liquidity);
    event Graduated(address indexed bond, uint256 raisedWeth, uint256 leftoverToken);

    /// @param curveWidth_ tick span from start to the curve CEILING (a positive multiple of SPACING). The ceiling
    /// is the ONLY graduation point — a coin graduates only when buys carry price all the way to it (~4.2 ETH).
    /// @param minGradWidth_ vestigial geometry input (< curveWidth_); it only sets the informational minGradTick
    /// marker and no longer gates graduation.
    constructor(
        address token_,
        address weth_,
        address v3Factory_,
        address platform_,
        address dev_,
        address bondDeployer_,
        uint256 curveSupply_,
        uint256 ambushSupply_,
        int24 startTick_,
        int24 curveWidth_,
        int24 minGradWidth_
    ) {
        require(
            token_ != address(0) && weth_ != address(0) && v3Factory_ != address(0) && platform_ != address(0)
                && dev_ != address(0) && bondDeployer_ != address(0),
            "zero"
        );
        require(
            curveSupply_ > 0 && ambushSupply_ > 0 && curveWidth_ > 0 && curveWidth_ % SPACING == 0
                && startTick_ % SPACING == 0 && minGradWidth_ > 0 && minGradWidth_ % SPACING == 0
                && minGradWidth_ < curveWidth_,
            "params"
        );
        token = IERC20(token_);
        WETH = weth_;
        v3Factory = IUniswapV3Factory(v3Factory_);
        platform = platform_;
        dev = dev_;
        bondDeployer = bondDeployer_;
        curveSupply = curveSupply_;
        ambushSupply = ambushSupply_;
        startTick = startTick_;

        bool tIs0 = token_ < weth_;
        tokenIsToken0 = tIs0;
        (token0, token1) = tIs0 ? (token_, weth_) : (weth_, token_);
        // The curve holds only the TOKEN. token0 => the token is on the ABOVE-price side (price rises with
        // tick); token1 => the token is on the BELOW-price side (price rises as tick falls).
        gradTick = tIs0 ? startTick_ + curveWidth_ : startTick_ - curveWidth_;
        minGradTick = tIs0 ? startTick_ + minGradWidth_ : startTick_ - minGradWidth_;
        // Default graduation target = the FULL ceiling (~4.2 ETH raised). The coin does NOT graduate until it
        // rides all the way to the ceiling, and only then does the creator earn their 0.5 WETH reward. The dev
        // MAY lower the target via setGradTarget to graduate EARLY — but early graduation forfeits the creator's
        // 0.5 reward (it stays in the raise → the floor) and leaves a thinner floor. See graduate().
        gradTarget = gradTick;

        // Claim + initialize the pool at the start price (DEX + DexScreener live from here).
        address p = IUniswapV3Factory(v3Factory_).getPool(token_, weth_, POOL_FEE);
        if (p == address(0)) p = IUniswapV3Factory(v3Factory_).createPool(token_, weth_, POOL_FEE);
        uint160 wantSqrt = PoolMath.getSqrtRatioAtTick(startTick_);
        // Guard the initialize: a same-block front-runner could pre-create AND pre-initialize the
        // (token, WETH, 10000) pool, which would make an unconditional initialize() revert and grief the
        // launch. If it is already initialized we accept it ONLY when it sits at our exact start price;
        // any other price is a hostile init and we revert loudly rather than launch onto a wrong curve.
        (uint160 existingSqrt,,,,,,) = IUniswapV3Pool(p).slot0();
        if (existingSqrt == 0) {
            IUniswapV3Pool(p).initialize(wantSqrt);
        } else if (existingSqrt != wantSqrt) {
            revert BadPoolInit();
        }
        pool = IUniswapV3Pool(p);
    }

    /// @notice Seed the curve — mint the single-sided token position. Call once, after this contract has been
    /// funded with `curveSupply + ambushSupply` tokens. Permissionless (idempotent-guarded).
    function seed() external nonReentrant {
        if (seeded) revert AlreadySeeded();
        seeded = true;
        seedTime = uint64(block.timestamp); // record when the curve was seeded (informational)
        // Curve range: token0 => [start, grad] above; token1 => [grad, start] below.
        (int24 lo, int24 hi) = tokenIsToken0 ? (startTick, gradTick) : (gradTick, startTick);
        curveLo = lo;
        curveHi = hi;
        uint128 L =
            PoolMath.singleSidedLiquidity(PoolMath.getSqrtRatioAtTick(lo), PoolMath.getSqrtRatioAtTick(hi), curveSupply, tokenIsToken0);
        curveL = L;
        _mint(lo, hi, L);
        // Arm the TWAP oracle for the Bond's poke() guard. Robinhood Chain runs ~0.1s blocks and stores ≤1
        // observation per active block, so the ring buffer must hold enough slots to span the Bond's TWAP
        // window. 200 slots cover ~20s of continuous every-block trading (> the Bond's 15s window). We cannot
        // ask for more here: Robinhood Chain caps a single tx at 2**24 (~16.7M) gas, and pre-initializing the
        // observation slots is ~20k gas each, so a bigger bump would push launch() over the per-tx cap. Coins
        // that want a wider TWAP margin ramp the buffer up post-launch via growOracle() (many cheap txs).
        pool.increaseObservationCardinalityNext(200);
        emit Seeded(lo, hi, L);
    }

    /// @notice Permissionless: grow the pool's TWAP observation buffer toward `target`. Split across as many
    /// calls as needed so each stays under Robinhood Chain's per-tx gas cap. Only ever increases the buffer
    /// (Uniswap ignores a target ≤ the current one), so it can't shrink or grieve the oracle.
    function growOracle(uint16 target) external {
        pool.increaseObservationCardinalityNext(target);
    }

    /// @notice The pool price at the curve's CEILING. Buyers/routers cap the buy swap here so price can climb
    /// the whole curve (up to the ceiling) but never run past it into empty space.
    function gradSqrtPriceX96() external view returns (uint160) {
        return PoolMath.getSqrtRatioAtTick(gradTick);
    }

    /// @notice Progress: is the coin graduatable? The ONLY way to graduate is reaching the full ceiling
    /// (~4.2 ETH raised / the locked graduation mcap). There is no early graduation and no timeout — a coin that
    /// never reaches the ceiling simply keeps trading on the curve (sellers can always exit), it never posts a
    /// thin Bond. Permissionless: once price reaches the ceiling, anyone may call graduate().
    function ready() public view returns (bool) {
        if (!seeded || graduated) return false;
        (, int24 tick,,,,,) = pool.slot0();
        return tokenIsToken0 ? tick >= gradTick : tick <= gradTick;
    }

    /// @notice Graduate — collect the raised WETH + unsold token from the curve and post the Bond. Permissionless.
    function graduate() external nonReentrant {
        if (!seeded) revert NotSeeded();
        if (graduated) revert AlreadyGraduated();
        if (!ready()) revert NotReady();

        // Anti-manipulation: the Bond is posted around the CURRENT price, so that price must be honest. Inside
        // the curve range [startTick, gradTick] it always is — to move spot UP a buyer must consume curve
        // liquidity, i.e. pay real WETH that JOINS the raise/floor, so a "high" spot is one the attacker funded
        // and the floor sits below it: nothing can be drained. The ONLY unbacked zone is ABOVE the ceiling
        // (no liquidity past gradTick, so spot is free to shove there), so we simply refuse to graduate above
        // the ceiling. That closes the floor-drain vector; graduation only ever fires AT the ceiling anyway.
        (uint160 sp, int24 tickNow,,,,,) = pool.slot0();
        bool aboveCeil = tokenIsToken0 ? tickNow > gradTick + GRAD_MAX_DEV : tickNow < gradTick - GRAD_MAX_DEV;
        if (aboveCeil) {
            // Anti-grief: anyone can shove spot into the empty zone ABOVE the ceiling for ~0 cost (no liquidity
            // past gradTick), which used to make graduate() revert and let an attacker block graduation every
            // block. Instead of reverting, nudge spot back down to the honest ceiling using the curve's OWN
            // still-live liquidity BEFORE we burn it, so the Bond posts around a real, backed price (no drain).
            // Selling the token drives price toward the ceiling; the swap traverses the empty zone consuming ~0
            // and stops exactly at the ceiling limit (the curve position, which ends at gradTick, is untouched).
            uint160 ceilSqrt = PoolMath.getSqrtRatioAtTick(gradTick);
            _swapping = true;
            // Size the nudge to our whole token balance (the ambush reserve). The ceiling price limit stops the
            // swap EXACTLY at the ceiling, so in the honest empty-zone case ~0 is consumed; if an attacker planted
            // real liquidity between spot and the ceiling to defeat a tiny nudge, this powers straight through it
            // (selling tokens above the ceiling only nets extra WETH) until price lands on the ceiling. It can
            // never cross into the curve — the limit is the ceiling — so the raise stays intact.
            pool.swap(address(this), tokenIsToken0, int256(token.balanceOf(address(this))), ceilSqrt, "");
            _swapping = false;
            (sp, tickNow,,,,,) = pool.slot0();
            // must now sit at/below the ceiling; if the nudge somehow didn't land, refuse rather than post high
            bool stillAbove = tokenIsToken0 ? tickNow > gradTick + GRAD_MAX_DEV : tickNow < gradTick - GRAD_MAX_DEV;
            if (stillAbove) revert NotReady();
        }
        graduated = true;

        // pull the whole curve position back here (raised WETH + the still-unsold curve tokens)
        pool.burn(curveLo, curveHi, curveL);
        (uint256 c0, uint256 c1) = pool.collect(address(this), curveLo, curveHi, U128_MAX, U128_MAX);
        (uint256 raisedWeth, uint256 leftToken) = tokenIsToken0 ? (c1, c0) : (c0, c1);
        require(raisedWeth > 0, "empty");

        // Graduation reward: a FIXED 0.5 WETH each to creator + platform (a launch incentive on top of the ongoing
        // fees). Graduation only ever happens at the full ceiling (~4.2 ETH — see ready()), so the creator always
        // earns their 0.5. Capped at raise/4 apiece so the two payouts can never exceed half the raise (the Bond
        // floor always keeps >=50%). Reentrancy-safe (nonReentrant + no callback); dev + platform non-zero.
        uint256 reward = Math.min(GRAD_REWARD, raisedWeth / 4);
        if (reward > 0) {
            raisedWeth -= 2 * reward;
            IERC20(WETH).safeTransfer(dev, reward);      // creator
            IERC20(WETH).safeTransfer(platform, reward); // platform
        }

        // Post the Bond around the CURRENT price. The Sherwood LP needs tokens; pair them from the Ambush
        // reserve PLUS any still-unsold curve tokens (rolled in here rather than burned), and the remainder
        // becomes the Ambush sell-wall whose earnings deepen the floor. Graduating later => bigger raise =>
        // thicker floor AND fewer unsold tokens => a lighter sell-wall.
        uint256 sherwoodWeth = (raisedWeth * SHERWOOD_WETH_BPS) / 10_000;
        uint256 bountyWeth = raisedWeth - sherwoodWeth;
        // The whole token balance goes to the Bond: the ambush reserve + the unsold curve tokens just
        // collected + any rounding dust the seed mint left behind. Using the actual balance (rather than
        // ambushSupply + leftToken) guarantees nothing is stranded in the curve. A stray token donation would
        // only inflate the harmless Ambush wall — it can't be extracted.
        uint256 tokenPool = token.balanceOf(address(this));
        uint256 quote = PoolMath.quoteWethPerToken(sp, tokenIsToken0);
        require(quote > 0, "price"); // fail fast rather than divide-by-zero at an extreme (mis-configured) price
        uint256 sherwoodTokens = Math.min(tokenPool, Math.mulDiv(sherwoodWeth, 1e18, quote));
        // Sherwood needs BOTH sides; a 0 token amount would make Bond.post's fullRangeLiquidity revert "bad
        // liquidity" and brick graduate() (raise stranded in the curve). Unreachable with the pad's large-supply
        // low-price geometry (quote << 1e18 → sherwoodTokens == tokenPool), but assert it with a named error so a
        // misconfigured price/supply fails loudly here rather than deep in the math library.
        require(sherwoodTokens > 0, "sherwood");
        uint256 ambushForBond = tokenPool - sherwoodTokens;

        address b = ICurveBondDeployer(bondDeployer).deploy(address(token), WETH, address(v3Factory), platform, address(this));
        bond = b;
        IERC20(WETH).safeTransfer(b, raisedWeth);
        IERC20(token).safeTransfer(b, tokenPool); // = sherwoodTokens + ambushForBond
        ICurveBond(b).post(sherwoodWeth, sherwoodTokens, bountyWeth, ambushForBond);

        // sweep any WETH dust
        uint256 wethDust = IERC20(WETH).balanceOf(address(this));
        if (wethDust > 0) IERC20(WETH).safeTransfer(platform, wethDust);

        emit Graduated(b, raisedWeth, leftToken);
    }

    function _mint(int24 lo, int24 hi, uint128 L) internal {
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

    /// @dev Only ever invoked by the one-off graduate() nudge that pushes a griefed above-ceiling spot back to
    /// the ceiling. Guarded by `_swapping` (set only inside graduate()) and the pool identity, so no external
    /// caller can drain the curve through it. Pays whatever the pool is owed from this contract's balance.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external override {
        if (msg.sender != address(pool)) revert NotPool();
        require(_swapping, "no swap");
        if (amount0Delta > 0) IERC20(token0).safeTransfer(msg.sender, uint256(amount0Delta));
        if (amount1Delta > 0) IERC20(token1).safeTransfer(msg.sender, uint256(amount1Delta));
    }
}
