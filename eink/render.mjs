const SECTIONS=['agenda','weather','tasks','goals','countdowns','markets'];
const HEX={black:'#000000',white:'#FFFFFF',red:'#FF0000',green:'#00FF00',blue:'#0000FF',yellow:'#FFFF00'};

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const short=(value,max=48)=>{const s=String(value??'');return s.length<=max?s:s.slice(0,Math.max(1,max-1))+'…'};
const num=(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback;
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const dateKey=value=>{const raw=typeof value==='string'?value.trim():'';if(/^\d{4}-\d{2}-\d{2}$/.test(raw))return raw;const d=new Date(value);return Number.isNaN(d.getTime())?'':[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')};
const renderTimeZone=data=>data?.timeZone||data?.weather?.timeZone||'UTC';
const fmtTime=(value,data)=>{const d=new Date(value);return Number.isNaN(d.getTime())?'':new Intl.DateTimeFormat('en-CA',{timeZone:renderTimeZone(data),hour:'numeric',minute:'2-digit'}).format(d)};
const fmtDate=(value,data)=>{const raw=String(value??'');if(/^\d{4}-\d{2}-\d{2}$/.test(raw)){const [y,m,d]=raw.split('-').map(Number);return new Date(y,m-1,d).toLocaleDateString('en-CA',{month:'short',day:'numeric'})}const dt=new Date(value);return Number.isNaN(dt.getTime())?'':new Intl.DateTimeFormat('en-CA',{timeZone:renderTimeZone(data),month:'short',day:'numeric'}).format(dt)};
const modeLabel=mode=>({dashboard:'Dashboard',daily:'Today',weekly:'This Week',monthly:'This Month',countdowns:'Countdowns'})[mode]||'Planner';
const sectionLabel=kind=>({agenda:'Agenda',weather:'Weather',tasks:'Tasks',goals:'Goals',countdowns:'Countdowns',markets:'Markets'})[kind]||kind;

function accent(kind,palette='spectra6'){
  if(palette==='mono')return HEX.black;
  return({agenda:HEX.blue,weather:HEX.yellow,tasks:HEX.green,goals:HEX.blue,countdowns:HEX.red,markets:HEX.green})[kind]||HEX.black;
}
function namedAccent(value,palette='spectra6',fallback=HEX.blue){
  if(palette==='mono')return HEX.black;
  const name=String(value||'').toLowerCase();
  if(name==='purple')return HEX.blue;
  return HEX[name]||fallback;
}
function weatherAccent(condition,palette='spectra6'){
  if(palette==='mono')return HEX.black;
  const t=String(condition||'').toUpperCase();
  if(/THUNDER|STORM/.test(t))return HEX.red;
  if(/RAIN|DRIZZLE|SHOWER|SNOW|ICE|SLEET/.test(t))return HEX.blue;
  if(/CLEAR|SUN/.test(t))return HEX.yellow;
  if(/FOG|HAZE|MIST/.test(t))return HEX.green;
  return HEX.black;
}
function weatherIcon(condition,size=54,palette='spectra6'){
  const t=String(condition||'').toUpperCase(),sun=palette==='mono'?HEX.black:HEX.yellow,rain=palette==='mono'?HEX.black:HEX.blue,storm=palette==='mono'?HEX.black:HEX.red;
  const cloud='<path d="M17 42c-7 0-12-5-12-11 0-6 4-10 10-11 2-8 9-13 17-13 10 0 18 7 19 17 6 1 10 5 10 11 0 7-5 12-13 12H17z" fill="#fff" stroke="#000" stroke-width="3" stroke-linejoin="round"/>';
  const sunSvg='<circle cx="23" cy="21" r="10" fill="'+sun+'" stroke="#000" stroke-width="2.5"/><path d="M23 3v7M23 32v7M5 21h7M34 21h7M10 8l5 5M31 29l5 5M36 8l-5 5M15 29l-5 5" stroke="#000" stroke-width="2.5" stroke-linecap="round"/>';
  let body='';
  if(/CLEAR|SUN/.test(t)&&!/CLOUD|PARTLY|MOSTLY/.test(t))body=sunSvg;
  else if(/THUNDER|STORM/.test(t))body=cloud+'<path d="M30 45h10l-7 9h7L27 67l4-11h-7z" fill="'+storm+'" stroke="#000" stroke-width="1.5"/>';
  else if(/RAIN|DRIZZLE|SHOWER/.test(t))body=cloud+'<path d="M20 51l-4 8M34 51l-4 8M48 51l-4 8" stroke="'+rain+'" stroke-width="4" stroke-linecap="round"/>';
  else if(/SNOW|ICE|SLEET/.test(t))body=cloud+'<g stroke="'+rain+'" stroke-width="2.2" stroke-linecap="round"><path d="M20 52v10M15 57h10M34 52v10M29 57h10M48 52v10M43 57h10"/></g>';
  else if(/PARTLY|MOSTLY|CLOUD.*SUN/.test(t))body=sunSvg+cloud;
  else body=cloud;
  return '<svg class="weather-icon" viewBox="0 0 68 68" width="'+size+'" height="'+size+'" aria-hidden="true">'+body+'</svg>';
}
function progressBar(value,color){
  const p=clamp(num(value,0),0,100);
  return '<div class="progress"><span style="width:'+p+'%;background:'+color+'"></span></div>';
}
function countdownLabel(item){
  const r=item?.remaining||{};
  if(item?.timeDisplayStyle==='weeks')return Math.floor(num(r.days,0)/7)+'w '+(num(r.days,0)%7)+'d';
  if(item?.timeDisplayStyle==='compact')return num(r.days,0)+'d '+String(num(r.hours,0)).padStart(2,'0')+'h';
  if(item?.timeDisplayStyle==='full'||item?.timeDisplayStyle==='precise')return num(r.days,0)+'d '+String(num(r.hours,0)).padStart(2,'0')+'h '+String(num(r.minutes,0)).padStart(2,'0')+'m';
  if(item?.timeDisplayStyle==='date')return fmtDate(item.end,data);
  return num(item?.daysRemaining,0)+' '+(num(item?.daysRemaining,0)===1?'day':'days');
}
function sectionStyle(rect){
  const r=rect||{x:0,y:0,w:25,h:25};
  const x=clamp(num(r.x,0),0,100),y=clamp(num(r.y,0),0,100),w=clamp(num(r.w,25),5,100-x),h=clamp(num(r.h,25),5,100-y);
  return 'left:calc('+x+'% + 2.5px);top:calc('+y+'% + 2.5px);width:calc('+w+'% - 5px);height:calc('+h+'% - 5px);';
}
function nativeColor(value,palette='spectra6',fallback=HEX.blue){
  if(palette==='mono')return HEX.black;
  const raw=String(value||'').trim(),named=raw.toLowerCase();
  if(named==='purple')return HEX.blue;
  if(HEX[named])return HEX[named];
  const match=/^#?([0-9a-f]{6})$/i.exec(raw);if(!match)return fallback;
  const n=parseInt(match[1],16),rgb=[n>>16,(n>>8)&255,n&255],choices=[HEX.black,HEX.red,HEX.green,HEX.blue,HEX.yellow];
  let best=fallback,dist=Infinity;
  for(const choice of choices){const m=parseInt(choice.slice(1),16),c=[m>>16,(m>>8)&255,m&255],d=(rgb[0]-c[0])**2+(rgb[1]-c[1])**2+(rgb[2]-c[2])**2;if(d<dist){dist=d;best=choice}}
  return best;
}
function eventColor(event,palette){return nativeColor(event?.eventColor||event?.calendarColor,palette,HEX.blue)}
function eventOnDateKey(event,key){
  if(event?.allDay){
    const startKey=String(event.start||'').slice(0,10),endKey=String(event.end||'').slice(0,10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(startKey))return false;
    return endKey>startKey?startKey<=key&&key<endKey:key===startKey;
  }
  return dateKey(event?.start)===key;
}
function taskColor(task,palette){return palette==='mono'?HEX.black:({urgent:HEX.red,high:HEX.red,medium:HEX.yellow,low:HEX.green})[String(task?.priority||'').toLowerCase()]||HEX.black}

function renderAgenda(data,cfg,palette){
  const events=Array.isArray(data.calendarEvents)?data.calendarEvents:(Array.isArray(data.events)?data.events:[]);
  const limit=clamp(num(cfg?.limit,12),1,20),style=cfg?.style||'list',now=new Date();
  if(style==='calendar'){
    const first=new Date(now.getFullYear(),now.getMonth(),1),start=new Date(first);start.setDate(1-((first.getDay()+6)%7));
    let html='<div class="month-grid"><div class="dow">M</div><div class="dow">T</div><div class="dow">W</div><div class="dow">T</div><div class="dow">F</div><div class="dow">S</div><div class="dow">S</div>';
    for(let i=0;i<42;i++){
      const d=new Date(start);d.setDate(start.getDate()+i);const key=dateKey(d),matches=events.filter(e=>eventOnDateKey(e,key)).slice(0,3);
      html+='<div class="day '+(d.getMonth()===now.getMonth()?'':'muted-day')+'"><b>'+d.getDate()+'</b><div class="dots">'+matches.map(e=>'<i style="background:'+eventColor(e,palette)+'"></i>').join('')+'</div></div>';
    }
    return html+'</div>';
  }
  if(style==='week'){
    const monday=new Date(now);monday.setHours(0,0,0,0);monday.setDate(monday.getDate()-((monday.getDay()+6)%7));
    let html='<div class="week-list">';
    for(let i=0;i<7;i++){
      const d=new Date(monday);d.setDate(monday.getDate()+i);const matches=events.filter(e=>eventOnDateKey(e,dateKey(d))).slice(0,2);
      html+='<div class="week-day"><div class="week-name">'+d.toLocaleDateString('en-CA',{weekday:'short'}).toUpperCase()+' <b>'+d.getDate()+'</b></div><div class="week-events">'+(matches.length?matches.map(e=>'<span><i style="background:'+eventColor(e,palette)+'"></i>'+esc(short(e.title,28))+'</span>').join(''):'<em>—</em>')+'</div></div>';
    }
    return html+'</div>';
  }
  if(!events.length)return '<div class="empty"><b>Open schedule</b><span>No upcoming calendar events</span></div>';
  return '<div class="agenda-list '+esc(style)+'">'+events.slice(0,limit).map(event=>{
    const when=event.allDay?'ALL DAY':fmtTime(event.start,data),detail=event.location||event.calendarName||event.calendarSummary||'';
    return '<div class="agenda-row"><time>'+esc(when)+'</time><i class="event-dot" style="background:'+eventColor(event,palette)+'"></i><div class="event-main"><b>'+esc(short(event.title,52))+'</b>'+(detail?'<span>'+esc(short(detail,52))+'</span>':'')+'</div></div>';
  }).join('')+'</div>';
}
function weatherDays(weather){return (weather?.days||weather?.forecast||[]).map(day=>({...day,condition:day?.daytime?.condition||day?.condition||'',description:day?.daytime?.description||day?.description||''}))}
function renderWeather(data,cfg,palette){
  const weather=data.weather,current=weather?.current,days=weatherDays(weather).slice(0,clamp(num(cfg?.limit,5),1,10));
  if(!current)return '<div class="empty"><b>Weather unavailable</b><span>Check the configured location</span></div>';
  const unit=weather?.unitSymbol||(weather?.units==='imperial'?'°F':'°C'),style=cfg?.style||'forecast';
  const metrics='<div class="weather-metrics"><div><span>Feels</span><b>'+esc(Math.round(num(current.feelsLike,current.temperature))+unit)+'</b></div><div><span>Humidity</span><b>'+esc(Math.round(num(current.humidity,0))+'%')+'</b></div><div><span>Wind</span><b>'+esc(Math.round(num(current.windSpeed,0))+(weather?.units==='imperial'?' mph':' km/h'))+'</b></div></div>';
  const forecast=style==='forecast'&&days.length?'<div class="forecast-strip">'+days.map((day,i)=>'<div class="forecast-day"><span>'+(i===0?'TODAY':new Date(day.date+'T12:00:00').toLocaleDateString('en-CA',{weekday:'short'}).toUpperCase())+'</span>'+weatherIcon(day.condition,26,palette)+'<b>'+esc((day.high??'—')+'°')+'</b><small>'+esc((day.low??'—')+'°')+'</small></div>').join('')+'</div>':'';
  return '<div class="weather-current '+esc(style)+'">'+weatherIcon(current.condition,58,palette)+'<div class="temp"><strong>'+esc(Math.round(num(current.temperature,0)))+'<sup>'+esc(unit)+'</sup></strong><span>'+esc(short(current.description||'',34))+'</span></div>'+metrics+forecast+'</div>';
}
function renderTasks(data,cfg,palette){
  const tasks=Array.isArray(data.tasks)?data.tasks:[],limit=clamp(num(cfg?.limit,4),1,20),style=cfg?.style||'checklist';
  if(!tasks.length)return '<div class="empty"><b>All clear</b><span>No open tasks</span></div>';
  return '<div class="task-list '+esc(style)+'">'+tasks.slice(0,limit).map(task=>'<div class="task-row"><span class="check"></span><i class="priority" style="background:'+taskColor(task,palette)+'"></i><div><b>'+esc(short(task.title,42))+'</b>'+(style!=='compact'&&task.project?'<small>'+esc(short(task.project,32))+'</small>':'')+'</div>'+(task.due?'<time>'+esc(fmtDate(task.due,data))+'</time>':'')+'</div>').join('')+'</div>';
}
function goalMetric(goal){
  if(goal?.type==='checklist'){const total=goal.checklist?.length||0,done=(goal.checklist||[]).filter(x=>x.done).length;return done+'/'+total+' steps'}
  if(goal?.type==='deadline'&&goal.deadline)return'Due '+fmtDate(goal.deadline,data);
  if(num(goal?.target,0)>0)return num(goal.current,0)+' / '+num(goal.target,0)+(goal.unit?' '+goal.unit:'');
  return'';
}
function renderGoals(data,cfg,palette){
  const goals=Array.isArray(data.goals)?data.goals:[],limit=clamp(num(cfg?.limit,2),1,20),style=cfg?.style||'bars';
  if(!goals.length)return '<div class="empty"><b>No active goals</b><span>Add a goal to track progress</span></div>';
  return '<div class="goal-list '+esc(style)+'">'+goals.slice(0,limit).map(goal=>{const p=Math.round(num(goal.progress,0)),c=namedAccent(goal.accentColor,palette,HEX.blue);return '<div class="goal-row"><div class="goal-head"><b>'+esc(short(goal.title,40))+'</b><strong>'+p+'%</strong></div>'+(style!=='compact'?'<small>'+esc(goalMetric(goal))+'</small>'+progressBar(p,c):'')+'</div>'}).join('')+'</div>';
}
function renderCountdowns(data,cfg,palette){
  const items=Array.isArray(data.countdowns)?data.countdowns:[],limit=clamp(num(cfg?.limit,3),1,20),style=cfg?.style||'detailed';
  if(!items.length)return '<div class="empty"><b>Nothing counting down</b><span>Add a date worth watching</span></div>';
  return '<div class="countdown-list '+esc(style)+'">'+items.slice(0,limit).map(item=>{const c=namedAccent(item.accentColor,palette,HEX.red);return '<div class="countdown-row"><i style="background:'+c+'"></i><div><b>'+esc(short(item.name,34))+'</b>'+(style!=='compact'&&item.showExactDate!==false?'<small>'+esc(fmtDate(item.end,data))+'</small>':'')+'</div><strong>'+esc(countdownLabel(item))+'</strong>'+(style!=='compact'&&item.showProgressBar!==false?progressBar(item.progress,c):'')+'</div>'}).join('')+'</div>';
}
function renderMarkets(data,cfg,palette){
  const quotes=Array.isArray(data.markets?.quotes)?data.markets.quotes:[],limit=clamp(num(cfg?.limit,4),1,20),style=cfg?.style||'summary';
  if(!quotes.length)return '<div class="empty"><b>No market data</b><span>Add symbols to your watchlist</span></div>';
  return '<div class="market-list '+esc(style)+'">'+quotes.slice(0,limit).map(q=>{const pct=Number(q.percentChange),ok=q.available!==false&&q.close!=null,up=ok&&Number.isFinite(pct)?pct:0,c=palette==='mono'?HEX.black:(up>0?HEX.green:up<0?HEX.red:HEX.black);return '<div class="market-row"><b>'+esc(q.symbol||'')+'</b>'+(style==='ticker'&&q.name?'<span>'+esc(short(q.name,22))+'</span>':'')+'<strong>'+esc(ok?Number(q.close).toFixed(2):'N/A')+'</strong><em style="color:'+c+'">'+(ok?(up>0?'▲ ':up<0?'▼ ':'• ')+Math.abs(up).toFixed(2)+'%':'—')+'</em></div>'}).join('')+'</div>';
}
function renderSection(kind,data,cfg,palette){
  if(kind==='agenda')return renderAgenda(data,cfg,palette);
  if(kind==='weather')return renderWeather(data,cfg,palette);
  if(kind==='tasks')return renderTasks(data,cfg,palette);
  if(kind==='goals')return renderGoals(data,cfg,palette);
  if(kind==='countdowns')return renderCountdowns(data,cfg,palette);
  if(kind==='markets')return renderMarkets(data,cfg,palette);
  return '';
}

export function renderEinkHtml(data,width=800,height=480){
  const w=clamp(Math.round(num(width,800)),300,2000),h=clamp(Math.round(num(height,480)),300,2000),display=data?.display||{},palette=display.palette||'spectra6',mode=display.mode||'dashboard';
  const layout=display.modeLayout||display.sectionLayout||{},sections=display.modeSections||{},order=Array.isArray(display.sectionOrder)?display.sectionOrder:SECTIONS;
  const now=new Date(),location=data?.weather?.location||data?.weather?.locationLabel||'';
  const widgets=order.filter(kind=>SECTIONS.includes(kind)&&sections?.[kind]?.enabled!==false).map(kind=>{
    const rect=layout?.[kind]||{x:0,y:0,w:6,h:4},cfg=sections?.[kind]||{},color=accent(kind,palette);
    return '<section class="widget widget-'+kind+' style-'+esc(cfg.style||'default')+'" style="'+sectionStyle(rect)+';--accent:'+color+'"><header><span class="pin"></span><h2>'+esc(sectionLabel(kind))+'</h2></header><div class="widget-body">'+renderSection(kind,data,cfg,palette)+'</div></section>';
  }).join('');
  const css='*{box-sizing:border-box}html,body{margin:0;width:'+w+'px;height:'+h+'px;overflow:hidden;background:#fff;color:#000;font-family:Arial,Helvetica,sans-serif}.canvas{position:relative;width:100%;height:100%;background:#fff;padding:12px 14px 10px}.masthead{height:52px;display:grid;grid-template-columns:1fr auto;grid-template-rows:18px 28px;align-items:end;border-bottom:1.5px solid #000;padding:0 2px 6px}.brand{font-size:8px;font-weight:900;letter-spacing:1.8px;text-transform:uppercase}.place{text-align:right;font-size:8px;font-weight:700;max-width:300px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.date{font-size:20px;line-height:1;font-weight:900;letter-spacing:-.35px}.time{text-align:right;font-size:18px;line-height:1;font-weight:800}.mode{position:absolute;right:16px;top:55px;font-size:7px;font-weight:800;letter-spacing:1.1px;text-transform:uppercase}.grid{position:absolute;left:14px;right:14px;top:69px;bottom:17px}.widget{position:absolute;min-width:0;min-height:0;border:1.25px solid #000;border-radius:8px;overflow:hidden;background:#fff;container-type:size}.widget>header{height:24px;display:flex;align-items:center;gap:7px;padding:0 8px;border-bottom:1px solid #000}.widget h2{font-size:8px;line-height:1;margin:0;text-transform:uppercase;letter-spacing:1.2px;font-weight:900}.pin{width:6px;height:6px;border-radius:50%;background:var(--accent);border:1px solid #000;flex:none}.widget-body{height:calc(100% - 24px);padding:7px 8px;overflow:hidden}.empty{height:100%;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;gap:4px}.empty b{font-size:12px;text-transform:uppercase;letter-spacing:.5px}.empty span{font-size:8px}.weather-current{height:100%;display:grid;grid-template-columns:auto auto 1fr;grid-template-rows:auto 1fr;align-items:center;gap:2px 8px}.weather-icon{display:block}.temp strong{font-size:27px;line-height:.9;font-weight:300;white-space:nowrap}.temp sup{font-size:10px;font-weight:700;vertical-align:top}.temp span{display:block;font-size:8px;font-weight:700;margin-top:5px}.weather-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px}.weather-metrics div{border-left:1px solid #000;padding-left:6px}.weather-metrics span{display:block;font-size:6px;text-transform:uppercase;letter-spacing:.7px}.weather-metrics b{display:block;font-size:9px;margin-top:2px}.forecast-strip{grid-column:1/-1;align-self:end;display:grid;grid-auto-flow:column;grid-auto-columns:1fr;border-top:1px solid #000;padding-top:4px;min-height:43px}.forecast-day{text-align:center;min-width:0;border-left:1px solid #000;display:grid;grid-template-columns:auto auto;grid-template-rows:10px 1fr 11px;align-items:center;justify-items:center;padding:0 3px}.forecast-day:first-child{border-left:0}.forecast-day>span{grid-column:1/-1;font-size:6px;font-weight:900}.forecast-day .weather-icon{grid-row:2/4}.forecast-day b{font-size:8px}.forecast-day small{font-size:7px}.agenda-list,.task-list,.goal-list,.countdown-list,.market-list,.week-list{height:100%;overflow:hidden}.agenda-row{display:grid;grid-template-columns:52px 8px 1fr;align-items:start;gap:6px;min-height:29px;padding:5px 0;border-bottom:1px solid #000}.agenda-row time{font-size:8px;font-weight:800}.event-dot{width:6px;height:6px;border:1px solid #000;border-radius:50%;margin-top:2px}.event-main b{font-size:10px;display:block}.event-main span{font-size:7px;display:block;margin-top:3px}.week-day{display:grid;grid-template-columns:50px 1fr;min-height:27px;border-bottom:1px solid #000;padding:4px 0}.week-name{font-size:8px;font-weight:800}.week-events{font-size:8px;display:flex;gap:9px;overflow:hidden}.week-events span{white-space:nowrap}.week-events i{display:inline-block;width:6px;height:6px;border-radius:50%;border:1px solid #000;margin-right:4px}.week-events em{font-style:normal}.month-grid{height:100%;display:grid;grid-template-columns:repeat(7,1fr);grid-template-rows:14px repeat(6,1fr);gap:0}.dow{text-align:center;font-size:7px;font-weight:900}.day{border-top:1px solid #000;border-left:1px solid #000;padding:3px;font-size:7px;min-height:0}.day:nth-child(7n+1){border-left:0}.muted-day{opacity:.45}.dots{display:flex;gap:2px;margin-top:5px}.dots i{width:4px;height:4px;border-radius:50%;border:.5px solid #000}.task-row{display:grid;grid-template-columns:12px 4px 1fr auto;gap:6px;align-items:center;min-height:27px;border-bottom:1px solid #000}.check{width:10px;height:10px;border:1px solid #000;border-radius:2px}.priority{width:3px;height:13px;border-radius:2px}.task-row b{font-size:9px;display:block}.task-row small{font-size:7px;display:block;margin-top:2px}.task-row time{font-size:7px;font-weight:700}.goal-row{padding:5px 0 7px;border-bottom:1px solid #000}.goal-head{display:flex;justify-content:space-between;gap:8px;align-items:baseline}.goal-head b{font-size:9px}.goal-head strong{font-size:12px}.goal-row small{display:block;font-size:7px;margin:3px 0}.progress{height:5px;border:1px solid #000;border-radius:4px;overflow:hidden}.progress span{display:block;height:100%}.countdown-row{display:grid;grid-template-columns:4px 1fr auto;gap:7px;align-items:center;min-height:30px;border-bottom:1px solid #000;position:relative}.countdown-row>i{width:4px;height:19px;border-radius:2px}.countdown-row b{font-size:9px;display:block}.countdown-row small{font-size:7px;display:block}.countdown-row>strong{font-size:10px;white-space:nowrap}.countdown-row>.progress{position:absolute;left:11px;right:0;bottom:2px;height:3px}.market-row{display:grid;grid-template-columns:45px minmax(0,1fr) 58px 55px;align-items:center;gap:4px;min-height:25px;border-bottom:1px solid #000}.market-row b{font-size:9px}.market-row span{font-size:7px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.market-row strong{font-size:8px;text-align:right}.market-row em{font-size:8px;font-style:normal;font-weight:900;text-align:right}.style-compact .widget-body{padding-top:5px}.style-compact .task-row,.style-compact .goal-row,.style-compact .countdown-row,.style-compact .market-row{min-height:22px}.footer{position:absolute;left:15px;right:15px;bottom:5px;display:flex;justify-content:space-between;font-size:6px;font-weight:700}@container (min-width:260px) and (min-height:130px){.widget h2{font-size:9px}.widget-body{padding:9px 10px}.temp strong{font-size:38px}.weather-current{grid-template-columns:auto auto 1fr}.agenda-row{min-height:35px;padding:7px 0}.event-main b{font-size:12px}.event-main span{font-size:8px}.agenda-row time{font-size:9px}.task-row{min-height:32px}.task-row b,.goal-head b,.countdown-row b{font-size:10px}.goal-head strong{font-size:16px}.countdown-row>strong{font-size:13px}}@container (max-height:75px){.widget>header{height:20px}.widget-body{height:calc(100% - 20px);padding:4px 7px}.widget h2{font-size:7px}.forecast-strip,.weather-metrics,.event-main span,.task-row small,.goal-row small,.progress{display:none}.weather-current{display:flex;align-items:center;gap:8px}.weather-current .weather-icon{width:28px;height:28px}.temp strong{font-size:21px}.temp span{font-size:7px;margin-top:2px}.agenda-row{min-height:20px;padding:2px 0}.task-row,.countdown-row,.market-row{min-height:20px}.goal-row{padding:2px 0}}';
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width='+w+',initial-scale=1"><style>'+css+'</style></head><body><main class="canvas"><header class="masthead"><div class="brand">Quest Log</div><div class="place">'+esc(short(location,46))+'</div><div class="date">'+esc(now.toLocaleDateString('en-CA',{weekday:'long',month:'long',day:'numeric'}))+'</div><div class="time">'+esc(now.toLocaleTimeString('en-CA',{hour:'numeric',minute:'2-digit'}))+'</div></header><div class="mode">'+esc(modeLabel(mode))+'</div><div class="grid">'+widgets+'</div><footer class="footer"><span>'+w+' × '+h+' · '+(palette==='mono'?'MONO':'SPECTRA 6')+'</span><span>Updated '+esc(new Date(data?.generatedAt||Date.now()).toLocaleTimeString('en-CA',{hour:'numeric',minute:'2-digit'}))+'</span></footer></main></body></html>';
}
