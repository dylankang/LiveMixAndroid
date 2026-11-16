// G2 HUD 수신기 모드 (/?mode=hud&code=XXXX): 마이크(getUserMedia)를 절대 요청하지 않는다.
// PC 분석기와 같은 4자리 '연결 코드'로 클라우드 MQTT 에 접속해 전체 상태(HUD 5줄 · 장르 · L/R 레벨 · 6밴드 표 · AI 로그)를 받아 보여 주고,
// HUD 5줄은 받는 즉시 Even Hub 브리지로 G2 렌즈에 보낸다. PC 와 폰이 서로 다른 네트워크(유선 LAN ↔ 5G/LTE)여도 된다.
import { Glasses } from './glasses';
import { HudReceiver, linesToShow, isCode, setLinkCode, linkCode, localLinked, HB_LOST_MS, type MixState, type ReceiverInfo } from './link';
/** 연결 수단이 있는지: 4자리 코드(MQTT) 또는 📱 같은 폰 앱 자동 연결 */
const linked = () => isCode(linkCode()) || localLinked();
declare const __BUILD_TIME__: string;
import { renderBandTable, paintMeters, paintHud, paintCdCount, meterMarkup, genreText, clock } from './views';

try {
  if (navigator.mediaDevices) {
    (navigator.mediaDevices as any).getUserMedia = () =>
      Promise.reject(new DOMException('HUD 수신기 모드: 마이크를 사용하지 않습니다', 'NotAllowedError'));
    (navigator.mediaDevices as any).getDisplayMedia = () =>
      Promise.reject(new DOMException('HUD 수신기 모드: 화면/오디오 캡처를 사용하지 않습니다', 'NotAllowedError'));
  }
} catch { /* ignore */ }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const CODE_KEY = 'lm.rxCode';
const lsGet = (k: string) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

$('app').innerHTML = `
  <header>
    <h1>G2 HUD 수신기 <small>RECEIVER</small></h1>
    <div class="rxcode"><span>연결 코드</span><b id="rxCode">----</b><button id="changeCode" class="small" type="button">코드 변경</button></div>
    <div id="status" class="status">시작 중…</div>
  </header>
  <div id="pcWarn" hidden>⚠️ PC 신호 대기중</div>
  <div id="conn" class="badge off">🔴 대기 중</div>
  <section class="card">
    <div id="hud">
      <div id="hudCd" class="hud-cd" hidden></div>
      <div class="hud-line fb" id="hud0"></div><div class="hud-line" id="hud1"></div><div class="hud-line" id="hud2"></div>
      <div class="hud-line" id="hud3"></div><div class="hud-line" id="hud4"></div>
    </div>
    <div id="g2" class="hint">G2 렌즈: 브리지 확인 중…</div>
  </section>
  <div id="genreBadge" class="badge genre">🎵 장르 판별 대기 중</div>
  <section class="card">
    <h2>스테레오 레벨 미터 <small>-60 ~ 0 dBFS · PC 분석기</small></h2>
    <div id="meters">${meterMarkup()}</div>
  </section>
  <section class="card">
    <h2>밴드 분석 <small id="bandInfo">PC 분석기 실시간</small></h2>
    <table id="bandTable"></table>
    <div id="aiLast" class="hint"></div>
  </section>
  <section class="card">
    <div id="remoteStatus" class="hint"></div>
    <div class="hint">PC 분석기 화면 맨 위의 4자리 연결 코드를 입력하면 자동으로 연결됩니다. 네트워크가 달라도(PC 유선 LAN ↔ 폰 LTE) 됩니다.</div>
    <div id="buildInfo" class="hint"></div>
  </section>`;

const glasses = new Glasses();
let levels: MixState['levels'] = null;
let codeSetAt = 0;

