'use client';
import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAccount, useSwitchChain } from 'wagmi';
import { UserRejectedRequestError } from 'viem';
import { robinhood } from './chain';

// wagmi's own record of the connection can say Robinhood Chain while the wallet itself
// is on another network. That happens with phone wallets over WalletConnect
// when a switch never reached the app, and the next write then fails with
// "the current chain of the connector does not match". So before anything
// is signed, the wallet is asked which network it is really on.

const SWITCH_WAIT_MS = 60_000;

/** The network the connected wallet is actually on (not wagmi's record). */
export function useWalletChainId(): number | undefined {
  const { connector, isConnected } = useAccount();
  const q = useQuery({
    queryKey: ['wallet-chain', connector?.uid],
    enabled: isConnected && !!connector,
    refetchInterval: 5_000,
    queryFn: () => connector!.getChainId(),
  });
  return q.data;
}

/**
 * Resolves once the wallet is on Robinhood Chain: asks it to switch (adding it first if
 * it doesn't know the network), then checks again. Throws a plain-words
 * message if the wallet stays elsewhere.
 */
export function useEnsureChain() {
  const { connector } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  return useCallback(async () => {
    if (!connector) throw new Error('Connect a wallet first.');
    if ((await connector.getChainId()) === robinhood.id) return;
    try {
      // A phone wallet may never answer; the check below decides either way.
      await Promise.race([
        switchChainAsync({ connector, chainId: robinhood.id }),
        new Promise((resolve) => setTimeout(resolve, SWITCH_WAIT_MS)),
      ]);
    } catch (e) {
      if (e instanceof UserRejectedRequestError || /rejected|denied/i.test(String((e as Error)?.message))) {
        throw new Error(`Your wallet said no to switching to ${robinhood.name}. Switch it to ${robinhood.name} and try again.`);
      }
    }
    if ((await connector.getChainId()) !== robinhood.id) {
      throw new Error(`Your wallet is still on another network. Open your wallet, switch its network to ${robinhood.name}, then come back and try again.`);
    }
  }, [connector, switchChainAsync]);
}
