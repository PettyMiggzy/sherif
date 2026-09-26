import { custom, http, type Transport } from 'viem';
import { CONFIG } from './config';

// Robinhood Chain's public RPC first. When it fails (down, rate-limited), a backup: on the server straight to
// RPC_FALLBACK_URL (a server-only env var holding a paid provider's URL, key included, so it
// never reaches a browser), and in the browser through this site's /api/rpc, which relays read
// calls to that same backup. The browser only uses the relay when the deploy says one is set up
// (NEXT_PUBLIC_RPC_FALLBACK=1 alongside RPC_FALLBACK_URL); otherwise /api/rpc would only ever answer 503.
export function chainTransport({ batch = false }: { batch?: boolean } = {}): Transport {
  const primary = http(CONFIG.rpcUrl, { batch });
  const backupUrl = typeof window === 'undefined'
    ? process.env.RPC_FALLBACK_URL
    : process.env.NEXT_PUBLIC_RPC_FALLBACK === '1' ? `${window.location.origin}/api/rpc` : undefined;
  if (!backupUrl) return primary;
  return revertAwareFallback(primary, http(backupUrl, { batch: batch ? { batchSize: 50 } : false }));
}

/**
 * A revert is the chain's answer, not an RPC failure. viem's own `fallback`
 * retries every error on the next transport (only a wallet rejection stops
 * it), so a reverting eth_call (every swap quote is one: see lib/swap.ts) was
 * re-sent to the backup, and whatever the backup said replaced the real
 * revert data. Here a revert goes straight back to the caller and only
 * transport failures (down, rate-limited, 5xx) move on to the backup.
 */
function revertAwareFallback(primary: Transport, backup: Transport): Transport {
  return (opts) => {
    const inner = { ...opts, retryCount: 0 };
    const p = primary(inner), b = backup(inner);
    return custom({
      async request({ method, params }) {
        try {
          return await p.request({ method, params } as never);
        } catch (e) {
          if (isRevert(e)) throw e;
          // If the backup fails too, the primary's error is the one worth
          // showing: the backup's (say, a 503 from an unconfigured relay)
          // says nothing about the call itself.
          try { return await b.request({ method, params } as never); } catch { throw e; }
        }
      },
    }, { key: 'fallback', name: 'Fallback' })(opts);
  };
}

function isRevert(e: unknown): boolean {
  for (let x = e as { code?: unknown; data?: unknown; details?: string; message?: string; cause?: unknown } | undefined, i = 0; x && i < 6; x = x.cause as typeof x, i++) {
    if (x.code === 3 || /execution reverted|revert/i.test(x.details ?? '') || (typeof x.data === 'string' && x.data.startsWith('0x') && x.data.length > 2)) return true;
  }
  return false;
}
