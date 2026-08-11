// V4 testnet team-test app — launch (with in-browser hook mining), buy, sell, read, graduate.
// Talks straight to the deployed testnet contracts. TESTNET ONLY. No secrets, no backend.
import * as ethers from "./ethers.min.js";
import { CFG } from "./config.js";

const $ = (id) => document.getElementById(id);
const ZERO = "0x0000000000000000000000000000000000000000";
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
const FEE = 10000, TS = 60; // 1% pool fee, tickSpacing 60 (matches the governed geometry)
const abi = ethers.AbiCoder.defaultAbiCoder();

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

// ── LAUNCH ─────────────────────────────────────────────────────────────────────
async function launch() {
  const name = $("name").value.trim(), symbol = $("symbol").value.trim().toUpperCase();
  if (!name || !symbol) return log("Enter a name + symbol.", "err");
  const curveSupply = ethers.parseEther($("curveSupply").value || "470000");
  const reserveSupply = curveSupply; // safe: satisfies the factory reserve invariant
  const supply = curveSupply + reserveSupply + ethers.parseEther("100000"); // + launcher allocation

  const salt = (s) => ethers.id(s + ":" + Date.now() + ":" + Math.floor(performance.now()));
  const tokenSalt = salt("tok");
  const curveSalt = salt("curve");

  log("Predicting token address…");
  const tokenInit = ethers.concat([CFG.BYTECODE.padToken, abi.encode(["string", "string", "uint8", "uint256", "address"], [name, symbol, 18, supply, CFG.ADDR.factory])]);
  const token = ethers.getCreate2Address(CFG.ADDR.deployer, tokenSalt, ethers.keccak256(tokenInit));

  log(`Mining a valid hook address (flags 0x00C4)…`);
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
  const cfg = { name, symbol, decimals: 18, supply, curveSupply, reserveSupply, tickSpacing: TS, creator: me };
  try {
    const tx = await factory.launch(cfg, tokenSalt, hookSalt, curveSalt, { type: 0 });
    log(`launch tx <a href="${ex(tx.hash)}" target="_blank">${tx.hash.slice(0, 10)}…</a> — waiting…`);
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((p) => p && p.name === "CurvePadLaunched");
    const [, tk, , hk, cv] = ev.args;
    const key = poolKey(tk, hk);
    launched = { token: tk, hook: hk, curve: cv, poolId: poolIdOf(key), key, buyLimit: MIN_SQRT, sellLimit: MAX_SQRT };
    // Read the curve's immutable boundary ticks so buys cap at the ceiling (gradTick) and sells at the
    // launch top (startTick) — never crossing into empty liquidity, which reverts on this chain.
    try {
      const cc = new ethers.Contract(cv, CFG.ABI.curve, provider);
      const [gt, st] = await Promise.all([cc.gradTick(), cc.startTick()]);
      launched.gradTick = Number(gt); launched.startTick = Number(st);
      launched.buyLimit = sqrtAtTick(launched.gradTick);
      launched.sellLimit = sqrtAtTick(launched.startTick);
    } catch (e) { log("note: couldn't read curve ticks — using absolute price limits (buys may revert near sell-out)", "warn"); }
    log(`🚀 LAUNCHED <b>${symbol}</b> — token <a href="${exA(tk)}" target="_blank">${tk.slice(0, 8)}…</a> · curve <a href="${exA(cv)}" target="_blank">${cv.slice(0, 8)}…</a>`, "ok");
    $("trade").style.display = "block";
    $("coinLabel").textContent = `${name} (${symbol})`;
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
    try { await r.swap.staticCall(...args, { value: amt }); }
    catch (pe) { return log("buy would revert → " + reason(pe), "err"); }
    const tx = await r.swap(...args, { value: amt, type: 0, gasLimit: GAS.swap });
    log(`buy ${$("buyAmt").value} ETH <a href="${ex(tx.hash)}" target="_blank">${tx.hash.slice(0, 10)}…</a>`);
    await tx.wait(); log("buy filled ✓", "ok"); refresh();
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
    try { await r.swap.staticCall(...args); }
    catch (pe) { return log("sell would revert → " + reason(pe), "err"); }
    const tx = await r.swap(...args, { type: 0, gasLimit: GAS.swap });
    log(`sell half <a href="${ex(tx.hash)}" target="_blank">${tx.hash.slice(0, 10)}…</a>`);
    await tx.wait(); log("sell filled ✓", "ok"); refresh();
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

$("btnConnect").onclick = connect;
$("btnLaunch").onclick = launch;
$("btnBuy").onclick = buy;
$("btnSell").onclick = sell;
$("btnGrad").onclick = graduate;
$("btnRefresh").onclick = refresh;

// Signals to the non-module bootstrap diagnostic (index.html) that the ES module graph loaded and
// every button handler is attached. If this never runs, the page shows a "did not initialize" banner.
window.__APP_READY__ = true;
console.log("Robin V4 bench ready — handlers attached.");
