const clean=(value,max=500)=>String(value==null?'':value).trim().slice(0,max);
const num=(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback;
const uid=identity=>{
  const value=clean(identity?.userId,120);
  if(!value){const e=new Error('Quest Log account is required.');e.status=401;throw e}
  return value;
};
const json=v=>{try{return JSON.parse(v||'')}catch{return{}}};
const ruleSafe=input=>{
  const source=input&&typeof input==='object'?input:{};
  const metric=['count','durationMinutes','distanceMeters','steps','value'].includes(source.metric)?source.metric:'count';
  const mode=source.mode==='sum'?'sum':'count';
  return{
    eventType:clean(source.eventType,120),
    metric,
    mode,
    target:Math.max(1,num(source.target,1))
  };
};
async function ensureSchema(env){
  if(!env.DB)throw new Error('Cloudflare D1 binding DB is not configured.');
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS questlog_challenges(
      challenge_id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      rule_json TEXT NOT NULL,
      starts_at TEXT,
      ends_at TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS questlog_challenge_participants(
      challenge_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      progress REAL NOT NULL DEFAULT 0,
      completed_at TEXT,
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(challenge_id,user_id)
    )
  `).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_challenge_participant_user ON questlog_challenge_participants(user_id,joined_at DESC)').run();
}
function publicChallenge(row,participant){
  const rule=ruleSafe(json(row.rule_json));
  return{
    challengeId:String(row.challenge_id||''),
    ownerUserId:String(row.owner_user_id||''),
    title:String(row.title||''),
    description:String(row.description||''),
    rule,
    startsAt:row.starts_at||null,
    endsAt:row.ends_at||null,
    status:String(row.status||'active'),
    progress:Number(participant?.progress)||0,
    completedAt:participant?.completed_at||null,
    joinedAt:participant?.joined_at||null,
    complete:(Number(participant?.progress)||0)>=rule.target
  };
}
export async function createChallenge(env,identity,input={}){
  await ensureSchema(env);
  const userId=uid(identity),title=clean(input.title||'Challenge',120),description=clean(input.description,500),rule=ruleSafe(input.rule);
  if(!rule.eventType){const e=new Error('Challenge event type is required.');e.status=400;throw e}
  const challengeId=crypto.randomUUID(),startsAt=input.startsAt?new Date(input.startsAt).toISOString():null,endsAt=input.endsAt?new Date(input.endsAt).toISOString():null;
  await env.DB.prepare('INSERT INTO questlog_challenges(challenge_id,owner_user_id,title,description,rule_json,starts_at,ends_at,status) VALUES(?,?,?,?,?,?,?,?)')
    .bind(challengeId,userId,title,description,JSON.stringify(rule),startsAt,endsAt,'active').run();
  await env.DB.prepare('INSERT INTO questlog_challenge_participants(challenge_id,user_id,progress) VALUES(?,?,0)').bind(challengeId,userId).run();
  const row=await env.DB.prepare('SELECT * FROM questlog_challenges WHERE challenge_id=?').bind(challengeId).first();
  const part=await env.DB.prepare('SELECT * FROM questlog_challenge_participants WHERE challenge_id=? AND user_id=?').bind(challengeId,userId).first();
  return publicChallenge(row,part);
}
export async function listChallenges(env,identity){
  await ensureSchema(env);
  const userId=uid(identity);
  const rows=await env.DB.prepare(`
    SELECT c.*,p.progress,p.completed_at,p.joined_at
    FROM questlog_challenges c
    JOIN questlog_challenge_participants p ON p.challenge_id=c.challenge_id
    WHERE p.user_id=?
    ORDER BY CASE WHEN c.status='active' THEN 0 ELSE 1 END,c.created_at DESC
    LIMIT 100
  `).bind(userId).all();
  return{challenges:(rows.results||[]).map(row=>publicChallenge(row,row))};
}
export async function joinChallenge(env,identity,challengeId){
  await ensureSchema(env);
  const userId=uid(identity),id=clean(challengeId,120);
  const row=await env.DB.prepare('SELECT * FROM questlog_challenges WHERE challenge_id=?').bind(id).first();
  if(!row){const e=new Error('Challenge not found.');e.status=404;throw e}
  await env.DB.prepare('INSERT OR IGNORE INTO questlog_challenge_participants(challenge_id,user_id,progress) VALUES(?,?,0)').bind(id,userId).run();
  const part=await env.DB.prepare('SELECT * FROM questlog_challenge_participants WHERE challenge_id=? AND user_id=?').bind(id,userId).first();
  return publicChallenge(row,part);
}
export async function applyActivityToChallenges(env,identity,event){
  await ensureSchema(env);
  const userId=uid(identity),eventType=clean(event?.eventType,120),metrics=event?.metrics&&typeof event.metrics==='object'?event.metrics:{},occurredAt=event?.occurredAt?new Date(event.occurredAt):new Date();
  if(!eventType)return[];
  const rows=await env.DB.prepare(`
    SELECT c.*,p.progress,p.completed_at,p.joined_at
    FROM questlog_challenges c
    JOIN questlog_challenge_participants p ON p.challenge_id=c.challenge_id
    WHERE p.user_id=? AND c.status='active' AND p.completed_at IS NULL
  `).bind(userId).all();
  const updates=[];
  for(const row of rows.results||[]){
    const rule=ruleSafe(json(row.rule_json));
    if(rule.eventType!==eventType)continue;
    if(row.starts_at&&occurredAt<new Date(row.starts_at))continue;
    if(row.ends_at&&occurredAt>new Date(row.ends_at))continue;
    const increment=rule.mode==='count'?1:Math.max(0,num(metrics[rule.metric],rule.metric==='count'?1:0));
    if(increment<=0)continue;
    const next=Math.min(rule.target,Math.max(0,num(row.progress,0)+increment)),complete=next>=rule.target;
    await env.DB.prepare('UPDATE questlog_challenge_participants SET progress=?,completed_at=CASE WHEN ?=1 THEN COALESCE(completed_at,datetime(\'now\')) ELSE completed_at END WHERE challenge_id=? AND user_id=?')
      .bind(next,complete?1:0,row.challenge_id,userId).run();
    updates.push({challengeId:String(row.challenge_id),title:String(row.title||''),progress:next,target:rule.target,completed:complete});
  }
  return updates;
}
