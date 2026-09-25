import { financeSummary as plaidSummary, createFinanceLinkToken, exchangeFinancePublicToken, syncFinance as syncPlaid, disconnectFinanceItem as disconnectPlaid, saveFinancePreferences, plaidConfigured } from './plaid.js';
import { externalProviders, startExternalFinance, completeExternalFinance, syncExternalFinance, disconnectExternalFinance, externalFinanceSummary } from './external-finance.js';

function prefixPlaid(items=[]){return items.map(x=>({...x,itemId:String(x.itemId||'').startsWith('plaid:')?x.itemId:'plaid:'+x.itemId,provider:'plaid',providerName:'Plaid'}))}
export async function financeSummary(env,identity,{sync=true}={}){
  const plaid=await plaidSummary(env,identity,{sync});
  const external=await externalFinanceSummary(env,identity,{sync});
  const providers=[{id:'plaid',name:'Plaid',configured:plaidConfigured(env),environment:plaid.environment||''},...externalProviders(env)];
  const connections=[...prefixPlaid(plaid.connections),...(external.connections||[])];
  return {
    configured:providers.some(x=>x.configured),
    provider:'Multiple',
    providers,
    connections,
    accounts:[...prefixPlaid(plaid.accounts),...(external.accounts||[])],
    transactions:[...prefixPlaid(plaid.transactions),...(external.transactions||[])].sort((a,b)=>String(b.date||'').localeCompare(String(a.date||''))).slice(0,1500),
    preferences:plaid.preferences||{monthlySpendingTarget:null},
    errors:[...(plaid.errors||[]).map(e=>typeof e==='string'?{provider:'plaid',error:e}:{provider:'plaid',...e}),...(external.errors||[])],
    lastSyncedAt:connections.map(x=>x.lastSyncedAt).filter(Boolean).sort().at(-1)||null
  };
}
export function financeProviders(env){return[{id:'plaid',name:'Plaid',configured:plaidConfigured(env),environment:String(env.PLAID_ENV||'sandbox')},...externalProviders(env)]}
export async function startFinanceConnection(env,identity,provider='plaid',payload={}){
  const id=String(provider||'plaid').toLowerCase();
  if(id==='plaid')return{provider:'plaid',launch:'plaid',...(await createFinanceLinkToken(env,identity,payload.redirectUri||''))};
  return startExternalFinance(env,identity,id,payload);
}
export async function completeFinanceConnection(env,identity,provider,payload={}){
  const id=String(provider||'').toLowerCase();
  if(id==='plaid')return exchangeFinancePublicToken(env,identity,payload.publicToken,payload.metadata||{});
  return completeExternalFinance(env,identity,id,payload);
}
export async function syncFinance(env,identity,{force=true}={}){
  const errors=[];
  if(plaidConfigured(env))errors.push(...await syncPlaid(env,identity,{force}));
  errors.push(...await syncExternalFinance(env,identity));
  return errors;
}
export async function disconnectFinanceItem(env,identity,itemId){
  const id=String(itemId||'');
  if(id.startsWith('yodlee:')||id.startsWith('flinks:'))return disconnectExternalFinance(env,identity,id);
  return disconnectPlaid(env,identity,id.replace(/^plaid:/,''));
}
export { saveFinancePreferences };
