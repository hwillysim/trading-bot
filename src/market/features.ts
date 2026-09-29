import type { MarketFeatures, MarketTick } from '../shared/types.ts';

export class RollingMarketFeatures {
  private readonly observations = new Map<string, MarketTick[]>();
  private readonly retentionMs: number;
  constructor(retentionMs = 5 * 60_000) { this.retentionMs = retentionMs; }

  add(tick: MarketTick): void {
    const rows = this.observations.get(tick.symbol) ?? [];
    rows.push(tick);
    const cutoff = tick.ts - this.retentionMs;
    let first = 0;
    while (first < rows.length && rows[first]!.ts < cutoff) first++;
    if (first) rows.splice(0, first);
    this.observations.set(tick.symbol, rows);
  }

  calculate(symbol: string, now = Date.now()): MarketFeatures | undefined {
    const rows = this.observations.get(symbol);
    if (!rows?.length) return undefined;
    const current = rows[rows.length - 1]!;
    const priceAt = (row: MarketTick) => row.last || (row.bid + row.ask) / 2;
    const price = priceAt(current);
    if (!(price > 0)) return undefined;
    const firstPrice = (windowMs: number) => {
      const row = rows.find((entry) => entry.ts >= now - windowMs && priceAt(entry) > 0);
      return row ? priceAt(row) : price;
    };
    const oneMinute = rows.filter((row) => row.ts >= now - 60_000);
    const fiveMinutes = rows.filter((row) => row.ts >= now - 300_000);
    const returns = priceReturns(oneMinute.map(priceAt));
    const returns5m = priceReturns(fiveMinutes.map(priceAt));
    const traded = (windowMs: number) => rows.filter((row) => row.ts >= now - windowMs && row.tradeQty !== undefined);
    const tradeValue = (windowMs: number) => traded(windowMs).reduce((sum, row) => sum + priceAt(row) * row.tradeQty!, 0);
    const flow = traded(60_000).reduce((totals, row) => {
      totals[row.tradeBuyerIsMaker ? 'sell' : 'buy'] += priceAt(row) * row.tradeQty!;
      return totals;
    }, { buy: 0, sell: 0 });
    const bidDepthUsdt = current.bid * current.bidQty;
    const askDepthUsdt = current.ask * current.askQty;
    const depthUsdt = bidDepthUsdt + askDepthUsdt;
    const spreadBps = current.bid > 0 && current.ask > 0
      ? (current.ask - current.bid) / ((current.ask + current.bid) / 2) * 10_000
      : 10_000;
    const orderUsdt = 0.20;
    const availableDepthUsdt = Math.min(bidDepthUsdt, askDepthUsdt);
    const depthShortfall = Math.max(0, orderUsdt - availableDepthUsdt) / orderUsdt;
    const quoteVolume1m = tradeValue(60_000);
    const quoteVolume5m = tradeValue(300_000);
    return {
      ...current,
      ts: now,
      last: price,
      return15s: ratioReturn(price, firstPrice(15_000)),
      return1m: ratioReturn(price, firstPrice(60_000)),
      return5m: ratioReturn(price, firstPrice(300_000)),
      volatility1m: stdev(returns),
      relativeVolume1m: quoteVolume5m ? quoteVolume1m / (quoteVolume5m / 5) : 0,
      buyFlow1m: flow.buy,
      sellFlow1m: flow.sell,
      spreadBps,
      bookImbalance: current.bidQty + current.askQty ? (current.bidQty - current.askQty) / (current.bidQty + current.askQty) : 0,
      depthUsdt,
      estimatedSlippageBps: Math.min(10_000, spreadBps / 2 + depthShortfall * 100),
    };
  }

  calculateAll(now = Date.now()): MarketFeatures[] {
    return [...this.observations.keys()].flatMap((symbol) => {
      const result = this.calculate(symbol, now);
      return result ? [result] : [];
    });
  }
}

function ratioReturn(current: number, previous: number): number { return previous ? current / previous - 1 : 0; }
function priceReturns(prices: number[]): number[] { return prices.slice(1).map((value, index) => value / prices[index]! - 1); }
function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}
