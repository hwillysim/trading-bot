import type { MarketTick, SymbolRules } from '../shared/types.ts';
import { fetchExchangeRules } from './rules.ts';

const BINANCE_WS = 'wss://stream.binance.com:9443/ws/!miniTicker@arr';
const MAX_CANDIDATES = 40;
const RESUBSCRIBE_INTERVAL_MS = 30_000;

type MiniTicker = { s?: string; c?: string; q?: string; P?: string };
type SocketLike = WebSocket;

export class BinanceMarketFeed {
  private socket?: SocketLike;
  private rules: SymbolRules[] = [];
  private readonly allowed = new Set<string>();
  private readonly latest = new Map<string, MarketTick>();
  private readonly miniTickers = new Map<string, { last: number; quoteVolume24h: number; priceChangePercent24h: number }>();
  private readonly subscribed = new Set<string>();
  private candidateSymbols: string[] = [];
  private readonly pinnedSymbols = new Set<string>();
  private id = 1;
  private stopped = true;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconcileTimer?: ReturnType<typeof setInterval>;

  private readonly onTick: (tick: MarketTick) => void;
  private readonly onRules: (rules: SymbolRules[]) => void;
  private readonly fetchRules: typeof fetchExchangeRules;
  private readonly wsUrl: string;

  constructor(
    onTick: (tick: MarketTick) => void,
    onRules: (rules: SymbolRules[]) => void,
    fetchRules: typeof fetchExchangeRules = fetchExchangeRules,
    wsUrl = BINANCE_WS,
  ) {
    this.onTick = onTick;
    this.onRules = onRules;
    this.fetchRules = fetchRules;
    this.wsUrl = wsUrl;
  }

