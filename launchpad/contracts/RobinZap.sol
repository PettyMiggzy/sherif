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
    function withdraw(uint256) external;
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
        (address coin, uint256 minOut, address recipient) = abi.decode(message, (address, uint256, address));
        uint256 ethAmount = amount;
        // If Across delivered WETH, unwrap it to native ETH so we can buy with msg.value.
        if (tokenSent == weth) {
            IWETH9(weth).withdraw(amount);
        }
        _zap(coin, minOut, recipient, ethAmount);
    }

    // ── Core: buy `coin` with `ethAmount`, forward to `recipient`, refund dust ────
    // On a buy revert (e.g. slippage), refund the ETH to the recipient — never strand it.
    function _zap(address coin, uint256 minOut, address recipient, uint256 ethAmount) internal {
        if (recipient == address(0)) revert BadRecipient();
        if (ethAmount == 0) revert NothingToZap();

        try IPadRouter(router).buy{value: ethAmount}(coin, minOut) returns (uint256) {
            uint256 got = IERC20Min(coin).balanceOf(address(this));
            if (got > 0) IERC20Min(coin).transfer(recipient, got);
            // Refund any leftover ETH (PadRouter refunds anything past the graduation ceiling).
            uint256 dust = address(this).balance;
            if (dust > 0) _send(recipient, dust);
            emit Zapped(recipient, coin, ethAmount, got);
        } catch {
            // Buy failed — return the full input to the user rather than lock it here.
            _send(recipient, address(this).balance);
            emit Refunded(recipient, coin, ethAmount);
        }
    }

    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert RefundFailed();
    }
}
