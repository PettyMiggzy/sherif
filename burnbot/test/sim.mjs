// Offline simulation of the buyback→burn path against a mock JSON-RPC node.
// Runs the REAL burn.js logic — asserts legacy type-0 txs, a positive-quote
// slippage floor, the buy→transfer-to-DEAD sequence, and the spend math.
//   RPC_URL=x BURN_PRIVATE_KEY=0x… node test/sim.mjs
import assert from 'node:assert';
import { ethers } from 'ethers';
import { ADDR, DEAD, CHAIN } from '../config.js';
import { buybackBurn, spendAmount, burnHeld, pruneHistory, dipReference, isDip } from '../burn.js';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('  ✓', m); pass++; };
const hex = (n) => '0x' + BigInt(n).toString(16);
const H32 = (b) => '0x' + String(b).repeat(64).slice(0, 64);
const GWEI = 10n ** 9n;
const erc20I = new ethers.Interface(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);

const sent = [];
class Mock extends ethers.JsonRpcProvider {
  constructor() { super('http://mock', { chainId: CHAIN.id, name: 'robinhood' }, { staticNetwork: true, batchMaxCount: 1 }); }
  async _send(payload) {
    const reqs = Array.isArray(payload) ? payload : [payload];
    return reqs.map((r) => ({ id: r.id, jsonrpc: '2.0', result: this._d(r.method, r.params || []) }));
  }
  _d(m, p) {
    switch (m) {
      case 'eth_chainId': return hex(CHAIN.id);
      case 'eth_blockNumber': return hex(0x100);
      case 'eth_gasPrice': return hex(GWEI);
      case 'eth_getTransactionCount': return hex(0);
      case 'eth_estimateGas': return hex(300000);
      case 'eth_getBalance': return hex(ethers.parseEther('1'));
      case 'eth_maxPriorityFeePerGas': return hex(0);
      case 'eth_getBlockByNumber': case 'eth_getBlockByHash':
        return { number: hex(0x100), hash: H32('11'), parentHash: H32('22'), nonce: '0x0000000000000000', timestamp: hex(1784880000), gasLimit: hex(3e7), gasUsed: hex(1e6), miner: ADDR.router, extraData: '0x', transactions: [], difficulty: '0x0' };
      case 'eth_call': {
        // router.buy quote → uint256 tokensOut; erc20.balanceOf → uint256
        const data = p[0]?.data || '';
        if (data.startsWith('0x70a08231')) return ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [ethers.parseEther('1000000')]); // balanceOf
        return ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [ethers.parseEther('1000000')]); // buy quote
      }
      case 'eth_sendRawTransaction': {
        const tx = ethers.Transaction.from(p[0]);
        ok(tx.type === 0, `tx is legacy type-0 (to ${tx.to?.slice(0, 8)})`);
        ok(tx.gasPrice > 0n, 'tx has explicit gasPrice');
        const kind = (tx.to || '').toLowerCase() === ADDR.router.toLowerCase() ? 'buy' : 'burn';
        if (kind === 'burn') {
          const dec = erc20I.decodeFunctionData('transfer', tx.data);
          ok(dec[0].toLowerCase() === DEAD.toLowerCase(), 'burn transfer goes to the DEAD address');
          ok(dec[1] > 0n, 'burn transfers a positive amount');
        }
        sent.push({ hash: tx.hash, kind });
        return tx.hash;
      }
      case 'eth_getTransactionReceipt':
        return { status: '0x1', blockNumber: hex(0x100), blockHash: H32('11'), transactionHash: p[0], transactionIndex: '0x0', from: ADDR.router, to: ADDR.router, contractAddress: null, gasUsed: hex(2e5), cumulativeGasUsed: hex(2e5), effectiveGasPrice: hex(GWEI), logsBloom: '0x' + '00'.repeat(256), type: '0x0', logs: [] };
      default: throw new Error('mock: unhandled ' + m);
    }
  }
}

(async () => {
  // spendAmount math
  const one = ethers.parseEther('1');
  ok(spendAmount({ balanceWei: one, buyback: 'max', gasReserveWei: ethers.parseEther('0.003'), minBalanceWei: ethers.parseEther('0.01') }) === one - ethers.parseEther('0.003'), 'max spend = balance - gas reserve');
  ok(spendAmount({ balanceWei: one, buyback: '0.1', gasReserveWei: ethers.parseEther('0.003'), minBalanceWei: ethers.parseEther('0.01') }) === ethers.parseEther('0.1'), 'fixed spend honored');
  ok(spendAmount({ balanceWei: ethers.parseEther('0.005'), buyback: 'max', gasReserveWei: ethers.parseEther('0.003'), minBalanceWei: ethers.parseEther('0.01') }) === 0n, 'below min balance → spend 0');
  ok(spendAmount({ balanceWei: ethers.parseEther('0.05'), buyback: '1', gasReserveWei: ethers.parseEther('0.003'), minBalanceWei: ethers.parseEther('0.01') }) === ethers.parseEther('0.05') - ethers.parseEther('0.003'), 'fixed spend never digs into the gas reserve');

  const mock = new Mock();
  const wallet = ethers.Wallet.createRandom().connect(mock);
  const r = await buybackBurn(wallet, mock, { token: '0x6696FE29288B586017E6f264c0091DBA6C5ebeaf', spendWei: ethers.parseEther('0.1'), slippagePct: 15 });
  ok(r.ethSpent === ethers.parseEther('0.1'), 'buyback recorded the ETH spent');
  ok(r.tokensBurned > 0n, 'tokens were burned');
  ok(r.buyHash && r.burnHash && r.buyHash !== r.burnHash, 'distinct buy + burn tx hashes');
  ok(sent.filter((s) => s.kind === 'buy').length === 1 && sent.filter((s) => s.kind === 'burn').length === 1, 'exactly one buy and one burn tx');

  // held-token burn: any ROBIN in the wallet is transferred to DEAD
  const held = await burnHeld(wallet, mock, '0x6696FE29288B586017E6f264c0091DBA6C5ebeaf');
  ok(held && held.tokensBurned > 0n && held.hash, 'burnHeld sends the held balance to DEAD');

  // dip logic (pure)
  ok(dipReference([{ ts: 1, price: 10 }, { ts: 2, price: 20 }]) === 15, 'dipReference = window average');
  ok(dipReference([]) === null, 'no history → null reference');
  ok(isDip(90, 100, 4) === true, '90 vs ref 100 is a >4% dip');
  ok(isDip(97, 100, 4) === false, '97 vs ref 100 is not a 4% dip');
  ok(isDip(200, null, 4) === false, 'no reference → not a dip (wait for baseline)');
  ok(isDip(200, 100, 0) === true, 'dipPct=0 → always buy');
  ok(pruneHistory([{ ts: 1000, price: 1 }, { ts: 999999999, price: 2 }], 999999999, 48).length === 1, 'pruneHistory drops samples older than the window');

  // quote-revert → abort (no unprotected buy)
  mock._d = ((orig) => function (m, p) { if (m === 'eth_call' && !(p[0]?.data || '').startsWith('0x70a08231')) throw new Error('execution reverted'); return orig.call(this, m, p); })(mock._d);
  let aborted = false;
  try { await buybackBurn(wallet, mock, { token: '0x6696FE29288B586017E6f264c0091DBA6C5ebeaf', spendWei: ethers.parseEther('0.1'), slippagePct: 15 }); } catch { aborted = true; }
  ok(aborted, 'buyback aborts when the quote reverts');

  console.log(`\n${pass} simulation checks passed`);
})().catch((e) => { console.error('SIM FAILED:', e); process.exit(1); });
