import {
  loadState, saveState, publicState, id, cleanText, iso, num, clamp, en,
  normalizeCountdown, normalizeTask, normalizeGoal, normalizeWeather,
  normalizeAppearance, normalizeMarkets, normalizeTimeZone, validTimeZone, normalizeSectionLayout,
  normalizeModeLayouts, normalizeModeSections, normalizeSectionOrder,
  LAYOUTS, PALETTES, DATE_WIDGETS, DISPLAY_MODES, WEATHER_STYLES,
  APPEARANCE_MODES, UI_THEMES, UI_DENSITIES, AGENT_PROVIDERS
} from './state.js';
import {
  googleConfigured, accountCapabilities, startGoogleAuth, finishGoogleAuth,
  calendars, taskLists, eventsBetween, mutateEvent, syncGoogleTasks,
  disconnectAccount, createGoogleTaskLink, updateLinkedGoogleTask, deleteLinkedGoogleTask
} from './google.js';
import { marketData, marketSearch, testMarketConnection } from './markets.js';
import { financeSummary, createFinanceLinkToken, exchangeFinancePublicToken, syncFinance, disconnectFinanceItem } from './plaid.js';
import { testAgent, listAgentModels, saveAgentCredential, clearAgentCredential, chat, applyActions } from './agent.js';
import { buildDisplayFeed, displayRange, renderDisplaySvg } from './display.js';
import { renderEinkHtml } from '../eink/render.mjs';
import { notificationConfig, updateNotificationPreferences, registerSubscription, unregisterSubscription, sendTestNotification, runNotificationSweep } from './notifications.js';
import { nativeSession, signup, login, logout, authCookie, expiredAuthCookie, authPublicConfig } from './auth.js';

let jwksCache={expiresAt:0,keys:[]};
const encoder=new TextEncoder(),decoder=new TextDecoder();

