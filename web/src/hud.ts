// G2 HUD 수신기 모드 (/?mode=hud): 마이크(getUserMedia)를 절대 요청하지 않는다.
// 크롬 분석기의 전체 상태(HUD 5줄 · 장르 · L/R 레벨 · 6밴드 표 · AI 로그)를 받아 그대로 보여 주고,
// HUD 5줄은 받는 즉시 Even Hub 브리지로 G2 렌즈에 보낸다.
import { Glasses } from './glasses';
import { HudReceiver, linesToShow, type MixState, type ReceiverInfo } from './link';
declare const __BUILD_TIME__: string;
import { renderBandTable, paintMeters, paintHud, meterMarkup, genreText, clock } from './views';

try {
  if (navigator.mediaDevices) {
    (navigator.mediaDevices as any).getUserMedia = () =>
      Promise.reject(new DOMException('HUD 수신기 모드: 마이크를 사용하지 않습니다', 'NotAllowedError'));
    (navigator.mediaDevices as any).getDisplayMedia = () =>
      Promise.reject(new DOMException('HUD 수신기 모드: 화면/오디오 캡처를 사용하지 않습니다', 'NotAllowedError'));
  }
} catch { /* ignore */ }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

$('app').innerHTML = `
  <header>
    <h1>G2 HUD 수신기 <small>RECEIVER</small></h1>
    <div id="status" class="status">시작 중…</div>
  </header>
  <div id="conn" class="badge off">🔴 대기 중</div>
  <section class="card">
    <div id="hud">
      <div class="hud-line fb" id="hud0"></div><div class="hud-line" id="hud1"></div><div class="hud-line" id="hud2"></div>
      <div class="hud-line" id="hud3"></div><div class="hud-line" id="hud4"></div>
    </div>
    <div id="g2" class="hint">G2 렌즈: 브리지 확인 중…</div>
  </section>
  <div id="genreBadge" class="badge genre">🎵 장르 판별 대기 중</div>
  <section class="card">
    <h2>스테레오 레벨 미터 <small>-60 ~ 0 dBFS · 크롬 분석기</small></h2>
    <div id="meters">${meterMarkup()}</div>
  </section>
  <section class="card">
    <h2>밴드 분석 <small id="bandInfo">크롬 분석기 실시간</small></h2>
    <table id="bandTable"></table>
    <div id="aiLast" class="hint"></div>
  </section>
  <section class="card">
    <div id="remoteStatus" class="hint"></div>
    <div class="hint">크롬에서 분석기(/)를 열고 [시작]을 누르면 자동으로 연결됩니다. 별도 설정이 필요 없습니다.</div>
    <div id="buildInfo" class="hint"></div>
  </section>`;

const glasses = new Glasses();
let levels: MixState['levels'] = null;

let shownSig = '';
/** HUD 5줄을 폰 화면과 G2 렌즈에 반영 (바뀐 경우만) */
function paintLines(lines: string[]) {
  const sig = lines.join('\n');
  if (sig === shownSig) return;
  shownSig = sig;
  paintHud(lines);
  glasses.update(lines);                 // Even Hub 브리지 → G2 렌즈 (받는 즉시)
}

function show(st: MixState, i: ReceiverInfo) {
  paintLines(linesToShow(st, i));
  $('genreBadge').textContent = genreText(st.genre, st.genreAt);
  renderBandTable($('bandTable'), st.bands);
  $('aiLast').textContent = st.aiLog ? `[${clock(st.aiLog.at)}] ${st.aiLog.text}` : '';
  $('remoteStatus').textContent = st.status ? `분석기 상태: ${st.status}` : '';
  levels = st.levels;
}

function paintConn(i: ReceiverInfo) {
  const c = $('conn');
  const t = i.lastUpdate ? clock(i.lastUpdate) : '';
  const mq = i.mqtt === 'on' ? 'MQTT 연결됨' : i.mqtt === 'connecting' ? 'MQTT 연결 중…' : 'MQTT 사용 불가';
  const map = {
    live: ['live', `🟢 실시간 수신 중 (마지막 업데이트: ${t})`],
    stale: ['stale', `🟡 신호 지연 — 크롬 분석기가 백그라운드에서 멈춤 (마지막 업데이트: ${t}) · 크롬의 [🔋 백그라운드 유지]가 ON인지 확인`],
    stopped: ['off', `⏸ 크롬 분석기 정지됨 (마지막 업데이트: ${t})`],
    waiting: ['off', '🔴 대기 중 — 크롬 분석기의 데이터를 기다리는 중'],
  } as const;
  const [cls, text] = map[i.phase];
  c.className = `badge ${cls}`;
  c.textContent = text;
  $('status').textContent = `${mq}${i.via ? ` · 수신 경로 ${i.via}` : ''}`;
}

const rx = new HudReceiver({ announce: true });
rx.onUpdate = (st, i) => { show(st, i); paintConn(i); };
rx.onLevels = lv => { levels = lv; };
rx.onInfo = i => { paintConn(i); refresh(); };
rx.start();

// 1초마다 다시 판단: 분석기 신호가 끊긴 채 오래되면 멈춘 조언을 지우고 '⏸ 분석기 신호 없음' 표시, 다시 들어오면 즉시 복구
function refresh() {
  const st = rx.state;
  if (!st) return;
  const i = rx.info();
  paintLines(linesToShow(st, i));
  if (i.phase !== 'live') levels = null;
}
setInterval(() => { refresh(); paintConn(rx.info()); }, 1000);

// 미터는 화면이 보일 때만 그림
function meterLoop() { paintMeters($('meters'), levels); requestAnimationFrame(meterLoop); }
requestAnimationFrame(meterLoop);
setInterval(() => { const s = rx.state; if (s && s.genre) $('genreBadge').textContent = genreText(s.genre, s.genreAt); }, 1000);
renderBandTable($('bandTable'), null);

$('buildInfo').textContent = `빌드: ${typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '개발 버전'}`;

glasses.onState = (s, d) => {
  $('g2').textContent = s === 'ready' ? 'G2 렌즈: 연결됨 (Even Hub 브리지 · 5줄 컨테이너)'
    : s === 'text-fallback' ? 'G2 렌즈: 연결됨 (브리지 텍스트 전송 방식)'
    : s === 'failed' ? `G2 렌즈: 출력 실패 (${d ?? ''})` : 'G2 렌즈: 브리지 확인 중…';
};
setTimeout(() => {
  if (glasses.state === 'waiting') $('g2').textContent = 'G2 렌즈: 브리지 대기 중 (Even 앱 밖의 일반 브라우저에서는 렌즈 출력 없음)';
}, 4000);
void glasses.init();
