import test from 'node:test';
import assert from 'node:assert/strict';
import { RollingMarketFeatures } from '../src/market/features.ts';
import { BinanceMarketFeed } from '../src/market/feed.ts';
import { parseExchangeRules } from '../src/market/rules.ts';

const exchangeInfo = {
  symbols: [
    { symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT', filters: [
      { filterType: 'PRICE_FILTER', tickSize: '0.01' },
      { filterType: 'LOT_SIZE', minQty: '0.0001', stepSize: '0.0001' },
      { filterType: 'NOTIONAL', minNotional: '5.00' },
    ] },
    { symbol: 'ETHBTC', status: 'TRADING', baseAsset: 'ETH', quoteAsset: 'BTC', filters: [] },
    { symbol: 'OLDUSDT', status: 'BREAK', baseAsset: 'OLD', quoteAsset: 'USDT', filters: [] },
  ],
};

test('exchange rules keep active USDT spot symbols and map Binance filters', () => {
  assert.deepEqual(parseExchangeRules(exchangeInfo), [{
    symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT',
    tickSize: 0.01, stepSize: 0.0001, minQty: 0.0001, minNotional: 5,
  }]);
});

test('rolling features calculate returns, trade flow, spread and book imbalance', () => {
  const features = new RollingMarketFeatures();
  const now = 1_000_000;
  const tick = (ts: number, last: number, extra: { tradeQty?: number; tradeBuyerIsMaker?: boolean } = {}) => ({
    symbol: 'BTCUSDT', ts, last, bid: last - 0.5, ask: last + 0.5,
    bidQty: 3, askQty: 1, quoteVolume24h: 10_000_000, priceChangePercent24h: 0, ...extra,
  });
  features.add(tick(now - 60_000, 100));
  for(let ts=now-55_000;ts<now-30_000;ts+=5_000)features.add(tick(ts,100));
  features.add(tick(now - 30_000, 101, { tradeQty: 2, tradeBuyerIsMaker: false }));
  for(let ts=now-25_000;ts<now-10_000;ts+=5_000)features.add(tick(ts,101));
  features.add(tick(now - 10_000, 102, { tradeQty: 1, tradeBuyerIsMaker: true }));
  const result = features.calculate('BTCUSDT', now);
  assert.ok(result);
  assert.ok(Math.abs(result.return15s-(102/101-1))<1e-12);
  assert.ok(Math.abs(result.return1m - 0.02) < 1e-12);
  assert.equal(result.buyFlow1m, 202);
  assert.equal(result.sellFlow1m, 102);
  assert.ok(Math.abs(result.spreadBps - 10000 / 102) < 1e-9);
  assert.equal(result.bookImbalance, 0.5);
  assert.ok(result.volatility1m > 0);
  assert.equal(result.estimatedSlippageBps, 0, 'a 0.20 USDT order fits within the visible depth');
});

test('features return undefined before the first usable price', () => {
  const features = new RollingMarketFeatures();
  features.add({ symbol: 'XUSDT', ts: 10, last: 0, bid: 0, ask: 0, bidQty: 0, askQty: 0, quoteVolume24h: 0, priceChangePercent24h: 0 });
  assert.equal(features.calculate('XUSDT', 10), undefined);
});


test('partial mini ticker updates retain prior symbols for candidate ranking', () => {
  const feed = new BinanceMarketFeed(() => {}, () => {});
  const internals = feed as unknown as { allowed: Set<string>; candidateSymbols: string[]; handleMessage(raw: string): void };
  internals.allowed.add('BTCUSDT');
  internals.allowed.add('ETHUSDT');
  internals.handleMessage(JSON.stringify([{ s: 'BTCUSDT', c: '100', q: '500', P: '1' }]));
  internals.handleMessage(JSON.stringify([{ s: 'ETHUSDT', c: '10', q: '900', P: '2' }]));
  assert.deepEqual(internals.candidateSymbols, ['ETHUSDT', 'BTCUSDT']);
});

test('book updates do not repeat the last trade quantity', () => {
  const ticks: Array<{ tradeQty?: number }> = [];
  const feed = new BinanceMarketFeed((tick) => ticks.push(tick), () => {});
  const internals = feed as unknown as { allowed: Set<string>; handleMessage(raw: string): void };
  internals.allowed.add('BTCUSDT');
  internals.handleMessage(JSON.stringify({ e: 'trade', s: 'BTCUSDT', T: 1_000, p: '100', q: '2', m: false }));
  internals.handleMessage(JSON.stringify({ e: 'bookTicker', s: 'BTCUSDT', E: 1_001, b: '99.9', B: '4', a: '100.1', A: '5' }));
  assert.equal(ticks[0]!.tradeQty, 2);
  assert.equal(ticks[1]!.tradeQty, undefined);
});


test('pinned eligible symbols remain subscribed outside the top twenty', () => {
  const feed = new BinanceMarketFeed(() => {}, () => {});
  const internals = feed as unknown as {
    allowed: Set<string>;
    subscribed: Set<string>;
    handleMessage(raw: string): void;
  };
  const tickers = Array.from({ length: 21 }, (_, index) => {
    const symbol = `T${String(index).padStart(2, '0')}USDT`;
    internals.allowed.add(symbol);
    return { s: symbol, c: '1', q: String(100 - index), P: '0' };
  });
  feed.setPinnedSymbols(['T20USDT']);
  internals.handleMessage(JSON.stringify(tickers));
  assert.equal(internals.subscribed.has('T19USDT'), true);
  assert.equal(internals.subscribed.has('T20USDT'), true);
  assert.equal(internals.subscribed.size, 21);
});

test('documented mini-ticker and combined depth payloads produce real change and five-level books',()=>{
 const ticks:Array<any>=[],feed=new BinanceMarketFeed(t=>ticks.push(t),()=>{});
 const internals=feed as unknown as {allowed:Set<string>;handleMessage(raw:string):void};internals.allowed.add('BTCUSDT');
 internals.handleMessage(JSON.stringify({stream:'!miniTicker@arr',data:[{s:'BTCUSDT',c:'110',o:'100',q:'2000000'}]}));
 assert.ok(Math.abs(ticks.at(-1).priceChangePercent24h-10)<1e-9);
 internals.handleMessage(JSON.stringify({stream:'btcusdt@depth5@100ms',data:{lastUpdateId:123,bids:[['109','2'],['108','3']],asks:[['110','4'],['111','5']]}}));
 const tick=ticks.at(-1);assert.equal(tick.bid,109);assert.equal(tick.ask,110);assert.equal(tick.bidQty,2);assert.equal(tick.asks.length,2);assert.equal(tick.bookUpdateId,123);assert.ok(tick.depthTs);
 const rolling=new RollingMarketFeatures();rolling.add(tick);const small=rolling.calculate('BTCUSDT',tick.ts,20),large=rolling.calculate('BTCUSDT',tick.ts,500);
 assert.ok(small&&large);assert.equal(small.depthUsdt,218+324+440+555);assert.ok(large.estimatedSlippageBps>small.estimatedSlippageBps);
});