  get monitoredCount():number { return this.subscribed.size; }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    try {
      this.rules = await this.fetchRules();
      if (this.stopped) return;
      this.allowed.clear();
      this.miniTickers.clear();
      for (const rule of this.rules) this.allowed.add(rule.symbol);
      this.onRules(this.rules);
      this.connect();
      this.reconcileTimer = setInterval(() => this.reconcile(), RESUBSCRIBE_INTERVAL_MS);
    } catch (error) {
      this.stopped = true;
      throw error;
    }
  }

  setPinnedSymbols(symbols: string[]): void {
    this.pinnedSymbols.clear();
    for (const symbol of symbols) this.pinnedSymbols.add(symbol.toUpperCase());
    this.reconcile();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconnectTimer = undefined;
    this.reconcileTimer = undefined;
    this.socket?.close(1000, 'stopped');
    this.socket = undefined;
    this.subscribed.clear();
  }

  private connect(): void {
    if (this.stopped) return;
    const socket = new WebSocket(this.wsUrl);
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket || this.stopped) return;
      this.subscribed.clear();
      this.setSubscriptions(this.subscriptionSymbols());
    });
    socket.addEventListener('message', (event) => {
      if (this.socket === socket && !this.stopped) this.handleMessage(String(event.data));
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket || this.stopped) return;
      this.socket = undefined;
      this.subscribed.clear();
      this.reconnectTimer = setTimeout(() => this.connect(), 1_500);
    });
    socket.addEventListener('error', () => socket.close());
  }

  private handleMessage(raw: string): void {
    let message: unknown;
    try { message = JSON.parse(raw); } catch { return; }
    if (Array.isArray(message)) {
      const tickers = message as MiniTicker[];
      for (const item of tickers) {
        if (!item.s || !this.allowed.has(item.s)) continue;
        const symbol = item.s;
        this.miniTickers.set(symbol, {
          last: positive(item.c),
          quoteVolume24h: positive(item.q),
          priceChangePercent24h: finite(item.P),
        });
      }
      for (const item of tickers) {
        if (!item.s || !this.allowed.has(item.s)) continue;
        const symbol = item.s;
        const mini = this.miniTickers.get(symbol)!;
        const current = this.latest.get(symbol) ?? emptyTick(symbol);
        this.publish({ ...current, ts: Date.now(), last: mini.last || current.last,
          quoteVolume24h: mini.quoteVolume24h, priceChangePercent24h: mini.priceChangePercent24h });
      }
      const ranked = [...this.miniTickers.entries()];
      const liquid = [...ranked].sort((a, b) => b[1].quoteVolume24h - a[1].quoteVolume24h).slice(0, MAX_CANDIDATES / 2);
      const movers = ranked.filter(([,ticker]) => ticker.quoteVolume24h >= 1_000_000)
        .sort((a,b) => Math.abs(b[1].priceChangePercent24h)-Math.abs(a[1].priceChangePercent24h))
        .slice(0,MAX_CANDIDATES/2);
      this.candidateSymbols = [...new Set([...liquid,...movers].map(([symbol])=>symbol))];
      this.setSubscriptions(this.subscriptionSymbols());
      return;
    }
    if (!message || typeof message !== 'object') return;
    const envelope = message as { stream?: string; data?: Record<string, unknown>; e?: string };
    const data = envelope.data ?? message as Record<string, unknown>;
    const event = String(data.e ?? envelope.stream?.split('@')[1] ?? '');
    const symbol = String(data.s ?? '');
    if (!symbol || !this.allowed.has(symbol)) return;
    const current = this.latest.get(symbol) ?? emptyTick(symbol);
    const ts = Number(data.E ?? data.T ?? Date.now());
    if (event.includes('bookTicker') || ('b' in data && 'a' in data && 'u' in data)) {
      this.publish({ ...current, ts, bookTs:ts, bid: positive(data.b), ask: positive(data.a), bidQty: positive(data.B), askQty: positive(data.A) });
    } else if (event === 'trade' || event === 'aggTrade') {
      const quantity = positive(data.q);
      const updated = { ...current, ts, last: positive(data.p) || current.last, tradeQty: quantity, tradeBuyerIsMaker: Boolean(data.m) };
      this.publish(updated);
    } else if (event.startsWith('depth')) {
      const bids = Array.isArray(data.b) ? data.b : [];
      const asks = Array.isArray(data.a) ? data.a : [];
      const bidQty = bids.reduce((sum: number, row: unknown) => sum + (Array.isArray(row) ? positive(row[1]) : 0), 0);
      const askQty = asks.reduce((sum: number, row: unknown) => sum + (Array.isArray(row) ? positive(row[1]) : 0), 0);
      this.publish({ ...current, ts, bidQty: bidQty || current.bidQty, askQty: askQty || current.askQty });
    }
  }

  private setSubscriptions(symbols: string[]): void {
    const next = new Set(symbols);
    const add = [...next].filter((symbol) => !this.subscribed.has(symbol));
    const remove = [...this.subscribed].filter((symbol) => !next.has(symbol));
    if (remove.length) this.send('UNSUBSCRIBE', streamsFor(remove));
    if (add.length) this.send('SUBSCRIBE', streamsFor(add));
    this.subscribed.clear();
    for (const symbol of next) this.subscribed.add(symbol);
  }

  private reconcile(): void {
    if (this.stopped || this.socket?.readyState !== WebSocket.OPEN) return;
    this.setSubscriptions(this.subscriptionSymbols());
  }

  private subscriptionSymbols(): string[] {
    const pinned = [...this.pinnedSymbols].filter((symbol) => this.allowed.has(symbol));
    return [...new Set([...this.candidateSymbols, ...pinned])];
  }

  private send(method: 'SUBSCRIBE' | 'UNSUBSCRIBE', params: string[]): void {
    if (this.socket?.readyState === WebSocket.OPEN && params.length) {
      this.socket.send(JSON.stringify({ method, params, id: this.id++ }));
    }
  }

  private publish(tick: MarketTick): void {
    const { tradeQty: _tradeQty, tradeBuyerIsMaker: _tradeSide, ...snapshot } = tick;
    this.latest.set(tick.symbol, snapshot);
    this.onTick(tick);
  }
}

function streamsFor(symbols: string[]): string[] {
  return symbols.flatMap((symbol) => {
    const name = symbol.toLowerCase();
    return [`${name}@bookTicker`, `${name}@trade`, `${name}@depth5@100ms`];
  });
}
function emptyTick(symbol: string): MarketTick {
  return { symbol, ts: Date.now(), last: 0, bid: 0, ask: 0, bidQty: 0, askQty: 0, quoteVolume24h: 0, priceChangePercent24h: 0 };
}
function positive(value: unknown): number { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : 0; }
function finite(value: unknown): number { const n = Number(value); return Number.isFinite(n) ? n : 0; }
