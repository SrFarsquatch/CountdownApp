const CACHE_NAME='quest-log-pwa-v5';
const STATIC_ASSETS=[
  '/offline.html',
  '/manifest.webmanifest',
  '/branding/icon-classic.svg',
  '/branding/icon-quest-192.png',
  '/branding/icon-quest-512.png',
  '/branding/icon-classic-maskable.svg',
  '/branding/apple-touch-icon.png'
];

self.addEventListener('install',event=>{
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache=>cache.addAll(STATIC_ASSETS))
      .catch(()=>{})
      .then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(key=>key!==CACHE_NAME).map(key=>caches.delete(key))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin)return;
  if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/cdn-cgi/')||url.pathname==='/frame'||url.pathname.startsWith('/login'))return;

  if(request.mode==='navigate'){
    event.respondWith(fetch(request).catch(()=>caches.match('/offline.html')));
    return;
  }

  if(!STATIC_ASSETS.includes(url.pathname))return;
  event.respondWith(
    caches.match(request).then(cached=>{
      const fresh=fetch(request).then(response=>{
        if(response&&response.ok){
          const copy=response.clone();
          caches.open(CACHE_NAME).then(cache=>cache.put(request,copy));
        }
        return response;
      }).catch(()=>cached);
      return cached||fresh;
    })
  );
});

self.addEventListener('push',event=>{
  let data={};
  try{data=event.data?event.data.json():{}}catch{data={body:event.data?.text?.()||''}}
  const title=data.title||'Quest Log';
  const options={
    body:data.body||'You have a new Quest Log notification.',
    icon:'/branding/icon-quest-classic-192.png',
    badge:'/branding/icon-quest-classic-192.png',
    tag:data.tag||'questlog-notification',
    renotify:false,
    data:{url:data.url||'/?view=today',kind:data.kind||'general',timestamp:data.timestamp||new Date().toISOString()}
  };
  event.waitUntil(self.registration.showNotification(title,options));
});

self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const target=new URL(event.notification?.data?.url||'/?view=today',self.location.origin).href;
  event.waitUntil((async()=>{
    const windows=await clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of windows){
      try{
        if(new URL(client.url).origin===self.location.origin){
          await client.navigate(target);
          return client.focus();
        }
      }catch{}
    }
    return clients.openWindow(target);
  })());
});
