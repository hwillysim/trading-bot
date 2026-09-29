import { chmodSync, createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import type { BotEngine } from './engine.ts';
import { JevClient } from '../models/jev.ts';
import { OpenAIReviewer } from '../models/reviewer.ts';

const contentTypes:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
const host='127.0.0.1';
const port=Number(process.env.PORT??3000);
const dist=resolve('web/dist');
const envPath=resolve('.env');
const credentialNames=['JEV_API_KEY','OPENAI_API_KEY','BINANCE_API_KEY','BINANCE_API_SECRET'] as const;
type CredentialName=typeof credentialNames[number];
const credentialStatus=()=>Object.fromEntries(credentialNames.map(name=>[name,Boolean(process.env[name])])) as Record<CredentialName,boolean>;

function saveCredentials(values:unknown) {
  if(!values||typeof values!=='object'||Array.isArray(values)) throw new Error('Invalid credentials');
  const fields=values as Record<string,unknown>;
  if(Object.keys(fields).some(key=>!credentialNames.includes(key as CredentialName))) throw new Error('Unsupported credential');
  for(const value of Object.values(fields)) if(typeof value!=='string'||value.length>4096||/[\r\n\0]/.test(value)) throw new Error('Invalid credential value');
  let lines=(existsSync(envPath)?readFileSync(envPath,'utf8'):'').split(/\r?\n/);
  const updates:Partial<Record<CredentialName,string>>={};
  for(const name of credentialNames) {
    const value=fields[name];
    if(typeof value!=='string'||!value.trim()) continue;
    updates[name]=value.trim();
    const prefix=`${name}=`;
    const indexes=lines.flatMap((line,index)=>line.startsWith(prefix)?[index]:[]);
    if(indexes.length) {
      lines[indexes[0]]=`${prefix}${value.trim()}`;
      lines=lines.filter((_,index)=>index===indexes[0]||!indexes.includes(index));
    } else lines.push(`${prefix}${value.trim()}`);
  }
  writeFileSync(envPath,lines.join('\n').replace(/\n*$/,'\n'),{mode:0o600});
  chmodSync(envPath,0o600);
  for(const [name,value] of Object.entries(updates)) process.env[name as CredentialName]=value;
}

function send(res:ServerResponse,status:number,data:unknown) {
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(JSON.stringify(data));
}

function sameOrigin(req:IncomingMessage):boolean {
  const origin=req.headers.origin;
  if(!origin) return true;
  try { const url=new URL(origin);return url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)&&[port,5173].includes(Number(url.port||80)); }
  catch {return false;}
}

async function body(req:IncomingMessage):Promise<unknown> {
  let text='';
  for await(const part of req) {text+=part;if(text.length>8_192) throw new Error('Request too large');}
  return JSON.parse(text||'{}');
}

export function startServer(engine:BotEngine) {
  const clients=new Set<ServerResponse>();
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url??'/',`http://${host}:${port}`);
    if(req.method==='GET'&&url.pathname==='/api/state') return send(res,200,engine.state());
    if(req.method==='GET'&&url.pathname==='/api/config') return send(res,200,{credentials:credentialStatus(),liveTradingAvailable:false});
    if(req.method==='POST'&&url.pathname==='/api/config') {
      if(!sameOrigin(req)) return send(res,403,{error:'Invalid origin'});
      if(!String(req.headers['content-type']??'').startsWith('application/json')) return send(res,415,{error:'JSON required'});
      try {
        const data=await body(req) as {credentials?:unknown};
        saveCredentials(data.credentials);
        engine.setClients(process.env.JEV_API_KEY?new JevClient():null,process.env.OPENAI_API_KEY?new OpenAIReviewer():null);
        return send(res,200,{credentials:credentialStatus(),liveTradingAvailable:false});
      } catch(error) {return send(res,400,{error:error instanceof Error?error.message:'Invalid credentials'});}
    }
    if(req.method==='GET'&&url.pathname==='/api/portfolio') {
      const ranges:Record<string,[number,number]>={'15m':[15*60_000,5_000],'1h':[60*60_000,15_000],'24h':[24*60*60_000,5*60_000],'7d':[7*24*60*60_000,30*60_000],all:[Infinity,60*60_000]};
      const [duration,bucket]=ranges[url.searchParams.get('range')??'1h']??ranges['1h'];
      const runId=engine.portfolioRunId;
      const oldest=engine.store.oldestPortfolioTs(runId);
      const resolution=Number.isFinite(duration)?bucket:Math.max(bucket,Math.ceil((Date.now()-(oldest??Date.now()))/499));
      return send(res,200,{runId,points:engine.store.portfolioHistory(Number.isFinite(duration)?Date.now()-duration:0,resolution,500,runId)});
    }
    if(req.method==='GET'&&url.pathname==='/api/events') {
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache, no-transform','connection':'keep-alive','x-content-type-options':'nosniff'});
      res.write(`event: state\ndata: ${JSON.stringify(engine.state())}\n\n`);
      clients.add(res);req.on('close',()=>clients.delete(res));return;
    }
    if(req.method==='POST'&&url.pathname==='/api/control') {
      if(!sameOrigin(req)) return send(res,403,{error:'Invalid origin'});
      if(!String(req.headers['content-type']??'').startsWith('application/json')) return send(res,415,{error:'JSON required'});
      try {
        const data=await body(req) as {action?:string;caps?:Record<string,number>;startingUsdt?:number};
        return send(res,200,engine.control(data.action??'',data.caps,data.startingUsdt));
      } catch(error) {return send(res,400,{error:error instanceof Error?error.message:'Invalid control'});}
    }
    if(url.pathname.startsWith('/api/')) return send(res,404,{error:'Not found'});
    if(req.method!=='GET') return send(res,405,{error:'Method not allowed'});
    const target=resolve(dist,`.${url.pathname==='/'?'/index.html':url.pathname}`);
    const file=target.startsWith(dist+sep)&&existsSync(target)&&statSync(target).isFile()?target:resolve(dist,'index.html');
    if(!existsSync(file)) {res.writeHead(503,{'content-type':'text/plain; charset=utf-8'});res.end('Dashboard not built. Run npm run web:install and npm run web:build.');return;}
    res.writeHead(200,{'content-type':contentTypes[extname(file)]??'application/octet-stream','x-content-type-options':'nosniff','cache-control':file.endsWith('index.html')?'no-store':'public, max-age=3600'});
    createReadStream(file).pipe(res);
  });
  const broadcast=setInterval(()=>{
    const payload=`event: state\ndata: ${JSON.stringify(engine.state())}\n\n`;
    for(const client of clients) client.write(payload);
  },2_000);
  server.listen(port,host);
  server.on('close',()=>clearInterval(broadcast));
  return server;
}
