// End-to-end guards for the Uniswap proxy ROUTE HANDLERS (the money path): handleQuote/handleSwap/
// handleApproval, with the upstream Trading API stubbed via globalThis.fetch. Complements uni-proxy.test.mjs
// (which covers the pure sub-functions). Run: node --test indexer/test/uni-swap-handlers.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { ethers } from "ethers";

// config.js reads env at import; set BEFORE importing uniproxy.
process.env.UNISWAP_API_KEY = "test-key";
process.env.UNISWAP_CHAIN_ID = "4663";
process.env.UNISWAP_FEE_RECIPIENT = "0xCDD5ff5d521D3694c2a2F31eDF7cd3C0E9a6fabf";
process.env.UNISWAP_FEE_BIPS = "125";
process.env.UNISWAP_TOKENS = "0x020bfc650a365f8bb26819deaabf3e21291018b4";

const { handleQuote, handleSwap, handleApproval } = await import("../src/uniproxy.js");

const NATIVE = "0x0000000000000000000000000000000000000000";
const CASHCAT = "0x020bfc650a365f8bb26819deaabf3e21291018b4";
const OFFLIST = "0x1111111111111111111111111111111111111111";
const SWAPPER = "0x2aA74C8d97d89a7Cac1243262479687e5Db30eF8";
const FEE_LC = "0xcdd5ff5d521d3694c2a2f31edf7cd3c0e9a6fabf";
const UR = "0x8876789976decbfcbbbe364623c63652db8c0904";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";

const coder = ethers.AbiCoder.defaultAbiCoder();
// A Universal Router execute(commands, inputs) with a V3_SWAP (0x00) then a PAY_PORTION (0x06) on `feeToken`.
function swapData(feeToken, recipient, bips) {
  const iface = new ethers.Interface(["function execute(bytes commands, bytes[] inputs)"]);
  const commands = "0x0006";
  const swapInput = coder.encode(["address", "uint256", "uint256", "bytes", "bool"], [SWAPPER, 1n, 0n, "0x", true]);
  const payInput = coder.encode(["address", "address", "uint256"], [feeToken, recipient, bips]);
  return iface.encodeFunctionData("execute", [commands, [swapInput, payInput]]);
}
const approveData = (spender) => new ethers.Interface(["function approve(address spender, uint256 amount)"]).encodeFunctionData("approve", [spender, 100n]);

// One canned upstream response per handler call.
let NEXT = { status: 200, body: {} };
globalThis.fetch = async () => ({ status: NEXT.status, json: async () => NEXT.body });
const feeLeg = [{ recipient: FEE_LC, bps: 125, fee: "INTEGRATOR" }];

// ── handleQuote ────────────────────────────────────────────────────────────────
test("handleQuote: 200 only when the upstream quote actually carries our fee", async () => {
  const body = { type: "EXACT_INPUT", amount: "1000", tokenIn: NATIVE, tokenOut: CASHCAT, swapper: SWAPPER };
  NEXT = { status: 200, body: { quote: { chainId: 4663, input: { token: NATIVE }, output: { token: CASHCAT }, aggregatedOutputs: feeLeg } } };
  assert.equal((await handleQuote(body)).status, 200);
  NEXT = { status: 200, body: { quote: { chainId: 4663, aggregatedOutputs: [] } } };  // fee missing
  assert.equal((await handleQuote(body)).status, 502);
  assert.equal((await handleQuote({ amount: "1", tokenIn: NATIVE, tokenOut: OFFLIST, swapper: SWAPPER })).status, 400); // off-allowlist, never forwarded
});

// ── handleSwap ─────────────────────────────────────────────────────────────────
const buyQuote = { chainId: 4663, input: { token: NATIVE, amount: "1000" }, output: { token: CASHCAT, amount: "5" }, aggregatedOutputs: feeLeg };
test("handleSwap: 200 for a well-formed native-in buy that pays our fee on the output leg", async () => {
  NEXT = { status: 200, body: { swap: { to: UR, data: swapData(CASHCAT, FEE_LC, 125), value: "1000", chainId: 4663 } } };
  assert.equal((await handleSwap({ quote: buyQuote })).status, 200);
});
test("handleSwap: 502 on a wrong target, wrong chain, value mismatch, or a fee stripped/decoyed in calldata", async () => {
  NEXT = { status: 200, body: { swap: { to: SWAPPER, data: swapData(CASHCAT, FEE_LC, 125), value: "1000", chainId: 4663 } } };
  assert.equal((await handleSwap({ quote: buyQuote })).status, 502); // not the Universal Router
  NEXT = { status: 200, body: { swap: { to: UR, data: swapData(CASHCAT, FEE_LC, 125), value: "1000", chainId: 1 } } };
  assert.equal((await handleSwap({ quote: buyQuote })).status, 502); // wrong chain
  NEXT = { status: 200, body: { swap: { to: UR, data: swapData(CASHCAT, FEE_LC, 125), value: "999", chainId: 4663 } } };
  assert.equal((await handleSwap({ quote: buyQuote })).status, 502); // native-in value != quoted input
  NEXT = { status: 200, body: { swap: { to: UR, data: swapData(WETH, FEE_LC, 125), value: "1000", chainId: 4663 } } };
  assert.equal((await handleSwap({ quote: buyQuote })).status, 502); // WETH decoy on a buy -> ~0 fee
  NEXT = { status: 200, body: { swap: { to: UR, data: swapData(CASHCAT, FEE_LC, 1), value: "1000", chainId: 4663 } } };
  assert.equal((await handleSwap({ quote: buyQuote })).status, 502); // bips reduced ~125x
});
test("handleSwap: 400 on a quote that fails re-validation (missing fee / bad legs)", async () => {
  assert.equal((await handleSwap({ quote: { ...buyQuote, aggregatedOutputs: [] } })).status, 400);
  assert.equal((await handleSwap({})).status, 400); // no quote
});

// ── handleApproval ───────────────────────────────────────────────────────────────
test("handleApproval: only ever passes an approve(Permit2, _) of the exact sell token", async () => {
  NEXT = { status: 200, body: { approval: { to: CASHCAT, data: approveData(PERMIT2) } } };
  assert.equal((await handleApproval({ token: CASHCAT, walletAddress: SWAPPER })).status, 200);
  NEXT = { status: 200, body: { approval: { to: CASHCAT, data: approveData(SWAPPER) } } }; // spender not Permit2
  assert.equal((await handleApproval({ token: CASHCAT, walletAddress: SWAPPER })).status, 502);
  NEXT = { status: 200, body: { approval: { to: OFFLIST, data: approveData(PERMIT2) } } }; // approval target != token
  assert.equal((await handleApproval({ token: CASHCAT, walletAddress: SWAPPER })).status, 502);
  assert.equal((await handleApproval({ token: OFFLIST, walletAddress: SWAPPER })).status, 400); // off-allowlist, never forwarded
  NEXT = { status: 200, body: {} }; // no approval needed (already approved) -> passthrough 200
  assert.equal((await handleApproval({ token: CASHCAT, walletAddress: SWAPPER })).status, 200);
});
