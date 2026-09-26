// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

interface IHolderSlotSource {
    function claimRecipient(uint256 slot) external returns (uint256);
}

/// @notice ERC-20 for a launch whose creator gave holders a share of the
/// fees ("holder dividends"). Like TrollLaunchToken: fixed supply, no
/// transfer tax, no admin, no owner, no trading restrictions of any kind.
///
/// How holders get paid: the launch's splitter lists THIS contract as one
/// of its payout wallets (`holdersSlot`), so the holders' share of every
/// fee lands here in USDC. `distribute()` pulls that slot and shares
/// whatever USDC arrived since the last call across every holder, pro rata
/// to balance, using the standard "dividend per share" accounting, so a
/// payout costs the same gas for 10 holders or 10 million. Each holder
/// claims their own USDC whenever they like with `claim()`; what they have
/// earned stays theirs after they sell or move their tokens.
///
/// Excluded from dividends (their share goes to everyone else): the
/// Uniswap v4 PoolManager (it holds the pool's tokens), the dead address
/// (burned tokens), this contract, the launch's splitter and the minter
/// (the portal, which only holds the supply inside the launch transaction).
/// The launch's locker isn't known when the token is made; it keeps a few
/// wei of rounding dust from seeding the pool, so its share is dust too.
///
/// Anyone may call `distribute()`. USDC sent here directly is shared out
/// the same way. Nothing is shared while fewer than MIN_ELIGIBLE_SUPPLY
/// tokens (0.1% of supply) sit outside the pool; the USDC waits for the
/// next call. That floor also keeps the per-share figure bounded, so the
/// accounting in every transfer can never overflow and block trading.
contract TrollHolderToken is ERC20 {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint256 internal constant MAGNITUDE = 2 ** 128;
    uint256 public constant MIN_ELIGIBLE_SUPPLY = 1_000_000 ether;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address public immutable quoteAsset; // USDC: what dividends are paid in
    address public immutable poolManager;
    address public immutable splitter;
    uint256 public immutable holdersSlot; // this contract's payout slot in the splitter
    address public immutable minter;

    uint256 public magnifiedDividendPerShare;
    uint256 public eligibleSupply; // tokens held outside the excluded addresses
    uint256 public totalDistributed; // USDC shared out to holders, ever
    uint256 public totalClaimed; // USDC holders have claimed, ever
    mapping(address => int256) internal _corrections;
    mapping(address => uint256) public claimedBy;

    event DividendsDistributed(uint256 amount, uint256 eligibleSupply);
    event DividendClaimed(address indexed holder, uint256 amount);

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 totalSupply_,
        address minter_,
        address quoteAsset_,
        address poolManager_,
        address splitter_,
        uint256 holdersSlot_
    ) ERC20(name_, symbol_) {
        quoteAsset = quoteAsset_;
        poolManager = poolManager_;
        splitter = splitter_;
        holdersSlot = holdersSlot_;
        minter = minter_;
        _mint(minter_, totalSupply_);
    }

    function isExcluded(address account) public view returns (bool) {
        return account == poolManager || account == DEAD || account == address(this) || account == splitter
            || account == minter;
    }

    /// @notice Pulls the holders' share from the splitter and shares every
    /// USDC that arrived since the last call across all holders. Anyone may
    /// call. Returns the amount shared (0 if there was nothing new, or too
    /// few tokens outside the pool, in which case it waits).
    function distribute() public returns (uint256 amount) {
        // A failed pull (e.g. USDC paused) must never block claims of what
        // is already here.
        try IHolderSlotSource(splitter).claimRecipient(holdersSlot) {} catch {}
        uint256 supply = eligibleSupply;
        if (supply < MIN_ELIGIBLE_SUPPLY) return 0;
        uint256 held = totalDistributed - totalClaimed;
        uint256 balance = IERC20(quoteAsset).balanceOf(address(this));
        if (balance <= held) return 0;
        amount = balance - held;
        magnifiedDividendPerShare += (amount * MAGNITUDE) / supply;
        totalDistributed += amount;
        emit DividendsDistributed(amount, supply);
    }

    /// @notice Shares out anything new, then pays you every USDC you have
    /// earned. Returns what was paid (0 if nothing).
    function claim() external returns (uint256 amount) {
        distribute();
        amount = dividendsOf(msg.sender);
        if (amount == 0) return 0;
        claimedBy[msg.sender] += amount;
        totalClaimed += amount;
        IERC20(quoteAsset).safeTransfer(msg.sender, amount);
        emit DividendClaimed(msg.sender, amount);
    }

    /// @notice USDC `account` can claim right now (after the last distribute).
    function dividendsOf(address account) public view returns (uint256) {
        return earnedBy(account) - claimedBy[account];
    }

    /// @notice USDC `account` has earned, ever, claimed or not.
    function earnedBy(address account) public view returns (uint256) {
        if (isExcluded(account)) return 0;
        int256 magnified = (magnifiedDividendPerShare * balanceOf(account)).toInt256() + _corrections[account];
        return magnified <= 0 ? 0 : uint256(magnified) / MAGNITUDE;
    }

    /// @notice USDC waiting to be shared by the next distribute(): what's here
    /// plus the holders' slot in the splitter. Tax still in the hook (not yet
    /// flushed) isn't counted.
    function pendingDistribution() external view returns (uint256 amount) {
        uint256 held = totalDistributed - totalClaimed;
        uint256 balance = IERC20(quoteAsset).balanceOf(address(this));
        if (balance > held) amount = balance - held;
        (bool ok, bytes memory data) = splitter.staticcall(abi.encodeWithSignature("recipientCredits()"));
        if (ok) {
            uint256[] memory credits = abi.decode(data, (uint256[]));
            if (holdersSlot < credits.length) amount += credits[holdersSlot];
        }
    }

    /// @dev Keeps each holder's earnings fixed across transfers: tokens that
    /// move carry no past dividends with them. Only bookkeeping; a transfer
    /// is never blocked, taxed or limited.
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        int256 magnified = (magnifiedDividendPerShare * value).toInt256();
        if (from != address(0) && !isExcluded(from)) {
            _corrections[from] += magnified;
            eligibleSupply -= value;
        }
        if (to != address(0) && !isExcluded(to)) {
            _corrections[to] -= magnified;
            eligibleSupply += value;
        }
    }
}
