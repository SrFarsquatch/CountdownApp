function clean(value,max=500){return String(value||'').trim().slice(0,max)}
function emailValue(value){return clean(value,320).toLowerCase()}
function userId(identity){
 const value=clean(identity?.userId,120);
 if(!value){const e=new Error('Quest Log account is required.');e.status=401;throw e}
 return value;
}
function pair(a,b){return String(a)<String(b)?[String(a),String(b)]:[String(b),String(a)]}
async function ensureFriendsSchema(env){
 if(!env.DB)throw new Error('Cloudflare D1 binding DB is not configured.');
 await env.DB.prepare(`
  CREATE TABLE IF NOT EXISTS questlog_friendships(
   friendship_id TEXT PRIMARY KEY,
   user_low TEXT NOT NULL,
   user_high TEXT NOT NULL,
   requested_by TEXT NOT NULL,
   status TEXT NOT NULL DEFAULT 'pending',
   created_at TEXT NOT NULL DEFAULT (datetime('now')),
   updated_at TEXT NOT NULL DEFAULT (datetime('now')),
   accepted_at TEXT,
   UNIQUE(user_low,user_high)
  )
 `).run();
 await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_questlog_friendships_low ON questlog_friendships(user_low,status)').run();
 await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_questlog_friendships_high ON questlog_friendships(user_high,status)').run();
}
function publicPerson(row){
 return{
  friendshipId:String(row.friendship_id||''),
  userId:String(row.other_user_id||''),
  email:String(row.primary_email||''),
  displayName:String(row.display_name||''),
  avatarData:String(row.avatar_data||''),
  createdAt:row.created_at||null,
  updatedAt:row.updated_at||null,
  acceptedAt:row.accepted_at||null
 };
}
export async function listFriends(env,identity){
 await ensureFriendsSchema(env);
 const current=userId(identity);
 const result=await env.DB.prepare(`
  SELECT f.friendship_id,f.user_low,f.user_high,f.requested_by,f.status,f.created_at,f.updated_at,f.accepted_at,
         u.user_id AS other_user_id,u.primary_email,u.display_name,u.avatar_data
  FROM questlog_friendships f
  JOIN questlog_users u
    ON u.user_id=CASE WHEN f.user_low=? THEN f.user_high ELSE f.user_low END
  WHERE f.user_low=? OR f.user_high=?
  ORDER BY lower(COALESCE(u.display_name,u.primary_email,'')),f.updated_at DESC
 `).bind(current,current,current).all();
 const friends=[],incoming=[],outgoing=[];
 for(const row of result.results||[]){
  const person=publicPerson(row);
  if(row.status==='accepted')friends.push(person);
  else if(row.status==='pending'&&row.requested_by===current)outgoing.push(person);
  else if(row.status==='pending')incoming.push(person);
 }
 return{friends,incoming,outgoing};
}
export async function requestFriend(env,identity,email){
 await ensureFriendsSchema(env);
 const current=userId(identity),targetEmail=emailValue(email);
 if(!targetEmail){const e=new Error('Enter the email address for a Quest Log account.');e.status=400;throw e}
 const target=await env.DB.prepare("SELECT user_id,primary_email,display_name,status FROM questlog_users WHERE lower(primary_email)=? LIMIT 1").bind(targetEmail).first();
 if(!target?.user_id||String(target.status||'active')!=='active'){const e=new Error('No active Quest Log account was found for that email.');e.status=404;throw e}
 if(target.user_id===current){const e=new Error('You cannot add your own account as a friend.');e.status=400;throw e}
 const [low,high]=pair(current,target.user_id);
 const existing=await env.DB.prepare('SELECT * FROM questlog_friendships WHERE user_low=? AND user_high=?').bind(low,high).first();
 if(existing){
  if(existing.status==='accepted'){const e=new Error('You are already friends.');e.status=409;throw e}
  if(existing.status==='pending'&&existing.requested_by===current){const e=new Error('Friend request already sent.');e.status=409;throw e}
  if(existing.status==='pending'){const e=new Error('This person already sent you a friend request.');e.status=409;throw e}
 }
 const friendshipId=crypto.randomUUID();
 await env.DB.prepare(`
  INSERT INTO questlog_friendships(friendship_id,user_low,user_high,requested_by,status,created_at,updated_at)
  VALUES(?,?,?,?,'pending',datetime('now'),datetime('now'))
 `).bind(friendshipId,low,high,current).run();
 return{ok:true,friendshipId};
}
export async function respondFriend(env,identity,friendshipId,action){
 await ensureFriendsSchema(env);
 const current=userId(identity),id=clean(friendshipId,120),decision=clean(action,20).toLowerCase();
 if(!id||!['accept','decline'].includes(decision)){const e=new Error('Invalid friend request action.');e.status=400;throw e}
 const row=await env.DB.prepare('SELECT * FROM questlog_friendships WHERE friendship_id=? AND (user_low=? OR user_high=?)').bind(id,current,current).first();
 if(!row){const e=new Error('Friend request not found.');e.status=404;throw e}
 if(row.status!=='pending'){const e=new Error('This friend request is no longer pending.');e.status=409;throw e}
 if(row.requested_by===current){const e=new Error('You cannot respond to your own outgoing friend request.');e.status=403;throw e}
 if(decision==='decline'){
  await env.DB.prepare('DELETE FROM questlog_friendships WHERE friendship_id=?').bind(id).run();
  return{ok:true,status:'declined'};
 }
 await env.DB.prepare("UPDATE questlog_friendships SET status='accepted',accepted_at=datetime('now'),updated_at=datetime('now') WHERE friendship_id=?").bind(id).run();
 return{ok:true,status:'accepted'};
}
export async function removeFriend(env,identity,friendshipId){
 await ensureFriendsSchema(env);
 const current=userId(identity),id=clean(friendshipId,120);
 if(!id){const e=new Error('Friendship is required.');e.status=400;throw e}
 const row=await env.DB.prepare('SELECT * FROM questlog_friendships WHERE friendship_id=? AND (user_low=? OR user_high=?)').bind(id,current,current).first();
 if(!row){const e=new Error('Friendship not found.');e.status=404;throw e}
 if(row.status==='pending'&&row.requested_by!==current){const e=new Error('Accept or decline this incoming friend request instead.');e.status=409;throw e}
 await env.DB.prepare('DELETE FROM questlog_friendships WHERE friendship_id=?').bind(id).run();
 return{ok:true};
}


