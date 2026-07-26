// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title  RobinDistributor
/// @notice Holds a fixed set of recipient wallets and splits its ETH balance
///         across them as evenly as possible, in whole `unitWei` increments
///         (the "$0.0000814 step"). You fund the contract, then run one round:
///         `startRound()` snapshots the balance and computes the even split, and
///         `distribute(count)` pays recipients in batches — batching is required
///         because Robinhood Chain caps a single tx at 2^24 (16,777,216) gas, so
///         ~1000 sends can't fit in one transaction.
///
///         The even split: totalUnits = balance / unitWei; every recipient gets
///         `totalUnits / n` units, and the first `totalUnits % n` recipients get
///         one extra unit. No two funded recipients ever differ by more than one
///         increment. Whatever can't fill a whole increment stays as dust for the
///         next round (or `sweep()`).
///
///         There is no USD oracle on this chain, so `unitWei` (the increment in
///         wei) is set by the owner — refresh it to `$0.0000814` at the current
///         ETH price with the provided off-chain helper.
contract RobinDistributor {
    address public owner;
    address[] public recipients;

    /// The increment every payout is a whole multiple of (wei).
    uint256 public unitWei;

    // ── Active-round snapshot (so batched payouts stay internally consistent) ──
    bool    public roundActive;
    uint256 public roundTotal; // balance captured at startRound()
    uint256 public baseUnits;  // units every recipient receives
    uint256 public extra;      // first `extra` recipients receive one extra unit
    uint256 public cursor;     // next recipient index to pay
    uint256 public roundPaid;  // wei successfully paid this round

    // Bounded gas forwarded to each recipient: enough for an EOA or simple
    // wallet, but caps a hostile recipient so it can't brick a whole batch.
    uint256 private constant SEND_GAS = 50_000;

    uint256 private _lock; // reentrancy guard

    event RecipientsAdded(uint256 added, uint256 total);
    event UnitSet(uint256 unitWei);
    event RoundStarted(uint256 roundTotal, uint256 totalUnits, uint256 baseUnits, uint256 extra);
    event Paid(uint256 indexed index, address indexed to, uint256 amount);
    event PayFailed(uint256 indexed index, address indexed to, uint256 amount);
    event RoundFinished(uint256 paid, uint256 leftover);
    event Swept(address indexed to, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier nonReentrant() { require(_lock == 0, "reentrant"); _lock = 1; _; _lock = 0; }

    constructor(uint256 _unitWei) {
        owner = msg.sender;
        unitWei = _unitWei;
        emit OwnershipTransferred(address(0), msg.sender);
        emit UnitSet(_unitWei);
    }

    /// @notice Accept ETH (funding). Does not auto-distribute — that would blow
    ///         the per-tx gas cap and can't be batched safely.
    receive() external payable {}

    // ── Views ─────────────────────────────────────────────────────────────────

    function recipientCount() external view returns (uint256) {
        return recipients.length;
    }

    /// @notice Preview the EVEN split for the current balance (no state change).
    function previewRound()
        external
        view
        returns (uint256 balance, uint256 totalUnits, uint256 base, uint256 extra_, uint256 n, uint256 funded)
    {
        n = recipients.length;
        balance = address(this).balance;
        if (unitWei == 0 || n == 0) return (balance, 0, 0, 0, n, 0);
        totalUnits = balance / unitWei;
        base = totalUnits / n;
        extra_ = totalUnits % n;
        funded = base > 0 ? n : extra_;
    }

    /// @notice Preview a FIXED round: exactly ONE increment ($0.0000814) per
    ///         wallet, funding as many as the balance affords. `needForAll` is
    ///         the ETH value required to pay every recipient once.
    function previewFixedRound()
        external
        view
        returns (uint256 balance, uint256 base, uint256 extra_, uint256 n, uint256 funded, uint256 needForAll)
    {
        n = recipients.length;
        balance = address(this).balance;
        needForAll = unitWei * n;
        if (unitWei == 0 || n == 0) return (balance, 0, 0, n, 0, needForAll);
        uint256 affordable = balance / unitWei;
        if (affordable >= n) { base = 1; extra_ = 0; funded = n; }
        else { base = 0; extra_ = affordable; funded = affordable; }
    }

    // ── Admin ───────────────────────────────────────────────────────────────

    /// @notice Append recipients (call in batches so storing stays under the gas cap).
    function addRecipients(address[] calldata batch) external onlyOwner {
        require(!roundActive, "round active");
        uint256 len = batch.length;
        for (uint256 i = 0; i < len; i++) {
            require(batch[i] != address(0), "zero addr");
            recipients.push(batch[i]);
        }
        emit RecipientsAdded(len, recipients.length);
    }

    function setUnitWei(uint256 _unitWei) external onlyOwner {
        require(!roundActive, "round active");
        require(_unitWei > 0, "unit=0");
        unitWei = _unitWei;
        emit UnitSet(_unitWei);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ── Distribution ──────────────────────────────────────────────────────────

    /// @notice Snapshot the balance and compute the even split. One round at a time.
    function startRound() external onlyOwner {
        require(!roundActive, "round active");
        uint256 n = recipients.length;
        require(n > 0, "no recipients");
        require(unitWei > 0, "unit=0");

        uint256 bal = address(this).balance;
        uint256 totalUnits = bal / unitWei;

        roundTotal = bal;
        baseUnits = totalUnits / n;
        extra = totalUnits % n;
        cursor = 0;
        roundPaid = 0;
        roundActive = true;

        emit RoundStarted(bal, totalUnits, baseUnits, extra);
    }

    /// @notice Snapshot and set up a FIXED round: exactly ONE increment
    ///         ($0.0000814) per wallet, funding as many recipients as the balance
    ///         affords. Fund with `unitWei * recipientCount` to pay everyone once.
    function startFixedRound() external onlyOwner {
        require(!roundActive, "round active");
        uint256 n = recipients.length;
        require(n > 0, "no recipients");
        require(unitWei > 0, "unit=0");

        uint256 bal = address(this).balance;
        uint256 affordable = bal / unitWei;
        uint256 totalUnits;
        if (affordable >= n) { baseUnits = 1; extra = 0; totalUnits = n; }
        else { baseUnits = 0; extra = affordable; totalUnits = affordable; }

        roundTotal = bal;
        cursor = 0;
        roundPaid = 0;
        roundActive = true;

        emit RoundStarted(bal, totalUnits, baseUnits, extra);
    }

    /// @notice Pay the next `count` recipients their computed share. Repeat until
    ///         the round finishes (cursor reaches the recipient count). Failed
    ///         sends are skipped (their funds stay in the contract), never revert
    ///         the batch.
    function distribute(uint256 count) external onlyOwner nonReentrant {
        require(roundActive, "no active round");
        require(count > 0, "count=0");

        uint256 n = recipients.length;
        uint256 end = cursor + count;
        if (end > n) end = n;

        uint256 unit = unitWei;
        uint256 base = baseUnits;
        uint256 ext = extra;
        uint256 paid = roundPaid;

        for (uint256 i = cursor; i < end; i++) {
            uint256 units = base + (i < ext ? 1 : 0);
            if (units == 0) continue; // scarcity: later recipients get nothing this round
            uint256 amount = units * unit;
            address to = recipients[i];
            (bool ok, ) = to.call{value: amount, gas: SEND_GAS}("");
            if (ok) {
                paid += amount;
                emit Paid(i, to, amount);
            } else {
                emit PayFailed(i, to, amount);
            }
        }

        cursor = end;
        roundPaid = paid;

        if (cursor >= n) {
            roundActive = false;
            emit RoundFinished(paid, address(this).balance);
        }
    }

    /// @notice Withdraw any leftover balance (dust or skipped payouts). Not while
    ///         a round is mid-flight.
    function sweep(address to) external onlyOwner nonReentrant {
        require(!roundActive, "round active");
        require(to != address(0), "zero to");
        uint256 bal = address(this).balance;
        (bool ok, ) = to.call{value: bal}("");
        require(ok, "sweep failed");
        emit Swept(to, bal);
    }
}
