// GoPlus Security's free token scan (https://gopluslabs.io), as shown on
// token pages. Shared by the /api/goplus proxy and the panel.

/** [GoPlus field, what a pass means, the passing value ("0" unless given)]. */
export const GOPLUS_CHECKS: [field: string, label: string, pass?: string][] = [
  ['is_honeypot', 'Can be sold (not a honeypot)'],
  ['is_open_source', 'Source code verified', '1'],
  ['is_proxy', 'Not upgradeable'],
  ['is_mintable', 'No minting'],
  ['hidden_owner', 'No hidden owner'],
  ['can_take_back_ownership', "Ownership can't be taken back"],
  ['owner_change_balance', "Nobody can change balances"],
  ['selfdestruct', 'No self-destruct'],
  ['external_call', 'No risky external calls'],
  ['is_blacklisted', 'No blacklist'],
  ['transfer_pausable', "Transfers can't be paused"],
  ['cannot_sell_all', 'Can sell everything'],
  ['trading_cooldown', 'No trading cooldown'],
  ['personal_slippage_modifiable', 'No per-wallet tax changes'],
];

export const GOPLUS_FIELDS = [...GOPLUS_CHECKS.map(([f]) => f), 'buy_tax', 'sell_tax', 'holder_count'];

/** null when GoPlus hasn't scanned the token yet. */
export type GoPlusScan = Record<string, string> | null;

export type GoPlusSummary = {
  checks: { label: string; ok: boolean }[];
  flagged: number;
  honeypotFlag: boolean;
  buyTax?: number;
  sellTax?: number;
  holders?: number;
};

export function summarizeGoPlus(scan: Record<string, string>): GoPlusSummary {
  const checks: GoPlusSummary['checks'] = [];
  // GoPlus leaves out fields that don't apply to a contract, so only the
  // fields it actually returned are shown.
  for (const [field, label, pass = '0'] of GOPLUS_CHECKS) {
    const v = scan[field];
    if (v === undefined || v === '') continue;
    checks.push({ label, ok: v === pass });
  }
  const num = (v?: string) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v));
  return {
    checks,
    flagged: checks.filter((c) => !c.ok).length,
    honeypotFlag: scan.is_honeypot === '1',
    buyTax: num(scan.buy_tax),
    sellTax: num(scan.sell_tax),
    holders: num(scan.holder_count),
  };
}

export const goplusReportUrl = (chainId: number, token: string) => `https://gopluslabs.io/token-security/${chainId}/${token}`;
