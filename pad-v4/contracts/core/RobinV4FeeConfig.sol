// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title RobinV4FeeConfig — governed DEFAULT launch parameters for the V4 curve pad suite.
/// @notice The `CurvePadFactoryV4` reads these at each launch and STAMPS them IMMUTABLY onto the new pad's
/// hook config. So changing a value here only affects FUTURE launches — every already-launched pad keeps the
/// exact fee it was born with (the trust guarantee: a coin's tax can never be raised after the fact). This is
/// the single authority that lets us retune pad economics/curve geometry WITHOUT ever redeploying the factory.
///
/// Hard caps below bound the HOOK taxes any future launch can carry, so even a compromised/fat-fingered owner
/// cannot push a new pad's buy/sell tax past the ceiling. TWO caveats the operator must hold (see M-10, M-12):
///   • [M-10] `lpFee` is a SECOND take on top of the buy/sell taxes (on a Robin pad it routes mostly to
///     protocol-owned positions), now bounded by the Robin `MAX_LP_FEE` = 1% policy cap. `setDefaults` remains a
///     real un-timelocked economic knob within that cap — hold this owner key with the same care as the fee wallet.
///   • [M-12] "forward-only, can never touch an existing coin" holds for a LAUNCHED pad (its fee is stamped
///     immutably at launch). An OPEN PRESALE no longer silently reprices on a retune: PresaleVault snapshots the
///     geometry at initialize and finalize() REVERTS `GeometryChanged` if the live defaults have moved — the raise
///     fails safely (100% refunds) instead of launching at a geometry its contributors never agreed to.
/// Govern this owner as a live capability (multisig, ideally a timelock), not a set-and-forget default source.
contract RobinV4FeeConfig is Ownable2Step {
    uint16 public constant BPS = 10000;
    uint16 public constant MAX_TAX_BPS = 200; // ≤2% per side on any future launch
    uint16 public constant MAX_FLOOR_SHARE_BPS = 5000; // ≤50% of the sell tax may go to the floor
    uint16 public constant MAX_BUFFER_SHARE_BPS = 5000; // ≤50% of the buy tax may be diverted to the curve buffer
    uint16 public constant MAX_REFERRAL_SHARE_BPS = 5000; // ≤50% of the PLATFORM buy cut may be paid to a referrer
    uint16 public constant MAX_GRAD_SHARE_BPS = 2500; // ≤25% of the raise to any single non-LP grad bucket
    // [M-10] Robin policy cap on the static LP fee: 1% (10_000 pips). Below Uniswap's structural 100% (1_000_000),
    // so it also subsumes the "static fee above the Uniswap max bricks initialize" concern. Production lpFee is
    // exactly 10_000, so it passes at the boundary (`>` not `>=`); a launch can never carry an lpFee above 1%.
    uint24 public constant MAX_LP_FEE = 10_000;
    // [FDV] A constant rail above the owner-tunable valuation band — the same shape as MAX_LP_FEE. This is a
    // FAT-FINGER GUARD, not a policy: at ~10,000x the shipped 100 ETH ceiling it never binds a real retune, it
    // only stops `maxFdvWei` being set to something like type(uint128).max, which would silently disable the
    // upper half of the band. Deliberately loose, because the band is denominated in WEI on a chain with no USD
    // oracle: the operator must stay free to move it a long way as ETH moves, in either direction.
    uint128 public constant HARD_MAX_FDV_WEI = 1_000_000 ether;
    uint24 internal constant DYNAMIC_FEE_FLAG = 0x800000;

    /// @dev v3-economics model: graduation rewards are a PERCENTAGE of the raise (so they scale with any MC),
    /// and a slice of the BUY tax is held in the curve as an idle ETH balance through the curve phase, then swept
    /// to the PLATFORM at graduation ([L-5] it is a deferred platform reward — NOT LP depth, and it gives no price
    /// support while held). All bps are immutable per-pad once stamped at launch.
    struct Defaults {
        uint16 buyTaxBps; // hook: buy trade tax (→ platform + curve buffer, split by buyBufferShareBps)
        uint16 sellTaxBps; // hook: sell trade tax → creator + floor
        uint16 sellFloorShareBps; // share of the SELL tax carved to the floor (rest → creator)
        uint16 buyLpFloorShareBps; // share of the BUY LP fee held in the curve → swept to the floor at grad
        uint16 buyBufferShareBps; // [L-5] share of BUY tax parked in the curve as ETH, swept to platform at grad; rest → platform at accrual (both end at platform)
        uint16 referralShareBps; // share of the PLATFORM buy cut paid to a referrer (from swap hookData); rest → platform
        uint16 platformGradBps; // platform share of the raise at graduation
        uint16 creatorGradBps; // creator share of the raise at graduation
        uint16 ambushGradBps; // ambush-vault share of the raise (active two-sided floor support); LP = the remainder
        uint24 lpFee; // static pool LP fee tier (must NOT carry the dynamic-fee flag)
        int24 startTickMag; // curve start-price magnitude (sign set by token/quote ordering at launch)
        int24 curveWidth; // tick span from start to the graduation CEILING
        int24 minGradWidth; // informational min-grad marker (< curveWidth)
        // [FDV] Creator-chosen valuation band. A creator picks SUPPLY and START PRICE freely; what is bounded is
        // the product of the two — the implied fully-diluted value at launch. Bounding FDV instead of supply is
        // what makes supply cosmetic: 10k tokens or 10bn tokens can both launch, because only the valuation has
        // to be sane. Denominated in WEI, not USD, because this chain has no USD oracle — so these are re-tuned
        // by the owner as ETH moves, and a client must READ them rather than assume a constant.
        uint128 minFdvWei;
        uint128 maxFdvWei;
    }

    Defaults private _d;

    event DefaultsUpdated(
        uint16 buyTaxBps,
        uint16 sellTaxBps,
        uint16 sellFloorShareBps,
        uint16 buyLpFloorShareBps,
        uint16 buyBufferShareBps,
        uint16 referralShareBps,
        uint16 platformGradBps,
        uint16 creatorGradBps,
        uint16 ambushGradBps,
        uint24 lpFee,
        int24 startTickMag,
        int24 curveWidth,
        int24 minGradWidth
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
        // ≤50% of the buy tax may divert to the buffer — a retune can never starve platform buy revenue to zero.
        if (d.buyBufferShareBps > MAX_BUFFER_SHARE_BPS) revert BadParam();
        // ≤50% of the platform's buy cut may be paid to a referrer — the platform can never be zeroed on buys.
        if (d.referralShareBps > MAX_REFERRAL_SHARE_BPS) revert BadParam();
        // graduation shares are a % of the raise; each ≤25%, and the three non-LP buckets must leave a POSITIVE
        // LP remainder (LP = BPS - platform - creator - ambush), so the locked liquidity can never be starved.
        if (d.platformGradBps > MAX_GRAD_SHARE_BPS || d.creatorGradBps > MAX_GRAD_SHARE_BPS || d.ambushGradBps > MAX_GRAD_SHARE_BPS) {
            revert BadParam();
        }
        if (uint256(d.platformGradBps) + d.creatorGradBps + d.ambushGradBps >= BPS) revert BadParam();
        // [AUDIT/M-10] static fee only AND ≤ the Robin MAX_LP_FEE (1%). An over-max static fee would both exceed
        // policy and (above Uniswap's 100%) revert poolManager.initialize; the 1% cap forecloses both.
        if (d.lpFee & DYNAMIC_FEE_FLAG != 0 || d.lpFee > MAX_LP_FEE) revert BadParam();
        if (d.startTickMag <= 0 || d.curveWidth <= 0) revert BadParam();
        if (d.minGradWidth <= 0 || d.minGradWidth >= d.curveWidth) revert BadParam();
        // [FDV] A zero floor would let a creator launch at a dust valuation where the raise truncates toward 0;
        // an inverted band would reject every launch and brick the pad. Both are owner fat-fingers, so fail loud.
        if (d.minFdvWei == 0 || d.maxFdvWei < d.minFdvWei || d.maxFdvWei > HARD_MAX_FDV_WEI) revert BadParam();
        // Exact tick-spacing alignment (startTick/curveWidth % tickSpacing) is enforced by the factory/pool at
        // launch; here we only bound magnitudes and ordering so a bad default can't slip past the caps.
    }

    function _emit(Defaults memory d) internal {
        emit DefaultsUpdated(
            d.buyTaxBps,
            d.sellTaxBps,
            d.sellFloorShareBps,
            d.buyLpFloorShareBps,
            d.buyBufferShareBps,
            d.referralShareBps,
            d.platformGradBps,
            d.creatorGradBps,
            d.ambushGradBps,
            d.lpFee,
            d.startTickMag,
            d.curveWidth,
            d.minGradWidth
        );
    }

    /// @notice Renounce disabled — the config must always have an owner able to retune future-launch defaults.
    /// Renouncing would freeze the defaults forever (existing pads stay immutable either way).
    function renounceOwnership() public pure override {
        revert("disabled");
    }
}
