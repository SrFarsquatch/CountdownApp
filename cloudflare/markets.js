import { saveState, normalizeMarkets, cleanText } from './state.js';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const marketNumber=value=>{const n=Number(String(value??'').replace('%',''));return Number.isFinite(n)?n:null};
function normalizeInstrument(value={}){
  const source=typeof value==='string'?{symbol:value}:value||{};
  const providerSymbol=cleanText(source.providerSymbol||source.symbol,32).toUpperCase();
  const displaySymbol=cleanText(source.symbol||providerSymbol,32).toUpperCase().replace(/\.(TRT|TRV)$/i,'');
  return{symbol:displaySymbol,providerSymbol,name:cleanText(source.name,120),exchange:cleanText(source.exchange||source.region,80),region:cleanText(source.region||source.country,80),type:cleanText(source.type,60),currency:cleanText(source.currency,12).toUpperCase(),marketOpen:cleanText(source.marketOpen,20),marketClose:cleanText(source.marketClose,20),timezone:cleanText(source.timezone,60),matchScore:cleanText(source.matchScore,20)};
}
function effectiveRefresh(config){
  const count=Math.max(1,config.watchlist.length),quotaSafe=Math.ceil((count*1440)/20);
  return Math.max(config.refreshMinutes,quotaSafe);
}
function quoteFromRaw(raw={},fallback={}){
  const requested=normalizeInstrument(fallback),close=marketNumber(raw['05. price']);
  return{...requested,providerSymbol:cleanText(raw['01. symbol']||requested.providerSymbol,32).toUpperCase(),close,open:marketNumber(raw['02. open']),high:marketNumber(raw['03. high']),low:marketNumber(raw['04. low']),volume:marketNumber(raw['06. volume']),datetime:cleanText(raw['07. latest trading day']||'',50),previousClose:marketNumber(raw['08. previous close']),change:marketNumber(raw['09. change']),percentChange:marketNumber(raw['10. change percent']),marketOpen:null,available:close!==null,error:''};
}
function unavailable(item,message='No quote returned for this watchlist symbol.'){
  return{...normalizeInstrument(item),close:null,open:null,high:null,low:null,previousClose:null,change:null,percentChange:null,volume:null,marketOpen:null,datetime:'',available:false,error:cleanText(message,220)};
}
function providerError(raw={},status=0){
  const message=cleanText(raw['Error Message']||raw.Note||raw.Information||'',260);
  if(/1 request per second|spread.*sparsely|call frequency/i.test(message))return{kind:'burst',message:'Alpha Vantage rate limit hit. Quest Log will retry automatically.'};
  if(/25 requests per day|daily.*limit|standard api call frequency/i.test(message))return{kind:'daily',message:'Alpha Vantage daily free API limit reached. Cached market data will be used until the allowance resets.'};
  return{kind:'api',message:message||'Alpha Vantage request failed ('+status+').'};
}
async function requestAlpha(env,params={}){
  if(!env.ALPHA_VANTAGE_API_KEY)throw new Error('ALPHA_VANTAGE_API_KEY is not configured as a Worker secret.');
  for(let attempt=0;attempt<2;attempt++){
    const q=new URLSearchParams({...params,apikey:env.ALPHA_VANTAGE_API_KEY});
    const response=await fetch('https://www.alphavantage.co/query?'+q),raw=await response.json().catch(()=>({})),err=providerError(raw,response.status);
    if(response.ok&&!raw['Error Message']&&!raw.Note&&!raw.Information)return raw;
    if(err.kind==='burst'&&attempt===0){await sleep(1250);continue}
    const e=new Error(err.message);e.kind=err.kind;throw e;
  }
  const e=new Error('Alpha Vantage rate limit hit. Try again shortly.');e.kind='burst';throw e;
}
export async function marketData(state,env){
  const config=normalizeMarkets(state.markets),refresh=effectiveRefresh(config),key=config.watchlist.map(x=>x.providerSymbol).join(','),cache=state.marketCache||null;
  if(cache?.data&&cache.key===key&&Number(cache.expiresAt)>Date.now())return cache.data;
  const quotes=[];
  for(let i=0;i<config.watchlist.length;i++){
    const item=config.watchlist[i];
    if(item.providerSymbol.includes('/')){quotes.push(unavailable(item,'Crypto pairs are not included in the Alpha Vantage stock quote watchlist.'));continue}
    try{
      const raw=await requestAlpha(env,{function:'GLOBAL_QUOTE',symbol:item.providerSymbol}),quote=raw['Global Quote']||{};
      quotes.push(Object.keys(quote).length?quoteFromRaw(quote,item):unavailable(item,'Alpha Vantage returned no quote for this symbol.'));
    }catch(error){
      const stale=cache?.data?.quotes?.find(q=>q.providerSymbol===item.providerSymbol||q.symbol===item.symbol);
      quotes.push(stale?.close!=null?{...stale,stale:true,error:error.message||'Using cached quote.'}:unavailable(item,error.message||'Quote unavailable.'));
      if(error.kind==='daily'){
        for(let j=i+1;j<config.watchlist.length;j++){
          const next=config.watchlist[j],old=cache?.data?.quotes?.find(q=>q.providerSymbol===next.providerSymbol||q.symbol===next.symbol);
          quotes.push(old?.close!=null?{...old,stale:true,error:'Using cached quote because the Alpha Vantage daily free API limit was reached.'}:unavailable(next,'Skipped because the Alpha Vantage daily free API limit was reached.'));
        }
        break;
      }
    }
    if(i<config.watchlist.length-1)await sleep(1150);
  }
  const data={provider:'Alpha Vantage',quotes,watchlist:config.watchlist,symbols:config.watchlist.map(x=>x.symbol),updatedAt:new Date().toISOString(),refreshMinutes:config.refreshMinutes,effectiveRefreshMinutes:refresh,freeDailyRequestLimit:25};
  state.marketCache={key,expiresAt:Date.now()+refresh*60000,data};if(env.DB)await saveState(env,state);return data;
}
export async function marketSearch(query,env){
  const q=cleanText(query,80).trim();if(!q)return[];
  const raw=await requestAlpha(env,{function:'SYMBOL_SEARCH',keywords:q});
  return(raw.bestMatches||[]).slice(0,10).map(item=>{
    const providerSymbol=cleanText(item['1. symbol'],32).toUpperCase();
    return normalizeInstrument({symbol:providerSymbol.replace(/\.(TRT|TRV)$/i,''),providerSymbol,name:item['2. name'],type:item['3. type'],region:item['4. region'],exchange:item['4. region'],marketOpen:item['5. marketOpen'],marketClose:item['6. marketClose'],timezone:item['7. timezone'],currency:item['8. currency'],matchScore:item['9. matchScore']});
  }).filter(x=>x.providerSymbol);
}
