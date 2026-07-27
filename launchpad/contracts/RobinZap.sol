// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ─────────────────────────────────────────────────────────────────────────────
// RobinZap — the destination "last mile" for buying a Robin Labs coin cross-chain.
//
// A user pays with ANY token on ANY EVM chain or Solana; a bridge (LI.FI, Relay,
// deBridge, Across, …) delivers ETH/WETH to Robinhood Chain and calls this handler,
// which buys the target coin through PadRouter and forwards it to the user.
//
// Why this contract must exist and be OURS: PadRouter.buy credits the bought tokens
// to msg.sender (the caller). If a bridge Executor calls buy directly, the coins land
// in the Executor, not the user. RobinZap is the caller, so it receives the coins and
// forwards them to the real recipient — and it's provider-agnostic, so every rail
// points at this one contract with no lock-in.
//
// Safety: no admin, no owner, no upgrade, holds no funds between calls. A failed buy
// (slippage) refunds the input to the recipient instead of stranding it. Reentrancy
// guarded. Robinhood Chain has no EIP-1559; callers price their own legacy tx.
// ─────────────────────────────────────────────────────────────────────────────

interface IPadRouter {
    function buy(address token, uint256 minOut) external payable returns (uint256 tokensOut);
}

interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256) external;
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract RobinZap {
    address public immutable router; // PadRouter on Robinhood Chain
    address public immutable weth;    // canonical WETH9
    address public immutable acrossSpokePool; // the only address allowed to call handleV3AcrossMessage

    error BadRecipient();
    error NothingToZap();
    error RefundFailed();
    error NotSpokePool();
    error NotWeth();
    error Reentrant();

    event Zapped(address indexed recipient, address indexed coin, uint256 ethIn, uint256 coinsOut);
    event Refunded(address indexed recipient, address indexed coin, uint256 ethBack);

    uint256 private _lock = 1;
    modifier nonReentrant() {
        if (_lock != 1) revert Reentrant();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address _router, address _weth, address _acrossSpokePool) {
        router = _router;
        weth = _weth;
        acrossSpokePool = _acrossSpokePool;
    }

    // Accept ETH: from WETH.withdraw (unwrap) and from PadRouter's over-ceiling refund.
    receive() external payable {}

    // ── Generic entrypoint ────────────────────────────────────────────────────
    // For rails that deliver NATIVE ETH and let us call an arbitrary contract with a
    // value + calldata (LI.FI Executor contractCalls, Relay Call Execution, deBridge
    // evm_transaction_call). The rail sends msg.value; we buy `coin` and forward it.
    function zap(address coin, uint256 minOut, address recipient) external payable nonReentrant {
        _zap(coin, minOut, recipient, msg.value);
    }

    // ── Across entrypoint ───────────────────────────────────────────────────────
    // Across delivers the output token to THIS contract, then the SpokePool calls this
    // with the message we set at origin. Output token is WETH (or native ETH); message
    // is abi.encode(coin, minOut, recipient). Only the SpokePool may call it.
    function handleV3AcrossMessage(address tokenSent, uint256 amount, address, bytes calldata message)
        external
        nonReentrant
    {
        if (msg.sender != acrossSpokePool) revert NotSpokePool();
        // We configure Across to deliver WETH, so require it: guarantees the contract actually holds
        // `amount` after the unwrap (no underflow in _zap's residue math) and blocks any path where a
        // stray token would make buy{value:amount} spend RESIDENT ETH.
        if (tokenSent != weth) revert NotWeth();
        (address coin, uint256 minOut, address recipient) = abi.decode(message, (address, uint256, address));
        IWETH9(weth).withdraw(amount); // WETH → native ETH so we can buy with msg.value
        _zap(coin, minOut, recipient, amount);
    }

    // ── Core: buy `coin` with `ethAmount`, forward to `recipient`, refund leftover ────
    // Moves ONLY funds attributable to this call. Anything already resident (donations, leftovers,
    // an async rail pre-delivering) is snapshotted as `residue` and never paid out, so a permissionless
    // zap can't sweep it to an attacker's recipient. On a buy revert, the input is refunded.
    function _zap(address coin, uint256 minOut, address recipient, uint256 ethAmount) internal {
        if (recipient == address(0)) revert BadRecipient();
        if (ethAmount == 0) revert NothingToZap();
        uint256 ethResidue = address(this).balance - ethAmount;      // pre-existing ETH, not ours to move
        uint256 coinResidue = IERC20Min(coin).balanceOf(address(this)); // pre-existing coin, not ours

        try IPadRouter(router).buy{value: ethAmount}(coin, minOut) returns (uint256) {
            uint256 got = IERC20Min(coin).balanceOf(address(this)) - coinResidue; // this call's coins only
            if (got > 0) {
                bool sent = IERC20Min(coin).transfer(recipient, got);
                if (!sent) revert RefundFailed();
            }
            // Refund only THIS call's leftover ETH (PadRouter refunds past the graduation ceiling).
            // Best-effort so undeliverable dust can't undo an otherwise-successful buy - but if the
            // recipient can't take native ETH (e.g. a contract with no receive), deliver it as WETH
            // instead of stranding it here forever (ERC20 transfer never runs recipient code).
            uint256 back = address(this).balance - ethResidue;
            if (back > 0) {
                (bool ok, ) = recipient.call{value: back}("");
                if (!ok) { IWETH9(weth).deposit{value: back}(); IWETH9(weth).transfer(recipient, back); }
            }
            emit Zapped(recipient, coin, ethAmount, got);
        } catch {
            // Buy failed — return exactly this call's input (never any resident funds).
            uint256 refundable = address(this).balance - ethResidue;
            _send(recipient, refundable);
            emit Refunded(recipient, coin, refundable);
        }
    }

    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert RefundFailed();
    }
}
