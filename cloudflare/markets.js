import YahooFinance from 'yahoo-finance2';
import { saveMarketCache, normalizeMarkets, cleanText } from './state.js';

const yahooFinance=new YahooFinance({queue:{concurrency:2,interval:250}});
const marketNumber=value=>{const n=Number(value);return Number.isFinite(n)?n:null};
const isoDate=value=>{
  if(!value)return'';
  const d=value instanceof Date?value:new Date(value);
  return Number.isNaN(d.getTime())?'':d.toISOString();
};

function normalizeInstrument(value={}){
  const source=typeof value==='string'?{symbol:value}:value||{};
  let providerSymbol=cleanText(source.providerSymbol||source.symbol,32).toUpperCase()
    .replace(/\.TRT$/i,'.TO').replace(/\.TRV$/i,'.V');
  const exchange=cleanText(source.exchange||source.region,80),region=cleanText(source.region||source.country,80);
  if(providerSymbol&&!providerSymbol.includes('.')&&!providerSymbol.includes('=')&&!providerSymbol.includes('-')){
    if(/TSXV|VENTURE/i.test(exchange)||/VENTURE/i.test(region))providerSymbol+='.V';
    else if(/TSX|TORONTO/i.test(exchange)||/TORONTO|CANADA/i.test(region))providerSymbol+='.TO';
  }
  return{
    symbol:cleanText(source.symbol||providerSymbol,32).toUpperCase().replace(/\.(TO|V)$/i,''),
    providerSymbol,
    name:cleanText(source.name||source.shortname||source.longname,120),
    exchange,
    region,
    type:cleanText(source.type||source.quoteType||source.typeDisp,60),
    currency:cleanText(source.currency,12).toUpperCase(),
    marketOpen:cleanText(source.marketOpen,20),
    marketClose:cleanText(source.marketClose,20),
    timezone:cleanText(source.timezone||source.exchangeTimezoneName,60),
    matchScore:cleanText(source.matchScore,20)
  };
}
function unavailable(item,message='Yahoo Finance returned no quote for this symbol.'){
  return{...normalizeInstrument(item),close:null,open:null,high:null,low:null,previousClose:null,change:null,percentChange:null,volume:null,marketOpen:null,datetime:'',available:false,error:cleanText(message,220)};
}
function quoteFromYahoo(raw={},fallback={}){
  const requested=normalizeInstrument(fallback),close=marketNumber(raw.regularMarketPrice);
  return{
    ...requested,
    symbol:cleanText(raw.symbol||requested.symbol,32).toUpperCase().replace(/\.(TO|V)$/i,''),
    providerSymbol:cleanText(raw.symbol||requested.providerSymbol,32).toUpperCase(),
    name:cleanText(raw.longName||raw.shortName||raw.displayName||requested.name,120),
    exchange:cleanText(raw.fullExchangeName||raw.exchange||requested.exchange,80),
    region:cleanText(raw.region||requested.region,80).toUpperCase(),
    type:cleanText(raw.quoteType||raw.typeDisp||requested.type,60),
    currency:cleanText(raw.currency||requested.currency,12).toUpperCase(),
    timezone:cleanText(raw.exchangeTimezoneName||requested.timezone,60),
    close,
    open:marketNumber(raw.regularMarketOpen),
    high:marketNumber(raw.regularMarketDayHigh??raw.dayHigh),
    low:marketNumber(raw.regularMarketDayLow??raw.dayLow),
    volume:marketNumber(raw.regularMarketVolume??raw.volume),
    datetime:isoDate(raw.regularMarketTime),
    previousClose:marketNumber(raw.regularMarketPreviousClose),
    change:marketNumber(raw.regularMarketChange),
    percentChange:marketNumber(raw.regularMarketChangePercent),
    marketOpen:String(raw.marketState||'').toUpperCase()==='REGULAR',
    available:close!==null,
    error:''
  };
}
export async function marketData(state,env){
  const config=normalizeMarkets(state.markets),key='yahoo:'+config.watchlist.map(x=>x.providerSymbol).join(','),cache=state.marketCache||null;
  if(cache?.data&&cache.key===key&&Number(cache.expiresAt)>Date.now())return cache.data;
  if(!config.watchlist.length){
    const data={provider:'Yahoo Finance',quotes:[],watchlist:[],symbols:[],updatedAt:new Date().toISOString(),refreshMinutes:config.refreshMinutes,effectiveRefreshMinutes:config.refreshMinutes,batchSize:50,unofficial:true};
    state.marketCache={key,expiresAt:Date.now()+config.refreshMinutes*60000,data};if(env.DB)await saveMarketCache(env,state.marketCache);return data;
  }
  let rows=[];
  try{
    rows=await yahooFinance.quote(config.watchlist.map(item=>item.providerSymbol),{fields:[
      'symbol','shortName','longName','displayName','quoteType','typeDisp','currency','region','exchange','fullExchangeName','exchangeTimezoneName',
      'marketState','regularMarketPrice','regularMarketOpen','regularMarketDayHigh','regularMarketDayLow','regularMarketVolume',
      'regularMarketPreviousClose','regularMarketChange','regularMarketChangePercent','regularMarketTime'
    ]});
    if(!Array.isArray(rows))rows=rows?[rows]:[];
  }catch(error){
    if(cache?.data)return{...cache.data,quotes:(cache.data.quotes||[]).map(q=>({...q,stale:true,error:'Yahoo Finance refresh failed. Using cached quote.'}))};
    throw new Error('Yahoo Finance quote request failed: '+cleanText(error?.message||error,180));
  }
  const bySymbol=new Map(rows.map(row=>[String(row?.symbol||'').toUpperCase(),row]));
  const quotes=config.watchlist.map(item=>{
    const row=bySymbol.get(item.providerSymbol.toUpperCase());
    return row?quoteFromYahoo(row,item):unavailable(item);
  });
  const data={provider:'Yahoo Finance',quotes,watchlist:config.watchlist,symbols:config.watchlist.map(x=>x.symbol),updatedAt:new Date().toISOString(),refreshMinutes:config.refreshMinutes,effectiveRefreshMinutes:config.refreshMinutes,batchSize:50,unofficial:true};
  state.marketCache={key,expiresAt:Date.now()+config.refreshMinutes*60000,data};if(env.DB)await saveMarketCache(env,state.marketCache);return data;
}
const marketHistoryCache=new Map();
export async function marketHistory(state){
  const config=normalizeMarkets(state.markets),watchlist=(config.watchlist||[]).slice(0,8);
  if(!watchlist.length)return{provider:'Yahoo Finance',mode:'equal-weight',symbols:[],points:[],updatedAt:new Date().toISOString()};
  const key='annual:'+watchlist.map(item=>item.providerSymbol).join(',');
  const cached=marketHistoryCache.get(key);
  if(cached&&cached.expiresAt>Date.now())return cached.data;
  const period2=new Date(),period1=new Date(period2.getTime()-370*86400000);
  const settled=await Promise.allSettled(watchlist.map(async item=>{
    const chart=await yahooFinance.chart(item.providerSymbol,{period1,period2,interval:'1d'});
    const rows=(chart?.quotes||[]).map(row=>({date:isoDate(row.date).slice(0,10),close:marketNumber(row.adjclose??row.close)})).filter(row=>row.date&&row.close!==null&&row.close>0);
    if(rows.length<2)return null;
    const base=rows[0].close;
    return{symbol:item.symbol,providerSymbol:item.providerSymbol,points:rows.map(row=>({date:row.date,value:(row.close/base-1)*100}))};
  }));
  const series=settled.filter(result=>result.status==='fulfilled'&&result.value).map(result=>result.value);
  const buckets=new Map();
  for(const item of series){
    for(const point of item.points){
      const bucket=buckets.get(point.date)||[];
      bucket.push(point.value);buckets.set(point.date,bucket);
    }
  }
  const points=[...buckets.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([date,values])=>({
    date,
    value:values.reduce((sum,value)=>sum+value,0)/values.length
  }));
  const data={provider:'Yahoo Finance',mode:'equal-weight',symbols:series.map(item=>item.symbol),points,updatedAt:new Date().toISOString()};
  if(marketHistoryCache.size>50)marketHistoryCache.clear();
  marketHistoryCache.set(key,{expiresAt:Date.now()+10*60000,data});
  return data;
}
export async function marketSearch(query,state,env){
  const q=cleanText(query,80).trim();if(!q)return[];
  let raw;
  try{
    raw=await yahooFinance.search(q,{region:'CA',lang:'en-CA',quotesCount:12,newsCount:0,enableCb:false,enableNavLinks:false});
  }catch(error){throw new Error('Yahoo Finance search failed: '+cleanText(error?.message||error,180))}
  return(raw?.quotes||[]).filter(item=>item?.isYahooFinance!==false&&item?.symbol&&['EQUITY','ETF','MUTUALFUND','INDEX','CURRENCY','CRYPTOCURRENCY','FUTURE'].includes(String(item.quoteType||'').toUpperCase())).slice(0,10).map(item=>normalizeInstrument({
    symbol:item.symbol,
    providerSymbol:item.symbol,
    name:item.longname||item.shortname,
    type:item.quoteType||item.typeDisp,
    exchange:item.exchDisp||item.exchange,
    region:/\.(TO|V)$/i.test(item.symbol)?'Canada':'',
    currency:/\.(TO|V)$/i.test(item.symbol)?'CAD':''
  })).filter(x=>x.providerSymbol);
}
export async function testMarketConnection(){
  try{
    const raw=await yahooFinance.quote('SPY',{fields:['symbol','shortName','longName','regularMarketPrice','currency']});
    return{ok:Boolean(raw?.symbol&&marketNumber(raw?.regularMarketPrice)!==null),provider:'Yahoo Finance',ticker:raw?.symbol||'SPY',name:raw?.longName||raw?.shortName||''};
  }catch(error){throw new Error('Yahoo Finance connection failed: '+cleanText(error?.message||error,180))}
}
