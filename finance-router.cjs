'use strict';
module.exports=function createFinanceRouter({plaid,yodlee,flinks}){
 const providers={plaid,yodlee,flinks};
 const names={plaid:'Plaid',yodlee:'Yodlee',flinks:'Flinks'};
 const available=()=>Object.entries(providers).map(([id,p])=>({id,name:names[id],configured:Boolean(p?.configured?.()),environment:p?.environment?.()||''}));
 const providerForItem=itemId=>String(itemId||'').split(':')[0]||'plaid';
 async function summary(sync=true){
  const results=[];for(const [id,p] of Object.entries(providers)){if(!p)continue;try{results.push([id,await p.summary(id==='flinks'?false:sync)])}catch(e){results.push([id,{configured:p.configured?.()||false,connections:[],accounts:[],transactions:[],errors:[{provider:id,error:e.message}]}])}}
  const plaidResult=results.find(x=>x[0]==='plaid')?.[1]||{};
  const connections=[],accounts=[],transactions=[],errors=[];
  for(const [id,r] of results){connections.push(...(r.connections||[]).map(x=>({...x,itemId:id==='plaid'&&!String(x.itemId).startsWith('plaid:')?'plaid:'+x.itemId:x.itemId,provider:id,providerName:names[id]})));accounts.push(...(r.accounts||[]).map(x=>({...x,itemId:id==='plaid'&&!String(x.itemId).startsWith('plaid:')?'plaid:'+x.itemId:x.itemId,provider:id})));transactions.push(...(r.transactions||[]).map(x=>({...x,itemId:id==='plaid'&&!String(x.itemId).startsWith('plaid:')?'plaid:'+x.itemId:x.itemId,provider:id})));errors.push(...(r.errors||[]).map(e=>typeof e==='string'?{provider:id,error:e}:{provider:id,...e}))}
  return{configured:available().some(x=>x.configured),provider:'Multiple',providers:available(),connections,accounts,transactions:transactions.sort((a,b)=>String(b.date||'').localeCompare(String(a.date||''))).slice(0,1500),preferences:plaidResult.preferences||{monthlySpendingTarget:null},errors,lastSyncedAt:connections.map(x=>x.lastSyncedAt).filter(Boolean).sort().at(-1)||null}
 }
 return{
  summary,providers:available,
  async start(provider,payload={}){const id=String(provider||'plaid').toLowerCase(),p=providers[id];if(!p?.configured?.()){const e=new Error((names[id]||provider)+' is not configured.');e.status=503;throw e}if(id==='plaid')return{provider:'plaid',launch:'plaid',...(await p.linkToken(payload.redirectUri||''))};return p.start(payload.itemId||'')},
  async complete(provider,payload={}){const id=String(provider||'').toLowerCase(),p=providers[id];if(!p){const e=new Error('Unknown finance provider.');e.status=400;throw e}if(id==='plaid')return p.exchange(payload.publicToken,payload.metadata||{});if(id==='flinks')return p.complete(payload.loginId,payload.institution);return p.complete(payload)},
  async sync(){const errors=[];for(const [id,p] of Object.entries(providers)){if(!p?.configured?.())continue;for(const e of await p.sync(true)||[])errors.push({provider:id,...e})}return errors},
  async disconnect(itemId){const id=providerForItem(itemId),p=providers[id]||providers.plaid;const raw=id==='plaid'?String(itemId).replace(/^plaid:/,''):itemId;return p.disconnect(raw)},
  async savePreferences(payload){return plaid.savePreferences(payload)}
 }
};