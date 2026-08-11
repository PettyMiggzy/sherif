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
    launched = { token: tk, hook: hk, curve: cv, poolId: poolIdOf(key), key };
    log(`🚀 LAUNCHED <b>${symbol}</b> — token <a href="${exA(tk)}" target="_blank">${tk.slice(0, 8)}…</a> · curve <a href="${exA(cv)}" target="_blank">${cv.slice(0, 8)}…</a>`, "ok");
    $("trade").style.display = "block";
    $("coinLabel").textContent = `${name} (${symbol})`;
    refresh();
  } catch (e) { log("launch failed: " + (e.shortMessage || e.message), "err"); }
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
    const amt = ethers.parseEther($("buyAmt").value || "0.001");
    const r = router();
    const tx = await r.swap(launched.key, { zeroForOne: true, amountSpecified: -amt, sqrtPriceLimitX96: MIN_SQRT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: amt, type: 0 });
    log(`buy ${$("buyAmt").value} ETH <a href="${ex(tx.hash)}" target="_blank">${tx.hash.slice(0, 10)}…</a>`);
    await tx.wait(); log("buy filled ✓", "ok"); refresh();
  } catch (e) { log("buy failed: " + (e.shortMessage || e.message), "err"); }
}
async function sell() {
  if (!launched) return;
  try {
    const tok = new ethers.Contract(launched.token, CFG.ABI.token, signer);
    const bal = await tok.balanceOf(me);
    const amt = bal / 2n; // sell half
    if (amt === 0n) return log("Nothing to sell.", "warn");
    const r = router();
    await (await tok.approve(await r.getAddress(), ethers.MaxUint256, { type: 0 })).wait();
    const tx = await r.swap(launched.key, { zeroForOne: false, amountSpecified: -amt, sqrtPriceLimitX96: MAX_SQRT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { type: 0 });
    log(`sell half <a href="${ex(tx.hash)}" target="_blank">${tx.hash.slice(0, 10)}…</a>`);
    await tx.wait(); log("sell filled ✓", "ok"); refresh();
  } catch (e) { log("sell failed: " + (e.shortMessage || e.message), "err"); }
}
async function graduate() {
  if (!launched) return;
  try {
    const curve = new ethers.Contract(launched.curve, CFG.ABI.curve, signer);
    const tx = await curve.graduate({ type: 0 });
    log(`graduate <a href="${ex(tx.hash)}" target="_blank">${tx.hash.slice(0, 10)}…</a> — waiting…`);
    await tx.wait(); log("🎓 GRADUATED — permanent LP locked, floor seeded.", "ok"); refresh();
  } catch (e) { log("graduate failed: " + (e.shortMessage || e.message), "err"); }
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
  } catch (e) { /* pool may not be readable until first read */ }
}

$("btnConnect").onclick = connect;
$("btnLaunch").onclick = launch;
$("btnBuy").onclick = buy;
$("btnSell").onclick = sell;
$("btnGrad").onclick = graduate;
$("btnRefresh").onclick = refresh;
