function clean(value,max=1000){return String(value??'').trim().slice(0,max)}
function accountId(identity){
 const value=clean(identity?.userId,120);
 if(!value){const e=new Error('Quest Log account is required.');e.status=401;throw e}
 return value;
}
function fail(message,status=400){const e=new Error(message);e.status=status;throw e}
function unique(values,max=50){return[...new Set((Array.isArray(values)?values:[]).map(value=>clean(value,120)).filter(Boolean))].slice(0,max)}
function pairKey(a,b){return[a,b].map(String).sort().join(':')}
function validIso(value){const time=Date.parse(String(value||''));return Number.isFinite(time)}
function dbIso(value){
 const raw=String(value||'').trim();
 if(!raw)return null;
 if(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw))return raw.replace(' ','T')+'Z';
 if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(raw))return raw+'Z';
 return raw;
}
function person(row,prefix=''){
 const p=prefix?prefix+'_':'';
 return{
  userId:String(row[p+'user_id']||''),
  email:String(row[p+'primary_email']||''),
  displayName:String(row[p+'display_name']||''),
  avatarData:String(row[p+'avatar_data']||'')
 };
}
let messagingSchemaReady=null;
export async function ensureMessagingSchema(env){
 if(!env.DB)throw new Error('Cloudflare D1 binding DB is not configured.');
 if(!messagingSchemaReady){
  messagingSchemaReady=env.DB.batch([
   env.DB.prepare(\`
    CREATE TABLE IF NOT EXISTS questlog_conversations(
     conversation_id TEXT PRIMARY KEY,
     type TEXT NOT NULL,
     title TEXT,
     direct_key TEXT UNIQUE,
     created_by TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
   \`),
   env.DB.prepare(\`
    CREATE TABLE IF NOT EXISTS questlog_conversation_members(
     conversation_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     role TEXT NOT NULL DEFAULT 'member',
     joined_at TEXT NOT NULL DEFAULT (datetime('now')),
     last_read_at TEXT,
     PRIMARY KEY(conversation_id,user_id)
    )
   \`),
   env.DB.prepare(\`
    CREATE TABLE IF NOT EXISTS questlog_messages(
     message_id TEXT PRIMARY KEY,
     conversation_id TEXT NOT NULL,
     sender_user_id TEXT NOT NULL,
     body TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     edited_at TEXT
    )
   \`),
   env.DB.prepare(\`
    CREATE TABLE IF NOT EXISTS questlog_message_reactions(
     message_id TEXT NOT NULL,
     conversation_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     emoji TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY(message_id,user_id)
    )
   \`),
   env.DB.prepare(\`
    CREATE TABLE IF NOT EXISTS questlog_group_events(
     event_id TEXT PRIMARY KEY,
     conversation_id TEXT NOT NULL,
     title TEXT NOT NULL,
     description TEXT,
     location TEXT,
     start_at TEXT NOT NULL,
     end_at TEXT NOT NULL,
     all_day INTEGER NOT NULL DEFAULT 0,
     created_by TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
   \`),
   env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_questlog_conv_members_user ON questlog_conversation_members(user_id,conversation_id)'),
   env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_questlog_messages_conv ON questlog_messages(conversation_id,created_at)'),
   env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_questlog_reactions_conv ON questlog_message_reactions(conversation_id,message_id)'),
   env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_questlog_group_events_conv ON questlog_group_events(conversation_id,start_at,end_at)')
  ]).then(()=>undefined).catch(error=>{messagingSchemaReady=null;throw error});
 }
 return messagingSchemaReady;
}
async function acceptedFriend(env,current,target){
 const low=String(current)<String(target)?String(current):String(target),high=String(current)<String(target)?String(target):String(current);
 return env.DB.prepare("SELECT friendship_id FROM questlog_friendships WHERE user_low=? AND user_high=? AND status='accepted' LIMIT 1").bind(low,high).first();
}
async function assertFriends(env,current,targets){
 for(const target of unique(targets)){
  if(target===current)continue;
  const relation=await acceptedFriend(env,current,target);
  if(!relation)fail('Groups and direct messages can only include accepted Quest Log friends.',403);
 }
}
async function memberRow(env,current,conversationId){
 await ensureMessagingSchema(env);
 const row=await env.DB.prepare(`
  SELECT c.conversation_id,c.type,c.title,c.direct_key,c.created_by,c.created_at,c.updated_at,
         cm.role,cm.joined_at,cm.last_read_at
  FROM questlog_conversations c
  JOIN questlog_conversation_members cm ON cm.conversation_id=c.conversation_id
  WHERE c.conversation_id=? AND cm.user_id=?
  LIMIT 1
 `).bind(clean(conversationId,120),current).first();
 if(!row)fail('Conversation not found.',404);
 return row;
}
async function membersFor(env,conversationId){
 const result=await env.DB.prepare(`
  SELECT cm.user_id,cm.role,cm.joined_at,u.primary_email,u.display_name,u.avatar_data
  FROM questlog_conversation_members cm
  JOIN questlog_users u ON u.user_id=cm.user_id
  WHERE cm.conversation_id=? AND u.status='active'
  ORDER BY CASE WHEN cm.role='owner' THEN 0 ELSE 1 END, lower(COALESCE(u.display_name,u.primary_email,''))
 `).bind(conversationId).all();
 return(result.results||[]).map(row=>({...person(row),role:String(row.role||'member'),joinedAt:dbIso(row.joined_at)}));
}
async function membersForConversations(env,conversationIds=[]){
 const ids=[...new Set((conversationIds||[]).map(value=>clean(value,120)).filter(Boolean))];
 const grouped=new Map(ids.map(id=>[id,[]]));
 for(let offset=0;offset<ids.length;offset+=90){
  const chunk=ids.slice(offset,offset+90),placeholders=chunk.map(()=>'?').join(',');
  const result=await env.DB.prepare(\`
   SELECT cm.conversation_id,cm.user_id,cm.role,cm.joined_at,u.primary_email,u.display_name,u.avatar_data
   FROM questlog_conversation_members cm
   JOIN questlog_users u ON u.user_id=cm.user_id
   WHERE cm.conversation_id IN (\${placeholders}) AND u.status='active'
   ORDER BY cm.conversation_id,CASE WHEN cm.role='owner' THEN 0 ELSE 1 END,lower(COALESCE(u.display_name,u.primary_email,''))
  \`).bind(...chunk).all();
  for(const row of result.results||[]){
   const conversationId=String(row.conversation_id||'');
   if(!grouped.has(conversationId))grouped.set(conversationId,[]);
   grouped.get(conversationId).push({...person(row),role:String(row.role||'member'),joinedAt:dbIso(row.joined_at)});
  }
 }
 return grouped;
}
function reactionGroups(rows=[],current=''){
 const grouped=new Map();
 for(const row of rows){
  const messageId=String(row.message_id||''),emoji=String(row.emoji||'');
  if(!messageId||!emoji)continue;
  if(!grouped.has(messageId))grouped.set(messageId,new Map());
  const byEmoji=grouped.get(messageId);
  if(!byEmoji.has(emoji))byEmoji.set(emoji,{emoji,count:0,mine:false});
  const item=byEmoji.get(emoji);
  item.count+=1;
  if(String(row.user_id||'')===current)item.mine=true;
 }
 return Object.fromEntries([...grouped.entries()].map(([messageId,items])=>[
  messageId,[...items.values()].sort((a,b)=>b.count-a.count||a.emoji.localeCompare(b.emoji))
 ]));
}
async function reactionsForConversation(env,current,conversationId){
 const result=await env.DB.prepare(`
  SELECT r.message_id,r.user_id,r.emoji,r.created_at
  FROM questlog_message_reactions r
  JOIN questlog_messages m ON m.message_id=r.message_id
  WHERE r.conversation_id=? AND m.conversation_id=?
    AND m.message_id IN (
      SELECT message_id FROM questlog_messages
      WHERE conversation_id=?
      ORDER BY created_at DESC,message_id DESC
      LIMIT 200
    )
  ORDER BY r.created_at ASC
 `).bind(conversationId,conversationId,conversationId).all();
 return reactionGroups(result.results||[],current);
}
function publicConversation(row,current,members,last={}){
 const directOther=row.type==='direct'?members.find(member=>member.userId!==current):null;
 return{
  conversationId:String(row.conversation_id||''),
  type:String(row.type||'direct'),
  title:row.type==='direct'?(directOther?.displayName||directOther?.email||'Direct message'):(String(row.title||'Group')),
  avatarData:row.type==='direct'?(directOther?.avatarData||''):'',
  members,
  memberCount:members.length,
  role:String(row.role||'member'),
  createdBy:String(row.created_by||''),
  createdAt:dbIso(row.created_at),
  updatedAt:dbIso(row.updated_at),
  lastMessage:last.body||'',
  lastMessageAt:dbIso(last.created_at),
  lastSenderUserId:last.sender_user_id||'',
  unreadCount:Number(last.unread_count)||0
 };
}
export async function listConversations(env,identity){
 await ensureMessagingSchema(env);
 const current=accountId(identity);
 const result=await env.DB.prepare(\`
  SELECT c.*,cm.role,cm.joined_at,cm.last_read_at,
   (SELECT body FROM questlog_messages m WHERE m.conversation_id=c.conversation_id ORDER BY m.created_at DESC,m.message_id DESC LIMIT 1) AS last_body,
   (SELECT sender_user_id FROM questlog_messages m WHERE m.conversation_id=c.conversation_id ORDER BY m.created_at DESC,m.message_id DESC LIMIT 1) AS last_sender_user_id,
   (SELECT created_at FROM questlog_messages m WHERE m.conversation_id=c.conversation_id ORDER BY m.created_at DESC,m.message_id DESC LIMIT 1) AS last_message_at,
   (SELECT COUNT(*) FROM questlog_messages m WHERE m.conversation_id=c.conversation_id AND m.sender_user_id<>? AND (cm.last_read_at IS NULL OR m.created_at>cm.last_read_at)) AS unread_count
  FROM questlog_conversations c
  JOIN questlog_conversation_members cm ON cm.conversation_id=c.conversation_id
  WHERE cm.user_id=?
  ORDER BY COALESCE(last_message_at,c.updated_at) DESC
  LIMIT 100
 \`).bind(current,current).all();
 const rows=result.results||[];
 const membersByConversation=await membersForConversations(env,rows.map(row=>row.conversation_id));
 const conversations=rows.map(row=>publicConversation(
  row,
  current,
  membersByConversation.get(String(row.conversation_id||''))||[],
  {body:row.last_body,created_at:row.last_message_at,sender_user_id:row.last_sender_user_id,unread_count:row.unread_count}
 ));
 return{conversations,unreadCount:conversations.reduce((sum,item)=>sum+item.unreadCount,0)};
}
export async function createDirectConversation(env,identity,targetUserId){
 await ensureMessagingSchema(env);
 const current=accountId(identity),target=clean(targetUserId,120);
 if(!target||target===current)fail('Choose a friend to message.');
 await assertFriends(env,current,[target]);
 const directKey=pairKey(current,target);
 let row=await env.DB.prepare('SELECT * FROM questlog_conversations WHERE direct_key=? LIMIT 1').bind(directKey).first();
 if(!row){
  const conversationId=crypto.randomUUID();
  await env.DB.batch([
   env.DB.prepare("INSERT INTO questlog_conversations(conversation_id,type,title,direct_key,created_by,created_at) VALUES(?,'direct',NULL,?,?,datetime('now'))").bind(conversationId,directKey,current),
   env.DB.prepare("INSERT INTO questlog_conversation_members(conversation_id,user_id,role) VALUES(?,?,'owner')").bind(conversationId,current),
   env.DB.prepare("INSERT INTO questlog_conversation_members(conversation_id,user_id,role) VALUES(?,?,'member')").bind(conversationId,target)
  ]);
  row=await env.DB.prepare('SELECT * FROM questlog_conversations WHERE conversation_id=?').bind(conversationId).first();
 }
 const membership=await memberRow(env,current,row.conversation_id),members=await membersFor(env,row.conversation_id);
 return{conversation:publicConversation({...row,...membership},current,members,{})};
}
export async function createGroupConversation(env,identity,input={}){
 await ensureMessagingSchema(env);
 const current=accountId(identity),title=clean(input.title,100),targets=unique(input.memberUserIds).filter(id=>id!==current);
 if(!title)fail('Enter a group name.');
 if(!targets.length)fail('Choose at least one friend for the group.');
 await assertFriends(env,current,targets);
 const conversationId=crypto.randomUUID();
 const statements=[
  env.DB.prepare("INSERT INTO questlog_conversations(conversation_id,type,title,created_by,created_at) VALUES(?,'group',?,?,datetime('now'))").bind(conversationId,title,current),
  env.DB.prepare("INSERT INTO questlog_conversation_members(conversation_id,user_id,role) VALUES(?,?,'owner')").bind(conversationId,current)
 ];
 for(const target of targets)statements.push(env.DB.prepare("INSERT INTO questlog_conversation_members(conversation_id,user_id,role) VALUES(?,?,'member')").bind(conversationId,target));
 await env.DB.batch(statements);
 const row=await memberRow(env,current,conversationId),members=await membersFor(env,conversationId);
 return{conversation:publicConversation(row,current,members,{})};
}
export async function getConversation(env,identity,conversationId){
 const current=accountId(identity),row=await memberRow(env,current,conversationId),members=await membersFor(env,row.conversation_id);
 return{conversation:publicConversation(row,current,members,{})};
}
export async function addGroupMembers(env,identity,conversationId,userIds=[]){
 const current=accountId(identity),row=await memberRow(env,current,conversationId);
 if(row.type!=='group')fail('Only groups can add members.');
 if(row.role!=='owner')fail('Only the group creator can add members.',403);
 const targets=unique(userIds).filter(id=>id!==current);
 await assertFriends(env,current,targets);
 for(const target of targets)await env.DB.prepare("INSERT OR IGNORE INTO questlog_conversation_members(conversation_id,user_id,role) VALUES(?,?,'member')").bind(row.conversation_id,target).run();
 await env.DB.prepare("UPDATE questlog_conversations SET updated_at=datetime('now') WHERE conversation_id=?").bind(row.conversation_id).run();
 return getConversation(env,identity,row.conversation_id);
}
export async function listMessages(env,identity,conversationId,{after='',limit=120}={}){
 const current=accountId(identity),row=await memberRow(env,current,conversationId),bounded=Math.max(1,Math.min(200,Number(limit)||120));
 let result;
 if(after){
  result=await env.DB.prepare(`
   SELECT m.message_id,m.conversation_id,m.sender_user_id,m.body,m.created_at,m.edited_at,
          u.primary_email,u.display_name,u.avatar_data
   FROM questlog_messages m JOIN questlog_users u ON u.user_id=m.sender_user_id
   WHERE m.conversation_id=? AND m.created_at>=?
   ORDER BY m.created_at ASC,m.message_id ASC LIMIT ?
  `).bind(row.conversation_id,after,bounded).all();
 }else{
  result=await env.DB.prepare(`
   SELECT * FROM(
    SELECT m.message_id,m.conversation_id,m.sender_user_id,m.body,m.created_at,m.edited_at,
           u.primary_email,u.display_name,u.avatar_data
    FROM questlog_messages m JOIN questlog_users u ON u.user_id=m.sender_user_id
    WHERE m.conversation_id=?
    ORDER BY m.created_at DESC,m.message_id DESC LIMIT ?
   ) ORDER BY created_at ASC,message_id ASC
  `).bind(row.conversation_id,bounded).all();
 }
 const reactionMap=after?{}:await reactionsForConversation(env,current,row.conversation_id);
 const messages=(result.results||[]).map(message=>({
  messageId:String(message.message_id||''),conversationId:String(message.conversation_id||''),body:String(message.body||''),
  createdAt:dbIso(message.created_at),editedAt:dbIso(message.edited_at),sender:person(message),mine:String(message.sender_user_id||'')===current,
  reactions:reactionMap[String(message.message_id||'')]||[]
 }));
 await env.DB.prepare("UPDATE questlog_conversation_members SET last_read_at=datetime('now') WHERE conversation_id=? AND user_id=?").bind(row.conversation_id,current).run();
 return{messages};
}
export async function sendMessage(env,identity,conversationId,input={}){
 const current=accountId(identity),row=await memberRow(env,current,conversationId),message=clean(input.body,4000);
 if(!message)fail('Write a message first.');
 const messageId=crypto.randomUUID();
 await env.DB.batch([
  env.DB.prepare("INSERT INTO questlog_messages(message_id,conversation_id,sender_user_id,body) VALUES(?,?,?,?)").bind(messageId,row.conversation_id,current,message),
  env.DB.prepare("UPDATE questlog_conversations SET updated_at=datetime('now') WHERE conversation_id=?").bind(row.conversation_id),
  env.DB.prepare("UPDATE questlog_conversation_members SET last_read_at=datetime('now') WHERE conversation_id=? AND user_id=?").bind(row.conversation_id,current)
 ]);
 const stored=await env.DB.prepare('SELECT created_at FROM questlog_messages WHERE message_id=? LIMIT 1').bind(messageId).first();
 const user=await env.DB.prepare('SELECT user_id,primary_email,display_name,avatar_data FROM questlog_users WHERE user_id=?').bind(current).first();
 const members=await membersFor(env,row.conversation_id);
 return{
  message:{messageId,conversationId:row.conversation_id,body:message,createdAt:dbIso(stored?.created_at)||new Date().toISOString(),editedAt:null,sender:person(user||{}),mine:true,reactions:[]},
  recipients:members.filter(member=>member.userId!==current).map(member=>member.userId),
  conversation:{conversationId:row.conversation_id,type:row.type,title:row.title||'',members}
 };
}
export async function listMessageReactions(env,identity,conversationId){
 const current=accountId(identity),row=await memberRow(env,current,conversationId);
 return{reactions:await reactionsForConversation(env,current,row.conversation_id)};
}
export async function toggleMessageReaction(env,identity,conversationId,messageId,input={}){
 const current=accountId(identity),row=await memberRow(env,current,conversationId),id=clean(messageId,120),emoji=clean(input.emoji,16);
 if(!emoji)fail('Choose an emoji reaction.');
 const message=await env.DB.prepare('SELECT message_id FROM questlog_messages WHERE conversation_id=? AND message_id=? LIMIT 1').bind(row.conversation_id,id).first();
 if(!message)fail('Message not found.',404);
 const existing=await env.DB.prepare('SELECT emoji FROM questlog_message_reactions WHERE conversation_id=? AND message_id=? AND user_id=? LIMIT 1').bind(row.conversation_id,id,current).first();
 if(existing&&String(existing.emoji||'')===emoji){
  await env.DB.prepare('DELETE FROM questlog_message_reactions WHERE conversation_id=? AND message_id=? AND user_id=?').bind(row.conversation_id,id,current).run();
 }else{
  await env.DB.prepare(`
   INSERT INTO questlog_message_reactions(message_id,conversation_id,user_id,emoji,created_at)
   VALUES(?,?,?,?,datetime('now'))
   ON CONFLICT(message_id,user_id) DO UPDATE SET
    conversation_id=excluded.conversation_id,
    emoji=excluded.emoji,
    created_at=datetime('now')
  `).bind(id,row.conversation_id,current,emoji).run();
 }
 const reactions=await reactionsForConversation(env,current,row.conversation_id);
 return{messageId:id,reactions:reactions[id]||[]};
}

async function assertGroup(env,current,conversationId){
 const row=await memberRow(env,current,conversationId);
 if(row.type!=='group')fail('Shared calendars are available for groups only.',400);
 return row;
}
function groupCalendarColor(conversationId=''){
 const palette=['#7c3aed','#2563eb','#059669','#d97706','#dc2626','#db2777','#0891b2','#65a30d','#9333ea','#ea580c'];
 let hash=0;
 for(const char of String(conversationId||''))hash=((hash*31)+char.charCodeAt(0))>>>0;
 return palette[hash%palette.length];
}
function publicGroupEvent(row,current){
 const conversationId=String(row.conversation_id||'');
 return{
  eventId:String(row.event_id||''),conversationId,title:String(row.title||''),
  description:String(row.description||''),location:String(row.location||''),start:String(row.start_at||''),end:String(row.end_at||''),
  allDay:Boolean(row.all_day),createdBy:String(row.created_by||''),createdAt:dbIso(row.created_at),updatedAt:dbIso(row.updated_at),
  creator:{userId:String(row.creator_user_id||row.created_by||''),displayName:String(row.creator_display_name||''),avatarData:String(row.creator_avatar_data||'')},
  eventColor:groupCalendarColor(conversationId),
  canEdit:true,mine:String(row.created_by||'')===current
 };
}
export async function listGroupEvents(env,identity,conversationId,{from='',to=''}={}){
 const current=accountId(identity),row=await assertGroup(env,current,conversationId);
 let sql=`SELECT e.*,u.user_id AS creator_user_id,u.display_name AS creator_display_name,u.avatar_data AS creator_avatar_data
          FROM questlog_group_events e LEFT JOIN questlog_users u ON u.user_id=e.created_by
          WHERE e.conversation_id=?`,bind=[row.conversation_id];
 if(from&&validIso(from)){sql+=' AND e.end_at>=?';bind.push(from)}
 if(to&&validIso(to)){sql+=' AND e.start_at<?';bind.push(to)}
 sql+=' ORDER BY e.start_at ASC,e.event_id ASC LIMIT 500';
 const result=await env.DB.prepare(sql).bind(...bind).all();
 return{events:(result.results||[]).map(event=>publicGroupEvent(event,current))};
}
function eventPayload(input={}){
 const title=clean(input.title,160),description=clean(input.description,4000),location=clean(input.location,500),start=String(input.start||''),end=String(input.end||''),allDay=Boolean(input.allDay);
 if(!title)fail('Event title is required.');
 if(!validIso(start)||!validIso(end))fail('Valid start and end times are required.');
 if(new Date(end)<=new Date(start))fail('Event end must be after its start.');
 return{title,description,location,start,end,allDay};
}
export async function listUserGroupEvents(env,identity,{from='',to=''}={}){
 await ensureMessagingSchema(env);
 const current=accountId(identity);
 let sql=`
  SELECT e.*,c.title AS conversation_title,
         u.user_id AS creator_user_id,u.display_name AS creator_display_name,u.avatar_data AS creator_avatar_data
  FROM questlog_group_events e
  JOIN questlog_conversations c ON c.conversation_id=e.conversation_id AND c.type='group'
  JOIN questlog_conversation_members cm ON cm.conversation_id=e.conversation_id AND cm.user_id=?
  LEFT JOIN questlog_users u ON u.user_id=e.created_by
  WHERE 1=1
 `,bind=[current];
 if(from&&validIso(from)){sql+=' AND e.end_at>=?';bind.push(from)}
 if(to&&validIso(to)){sql+=' AND e.start_at<?';bind.push(to)}
 sql+=' ORDER BY e.start_at ASC,e.event_id ASC LIMIT 1000';
 const result=await env.DB.prepare(sql).bind(...bind).all();
 return(result.results||[]).map(row=>{
  const event=publicGroupEvent(row,current),groupTitle=String(row.conversation_title||'Group');
  return{
   id:event.eventId,
   eventId:event.eventId,
   title:event.title,
   description:event.description,
   location:event.location,
   start:event.start,
   end:event.end,
   allDay:event.allDay,
   accountId:'questlog-groups',
   accountLabel:'Quest Log',
   calendarId:'group:'+event.conversationId,
   calendarName:'Group · '+groupTitle,
   calendarColor:event.eventColor,
   eventColor:event.eventColor,
   accessRole:'writer',
   groupEvent:true,
   groupConversationId:event.conversationId,
   groupTitle,
   createdBy:event.createdBy,
   creator:event.creator,
   canEdit:true,
   mine:event.mine
  };
 });
}

export async function createGroupEvent(env,identity,conversationId,input={}){
 const current=accountId(identity),row=await assertGroup(env,current,conversationId),event=eventPayload(input),eventId=crypto.randomUUID();
 await env.DB.batch([
  env.DB.prepare("INSERT INTO questlog_group_events(event_id,conversation_id,title,description,location,start_at,end_at,all_day,created_by) VALUES(?,?,?,?,?,?,?,?,?)").bind(eventId,row.conversation_id,event.title,event.description,event.location,event.start,event.end,event.allDay?1:0,current),
  env.DB.prepare("UPDATE questlog_conversations SET updated_at=datetime('now') WHERE conversation_id=?").bind(row.conversation_id)
 ]);
 return{event:{eventId,conversationId:row.conversation_id,...event,createdBy:current,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),canEdit:true,mine:true}};
}
export async function updateGroupEvent(env,identity,conversationId,eventId,input={}){
 const current=accountId(identity),row=await assertGroup(env,current,conversationId),id=clean(eventId,120),event=eventPayload(input);
 const existing=await env.DB.prepare('SELECT event_id FROM questlog_group_events WHERE conversation_id=? AND event_id=?').bind(row.conversation_id,id).first();
 if(!existing)fail('Group event not found.',404);
 await env.DB.prepare("UPDATE questlog_group_events SET title=?,description=?,location=?,start_at=?,end_at=?,all_day=?,updated_at=datetime('now') WHERE conversation_id=? AND event_id=?").bind(event.title,event.description,event.location,event.start,event.end,event.allDay?1:0,row.conversation_id,id).run();
 const result=await listGroupEvents(env,identity,row.conversation_id,{});
 return{event:result.events.find(item=>item.eventId===id)};
}
export async function deleteGroupEvent(env,identity,conversationId,eventId){
 const current=accountId(identity),row=await assertGroup(env,current,conversationId),id=clean(eventId,120);
 const result=await env.DB.prepare('DELETE FROM questlog_group_events WHERE conversation_id=? AND event_id=?').bind(row.conversation_id,id).run();
 if(!result.meta?.changes)fail('Group event not found.',404);
 return{ok:true};
}
