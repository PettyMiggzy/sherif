// V4 testnet team-test app — launch (with in-browser hook mining), buy, sell, read, graduate.
// Talks straight to the deployed testnet contracts. TESTNET ONLY. No secrets, no backend.
import * as ethers from "./ethers.min.js";
import { CFG } from "./config.js";

const $ = (id) => document.getElementById(id);
const ZERO = "0x0000000000000000000000000000000000000000";
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
// [FIX] tickSpacing was 60 — the governed curveWidth every real deploy ships (23000, see
// scripts/deploy-curve.js/deploy-local-demo.js) only divides evenly by 100, so a launch with tickSpacing=60
// reverted BadGeometry (`d.curveWidth % ts != 0`) every single time. 100 matches production/testnet/local.
const FEE = 10000, TS = 100; // default 1% pool fee / tickSpacing 100 — the REAL fee is read from the curve
const abi = ethers.AbiCoder.defaultAbiCoder();
// [audit M5] Curve read-ABI incl. fee() so we can read the pool's ACTUAL lp fee (governed on-chain) and never
// desync the poolId by hardcoding it. Only appends fee() if the generated ABI doesn't already carry it.
const CURVE_READ = CFG.ABI.curve.some((f) => f.name === "fee")
  ? CFG.ABI.curve
  : [...CFG.ABI.curve, { type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] }];

// Exact port of Uniswap TickMath.getSqrtPriceAtTick (Q64.96). We cap each swap's price limit at the
// curve's own boundary tick instead of the absolute MIN/MAX — a swap that would cross the boundary then
// fills up to it and STOPS, rather than walking into the zero-liquidity zone (which the deployed
// PoolManager rejects with an opaque custom error). Must match on-chain bit-for-bit, so BigInt not float.
function sqrtAtTick(tick) {
  const t = BigInt(tick);
  const abs = t < 0n ? -t : t;
  if (abs > 887272n) throw new Error("tick out of range");
  let r = (abs & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  const M = (h) => { r = (r * h) >> 128n; };
  if (abs & 0x2n) M(0xfff97272373d413259a46990580e213an);
  if (abs & 0x4n) M(0xfff2e50f5f656932ef12357cf3c7fdccn);
  if (abs & 0x8n) M(0xffe5caca7e10e4e61c3624eaa0941cd0n);
  if (abs & 0x10n) M(0xffcb9843d60f6159c9db58835c926644n);
  if (abs & 0x20n) M(0xff973b41fa98c081472e6896dfb254c0n);
  if (abs & 0x40n) M(0xff2ea16466c96a3843ec78b326b52861n);
  if (abs & 0x80n) M(0xfe5dee046a99a2a811c461f1969c3053n);
  if (abs & 0x100n) M(0xfcbe86c7900a88aedcffc83b479aa3a4n);
  if (abs & 0x200n) M(0xf987a7253ac413176f2b074cf7815e54n);
  if (abs & 0x400n) M(0xf3392b0822b70005940c7a398e4b70f3n);
  if (abs & 0x800n) M(0xe7159475a2c29b7443b29c7fa6e889d9n);
  if (abs & 0x1000n) M(0xd097f3bdfd2022b8845ad8f792aa5825n);
  if (abs & 0x2000n) M(0xa9f746462d870fdf8a65dc1f90e061e5n);
  if (abs & 0x4000n) M(0x70d869a156d2a1b890bb3df62baf32f7n);
  if (abs & 0x8000n) M(0x31be135f97d08fd981231505542fcfa6n);
  if (abs & 0x10000n) M(0x9aa508b5b7a84e1c677de54f3e99bc9n);
  if (abs & 0x20000n) M(0x5d6af8dedb81196699c329225ee604n);
  if (abs & 0x40000n) M(0x2216e584f5fa1ea926041bedfe98n);
  if (abs & 0x80000n) M(0x48a170391f7dc42444e8fa2n);
  if (t > 0n) r = ((1n << 256n) - 1n) / r;
  return (r >> 32n) + ((r & 0xffffffffn) === 0n ? 0n : 1n);
}

let provider, signer, me;
let launched = null; // { token, hook, curve, poolId, key }
let auctionVault = null; // [AUCTION] this launch's DailyAuctionVaultV4 address, or null if auctionDays was 0

function log(msg, cls = "") {
  const el = $("log");
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.innerHTML = msg;
  el.prepend(line);
}
const ex = (h) => `${CFG.CHAIN.explorer}/tx/${h}`;
const exA = (a) => `${CFG.CHAIN.explorer}/address/${a}`;

async function connect() {
  if (!window.ethereum) return log("No wallet found. Install MetaMask.", "err");
  provider = new ethers.BrowserProvider(window.ethereum);
  await window.ethereum.request({ method: "eth_requestAccounts" });
  // ensure testnet
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CFG.CHAIN.hexId }] });
  } catch (e) {
    if (e.code === 4902) {
      await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{
        chainId: CFG.CHAIN.hexId, chainName: CFG.CHAIN.name, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
        rpcUrls: [CFG.CHAIN.rpc], blockExplorerUrls: [CFG.CHAIN.explorer],
      }] });
    }
  }
  signer = await provider.getSigner();
  me = await signer.getAddress();
  const bal = await provider.getBalance(me);
  $("who").innerHTML = `${me.slice(0, 6)}…${me.slice(-4)} · ${(+ethers.formatEther(bal)).toFixed(4)} test-ETH`;
  $("app").style.display = "block";
  if (+ethers.formatEther(bal) === 0) log(`Wallet has 0 test-ETH — grab some at <a href="${CFG.CHAIN.faucet}" target="_blank">the faucet</a>.`, "warn");
}

