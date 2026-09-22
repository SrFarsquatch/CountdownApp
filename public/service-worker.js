const CACHE_NAME='quest-log-pwa-v1';
const STATIC_ASSETS=[
  '/offline.html',
  '/manifest.webmanifest',
  '/branding/icon-quest.svg',
  '/branding/icon-quest-192.png',
  '/branding/icon-quest-512.png',
  '/branding/icon-quest-maskable-512.png',
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
