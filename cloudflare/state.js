const COLORS=['black','red','blue','green','yellow','purple'];
const PROGRESS_MODES=['time','manual','none'];
const PROGRESS_STYLES=['solid','segmented','thin'];
const DATE_STYLES=['short','medium','long','numeric'];
const TIME_STYLES=['days','compact','full','precise','weeks','date'];
const TASK_STATUS=['todo','progress','done'];
const TASK_PRIORITY=['low','medium','high','urgent'];
const GOAL_TYPES=['number','checklist','deadline'];
const GOAL_STATUS=['active','complete','paused'];
export const APPEARANCE_MODES=['system','light','dark'];
export const UI_THEMES=['classic','quest','moss','ember','arcane','slate'];
export const UI_DENSITIES=['comfortable','compact'];
export const DISPLAY_MODES=['dashboard','daily','weekly','monthly','countdowns'];
export const DISPLAY_KEYS=['agenda','weather','tasks','goals','countdowns','markets'];
export const WEATHER_UNITS=['metric','imperial'];
export const LAYOUTS=['auto','landscape','portrait'];
export const PALETTES=['spectra6','mono'];
export const DATE_WIDGETS=['flipper','plain'];
export const WEATHER_STYLES=['compact','current','forecast'];
export const AGENT_PROVIDERS=['openai','anthropic','gemini','openrouter','groq','mistral','deepseek','xai','local'];

export const num=(v,f=0)=>Number.isFinite(Number(v))?Number(v):f;
export const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
export const en=(v,a,f)=>a.includes(v)?v:f;
export const cleanText=(v,max=500)=>String(v||'').trim().slice(0,max);
export const iso=v=>{if(!v)return null;const d=new Date(v);return Number.isNaN(d.getTime())?null:d.toISOString()};
export const id=()=>Date.now().toString(36)+crypto.randomUUID().replaceAll('-','').slice(0,8);

export function normalizeNotifications(x={}){
  const subs=Array.isArray(x.subscriptions)?x.subscriptions.map(item=>({
    endpoint:cleanText(item?.endpoint,2000),
    keys:{p256dh:cleanText(item?.keys?.p256dh,500),auth:cleanText(item?.keys?.auth,500)},
    userAgent:cleanText(item?.userAgent,300),
    createdAt:iso(item?.createdAt)||new Date().toISOString(),
    lastSeen:iso(item?.lastSeen)||new Date().toISOString()
  })).filter(item=>item.endpoint&&item.keys.p256dh&&item.keys.auth).slice(0,20):[];
  return{
    enabled:Boolean(x.enabled),
    taskReminders:x.taskReminders!==false,
    eventReminders:x.eventReminders!==false,
    goalReminders:x.goalReminders!==false,
    countdownReminders:x.countdownReminders!==false,
    taskLeadMinutes:clamp(Math.round(num(x.taskLeadMinutes,30)),1,10080),
    eventLeadMinutes:clamp(Math.round(num(x.eventLeadMinutes,15)),1,1440),
    goalLeadMinutes:clamp(Math.round(num(x.goalLeadMinutes,1440)),15,43200),
    countdownLeadMinutes:clamp(Math.round(num(x.countdownLeadMinutes,1440)),15,43200),
    subscriptions:subs,
    sent:x.sent&&typeof x.sent==='object'?x.sent:{}
  };
}

