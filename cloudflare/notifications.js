import { saveState, cleanText, clamp, num, normalizeNotifications } from './state.js';
import { eventsBetween } from './google.js';

const enc=new TextEncoder();
const DAY=86400000;

const b64u=bytes=>{
  let raw='';for(const b of bytes)raw+=String.fromCharCode(b);
  return btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
};
const fromB64u=value=>{
  const s=String(value||'').replace(/-/g,'+').replace(/_/g,'/');
  const raw=atob(s+'='.repeat((4-s.length%4)%4));
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
};
const concat=(...parts)=>{
  const size=parts.reduce((n,p)=>n+p.length,0),out=new Uint8Array(size);let offset=0;
  for(const part of parts){out.set(part,offset);offset+=part.length}
  return out;
};
async function hmac(keyBytes,data){
  const key=await crypto.subtle.importKey('raw',keyBytes,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC',key,data));
}
async function hkdfExpand(prk,info,length){
  let out=new Uint8Array(0),previous=new Uint8Array(0),counter=1;
  while(out.length<length){
    previous=await hmac(prk,concat(previous,info,new Uint8Array([counter++])));
    out=concat(out,previous);
  }
  return out.slice(0,length);
}
function vapidConfig(env){
  const publicKey=cleanText(env.VAPID_PUBLIC_KEY,200),privateKey=cleanText(env.VAPID_PRIVATE_KEY,200);
  return{
    configured:Boolean(publicKey&&privateKey),
    publicKey,
    privateKey,
    subject:cleanText(env.VAPID_SUBJECT||'mailto:questlog@localhost',320)
  };
}
function firebaseConfig(env){
  const projectId=cleanText(env.FIREBASE_PROJECT_ID,200),clientEmail=cleanText(env.FIREBASE_CLIENT_EMAIL,320),privateKey=String(env.FIREBASE_PRIVATE_KEY||'').trim();
  return{configured:Boolean(projectId&&clientEmail&&privateKey),projectId,clientEmail,privateKey};
}
function apnsConfig(env){
  const teamId=cleanText(env.APNS_TEAM_ID,120),keyId=cleanText(env.APNS_KEY_ID,120),privateKey=String(env.APNS_PRIVATE_KEY||'').trim(),bundleId=cleanText(env.APNS_BUNDLE_ID||'ca.mattmoonie.questlog',240);
  return{configured:Boolean(teamId&&keyId&&privateKey&&bundleId),teamId,keyId,privateKey,bundleId,sandbox:String(env.APNS_SANDBOX||'').toLowerCase()==='true'};
}
function pemBytes(value){
  const raw=String(value||'').replace(/\\n/g,'\n').replace(/-----BEGIN [^-]+-----/g,'').replace(/-----END [^-]+-----/g,'').replace(/\s+/g,'');
  if(!raw)throw new Error('Push private key is empty.');
  const binary=atob(raw);
  return Uint8Array.from(binary,char=>char.charCodeAt(0));
}
function jsonB64u(value){return b64u(enc.encode(JSON.stringify(value)))}
let firebaseTokenCache={token:'',expiresAt:0};
async function firebaseAccessToken(env){
  const config=firebaseConfig(env);if(!config.configured)throw new Error('Firebase push is not configured.');
  if(firebaseTokenCache.token&&Date.now()<firebaseTokenCache.expiresAt-60000)return firebaseTokenCache.token;
  const now=Math.floor(Date.now()/1000),header=jsonB64u({alg:'RS256',typ:'JWT'}),payload=jsonB64u({
    iss:config.clientEmail,
    scope:'https://www.googleapis.com/auth/firebase.messaging',
    aud:'https://oauth2.googleapis.com/token',
    iat:now,
    exp:now+3600
  });
  const key=await crypto.subtle.importKey('pkcs8',pemBytes(config.privateKey),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const input=header+'.'+payload,signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,enc.encode(input));
  const assertion=input+'.'+b64u(new Uint8Array(signature));
  const response=await fetch('https://oauth2.googleapis.com/token',{
    method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion})
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data.access_token)throw new Error('Firebase OAuth failed: '+(data.error_description||data.error||response.status));
  firebaseTokenCache={token:data.access_token,expiresAt:Date.now()+num(data.expires_in,3600)*1000};
  return firebaseTokenCache.token;
}
let apnsTokenCache={token:'',expiresAt:0,key:''};
async function apnsProviderToken(env){
  const config=apnsConfig(env);if(!config.configured)throw new Error('Apple push is not configured.');
  const cacheKey=config.teamId+'|'+config.keyId;
  if(apnsTokenCache.token&&apnsTokenCache.key===cacheKey&&Date.now()<apnsTokenCache.expiresAt)return apnsTokenCache.token;
  const now=Math.floor(Date.now()/1000),header=jsonB64u({alg:'ES256',kid:config.keyId}),payload=jsonB64u({iss:config.teamId,iat:now}),input=header+'.'+payload;
  const key=await crypto.subtle.importKey('pkcs8',pemBytes(config.privateKey),{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,enc.encode(input));
  const token=input+'.'+b64u(new Uint8Array(signature));
  apnsTokenCache={token,expiresAt:Date.now()+50*60*1000,key:cacheKey};
  return token;
}
async function sendFirebasePush(device,payload,env){
  const config=firebaseConfig(env),access=await firebaseAccessToken(env);
  const response=await fetch('https://fcm.googleapis.com/v1/projects/'+encodeURIComponent(config.projectId)+'/messages:send',{
    method:'POST',
    headers:{authorization:'Bearer '+access,'content-type':'application/json'},
    body:JSON.stringify({message:{
      token:device.token,
      notification:{title:payload.title,body:payload.body},
      data:{url:payload.url||'/?view=today',kind:payload.kind||'activity',tag:payload.tag||''},
      android:{priority:'HIGH',notification:{channel_id:'questlog-updates',sound:'default'}}
    }})
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
    const error=new Error('FCM returned '+response.status+': '+(data?.error?.message||'push failed'));
    error.status=response.status;
    error.code=data?.error?.details?.[0]?.errorCode||'';
    throw error;
  }
  return true;
}
async function sendApnsPush(device,payload,env){
  const config=apnsConfig(env),provider=await apnsProviderToken(env),host=config.sandbox?'https://api.sandbox.push.apple.com':'https://api.push.apple.com';
  const response=await fetch(host+'/3/device/'+encodeURIComponent(device.token),{
    method:'POST',
    headers:{
      authorization:'bearer '+provider,
      'apns-topic':config.bundleId,
      'apns-push-type':'alert',
      'apns-priority':'10'
    },
    body:JSON.stringify({
      aps:{alert:{title:payload.title,body:payload.body},sound:'default'},
      url:payload.url||'/?view=today',
      kind:payload.kind||'activity',
      tag:payload.tag||''
    })
  });
  if(!response.ok){
    const data=await response.json().catch(()=>({}));
    const error=new Error('APNs returned '+response.status+': '+(data.reason||'push failed'));
    error.status=response.status;
    error.code=data.reason||'';
    throw error;
  }
  return true;
}
async function sendNativePush(device,payload,env){
  if(device.platform==='android')return sendFirebasePush(device,payload,env);
  if(device.platform==='ios')return sendApnsPush(device,payload,env);
  throw new Error('Unsupported native push platform.');
}
async function vapidJwt(endpoint,config){
  const publicBytes=fromB64u(config.publicKey),privateBytes=fromB64u(config.privateKey);
  if(publicBytes.length!==65||publicBytes[0]!==4||privateBytes.length!==32)throw new Error('Invalid VAPID key pair.');
  const key=await crypto.subtle.importKey('jwk',{
    kty:'EC',crv:'P-256',x:b64u(publicBytes.slice(1,33)),y:b64u(publicBytes.slice(33,65)),d:b64u(privateBytes),ext:true
  },{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const header=b64u(enc.encode(JSON.stringify({typ:'JWT',alg:'ES256'})));
  const payload=b64u(enc.encode(JSON.stringify({
    aud:new URL(endpoint).origin,
    exp:Math.floor(Date.now()/1000)+12*60*60,
    sub:config.subject
  })));
  const data=enc.encode(header+'.'+payload);
  const signature=new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,data));
  return header+'.'+payload+'.'+b64u(signature);
}
async function encryptPayload(subscription,payload){
  const uaPublic=fromB64u(subscription.keys?.p256dh),auth=fromB64u(subscription.keys?.auth);
  if(uaPublic.length!==65||uaPublic[0]!==4||!auth.length)throw new Error('Invalid push subscription encryption keys.');
  const uaKey=await crypto.subtle.importKey('raw',uaPublic,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const server=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const serverPublic=new Uint8Array(await crypto.subtle.exportKey('raw',server.publicKey));
  const shared=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:uaKey},server.privateKey,256));
  const prkKey=await hmac(auth,shared);
  const ikm=await hkdfExpand(prkKey,concat(enc.encode('WebPush: info\0'),uaPublic,serverPublic),32);
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const prk=await hmac(salt,ikm);
  const cek=await hkdfExpand(prk,enc.encode('Content-Encoding: aes128gcm\0'),16);
  const nonce=await hkdfExpand(prk,enc.encode('Content-Encoding: nonce\0'),12);
  const aesKey=await crypto.subtle.importKey('raw',cek,{name:'AES-GCM'},false,['encrypt']);
  const plaintext=concat(enc.encode(JSON.stringify(payload)),new Uint8Array([2]));
  const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,tagLength:128},aesKey,plaintext));
  const rs=new Uint8Array(4);new DataView(rs.buffer).setUint32(0,4096);
  return concat(salt,rs,new Uint8Array([serverPublic.length]),serverPublic,ciphertext);
}
export async function sendWebPush(subscription,payload,env){
  const config=vapidConfig(env);
  if(!config.configured)throw new Error('Cloud push notifications need VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.');
  const endpoint=cleanText(subscription?.endpoint,2000);
  if(!/^https:\/\//i.test(endpoint))throw new Error('Invalid push endpoint.');
  const body=await encryptPayload(subscription,payload);
  const token=await vapidJwt(endpoint,config);
  const response=await fetch(endpoint,{
    method:'POST',
    headers:{
      'TTL':'300',
      'Urgency':'high',
      'Content-Encoding':'aes128gcm',
      'Content-Type':'application/octet-stream',
      'Authorization':'vapid t='+token+', k='+config.publicKey
    },
    body
  });
  if(!response.ok){
    const error=new Error('Push service returned '+response.status+'.');
    error.status=response.status;
    throw error;
  }
  return true;
}
export function notificationConfig(state,env){
  const cfg=normalizeNotifications(state.notifications),vapid=vapidConfig(env),firebase=firebaseConfig(env),apns=apnsConfig(env);
  return{
    configured:vapid.configured||firebase.configured||apns.configured,
    webConfigured:vapid.configured,
    androidConfigured:firebase.configured,
    iosConfigured:apns.configured,
    publicKey:vapid.configured?vapid.publicKey:'',
    enabled:cfg.enabled,
    taskReminders:cfg.taskReminders,
    eventReminders:cfg.eventReminders,
    goalReminders:cfg.goalReminders,
    countdownReminders:cfg.countdownReminders,
    socialUpdates:cfg.socialUpdates,
    taskLeadMinutes:cfg.taskLeadMinutes,
    eventLeadMinutes:cfg.eventLeadMinutes,
    goalLeadMinutes:cfg.goalLeadMinutes,
    countdownLeadMinutes:cfg.countdownLeadMinutes,
    subscriptionCount:cfg.subscriptions.length,
    nativeDeviceCount:cfg.nativeDevices.length,
    scheduler:'cloudflare-cron'
  };
}
export function updateNotificationPreferences(state,input={}){
  state.notifications=normalizeNotifications({
    ...state.notifications,
    enabled:input.enabled??state.notifications?.enabled,
    taskReminders:input.taskReminders??state.notifications?.taskReminders,
    eventReminders:input.eventReminders??state.notifications?.eventReminders,
    goalReminders:input.goalReminders??state.notifications?.goalReminders,
    countdownReminders:input.countdownReminders??state.notifications?.countdownReminders,
    socialUpdates:input.socialUpdates??state.notifications?.socialUpdates,
    taskLeadMinutes:input.taskLeadMinutes??state.notifications?.taskLeadMinutes,
    eventLeadMinutes:input.eventLeadMinutes??state.notifications?.eventLeadMinutes,
    goalLeadMinutes:input.goalLeadMinutes??state.notifications?.goalLeadMinutes,
    countdownLeadMinutes:input.countdownLeadMinutes??state.notifications?.countdownLeadMinutes
  });
  return state.notifications;
}
export function registerSubscription(state,raw,userAgent=''){
  const cfg=normalizeNotifications(state.notifications),endpoint=cleanText(raw?.endpoint,2000);
  const p256dh=cleanText(raw?.keys?.p256dh,500),auth=cleanText(raw?.keys?.auth,500);
  if(!/^https:\/\//i.test(endpoint)||!p256dh||!auth)throw new Error('Invalid push subscription.');
  const now=new Date().toISOString(),existing=cfg.subscriptions.find(item=>item.endpoint===endpoint);
  const next={endpoint,keys:{p256dh,auth},userAgent:cleanText(userAgent,300),createdAt:existing?.createdAt||now,lastSeen:now};
  cfg.subscriptions=cfg.subscriptions.filter(item=>item.endpoint!==endpoint);
  cfg.subscriptions.push(next);
  state.notifications=normalizeNotifications(cfg);
  return next;
}
export function unregisterSubscription(state,endpoint){
  const cfg=normalizeNotifications(state.notifications),target=cleanText(endpoint,2000),before=cfg.subscriptions.length;
  cfg.subscriptions=cfg.subscriptions.filter(item=>item.endpoint!==target);
  state.notifications=normalizeNotifications(cfg);
  return before!==state.notifications.subscriptions.length;
}
export function registerNativeDevice(state,raw={}){
  const cfg=normalizeNotifications(state.notifications),token=cleanText(raw.token,4096),platform=['android','ios'].includes(raw.platform)?raw.platform:'';
  if(!token||!platform)throw new Error('Invalid native push registration.');
  const now=new Date().toISOString(),existing=cfg.nativeDevices.find(item=>item.token===token);
  const next={token,platform,createdAt:existing?.createdAt||now,lastSeen:now};
  cfg.nativeDevices=cfg.nativeDevices.filter(item=>item.token!==token);
  cfg.nativeDevices.push(next);
  state.notifications=normalizeNotifications(cfg);
  return next;
}
export function unregisterNativeDevice(state,token){
  const cfg=normalizeNotifications(state.notifications),target=cleanText(token,4096),before=cfg.nativeDevices.length;
  cfg.nativeDevices=cfg.nativeDevices.filter(item=>item.token!==target);
  state.notifications=normalizeNotifications(cfg);
  return before!==state.notifications.nativeDevices.length;
}
async function sendToNativeDevices(state,payload,env,onlyToken=''){
  const cfg=normalizeNotifications(state.notifications),keep=[],results=[];
  for(const device of cfg.nativeDevices){
    if(onlyToken&&device.token!==onlyToken){keep.push(device);continue}
    try{
      await sendNativePush(device,payload,env);
      keep.push(device);results.push({token:device.token,platform:device.platform,ok:true});
    }catch(error){
      const gone=(device.platform==='android'&&(error.code==='UNREGISTERED'||error.status===404))||(device.platform==='ios'&&['BadDeviceToken','Unregistered','DeviceTokenNotForTopic'].includes(error.code));
      if(!gone)keep.push(device);
      results.push({token:device.token,platform:device.platform,ok:false,gone,error:error.message});
    }
  }
  if(onlyToken){
    const untouched=cfg.nativeDevices.filter(item=>item.token!==onlyToken);
    cfg.nativeDevices=[...untouched,...keep.filter(item=>item.token===onlyToken)];
  }else cfg.nativeDevices=keep;
  state.notifications=normalizeNotifications(cfg);
  return results;
}
async function sendToSubscriptions(state,payload,env,onlyEndpoint=''){
  const cfg=normalizeNotifications(state.notifications),keep=[],results=[];
  for(const subscription of cfg.subscriptions){
    if(onlyEndpoint&&subscription.endpoint!==onlyEndpoint){keep.push(subscription);continue}
    try{
      await sendWebPush(subscription,payload,env);
      keep.push(subscription);results.push({endpoint:subscription.endpoint,ok:true});
    }catch(error){
      const gone=error?.status===404||error?.status===410;
      if(!gone)keep.push(subscription);
      results.push({endpoint:subscription.endpoint,ok:false,gone,error:error.message});
    }
  }
  if(onlyEndpoint){
    const untouched=cfg.subscriptions.filter(item=>item.endpoint!==onlyEndpoint);
    cfg.subscriptions=[...untouched,...keep.filter(item=>item.endpoint===onlyEndpoint)];
  }else cfg.subscriptions=keep;
  state.notifications=normalizeNotifications(cfg);
  return results;
}
export async function sendInstantNotification(state,env,payload={}){
  const cfg=normalizeNotifications(state.notifications);state.notifications=cfg;
  if(!cfg.enabled||!cfg.socialUpdates)return{sent:0,skipped:true};
  const safePayload={
    title:cleanText(payload.title||'Quest Log',180),
    body:cleanText(payload.body||'',360),
    tag:cleanText(payload.tag||('questlog-activity-'+Date.now()),220),
    url:cleanText(payload.url||'/?view=today',500),
    kind:cleanText(payload.kind||'activity',80),
    timestamp:new Date().toISOString()
  };
  const webResults=cfg.subscriptions.length&&vapidConfig(env).configured?await sendToSubscriptions(state,safePayload,env):[];
  const nativeResults=cfg.nativeDevices.length?await sendToNativeDevices(state,safePayload,env):[];
  const results=[...webResults,...nativeResults];
  await saveState(env,state);
  return{sent:results.filter(item=>item.ok).length,results};
}
export async function sendTestNotification(state,env,endpoint=''){
  const payload={
    title:'Quest Log notifications are on',
    body:'Push notifications are working on this device.',
    tag:'questlog-test',
    url:'/?view=today',
    kind:'test',
    timestamp:new Date().toISOString()
  };
  const results=await sendToSubscriptions(state,payload,env,cleanText(endpoint,2000));
  await saveState(env,state);
  return{ok:results.some(item=>item.ok),results:results.map(item=>({ok:item.ok,gone:item.gone||false,error:item.error||''}))};
}
export async function sendNativeTestNotification(state,env,token=''){
  const payload={
    title:'Quest Log notifications are on',
    body:'Native push notifications are working on this device.',
    tag:'questlog-native-test',
    url:'/?view=today',
    kind:'test',
    timestamp:new Date().toISOString()
  };
  const results=await sendToNativeDevices(state,payload,env,cleanText(token,4096));
  await saveState(env,state);
  return{ok:results.some(item=>item.ok),results:results.map(item=>({ok:item.ok,platform:item.platform,gone:item.gone||false,error:item.error||''}))};
}
function relativeMinutes(target,now){
  const minutes=Math.max(0,Math.round((target-now)/60000));
  if(minutes<60)return minutes<=1?'in about a minute':'in '+minutes+' minutes';
  const hours=Math.round(minutes/60);if(hours<24)return hours===1?'in about an hour':'in about '+hours+' hours';
  const days=Math.round(hours/24);return days===1?'tomorrow':'in '+days+' days';
}
function reminderItems(state,events,now){
  const cfg=normalizeNotifications(state.notifications),items=[];
  const add=(kind,id,target,lead,title,body,url)=>{
    if(!target||!Number.isFinite(target))return;
    const earliest=now-5*60000,latest=now+lead*60000;
    if(target<earliest||target>latest)return;
    const key=[kind,id,new Date(target).toISOString(),lead].join(':');
    if(cfg.sent[key])return;
    items.push({key,payload:{title,body,tag:'questlog-'+kind+'-'+id,url,kind,timestamp:new Date(now).toISOString()}});
  };
  if(cfg.taskReminders)for(const task of state.tasks||[]){
    if(task.status==='done'||!task.due)continue;
    const target=new Date(task.due).getTime();
    add('task',task.id,target,cfg.taskLeadMinutes,'Task due soon',task.title+' is due '+relativeMinutes(target,now)+'.','/?view=tasks');
  }
  if(cfg.goalReminders)for(const goal of state.goals||[]){
    if(goal.status==='complete'||!goal.deadline)continue;
    const target=new Date(goal.deadline).getTime();
    add('goal',goal.id,target,cfg.goalLeadMinutes,'Goal deadline approaching',goal.title+' is due '+relativeMinutes(target,now)+'.','/?view=goals');
  }
  if(cfg.countdownReminders)for(const item of state.countdowns||[]){
    const target=new Date(item.end).getTime();if(target<=now)continue;
    add('countdown',item.id,target,cfg.countdownLeadMinutes,'Countdown approaching',item.name+' is '+relativeMinutes(target,now)+'.','/?view=countdowns');
  }
  if(cfg.eventReminders)for(const event of events||[]){
    if(event.allDay||!event.start)continue;
    const target=new Date(event.start).getTime();
    add('event',(event.accountId||'')+'-'+(event.calendarId||'')+'-'+event.id,target,cfg.eventLeadMinutes,'Calendar event soon',event.title+' starts '+relativeMinutes(target,now)+'.','/?view=planner');
  }
  return items;
}
export async function runNotificationSweep(state,env,nowMs=Date.now()){
  let cfg=normalizeNotifications(state.notifications);
  state.notifications=cfg;
  const canWeb=cfg.subscriptions.length&&vapidConfig(env).configured,canNative=cfg.nativeDevices.length;
  if(!cfg.enabled||(!canWeb&&!canNative))return{sent:0,skipped:true};
  let events=[];
  if(cfg.eventReminders&&state.google?.accounts?.length){
    const end=new Date(nowMs+Math.max(cfg.eventLeadMinutes,5)*60000);
    try{events=await eventsBetween(new Date(nowMs-5*60000).toISOString(),end.toISOString(),state,env)}catch{}
  }
  const items=reminderItems(state,events,nowMs);let sent=0;
  for(const item of items){
    const webResults=canWeb?await sendToSubscriptions(state,item.payload,env):[];
    const nativeResults=canNative?await sendToNativeDevices(state,item.payload,env):[];
    const results=[...webResults,...nativeResults];
    if(results.some(result=>result.ok)){state.notifications.sent[item.key]=new Date(nowMs).toISOString();sent++}
  }
  const cutoff=nowMs-45*DAY,entries=Object.entries(state.notifications.sent||{}).filter(([,value])=>new Date(value).getTime()>=cutoff).slice(-600);
  state.notifications.sent=Object.fromEntries(entries);
  await saveState(env,state);
  return{sent,checked:items.length,subscriptions:state.notifications.subscriptions.length,nativeDevices:state.notifications.nativeDevices.length};
}
