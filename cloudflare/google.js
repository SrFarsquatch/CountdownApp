import { saveState, saveGoogleAccounts, normalizeGoogleAccount, normalizeTask, id, cleanText, iso, num, clamp } from './state.js';

const SCOPES='https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/tasks';
const enc=new TextEncoder(),dec=new TextDecoder();

function b64u(bytes){
  let raw='';for(const b of bytes)raw+=String.fromCharCode(b);
  return btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function fromB64u(value){
  const s=String(value||'').replace(/-/g,'+').replace(/_/g,'/');
  const raw=atob(s+'='.repeat((4-s.length%4)%4));return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
async function appKey(env){
  if(!env.APP_SECRET)throw new Error('APP_SECRET is not configured on the Worker.');
  const hash=await crypto.subtle.digest('SHA-256',enc.encode(String(env.APP_SECRET)));
  return crypto.subtle.importKey('raw',hash,{name:'AES-GCM'},false,['encrypt','decrypt']);
}
async function encryptToken(value,env){
  const key=await appKey(env),iv=crypto.getRandomValues(new Uint8Array(12));
  const data=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,enc.encode(JSON.stringify(value)));
  return 'cf1.'+b64u(iv)+'.'+b64u(new Uint8Array(data));
}
async function decryptToken(value,env){
  if(!value||!String(value).startsWith('cf1.'))return null;
  try{
    const [,iv,data]=String(value).split('.'),key=await appKey(env);
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:fromB64u(iv)},key,fromB64u(data));
    return JSON.parse(dec.decode(plain));
  }catch{return null}
}
async function hmacKey(env){
  if(!env.APP_SECRET)throw new Error('APP_SECRET is not configured on the Worker.');
  return crypto.subtle.importKey('raw',enc.encode(String(env.APP_SECRET)),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
async function oauthState(env,context={}){
  const payload={
    v:2,
    issuedAt:Date.now(),
    nonce:b64u(crypto.getRandomValues(new Uint8Array(18))),
    userId:cleanText(context.userId,160),
    native:Boolean(context.native)
  };
  const encoded=b64u(enc.encode(JSON.stringify(payload)));
  const signed='v2.'+encoded;
  const sig=await crypto.subtle.sign('HMAC',await hmacKey(env),enc.encode(signed));
  return signed+'.'+b64u(new Uint8Array(sig));
}
export async function readGoogleOauthState(value,env){
  try{
    const raw=String(value||''),parts=raw.split('.');
    if(parts.length===3&&parts[0]==='v2'){
      const signed=parts[0]+'.'+parts[1];
      const ok=await crypto.subtle.verify('HMAC',await hmacKey(env),fromB64u(parts[2]),enc.encode(signed));
      if(!ok)return null;
      const payload=JSON.parse(dec.decode(fromB64u(parts[1])));
      const age=Date.now()-Number(payload.issuedAt||0);
      if(payload.v!==2||!payload.nonce||!Number.isFinite(age)||age<0||age>10*60*1000)return null;
      return{userId:cleanText(payload.userId,160),native:Boolean(payload.native),legacy:false};
    }
    if(parts.length===3){
      const [issued,nonce,sig]=parts,timestamp=parseInt(issued,36);
      if(!nonce||!Number.isFinite(timestamp)||Date.now()-timestamp<0||Date.now()-timestamp>10*60*1000)return null;
      const ok=await crypto.subtle.verify('HMAC',await hmacKey(env),fromB64u(sig),enc.encode(issued+'.'+nonce));
      return ok?{userId:'',native:false,legacy:true}:null;
    }
    return null;
  }catch{return null}
}
export function googleConfigured(env){return Boolean(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET&&env.APP_SECRET)}
function account(state,id){return(state.google?.accounts||[]).find(x=>x.id===id)||null}
export async function accountCapabilities(accountValue,env){
  const token=await decryptToken(accountValue?.token,env),scopes=String(token?.scope||'').split(/\s+/).filter(Boolean);
  return{
    canWrite:scopes.includes('https://www.googleapis.com/auth/calendar.events')||scopes.includes('https://www.googleapis.com/auth/calendar'),
    canTasks:scopes.includes('https://www.googleapis.com/auth/tasks')
  };
}
async function accessToken(accountValue,state,env){
  if(!accountValue)return null;
  const token=await decryptToken(accountValue.token,env);if(!token)return null;
  if(token.access_token&&token.expires_at&&Date.now()<token.expires_at-60000)return token.access_token;
  if(!token.refresh_token)return null;
  const payload=new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,refresh_token:token.refresh_token,grant_type:'refresh_token'});
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:payload});
  if(!response.ok)return null;
  const next=await response.json(),merged={...token,...next,refresh_token:token.refresh_token,scope:next.scope||token.scope,expires_at:Date.now()+num(next.expires_in,3600)*1000};
  accountValue.token=await encryptToken(merged,env);await saveGoogleAccounts(env,state.google.accounts);return merged.access_token;
}
async function googleRequest(accountValue,state,env,endpoint,method='GET',payload){
  const access=await accessToken(accountValue,state,env);if(!access)throw new Error('Google account is not connected.');
  const hasBody=payload!==undefined&&payload!==null;
  const response=await fetch('https://www.googleapis.com/calendar/v3'+endpoint,{method,headers:{Authorization:'Bearer '+access,...(hasBody?{'Content-Type':'application/json'}:{})},body:hasBody?JSON.stringify(payload):undefined});
  if(response.status===204)return null;
  const raw=await response.text();let data=null;try{data=raw?JSON.parse(raw):null}catch{}
  if(!response.ok){const e=new Error('Google Calendar request failed: '+(data?.error?.message||raw.slice(0,180)||('HTTP '+response.status)));e.status=response.status;throw e}
  return data;
}
async function tasksRequest(accountValue,state,env,endpoint,method='GET',payload){
  const access=await accessToken(accountValue,state,env);if(!access)throw new Error('Google account is not connected.');
  const caps=await accountCapabilities(accountValue,env);if(!caps.canTasks)throw new Error('Reconnect this Google account to grant Google Tasks access.');
  const hasBody=payload!==undefined&&payload!==null;
  const response=await fetch('https://tasks.googleapis.com/tasks/v1'+endpoint,{method,headers:{Authorization:'Bearer '+access,...(hasBody?{'Content-Type':'application/json'}:{})},body:hasBody?JSON.stringify(payload):undefined});
  if(response.status===204)return null;
  const raw=await response.text();let data=null;try{data=raw?JSON.parse(raw):null}catch{}
  if(!response.ok){const e=new Error('Google Tasks request failed: '+(data?.error?.message||raw.slice(0,180)||('HTTP '+response.status)));e.status=response.status;throw e}
  return data;
}
function accountLabel(items=[]){
  const primary=items.find(x=>x.primary)||items[0];if(!primary)return{googleId:'',label:'Google account'};
  const googleId=cleanText(primary.id,240),summary=cleanText(primary.summary,160);
  return{googleId,label:summary&&summary!==googleId?summary+' ('+googleId+')':(googleId||summary||'Google account')};
}
async function calendarList(accountValue,state,env){
  let out=[],pageToken='';
  do{
    const q=new URLSearchParams({maxResults:'250'});if(pageToken)q.set('pageToken',pageToken);
    const data=await googleRequest(accountValue,state,env,'/users/me/calendarList?'+q);
    out.push(...(data.items||[]));pageToken=data.nextPageToken||'';
  }while(pageToken);
  const identity=accountLabel(out),changed=(identity.googleId&&identity.googleId!==accountValue.googleId)||(identity.label&&identity.label!==accountValue.label);
  if(identity.googleId)accountValue.googleId=identity.googleId;if(identity.label)accountValue.label=identity.label;if(changed)await saveGoogleAccounts(env,state.google.accounts);
  return out;
}
export async function startGoogleAuth(request,env,identity={}){
  if(!googleConfigured(env))throw new Error('Google OAuth is not configured on the Worker.');
  const requestUrl=new URL(request.url),native=requestUrl.searchParams.get('native')==='1';
  const redirect=new URL('/api/google/callback',request.url).toString();
  const q=new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,redirect_uri:redirect,response_type:'code',scope:SCOPES,access_type:'offline',prompt:'select_account consent',include_granted_scopes:'true',state:await oauthState(env,{userId:identity.userId||'',native})});
  const authUrl='https://accounts.google.com/o/oauth2/v2/auth?'+q;
  if(requestUrl.searchParams.get('response')==='json')return new Response(JSON.stringify({url:authUrl}),{status:200,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
  return Response.redirect(authUrl,302);
}
export async function finishGoogleAuth(request,state,env,oauthContext=null){
  const url=new URL(request.url),context=oauthContext||await readGoogleOauthState(url.searchParams.get('state'),env);
  if(!context)throw new Error('Invalid or expired OAuth state. Start the Google connection again.');
  if(url.searchParams.get('error')){
    if(context.native)return Response.redirect('questlog://oauth/google?status=cancelled',302);
    throw new Error('Google authorization was cancelled.');
  }
  const redirect=new URL('/api/google/callback',request.url).toString();
  const payload=new URLSearchParams({code:url.searchParams.get('code')||'',client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,redirect_uri:redirect,grant_type:'authorization_code'});
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:payload});
  if(!response.ok)throw new Error('Google token exchange failed: '+(await response.text()).slice(0,180));
  const token=await response.json();token.expires_at=Date.now()+num(token.expires_in,3600)*1000;
  const access=token.access_token;
  const listResponse=await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250',{headers:{Authorization:'Bearer '+access}});
  if(!listResponse.ok)throw new Error('Could not identify the connected Google account.');
  const listData=await listResponse.json(),identity=accountLabel(listData.items||[]);
  let found=(state.google.accounts||[]).find(x=>x.googleId&&x.googleId===identity.googleId);
  if(found){
    const previous=await decryptToken(found.token,env)||{};
    if(!token.refresh_token&&previous.refresh_token)token.refresh_token=previous.refresh_token;
    if(!token.scope&&previous.scope)token.scope=previous.scope;
    found.token=await encryptToken(token,env);found.label=identity.label||found.label;found.connectedAt=new Date().toISOString();
  }else{
    found=normalizeGoogleAccount({id:id(),googleId:identity.googleId,label:identity.label,token:await encryptToken(token,env),selectedCalendarIds:[],selectedTaskListIds:[],connectedAt:new Date().toISOString()});
    state.google.accounts.push(found);
  }
  await saveState(env,state);
  const caps=await accountCapabilities(found,env);
  if(caps.canTasks&&!found.selectedTaskListIds.length){
    try{const lists=await taskLists(found.id,state,env);if(lists.length){found.selectedTaskListIds=[lists[0].id];found.defaultTaskListId=lists[0].id;await saveState(env,state)}}catch{}
  }
  if(context.native)return Response.redirect('questlog://oauth/google?status=connected',302);
  return Response.redirect(new URL('/?view=settings&calendar=connected',request.url).toString(),302);
}
export async function calendars(accountId,state,env){
  const a=account(state,accountId);if(!a)throw new Error('Google account was not found.');
  return(await calendarList(a,state,env)).map(c=>({id:c.id,summary:c.summary,primary:Boolean(c.primary),backgroundColor:c.backgroundColor||'',foregroundColor:c.foregroundColor||'',accessRole:c.accessRole||'reader'}));
}
export async function taskLists(accountId,state,env){
  const a=typeof accountId==='string'?account(state,accountId):accountId;if(!a)throw new Error('Google account was not found.');
  let out=[],pageToken='';
  do{const q=new URLSearchParams({maxResults:'100'});if(pageToken)q.set('pageToken',pageToken);const data=await tasksRequest(a,state,env,'/users/@me/lists?'+q);out.push(...(data.items||[]));pageToken=data.nextPageToken||''}while(pageToken);
  return out.map(x=>({id:x.id,title:x.title||'Tasks',updated:x.updated||null}));
}
function dateOnly(value){return /^\d{4}-\d{2}-\d{2}$/.test(String(value||''))?String(value):null}
function addDays(value,days){const d=new Date(value+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10)}
export function eventPayload(incoming={},allowRecurrence=false){
  const summary=cleanText(incoming.title||incoming.summary,500);if(!summary)throw new Error('Event title is required.');
  const allDay=Boolean(incoming.allDay);let start,end;
  if(allDay){const a=dateOnly(incoming.startDate),b=dateOnly(incoming.endDate||incoming.startDate);if(!a||!b||b<a)throw new Error('Valid all-day start and end dates are required.');start={date:a};end={date:addDays(b,1)}}
  else{const a=iso(incoming.start),b=iso(incoming.end);if(!a||!b||new Date(b)<=new Date(a))throw new Error('Event end time must be after its start time.');start={dateTime:a};end={dateTime:b}}
  const payload={summary,description:cleanText(incoming.description,8000),location:cleanText(incoming.location,1000),start,end,transparency:incoming.transparency==='transparent'?'transparent':'opaque'};
  if(allowRecurrence&&['daily','weekly','monthly','yearly'].includes(String(incoming.repeat||'').toLowerCase()))payload.recurrence=['RRULE:FREQ='+String(incoming.repeat).toUpperCase()];
  return payload;
}
export async function mutateEvent(accountId,calendarId,eventId,method,incoming,state,env){
  const a=account(state,accountId);if(!a)throw new Error('Google account was not found.');
  const caps=await accountCapabilities(a,env);if(!caps.canWrite)throw new Error('Reconnect this Google account to grant event editing access.');
  const entry=await googleRequest(a,state,env,'/users/me/calendarList/'+encodeURIComponent(calendarId));
  if(!['writer','owner'].includes(entry?.accessRole||'reader'))throw new Error('This calendar is read-only in Google Calendar.');
  if(method==='POST')return googleRequest(a,state,env,'/calendars/'+encodeURIComponent(calendarId)+'/events?sendUpdates=all','POST',eventPayload(incoming,true));
  if(method==='PATCH'||method==='PUT')return googleRequest(a,state,env,'/calendars/'+encodeURIComponent(calendarId)+'/events/'+encodeURIComponent(eventId)+'?sendUpdates=all','PATCH',eventPayload(incoming,false));
  if(method==='DELETE'){await googleRequest(a,state,env,'/calendars/'+encodeURIComponent(calendarId)+'/events/'+encodeURIComponent(eventId)+'?sendUpdates=all','DELETE');return null}
  throw new Error('Unsupported event operation.');
}
export async function eventsBetween(from,to,state,env){
  const accounts=(state.google.accounts||[]).filter(x=>x.token&&(x.selectedCalendarIds||[]).length);if(!accounts.length)return[];
  const min=from?new Date(from):new Date(),max=to?new Date(to):new Date(min.getTime()+clamp(num(state.google.countdownWindowDays,30),1,365)*86400000);
  if(Number.isNaN(min.getTime())||Number.isNaN(max.getTime())||max<=min||max-min>370*86400000)throw new Error('Invalid calendar date range.');
  const out=[],seen=new Set();
  for(const a of accounts){
    const items=await calendarList(a,state,env),map=new Map(items.map(c=>[c.id,c]));let colors={};
    try{colors=(await googleRequest(a,state,env,'/colors')).event||{}}catch{}
    for(const calendarId of a.selectedCalendarIds){
      const cal=map.get(calendarId)||{},q=new URLSearchParams({timeMin:min.toISOString(),timeMax:max.toISOString(),singleEvents:'true',orderBy:'startTime',maxResults:'250'});
      const data=await googleRequest(a,state,env,'/calendars/'+encodeURIComponent(calendarId)+'/events?'+q);
      for(const e of data.items||[]){
        if(e.status==='cancelled'||e.extendedProperties?.private?.questLogTaskId)continue;const start=e.start?.dateTime||e.start?.date;if(!start)continue;
        const k=calendarId+'|'+e.id+'|'+start;if(seen.has(k))continue;seen.add(k);const color=e.colorId?colors[e.colorId]:null;
        out.push({id:e.id,calendarId,accountId:a.id,accountLabel:a.label,calendarName:cal.summary||'Calendar',accessRole:cal.accessRole||'reader',calendarColor:cal.backgroundColor||'#6c5ce7',calendarForeground:cal.foregroundColor||'#ffffff',eventColor:color?.background||'',eventForeground:color?.foreground||'',colorId:e.colorId||'',title:e.summary||'Busy',description:e.description||'',start,end:e.end?.dateTime||e.end?.date||start,allDay:Boolean(e.start?.date),transparency:e.transparency||'opaque',recurringEventId:e.recurringEventId||'',recurrence:e.recurrence||[],location:e.location||'',htmlLink:e.htmlLink||''});
      }
    }
  }
  return out.sort((a,b)=>new Date(a.start)-new Date(b.start));
}
function taskTimeZone(state){
  const zone=cleanText(state?.timeZone||state?.weather?.timeZone||'America/Vancouver',100)||'America/Vancouver';
  try{new Intl.DateTimeFormat('en-CA',{timeZone:zone}).format(new Date());return zone}catch{return'UTC'}
}
function zonedParts(value,timeZone){
  const d=new Date(value);if(Number.isNaN(d.getTime()))return null;
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(d);
  return Object.fromEntries(parts.filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
}
function zonedDateKey(value,timeZone){
  if(!value)return'';
  const raw=String(value);if(/^\d{4}-\d{2}-\d{2}$/.test(raw))return raw;
  const p=zonedParts(value,timeZone);return p?p.year+'-'+p.month+'-'+p.day:'';
}
function zonedDateTimeIso(dateKey,hour,minute,timeZone){
  const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey||''));if(!match)return null;
  const target=Date.UTC(+match[1],+match[2]-1,+match[3],Number(hour)||0,Number(minute)||0,0);let guess=target;
  for(let i=0;i<4;i++){
    const p=zonedParts(new Date(guess),timeZone);if(!p)break;
    const shown=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,0);
    guess+=target-shown;
  }
  return new Date(guess).toISOString();
}
function taskPayload(task,state){
  const key=zonedDateKey(task.due,taskTimeZone(state));
  return{title:cleanText(task.title||'Task',1024),notes:cleanText(task.description,8192),status:task.status==='done'?'completed':'needsAction',completed:task.status==='done'?(iso(task.completedAt)||new Date().toISOString()):null,due:key?key+'T00:00:00.000Z':null};
}
function dueFromGoogle(value,existing,state){
  const key=String(value||'').slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(key))return null;
  const zone=taskTimeZone(state);
  if(existing&&zonedDateKey(existing,zone)===key)return iso(existing);
  const old=existing?zonedParts(existing,zone):null,h=old?Number(old.hour):12,min=old?Number(old.minute):0;
  return zonedDateTimeIso(key,h,min,zone);
}
function applyRemoteTask(local,remote,a,list,state){
  const done=remote.status==='completed',base=local||{};
  return normalizeTask({...base,id:base.id||id(),title:cleanText(remote.title||base.title||'Task',160),description:cleanText(remote.notes||'',2000),status:done?'done':(base.status==='progress'?'progress':'todo'),due:remote.due?dueFromGoogle(remote.due,base.due,state):null,project:base.project||cleanText(list?.title,80),created:base.created||iso(remote.updated)||new Date().toISOString(),updated:iso(remote.updated)||new Date().toISOString(),completedAt:done?(iso(remote.completed)||iso(remote.updated)||new Date().toISOString()):null,googleAccountId:a.id,googleTaskListId:list.id,googleTaskListTitle:list.title||'Tasks',googleTaskId:remote.id,googleParentId:remote.parent||'',googleUpdated:iso(remote.updated),googleEtag:remote.etag||''});
}
function writableCalendar(entry){return['writer','owner'].includes(String(entry?.accessRole||''))}
async function taskCalendarFor(a,task,state,env){
  const items=await calendarList(a,state,env),preferred=cleanText(task.googleTaskCalendarId,500);
  return(items.find(item=>item.id===preferred&&writableCalendar(item))
    ||items.find(item=>item.primary&&writableCalendar(item))
    ||items.find(item=>(a.selectedCalendarIds||[]).includes(item.id)&&writableCalendar(item))
    ||items.find(writableCalendar)
    ||null);
}
function taskCalendarPayload(task,state){
  const start=iso(task.due);if(!start)return null;
  const zone=taskTimeZone(state),minutes=clamp(Math.round(num(task.estimatedMinutes,30))||30,5,1440);
  const end=new Date(new Date(start).getTime()+minutes*60000).toISOString();
  return{
    summary:cleanText(task.title||'Task',500),
    description:cleanText(task.description,8000),
    start:{dateTime:start,timeZone:zone},
    end:{dateTime:end,timeZone:zone},
    transparency:'transparent',
    extendedProperties:{private:{questLogTaskId:String(task.id||''),questLogGoogleTaskId:String(task.googleTaskId||'')}}
  };
}
async function deleteTaskCalendarEvent(task,a,state,env){
  const calendarId=cleanText(task.googleTaskCalendarId,500),eventId=cleanText(task.googleTaskCalendarEventId,500);
  if(!calendarId||!eventId)return normalizeTask({...task,googleTaskCalendarId:'',googleTaskCalendarEventId:''});
  const caps=await accountCapabilities(a,env);if(!caps.canWrite)return task;
  try{await googleRequest(a,state,env,'/calendars/'+encodeURIComponent(calendarId)+'/events/'+encodeURIComponent(eventId),'DELETE')}
  catch(error){if(error.status!==404&&error.status!==410)throw error}
  return normalizeTask({...task,googleTaskCalendarId:'',googleTaskCalendarEventId:''});
}
async function syncTaskCalendarEvent(task,a,state,env){
  const caps=await accountCapabilities(a,env);if(!caps.canWrite)return task;
  if(!task.due)return deleteTaskCalendarEvent(task,a,state,env);
  const calendar=await taskCalendarFor(a,task,state,env);if(!calendar)return task;
  let next=task,eventId=cleanText(task.googleTaskCalendarEventId,500),oldCalendarId=cleanText(task.googleTaskCalendarId,500);
  if(eventId&&oldCalendarId&&oldCalendarId!==calendar.id){
    try{await googleRequest(a,state,env,'/calendars/'+encodeURIComponent(oldCalendarId)+'/events/'+encodeURIComponent(eventId),'DELETE')}catch{}
    eventId='';next=normalizeTask({...next,googleTaskCalendarId:'',googleTaskCalendarEventId:''});
  }
  const payload=taskCalendarPayload(next,state);let event=null;
  if(eventId){
    try{event=await googleRequest(a,state,env,'/calendars/'+encodeURIComponent(calendar.id)+'/events/'+encodeURIComponent(eventId),'PATCH',payload)}
    catch(error){if(error.status!==404&&error.status!==410)throw error;eventId=''}
  }
  if(!eventId)event=await googleRequest(a,state,env,'/calendars/'+encodeURIComponent(calendar.id)+'/events','POST',payload);
  return normalizeTask({...next,googleTaskCalendarId:calendar.id,googleTaskCalendarEventId:event?.id||eventId});
}
async function safeSyncTaskCalendarEvent(task,a,state,env){
  try{return await syncTaskCalendarEvent(task,a,state,env)}
  catch(error){console.warn('Quest Log timed Google task calendar sync failed',error);return task}
}
export async function createGoogleTaskLink(task,accountId,listId,state,env){
  const a=account(state,accountId);if(!a)throw new Error('Google account was not found.');const lists=await taskLists(a,state,env),list=lists.find(x=>x.id===listId);if(!list)throw new Error('Google task list was not found.');
  const remote=await tasksRequest(a,state,env,'/lists/'+encodeURIComponent(listId)+'/tasks','POST',taskPayload(task,state));
  let next=applyRemoteTask(task,remote,a,list,state);
  if(task.due)next=await safeSyncTaskCalendarEvent(next,a,state,env);
  return next;
}
export async function updateLinkedGoogleTask(task,state,env,{syncCalendarTime=false}={}){
  if(!task.googleAccountId||!task.googleTaskListId||!task.googleTaskId)return task;const a=account(state,task.googleAccountId);if(!a)throw new Error('The Google account linked to this task is disconnected.');
  const remote=await tasksRequest(a,state,env,'/lists/'+encodeURIComponent(task.googleTaskListId)+'/tasks/'+encodeURIComponent(task.googleTaskId),'PATCH',taskPayload(task,state));
  let next=applyRemoteTask(task,remote,a,{id:task.googleTaskListId,title:task.googleTaskListTitle||task.project||'Tasks'},state);
  if(syncCalendarTime||task.googleTaskCalendarEventId)next=await safeSyncTaskCalendarEvent(next,a,state,env);
  return next;
}
export async function deleteLinkedGoogleTask(task,state,env){
  if(!task.googleAccountId||!task.googleTaskListId||!task.googleTaskId)return;const a=account(state,task.googleAccountId);if(!a)return;
  if(task.googleTaskCalendarEventId){try{await deleteTaskCalendarEvent(task,a,state,env)}catch(error){console.warn('Quest Log timed task calendar cleanup failed',error)}}
  try{await tasksRequest(a,state,env,'/lists/'+encodeURIComponent(task.googleTaskListId)+'/tasks/'+encodeURIComponent(task.googleTaskId),'DELETE')}catch(e){if(e.status!==404)throw e}
}
async function remoteTasks(a,listId,state,env){
  let out=[],pageToken='';do{const q=new URLSearchParams({maxResults:'100',showCompleted:'true',showDeleted:'true',showHidden:'true'});if(pageToken)q.set('pageToken',pageToken);const data=await tasksRequest(a,state,env,'/lists/'+encodeURIComponent(listId)+'/tasks?'+q);out.push(...(data.items||[]));pageToken=data.nextPageToken||''}while(pageToken);return out;
}
export async function syncGoogleTasks(state,env){
  const result={imported:0,pulled:0,pushed:0,deleted:0,errors:[]};let changed=false;
  for(const a of state.google.accounts||[]){
    const caps=await accountCapabilities(a,env);if(!a.token||!caps.canTasks||!(a.selectedTaskListIds||[]).length)continue;
    let lists=[];try{lists=await taskLists(a,state,env)}catch(e){result.errors.push(a.label+': '+e.message);continue}const listMap=new Map(lists.map(x=>[x.id,x]));
    for(const listId of a.selectedTaskListIds){
      const list=listMap.get(listId)||{id:listId,title:'Google Tasks'};let remotes=[];try{remotes=await remoteTasks(a,listId,state,env)}catch(e){result.errors.push(a.label+' / '+list.title+': '+e.message);continue}
      const remoteMap=new Map(remotes.filter(x=>x.id).map(x=>[x.id,x])),linked=state.tasks.filter(t=>t.googleAccountId===a.id&&t.googleTaskListId===listId);
      for(const remote of remotes){
        const local=linked.find(t=>t.googleTaskId===remote.id);
        if(remote.deleted){
          if(local){
            if(local.googleTaskCalendarEventId)try{await deleteTaskCalendarEvent(local,a,state,env)}catch{}
            state.tasks=state.tasks.filter(t=>t.id!==local.id);result.deleted++;changed=true;
          }
          continue;
        }
        if(!local){state.tasks.push(applyRemoteTask(null,remote,a,list,state));result.imported++;changed=true;continue}
        const baseline=local.googleUpdated?new Date(local.googleUpdated).getTime():0,lu=local.updated?new Date(local.updated).getTime():0,ru=remote.updated?new Date(remote.updated).getTime():0;
        if(lu>baseline+500&&(!(ru>baseline+500)||lu>ru)){
          try{
            const next=await updateLinkedGoogleTask(local,state,env,{syncCalendarTime:Boolean(local.googleTaskCalendarEventId)}),i=state.tasks.findIndex(t=>t.id===local.id);
            if(i>=0)state.tasks[i]=next;result.pushed++;changed=true;
          }catch(e){result.errors.push(a.label+' / '+local.title+': '+e.message)}
        }else if(ru>baseline+500){
          const i=state.tasks.findIndex(t=>t.id===local.id);
          if(i>=0){
            let next=applyRemoteTask(local,remote,a,list,state);
            if(next.googleTaskCalendarEventId)next=await safeSyncTaskCalendarEvent(next,a,state,env);
            state.tasks[i]=next;
          }
          result.pulled++;changed=true;
        }
      }
      for(const local of linked)if(local.googleTaskId&&!remoteMap.has(local.googleTaskId)){
        if(local.googleTaskCalendarEventId)try{await deleteTaskCalendarEvent(local,a,state,env)}catch{}
        state.tasks=state.tasks.filter(t=>t.id!==local.id);result.deleted++;changed=true;
      }
    }
  }
  if(changed)await saveState(env,state);return result;
}
export async function disconnectAccount(accountId,state,env){
  const before=state.google.accounts.length;state.google.accounts=state.google.accounts.filter(a=>a.id!==accountId);
  if(before===state.google.accounts.length)return false;
  state.tasks=state.tasks.map(t=>t.googleAccountId===accountId?normalizeTask({...t,googleAccountId:'',googleTaskListId:'',googleTaskListTitle:'',googleTaskId:'',googleParentId:'',googleUpdated:null,googleEtag:'',googleTaskCalendarId:'',googleTaskCalendarEventId:''}):t);
  await saveState(env,state);return true;
}
