import { listFriends } from './friends.js';

const TYPES=new Set(['task','goal','countdown','event']);
const PERMISSIONS=new Set(['view','complete','edit']);
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
function permissionValue(value,type='task'){
  const raw=clean(value,30).toLowerCase();
  const permission=PERMISSIONS.has(raw)?raw:'view';
  if(permission==='complete'&&!['task','goal'].includes(type))return'view';
  return permission;
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
  for(const sql of [
    "ALTER TABLE questlog_shared_item_members ADD COLUMN status TEXT NOT NULL DEFAULT 'accepted'",
    "ALTER TABLE questlog_shared_item_members ADD COLUMN permission TEXT NOT NULL DEFAULT 'view'",
    "ALTER TABLE questlog_shared_item_members ADD COLUMN responded_at TEXT",
    "ALTER TABLE questlog_shared_item_members ADD COLUMN updated_at TEXT"
  ]){try{await env.DB.prepare(sql).run()}catch{}}
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_shared_item_members_user ON questlog_shared_item_members(user_id,item_type,status)').run();
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
    recurrence:Array.isArray(item.recurrence)?item.recurrence.slice(0,20):[],
    sourceAccountId:clean(item.sourceAccountId||item.accountId,160),
    sourceCalendarId:clean(item.sourceCalendarId||item.calendarId,500)
  };
}
async function acceptedFriendIds(env,identity){
  const data=await listFriends(env,identity);
  return new Set((data.friends||[]).map(x=>clean(x.userId,120)).filter(Boolean));
}
function normalizeMembers(values,current,type){
  const out=[],seen=new Set();
  for(const raw of Array.isArray(values)?values:[]){
    const user=typeof raw==='string'?raw:(raw?.userId||raw?.id),id=clean(user,120);
    if(!id||id===current||seen.has(id))continue;
    seen.add(id);
    out.push({
      userId:id,
      permission:permissionValue(typeof raw==='object'?raw.permission:'view',type),
      reinvite:Boolean(typeof raw==='object'&&raw.reinvite)
    });
    if(out.length>=50)break;
  }
  return out;
}
function publicMember(row){
  return{
    userId:String(row.user_id||''),
    email:String(row.primary_email||''),
    displayName:String(row.display_name||''),
    avatarData:String(row.avatar_data||''),
    status:['pending','accepted','declined'].includes(String(row.status))?String(row.status):'accepted',
    permission:permissionValue(row.permission,row.item_type),
    createdAt:row.created_at||null,
    updatedAt:row.updated_at||null,
    respondedAt:row.responded_at||null
  };
}
async function itemMembers(env,owner,type,itemId){
  const result=await env.DB.prepare(`
    SELECT m.user_id,m.status,m.permission,m.created_at,m.updated_at,m.responded_at,m.item_type,
           u.primary_email,u.display_name,u.avatar_data
    FROM questlog_shared_item_members m
    LEFT JOIN questlog_users u ON u.user_id=m.user_id
    WHERE m.owner_user_id=? AND m.item_type=? AND m.item_id=?
    ORDER BY lower(COALESCE(u.display_name,u.primary_email,''))
  `).bind(owner,type,itemId).all();
  return (result.results||[]).map(publicMember);
}
export async function syncItemShare(env,identity,itemType,item,requestedMembers=[]){
  await ensureSchema(env);
  const owner=userId(identity),type=typeValue(itemType),snapshot=safeSnapshot(type,item);
  const members=normalizeMembers(requestedMembers,owner,type);
  if(members.length){
    const allowed=await acceptedFriendIds(env,identity);
    const invalid=members.filter(member=>!allowed.has(member.userId));
    if(invalid.length){const e=new Error('Only accepted Quest Log friends can be invited.');e.status=403;throw e}
  }
  const previousMembers=await itemMembers(env,owner,type,snapshot.id),previousMap=new Map(previousMembers.map(x=>[x.userId,x])),activityEvents=[];
  if(!members.length){
    await env.DB.batch([
      env.DB.prepare('DELETE FROM questlog_shared_item_members WHERE owner_user_id=? AND item_type=? AND item_id=?').bind(owner,type,snapshot.id),
      env.DB.prepare('DELETE FROM questlog_shared_items WHERE owner_user_id=? AND item_type=? AND item_id=?').bind(owner,type,snapshot.id)
    ]);
    for(const member of previousMembers)activityEvents.push({kind:'share_revoked',userId:member.userId,permission:member.permission,status:member.status});
    return{sharedWithUserIds:[],sharedMembers:[],activityEvents};
  }
  await env.DB.prepare(`
    INSERT INTO questlog_shared_items(owner_user_id,item_type,item_id,item_json,created_at,updated_at)
    VALUES(?,?,?,?,datetime('now'),datetime('now'))
    ON CONFLICT(owner_user_id,item_type,item_id) DO UPDATE SET item_json=excluded.item_json,updated_at=datetime('now')
  `).bind(owner,type,snapshot.id,JSON.stringify(snapshot)).run();
  const existing=previousMembers,existingMap=previousMap;
  const desiredIds=new Set(members.map(x=>x.userId));
  const removed=existing.filter(x=>!desiredIds.has(x.userId));
  if(removed.length){
    await env.DB.batch(removed.map(member=>env.DB.prepare(
      'DELETE FROM questlog_shared_item_members WHERE owner_user_id=? AND item_type=? AND item_id=? AND user_id=?'
    ).bind(owner,type,snapshot.id,member.userId)));
    for(const member of removed)activityEvents.push({kind:'share_revoked',userId:member.userId,permission:member.permission,status:member.status});
  }
  const writes=[];
  for(const member of members){
    const previous=existingMap.get(member.userId);
    if(!previous){
      writes.push(env.DB.prepare(`
        INSERT INTO questlog_shared_item_members(owner_user_id,item_type,item_id,user_id,status,permission,created_at,updated_at)
        VALUES(?,?,?,?,'pending',?,datetime('now'),datetime('now'))
      `).bind(owner,type,snapshot.id,member.userId,member.permission));
      activityEvents.push({kind:'share_invite',userId:member.userId,permission:member.permission,status:'pending'});
      continue;
    }
    const nextStatus=previous.status==='declined'&&member.reinvite?'pending':previous.status;
    writes.push(env.DB.prepare(`
      UPDATE questlog_shared_item_members
      SET permission=?,status=?,responded_at=CASE WHEN ?='pending' THEN NULL ELSE responded_at END,updated_at=datetime('now')
      WHERE owner_user_id=? AND item_type=? AND item_id=? AND user_id=?
    `).bind(member.permission,nextStatus,nextStatus,owner,type,snapshot.id,member.userId));
    if(previous.status==='declined'&&nextStatus==='pending')activityEvents.push({kind:'share_invite',userId:member.userId,permission:member.permission,status:'pending'});
    else if(previous.permission!==member.permission)activityEvents.push({kind:'share_permission',userId:member.userId,permission:member.permission,status:nextStatus});
  }
  if(writes.length)await env.DB.batch(writes);
  const sharedMembers=await itemMembers(env,owner,type,snapshot.id);
  return{sharedWithUserIds:sharedMembers.map(x=>x.userId),sharedMembers,activityEvents};
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
  const result=await env.DB.prepare(`
    SELECT m.item_id,m.user_id,m.status,m.permission,m.created_at,m.updated_at,m.responded_at,m.item_type,
           u.primary_email,u.display_name,u.avatar_data
    FROM questlog_shared_item_members m
    LEFT JOIN questlog_users u ON u.user_id=m.user_id
    WHERE m.owner_user_id=? AND m.item_type=?
    ORDER BY lower(COALESCE(u.display_name,u.primary_email,''))
  `).bind(owner,type).all();
  const map=new Map();
  for(const row of result.results||[]){
    if(!map.has(row.item_id))map.set(row.item_id,[]);
    map.get(row.item_id).push(publicMember(row));
  }
  return (items||[]).map(item=>{
    const sharedMembers=map.get(String(item.id))||[];
    return{...item,sharedMembers,sharedWithUserIds:sharedMembers.map(x=>x.userId)};
  });
}
function sharedDisplayItem(type,row){
  let item={};
  try{item=JSON.parse(row.item_json||'{}')}catch{}
  const sourceId=clean(item.id||row.item_id,240),owner=String(row.owner_user_id||''),permission=permissionValue(row.permission,type);
  const common={
    ...item,
    id:'shared:'+owner+':'+type+':'+sourceId,
    shareSourceId:sourceId,
    shared:true,
    shareStatus:String(row.status||'accepted'),
    sharePermission:permission,
    canEdit:permission==='edit',
    canComplete:permission==='edit'||permission==='complete',
    ownerUserId:owner,
    sharedByName:String(row.display_name||row.primary_email||'Quest Log friend'),
    sharedByEmail:String(row.primary_email||''),
    sharedWithUserIds:[],
    sharedMembers:[]
  };
  if(type==='task')return{...common,goalId:'',googleAccountId:'',googleTaskListId:'',googleTaskListTitle:'',googleTaskId:'',googleParentId:'',googleUpdated:null,googleEtag:''};
  if(type==='countdown')return{...common,goalId:''};
  if(type==='event')return{...common,accountId:'',accountLabel:common.sharedByName,calendarId:'shared',calendarName:'Shared with me',accessRole:permission==='edit'?'writer':'reader',calendarColor:'#6c5ce7',calendarForeground:'#ffffff',eventColor:'',eventForeground:'',colorId:'',htmlLink:''};
  return common;
}
export async function listShareInvitations(env,identity){
  await ensureSchema(env);
  const current=userId(identity);
  const result=await env.DB.prepare(`
    SELECT s.owner_user_id,s.item_type,s.item_id,s.item_json,m.status,m.permission,m.created_at,m.updated_at,
           u.primary_email,u.display_name,u.avatar_data
    FROM questlog_shared_item_members m
    JOIN questlog_shared_items s
      ON s.owner_user_id=m.owner_user_id AND s.item_type=m.item_type AND s.item_id=m.item_id
    LEFT JOIN questlog_users u ON u.user_id=s.owner_user_id
    WHERE m.user_id=? AND m.status='pending'
    ORDER BY m.created_at DESC
  `).bind(current).all();
  return{invitations:(result.results||[]).map(row=>{
    const item=sharedDisplayItem(row.item_type,row);
    return{
      ownerUserId:String(row.owner_user_id),itemType:String(row.item_type),itemId:String(row.item_id),
      title:row.item_type==='countdown'?item.name:item.title,
      permission:permissionValue(row.permission,row.item_type),
      sharedByName:String(row.display_name||row.primary_email||'Quest Log friend'),
      sharedByEmail:String(row.primary_email||''),avatarData:String(row.avatar_data||''),
      createdAt:row.created_at||null
    };
  })};
}
export async function respondShareInvitation(env,identity,ownerUserId,itemType,itemId,action){
  await ensureSchema(env);
  const current=userId(identity),owner=clean(ownerUserId,120),type=typeValue(itemType),id=clean(itemId,240),decision=clean(action,20).toLowerCase();
  if(!owner||!id||!['accept','decline'].includes(decision)){const e=new Error('Invalid invitation response.');e.status=400;throw e}
  const row=await env.DB.prepare(`
    SELECT status FROM questlog_shared_item_members
    WHERE owner_user_id=? AND item_type=? AND item_id=? AND user_id=?
  `).bind(owner,type,id,current).first();
  if(!row){const e=new Error('Invitation not found.');e.status=404;throw e}
  if(row.status!=='pending'){const e=new Error('This invitation has already been answered.');e.status=409;throw e}
  const status=decision==='accept'?'accepted':'declined';
  await env.DB.prepare(`
    UPDATE questlog_shared_item_members SET status=?,responded_at=datetime('now'),updated_at=datetime('now')
    WHERE owner_user_id=? AND item_type=? AND item_id=? AND user_id=?
  `).bind(status,owner,type,id,current).run();
  return{ok:true,status};
}
export async function getSharedItemAccess(env,identity,ownerUserId,itemType,itemId){
  await ensureSchema(env);
  const current=userId(identity),owner=clean(ownerUserId,120),type=typeValue(itemType),id=clean(itemId,240);
  const row=await env.DB.prepare(`
    SELECT m.status,m.permission,s.item_json,u.primary_email,u.display_name
    FROM questlog_shared_item_members m
    JOIN questlog_shared_items s
      ON s.owner_user_id=m.owner_user_id AND s.item_type=m.item_type AND s.item_id=m.item_id
    LEFT JOIN questlog_users u ON u.user_id=m.owner_user_id
    WHERE m.owner_user_id=? AND m.item_type=? AND m.item_id=? AND m.user_id=?
  `).bind(owner,type,id,current).first();
  if(!row||row.status!=='accepted'){const e=new Error('This shared item is not available to your account.');e.status=403;throw e}
  let snapshot={};try{snapshot=JSON.parse(row.item_json||'{}')}catch{}
  const permission=permissionValue(row.permission,type);
  return{ownerUserId:owner,itemType:type,itemId:id,permission,canEdit:permission==='edit',canComplete:permission==='edit'||permission==='complete',snapshot,sharedByName:String(row.display_name||row.primary_email||'Quest Log friend')};
}
export async function sharedPlannerItems(env,identity){
  await ensureSchema(env);
  const current=userId(identity);
  const result=await env.DB.prepare(`
    SELECT s.owner_user_id,s.item_type,s.item_id,s.item_json,s.updated_at,m.status,m.permission,u.primary_email,u.display_name
    FROM questlog_shared_item_members m
    JOIN questlog_shared_items s
      ON s.owner_user_id=m.owner_user_id AND s.item_type=m.item_type AND s.item_id=m.item_id
    LEFT JOIN questlog_users u ON u.user_id=s.owner_user_id
    WHERE m.user_id=? AND m.status='accepted' AND s.item_type IN ('task','goal','countdown')
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
    SELECT s.owner_user_id,s.item_type,s.item_id,s.item_json,s.updated_at,m.status,m.permission,u.primary_email,u.display_name
    FROM questlog_shared_item_members m
    JOIN questlog_shared_items s
      ON s.owner_user_id=m.owner_user_id AND s.item_type=m.item_type AND s.item_id=m.item_id
    LEFT JOIN questlog_users u ON u.user_id=s.owner_user_id
    WHERE m.user_id=? AND m.status='accepted' AND s.item_type='event'
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
    recurrence:Array.isArray(googleEvent?.recurrence)?googleEvent.recurrence:[],
    sourceAccountId:clean(incoming.sourceAccountId||incoming.accountId,160),
    sourceCalendarId:clean(incoming.sourceCalendarId||incoming.calendarId,500)
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
