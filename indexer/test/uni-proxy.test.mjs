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
  // BUY leg (tokenIn=native, tokenOut=CASHCAT): fee must be on the OUTPUT token only.
  assert.equal(feeInCalldata(exec(iface2, CASHCAT, FEE_LC, 125), NATIVE, CASHCAT), true);   // fee on the output leg
  assert.equal(feeInCalldata(exec(iface3, CASHCAT, FEE_LC, 125), NATIVE, CASHCAT), true);   // 3-arg variant decodes
  assert.equal(feeInCalldata(exec(iface2, WETH, FEE_LC, 125), NATIVE, CASHCAT), false);     // WETH decoy on a BUY -> reject (~0-balance strip)
  assert.equal(feeInCalldata(exec(iface2, CASHCAT, FEE_LC, 1), NATIVE, CASHCAT), false);    // bips reduced ~125x
  assert.equal(feeInCalldata(exec(iface2, CASHCAT, SWAPPER, 125), NATIVE, CASHCAT), false); // fee redirected
  assert.equal(feeInCalldata(exec(iface2, OFFLIST, FEE_LC, 125), NATIVE, CASHCAT), false);  // decoy token -> reject
  assert.equal(feeInCalldata("0xdeadbeef", NATIVE, CASHCAT), false);                        // unparseable -> reject
  // SELL leg (tokenIn=CASHCAT, tokenOut=native): fee is on WETH ONLY (pre-unwrap).
  assert.equal(feeInCalldata(exec(iface2, WETH, FEE_LC, 125), CASHCAT, NATIVE), true);      // fee on WETH -> accept
  assert.equal(feeInCalldata(exec(iface2, CASHCAT, FEE_LC, 125), CASHCAT, NATIVE), false);  // fee on tin (swapped away) -> reject (~0-balance strip)
  assert.equal(feeInCalldata(exec(iface2, OFFLIST, FEE_LC, 125), CASHCAT, NATIVE), false);  // decoy on a sell -> reject
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

// The Universal Router deployed on Robinhood Chain (4663) takes the integrator fee via command 0x07 with
// bips as a 1e18 WAD (125 -> 125*1e14 = 12500000000000000), NOT the classic 0x06 PAY_PORTION with integer
// bips. These guard against a regression that would 502 every real swap (the fee guard looking in the
// wrong place / comparing the wrong encoding). WAD (1.25e16) also exceeds Number.MAX_SAFE_INTEGER, so the
// comparison must be BigInt.
const WAD_BIPS = 125n * 100000000000000n; // 12500000000000000
const feeCmd = (feeToken, recipient, bipsVal, cmdByte) => {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const iface = new ethers.Interface(["function execute(bytes commands, bytes[] inputs)"]);
  const commands = "0x00" + cmdByte;                                             // V3_SWAP_EXACT_IN then the fee command
  const swapInput = coder.encode(["address", "uint256", "uint256", "bytes", "bool"], [SWAPPER, 1n, 0n, "0x", true]);
  const feeInput = coder.encode(["address", "address", "uint256"], [feeToken, recipient, bipsVal]);
  return iface.encodeFunctionData("execute", [commands, [swapInput, feeInput]]);
};

test("feeInCalldata accepts the 4663 fee command 0x07 with WAD bips (and still the classic 0x06 integer)", () => {
  const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
  // 0x07 + WAD, buy: fee on OUTPUT token -> accept
  assert.equal(feeInCalldata(feeCmd(CASHCAT, FEE_LC, WAD_BIPS, "07"), NATIVE, CASHCAT), true);
  // 0x07 + WAD, sell: fee on WETH -> accept
  assert.equal(feeInCalldata(feeCmd(WETH, FEE_LC, WAD_BIPS, "07"), CASHCAT, NATIVE), true);
  // classic 0x06 + integer 125 still works
  assert.equal(feeInCalldata(feeCmd(CASHCAT, FEE_LC, 125n, "06"), NATIVE, CASHCAT), true);
  // WAD on a BUY but on WETH (decoy) -> reject
  assert.equal(feeInCalldata(feeCmd(WETH, FEE_LC, WAD_BIPS, "07"), NATIVE, CASHCAT), false);
  // WAD but wrong recipient -> reject
  assert.equal(feeInCalldata(feeCmd(CASHCAT, SWAPPER, WAD_BIPS, "07"), NATIVE, CASHCAT), false);
  // reduced WAD (1 bip) -> reject (bips attack)
  assert.equal(feeInCalldata(feeCmd(CASHCAT, FEE_LC, 1n * 100000000000000n, "07"), NATIVE, CASHCAT), false);
});

test("feeInCalldata accepts REAL live-captured Universal Router calldata (buy + sell)", async () => {
  const { readFileSync } = await import("node:fs");
  const fx = JSON.parse(readFileSync(new URL("./fixtures-uni-calldata.json", import.meta.url), "utf8"));
  // buy: native -> CASHCAT, fee legitimately on the OUTPUT (CASHCAT)
  assert.equal(feeInCalldata(fx.buyData, fx.native, fx.cashcat), true, "real buy calldata must pass");
  // sell: CASHCAT -> native, fee legitimately on WETH
  assert.equal(feeInCalldata(fx.sellData, fx.cashcat, fx.native), true, "real sell calldata must pass");
  // leg-binding still holds: the buy's fee (on CASHCAT) must NOT validate if the swap claims to be a sell
  assert.equal(feeInCalldata(fx.buyData, fx.cashcat, fx.native), false, "leg binding must reject a mislabeled buy");
});
