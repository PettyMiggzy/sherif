// Tokens kept out of every list on this site (home, explore, leaderboard, the
// public API and MCP lists). They still exist on chain and still open by direct
// link; nothing here can change a launch. Add more with HIDDEN_TOKENS=0x…,0x… .
const BUILT_IN = [
  '0x8ad64f6b8b2d75d67b26eaa27f539a2b6cb214ba', // ELD: launched at a $20B starting market cap by mistake
];
const HIDDEN = new Set([...BUILT_IN, ...(process.env.HIDDEN_TOKENS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)]);
export const isHidden = (token: string) => HIDDEN.has(token.toLowerCase());
