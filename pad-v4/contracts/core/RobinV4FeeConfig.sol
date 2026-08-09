// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title RobinV4FeeConfig — governed DEFAULT launch parameters for the V4 curve pad suite.
/// @notice The `CurvePadFactoryV4` reads these at each launch and STAMPS them IMMUTABLY onto the new pad's
/// hook config. So changing a value here only affects FUTURE launches — every already-launched pad keeps the
/// exact fee it was born with (the trust guarantee: a coin's tax can never be raised after the fact). This is
/// the single authority that lets us retune pad economics/curve geometry WITHOUT ever redeploying the factory.
///
/// Hard caps below bound what any future launch can carry, so even a compromised/fat-fingered owner cannot
/// push a new pad's tax past the ceiling. Live pads are immutable regardless of this contract's state, so
/// there is no timelock: a defaults change is forward-only and can never touch an existing coin.
contract RobinV4FeeConfig is Ownable2Step {
    uint16 public constant BPS = 10000;
    uint16 public constant MAX_TAX_BPS = 200; // ≤2% per side on any future launch
    uint16 public constant MAX_FLOOR_SHARE_BPS = 5000; // ≤50% of the sell tax may go to the floor
    uint256 public constant MAX_GRAD_REWARD = 2 ether; // per-side graduation reward ceiling
    uint24 public constant MAX_LP_FEE = 1_000_000; // Uniswap's LPFeeLibrary max (100%); a static fee above it bricks initialize
    uint24 internal constant DYNAMIC_FEE_FLAG = 0x800000;

    struct Defaults {
        uint16 buyTaxBps; // hook: buy trade tax → platform
        uint16 sellTaxBps; // hook: sell trade tax → creator + floor
        uint16 sellFloorShareBps; // share of the SELL tax carved to the floor (rest → creator)
        uint16 buyLpFloorShareBps; // share of the BUY LP fee held in the curve → swept to the floor at grad (v2)
        uint24 lpFee; // static pool LP fee tier (must NOT carry the dynamic-fee flag)
        int24 startTickMag; // curve start-price magnitude (sign set by token/quote ordering at launch)
        int24 curveWidth; // tick span from start to the graduation CEILING
        int24 minGradWidth; // informational min-grad marker (< curveWidth)
        uint256 gradRewardWei; // per-side ETH reward paid to platform + creator at graduation (capped raise/4)
    }

    Defaults private _d;

    event DefaultsUpdated(
        uint16 buyTaxBps,
        uint16 sellTaxBps,
        uint16 sellFloorShareBps,
        uint16 buyLpFloorShareBps,
        uint24 lpFee,
        int24 startTickMag,
        int24 curveWidth,
        int24 minGradWidth,
        uint256 gradRewardWei
    );

    error BadParam();

    constructor(address owner_, Defaults memory d0) Ownable(owner_) {
        _validate(d0);
        _d = d0;
        _emit(d0);
    }

    /// @notice The current default launch parameters. The factory reads this at each launch.
    function defaults() external view returns (Defaults memory) {
        return _d;
    }

    /// @notice Retune the defaults for FUTURE launches. Bounded by the hard caps; live pads are unaffected.
    function setDefaults(Defaults calldata d) external onlyOwner {
        _validate(d);
        _d = d;
        _emit(d);
    }

    function _validate(Defaults memory d) internal pure {
        if (d.buyTaxBps > MAX_TAX_BPS || d.sellTaxBps > MAX_TAX_BPS) revert BadParam();
        // [AUDIT] the hook rejects a zero/zero tax (RobinFeeHook.registerPool → BadTax), so a 0/0 default would
        // brick EVERY future launch; require at least one side to carry a tax.
        if (d.buyTaxBps == 0 && d.sellTaxBps == 0) revert BadParam();
        if (d.sellFloorShareBps > MAX_FLOOR_SHARE_BPS) revert BadParam();
        if (d.buyLpFloorShareBps > BPS) revert BadParam();
        if (d.gradRewardWei > MAX_GRAD_REWARD) revert BadParam();
        // [AUDIT] static fee only AND ≤ Uniswap's MAX_LP_FEE — an over-max static fee reverts poolManager.initialize
        // (surfacing as a misleading PoolAlreadyInit) and bricks the launch.
        if (d.lpFee & DYNAMIC_FEE_FLAG != 0 || d.lpFee > MAX_LP_FEE) revert BadParam();
        if (d.startTickMag <= 0 || d.curveWidth <= 0) revert BadParam();
        if (d.minGradWidth <= 0 || d.minGradWidth >= d.curveWidth) revert BadParam();
        // Exact tick-spacing alignment (startTick/curveWidth % tickSpacing) is enforced by the factory/pool at
        // launch; here we only bound magnitudes and ordering so a bad default can't slip past the caps.
    }

    function _emit(Defaults memory d) internal {
        emit DefaultsUpdated(
            d.buyTaxBps,
            d.sellTaxBps,
            d.sellFloorShareBps,
            d.buyLpFloorShareBps,
            d.lpFee,
            d.startTickMag,
            d.curveWidth,
            d.minGradWidth,
            d.gradRewardWei
        );
    }

    /// @notice Renounce disabled — the config must always have an owner able to retune future-launch defaults.
    /// Renouncing would freeze the defaults forever (existing pads stay immutable either way).
    function renounceOwnership() public pure override {
        revert("disabled");
    }
}
