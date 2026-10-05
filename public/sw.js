/* Build substitutes a content-derived version and the complete static shell.
 * A new worker waits for existing tabs to close, preserving unsaved editors. */
const CACHE = 'cognate-shell-__BUILD_ID__';
const SHELL = __PRECACHE_ASSETS__;
const urls = new Set(SHELL.map(path => new URL(path,self.location.origin).href));
self.addEventListener('install',event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});
self.addEventListener('activate',event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('cognate-shell-') && key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',event => {
  const request=event.request;
  if (request.method!=='GET' || new URL(request.url).origin!==self.location.origin) return;
  if (request.mode==='navigate') {
    event.respondWith(caches.open(CACHE).then(cache=>cache.match('/index.html')).then(shell=>shell || fetch(request)));
  } else if (urls.has(request.url)) {
    event.respondWith(caches.open(CACHE).then(cache=>cache.match(request,{ignoreVary:true})).then(asset=>asset || fetch(request)));
  }
});
