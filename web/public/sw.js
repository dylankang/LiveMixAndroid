// 최소 서비스 워커: PWA 설치 조건 충족용. 캐시를 하지 않으므로 Netlify 재배포 즉시 최신 빌드가 반영됩니다.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* 네트워크 그대로 */ });