function poolKey(token, hook) {
  return { currency0: ZERO, currency1: token, fee: FEE, tickSpacing: TS, hooks: hook };
}
function poolIdOf(k) {
  return ethers.keccak256(abi.encode(["tuple(address,address,uint24,int24,address)"], [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]]));
}

// [FIX] CurvePadFactoryV4.launch() does NOT hand the caller's tokenSalt to the CREATE2 deployer raw — it
// folds the WHOLE LaunchConfig in first (`keccak256(abi.encode(cfg, tokenSalt))`, see the contract's own
// [SALT BINDING] comment), specifically so a replayed salt with a changed field can't land on the same
// address. This bench predicted (and mined the hook against) `getCreate2Address(deployer, tokenSalt, ...)`
// using the RAW salt — the wrong address entirely, and since it never mined for the `1ab5` brand suffix at
// all (PadBrand.requireBrand is enforced unconditionally), essentially every launch reverted BadTokenSuffix.
const LAUNCH_CFG_TUPLE = "tuple(string,string,uint8,uint256,uint256,uint256,int24,int24,address,bool,uint24,uint8)";
function cfgTupleValues(cfg) {
  return [cfg.name, cfg.symbol, cfg.decimals, cfg.supply, cfg.curveSupply, cfg.reserveSupply, cfg.tickSpacing, cfg.startTickMag, cfg.creator, cfg.noPoolForever, cfg.lpFee, cfg.auctionDays];
}
async function mineTokenSalt(cfg, tokenInitCodeHash, maxTries = 200000) {
  for (let i = 0n; i < BigInt(maxTries); i++) {
    const candidate = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const wrapped = ethers.keccak256(abi.encode([LAUNCH_CFG_TUPLE, "bytes32"], [cfgTupleValues(cfg), candidate]));
    const addr = ethers.getCreate2Address(CFG.ADDR.deployer, wrapped, tokenInitCodeHash);
    if ((BigInt(addr) & 0xffffn) === 0x1ab5n) return { tokenSalt: candidate, token: addr };
    if (i % 20000n === 0n && i > 0n) await new Promise((r) => setTimeout(r)); // yield so the UI doesn't freeze
  }
  return null;
}