// ───────── 🔑 연결 코드: URL(?code=) → 저장된 코드 → 없으면 키패드 ─────────
function applyCode(code: string) {
  lsSet(CODE_KEY, code);
  codeSetAt = Date.now();
  setLinkCode(code);
  $('rxCode').textContent = code;
  try {
    const u = new URL(location.href);
    u.searchParams.set('mode', 'hud'); u.searchParams.set('code', code);
    history.replaceState(null, '', u.toString());
  } catch { /* ignore */ }
  refresh();
}

/** 터치하기 쉬운 큰 숫자 키패드 (4자리 입력 즉시 연결) */
function openKeypad() {
  if (document.getElementById('keypad')) return;
  let digits = '';
  const box = document.createElement('div');
  box.id = 'keypad'; box.className = 'keypad';
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'cancel'];
  box.innerHTML = `
    <h2>PC 분석기의 연결 코드 4자리</h2>
    <div class="kp-disp">${'<span></span>'.repeat(4)}</div>
    <div class="kp-grid">${keys.map(k => `<button type="button" data-k="${k}">${k === 'del' ? '⌫' : k === 'cancel' ? '취소' : k}</button>`).join('')}</div>
    <div class="kp-msg"></div>`;
  document.body.appendChild(box);
  const cancelBtn = box.querySelector<HTMLButtonElement>('[data-k="cancel"]')!;
  cancelBtn.disabled = !isCode(linkCode());
  const paint = () => box.querySelectorAll('.kp-disp span').forEach((s, i) => { s.textContent = digits[i] ?? ''; });
  const close = () => { box.remove(); window.removeEventListener('keydown', onKey); };
  const press = (k: string) => {
    if (k === 'cancel') { if (isCode(linkCode())) close(); return; }
    if (k === 'del') digits = digits.slice(0, -1);
    else if (/^\d$/.test(k) && digits.length < 4) digits += k;
    paint();
    if (digits.length === 4) {
      box.querySelector('.kp-msg')!.textContent = `${digits} 로 연결 중…`;
      const code = digits;
      setTimeout(() => { close(); applyCode(code); }, 150);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('del');
    else if (e.key === 'Escape') press('cancel');
  };
  box.querySelectorAll<HTMLButtonElement>('button[data-k]').forEach(b => { b.onclick = () => press(b.dataset.k!); });
  window.addEventListener('keydown', onKey);
  paint();
}
$('changeCode').onclick = openKeypad;

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
  $('genreBadge').textContent = st.genre ? genreText(st.genre, st.genreAt) : '🎵 장르 판별 대기 중';
  renderBandTable($('bandTable'), st.bands);
  $('aiLast').textContent = st.aiLog ? `[${clock(st.aiLog.at)}] ${st.aiLog.text}` : '';
  $('remoteStatus').textContent = st.status ? `분석기 상태: ${st.status}` : '';
  levels = st.levels;
  paintCount(st, i);
}

/** HUD 오른쪽 위 쿨다운 개수 (PC 신호가 끊겼거나 분석 정지면 숨김) */
function paintCount(st: MixState, i: ReceiverInfo) {
  const n = st.running && i.phase !== 'stopped' && !(i.lastHb !== null && !i.pcAlive) ? st.cooldownCount ?? 0 : 0;
  paintCdCount(n);
  glasses.setCooldownCount(n);
}

// 👓 안경 다리 한 번 터치 → PC 분석기에 '쿨다운 전체 초기화' 명령 (길게 누르기 = 종료 확인)
glasses.onTap = () => {
  if (!linked()) return;
  rx.sendCommand('resetCooldown');
  const s = $('status');
  s.textContent = '👓 터치: 쿨다운 초기화 요청을 보냈습니다';
  paintCdCount(0); glasses.setCooldownCount(0);       // 바로 반영 (PC 상태가 오면 다시 맞춰짐)
};

