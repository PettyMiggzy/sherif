#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Robin Radar — finds STRANDED coins on Robinhood Chain worth pitching a migration to.
//
// The migration wedge only works if we approach the right wallets: creators whose coin
// stalled below graduation or bled out after a pump, on PONS / NOXA / Lemon / the pack.
// Radar reads the chain's PUBLIC data (GeckoTerminal + DexScreener, no keys) and ranks
// candidates by "salvageable but stuck", then resolves their socials so you can DM them.
//
// Read-only. Touches nothing on-chain, no wallet, no live contracts. Just intel.
//
//   node tools/robin-radar.mjs               # scan + write marketing/radar-hitlist.{md,json}
//   node tools/robin-radar.mjs --pages 6     # scan deeper (more API calls, slower)
//
// Rate limit: GeckoTerminal free tier is ~30 calls/min. We pace to stay under it.
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";

const NET = "robinhood";                 // GeckoTerminal network slug for Robinhood Chain
const GT = "https://api.geckoterminal.com/api/v2";
const HEADERS = { Accept: "application/json", "User-Agent": "robin-radar/1.0" };
const argPages = (() => { const i = process.argv.indexOf("--pages"); return i > -1 ? Math.max(1, +process.argv[i + 1] || 12) : 12; })();

// Graduation bar on PONS is 4.2 ETH of paired liquidity. A coin sitting well under that with
// real identity + past trades is a "stalled below graduation" migration target. A coin that had
// volume and is now down hard is a "dumped after pump" target. Both are addressable.
const GRAD_ETH = 4.2;
const WETH_LC = "0x".padEnd(2, "0"); // resolved dynamically below from a WETH pair
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gt(path) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(`${GT}${path}`, { headers: HEADERS });
      if (r.status === 429) { await sleep(2500 * (attempt + 1)); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch { await sleep(1500 * (attempt + 1)); }
  }
  return null;
}

// A pool's non-WETH side is the token we might pitch. Pull the identity + metrics we score on.
function pickBase(pool, included) {
  const a = pool.attributes || {};
  const rel = pool.relationships || {};
  const baseId = rel.base_token?.data?.id || "";
  const quoteId = rel.quote_token?.data?.id || "";
  // The base token id looks like "robinhood_0xabc...". WETH is usually the quote; if base IS weth, skip.
  const addrOf = (id) => (id.split("_")[1] || "").toLowerCase();
  const baseAddr = addrOf(baseId);
  const quoteAddr = addrOf(quoteId);
  const inc = (id) => included.get(id);
  return {
    poolName: a.name,
    poolAddr: a.address,
    baseId, baseAddr, quoteAddr,
    baseMeta: inc(baseId),
    liqUsd: parseFloat(a.reserve_in_usd || 0) || 0,
    vol24: parseFloat(a.volume_usd?.h24 || 0) || 0,
    priceUsd: parseFloat(a.base_token_price_usd || 0) || 0,
    chg24: parseFloat(a.price_change_percentage?.h24 || 0) || 0,
    chg6: parseFloat(a.price_change_percentage?.h6 || 0) || 0,
    txns24: (() => { const t = a.transactions?.h24 || {}; return (t.buys || 0) + (t.sells || 0); })(),
    buyers24: a.transactions?.h24?.buyers || 0,
    createdAt: a.pool_created_at || "",
    dex: rel.dex?.data?.id || "",
  };
}

function ageHours(iso) {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!isFinite(t)) return 0;
  return (Date.now() - t) / 3.6e6;
}

