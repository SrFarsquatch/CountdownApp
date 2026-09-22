import {
  saveState, cleanText, iso, num, clamp, en, id,
  normalizeTask, normalizeGoal, normalizeCountdown, goalProgress,
  normalizeWeather, normalizeMarkets, normalizeAppearance, normalizeModeSections, normalizeSectionOrder
} from './state.js';
import { eventsBetween, calendars, taskLists, mutateEvent } from './google.js';

const ACTION_TYPES=['create_task','update_task','create_goal','update_goal','create_countdown','update_countdown','create_event','update_event'];
const credentialEncoder=new TextEncoder(),credentialDecoder=new TextDecoder();
function credentialB64u(bytes){
  let raw='';for(const b of bytes)raw+=String.fromCharCode(b);
  return btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function credentialFromB64u(value){
  const input=String(value||'').replace(/-/g,'+').replace(/_/g,'/');
  const raw=atob(input+'='.repeat((4-input.length%4)%4));
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
async function agentCredentialKey(env){
  if(!env.APP_SECRET)throw new Error('APP_SECRET is not configured on the Worker.');
  const hash=await crypto.subtle.digest('SHA-256',credentialEncoder.encode(String(env.APP_SECRET)));
  return crypto.subtle.importKey('raw',hash,{name:'AES-GCM'},false,['encrypt','decrypt']);
}
async function encryptAgentCredential(value,env){
  const key=await agentCredentialKey(env),iv=crypto.getRandomValues(new Uint8Array(12));
  const data=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,credentialEncoder.encode(String(value)));
  return 'agent1.'+credentialB64u(iv)+'.'+credentialB64u(new Uint8Array(data));
}
async function decryptAgentCredential(value,env){
  if(!value||!String(value).startsWith('agent1.'))return'';
  try{
    const [,iv,data]=String(value).split('.'),key=await agentCredentialKey(env);
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:credentialFromB64u(iv)},key,credentialFromB64u(data));
    return credentialDecoder.decode(plain);
  }catch{return''}
}
export async function saveAgentCredential(state,env,provider,value){
  const cleanProvider=cleanText(provider,40),secret=cleanText(value,5000);
  if(!secret)throw new Error('API key cannot be empty.');
  state.agent=state.agent||{};
  state.agent.credentials=state.agent.credentials&&typeof state.agent.credentials==='object'?state.agent.credentials:{};
  state.agent.credentials[cleanProvider]=await encryptAgentCredential(secret,env);
  await saveState(env,state);
}
export async function clearAgentCredential(state,env,provider){
  state.agent=state.agent||{};
  state.agent.credentials=state.agent.credentials&&typeof state.agent.credentials==='object'?state.agent.credentials:{};
  delete state.agent.credentials[cleanText(provider,40)];
  await saveState(env,state);
}
async function storedAgentCredential(state,env,provider){
  return decryptAgentCredential(state.agent?.credentials?.[provider],env);
}

