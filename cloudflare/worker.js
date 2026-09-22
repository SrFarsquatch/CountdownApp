import {
  loadState, saveState, publicState, id, cleanText, iso, num, clamp, en,
  normalizeCountdown, normalizeTask, normalizeGoal, normalizeWeather,
  normalizeAppearance, normalizeMarkets, normalizeSectionLayout,
  normalizeModeLayouts, normalizeModeSections, normalizeSectionOrder,
  LAYOUTS, PALETTES, DATE_WIDGETS, DISPLAY_MODES, WEATHER_STYLES,
  APPEARANCE_MODES, UI_THEMES, UI_DENSITIES, AGENT_PROVIDERS
} from './state.js';
import {
  googleConfigured, accountCapabilities, startGoogleAuth, finishGoogleAuth,
  calendars, taskLists, eventsBetween, mutateEvent, syncGoogleTasks,
  disconnectAccount, createGoogleTaskLink, updateLinkedGoogleTask, deleteLinkedGoogleTask
} from './google.js';
import { marketData, marketSearch } from './markets.js';
import { testAgent, listAgentModels, saveAgentCredential, clearAgentCredential, chat, applyActions } from './agent.js';
import { buildDisplayFeed, displayRange, renderDisplaySvg } from './display.js';
import { notificationConfig, updateNotificationPreferences, registerSubscription, unregisterSubscription, sendTestNotification, runNotificationSweep } from './notifications.js';

let jwksCache={expiresAt:0,keys:[]};
const encoder=new TextEncoder(),decoder=new TextDecoder();

