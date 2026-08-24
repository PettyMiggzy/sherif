/*
 * DefiLlama fees adapter — Robin Labs (robinlab.io), a launchpad on Robinhood Chain.
 *
 * Submit to: https://github.com/DefiLlama/dimension-adapters
 *   path: fees/robin-labs/index.ts
 *   test: npm test fees robin-labs
 *   PR must have "Allow edits by maintainers" ticked.
 *
 * WHERE THE NUMBERS COME FROM
 * Every trade routed through PadRouter emits one FeeSplit with the fee already broken into its destinations,
 * so nothing here has to re-derive a split or guess at a rate — it reads the exact wei that moved:
 *
 *   FeeSplit(token, platform, deferred, platformCut, dev, floor, burn)
 *
 *   platform    immediate protocol cut
 *   deferred    protocol cut held until that coin graduates, then released
 *   platformCut protocol buy-back cut (only on above-default fee tiers)
 *   dev         the coin creator's share
 *   floor       into that coin's permanent, non-withdrawable buy wall
 *   burn        auto-burn share
 *
 * Fees        = every field (the whole fee the trader paid)
 * Revenue     = platform + deferred + platformCut   (what the protocol keeps)
 * SupplySide  = dev + floor + burn                  (creator + the coin's own floor + burn)
 *
 * `floor` is counted as supply-side rather than revenue on purpose: it is minted into a permanent liquidity
 * position the protocol cannot withdraw from, so it is value handed to the coin, not retained by us.
 *
 * All amounts are native ETH (Robinhood Chain's gas token), collected as WETH by the router.
 */
import { SimpleAdapter, FetchOptions } from "../../adapters/types";
import { CHAIN } from "../../helpers/chains";

// Robinhood Chain (chainId 4663)
const PAD_ROUTER = "0xA6BaAB820809C7fC8350311776627298f91F07eC";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

const FEE_SPLIT_EVENT =
  "event FeeSplit(address indexed token, uint256 platform, uint256 deferred, uint256 platformCut, uint256 dev, uint256 floor, uint256 burn)";

const fetch = async (options: FetchOptions) => {
  const dailyFees = options.createBalances();
  const dailyRevenue = options.createBalances();
  const dailySupplySideRevenue = options.createBalances();

  const logs = await options.getLogs({
    target: PAD_ROUTER,
    eventAbi: FEE_SPLIT_EVENT,
  });

  for (const log of logs) {
    const platform = log.platform + log.deferred + log.platformCut;
    const supplySide = log.dev + log.floor + log.burn;

    dailyRevenue.add(WETH, platform, "Protocol fee");
    dailySupplySideRevenue.add(WETH, log.dev, "Creator share");
    dailySupplySideRevenue.add(WETH, log.floor, "Coin floor");
    dailySupplySideRevenue.add(WETH, log.burn, "Auto-burn");
    dailyFees.add(WETH, platform + supplySide, "Trading fee");
  }

  return { dailyFees, dailyRevenue, dailySupplySideRevenue };
};

const methodology = {
  Fees: "Every trade through the Robin Labs swap desk pays a per-coin fee of 1%-4% per side, set by that coin's creator at launch and immutable afterwards.",
  Revenue: "The protocol's retained share of each trading fee, including the portion deferred until a coin graduates and the buy-back cut taken on above-default fee tiers.",
  SupplySideRevenue: "The creator's share, the share minted into that coin's permanent non-withdrawable buy wall, and the auto-burn share.",
};

const breakdownMethodology = {
  Fees: { "Trading fee": "The full per-side fee paid by the trader." },
  Revenue: { "Protocol fee": "Immediate protocol cut, plus the graduation-deferred cut and the buy-back cut." },
  SupplySideRevenue: {
    "Creator share": "Paid to the coin's creator, claimable from escrow.",
    "Coin floor": "Minted into that coin's permanent buy wall; the protocol has no withdraw path to it.",
    "Auto-burn": "Used to buy and burn that coin's own supply.",
  },
};

const adapter: SimpleAdapter = {
  version: 2,
  pullHourly: true,
  fetch,
  chains: [CHAIN.ROBINHOOD],
  start: "2026-07-24",
  methodology,
  breakdownMethodology,
};

export default adapter;
