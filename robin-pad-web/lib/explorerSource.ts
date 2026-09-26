'use client';
import { CONFIG } from './config';

// The explorer (Blockscout) only shows a contract's verified source after someone asks
// it for that contract: the first request makes it look the code up in the
// shared verified-code database (Sourcify's). Token scanners such as Quick
// Intel read the source from the explorer, and flag a token whose source it
// doesn't have yet. Every launch token has the same code as one already
// verified, so one request per token is enough. Visitors' browsers send it
// for every token the site shows (the launch itself, token pages, the home
// and explore lists), once per visit, so new launches get verified on their
// own. (The explorer's API turns servers away, so this can't run from ours.)
const STORAGE_KEY = 'explorer-asked';
const asked = new Set<string>();

function remembered(): string[] {
  try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]') as string[]; } catch { return []; }
}

export function askExplorerForSources(addresses: string[]) {
  if (!CONFIG.explorerUrl || typeof window === 'undefined') return;
  const done = new Set([...remembered(), ...asked]);
  for (const address of addresses) {
    const a = address.toLowerCase();
    if (done.has(a)) continue;
    done.add(a);
    asked.add(a);
    fetch(`${CONFIG.explorerUrl}/api/v2/smart-contracts/${a}`, { mode: 'no-cors', cache: 'no-store' }).catch(() => {});
  }
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...done].slice(-500))); } catch { /* private mode */ }
}

export const askExplorerForSource = (address: string) => askExplorerForSources([address]);
