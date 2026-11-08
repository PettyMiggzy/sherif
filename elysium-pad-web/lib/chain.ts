import { defineChain } from 'viem';
import { CONFIG } from './config';

export const padChain = defineChain({
  id: CONFIG.chainId,
  name: CONFIG.chainName,
  nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  rpcUrls: { default: { http: [CONFIG.rpcUrl] } },
  blockExplorers: CONFIG.explorerUrl ? { default: { name: 'Elysium Explorer', url: CONFIG.explorerUrl } } : undefined,
});
