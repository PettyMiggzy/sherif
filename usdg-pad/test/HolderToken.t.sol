// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "@uniswap/v4-core/lib/solmate/src/test/utils/mocks/MockERC20.sol";
import {TrollHolderToken} from "../src/TrollHolderToken.sol";

/// @dev Stands in for the splitter: holds the holders' slot and pays it to
/// the token on claimRecipient, like PadRevenueSplitter does.
contract MockHolderSlot {
    MockERC20 public usdc;
    address public token;
    uint256 public owed;
    bool public broken;

    constructor(MockERC20 usdc_) {
        usdc = usdc_;
    }

    function setToken(address token_) external {
        token = token_;
    }

    function credit(uint256 amount) external {
        usdc.mint(address(this), amount);
        owed += amount;
    }

    function breakIt() external {
        broken = true;
    }

    function claimRecipient(uint256) external returns (uint256 amount) {
        require(!broken, "splitter down");
        amount = owed;
        owed = 0;
        usdc.transfer(token, amount);
    }

    function recipientCredits() external view returns (uint256[] memory c) {
        c = new uint256[](1);
        c[0] = owed;
    }
}

/// @notice TrollHolderToken on its own: the dividend accounting under random
/// transfers, payouts and claims, and the overflow bound that keeps
/// transfers from ever reverting.
contract HolderTokenTest is Test {
    MockERC20 usdc;
    MockHolderSlot slot;
    TrollHolderToken token;
    address pool = makeAddr("poolManager");
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address[6] holders;

    uint256 constant SUPPLY = 1_000_000_000 ether;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        slot = new MockHolderSlot(usdc);
        token = new TrollHolderToken("H", "H", SUPPLY, address(this), address(usdc), pool, address(slot), 0);
        slot.setToken(address(token));
        for (uint256 i; i < holders.length; i++) {
            holders[i] = address(uint160(0xA11CE + i));
        }
        // Like a launch: the whole supply goes into "the pool".
        token.transfer(pool, SUPPLY);
    }

    function _nonExcludedSum() internal view returns (uint256 sum) {
        for (uint256 i; i < holders.length; i++) {
            sum += token.balanceOf(holders[i]);
        }
    }

    function _owedSum() internal view returns (uint256 sum) {
        for (uint256 i; i < holders.length; i++) {
            sum += token.dividendsOf(holders[i]);
        }
    }

    function test_ExcludedAddresses() public view {
        assertTrue(token.isExcluded(pool));
        assertTrue(token.isExcluded(DEAD));
        assertTrue(token.isExcluded(address(token)));
        assertTrue(token.isExcluded(address(slot)));
        assertTrue(token.isExcluded(address(this)), "the minter");
        assertFalse(token.isExcluded(holders[0]));
        assertEq(token.eligibleSupply(), 0);
    }

    function test_SplitterDownStillLetsHoldersClaimWhatIsHere() public {
        vm.prank(pool);
        token.transfer(holders[0], 10_000_000 ether);
        slot.credit(100e6);
        token.distribute();
        slot.credit(50e6);
        slot.breakIt();
        vm.prank(holders[0]);
        assertApproxEqAbs(token.claim(), 100e6, 1, "the pull failed quietly; what was here is still paid");
        assertEq(token.pendingDistribution(), 50e6);
    }

    /// @dev Worst case for the per-share figure: only the minimum outside the
    /// pool, and more USDC than exists (1e17 raw = $100B) shared into it,
    /// many times. Moving the whole supply afterwards must still work.
    function test_PerShareCanNeverOverflowTransfers() public {
        uint256 min = token.MIN_ELIGIBLE_SUPPLY();
        vm.prank(pool);
        token.transfer(holders[0], min);
        for (uint256 i; i < 50; i++) {
            slot.credit(1e17);
            assertEq(token.distribute(), 1e17);
        }
        // Everything moves: pool -> holder -> holder -> dead -> nothing reverts.
        vm.prank(pool);
        token.transfer(holders[1], SUPPLY - min);
        vm.prank(holders[1]);
        token.transfer(holders[2], SUPPLY - min);
        vm.prank(holders[0]);
        token.transfer(holders[2], min);
        vm.prank(holders[2]);
        token.transfer(DEAD, SUPPLY);
        assertEq(token.eligibleSupply(), 0);
        vm.prank(holders[0]);
        assertApproxEqAbs(token.claim(), 50 * 1e17, 50, "the only holder got all of it");
    }

    function test_BelowTheFloorNothingIsSharedAndNothingIsLost() public {
        uint256 min = token.MIN_ELIGIBLE_SUPPLY();
        vm.prank(pool);
        token.transfer(holders[0], min - 1);
        slot.credit(7e6);
        assertEq(token.distribute(), 0);
        assertEq(token.dividendsOf(holders[0]), 0);
        vm.prank(pool);
        token.transfer(holders[1], 1);
        assertEq(token.distribute(), 7e6, "shared once the floor is reached");
    }

    /// @dev Random transfers (holders, the pool, the dead address), payouts
    /// and claims. After every step: the eligible supply matches the
    /// holders' balances, and the token holds enough USDC for every claim.
    function testFuzz_AccountingNeverOverpays(uint256 seed) public {
        for (uint256 step; step < 60; step++) {
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            uint256 op = r % 6;
            address a = holders[(r >> 8) % holders.length];
            address b = holders[(r >> 16) % holders.length];
            if (op == 0) {
                // A buy: tokens out of the pool.
                uint256 amt = bound(r >> 32, 1, token.balanceOf(pool));
                vm.prank(pool);
                token.transfer(a, amt);
            } else if (op == 1) {
                // A sell: tokens back into the pool.
                uint256 bal = token.balanceOf(a);
                if (bal > 0) {
                    vm.prank(a);
                    token.transfer(pool, bound(r >> 32, 1, bal));
                }
            } else if (op == 2) {
                uint256 bal = token.balanceOf(a);
                vm.prank(a);
                token.transfer(b, bal == 0 ? 0 : bound(r >> 32, 1, bal));
            } else if (op == 3) {
                slot.credit(bound(r >> 32, 0, 1e12));
                token.distribute();
            } else if (op == 4) {
                if ((r >> 40) % 3 == 0) usdc.mint(address(token), bound(r >> 48, 1, 1e9)); // a direct top-up
                uint256 due = token.dividendsOf(a);
                uint256 before = usdc.balanceOf(a);
                vm.prank(a);
                uint256 paid = token.claim();
                assertGe(paid, due, "a claim pays at least what was showing");
                assertEq(usdc.balanceOf(a), before + paid);
            } else {
                uint256 bal = token.balanceOf(a);
                if (bal > 0) {
                    vm.prank(a);
                    token.transfer(DEAD, bound(r >> 32, 1, bal)); // a burn
                }
            }
            assertEq(token.eligibleSupply(), _nonExcludedSum(), "eligible supply = holders' balances");
            assertLe(_owedSum(), usdc.balanceOf(address(token)), "always enough USDC for every claim");
            assertEq(token.totalDistributed() - token.totalClaimed() <= usdc.balanceOf(address(token)), true);
        }
        // Everyone claims; only rounding dust may stay behind.
        for (uint256 i; i < holders.length; i++) {
            vm.prank(holders[i]);
            token.claim();
            assertEq(token.dividendsOf(holders[i]), 0);
        }
        uint256 left = usdc.balanceOf(address(token)) + slot.owed();
        uint256 undistributed = left - (token.totalDistributed() - token.totalClaimed());
        assertLe(token.totalDistributed() - token.totalClaimed(), holders.length + 60, "dust only");
        assertEq(undistributed, token.pendingDistribution(), "anything not shared yet is still waiting");
    }
}
