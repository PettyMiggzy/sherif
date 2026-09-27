import { CONFIG, generationOf } from './config';

// How a launch's money is shared, per deployment (see CONFIG.feeDesk):
//   with a fee desk: tax 80% creator / 20% platform; every LP fee to the
//     platform (USDG side to the treasury, token side sold at 10% off by the desk).
//   without (the 2026-09-26 portal): tax and USDG LP fees 90% creator /
//     10% platform; token-side LP fees burned.
export type FeeModel = { creatorPct: number; platformPct: number; lpToPlatform: boolean; deskDiscountPct: number };

export function feeModel(portal?: string): FeeModel {
  const hasDesk = !!generationOf(portal).feeDesk;
  return hasDesk
    ? { creatorPct: 80, platformPct: 20, lpToPlatform: true, deskDiscountPct: 10 }
    : { creatorPct: 90, platformPct: 10, lpToPlatform: false, deskDiscountPct: 0 };
}

/** New launches (on CONFIG.portal). */
export const FEES = feeModel(CONFIG.portal);
