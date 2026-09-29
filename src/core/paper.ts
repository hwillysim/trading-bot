import { randomUUID } from 'node:crypto';
import type { MarketTick, RiskCaps } from '../shared/types.ts';
import { PAPER_SLIPPAGE_BPS, TAKER_FEE_BPS, utcDay } from './defaults.ts';
import type { RecordedTrade, Store } from './store.ts';

export interface Position { symbol:string; quantity:number; entryPrice:number; entryTs:number; costUsdt:number; peakBid:number }
export interface PaperOrder { id:string; symbol:string; side:'BUY'|'SELL'; status:'OPEN'|'PARTIALLY_FILLED'|'FILLED'|'CANCELLED'; limitPrice:number; quantity:number; filledQuantity:number; remainingQuantity:number; createdTs:number; expiresTs:number; reservedUsdt:number; feeUsdt:number; reason:string }
export interface PaperState { usdt:number; positions:Position[]; orders?:PaperOrder[]; realisedPnlUsdt:number; feesUsdt:number; day:string; dailyRealisedLossUsdt:number; peakPortfolioUsdt:number }

export class PaperBroker {
  state:PaperState;
  private readonly store:Store;
  private caps:RiskCaps;
  constructor(store:Store, caps:RiskCaps) {
    this.store=store;this.caps=caps;
    const saved=store.get<PaperState & {position?:Position|null}>('paper', {usdt:caps.floatUsdt,positions:[],realisedPnlUsdt:0,feesUsdt:0,day:utcDay(Date.now()),dailyRealisedLossUsdt:0,peakPortfolioUsdt:caps.floatUsdt});
    const {position,...rest}=saved;
    this.state={...rest,positions:Array.isArray(saved.positions)?saved.positions:position?[position]:[]};
    if('position' in saved)this.save();
  }
  rollDay(ts:number) { const day=utcDay(ts); if(day!==this.state.day) { this.state.day=day; this.state.dailyRealisedLossUsdt=0; this.save(); } }
  setCaps(caps:RiskCaps) {this.caps=caps;}
  startWithBalance(usdt:number) {
    if(!Number.isFinite(usdt)||usdt<=0||usdt>1_000_000) throw new Error('Starting USDT must be between 0 and 1,000,000');
    if(this.state.positions.length||this.openOrders.length) throw new Error('Liquidate holdings and cancel orders before starting a new paper run');
    this.state={usdt,positions:[],orders:[],realisedPnlUsdt:0,feesUsdt:0,day:utcDay(Date.now()),dailyRealisedLossUsdt:0,peakPortfolioUsdt:usdt};
    this.save();
  }
  private save() { this.store.set('paper',this.state); }
  get openOrders():PaperOrder[] { return (this.state.orders??[]).filter(o=>o.status==='OPEN'||o.status==='PARTIALLY_FILLED').map(o=>({...o})); }
  get occupiedSlots():number { const symbols=new Set(this.state.positions.map(p=>p.symbol));for(const order of this.openOrders)if(order.side==='BUY')symbols.add(order.symbol);return symbols.size; }
  position(symbol:string):Position|undefined {return this.state.positions.find(p=>p.symbol===symbol);}
  submitBuy(tick:MarketTick,notionalUsdt:number,reason:string,extraSlippageBps=0):PaperOrder|null {
    this.rollDay(tick.ts);
    const orders=this.state.orders??=[];
    if(this.occupiedSlots>=this.caps.maxPositions || this.position(tick.symbol) || orders.some(o=>o.symbol===tick.symbol&&o.side==='BUY'&&(o.status==='OPEN'||o.status==='PARTIALLY_FILLED')) || !Number.isFinite(tick.bid)||tick.bid<=0||!Number.isFinite(tick.askQty)||tick.askQty<=0||notionalUsdt<=0||notionalUsdt>this.caps.maxOrderUsdt||notionalUsdt>this.state.usdt||this.state.dailyRealisedLossUsdt>=this.caps.dailyLossStopUsdt) return null;
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
      const p=this.position(tick.symbol);
      if(!p) this.state.positions.push({symbol:tick.symbol,quantity,entryPrice:price,entryTs:tick.ts,costUsdt:total,peakBid:tick.bid});
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
    if(this.occupiedSlots>=this.caps.maxPositions || this.position(tick.symbol) || this.openOrders.some(o=>o.symbol===tick.symbol&&o.side==='BUY') || !Number.isFinite(tick.ask) || tick.ask<=0 || notionalUsdt<=0 || notionalUsdt>this.caps.maxOrderUsdt || notionalUsdt>this.state.usdt || this.state.dailyRealisedLossUsdt>=this.caps.dailyLossStopUsdt) return null;
    const price=tick.ask*(1+(PAPER_SLIPPAGE_BPS+extraSlippageBps)/10_000);
    const feeUsdt=notionalUsdt*TAKER_FEE_BPS/10_000;
    const quantity=(notionalUsdt-feeUsdt)/price;
    const trade:RecordedTrade={id:randomUUID(),ts:tick.ts,symbol:tick.symbol,side:'BUY',quantity,price,notionalUsdt,feeUsdt,reason,mode:'paper'};
    this.state.usdt-=notionalUsdt;
    this.state.positions.push({symbol:tick.symbol,quantity,entryPrice:price,entryTs:tick.ts,costUsdt:notionalUsdt,peakBid:tick.bid});
    this.state.feesUsdt+=feeUsdt;
    this.store.trade(trade); this.save(); return trade;
  }
  sell(tick:MarketTick,reason:string,extraSlippageBps=0):RecordedTrade|null {
    this.rollDay(tick.ts);
    let cancelled=false;
    for(const order of this.state.orders??[]) if(order.symbol===tick.symbol&&order.side==='BUY'&&(order.status==='OPEN'||order.status==='PARTIALLY_FILLED')) { this.state.usdt+=order.reservedUsdt;order.reservedUsdt=0;order.status='CANCELLED';cancelled=true; }
    const p=this.position(tick.symbol);
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
    this.state.positions=this.state.positions.filter(position=>position.symbol!==tick.symbol);
    this.state.peakPortfolioUsdt=Math.max(this.state.peakPortfolioUsdt,this.state.usdt);
    this.store.trade(trade); this.save(); return trade;
  }
  mark(tick:MarketTick) { const p=this.position(tick.symbol); if(p&&tick.bid>p.peakBid){p.peakBid=tick.bid;this.save();} }
  portfolio(latest:Map<string,MarketTick>) {
    const holdings=this.state.positions.map(p=>{const bid=latest.get(p.symbol)?.bid??p.entryPrice;const valueUsdt=p.quantity*bid*(1-TAKER_FEE_BPS/10_000);return {symbol:p.symbol,quantity:p.quantity,valueUsdt,entryPrice:p.entryPrice,ageSeconds:Math.max(0,(Date.now()-p.entryTs)/1000)};});
    const holdingValue=holdings.reduce((sum,holding)=>sum+holding.valueUsdt,0);
    const costUsdt=this.state.positions.reduce((sum,position)=>sum+position.costUsdt,0);
    const reservedUsdt=this.openOrders.reduce((sum,order)=>sum+order.reservedUsdt,0);
    const total=this.state.usdt+reservedUsdt+holdingValue;
    this.state.peakPortfolioUsdt=Math.max(this.state.peakPortfolioUsdt,total);
    return {availableUsdt:this.state.usdt,holdings,portfolioUsdt:total,reservedUsdt,realisedPnlUsdt:this.state.realisedPnlUsdt,unrealisedPnlUsdt:holdingValue-costUsdt,feesUsdt:this.state.feesUsdt,drawdownPercent:this.state.peakPortfolioUsdt>0?(this.state.peakPortfolioUsdt-total)/this.state.peakPortfolioUsdt*100:0,openPositions:holdings.length};
  }
}
