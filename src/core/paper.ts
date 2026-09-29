import { randomUUID } from 'node:crypto';
import type { MarketTick, RiskCaps } from '../shared/types.ts';
import { PAPER_SLIPPAGE_BPS, TAKER_FEE_BPS, utcDay } from './defaults.ts';
import type { RecordedTrade, Store } from './store.ts';

export interface Position { symbol:string; quantity:number; entryPrice:number; entryTs:number; costUsdt:number; peakBid:number }
const PAPER_ORDER_CAP_USDT=0.2;
export interface PaperOrder { id:string; symbol:string; side:'BUY'|'SELL'; status:'OPEN'|'PARTIALLY_FILLED'|'FILLED'|'CANCELLED'; limitPrice:number; quantity:number; filledQuantity:number; remainingQuantity:number; createdTs:number; expiresTs:number; reservedUsdt:number; feeUsdt:number; reason:string }
export interface PaperState { usdt:number; position:Position|null; orders?:PaperOrder[]; realisedPnlUsdt:number; feesUsdt:number; day:string; dailyRealisedLossUsdt:number; peakPortfolioUsdt:number }

export class PaperBroker {
  state:PaperState;
  private readonly store:Store;
  private caps:RiskCaps;
  constructor(store:Store, caps:RiskCaps) {
    this.store=store;this.caps=caps;
    this.state=store.get<PaperState>('paper', {usdt:caps.floatUsdt,position:null,realisedPnlUsdt:0,feesUsdt:0,day:utcDay(Date.now()),dailyRealisedLossUsdt:0,peakPortfolioUsdt:caps.floatUsdt});
  }
  rollDay(ts:number) { const day=utcDay(ts); if(day!==this.state.day) { this.state.day=day; this.state.dailyRealisedLossUsdt=0; this.save(); } }
  setCaps(caps:RiskCaps) {this.caps=caps;}
  private save() { this.store.set('paper',this.state); }
  get openOrders():PaperOrder[] { return (this.state.orders??[]).filter(o=>o.status==='OPEN'||o.status==='PARTIALLY_FILLED').map(o=>({...o})); }
  submitBuy(tick:MarketTick,notionalUsdt:number,reason:string,extraSlippageBps=0):PaperOrder|null {
    this.rollDay(tick.ts);
    const orders=this.state.orders??=[];
    if(this.state.position || orders.some(o=>o.side==='BUY'&&(o.status==='OPEN'||o.status==='PARTIALLY_FILLED')) || !Number.isFinite(tick.bid)||tick.bid<=0||!Number.isFinite(tick.askQty)||tick.askQty<=0||notionalUsdt<=0||notionalUsdt>Math.min(PAPER_ORDER_CAP_USDT,this.caps.maxOrderUsdt)||notionalUsdt>this.state.usdt||this.state.dailyRealisedLossUsdt>=this.caps.dailyLossStopUsdt) return null;
    const limitPrice=tick.bid*(1+Math.max(0,Math.min(10,PAPER_SLIPPAGE_BPS+extraSlippageBps))/10_000);
    const reserve=Math.min(notionalUsdt,this.state.usdt);
    const quantity=reserve/(limitPrice*(1+TAKER_FEE_BPS/10_000));
    const order:PaperOrder={id:randomUUID(),symbol:tick.symbol,side:'BUY',status:'OPEN',limitPrice,quantity,filledQuantity:0,remainingQuantity:quantity,createdTs:tick.ts,expiresTs:tick.ts+30_000,reservedUsdt:reserve,feeUsdt:0,reason};
    this.state.usdt-=reserve;orders.push(order);this.save();return {...order};
  }
  processTick(tick:MarketTick,extraSlippageBps=0):RecordedTrade[] {
    const trades:RecordedTrade[]=[]; const orders=this.state.orders??[];let changed=false;
    for(const order of orders) {
      if((order.status!=='OPEN'&&order.status!=='PARTIALLY_FILLED')||order.symbol!==tick.symbol) continue;
      if(tick.ts>=order.expiresTs) { this.state.usdt+=order.reservedUsdt;order.reservedUsdt=0;order.status='CANCELLED';changed=true; continue; }
      if(tick.bookTs!==undefined&&(tick.bookTs>tick.ts||tick.ts-tick.bookTs>3_000)) continue;
      if(!Number.isFinite(tick.ask)||tick.ask<=0||!Number.isFinite(tick.askQty)||tick.askQty<=0||tick.ask>order.limitPrice) continue;
      const price=tick.ask*(1+Math.max(0,Math.min(10,extraSlippageBps))/10_000);
      if(price>order.limitPrice) continue;
      const affordable=order.reservedUsdt/(price*(1+TAKER_FEE_BPS/10_000));
      const quantity=Math.min(order.remainingQuantity,tick.askQty,affordable);
      if(quantity<=0) continue;
      changed=true;
      const gross=quantity*price,fee=gross*TAKER_FEE_BPS/10_000,total=gross+fee;
      order.reservedUsdt-=total;order.filledQuantity+=quantity;order.remainingQuantity-=quantity;order.feeUsdt+=fee;this.state.feesUsdt+=fee;
      const p=this.state.position;
      if(!p) this.state.position={symbol:tick.symbol,quantity,entryPrice:price,entryTs:tick.ts,costUsdt:total,peakBid:tick.bid};
      else {p.quantity+=quantity;p.costUsdt+=total;p.entryPrice=(p.entryPrice*(p.quantity-quantity)+price*quantity)/p.quantity;}
      const trade:RecordedTrade={id:randomUUID(),ts:tick.ts,symbol:tick.symbol,side:'BUY',quantity,price,notionalUsdt:gross,feeUsdt:fee,reason:order.reason,mode:'paper'};
      trades.push(trade);this.store.trade(trade);
      if(order.remainingQuantity<=1e-12){order.remainingQuantity=0;order.status='FILLED';this.state.usdt+=order.reservedUsdt;order.reservedUsdt=0;}
      else order.status='PARTIALLY_FILLED';
    }
    if(changed)this.save();return trades;
  }
  expireOrders(now=Date.now()):number {let expired=0;for(const order of this.openOrders)if(now>=order.expiresTs&&this.cancelOrder(order.id))expired++;return expired;}
  cancelOrder(orderId:string):boolean { const order=(this.state.orders??[]).find(o=>o.id===orderId&&(o.status==='OPEN'||o.status==='PARTIALLY_FILLED'));if(!order)return false;this.state.usdt+=order.reservedUsdt;order.reservedUsdt=0;order.status='CANCELLED';this.save();return true; }
  buy(tick:MarketTick,notionalUsdt:number,reason:string,extraSlippageBps=0):RecordedTrade|null {
    this.rollDay(tick.ts);
    if(this.state.position || this.openOrders.some(o=>o.side==='BUY') || !Number.isFinite(tick.ask) || tick.ask<=0 || notionalUsdt<=0 || notionalUsdt>Math.min(PAPER_ORDER_CAP_USDT,this.caps.maxOrderUsdt) || notionalUsdt>this.state.usdt || this.state.dailyRealisedLossUsdt>=this.caps.dailyLossStopUsdt) return null;
    const price=tick.ask*(1+(PAPER_SLIPPAGE_BPS+extraSlippageBps)/10_000);
    const feeUsdt=notionalUsdt*TAKER_FEE_BPS/10_000;
    const quantity=(notionalUsdt-feeUsdt)/price;
    const trade:RecordedTrade={id:randomUUID(),ts:tick.ts,symbol:tick.symbol,side:'BUY',quantity,price,notionalUsdt,feeUsdt,reason,mode:'paper'};
    this.state.usdt-=notionalUsdt;
    this.state.position={symbol:tick.symbol,quantity,entryPrice:price,entryTs:tick.ts,costUsdt:notionalUsdt,peakBid:tick.bid};
    this.state.feesUsdt+=feeUsdt;
    this.store.trade(trade); this.save(); return trade;
  }
  sell(tick:MarketTick,reason:string,extraSlippageBps=0):RecordedTrade|null {
    this.rollDay(tick.ts);
    let cancelled=false;
    for(const order of this.state.orders??[]) if(order.symbol===tick.symbol&&order.side==='BUY'&&(order.status==='OPEN'||order.status==='PARTIALLY_FILLED')) { this.state.usdt+=order.reservedUsdt;order.reservedUsdt=0;order.status='CANCELLED';cancelled=true; }
    const p=this.state.position;
    if(!p || p.symbol!==tick.symbol || !Number.isFinite(tick.bid) || tick.bid<=0) {if(cancelled)this.save();return null;}
    const price=tick.bid*(1-(PAPER_SLIPPAGE_BPS+extraSlippageBps)/10_000);
    const gross=p.quantity*price;
    const feeUsdt=gross*TAKER_FEE_BPS/10_000;
    const proceeds=gross-feeUsdt;
    const pnl=proceeds-p.costUsdt;
    const trade:RecordedTrade={id:randomUUID(),ts:tick.ts,symbol:tick.symbol,side:'SELL',quantity:p.quantity,price,notionalUsdt:gross,feeUsdt,reason,mode:'paper'};
    this.state.usdt+=proceeds;
    this.state.realisedPnlUsdt+=pnl;
    if(pnl<0) this.state.dailyRealisedLossUsdt-=pnl;
    this.state.feesUsdt+=feeUsdt;
    this.state.position=null;
    this.state.peakPortfolioUsdt=Math.max(this.state.peakPortfolioUsdt,this.state.usdt);
    this.store.trade(trade); this.save(); return trade;
  }
  mark(tick:MarketTick) { const p=this.state.position; if(p?.symbol===tick.symbol && tick.bid>p.peakBid){p.peakBid=tick.bid;this.save();} }
  portfolio(latest:Map<string,MarketTick>) {
    const p=this.state.position; const bid=p ? latest.get(p.symbol)?.bid ?? p.entryPrice : 0;
    const holdingValue=p ? p.quantity*bid*(1-TAKER_FEE_BPS/10_000) : 0;
    const reservedUsdt=this.openOrders.reduce((sum,order)=>sum+order.reservedUsdt,0);
    const total=this.state.usdt+reservedUsdt+holdingValue;
    this.state.peakPortfolioUsdt=Math.max(this.state.peakPortfolioUsdt,total);
    return {availableUsdt:this.state.usdt,holdings:p?[{symbol:p.symbol,quantity:p.quantity,valueUsdt:holdingValue,entryPrice:p.entryPrice,ageSeconds:Math.max(0,(Date.now()-p.entryTs)/1000)}]:[],portfolioUsdt:total,reservedUsdt,realisedPnlUsdt:this.state.realisedPnlUsdt,unrealisedPnlUsdt:p?holdingValue-p.costUsdt:0,feesUsdt:this.state.feesUsdt,drawdownPercent:this.state.peakPortfolioUsdt>0?(this.state.peakPortfolioUsdt-total)/this.state.peakPortfolioUsdt*100:0,openPositions:p?1:0};
  }
}
