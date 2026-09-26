// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Plain ERC-20 for a Troll Pad launch. No transfer tax, no admin
/// functions, no mint after construction. All trading tax lives in the
/// shared pool hook (see TrollHook) — never in the token itself, so a
/// wallet-to-wallet transfer always costs nothing and no one can rug the
/// token's own logic after deploy.
contract TrollLaunchToken is ERC20 {
    constructor(string memory name_, string memory symbol_, uint256 totalSupply_, address mintTo_)
        ERC20(name_, symbol_)
    {
        _mint(mintTo_, totalSupply_);
    }
}
