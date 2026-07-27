// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// ─────────────────────────────────────────────────────────────────────────────
// RobinSwap — trade the top coins on Robinhood Chain on Robin Labs, and get paid.
//
// A thin fee+reward wrapper over the chain's live Uniswap v3 SwapRouter02. For each
// curated token, a buy/sell routes through the token's WETH pool; RobinSwap skims a
// CONFIGURABLE per-side fee (RobinSwapFeeConfig) and splits it: a platform cut, a Robin-LP
// cut, and a reward leg accrued to the RewardVault (buys → traders pot, sells → holders
// pot), so the same rewards the pad's own coins earn extend to the whole chain's top coins.
//
// Shaped on PadRouter: escrow-then-flush fees (never revert a trade on payout), try/catch
// vault accrual, nonReentrant, native-ETH↔WETH wrapping, a curated register-once allowlist,
// and a defensive fee-config read that falls back to a safe default. Legacy (type-0) txs.
// ─────────────────────────────────────────────────────────────────────────────

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256) external;
    function approve(address, uint256) external returns (bool);
}

interface IRewardVault {
    function accrue(address coin, uint8 side) external payable; // side 0 = traders, 1 = holders
}

interface IRobinSwapFeeConfig {
    function rates(bool isBuy) external view returns (uint256 total, uint16 platformShare, uint16 lpShare);
}

