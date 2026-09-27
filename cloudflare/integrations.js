import { applyActivityToChallenges } from './challenges.js';
const clean=(value,max=500)=>String(value==null?'':value).trim().slice(0,max);
const number=(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback;
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const uuid=()=>crypto.randomUUID();

const PROVIDERS=Object.freeze([
  {id:'apple_health',name:'Apple Health',category:'health',phase:1,mode:'native',platform:'ios',description:'Workouts, steps, distance and activity summaries from HealthKit.',capabilities:['workouts','steps','distance','activity'],env:[]},
  {id:'health_connect',name:'Health Connect',category:'health',phase:1,mode:'native',platform:'android',description:'Android health gateway for workouts, steps, sleep and activity records.',capabilities:['workouts','steps','distance','sleep','activity'],env:[]},
  {id:'strava',name:'Strava',category:'fitness',phase:1,mode:'oauth',description:'Runs, rides, hikes and athlete activities.',capabilities:['workouts','distance','webhooks'],env:['STRAVA_CLIENT_ID','STRAVA_CLIENT_SECRET']},
  {id:'google_calendar',name:'Google Calendar',category:'productivity',phase:1,mode:'existing',description:'Calendar events and planned focus blocks already used by Quest Log.',capabilities:['calendar','events'],env:['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET']},
  {id:'google_tasks',name:'Google Tasks',category:'productivity',phase:1,mode:'existing',description:'Task completion events from connected Google accounts.',capabilities:['tasks'],env:['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET']},
  {id:'questlog_focus',name:'Quest Log Focus',category:'focus',phase:1,mode:'builtin',description:'Built-in focus sessions that earn verified Quest Log XP.',capabilities:['focus'],env:[]},
  {id:'github',name:'GitHub',category:'development',phase:1,mode:'oauth',description:'Issues, pull requests, commits and releases for developer quests.',capabilities:['issues','pull_requests','releases'],env:['GITHUB_CLIENT_ID','GITHUB_CLIENT_SECRET']},

  {id:'todoist',name:'Todoist',category:'productivity',phase:2,mode:'oauth',description:'Tasks, projects and completion events.',capabilities:['tasks','projects','webhooks'],env:['TODOIST_CLIENT_ID','TODOIST_CLIENT_SECRET']},
  {id:'microsoft_todo',name:'Microsoft To Do',category:'productivity',phase:2,mode:'oauth',description:'Personal tasks and lists through Microsoft Graph.',capabilities:['tasks','lists'],env:['MICROSOFT_CLIENT_ID','MICROSOFT_CLIENT_SECRET']},
  {id:'microsoft_planner',name:'Microsoft Planner',category:'productivity',phase:2,mode:'oauth',description:'Team plans and assigned work through Microsoft Graph.',capabilities:['tasks','plans'],env:['MICROSOFT_CLIENT_ID','MICROSOFT_CLIENT_SECRET']},
  {id:'fitbit',name:'Fitbit',category:'health',phase:2,mode:'oauth',description:'Steps, activity minutes, workouts and supported sleep summaries.',capabilities:['workouts','steps','activity','sleep'],env:['FITBIT_CLIENT_ID','FITBIT_CLIENT_SECRET']},
  {id:'whoop',name:'WHOOP',category:'health',phase:2,mode:'oauth',description:'Workout, strain, recovery and sleep summaries.',capabilities:['workouts','recovery','sleep'],env:['WHOOP_CLIENT_ID','WHOOP_CLIENT_SECRET']},
  {id:'oura',name:'Oura',category:'health',phase:2,mode:'oauth',description:'Activity, sleep and readiness summaries.',capabilities:['activity','sleep','readiness'],env:['OURA_CLIENT_ID','OURA_CLIENT_SECRET']},

  {id:'garmin',name:'Garmin Connect',category:'health',phase:3,mode:'partner',description:'Garmin activities and wellness summaries once partner access is approved.',capabilities:['workouts','steps','sleep','activity'],env:['GARMIN_CLIENT_ID','GARMIN_CLIENT_SECRET']},
  {id:'samsung_health',name:'Samsung Health',category:'health',phase:3,mode:'native',platform:'android',description:'Galaxy device activity through the native Samsung health bridge.',capabilities:['workouts','steps','sleep'],env:[]},
  {id:'jira',name:'Jira',category:'productivity',phase:3,mode:'oauth',description:'Issues, sprint work and project completion events.',capabilities:['issues','projects'],env:['JIRA_CLIENT_ID','JIRA_CLIENT_SECRET']},
  {id:'browser_companion',name:'Browser Companion',category:'focus',phase:3,mode:'companion',description:'Optional browser companion for Quest Log focus sessions and distraction controls.',capabilities:['focus','browser'],env:[]}
]);

const PROVIDER_MAP=new Map(PROVIDERS.map(provider=>[provider.id,provider]));
const CATEGORIES=new Set(['fitness','health','productivity','focus','development','wellbeing']);
const VISIBILITY=new Set(['private','friends','party','public']);

function userId(identity){
  const value=clean(identity?.userId,120);
  if(!value){const error=new Error('Quest Log account is required.');error.status=401;throw error}
  return value;
}
function configured(provider,env){
  if(provider.mode==='builtin')return true;
  if(provider.mode==='native'||provider.mode==='companion')return false;
  return (provider.env||[]).length>0&&(provider.env||[]).every(key=>Boolean(String(env?.[key]||'').trim()));
}
function providerPublic(provider,env,preference){
  const isConfigured=configured(provider,env);
  return{
    id:provider.id,
    name:provider.name,
    category:provider.category,
    phase:provider.phase,
    mode:provider.mode,
    platform:provider.platform||'',
    description:provider.description,
    capabilities:[...provider.capabilities],
    configured:isConfigured,
    setupState:provider.mode==='builtin'?'active':provider.mode==='native'?'native_bridge':provider.mode==='companion'?'companion_build':isConfigured?'ready':'needs_credentials',
    preference:preference||defaultPreference(provider.id)
  };
}
function defaultPreference(providerId){
  return{
    providerId,
    earnXp:true,
    challengeEligible:true,
    visibility:'private',
    enabled:providerId==='questlog_focus',
    settings:{}
  };
}
function safeSettings(value){
  const source=value&&typeof value==='object'?value:{};
  const allowed=['workouts','steps','sleep','activity','tasks','events','pullRequests','issues','releases','focus','autoShareMilestones'];
  const output={};
  for(const key of allowed)if(key in source)output[key]=Boolean(source[key]);
  return output;
}
function safeMetrics(value){
  const source=value&&typeof value==='object'?value:{};
  const output={};
  const numeric=['durationMinutes','distanceMeters','steps','count','value'];
  for(const key of numeric)if(key in source)output[key]=clamp(number(source[key],0),0,100000000);
  for(const key of ['unit','activity','action','difficulty'])if(key in source)output[key]=clean(source[key],80);
  return output;
}
function normalizeOccurredAt(value){
  const date=value?new Date(value):new Date();
  if(Number.isNaN(date.getTime()))return new Date().toISOString();
  const futureLimit=Date.now()+5*60*1000;
  if(date.getTime()>futureLimit)return new Date().toISOString();
  return date.toISOString();
}
function xpFor(eventType,metrics={}){
  const minutes=clamp(number(metrics.durationMinutes,0),0,720);
  const steps=clamp(number(metrics.steps,0),0,100000);
  const count=clamp(number(metrics.count,1),0,1000);
  if(eventType==='focus.session.completed')return minutes<5?0:clamp(10+Math.floor(minutes/15)*5,10,80);
  if(eventType==='fitness.workout.completed'||eventType==='health.workout.completed')return clamp(20+Math.floor(minutes/10)*5,20,100);
  if(eventType==='fitness.steps.recorded'||eventType==='health.steps.recorded')return steps>=10000?35:steps>=7500?25:steps>=5000?15:0;
  if(eventType==='productivity.task.completed')return clamp(10*count,10,50);
  if(eventType==='productivity.event.completed')return 15;
  if(eventType==='development.issue.closed')return clamp(15*count,15,60);
  if(eventType==='development.pull_request.merged')return clamp(35*count,35,100);
  if(eventType==='development.release.published')return 75;
  return 10;
}
function levelInfo(totalXp){
  const total=Math.max(0,Math.floor(number(totalXp,0)));
  let level=1,spent=0,nextCost=100;
  while(total>=spent+nextCost&&level<200){spent+=nextCost;level+=1;nextCost=level*100}
  return{level,totalXp:total,levelXp:Math.max(0,total-spent),nextLevelXp:nextCost,progress:nextCost?Math.min(1,Math.max(0,(total-spent)/nextCost)):1};
}
function parseJson(value,fallback={}){
  try{return JSON.parse(value||'')}catch{return fallback}
}
async function ensureSchema(env){
  if(!env.DB)throw new Error('Cloudflare D1 binding DB is not configured.');
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS questlog_integration_preferences(
      user_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      earn_xp INTEGER NOT NULL DEFAULT 1,
      challenge_eligible INTEGER NOT NULL DEFAULT 1,
      visibility TEXT NOT NULL DEFAULT 'private',
      enabled INTEGER NOT NULL DEFAULT 0,
      settings_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(user_id,provider_id)
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS questlog_progress_events(
      event_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      occurred_at TEXT NOT NULL,
      metrics_json TEXT NOT NULL DEFAULT '{}',
      verification TEXT NOT NULL DEFAULT 'provider',
      visibility TEXT NOT NULL DEFAULT 'private',
      xp_awarded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id,provider_id,source_event_id)
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS questlog_progress_profiles(
      user_id TEXT PRIMARY KEY,
      total_xp INTEGER NOT NULL DEFAULT 0,
      fitness_xp INTEGER NOT NULL DEFAULT 0,
      health_xp INTEGER NOT NULL DEFAULT 0,
      productivity_xp INTEGER NOT NULL DEFAULT 0,
      focus_xp INTEGER NOT NULL DEFAULT 0,
      development_xp INTEGER NOT NULL DEFAULT 0,
      wellbeing_xp INTEGER NOT NULL DEFAULT 0,
      current_streak INTEGER NOT NULL DEFAULT 0,
      best_streak INTEGER NOT NULL DEFAULT 0,
      last_active_date TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_progress_events_user_date ON questlog_progress_events(user_id,occurred_at DESC)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_progress_events_user_category ON questlog_progress_events(user_id,category,occurred_at DESC)').run();
}
async function preferencesFor(env,identity){
  await ensureSchema(env);
  const uid=userId(identity);
  const rows=await env.DB.prepare('SELECT * FROM questlog_integration_preferences WHERE user_id=?').bind(uid).all();
  const map=new Map();
  for(const row of rows.results||[]){
    map.set(String(row.provider_id||''),{
      providerId:String(row.provider_id||''),
      earnXp:Boolean(row.earn_xp),
      challengeEligible:Boolean(row.challenge_eligible),
      visibility:VISIBILITY.has(row.visibility)?row.visibility:'private',
      enabled:Boolean(row.enabled),
      settings:parseJson(row.settings_json,{})
    });
  }
  return map;
}
function profilePublic(row){
  const base={
    totalXp:Number(row?.total_xp)||0,
    fitnessXp:Number(row?.fitness_xp)||0,
    healthXp:Number(row?.health_xp)||0,
    productivityXp:Number(row?.productivity_xp)||0,
    focusXp:Number(row?.focus_xp)||0,
    developmentXp:Number(row?.development_xp)||0,
    wellbeingXp:Number(row?.wellbeing_xp)||0,
    currentStreak:Number(row?.current_streak)||0,
    bestStreak:Number(row?.best_streak)||0,
    lastActiveDate:row?.last_active_date||null
  };
  return{...base,...levelInfo(base.totalXp)};
}
function eventPublic(row){
  return{
    eventId:String(row.event_id||''),
    providerId:String(row.provider_id||''),
    sourceEventId:String(row.source_event_id||''),
    eventType:String(row.event_type||''),
    category:String(row.category||''),
    title:String(row.title||''),
    occurredAt:row.occurred_at||null,
    metrics:safeMetrics(parseJson(row.metrics_json,{})),
    verification:String(row.verification||'provider'),
    visibility:VISIBILITY.has(row.visibility)?row.visibility:'private',
    xpAwarded:Number(row.xp_awarded)||0
  };
}
export async function integrationDashboard(env,identity){
  await ensureSchema(env);
  const uid=userId(identity),prefs=await preferencesFor(env,identity);
  const [profileRow,recentRows,weeklyRow]=await Promise.all([
    env.DB.prepare('SELECT * FROM questlog_progress_profiles WHERE user_id=?').bind(uid).first(),
    env.DB.prepare('SELECT * FROM questlog_progress_events WHERE user_id=? ORDER BY occurred_at DESC LIMIT 20').bind(uid).all(),
    env.DB.prepare("SELECT COALESCE(SUM(xp_awarded),0) AS xp FROM questlog_progress_events WHERE user_id=? AND occurred_at>=datetime('now','-7 day')").bind(uid).first()
  ]);
  return{
    providers:PROVIDERS.map(provider=>providerPublic(provider,env,prefs.get(provider.id))),
    progress:{...profilePublic(profileRow),weeklyXp:Number(weeklyRow?.xp)||0},
    recentActivity:(recentRows.results||[]).map(eventPublic),
    privacy:{defaultVisibility:'private',rawHealthDataShared:false}
  };
}
export async function saveIntegrationPreference(env,identity,input={}){
  await ensureSchema(env);
  const uid=userId(identity),providerId=clean(input.providerId,80),provider=PROVIDER_MAP.get(providerId);
  if(!provider){const error=new Error('Unknown integration provider.');error.status=400;throw error}
  const current=defaultPreference(providerId);
  const earnXp=input.earnXp===undefined?current.earnXp:Boolean(input.earnXp);
  const challengeEligible=input.challengeEligible===undefined?current.challengeEligible:Boolean(input.challengeEligible);
  const visibility=VISIBILITY.has(input.visibility)?input.visibility:'private';
  const enabled=input.enabled===undefined?current.enabled:Boolean(input.enabled);
  const settings=safeSettings(input.settings);
  await env.DB.prepare(`
    INSERT INTO questlog_integration_preferences(user_id,provider_id,earn_xp,challenge_eligible,visibility,enabled,settings_json,updated_at)
    VALUES(?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(user_id,provider_id) DO UPDATE SET
      earn_xp=excluded.earn_xp,
      challenge_eligible=excluded.challenge_eligible,
      visibility=excluded.visibility,
      enabled=excluded.enabled,
      settings_json=excluded.settings_json,
      updated_at=datetime('now')
  `).bind(uid,providerId,earnXp?1:0,challengeEligible?1:0,visibility,enabled?1:0,JSON.stringify(settings)).run();
  return{ok:true,preference:{providerId,earnXp,challengeEligible,visibility,enabled,settings}};
}
async function updateProgress(env,uid,category,xp,occurredAt){
  const existing=await env.DB.prepare('SELECT * FROM questlog_progress_profiles WHERE user_id=?').bind(uid).first();
  const date=occurredAt.slice(0,10),last=existing?.last_active_date||null;
  let current=Number(existing?.current_streak)||0,best=Number(existing?.best_streak)||0;
  if(!last){current=1}
  else if(last!==date){
    const delta=Math.round((Date.parse(date+'T00:00:00Z')-Date.parse(last+'T00:00:00Z'))/86400000);
    current=delta===1?current+1:1;
  }
  best=Math.max(best,current);
  const columns={fitness:'fitness_xp',health:'health_xp',productivity:'productivity_xp',focus:'focus_xp',development:'development_xp',wellbeing:'wellbeing_xp'};
  const column=columns[category]||'productivity_xp';
  await env.DB.prepare(`
    INSERT INTO questlog_progress_profiles(user_id,total_xp,${column},current_streak,best_streak,last_active_date,updated_at)
    VALUES(?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      total_xp=questlog_progress_profiles.total_xp+excluded.total_xp,
      ${column}=questlog_progress_profiles.${column}+excluded.${column},
      current_streak=excluded.current_streak,
      best_streak=MAX(questlog_progress_profiles.best_streak,excluded.best_streak),
      last_active_date=excluded.last_active_date,
      updated_at=datetime('now')
  `).bind(uid,xp,xp,current,best,date).run();
}
export async function recordNormalizedActivity(env,identity,input={}){
  await ensureSchema(env);
  const uid=userId(identity),providerId=clean(input.providerId,80),provider=PROVIDER_MAP.get(providerId);
  if(!provider){const error=new Error('Unknown integration provider.');error.status=400;throw error}
  const sourceEventId=clean(input.sourceEventId,180)||uuid();
  const eventType=clean(input.eventType,120);
  if(!eventType){const error=new Error('Activity event type is required.');error.status=400;throw error}
  const metrics=safeMetrics(input.metrics),category=CATEGORIES.has(input.category)?input.category:(provider.category==='fitness'?'fitness':provider.category==='development'?'development':provider.category==='focus'?'focus':provider.category==='health'?'health':'productivity');
  const occurredAt=normalizeOccurredAt(input.occurredAt),title=clean(input.title||provider.name+' activity',140);
  const prefs=await preferencesFor(env,identity),pref=prefs.get(providerId)||defaultPreference(providerId);
  const xp=pref.earnXp?xpFor(eventType,metrics):0;
  const verification=provider.mode==='builtin'?'questlog':clean(input.verification||'provider',40);
  const eventId=uuid();
  const result=await env.DB.prepare(`
    INSERT OR IGNORE INTO questlog_progress_events(
      event_id,user_id,provider_id,source_event_id,event_type,category,title,occurred_at,metrics_json,verification,visibility,xp_awarded,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
  `).bind(eventId,uid,providerId,sourceEventId,eventType,category,title,occurredAt,JSON.stringify(metrics),verification,pref.visibility,xp).run();
  const inserted=Number(result?.meta?.changes||0)>0;
  if(inserted&&xp>0)await updateProgress(env,uid,category,xp,occurredAt);
  const row=await env.DB.prepare('SELECT * FROM questlog_progress_events WHERE user_id=? AND provider_id=? AND source_event_id=?').bind(uid,providerId,sourceEventId).first();
  const profile=await env.DB.prepare('SELECT * FROM questlog_progress_profiles WHERE user_id=?').bind(uid).first();
  const publicEvent=eventPublic(row||{});
  const challengeUpdates=inserted&&pref.challengeEligible?await applyActivityToChallenges(env,identity,publicEvent):[];
  return{ok:true,duplicate:!inserted,event:publicEvent,progress:profilePublic(profile),challengeUpdates};
}
export async function recordFirstPartyActivity(env,identity,input={}){
  const providerId=clean(input.providerId,80);
  if(!new Set(['questlog_focus']).has(providerId)){const error=new Error('This endpoint only accepts first-party Quest Log activities.');error.status=403;throw error}
  return recordNormalizedActivity(env,identity,{...input,providerId,verification:'questlog'});
}
export async function recordNativeActivity(env,identity,input={}){
  const providerId=clean(input.providerId,80);
  if(!new Set(['apple_health','health_connect','samsung_health']).has(providerId)){const error=new Error('Unsupported native health provider.');error.status=400;throw error}
  return recordNormalizedActivity(env,identity,{...input,providerId,verification:'device'});
}
