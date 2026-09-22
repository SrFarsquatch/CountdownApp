import { saveState, normalizeMarkets, cleanText } from './state.js';

const marketNumber=value=>{const n=Number(value);return Number.isFinite(n)?n:null};

function normalizeInstrument(value={}){
  const source=typeof value==='string'?{symbol:value}:value||{};
  const providerSymbol=cleanText(source.providerSymbol||source.symbol,32).toUpperCase();
  return{
    symbol:cleanText(source.symbol||providerSymbol,32).toUpperCase(),
    providerSymbol,
    name:cleanText(source.name,120),
    exchange:cleanText(source.exchange||source.region,80),
    region:cleanText(source.region||source.country,80),
    type:cleanText(source.type||source.asset_type,60),
    currency:cleanText(source.currency||source.currency_name,12).toUpperCase(),
    marketOpen:cleanText(source.marketOpen,20),
    marketClose:cleanText(source.marketClose,20),
    timezone:cleanText(source.timezone,60),
    matchScore:cleanText(source.matchScore,20)
  };
}
function unavailable(item,message='Tickerbot returned no quote for this symbol.'){
  return{...normalizeInstrument(item),close:null,open:null,high:null,low:null,previousClose:null,change:null,percentChange:null,volume:null,marketOpen:null,datetime:'',available:false,error:cleanText(message,220)};
}
function marketApiKey(env){
  return String(env.TICKERBOT_API_KEY||'').trim();
}
async function requestTickerbot(state,env,path){
  const apiKey=marketApiKey(env);
  if(!apiKey)throw new Error('TICKERBOT_API_KEY is not configured as a Cloudflare Worker secret.');
  const response=await fetch('https://api.tickerbot.io/v2/'+String(path||'').replace(/^\/+/,''),{
    headers:{Authorization:'Bearer '+apiKey,Accept:'application/json'}
  });
  const raw=await response.json().catch(()=>({}));
  if(!response.ok){
    const message=cleanText(raw?.error?.message||raw?.message||raw?.error||'',260);
    if(response.status===401)throw new Error('Tickerbot rejected the saved API key.');
    if(response.status===429)throw new Error('Tickerbot rate limit reached. Quest Log will keep using cached market data.');
    throw new Error(message||'Tickerbot request failed ('+response.status+').');
  }
  return raw;
}
function quoteFromTickerbot(raw={},fallback={},asOf=''){
  const requested=normalizeInstrument(fallback),close=marketNumber(raw.price),percentChange=marketNumber(raw.change_1d_pct);
  const previousClose=close!=null&&percentChange!=null&&Math.abs(100+percentChange)>0.0001?close/(1+percentChange/100):null;
  const change=close!=null&&previousClose!=null?close-previousClose:null;
  return{
    ...requested,
    symbol:cleanText(raw.ticker||requested.symbol,32).toUpperCase(),
    providerSymbol:cleanText(raw.ticker||requested.providerSymbol,32).toUpperCase(),
    name:cleanText(raw.name||requested.name,120),
    exchange:cleanText(raw.exchange||requested.exchange,80),
    region:cleanText(raw.country||requested.region,80).toUpperCase(),
    type:cleanText(raw.asset_type||requested.type,60),
    currency:cleanText(raw.currency_name||requested.currency||'USD',12).toUpperCase(),
    close,
    open:null,
    high:null,
    low:null,
    volume:marketNumber(raw.volume_today),
    datetime:cleanText(raw.date||asOf,50),
    previousClose,
    change,
    percentChange,
    marketOpen:null,
    available:close!==null,
    error:''
  };
}
export async function marketData(state,env){
  const config=normalizeMarkets(state.markets),key='tickerbot:'+config.watchlist.map(x=>x.providerSymbol).join(','),cache=state.marketCache||null;
  if(cache?.data&&cache.key===key&&Number(cache.expiresAt)>Date.now())return cache.data;
  if(!config.watchlist.length){
    const data={provider:'Tickerbot',quotes:[],watchlist:[],symbols:[],updatedAt:new Date().toISOString(),refreshMinutes:config.refreshMinutes,effectiveRefreshMinutes:config.refreshMinutes,freeMonthlyRequestLimit:10000,batchSize:50};
    state.marketCache={key,expiresAt:Date.now()+config.refreshMinutes*60000,data};if(env.DB)await saveState(env,state);return data;
  }
  let raw;
  try{
    const symbols=config.watchlist.map(item=>encodeURIComponent(item.providerSymbol)).join(',');
    raw=await requestTickerbot(state,env,'tickers/'+symbols);
  }catch(error){
    if(cache?.data)return{...cache.data,quotes:(cache.data.quotes||[]).map(q=>({...q,stale:true,error:error.message||'Using cached quote.'}))};
    throw error;
  }
  const rows=raw?.data&&typeof raw.data==='object'?raw.data:{},notFound=new Set((raw?.not_found||[]).map(x=>String(x).toUpperCase()));
  const quotes=config.watchlist.map(item=>{
    const symbol=item.providerSymbol.toUpperCase(),row=rows[symbol]||rows[item.symbol?.toUpperCase?.()];
    if(row)return quoteFromTickerbot(row,item,raw.as_of||'');
    return unavailable(item,notFound.has(symbol)?'Tickerbot does not track this symbol.':'Tickerbot returned no quote for this symbol.');
  });
  const data={provider:'Tickerbot',quotes,watchlist:config.watchlist,symbols:config.watchlist.map(x=>x.symbol),updatedAt:new Date().toISOString(),providerAsOf:cleanText(raw.as_of,50),refreshMinutes:config.refreshMinutes,effectiveRefreshMinutes:config.refreshMinutes,freeMonthlyRequestLimit:10000,batchSize:50};
  state.marketCache={key,expiresAt:Date.now()+config.refreshMinutes*60000,data};if(env.DB)await saveState(env,state);return data;
}
export async function marketSearch(query,state,env){
  const q=cleanText(query,64).trim();if(!q)return[];
  const raw=await requestTickerbot(state,env,'tickers?search='+encodeURIComponent(q)+'&asset_class=stocks&limit=10');
  return(raw.results||[]).filter(item=>item?.active!==false).slice(0,10).map(item=>normalizeInstrument({
    symbol:item.ticker,
    providerSymbol:item.ticker,
    name:item.name,
    type:item.asset_type,
    region:item.country,
    exchange:item.exchange,
    currency:item.currency_name
  })).filter(x=>x.providerSymbol);
}
export async function testMarketConnection(state,env){
  const raw=await requestTickerbot(state,env,'tickers/SPY');
  return{ok:Boolean(raw?.data),provider:'Tickerbot',ticker:raw?.data?.ticker||'SPY',name:raw?.data?.name||''};
}
