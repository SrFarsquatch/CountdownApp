import {
  num, clamp, en, goalProgress, normalizeSectionLayout, normalizeModeSections,
  normalizeSectionOrder, DISPLAY_MODES, DISPLAY_KEYS
} from './state.js';

const HEX={black:'#111111',red:'#d22f27',blue:'#2457c5',green:'#29834a',yellow:'#d8a300',purple:'#7746b8'};
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

function color(name,palette){return palette==='mono'?HEX.black:(HEX[name]||HEX.black)}
function sectionTitle(label,x,y){return'<text x="'+x+'" y="'+y+'" class="k">'+esc(label)+'</text>'}
function bar(percent,x,y,w,h,fill){
  const p=clamp(num(percent,0),0,100);
  return'<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" rx="'+(h/2)+'" fill="#deded8"/><rect x="'+x+'" y="'+y+'" width="'+(w*p/100).toFixed(1)+'" height="'+h+'" rx="'+(h/2)+'" fill="'+fill+'"/>';
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
  if(/THUNDER|STORM/.test(t))return HEX.purple;if(/RAIN|DRIZZLE|SHOWER|SNOW|ICE/.test(t))return HEX.blue;if(/CLEAR|SUN/.test(t))return HEX.yellow;return HEX.black;
}
function weatherIcon(condition,x,y,size,palette){
  const t=String(condition||'').toUpperCase(),accent=weatherAccent(t,palette),black='#111';
  if(/CLEAR|SUN/.test(t))return'<circle cx="'+(x+size*.5)+'" cy="'+(y+size*.5)+'" r="'+(size*.22)+'" fill="'+accent+'"/><path d="M'+(x+size*.5)+' '+y+'v'+(size*.18)+'M'+(x+size*.5)+' '+(y+size*.82)+'v'+(size*.18)+'M'+x+' '+(y+size*.5)+'h'+(size*.18)+'M'+(x+size*.82)+' '+(y+size*.5)+'h'+(size*.18)+'" stroke="'+accent+'" stroke-width="'+Math.max(1.5,size*.06)+'"/>';
  const cloud='<path d="M'+(x+size*.12)+' '+(y+size*.62)+'c0-'+(size*.16)+' '+(size*.13)+'-'+(size*.27)+' '+(size*.29)+'-'+(size*.27)+' '+(size*.07)+'-'+(size*.17)+' '+(size*.22)+'-'+(size*.27)+' '+(size*.4)+'-'+(size*.27)+' '+(size*.23)+' 0 '+(size*.42)+' '+(size*.18)+' '+(size*.42)+' '+(size*.4)+' 0 '+(size*.16)+'-'+(size*.13)+' '+(size*.29)+'-'+(size*.29)+' '+(size*.29)+'H'+(x+size*.36)+'c-'+(size*.13)+' 0-'+(size*.24)+'-'+(size*.11)+'-'+(size*.24)+'-'+(size*.24)+'z" fill="'+(palette==='mono'?black:'#777')+'"/>';
  if(/RAIN|DRIZZLE|SHOWER/.test(t))return cloud+'<path d="M'+(x+size*.35)+' '+(y+size*.78)+'l-'+(size*.06)+' '+(size*.13)+'M'+(x+size*.58)+' '+(y+size*.78)+'l-'+(size*.06)+' '+(size*.13)+'" stroke="'+accent+'" stroke-width="'+Math.max(1.5,size*.055)+'"/>';
  if(/SNOW|ICE/.test(t))return cloud+'<circle cx="'+(x+size*.36)+'" cy="'+(y+size*.86)+'" r="'+(size*.05)+'" fill="'+accent+'"/><circle cx="'+(x+size*.62)+'" cy="'+(y+size*.86)+'" r="'+(size*.05)+'" fill="'+accent+'"/>';
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
  if(palette==='mono')return HEX.black;
  const v=String(event.eventColor||event.calendarColor||'').toLowerCase();
  if(/^#[0-9a-f]{6}$/.test(v))return v;
  return HEX.blue;
}
function money(value){const n=Number(value);return Number.isFinite(n)?n.toFixed(2):'N/A'}

export function renderDisplaySvg(data,width=800,height=480){
  const w=clamp(Math.round(num(width,800)),300,2000),h=clamp(Math.round(num(height,480)),300,2000),palette=data.display?.palette||'spectra6';
  const pad=Math.max(12,Math.round(Math.min(w,h)*.026)),top=pad+31,available=h-top-18,contentWidth=w-pad*2,black='#111111',muted='#666660',rule='#c9c9c2';
  const now=new Date(),mode=data.display?.mode||'daily',modeLabel=({dashboard:'DASHBOARD',daily:'DAY',weekly:'WEEK',monthly:'MONTH',countdowns:'COUNTDOWNS'})[mode]||'PLANNER';
  let svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'"><rect width="100%" height="100%" fill="#fff"/><style>text{font-family:Arial,Helvetica,sans-serif}.k{font-size:11px;font-weight:700;letter-spacing:1.5px}.muted{fill:'+muted+'}.line{stroke:'+rule+';stroke-width:1}.section-box{fill:#fff;stroke:'+rule+';stroke-width:1}</style>';
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
    svg+='<rect x="'+box.x+'" y="'+box.y+'" width="'+box.bw+'" height="'+box.bh+'" rx="7" class="section-box"/><g clip-path="url(#'+box.clip+')">';
    const x=box.x+box.inset,y=box.y+box.inset,bw=Math.max(20,box.bw-box.inset*2),bh=Math.max(20,box.bh-box.inset*2),kind=box.kind,items=sectionData[kind]||[],cfg=sections[kind]||{};
    svg+=sectionTitle(({agenda:'AGENDA',weather:'WEATHER',tasks:'TASKS',goals:'GOALS',countdowns:'COUNTDOWNS',markets:'MARKETS'})[kind],x,y+11);
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
      for(const task of items.slice(0,cfg.limit||4)){if(cy+28>y+bh)break;const due=task.due?new Date(task.due).toLocaleDateString('en-CA',{month:'short',day:'numeric'}):'';svg+='<line x1="'+x+'" y1="'+cy+'" x2="'+(x+bw)+'" y2="'+cy+'" class="line"/>';if(cfg.style!=='compact')svg+='<rect x="'+x+'" y="'+(cy+9)+'" width="10" height="10" rx="2" fill="#fff" stroke="'+black+'"/>';svg+='<text x="'+(x+(cfg.style==='compact'?0:18))+'" y="'+(cy+19)+'" font-size="'+(cfg.style==='compact'?11:13)+'" font-weight="700">'+esc(short(task.title,Math.max(12,Math.floor((bw-(due?72:18))/7))))+'</text>';if(due)svg+='<text x="'+(x+bw)+'" y="'+(cy+19)+'" text-anchor="end" font-size="10" class="muted">'+esc(due)+'</text>';cy+=27}
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
