import { listFriends } from './friends.js';

const TYPES=new Set(['task','goal','countdown','event']);
const clean=(v,m=500)=>String(v==null?'':v).trim().slice(0,m);
function userId(identity){
  const id=clean(identity?.userId,120);
  if(!id){const e=new Error('Quest Log account is required.');e.status=401;throw e}
  return id;
}
function typeValue(value){
  const type=clean(value,30).toLowerCase();
  if(!TYPES.has(type)){const e=new Error('Unsupported shared item type.');e.status=400;throw e}
  return type;
}
async function ensureSchema(env){
  if(!env.DB)throw new Error('Cloudflare D1 binding DB is not configured.');
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS questlog_shared_items(
      owner_user_id TEXT NOT NULL,
      item_type TEXT NOT NULL,
      item_id TEXT NOT NULL,
      item_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(owner_user_id,item_type,item_id)
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS questlog_shared_item_members(
      owner_user_id TEXT NOT NULL,
      item_type TEXT NOT NULL,
      item_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(owner_user_id,item_type,item_id,user_id)
    )
  `).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_shared_item_members_user ON questlog_shared_item_members(user_id,item_type)').run();
}
function safeIds(values,current){
  return [...new Set((Array.isArray(values)?values:[]).map(v=>clean(v,120)).filter(v=>v&&v!==current))].slice(0,50);
}
function goalProgress(item={}){
  if(item.type==='checklist'){
    const list=Array.isArray(item.checklist)?item.checklist:[];
    return list.length?Math.max(0,Math.min(100,list.filter(x=>x?.done).length/list.length*100)):0;
  }
  if(item.type==='deadline'){
    const start=item.created?new Date(item.created).getTime():NaN,end=item.deadline?new Date(item.deadline).getTime():NaN;
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return item.status==='complete'?100:0;
    return Math.max(0,Math.min(100,(Date.now()-start)/(end-start)*100));
  }
  const target=Number(item.target)||0,current=Number(item.current)||0;
  return target>0?Math.max(0,Math.min(100,current/target*100)):0;
}
function safeSnapshot(type,item={}){
  const id=clean(item.id,240);
  if(!id)throw Object.assign(new Error('Shared item ID is required.'),{status:400});
  if(type==='task')return{
    id,title:clean(item.title,160),description:clean(item.description,2000),status:clean(item.status,30),priority:clean(item.priority,30),
    due:item.due||null,start:item.start||null,estimatedMinutes:Number(item.estimatedMinutes)||0,project:clean(item.project,80),
    tags:Array.isArray(item.tags)?item.tags.slice(0,12):[],subtasks:Array.isArray(item.subtasks)?item.subtasks.slice(0,50):[],
    created:item.created||null,updated:item.updated||null,completedAt:item.completedAt||null,displayEnabled:item.displayEnabled!==false
  };
  if(type==='goal')return{
    id,title:clean(item.title,160),description:clean(item.description,2000),type:clean(item.type,30),current:Number(item.current)||0,
    target:Number(item.target)||0,unit:clean(item.unit,30),deadline:item.deadline||null,project:clean(item.project,80),status:clean(item.status,30),
    accentColor:clean(item.accentColor,30),checklist:Array.isArray(item.checklist)?item.checklist.slice(0,100):[],
    created:item.created||null,updated:item.updated||null,displayEnabled:item.displayEnabled!==false,progress:goalProgress(item)
  };
  if(type==='countdown')return{
    id,name:clean(item.name,100),end:item.end||null,created:item.created||null,accentColor:clean(item.accentColor,30),
    progressMode:clean(item.progressMode,30),progressStyle:clean(item.progressStyle,30),progressStart:item.progressStart||null,
    progressCurrent:Number(item.progressCurrent)||0,progressTotal:Number(item.progressTotal)||0,dateDisplayStyle:clean(item.dateDisplayStyle,30),
    timeDisplayStyle:clean(item.timeDisplayStyle,30),showExactDate:item.showExactDate!==false,showProgressBar:item.showProgressBar!==false,
    displayEnabled:item.displayEnabled!==false,pinned:Boolean(item.pinned)
  };
  return{
    id,title:clean(item.title||item.summary,500)||'Shared event',description:clean(item.description,8000),
    start:item.start||null,end:item.end||item.start||null,allDay:Boolean(item.allDay),location:clean(item.location,1000),
    transparency:item.transparency==='transparent'?'transparent':'opaque',recurringEventId:clean(item.recurringEventId,240),
    recurrence:Array.isArray(item.recurrence)?item.recurrence.slice(0,20):[]
  };
}
async function acceptedFriendIds(env,identity){
  const data=await listFriends(env,identity);
  return new Set((data.friends||[]).map(x=>clean(x.userId,120)).filter(Boolean));
}
async function memberRows(env,owner,type,itemId){
  const result=await env.DB.prepare(`
    SELECT m.user_id,u.primary_email,u.display_name,u.avatar_data
    FROM questlog_shared_item_members m
    LEFT JOIN questlog_users u ON u.user_id=m.user_id
    WHERE m.owner_user_id=? AND m.item_type=? AND m.item_id=?
    ORDER BY lower(COALESCE(u.display_name,u.primary_email,''))
  `).bind(owner,type,itemId).all();
  return result.results||[];
}
export async function syncItemShare(env,identity,itemType,item,requestedUserIds=[]){
  await ensureSchema(env);
  const owner=userId(identity),type=typeValue(itemType),snapshot=safeSnapshot(type,item);
  const ids=safeIds(requestedUserIds,owner);
  if(ids.length){
    const allowed=await acceptedFriendIds(env,identity);
    const invalid=ids.filter(id=>!allowed.has(id));
    if(invalid.length){const e=new Error('Only accepted Quest Log friends can be invited.');e.status=403;throw e}
  }
  if(!ids.length){
    await env.DB.batch([
      env.DB.prepare('DELETE FROM questlog_shared_item_members WHERE owner_user_id=? AND item_type=? AND item_id=?').bind(owner,type,snapshot.id),
      env.DB.prepare('DELETE FROM questlog_shared_items WHERE owner_user_id=? AND item_type=? AND item_id=?').bind(owner,type,snapshot.id)
    ]);
    return{sharedWithUserIds:[]};
  }
  await env.DB.prepare(`
    INSERT INTO questlog_shared_items(owner_user_id,item_type,item_id,item_json,created_at,updated_at)
    VALUES(?,?,?,?,datetime('now'),datetime('now'))
    ON CONFLICT(owner_user_id,item_type,item_id) DO UPDATE SET item_json=excluded.item_json,updated_at=datetime('now')
  `).bind(owner,type,snapshot.id,JSON.stringify(snapshot)).run();
  await env.DB.prepare('DELETE FROM questlog_shared_item_members WHERE owner_user_id=? AND item_type=? AND item_id=?').bind(owner,type,snapshot.id).run();
  await env.DB.batch(ids.map(friendId=>env.DB.prepare(`
    INSERT INTO questlog_shared_item_members(owner_user_id,item_type,item_id,user_id,created_at)
    VALUES(?,?,?,?,datetime('now'))
  `).bind(owner,type,snapshot.id,friendId)));
  return{sharedWithUserIds:ids};
}
export async function deleteItemShare(env,identity,itemType,itemId){
  await ensureSchema(env);
  const owner=userId(identity),type=typeValue(itemType),id=clean(itemId,240);
  if(!id)return;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM questlog_shared_item_members WHERE owner_user_id=? AND item_type=? AND item_id=?').bind(owner,type,id),
    env.DB.prepare('DELETE FROM questlog_shared_items WHERE owner_user_id=? AND item_type=? AND item_id=?').bind(owner,type,id)
  ]);
}
export async function refreshOwnedShareSnapshots(env,identity,itemType,items=[]){
  await ensureSchema(env);
  const owner=userId(identity),type=typeValue(itemType);
  const existing=await env.DB.prepare('SELECT item_id FROM questlog_shared_items WHERE owner_user_id=? AND item_type=?').bind(owner,type).all();
  const ids=new Set((existing.results||[]).map(x=>String(x.item_id)));
  const updates=(items||[]).filter(item=>ids.has(String(item.id))).map(item=>
    env.DB.prepare("UPDATE questlog_shared_items SET item_json=?,updated_at=datetime('now') WHERE owner_user_id=? AND item_type=? AND item_id=?")
      .bind(JSON.stringify(safeSnapshot(type,item)),owner,type,String(item.id))
  );
  if(updates.length)await env.DB.batch(updates);
}
export async function decorateOwnedShares(env,identity,itemType,items=[]){
  await ensureSchema(env);
  const owner=userId(identity),type=typeValue(itemType);
  const result=await env.DB.prepare('SELECT item_id,user_id FROM questlog_shared_item_members WHERE owner_user_id=? AND item_type=?').bind(owner,type).all();
  const map=new Map();
  for(const row of result.results||[]){
    if(!map.has(row.item_id))map.set(row.item_id,[]);
    map.get(row.item_id).push(String(row.user_id));
  }
  return (items||[]).map(item=>({...item,sharedWithUserIds:map.get(String(item.id))||[]}));
}
function sharedDisplayItem(type,row){
  let item={};
  try{item=JSON.parse(row.item_json||'{}')}catch{}
  const sourceId=clean(item.id||row.item_id,240),owner=String(row.owner_user_id||'');
  const common={
    ...item,
    id:'shared:'+owner+':'+type+':'+sourceId,
    shareSourceId:sourceId,
    shared:true,
    canEdit:false,
    ownerUserId:owner,
    sharedByName:String(row.display_name||row.primary_email||'Quest Log friend'),
    sharedByEmail:String(row.primary_email||''),
    sharedWithUserIds:[]
  };
  if(type==='task')return{...common,goalId:'',googleAccountId:'',googleTaskListId:'',googleTaskListTitle:'',googleTaskId:'',googleParentId:'',googleUpdated:null,googleEtag:''};
  if(type==='countdown')return{...common,goalId:''};
  if(type==='event')return{...common,accountId:'',accountLabel:common.sharedByName,calendarId:'shared',calendarName:'Shared with me',accessRole:'reader',calendarColor:'#6c5ce7',calendarForeground:'#ffffff',eventColor:'',eventForeground:'',colorId:'',htmlLink:''};
  return common;
}
export async function sharedPlannerItems(env,identity){
  await ensureSchema(env);
  const current=userId(identity);
  const result=await env.DB.prepare(`
    SELECT s.owner_user_id,s.item_type,s.item_id,s.item_json,s.updated_at,u.primary_email,u.display_name
    FROM questlog_shared_item_members m
    JOIN questlog_shared_items s
      ON s.owner_user_id=m.owner_user_id AND s.item_type=m.item_type AND s.item_id=m.item_id
    LEFT JOIN questlog_users u ON u.user_id=s.owner_user_id
    WHERE m.user_id=? AND s.item_type IN ('task','goal','countdown')
    ORDER BY s.updated_at DESC
  `).bind(current).all();
  const out={tasks:[],goals:[],countdowns:[]};
  for(const row of result.results||[]){
    const item=sharedDisplayItem(row.item_type,row);
    if(row.item_type==='task')out.tasks.push(item);
    if(row.item_type==='goal')out.goals.push(item);
    if(row.item_type==='countdown')out.countdowns.push(item);
  }
  return out;
}
function overlaps(event,from,to){
  const start=new Date(event.start).getTime(),end=new Date(event.end||event.start).getTime();
  const min=from?new Date(from).getTime():-Infinity,max=to?new Date(to).getTime():Infinity;
  return Number.isFinite(start)&&start<max&&(!Number.isFinite(end)||end>min);
}
export async function mergeSharedEvents(env,identity,ownEvents=[],from=null,to=null){
  await ensureSchema(env);
  const current=userId(identity);
  const decorated=await decorateOwnedShares(env,identity,'event',ownEvents);
  const result=await env.DB.prepare(`
    SELECT s.owner_user_id,s.item_type,s.item_id,s.item_json,s.updated_at,u.primary_email,u.display_name
    FROM questlog_shared_item_members m
    JOIN questlog_shared_items s
      ON s.owner_user_id=m.owner_user_id AND s.item_type=m.item_type AND s.item_id=m.item_id
    LEFT JOIN questlog_users u ON u.user_id=s.owner_user_id
    WHERE m.user_id=? AND s.item_type='event'
    ORDER BY s.updated_at DESC
  `).bind(current).all();
  const shared=(result.results||[]).map(row=>sharedDisplayItem('event',row)).filter(item=>overlaps(item,from,to));
  return [...decorated,...shared].sort((a,b)=>new Date(a.start)-new Date(b.start));
}
export function sharedEventSnapshot(googleEvent={},incoming={}){
  const start=googleEvent?.start?.dateTime||googleEvent?.start?.date||incoming.start||incoming.startDate||null;
  const end=googleEvent?.end?.dateTime||googleEvent?.end?.date||incoming.end||incoming.endDate||start;
  return{
    id:clean(googleEvent?.id||incoming.id,240),
    title:clean(googleEvent?.summary||incoming.title,500)||'Shared event',
    description:clean(googleEvent?.description??incoming.description,8000),
    start,end,allDay:Boolean(googleEvent?.start?.date||incoming.allDay),
    location:clean(googleEvent?.location??incoming.location,1000),
    transparency:(googleEvent?.transparency||incoming.transparency)==='transparent'?'transparent':'opaque',
    recurringEventId:clean(googleEvent?.recurringEventId,240),
    recurrence:Array.isArray(googleEvent?.recurrence)?googleEvent.recurrence:[]
  };
}
export async function pruneSharesForFormerFriend(env,currentUserId,otherUserId){
  if(!env.DB)return;
  await ensureSchema(env);
  const current=clean(currentUserId,120),other=clean(otherUserId,120);
  if(!current||!other)return;
  await env.DB.prepare(`
    DELETE FROM questlog_shared_item_members
    WHERE (owner_user_id=? AND user_id=?) OR (owner_user_id=? AND user_id=?)
  `).bind(current,other,other,current).run();
}
