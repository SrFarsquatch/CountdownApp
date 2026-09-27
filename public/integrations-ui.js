(()=>{
const KEY='questlog.focus.session.v1';
let data=null,phase='all',timer=null;
const E=s=>String(s==null?'':s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const icon=id=>({apple_health:'AH',health_connect:'HC',strava:'ST',google_calendar:'GC',google_tasks:'GT',questlog_focus:'QL',github:'GH',todoist:'TD',microsoft_todo:'MT',microsoft_planner:'MP',fitbit:'FB',whoop:'WH',oura:'OR',garmin:'GA',samsung_health:'SH',jira:'JI',browser_companion:'BC'})[id]||'QL';
const root=()=>document.getElementById('integrationsRoot');
const focus=()=>{try{return JSON.parse(localStorage.getItem(KEY)||'null')}catch{return null}};
const saveFocus=x=>x?localStorage.setItem(KEY,JSON.stringify(x)):localStorage.removeItem(KEY);
function ms(s){return !s?0:s.status==='paused'?Math.max(0,Number(s.remainingMs)||0):Math.max(0,(Number(s.endsAt)||0)-Date.now())}
function clock(s){if(!s)return'25:00';const n=Math.ceil(ms(s)/1000),m=Math.floor(n/60),r=n%60;return String(m).padStart(2,'0')+':'+String(r).padStart(2,'0')}
function clear(){if(timer){clearInterval(timer);timer=null}}
async function finish(s){
 clear();saveFocus(null);
 try{await api('/api/integrations/activity',{method:'POST',body:JSON.stringify({providerId:'questlog_focus',sourceEventId:s.id,eventType:'focus.session.completed',category:'focus',title:s.label||'Focus session',occurredAt:new Date().toISOString(),metrics:{durationMinutes:s.durationMinutes,activity:'focus'}})})}catch(e){console.warn(e)}
 await load(true);render();
}
function tick(){
 const s=focus(),time=document.getElementById('focusTime'),sub=document.getElementById('focusSub');
 if(time)time.textContent=clock(s);
 if(sub)sub.textContent=s?((s.label||'Focus')+' · '+(s.status==='paused'?'Paused':'In progress')):'Ready when you are.';
 if(s&&s.status==='running'&&ms(s)<=0)finish(s);
}
function start(){
 const mins=Math.max(5,Math.min(180,Number(document.getElementById('focusMinutes')?.value)||25));
 const label=String(document.getElementById('focusLabel')?.value||'Deep work').trim().slice(0,80)||'Deep work';
 const s={id:crypto.randomUUID(),label,durationMinutes:mins,status:'running',endsAt:Date.now()+mins*60000,remainingMs:mins*60000};
 saveFocus(s);clear();timer=setInterval(tick,1000);render();
}
function pause(){const s=focus();if(!s||s.status!=='running')return;s.remainingMs=ms(s);s.status='paused';delete s.endsAt;saveFocus(s);clear();render()}
function resume(){const s=focus();if(!s||s.status!=='paused')return;s.status='running';s.endsAt=Date.now()+Number(s.remainingMs||0);saveFocus(s);clear();timer=setInterval(tick,1000);render()}
function cancel(){clear();saveFocus(null);render()}
async function pref(id,key,value){
 const p=data.providers.find(x=>x.id===id);if(!p)return;
 p.preference={...p.preference,[key]:value,providerId:id};
 try{await api('/api/integrations/preferences',{method:'PUT',body:JSON.stringify(p.preference)})}catch(e){console.warn(e)}
}
function card(p){
 const s=p.id==='questlog_focus'?['Active','active']:p.setupState==='ready'?['Ready','ready']:p.setupState==='native_bridge'?['Native bridge','']:['Setup later',''];
 const pr=p.preference||{},action=p.id==='questlog_focus'?'<button class="btn" data-open-focus>Open focus</button>':'<button class="btn" disabled>'+(p.setupState==='ready'?'Connect later':'Configure later')+'</button>';
 const note=p.mode==='builtin'?'Works now without external credentials.':p.mode==='native'?'Native bridge scaffolded; device permission wiring comes with SDK setup.':'API/OAuth credentials intentionally deferred until Cloudflare setup.';
 return '<article class="integration-card" data-provider="'+E(p.id)+'"><div class="integration-card-top"><div class="integration-icon">'+E(icon(p.id))+'</div><div class="integration-title"><strong>'+E(p.name)+'</strong><span>'+E(p.description)+'</span></div><span class="integration-status '+s[1]+'">'+s[0]+'</span></div><div class="integration-capabilities">'+(p.capabilities||[]).map(x=>'<span class="integration-capability">'+E(x.replaceAll('_',' '))+'</span>').join('')+'</div><div class="integration-controls"><label class="integration-switch"><input type="checkbox" data-pref="earnXp" '+(pr.earnXp!==false?'checked':'')+'> Earn XP</label><label class="integration-switch"><input type="checkbox" data-pref="challengeEligible" '+(pr.challengeEligible!==false?'checked':'')+'> Challenge eligible</label><div class="integration-control-row"><span>Visibility</span><select data-pref="visibility"><option value="private" '+(pr.visibility==='private'?'selected':'')+'>Private</option><option value="friends" '+(pr.visibility==='friends'?'selected':'')+'>Friends</option><option value="party" '+(pr.visibility==='party'?'selected':'')+'>Party</option><option value="public" '+(pr.visibility==='public'?'selected':'')+'>Public</option></select></div></div><div class="integration-actions">'+action+'<span class="integration-note">'+E(note)+'</span></div></article>';
}
function activity(a){
 const m=a.metrics?.durationMinutes?Math.round(a.metrics.durationMinutes)+' min':a.metrics?.steps?Math.round(a.metrics.steps).toLocaleString()+' steps':'Verified';
 return '<div class="integrations-activity-row"><div class="integrations-activity-icon">'+E(icon(a.providerId))+'</div><div class="integrations-activity-copy"><strong>'+E(a.title||a.eventType)+'</strong><span>'+E(m)+' · '+new Date(a.occurredAt).toLocaleString()+'</span></div><div class="integrations-xp-pill">+'+(Number(a.xpAwarded)||0)+' XP</div></div>';
}
function render(){
 const el=root();if(!el)return;
 if(!data){el.innerHTML='<div class="card"><div class="empty">Loading integrations…</div></div>';return}
 const p=data.progress||{},s=focus(),groups=[1,2,3].map(n=>({n,items:data.providers.filter(x=>x.phase===n&&(phase==='all'||String(n)===String(phase)))})).filter(g=>g.items.length);
 let h='<div class="integrations-shell"><div class="integrations-hero"><section class="integrations-level-card"><div class="integrations-level-head"><div class="integrations-level-copy"><div class="eyebrow">Life progression</div><h3>Level '+(p.level||1)+'</h3><p>'+(p.weeklyXp||0)+' XP earned in the last 7 days.</p></div><div class="integrations-level-number">'+(p.totalXp||0)+'<span style="font-size:11px;color:var(--muted);font-weight:800"> XP</span></div></div><div class="integrations-xp-track"><div class="integrations-xp-fill" style="width:'+Math.round((p.progress||0)*100)+'%"></div></div><div class="integrations-level-meta"><span>'+(p.levelXp||0)+' / '+(p.nextLevelXp||100)+' XP</span><span>'+(p.currentStreak||0)+' day streak · best '+(p.bestStreak||0)+'</span></div><div class="integrations-stat-grid"><div class="integrations-stat"><strong>'+(p.fitnessXp||0)+'</strong><span>Fitness XP</span></div><div class="integrations-stat"><strong>'+(p.productivityXp||0)+'</strong><span>Productivity XP</span></div><div class="integrations-stat"><strong>'+(p.focusXp||0)+'</strong><span>Focus XP</span></div><div class="integrations-stat"><strong>'+(p.developmentXp||0)+'</strong><span>Developer XP</span></div></div></section><section class="integrations-focus-card" id="focusCard"><div><div class="eyebrow">Built in</div><div class="integrations-focus-time" id="focusTime">'+clock(s)+'</div><div class="integrations-focus-sub" id="focusSub">'+(s?E(s.label)+' · '+(s.status==='paused'?'Paused':'In progress'):'Ready when you are.')+'</div></div><div class="integrations-focus-setup"><input id="focusLabel" value="'+E(s?.label||'Deep work')+'"><select id="focusMinutes"><option value="25">25 min</option><option value="45">45 min</option><option value="60">60 min</option><option value="90">90 min</option></select></div><div class="integrations-focus-controls">'+(!s?'<button class="btn primary" data-focus="start">Start focus</button>':s.status==='paused'?'<button class="btn primary" data-focus="resume">Resume</button><button class="btn" data-focus="cancel">Cancel</button>':'<button class="btn" data-focus="pause">Pause</button><button class="btn" data-focus="cancel">Cancel</button>')+'</div></section></div>';
 h+='<div class="integrations-toolbar"><div class="integrations-filters">'+['all',1,2,3].map(x=>'<button class="integrations-filter '+(String(phase)===String(x)?'on':'')+'" data-phase="'+x+'">'+(x==='all'?'All phases':'Phase '+x)+'</button>').join('')+'</div></div>';
 groups.forEach(g=>{h+='<section class="integration-phase-section"><div class="integration-phase-head"><div><div class="eyebrow">Phase '+g.n+'</div><h3>'+({1:'Core integrations',2:'Expanded ecosystem',3:'Advanced & partner integrations'}[g.n])+'</h3></div><span class="meta">'+g.items.length+' integrations</span></div><div class="integration-grid">'+g.items.map(card).join('')+'</div></section>'});
 h+='<section class="card"><div class="section-title"><h3>Recent verified activity</h3><span class="meta">Normalized Quest Log events</span></div><div class="integrations-activity">'+((data.recentActivity||[]).length?data.recentActivity.map(activity).join(''):'<div class="empty">Complete a Focus session to create the first verified activity.</div>')+'</div></section><div class="integrations-privacy-note"><strong>Privacy by default.</strong> Quest Log stores normalized accomplishments for the game layer. Raw health records are not social activity. Each source controls XP, challenge eligibility and visibility.</div></div>';
 el.innerHTML=h;
 el.querySelectorAll('[data-phase]').forEach(b=>b.onclick=()=>{phase=b.dataset.phase==='all'?'all':Number(b.dataset.phase);render()});
 el.querySelectorAll('[data-provider]').forEach(c=>c.querySelectorAll('[data-pref]').forEach(x=>x.onchange=()=>pref(c.dataset.provider,x.dataset.pref,x.type==='checkbox'?x.checked:x.value)));
 el.querySelectorAll('[data-open-focus]').forEach(b=>b.onclick=()=>document.getElementById('focusCard')?.scrollIntoView({behavior:'smooth'}));
 el.querySelectorAll('[data-focus]').forEach(b=>b.onclick=()=>({start,pause,resume,cancel}[b.dataset.focus]||(()=>{}))());
 clear();if(focus()?.status==='running')timer=setInterval(tick,1000);
}
async function load(quiet=false){if(!quiet&&root())root().innerHTML='<div class="card"><div class="empty">Loading integrations…</div></div>';try{data=await api('/api/integrations')}catch(e){data=null;if(root())root().innerHTML='<div class="card"><div class="empty">Could not load integrations: '+E(e.message||e)+'</div></div>'}}
window.QuestLogIntegrations={render:async()=>{await load();render()},refresh:async()=>{await load(true);render()}};
})();