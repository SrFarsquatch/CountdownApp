function clean(value,max=500){return String(value||'').trim().slice(0,max)}
async function ensureUserSchema(env){
  if(!env.DB)throw new Error('Cloudflare D1 binding DB is not configured.');
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS questlog_users (
      user_id TEXT PRIMARY KEY,
      primary_email TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS questlog_user_identities (
      provider TEXT NOT NULL,
      subject TEXT NOT NULL,
      user_id TEXT NOT NULL,
      email TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (provider, subject)
    )
  `).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_questlog_user_identities_user ON questlog_user_identities(user_id)').run();
}
function identityDescriptor(identity={}){
  const email=clean(identity.email,320).toLowerCase();
  if(identity.bypass)return{provider:'development',subject:clean(identity.sub||email||'local-dev',500),email};
  const subject=clean(identity.sub||email,500);
  if(!subject)throw new Error('Authenticated user identity is missing a stable subject.');
  return{provider:'cloudflare_access',subject,email};
}
export async function resolveQuestLogUser(env,identity={}){
  await ensureUserSchema(env);
  if(identity?.userId){
    const userId=clean(identity.userId,120);
    const email=clean(identity.email,320).toLowerCase();
    if(!userId)throw new Error('Quest Log user ID is required.');
    await env.DB.prepare("INSERT INTO questlog_users(user_id,primary_email,created_at,updated_at) VALUES(?,?,datetime('now'),datetime('now')) ON CONFLICT(user_id) DO UPDATE SET primary_email=COALESCE(excluded.primary_email,questlog_users.primary_email),updated_at=datetime('now')").bind(userId,email||null).run();
    return{userId,email,provider:identity.provider||'questlog'};
  }
  const descriptor=identityDescriptor(identity);
  let row=await env.DB.prepare(
    'SELECT user_id,email FROM questlog_user_identities WHERE provider=? AND subject=?'
  ).bind(descriptor.provider,descriptor.subject).first();
  if(row?.user_id){
    if(descriptor.email&&descriptor.email!==row.email){
      await env.DB.batch([
        env.DB.prepare('UPDATE questlog_user_identities SET email=?,updated_at=datetime(\'now\') WHERE provider=? AND subject=?')
          .bind(descriptor.email,descriptor.provider,descriptor.subject),
        env.DB.prepare('UPDATE questlog_users SET primary_email=?,updated_at=datetime(\'now\') WHERE user_id=?')
          .bind(descriptor.email,row.user_id)
      ]);
    }
    return{userId:row.user_id,email:descriptor.email||row.email||'',provider:descriptor.provider};
  }
  const userId=crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO questlog_users(user_id,primary_email,created_at,updated_at) VALUES(?,?,datetime(\'now\'),datetime(\'now\'))')
      .bind(userId,descriptor.email||null),
    env.DB.prepare('INSERT INTO questlog_user_identities(provider,subject,user_id,email,created_at,updated_at) VALUES(?,?,?,?,datetime(\'now\'),datetime(\'now\'))')
      .bind(descriptor.provider,descriptor.subject,userId,descriptor.email||null)
  ]);
  return{userId,email:descriptor.email,provider:descriptor.provider};
}