// Score a candidate: a REAL coin (identity + a community) that is now STUCK and rescuable.
// Two addressable target types, and we require at least one to fire:
//   (A) stalled below graduation: real liquidity under the 4.2 ETH bar, gone quiet
//   (B) dumped after a pump: down hard on the day, owner demoralized, open to a fresh floor
function score(c, gradUsd) {
  let s = 0; const tags = [];
  const sym = c.baseMeta?.attributes?.symbol || (c.poolName ? c.poolName.split("/")[0].trim() : "");
  const junk = !sym || /^(WETH|USDC|USDT|USDG|USDbC|DAI|NVDA|AAPL|HOOD|GME)$/i.test(sym);
  if (junk) return { s: -1, tags: ["skip"] };
  if (c.liqUsd < 400) return { s: -1, tags: ["dust"] };   // too dead to have a community worth moving

  const age = ageHours(c.createdAt);
  const belowGrad = c.liqUsd < gradUsd;

  // (A) Stalled below graduation and quiet now (had a shot, never made it over the bar).
  const stalled = belowGrad && c.vol24 < 3000 && (age > 6 || c.txns24 < 40);
  if (stalled) { s += 34; tags.push("stalled-below-grad"); }

  // (B) Dumped after a pump (still shows in the active set, but bleeding).
  if (c.chg24 <= -50) { s += 40; tags.push("dumped-hard"); }
  else if (c.chg24 <= -30) { s += 26; tags.push("dumping"); }
  else if (c.chg24 <= -15) { s += 12; tags.push("fading"); }

  if (!tags.length) return { s: 0, tags: [] };            // neither target type → not our lead

  // Supporting signals (a community actually exists to carry over).
  if (c.txns24 >= 20 || c.buyers24 >= 10) { s += 14; tags.push("has-traders"); }
  if (c.buyers24 >= 40) { s += 8; tags.push("real-holders"); }
  if (age > 24) { s += 6; tags.push("aged"); }
  // Favor communities big enough to be worth the DM, without rewarding whales-only dust.
  s += Math.min(12, Math.round(c.liqUsd / 700));
  return { s, tags };
}

