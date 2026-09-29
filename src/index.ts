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
let pinnedSymbol='';
const feed=new BinanceMarketFeed(tick=>{
  engine.onTick(tick);
  const held=engine.paper.state.position?.symbol??'';
  if(held!==pinnedSymbol) {pinnedSymbol=held;feed.setPinnedSymbols(held?[held]:[]);}
  features.add(tick);
  if(tick.ts-(lastFeatureAt.get(tick.symbol)??0)<1_000) return;
  lastFeatureAt.set(tick.symbol,tick.ts);
  const f=features.calculate(tick.symbol,tick.ts);
  if(f) engine.onFeatures(f);
},rules=>engine.setRules(rules));
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
  engine.scan();
  void engine.reviewIfDue();
  engine.checkRollback();
},5_000);
const cleanup=setInterval(()=>store.prune(Date.now()-7*24*60*60*1000),60*60*1000);
const portfolioRecording=setInterval(()=>engine.recordPortfolio(),10_000);

function shutdown() {
  clearInterval(maintenance);clearInterval(cleanup);clearInterval(portfolioRecording);feed.stop();server.close();store.close();
}
process.on('SIGINT',()=>{shutdown();process.exit(0);});
process.on('SIGTERM',()=>{shutdown();process.exit(0);});
