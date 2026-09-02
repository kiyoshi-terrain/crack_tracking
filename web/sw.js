// オフライン動作のためのサービスワーカー。
//
// 現場は圏外か電波が細いことが普通なので、一度開けば通信なしで
// 使えるようにしておきます。解析自体はもともとブラウザ内で完結するので、
// アプリ本体をキャッシュするだけで完全にオフラインで動きます。
//
// 更新方法: ファイルを変えたら CACHE の版を上げる。

const CACHE = 'sigma-tool-v24';

// src/ 配下のモジュールは**全部**並べること。1本でも漏れると、
// 圏外でその機能だけ静かに動かなくなる（targets.js が実際に漏れていた）。
// reset.html は**意図的にここへ入れない**。古い版の SW は「キャッシュにあれば
// 永久にそれを返す」ので、キャッシュに無い URL でないと復旧ページに届かない。
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './manual/',
  './manual/index.html',
  './testpattern/',
  './testpattern/index.html',
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
  './src/change.js',
  './src/comparepanel.js',
  './src/capture.js',
  './src/capturepanel.js',
  './src/store.js',
  './src/cloudchange.js',
  './src/cloudalign.js',
  './src/clouddiffpanel.js',
  './src/history.js',
  './src/historypanel.js',
  './src/version.js',
];

// 取り直しは必ず HTTP キャッシュを素通りさせる（cache: 'reload'）。
// GitHub Pages は max-age=600 を返すので、既定のまま取ると新しい版の SW が
// ブラウザの HTTP キャッシュに残った**古いファイル**で自分のキャッシュを埋め、
// 版番号だけ新しくて中身は旧版（または新旧混在）という状態が再現する
// （ローカルで実際に再現した: v16 の SW のキャッシュに v15 の app.js が入る）。
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
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

// シェル（アプリ本体）は**版のキャッシュからだけ**返す。ファイル単位で裏から取り直すと、
// 「新しい app.js ＋ 古い capturepanel.js」のような混在が起き、新しい import が
// 古いモジュールに無くて起動時に即死する（実機で実際に起きた）。
// 更新は新しい sw.js（CACHE の版が違う）の install で一式を取り直し、activate で
// 旧キャッシュを消す。ページ側は controllerchange を受けて一度だけ再読み込みする。
// シェル以外（画像など）はネットワーク優先・失敗時キャッシュ。
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response && response.ok) cache.put(request, response.clone());
        return response;
      } catch {
        return (await caches.match(request)) || Response.error();
      }
    })
  );
});
