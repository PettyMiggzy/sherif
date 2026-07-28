// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
// NOTE: we hand-roll the EIP-712 domain separator instead of importing OpenZeppelin's EIP712
// base. OZ's EIP712 pulls in Strings → Bytes, which uses the Cancun `mcopy` opcode; the pad's
// contracts target a pre-Cancun EVM, and changing that globally would recompile the live stack.
// ECDSA has no such dependency, so signature recovery still uses the audited library.

// ─────────────────────────────────────────────────────────────────────────────
// RobinLimit — non-custodial limit orders + DCA for Robin Labs, over RobinSwap.
//
// The maker signs an EIP-712 order and grants this contract an ERC20 allowance on the
// token they're selling (WETH to buy a coin, the coin to sell for WETH). NOTHING is
// escrowed: the contract never holds a balance between transactions. When a keeper calls
// execute(), one slice is pulled straight from the maker, swapped through RobinSwap in the
// SAME transaction, and the proceeds (minus a small, capped keeper fee) are sent to the
// maker — all atomic. The maker keeps custody the entire time and can cancel on-chain, or
// simply revoke the allowance, at any moment.
//
//   - Limit order  = 1 slice: fills once, only if the swap clears the maker's minOut (price).
//   - DCA          = N slices on an interval: each slice is an independent min-out swap, so a
//                    bad-price slice just reverts and is retried later; it never over-fills.
//
// This is NOT an order book: there is no matching, no counterparty, no inventory. Every fill
// is a peer-to-protocol swap the maker pre-authorized. Legacy (type-0) txs on chain 4663.
//
// SECURITY NOTE: this moves user funds and MUST be independently audited before it is
// deployed to mainnet. It is written to be minimal and conservative for exactly that review.
// ─────────────────────────────────────────────────────────────────────────────

interface IWETH9b {
    function deposit() external payable;
    function withdraw(uint256) external;
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IRobinSwap {
    function buy(address token, uint256 minOut) external payable returns (uint256 tokensOut);
    function sell(address token, uint256 amountIn, uint256 minOutEth) external returns (uint256 ethOut);
}

contract RobinLimit is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 private constant BPS = 10000;
    uint16 public constant MAX_KEEPER_BPS = 100; // hard ceiling: a keeper can never take more than 1% of a fill

    address public immutable WETH;
    address public immutable robinSwap;

    // Keeper fee, in bps of a slice's output, paid to whoever lands the fill (their gas incentive).
    // Enforced AFTER the maker's minOut, so the maker always receives at least the price they signed.
    uint16 public keeperFeeBps = 20; // 0.20% default; owner-tunable up to MAX_KEEPER_BPS

    // An order is identified by the hash of its typed data. We track fills so a DCA order
    // can't be over-filled and a filled/cancelled order can't be replayed.
    mapping(bytes32 => uint256) public filledSlices; // slices executed so far
    mapping(bytes32 => uint256) public lastFillTs;   // timestamp of the most recent fill (DCA cadence gate)
    mapping(bytes32 => bool)    public cancelled;     // maker cancelled the remainder

    struct Order {
        address maker;      // signer; funds come from and proceeds go to this address
        address sellToken;  // token spent per slice — WETH (to buy a coin) or the coin (to sell)
        address buyToken;   // token received — the coin (buy) or WETH (sell); the other side must be WETH
        uint256 sliceIn;    // sellToken amount pulled per slice
        uint256 minOut;     // minimum buyToken the maker must receive per slice, net of the keeper fee (the limit price)
        uint256 slices;     // number of slices: 1 = a plain limit order, N = DCA
        uint256 interval;   // minimum seconds between fills (0 = fill as soon as the price allows)
        uint256 expiry;     // unix time after which the order is dead
        uint256 salt;       // uniqueness so two identical-parameter orders hash differently
    }