function defaultLayout(mode='dashboard'){
  if(mode==='daily'||mode==='weekly')return{agenda:{x:0,y:0,w:16,h:16},weather:{x:16,y:0,w:8,h:4},tasks:{x:16,y:4,w:8,h:4},goals:{x:16,y:8,w:8,h:4},countdowns:{x:16,y:12,w:8,h:4},markets:{x:16,y:12,w:8,h:4}};
  if(mode==='monthly')return{agenda:{x:0,y:0,w:18,h:16},weather:{x:18,y:0,w:6,h:4},tasks:{x:18,y:4,w:6,h:4},goals:{x:18,y:8,w:6,h:4},countdowns:{x:18,y:12,w:6,h:4},markets:{x:18,y:12,w:6,h:4}};
  if(mode==='countdowns')return{agenda:{x:0,y:0,w:12,h:8},weather:{x:12,y:0,w:12,h:4},tasks:{x:12,y:4,w:12,h:4},goals:{x:0,y:8,w:12,h:8},countdowns:{x:0,y:0,w:24,h:16},markets:{x:12,y:8,w:12,h:8}};
  return{agenda:{x:0,y:0,w:14,h:8},weather:{x:14,y:0,w:10,h:4},tasks:{x:14,y:4,w:10,h:4},goals:{x:0,y:8,w:8,h:8},countdowns:{x:8,y:8,w:8,h:8},markets:{x:16,y:8,w:8,h:8}};
}
export function normalizeSectionLayout(input,mode='dashboard'){
  const base=defaultLayout(mode),source=input&&typeof input==='object'?input:{},out={};
  for(const key of DISPLAY_KEYS){
    const raw=source[key]&&typeof source[key]==='object'?source[key]:base[key];
    const w=clamp(Math.round(num(raw.w,base[key].w)),2,24),h=clamp(Math.round(num(raw.h,base[key].h)),1,16);
    out[key]={x:clamp(Math.round(num(raw.x,base[key].x)),0,24-w),y:clamp(Math.round(num(raw.y,base[key].y)),0,16-h),w,h};
  }
  return out;
}
function defaultSections(mode='dashboard'){
  const countdownOnly=mode==='countdowns';
  return{
    agenda:{enabled:!countdownOnly,style:mode==='daily'?'timeline':mode==='weekly'?'week':mode==='monthly'?'calendar':'list',scope:mode==='daily'?'today':mode==='weekly'?'week':mode==='monthly'?'month':'upcoming',limit:mode==='weekly'?14:mode==='monthly'?20:12},
    weather:{enabled:!countdownOnly,style:'forecast',limit:5},
    tasks:{enabled:!countdownOnly,style:'checklist',limit:4},
    goals:{enabled:!countdownOnly,style:'bars',limit:2},
    countdowns:{enabled:true,style:'detailed',limit:countdownOnly?8:3},
    markets:{enabled:mode==='dashboard',style:'summary',limit:4}
  };
}
export function normalizeSectionOrder(input){
  const seen=new Set(),out=[];
  for(const key of Array.isArray(input)?input.map(String):[])if(DISPLAY_KEYS.includes(key)&&!seen.has(key)){seen.add(key);out.push(key)}
  for(const key of DISPLAY_KEYS)if(!seen.has(key))out.push(key);
  return out;
}
export function normalizeModeLayouts(input,legacy){
  const source=input&&typeof input==='object'?input:{},out={};
  for(const mode of DISPLAY_MODES)out[mode]=normalizeSectionLayout(source[mode]||(mode==='dashboard'?legacy:null)||defaultLayout(mode),mode);
  return out;
}
export function normalizeModeSections(input){
  const source=input&&typeof input==='object'?input:{},out={};
  for(const mode of DISPLAY_MODES)out[mode]={...defaultSections(mode),...(source[mode]||{})};
  return out;
}
export function normalizeCountdown(x={}){
  const created=iso(x.created)||new Date().toISOString();
  return{id:String(x.id||id()),name:cleanText(x.name||'Countdown',100),end:iso(x.end)||new Date(Date.now()+86400000).toISOString(),created,accentColor:en(x.accentColor,COLORS,'black'),progressMode:en(x.progressMode,PROGRESS_MODES,'time'),progressStyle:en(x.progressStyle,PROGRESS_STYLES,'solid'),progressStart:iso(x.progressStart)||created,progressCurrent:num(x.progressCurrent,0),progressTotal:Math.max(0,num(x.progressTotal,100)),dateDisplayStyle:en(x.dateDisplayStyle,DATE_STYLES,'medium'),timeDisplayStyle:en(x.timeDisplayStyle,TIME_STYLES,'days'),showExactDate:x.showExactDate!==false,showProgressBar:x.showProgressBar!==false,displayEnabled:x.displayEnabled!==false,pinned:Boolean(x.pinned),goalId:x.goalId?String(x.goalId):''};
}
const normalizeSubtask=x=>({id:String(x?.id||id()),title:cleanText(x?.title||'Subtask',140),done:Boolean(x?.done)});
export function normalizeTask(x={}){
  const created=iso(x.created)||new Date().toISOString(),status=en(x.status,TASK_STATUS,'todo');
  return{id:String(x.id||id()),title:cleanText(x.title||'Task',160),description:cleanText(x.description,2000),status,priority:en(x.priority,TASK_PRIORITY,'medium'),due:iso(x.due),start:iso(x.start),estimatedMinutes:clamp(num(x.estimatedMinutes,0),0,100000),project:cleanText(x.project,80),goalId:x.goalId?String(x.goalId):'',tags:Array.isArray(x.tags)?x.tags.map(v=>cleanText(v,40)).filter(Boolean).slice(0,12):[],subtasks:Array.isArray(x.subtasks)?x.subtasks.map(normalizeSubtask).slice(0,50):[],created,updated:iso(x.updated)||created,completedAt:status==='done'?(iso(x.completedAt)||new Date().toISOString()):null,displayEnabled:x.displayEnabled!==false,googleAccountId:x.googleAccountId?String(x.googleAccountId):'',googleTaskListId:x.googleTaskListId?String(x.googleTaskListId):'',googleTaskListTitle:cleanText(x.googleTaskListTitle,160),googleTaskId:x.googleTaskId?String(x.googleTaskId):'',googleParentId:x.googleParentId?String(x.googleParentId):'',googleUpdated:iso(x.googleUpdated),googleEtag:cleanText(x.googleEtag,500)};
}
export function normalizeGoal(x={}){
  const created=iso(x.created)||new Date().toISOString();
  return{id:String(x.id||id()),title:cleanText(x.title||'Goal',160),description:cleanText(x.description,2000),type:en(x.type,GOAL_TYPES,'number'),current:num(x.current,0),target:Math.max(0,num(x.target,100)),unit:cleanText(x.unit,30),deadline:iso(x.deadline),project:cleanText(x.project,80),status:en(x.status,GOAL_STATUS,'active'),accentColor:en(x.accentColor,COLORS,'purple'),checklist:Array.isArray(x.checklist)?x.checklist.map(normalizeSubtask).slice(0,100):[],created,updated:iso(x.updated)||new Date().toISOString(),displayEnabled:x.displayEnabled!==false};
}
export function normalizeWeather(x={}){
  const lat=x.latitude===''||x.latitude==null?null:Number(x.latitude),lon=x.longitude===''||x.longitude==null?null:Number(x.longitude);
  return{latitude:Number.isFinite(lat)&&lat>=-90&&lat<=90?lat:null,longitude:Number.isFinite(lon)&&lon>=-180&&lon<=180?lon:null,locationLabel:cleanText(x.locationLabel,100),countryCode:cleanText(x.countryCode,8).toUpperCase(),units:en(x.units,WEATHER_UNITS,'metric')};
}
export const normalizeAppearance=x=>({mode:en(x?.mode,APPEARANCE_MODES,'system'),theme:en(x?.theme,UI_THEMES,'quest'),density:en(x?.density,UI_DENSITIES,'comfortable')});
export function normalizeMarkets(x={}){
  const raw=Array.isArray(x.watchlist)?x.watchlist:['SPY','QQQ'];
  const seen=new Set(),watchlist=[];
  for(const item of raw){
    const src=typeof item==='string'?{symbol:item}:item||{},providerSymbol=cleanText(src.providerSymbol||src.symbol,32).toUpperCase();
    if(!providerSymbol||seen.has(providerSymbol))continue;
    seen.add(providerSymbol);
    watchlist.push({symbol:cleanText(src.symbol||providerSymbol,32).toUpperCase(),providerSymbol,name:cleanText(src.name,120),exchange:cleanText(src.exchange,80),region:cleanText(src.region,80),type:cleanText(src.type,60),currency:cleanText(src.currency,12).toUpperCase(),marketOpen:cleanText(src.marketOpen,20),marketClose:cleanText(src.marketClose,20),timezone:cleanText(src.timezone,60),matchScore:cleanText(src.matchScore,20)});
    if(watchlist.length>=8)break;
  }
  return{watchlist,refreshMinutes:clamp(Math.round(num(x.refreshMinutes,1440)),240,1440)};
}
export function normalizeGoogleAccount(x={}){
  const selectedTaskListIds=Array.isArray(x.selectedTaskListIds)?x.selectedTaskListIds.map(String).slice(0,50):[];
  return{id:String(x.id||id()),googleId:cleanText(x.googleId,240),label:cleanText(x.label||x.googleId||'Google account',160),token:typeof x.token==='string'?x.token:null,selectedCalendarIds:Array.isArray(x.selectedCalendarIds)?x.selectedCalendarIds.map(String).slice(0,50):[],selectedTaskListIds,defaultTaskListId:selectedTaskListIds.includes(String(x.defaultTaskListId||''))?String(x.defaultTaskListId):selectedTaskListIds[0]||'',connectedAt:iso(x.connectedAt)||new Date().toISOString()};
}
function normalizeDisplay(x={}){
  const base={token:crypto.randomUUID().replaceAll('-')+crypto.randomUUID().replaceAll('-').slice(0,16),title:'Today',maxEvents:5,maxCountdowns:3,maxTasks:6,maxGoals:3,layout:'auto',palette:'spectra6',dateWidgetStyle:'plain',mode:'daily',plannerLayoutVersion:5,sectionLayoutMode:'custom',sectionLayout:defaultLayout('dashboard'),sectionOrder:[...DISPLAY_KEYS],weatherStyle:'forecast',modeLayouts:Object.fromEntries(DISPLAY_MODES.map(m=>[m,defaultLayout(m)])),modeSections:Object.fromEntries(DISPLAY_MODES.map(m=>[m,defaultSections(m)])),refreshMinutes:15,showAgenda:true,showTasks:true,showGoals:true,showCountdowns:true,showWeather:true};
  const m={...base,...x};
  return{...m,sectionLayoutMode:'custom',sectionLayout:normalizeSectionLayout(m.sectionLayout,'dashboard'),sectionOrder:normalizeSectionOrder(m.sectionOrder),modeLayouts:normalizeModeLayouts(m.modeLayouts,m.sectionLayout),modeSections:normalizeModeSections(m.modeSections),plannerLayoutVersion:5};
}
export function defaults(){
  return{countdowns:[],tasks:[],goals:[],google:{accounts:[],countdownWindowDays:30},weather:normalizeWeather({units:'metric'}),appearance:normalizeAppearance({mode:'system',theme:'quest',density:'comfortable'}),markets:normalizeMarkets({}),marketCache:null,agent:{enabled:true,provider:'openai',baseUrl:'',model:'gpt-5.6-luna',contextDays:14,credentials:{}},notifications:normalizeNotifications({}),display:normalizeDisplay({})};
}
export function normalizeState(source={}){
  const base=defaults();
  return{...base,...source,countdowns:Array.isArray(source.countdowns)?source.countdowns.map(normalizeCountdown):[],tasks:Array.isArray(source.tasks)?source.tasks.map(normalizeTask):[],goals:Array.isArray(source.goals)?source.goals.map(normalizeGoal):[],google:{accounts:Array.isArray(source.google?.accounts)?source.google.accounts.map(normalizeGoogleAccount):[],countdownWindowDays:clamp(num(source.google?.countdownWindowDays,30),1,365)},weather:normalizeWeather(source.weather||base.weather),appearance:normalizeAppearance(source.appearance||base.appearance),markets:normalizeMarkets(source.markets||base.markets),marketCache:source.marketCache&&typeof source.marketCache==='object'?source.marketCache:null,agent:{enabled:source.agent?.enabled!==false,provider:AGENT_PROVIDERS.includes(source.agent?.provider)?source.agent.provider:'openai',baseUrl:cleanText(source.agent?.baseUrl,500).replace(/\/+$/,''),model:cleanText(source.agent?.model||(source.agent?.provider==='openai'?'gpt-5.6-luna':''),160),contextDays:clamp(Math.round(num(source.agent?.contextDays,14)),1,30),credentials:Object.fromEntries(Object.entries(source.agent?.credentials&&typeof source.agent.credentials==='object'?source.agent.credentials:{}).filter(([provider,value])=>AGENT_PROVIDERS.includes(provider)&&typeof value==='string'&&value).slice(0,20))},notifications:normalizeNotifications(source.notifications||base.notifications),display:normalizeDisplay(source.display||base.display)};
}
export function goalProgress(goal){
  if(goal.type==='checklist')return goal.checklist?.length?clamp(goal.checklist.filter(x=>x.done).length/goal.checklist.length*100,0,100):0;
  if(goal.type==='deadline'){const start=new Date(goal.created).getTime(),end=goal.deadline?new Date(goal.deadline).getTime():start;if(!Number.isFinite(end)||end<=start)return goal.status==='complete'?100:0;return clamp((Date.now()-start)/(end-start)*100,0,100)}
  return clamp(goal.target>0?goal.current/goal.target*100:0,0,100);
}
function cloudAgentSecretName(provider){
  return{openai:'OPENAI_API_KEY',anthropic:'ANTHROPIC_API_KEY',gemini:'GEMINI_API_KEY',openrouter:'OPENROUTER_API_KEY',groq:'GROQ_API_KEY',mistral:'MISTRAL_API_KEY',deepseek:'DEEPSEEK_API_KEY',xai:'XAI_API_KEY'}[provider]||'';
}
function cloudAgentModelEnvName(provider){
  return{openai:'OPENAI_MODEL',anthropic:'ANTHROPIC_MODEL',gemini:'GEMINI_MODEL',openrouter:'OPENROUTER_MODEL',groq:'GROQ_MODEL',mistral:'MISTRAL_MODEL',deepseek:'DEEPSEEK_MODEL',xai:'XAI_MODEL',local:'LOCAL_AGENT_MODEL'}[provider]||'';
}
function cloudAgentHasCredential(state,env,provider){
  const stored=Boolean(state.agent?.credentials?.[provider]);
  if(stored)return true;
  if(provider==='local')return Boolean(env.LOCAL_AGENT_API_KEY||env.LOCAL_AGENT_ACCESS_CLIENT_ID);
  const keyName=cloudAgentSecretName(provider);
  return Boolean(keyName&&env[keyName]);
}
export function publicState(state,env){
  const market=normalizeMarkets(state.markets);
  return{countdowns:[...state.countdowns].sort((a,b)=>Number(Boolean(b.pinned))-Number(Boolean(a.pinned))||new Date(a.end)-new Date(b.end)),tasks:[...state.tasks].sort((a,b)=>(a.status==='done')-(b.status==='done')||(a.due?new Date(a.due):Infinity)-(b.due?new Date(b.due):Infinity)),goals:state.goals.map(g=>({...g,progress:goalProgress(g)})),updater:{configured:false,cloudManaged:true},runtime:{type:'cloudflare',standalone:true},appearance:normalizeAppearance(state.appearance),weather:{...normalizeWeather(state.weather),configured:true,provider:'Open-Meteo'},markets:{...market,configured:Boolean(env.ALPHA_VANTAGE_API_KEY),provider:'Alpha Vantage',effectiveRefreshMinutes:market.refreshMinutes,freeDailyRequestLimit:25},agent:{enabled:state.agent.enabled!==false,provider:state.agent.provider||'openai',baseUrl:state.agent.provider==='local'?(state.agent.baseUrl||''):'',model:(()=>{const p=state.agent.provider||'openai',name=cloudAgentModelEnvName(p);return cleanText(state.agent.model||(name&&env[name])||(p==='openai'?'gpt-5.6-luna':''),160)})(),hasApiKey:cloudAgentHasCredential(state,env,state.agent.provider||'openai'),configuredProviders:AGENT_PROVIDERS.filter(provider=>cloudAgentHasCredential(state,env,provider)),canStoreApiKey:Boolean(env.APP_SECRET),requireConfirmation:true,contextDays:state.agent.contextDays||14,cloudManaged:true},notifications:{enabled:state.notifications?.enabled||false,taskReminders:state.notifications?.taskReminders!==false,eventReminders:state.notifications?.eventReminders!==false,goalReminders:state.notifications?.goalReminders!==false,countdownReminders:state.notifications?.countdownReminders!==false,taskLeadMinutes:state.notifications?.taskLeadMinutes||30,eventLeadMinutes:state.notifications?.eventLeadMinutes||15,goalLeadMinutes:state.notifications?.goalLeadMinutes||1440,countdownLeadMinutes:state.notifications?.countdownLeadMinutes||1440,subscriptionCount:Array.isArray(state.notifications?.subscriptions)?state.notifications.subscriptions.length:0},options:{colors:COLORS,progressModes:PROGRESS_MODES,progressStyles:PROGRESS_STYLES,dateStyles:DATE_STYLES,timeStyles:TIME_STYLES,taskStatus:TASK_STATUS,taskPriority:TASK_PRIORITY,goalTypes:GOAL_TYPES},google:{configured:Boolean(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET&&env.APP_SECRET),connected:state.google.accounts.some(a=>Boolean(a.token)),accounts:state.google.accounts.map(a=>({id:a.id,googleId:a.googleId,label:a.label,selectedCalendarIds:a.selectedCalendarIds||[],selectedTaskListIds:a.selectedTaskListIds||[],defaultTaskListId:a.defaultTaskListId||'',connectedAt:a.connectedAt,canWrite:Boolean(a.token),canTasks:Boolean(a.token)})),countdownWindowDays:state.google.countdownWindowDays||30},display:{...state.display,sectionLayout:normalizeSectionLayout(state.display.sectionLayout,'dashboard'),modeLayouts:normalizeModeLayouts(state.display.modeLayouts,state.display.sectionLayout),modeSections:normalizeModeSections(state.display.modeSections),sectionOrder:normalizeSectionOrder(state.display.sectionOrder),sectionLayoutMode:'custom',gridCols:24,gridRows:16,feedPath:'/api/frameos/feed?token='+state.display.token,svgPath:'/api/frameos/svg?token='+state.display.token,viewPath:'/frame?token='+state.display.token}};
}
async function ensureSchema(db){
  await db.prepare("CREATE TABLE IF NOT EXISTS questlog_state (workspace_id TEXT PRIMARY KEY,state_json TEXT NOT NULL,schema_version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT (datetime('now')),updated_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
}
export async function loadState(env){
  if(!env.DB)return defaults();
  await ensureSchema(env.DB);
  const workspace=cleanText(env.CLOUD_WORKSPACE_ID||'default',120)||'default';
  const row=await env.DB.prepare('SELECT state_json FROM questlog_state WHERE workspace_id=?').bind(workspace).first();
  if(!row?.state_json){const state=defaults();await saveState(env,state);return state}
  try{return normalizeState(JSON.parse(row.state_json))}catch{const state=defaults();await saveState(env,state);return state}
}
export async function saveState(env,state){
  if(!env.DB)throw new Error('Cloudflare D1 binding DB is not configured.');
  await ensureSchema(env.DB);
  const workspace=cleanText(env.CLOUD_WORKSPACE_ID||'default',120)||'default',normalized=normalizeState(state);
  await env.DB.prepare("INSERT INTO questlog_state(workspace_id,state_json,schema_version,created_at,updated_at) VALUES(?,?,1,datetime('now'),datetime('now')) ON CONFLICT(workspace_id) DO UPDATE SET state_json=excluded.state_json,schema_version=1,updated_at=datetime('now')").bind(workspace,JSON.stringify(normalized)).run();
  return normalized;
}