contract RobinSwap is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 private constant SIDE_TRADERS = 0;
    uint8 private constant SIDE_HOLDERS = 1;
    uint16 private constant BPS = 10000;
    // Safe fallback if the fee config is unset/broken: 1.25% side, 0.5% platform / 0.25% LP / 0.5% rewards.
    uint16 private constant DEF_TOTAL = 125;
    uint16 private constant DEF_PLAT = 4000;
    uint16 private constant DEF_LP = 2000;
    uint16 private constant MAX_TOTAL = 400; // never over-tax, even if a bad config slips the read guard

    address public immutable WETH;
    address public immutable swapRouter; // Uniswap SwapRouter02 on Robinhood Chain

    struct Listing {
        uint24 poolFee; // the token/WETH pool's fee tier (e.g. 10000 = 1%)
        address lpSink; // per-token Robin-LP sink (0 → use lpSinkDefault)
        bool set;       // register-once presence
        bool paused;    // curator can halt a listing without deleting it
    }
    mapping(address => Listing) public listing;
    mapping(address => bool) public isCurator; // allowlist governors (owner-managed)

    address public feeConfig;      // RobinSwapFeeConfig (0 → hardcoded default split)
    address public rewardVault;    // RobinSwap's RewardVault (0 → reward legs OFF, whole fee to platform/LP)
    mapping(address => bool) public wasRewardVault; // every vault ever wired here (current + migrated-away) — see donateFloor
    address public lpSinkDefault;  // global Robin-LP sink
    address public platformWallet; // platform cut recipient

    uint256 public platformEscrow;               // platform cut, native ETH
    mapping(address => uint256) public lpEscrow;  // Robin-LP cut per token, native ETH

    error Unknown();
    error Paused();
    error Dust();
    error Slippage();
    error NotCurator();
    error AlreadyListed();
    error BadArg();
    error PayFailed();
    error NotVault();

    event Listed(address indexed token, uint24 poolFee, address lpSink);
    event ListingPaused(address indexed token, bool paused);
    event Bought(address indexed token, address indexed buyer, uint256 ethIn, uint256 fee, uint256 tokensOut);
    event Sold(address indexed token, address indexed seller, uint256 tokensIn, uint256 fee, uint256 ethOut);
    event RewardAccrued(address indexed token, uint8 side, uint256 amount);
    event PlatformWithdrawn(uint256 amount);
    event LpFlushed(address indexed token, address indexed sink, uint256 amount);

    constructor(address weth_, address swapRouter_, address owner_) Ownable(owner_) {
        if (weth_ == address(0) || swapRouter_ == address(0)) revert BadArg();
        WETH = weth_;
        swapRouter = swapRouter_;
        isCurator[owner_] = true;
    }

    // ── trading ─────────────────────────────────────────────────────────────────

    /// Buy `token` with native ETH. Fee is skimmed in ETH; the rest is swapped WETH→token to the buyer.
    function buy(address token, uint256 minOut) external payable nonReentrant returns (uint256 tokensOut) {
        Listing memory L = listing[token];
        if (!L.set) revert Unknown();
        if (L.paused) revert Paused();

        (uint256 total, , ) = _rates(true);
        uint256 fee = (msg.value * total) / BPS;
        uint256 net = msg.value - fee;
        if (net == 0) revert Dust();

        IWETH9(WETH).deposit{value: net}();
        IWETH9(WETH).approve(swapRouter, net);
        tokensOut = ISwapRouter02(swapRouter).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams(WETH, token, L.poolFee, msg.sender, net, minOut, 0));
        if (tokensOut < minOut) revert Slippage();

        _distribute(token, fee, true); // fee stays as native ETH → platform/lp/reward
        emit Bought(token, msg.sender, msg.value, fee, tokensOut);
    }

    /// Sell `amountIn` of `token` for ETH. Needs a prior exact-amount approval of `token` to THIS router.
    function sell(address token, uint256 amountIn, uint256 minOutEth) external nonReentrant returns (uint256 ethOut) {
        Listing memory L = listing[token];
        if (!L.set) revert Unknown();
        if (L.paused) revert Paused();

        // Fee-on-transfer safe: swap the amount we ACTUALLY received, not amountIn.
        uint256 beforeBal = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 got = IERC20(token).balanceOf(address(this)) - beforeBal;
        if (got == 0) revert Dust();

        IERC20(token).forceApprove(swapRouter, got);
        uint256 wethOut = ISwapRouter02(swapRouter).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams(token, WETH, L.poolFee, address(this), got, 0, 0));
        IWETH9(WETH).withdraw(wethOut);

        (uint256 total, , ) = _rates(false);
        uint256 fee = (wethOut * total) / BPS;
        ethOut = wethOut - fee;
        if (ethOut < minOutEth) revert Slippage();

        _distribute(token, fee, false);
        (bool ok, ) = msg.sender.call{value: ethOut}("");
        if (!ok) revert PayFailed();
        emit Sold(token, msg.sender, amountIn, fee, ethOut);
    }

    // ── fee carve ─────────────────────────────────────────────────────────────────

    function _distribute(address token, uint256 fee, bool isBuy) internal {
        if (fee == 0) return;
        (, uint16 platShare, uint16 lpShare) = _rates(isBuy);
        uint256 toPlat = (fee * platShare) / BPS;
        uint256 toLp = (fee * lpShare) / BPS;
        uint256 toReward = fee - toPlat - toLp; // remainder → reward leg (no dust)

        platformEscrow += toPlat;
        lpEscrow[token] += toLp;

        if (rewardVault != address(0) && toReward > 0) {
            uint8 side = isBuy ? SIDE_TRADERS : SIDE_HOLDERS;
            // try/catch so a paused/misconfigured vault can never revert a trade; funds fall back to LP.
            try IRewardVault(rewardVault).accrue{value: toReward}(token, side) {
                emit RewardAccrued(token, side, toReward);
            } catch {
                lpEscrow[token] += toReward;
            }
        } else {
            lpEscrow[token] += toReward; // reward legs off → the reward slice deepens Robin LP instead
        }
    }

    /// Defensive read of the fee dial: a bad/broken config can never revert or over-tax a trade.
    /// The read is done with a HARD gas cap + FIXED 96-byte output buffer and the three fields are decoded as
    /// uint256s, so neither a returndata bomb nor dirty high bits (which Solidity's strict uintN abi.decode would
    /// revert on, in THIS frame, uncaught) can brick a buy/sell. On any failure we fall back to the safe default.
    function _rates(bool isBuy) internal view returns (uint256 total, uint16 platShare, uint16 lpShare) {
        address fc = feeConfig;
        if (fc != address(0)) {
            (bool ok, uint256 t, uint256 p, uint256 l) = _readRatesRaw(fc, isBuy);
            // Bound each share BEFORE summing so a lying config can't overflow the sum, then range-check the split.
            if (ok && t <= MAX_TOTAL && p <= BPS && l <= BPS && p + l <= BPS) {
                return (t, uint16(p), uint16(l));
            }
        }
        return (DEF_TOTAL, DEF_PLAT, DEF_LP);
    }

    /// @dev Low-level read of RobinSwapFeeConfig.rates(bool): 50k gas cap bounds a griefing callee, a FIXED 0x60
    /// output buffer copies at most 3 words no matter how large the return data is (returndata-bomb proof), and
    /// decoding as uint256 never reverts on dirty high bits. NEVER reverts — returns ok=false on any failure.
    function _readRatesRaw(address fc, bool isBuy) private view returns (bool ok, uint256 t, uint256 p, uint256 l) {
        bytes4 sel = IRobinSwapFeeConfig.rates.selector;
        assembly {
            let m := mload(0x40)
            mstore(m, sel)              // 4-byte selector, left-aligned
            mstore(add(m, 0x04), isBuy) // the bool argument
            // staticcall(gas, addr, inPtr, inSize=0x24, outPtr, outSize=0x60): fixed 3-word buffer, 50k gas cap
            ok := staticcall(50000, fc, m, 0x24, m, 0x60)
            if lt(returndatasize(), 0x60) { ok := 0 } // require a full 3-word answer, else treat as failure
            t := mload(m)
            p := mload(add(m, 0x20))
            l := mload(add(m, 0x40))
        }
        if (!ok) return (false, 0, 0, 0); // never let stale scratch bytes look like a valid split
    }

    // ── permissionless payouts ─────────────────────────────────────────────────────

    function withdrawPlatform() external nonReentrant {
        uint256 amt = platformEscrow;
        if (amt == 0) return;
        platformEscrow = 0;
        address to = platformWallet == address(0) ? owner() : platformWallet;
        (bool ok, ) = to.call{value: amt}("");
        if (!ok) revert PayFailed();
        emit PlatformWithdrawn(amt);
    }

    function flushLp(address token) external nonReentrant {
        uint256 amt = lpEscrow[token];
        if (amt == 0) return;
        lpEscrow[token] = 0;
        address sink = listing[token].lpSink != address(0) ? listing[token].lpSink : lpSinkDefault;
        if (sink == address(0)) sink = owner();
        (bool ok, ) = sink.call{value: amt}("");
        if (!ok) revert PayFailed();
        emit LpFlushed(token, sink, amt);
    }

    /// The vault's sweep/emergencySweep calls this on its router for stranded epochs. Here it means "credit
    /// the Robin-LP escrow" (external tokens have no Bond floor). Keeps the vault bytecode identical.
    /// Gate on wasRewardVault (any current-or-former vault), not just the CURRENT one: RewardVault.router is
    /// immutable, so after a setRewardVault migration an OLD vault still calls back here on a late sweep and
    /// must not be rejected (which would strand its swept remainder). Mirrors PadRouter.
    function donateFloor(address token) external payable {
        if (!wasRewardVault[msg.sender]) revert NotVault();
        lpEscrow[token] += msg.value;
    }

    // ── curation (register-once, curator-gated) ─────────────────────────────────────

    function list(address token, uint24 poolFee, address lpSink) external {
        if (!isCurator[msg.sender]) revert NotCurator();
        if (token == address(0) || poolFee == 0) revert BadArg();
        if (listing[token].set) revert AlreadyListed();
        listing[token] = Listing(poolFee, lpSink, true, false);
        emit Listed(token, poolFee, lpSink);
    }

    function setPaused(address token, bool paused) external {
        if (!isCurator[msg.sender]) revert NotCurator();
        if (!listing[token].set) revert Unknown();
        listing[token].paused = paused;
        emit ListingPaused(token, paused);
    }

    /// Correct a mislisted token (e.g. a wrong poolFee tier that would route every trade to a dead pool)
    /// WITHOUT a redeploy. Curator-gated; only updates an EXISTING listing (list() stays register-once),
    /// and preserves the paused flag. Without this, a single fat-fingered list() bricks a token forever.
    function relist(address token, uint24 poolFee, address lpSink) external {
        if (!isCurator[msg.sender]) revert NotCurator();
        if (poolFee == 0) revert BadArg();
        if (!listing[token].set) revert Unknown();
        listing[token].poolFee = poolFee;
        listing[token].lpSink = lpSink;
        emit Listed(token, poolFee, lpSink);
    }

    // ── owner config ───────────────────────────────────────────────────────────────

    function setCurator(address who, bool on) external onlyOwner { isCurator[who] = on; }
    // Must be a CONTRACT: a code-size check stops an EOA/typo that would silently misdirect the reward leg (a
    // value-call to a codeless account succeeds and swallows the ETH, so the try/catch → LP fallback never fires).
    function setFeeConfig(address fc) external onlyOwner {
        if (fc != address(0)) require(fc.code.length > 0, "not a contract");
        feeConfig = fc;
    }
    function setRewardVault(address v) external onlyOwner {
        if (v != address(0)) { require(v.code.length > 0, "not a contract"); wasRewardVault[v] = true; }
        rewardVault = v;
    }
    function setLpSinkDefault(address s) external onlyOwner { lpSinkDefault = s; }
    function setPlatformWallet(address w) external onlyOwner { platformWallet = w; }

    /// Ownership is load-bearing — platformEscrow/lpEscrow fall back to owner() when their sinks are unset, so
    /// renouncing would let a flush burn escrowed ETH to address(0) and permanently brick curation/config.
    /// Disabled; transfer via Ownable2Step's transferOwnership/acceptOwnership instead.
    function renounceOwnership() public pure override { revert("disabled"); }

    /// Keep curator rights in sync with ownership: a new owner (via acceptOwnership) is automatically a curator,
    /// so control never lands with an owner who can't list/pause. The prior owner's rights persist until revoked.
    function _transferOwnership(address newOwner) internal override {
        super._transferOwnership(newOwner);
        if (newOwner != address(0)) isCurator[newOwner] = true;
    }

    receive() external payable {} // WETH.withdraw sends ETH here
}