// ── LAUNCH ─────────────────────────────────────────────────────────────────────
async function launch() {
  const name = $("name").value.trim(), symbol = $("symbol").value.trim().toUpperCase();
  if (!name || !symbol) return log("Enter a name + symbol.", "err");
  const curveSupply = ethers.parseEther($("curveSupply").value || "470000");
  const reserveSupply = curveSupply; // safe: satisfies the factory reserve invariant
  // [FIX] there is no "launcher allocation" in CurvePadFactoryV4 — NO DEV MINT is structural, enforced exactly:
  // supply MUST equal curveSupply + reserveSupply (see the factory's own BadConfig check) or every launch
  // reverts BadConfig immediately. The creator gets tokens only by buying from the curve like anyone else.
  const supply = curveSupply + reserveSupply;

  const salt = (s) => ethers.id(s + ":" + Date.now() + ":" + Math.floor(performance.now()));
  const curveSalt = salt("curve");

  // [FIX] cfg was missing startTickMag/noPoolForever/lpFee — CurvePadFactoryV4.LaunchConfig has carried those
  // for a while now (see the [FDV]/[NO-POOL]/[LP-FEE] rounds), so every launch through this bench has been
  // failing at the ABI-encoding layer ("missing value for component ...") regardless of the auction feature.
  // 0/false/FEE reproduce this bench's previous fixed behavior (governed-default price, no checkpoint pad,
  // the same 1% pool fee poolKey() already hardcodes below).
  const auctionDays = Number($("auctionDays")?.value || 0);
  const cfg = {
    name, symbol, decimals: 18, supply, curveSupply, reserveSupply, tickSpacing: TS,
    // [NO-POOL] every real launch is the no-pool-forever type — the curve stays the permanent market forever,
    // there's no separate permanent-LP pool for a copycat pool to matter against. Requires the deployed
    // feeConfig to have noPoolForeverEnabled (see scripts/deploy-curve.js).
    startTickMag: 0, creator: me, noPoolForever: true, lpFee: FEE, auctionDays,
  };

  log("Mining a branded (…1ab5) token address — matches the factory's own salt-binding, ~a few seconds…");
  const tokenInit = ethers.concat([CFG.BYTECODE.padToken, abi.encode(["string", "string", "uint8", "uint256", "address"], [name, symbol, 18, supply, CFG.ADDR.factory])]);
  const tokenInitCodeHash = ethers.keccak256(tokenInit);
  const mined = await mineTokenSalt(cfg, tokenInitCodeHash);
  if (!mined) return log("Could not mine a branded token salt (unexpected).", "err");
  const { tokenSalt, token } = mined;
  log(`Token address mined ✓ ${token.slice(0, 10)}…${token.slice(-4)}`);

  log(`Mining a valid hook address (flags ${CFG.HOOK_FLAGS})…`);
  const hookInit = ethers.concat([CFG.BYTECODE.feeHook, abi.encode(["address", "address", "address", "address"], [CFG.ADDR.poolManager, CFG.ADDR.factory, CFG.ADDR.feeRegistry, token])]);
  const hookHash = ethers.keccak256(hookInit);
  const FLAGS = BigInt(CFG.HOOK_FLAGS), MASK = BigInt(CFG.FLAG_MASK);
  let hookSalt = null;
  for (let i = 0n; i < 5000000n; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const a = ethers.getCreate2Address(CFG.ADDR.deployer, s, hookHash);
    if ((BigInt(a) & MASK) === FLAGS) { hookSalt = s; break; }
    if (i % 20000n === 0n && i > 0n) await new Promise((r) => setTimeout(r)); // yield so the UI doesn't freeze
  }
  if (!hookSalt) return log("Could not mine a hook salt (unexpected).", "err");
  log(`Hook mined ✓  Submitting launch…`);

  const factory = new ethers.Contract(CFG.ADDR.factory, CFG.ABI.factory, signer);
  try {
    // [FIX] launch() deploys the token + curve + hook (+ auction vault, when auctionDays>0) in one tx —
    // some RPC providers' automatic eth_estimateGas badly over-estimates a call shape this heavy (observed
    // ~3x the real cost against a local node), which either wildly overshoots what the wallet shows the
    // user or trips a provider-side gas cap outright. Measured real cost tops out ~8.7M gas even with a
    // 4-day auction; 16M leaves comfortable headroom without depending on estimateGas being accurate.
    const tx = await factory.launch(cfg, tokenSalt, hookSalt, curveSalt, { type: 0, gasLimit: 16_000_000n });
    log(`launch tx <a href="${ex(tx.hash)}" target="_blank">${tx.hash.slice(0, 10)}…</a> — waiting…`);
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((p) => p && p.name === "CurvePadLaunched");
    const [, tk, , hk, cv] = ev.args;
    // Read the pool fee + boundary ticks from the curve itself: fee → correct poolId even if governance
    // retunes lpFee [audit M5]; gradTick/startTick → cap buys at the ceiling and sells at the top so a swap
    // fills to the boundary and stops instead of crossing into empty liquidity.
    try {
      const cc = new ethers.Contract(cv, CURVE_READ, provider);
      const [gt, st, fe] = await Promise.all([cc.gradTick(), cc.startTick(), cc.fee()]);
      const key = { currency0: ZERO, currency1: tk, fee: Number(fe), tickSpacing: TS, hooks: hk };
      launched = { token: tk, hook: hk, curve: cv, key, poolId: poolIdOf(key), gradTick: Number(gt), startTick: Number(st), buyLimit: sqrtAtTick(Number(gt)), sellLimit: sqrtAtTick(Number(st)) };
    } catch (e) {
      const key = poolKey(tk, hk); // fallback: hardcoded fee + absolute limits
      launched = { token: tk, hook: hk, curve: cv, key, poolId: poolIdOf(key), buyLimit: MIN_SQRT, sellLimit: MAX_SQRT };
      log("note: couldn't read curve fee/ticks — using defaults (buys may revert near sell-out)", "warn");
    }
    log(`🚀 LAUNCHED <b>${symbol}</b> — token <a href="${exA(tk)}" target="_blank">${tk.slice(0, 8)}…</a> · curve <a href="${exA(cv)}" target="_blank">${cv.slice(0, 8)}…</a>`, "ok");
    $("trade").style.display = "block";
    $("coinLabel").textContent = `${name} (${symbol})`;
    // [AUCTION] resolve this launch's vault (0 if auctionDays was 0, or the feature isn't wired here).
    try {
      const av = await factory.auctionVaultOf(tk);
      if (av && av !== ZERO) { auctionVault = av; $("auction").style.display = "block"; refreshAuction(); }
      else { auctionVault = null; $("auction").style.display = "none"; }
    } catch { auctionVault = null; }
    refresh();
  } catch (e) { log("launch failed: " + (e.shortMessage || e.message), "err"); }
}

