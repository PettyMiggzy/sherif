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
  const { connector, address } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  return useCallback(async () => {
    if (!connector) throw new Error('Connect a wallet first.');
    await assertWalletCanSign(connector, address);
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
  }, [connector, address, switchChainAsync]);
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * The account this site sends from has to be one the wallet will sign for.
 * If the wallet was switched to another account, locked, or lost that account
 * (a hardware or removed account), MetaMask fails the send with "KeyringController -
 * Keyring not found". Asked here first, the answer is a plain instruction instead.
 */
async function assertWalletCanSign(connector: NonNullable<ReturnType<typeof useAccount>['connector']>, address: string | undefined) {
  let accounts: string[] = [];
  try {
    const provider = (await connector.getProvider()) as { request(args: { method: string }): Promise<unknown> } | undefined;
    accounts = ((await provider?.request({ method: 'eth_accounts' })) as string[] | undefined) ?? [];
  } catch {
    return; // a wallet that can't answer this is left to the send itself
  }
  if (!accounts.length) throw new Error('Your wallet is locked or no longer connected to this site. Unlock it (or connect again) and try once more.');
  if (address && !accounts.some((a) => a.toLowerCase() === address.toLowerCase())) {
    throw new Error(`Your wallet is on ${short(accounts[0])}, but this site is connected as ${short(address)}. Switch your wallet to ${short(address)}, or disconnect here and connect again.`);
  }
}
