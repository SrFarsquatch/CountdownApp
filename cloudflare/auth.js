const enc=new TextEncoder();
const dec=new TextDecoder();
const SESSION_COOKIE='questlog_session';
const SESSION_DAYS=30;
const PBKDF2_ITERATIONS=100000;
const AUTH_WINDOW_SECONDS=15*60;
const AUTH_MAX_ATTEMPTS=12;

function clean(value,max=500){return String(value||'').trim().slice(0,max)}
function emailValue(value){return clean(value,320).toLowerCase()}
function b64u(bytes){let raw='';for(const byte of bytes)raw+=String.fromCharCode(byte);return btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
function fromB64u(value){const input=String(value||'').replace(/-/g,'+').replace(/_/g,'/');const raw=atob(input+'='.repeat((4-input.length%4)%4));return Uint8Array.from(raw,c=>c.charCodeAt(0))}
function randomToken(bytes=32){return b64u(crypto.getRandomValues(new Uint8Array(bytes)))}
async function sha256Bytes(value){return new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(String(value||''))))}
async function sha256Hex(value){return Array.from(await sha256Bytes(value),b=>b.toString(16).padStart(2,'0')).join('')}
async function hmacHex(secret,value){
 const key=await crypto.subtle.importKey('raw',enc.encode(String(secret||'')),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(String(value||'')))),b=>b.toString(16).padStart(2,'0')).join('');
}
function cookieValue(request,name){
 const raw=request.headers.get('cookie')||'';
 for(const part of raw.split(';')){
  const [key,...rest]=part.trim().split('=');
  if(key===name)return decodeURIComponent(rest.join('='));
 }
 return'';
}
function sessionCookie(token,request,maxAge=SESSION_DAYS*86400){
 const secure=new URL(request.url).protocol==='https:'?'; Secure':'';
 return SESSION_COOKIE+'='+encodeURIComponent(token)+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+maxAge+secure;
}
function clearSessionCookie(request){return sessionCookie('',request,0)}
function validEmail(email){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)&&email.length<=320}
function envFlag(value,defaultValue=false){
 const normalized=String(value??'').trim().toLowerCase();
 if(['1','true','yes','y','on'].includes(normalized))return true;
 if(['0','false','no','n','off'].includes(normalized))return false;
 return defaultValue;
}
function enforceAllowedEmails(env){return envFlag(env.ENFORCE_ALLOWED_EMAILS,false)}
function allowedEmails(env){
 return [...new Set(String(env.ALLOWED_EMAILS||'').split(/[;,\n]/).map(emailValue).filter(Boolean))];
}
function assertAllowedEmail(env,email){
 if(!enforceAllowedEmails(env))return;
 const list=allowedEmails(env);
 if(!list.length){
  const e=new Error('Email allowlist enforcement is enabled but ALLOWED_EMAILS is empty.');
  e.status=503;
  throw e;
 }
 if(list.includes(emailValue(email)))return;
 const e=new Error('This account is not permitted to access Quest Log.');
 e.status=403;
 throw e;
}
function validatePassword(password){
 const value=String(password||'');
 if(value.length<10)return'Use at least 10 characters.';
 if(value.length>200)return'Password is too long.';
 return'';
}
async function passwordHash(password,salt,iterations=PBKDF2_ITERATIONS){
 const key=await crypto.subtle.importKey('raw',enc.encode(String(password||'')),'PBKDF2',false,['deriveBits']);
 const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations,hash:'SHA-256'},key,256);
 return new Uint8Array(bits);
}
function timingSafeBytes(a,b){
 if(a.length!==b.length)return false;
 let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;
}
async function ensureColumn(db,table,name,definition){
 const info=await db.prepare('PRAGMA table_info('+table+')').all();
 if(!(info.results||[]).some(row=>row.name===name))await db.prepare('ALTER TABLE '+table+' ADD COLUMN '+name+' '+definition).run();
}
export async function ensureAuthSchema(env){
 if(!env.DB)throw new Error('Cloudflare D1 binding DB is not configured.');
 await env.DB.prepare(`
  CREATE TABLE IF NOT EXISTS questlog_users(
   user_id TEXT PRIMARY KEY,
   primary_email TEXT,
   created_at TEXT NOT NULL DEFAULT (datetime('now')),
   updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
 `).run();
 await ensureColumn(env.DB,'questlog_users','display_name','TEXT');
 await ensureColumn(env.DB,'questlog_users','avatar_data','TEXT');
 await ensureColumn(env.DB,'questlog_users','password_hash','TEXT');
 await ensureColumn(env.DB,'questlog_users','password_salt','TEXT');
 await ensureColumn(env.DB,'questlog_users','password_iterations','INTEGER');
 await ensureColumn(env.DB,'questlog_users','status',"TEXT NOT NULL DEFAULT 'active'");
 await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_questlog_users_email ON questlog_users(lower(primary_email)) WHERE primary_email IS NOT NULL').run();
 await env.DB.prepare(`
  CREATE TABLE IF NOT EXISTS questlog_sessions(
   session_hash TEXT PRIMARY KEY,
   user_id TEXT NOT NULL,
   created_at TEXT NOT NULL DEFAULT (datetime('now')),
   expires_at TEXT NOT NULL,
   last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
   user_agent TEXT,
   ip_hash TEXT
  )
 `).run();
 await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_questlog_sessions_user ON questlog_sessions(user_id)').run();
 await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_questlog_sessions_expiry ON questlog_sessions(expires_at)').run();
 await env.DB.prepare(`
  CREATE TABLE IF NOT EXISTS questlog_auth_attempts(
   attempt_key TEXT PRIMARY KEY,
   window_started_at INTEGER NOT NULL,
   attempts INTEGER NOT NULL DEFAULT 0
  )
 `).run();
}
async function attemptKey(request,env,email,kind){
 const ip=request.headers.get('cf-connecting-ip')||'unknown';
 return hmacHex(env.APP_SECRET||'questlog-auth',kind+'|'+ip+'|'+email);
}
async function checkRateLimit(request,env,email,kind){
 await ensureAuthSchema(env);
 const key=await attemptKey(request,env,email,kind),now=Math.floor(Date.now()/1000);
 const row=await env.DB.prepare('SELECT window_started_at,attempts FROM questlog_auth_attempts WHERE attempt_key=?').bind(key).first();
 if(!row||now-Number(row.window_started_at)>AUTH_WINDOW_SECONDS){
  await env.DB.prepare('INSERT INTO questlog_auth_attempts(attempt_key,window_started_at,attempts) VALUES(?,?,1) ON CONFLICT(attempt_key) DO UPDATE SET window_started_at=excluded.window_started_at,attempts=1').bind(key,now).run();
  return;
 }
 if(Number(row.attempts)>=AUTH_MAX_ATTEMPTS){const e=new Error('Too many attempts. Try again later.');e.status=429;throw e}
 await env.DB.prepare('UPDATE questlog_auth_attempts SET attempts=attempts+1 WHERE attempt_key=?').bind(key).run();
}
async function clearRateLimit(request,env,email,kind){
 const key=await attemptKey(request,env,email,kind);
 await env.DB.prepare('DELETE FROM questlog_auth_attempts WHERE attempt_key=?').bind(key).run().catch(()=>{});
}
async function verifyTurnstile(request,env,token){
 if(!env.TURNSTILE_SECRET_KEY)return true;
 const form=new FormData();form.set('secret',env.TURNSTILE_SECRET_KEY);form.set('response',clean(token,4000));
 const ip=request.headers.get('cf-connecting-ip');if(ip)form.set('remoteip',ip);
 const response=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',body:form});
 const result=await response.json().catch(()=>({success:false}));
 if(!result.success){const e=new Error('Human verification failed. Please try again.');e.status=400;throw e}
 return true;
}
async function nativeChallengeSignature(env,issued,nonce){
 if(!env.APP_SECRET)throw new Error('APP_SECRET is required for native authentication.');
 return hmacHex(env.APP_SECRET,'native-auth|'+issued+'|'+nonce);
}
export async function createNativeAuthChallenge(request,env,payload={}){
 await verifyTurnstile(request,env,payload.turnstileToken);
 const nonce=clean(payload.nonce,160);
 if(!nonce){const e=new Error('Native challenge nonce is required.');e.status=400;throw e}
 const issued=Date.now().toString(36),signature=await nativeChallengeSignature(env,issued,nonce);
 return{token:['nat1',issued,nonce,signature].join('.'),expiresInSeconds:300};
}
async function verifyNativeAuthChallenge(env,value){
 try{
  const [version,issued,nonce,signature]=String(value||'').split('.');
  if(version!=='nat1'||!issued||!nonce||!signature)return false;
  const timestamp=parseInt(issued,36),age=Date.now()-timestamp;
  if(!Number.isFinite(timestamp)||age<0||age>5*60*1000)return false;
  const expected=await nativeChallengeSignature(env,issued,nonce);
  if(expected.length!==signature.length)return false;
  let diff=0;for(let i=0;i<expected.length;i++)diff|=expected.charCodeAt(i)^signature.charCodeAt(i);
  return diff===0;
 }catch{return false}
}
async function verifyHumanChallenge(request,env,payload={}){
 if(!env.TURNSTILE_SECRET_KEY)return true;
 if(payload.nativeChallengeToken){
  if(await verifyNativeAuthChallenge(env,payload.nativeChallengeToken))return true;
  const e=new Error('Native human verification expired. Please try again.');e.status=400;throw e
 }
 return verifyTurnstile(request,env,payload.turnstileToken);
}
async function createSession(request,env,user){
 const token=randomToken(32),hash=await sha256Hex(token),expires=new Date(Date.now()+SESSION_DAYS*86400000).toISOString();
 const ip=request.headers.get('cf-connecting-ip')||'';
 const ipHash=ip?await hmacHex(env.APP_SECRET||'questlog-auth','session|'+ip):'';
 await env.DB.prepare(`
  INSERT INTO questlog_sessions(session_hash,user_id,created_at,expires_at,last_seen_at,user_agent,ip_hash)
  VALUES(?,?,datetime('now'),?,datetime('now'),?,?)
 `).bind(hash,user.user_id,expires,clean(request.headers.get('user-agent'),500),ipHash).run();
 return{token,expires};
}
function publicUser(row){return{userId:row.user_id,email:row.primary_email||'',displayName:row.display_name||'',avatarData:row.avatar_data||'',createdAt:row.created_at||null}}
export async function nativeSession(request,env){
 await ensureAuthSchema(env);
 const token=cookieValue(request,SESSION_COOKIE);if(!token)return null;
 const hash=await sha256Hex(token);
 const row=await env.DB.prepare(`
  SELECT u.user_id,u.primary_email,u.display_name,u.avatar_data,u.created_at,u.status,s.expires_at
  FROM questlog_sessions s JOIN questlog_users u ON u.user_id=s.user_id
  WHERE s.session_hash=?
 `).bind(hash).first();
 if(!row||row.status==='disabled'||new Date(row.expires_at).getTime()<=Date.now()){
  if(row)await env.DB.prepare('DELETE FROM questlog_sessions WHERE session_hash=?').bind(hash).run().catch(()=>{});
  return null;
 }
 try{assertAllowedEmail(env,row.primary_email)}
 catch{
  await env.DB.prepare('DELETE FROM questlog_sessions WHERE session_hash=?').bind(hash).run().catch(()=>{});
  return null;
 }
 env.DB.prepare("UPDATE questlog_sessions SET last_seen_at=datetime('now') WHERE session_hash=?").bind(hash).run().catch(()=>{});
 return{userId:row.user_id,email:row.primary_email||'',sub:row.user_id,provider:'questlog',user:publicUser(row)};
}
export async function signup(request,env,payload={}){
 await ensureAuthSchema(env);
 if(String(env.ALLOW_SIGNUPS||'true').toLowerCase()==='false'){const e=new Error('Account creation is currently closed.');e.status=403;throw e}
 const email=emailValue(payload.email),password=String(payload.password||''),displayName=clean(payload.displayName,120);
 if(!validEmail(email)){const e=new Error('Enter a valid email address.');e.status=400;throw e}
 assertAllowedEmail(env,email);
 const passwordError=validatePassword(password);if(passwordError){const e=new Error(passwordError);e.status=400;throw e}
 await checkRateLimit(request,env,email,'signup');
 await verifyHumanChallenge(request,env,payload);
 let user=await env.DB.prepare('SELECT * FROM questlog_users WHERE lower(primary_email)=?').bind(email).first();
 if(user?.password_hash){const e=new Error('An account already exists for that email.');e.status=409;throw e}
 if(user&&!payload.legacyVerified){const e=new Error('This email is reserved for an existing Quest Log identity. Complete the owner migration before removing Cloudflare Access.');e.status=409;throw e}
 const salt=crypto.getRandomValues(new Uint8Array(16)),hash=await passwordHash(password,salt),userId=user?.user_id||crypto.randomUUID();
 if(user){
  await env.DB.prepare(`
   UPDATE questlog_users SET primary_email=?,display_name=?,password_hash=?,password_salt=?,password_iterations=?,status='active',updated_at=datetime('now')
   WHERE user_id=?
  `).bind(email,displayName,b64u(hash),b64u(salt),PBKDF2_ITERATIONS,userId).run();
 }else{
  await env.DB.prepare(`
   INSERT INTO questlog_users(user_id,primary_email,display_name,password_hash,password_salt,password_iterations,status,created_at,updated_at)
   VALUES(?,?,?,?,?,?,'active',datetime('now'),datetime('now'))
  `).bind(userId,email,displayName,b64u(hash),b64u(salt),PBKDF2_ITERATIONS).run();
 }
 await clearRateLimit(request,env,email,'signup');
 const legacyOwner=emailValue(env.LEGACY_OWNER_EMAIL);
 if(legacyOwner&&legacyOwner===email&&payload.legacyVerified){
  const target='user:'+userId;
  const existing=await env.DB.prepare('SELECT workspace_id FROM questlog_state WHERE workspace_id=?').bind(target).first().catch(()=>null);
  const legacy=await env.DB.prepare("SELECT state_json FROM questlog_state WHERE workspace_id='default'").first().catch(()=>null);
  if(!existing&&legacy?.state_json){
   await env.DB.prepare("INSERT INTO questlog_state(workspace_id,state_json,schema_version,created_at,updated_at) VALUES(?,?,1,datetime('now'),datetime('now'))").bind(target,legacy.state_json).run();
  }
 }
 user=await env.DB.prepare('SELECT * FROM questlog_users WHERE user_id=?').bind(userId).first();
 const session=await createSession(request,env,user);
 return{user:publicUser(user),session};
}
export async function login(request,env,payload={}){
 await ensureAuthSchema(env);
 const email=emailValue(payload.email),password=String(payload.password||'');
 if(!validEmail(email)||!password){const e=new Error('Email and password are required.');e.status=400;throw e}
 assertAllowedEmail(env,email);
 await checkRateLimit(request,env,email,'login');
 await verifyHumanChallenge(request,env,payload);
 const user=await env.DB.prepare('SELECT * FROM questlog_users WHERE lower(primary_email)=?').bind(email).first();
 let valid=false;
 if(user?.password_hash&&user?.password_salt&&user.status!=='disabled'){
  const actual=await passwordHash(password,fromB64u(user.password_salt),Number(user.password_iterations)||PBKDF2_ITERATIONS);
  valid=timingSafeBytes(actual,fromB64u(user.password_hash));
 }else{
  const fakeSalt=await sha256Bytes('questlog-missing-user:'+email);
  await passwordHash(password,fakeSalt.slice(0,16),PBKDF2_ITERATIONS);
 }
 if(!valid){const e=new Error('Email or password is incorrect.');e.status=401;throw e}
 await clearRateLimit(request,env,email,'login');
 const session=await createSession(request,env,user);
 return{user:publicUser(user),session};
}
function normalizeAvatarData(value){
 const raw=String(value||'').trim();
 if(!raw)return'';
 if(raw.length>400000){const e=new Error('Profile image is too large.');e.status=413;throw e}
 if(!/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(raw)){const e=new Error('Profile image format is not supported.');e.status=400;throw e}
 return raw;
}
export async function updateProfile(env,identity,payload={}){
 await ensureAuthSchema(env);
 const userId=clean(identity?.userId,120);
 if(!userId){const e=new Error('Quest Log account is required.');e.status=401;throw e}
 const displayName=clean(payload.displayName,120);
 const avatarData=normalizeAvatarData(payload.avatarData);
 await env.DB.prepare("UPDATE questlog_users SET display_name=?,avatar_data=?,updated_at=datetime('now') WHERE user_id=?")
  .bind(displayName,avatarData||null,userId).run();
 const user=await env.DB.prepare('SELECT * FROM questlog_users WHERE user_id=?').bind(userId).first();
 if(!user){const e=new Error('Account was not found.');e.status=404;throw e}
 return publicUser(user);
}

export async function logout(request,env){
 await ensureAuthSchema(env);
 const token=cookieValue(request,SESSION_COOKIE);
 if(token)await env.DB.prepare('DELETE FROM questlog_sessions WHERE session_hash=?').bind(await sha256Hex(token)).run().catch(()=>{});
 return{ok:true};
}
export function authCookie(session,request){return sessionCookie(session.token,request)}
export function expiredAuthCookie(request){return clearSessionCookie(request)}
export function authPublicConfig(env){
 return{signupsEnabled:String(env.ALLOW_SIGNUPS||'true').toLowerCase()!=='false',turnstileEnabled:Boolean(env.TURNSTILE_SITE_KEY&&env.TURNSTILE_SECRET_KEY),turnstileSiteKey:env.TURNSTILE_SITE_KEY||''};
}
