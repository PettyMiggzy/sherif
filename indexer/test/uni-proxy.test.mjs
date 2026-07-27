// Uniswap proxy logic tests (no network): input validation, allowlist, server-side fee injection,
// the request(`bips`)-vs-response(`bps`) fee assertion, and the /swap quote re-check.
//   Run: node --test indexer/test/uni-proxy.test.mjs
import { test } from "node:test";
import assert from "node:assert";

// Set config BEFORE importing (config.js reads process.env at import; it only fills gaps from .env).
process.env.UNISWAP_API_KEY = "test-key";
process.env.UNISWAP_CHAIN_ID = "4663";
process.env.UNISWAP_FEE_RECIPIENT = "0xCDD5ff5d521D3694c2a2F31eDF7cd3C0E9a6fabf";
process.env.UNISWAP_FEE_BIPS = "125";
process.env.UNISWAP_TOKENS = "0x020bfc650a365f8bb26819deaabf3e21291018b4,0x45f82ac5d507e988f7406935da8eefe495a360e0";

const { ethers } = await import("ethers");
const { _internal } = await import("../src/uniproxy.js");
const { buildQuoteUpstream, validateQuote, validateSwapQuote, feeApplied, feeInCalldata } = _internal;

const NATIVE = "0x0000000000000000000000000000000000000000";
const CASHCAT = "0x020bfc650a365f8bb26819deaabf3e21291018b4";
const OFFLIST = "0x1111111111111111111111111111111111111111";
const SWAPPER = "0x2aA74C8d97d89a7Cac1243262479687e5Db30eF8";
const FEE_LC = "0xcdd5ff5d521d3694c2a2f31edf7cd3c0e9a6fabf";

test("buildQuoteUpstream injects OUR fee, ignores the client's, forces EXACT_INPUT + chain 4663", () => {
  const up = buildQuoteUpstream({
    type: "EXACT_INPUT", amount: "1000000000000000", tokenIn: NATIVE, tokenOut: CASHCAT, swapper: SWAPPER,
    integratorFees: [{ recipient: "0xAttacker000000000000000000000000000000001", bips: 9999 }], // must be discarded
    slippageTolerance: 8,
  });
  assert.equal(up.type, "EXACT_INPUT");
  assert.equal(up.tokenInChainId, 4663);
  assert.equal(up.tokenOutChainId, 4663);
  assert.deepEqual(up.integratorFees, [{ recipient: FEE_LC, bips: 125 }]); // ours only
  assert.equal(up.slippageTolerance, 8);
});

test("buildQuoteUpstream clamps out-of-range slippage (drops it)", () => {
  assert.equal(buildQuoteUpstream({ amount: "1", tokenIn: NATIVE, tokenOut: CASHCAT, swapper: SWAPPER, slippageTolerance: 99 }).slippageTolerance, undefined);
  assert.equal(buildQuoteUpstream({ amount: "1", tokenIn: NATIVE, tokenOut: CASHCAT, swapper: SWAPPER, slippageTolerance: 5 }).slippageTolerance, 5);
});

test("validateQuote accepts a well-formed native->token request", () => {
  assert.equal(validateQuote({ type: "EXACT_INPUT", amount: "1000000000000000", tokenIn: NATIVE, tokenOut: CASHCAT, swapper: SWAPPER }), null);
});

test("validateQuote rejects: off-allowlist, same token, no native leg, zero/bad amount, bad addr", () => {
  assert.match(validateQuote({ amount: "1", tokenIn: NATIVE, tokenOut: OFFLIST, swapper: SWAPPER }), /allowlist/);
  assert.match(validateQuote({ amount: "1", tokenIn: CASHCAT, tokenOut: CASHCAT, swapper: SWAPPER }), /==|allowlist|native/);
  assert.match(validateQuote({ amount: "1", tokenIn: CASHCAT, tokenOut: CASHCAT, swapper: SWAPPER }), /./);
  assert.match(validateQuote({ amount: "0", tokenIn: NATIVE, tokenOut: CASHCAT, swapper: SWAPPER }), /amount/);
  assert.match(validateQuote({ amount: "000", tokenIn: NATIVE, tokenOut: CASHCAT, swapper: SWAPPER }), /amount/);
  assert.match(validateQuote({ amount: "1", tokenIn: "0xnothex", tokenOut: CASHCAT, swapper: SWAPPER }), /token/);
  assert.match(validateQuote({ amount: "1", tokenIn: NATIVE, tokenOut: CASHCAT, swapper: "0xbad" }), /swapper/);
  // token<->token with no native side (both allowlisted but neither native)
  assert.match(validateQuote({ amount: "1", tokenIn: CASHCAT, tokenOut: "0x45f82ac5d507e988f7406935da8eefe495a360e0", swapper: SWAPPER }), /native/);
});