// ── revert decoding + gas ────────────────────────────────────────────────────────
// This Orbit L2 has no EIP-1559. We send legacy type-0 txs with an EXPLICIT gasLimit so ethers never
// calls eth_estimateGas — the testnet RPC returns revert errors in a shape ethers v6 can't classify
// ("could not coalesce error"), which hides the real reason. We preview with staticCall instead, and
// decode the revert data ourselves against the hook / v4-core / PoolSwapTest / Solidity error sets.
const GAS = { swap: 900000n, approve: 120000n, graduate: 1600000n };
const ERRORS = new ethers.Interface([
  "error ExactOutputNotSupported()",
  "error CorporateActionCurb()",
  "error SwapAmountCannotBeZero()",
  "error PriceLimitAlreadyExceeded(uint160 current, uint160 limit)",
  "error PriceLimitOutOfBounds(uint160 limit)",
  "error NotEnoughLiquidity(bytes32 poolId)",
  "error PoolNotInitialized()",
  "error PoolAlreadyInitialized()",
  "error CurrencyNotSettled()",
  "error ManagerLocked()",
  "error TicksMisordered(int24 lower, int24 upper)",
  "error TickLowerOutOfBounds(int24 tick)",
  "error TickUpperOutOfBounds(int24 tick)",
  "error NoSwapOccurred()",
  "error HookDeltaExceedsSwapAmount()",
  "error Error(string reason)",
  "error Panic(uint256 code)",
]);