export async function getSocialProfile(env,identity,targetUserId=''){
 await ensureFriendsSchema(env);
 const current=userId(identity),target=clean(targetUserId||current,120),isSelf=target===current;
 if(!target){const e=new Error('Profile user is required.');e.status=400;throw e}
 let friendshipId='',isFriend=false;
 if(!isSelf){
  const [low,high]=pair(current,target);
  const relation=await env.DB.prepare("SELECT friendship_id,status FROM questlog_friendships WHERE user_low=? AND user_high=? LIMIT 1").bind(low,high).first();
  if(!relation||relation.status!=='accepted'){const e=new Error('This profile is only available to friends.');e.status=403;throw e}
  friendshipId=String(relation.friendship_id||'');isFriend=true;
 }
 const row=await env.DB.prepare("SELECT user_id,primary_email,display_name,avatar_data,bio,profile_visibility,created_at,status FROM questlog_users WHERE user_id=? LIMIT 1").bind(target).first();
 if(!row||String(row.status||'active')!=='active'){const e=new Error('Profile not found.');e.status=404;throw e}
 const visibility=['friends','private'].includes(String(row.profile_visibility||''))?String(row.profile_visibility):'friends';
 if(!isSelf&&visibility==='private'){const e=new Error('This profile is private.');e.status=403;throw e}
 const countRow=await env.DB.prepare("SELECT COUNT(*) AS count FROM questlog_friendships WHERE status='accepted' AND (user_low=? OR user_high=?)").bind(target,target).first();
 return{
  userId:String(row.user_id||''),
  displayName:String(row.display_name||''),
  avatarData:String(row.avatar_data||''),
  bio:String(row.bio||''),
  createdAt:row.created_at||null,
  profileVisibility:visibility,
  friendCount:Number(countRow?.count)||0,
  isSelf,
  isFriend,
  friendshipId
 };
}
