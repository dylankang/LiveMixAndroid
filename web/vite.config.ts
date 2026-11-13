import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// 앱(APK) 빌드(--mode app): 외부 CDN 없이 동작하도록 MQTT 라이브러리를 앱에 포함된 파일(/mqtt.min.js)로 교체
const appHtml = () => ({
  name: 'app-html',
  transformIndexHtml: (html: string) => html.replace('https://unpkg.com/mqtt@5.10.1/dist/mqtt.min.js', '/mqtt.min.js'),
});

// HTTPS 로컬 서버: 모바일 브라우저/Even Hub WebView에서 getUserMedia 차단 방지
export default defineConfig(({ mode }) => ({
  plugins: [basicSsl(), ...(mode === 'app' ? [appHtml()] : [])],
  server: { https: {}, host: true, port: 5173 },
  build: { target: 'es2022' },
  // 수신기 화면 하단에 표시 → Even 앱이 새 버전을 불러왔는지 바로 확인
  define: { __BUILD_TIME__: JSON.stringify(new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })) },
}));
