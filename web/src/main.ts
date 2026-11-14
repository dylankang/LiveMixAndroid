import './style.css';

// 모드 분기: ?mode=hud → G2 HUD 수신기(마이크 코드 로드 안 함), 그 외 → 분석기
const params = new URLSearchParams(location.search);
if (params.get('mode') === 'hud') void import('./hud');
else void import('./analyzer');

// PWA 설치 조건용 서비스 워커 (캐시 없음 → 항상 최신 빌드)
if ('serviceWorker' in navigator && location.protocol === 'https:' && !(window as any).LiveMixNative) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
}
