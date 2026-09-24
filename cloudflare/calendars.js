import { loadState, saveState, normalizeTask, normalizeGoal, normalizeCountdown, normalizeQuestEvent, cleanText, iso } from './state.js';

const COLOR_RE=/^#[0-9a-f]{6}$/i;
function userId(identity){
  const value=cleanText(identity?.userId,120);
  if(!value){const e=new Error('Quest Log account is required.');e.status=401;throw e}
  return value;
}
function scopedEnv(env,id){
  const scoped=Object.create(env);
  scoped.CLOUD_WORKSPACE_ID='user:'+id;
  return scoped;
}
async function ensureSchema(env){
  if(!env.DB)throw new Error('Cloudflare D1 binding DB is not configured.');
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS questlog_calendars(
      calendar_id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#6c5ce7',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS questlog_calendar_members(
      calendar_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(calendar_id,user_id)
    )
  `).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_questlog_cal_owner ON questlog_calendars(owner_user_id)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_questlog_cal_member ON questlog_calendar_members(user_id)').run();
}
async function userProfile(env,id){
  return env.DB.prepare('SELECT user_id,primary_email,display_name,avatar_data FROM questlog_users WHERE user_id=?').bind(id).first();
}
async function ensurePersonalCalendar(env,identity){
  await ensureSchema(env);
  const current=userId(identity);
  let row=await env.DB.prepare('SELECT * FROM questlog_calendars WHERE owner_user_id=? ORDER BY created_at LIMIT 1').bind(current).first();
  if(row)return row;
  const profile=await userProfile(env,current);
  const calendarId=crypto.randomUUID();
  const name=(cleanText(profile?.display_name,120)||'My calendar')+'';
  await env.DB.prepare(`
    INSERT INTO questlog_calendars(calendar_id,owner_user_id,name,color,created_at,updated_at)
    VALUES(?,?,?,'#6c5ce7',datetime('now'),datetime('now'))
  `).bind(calendarId,current,name==='My calendar'?name:'My calendar').run();
  return env.DB.prepare('SELECT * FROM questlog_calendars WHERE calendar_id=?').bind(calendarId).first();
}
async function visibleCalendarRows(env,identity){
  await ensurePersonalCalendar(env,identity);
  const current=userId(identity);
  const result=await env.DB.prepare(`
    SELECT c.calendar_id,c.owner_user_id,c.name,c.color,c.created_at,c.updated_at,
           CASE WHEN c.owner_user_id=? THEN 'owner' ELSE COALESCE(m.role,'viewer') END AS role,
           u.primary_email AS owner_email,u.display_name AS owner_name,u.avatar_data AS owner_avatar
    FROM questlog_calendars c
    JOIN questlog_users u ON u.user_id=c.owner_user_id
    LEFT JOIN questlog_calendar_members m ON m.calendar_id=c.calendar_id AND m.user_id=?
    WHERE c.owner_user_id=? OR m.user_id=?
    ORDER BY CASE WHEN c.owner_user_id=? THEN 0 ELSE 1 END, lower(c.name)
  `).bind(current,current,current,current,current).all();
  return result.results||[];
}
async function memberRows(env,calendarId){
  const result=await env.DB.prepare(`
    SELECT m.user_id,m.role,m.created_at,m.updated_at,u.primary_email,u.display_name,u.avatar_data
    FROM questlog_calendar_members m JOIN questlog_users u ON u.user_id=m.user_id
    WHERE m.calendar_id=? ORDER BY lower(COALESCE(u.display_name,u.primary_email,''))
  `).bind(calendarId).all();
  return result.results||[];
}
function publicCalendar(row,members=[]){
  return{
    id:String(row.calendar_id||''),
    ownerUserId:String(row.owner_user_id||''),
    name:String(row.name||'Calendar'),
    color:COLOR_RE.test(String(row.color||''))?String(row.color):'#6c5ce7',
    role:String(row.role||'viewer'),
    shared:members.length>0||String(row.role||'')!=='owner',
    owner:{userId:String(row.owner_user_id||''),email:String(row.owner_email||''),displayName:String(row.owner_name||''),avatarData:String(row.owner_avatar||'')},
    members:members.map(m=>({userId:String(m.user_id||''),role:String(m.role||'viewer'),email:String(m.primary_email||''),displayName:String(m.display_name||''),avatarData:String(m.avatar_data||'')}))
  };
}
export async function listQuestCalendars(env,identity){
  const rows=await visibleCalendarRows(env,identity);
  const out=[];
  for(const row of rows)out.push(publicCalendar(row,await memberRows(env,row.calendar_id)));
  return{calendars:out};
}
export async function createQuestCalendar(env,identity,payload={}){
  await ensureSchema(env);
  const current=userId(identity),name=cleanText(payload.name||'New calendar',120),color=COLOR_RE.test(String(payload.color||''))?String(payload.color):'#6c5ce7';
  if(!name){const e=new Error('Calendar name is required.');e.status=400;throw e}
  const id=crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO questlog_calendars(calendar_id,owner_user_id,name,color,created_at,updated_at)
    VALUES(?,?,?,?,datetime('now'),datetime('now'))
  `).bind(id,current,name,color).run();
  return{calendar:(await listQuestCalendars(env,identity)).calendars.find(c=>c.id===id)};
}
async function calendarAccess(env,identity,calendarId){
  await ensureSchema(env);
  const current=userId(identity),row=await env.DB.prepare(`
    SELECT c.*,CASE WHEN c.owner_user_id=? THEN 'owner' ELSE m.role END AS role
    FROM questlog_calendars c LEFT JOIN questlog_calendar_members m ON m.calendar_id=c.calendar_id AND m.user_id=?
    WHERE c.calendar_id=? AND (c.owner_user_id=? OR m.user_id=?)
  `).bind(current,current,calendarId,current,current).first();
  if(!row){const e=new Error('Calendar was not found.');e.status=404;throw e}
  return row;
}
export async function updateQuestCalendar(env,identity,calendarId,payload={}){
  const row=await calendarAccess(env,identity,calendarId);
  if(row.role!=='owner'){const e=new Error('Only the calendar owner can change calendar settings.');e.status=403;throw e}
  const name=payload.name===undefined?row.name:cleanText(payload.name,120);
  const color=payload.color===undefined?row.color:(COLOR_RE.test(String(payload.color))?String(payload.color):row.color);
  if(!name){const e=new Error('Calendar name is required.');e.status=400;throw e}
  await env.DB.prepare('UPDATE questlog_calendars SET name=?,color=?,updated_at=datetime(\'now\') WHERE calendar_id=?').bind(name,color,calendarId).run();
  return{ok:true};
}
export async function deleteQuestCalendar(env,identity,calendarId){
  const row=await calendarAccess(env,identity,calendarId);
  if(row.role!=='owner'){const e=new Error('Only the calendar owner can delete this calendar.');e.status=403;throw e}
  const owned=(await env.DB.prepare('SELECT calendar_id FROM questlog_calendars WHERE owner_user_id=? ORDER BY created_at').bind(row.owner_user_id).all()).results||[];
  if(owned.length<=1){const e=new Error('Keep at least one Quest Log calendar.');e.status=409;throw e}
  const fallback=owned.find(x=>x.calendar_id!==calendarId)?.calendar_id||'';
  const state=await loadState(scopedEnv(env,row.owner_user_id));
  state.events=(state.events||[]).map(x=>x.calendarId===calendarId?normalizeQuestEvent({...x,calendarId:fallback}):x);
  state.tasks=(state.tasks||[]).map(x=>x.calendarId===calendarId?normalizeTask({...x,calendarId:fallback}):x);
  state.goals=(state.goals||[]).map(x=>x.calendarId===calendarId?normalizeGoal({...x,calendarId:fallback}):x);
  state.countdowns=(state.countdowns||[]).map(x=>x.calendarId===calendarId?normalizeCountdown({...x,calendarId:fallback}):x);
  await saveState(scopedEnv(env,row.owner_user_id),state);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM questlog_calendar_members WHERE calendar_id=?').bind(calendarId),
    env.DB.prepare('DELETE FROM questlog_calendars WHERE calendar_id=?').bind(calendarId)
  ]);
  return{ok:true};
}
async function areFriends(env,a,b){
  const low=String(a)<String(b)?a:b,high=String(a)<String(b)?b:a;
  const row=await env.DB.prepare("SELECT status FROM questlog_friendships WHERE user_low=? AND user_high=?").bind(low,high).first();
  return row?.status==='accepted';
}
export async function addCalendarMember(env,identity,calendarId,payload={}){
  const row=await calendarAccess(env,identity,calendarId);
  if(row.role!=='owner'){const e=new Error('Only the calendar owner can share it.');e.status=403;throw e}
  const target=cleanText(payload.userId,120),role=['viewer','editor'].includes(String(payload.role))?String(payload.role):'editor';
  if(!target){const e=new Error('Choose a Quest Log friend.');e.status=400;throw e}
  if(target===row.owner_user_id){const e=new Error('The owner already has access.');e.status=400;throw e}
  if(!await areFriends(env,row.owner_user_id,target)){const e=new Error('You can only share calendars with accepted Quest Log friends.');e.status=403;throw e}
  await env.DB.prepare(`
    INSERT INTO questlog_calendar_members(calendar_id,user_id,role,created_at,updated_at)
    VALUES(?,?,?,datetime('now'),datetime('now'))
    ON CONFLICT(calendar_id,user_id) DO UPDATE SET role=excluded.role,updated_at=datetime('now')
  `).bind(calendarId,target,role).run();
  return{ok:true};
}
export async function removeCalendarMember(env,identity,calendarId,targetUserId){
  const row=await calendarAccess(env,identity,calendarId),current=userId(identity),target=cleanText(targetUserId,120);
  if(row.role!=='owner'&&target!==current){const e=new Error('Only the owner can remove other members.');e.status=403;throw e}
  await env.DB.prepare('DELETE FROM questlog_calendar_members WHERE calendar_id=? AND user_id=?').bind(calendarId,target).run();
  return{ok:true};
}
function itemDate(item,type){
  if(type==='event')return item.start||item.end||'';
  if(type==='task')return item.start||item.due||'';
  if(type==='goal')return item.deadline||'';
  if(type==='countdown')return item.end||'';
  return'';
}
function inRange(value,from,to){
  if(!value)return false;const time=new Date(value).getTime();if(!Number.isFinite(time))return false;
  return time>=from.getTime()-86400000&&time<to.getTime()+86400000;
}
function participantSet(value){
  return Array.isArray(value)?[...new Set(value.map(String).filter(Boolean))].slice(0,50):[];
}
async function acceptedFriendIds(env,current){
  const result=await env.DB.prepare(`
    SELECT CASE WHEN user_low=? THEN user_high ELSE user_low END AS friend_id
    FROM questlog_friendships
    WHERE status='accepted' AND (user_low=? OR user_high=?)
  `).bind(current,current,current).all();
  return (result.results||[]).map(row=>String(row.friend_id||'')).filter(Boolean);
}
async function calendarRowById(env,calendarId,current){
  if(!calendarId)return null;
  const row=await env.DB.prepare(`
    SELECT c.calendar_id,c.owner_user_id,c.name,c.color,c.created_at,c.updated_at,
           CASE WHEN c.owner_user_id=? THEN 'owner' ELSE COALESCE(m.role,'') END AS role,
           u.primary_email AS owner_email,u.display_name AS owner_name,u.avatar_data AS owner_avatar
    FROM questlog_calendars c
    JOIN questlog_users u ON u.user_id=c.owner_user_id
    LEFT JOIN questlog_calendar_members m ON m.calendar_id=c.calendar_id AND m.user_id=?
    WHERE c.calendar_id=?
  `).bind(current,current,calendarId).first();
  return row||null;
}
function sharedItem(type,item,owner,calendar){
  return{
    ...item,
    ownerUserId:owner.user_id,
    ownerName:owner.display_name||owner.primary_email||'Quest Log user',
    ownerEmail:owner.primary_email||'',
    calendarName:calendar.name,
    calendarColor:calendar.color,
    calendarRole:calendar.role,
    sharedFromOtherUser:calendar.owner_user_id!==owner.user_id,
    participants:participantSet(item.participantIds)
  };
}
export async function sharedPlannerData(env,identity,fromValue,toValue){
  await ensureSchema(env);
  const current=userId(identity),from=new Date(fromValue),to=new Date(toValue);
  if(Number.isNaN(from.getTime())||Number.isNaN(to.getTime())||to<=from||to-from>370*86400000){const e=new Error('Invalid shared calendar date range.');e.status=400;throw e}
  const rows=await visibleCalendarRows(env,identity),calendarMap=new Map(rows.map(r=>[r.calendar_id,r]));
  const friends=await acceptedFriendIds(env,current);
  const owners=[...new Set([current,...friends,...rows.map(r=>r.owner_user_id)])],events=[],tasks=[],goals=[],countdowns=[];
  for(const ownerId of owners){
    const owner=await userProfile(env,ownerId)||{user_id:ownerId};
    const state=await loadState(scopedEnv(env,ownerId));
    for(const [type,list,target] of [['event',state.events||[],events],['task',state.tasks||[],tasks],['goal',state.goals||[],goals],['countdown',state.countdowns||[],countdowns]]){
      for(const item of list){
        if(!inRange(itemDate(item,type),from,to))continue;
        const participants=participantSet(item.participantIds),directInvite=ownerId!==current&&participants.includes(current);
        let calendar=calendarMap.get(item.calendarId);
        const ownsItem=ownerId===current;
        if(!calendar&&directInvite){
          const raw=await calendarRowById(env,item.calendarId,current);
          calendar=raw?{...raw,role:'participant'}:{calendar_id:item.calendarId,owner_user_id:ownerId,name:'Shared item',color:'#6c5ce7',role:'participant'};
        }
        if(!ownsItem&&!calendar&&!directInvite)continue;
        if(!calendar){
          const raw=await calendarRowById(env,item.calendarId,current);
          calendar=raw||{calendar_id:item.calendarId,owner_user_id:ownerId,name:'Quest Log',color:'#6c5ce7',role:'owner'};
        }
        target.push(sharedItem(type,item,owner,calendar));
      }
    }
  }
  return{events,tasks,goals,countdowns};
}
async function sharedItemAccess(env,identity,type,ownerUserId,itemId){
  const current=userId(identity),calendarRows=await visibleCalendarRows(env,identity),calendarMap=new Map(calendarRows.map(r=>[r.calendar_id,r]));
  const state=await loadState(scopedEnv(env,ownerUserId));
  const key=type==='event'?'events':type==='task'?'tasks':type==='goal'?'goals':type==='countdown'?'countdowns':'';
  if(!key){const e=new Error('Unsupported shared item type.');e.status=400;throw e}
  const index=(state[key]||[]).findIndex(x=>x.id===itemId);
  if(index<0){const e=new Error('Shared item was not found.');e.status=404;throw e}
  const item=state[key][index],directInvite=participantSet(item.participantIds).includes(current);
  let calendar=calendarMap.get(item.calendarId);
  if(ownerUserId===current&&!calendar)calendar=await calendarRowById(env,item.calendarId,current);
  if(!calendar&&directInvite){
    const raw=await calendarRowById(env,item.calendarId,current);
    calendar=raw?{...raw,role:'participant'}:{calendar_id:item.calendarId,owner_user_id:ownerUserId,name:'Shared item',color:'#6c5ce7',role:'participant'};
  }
  if(!calendar||calendar.owner_user_id!==ownerUserId){const e=new Error('You do not have access to this item.');e.status=403;throw e}
  return{state,key,index,item,calendar,directInvite};
}
export async function updateSharedItem(env,identity,type,ownerUserId,itemId,payload={}){
  const access=await sharedItemAccess(env,identity,type,ownerUserId,itemId),current=userId(identity);
  if(access.calendar.owner_user_id!==current&&access.calendar.role!=='editor'&&access.calendar.role!=='participant'){const e=new Error('This shared item is view-only.');e.status=403;throw e}
  let next;
  const base={...access.item,...payload,id:itemId};
  if(type==='event')next=normalizeQuestEvent(base);
  else if(type==='task')next=normalizeTask({...base,updated:new Date().toISOString()});
  else if(type==='goal')next=normalizeGoal({...base,updated:new Date().toISOString()});
  else next=normalizeCountdown(base);
  access.state[access.key][access.index]=next;
  await saveState(scopedEnv(env,ownerUserId),access.state);
  return next;
}
export async function deleteSharedItem(env,identity,type,ownerUserId,itemId){
  const access=await sharedItemAccess(env,identity,type,ownerUserId,itemId),current=userId(identity);
  if(access.calendar.owner_user_id!==current&&access.calendar.role!=='editor'){const e=new Error('Only the owner or a shared-calendar editor can delete this item.');e.status=403;throw e}
  access.state[access.key].splice(access.index,1);
  await saveState(scopedEnv(env,ownerUserId),access.state);
  return{ok:true};
}
export async function ensureOwnedCalendar(env,identity,calendarId){
  const defaultCal=await ensurePersonalCalendar(env,identity),current=userId(identity),id=cleanText(calendarId,120)||defaultCal.calendar_id;
  const row=await env.DB.prepare('SELECT calendar_id FROM questlog_calendars WHERE calendar_id=? AND owner_user_id=?').bind(id,current).first();
  if(!row){const e=new Error('Choose one of your Quest Log calendars.');e.status=400;throw e}
  return id;
}
export async function sanitizeParticipants(env,identity,values){
  const current=userId(identity),ids=participantSet(values),out=[];
  for(const target of ids)if(target!==current&&await areFriends(env,current,target))out.push(target);
  return out;
}
