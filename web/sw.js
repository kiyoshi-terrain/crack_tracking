// オフライン動作のためのサービスワーカー。
//
// 現場は圏外か電波が細いことが普通なので、一度開けば通信なしで
// 使えるようにしておきます。解析自体はもともとブラウザ内で完結するので、
// アプリ本体をキャッシュするだけで完全にオフラインで動きます。
//
// 更新方法: ファイルを変えたら CACHE の版を上げる。

const CACHE = 'sigma-tool-v3';

// src/ 配下のモジュールは**全部**並べること。1本でも漏れると、
// 圏外でその機能だけ静かに動かなくなる（targets.js が実際に漏れていた）。
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './src/app.js',
  './src/shell.js',
  './src/dic.js',
  './src/transform.js',
  './src/sigma.js',
  './src/speckle.js',
  './src/exif.js',
  './src/image.js',
  './src/targets.js',
  './src/pointcloud.js',
  './src/surface.js',
  './src/cloudpanel.js',
  './src/history.js',
  './src/historypanel.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// stale-while-revalidate: まずキャッシュを返して即座に開き、
// 裏で取り直して次回に反映する。オフラインでも開き、更新も取りこぼさない。
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