/** PC 하트비트가 10초 넘게 없으면 상단에 '⚠️ PC 신호 대기중' */
function paintPcWarn(i: ReceiverInfo) {
  const w = $('pcWarn');
  const code = linked();
  const lost = code && !i.pcAlive && (i.lastHb !== null || Date.now() - codeSetAt > HB_LOST_MS);
  w.hidden = !lost;
  if (lost) w.textContent = i.lastHb ? `⚠️ PC 신호 대기중 · 마지막 신호 ${clock(i.lastHb)}`
    : i.local ? '⚠️ 분석기 신호 대기중 · 같은 폰의 Live Mix 앱에서 [시작]을 눌러 주세요' : `⚠️ PC 신호 대기중 · 코드 ${linkCode()} 의 PC 분석기가 아직 응답하지 않습니다`;
}

function paintConn(i: ReceiverInfo) {
  const c = $('conn');
  const t = i.lastUpdate ? clock(i.lastUpdate) : '';
  const mq = i.mqtt === 'on' ? 'MQTT 연결됨' : i.mqtt === 'connecting' ? 'MQTT 연결 중…' : 'MQTT 사용 불가';
  const lv = i.pcAlive && i.hbLevelDb !== null ? ` · PC 입력 ${i.hbLevelDb <= -100 ? '-∞' : i.hbLevelDb.toFixed(0)}dB` : '';
  const map = {
    live: ['live', `🟢 실시간 수신 중 (마지막 업데이트: ${t})${lv}`],
    stale: ['stale', `🟡 신호 지연 — PC 분석기 응답 없음 (마지막 업데이트: ${t})`],
    stopped: ['off', `⏸ PC 분석기 정지됨 (마지막 업데이트: ${t})`],
    waiting: ['off', i.local ? '🔴 대기 중 — 같은 폰 Live Mix 앱의 분석 시작을 기다리는 중'
      : isCode(linkCode()) ? `🔴 대기 중 — 코드 ${linkCode()} 의 PC 분석기 데이터를 기다리는 중` : '🔴 연결 코드를 입력하세요 (같은 폰의 Live Mix 앱을 찾는 중…)'],
  } as const;
  const [cls, text] = map[i.phase];
  c.className = `badge ${cls}`;
  c.textContent = text;
  $('status').textContent = `${i.local ? '📱 같은 폰 앱과 자동 연결됨 (코드 불필요) · ' : ''}${mq}${isCode(linkCode()) ? ` · 코드 ${linkCode()}` : ''}`;
  if (i.local) document.getElementById('keypad')?.remove();   // 같은 폰 앱을 찾으면 코드 입력 창은 닫음
  if (i.local && !isCode(linkCode())) $('rxCode').textContent = '📱자동';
  paintPcWarn(i);
}

const rx = new HudReceiver({ announce: true });
rx.onUpdate = (st, i) => { show(st, i); paintConn(i); };
rx.onLevels = lv => { levels = lv; };
rx.onInfo = i => { paintConn(i); refresh(); };

// 시작 코드: URL ?code= → 저장된 코드 → 없으면 키패드
{
  const fromUrl = new URLSearchParams(location.search).get('code') ?? '';
  const start = isCode(fromUrl) ? fromUrl : lsGet(CODE_KEY);
  if (isCode(start)) { lsSet(CODE_KEY, start); codeSetAt = Date.now(); setLinkCode(start); $('rxCode').textContent = start; }
}
rx.start();
// 코드가 없으면: 같은 폰의 Live Mix 앱을 잠깐 찾아보고, 없을 때만 코드 키패드를 연다
if (!isCode(linkCode())) setTimeout(() => { if (!linked()) openKeypad(); }, 2500);

// 1초마다 다시 판단: PC 신호가 끊긴 채 오래되면 멈춘 조언을 지우고 '⚠️ PC 신호 대기중' 표시, 다시 들어오면 즉시 복구
function refresh() {
  const i = rx.info();
  paintPcWarn(i);
  const st = rx.state;
  if (!st) return;
  paintLines(linesToShow(st, i));
  paintCount(st, i);
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
