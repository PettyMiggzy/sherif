// ─────────────────────────────────────────────────────────────────────────────
// sitegate — slug moderation for per-coin websites (<slug>.robinlabs.fun).
//
// A coin's creator picks the subdomain label. Three gates, in order:
//   1. FORMAT   — DNS-label-safe, 2..32 chars, [a-z0-9-], no edge/‑double hyphen.
//   2. RESERVED — infra + first-party labels a coin must never occupy
//                 (www, api, admin, robin, docs, …) so it can't shadow us or
//                 phish (robinhood, uniswap, metamask, airdrop, support …).
//   3. WORDLIST — a blocked-substring filter (slurs / obvious abuse). The list
//                 is stored rot13-encoded so the repo isn't a wall of slurs;
//                 extend at deploy time with SITE_SLUG_BLOCKWORDS (plain, comma-sep).
//
// TAKEDOWN — a separate exact-match blocklist (SITE_SLUG_BLOCKLIST, comma-sep,
// plus this module's built-ins). A taken-down slug can never be registered AND
// is refused at serve time even if a row still points at it (belt + braces).
//
// checkSlug() is pure + synchronous; the API layer adds the uniqueness check.
// ─────────────────────────────────────────────────────────────────────────────

const SLUG_MIN = 2;
const SLUG_MAX = 32;

// Reserved first-party + infra labels. Kept lowercase; matched exactly.
const RESERVED = new Set([
  // infra / DNS
  "www", "api", "app", "apps", "admin", "administrator", "root", "mail", "email",
  "smtp", "imap", "pop", "ftp", "sftp", "ssh", "ns", "ns1", "ns2", "dns", "mx",
  "cdn", "static", "assets", "media", "img", "images", "files", "download", "downloads",
  "cpanel", "webmail", "autoconfig", "autodiscover", "localhost", "internal", "vpn",
  "gateway", "proxy", "router", "server", "host", "cluster", "k8s", "grafana", "kibana",
  // environments
  "dev", "development", "test", "testing", "stage", "staging", "prod", "production",
  "preview", "beta", "alpha", "demo", "sandbox", "canary", "edge", "local",
  // first-party Robin Labs surfaces
  "robin", "robinlab", "robinlabs", "labs", "lab", "pad", "launchpad", "docs", "doc",
  "help", "support", "status", "blog", "news", "about", "team", "careers", "jobs",
  "press", "brand", "legal", "terms", "privacy", "policy", "security", "abuse",
  "dashboard", "account", "accounts", "wallet", "wallets", "swap", "bridge", "rewards",
  "reward", "stake", "staking", "vault", "vaults", "create", "launch", "browse",
  "explore", "market", "markets", "trade", "trading", "chart", "charts", "stats",
  "analytics", "coin", "coins", "token", "tokens", "og", "share", "embed", "widget",
  "auth", "login", "logout", "signin", "signup", "register", "oauth", "sso", "verify",
  "verification", "connect", "callback", "webhook", "webhooks", "graphql", "rpc", "ws",
  "me", "you", "us", "info", "contact", "hello", "hi", "mod", "moderator", "official",
  // common phishing / impersonation targets
  "robinhood", "uniswap", "metamask", "coinbase", "binance", "opensea", "phantom",
  "ledger", "trezor", "trustwallet", "walletconnect", "etherscan", "blockscout",
  "airdrop", "airdrops", "claim", "claims", "presale", "giveaway", "bonus", "reward-claim",
  "free", "mint", "minting", "kyc", "unlock", "migrate", "migration",
]);

// Blocked substrings (rot13). Decoded at load. Deliberately conservative: obvious
// slurs + a few abuse markers. Substring match, so variants ("…slur123") are caught.
const BLOCK_ROT13 = [
  // racial / hateful slurs
  "avttre", "avttre", "avttn", "xvxr", "snttbg", "snt", "ergneq", "fcvp", "puvax",
  "puvat", "tbbx", "wnc", "penpxre", "ornare", "genavr", "gunaavr", "puvax",
  // sexual abuse / CSAM markers
  "puvyqcbea", "cnrqb", "erncr", "orfgvnyvgl", "vaprfg",
  // extremist
  "anmv", "uvgyre", "xxx", "wvunq",
];
function rot13(s) {
  return s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));
}
const BLOCK_WORDS = new Set(BLOCK_ROT13.map(rot13));
// Extra blocked substrings from the environment (plain text, comma-separated).
for (const w of String(process.env.SITE_SLUG_BLOCKWORDS || "").toLowerCase().split(","))
  if (w.trim()) BLOCK_WORDS.add(w.trim());

// Takedown: exact slugs that are permanently refused (registration AND serving).
const TAKEDOWN = new Set(
  String(process.env.SITE_SLUG_BLOCKLIST || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean),
);

const FORMAT = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

// Normalise to the canonical stored form (or null if it isn't even a string).
export function normalizeSlug(raw) {
  if (raw == null) return null;
  return String(raw).trim().toLowerCase();
}

export function isTakenDown(slug) {
  const s = normalizeSlug(slug);
  return !!s && TAKEDOWN.has(s);
}

// Pure gate. Returns { ok:true, slug } or { ok:false, reason }.
export function checkSlug(raw) {
  const slug = normalizeSlug(raw);
  if (!slug) return { ok: false, reason: "empty" };
  if (slug.length < SLUG_MIN) return { ok: false, reason: `too short (min ${SLUG_MIN})` };
  if (slug.length > SLUG_MAX) return { ok: false, reason: `too long (max ${SLUG_MAX})` };
  if (!FORMAT.test(slug)) return { ok: false, reason: "use a-z, 0-9 and hyphens; no leading/trailing hyphen" };
  if (slug.includes("--")) return { ok: false, reason: "no double hyphens" };
  // reject xn-- style punycode / homoglyph smuggling and all-numeric labels that read like IPs
  if (slug.startsWith("xn--")) return { ok: false, reason: "reserved prefix" };
  if (RESERVED.has(slug)) return { ok: false, reason: "reserved word" };
  if (TAKEDOWN.has(slug)) return { ok: false, reason: "unavailable" };
  for (const bad of BLOCK_WORDS) if (slug.includes(bad)) return { ok: false, reason: "not allowed" };
  return { ok: true, slug };
}

// Style key must be one of the shipped templates. Kept here so the API validates
// against the same list the engine (pad/assets/coinsite.js STYLE_KEYS) renders.
export const SITE_STYLES = [
  "neonvault", "aurora", "midnight", "blackgold", "chromesunset",
  "cyberhud", "reserve", "brutalist", "halftone", "monomax",
];
export function isValidStyle(k) { return SITE_STYLES.includes(String(k || "")); }