// Pull the GENUINE EVM revert data — only from ethers' structured `.data` fields, NEVER from message
// strings. Ethers embeds the OUTGOING calldata in its error message, and a swap's calldata begins with
// the swap() selector (0x2229d0b4) — scraping that misreported an out-of-gas as a phantom revert. When
// there is no real revert data, the failure is NOT a contract revert (almost always gas), so we say so.
function revertData(e) {
  const hex = (x) => (typeof x === "string" && /^0x[0-9a-fA-F]{8,}$/.test(x)) ? x : null;
  return hex(e?.data) || hex(e?.info?.error?.data) || hex(e?.error?.data) || hex(e?.error?.error?.data) || hex(e?.value?.data);
}
function reason(e) {
  const d = revertData(e);
  if (d) {
    try {
      const p = ERRORS.parseError(d);
      if (p) {
        const args = p.args && p.args.length ? "(" + p.args.map((x) => x.toString()).join(", ") + ")" : "";
        return p.name + args;
      }
    } catch {}
    return "revert " + d.slice(0, 10) + " — unrecognized custom error";
  }
  const msg = e?.shortMessage || (e?.info && e.info.error && e.info.error.message) || (e?.error && e.error.message) || e?.message || "";
  if (/gas|coalesce|exceed|out of|reverted/i.test(msg)) return "no revert reason from the node (likely out-of-gas / swap too large) — try a smaller amount";
  return msg || (e?.code ? String(e.code) : "unknown error");
}

// Unpack a v4 BalanceDelta (int256: amount0 in the high 128 bits, amount1 in the low 128, each signed).
function unpackDelta(d) {
  let raw = BigInt(d);
  if (raw < 0n) raw += (1n << 256n);
  const s128 = (x) => (x >= (1n << 127n) ? x - (1n << 128n) : x);
  return { amount0: s128(raw >> 128n), amount1: s128(raw & ((1n << 128n) - 1n)) };
}

// ── BUY / SELL (via PoolSwapTest router) ─────────────────────────────────────────
function router() {
  const r = ($("router").value || CFG.ADDR.swapRouter || "").trim();
  if (!ethers.isAddress(r)) throw new Error("Set the swap-router address (deploy PoolSwapTest via scripts/deploy-testnet-extras.js).");
  return new ethers.Contract(r, CFG.ABI.swapRouter, signer);
}
async function buy() {
  if (!launched) return;
  try {
    const curveC = new ethers.Contract(launched.curve, CFG.ABI.curve, provider);
    if (await curveC.ready()) return log("Curve is sold out (ready=true) — hit <b>Graduate</b>, no more buys.", "warn");
    const amt = ethers.parseEther($("buyAmt").value || "0.001");
    const r = router();
    // cap the buy at the ceiling (gradTick): a buy bigger than the remaining curve fills up to sell-out
    // and stops, instead of crossing into empty liquidity and reverting.
    const args = [launched.key, { zeroForOne: true, amountSpecified: -amt, sqrtPriceLimitX96: launched.buyLimit ?? MIN_SQRT },
      { takeClaims: false, settleUsingBurn: false }, "0x"];
    let spent = null;
    try { const { amount0 } = unpackDelta(await r.swap.staticCall(...args, { value: amt })); spent = amount0 < 0n ? -amount0 : amount0; }
    catch (pe) { return log("buy would revert → " + reason(pe), "err"); }
    const tx = await r.swap(...args, { value: amt, type: 0, gasLimit: GAS.swap });
    log(`buy ${$("buyAmt").value} ETH <a href="${ex(tx.hash)}" target="_blank">${tx.hash.slice(0, 10)}…</a>`);
    await tx.wait();
    // [audit M4] a buy that hits the ceiling only partial-fills (rest refunded) — say so, don't imply full fill.
    if (spent !== null && spent < amt) {
      const f = (x) => (+ethers.formatEther(x)).toFixed(6);
      log(`PARTIAL FILL — spent ${f(spent)} of ${$("buyAmt").value} ETH (curve ceiling reached); ~${f(amt - spent)} ETH refunded to you.`, "warn");
    } else log("buy filled ✓", "ok");
    refresh();
  } catch (e) { log("buy failed: " + reason(e), "err"); }
}
async function sell() {
  if (!launched) return;
  try {
    const tok = new ethers.Contract(launched.token, CFG.ABI.token, signer);
    const bal = await tok.balanceOf(me);
    const amt = bal / 2n; // sell half
    if (amt === 0n) return log("Nothing to sell.", "warn");
    const r = router();
    const rAddr = await r.getAddress();
    log("approving token → router…");
    await (await tok.approve(rAddr, ethers.MaxUint256, { type: 0, gasLimit: GAS.approve })).wait();
    // cap the sell at the launch top (startTick) so a large sell fills up to it and stops, never
    // crossing above the range into empty liquidity.
    const args = [launched.key, { zeroForOne: false, amountSpecified: -amt, sqrtPriceLimitX96: launched.sellLimit ?? MAX_SQRT },
      { takeClaims: false, settleUsingBurn: false }, "0x"];
    let prev = null;
    try { prev = unpackDelta(await r.swap.staticCall(...args)); }
    catch (pe) { return log("sell would revert → " + reason(pe), "err"); }
    const tx = await r.swap(...args, { type: 0, gasLimit: GAS.swap });
    log(`sell half <a href="${ex(tx.hash)}" target="_blank">${tx.hash.slice(0, 10)}…</a>`);
    await tx.wait();
    // [audit M4] report what actually moved (tokens sold → ETH out), flag a startTick-cap partial fill.
    if (prev) {
      const sold = prev.amount1 < 0n ? -prev.amount1 : prev.amount1;
      const ethGot = prev.amount0 > 0n ? prev.amount0 : 0n;
      log(`sold ${(+ethers.formatEther(sold)).toLocaleString()} ${$("symbol").value} → ${(+ethers.formatEther(ethGot)).toFixed(6)} ETH ✓${sold < amt ? " (partial — hit startTick cap)" : ""}`, "ok");
    } else log("sell filled ✓", "ok");
    refresh();
  } catch (e) { log("sell failed: " + reason(e), "err"); }
}
async function graduate() {
  if (!launched) return;
  try {
    const curve = new ethers.Contract(launched.curve, CFG.ABI.curve, signer);
    try { await curve.graduate.staticCall(); }
    catch (pe) { return log("graduate would revert → " + reason(pe), "err"); }
    const tx = await curve.graduate({ type: 0, gasLimit: GAS.graduate });
    log(`graduate <a href="${ex(tx.hash)}" target="_blank">${tx.hash.slice(0, 10)}…</a> — waiting…`);
    await tx.wait(); log("🎓 GRADUATED — permanent LP locked, floor seeded.", "ok"); refresh();
  } catch (e) { log("graduate failed: " + reason(e), "err"); }
}

