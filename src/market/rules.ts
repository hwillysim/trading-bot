import type { SymbolRules } from '../shared/types.ts';

export interface BinanceExchangeInfo {
  symbols?: Array<{
    symbol?: string;
    status?: string;
    baseAsset?: string;
    quoteAsset?: string;
    isSpotTradingAllowed?: boolean;
    filters?: Array<Record<string, unknown>>;
  }>;
}

function nonNegativeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function parseExchangeRules(payload: BinanceExchangeInfo): SymbolRules[] {
  return (payload.symbols ?? []).flatMap((item) => {
    if (!item.symbol || !item.baseAsset || !item.quoteAsset || item.quoteAsset !== 'USDT' || item.status !== 'TRADING' || item.isSpotTradingAllowed === false) return [];
    const filters = item.filters ?? [];
    const price = filters.find((filter) => filter.filterType === 'PRICE_FILTER');
    const lot = filters.find((filter) => filter.filterType === 'LOT_SIZE');
    const notional = filters.find((filter) => filter.filterType === 'NOTIONAL' || filter.filterType === 'MIN_NOTIONAL');
    if (!price || !lot) return [];
    return [{
      symbol: item.symbol,
      status: item.status,
      baseAsset: item.baseAsset,
      quoteAsset: item.quoteAsset,
      tickSize: nonNegativeNumber(price.tickSize),
      stepSize: nonNegativeNumber(lot.stepSize),
      minQty: nonNegativeNumber(lot.minQty),
      minNotional: nonNegativeNumber(notional?.minNotional),
    }];
  });
}

export async function fetchExchangeRules(fetcher: typeof fetch = fetch): Promise<SymbolRules[]> {
  const response = await fetcher('https://api.binance.com/api/v3/exchangeInfo');
  if (!response.ok) throw new Error(`Binance exchangeInfo returned HTTP ${response.status}`);
  return parseExchangeRules(await response.json() as BinanceExchangeInfo);
}
