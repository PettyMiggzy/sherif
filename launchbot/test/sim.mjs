// ─────────────────────────────────────────────────────────────────────────────
// Offline end-to-end simulation of the bot's on-chain paths.
//
// A mock JSON-RPC provider stands in for Robinhood Chain so the REAL chain.js
// (launch / buy / sell / withdraw) runs without a live node. This exercises the
// legacy (type-0) tx encoding, the gas clamp, quote→minOut decoding, and the
// Launched event parse — the runtime paths unit tests can't reach.
//
//   TELEGRAM_BOT_TOKEN=… RPC_URL=… MASTER_SECRET=… node test/sim.mjs
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert';
import { ethers } from 'ethers';
import { ADDRESSES, ABI, CHAIN } from '../config.js';
import * as chain from '../chain.js';

const GWEI = 10n ** 9n;
const factoryIface = new ethers.Interface(ABI.factory);
const LAUNCHED = factoryIface.getEvent('Launched');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('  ✓', m); pass++; };
const hex = (n) => '0x' + BigInt(n).toString(16);
const H32 = (b) => '0x' + String(b).repeat(64).slice(0, 64);

// Records the last-sent tx kinds and the legacy-type assertion.
const sent = [];

class MockProvider extends ethers.JsonRpcProvider {
  constructor() {
    super('http://mock', { chainId: CHAIN.id, name: 'robinhood' }, { staticNetwork: true, batchMaxCount: 1 });
    this.balance = ethers.parseEther('10');
  }
  async _send(payload) {
    const reqs = Array.isArray(payload) ? payload : [payload];
    const out = reqs.map((r) => ({ id: r.id, jsonrpc: '2.0', result: this._dispatch(r.method, r.params || []) }));
    return out;
  }
  _dispatch(method, params) {
    switch (method) {
      case 'eth_chainId': return hex(CHAIN.id);
      case 'eth_blockNumber': return hex(0x100);
      case 'eth_gasPrice': return hex(GWEI); // 1 gwei, legacy
      case 'eth_getBalance': return hex(this.balance);
      case 'eth_getTransactionCount': return hex(0);
      case 'eth_estimateGas': return hex(2_000_000);
      case 'eth_maxPriorityFeePerGas': return hex(0);
      case 'eth_getBlockByNumber':
      case 'eth_getBlockByHash':
        // NB: no baseFeePerGas → getFeeData uses the legacy gasPrice path.
        return {
          number: hex(0x100), hash: H32('11'), parentHash: H32('22'), nonce: '0x0000000000000000',
          timestamp: hex(1784880000), gasLimit: hex(30_000_000), gasUsed: hex(1_000_000),
          miner: ADDRESSES.router, extraData: '0x', transactions: [], difficulty: '0x0',
        };
      case 'eth_call':
        // Every view here (a buy/sell quote, or an erc20 allowance/balance) returns
        // a single uint256. A large value gives a positive quote and a huge
        // allowance (so the sell path skips approve).
        return ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [ethers.parseEther('1000')]);
      case 'eth_sendRawTransaction': {
        const tx = ethers.Transaction.from(params[0]);
        ok(tx.type === 0, `broadcast tx is legacy type-0 (to ${tx.to?.slice(0, 8)})`);
        ok(tx.gasPrice != null && tx.gasPrice > 0n, 'broadcast tx carries an explicit gasPrice');
        ok(BigInt(tx.gasLimit) < BigInt(CHAIN.perTxGasCap), 'gasLimit under the 2^24 cap');
        const kind = (tx.to || '').toLowerCase() === ADDRESSES.factory.toLowerCase() ? 'launch'
          : (tx.to || '').toLowerCase() === ADDRESSES.router.toLowerCase() ? 'trade' : 'transfer';
        sent.push({ hash: tx.hash, kind, to: tx.to });
        return tx.hash;
      }
      case 'eth_getTransactionReceipt': {
        const rec = sent.find((s) => s.hash === params[0]);
        const kind = rec ? rec.kind : 'transfer';
        const logs = [];
        if (kind === 'launch') {
          const token = ADDRESSES.weth < ADDRESSES.router ? '0x000000000000000000000000000000000000c0de' : '0x000000000000000000000000000000000000C0DE';
          const enc = factoryIface.encodeEventLog(LAUNCHED, [
            '0x000000000000000000000000000000000000C0DE', // token
            '0x000000000000000000000000000000000000cafe', // curve
            '0x000000000000000000000000000000000000BEEF', // pool
            '0x000000000000000000000000000000000000dEaD', // dev
            ethers.parseEther('42'),                      // devBought
          ]);
          logs.push({
            address: ADDRESSES.factory, topics: enc.topics, data: enc.data,
            blockNumber: hex(0x100), blockHash: H32('11'), transactionHash: params[0],
            transactionIndex: '0x0', logIndex: '0x0', removed: false,
          });
        }
        return {
          status: '0x1', blockNumber: hex(0x100), blockHash: H32('11'), transactionHash: params[0],
          transactionIndex: '0x0', from: ADDRESSES.router, to: rec?.to || ADDRESSES.router,
          contractAddress: null, gasUsed: hex(500_000), cumulativeGasUsed: hex(500_000),
          effectiveGasPrice: hex(GWEI), logsBloom: '0x' + '00'.repeat(256), type: '0x0', logs,
        };
      }
      default:
        throw new Error('mock: unhandled ' + method);
    }
  }
}

