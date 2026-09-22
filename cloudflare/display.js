import {
  num, clamp, en, goalProgress, normalizeSectionLayout, normalizeModeSections,
  normalizeSectionOrder, DISPLAY_MODES, DISPLAY_KEYS
} from './state.js';

const HEX={black:'#000000',white:'#FFFFFF',red:'#FF0000',blue:'#0000FF',green:'#00FF00',yellow:'#FFFF00'};
const ACCENT_COLORS=[HEX.black,HEX.red,HEX.blue,HEX.green,HEX.yellow];
function parseHex(value){
  const match=/^#?([0-9a-f]{6})$/i.exec(String(value||''));
  if(!match)return null;
  const n=parseInt(match[1],16);
  return{r:n>>16,g:(n>>8)&255,b:n&255};
}
function einkAccent(value,palette,fallback='blue'){
  if(palette==='mono')return HEX.black;
  const named=String(value||'').toLowerCase();
  if(named==='purple')return HEX.blue;
  if(HEX[named]&&named!=='white')return HEX[named];
  const rgb=parseHex(value);
  if(!rgb)return HEX[fallback]||HEX.blue;
  let best=HEX[fallback]||HEX.blue,bestDistance=Infinity;
  for(const candidate of ACCENT_COLORS){
    const c=parseHex(candidate),distance=(rgb.r-c.r)**2+(rgb.g-c.g)**2+(rgb.b-c.b)**2;
    if(distance<bestDistance){bestDistance=distance;best=candidate}
  }
  return best;
}
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const short=(value,max=40)=>{const s=String(value??'');return s.length<=max?s:s.slice(0,Math.max(1,max-1))+'…'};
const dateKey=value=>{const d=new Date(value);return Number.isNaN(d.getTime())?'':[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')};
const startOfDay=value=>{const d=new Date(value);d.setHours(0,0,0,0);return d};

function countdownView(item,now=Date.now()){
  const end=new Date(item.end).getTime(),ms=Math.max(0,end-now),totalSeconds=Math.floor(ms/1000);
  const days=Math.floor(totalSeconds/86400),hours=Math.floor((totalSeconds%86400)/3600),minutes=Math.floor((totalSeconds%3600)/60),seconds=totalSeconds%60;
  let progress=0;
  if(item.progressMode==='manual'&&item.progressTotal>0)progress=clamp(item.progressCurrent/item.progressTotal*100,0,100);
  else if(item.progressMode==='time'){
    const start=new Date(item.progressStart||item.created||now).getTime(),span=end-start;
    progress=span>0?clamp((now-start)/span*100,0,100):100;
  }
  return{...item,remaining:{days,hours,minutes,seconds},daysRemaining:Math.ceil(ms/86400000),progress};
}
function taskSort(a,b){
  if(a.status==='done'&&b.status!=='done')return 1;if(a.status!=='done'&&b.status==='done')return-1;
  const ad=a.due?new Date(a.due).getTime():Infinity,bd=b.due?new Date(b.due).getTime():Infinity;
  return ad-bd||String(a.created||'').localeCompare(String(b.created||''));
}
function rangeFor(scope,days=30){
  const now=new Date(),start=startOfDay(now);
  if(scope==='today'){const end=new Date(start);end.setDate(end.getDate()+1);return{start,end}}
  if(scope==='week'){start.setDate(start.getDate()-((start.getDay()+6)%7));const end=new Date(start);end.setDate(end.getDate()+7);return{start,end}}
  if(scope==='month'){const a=new Date(now.getFullYear(),now.getMonth(),1),b=new Date(now.getFullYear(),now.getMonth()+1,1);return{start:a,end:b}}
  return{start:now,end:new Date(now.getTime()+clamp(num(days,30),1,365)*86400000)};
}
export function displayRange(state){
  const mode=en(state.display?.mode,DISPLAY_MODES,'daily');
  const sections=normalizeModeSections(state.display?.modeSections||{})[mode];
  return sections?.agenda?.enabled?rangeFor(sections.agenda.scope,state.google?.countdownWindowDays):null;
}
export function buildDisplayFeed(state,{events=[],weather=null,markets=null,calendarError=null,weatherError=null,marketError=null}={}){
  const mode=en(state.display?.mode,DISPLAY_MODES,'daily'),allSections=normalizeModeSections(state.display?.modeSections||{}),sections=allSections[mode];
  const modeLayouts=state.display?.modeLayouts||{},modeLayout=normalizeSectionLayout(modeLayouts[mode]||state.display?.sectionLayout,mode);
  const now=Date.now(),tasks=[...(state.tasks||[])].sort(taskSort),range=displayRange(state);
  const agendaTasks=range?tasks.filter(task=>{
    if(task.status==='done'||task.displayEnabled===false)return false;
    if(!task.due)return sections.agenda.scope==='today'||sections.agenda.scope==='upcoming';
    const d=new Date(task.due);if(Number.isNaN(d.getTime()))return false;
    return d<startOfDay(new Date())||(d>=range.start&&d<range.end);
  }):[];
  const activeGoals=(state.goals||[]).filter(g=>g.status==='active'&&g.displayEnabled!==false).map(g=>({...g,progress:goalProgress(g)}));
  const countdowns=(state.countdowns||[]).filter(c=>c.displayEnabled!==false&&new Date(c.end).getTime()>now).sort((a,b)=>Number(Boolean(b.pinned))-Number(Boolean(a.pinned))||new Date(a.end)-new Date(b.end)).map(c=>countdownView(c,now));
  return{
    generatedAt:new Date().toISOString(),
    title:state.display?.title||'Today',
    calendarError,weatherError,marketError,weather,markets,
    nextEvent:events.find(e=>new Date(e.end||e.start).getTime()>=now)||null,
    events:sections.agenda.enabled?events.slice(0,sections.agenda.limit):[],
    calendarEvents:sections.agenda.enabled?events.slice(0,250):[],
    agendaTasks:[],
    plannerTasks:(sections.agenda.enabled||sections.tasks.enabled)?tasks.filter(t=>t.status!=='done'&&t.displayEnabled!==false).slice(0,250):[],
    tasks:sections.tasks.enabled?tasks.filter(t=>t.status!=='done'&&t.displayEnabled!==false).slice(0,sections.tasks.limit):[],
    goals:sections.goals.enabled?activeGoals.slice(0,sections.goals.limit):[],
    countdowns:sections.countdowns.enabled?countdowns.slice(0,sections.countdowns.limit):[],
    display:{
      layout:state.display?.layout||'auto',
      palette:state.display?.palette||'spectra6',
      dateWidgetStyle:state.display?.dateWidgetStyle||'plain',
      mode,
      sectionLayoutMode:'custom',
      sectionLayout:normalizeSectionLayout(state.display?.sectionLayout,'dashboard'),
      sectionOrder:normalizeSectionOrder(state.display?.sectionOrder),
      gridCols:24,gridRows:16,
      refreshMinutes:clamp(num(state.display?.refreshMinutes,15),1,1440),
      showAgenda:state.display?.showAgenda!==false,
      showTasks:state.display?.showTasks!==false,
      showGoals:state.display?.showGoals!==false,
      showCountdowns:state.display?.showCountdowns!==false,
      showWeather:sections.weather.enabled,
      weatherStyle:sections.weather.style,
      modeLayout,
      modeSections:sections,
      modeLayouts:state.display?.modeLayouts||{},
      modeSectionsAll:allSections
    }
  };
}

function color(name,palette){return einkAccent(name,palette,'blue')}
function sectionAccent(kind,palette){
  if(palette==='mono')return HEX.black;
  return({agenda:HEX.blue,weather:HEX.yellow,tasks:HEX.green,goals:HEX.blue,countdowns:HEX.red,markets:HEX.green})[kind]||HEX.blue;
}
function sectionTitle(label,x,y,kind,palette){
  const accent=sectionAccent(kind,palette);
  return'<circle cx="'+(x+4)+'" cy="'+(y-4)+'" r="3.5" fill="'+accent+'" stroke="'+HEX.black+'" stroke-width=".8"/><text x="'+(x+14)+'" y="'+y+'" class="k">'+esc(label)+'</text>';
}
function bar(percent,x,y,w,h,fill){
  const p=clamp(num(percent,0),0,100);
  return'<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" rx="'+(h/2)+'" fill="'+HEX.white+'" stroke="'+HEX.black+'" stroke-width="1"/><rect x="'+x+'" y="'+y+'" width="'+(w*p/100).toFixed(1)+'" height="'+h+'" rx="'+(h/2)+'" fill="'+einkAccent(fill,'spectra6','blue')+'"/>';
}
function countdownLabel(c){
  const r=c.remaining||{};
  if(c.timeDisplayStyle==='date')return new Date(c.end).toLocaleDateString('en-CA',{month:'short',day:'numeric'});
  if(c.timeDisplayStyle==='weeks')return Math.floor((r.days||0)/7)+'w '+((r.days||0)%7)+'d';
  if(c.timeDisplayStyle==='compact')return(r.days||0)+'d '+String(r.hours||0).padStart(2,'0')+'h';
  if(c.timeDisplayStyle==='full')return(r.days||0)+'d '+String(r.hours||0).padStart(2,'0')+'h '+String(r.minutes||0).padStart(2,'0')+'m';
  if(c.timeDisplayStyle==='precise')return(r.days||0)+'d '+String(r.hours||0).padStart(2,'0')+'h '+String(r.minutes||0).padStart(2,'0')+'m';
  return(c.daysRemaining??0)+' '+((c.daysRemaining??0)===1?'day':'days');
}
function weatherAccent(condition,palette){
  if(palette==='mono')return HEX.black;
  const t=String(condition||'').toUpperCase();
  if(/THUNDER|STORM/.test(t))return HEX.red;
  if(/RAIN|DRIZZLE|SHOWER|SNOW|ICE/.test(t))return HEX.blue;
  if(/CLEAR|SUN/.test(t))return HEX.yellow;
  if(/CLOUD|FOG|HAZE/.test(t))return HEX.black;
  return HEX.green;
}
function weatherIcon(condition,x,y,size,palette){
  const t=String(condition||'').toUpperCase(),black=HEX.black,white=HEX.white;
  const sunColor=palette==='mono'?black:HEX.yellow,rainColor=palette==='mono'?black:HEX.blue,stormColor=palette==='mono'?black:HEX.red,fogColor=palette==='mono'?black:HEX.green;
  const sw=Math.max(1.2,size*.045),ray=Math.max(1.3,size*.05);
  const cx=x+size*.36,cy=y+size*.34;
  const sun='<circle cx="'+cx+'" cy="'+cy+'" r="'+(size*.18)+'" fill="'+sunColor+'" stroke="'+black+'" stroke-width="'+sw+'"/><path d="M'+cx+' '+y+'v'+(size*.11)+'M'+cx+' '+(y+size*.57)+'v'+(size*.11)+'M'+x+' '+cy+'h'+(size*.11)+'M'+(x+size*.57)+' '+cy+'h'+(size*.11)+'M'+(x+size*.09)+' '+(y+size*.09)+'l'+(size*.08)+' '+(size*.08)+'M'+(x+size*.55)+' '+(y+size*.55)+'l'+(size*.08)+' '+(size*.08)+'M'+(x+size*.55)+' '+(y+size*.09)+'l-'+(size*.08)+' '+(size*.08)+'M'+(x+size*.09)+' '+(y+size*.55)+'l'+(size*.08)+'-'+(size*.08)+'" stroke="'+black+'" stroke-width="'+ray+'" stroke-linecap="round"/>';
  const cloud='<path d="M'+(x+size*.13)+' '+(y+size*.61)+'c0-'+(size*.13)+' '+(size*.10)+'-'+(size*.23)+' '+(size*.24)+'-'+(size*.24)+' '+(size*.05)+'-'+(size*.14)+' '+(size*.17)+'-'+(size*.22)+' '+(size*.32)+'-'+(size*.22)+' '+(size*.20)+' 0 '+(size*.37)+' '+(size*.15)+' '+(size*.39)+' '+(size*.34)+' '+(size*.15)+' '+(size*.02)+' '+(size*.27)+' '+(size*.14)+' '+(size*.27)+' '+(size*.29)+' 0 '+(size*.17)+'-'+(size*.14)+' '+(size*.30)+'-'+(size*.31)+' '+(size*.30)+'H'+(x+size*.35)+'c-'+(size*.12)+' 0-'+(size*.22)+'-'+(size*.10)+'-'+(size*.22)+'-'+(size*.22)+'z" fill="'+white+'" stroke="'+black+'" stroke-width="'+sw+'" stroke-linejoin="round"/>';
  if(/CLEAR|SUN/.test(t)&&!/CLOUD|PARTLY|MOSTLY/.test(t))return sun;
  if(/THUNDER|STORM/.test(t))return cloud+'<path d="M'+(x+size*.48)+' '+(y+size*.72)+'h'+(size*.14)+'l-'+(size*.10)+' '+(size*.16)+'h'+(size*.11)+'l-'+(size*.22)+' '+(size*.23)+' '+(size*.06)+'-'+(size*.19)+'h-'+(size*.11)+'z" fill="'+stormColor+'" stroke="'+black+'" stroke-width="'+Math.max(.7,size*.025)+'" stroke-linejoin="round"/>';
  if(/RAIN|DRIZZLE|SHOWER/.test(t))return cloud+'<path d="M'+(x+size*.30)+' '+(y+size*.78)+'l-'+(size*.035)+' '+(size*.10)+'M'+(x+size*.50)+' '+(y+size*.78)+'l-'+(size*.035)+' '+(size*.10)+'M'+(x+size*.70)+' '+(y+size*.78)+'l-'+(size*.035)+' '+(size*.10)+'" stroke="'+rainColor+'" stroke-width="'+Math.max(1.5,size*.055)+'" stroke-linecap="round"/>';
  if(/SNOW|ICE|SLEET/.test(t)){
    const r=size*.045,yy=y+size*.86;
    return cloud+'<g stroke="'+rainColor+'" stroke-width="'+Math.max(1,size*.035)+'" stroke-linecap="round"><path d="M'+(x+size*.30-r)+' '+yy+'h'+(r*2)+'M'+(x+size*.30)+' '+(yy-r)+'v'+(r*2)+'M'+(x+size*.50-r)+' '+yy+'h'+(r*2)+'M'+(x+size*.50)+' '+(yy-r)+'v'+(r*2)+'M'+(x+size*.70-r)+' '+yy+'h'+(r*2)+'M'+(x+size*.70)+' '+(yy-r)+'v'+(r*2)+'"/></g>';
  }
  if(/FOG|HAZE|MIST/.test(t))return cloud+'<path d="M'+(x+size*.20)+' '+(y+size*.80)+'h'+(size*.55)+'M'+(x+size*.27)+' '+(y+size*.90)+'h'+(size*.45)+'" stroke="'+fogColor+'" stroke-width="'+Math.max(1.3,size*.045)+'" stroke-linecap="round"/>';
  if(/PARTLY|MOSTLY.*CLOUD|CLOUD.*SUN/.test(t))return sun+cloud;
  return cloud;
}
function agendaEntries(data){
  return(data.calendarEvents||data.events||[]).map(event=>({kind:'event',when:new Date(event.start).getTime(),event})).sort((a,b)=>a.when-b.when);
}
function eventsForDay(data,day){
  const a=startOfDay(day),b=new Date(a);b.setDate(b.getDate()+1);
  return(data.calendarEvents||data.events||[]).filter(e=>new Date(e.start)<b&&new Date(e.end||e.start)>a);
}
function tasksForDay(data,day){
  const key=dateKey(day);return(data.agendaTasks||data.plannerTasks||data.tasks||[]).filter(t=>t.status!=='done'&&t.due&&dateKey(t.due)===key);
}
function eventAccent(event,palette){
  return einkAccent(event.eventColor||event.calendarColor,palette,'blue');
}
function money(value){const n=Number(value);return Number.isFinite(n)?n.toFixed(2):'N/A'}


function renderDashboardSvg(data,w,h){
  const palette=data.display?.palette||'spectra6',black=HEX.black,white=HEX.white,rule=HEX.black;
  const pad=Math.max(13,Math.round(Math.min(w,h)*.028)),headerH=Math.max(47,Math.round(h*.105)),top=pad+headerH,contentW=w-pad*2,contentH=h-top-pad-3;
  const sections=data.display?.modeSections||{},layout=normalizeSectionLayout(data.display?.modeLayout,'dashboard'),order=normalizeSectionOrder(data.display?.sectionOrder);
  const sectionData={agenda:agendaEntries(data),weather:data.weather?[data.weather]:[],tasks:data.tasks||[],goals:data.goals||[],countdowns:data.countdowns||[],markets:data.markets?.quotes||[]};
  const labels={agenda:'AGENDA',weather:'WEATHER',tasks:'TASKS',goals:'GOALS',countdowns:'COUNTDOWNS',markets:'MARKETS'};
  const now=new Date(),location=data.weather?.location||data.weather?.locationLabel||'',dateText=now.toLocaleDateString('en-CA',{weekday:'long',month:'long',day:'numeric'}),timeText=now.toLocaleTimeString('en-CA',{hour:'numeric',minute:'2-digit'});
  const density=(bw,bh)=>bw>=255&&bh>=145?'hero':bw>=155&&bh>=86?'standard':'compact';
  const taskAccent=task=>palette==='mono'?black:({urgent:HEX.red,high:HEX.red,medium:HEX.yellow,low:HEX.green})[String(task?.priority||'').toLowerCase()]||HEX.black;
  const goalMetric=goal=>{
    if(goal?.type==='checklist'){const total=goal.checklist?.length||0,done=(goal.checklist||[]).filter(item=>item.done).length;return done+'/'+total+' steps'}
    if(goal?.type==='deadline'&&goal.deadline)return'Due '+new Date(goal.deadline).toLocaleDateString('en-CA',{month:'short',day:'numeric'});
    if(num(goal?.target,0)>0)return num(goal.current,0)+'/'+num(goal.target,0)+(goal.unit?' '+goal.unit:'');
    return'';
  };
  const metric=(label,value,x,y,maxW)=>{
    if(value===undefined||value===null||value==='')return'';
    const text=String(value),ww=Math.min(maxW,Math.max(42,(label.length+text.length)*4.8+14));
    return'<text x="'+x+'" y="'+y+'" font-size="6.8" font-weight="800" letter-spacing=".7">'+esc(label.toUpperCase())+'</text><text x="'+x+'" y="'+(y+12)+'" font-size="9.5" font-weight="800">'+esc(text)+'</text><line x1="'+x+'" y1="'+(y+17)+'" x2="'+(x+ww)+'" y2="'+(y+17)+'" stroke="'+rule+'" stroke-width=".7"/>';
  };
  const trend=(days,x,y,bw,bh)=>{
    const vals=days.flatMap(d=>[num(d.high,NaN),num(d.low,NaN)]).filter(Number.isFinite);
    if(days.length<2||!vals.length)return'';
    const min=Math.min(...vals),max=Math.max(...vals),span=Math.max(1,max-min),step=bw/Math.max(1,days.length-1);
    const points=(key)=>days.map((d,i)=>{const v=num(d[key],min);return(x+i*step).toFixed(1)+','+(y+bh-(v-min)/span*bh).toFixed(1)}).join(' ');
    return'<polyline points="'+points('high')+'" fill="none" stroke="'+(palette==='mono'?black:HEX.red)+'" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><polyline points="'+points('low')+'" fill="none" stroke="'+(palette==='mono'?black:HEX.blue)+'" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>';
  };

  let svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'"><rect width="100%" height="100%" fill="'+white+'"/><style>text{font-family:Arial,Helvetica,sans-serif}.dash-card{fill:#fff;stroke:#000;stroke-width:1}.dash-rule{stroke:#000;stroke-width:.8}.dash-muted{fill:#000}.dash-label{font-size:9px;font-weight:800;letter-spacing:1.2px}</style>';
  svg+='<rect x="5" y="5" width="'+(w-10)+'" height="'+(h-10)+'" rx="11" fill="none" stroke="'+black+'" stroke-width="1"/>';
  svg+='<text x="'+pad+'" y="'+(pad+11)+'" font-size="8" font-weight="900" letter-spacing="1.6">QUEST LOG</text>';
  svg+='<text x="'+pad+'" y="'+(pad+30)+'" font-size="'+Math.max(15,Math.min(20,w*.023))+'" font-weight="900">'+esc(dateText)+'</text>';
  if(location)svg+='<text x="'+(w-pad)+'" y="'+(pad+11)+'" text-anchor="end" font-size="8.5" font-weight="700">'+esc(short(location,36))+'</text>';
  svg+='<text x="'+(w-pad)+'" y="'+(pad+31)+'" text-anchor="end" font-size="'+Math.max(15,Math.min(20,w*.022))+'" font-weight="900">'+esc(timeText)+'</text>';
  svg+='<line x1="'+pad+'" y1="'+(top-8)+'" x2="'+(w-pad)+'" y2="'+(top-8)+'" stroke="'+black+'" stroke-width="1"/>';
  if(palette!=='mono')svg+='<line x1="'+pad+'" y1="'+(top-8)+'" x2="'+(pad+52)+'" y2="'+(top-8)+'" stroke="'+HEX.blue+'" stroke-width="3"/><line x1="'+(pad+57)+'" y1="'+(top-8)+'" x2="'+(pad+82)+'" y2="'+(top-8)+'" stroke="'+HEX.yellow+'" stroke-width="3"/>';

  const defs=[],queue=[];
  for(const kind of order){
    if(!DISPLAY_KEYS.includes(kind)||sections[kind]?.enabled===false)continue;
    const r=layout[kind],x=pad+contentW*r.x/24,y=top+contentH*r.y/16,bw=contentW*r.w/24,bh=contentH*r.h/16,inset=Math.max(7,Math.min(11,Math.round(Math.min(bw,bh)*.045))),clip='dash-'+kind;
    defs.push('<clipPath id="'+clip+'"><rect x="'+(x+1)+'" y="'+(y+1)+'" width="'+Math.max(1,bw-2)+'" height="'+Math.max(1,bh-2)+'" rx="8"/></clipPath>');
    queue.push({kind,x,y,bw,bh,inset,clip,density:density(bw,bh)});
  }
  if(defs.length)svg+='<defs>'+defs.join('')+'</defs>';

  for(const box of queue){
    const kind=box.kind,items=sectionData[kind]||[],cfg=sections[kind]||{},accent=sectionAccent(kind,palette),x=box.x+box.inset,y=box.y+box.inset,bw=Math.max(20,box.bw-box.inset*2),bh=Math.max(20,box.bh-box.inset*2),level=box.density;
    svg+='<rect x="'+box.x+'" y="'+box.y+'" width="'+box.bw+'" height="'+box.bh+'" rx="8" class="dash-card"/>';
    svg+='<rect x="'+(box.x+9)+'" y="'+(box.y+10)+'" width="5" height="5" rx="1.5" fill="'+accent+'" stroke="'+black+'" stroke-width=".55"/>';
    svg+='<text x="'+(box.x+20)+'" y="'+(box.y+16)+'" class="dash-label">'+labels[kind]+'</text>';
    if(box.bw>120)svg+='<text x="'+(box.x+box.bw-9)+'" y="'+(box.y+16)+'" text-anchor="end" font-size="7.5" font-weight="700">'+esc(kind==='weather'?(data.weather?.forecast?.length||0)+' day':items.length+' item'+(items.length===1?'':'s'))+'</text>';
    svg+='<line x1="'+(box.x+9)+'" y1="'+(box.y+25)+'" x2="'+(box.x+box.bw-9)+'" y2="'+(box.y+25)+'" class="dash-rule"/><g clip-path="url(#'+box.clip+')">';
    let cy=box.y+31;
    const bottom=box.y+box.bh-box.inset;

    if(!items.length){
      const msg=kind==='weather'&&data.weatherError?data.weatherError:kind==='markets'&&data.marketError?data.marketError:kind==='agenda'&&data.calendarError?data.calendarError:'Nothing to show.';
      svg+='<text x="'+x+'" y="'+(cy+18)+'" font-size="10" font-weight="650">'+esc(short(msg,Math.max(12,Math.floor(bw/5.8))))+'</text></g>';continue;
    }

    if(kind==='weather'){
      const weather=data.weather,current=weather?.current,days=(weather?.forecast||[]).slice(0,Math.min(cfg.limit||5,5)),unit=weather?.units==='imperial'?'°F':'°C';
      if(current){
        if(level==='hero'){
          const iconSize=Math.min(60,Math.max(46,bh*.28)),tempX=x+iconSize+12;
          svg+=weatherIcon(current.condition,x,cy+5,iconSize,palette);
          svg+='<text x="'+tempX+'" y="'+(cy+39)+'" font-size="'+Math.min(40,Math.max(30,bw*.105))+'" font-weight="300">'+esc(Math.round(num(current.temperature,0))+unit)+'</text>';
          svg+='<text x="'+tempX+'" y="'+(cy+56)+'" font-size="10" font-weight="700">'+esc(short(current.description||'',Math.max(12,Math.floor((bw-iconSize-15)/6))))+'</text>';
          let mx=Math.max(tempX+bw*.22,x+bw*.52),my=cy+10;
          svg+=metric('Feels',Math.round(num(current.feelsLike,current.temperature))+unit,mx,my,70);
          svg+=metric('Humidity',Math.round(num(current.humidity,0))+'%',mx+82,my,76);
          svg+=metric('Wind',Math.round(num(current.windSpeed,0))+(weather.units==='imperial'?' mph':' km/h'),mx,my+35,74);
          if(days.length>=2&&bottom-cy>125)svg+=trend(days,x,cy+76,bw,22);
          const fy=Math.min(bottom-53,cy+105),cellW=bw/Math.max(1,days.length);
          days.forEach((d,i)=>{
            const dx=x+i*cellW;
            if(i)svg+='<line x1="'+dx+'" y1="'+fy+'" x2="'+dx+'" y2="'+(fy+46)+'" class="dash-rule"/>';
            svg+='<text x="'+(dx+cellW/2)+'" y="'+(fy+9)+'" text-anchor="middle" font-size="7.5" font-weight="800">'+esc(i===0?'TODAY':new Date(d.date+'T12:00:00').toLocaleDateString('en-CA',{weekday:'short'}).toUpperCase())+'</text>';
            svg+=weatherIcon(d.condition,dx+cellW/2-11,fy+13,22,palette);
            svg+='<text x="'+(dx+cellW/2)+'" y="'+(fy+43)+'" text-anchor="middle" font-size="9" font-weight="800">'+esc(Math.round(num(d.high,0))+'° / '+Math.round(num(d.low,0))+'°')+'</text>';
          });
        }else if(level==='standard'){
          svg+=weatherIcon(current.condition,x,cy+4,38,palette)+'<text x="'+(x+47)+'" y="'+(cy+29)+'" font-size="26" font-weight="350">'+esc(Math.round(num(current.temperature,0))+unit)+'</text><text x="'+(x+47)+'" y="'+(cy+44)+'" font-size="8.5" font-weight="700">'+esc(short(current.description||'',Math.max(10,Math.floor((bw-50)/5.5))))+'</text>';
          const fy=cy+56,cellW=bw/Math.max(1,Math.min(3,days.length));
          days.slice(0,3).forEach((d,i)=>{const dx=x+i*cellW;if(i)svg+='<line x1="'+dx+'" y1="'+fy+'" x2="'+dx+'" y2="'+Math.min(bottom,fy+35)+'" class="dash-rule"/>';svg+='<text x="'+(dx+cellW/2)+'" y="'+(fy+9)+'" text-anchor="middle" font-size="7" font-weight="800">'+esc(i===0?'TODAY':new Date(d.date+'T12:00:00').toLocaleDateString('en-CA',{weekday:'short'}).toUpperCase())+'</text>'+weatherIcon(d.condition,dx+cellW/2-8,fy+12,16,palette)+'<text x="'+(dx+cellW/2)+'" y="'+(fy+34)+'" text-anchor="middle" font-size="8">'+esc(Math.round(num(d.high,0))+'° / '+Math.round(num(d.low,0))+'°')+'</text>'});
        }else{
          svg+=weatherIcon(current.condition,x,cy+6,28,palette)+'<text x="'+(x+36)+'" y="'+(cy+26)+'" font-size="20" font-weight="400">'+esc(Math.round(num(current.temperature,0))+unit)+'</text><text x="'+(x+90)+'" y="'+(cy+25)+'" font-size="8.5" font-weight="700">'+esc(short(current.description||'',Math.max(9,Math.floor((bw-92)/5.5))))+'</text>';
        }
      }
    }else if(kind==='agenda'){
      const max=cfg.limit||12,timeline=cfg.style==='timeline';
      if(cfg.style==='week'||cfg.style==='calendar'){
        const entries=items.slice(0,Math.min(max,level==='compact'?3:level==='standard'?5:7));
        for(const entry of entries){if(cy+26>bottom)break;const event=entry.event,d=new Date(event.start),when=event.allDay?'All day':d.toLocaleTimeString('en-CA',{hour:'numeric',minute:'2-digit'}),a=eventAccent(event,palette);svg+='<text x="'+x+'" y="'+(cy+15)+'" font-size="8.5" font-weight="800">'+esc(when)+'</text><circle cx="'+(x+48)+'" cy="'+(cy+11)+'" r="3" fill="'+a+'" stroke="'+black+'" stroke-width=".55"/><text x="'+(x+58)+'" y="'+(cy+15)+'" font-size="10.5" font-weight="750">'+esc(short(event.title,Math.max(12,Math.floor((bw-60)/6))))+'</text>';cy+=25}
      }else{
        if(level==='hero')svg+='<line x1="'+(x+55)+'" y1="'+(cy+3)+'" x2="'+(x+55)+'" y2="'+(bottom-3)+'" class="dash-rule"/>';
        for(const entry of items.slice(0,max)){const row=level==='hero'?36:level==='standard'?29:24;if(cy+row>bottom)break;const event=entry.event,d=new Date(event.start),when=event.allDay?'ALL DAY':d.toLocaleTimeString('en-CA',{hour:'numeric',minute:'2-digit'}),a=eventAccent(event,palette);if(level==='hero'){svg+='<text x="'+x+'" y="'+(cy+15)+'" font-size="8.5" font-weight="800">'+esc(when)+'</text><circle cx="'+(x+55)+'" cy="'+(cy+11)+'" r="3.2" fill="'+a+'" stroke="'+black+'" stroke-width=".55"/><text x="'+(x+66)+'" y="'+(cy+14)+'" font-size="11.5" font-weight="800">'+esc(short(event.title,Math.max(12,Math.floor((bw-68)/6))))+'</text>';const detail=String(event.location||event.calendarName||event.calendarSummary||'').trim();if(detail)svg+='<text x="'+(x+66)+'" y="'+(cy+27)+'" font-size="7.7">'+esc(short(detail,Math.max(10,Math.floor((bw-68)/5))))+'</text>'}else{svg+='<circle cx="'+(x+3)+'" cy="'+(cy+11)+'" r="2.6" fill="'+a+'" stroke="'+black+'" stroke-width=".5"/><text x="'+(x+11)+'" y="'+(cy+15)+'" font-size="'+(level==='compact'?9:10.5)+'" font-weight="750">'+esc(short(event.title,Math.max(10,Math.floor((bw-64)/5.8))))+'</text><text x="'+(x+bw)+'" y="'+(cy+15)+'" text-anchor="end" font-size="8">'+esc(when)+'</text>'}cy+=row}
      }
    }else if(kind==='tasks'){
      for(const task of items.slice(0,cfg.limit||4)){const row=level==='hero'?36:level==='standard'?28:23;if(cy+row>bottom)break;const due=task.due?new Date(task.due).toLocaleDateString('en-CA',{month:'short',day:'numeric'}):'',a=taskAccent(task);svg+='<rect x="'+x+'" y="'+(cy+5)+'" width="10" height="10" rx="2.5" fill="'+white+'" stroke="'+black+'" stroke-width=".9"/><rect x="'+(x+17)+'" y="'+(cy+6)+'" width="3" height="9" rx="1.5" fill="'+a+'"/><text x="'+(x+27)+'" y="'+(cy+14)+'" font-size="'+(level==='compact'?9:10.5)+'" font-weight="750">'+esc(short(task.title,Math.max(10,Math.floor((bw-(due?62:28))/5.8))))+'</text>';if(due)svg+='<text x="'+(x+bw)+'" y="'+(cy+14)+'" text-anchor="end" font-size="8" font-weight="700">'+esc(due)+'</text>';if(level==='hero'&&task.project)svg+='<text x="'+(x+27)+'" y="'+(cy+27)+'" font-size="7.5">'+esc(short(task.project,Math.max(10,Math.floor((bw-28)/5))))+'</text>';cy+=row}
    }else if(kind==='goals'){
      for(const goal of items.slice(0,cfg.limit||2)){const row=level==='hero'?50:level==='standard'?39:28;if(cy+row>bottom)break;const p=Math.round(num(goal.progress,0)),a=color(goal.accentColor,palette),m=goalMetric(goal);svg+='<text x="'+x+'" y="'+(cy+14)+'" font-size="'+(level==='compact'?9.5:10.5)+'" font-weight="800">'+esc(short(goal.title,Math.max(10,Math.floor((bw-46)/5.8))))+'</text><text x="'+(x+bw)+'" y="'+(cy+14)+'" text-anchor="end" font-size="'+(level==='hero'?15:11)+'" font-weight="900">'+p+'%</text>';if(level!=='compact'){if(m)svg+='<text x="'+x+'" y="'+(cy+27)+'" font-size="7.5">'+esc(short(m,Math.max(10,Math.floor(bw/5))))+'</text>';svg+=bar(p,x,cy+(level==='hero'?35:27),bw,level==='hero'?6:5,a)}cy+=row}
    }else if(kind==='countdowns'){
      for(const c of items.slice(0,cfg.limit||3)){const row=level==='hero'?48:level==='standard'?36:25;if(cy+row>bottom)break;const a=color(c.accentColor,palette),label=countdownLabel(c);if(level==='hero'){svg+='<text x="'+x+'" y="'+(cy+17)+'" font-size="10.5" font-weight="800">'+esc(short(c.name,Math.max(10,Math.floor((bw-90)/5.8))))+'</text><text x="'+(x+bw)+'" y="'+(cy+19)+'" text-anchor="end" font-size="18" font-weight="300" fill="'+a+'">'+esc(label)+'</text>';if(c.showExactDate!==false)svg+='<text x="'+x+'" y="'+(cy+31)+'" font-size="7.5">'+esc(new Date(c.end).toLocaleDateString('en-CA',{month:'short',day:'numeric',year:'numeric'}))+'</text>';if(c.showProgressBar!==false)svg+=bar(c.progress,x,cy+38,bw,4,a)}else{svg+='<rect x="'+x+'" y="'+(cy+5)+'" width="3" height="'+(row-10)+'" rx="1.5" fill="'+a+'"/><text x="'+(x+10)+'" y="'+(cy+15)+'" font-size="'+(level==='compact'?9:10.5)+'" font-weight="800">'+esc(short(c.name,Math.max(10,Math.floor((bw-72)/5.8))))+'</text><text x="'+(x+bw)+'" y="'+(cy+15)+'" text-anchor="end" font-size="'+(level==='compact'?9:11)+'" font-weight="900">'+esc(label)+'</text>'}cy+=row}
    }else if(kind==='markets'){
      for(const q of items.slice(0,cfg.limit||4)){const row=level==='hero'?32:level==='standard'?27:22;if(cy+row>bottom)break;const pct=Number(q.percentChange),ok=q.available!==false&&q.close!=null,change=ok&&Number.isFinite(pct)?pct:null,a=palette==='mono'?black:(change>0?HEX.green:change<0?HEX.red:black),arrow=change>0?'▲':change<0?'▼':'•';svg+='<text x="'+x+'" y="'+(cy+15)+'" font-size="'+(level==='compact'?9:10.5)+'" font-weight="900">'+esc(q.symbol)+'</text>';if(level==='hero'&&q.name)svg+='<text x="'+(x+48)+'" y="'+(cy+15)+'" font-size="7.5">'+esc(short(q.name,Math.max(8,Math.floor((bw-145)/5))))+'</text>';svg+='<text x="'+(x+bw-55)+'" y="'+(cy+15)+'" text-anchor="end" font-size="'+(level==='compact'?8.5:10)+'" font-weight="750">'+esc(ok?money(q.close):'N/A')+'</text><text x="'+(x+bw)+'" y="'+(cy+15)+'" text-anchor="end" font-size="'+(level==='compact'?8:9.5)+'" font-weight="900" fill="'+a+'">'+(ok?arrow+' '+esc(Math.abs(change||0).toFixed(2))+'%':'—')+'</text>';if(level!=='compact'){const mid=x+bw-48,span=Math.min(38,Math.abs(change||0)*10+6);svg+='<line x1="'+mid+'" y1="'+(cy+23)+'" x2="'+(mid+span)+'" y2="'+(cy+23)+'" stroke="'+a+'" stroke-width="2" stroke-linecap="round"/>'}cy+=row}
    }
    svg+='</g>';
  }
  svg+='<text x="'+pad+'" y="'+(h-9)+'" font-size="7" font-weight="700">800 × 480 · SPECTRA 6 READY</text><text x="'+(w-pad)+'" y="'+(h-9)+'" text-anchor="end" font-size="7">Updated '+esc(new Date(data.generatedAt).toLocaleTimeString('en-CA',{hour:'numeric',minute:'2-digit'}))+'</text></svg>';
  return svg;
}

export function renderDisplaySvg(data,width=800,height=480){
  const w=clamp(Math.round(num(width,800)),300,2000),h=clamp(Math.round(num(height,480)),300,2000),palette=data.display?.palette||'spectra6';
  if((data.display?.mode||'daily')==='dashboard')return renderDashboardSvg(data,w,h);
  const pad=Math.max(12,Math.round(Math.min(w,h)*.026)),top=pad+31,available=h-top-18,contentWidth=w-pad*2,black=HEX.black,muted=HEX.black,rule=HEX.black;
  const now=new Date(),mode=data.display?.mode||'daily',modeLabel=({dashboard:'DASHBOARD',daily:'DAY',weekly:'WEEK',monthly:'MONTH',countdowns:'COUNTDOWNS'})[mode]||'PLANNER';
  let svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'"><rect width="100%" height="100%" fill="#FFFFFF"/><style>text{font-family:Arial,Helvetica,sans-serif}.k{font-size:11px;font-weight:750;letter-spacing:1.35px}.muted{fill:'+muted+'}.line{stroke:'+rule+';stroke-width:1}.section-box{fill:#fff;stroke:'+rule+';stroke-width:1.1}</style>';
  const frameA=palette==='mono'?black:HEX.blue,frameB=palette==='mono'?black:HEX.yellow;
  svg+='<rect x="4.5" y="4.5" width="'+(w-9)+'" height="'+(h-9)+'" rx="13" fill="none" stroke="'+black+'" stroke-width="1.2"/>';
  svg+='<path d="M9 18V9h9M'+(w-18)+' 9h9v9M9 '+(h-18)+'v9h9M'+(w-18)+' '+(h-9)+'h9v-9" fill="none" stroke="'+frameA+'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
  svg+='<circle cx="9" cy="'+(h/2)+'" r="2.1" fill="'+frameB+'" stroke="'+black+'" stroke-width=".7"/><circle cx="'+(w-9)+'" cy="'+(h/2)+'" r="2.1" fill="'+frameB+'" stroke="'+black+'" stroke-width=".7"/>';
  svg+='<text x="'+pad+'" y="'+(pad+15)+'" font-size="12" font-weight="800" letter-spacing="1">'+esc(now.toLocaleDateString('en-CA',{weekday:'short',month:'short',day:'numeric',year:'numeric'}).toUpperCase())+'</text>';
  svg+='<text x="'+(w-pad)+'" y="'+(pad+15)+'" text-anchor="end" font-size="11" font-weight="800" letter-spacing="1">'+esc(modeLabel+' · '+now.toLocaleTimeString('en-CA',{hour:'numeric',minute:'2-digit'}))+'</text>';
  svg+='<line x1="'+pad+'" y1="'+(pad+23)+'" x2="'+(w-pad)+'" y2="'+(pad+23)+'" class="line"/>';

  const sections=data.display?.modeSections||{},layout=normalizeSectionLayout(data.display?.modeLayout,mode),order=normalizeSectionOrder(data.display?.sectionOrder);
  const sectionData={agenda:agendaEntries(data),weather:data.weather?[data.weather]:[],tasks:data.tasks||[],goals:data.goals||[],countdowns:data.countdowns||[],markets:data.markets?.quotes||[]};
  const defs=[],queue=[];
  for(const kind of order){
    if(!DISPLAY_KEYS.includes(kind)||sections[kind]?.enabled===false)continue;
    const r=layout[kind],x=pad+contentWidth*r.x/24,y=top+available*r.y/16,bw=contentWidth*r.w/24,bh=available*r.h/16,inset=Math.max(5,Math.min(9,Math.round(Math.min(bw,bh)*.035))),clip='clip-'+kind;
    defs.push('<clipPath id="'+clip+'"><rect x="'+(x+inset)+'" y="'+(y+inset)+'" width="'+Math.max(1,bw-inset*2)+'" height="'+Math.max(1,bh-inset*2)+'" rx="4"/></clipPath>');
    queue.push({kind,x,y,bw,bh,inset,clip});
  }
  if(defs.length)svg+='<defs>'+defs.join('')+'</defs>';

  for(const box of queue){
    const cardAccent=sectionAccent(box.kind,palette),cardDetail=Math.min(30,Math.max(14,box.bw*.13));
    svg+='<rect x="'+box.x+'" y="'+box.y+'" width="'+box.bw+'" height="'+box.bh+'" rx="9" class="section-box"/><path d="M'+(box.x+11)+' '+(box.y+1.2)+'h'+cardDetail+'" stroke="'+cardAccent+'" stroke-width="2.4" stroke-linecap="round"/><g clip-path="url(#'+box.clip+')">';
    const x=box.x+box.inset,y=box.y+box.inset,bw=Math.max(20,box.bw-box.inset*2),bh=Math.max(20,box.bh-box.inset*2),kind=box.kind,items=sectionData[kind]||[],cfg=sections[kind]||{};
    svg+=sectionTitle(({agenda:'AGENDA',weather:'WEATHER',tasks:'TASKS',goals:'GOALS',countdowns:'COUNTDOWNS',markets:'MARKETS'})[kind],x,y+11,kind,palette);
    let cy=y+22;
    if(!items.length){svg+='<text x="'+x+'" y="'+(cy+15)+'" font-size="12" class="muted">'+esc(kind==='weather'&&data.weatherError?data.weatherError:kind==='markets'&&data.marketError?data.marketError:kind==='agenda'&&data.calendarError?data.calendarError:'Nothing to show.')+'</text>';svg+='</g>';continue}

    if(kind==='agenda'){
      if(cfg.style==='week'){
        const monday=startOfDay(now);monday.setDate(monday.getDate()-((monday.getDay()+6)%7));const rowH=Math.max(22,Math.min(40,(bh-25)/7));
        for(let i=0;i<7&&cy+rowH<=y+bh;i++){
          const day=new Date(monday);
          day.setDate(day.getDate()+i);
          const entries=eventsForDay(data,day).map(event=>({kind:'event',event})).slice(0,2);
          svg+='<line x1="'+x+'" y1="'+cy+'" x2="'+(x+bw)+'" y2="'+cy+'" class="line"/><text x="'+x+'" y="'+(cy+15)+'" font-size="9" font-weight="800">'+esc(day.toLocaleDateString('en-CA',{weekday:'short'}).toUpperCase()+' '+day.getDate())+'</text>';
          let tx=x+58;for(const e of entries){svg+='<circle cx="'+tx+'" cy="'+(cy+11)+'" r="3" fill="'+eventAccent(e.event,palette)+'"/><text x="'+(tx+7)+'" y="'+(cy+15)+'" font-size="9.5">'+esc(short(e.event.title,Math.max(10,Math.floor((bw-(tx-x))/7))))+'</text>';tx+=Math.max(90,bw*.42)}cy+=rowH;
        }
      }else if(cfg.style==='calendar'){
        const first=new Date(now.getFullYear(),now.getMonth(),1),offset=(first.getDay()+6)%7,start=new Date(first);
        start.setDate(start.getDate()-offset);
        const cellW=bw/7,cellH=Math.max(24,Math.min(48,(bh-38)/6));
        ['M','T','W','T','F','S','S'].forEach((d,i)=>svg+='<text x="'+(x+i*cellW+cellW/2)+'" y="'+(cy+9)+'" text-anchor="middle" font-size="7.5" font-weight="800" class="muted">'+d+'</text>');cy+=13;
        for(let i=0;i<42;i++){const day=new Date(start);day.setDate(start.getDate()+i);const col=i%7,row=Math.floor(i/7),cx=x+col*cellW,yy=cy+row*cellH;if(yy+cellH>y+bh)break;svg+='<rect x="'+cx+'" y="'+yy+'" width="'+cellW+'" height="'+cellH+'" fill="none" stroke="'+rule+'"/><text x="'+(cx+4)+'" y="'+(yy+11)+'" font-size="8">'+day.getDate()+'</text>';const ev=eventsForDay(data,day).slice(0,3);ev.forEach((e,j)=>svg+='<circle cx="'+(cx+6+j*8)+'" cy="'+(yy+cellH-6)+'" r="2.5" fill="'+eventAccent(e,palette)+'"/>')}
      }else{
        const timeline=cfg.style==='timeline';
        for(const entry of items.slice(0,cfg.limit||12)){
          if(cy+31>y+bh)break;
          const d=new Date(entry.event.start),when=entry.event.allDay?'All day':d.toLocaleTimeString('en-CA',{hour:'numeric',minute:'2-digit'}),accent=eventAccent(entry.event,palette);
          svg+='<line x1="'+x+'" y1="'+cy+'" x2="'+(x+bw)+'" y2="'+cy+'" class="line"/>';
          if(timeline){
            svg+='<text x="'+x+'" y="'+(cy+20)+'" font-size="10" class="muted">'+esc(when)+'</text><circle cx="'+(x+61)+'" cy="'+(cy+16)+'" r="4" fill="'+accent+'"/><text x="'+(x+72)+'" y="'+(cy+20)+'" font-size="13" font-weight="700">'+esc(short(entry.event.title,Math.max(12,Math.floor((bw-74)/7))))+'</text>';
          }else{
            svg+='<circle cx="'+(x+4)+'" cy="'+(cy+16)+'" r="4" fill="'+accent+'"/><text x="'+(x+14)+'" y="'+(cy+20)+'" font-size="13" font-weight="700">'+esc(short(entry.event.title,Math.max(12,Math.floor((bw-86)/7))))+'</text><text x="'+(x+bw)+'" y="'+(cy+20)+'" text-anchor="end" font-size="10" class="muted">'+esc(when)+'</text>';
          }
          cy+=30;
        }
      }
    }else if(kind==='weather'){
      const weather=data.weather,current=weather?.current,forecast=weather?.forecast||[],unit=weather?.units==='imperial'?'°F':'°C';
      if(current){
        if(cfg.style==='compact'){
          svg+=weatherIcon(current.condition,x,cy,30,palette)+'<text x="'+(x+38)+'" y="'+(cy+20)+'" font-size="18" font-weight="800">'+esc(Math.round(num(current.temperature,0))+unit)+'</text><text x="'+(x+98)+'" y="'+(cy+20)+'" font-size="10" class="muted">'+esc(short(current.description||'',Math.max(12,Math.floor((bw-100)/6))))+'</text>';
          cy+=34;
        }else if(cfg.style==='current'){
          svg+=weatherIcon(current.condition,x,cy,40,palette)+'<text x="'+(x+50)+'" y="'+(cy+25)+'" font-size="24" font-weight="800">'+esc(Math.round(num(current.temperature,0))+unit)+'</text><text x="'+(x+50)+'" y="'+(cy+42)+'" font-size="10" class="muted">'+esc(short(current.description||'',Math.max(12,Math.floor((bw-52)/6))))+'</text>';
          svg+='<text x="'+x+'" y="'+(cy+61)+'" font-size="9.5" class="muted">Feels '+esc(Math.round(num(current.feelsLike,current.temperature))+unit)+' · '+Math.round(num(current.humidity,0))+'% humidity · '+Math.round(num(current.windSpeed,0))+(weather.units==='imperial'?' mph':' km/h')+'</text>';
          cy+=70;
        }else{
          const max=Math.max(1,Math.min(cfg.limit||7,forecast.length)),shortBox=bh<105;
          if(shortBox){
            const currentW=Math.min(112,Math.max(88,bw*.18)),days=forecast.slice(0,max),cellW=Math.max(52,(bw-currentW)/Math.max(1,days.length));
            svg+=weatherIcon(current.condition,x,cy+2,26,palette)+'<text x="'+(x+34)+'" y="'+(cy+19)+'" font-size="18" font-weight="800">'+esc(Math.round(num(current.temperature,0))+unit)+'</text>';
            days.forEach((d,i)=>{
              const dx=x+currentW+i*cellW;
              if(i===0)svg+='<line x1="'+(dx-5)+'" y1="'+cy+'" x2="'+(dx-5)+'" y2="'+Math.min(y+bh-3,cy+48)+'" class="line"/>';
              svg+='<text x="'+dx+'" y="'+(cy+10)+'" font-size="8" font-weight="800" class="muted">'+esc(i===0?'TODAY':new Date(d.date+'T12:00:00').toLocaleDateString('en-CA',{weekday:'short'}).toUpperCase())+'</text>';
              svg+=weatherIcon(d.condition,dx,cy+14,17,palette);
              svg+='<text x="'+(dx+21)+'" y="'+(cy+27)+'" font-size="9.5" font-weight="800">'+esc(Math.round(num(d.high,0))+'°')+'</text><text x="'+(dx+21)+'" y="'+(cy+39)+'" font-size="8" class="muted">'+esc(Math.round(num(d.low,0))+'°')+'</text>';
            });
            cy+=48;
          }else{
            const headerH=Math.min(42,Math.max(30,bh*.24)),availableForecast=Math.max(36,bh-headerH-10),cols=Math.min(max,Math.max(2,Math.floor(bw/92))),rows=Math.ceil(max/cols),cellW=bw/cols,cellH=Math.max(46,availableForecast/rows);
            svg+=weatherIcon(current.condition,x,cy,30,palette)+'<text x="'+(x+38)+'" y="'+(cy+20)+'" font-size="18" font-weight="800">'+esc(Math.round(num(current.temperature,0))+unit)+'</text><text x="'+(x+98)+'" y="'+(cy+20)+'" font-size="10" class="muted">'+esc(short(current.description||'',Math.max(12,Math.floor((bw-100)/6))))+'</text>';
            cy+=headerH;
            forecast.slice(0,max).forEach((d,i)=>{
              const col=i%cols,row=Math.floor(i/cols),dx=x+col*cellW,dy=cy+row*cellH,pop=Math.round(num(d.precipitationProbability,0));
              if(col>0)svg+='<line x1="'+dx+'" y1="'+dy+'" x2="'+dx+'" y2="'+Math.min(y+bh,dy+cellH-3)+'" class="line"/>';
              if(row>0)svg+='<line x1="'+dx+'" y1="'+dy+'" x2="'+Math.min(x+bw,dx+cellW-3)+'" y2="'+dy+'" class="line"/>';
              svg+='<text x="'+(dx+4)+'" y="'+(dy+10)+'" font-size="8.5" font-weight="800" class="muted">'+esc(i===0?'TODAY':new Date(d.date+'T12:00:00').toLocaleDateString('en-CA',{weekday:'short'}).toUpperCase())+'</text>';
              svg+=weatherIcon(d.condition,dx+4,dy+14,22,palette);
              svg+='<text x="'+(dx+31)+'" y="'+(dy+28)+'" font-size="11" font-weight="800">'+esc(Math.round(num(d.high,0))+'°')+'</text><text x="'+(dx+31)+'" y="'+(dy+41)+'" font-size="9" class="muted">'+esc(Math.round(num(d.low,0))+'° low')+'</text>';
              if(cellH>=60&&pop)svg+='<text x="'+(dx+4)+'" y="'+Math.min(dy+cellH-5,dy+57)+'" font-size="8.5" class="muted">'+esc(pop+'% precip')+'</text>';
            });
            cy+=rows*cellH;
          }
        }
        if(weather.location)svg+='<text x="'+x+'" y="'+Math.min(y+bh-3,cy+9)+'" font-size="8.5" class="muted">'+esc(short(weather.location,Math.floor(bw/5)))+'</text>';
      }
    }else if(kind==='tasks'){
      for(const task of items.slice(0,cfg.limit||4)){if(cy+28>y+bh)break;const due=task.due?new Date(task.due).toLocaleDateString('en-CA',{month:'short',day:'numeric'}):'';svg+='<line x1="'+x+'" y1="'+cy+'" x2="'+(x+bw)+'" y2="'+cy+'" class="line"/>';if(cfg.style!=='compact')svg+='<rect x="'+x+'" y="'+(cy+9)+'" width="10" height="10" rx="2" fill="#FFFFFF" stroke="'+black+'"/>';svg+='<text x="'+(x+(cfg.style==='compact'?0:18))+'" y="'+(cy+19)+'" font-size="'+(cfg.style==='compact'?11:13)+'" font-weight="700">'+esc(short(task.title,Math.max(12,Math.floor((bw-(due?72:18))/7))))+'</text>';if(due)svg+='<text x="'+(x+bw)+'" y="'+(cy+19)+'" text-anchor="end" font-size="10" class="muted">'+esc(due)+'</text>';cy+=27}
    }else if(kind==='goals'){
      for(const goal of items.slice(0,cfg.limit||2)){if(cy+42>y+bh)break;const accent=color(goal.accentColor,palette);svg+='<text x="'+x+'" y="'+(cy+14)+'" font-size="13" font-weight="700">'+esc(short(goal.title,Math.max(12,Math.floor((bw-50)/7))))+'</text><text x="'+(x+bw)+'" y="'+(cy+14)+'" text-anchor="end" font-size="11" font-weight="700">'+Math.round(num(goal.progress,0))+'%</text>';if(cfg.style!=='compact')svg+=bar(goal.progress,x,cy+23,bw,7,accent);cy+=cfg.style==='compact'?25:42}
    }else if(kind==='countdowns'){
      for(const c of items.slice(0,cfg.limit||3)){if(cy+35>y+bh)break;const accent=color(c.accentColor,palette),label=countdownLabel(c);svg+='<rect x="'+x+'" y="'+(cy+4)+'" width="4" height="25" rx="2" fill="'+accent+'"/><text x="'+(x+12)+'" y="'+(cy+16)+'" font-size="13" font-weight="700">'+esc(short(c.name,Math.max(12,Math.floor((bw-110)/7))))+'</text><text x="'+(x+bw)+'" y="'+(cy+16)+'" text-anchor="end" font-size="13" font-weight="800" fill="'+accent+'">'+esc(label)+'</text>';if(cfg.style!=='compact'&&c.showExactDate!==false)svg+='<text x="'+(x+12)+'" y="'+(cy+30)+'" font-size="9.5" class="muted">'+esc(new Date(c.end).toLocaleDateString('en-CA',{month:'short',day:'numeric',year:'numeric'}))+'</text>';cy+=cfg.style==='compact'?24:36}
    }else if(kind==='markets'){
      for(const q of items.slice(0,cfg.limit||4)){if(cy+28>y+bh)break;const pct=Number(q.percentChange),available=q.available!==false&&q.close!=null,accent=palette==='mono'?black:(pct>0?HEX.green:pct<0?HEX.red:black),arrow=pct>0?'▲':pct<0?'▼':'•';svg+='<line x1="'+x+'" y1="'+cy+'" x2="'+(x+bw)+'" y2="'+cy+'" class="line"/><text x="'+x+'" y="'+(cy+18)+'" font-size="12" font-weight="800">'+esc(q.symbol||'')+'</text><text x="'+(x+bw-58)+'" y="'+(cy+18)+'" text-anchor="end" font-size="11" font-weight="700">'+esc(available?money(q.close):'N/A')+'</text><text x="'+(x+bw)+'" y="'+(cy+18)+'" text-anchor="end" font-size="10" font-weight="800" fill="'+accent+'">'+(available?arrow+' '+Math.abs(pct||0).toFixed(2)+'%':'Unavailable')+'</text>';cy+=27}
    }
    svg+='</g>';
  }
  svg+='<text x="'+pad+'" y="'+(h-9)+'" font-size="9" class="muted">Updated '+esc(new Date(data.generatedAt).toLocaleTimeString('en-CA',{hour:'numeric',minute:'2-digit'}))+'</text><text x="'+(w-pad)+'" y="'+(h-9)+'" text-anchor="end" font-size="9" class="muted">Quest Log Cloud</text></svg>';
  return svg;
}