function json(data,status=200,headers={}){
  return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers}});
}
function text(data,status=200,type='text/plain; charset=utf-8',headers={}){
  return new Response(data,{status,headers:{'content-type':type,'cache-control':'no-store',...headers}});
}
async function body(request){
  const raw=await request.text();
  if(!raw)return{};
  try{return JSON.parse(raw)}catch{const e=new Error('Invalid JSON request.');e.status=400;throw e}
}
function cleanTeamDomain(value){
  return String(value||'').trim().replace(/^https?:\/\//i,'').replace(/\/$/,'').split('/')[0];
}
function accessLoginUrl(request,env,next='/'){
  const teamDomain=cleanTeamDomain(env.CF_ACCESS_TEAM_DOMAIN),audience=String(env.CF_ACCESS_AUD||'').trim();
  if(!teamDomain||!audience)throw new Error('Cloudflare Access is not configured.');
  let redirectPath='/';
  try{
    const base=new URL(request.url),target=new URL(String(next||'/'),base.origin);
    if(target.origin===base.origin)redirectPath=target.pathname+target.search;
  }catch{}
  const hostname=new URL(request.url).hostname;
  const login=new URL('/cdn-cgi/access/login/'+hostname,'https://'+teamDomain);
  login.search=new URLSearchParams({kid:audience,redirect_url:redirectPath}).toString();
  return login.toString();
}
function base64UrlBytes(value){
  const normalized=String(value||'').replace(/-/g,'+').replace(/_/g,'/');
  const padded=normalized+'='.repeat((4-normalized.length%4)%4);
  const raw=atob(padded);
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
function decodeJwtJson(value){return JSON.parse(decoder.decode(base64UrlBytes(value)))}
async function accessKeys(teamDomain){
  if(jwksCache.expiresAt>Date.now()&&jwksCache.keys.length)return jwksCache.keys;
  const response=await fetch('https://'+teamDomain+'/cdn-cgi/access/certs');
  if(!response.ok)throw new Error('Could not load Cloudflare Access signing keys.');
  const data=await response.json(),keys=Array.isArray(data?.keys)?data.keys:[];
  if(!keys.length)throw new Error('Cloudflare Access returned no signing keys.');
  jwksCache={expiresAt:Date.now()+5*60*1000,keys};return keys;
}
function audienceMatches(aud,expected){return Array.isArray(aud)?aud.includes(expected):aud===expected}
function emailAllowed(email,raw){
  const list=String(raw||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
  return !list.length||list.includes(String(email||'').trim().toLowerCase());
}
async function authenticate(request,env){
  if(String(env.AUTH_BYPASS||'').toLowerCase()==='true')return{email:env.DEV_USER_EMAIL||'local-dev@questlog.local',bypass:true};
  const teamDomain=cleanTeamDomain(env.CF_ACCESS_TEAM_DOMAIN),audience=String(env.CF_ACCESS_AUD||'').trim();
  if(!teamDomain||!audience){const e=new Error('Cloudflare Access is not configured.');e.status=503;throw e}
  const token=request.headers.get('cf-access-jwt-assertion');
  if(!token){const e=new Error('Cloudflare Access authentication is required.');e.status=401;throw e}
  const parts=token.split('.');
  if(parts.length!==3){const e=new Error('Invalid Cloudflare Access token.');e.status=401;throw e}
  let header,claims;
  try{header=decodeJwtJson(parts[0]);claims=decodeJwtJson(parts[1])}catch{const e=new Error('Invalid Cloudflare Access token.');e.status=401;throw e}
  if(header.alg!=='RS256'||!header.kid){const e=new Error('Unsupported Cloudflare Access token.');e.status=401;throw e}
  let keys=await accessKeys(teamDomain),jwk=keys.find(x=>x.kid===header.kid);
  if(!jwk){jwksCache.expiresAt=0;keys=await accessKeys(teamDomain);jwk=keys.find(x=>x.kid===header.kid)}
  if(!jwk){const e=new Error('Cloudflare Access signing key was not found.');e.status=401;throw e}
  const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  const verified=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,base64UrlBytes(parts[2]),encoder.encode(parts[0]+'.'+parts[1]));
  const now=Math.floor(Date.now()/1000),issuer=String(claims.iss||'').replace(/\/$/,'');
  if(!verified||issuer!==('https://'+teamDomain).replace(/\/$/,'')||!audienceMatches(claims.aud,audience)||!claims.exp||claims.exp<=now||(claims.nbf&&claims.nbf>now+30)){
    const e=new Error('Cloudflare Access token validation failed.');e.status=401;throw e;
  }
  const email=String(claims.email||'').trim().toLowerCase();
  if(!emailAllowed(email,env.ALLOWED_EMAILS)){const e=new Error('This account is not allowed to use Quest Log.');e.status=403;throw e}
  return{email,sub:String(claims.sub||''),bypass:false};
}

function weatherCodeInfo(code){
  const v=Number(code);
  if(v===0)return{condition:'CLEAR',description:'Clear sky'};
  if([1,2].includes(v))return{condition:'PARTLY_CLOUDY',description:v===1?'Mainly clear':'Partly cloudy'};
  if(v===3)return{condition:'CLOUDY',description:'Overcast'};
  if([45,48].includes(v))return{condition:'FOG',description:'Fog'};
  if([51,53,55,56,57].includes(v))return{condition:'DRIZZLE',description:'Drizzle'};
  if([61,63,65,66,67].includes(v))return{condition:'RAIN',description:'Rain'};
  if([71,73,75,77].includes(v))return{condition:'SNOW',description:'Snow'};
  if([80,81,82].includes(v))return{condition:'SHOWERS',description:'Rain showers'};
  if([85,86].includes(v))return{condition:'SNOW_SHOWERS',description:'Snow showers'};
  if([95,96,99].includes(v))return{condition:'THUNDERSTORM',description:'Thunderstorm'};
  return{condition:'CLOUDY',description:'Weather'};
}
async function weatherSearch(query){
  const url=new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.search=new URLSearchParams({name:cleanText(query,120),count:'8',language:'en',format:'json'}).toString();
  const response=await fetch(url);
  if(!response.ok)throw new Error('Weather location search failed.');
  const data=await response.json();
  return(data.results||[]).map(x=>({name:x.name,admin1:x.admin1||'',country:x.country||'',countryCode:x.country_code||'',latitude:x.latitude,longitude:x.longitude,label:[x.name,x.admin1,x.country].filter(Boolean).join(', ')}));
}
async function weatherData(state){
  const cfg=normalizeWeather(state.weather);
  if(!Number.isFinite(cfg.latitude)||!Number.isFinite(cfg.longitude))return null;
  const imperial=cfg.units==='imperial';
  const params=new URLSearchParams({
    latitude:String(cfg.latitude),longitude:String(cfg.longitude),
    current:'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,wind_gusts_10m',
    daily:'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset',
    timezone:'auto',forecast_days:'10',
    temperature_unit:imperial?'fahrenheit':'celsius',
    wind_speed_unit:imperial?'mph':'kmh',
    precipitation_unit:imperial?'inch':'mm'
  });
  const response=await fetch('https://api.open-meteo.com/v1/forecast?'+params);
  if(!response.ok)throw new Error('Open-Meteo weather request failed.');
  const data=await response.json(),c=data.current||{},d=data.daily||{};
  const info=weatherCodeInfo(c.weather_code);
  return{
    provider:'Open-Meteo',location:cfg.locationLabel||'Saved location',units:cfg.units,
    current:{temperature:c.temperature_2m,feelsLike:c.apparent_temperature,humidity:c.relative_humidity_2m,precipitation:c.precipitation,windSpeed:c.wind_speed_10m,windGust:c.wind_gusts_10m,isDay:Boolean(c.is_day),weatherCode:c.weather_code,...info},
    forecast:(d.time||[]).map((date,i)=>({date,weatherCode:d.weather_code?.[i],...weatherCodeInfo(d.weather_code?.[i]),high:d.temperature_2m_max?.[i],low:d.temperature_2m_min?.[i],precipitationProbability:d.precipitation_probability_max?.[i],sunrise:d.sunrise?.[i],sunset:d.sunset?.[i]})),
    official:null,alerts:[]
  };
}
function cloudUpdateStatus(env){
  return{configured:true,cloudManaged:true,phase:'idle',step:'deployed',progress:100,message:'Cloudflare deploys Quest Log automatically from GitHub.',checking:false,available:false,lastCheckedAt:null,currentRevision:env.CF_VERSION_METADATA?.id||'',latestRevision:env.CF_VERSION_METADATA?.id||'',currentVersion:env.CF_VERSION_METADATA?.tag||'cloud',latestVersion:env.CF_VERSION_METADATA?.tag||'cloud',installMode:'cloudflare'};
}
function ensureItemTitle(value,label,max){
  if(!cleanText(value,max)){const e=new Error(label+' is required.');e.status=400;throw e}
}
async function handleApi(request,env,identity){
  const url=new URL(request.url),p=url.pathname,method=request.method;
  if(p==='/api/runtime')return json({runtime:'cloudflare',standalone:true,authenticated:true,user:identity.email||null,database:'d1',databaseBound:Boolean(env.DB),logoutPath:'/cdn-cgi/access/logout',workerVersion:env.CF_VERSION_METADATA?.id||null,workerTag:env.CF_VERSION_METADATA?.tag||null,workerTimestamp:env.CF_VERSION_METADATA?.timestamp||null});
  if(p.startsWith('/api/update/')){
    if(p==='/api/update/status'&&method==='GET')return json(cloudUpdateStatus(env));
    if(p==='/api/update/check'&&method==='POST')return json({ok:true,...cloudUpdateStatus(env)});
    if(p==='/api/update/start'&&method==='POST')return json({error:'Cloud deployments are managed by Cloudflare Workers Builds from GitHub.'},409);
  }

  let state=await loadState(env);
  if(p==='/api/state'&&method==='GET'){
    const view=publicState(state,env);
    view.notifications=notificationConfig(state,env);
    view.google.accounts=await Promise.all((state.google.accounts||[]).map(async a=>{
      const caps=await accountCapabilities(a,env);
      return{id:a.id,googleId:a.googleId,label:a.label,selectedCalendarIds:a.selectedCalendarIds||[],selectedTaskListIds:a.selectedTaskListIds||[],defaultTaskListId:a.defaultTaskListId||'',connectedAt:a.connectedAt,canWrite:caps.canWrite,canTasks:caps.canTasks};
    }));
    view.google.connected=view.google.accounts.length>0;
    view.google.configured=googleConfigured(env);
    return json(view);
  }

  if(p==='/api/notifications/config'&&method==='GET')return json(notificationConfig(state,env));
  if(p==='/api/notifications/preferences'&&method==='PUT'){
    const incoming=await body(request);
    updateNotificationPreferences(state,incoming);
    await saveState(env,state);
    return json(notificationConfig(state,env));
  }
  if(p==='/api/notifications/subscribe'&&method==='POST'){
    const incoming=await body(request);
    registerSubscription(state,incoming.subscription||incoming,request.headers.get('user-agent')||'');
    state.notifications.enabled=true;
    await saveState(env,state);
    return json(notificationConfig(state,env),201);
  }
  if(p==='/api/notifications/unsubscribe'&&method==='POST'){
    const incoming=await body(request);
    unregisterSubscription(state,incoming.endpoint||'');
    if(!state.notifications.subscriptions.length)state.notifications.enabled=false;
    await saveState(env,state);
    return json(notificationConfig(state,env));
  }
  if(p==='/api/notifications/test'&&method==='POST'){
    const incoming=await body(request);
    return json(await sendTestNotification(state,env,incoming.endpoint||''));
  }

  if(p==='/api/countdowns'&&method==='POST'){
    const incoming=await body(request);ensureItemTitle(incoming.name,'Countdown name',100);
    if(!iso(incoming.end)){const e=new Error('A valid end date is required.');e.status=400;throw e}
    const item=normalizeCountdown({...incoming,id:id(),created:new Date().toISOString()});state.countdowns.push(item);await saveState(env,state);return json(item,201);
  }
  if(p.startsWith('/api/countdowns/')){
    const itemId=decodeURIComponent(p.split('/').pop()),index=state.countdowns.findIndex(x=>x.id===itemId);
    if(index<0)return json({error:'Not found'},404);
    if(method==='PUT'){
      const incoming=await body(request);ensureItemTitle(incoming.name,'Countdown name',100);
      if(!iso(incoming.end)){const e=new Error('A valid end date is required.');e.status=400;throw e}
      state.countdowns[index]=normalizeCountdown({...state.countdowns[index],...incoming,id:itemId,created:state.countdowns[index].created});await saveState(env,state);return json(state.countdowns[index]);
    }
    if(method==='DELETE'){state.countdowns.splice(index,1);await saveState(env,state);return json({ok:true})}
  }

  if(p==='/api/tasks'&&method==='POST'){
    const incoming=await body(request);ensureItemTitle(incoming.title,'Task title',160);
    const now=new Date().toISOString();let item=normalizeTask({...incoming,id:id(),created:now,updated:now});
    if(incoming.googleAccountId&&incoming.googleTaskListId)item=await createGoogleTaskLink(item,String(incoming.googleAccountId),String(incoming.googleTaskListId),state,env);
    state.tasks.push(item);await saveState(env,state);return json(item,201);
  }
  if(p.startsWith('/api/tasks/')){
    const itemId=decodeURIComponent(p.split('/').pop()),index=state.tasks.findIndex(x=>x.id===itemId);
    if(index<0)return json({error:'Not found'},404);
    if(method==='PUT'){
      const incoming=await body(request);if(incoming.title!==undefined)ensureItemTitle(incoming.title,'Task title',160);
      const existing=state.tasks[index],merged={...existing,...incoming,id:itemId,created:existing.created,updated:new Date().toISOString()};
      if(incoming.status&&incoming.status!=='done')merged.completedAt=null;
      if(incoming.status==='done'&&!merged.completedAt)merged.completedAt=new Date().toISOString();
      let next=normalizeTask(merged);
      if(existing.googleTaskId){
        next.googleAccountId=existing.googleAccountId;next.googleTaskListId=existing.googleTaskListId;next.googleTaskListTitle=existing.googleTaskListTitle;next.googleTaskId=existing.googleTaskId;next.googleParentId=existing.googleParentId;next.googleUpdated=existing.googleUpdated;next.googleEtag=existing.googleEtag;
        next=await updateLinkedGoogleTask(next,state,env);
      }else if(incoming.googleAccountId&&incoming.googleTaskListId){
        next=await createGoogleTaskLink(next,String(incoming.googleAccountId),String(incoming.googleTaskListId),state,env);
      }
      state.tasks[index]=next;await saveState(env,state);return json(state.tasks[index]);
    }
    if(method==='DELETE'){const item=state.tasks[index];await deleteLinkedGoogleTask(item,state,env);state.tasks.splice(index,1);await saveState(env,state);return json({ok:true})}
  }

  if(p==='/api/goals'&&method==='POST'){
    const incoming=await body(request);ensureItemTitle(incoming.title,'Goal title',160);
    const now=new Date().toISOString(),item=normalizeGoal({...incoming,id:id(),created:now,updated:now});
    state.goals.push(item);await saveState(env,state);return json({...item,progress:0},201);
  }
  if(p.startsWith('/api/goals/')){
    const itemId=decodeURIComponent(p.split('/').pop()),index=state.goals.findIndex(x=>x.id===itemId);
    if(index<0)return json({error:'Not found'},404);
    if(method==='PUT'){
      const incoming=await body(request);if(incoming.title!==undefined)ensureItemTitle(incoming.title,'Goal title',160);
      state.goals[index]=normalizeGoal({...state.goals[index],...incoming,id:itemId,created:state.goals[index].created,updated:new Date().toISOString()});await saveState(env,state);return json(state.goals[index]);
    }
    if(method==='DELETE'){
      state.goals.splice(index,1);state.tasks=state.tasks.map(t=>t.goalId===itemId?{...t,goalId:''}:t);state.countdowns=state.countdowns.map(c=>c.goalId===itemId?{...c,goalId:''}:c);await saveState(env,state);return json({ok:true});
    }
  }

  if(p==='/api/settings'&&method==='PUT'){
    const incoming=await body(request);
    if(incoming.appearanceMode!==undefined||incoming.appearanceTheme!==undefined||incoming.appearanceDensity!==undefined){
      state.appearance=normalizeAppearance({...state.appearance,mode:incoming.appearanceMode??state.appearance.mode,theme:incoming.appearanceTheme??state.appearance.theme,density:incoming.appearanceDensity??state.appearance.density});
    }
    if(incoming.displayTitle!==undefined)state.display.title=cleanText(incoming.displayTitle||'Today',80);
    if(incoming.maxEvents!==undefined)state.display.maxEvents=clamp(num(incoming.maxEvents,5),1,20);
    if(incoming.maxCountdowns!==undefined)state.display.maxCountdowns=clamp(num(incoming.maxCountdowns,3),1,20);
    if(incoming.maxTasks!==undefined)state.display.maxTasks=clamp(num(incoming.maxTasks,6),1,20);
    if(incoming.maxGoals!==undefined)state.display.maxGoals=clamp(num(incoming.maxGoals,3),1,20);
    if(incoming.layout!==undefined)state.display.layout=en(incoming.layout,LAYOUTS,'auto');
    if(incoming.palette!==undefined)state.display.palette=en(incoming.palette,PALETTES,'spectra6');
    if(incoming.dateWidgetStyle!==undefined)state.display.dateWidgetStyle=en(incoming.dateWidgetStyle,DATE_WIDGETS,'plain');
    if(incoming.mode!==undefined)state.display.mode=en(incoming.mode,DISPLAY_MODES,'daily');
    if(incoming.sectionLayout!==undefined)state.display.sectionLayout=normalizeSectionLayout(incoming.sectionLayout);
    if(incoming.sectionOrder!==undefined)state.display.sectionOrder=normalizeSectionOrder(incoming.sectionOrder);
    if(incoming.modeLayouts!==undefined)state.display.modeLayouts=normalizeModeLayouts(incoming.modeLayouts,state.display.sectionLayout);
    if(incoming.modeSections!==undefined)state.display.modeSections=normalizeModeSections(incoming.modeSections);
    if(incoming.refreshMinutes!==undefined)state.display.refreshMinutes=clamp(num(incoming.refreshMinutes,15),1,1440);
    if(incoming.showAgenda!==undefined)state.display.showAgenda=Boolean(incoming.showAgenda);
    if(incoming.showTasks!==undefined)state.display.showTasks=Boolean(incoming.showTasks);
    if(incoming.showGoals!==undefined)state.display.showGoals=Boolean(incoming.showGoals);
    if(incoming.showCountdowns!==undefined)state.display.showCountdowns=Boolean(incoming.showCountdowns);
    if(incoming.showWeather!==undefined)state.display.showWeather=Boolean(incoming.showWeather);
    if(incoming.weatherStyle!==undefined)state.display.weatherStyle=en(incoming.weatherStyle,WEATHER_STYLES,'forecast');
    if(incoming.weatherLatitude!==undefined||incoming.weatherLongitude!==undefined||incoming.weatherLocationLabel!==undefined||incoming.weatherCountryCode!==undefined||incoming.weatherUnits!==undefined){
      state.weather=normalizeWeather({...state.weather,latitude:incoming.weatherLatitude??state.weather.latitude,longitude:incoming.weatherLongitude??state.weather.longitude,locationLabel:incoming.weatherLocationLabel??state.weather.locationLabel,countryCode:incoming.weatherCountryCode??state.weather.countryCode,units:incoming.weatherUnits??state.weather.units});
    }
    if(incoming.marketWatchlist!==undefined||incoming.marketSymbols!==undefined||incoming.marketRefreshMinutes!==undefined){
      state.markets=normalizeMarkets({...state.markets,watchlist:incoming.marketWatchlist??incoming.marketSymbols??state.markets.watchlist,refreshMinutes:incoming.marketRefreshMinutes??state.markets.refreshMinutes});
    }
    if(incoming.agentEnabled!==undefined||incoming.agentProvider!==undefined||incoming.agentBaseUrl!==undefined||incoming.agentModel!==undefined||incoming.agentContextDays!==undefined||incoming.agentApiKey!==undefined||incoming.agentClearApiKey!==undefined){
      const requested=String(incoming.agentProvider||state.agent.provider||'openai');
      const provider=AGENT_PROVIDERS.includes(requested)?requested:'openai';
      let baseUrl=cleanText(incoming.agentBaseUrl??state.agent.baseUrl,500).replace(/\/+$/,'');
      if(provider==='local'&&baseUrl){
        let parsed;try{parsed=new URL(baseUrl)}catch{const e=new Error('Local model endpoint is invalid.');e.status=400;throw e}
        if(parsed.protocol!=='https:'){const e=new Error('Cloud local-model endpoints must use HTTPS.');e.status=400;throw e}
      }
      if(provider!=='local')baseUrl='';
      state.agent={...state.agent,enabled:incoming.agentEnabled??state.agent.enabled,provider,baseUrl,model:cleanText(incoming.agentModel??state.agent.model,160),contextDays:clamp(Math.round(num(incoming.agentContextDays,state.agent.contextDays||14)),1,30)};
      if(incoming.agentClearApiKey)await clearAgentCredential(state,env,provider);
      if(incoming.agentApiKey!==undefined&&cleanText(incoming.agentApiKey,5000))await saveAgentCredential(state,env,provider,cleanText(incoming.agentApiKey,5000));
    }
    await saveState(env,state);return json({ok:true});
  }

  if(p==='/api/weather'&&method==='GET'){
    try{const weather=await weatherData(state);return json({weather,error:weather?null:'Choose a weather location in Settings.'})}
    catch(error){return json({weather:null,error:error.message||'Weather is unavailable.'})}
  }
  if(p==='/api/weather/search'&&method==='GET'){
    const q=url.searchParams.get('q')||'';if(cleanText(q,120).length<2)return json({results:[]});
    return json({results:await weatherSearch(q)});
  }

  if(p==='/api/markets'&&method==='GET'){
    if(!env.ALPHA_VANTAGE_API_KEY)return json({markets:null,error:'Add ALPHA_VANTAGE_API_KEY as a Worker secret to enable Markets.'});
    try{return json({markets:await marketData(state,env),error:null})}
    catch(error){return json({markets:state.marketCache?.data||null,error:error.message||'Market data is unavailable.'})}
  }
  if(p==='/api/markets/search'&&method==='GET'){
    if(!env.ALPHA_VANTAGE_API_KEY)return json({error:'ALPHA_VANTAGE_API_KEY is not configured.'},400);
    const q=url.searchParams.get('q')||'';if(!cleanText(q,80).trim())return json({results:[]});
    return json({results:await marketSearch(q,env)});
  }

  if(p==='/api/google/auth'&&method==='GET')return startGoogleAuth(request,env);
  if(p==='/api/google/callback'&&method==='GET')return finishGoogleAuth(request,state,env);
  if(p==='/api/google/disconnect'&&method==='POST'){state.google.accounts=[];state.tasks=state.tasks.map(t=>normalizeTask({...t,googleAccountId:'',googleTaskListId:'',googleTaskListTitle:'',googleTaskId:'',googleParentId:'',googleUpdated:null,googleEtag:''}));await saveState(env,state);return json({ok:true})}
  if(p.startsWith('/api/google/accounts/')&&p.endsWith('/disconnect')&&method==='POST'){
    const accountId=decodeURIComponent(p.split('/')[4]||'');return await disconnectAccount(accountId,state,env)?json({ok:true}):json({error:'Google account was not found.'},404);
  }
  if(p.startsWith('/api/google/accounts/')&&p.endsWith('/calendars')&&method==='PUT'){
    const accountId=decodeURIComponent(p.split('/')[4]||''),a=(state.google.accounts||[]).find(x=>x.id===accountId);if(!a)return json({error:'Google account was not found.'},404);
    const incoming=await body(request);if(!Array.isArray(incoming.calendarIds))return json({error:'calendarIds must be an array.'},400);
    a.selectedCalendarIds=incoming.calendarIds.map(String).slice(0,50);await saveState(env,state);return json({ok:true});
  }
  if(p.startsWith('/api/google/accounts/')&&p.endsWith('/tasklists')&&method==='PUT'){
    const accountId=decodeURIComponent(p.split('/')[4]||''),a=(state.google.accounts||[]).find(x=>x.id===accountId);if(!a)return json({error:'Google account was not found.'},404);
    const incoming=await body(request);if(!Array.isArray(incoming.taskListIds))return json({error:'taskListIds must be an array.'},400);
    const previous=new Set(a.selectedTaskListIds||[]);a.selectedTaskListIds=incoming.taskListIds.map(String).slice(0,50);const selected=new Set(a.selectedTaskListIds);
    const removed=[...previous].filter(x=>!selected.has(x));if(removed.length)state.tasks=state.tasks.map(t=>t.googleAccountId===accountId&&removed.includes(t.googleTaskListId)?normalizeTask({...t,googleAccountId:'',googleTaskListId:'',googleTaskListTitle:'',googleTaskId:'',googleParentId:'',googleUpdated:null,googleEtag:''}):t);
    const requested=incoming.defaultTaskListId?String(incoming.defaultTaskListId):'';a.defaultTaskListId=a.selectedTaskListIds.includes(requested)?requested:(a.selectedTaskListIds[0]||'');await saveState(env,state);
    return json({ok:true,sync:await syncGoogleTasks(state,env)});
  }
  if(p==='/api/google/calendars'&&method==='GET'){
    const accountId=url.searchParams.get('accountId');if(!accountId)return json({error:'accountId is required.'},400);return json({calendars:await calendars(accountId,state,env)});
  }
  if(p==='/api/google/tasklists'&&method==='GET'){
    const accountId=url.searchParams.get('accountId');if(!accountId)return json({error:'accountId is required.'},400);return json({taskLists:await taskLists(accountId,state,env)});
  }
  if(p==='/api/google/tasks/sync'&&method==='POST')return json({ok:true,sync:await syncGoogleTasks(state,env)});
  if(p==='/api/google/events'&&method==='GET')return json({events:await eventsBetween(url.searchParams.get('from'),url.searchParams.get('to'),state,env)});
  const eventMatch=p.match(/^\/api\/google\/accounts\/([^/]+)\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
  if(eventMatch){
    const accountId=decodeURIComponent(eventMatch[1]),calendarId=decodeURIComponent(eventMatch[2]),eventId=eventMatch[3]?decodeURIComponent(eventMatch[3]):'';
    if(method==='POST'&&!eventId)return json({ok:true,event:await mutateEvent(accountId,calendarId,'','POST',await body(request),state,env)},201);
    if((method==='PATCH'||method==='PUT')&&eventId)return json({ok:true,event:await mutateEvent(accountId,calendarId,eventId,method,await body(request),state,env)});
    if(method==='DELETE'&&eventId){await mutateEvent(accountId,calendarId,eventId,'DELETE',null,state,env);return json({ok:true})}
    return json({error:'Unsupported event operation.'},405);
  }

  if(p==='/api/agent/models'&&method==='GET'){
    try{return json(await listAgentModels(state,env,url.searchParams.get('provider')||''))}catch(error){return json({ok:false,error:error.message||'Could not load models.'},400)}
  }
  if(p==='/api/agent/test'&&method==='POST'){
    try{return json(await testAgent(state,env))}catch(error){return json({ok:false,error:error.message||'Agent connection failed.'},400)}
  }
  if(p==='/api/agent/chat'&&method==='POST'){
    const incoming=await body(request);
    if(state.agent?.enabled===false)return json({error:'Enable Navi in Settings first.'},400);
    return json(await chat(state,env,incoming.messages||[]));
  }
  if(p==='/api/agent/actions'&&method==='POST'){
    const incoming=await body(request);
    return json({ok:true,results:await applyActions(state,env,incoming.actions||[])});
  }

  if(p==='/api/display/rotate-token'&&method==='POST'){
    state.display.token=crypto.randomUUID().replaceAll('-')+crypto.randomUUID().replaceAll('-').slice(0,16);await saveState(env,state);
    return json({feedPath:'/api/frameos/feed?token='+state.display.token,svgPath:'/api/frameos/svg?token='+state.display.token,viewPath:'/frame?token='+state.display.token});
  }
  if(p==='/api/frameos/feed'&&method==='GET'){
    if(url.searchParams.get('token')!==state.display.token)return json({error:'Invalid display token'},401);
    const range=displayRange(state);
    let events=[],calendarError=null,weather=null,weatherError=null,markets=null,marketError=null;
    if(range){try{events=await eventsBetween(range.start.toISOString(),range.end.toISOString(),state,env)}catch(error){calendarError=error.message}}
    if(state.display?.showWeather!==false){try{weather=await weatherData(state);if(!weather)weatherError='Choose a weather location in Settings.'}catch(error){weatherError=error.message}}
    if(env.ALPHA_VANTAGE_API_KEY){try{markets=await marketData(state,env)}catch(error){marketError=error.message;markets=state.marketCache?.data||null}}
    else marketError='ALPHA_VANTAGE_API_KEY is not configured.';
    return json(buildDisplayFeed(state,{events,weather,markets,calendarError,weatherError,marketError}));
  }
  if(p==='/api/frameos/svg'&&method==='GET'){
    if(url.searchParams.get('token')!==state.display.token)return text('Invalid display token',401);
    const range=displayRange(state);
    let events=[],calendarError=null,weather=null,weatherError=null,markets=null,marketError=null;
    if(range){try{events=await eventsBetween(range.start.toISOString(),range.end.toISOString(),state,env)}catch(error){calendarError=error.message}}
    if(state.display?.showWeather!==false){try{weather=await weatherData(state);if(!weather)weatherError='Choose a weather location in Settings.'}catch(error){weatherError=error.message}}
    if(env.ALPHA_VANTAGE_API_KEY){try{markets=await marketData(state,env)}catch(error){marketError=error.message;markets=state.marketCache?.data||null}}
    else marketError='ALPHA_VANTAGE_API_KEY is not configured.';
    const feed=buildDisplayFeed(state,{events,weather,markets,calendarError,weatherError,marketError});
    const width=clamp(num(url.searchParams.get('w'),800),300,2000),height=clamp(num(url.searchParams.get('h'),480),300,2000);
    return text(renderDisplaySvg(feed,width,height),200,'image/svg+xml; charset=utf-8',{'cache-control':'no-store, max-age=0'});
  }

  return json({error:'Not found'},404);
}

export default{
  async scheduled(controller,env,ctx){
    ctx.waitUntil((async()=>{
      try{
        const state=await loadState(env);
        await runNotificationSweep(state,env,controller?.scheduledTime||Date.now());
      }catch(error){
        console.error('Quest Log notification sweep failed:',error);
      }
    })());
  },
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==='/healthz')return json({ok:true,runtime:'cloudflare',standalone:true});
    if(url.pathname==='/login')return env.ASSETS.fetch(new Request(new URL('/login.html',url),request));
    if(url.pathname==='/login/start'){
      try{return Response.redirect(accessLoginUrl(request,env,url.searchParams.get('next')||'/'),302)}
      catch(error){return text(error.message||'Login is unavailable.',503)}
    }
    const machineDisplay=url.pathname==='/frame'||url.pathname==='/api/frameos/feed'||url.pathname==='/api/frameos/svg';
    if(machineDisplay){
      try{
        const state=await loadState(env);
        if(url.searchParams.get('token')!==state.display.token)return url.pathname==='/frame'?text('Invalid display token',401):json({error:'Invalid display token'},401);
        if(url.pathname==='/frame')return env.ASSETS.fetch(new Request(new URL('/frame.html',url),request));
        return await handleApi(request,env,{email:null,sub:'display-token',bypass:true});
      }catch(error){
        return url.pathname==='/frame'?text(error.message||'Display unavailable.',500):json({error:error.message||'Display unavailable.'},500);
      }
    }
    let identity;
    try{identity=await authenticate(request,env)}catch(error){return json({error:error.message||'Authentication failed.'},Number(error.status)||503)}
    if(url.pathname.startsWith('/api/')){
      try{return await handleApi(request,env,identity)}catch(error){return json({error:error.message||'Unexpected cloud runtime error.'},Number(error.status)||500)}
    }
    return env.ASSETS.fetch(request);
  }
};
