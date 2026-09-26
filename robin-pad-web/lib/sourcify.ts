import 'server-only';
import { CONFIG } from './config';
import stdJsonInput from './verify/robin-launch-token.std.json';

// Every launch token is the same contract (RobinLaunchToken: a plain ERC-20
// with no immutables), so every one has identical runtime bytecode, and this
// one compiler input (generated from usdg-pad with
// `forge verify-contract --show-standard-json-input`, then checked byte for
// byte against a token launched through the live portal) verifies them all.
//
// Verified source matters: token scanners (GoPlus, Quick Intel, DexScreener's
// audit panel) flag an unverified contract on its own. The site sends each new
// launch to Sourcify, and Blockscout (Robinhood Chain's explorer) shows
// Sourcify-verified source. lib/explorerSource.ts then nudges the explorer to
// look it up. Blockscout's own API turns servers away, Sourcify's doesn't.

const API = 'https://sourcify.dev/server';
const COMPILER = '0.8.26+commit.8a97fa7a';
const CONTRACT = 'src/RobinLaunchToken.sol:RobinLaunchToken';
const TIMEOUT_MS = 20_000;

// Per server instance: tokens already confirmed or submitted, so a warm
// instance asks Sourcify about each token at most once.
const handled = new Set<string>();

export type VerifyResult = 'verified' | 'submitted' | 'skipped' | 'failed';

/** Off on a local fork (addresses there don't exist on the real chain) or when SOURCIFY_VERIFY=0. */
export function verificationEnabled(): boolean {
  if (process.env.SOURCIFY_VERIFY === '0') return false;
  return !/\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)[:/]/.test(CONFIG.rpcUrl);
}

export async function isVerifiedOnSourcify(address: string): Promise<boolean> {
  const r = await fetch(`${API}/v2/contract/${CONFIG.chainId}/${address}`, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) return false;
  const body = (await r.json()) as { match?: string | null };
  return !!body.match;
}

/**
 * Makes sure a launch token's source is verified on Sourcify. Only call it
 * for addresses the portal actually launched (see lib/launches.ts and
 * /api/verify/[token]); it never throws.
 */
export async function verifyLaunchToken(address: string, opts: { waitMs?: number } = {}): Promise<VerifyResult> {
  const key = address.toLowerCase();
  if (!verificationEnabled()) return 'skipped';
  if (handled.has(key)) return 'verified';
  try {
    if (await isVerifiedOnSourcify(address)) {
      handled.add(key);
      return 'verified';
    }
    const r = await fetch(`${API}/v2/verify/${CONFIG.chainId}/${address}`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stdJsonInput, compilerVersion: COMPILER, contractIdentifier: CONTRACT }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // 202: queued (Sourcify compiles and compares in the background).
    // 409: someone verified it first.
    if (r.status === 409) {
      handled.add(key);
      return 'verified';
    }
    if (r.status === 202) {
      handled.add(key);
      const { verificationId } = (await r.json()) as { verificationId?: string };
      if (!opts.waitMs || !verificationId) return 'submitted';
      return await waitForJob(verificationId, opts.waitMs);
    }
    console.error(`sourcify: ${address} -> HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
    return 'failed';
  } catch (e) {
    console.error(`sourcify: ${address} ->`, (e as Error)?.message ?? e);
    return 'failed';
  }
}

/** Polls a Sourcify job until it finishes or `waitMs` runs out. */
async function waitForJob(id: string, waitMs: number): Promise<VerifyResult> {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2_500));
    try {
      const r = await fetch(`${API}/v2/verify/${id}`, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!r.ok) continue;
      const job = (await r.json()) as { isJobCompleted?: boolean; contract?: { match?: string | null }; error?: { customCode?: string } };
      if (!job.isJobCompleted) continue;
      if (job.contract?.match) return 'verified';
      console.error(`sourcify: job ${id} finished without a match (${job.error?.customCode ?? 'unknown'})`);
      return 'failed';
    } catch { /* retry until the deadline */ }
  }
  return 'submitted';
}
