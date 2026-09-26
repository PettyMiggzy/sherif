import { defineChain } from 'viem';
import { CONFIG } from './config';

export const robinhood = defineChain({
  id: CONFIG.chainId,
  name: CONFIG.chainName,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [CONFIG.rpcUrl] } },
  blockExplorers: CONFIG.explorerUrl ? { default: { name: 'Blockscout', url: CONFIG.explorerUrl } } : undefined,
});