function json(data,status=200,headers={}){
  return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers}});
}
function text(data,status=200,type='text/plain; charset=utf-8',headers={}){
  return new Response(data,{status,headers:{'content-type':type,'cache-control':'no-store',...headers}});
}
async function einkFingerprint(feed,width,height){
  const stable={...feed,generatedAt:''};
  const bytes=encoder.encode(JSON.stringify({width,height,palette:feed.display?.palette||'spectra6',data:stable}));
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(digest).slice(0,12),b=>b.toString(16).padStart(2,'0')).join('');
}
function einkCacheRequests(url,state,feed,width,height,fingerprint){
  const token=String(state.display?.token||'display'),palette=String(feed.display?.palette||'spectra6');
  const root=new URL('/__questlog_eink_cache/',url.origin);
  const prefix=root.href+encodeURIComponent(token)+'/'+width+'x'+height+'/'+encodeURIComponent(palette)+'/';
  return{
    exact:new Request(prefix+'exact/'+fingerprint,{method:'GET'}),
    last:new Request(prefix+'last',{method:'GET'})
  };
}
async function screenshotWithRetry(env,html,width,height){
  let firstError=null;
  for(let attempt=0;attempt<2;attempt++){
    try{
      if(!env.BROWSER?.quickAction)throw new Error('Cloudflare Browser Run binding is unavailable.');
      const response=await env.BROWSER.quickAction('screenshot',{
        html,
        viewport:{width,height,deviceScaleFactor:1},
        screenshotOptions:{type:'png',fullPage:false,omitBackground:false}
      });
      if(!response.ok)throw new Error('Browser Run screenshot failed ('+response.status+').');
      return await response.arrayBuffer();
    }catch(error){
      if(!firstError)firstError=error;
      if(attempt===1){
        error.firstRenderError=firstError;
        throw error;
      }
    }
  }
}
function pngResponse(bytes,renderer,feed,error=''){
  const headers={
    'content-type':'image/png',
    'cache-control':'no-store, max-age=0',
    'x-questlog-renderer':renderer,
    'x-frameos-refresh-minutes':String(feed.display.refreshMinutes)
  };
  if(error)headers['x-questlog-renderer-error']=cleanText(error,160);
  return new Response(bytes,{status:200,headers});
}
async function readCachedPng(cache,request,renderer,feed,error=''){
  if(!cache)return null;
  try{
    const cached=await cache.match(request);
    if(!cached)return null;
    return pngResponse(await cached.arrayBuffer(),renderer,feed,error);
  }catch{return null}
}
async function storeCachedPng(cache,requests,bytes){
  if(!cache)return;
  const stored=new Response(bytes,{status:200,headers:{'content-type':'image/png','cache-control':'public, max-age=604800'}});
  try{
    await Promise.all([cache.put(requests.exact,stored.clone()),cache.put(requests.last,stored.clone())]);
  }catch{}
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
  return(data.results||[]).map(x=>({name:x.name,admin1:x.admin1||'',country:x.country||'',countryCode:x.country_code||'',latitude:x.latitude,longitude:x.longitude,timezone:x.timezone||'',label:[x.name,x.admin1,x.country].filter(Boolean).join(', ')}));
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
    provider:'Open-Meteo',location:cfg.locationLabel||'Saved location',units:cfg.units,timeZone:cleanText(data.timezone||cfg.timeZone||'',100),
    current:{temperature:c.temperature_2m,feelsLike:c.apparent_temperature,humidity:c.relative_humidity_2m,precipitation:c.precipitation,windSpeed:c.wind_speed_10m,windGust:c.wind_gusts_10m,isDay:Boolean(c.is_day),weatherCode:c.weather_code,...info},
    forecast:(d.time||[]).map((date,i)=>({date,weatherCode:d.weather_code?.[i],...weatherCodeInfo(d.weather_code?.[i]),high:d.temperature_2m_max?.[i],low:d.temperature_2m_min?.[i],precipitationProbability:d.precipitation_probability_max?.[i],sunrise:d.sunrise?.[i],sunset:d.sunset?.[i]})),
    official:null,alerts:[]
  };
}
function scopedUserEnv(env,identity){
  if(!identity?.userId)return env;
  const scoped=Object.create(env);
  scoped.CLOUD_WORKSPACE_ID='user:'+identity.userId;
  return scoped;
}
async function displayIdentityFromToken(env,token){
  const cleanToken=cleanText(token,160);
  if(!cleanToken||!env.DB)return null;
  const row=await env.DB.prepare("SELECT workspace_id FROM questlog_state WHERE json_extract(state_json,'$.display.token')=? LIMIT 1").bind(cleanToken).first();
  if(!row?.workspace_id)return null;
  const workspace=String(row.workspace_id);
  if(workspace.startsWith('user:')){
    const userId=workspace.slice(5);
    const user=await env.DB.prepare('SELECT primary_email,display_name FROM questlog_users WHERE user_id=?').bind(userId).first().catch(()=>null);
    return{userId,email:user?.primary_email||'',sub:userId,provider:'questlog',displayAuthorized:true};
  }
  return{email:null,sub:'legacy-display',provider:'legacy',displayAuthorized:true,legacyWorkspace:workspace};
}
function cloudUpdateStatus(env){
  return{configured:true,cloudManaged:true,phase:'idle',step:'deployed',progress:100,message:'Cloudflare deploys Quest Log automatically from GitHub.',checking:false,available:false,lastCheckedAt:null,currentRevision:env.CF_VERSION_METADATA?.id||'',latestRevision:env.CF_VERSION_METADATA?.id||'',currentVersion:env.CF_VERSION_METADATA?.tag||'cloud',latestVersion:env.CF_VERSION_METADATA?.tag||'cloud',installMode:'cloudflare'};
}
function ensureItemTitle(value,label,max){
  if(!cleanText(value,max)){const e=new Error(label+' is required.');e.status=400;throw e}
}
async function handleApi(request,env,identity){
  env=scopedUserEnv(env,identity);
  const url=new URL(request.url),p=url.pathname,method=request.method;
  if(p==='/api/runtime')return json({runtime:'cloudflare',standalone:true,authenticated:true,user:identity.email||null,database:'d1',databaseBound:Boolean(env.DB),logoutPath:'/logout',workerVersion:env.CF_VERSION_METADATA?.id||null,workerTag:env.CF_VERSION_METADATA?.tag||null,workerTimestamp:env.CF_VERSION_METADATA?.timestamp||null});
  if(p.startsWith('/api/update/')){
    if(p==='/api/update/status'&&method==='GET')return json(cloudUpdateStatus(env));
    if(p==='/api/update/check'&&method==='POST')return json({ok:true,...cloudUpdateStatus(env)});
    if(p==='/api/update/start'&&method==='POST')return json({error:'Cloud deployments are managed by Cloudflare Workers Builds from GitHub.'},409);
  }

  if(p==='/api/finance'&&method==='GET')return json(await financeSummary(env,identity,{sync:true}));
  if(p==='/api/finance/link-token'&&method==='POST')return json(await createFinanceLinkToken(env,identity));
  if(p==='/api/finance/exchange'&&method==='POST'){
    const incoming=await body(request);
    return json(await exchangeFinancePublicToken(env,identity,incoming.publicToken,incoming.metadata||{}));
  }
  if(p==='/api/finance/sync'&&method==='POST'){
    await syncFinance(env,identity,{force:true});
    return json(await financeSummary(env,identity,{sync:false}));
  }
  if(p==='/api/finance/disconnect'&&method==='POST'){
    const incoming=await body(request);
    await disconnectFinanceItem(env,identity,incoming.itemId);
    return json(await financeSummary(env,identity,{sync:false}));
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
    if(incoming.timeZone!==undefined){
      const requestedTimeZone=cleanText(incoming.timeZone,100);
      if(!validTimeZone(requestedTimeZone)){const e=new Error('Choose a valid IANA time zone.');e.status=400;throw e}
      state.timeZone=normalizeTimeZone(requestedTimeZone,state.timeZone||state.weather?.timeZone||'America/Vancouver');
    }
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
    if(incoming.weatherLatitude!==undefined||incoming.weatherLongitude!==undefined||incoming.weatherLocationLabel!==undefined||incoming.weatherCountryCode!==undefined||incoming.weatherTimeZone!==undefined||incoming.weatherUnits!==undefined){
      state.weather=normalizeWeather({...state.weather,latitude:incoming.weatherLatitude??state.weather.latitude,longitude:incoming.weatherLongitude??state.weather.longitude,locationLabel:incoming.weatherLocationLabel??state.weather.locationLabel,countryCode:incoming.weatherCountryCode??state.weather.countryCode,timeZone:incoming.weatherTimeZone??state.weather.timeZone,units:incoming.weatherUnits??state.weather.units});
    }
    if(incoming.marketWatchlist!==undefined||incoming.marketSymbols!==undefined||incoming.marketRefreshMinutes!==undefined){
      state.markets=normalizeMarkets({...state.markets,watchlist:incoming.marketWatchlist??incoming.marketSymbols??state.markets.watchlist,refreshMinutes:incoming.marketRefreshMinutes??state.markets.refreshMinutes});
      state.marketCache=null;
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
    try{return json({markets:await marketData(state,env),error:null})}
    catch(error){return json({markets:state.marketCache?.data||null,error:error.message||'Market data is unavailable.'})}
  }
  if(p==='/api/markets/search'&&method==='GET'){
    const q=url.searchParams.get('q')||'';if(!cleanText(q,64).trim())return json({results:[]});
    return json({results:await marketSearch(q,state,env)});
  }
  if(p==='/api/markets/test'&&method==='POST'){
    try{return json(await testMarketConnection(state,env))}
    catch(error){return json({ok:false,error:error.message||'Yahoo Finance connection failed.'},400)}
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
    state.display.token=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','').slice(0,16);await saveState(env,state);
    return json({feedPath:'/api/frameos/feed?token='+state.display.token,imagePath:'/api/frameos/image?token='+state.display.token,svgPath:'/api/frameos/svg?token='+state.display.token,viewPath:'/frame?token='+state.display.token});
  }
  if(p==='/api/frameos/feed'&&method==='GET'){
    if(!identity?.displayAuthorized&&url.searchParams.get('token')!==state.display.token)return json({error:'Invalid display token'},401);
    const range=displayRange(state);
    let events=[],calendarError=null,weather=null,weatherError=null,markets=null,marketError=null;
    if(range){try{events=await eventsBetween(range.start.toISOString(),range.end.toISOString(),state,env)}catch(error){calendarError=error.message}}
    if(state.display?.showWeather!==false){try{weather=await weatherData(state);if(!weather)weatherError='Choose a weather location in Settings.'}catch(error){weatherError=error.message}}
    try{markets=await marketData(state,env)}catch(error){marketError=error.message;markets=state.marketCache?.data||null}
    return json(buildDisplayFeed(state,{events,weather,markets,calendarError,weatherError,marketError}));
  }
  if(p==='/api/frameos/image'&&method==='GET'){
    if(!identity?.displayAuthorized&&url.searchParams.get('token')!==state.display.token)return text('Invalid display token',401);
    const range=displayRange(state);
    let events=[],calendarError=null,weather=null,weatherError=null,markets=null,marketError=null;
    if(range){try{events=await eventsBetween(range.start.toISOString(),range.end.toISOString(),state,env)}catch(error){calendarError=error.message}}
    if(state.display?.showWeather!==false){try{weather=await weatherData(state);if(!weather)weatherError='Choose a weather location in Settings.'}catch(error){weatherError=error.message}}
    try{markets=await marketData(state,env)}catch(error){marketError=error.message;markets=state.marketCache?.data||null}
    const feed=buildDisplayFeed(state,{events,weather,markets,calendarError,weatherError,marketError});
    const width=clamp(Math.round(num(url.searchParams.get('w'),800)),300,2000),height=clamp(Math.round(num(url.searchParams.get('h'),480)),300,2000);
    const cache=globalThis.caches?.default||null,fingerprint=await einkFingerprint(feed,width,height),requests=einkCacheRequests(url,state,feed,width,height,fingerprint);
    const exact=await readCachedPng(cache,requests.exact,'html-browser-run-cache',feed);
    if(exact)return exact;
    try{
      const bytes=await screenshotWithRetry(env,renderEinkHtml(feed,width,height),width,height);
      await storeCachedPng(cache,requests,bytes);
      return pngResponse(bytes,'html-browser-run',feed);
    }catch(error){
      const stale=await readCachedPng(cache,requests.last,'html-browser-run-stale-cache',feed,error.message);
      if(stale)return stale;
      return text(renderDisplaySvg(feed,width,height),200,'image/svg+xml; charset=utf-8',{
        'x-questlog-renderer':'svg-emergency-fallback',
        'x-questlog-renderer-error':cleanText(error.message,160),
        'x-frameos-refresh-minutes':String(feed.display.refreshMinutes)
      });
    }
  }
  if(p==='/api/frameos/svg'&&method==='GET'){
    if(!identity?.displayAuthorized&&url.searchParams.get('token')!==state.display.token)return text('Invalid display token',401);
    const range=displayRange(state);
    let events=[],calendarError=null,weather=null,weatherError=null,markets=null,marketError=null;
    if(range){try{events=await eventsBetween(range.start.toISOString(),range.end.toISOString(),state,env)}catch(error){calendarError=error.message}}
    if(state.display?.showWeather!==false){try{weather=await weatherData(state);if(!weather)weatherError='Choose a weather location in Settings.'}catch(error){weatherError=error.message}}
    try{markets=await marketData(state,env)}catch(error){marketError=error.message;markets=state.marketCache?.data||null}
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
        const rows=env.DB?await env.DB.prepare("SELECT workspace_id,state_json FROM questlog_state WHERE workspace_id LIKE 'user:%'").all():{results:[]};
        for(const row of rows.results||[]){
          try{
            const userId=String(row.workspace_id||'').slice(5);
            if(!userId)continue;
            const scoped=scopedUserEnv(env,{userId});
            const state=await loadState(scoped);
            await runNotificationSweep(state,scoped,controller?.scheduledTime||Date.now());
          }catch(error){console.error('Quest Log notification sweep failed for workspace:',row.workspace_id,error)}
        }
      }catch(error){
        console.error('Quest Log scheduled sweep failed:',error);
      }
    })());
  },
  async fetch(request,env){
    const url=new URL(request.url),path=url.pathname;
    if(path==='/healthz')return json({ok:true,runtime:'cloudflare',standalone:true});

    if(path==='/api/auth/config'&&request.method==='GET')return json(authPublicConfig(env));
    if(path==='/api/auth/session'&&request.method==='GET'){
      const identity=await nativeSession(request,env);
      return json({authenticated:Boolean(identity),user:identity?.user||null});
    }
    if(path==='/api/auth/signup'&&request.method==='POST'){
      try{
        const result=await signup(request,env,await body(request));
        return json({authenticated:true,user:result.user},201,{'set-cookie':authCookie(result.session,request)});
      }catch(error){return json({error:error.message||'Could not create account.'},Number(error.status)||500)}
    }
    if(path==='/api/auth/login'&&request.method==='POST'){
      try{
        const result=await login(request,env,await body(request));
        return json({authenticated:true,user:result.user},200,{'set-cookie':authCookie(result.session,request)});
      }catch(error){return json({error:error.message||'Could not sign in.'},Number(error.status)||500)}
    }
    if(path==='/api/auth/logout'&&request.method==='POST'){
      await logout(request,env).catch(()=>null);
      return json({ok:true},200,{'set-cookie':expiredAuthCookie(request)});
    }
    if(path==='/logout'){
      await logout(request,env).catch(()=>null);
      return new Response(null,{status:302,headers:{location:'/login','set-cookie':expiredAuthCookie(request),'cache-control':'no-store'}});
    }

    if(path==='/login'){
      const identity=await nativeSession(request,env).catch(()=>null);
      if(identity)return Response.redirect(new URL('/',url),302);
      return env.ASSETS.fetch(new Request(new URL('/login.html',url),request));
    }
    if(path.startsWith('/branding/')||path==='/favicon.ico')return env.ASSETS.fetch(request);

    const machineDisplay=path==='/frame'||path==='/api/frameos/feed'||path==='/api/frameos/image'||path==='/api/frameos/svg';
    if(machineDisplay){
      try{
        let identity=await displayIdentityFromToken(env,url.searchParams.get('token'));
        if(!identity)identity=await nativeSession(request,env);
        if(!identity){const e=new Error('Display authentication is required.');e.status=401;throw e}
        if(path==='/frame')return env.ASSETS.fetch(new Request(new URL('/frame.html',url),request));
        return await handleApi(request,env,{...identity,displayAuthorized:true});
      }catch(error){
        const status=Number(error.status)||401;
        return path==='/frame'?text(error.message||'Display unavailable.',status):json({error:error.message||'Display unavailable.'},status);
      }
    }

    const identity=await nativeSession(request,env).catch(()=>null);
    if(!identity){
      if(path.startsWith('/api/'))return json({error:'Authentication required.'},401);
      const next=url.pathname+url.search;
      return Response.redirect(new URL('/login?next='+encodeURIComponent(next),url),302);
    }
    if(path.startsWith('/api/')){
      try{return await handleApi(request,env,identity)}
      catch(error){return json({error:error.message||'Unexpected cloud runtime error.'},Number(error.status)||500)}
    }
    return env.ASSETS.fetch(request);
  }
};