test("feeApplied reads the RESPONSE field `bps` and requires our recipient + INTEGRATOR", () => {
  const good = { aggregatedOutputs: [
    { recipient: SWAPPER, bps: 9875, amount: "100" },
    { recipient: "0xCDD5ff5d521D3694c2a2F31eDF7cd3C0E9a6fabf", bps: 125, amount: "2", fee: "INTEGRATOR" }, // checksummed on purpose
  ]};
  assert.equal(feeApplied(good), true);
  // wrong bps value
  assert.equal(feeApplied({ aggregatedOutputs: [{ recipient: FEE_LC, bps: 100, fee: "INTEGRATOR" }] }), false);
  // wrong recipient
  assert.equal(feeApplied({ aggregatedOutputs: [{ recipient: SWAPPER, bps: 125, fee: "INTEGRATOR" }] }), false);
  // not tagged INTEGRATOR
  assert.equal(feeApplied({ aggregatedOutputs: [{ recipient: FEE_LC, bps: 125 }] }), false);
  // no outputs
  assert.equal(feeApplied({}), false);
});

test("feeInCalldata enforces PAY_PORTION recipient + exact bips + a real leg token (blocks bips and decoy-token attacks)", () => {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
  const iface2 = new ethers.Interface(["function execute(bytes commands, bytes[] inputs)"]);
  const iface3 = new ethers.Interface(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);
  // commands: V3_SWAP_EXACT_IN (0x00) then PAY_PORTION (0x06); inputs sized to match.
  const exec = (iface, feeToken, recipient, bips) => {
    const commands = "0x0006";
    const swapInput = coder.encode(["address", "uint256", "uint256", "bytes", "bool"], [SWAPPER, 1n, 0n, "0x", true]);
    const payInput = coder.encode(["address", "address", "uint256"], [feeToken, recipient, bips]);
    const args = [commands, [swapInput, payInput]];
    if (iface === iface3) args.push(1893456000n); // deadline
    return iface.encodeFunctionData("execute", args);
  };
  // buy leg: tokenIn = native, tokenOut = CASHCAT -> allowed fee tokens {CASHCAT, WETH}
  assert.equal(feeInCalldata(exec(iface2, WETH, FEE_LC, 125), NATIVE, CASHCAT), true);      // fee on WETH leg
  assert.equal(feeInCalldata(exec(iface2, CASHCAT, FEE_LC, 125), NATIVE, CASHCAT), true);   // fee on the output leg
  assert.equal(feeInCalldata(exec(iface3, WETH, FEE_LC, 125), NATIVE, CASHCAT), true);      // 3-arg variant decodes
  assert.equal(feeInCalldata(exec(iface2, WETH, FEE_LC, 1), NATIVE, CASHCAT), false);       // bips reduced ~125x
  assert.equal(feeInCalldata(exec(iface2, WETH, SWAPPER, 125), NATIVE, CASHCAT), false);    // fee redirected
  assert.equal(feeInCalldata(exec(iface2, OFFLIST, FEE_LC, 125), NATIVE, CASHCAT), false);  // DECOY token (router holds ~0) -> reject
  assert.equal(feeInCalldata("0xdeadbeef", NATIVE, CASHCAT), false);                        // unparseable -> reject
});

test("validateSwapQuote re-checks chain, allowlist, one-native-leg, and fee presence", () => {
  const q = { chainId: 4663, input: { token: NATIVE }, output: { token: CASHCAT },
    aggregatedOutputs: [{ recipient: FEE_LC, bps: 125, fee: "INTEGRATOR" }] };
  assert.equal(validateSwapQuote(q), null);
  assert.match(validateSwapQuote({ ...q, chainId: 1 }), /chain/);
  assert.match(validateSwapQuote({ ...q, output: { token: OFFLIST } }), /allowlist/);
  assert.match(validateSwapQuote({ ...q, aggregatedOutputs: [] }), /fee/);
  assert.match(validateSwapQuote({ ...q, input: { token: CASHCAT }, output: { token: CASHCAT } }), /native|allowlist/);
});
