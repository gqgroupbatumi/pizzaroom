// Минимальный сервис-воркер: нужен, чтобы браузер предложил «Установить приложение».
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
