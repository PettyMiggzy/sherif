// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title TokenVestingLock
/// @notice A single, shared, IRREVOCABLE token locker. A creator escrows their own token allocation
/// (e.g. their dev-buy tokens) with a cliff + linear release, so buyers can see on-chain that the dev
/// cannot dump the whole bag. One deployed instance holds many independent schedules keyed by an
/// incrementing id — no per-lock deployment.
///
/// Trust guarantee (mirrors LiquidityLocker's "no escape hatch"): there is NO cancel, NO revoke, NO
/// owner, NO admin, NO pause and NO upgrade. Once `create` writes a schedule, the only field that ever
/// changes is `released`, and released tokens can only ever go to the schedule's fixed `beneficiary`.
///
/// Intended for standard, non-rebasing 18-decimal ERC20s (like the pad's LaunchToken, which has no
/// transfer tax). `create` measures the ACTUAL amount received, so a fee-on-transfer token is recorded
/// honestly; a rebasing token whose balance later shrinks is out of scope (releases could then fall
/// short) — do not lock rebasing tokens here.
contract TokenVestingLock is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Schedule {
        address token; // ERC20 being vested
        address beneficiary; // the ONLY address released tokens can go to
        uint128 total; // actual amount received on deposit (post-transfer delta)
        uint128 released; // cumulative amount already released (<= total)
        uint64 start; // vesting start timestamp
        uint64 cliff; // absolute ts; nothing releasable before this
        uint64 duration; // seconds from start to fully vested
    }

    uint256 public nextId; // schedule counter; also the number of schedules created
    mapping(uint256 => Schedule) public schedules; // id => schedule
    mapping(address => uint256[]) internal _byBeneficiary; // beneficiary => ids (read off-chain)
    mapping(address => uint256[]) internal _byToken; // token => ids (read off-chain)

    error BadBeneficiary();
    error BadToken();
    error ZeroAmount();
    error BadDuration();
    error AmountTooLarge();
    error NoSchedule();
    error NothingToRelease();

    event ScheduleCreated(
        uint256 indexed id,
        address indexed token,
        address indexed beneficiary,
        uint256 total,
        uint64 start,
        uint64 cliff,
        uint64 duration
    );
    event Released(uint256 indexed id, address indexed beneficiary, uint256 amount);

    /// @notice Create an IRREVOCABLE vesting lock. Pulls `amount` of `token` from the caller, records the
    /// real amount received, and stores an immutable schedule. Anyone may create for any beneficiary
    /// (creating a lock only ever ESCROWS the caller's tokens for that beneficiary — it can't harm them).
    /// @param start        vesting start (0 => now)
    /// @param cliffDuration seconds after `start` before anything unlocks (0 => no cliff)
    /// @param duration     seconds after `start` to fully vest (> 0, and >= cliffDuration)
    function create(
        address token,
        address beneficiary,
        uint256 amount,
        uint64 start,
        uint64 cliffDuration,
        uint64 duration
    ) external nonReentrant returns (uint256 id) {
        if (beneficiary == address(0)) revert BadBeneficiary();
        if (token == address(0)) revert BadToken();
        if (amount == 0) revert ZeroAmount();
        if (duration == 0 || cliffDuration > duration) revert BadDuration();

        uint64 start_ = start == 0 ? uint64(block.timestamp) : start;

        // Measure the ACTUAL received amount so the schedule is honest even for a skimming token.
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 got = IERC20(token).balanceOf(address(this)) - before;
        if (got == 0) revert ZeroAmount();
        if (got > type(uint128).max) revert AmountTooLarge();

        id = nextId++;
        schedules[id] = Schedule({
            token: token,
            beneficiary: beneficiary,
            total: uint128(got),
            released: 0,
            start: start_,
            cliff: start_ + cliffDuration,
            duration: duration
        });
        _byBeneficiary[beneficiary].push(id);
        _byToken[token].push(id);

        emit ScheduleCreated(id, token, beneficiary, got, start_, start_ + cliffDuration, duration);
    }

    /// @notice Release all currently-vested-but-unreleased tokens to the schedule's beneficiary.
    /// Permissionless to trigger, but funds ALWAYS go to `beneficiary` (like LiquidityLocker.collectFees).
    function release(uint256 id) external nonReentrant returns (uint256 amount) {
        if (id >= nextId) revert NoSchedule();
        Schedule storage s = schedules[id];
        amount = _releasable(s);
        if (amount == 0) revert NothingToRelease();
        // Effects before interaction (CEI) — released can never exceed total (see _vestedAmount).
        s.released += uint128(amount);
        IERC20(s.token).safeTransfer(s.beneficiary, amount);
        emit Released(id, s.beneficiary, amount);
    }

    // ─────────────────────────────────────────────────────────── views ──

    /// @notice Cumulative amount vested at `atTime` (cliff-gated, then linear from start).
    function vestedAmount(uint256 id, uint64 atTime) public view returns (uint256) {
        if (id >= nextId) revert NoSchedule();
        return _vestedAmount(schedules[id], atTime);
    }

    /// @notice Amount claimable right now (vested minus already released).
    function releasable(uint256 id) public view returns (uint256) {
        if (id >= nextId) revert NoSchedule();
        return _releasable(schedules[id]);
    }

    /// @notice Tokens still locked right now (total minus vested).
    function locked(uint256 id) public view returns (uint256) {
        if (id >= nextId) revert NoSchedule();
        Schedule storage s = schedules[id];
        return uint256(s.total) - _vestedAmount(s, uint64(block.timestamp));
    }

    /// @notice Still-locked fraction of the schedule, in basis points (10000 = 100%).
    function lockedPercent(uint256 id) external view returns (uint256) {
        if (id >= nextId) revert NoSchedule();
        Schedule storage s = schedules[id];
        if (s.total == 0) return 0;
        return (locked(id) * 10_000) / s.total;
    }

    function scheduleCount() external view returns (uint256) {
        return nextId;
    }

    function idsOfBeneficiary(address who) external view returns (uint256[] memory) {
        return _byBeneficiary[who];
    }

    function idsOfToken(address token) external view returns (uint256[] memory) {
        return _byToken[token];
    }

    // ─────────────────────────────────────────────────────── internal ──

    function _vestedAmount(Schedule storage s, uint64 atTime) internal view returns (uint256) {
        if (atTime < s.cliff) return 0; // cliff gate (cliff >= start, so no underflow below)
        uint64 end = s.start + s.duration;
        if (atTime >= end) return s.total; // fully vested — exact total, absorbs all rounding dust
        return (uint256(s.total) * (atTime - s.start)) / s.duration; // floor: always <= total for t < end
    }

    function _releasable(Schedule storage s) internal view returns (uint256) {
        return _vestedAmount(s, uint64(block.timestamp)) - s.released;
    }
}
