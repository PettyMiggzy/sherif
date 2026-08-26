// ─────────────────────────────────────────────────────────────────────────────
// WalletConnect — connect a phone wallet from a normal desktop or mobile browser
//
// Before this, the pad could only talk to an INJECTED wallet (EIP-6963 / window.ethereum). That covers a
// desktop extension and it covers a phone only if the user is already inside their wallet app's own browser —
// which is why mobile falls back to a deep link that reopens the site in there (showMobileWalletPrompt in
// wallet.js). That fallback still exists and still works. This adds the other route: scan a QR (or tap through
// on mobile) and drive the site from the phone wallet, staying in the browser you started in.
//
// TWO THINGS TO KNOW ABOUT THE SHAPE OF THIS:
//
// 1. The library is ~2MB, so it is LAZY. Nothing here imports it at module scope —  does a
//    dynamic import the first time someone actually chooses WalletConnect. A user who never touches it never
//    downloads it, and the pad's normal page load is unchanged.
//
// 2. Chain 4663 is requested as OPTIONAL, not required. A required namespace the wallet has never heard of
//    makes the whole session proposal fail with nothing useful to show the user. Asking for it optionally lets
//    the session open either way, and then the pad's existing ensureChain() does the ordinary
//    wallet_switchEthereumChain / wallet_addEthereumChain dance — the same path an injected wallet takes.
//    Those two methods are declared optional here for exactly that reason; without them the wallet is allowed
//    to reject the switch request outright.
//
// The provider this returns is a plain EIP-1193 object, so everything downstream in wallet.js — ethers
// BrowserProvider, the accountsChanged/chainChanged listeners, ensureChain — treats it like any other wallet.
// ─────────────────────────────────────────────────────────────────────────────
import { CHAIN, WALLETCONNECT_PROJECT_ID } from "./config.js";

export const WC_RDNS = "walletconnect";

// Inline so the picker never fetches a remote image (and so it satisfies wallet.js's safeIcon, which rejects
// anything with quotes, spaces or angle brackets — hence base64 rather than raw SVG).
const WC_ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iOCIgZmlsbD0iIzMzOTZGRiIvPjxwYXRoIGQ9Ik05LjUgMTIuOWMzLjYtMy41IDkuNC0zLjUgMTMgMGwuNC40Yy4yLjIuMi41IDAgLjdsLTEuNSAxLjRjLS4xLjEtLjIuMS0uMyAwbC0uNi0uNmMtMi41LTIuNC02LjYtMi40LTkuMSAwbC0uNi42Yy0uMS4xLS4yLjEtLjMgMGwtMS41LTEuNGMtLjItLjItLjItLjUgMC0uN3ptMTYuMSAzbDEuMyAxLjNjLjIuMi4yLjUgMCAuN2wtNiA1LjhjLS4yLjItLjUuMi0uNyAwbC00LjItNC4xYzAtLjEtLjEtLjEtLjIgMGwtNC4yIDQuMWMtLjIuMi0uNS4yLS43IDBsLTYtNS44Yy0uMi0uMi0uMi0uNSAwLS43bDEuMy0xLjNjLjItLjIuNS0uMi43IDBsNC4yIDQuMWMuMS4xLjIuMS4yIDBsNC4yLTQuMWMuMi0uMi41LS4yLjcgMGw0LjIgNC4xYy4xLjEuMi4xLjIgMGw0LjItNC4xYy4yLS4yLjUtLjIuNyAweiIgZmlsbD0iI2ZmZiIvPjwvc3ZnPg==";

/// The entry the wallet picker shows. Deliberately shaped like an EIP-6963 wallet, with `lazy` marking that
/// its provider does not exist yet and must be awaited.
export function wcWalletEntry() {
  return { info: { rdns: WC_RDNS, name: "WalletConnect", icon: WC_ICON }, provider: null, lazy: wcProvider };
}

export function isWalletConnect(wallet) {
  return wallet?.info?.rdns === WC_RDNS;
}

let _provider = null;
let _initing = null;

/// Load the library (once) and initialize the provider (once). Safe to call repeatedly.
export function wcProvider() {
  if (_provider) return Promise.resolve(_provider);
  if (_initing) return _initing;
  _initing = (async () => {
    if (!WALLETCONNECT_PROJECT_ID) throw new Error("WalletConnect isn't configured for this site.");
    const { EthereumProvider } = await import("./vendor/walletconnect-provider.mjs");
    _provider = await EthereumProvider.init({
      projectId: WALLETCONNECT_PROJECT_ID,
      // Optional, not required — see note 2 at the top of this file.
      optionalChains: [CHAIN.id],
      // The RPC the WALLET is told to use. Must be write-capable: the wallet broadcasts the user's
      // transactions through it, so this is walletRpcUrls for the same reason wallet_addEthereumChain uses it,
      // and never the read-only proxy in CHAIN.rpc (which refuses eth_sendRawTransaction).
      rpcMap: { [CHAIN.id]: (CHAIN.walletRpcUrls || CHAIN.rpc)[0] },
      optionalMethods: [
        "eth_sendTransaction", "personal_sign", "eth_signTypedData_v4",
        "wallet_switchEthereumChain", "wallet_addEthereumChain",
      ],
      optionalEvents: ["accountsChanged", "chainChanged"],
      showQrModal: true, // the library brings its own QR modal; the pad does not draw one
      metadata: {
        name: "Robin Labs",
        description: "Fair launch memecoins on Robinhood Chain.",
        url: typeof location !== "undefined" ? location.origin : "https://robinlab.io",
        icons: [(typeof location !== "undefined" ? location.origin : "") + "/assets/logo-mark.png"],
      },
    });
    return _provider;
  })().catch((e) => {
    // Clear the memo so a later attempt starts clean instead of replaying a rejected promise forever — a
    // failed init is usually a dropped network or a blocked relay, both of which a retry can fix.
    _initing = null;
    _provider = null;
    throw new Error("WalletConnect couldn't start (" + (e?.message || "unknown error") + "). Try again.");
  });
  return _initing;
}

/// Whether a WalletConnect session already exists — checked WITHOUT loading the library.
///
/// The point of this is page load. Restoring a session eagerly on every navigation would mean importing 2MB
/// on every navigation, even for someone who connected once and left. WalletConnect persists its session in
/// localStorage under `wc@2:*`, so the cheap presence check is a key scan; the library is only pulled in when
/// there is actually something to restore.
export function hasStoredSession() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("wc@2:") && k.includes("session")) {
        const v = localStorage.getItem(k);
        if (v && v !== "[]" && v !== "{}" && v !== "null") return true;
      }
    }
  } catch { /* private mode — treat as no session */ }
  return false;
}

/// End the session on BOTH sides. Without this the phone wallet keeps listing the site as connected and the
/// next connect silently reuses the stale session instead of showing a QR.
export async function wcDisconnect() {
  const p = _provider;
  _provider = null;
  _initing = null;
  try { await p?.disconnect?.(); } catch { /* already gone on one side; local state is cleared either way */ }
}
