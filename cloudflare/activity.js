const clean=(v,m=500)=>String(v==null?'':v).trim().slice(0,m);
const id=()=>crypto.randomUUID();

function currentUserId(identity){
  const value=clean(identity?.userId,120);
  if(!value){const error=new Error('Quest Log account is required.');error.status=401;throw error}
  return value;
}
async function ensureSchema(env){
  if(!env.DB)throw new Error('Cloudflare D1 binding DB is not configured.');
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS questlog_activity_notifications(
      notification_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      actor_user_id TEXT,
      actor_name TEXT,
      actor_avatar_data TEXT,
      target_type TEXT,
      target_id TEXT,
      target_owner_user_id TEXT,
      route TEXT,
      data_json TEXT NOT NULL DEFAULT '{}',
      dedupe_key TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      read_at TEXT
    )
  `).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_activity_user_created ON questlog_activity_notifications(user_id,created_at DESC)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_activity_user_unread ON questlog_activity_notifications(user_id,is_read,created_at DESC)').run();
  await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_user_dedupe ON questlog_activity_notifications(user_id,dedupe_key) WHERE dedupe_key IS NOT NULL').run();
}
async function actorProfile(env,userId){
  if(!userId)return{name:'',avatarData:''};
  const row=await env.DB.prepare('SELECT display_name,primary_email,avatar_data FROM questlog_users WHERE user_id=?').bind(userId).first().catch(()=>null);
  return{
    name:clean(row?.display_name||row?.primary_email||'Quest Log friend',160),
    avatarData:clean(row?.avatar_data,180000)
  };
}
function kindMessage(kind,actorName,subject='',targetType='item',meta={}){
  const actor=actorName||'A Quest Log friend',name=subject||('shared '+targetType);
  if(kind==='friend_request')return{title:actor+' sent you a friend request',body:'Accept or decline the request from your notification center.'};
  if(kind==='friend_accepted')return{title:actor+' accepted your friend request',body:'You can now invite each other to Quest Log planner items.'};
  if(kind==='share_invite')return{title:actor+' invited you to '+name,body:'Permission: '+(meta.permissionLabel||'View only')+'.'};
  if(kind==='share_accepted')return{title:actor+' accepted your invitation',body:name+' is now shared with them.'};
  if(kind==='share_declined')return{title:actor+' declined your invitation',body:name+' was not added to their planner.'};
  if(kind==='share_permission')return{title:actor+' changed your access',body:'Your permission for '+name+' is now '+(meta.permissionLabel||'View only')+'.'};
  if(kind==='share_revoked')return{title:actor+' removed your access',body:name+' is no longer shared with you.'};
  if(kind==='shared_item_completed')return{title:actor+' completed '+name,body:'A shared '+targetType+' was completed.'};
  if(kind==='shared_item_updated')return{title:actor+' updated '+name,body:'A shared '+targetType+' was changed.'};
  return{title:actor+' updated Quest Log',body:subject||''};
}
function routeFor(targetType=''){
  if(targetType==='task')return'/?view=tasks';
  if(targetType==='goal')return'/?view=goals';
  if(targetType==='countdown')return'/?view=countdowns';
  if(targetType==='event')return'/?view=planner';
  return'/?view=today';
}
function publicRow(row){
  let data={};try{data=JSON.parse(row.data_json||'{}')}catch{}
  return{
    notificationId:String(row.notification_id||''),
    kind:String(row.kind||''),
    title:String(row.title||''),
    body:String(row.body||''),
    actorUserId:String(row.actor_user_id||''),
    actorName:String(row.actor_name||''),
    actorAvatarData:String(row.actor_avatar_data||''),
    targetType:String(row.target_type||''),
    targetId:String(row.target_id||''),
    targetOwnerUserId:String(row.target_owner_user_id||''),
    route:String(row.route||''),
    data,
    read:Boolean(row.is_read),
    createdAt:row.created_at||null,
    readAt:row.read_at||null
  };
}
export async function createActivityNotification(env,input={}){
  await ensureSchema(env);
  const userId=clean(input.userId,120);
  if(!userId)throw new Error('Notification recipient is required.');
  const actorUserId=clean(input.actorUserId,120),profile=await actorProfile(env,actorUserId);
  const kind=clean(input.kind,80),targetType=clean(input.targetType,40),subject=clean(input.subject,240);
  const message=kindMessage(kind,profile.name,subject,targetType,input.meta||{});
  const notificationId=id(),dedupeKey=clean(input.dedupeKey,240)||null,route=clean(input.route||routeFor(targetType),500);
  const dataJson=JSON.stringify(input.data&&typeof input.data==='object'?input.data:{});
  if(dedupeKey){
    await env.DB.prepare(`
      INSERT INTO questlog_activity_notifications(
        notification_id,user_id,kind,title,body,actor_user_id,actor_name,actor_avatar_data,
        target_type,target_id,target_owner_user_id,route,data_json,dedupe_key,is_read,created_at,read_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),NULL)
      ON CONFLICT(user_id,dedupe_key) DO UPDATE SET
        kind=excluded.kind,title=excluded.title,body=excluded.body,actor_user_id=excluded.actor_user_id,
        actor_name=excluded.actor_name,actor_avatar_data=excluded.actor_avatar_data,target_type=excluded.target_type,
        target_id=excluded.target_id,target_owner_user_id=excluded.target_owner_user_id,route=excluded.route,
        data_json=excluded.data_json,is_read=0,created_at=datetime('now'),read_at=NULL
    `).bind(notificationId,userId,kind,message.title,message.body,actorUserId||null,profile.name,profile.avatarData,targetType||null,clean(input.targetId,240)||null,clean(input.targetOwnerUserId,120)||null,route,dataJson,dedupeKey).run();
    const row=await env.DB.prepare('SELECT * FROM questlog_activity_notifications WHERE user_id=? AND dedupe_key=?').bind(userId,dedupeKey).first();
    return publicRow(row||{});
  }
  await env.DB.prepare(`
    INSERT INTO questlog_activity_notifications(
      notification_id,user_id,kind,title,body,actor_user_id,actor_name,actor_avatar_data,
      target_type,target_id,target_owner_user_id,route,data_json,dedupe_key,is_read,created_at,read_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),NULL)
  `).bind(notificationId,userId,kind,message.title,message.body,actorUserId||null,profile.name,profile.avatarData,targetType||null,clean(input.targetId,240)||null,clean(input.targetOwnerUserId,120)||null,route,dataJson,null).run();
  const row=await env.DB.prepare('SELECT * FROM questlog_activity_notifications WHERE notification_id=?').bind(notificationId).first();
  return publicRow(row||{});
}
export async function listActivityNotifications(env,identity,{limit=60}={}){
  await ensureSchema(env);
  const userId=currentUserId(identity),safeLimit=Math.max(1,Math.min(100,Number(limit)||60));
  const [rows,count]=await Promise.all([
    env.DB.prepare('SELECT * FROM questlog_activity_notifications WHERE user_id=? ORDER BY created_at DESC LIMIT ?').bind(userId,safeLimit).all(),
    env.DB.prepare('SELECT COUNT(*) AS total FROM questlog_activity_notifications WHERE user_id=? AND is_read=0').bind(userId).first()
  ]);
  return{notifications:(rows.results||[]).map(publicRow),unreadCount:Number(count?.total)||0};
}
export async function markActivityNotifications(env,identity,input={}){
  await ensureSchema(env);
  const userId=currentUserId(identity),all=Boolean(input.all),ids=[...new Set((Array.isArray(input.notificationIds)?input.notificationIds:[]).map(v=>clean(v,120)).filter(Boolean))].slice(0,100);
  if(all){
    await env.DB.prepare("UPDATE questlog_activity_notifications SET is_read=1,read_at=COALESCE(read_at,datetime('now')) WHERE user_id=? AND is_read=0").bind(userId).run();
  }else if(ids.length){
    const placeholders=ids.map(()=>'?').join(',');
    await env.DB.prepare(`UPDATE questlog_activity_notifications SET is_read=1,read_at=COALESCE(read_at,datetime('now')) WHERE user_id=? AND notification_id IN (${placeholders})`).bind(userId,...ids).run();
  }
  const row=await env.DB.prepare('SELECT COUNT(*) AS total FROM questlog_activity_notifications WHERE user_id=? AND is_read=0').bind(userId).first();
  return{ok:true,unreadCount:Number(row?.total)||0};
}
export async function removeActivityNotification(env,identity,notificationId){
  await ensureSchema(env);
  const userId=currentUserId(identity),idValue=clean(notificationId,120);
  if(!idValue)return{ok:true};
  await env.DB.prepare('DELETE FROM questlog_activity_notifications WHERE user_id=? AND notification_id=?').bind(userId,idValue).run();
  return{ok:true};
}
