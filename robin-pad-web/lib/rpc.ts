import { custom, http, type Transport } from 'viem';
import { CONFIG } from './config';

// Robinhood Chain's public RPC first. When it fails (down, rate-limited, or a Cloudflare
// challenge, which it serves under load), a backup: on the server straight to the backup URL,
// and in the browser through this site's /api/rpc, which relays read calls to it. The backup is
// Robin Labs' own read proxy (api.robinlab.io/rpc, Alchemy behind it) unless RPC_FALLBACK_URL
// names another. NEXT_PUBLIC_RPC_FALLBACK=0 turns the browser relay off.
export const BACKUP_RPC_URL = process.env.RPC_FALLBACK_URL || 'https://api.robinlab.io/rpc';

// JSON-RPC answers must never come from a cache: Next.js's Data Cache stores
// server-side fetch() responses (POSTs included) unless told not to, which froze
// the chain tip and replayed old logs to the launch scan. Every RPC call here opts out.
const NO_STORE = { cache: 'no-store' } as const;

export function chainTransport({ batch = false }: { batch?: boolean } = {}): Transport {
  const primary = http(CONFIG.rpcUrl, { batch, fetchOptions: NO_STORE });
  if (/\/\/(localhost|127\.0\.0\.1)[:/]/.test(CONFIG.rpcUrl)) return primary; // a local fork: nothing to fall back to
  const backupUrl = typeof window === 'undefined'
    ? BACKUP_RPC_URL
    : process.env.NEXT_PUBLIC_RPC_FALLBACK === '0' ? undefined : `${window.location.origin}/api/rpc`;
  if (!backupUrl) return primary;
  return revertAwareFallback(primary, http(backupUrl, { batch: batch ? { batchSize: 50 } : false, fetchOptions: NO_STORE }));
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