async function refresh() {
  if (!launched) return;
  try {
    const sv = new ethers.Contract(CFG.ADDR.stateView, CFG.ABI.stateView, provider);
    const [, tick] = await sv.getSlot0(launched.poolId);
    const curve = new ethers.Contract(launched.curve, CFG.ABI.curve, provider);
    const ready = await curve.ready();
    const grad = await curve.graduated();
    const tok = new ethers.Contract(launched.token, CFG.ABI.token, provider);
    const myTok = await tok.balanceOf(me);
    $("state").innerHTML = `tick <b>${tick}</b> · you hold <b>${(+ethers.formatEther(myTok)).toLocaleString()}</b> ${$("symbol").value} · ready=${ready} · graduated=${grad}`;
    $("btnGrad").disabled = !ready || grad;
    $("btnBuy").disabled = ready || grad; // sold out or graduated → nothing left to buy
  } catch (e) { /* pool may not be readable until first read */ }
}

// ── [AUCTION] optional 0-4 day daily batch auction ────────────────────────────────
// Same mechanism as v3's sibling DailyAuctionVault (see launchpad/AUDIT-V3.md): a sealed batch per day,
// permissionless close once the window passes, platform's flat 10% then a real burn-buy against this same
// curve, pro-rata claim. See DailyAuctionVaultV4.sol.
function auctionContract(signerOrProvider) {
  return new ethers.Contract(auctionVault, CFG.ABI.dailyAuctionVault, signerOrProvider);
}
async function refreshAuction() {
  if (!auctionVault) return;
  try {
    const v = auctionContract(provider);
    // [FIX] the window math below is a pure chain-timestamp comparison (dayWindow() vs "now") — using the
    // browser's wall clock instead of the chain's own block timestamp shows a stale/wrong status whenever
    // the two drift apart (observed locally after repeated evm_increaseTime warps; a real chain can drift
    // too), e.g. hiding a bid button for a window that is actually open right now.
    // provider.getBlock("latest") goes through ethers's cached block-tag resolution, which can lag behind
    // the chain's real head between its background polls — send the RPC directly so "now" is always the
    // actual current block timestamp, not a stale cached one.
    const [days, dayTranche, latestBlockHex] = await Promise.all([
      v.auctionDays(), v.dayTranche(), provider.send("eth_getBlockByNumber", ["latest", false]),
    ]);
    const n = Number(days);
    const now = Number(BigInt(latestBlockHex.timestamp));
    const rows = [];
    for (let day = 1; day <= n; day++) {
      const [[opens, closes], total, closedFlag, myBid] = await Promise.all([
        v.dayWindow(day), v.dayTotal(day), v.closed(day), v.bidOf(day, me),
      ]);
      const o = Number(opens), c = Number(closes);
      let status, action;
      if (now < o) { status = `opens in ${Math.ceil((o - now) / 3600)}h`; action = ""; }
      else if (now < c) { status = `closes in ${Math.ceil((c - now) / 3600)}h`; action = `<button data-day="${day}" class="ghost bidBtn">Bid 0.1 ETH</button>`; }
      else if (!closedFlag) { status = "window closed"; action = `<button data-day="${day}" class="ghost closeBtn">Close day ${day}</button>`; }
      else { status = total === 0n ? "no bids — funded staking" : "settled"; action = (myBid > 0n) ? `<button data-day="${day}" class="ghost claimBtn">Claim day ${day}</button>` : ""; }
      rows.push(`<div>Day ${day} — ${(+ethers.formatEther(total)).toFixed(3)} ETH bid${myBid > 0n ? ` (you: ${(+ethers.formatEther(myBid)).toFixed(3)})` : ""} — ${status} ${action}</div>`);
    }
    $("auctionState").innerHTML = `${n} day auction · ${(+ethers.formatEther(dayTranche)).toLocaleString()} tokens/day<br>` + rows.join("");
    $("auctionState").querySelectorAll(".bidBtn").forEach((b) => b.onclick = () => bidAuction(Number(b.dataset.day)));
    $("auctionState").querySelectorAll(".closeBtn").forEach((b) => b.onclick = () => closeAuctionDay(Number(b.dataset.day)));
    $("auctionState").querySelectorAll(".claimBtn").forEach((b) => b.onclick = () => claimAuction(Number(b.dataset.day)));
  } catch (e) { log("auction refresh failed: " + (e.shortMessage || e.message), "err"); }
}
async function bidAuction(day) {
  try {
    const v = auctionContract(signer);
    const tx = await v.bid(day, { value: ethers.parseEther("0.1"), type: 0, gasLimit: GAS.swap });
    log(`bid day ${day} <a href="${ex(tx.hash)}" target="_blank">${tx.hash.slice(0, 10)}…</a>`);
    await tx.wait(); log("bid confirmed ✓", "ok"); refreshAuction();
  } catch (e) { log("bid failed: " + reason(e), "err"); }
}
async function closeAuctionDay(day) {
  try {
    const v = auctionContract(signer);
    const tx = await v.closeDay(day, { type: 0, gasLimit: GAS.graduate });
    log(`close day ${day} <a href="${ex(tx.hash)}" target="_blank">${tx.hash.slice(0, 10)}…</a>`);
    await tx.wait(); log("day closed ✓", "ok"); refreshAuction();
  } catch (e) { log("close failed: " + reason(e), "err"); }
}
async function claimAuction(day) {
  try {
    const v = auctionContract(signer);
    const tx = await v.claim(day, { type: 0, gasLimit: GAS.approve });
    log(`claim day ${day} <a href="${ex(tx.hash)}" target="_blank">${tx.hash.slice(0, 10)}…</a>`);
    await tx.wait(); log("claimed ✓", "ok"); refreshAuction();
  } catch (e) { log("claim failed: " + reason(e), "err"); }
}

$("btnConnect").onclick = connect;
$("btnLaunch").onclick = launch;
$("btnBuy").onclick = buy;
$("btnSell").onclick = sell;
$("btnGrad").onclick = graduate;
$("btnRefresh").onclick = refresh;
$("btnAuctionRefresh").onclick = refreshAuction;

// Signals to the non-module bootstrap diagnostic (index.html) that the ES module graph loaded and
// every button handler is attached. If this never runs, the page shows a "did not initialize" banner.
window.__APP_READY__ = true;
console.log("Robin V4 bench ready — handlers attached.");
