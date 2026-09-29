import { createHmac } from 'node:crypto';
import type { SymbolRules } from '../shared/types.ts';

export interface BinanceAdapterOptions {
  apiKey: string;
  apiSecret: string;
  liveEnabled?: boolean;
  testnet?: boolean;
  baseUrl?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  recvWindow?: number;
}

export interface LimitOrderRequest {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  clientOrderId: string;
}

export interface BinanceOrder {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  status: string;
  side: string;
  type: string;
  origQty: string;
  executedQty: string;
  cummulativeQuoteQty: string;
  price: string;
}

export class BinanceApiError extends Error {
  readonly status?: number;
  readonly code?: number;
  constructor(message: string, status?: number, code?: number) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class AmbiguousOrderError extends Error {
  readonly clientOrderId: string;
  constructor(clientOrderId: string) {
    super(`Order submission outcome is unknown for clientOrderId ${clientOrderId}`);
    this.name = 'AmbiguousOrderError';
    this.clientOrderId = clientOrderId;
  }
}

export class BinanceSpotAdapter {
  private armed = false;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly recvWindow: number;
  private readonly liveEnabled: boolean;
  private readonly options: BinanceAdapterOptions;

  constructor(options: BinanceAdapterOptions) {
    this.options = options;
    if (!options.apiKey || !options.apiSecret) throw new Error('Binance API key and secret are required');
    this.baseUrl = (options.baseUrl ?? (options.testnet ? 'https://testnet.binance.vision' : 'https://api.binance.com')).replace(/\/$/, '');
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.recvWindow = options.recvWindow ?? 5_000;
    this.liveEnabled = options.liveEnabled ?? false;
  }

  armLiveOrders(): void {
    if (!this.liveEnabled) throw new Error('Live orders are disabled at construction');
    this.armed = true;
  }

  disarmLiveOrders(): void { this.armed = false; }

  async getAccount(): Promise<unknown> { return this.signed('GET', '/api/v3/account'); }

  async getCommissionRates(symbol: string): Promise<unknown> {
    return this.signed('GET', '/api/v3/account/commission', { symbol });
  }

  async getOrder(symbol: string, orderId?: number, clientOrderId?: string): Promise<BinanceOrder | null> {
    if (orderId === undefined && !clientOrderId) throw new Error('orderId or clientOrderId is required');
    try {
      return await this.signed('GET', '/api/v3/order', { symbol, ...(orderId === undefined ? {} : { orderId }), ...(clientOrderId ? { origClientOrderId: clientOrderId } : {}) }) as BinanceOrder;
    } catch (error) {
      if (error instanceof BinanceApiError && error.code === -2013) return null;
      throw error;
    }
  }

  async submitLimitOrder(request: LimitOrderRequest, rules: SymbolRules): Promise<BinanceOrder> {
    this.assertArmed();
    if (request.symbol !== rules.symbol || rules.status !== 'TRADING') throw new Error('Symbol rules do not permit this order');
    if (!request.clientOrderId || request.clientOrderId.length > 36) throw new Error('clientOrderId must contain 1 to 36 characters');
    const quantity = floorToStep(request.quantity, rules.stepSize);
    const price = floorToStep(request.price, rules.tickSize);
    if (!(quantity > 0) || quantity < rules.minQty) throw new Error('Quantity is below the exchange minimum or invalid');
    if (!(price > 0)) throw new Error('Price is invalid');
    if (quantity * price < rules.minNotional) throw new Error('Order is below the exchange minimum notional');
    const params = { symbol: request.symbol, side: request.side, type: 'LIMIT', timeInForce: 'GTC', quantity: decimalString(quantity, rules.stepSize), price: decimalString(price, rules.tickSize), newClientOrderId: request.clientOrderId };
    try {
      return await this.signed('POST', '/api/v3/order', params) as BinanceOrder;
    } catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === 'AbortError')) throw error;
      const recovered = await this.getOrder(request.symbol, undefined, request.clientOrderId);
      if (recovered) return recovered;
      throw new AmbiguousOrderError(request.clientOrderId);
    }
  }

  async cancelOrder(symbol: string, orderId?: number, clientOrderId?: string): Promise<BinanceOrder> {
    this.assertArmed();
    if (orderId === undefined && !clientOrderId) throw new Error('orderId or clientOrderId is required');
    return await this.signed('DELETE', '/api/v3/order', { symbol, ...(orderId === undefined ? {} : { orderId }), ...(clientOrderId ? { origClientOrderId: clientOrderId } : {}) }) as BinanceOrder;
  }

  async getBalances(): Promise<Array<{ asset: string; free: string; locked: string }>> {
    const account = await this.getAccount() as { balances?: Array<{ asset: string; free: string; locked: string }> };
    return account.balances ?? [];
  }

  async getMyTrades(symbol: string, options: { fromId?: number; startTime?: number; endTime?: number; limit?: number } = {}): Promise<unknown[]> {
    const trades = await this.signed('GET', '/api/v3/myTrades', { symbol, ...options });
    return trades as unknown[];
  }

  async reconcile(symbol: string, since?: number): Promise<{ balances: Array<{ asset: string; free: string; locked: string }>; trades: unknown[] }> {
    const [balances, trades] = await Promise.all([this.getBalances(), this.getMyTrades(symbol, since === undefined ? {} : { startTime: since })]);
    return { balances, trades };
  }

  private assertArmed(): void {
    if (!this.liveEnabled || !this.armed) throw new Error('Live order gate is closed');
  }

  private async signed(method: string, path: string, params: Record<string, string | number | undefined> = {}): Promise<unknown> {
    const values = { ...params, recvWindow: this.recvWindow, timestamp: Date.now() };
    const query = new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    query.set('signature', createHmac('sha256', this.options.apiSecret).update(query.toString()).digest('hex'));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}?${query}`, { method, headers: { 'X-MBX-APIKEY': this.options.apiKey }, signal: controller.signal });
      const body = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new BinanceApiError(String(body.msg ?? `Binance returned HTTP ${response.status}`), response.status, typeof body.code === 'number' ? body.code : undefined);
      return body;
    } finally { clearTimeout(timer); }
  }
}

function floorToStep(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return 0;
  const decimals = Math.max(decimalPlaces(step), decimalPlaces(value));
  const scale = 10 ** Math.min(decimals, 14);
  const integerStep = Math.round(step * scale);
  return Math.floor((value * scale + 1e-9) / integerStep) * integerStep / scale;
}

function decimalString(value: number, step: number): string { return value.toFixed(Math.min(decimalPlaces(step), 14)).replace(/\.?0+$/, (match) => match.startsWith('.') ? '' : match); }
function decimalPlaces(value: number): number { const text = String(value); return text.includes('e-') ? Number(text.split('e-')[1]) : (text.split('.')[1]?.length ?? 0); }