    bytes32 private constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,address sellToken,address buyToken,uint256 sliceIn,uint256 minOut,uint256 slices,uint256 interval,uint256 expiry,uint256 salt)"
    );
    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    // Cached at deploy; recomputed if the chain forks (chainid changes) so a signature can't be replayed across chains.
    bytes32 private immutable _cachedDomainSeparator;
    uint256 private immutable _cachedChainId;

    event Filled(bytes32 indexed orderHash, address indexed maker, address indexed keeper, uint256 sliceIndex, uint256 out, uint256 keeperFee);
    event Cancelled(bytes32 indexed orderHash, address indexed maker);
    event KeeperFeeSet(uint16 bps);

    constructor(address weth_, address robinSwap_, address owner_) Ownable(owner_) {
        require(weth_ != address(0) && robinSwap_ != address(0), "zero");
        WETH = weth_;
        robinSwap = robinSwap_;
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(
            DOMAIN_TYPEHASH, keccak256("RobinLimit"), keccak256("1"), block.chainid, address(this)
        ));
    }

    function _domainSeparator() private view returns (bytes32) {
        return block.chainid == _cachedChainId ? _cachedDomainSeparator : _buildDomainSeparator();
    }

    // The EIP-712 domain separator, exposed for wallets/tools that want to verify it.
    function DOMAIN_SEPARATOR() external view returns (bytes32) { return _domainSeparator(); }

    function setKeeperFeeBps(uint16 bps) external onlyOwner {
        require(bps <= MAX_KEEPER_BPS, "fee too high");
        keeperFeeBps = bps;
        emit KeeperFeeSet(bps);
    }

    // The EIP-712 digest a maker signs. Exposed so the frontend/keeper can compute the same hash.
    function hashOrder(Order calldata o) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            ORDER_TYPEHASH, o.maker, o.sellToken, o.buyToken,
            o.sliceIn, o.minOut, o.slices, o.interval, o.expiry, o.salt
        ));
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    // How many more slices could still fill right now (ignoring price) — a cheap view for the keeper/UI.
    function remainingSlices(Order calldata o) external view returns (uint256) {
        bytes32 h = hashOrder(o);
        if (cancelled[h] || block.timestamp > o.expiry) return 0;
        uint256 done = filledSlices[h];
        return done >= o.slices ? 0 : o.slices - done;
    }

    // Maker cancels the remainder of an order. Only the maker can; idempotent.
    function cancel(Order calldata o) external {
        require(msg.sender == o.maker, "not maker");
        bytes32 h = hashOrder(o);
        if (!cancelled[h]) {
            cancelled[h] = true;
            emit Cancelled(h, o.maker);
        }
    }

    // Execute one slice of a signed order. Permissionless: any keeper may land a valid fill and
    // earn the keeper fee. Reverts (costing the keeper only gas) if the price/cadence isn't met,
    // so nothing partial or unauthorized can happen.
    function execute(Order calldata o, bytes calldata signature) external nonReentrant returns (uint256 makerOut) {
        require(o.slices >= 1, "no slices");
        require(o.sliceIn > 0, "no amount");
        require(block.timestamp <= o.expiry, "expired");
        // exactly one leg must be WETH; the other is the coin. This is an ETH-quoted venue.
        require(o.sellToken == WETH ? o.buyToken != WETH : o.buyToken == WETH, "pair");
        // A zero minOut would disable the price floor entirely (any fill "clears"), turning a slice
        // into an unprotected market buy a searcher can sandwich to near-total loss. Every order MUST
        // carry a real minimum. The app enforces this too; this is the on-chain backstop.
        require(o.minOut > 0, "no min");

        bytes32 h = hashOrder(o);
        require(!cancelled[h], "cancelled");

        uint256 done = filledSlices[h];
        require(done < o.slices, "filled");
        // DCA cadence: enforce the interval between consecutive fills. The first fill is unrestricted.
        if (done > 0) require(block.timestamp >= lastFillTs[h] + o.interval, "too soon");

        // verify the maker actually signed THIS order
        require(ECDSA.recover(h, signature) == o.maker, "bad sig");

        // ---- effects before interactions (also nonReentrant-guarded) ----
        filledSlices[h] = done + 1;
        lastFillTs[h] = block.timestamp;

        // ---- pull exactly one slice from the maker and swap it, atomically ----
        // We pass 0 as the underlying swap's own min-out and enforce the maker's limit price HERE
        // instead (makerOut >= o.minOut below). Both the swap and the check are in this one atomic tx,
        // so a price move — even a same-block sandwich — just makes `out` fall short and reverts the
        // whole fill; nothing settles below the signed price. This keeps RobinLimit the single, clear
        // authority on the limit price (revert "price") rather than double-gating with the swap.
        uint256 out;
        if (o.sellToken == WETH) {
            // BUY the coin with WETH: pull WETH, unwrap, buy through RobinSwap (proceeds land here).
            uint256 ethBefore = address(this).balance; // any pre-existing (force-fed) ETH — measure the delta, not the total
            IERC20(WETH).safeTransferFrom(o.maker, address(this), o.sliceIn);
            IWETH9b(WETH).withdraw(o.sliceIn);
            uint256 before = IERC20(o.buyToken).balanceOf(address(this));
            IRobinSwap(robinSwap).buy{value: o.sliceIn}(o.buyToken, 0);
            out = IERC20(o.buyToken).balanceOf(address(this)) - before;
            // The venue may refund unspent ETH (padRouter does on a near-graduation partial fill, where the
            // buy hits the curve top and can't absorb the whole slice). Return ONLY this fill's refund to the
            // maker as WETH (delta above ethBefore), so a force-fed balance can't be donated to the maker and
            // nothing is stranded. A venue that never refunds (RobinSwap) makes this a no-op.
            uint256 refund = address(this).balance - ethBefore;
            if (refund > 0) { IWETH9b(WETH).deposit{value: refund}(); IERC20(WETH).safeTransfer(o.maker, refund); }
        } else {
            // SELL the coin for WETH: pull the coin, approve RobinSwap, sell (ETH lands here), wrap to WETH.
            IERC20(o.sellToken).safeTransferFrom(o.maker, address(this), o.sliceIn);
            IERC20(o.sellToken).forceApprove(robinSwap, o.sliceIn);
            uint256 ethBefore = address(this).balance;
            IRobinSwap(robinSwap).sell(o.sellToken, o.sliceIn, 0);
            uint256 ethOut = address(this).balance - ethBefore;
            IWETH9b(WETH).deposit{value: ethOut}();
            out = ethOut;
            // The venue may consume only PART of the slice and return the rest (padRouter refunds the
            // unconsumed coin on a floor/partial fill). Clear the residual approval and sweep any leftover
            // sellToken back to the maker, so a partial sell never strands the maker's tokens here.
            IERC20(o.sellToken).forceApprove(robinSwap, 0);
            uint256 leftover = IERC20(o.sellToken).balanceOf(address(this));
            if (leftover > 0) IERC20(o.sellToken).safeTransfer(o.maker, leftover);
        }

        // keeper fee comes out of the OUTPUT, capped; the maker still nets at least their signed minOut.
        uint256 fee = (out * keeperFeeBps) / BPS;
        uint256 send = out - fee;

        // Enforce the limit price on what the maker ACTUALLY RECEIVES, measured across the transfer, so a
        // fee-on-transfer buyToken (RobinSwap can list external tokens) can't deliver less than the signed
        // minOut while still passing a pre-transfer check. Standard tokens: received == send, unchanged.
        uint256 mBefore = IERC20(o.buyToken).balanceOf(o.maker);
        IERC20(o.buyToken).safeTransfer(o.maker, send);
        makerOut = IERC20(o.buyToken).balanceOf(o.maker) - mBefore;
        require(makerOut >= o.minOut, "price");

        if (fee > 0) IERC20(o.buyToken).safeTransfer(msg.sender, fee);

        emit Filled(h, o.maker, msg.sender, done, out, fee);
    }

    // Only ever receives ETH transiently from WETH.withdraw / RobinSwap.sell during execute().
    receive() external payable {
        require(msg.sender == WETH || msg.sender == robinSwap, "no eth");
    }
}
