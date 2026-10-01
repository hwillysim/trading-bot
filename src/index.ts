import { BinanceMarketFeed, RollingMarketFeatures } from './market/index.ts';
import { JevClient } from './models/jev.ts';
import { OpenAIReviewer } from './models/reviewer.ts';
import { BotEngine } from './core/engine.ts';
import { startServer } from './core/server.ts';
import { Store } from './core/store.ts';

const store=new Store(process.env.BOT_DB_PATH??'data/trading-bot.sqlite');
const engine=new BotEngine(store,process.env.JEV_API_KEY?new JevClient():null,process.env.OPENAI_API_KEY?new OpenAIReviewer():null);
const features=new RollingMarketFeatures();
const lastFeatureAt=new Map<string,number>();
let pinnedSymbols='';
const feed=new BinanceMarketFeed(tick=>{
  engine.onTick(tick);
  refreshPinnedSymbols();
  features.add(tick);
  if(tick.ts-(lastFeatureAt.get(tick.symbol)??0)<1_000) return;
  lastFeatureAt.set(tick.symbol,tick.ts);
  const orderUsdt=Math.min(engine.caps.maxOrderUsdt,engine.caps.floatUsdt*engine.strategy.positionFraction);
  const f=features.calculate(tick.symbol,tick.ts,orderUsdt);
  if(f) {f.btcReturn15s=engine.features.get('BTCUSDT')?.return15s??0;f.ethReturn15s=engine.features.get('ETHUSDT')?.return15s??0;engine.onFeatures(f);}
},rules=>engine.setRules(rules));
function refreshPinnedSymbols() {
  const symbols=[...new Set([...engine.paper.state.positions.map(position=>position.symbol),...engine.paper.openOrders.map(order=>order.symbol),...engine.research.symbols])].sort();
  const key=symbols.join(',');
  if(key!==pinnedSymbols) {pinnedSymbols=key;feed.setPinnedSymbols(symbols);}
}
refreshPinnedSymbols();
const server=startServer(engine);
engine.recordPortfolio();

let restarting=false;
async function startFeed() {
  if(restarting) return;
  restarting=true;
  try {await feed.start();store.event('feed_start',{status:'connecting'});}
  catch(error) {engine.setFeedConnected(false);store.event('feed_start_error',{message:error instanceof Error?error.message:String(error)});setTimeout(()=>{restarting=false;void startFeed();},30_000);return;}
  restarting=false;
}
void startFeed();

const maintenance=setInterval(()=>{
  if(Date.now()-engine.health.lastTickTs>10_000) engine.setFeedConnected(false);
  engine.setMonitoredMarketCount(feed.monitoredCount);
  engine.scan();
  refreshPinnedSymbols();
  void engine.reviewIfDue();

},500);
const cleanup=setInterval(()=>store.prune(Date.now()-7*24*60*60*1000),60*60*1000);
const portfolioRecording=setInterval(()=>engine.recordPortfolio(),10_000);

function shutdown() {
  clearInterval(maintenance);clearInterval(cleanup);clearInterval(portfolioRecording);feed.stop();server.close();store.close();
}
process.on('SIGINT',()=>{shutdown();process.exit(0);});
process.on('SIGTERM',()=>{shutdown();process.exit(0);});