const PROVIDER_CONFIG={
  openai:{base:'https://api.openai.com/v1',key:'OPENAI_API_KEY',modelEnv:'OPENAI_MODEL',defaultModel:'gpt-5.6-luna',style:'openai'},
  anthropic:{base:'https://api.anthropic.com/v1',key:'ANTHROPIC_API_KEY',modelEnv:'ANTHROPIC_MODEL',defaultModel:'',style:'anthropic'},
  gemini:{base:'https://generativelanguage.googleapis.com/v1beta/openai',key:'GEMINI_API_KEY',modelEnv:'GEMINI_MODEL',defaultModel:'',style:'openai'},
  openrouter:{base:'https://openrouter.ai/api/v1',key:'OPENROUTER_API_KEY',modelEnv:'OPENROUTER_MODEL',defaultModel:'',style:'openai'},
  groq:{base:'https://api.groq.com/openai/v1',key:'GROQ_API_KEY',modelEnv:'GROQ_MODEL',defaultModel:'',style:'openai'},
  mistral:{base:'https://api.mistral.ai/v1',key:'MISTRAL_API_KEY',modelEnv:'MISTRAL_MODEL',defaultModel:'',style:'openai'},
  deepseek:{base:'https://api.deepseek.com',key:'DEEPSEEK_API_KEY',modelEnv:'DEEPSEEK_MODEL',defaultModel:'',style:'openai'},
  xai:{base:'https://api.x.ai/v1',key:'XAI_API_KEY',modelEnv:'XAI_MODEL',defaultModel:'',style:'openai'}
};
async function endpointConfig(state,env){
  const cfg=state.agent||{},provider=cfg.provider||'openai';
  if(provider==='local'){
    const base=cleanText(cfg.baseUrl||env.LOCAL_AGENT_BASE_URL,500).replace(/\/+$/,'');
    if(!base)throw new Error('Configure a local model HTTPS endpoint in Navi settings.');
    let parsed;try{parsed=new URL(base)}catch{throw new Error('Local model endpoint is invalid.')}
    if(parsed.protocol!=='https:')throw new Error('Cloud Navi local model endpoints must use HTTPS.');
    const storedKey=await storedAgentCredential(state,env,provider),key=storedKey||env.LOCAL_AGENT_API_KEY||'';
    return{
      provider,
      style:'openai',
      base,
      model:cleanText(cfg.model||env.LOCAL_AGENT_MODEL||'local-model',160),
      headers:{
        'Content-Type':'application/json',
        ...(key?{Authorization:'Bearer '+key}:{}),
        ...(env.LOCAL_AGENT_ACCESS_CLIENT_ID&&env.LOCAL_AGENT_ACCESS_CLIENT_SECRET?{
          'CF-Access-Client-Id':env.LOCAL_AGENT_ACCESS_CLIENT_ID,
          'CF-Access-Client-Secret':env.LOCAL_AGENT_ACCESS_CLIENT_SECRET
        }:{})
      }
    };
  }
  const preset=PROVIDER_CONFIG[provider]||PROVIDER_CONFIG.openai;
  const storedKey=await storedAgentCredential(state,env,provider),key=storedKey||env[preset.key]||'';
  if(!key)throw new Error('Add an API key for '+provider+' in Navi settings.');
  return{
    provider,
    style:preset.style,
    base:preset.base,
    model:cleanText(env[preset.modelEnv]||cfg.model||preset.defaultModel,160),
    headers:preset.style==='anthropic'
      ?{'Content-Type':'application/json','anthropic-version':'2023-06-01','x-api-key':key}
      :{'Content-Type':'application/json',Authorization:'Bearer '+key}
  };
}
async function modelFetch(state,env,resource,options={}){
  const cfg=await endpointConfig(state,env),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),120000);
  try{
    const response=await fetch(cfg.base+'/'+String(resource||'').replace(/^\/+/,''),{
      ...options,
      headers:{...cfg.headers,...(options.headers||{})},
      signal:controller.signal
    });
    const raw=await response.text();let data=null;try{data=raw?JSON.parse(raw):null}catch{}
    if(!response.ok){
      const detail=data?.error?.message||data?.error||raw.slice(0,240)||('HTTP '+response.status);
      throw new Error('Agent endpoint request failed: '+detail);
    }
    return{data,cfg};
  }catch(error){
    if(error?.name==='AbortError')throw new Error('Agent request timed out.');
    throw error;
  }finally{clearTimeout(timer)}
}
function responseText(data){
  const content=data?.choices?.[0]?.message?.content;
  if(typeof content==='string')return content.trim();
  if(Array.isArray(content))return content.map(x=>typeof x==='string'?x:(x?.text||x?.content||'')).filter(Boolean).join('\n').trim();
  if(Array.isArray(data?.content))return data.content.map(x=>typeof x==='string'?x:(x?.text||x?.content||'')).filter(Boolean).join('\n').trim();
  if(typeof data?.output_text==='string')return data.output_text.trim();
  return'';
}
function dateOnly(v){return /^\d{4}-\d{2}-\d{2}$/.test(String(v||''))?String(v):null}
function cleanMessages(input){
  if(!Array.isArray(input))return[];
  return input.slice(-24).map(x=>({role:x?.role==='assistant'?'assistant':'user',content:cleanText(x?.content,6000)})).filter(x=>x.content);
}
async function plannerContext(state,env){
  const now=new Date(),end=new Date(now.getTime()+clamp(num(state.agent?.contextDays,14),1,30)*86400000);
  const weather=normalizeWeather(state.weather||{}),markets=normalizeMarkets(state.markets||{}),appearance=normalizeAppearance(state.appearance||{});
  let events=[];try{events=await eventsBetween(now.toISOString(),end.toISOString(),state,env)}catch{}
  const accounts=[],calendarItems=[],taskListItems=[],writable=[];
  for(const account of state.google?.accounts||[]){
    accounts.push({
      id:account.id,label:account.label,
      connected:Boolean(account.token),
      selectedCalendarIds:(account.selectedCalendarIds||[]).slice(0,50),
      selectedTaskListIds:(account.selectedTaskListIds||[]).slice(0,50),
      defaultTaskListId:account.defaultTaskListId||''
    });
    try{
      for(const cal of await calendars(account.id,state,env)){
        const entry={accountId:account.id,accountLabel:account.label,id:cal.id,name:cal.summary,primary:Boolean(cal.primary),accessRole:cal.accessRole,selected:(account.selectedCalendarIds||[]).includes(cal.id)};
        calendarItems.push(entry);
        if(['writer','owner'].includes(cal.accessRole))writable.push({accountId:account.id,accountLabel:account.label,calendarId:cal.id,calendarName:cal.summary,primary:Boolean(cal.primary),selected:entry.selected});
      }
    }catch{}
    try{
      for(const list of await taskLists(account.id,state,env)){
        taskListItems.push({accountId:account.id,accountLabel:account.label,id:list.id,title:list.title,selected:(account.selectedTaskListIds||[]).includes(list.id),isDefault:account.defaultTaskListId===list.id});
      }
    }catch{}
  }

  const allTasks=state.tasks||[],allGoals=state.goals||[],allCountdowns=state.countdowns||[];
  const projects=[...new Set([...allTasks.map(x=>cleanText(x.project,80)),...allGoals.map(x=>cleanText(x.project,80))].filter(Boolean))].slice(0,100);
  return{
    generatedAt:now.toISOString(),
    app:{
      runtime:'cloudflare',
      appearance,
      display:{
        title:cleanText(state.display?.title||'Today',80),
        mode:state.display?.mode||'daily',
        layout:state.display?.layout||'auto',
        palette:state.display?.palette||'spectra6',
        dateWidgetStyle:state.display?.dateWidgetStyle||'plain',
        refreshMinutes:clamp(num(state.display?.refreshMinutes,15),1,1440),
        sectionOrder:normalizeSectionOrder(state.display?.sectionOrder),
        modeSections:normalizeModeSections(state.display?.modeSections)
      }
    },
    userContext:{
      weatherLocation:{
        configured:Number.isFinite(weather.latitude)&&Number.isFinite(weather.longitude),
        label:weather.locationLabel||'',
        countryCode:weather.countryCode||'',
        latitude:weather.latitude,
        longitude:weather.longitude,
        units:weather.units,
        meaning:'This is the location saved by the user for Quest Log weather. Treat it as their preferred/local context when useful, but do not claim it is their verified current physical location.'
      }
    },
    plannerSummary:{
      totalTasks:allTasks.length,
      openTasks:allTasks.filter(x=>x.status!=='done').length,
      completedTasks:allTasks.filter(x=>x.status==='done').length,
      activeGoals:allGoals.filter(x=>x.status==='active').length,
      activeCountdowns:allCountdowns.filter(x=>new Date(x.end)>now).length,
      upcomingEventsInContextWindow:events.length,
      contextWindowDays:clamp(num(state.agent?.contextDays,14),1,30)
    },
    projects,
    tasks:allTasks.slice(0,75).map(x=>({
      id:x.id,title:x.title,description:x.description,status:x.status,priority:x.priority,due:x.due,start:x.start,
      estimatedMinutes:x.estimatedMinutes,project:x.project,goalId:x.goalId,tags:(x.tags||[]).slice(0,12),
      subtasks:(x.subtasks||[]).slice(0,20).map(item=>({id:item.id,title:item.title,done:item.done})),
      created:x.created,updated:x.updated,completedAt:x.completedAt,displayEnabled:x.displayEnabled!==false,
      googleTaskListTitle:x.googleTaskListTitle||'',linkedToGoogleTask:Boolean(x.googleTaskId)
    })),
    goals:allGoals.slice(0,40).map(x=>({
      id:x.id,title:x.title,description:x.description,type:x.type,current:x.current,target:x.target,unit:x.unit,
      deadline:x.deadline,project:x.project,status:x.status,progress:goalProgress(x),accentColor:x.accentColor,
      displayEnabled:x.displayEnabled!==false,
      checklist:(x.checklist||[]).slice(0,25).map(item=>({id:item.id,title:item.title,done:item.done})),
      created:x.created,updated:x.updated
    })),
    countdowns:allCountdowns.filter(x=>new Date(x.end)>now).slice(0,40).map(x=>({
      id:x.id,name:x.name,end:x.end,created:x.created,pinned:x.pinned,goalId:x.goalId,accentColor:x.accentColor,
      progressMode:x.progressMode,progressCurrent:x.progressCurrent,progressTotal:x.progressTotal,progressStart:x.progressStart,
      displayEnabled:x.displayEnabled!==false,dateDisplayStyle:x.dateDisplayStyle,timeDisplayStyle:x.timeDisplayStyle
    })),
    events:events.slice(0,80).map(x=>({
      id:x.id,accountId:x.accountId,calendarId:x.calendarId,calendarName:x.calendarName,title:x.title,
      description:cleanText(x.description,1000),start:x.start,end:x.end,allDay:x.allDay,location:x.location,
      accessRole:x.accessRole,recurringEventId:x.recurringEventId||''
    })),
    integrations:{
      google:{connected:accounts.some(x=>x.connected),accounts:accounts.slice(0,12),calendars:calendarItems.slice(0,100),taskLists:taskListItems.slice(0,100)},
      weather:{configured:Number.isFinite(weather.latitude)&&Number.isFinite(weather.longitude),provider:'Open-Meteo',location:{label:weather.locationLabel||'',countryCode:weather.countryCode||'',latitude:weather.latitude,longitude:weather.longitude,units:weather.units}},
      markets:{configured:Boolean(env.ALPHA_VANTAGE_API_KEY),provider:'Alpha Vantage',refreshMinutes:markets.refreshMinutes,watchlist:(markets.watchlist||[]).slice(0,8).map(item=>({symbol:item.symbol,providerSymbol:item.providerSymbol,name:item.name,exchange:item.exchange,region:item.region,currency:item.currency}))}
    },
    writableCalendars:writable.slice(0,50)
  };
}
function systemPrompt(){
  return[
    'You are Navi, the planning companion inside Quest Log.',
    'Use the supplied Quest Log context as the source of truth for current planner data, app settings, integrations, and saved preferences.',
    'The saved weatherLocation is especially important local context. It is the location the user chose for weather, not verified live device location, so use it as a default local area without claiming the user is physically there right now.',
    'You may use app appearance, display preferences, project names, Google account/calendar/task-list metadata, weather configuration, and market watchlist when relevant.',
    'Secrets, OAuth tokens, API keys, agent credentials, and display tokens are intentionally excluded from context; never ask the user to reveal them in chat.',
    'Return ONLY one JSON object with this shape: {"message":"your response","actions":[]}.',
    'Never claim a proposed planner change already happened.',
    'When the user asks to change planner data, return one or more actions. The user will approve them before execution.',
    'Do not propose deletions and do not invent IDs.',
    'Allowed actions:',
    'create_task: title, description?, due? ISO-8601, start? ISO-8601, priority? low|medium|high|urgent, project?, goalId?, estimatedMinutes?',
    'update_task: id plus any create_task fields or status? todo|progress|done',
    'create_goal: title, description?, goalType? number|checklist|deadline, current?, target?, unit?, deadline? ISO-8601, project?, status? active|complete|paused',
    'update_goal: id plus any create_goal fields',
    'create_countdown: name, end ISO-8601, pinned?, goalId?, accentColor? black|red|blue|green|yellow|purple',
    'update_countdown: id plus any create_countdown fields',
    'create_event: accountId, calendarId, title, description?, location?, allDay?, start/end ISO-8601 or startDate/endDate YYYY-MM-DD, repeat? none|daily|weekly|monthly|yearly',
    'update_event: accountId, calendarId, eventId and event fields',
    'For calendar actions, only use accountId/calendarId pairs from writableCalendars.',
    'If an important date, time, calendar, or target is ambiguous, ask a follow-up question and return no actions.'
  ].join('\n');
}
function normalizeAction(raw={}){
  const type=ACTION_TYPES.includes(String(raw.type||''))?String(raw.type):'';if(!type)return null;
  const out={type},txt=(k,m=500)=>{if(Object.prototype.hasOwnProperty.call(raw,k))out[k]=cleanText(raw[k],m)},bool=k=>{if(Object.prototype.hasOwnProperty.call(raw,k))out[k]=Boolean(raw[k])},number=k=>{if(Number.isFinite(Number(raw[k])))out[k]=Number(raw[k])},date=k=>{if(!Object.prototype.hasOwnProperty.call(raw,k))return;if(raw[k]===null||raw[k]==='')out[k]=null;else{const v=iso(raw[k]);if(v)out[k]=v}};
  if(type.includes('task')){
    if(type==='update_task'){txt('id',120);if(!out.id)return null}
    txt('title',160);txt('description',2000);txt('project',80);txt('goalId',120);date('due');date('start');number('estimatedMinutes');
    if(raw.priority!==undefined)out.priority=en(raw.priority,['low','medium','high','urgent'],'medium');
    if(raw.status!==undefined)out.status=en(raw.status,['todo','progress','done'],'todo');
    if(type==='create_task'&&!out.title)return null;
  }else if(type.includes('goal')){
    if(type==='update_goal'){txt('id',120);if(!out.id)return null}
    txt('title',160);txt('description',2000);txt('unit',30);txt('project',80);date('deadline');number('current');number('target');
    if(raw.goalType!==undefined)out.goalType=en(raw.goalType,['number','checklist','deadline'],'number');
    if(raw.status!==undefined)out.status=en(raw.status,['active','complete','paused'],'active');
    if(type==='create_goal'&&!out.title)return null;
  }else if(type.includes('countdown')){
    if(type==='update_countdown'){txt('id',120);if(!out.id)return null}
    txt('name',100);txt('goalId',120);date('end');bool('pinned');
    if(raw.accentColor!==undefined)out.accentColor=en(raw.accentColor,['black','red','blue','green','yellow','purple'],'black');
    if(type==='create_countdown'&&(!out.name||!out.end))return null;
  }else{
    txt('accountId',160);txt('calendarId',500);txt('eventId',500);txt('title',500);txt('description',8000);txt('location',1000);txt('startDate',10);txt('endDate',10);txt('repeat',20);bool('allDay');date('start');date('end');
    if(type==='update_event'&&!out.eventId)return null;
    if(!out.accountId||!out.calendarId||!out.title)return null;
    if(out.allDay){if(!dateOnly(out.startDate)||!dateOnly(out.endDate||out.startDate))return null}else if(!out.start||!out.end)return null;
  }
  out.summary=type.replaceAll('_',' ')+(out.title?': '+out.title:out.name?': '+out.name:'');
  return out;
}
function parseEnvelope(raw){
  const original=String(raw||'').trim(),candidate=original.replace(/^\`\`\`(?:json)?\s*/i,'').replace(/\s*\`\`\`$/i,'').trim();
  let parsed=null;try{parsed=JSON.parse(candidate)}catch{const a=candidate.indexOf('{'),b=candidate.lastIndexOf('}');if(a>=0&&b>a)try{parsed=JSON.parse(candidate.slice(a,b+1))}catch{}}
  if(!parsed||typeof parsed!=='object')return{message:original||'I could not format a response.',actions:[]};
  return{message:cleanText(parsed.message||parsed.reply||original,10000),actions:Array.isArray(parsed.actions)?parsed.actions.map(normalizeAction).filter(Boolean).slice(0,10):[]};
}
export async function listAgentModels(state,env){
  const cfg=await endpointConfig(state,env);
  try{
    const result=await modelFetch(state,env,'models',{method:'GET'});
    const data=result.data,raw=Array.isArray(data?.data)?data.data:(Array.isArray(data?.models)?data.models:[]);
    const models=raw.map(x=>cleanText(x?.id||x?.name||x,200)).filter(Boolean);
    return{ok:true,provider:cfg.provider,models:[...new Set(models)].slice(0,200),configuredModel:cfg.model||''};
  }catch(error){
    return{ok:true,provider:cfg.provider,models:[],configuredModel:cfg.model||'',warning:'This provider did not return a model list. Enter the model ID manually.'};
  }
}
export async function testAgent(state,env){
  const cfg=await endpointConfig(state,env);
  if(!cfg.model)throw new Error('Configure a model for '+cfg.provider+' first.');
  try{
    const result=await modelFetch(state,env,'models',{method:'GET'});
    const data=result.data,raw=Array.isArray(data?.data)?data.data:(Array.isArray(data?.models)?data.models:[]);
    const models=raw.map(x=>x?.id||x?.name||x).filter(Boolean).slice(0,10);
    return{ok:true,provider:cfg.provider,models:models.length?models:[cfg.model]};
  }catch(error){
    if(cfg.style==='anthropic'){
      const payload={model:cfg.model,max_tokens:8,messages:[{role:'user',content:'Reply with the word OK.'}]};
      await modelFetch(state,env,'messages',{method:'POST',body:JSON.stringify(payload)});
      return{ok:true,provider:cfg.provider,models:[cfg.model]};
    }
    const payload={model:cfg.model,stream:false,messages:[{role:'user',content:'Reply with the word OK.'}],max_tokens:8};
    await modelFetch(state,env,'chat/completions',{method:'POST',body:JSON.stringify(payload)});
    return{ok:true,provider:cfg.provider,models:[cfg.model]};
  }
}
export async function chat(state,env,messages){
  const cfg=await endpointConfig(state,env),context=await plannerContext(state,env),history=cleanMessages(messages);
  if(!cfg.model)throw new Error('Configure a model for '+cfg.provider+' first.');
  let resource='chat/completions',payload;
  if(cfg.style==='anthropic'){
    resource='messages';
    payload={model:cfg.model,stream:false,max_tokens:4096,system:systemPrompt()+'\n\nCurrent Quest Log context (JSON):\n'+JSON.stringify(context),messages:history};
  }else{
    payload={model:cfg.model,stream:false,messages:[{role:'system',content:systemPrompt()},{role:'system',content:'Current Quest Log context (JSON):\n'+JSON.stringify(context)},...history]};
  }
  const {data}=await modelFetch(state,env,resource,{method:'POST',body:JSON.stringify(payload)});
  const text=responseText(data);if(!text)throw new Error('The agent returned an empty response.');
  return parseEnvelope(text);
}
export async function applyActions(state,env,actions){
  if(!Array.isArray(actions))throw new Error('actions must be an array.');
  const results=[];
  for(const raw of actions.slice(0,10)){
    const action=normalizeAction(raw);if(!action){results.push({ok:false,label:'Invalid planner change'});continue}
    try{
      if(action.type==='create_task'){
        const now=new Date().toISOString(),item=normalizeTask({...action,id:id(),created:now,updated:now});state.tasks.push(item);results.push({ok:true,label:'Created task: '+item.title});
      }else if(action.type==='update_task'){
        const i=state.tasks.findIndex(x=>x.id===action.id);if(i<0)throw new Error('Task not found');
        const current=state.tasks[i],next=normalizeTask({...current,...action,id:current.id,created:current.created,updated:new Date().toISOString()});state.tasks[i]=next;results.push({ok:true,label:'Updated task: '+next.title});
      }else if(action.type==='create_goal'){
        const now=new Date().toISOString(),item=normalizeGoal({...action,type:action.goalType||'number',id:id(),created:now,updated:now});state.goals.push(item);results.push({ok:true,label:'Created goal: '+item.title});
      }else if(action.type==='update_goal'){
        const i=state.goals.findIndex(x=>x.id===action.id);if(i<0)throw new Error('Goal not found');
        const current=state.goals[i],next=normalizeGoal({...current,...action,type:action.goalType||current.type,id:current.id,created:current.created,updated:new Date().toISOString()});state.goals[i]=next;results.push({ok:true,label:'Updated goal: '+next.title});
      }else if(action.type==='create_countdown'){
        const item=normalizeCountdown({...action,id:id(),created:new Date().toISOString()});state.countdowns.push(item);results.push({ok:true,label:'Created countdown: '+item.name});
      }else if(action.type==='update_countdown'){
        const i=state.countdowns.findIndex(x=>x.id===action.id);if(i<0)throw new Error('Countdown not found');
        const current=state.countdowns[i],next=normalizeCountdown({...current,...action,id:current.id,created:current.created});state.countdowns[i]=next;results.push({ok:true,label:'Updated countdown: '+next.name});
      }else if(action.type==='create_event'){
        await mutateEvent(action.accountId,action.calendarId,'','POST',action,state,env);results.push({ok:true,label:'Created calendar event: '+action.title});
      }else if(action.type==='update_event'){
        await mutateEvent(action.accountId,action.calendarId,action.eventId,'PATCH',action,state,env);results.push({ok:true,label:'Updated calendar event: '+action.title});
      }
    }catch(error){results.push({ok:false,label:action.summary||action.type,error:error.message})}
  }
  await saveState(env,state);return results;
}
