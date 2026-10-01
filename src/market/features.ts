import type { MarketFeatures, MarketTick } from '../shared/types.ts';

export class RollingMarketFeatures {
  private readonly observations = new Map<string, MarketTick[]>();
  private readonly retentionMs: number;
  constructor(retentionMs = 5 * 60_000) { this.retentionMs = retentionMs; }

  add(tick: MarketTick): void {
    let rows = this.observations.get(tick.symbol) ?? [];
    if(rows.length&&tick.ts-rows[rows.length-1]!.ts>10_000)rows=[];
    if(rows.length&&tick.ts<rows[rows.length-1]!.ts)return;
    rows.push(tick);
    const cutoff = tick.ts - this.retentionMs;
    let first = 0;
    while (first < rows.length && rows[first]!.ts < cutoff) first++;
    if (first) rows.splice(0, first);
    this.observations.set(tick.symbol, rows);
  }

  calculate(symbol: string, now = Date.now(), orderUsdt=0.20): MarketFeatures | undefined {
    const rows = this.observations.get(symbol);
    if (!rows?.length) return undefined;
    const current = rows[rows.length - 1]!;
    const priceAt = (row: MarketTick) => row.bid>0&&row.ask>0?(row.bid+row.ask)/2:row.last;
    const price = priceAt(current);
    if (!(price > 0)) return undefined;
    const firstPrice = (windowMs: number) => {
      const row = rows.find((entry) => entry.ts >= now - windowMs && priceAt(entry) > 0);
      return row ? priceAt(row) : price;
    };
    const oneMinute = rows.filter((row) => row.ts >= now - 60_000);
    const fiveMinutes = rows.filter((row) => row.ts >= now - 300_000);
    // Sample once per second so volatility does not depend on message frequency.
    const seconds=new Map<number,number>();
    for(const row of oneMinute) seconds.set(Math.floor(row.ts/1000),priceAt(row));
    const returns=priceReturns([...seconds.values()]);
    const traded = (windowMs: number) => rows.filter((row) => row.ts >= now - windowMs && row.tradeQty !== undefined);
    const tradeValue = (windowMs: number) => traded(windowMs).reduce((sum, row) => sum + row.last * row.tradeQty!, 0);
    const flow = traded(60_000).reduce((totals, row) => {
      totals[row.tradeBuyerIsMaker ? 'sell' : 'buy'] += row.last * row.tradeQty!;
      return totals;
    }, { buy: 0, sell: 0 });
    const freshDepth=!!current.depthTs && now-current.depthTs<=3_000;
    const bids=freshDepth&&current.bids?.length?current.bids:[[current.bid,current.bidQty]];
    const asks=freshDepth&&current.asks?.length?current.asks:[[current.ask,current.askQty]];
    const bidDepthUsdt=bids.reduce((sum,[p,q])=>sum+p!*q!,0);
    const askDepthUsdt=asks.reduce((sum,[p,q])=>sum+p!*q!,0);
    const depthUsdt = bidDepthUsdt + askDepthUsdt;
    const spreadBps = current.bid > 0 && current.ask > 0
      ? (current.ask - current.bid) / ((current.ask + current.bid) / 2) * 10_000
      : 10_000;

    const availableDepthUsdt = Math.min(bidDepthUsdt, askDepthUsdt);
    const depthShortfall = Math.max(0, orderUsdt - availableDepthUsdt) / orderUsdt;
    const quoteVolume1m = tradeValue(60_000);
    const quoteVolume5m = tradeValue(300_000);
    return {
      ...current,
      ts: current.ts,
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
      historySeconds:Math.max(0,(now-rows[0]!.ts)/1000),
      volatility5sBps:stdev(returns)*Math.sqrt(5)*10_000,
      buyFlow5s:traded(5_000).filter(row=>!row.tradeBuyerIsMaker).reduce((sum,row)=>sum+row.last*row.tradeQty!,0),
      sellFlow5s:traded(5_000).filter(row=>row.tradeBuyerIsMaker).reduce((sum,row)=>sum+row.last*row.tradeQty!,0),
      recentPath:[60,30,15,5,0].map(secondsAgo=>({secondsAgo,returnBps:ratioReturn(firstPrice(secondsAgo*1000),firstPrice(60_000))*10_000})),
      estimatedSlippageBps: Math.min(10_000, depthShortfall * 100 + bookImpact(asks,orderUsdt,current.ask)),
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

function bookImpact(levels:number[][],notional:number,best:number):number {
  let remaining=notional,quantity=0,spent=0;
  for(const [price,qty] of levels){if(!price||!qty)continue;const value=Math.min(remaining,price*qty);spent+=value;quantity+=value/price;remaining-=value;if(remaining<=0)break;}
  return quantity&&best>0?Math.max(0,(spent/quantity/best-1)*10_000):10_000;
}
