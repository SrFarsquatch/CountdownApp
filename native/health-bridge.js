export function createHealthBridge({Capacitor,nativeApi,platform}) {
  function plugin(){
    if(!Capacitor?.isNativePlatform?.())return null;
    return Capacitor.Plugins?.QuestLogHealth||null;
  }
  async function status(){
    const p=plugin();
    if(!p)return{supported:false,available:false,platform:platform(),provider:platform()==='ios'?'apple_health':platform()==='android'?'health_connect':'',reason:'Native health plugin is not installed yet.'};
    try{
      const result=await p.status();
      return{supported:true,available:Boolean(result?.available),platform:platform(),provider:platform()==='ios'?'apple_health':'health_connect',...result};
    }catch(error){
      return{supported:true,available:false,platform:platform(),provider:platform()==='ios'?'apple_health':'health_connect',reason:error?.message||String(error)};
    }
  }
  async function requestPermissions(types=['workouts','steps','distance','activity']){
    const p=plugin();if(!p)throw new Error('Quest Log health bridge is not installed in this native build.');
    return p.requestPermissions({types});
  }
  async function sync({since}={}){
    const p=plugin();if(!p)throw new Error('Quest Log health bridge is not installed in this native build.');
    const result=await p.readActivities({since:since||new Date(Date.now()-7*86400000).toISOString()});
    const activities=Array.isArray(result?.activities)?result.activities:[];
    const recorded=[];
    for(const item of activities){
      const providerId=platform()==='ios'?'apple_health':'health_connect';
      const payload={
        providerId,
        sourceEventId:String(item.id||crypto.randomUUID()),
        eventType:String(item.eventType||'health.workout.completed'),
        category:String(item.category||'health'),
        title:String(item.title||'Health activity'),
        occurredAt:item.occurredAt||new Date().toISOString(),
        metrics:item.metrics&&typeof item.metrics==='object'?item.metrics:{}
      };
      recorded.push(await nativeApi('/api/integrations/native-activity',{method:'POST',body:JSON.stringify(payload)}));
    }
    return{count:recorded.length,results:recorded};
  }
  return{status,requestPermissions,sync};
}
