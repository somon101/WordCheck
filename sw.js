/* =========================================================
   WordCheck — sw.js
   Service worker для офлайн-режима PWA. Кеширует "оболочку" приложения
   (HTML/CSS/JS/иконки) — сами данные словарей живут в IndexedDB
   (db-web.js), это никак не пересекается с кешем service worker'а.
   ========================================================= */

const CACHE_NAME = "wordcheck-shell-v1";

const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./setup.js",
  "./db-web.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const isSameOrigin = new URL(event.request.url).origin === self.location.origin;

  if (isSameOrigin) {
    // Оболочка приложения: сеть в приоритете (чтобы видеть свежие правки при
    // разработке), кеш — запасной вариант, когда сети нет.
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    // Внешние ресурсы (шрифты Google Fonts и т.п.): просто сеть, без кеша —
    // если офлайн и шрифт недоступен, страница останется на системном шрифте.
    event.respondWith(fetch(event.request).catch(() => new Response("", { status: 504 })));
  }
});
