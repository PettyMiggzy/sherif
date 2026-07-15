// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IUniswapV3Pool, IUniswapV3SwapCallback, IWETH9} from "./interfaces/IUniswapV3.sol";
import {PoolMath} from "./libraries/PoolMath.sol";

interface ICurveForBond {
    function bond() external view returns (address);
}

interface IBondPoke {
    function poke() external;
}

/// @title PadRouter — the Pad's swap desk + the project tax
/// @notice Robinhood Chain has no canonical Uniswap periphery, so this IS the router every trade goes
/// through. Buys take native ETH (no token approval); sells take the token (one exact-amount approval to
/// THIS router). On top of the swap it applies each project's own, self-set tax — **capped at 4% buy and
/// 4% sell** — of which the **platform always takes 25%** and the project keeps 75%, split across:
///   - the project's own wallet,
///   - deepening that coin's Bond floor (WETH into the Bond → recycled as the buy-wall), and
///   - auto-burn (buy the token and send it to dead).
///
/// The tax is NOT a token transfer tax (which would break Uniswap v3 and flag as a honeypot). It is a
/// swap-desk fee — the EVM equivalent of a Jupiter platformFee — so the token stays clean and tradeable.
///
/// Design note: fee shares accumulate as ESCROW and are paid out by separate, permissionless flush/withdraw
/// calls — never inside the user's trade. So a bad project wallet, a paused Bond, or a burn swap can never
/// make someone's buy or sell revert.
contract PadRouter is Ownable2Step, ReentrancyGuard, IUniswapV3SwapCallback {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_TAX_BPS = 400; // 4% hard cap, per side, enforced at registration
    uint16 public constant PLATFORM_BPS = 2500; // platform's cut OF THE TAX = 25% (immutable)
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address public immutable WETH;

    struct Cfg {
        address pool;
        address curve;
        address projectWallet;
        uint16 buyBps; // ≤ MAX_TAX_BPS
        uint16 sellBps; // ≤ MAX_TAX_BPS
        uint16 walletBps; // split of the PROJECT share (the 75%); the three sum to 10000
        uint16 floorBps;
        uint16 burnBps;
        bool set;
    }

    address public factory; // only the factory may register a coin (set once)
    mapping(address => Cfg) internal _cfg;
    mapping(address => address) public bondOf; // token -> its Bond (once graduated)

    // escrowed fee shares (all in native ETH), paid out by permissionless flushers
    uint256 public platformEscrow;
    mapping(address => uint256) public devEscrow;
    mapping(address => uint256) public floorEscrow;
    mapping(address => uint256) public burnEscrow;

    bool private _swapping;
    address private _activePool; // the pool we're mid-swap with (callback authenticity check)

    error Unknown();
    error OnlyFactory();
    error BadTax();
    error BadAlloc();
    error Slippage();
    error Dust();

    event Registered(address indexed token, uint16 buyBps, uint16 sellBps, uint16 walletBps, uint16 floorBps, uint16 burnBps);
    event Bought(address indexed token, address indexed buyer, uint256 ethIn, uint256 fee, uint256 tokensOut);
    event Sold(address indexed token, address indexed seller, uint256 tokensIn, uint256 fee, uint256 ethOut);
    event FeeSplit(address indexed token, uint256 platform, uint256 dev, uint256 floor, uint256 burn);

    constructor(address weth_, address owner_) Ownable(owner_) {
        require(weth_ != address(0), "zero");
        WETH = weth_;
    }

    receive() external payable {} // WETH.withdraw

    function setFactory(address f) external onlyOwner {
        require(factory == address(0) && f != address(0), "set");
        factory = f;
    }

    function configOf(address token) external view returns (Cfg memory) {
        return _cfg[token];
    }

    /// @notice Registered once, by the factory, when a coin launches. Enforces the 4% caps and that the
    /// project-share allocation sums to 100%.
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
    ) external {
        if (msg.sender != factory) revert OnlyFactory();
        if (buyBps > MAX_TAX_BPS || sellBps > MAX_TAX_BPS) revert BadTax();
        if (uint256(walletBps) + floorBps + burnBps != 10_000) revert BadAlloc();
        if (walletBps > 0 && projectWallet == address(0)) revert BadAlloc();
        _cfg[token] = Cfg(pool, curve, projectWallet, buyBps, sellBps, walletBps, floorBps, burnBps, true);
        emit Registered(token, buyBps, sellBps, walletBps, floorBps, burnBps);
    }

    // ─────────────────────────────────────────────────────────── trading ──
    /// @notice Buy `token` with native ETH. No token approval. `minOut` guards slippage.
    function buy(address token, uint256 minOut) external payable nonReentrant returns (uint256 tokensOut) {
        Cfg storage c = _cfg[token];
        if (!c.set) revert Unknown();
        uint256 fee = (msg.value * c.buyBps) / 10_000;
        uint256 net = msg.value - fee;
        if (net == 0) revert Dust();

        IWETH9(WETH).deposit{value: net}();
        tokensOut = _swap(token, c.pool, WETH, net, msg.sender);
        if (tokensOut < minOut) revert Slippage();

        // refund any WETH the swap couldn't consume (e.g. a buy larger than the curve can absorb),
        // so a buyer's funds can never get stranded in the router
        uint256 leftover = IERC20(WETH).balanceOf(address(this));
        if (leftover > 0) {
            IWETH9(WETH).withdraw(leftover);
            (bool r,) = msg.sender.call{value: leftover}("");
            require(r, "refund");
        }

        _distribute(token, fee);
        emit Bought(token, msg.sender, msg.value, fee, tokensOut);
    }

    /// @notice Sell `amountIn` of `token` for native ETH. Requires an exact-amount approval to THIS router
    /// (the one approval in the app). `minOutEth` guards slippage AFTER the tax.
    function sell(address token, uint256 amountIn, uint256 minOutEth) external nonReentrant returns (uint256 ethOut) {
        Cfg storage c = _cfg[token];
        if (!c.set) revert Unknown();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);

        uint256 wethOut = _swap(token, c.pool, token, amountIn, address(this));
        IWETH9(WETH).withdraw(wethOut);

        uint256 fee = (wethOut * c.sellBps) / 10_000;
        ethOut = wethOut - fee;
        if (ethOut < minOutEth) revert Slippage();

        _distribute(token, fee);
        (bool ok,) = msg.sender.call{value: ethOut}("");
        require(ok, "pay");
        emit Sold(token, msg.sender, amountIn, fee, ethOut);
    }

    /// @dev Swap `amountIn` of `tokenIn` through the pool to `recipient`; returns the output amount.
    /// The router already holds `amountIn` of `tokenIn` (wrapped WETH for a buy, pulled token for a sell);
    /// the callback pays it. Swaps as far as the pool allows (slippage is checked by the caller).
    function _swap(address token, address pool, address tokenIn, uint256 amountIn, address recipient)
        internal
        returns (uint256 out)
    {
        bool tokenIsToken0 = token < WETH;
        bool tokenInIsToken0 = tokenIn == WETH ? !tokenIsToken0 : tokenIsToken0;
        bool zeroForOne = tokenInIsToken0;
        uint160 limit = zeroForOne ? PoolMath.MIN_SQRT_RATIO + 1 : PoolMath.MAX_SQRT_RATIO - 1;

        _swapping = true;
        _activePool = pool;
        (int256 a0, int256 a1) =
            IUniswapV3Pool(pool).swap(recipient, zeroForOne, int256(amountIn), limit, abi.encode(tokenIn));
        _activePool = address(0);
        _swapping = false;
        // the negative delta is what the pool sent OUT (to recipient)
        out = a0 < 0 ? uint256(-a0) : uint256(-a1);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external override {
        // only reachable during one of our own swaps, and only from THAT pool
        require(_swapping && msg.sender == _activePool, "no swap");
        address tokenIn = abi.decode(data, (address));
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        IERC20(tokenIn).safeTransfer(msg.sender, owed);
    }

    function _distribute(address token, uint256 fee) internal {
        if (fee == 0) return;
        Cfg storage c = _cfg[token];
        uint256 plat = (fee * PLATFORM_BPS) / 10_000;
        uint256 proj = fee - plat;
        uint256 dev = (proj * c.walletBps) / 10_000;
        uint256 burn = (proj * c.burnBps) / 10_000;
        uint256 floor = proj - dev - burn;
        platformEscrow += plat;
        devEscrow[token] += dev;
        burnEscrow[token] += burn;
        floorEscrow[token] += floor;
        emit FeeSplit(token, plat, dev, floor, burn);
    }

    // ─────────────────────────────────────────── permissionless payouts ──
    /// @notice Learn a coin's Bond once it has graduated, so the floor share can be routed to it.
    function syncBond(address token) public returns (address b) {
        Cfg storage c = _cfg[token];
        if (!c.set || c.curve == address(0)) return address(0);
        b = ICurveForBond(c.curve).bond();
        if (b != address(0)) bondOf[token] = b;
    }

    function withdrawPlatform() external nonReentrant {
        uint256 amt = platformEscrow;
        platformEscrow = 0;
        (bool ok,) = owner().call{value: amt}("");
        require(ok, "pay");
    }

    /// @notice Pay the project's accrued wallet share to its configured wallet. Anyone can trigger it; the
    /// funds only ever go to the wallet the project set at launch.
    function withdrawDev(address token) external nonReentrant {
        uint256 amt = devEscrow[token];
        if (amt == 0) return;
        devEscrow[token] = 0;
        (bool ok,) = _cfg[token].projectWallet.call{value: amt}("");
        require(ok, "pay");
    }

    /// @notice Push the accrued floor share into the coin's Bond as fresh WETH, then poke it so it becomes
    /// buy-wall depth. No-op until the coin has graduated and a Bond exists.
    function flushFloor(address token) external nonReentrant {
        uint256 amt = floorEscrow[token];
        if (amt == 0) return;
        address b = bondOf[token];
        if (b == address(0)) b = syncBond(token);
        if (b == address(0)) return; // not graduated yet — leave it escrowed
        floorEscrow[token] = 0;
        IWETH9(WETH).deposit{value: amt}();
        IERC20(WETH).safeTransfer(b, amt); // Bond's next poke() places all held WETH as Bounty
        try IBondPoke(b).poke() {} catch {}
    }

    /// @notice Spend the accrued burn share buying the token and sending it to the dead address.
    function flushBurn(address token) external nonReentrant {
        uint256 amt = burnEscrow[token];
        if (amt == 0) return;
        Cfg storage c = _cfg[token];
        burnEscrow[token] = 0;
        IWETH9(WETH).deposit{value: amt}();
        uint256 bought = _swap(token, c.pool, WETH, amt, address(this));
        IERC20(token).safeTransfer(DEAD, bought);
        // if the swap couldn't consume all of it, re-credit the residual (never leave stray WETH in the
        // router, or a later buy's refund would hand it to an unrelated buyer)
        uint256 left = IERC20(WETH).balanceOf(address(this));
        if (left > 0) {
            IWETH9(WETH).withdraw(left);
            burnEscrow[token] += left;
        }
    }
}