(async () => {
  const mock = new MockProvider();
  chain.__setProviderForTests(mock);
  const wallet = ethers.Wallet.createRandom().connect(mock);

  // 1) legacyOv shape + null-guard
  const ov = await chain.legacyOv();
  ok(ov.type === 0 && ov.gasPrice === GWEI, 'legacyOv() → {type:0, gasPrice}');

  // 2) LAUNCH — parses the Launched event, returns addresses
  const res = await chain.launch(wallet, { name: 'Sim Coin', symbol: 'SIM', devBuyWei: ethers.parseEther('0.1') });
  ok(res.token?.toLowerCase() === '0x000000000000000000000000000000000000c0de', 'launch parsed token from Launched event');
  ok(res.curve?.toLowerCase() === '0x000000000000000000000000000000000000cafe', 'launch parsed curve');
  ok(res.pool?.toLowerCase() === '0x000000000000000000000000000000000000beef', 'launch parsed pool');
  ok(res.devBought === ethers.parseEther('42'), 'launch parsed devBought');

  // 3) BUY — quotes then sends a legacy trade tx
  const buy = await chain.buy(wallet, res.token, ethers.parseEther('0.05'));
  ok(typeof buy.hash === 'string' && buy.hash.startsWith('0x'), 'buy returned a tx hash');

  // 4) SELL — allowance (mock huge → skip approve), quote, send
  const sell = await chain.sell(wallet, res.token, ethers.parseEther('100'));
  ok(typeof sell.hash === 'string', 'sell returned a tx hash');

  // 5) WITHDRAW — sweeps balance minus gas
  const wd = await chain.withdrawAll(wallet, '0x000000000000000000000000000000000000dEaD');
  ok(wd && wd.sent > 0n && wd.sent < mock.balance, 'withdrawAll sweeps balance minus gas');
  ok(wd.sent === mock.balance - GWEI * 21000n, 'withdraw amount = balance - gasPrice*21000 (exact)');

  // 6) quote-revert → abort (no zero-protection trade)
  mock._dispatch = ((orig) => function (m, p) {
    if (m === 'eth_call') throw new Error('execution reverted'); // simulate a reverting quote
    return orig.call(this, m, p);
  })(mock._dispatch);
  let aborted = false;
  try { await chain.buy(wallet, res.token, ethers.parseEther('0.05')); } catch { aborted = true; }
  ok(aborted, 'buy ABORTS when the quote reverts (never trades with 0 slippage protection)');

  console.log(`\n${pass} simulation checks passed`);
})().catch((e) => { console.error('SIM FAILED:', e); process.exit(1); });