async function main() {
  // --dms-only: skip the slow chain scan, just regenerate the DM sheet from the existing hit-list JSON
  // (use after editing the DM template so you don't re-resolve every social).
  if (process.argv.includes("--dms-only")) {
    const json = JSON.parse(readFileSync("marketing/radar-hitlist.json", "utf8"));
    renderMd(json); renderDms(json);
    const reach = json.filter((c) => c.twitter || c.telegram).length;
    console.log(`Regenerated marketing/radar-dms.md from ${json.length} candidates (${reach} reachable).`);
    return;
  }
  console.log(`Robin Radar scanning Robinhood Chain (network=${NET}, pages=${argPages})...`);
  // 1) Find the WETH address + ETH price from a trending WETH pair, to size the graduation bar in USD.
  let ethUsd = 0;
  const INC = "include=base_token,quote_token,dex";
  const trend = await gt(`/networks/${NET}/trending_pools?page=1&${INC}`); await sleep(2200);
  const incMap = new Map();
  const pools = [];
  const absorb = (j) => {
    if (!j) return;
    (j.included || []).forEach((x) => incMap.set(x.id, x));
    (j.data || []).forEach((p) => pools.push(p));
  };
  absorb(trend);
  // derive ETH price: a WETH-quoted pool has base_token_price in USD; WETH itself trades ~ known.
  for (const p of (trend?.data || [])) {
    const a = p.attributes || {};
    // reserve_in_usd / (2 * base_price_in_native?) is messy; instead grab a WETH price via a stable pair later.
  }

  // 2) Pull new pools + several pages of all pools (sorted by volume desc) for breadth.
  absorb(await gt(`/networks/${NET}/new_pools?page=1&${INC}`)); await sleep(2200);
  absorb(await gt(`/networks/${NET}/new_pools?page=2&${INC}`)); await sleep(2200);
  for (let pg = 1; pg <= argPages; pg++) {
    absorb(await gt(`/networks/${NET}/pools?page=${pg}&${INC}`));
    await sleep(2200);
  }

  // ETH price: read it from GeckoTerminal simple token price of WETH if we can spot WETH id.
  // WETH is the most common quote token; grab its address from the most common quoteAddr.
  const quoteCounts = new Map();
  for (const p of pools) {
    const c = pickBase(p, incMap);
    if (c.quoteAddr) quoteCounts.set(c.quoteAddr, (quoteCounts.get(c.quoteAddr) || 0) + 1);
  }
  const wethAddr = [...quoteCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  if (wethAddr) {
    const pj = await gt(`/simple/networks/${NET}/token_price/${wethAddr}`); await sleep(2200);
    ethUsd = parseFloat(pj?.data?.attributes?.token_prices?.[wethAddr] || 0) || 0;
  }
  if (!ethUsd) ethUsd = 1868; // fallback to a recently observed price
  const gradUsd = GRAD_ETH * ethUsd;
  console.log(`ETH ~$${ethUsd.toFixed(0)}, graduation bar ~$${gradUsd.toFixed(0)} (${GRAD_ETH} ETH)`);

  // 3) Dedup by base token, keep the deepest pool per token, score.
  const byToken = new Map();
  for (const p of pools) {
    const c = pickBase(p, incMap);
    if (!c.baseAddr || c.baseAddr === wethAddr) continue;
    const prev = byToken.get(c.baseAddr);
    if (!prev || c.liqUsd > prev.liqUsd) byToken.set(c.baseAddr, c);
  }
  const scored = [];
  for (const c of byToken.values()) {
    const { s, tags } = score(c, gradUsd);
    if (s <= 0) continue;
    scored.push({ ...c, score: s, tags });
  }
  scored.sort((a, b) => b.score - a.score);
  const TOPN = Number((() => { const i = process.argv.indexOf("--top"); return i > -1 ? process.argv[i + 1] : 0; })()) || 80;
  const top = scored.slice(0, TOPN);
  // Identity is already known from the included token objects — set it now so the list is useful
  // even if the (slower, rate-limited) socials pass gets cut short.
  for (const c of top) {
    c.symbol = c.baseMeta?.attributes?.symbol || (c.poolName ? c.poolName.split("/")[0].trim() : "?");
    c.name = c.baseMeta?.attributes?.name || c.symbol;
    c.twitter = ""; c.telegram = ""; c.websites = []; c.gtScore = null;
  }

  mkdirSync("marketing", { recursive: true });
  const writeOutputs = () => {
    top.sort((a, b) => b.score - a.score);
    const json = top.map((c) => ({
      name: c.name, symbol: c.symbol, token: c.baseAddr, dex: c.dex,
      liqUsd: Math.round(c.liqUsd), vol24: Math.round(c.vol24), chg24: Math.round(c.chg24),
      buyers24: c.buyers24, txns24: c.txns24, ageH: Math.round(ageHours(c.createdAt)),
      twitter: c.twitter, telegram: c.telegram, websites: c.websites, gtScore: c.gtScore,
      deployer: c.deployer || "", holders: c.holders ?? null,
      tags: c.tags, score: c.score,
      gecko: `https://www.geckoterminal.com/${NET}/pools/${c.poolAddr}`,
      dexscreener: `https://dexscreener.com/${NET}/${c.poolAddr}`,
    }));
    writeFileSync("marketing/radar-hitlist.json", JSON.stringify(json, null, 2));
    renderMd(json);
    renderDms(json);
    return json;
  };

  // Write immediately (pre-socials) so a killed run still leaves a usable list.
  writeOutputs();

  // 4) Enrich socials via DexScreener — batched 30 tokens/call, ~300 req/min, far better socials coverage
  // than GeckoTerminal and no throttling, so we enrich EVERY candidate and get a big reachable list.
  console.log(`Resolving socials via DexScreener for all ${top.length} candidates...`);
  const byAddr = new Map(top.map((c) => [c.baseAddr.toLowerCase(), c]));
  for (let i = 0; i < top.length; i += 30) {
    const batch = top.slice(i, i + 30).map((c) => c.baseAddr);
    let j = null;
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${batch.join(",")}`, { headers: HEADERS });
      if (r.ok) j = await r.json();
    } catch { /* skip batch */ }
    for (const pair of (j?.pairs || [])) {
      const c = byAddr.get((pair.baseToken?.address || "").toLowerCase());
      if (!c) continue;
      const info = pair.info || {};
      const soc = info.socials || [];
      const tw = soc.find((s) => /twitter|^x$/i.test(s.type || ""));
      const tg = soc.find((s) => /telegram/i.test(s.type || ""));
      if (tw && !c.twitter) c.twitter = tw.url;
      if (tg && !c.telegram) c.telegram = tg.url;
      if (info.websites?.length && !(c.websites || []).length) c.websites = info.websites.map((w) => w.url || w).slice(0, 2);
      if (pair.baseToken?.symbol) c.symbol = pair.baseToken.symbol;
      if (pair.baseToken?.name) c.name = pair.baseToken.name;
    }
    await sleep(400); // stay well under DexScreener's ~300/min
    writeOutputs(); // checkpoint each batch
  }
  top.forEach((c) => { if (c.twitter || c.telegram) c.score += 12; }); // reachable => higher priority

  const json = writeOutputs();
  const reachable = json.filter((c) => c.twitter || c.telegram);
  console.log(`\nTop reachable targets:`);
  reachable.slice(0, 15).forEach((c, i) => {
    console.log(`${String(i + 1).padStart(2)}. ${(c.name + " ($" + c.symbol + ")").slice(0, 28).padEnd(28)} liq $${String(c.liqUsd).padStart(7)} | ${String(c.chg24).padStart(4)}% | ${c.buyers24} buyers | ${[c.twitter && "X", c.telegram && "TG"].filter(Boolean).join("+")}`);
  });
  console.log(`\nWrote marketing/radar-hitlist.md (${json.length} candidates, ${reachable.length} reachable) + .json`);
}

// Render the markdown hit-list from the json rows.
function renderMd(json) {
  const reachable = json.filter((c) => c.twitter || c.telegram);
  const md = [];
  md.push(`# Robin Radar hit-list — stranded coins to pitch migration`);
  md.push(`Scanned Robinhood Chain via GeckoTerminal (graduation bar 4.2 ETH).`);
  md.push(`Candidates: ${json.length} total, ${reachable.length} with a public X or Telegram to DM.\n`);
  md.push(`Pitch: "Migrate your coin to Robin in one paste, keep your name and community, land on a permanent floor instead of PONS V2's curve, and give holders limit orders + DCA."\n`);
  md.push(`| # | Coin | Liq | 24h vol | 24h % | Buyers | Age h | Reach | Why |`);
  md.push(`|---|------|-----|---------|-------|--------|-------|-------|-----|`);
  json.forEach((c, i) => {
    const reach = [c.twitter ? "X" : "", c.telegram ? "TG" : ""].filter(Boolean).join("+") || "-";
    md.push(`| ${i + 1} | ${c.name} ($${c.symbol}) | $${c.liqUsd.toLocaleString()} | $${c.vol24.toLocaleString()} | ${c.chg24}% | ${c.buyers24} | ${c.ageH} | ${reach} | ${c.tags.join(", ")} |`);
  });
  md.push(`\n## Reachable targets (DM these first)\n`);
  reachable.forEach((c, i) => {
    md.push(`### ${i + 1}. ${c.name} ($${c.symbol})`);
    md.push(`- Token: \`${c.token}\``);
    if (c.twitter) md.push(`- X: ${c.twitter}`);
    if (c.telegram) md.push(`- Telegram: ${c.telegram}`);
    if (c.websites?.length) md.push(`- Web: ${c.websites.join(", ")}`);
    if (c.deployer) md.push(`- Deployer wallet: \`${c.deployer}\``);
    md.push(`- Liquidity $${c.liqUsd.toLocaleString()}, 24h vol $${c.vol24.toLocaleString()}, ${c.chg24}% 24h, ${c.buyers24} buyers${c.holders ? `, ${c.holders} holders` : ""}, ~${c.ageH}h old`);
    md.push(`- Chart: ${c.gecko}`);
    md.push(`- Signals: ${c.tags.join(", ")}\n`);
  });
  writeFileSync("marketing/radar-hitlist.md", md.join("\n"));
}

// Draft a PERSONALIZED migration DM per reachable target — pulls its real name/ticker/drawdown/holders so
// each one reads written-for-them, not blasted. A human still reviews + sends (this never sends anything).
// Phrasing varies by index so 20 of them don't look like a copy-paste (reads real, and doesn't trip filters).
function dmFor(c, i) {
  const sym = (c.symbol || "?").replace(/^\$+/, "");
  const drop = c.chg24 <= 0 ? Math.abs(c.chg24) : 0;
  const crowd = c.holders || c.buyers24 || 0;
  const hard = drop >= 40;
  // Only cite numbers we actually have; keep it honest.
  const crowdLine = crowd ? `${crowd.toLocaleString()} ${c.holders ? "holders" : "buyers"}` : "a real community";
  const dropLine = drop ? `${drop}% drawdown` : "a rough stretch";
  const variants = [
    `Hey, been watching $${sym}. ${crowd ? `${crowdLine} still here through ${hard ? "a " + dropLine : dropLine}` : "You built something real"} says the community is real even if the chart hasn't been. I run Robin Labs (robinlab.io). I can migrate $${sym} in one paste: keep your name, ticker, logo and holders, and relaunch into real Uniswap v3 liquidity with a permanent floor the price can't fall through. Free to launch, you earn a 0.5 ETH creator reward on graduation, and I'll do it with you live and seed the first buy so it opens green. Worth 10 minutes?`,
    `Hey $${sym} team. Finding ${crowdLine} is the hard part, and they deserve better than ${dropLine}. I run Robin Labs. One paste migrates you onto real liquidity with a permanent floor, keeps your whole community, and it's free to launch with a 0.5 ETH creator reward on graduation (PONS charges you to launch and then puts you on a curve that can dump to zero). I'll walk you through it personally. Can I show you?`,
    `Hey, saw $${sym}. ${crowd ? crowdLine + " holding through " + dropLine : "Real project, unfair chart"}. Robin Labs relaunches you in one paste onto a permanent floor instead of a curve, keeps your name and holders, free to launch plus a 0.5 ETH creator reward on graduation. I'll help you live and seed a green opening candle. Open to it?`,
  ];
  return variants[i % variants.length];
}

// Write a clean, copy-paste DM sheet: one ready-to-send message per reachable target.
function renderDms(json) {
  const reachable = json.filter((c) => c.twitter || c.telegram);
  const md = [];
  md.push(`# Robin Radar — ready-to-send migration DMs`);
  md.push(`${reachable.length} reachable targets, each with a personalized draft. Skim, tweak a word, send from a REAL profile.`);
  md.push(`Do NOT auto-send (spam = bans + "scam project" label). Aim for ~15-20 quality sends/day.\n`);
  reachable.forEach((c, i) => {
    const to = [c.twitter && `X ${c.twitter}`, c.telegram && `TG ${c.telegram}`].filter(Boolean).join("  |  ");
    md.push(`## ${i + 1}. ${c.name} ($${(c.symbol || "").replace(/^\$+/, "")})`);
    md.push(`Send to: ${to}`);
    md.push(`Signals: ${c.chg24}% 24h, ${c.buyers24} buyers${c.holders ? `, ${c.holders} holders` : ""}. Chart: ${c.gecko}`);
    md.push(`\n> ${dmFor(c, i)}\n`);
  });
  writeFileSync("marketing/radar-dms.md", md.join("\n"));
}

main().catch((e) => { console.error("radar error:", e); process.exit(1); });
