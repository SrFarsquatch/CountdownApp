import {
  saveState, cleanText, iso, num, clamp, en, id,
  normalizeTask, normalizeGoal, normalizeCountdown, goalProgress
} from './state.js';
import { eventsBetween, calendars, mutateEvent } from './google.js';

const ACTION_TYPES=['create_task','update_task','create_goal','update_goal','create_countdown','update_countdown','create_event','update_event'];

function endpointConfig(state,env){
  const cfg=state.agent||{},provider=cfg.provider==='local'?'local':'openai';
  if(provider==='local'){
    const base=cleanText(cfg.baseUrl||env.LOCAL_AGENT_BASE_URL,500).replace(/\/+$/,'');
    if(!base)throw new Error('Configure a local model HTTPS endpoint in Navi settings.');
    let parsed;try{parsed=new URL(base)}catch{throw new Error('Local model endpoint is invalid.')}
    if(parsed.protocol!=='https:')throw new Error('Cloud Navi local model endpoints must use HTTPS.');
    return{
      provider,
      base,
      model:cleanText(cfg.model||env.LOCAL_AGENT_MODEL||'local-model',160),
      headers:{
        'Content-Type':'application/json',
        ...(env.LOCAL_AGENT_API_KEY?{Authorization:'Bearer '+env.LOCAL_AGENT_API_KEY}:{}),
        ...(env.LOCAL_AGENT_ACCESS_CLIENT_ID&&env.LOCAL_AGENT_ACCESS_CLIENT_SECRET?{
          'CF-Access-Client-Id':env.LOCAL_AGENT_ACCESS_CLIENT_ID,
          'CF-Access-Client-Secret':env.LOCAL_AGENT_ACCESS_CLIENT_SECRET
        }:{})
      }
    };
  }
  if(!env.OPENAI_API_KEY)throw new Error('OPENAI_API_KEY is not configured as a Worker secret.');
  return{
    provider:'openai',
    base:'https://api.openai.com/v1',
    model:cleanText(env.OPENAI_MODEL||cfg.model||'gpt-5.6-luna',160),
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+env.OPENAI_API_KEY}
  };
}
async function modelFetch(state,env,resource,options={}){
  const cfg=endpointConfig(state,env),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),120000);
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
  let events=[];try{events=await eventsBetween(now.toISOString(),end.toISOString(),state,env)}catch{}
  const writable=[];
  for(const account of state.google?.accounts||[]){
    try{
      for(const cal of await calendars(account.id,state,env)){
        if(['writer','owner'].includes(cal.accessRole))writable.push({accountId:account.id,accountLabel:account.label,calendarId:cal.id,calendarName:cal.summary,primary:Boolean(cal.primary),selected:(account.selectedCalendarIds||[]).includes(cal.id)});
      }
    }catch{}
  }
  return{
    generatedAt:now.toISOString(),
    tasks:(state.tasks||[]).slice(0,50).map(x=>({id:x.id,title:x.title,description:x.description,status:x.status,priority:x.priority,due:x.due,start:x.start,project:x.project,goalId:x.goalId})),
    goals:(state.goals||[]).slice(0,30).map(x=>({id:x.id,title:x.title,description:x.description,type:x.type,current:x.current,target:x.target,unit:x.unit,deadline:x.deadline,project:x.project,status:x.status,progress:goalProgress(x)})),
    countdowns:(state.countdowns||[]).filter(x=>new Date(x.end)>now).slice(0,30).map(x=>({id:x.id,name:x.name,end:x.end,pinned:x.pinned,goalId:x.goalId})),
    events:events.slice(0,60).map(x=>({id:x.id,accountId:x.accountId,calendarId:x.calendarId,calendarName:x.calendarName,title:x.title,description:cleanText(x.description,500),start:x.start,end:x.end,allDay:x.allDay,location:x.location,accessRole:x.accessRole})),
    writableCalendars:writable.slice(0,50)
  };
}
function systemPrompt(){
  return[
    'You are Navi, the planning companion inside Quest Log.',
    'Use the supplied Quest Log context as the source of truth for current planner data.',
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
export async function testAgent(state,env){
  const cfg=endpointConfig(state,env);
  try{
    const result=await modelFetch(state,env,'models',{method:'GET'});
    const data=result.data,models=Array.isArray(data?.data)?data.data.map(x=>x.id).filter(Boolean).slice(0,10):[cfg.model];
    return{ok:true,provider:cfg.provider,models:models.length?models:[cfg.model]};
  }catch{
    // Some compatible local endpoints do not expose /models. A minimal chat request is a better fallback test.
    const payload={model:cfg.model,stream:false,messages:[{role:'user',content:'Reply with the word OK.'}],max_tokens:8};
    await modelFetch(state,env,'chat/completions',{method:'POST',body:JSON.stringify(payload)});
    return{ok:true,provider:cfg.provider,models:[cfg.model]};
  }
}
export async function chat(state,env,messages){
  const cfg=endpointConfig(state,env),context=await plannerContext(state,env);
  const payload={model:cfg.model,stream:false,messages:[{role:'system',content:systemPrompt()},{role:'system',content:'Current Quest Log context (JSON):\n'+JSON.stringify(context)},...cleanMessages(messages)]};
  const {data}=await modelFetch(state,env,'chat/completions',{method:'POST',body:JSON.stringify(payload)});
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
