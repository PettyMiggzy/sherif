// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Boost source that burns every drop of gas it is handed, on the RIGHT selector
/// (`stakedLockedOf` — the pre-fix mock answered `stakedOf` and therefore never ran).
contract ZxBurnBoost {
    function stakedLockedOf(address) external view returns (uint256 n) {
        // view-safe gas sink: keccak over memory, unbounded
        while (true) {
            n = uint256(keccak256(abi.encode(n, gasleft())));
        }
    }
}

/// @dev Boost source that returns a huge blob. The callee pays memory expansion out of the
/// gas cap; the CALLER pays returndatacopy + its own memory expansion out of its own gas,
/// which the cap does not bound.
contract ZxBombBoost {
    uint256 public size;
    constructor(uint256 s) { size = s; }
    function stakedLockedOf(address) external view returns (uint256) {
        uint256 s = size;
        assembly {
            mstore(0x00, not(0)) // first word decodes to type(uint256).max => always over threshold
            mstore(s, 1)         // force memory expansion to s+32
            return(0, s)
        }
    }
}

/// @dev Boost source that returns MORE than 32 bytes of well-formed data.
contract ZxFatBoost {
    uint256 public v;
    constructor(uint256 v_) { v = v_; }
    function stakedLockedOf(address) external view returns (uint256) {
        uint256 x = v;
        assembly {
            mstore(0x00, x)
            mstore(0x20, 0xdeadbeef)
            mstore(0x40, 0xfeedface)
            return(0x00, 0x60)   // 96 bytes: value + 64 bytes of trailing junk
        }
    }
}

/// @dev Boost source that always reverts.
contract ZxRevertBoost {
    function stakedLockedOf(address) external pure returns (uint256) { revert("nope"); }
}

/// @dev Boost source that returns nothing at all.
contract ZxSilentBoost {
    fallback() external {}
}

/// @dev Stake token that calls back into the pool on every transfer (ERC777-ish hook),
/// aimed at the withdraw payout.
contract ZxHookStake is ERC20 {
    address public pool;
    bytes public payload;
    bool public armed;
    address public hookOn;
    bool public swallow;
    bool public lastOk;
    bytes public lastRet;

    constructor(uint256 s) ERC20("Zx Hook", "ZXH") { _mint(msg.sender, s); }
    function setPool(address p) external { pool = p; }
    function arm(address on, bytes calldata data, bool swallow_) external {
        hookOn = on; payload = data; armed = true; swallow = swallow_;
    }
    function disarm() external { armed = false; }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && to == hookOn && pool != address(0)) {
            (bool ok, bytes memory r) = pool.call(payload);
            lastOk = ok; lastRet = r;
            if (!swallow && !ok) {
                assembly { revert(add(r, 0x20), mload(r)) }
            }
        }
    }
}

/// @dev Stake token whose transfers can be frozen, and whose balance can be silently burned
/// out from under a holder (rebase-down / blocklist shapes).
contract ZxNastyStake is ERC20 {
    bool public frozen;
    mapping(address => bool) public blocked;
    constructor(uint256 s) ERC20("Zx Nasty", "ZXN") { _mint(msg.sender, s); }
    function setFrozen(bool f) external { frozen = f; }
    function setBlocked(address a, bool b) external { blocked[a] = b; }
    function burnFrom(address a, uint256 n) external { _burn(a, n); }
    function _update(address from, address to, uint256 value) internal override {
        require(!frozen, "ZXN: frozen");
        require(!blocked[from] && !blocked[to], "ZXN: blocked");
        super._update(from, to, value);
    }
}

/// @dev A staker that is a contract and refuses to be re-entered / rejects ETH.
contract ZxHolder {
    function call1(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory r) = target.call(data);
        if (!ok) { assembly { revert(add(r, 0x20), mload(r)) } }
        return r;
    }
    function approveTo(address token, address spender, uint256 n) external {
        (bool ok,) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, n));
        require(ok, "approve");
    }
    receive() external payable { revert("no eth"); }
}
