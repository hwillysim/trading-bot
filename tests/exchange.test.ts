import test from 'node:test';
import assert from 'node:assert/strict';
import { AmbiguousOrderError, BinanceSpotAdapter } from '../src/exchange/binance.ts';
import type { SymbolRules } from '../src/shared/types.ts';

const rules: SymbolRules = { symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT', minNotional: 10, minQty: 0.0001, stepSize: 0.0001, tickSize: 0.01 };
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const order = { symbol: 'BTCUSDT', orderId: 1, clientOrderId: 'cid-1', status: 'NEW', side: 'BUY', type: 'LIMIT', origQty: '0.001', executedQty: '0', cummulativeQuoteQty: '0', price: '10000' };

test('defaults to disabled and requires both construction flag and runtime arm', async () => {
  const adapter = new BinanceSpotAdapter({ apiKey: 'key', apiSecret: 'secret', fetcher: async () => ok(order) });
  await assert.rejects(adapter.submitLimitOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: 0.001, price: 10000, clientOrderId: 'cid-1' }, rules), /gate is closed/);
  assert.throws(() => adapter.armLiveOrders(), /disabled at construction/);
});

test('validates exchange filters and floors quantity and price precision', async () => {
  const urls: string[] = [];
  const adapter = new BinanceSpotAdapter({ apiKey: 'key', apiSecret: 'secret', liveEnabled: true, fetcher: async (input) => { urls.push(String(input)); return ok(order); } });
  adapter.armLiveOrders();
  await assert.rejects(adapter.submitLimitOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: 0.001, price: 9999, clientOrderId: 'cid-small' }, rules), /minimum notional/);
  await adapter.submitLimitOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: 0.00129, price: 10000.019, clientOrderId: 'cid-1' }, rules);
  const url = new URL(urls[0]!);
  assert.equal(url.origin, 'https://api.binance.com');
  assert.equal(url.searchParams.get('quantity'), '0.0012');
  assert.equal(url.searchParams.get('price'), '10000.01');
  assert.equal(url.searchParams.get('newClientOrderId'), 'cid-1');
  assert.ok(url.searchParams.get('signature'));
});

test('uses testnet and recovers an ambiguous submit by client order id', async () => {
  const calls: string[] = [];
  const adapter = new BinanceSpotAdapter({ apiKey: 'key', apiSecret: 'secret', liveEnabled: true, testnet: true, fetcher: async (input) => {
    const url = new URL(String(input)); calls.push(`${url.origin}${url.pathname}`);
    if (url.pathname.endsWith('/api/v3/order') && url.searchParams.has('origClientOrderId')) return ok(order);
    throw new TypeError('connection reset after send');
  } });
  adapter.armLiveOrders();
  const recovered = await adapter.submitLimitOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: 0.001, price: 10000, clientOrderId: 'cid-1' }, rules);
  assert.equal(recovered.orderId, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((url) => url.startsWith('https://testnet.binance.vision/')));
});

test('does not retry an ambiguous submit when the immediate lookup finds no order', async () => {
  let submitCount = 0;
  const adapter = new BinanceSpotAdapter({ apiKey: 'key', apiSecret: 'secret', liveEnabled: true, fetcher: async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/api/v3/order') && url.searchParams.has('origClientOrderId')) return ok({ code: -2013, msg: 'Order does not exist' }, 400);
    submitCount += 1;
    throw new TypeError('connection reset after send');
  } });
  adapter.armLiveOrders();
  await assert.rejects(
    adapter.submitLimitOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: 0.001, price: 10000, clientOrderId: 'cid-unknown' }, rules),
    (error: unknown) => error instanceof AmbiguousOrderError && error.clientOrderId === 'cid-unknown',
  );
  assert.equal(submitCount, 1);
});

test('signed account, commission, status, cancel and reconciliation methods use signed endpoints', async () => {
  const calls: Array<{ url: URL; method: string }> = [];
  const adapter = new BinanceSpotAdapter({ apiKey: 'key', apiSecret: 'secret', liveEnabled: true, fetcher: async (input, init) => {
    const url = new URL(String(input)); calls.push({ url, method: init?.method ?? 'GET' });
    if (url.pathname.endsWith('/account')) return ok({ balances: [{ asset: 'USDT', free: '20', locked: '0' }] });
    if (url.pathname.endsWith('/myTrades')) return ok([{ id: 7 }]);
    return ok(order);
  } });
  const balances = await adapter.getBalances();
  assert.equal(balances[0]?.asset, 'USDT');
  assert.deepEqual(await adapter.getMyTrades('BTCUSDT'), [{ id: 7 }]);
  await adapter.getCommissionRates('BTCUSDT');
  assert.equal((await adapter.getOrder('BTCUSDT', undefined, 'cid-1'))?.status, 'NEW');
  adapter.armLiveOrders();
  await adapter.cancelOrder('BTCUSDT', 1);
  const state = await adapter.reconcile('BTCUSDT', 123);
  assert.equal(state.trades.length, 1);
  assert.ok(calls.every(({ url }) => url.searchParams.has('signature')));
  assert.equal(calls.find(({ method }) => method === 'DELETE')?.method, 'DELETE');
});
