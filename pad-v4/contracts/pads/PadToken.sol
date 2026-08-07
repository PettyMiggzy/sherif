// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title PadToken
/// @notice The launched token. Fixed supply, minted once to the factory in the constructor,
/// then IMMUTABLE — no owner, no mint, no pause, no blocklist after construction. The whole
/// supply exists the instant it is deployed, so there is nothing an operator can do to it.
///
/// The factory CREATE2-mines the salt so this token's address sorts ABOVE the quote currency,
/// making the pad `currency1` in the V4 PoolKey (quote is `currency0`; native ETH is
/// address(0) and always sorts lowest). No logic here depends on that ordering — it is a
/// deployment-time constraint enforced by the factory's salt mining.
contract PadToken is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 supply, address mintTo)
        ERC20(name_, symbol_)
    {
        _decimals = decimals_;
        _mint(mintTo, supply);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}
