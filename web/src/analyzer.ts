import { AudioEngine, type BandStat, listInputs, requestMicPermission, systemCaptureSupported, SYSTEM_AUDIO_ID, DEFAULT_INPUT_ID, REFERENCE_ID } from './audio';
import { ReferencePlayer } from './player';
import { AdviceManager } from './advice';
import { callAI, parseReply, buildSystemPrompt, isQuotaError, type Genre } from './ai';
import { evaluateBalance, TOL_RANGE } from './balance';
import { fbParamsFor } from './config';
import { Glasses } from './glasses';
import { HudSender, HudReceiver, linesToShow, type BandRow, type LevelPkt, type MixState, type ReceiverInfo } from './link';
import { renderBandTable, paintMeters, paintHud, genreText, clock } from './views';
import { setTicker, clearTicker } from './ticker';
import { BANDS, PROVIDERS, TIMING, INTERVAL_RANGE, type ProviderId } from './config';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ls = {
  get: (k: string, d = '') => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* 저장 불가 환경 */ } },
};

const engine = new AudioEngine();
const advice = new AdviceManager();
const glasses = new Glasses();

// ───────── G2 HUD 수신기 연결 (MQTT + BroadcastChannel + localStorage · 무설정) ─────────
const sender = new HudSender();
const hudUrl = () => `${location.origin}${location.pathname}?mode=hud`;
let genre: Genre | null = null;
let genreAt = 0;
{
  const badge = document.createElement('div');
  badge.id = 'genreBadge'; badge.className = 'badge genre';
  const card = document.createElement('section');
  card.className = 'card';
  card.innerHTML = `
    <h2>G2 HUD 수신기 <small id="linkState">🔴 수신기 대기</small></h2>
    <button id="copyUrl" class="primary">Even Hub용 수신기 URL 복사</button>
    <button id="openHud">수신기 새 탭에서 열기 (연결 테스트)</button>
    <div id="hudUrl" class="hint url"></div>
    <div id="linkHint" class="hint"></div>`;
  const header = document.querySelector('header')!;
  header.after(card);
  header.after(badge);     // 헤더 바로 아래: 장르/상태 배지
  $('hudUrl').textContent = hudUrl();

  sender.onState = i => {
    const mq = i.mqtt === 'on' ? 'MQTT 연결됨' : i.mqtt === 'connecting' ? 'MQTT 연결 중…' : 'MQTT 사용 불가';
    $('linkState').textContent = i.receivers > 0 ? `🟢 수신기 ${i.receivers}개 연결됨 (${i.via.join('/')})` : `🔴 수신기 대기 · ${mq}`;
    $('linkHint').textContent = i.receivers > 0 ? '' : `수신기 주소를 Even Hub에서 열면 자동 연결됩니다. (${mq})`;
  };
  $('copyUrl').onclick = async () => {
    const url = hudUrl();
    let ok = false;
    try { await navigator.clipboard.writeText(url); ok = true; } catch {
      const ta = document.createElement('textarea');
      ta.value = url; ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
    }
    const b = $('copyUrl'), old = b.textContent;
    b.textContent = ok ? '복사됨 ✓' : '복사 실패 — 아래 주소를 직접 복사하세요';
    setTimeout(() => { b.textContent = old; }, 1800);
  };
  $('openHud').onclick = () => window.open(hudUrl(), '_blank');
}

/** AI가 판별한 장르/모드 문구 (폰 화면 배지 + 수신기 미러링용 · G2 HUD 5줄에는 넣지 않음) */
function genreLabel(): string {
  if (!genre) return '';
  const c = genre.category;
  return c.startsWith('단일 악기') ? `🎤 감지된 상태: ${genre.instrument || '단일 악기'} Solo`
    : c.startsWith('스피치') ? '🗣️ 감지된 상태: 스피치/설교'
    : `🎵 감지된 장르: ${c} (Full Mix)`;
}
function paintGenre() {
  if (mirroring) return;
  $('genreBadge').textContent = genreText(genreLabel(), genreAt);
}

let running = false;
let mirroring = false;      // 로컬 분석이 꺼져 있고 다른 기기(크롬)의 분석 결과를 보여 주는 중
let localLevels: [LevelPkt, LevelPkt] | null = null;   // 50ms 분석 루프가 채움 (미터는 이 값만 그림)
let remoteLevels: [LevelPkt, LevelPkt] | null = null;
let lastRows: BandRow[] | null = null;
let fbText = '';           // 현재 피드백 경고 (빈 문자열이면 이상 없음)
let fbUntil = 0;
let inFlight = false;
let lastRendered = '';
let analyzeTimer = 0;      // AI 분석 타이머 (주기 슬라이더로 즉시 교체 가능)
let lastCollectAt = Date.now();
let aiPaused = false;      // API 할당량 소진 등으로 AI 조언만 정지된 상태
const QUOTA_MSG = '⚠️ API 할당량 소진: AI 조언 정지됨';

const banner = document.createElement('div');
banner.id = 'quotaBanner';
banner.className = 'banner';
banner.hidden = true;
banner.innerHTML = `<div class="banner-row"><span>${QUOTA_MSG}</span><button id="resumeBtn">AI 분석 재개</button></div>
  <div class="hint">API 키나 모델을 바꾼 뒤 재개하세요. 레벨 미터와 피드백 감지는 계속 작동 중입니다.</div>`;
document.getElementById('app')!.prepend(banner);

// ───────── UI 초기화 ─────────
const providerSel = $<HTMLSelectElement>('provider');
const modelSel = $<HTMLSelectElement>('model');
const customModel = $<HTMLInputElement>('customModel');
const apiKeyInp = $<HTMLInputElement>('apiKey');
const deviceSel = $<HTMLSelectElement>('device');
const startBtn = $<HTMLButtonElement>('startBtn');

const CUSTOM = '__custom__';
providerSel.innerHTML = (Object.keys(PROVIDERS) as ProviderId[]).map(p => `<option value="${p}">${PROVIDERS[p].label}</option>`).join('');
providerSel.value = ls.get('lm.provider', 'gemini');
const provider = () => providerSel.value as ProviderId;

function loadProviderUI() {
  const p = provider();
  const models = PROVIDERS[p].models;
  modelSel.innerHTML = models.map(m => `<option>${m}</option>`).join('') + `<option value="${CUSTOM}">직접 입력…</option>`;
  const saved = ls.get(`lm.model2.${p}`, models[0]);
  if (models.includes(saved)) { modelSel.value = saved; customModel.hidden = true; }
  else { modelSel.value = CUSTOM; customModel.hidden = false; customModel.value = saved; }
  apiKeyInp.value = ls.get(`lm.key.${p}`);
}
const currentModel = () => (modelSel.value === CUSTOM ? customModel.value.trim() : modelSel.value);

providerSel.onchange = () => { ls.set('lm.provider', provider()); loadProviderUI(); onAiConfigChanged(); };
modelSel.onchange = () => { customModel.hidden = modelSel.value !== CUSTOM; ls.set(`lm.model2.${provider()}`, currentModel()); onAiConfigChanged(); };
customModel.oninput = () => { ls.set(`lm.model2.${provider()}`, currentModel()); onAiConfigChanged(); };
apiKeyInp.oninput = () => { ls.set(`lm.key.${provider()}`, apiKeyInp.value.trim()); onAiConfigChanged(); };
loadProviderUI();

// ───────── 입력 장치 탐색 ─────────
const DEFAULT_LABEL = '🔌 기본 오디오 입력 (연결된 USB 인터페이스 자동)';
const SYSTEM_LABEL = '📱 시스템/화면 오디오 캡처 (내부 재생음)';
const REFERENCE_LABEL = '🎵 내장 디지털 레퍼런스 플레이어 (볼륨 무관 원본 직결)';
const MOBILE_CAPTURE_MSG = '📱 모바일 브라우저는 내부 재생음 캡처를 지원하지 않아 내장 디지털 직결 플레이어로 전환했습니다. 파일이나 데모 루프를 불러오세요 (폰 볼륨·무음과 무관하게 원본 레벨로 분석).';

// 🎵 내장 디지털 레퍼런스 플레이어 패널 (입력 장치 선택 바로 아래)
const playerPanel = document.createElement('div');
playerPanel.id = 'playerPanel'; playerPanel.className = 'player'; playerPanel.hidden = true;
deviceSel.closest('label')!.after(playerPanel);
const player = new ReferencePlayer(playerPanel);
player.onVolume = v => engine.setMonitorVolume(v);
const syncPanel = () => { playerPanel.hidden = deviceSel.value !== REFERENCE_ID; };
const findBtn = $<HTMLButtonElement>('findBtn');

// 시작 실패 원인을 보여 주는 붉은 박스 (시작 버튼 바로 아래)
const errBox = document.createElement('div');
errBox.id = 'startError'; errBox.className = 'errbox'; errBox.hidden = true;
startBtn.parentElement!.after(errBox);
const showError = (msg: string) => { errBox.textContent = '⛔ ' + msg; errBox.hidden = false; };
const clearError = () => { errBox.hidden = true; errBox.textContent = ''; };

// 안내 배너 (화면 상단)
const notice = document.createElement('div');
notice.id = 'noticeBanner'; notice.className = 'banner info'; notice.hidden = true;
notice.innerHTML = `<div class="banner-row"><span id="noticeText"></span><button id="noticeClose">닫기</button></div>`;
document.getElementById('app')!.prepend(notice);
$('noticeClose').onclick = () => { notice.hidden = true; };
const showNotice = (msg: string) => { $('noticeText').textContent = msg; notice.hidden = false; };

/** 오류를 사람이 읽을 수 있는 원인으로 변환 */
function describeError(e: unknown): string {
  const name = (e as { name?: string } | null)?.name ?? '';
  const msg = e instanceof Error ? e.message : String(e);
  const detail = name && name !== 'Error' ? ` (${name}: ${msg})` : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError')
    return `마이크 권한이 거부되었습니다. 주소창 왼쪽 아이콘 → 권한 → 마이크를 '허용'으로 바꾸고, 안드로이드 설정에서 크롬 앱의 마이크 권한도 확인한 뒤 다시 시도하세요.${detail}`;
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError')
    return `오디오 입력 장치를 찾지 못했습니다. USB 인터페이스 연결(전원·케이블·OTG)을 확인하고 [🔄 장치 찾기]를 눌러 주세요.${detail}`;
  if (name === 'NotReadableError' || name === 'TrackStartError')
    return `입력 장치를 열 수 없습니다. 다른 앱이 마이크/인터페이스를 사용 중이거나 USB 연결이 불안정합니다.${detail}`;
  if (name === 'OverconstrainedError') return `장치가 요청한 설정을 지원하지 않습니다.${detail}`;
  return (msg || '알 수 없는 오류') + (name && name !== 'Error' ? ` (${name})` : '');
}

function fillDevices(devs: MediaDeviceInfo[]) {
  // 권한 전에는 deviceId 가 빈 문자열로 오므로 그런 항목은 목록에 넣지 않는다
  const real = devs.filter(d => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const keep = deviceSel.value || ls.get('lm.device', DEFAULT_INPUT_ID);
  deviceSel.innerHTML = '';
  const add = (value: string, label: string) => {
    const o = document.createElement('option');
    o.value = value; o.textContent = label;
    deviceSel.appendChild(o);
  };
  add(DEFAULT_INPUT_ID, DEFAULT_LABEL);                                   // 항상 맨 위 · 기본값
  real.forEach((d, i) => add(d.deviceId, d.label || `입력 ${i + 1}`));
  add(REFERENCE_ID, REFERENCE_LABEL);
  add(SYSTEM_AUDIO_ID, SYSTEM_LABEL);
  const valid = keep === SYSTEM_AUDIO_ID || keep === REFERENCE_ID || real.some(d => d.deviceId === keep);
  deviceSel.value = valid ? keep : DEFAULT_INPUT_ID;
  syncPanel();
}

/** askPermission=true 면 먼저 마이크 권한 팝업을 띄운 뒤 목록을 다시 읽는다 */
async function refreshDevices(askPermission = false) {
  // 분석 중에는 이미 권한이 허용된 상태이므로 권한용 스트림을 따로 열지 않는다
  if (askPermission && !running) await requestMicPermission();
  fillDevices(await listInputs());
}

findBtn.onclick = async () => {
  const old = findBtn.textContent;
  findBtn.disabled = true; findBtn.textContent = '찾는 중…';
  try {
    await refreshDevices(true);
    clearError();
    const n = deviceSel.options.length - 2;
    setStatus(n > 0 ? `입력 장치 ${n}개 찾음` : '개별 장치 없음 · 기본 오디오 입력을 사용하세요');
  } catch (e) {
    showError(describeError(e));
    try { fillDevices(await listInputs()); } catch { /* ignore */ }
  } finally { findBtn.disabled = false; findBtn.textContent = old; }
};

/** 미지원 기기(모바일)에서 시스템 캡처를 고르면 내장 디지털 레퍼런스 플레이어로 전환하고 패널을 연다. 전환했으면 true */
function guardSystemCapture(): boolean {
  if (deviceSel.value !== SYSTEM_AUDIO_ID || systemCaptureSupported()) { syncPanel(); return false; }
  // 모바일: 경고 배너 대신 내장 디지털 직결 플레이어로 바로 전환
  deviceSel.value = REFERENCE_ID;
  ls.set('lm.device', REFERENCE_ID);
  syncPanel();
  player.msg(MOBILE_CAPTURE_MSG);
  return true;
}

deviceSel.onchange = async () => {
  guardSystemCapture();
  syncPanel();
  ls.set('lm.device', deviceSel.value);
  if (!running) return;
  try { await startAudio(); clearError(); }
  catch (e) { showError(describeError(e)); await stop(); }
};
// 인터페이스를 꽂거나 뺄 때 목록 자동 갱신
try { navigator.mediaDevices?.addEventListener?.('devicechange', () => { refreshDevices().catch(() => {}); }); } catch { /* ignore */ }
fillDevices([]);                       // 권한 전에도 '기본 오디오 입력'이 바로 선택돼 있도록
guardSystemCapture();
refreshDevices().catch(() => {});

// ───────── 슬라이더: 조언 민감도 / 피드백 민감도 / AI 조언 주기 ─────────
// 두 민감도 모두  왼쪽 = 둔감  →  가운데 = 보통  →  오른쪽 = 예민
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : lo));
let tolDb = clamp(parseFloat(ls.get('lm.tol', String(TOL_RANGE.default))), TOL_RANGE.min, TOL_RANGE.max);
let fbSens = clamp(parseFloat(ls.get('lm.fb', '50')), 0, 100);
let intervalSec = clamp(Math.round(parseFloat(ls.get('lm.interval', String(INTERVAL_RANGE.default))) / INTERVAL_RANGE.step) * INTERVAL_RANGE.step, INTERVAL_RANGE.min, INTERVAL_RANGE.max);
{
  const tolSteps = Math.round((TOL_RANGE.max - TOL_RANGE.min) / TOL_RANGE.step);
  const tolMid = (TOL_RANGE.max + TOL_RANGE.min) / 2;
  const card = document.createElement('section');
  card.className = 'card';
  card.innerHTML = `
    <h2>조언 민감도 <small id="tolInfo"></small></h2>
    <input id="tolSlider" type="range" min="0" max="${tolSteps}" step="1" />
    <div class="scale"><span>둔감 ±${TOL_RANGE.max}dB</span><span>보통 ±${tolMid}dB</span><span>예민 ±${TOL_RANGE.min}dB</span></div>
    <h2 style="margin-top:8px">피드백 민감도 <small id="fbInfo"></small></h2>
    <input id="fbSlider" type="range" min="0" max="100" step="5" />
    <div class="scale"><span>둔감</span><span>보통</span><span>예민</span></div>
    <h2 style="margin-top:8px">AI 조언 주기 <small id="intInfo"></small></h2>
    <input id="intSlider" type="range" min="${INTERVAL_RANGE.min}" max="${INTERVAL_RANGE.max}" step="${INTERVAL_RANGE.step}" />
    <div class="scale"><span>${INTERVAL_RANGE.min}초</span><span>${INTERVAL_RANGE.max}초</span></div>`;
  $('hud').closest('section')!.before(card);
  const tol = $<HTMLInputElement>('tolSlider'), fb = $<HTMLInputElement>('fbSlider'), it = $<HTMLInputElement>('intSlider');
  const paintTol = () => { $('tolInfo').textContent = `허용 편차 ±${tolDb}dB`; };
  const paintFb = () => {
    const p = fbParamsFor(fbSens / 100);
    $('fbInfo').textContent = `돌출 ${p.prominenceDb.toFixed(0)}dB · ${(p.confirmScans / 10).toFixed(1)}초 · ${p.minLevelDb.toFixed(0)}dBFS`;
  };
  const paintInt = () => { $('intInfo').textContent = `${intervalSec}초마다`; };
  // 슬라이더 위치(왼쪽 0) → 허용 편차: 왼쪽 = 큰 편차(둔감)
  tol.value = String(Math.round((TOL_RANGE.max - tolDb) / TOL_RANGE.step));
  fb.value = String(fbSens);
  it.value = String(intervalSec);
  tol.oninput = () => { tolDb = TOL_RANGE.max - parseFloat(tol.value) * TOL_RANGE.step; ls.set('lm.tol', String(tolDb)); paintTol(); };
  fb.oninput = () => { fbSens = parseFloat(fb.value); ls.set('lm.fb', String(fbSens)); engine.setFbSensitivity(fbSens / 100); paintFb(); };
  it.oninput = () => {
    intervalSec = parseFloat(it.value); ls.set('lm.interval', String(intervalSec));
    advice.setIntervalMs(intervalSec * 1000); paintInt();
    if (running && !aiPaused) setAnalyzeTimer();   // 오디오 스트림은 그대로, 타이머만 즉시 교체
  };
  engine.setFbSensitivity(fbSens / 100);
  advice.setIntervalMs(intervalSec * 1000);
  paintTol(); paintFb(); paintInt();
}

// ───────── 오디오 컨트롤: Thru 모니터링 / 백그라운드 유지 ─────────
let thruOn = false;                                   // 기본 OFF (하울링 주의)
let keepOn = ls.get('lm.keepalive2', '1') !== '0';    // 기본 ON (15Hz 유지 톤) · 키를 바꿔 예전에 OFF로 저장된 값을 초기화
{
  const box = startBtn.closest('section')!;
  box.insertAdjacentHTML('beforeend', `
    <button id="thruBtn" class="toggle"></button>
    <div id="thruHint" class="hint"></div>
    <button id="keepBtn" class="toggle"></button>
    <div class="hint">Even 앱으로 전환하거나 화면이 꺼져도 크롬이 분석을 멈추지 않도록, 귀·스피커로 들리지 않는 15Hz 초저역(-50 dBFS)을 출력합니다. &lt;audio&gt; 태그를 쓰지 않아 유튜브를 멈추지 않아요. <b>OFF로 두면 크롬이 백그라운드에서 멈춰 수신기가 '신호 지연'이 될 수 있어요.</b></div>`);
  const thruBtn = $('thruBtn'), keepBtn = $('keepBtn');
  const paint = () => {
    thruBtn.textContent = `🎧 입력 신호 출력 모니터링 (Thru ${thruOn ? 'ON' : 'OFF'})`;
    thruBtn.classList.toggle('active', thruOn);
    $('thruHint').textContent = thruOn
      ? '⚠ 하울링 주의: 입력이 스피커로 나가 마이크로 되돌아오면 피드백이 생깁니다. 이어폰/헤드폰을 사용하세요. (시스템 오디오 캡처 중에는 소리가 이중 재생될 수 있어요)'
      : '';
    keepBtn.textContent = `🔋 화면 꺼짐 백그라운드 유지 (유튜브 동시 재생 시 OFF 권장) : ${keepOn ? 'ON' : 'OFF'}`;
    keepBtn.classList.toggle('active', keepOn);
  };
  thruBtn.onclick = () => { thruOn = !thruOn; engine.setThru(thruOn); paint(); };
  keepBtn.onclick = () => { keepOn = !keepOn; ls.set('lm.keepalive2', keepOn ? '1' : '0'); engine.setKeepAlive(keepOn); paint(); };
  engine.setKeepAlive(keepOn); engine.setThru(false);
  paint();
}

$('resetBtn').onclick = () => { advice.resetCooldown(); renderCooldown(); setStatus('쿨다운 초기화됨'); };

const setStatus = (s: string) => { $('status').textContent = s; sender.update({ status: s }); };

// ───────── 렌더링 (폰 + 글래스 5줄 동기화) ─────────
function hudLines(): string[] {
  const lines = [fbText, ...advice.lines()];   // 피드백 없으면 1번 줄은 완전 빈 줄
  if (aiPaused) lines[4] = QUOTA_MSG;          // 할당량 소진 시 HUD 마지막 줄에 경고
  return lines;
}
function render() {
  const lines = hudLines();
  const sig = lines.join('\n');
  if (sig === lastRendered) return;
  lastRendered = sig;
  sender.update({ lines }, true);   // 바뀌는 즉시 발행 (피드백 발생/해제 포함 · 실행 중일 때만 실제 전송)
  if (mirroring) return;
  paintHud(lines);
  glasses.update(lines);
}
function renderCooldown() {
  const tags = advice.cooldownTags(Date.now());
  $('cooldownInfo').textContent = tags.length ? `쿨다운(5분): ${tags.join(', ')}` : '쿨다운 목록 없음';
}

// ───────── 오디오 시작/정지 ─────────
async function startAudio() {
  guardSystemCapture();
  let id = deviceSel.value || DEFAULT_INPUT_ID;
  if (id === REFERENCE_ID) {
    // 🎵 레퍼런스 플레이어: 미디어 요소 → Web Audio (분석 Pre-Fader 1.0 / 청취 Post-Fader monitorGain)
    if (!player.hasSource) player.loadDemo();
    engine.setMonitorVolume(player.vol);
    engine.setMedia(player.takeForAnalysis());
    try { await engine.start(id); } catch (e) { player.release(); throw e; }
    void player.play();
    $('inputInfo').textContent = '🎵 내장 레퍼런스 플레이어 · 디지털 원본 직결 (Pre-Fader 1.0) · 폰 볼륨/무음/청취 볼륨과 무관';
    return;
  }
  player.release();                      // 플레이어 모드에서 다른 입력으로 바꾸는 경우: 플레이어는 스피커 직접 재생으로 복귀
  try {
    await engine.start(id);              // 마이크 권한 팝업 + 3단계 Fallback
  } catch (e) {
    if (id !== SYSTEM_AUDIO_ID) throw e;
    // 시스템 캡처가 거부/실패하면 안내 후 기본 오디오 입력으로 자동 전환
    showNotice(`시스템/화면 오디오 캡처를 시작하지 못했습니다 (${describeError(e)}). 기본 오디오 입력으로 전환합니다.`);
    deviceSel.value = DEFAULT_INPUT_ID; ls.set('lm.device', DEFAULT_INPUT_ID);
    id = DEFAULT_INPUT_ID;
    await engine.start(id);
  }
  refreshDevices().catch(() => {});      // 권한 승인 직후: 실제 장치 이름과 deviceId 로 목록 갱신

  const info = engine.openInfo;
  const st = info?.settings;
  const ch = engine.channels;
  const parts: string[] = [];
  if (id === SYSTEM_AUDIO_ID) parts.push('📱 시스템 오디오 캡처 중 (공유를 끝내면 분석이 정지됩니다)');
  else parts.push(`입력: ${info?.label || '기본 장치'} · ${ch || '?'}ch · ${info?.step ?? 1}차 방식으로 열림`);
  if (ch === 1) parts.push('⚠ 모노로 열렸습니다 (R = L 복제)');
  if (info?.step === 3) parts.push('⚠ 기본 모드로 열림: OS 음성 보정(에코 제거/노이즈 억제/AGC)이 켜져 있을 수 있습니다');
  else if (st && (st.echoCancellation || st.noiseSuppression || st.autoGainControl)) parts.push('⚠ 브라우저가 음성 보정을 끄지 못했습니다 (EC/NS/AGC 일부 ON)');
  if (engine.ctxState && engine.ctxState !== 'running') parts.push('⚠ 오디오 엔진이 대기 상태입니다. 화면을 한 번 터치해 주세요');
  $('inputInfo').textContent = parts.join('\n');
}
document.addEventListener('pointerdown', () => { if (running) engine.resumeCtx(); });
// 앱 전환/화면 켜짐으로 돌아오면: 멈췄을 수 있는 오디오 엔진을 깨우고 현재 상태를 바로 발행
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !running) return;
  engine.resumeCtx();
  sender.publish();
});
// 크롬이 페이지를 얼리기 직전(freeze)·닫기 직전(pagehide): 수신기가 오래된 조언을 바로 지우도록 알림
document.addEventListener('freeze', () => { if (running) sender.publishFrozen(); });
window.addEventListener('pagehide', () => { if (running) sender.publishFrozen(); });
document.addEventListener('resume', () => { if (running) { engine.resumeCtx(); sender.publish(); } });

/** 안드로이드 앱(WebView) 안에서 실행 중이면 앱에 분석 상태를 알려 백그라운드 유지 서비스를 켜고 끈다 */
const nativeApp = (window as any).LiveMixNative as { setRunning?: (b: boolean) => void } | undefined;
const tellNative = (b: boolean) => { try { nativeApp?.setRunning?.(b); } catch (e) { console.warn('앱 연동 실패', e); } };

let starting = false;
startBtn.onclick = async () => {
  if (starting) return;
  if (running) { await stop(); return; }
  starting = true;
  clearError();
  startBtn.disabled = true; startBtn.textContent = '시작 중…';
  try {
    await startAudio();
  } catch (e) {
    console.error('시작 실패', e);
    showError(describeError(e));
    setStatus('시작 실패 — 버튼 아래 원인을 확인하세요');
    try { await engine.stop(); } catch { /* ignore */ }
    startBtn.disabled = false; startBtn.textContent = '시작';
    starting = false;
    return;
  }
  // 여기부터는 입력이 열린 상태: 부가 기능이 실패해도 분석은 계속되도록 각각 격리
  running = true;
  endMirror();
  lastCollectAt = Date.now();
  startBtn.disabled = false; startBtn.textContent = '정지'; startBtn.classList.add('on');
  try { schedule(); } catch (e) { console.error(e); showError('분석 타이머 시작 실패: ' + describeError(e)); }
  try { sender.setRunning(true); } catch (e) { console.warn('수신기 전송 시작 실패 (분석은 계속)', e); }
  tellNative(true);
  try { setStatus(glasses.connected ? '실행 중 · G2 연결됨' : '실행 중 · HUD 수신기로 전송'); } catch { /* ignore */ }
  starting = false;
};
async function stop() {
  running = false;
  try { sender.setRunning(false); } catch { /* ignore */ }
  tellNative(false);
  timers.forEach(clearTicker); timers = [];
  clearTicker(analyzeTimer); analyzeTimer = 0;
  await engine.stop();
  player.release();
  localLevels = null;
  startBtn.textContent = '시작'; startBtn.classList.remove('on');
  setStatus('정지');
}

// ───────── 주기 작업 ─────────
// 분석 루프는 requestAnimationFrame 을 쓰지 않는다 (크롬이 백그라운드로 가면 rAF 는 멈춤).
// Web Worker 타이머(ticker.ts) 50ms 루프에서 레벨·피드백을 계산하고, 1초 루프에서 밴드 표·전체 상태를 발행한다.
// 화면의 레벨 미터 그리기만 rAF(화면이 보일 때만)에서 한다.
let timers: number[] = [];
let tickN = 0;
function schedule() {
  timers.forEach(clearTicker);
  tickN = 0;
  timers = [
    setTicker(analysisTick, 50),
    setTicker(secondTick, TIMING.tickMs),
  ];
  if (!aiPaused) setAnalyzeTimer();
}

function analysisTick() {
  if (!running) return;
  tickN++;
  const lv = engine.readLevels();
  if (lv) localLevels = lv;
  if (tickN % 2 === 0) {                 // 0.1초: 피드백 스캔 (AI 미경유)
    const hit = engine.scanFeedback();
    const now = Date.now();
    if (hit) { fbText = `⚠️ 피드백: ${hit.hz}Hz`; fbUntil = now + TIMING.fbHoldMs; }
    else if (fbText && now > fbUntil) fbText = '';
    render();
  }
  if (tickN % 5 === 0 && localLevels) sender.sendLevels(localLevels[0], localLevels[1]);   // 0.25초: 레벨
}

function secondTick() {
  if (!running) return;
  if (advice.tick(Date.now())) render();
  renderCooldown();
  paintGenre();
  updateLiveBands();
  sender.update({ genre: genreLabel(), genreAt, levels: localLevels });
  sender.publish();                      // 1초마다 전체 상태 강제 동기화 (MQTT retain)
}

/** 현재 AI 구간의 누적값으로 밴드 표를 1초마다 갱신 (누적값은 지우지 않음) */
function updateLiveBands() {
  const b = engine.peekBands();
  if (Object.values(b).every(x => x.avgDb < -70)) { showBands(bandRows(b, null)); return; }
  const ev = evaluateBalance(b, tolDb);
  showBands(bandRows(b, ev.mode === 'solo' ? null : ev.deltas));
}

function setAnalyzeTimer() {
  clearTicker(analyzeTimer);
  analyzeTimer = setTicker(analyze, intervalSec * 1000);   // 슬라이더 주기 (5~60초)
}

// ───────── API 할당량 소진 → AI만 정지 (미터/피드백 감지는 계속) ─────────
function pauseForQuota() {
  aiPaused = true;
  clearTicker(analyzeTimer); analyzeTimer = 0;
  banner.hidden = false;
  $('resumeBtn').textContent = 'AI 분석 재개';
  setStatus('API 할당량 소진 · AI 정지 (미터/피드백은 계속)');
  lastRendered = ''; render();
}
engine.onEnded = () => { if (running) { setStatus('입력이 종료되었습니다 (오디오 공유 종료/장치 분리)'); void stop(); } };

function resumeAi() {
  aiPaused = false;
  banner.hidden = true;
  engine.collectBands(); engine.collectSpectrum(); engine.collectDynamics(); lastCollectAt = Date.now();   // 정지 중 쌓인 누적값 폐기
  if (running) setAnalyzeTimer();
  setStatus('AI 분석 재개');
  lastRendered = ''; render();
}
function onAiConfigChanged() {
  if (aiPaused) $('resumeBtn').textContent = 'AI 분석 재개 (설정 변경됨)';
}
$('resumeBtn').onclick = resumeAi;

async function analyze() {
  const bands = engine.collectBands();               // 항상 비워서 다음 구간 시작
  const spec = engine.collectSpectrum();
  const dyn = engine.collectDynamics();
  const peaks = spec.peaks;
  const nowMs = Date.now();
  const windowSec = Math.max(1, Math.round((nowMs - lastCollectAt) / 1000));
  lastCollectAt = nowMs;
  if (!running || aiPaused) return;
  const silent = Object.values(bands).every(b => b.avgDb < -70);
  if (silent) { showBands(bandRows(bands, null)); return; }   // 무신호면 호출 생략 (= NONE)

  // 로컬 집계(활성 대역/에너지 집중도) → Full Mix vs Solo 판별 → 사전 통과 필터
  const tol = tolDb;
  const ev = evaluateBalance(bands, tol, peaks);
  const solo = ev.mode === 'solo';
  showBands(bandRows(bands, solo ? null : ev.deltas));
  const modeInfo = `신호: ${solo ? 'Solo(PFL) 추정' : 'Full Mix'} · 활성 ${ev.signal.activeBands.length}/6 (${ev.signal.activeBands.join(', ') || '없음'})`;
  if (ev.pass) {
    setStatus(`${solo ? 'Solo' : '밸런스'} 양호 · AI 호출 생략 (NONE)`);
    setAiLast(`${modeInfo}\n로컬 필터 통과 → AI 호출 안 함`);
    return;
  }
  if (inFlight) return;
  const over = solo
    ? [ev.crestOk ? '협대역 피크' : 'Crest 범위 밖']
    : Object.entries(ev.deltas).filter(([, d]) => Math.abs(d) > tol).map(([n, d]) => `${n} ${d > 0 ? '+' : ''}${d}`);
  const gateInfo = `${modeInfo}\n필터 초과: ` + (over.length ? over.join(', ') : 'Crest 범위 밖');

  inFlight = true;
  const bandData = Object.fromEntries(Object.entries(bands).map(([n, b]) => [n, {
    avgDb: b.avgDb, peakDb: b.peakDb, crestDb: b.crestDb,
    deltaDb: solo ? null : ev.deltas[n],
    active: ev.signal.activeBands.includes(n),
    character: b.character,
  }]));
  const payload = {
    windowSec,
    toleranceDb: tol,
    signal: ev.signal,
    metrics: {                                       // 장르 판별용 로컬 집계
      ...dyn,
      subVsMidDb: spec.subVsMidDb,
      sub20to80SharePct: spec.sub20to80SharePct,
      voiceBandSharePct: spec.voiceBandSharePct,
    },
    bands: bandData,
    peaks,
    currentDisplay: advice.displayList().map(i => i.text),
    cooldown5min: advice.cooldownTags(nowMs),
  };
  try {
    const raw = await callAI(provider(), currentModel(), apiKeyInp.value.trim(), buildSystemPrompt(tol),
      `최근 ${windowSec}초 분석 데이터(JSON):\n${JSON.stringify(payload)}`);
    const res = parseReply(raw);
    if (res.genre) { genre = res.genre; genreAt = Date.now(); paintGenre(); sender.update({ genre: genreLabel(), genreAt }); }
    const added = advice.ingest(res.advice, Date.now());
    const text = raw.trim().replace(/\s+/g, ' ');
    setAiLast(`${gateInfo}\nAI 응답(${new Date().toLocaleTimeString()}): ${text || '(빈 응답)'}`);
    setStatus(!text ? 'AI 빈 응답' : res.none ? 'AI: NONE (지적 없음)' : !res.advice.length ? 'AI 응답 형식 불일치'
      : `AI: ${added.length}건 표시` + (res.advice.length > added.length ? ` · ${res.advice.length - added.length}건 제외(중복/쿨다운)` : ''));
    render(); renderCooldown();
  } catch (e) {
    if (isQuotaError(e)) pauseForQuota();           // 429 / RESOURCE_EXHAUSTED → 즉시 자동 정지
    else setStatus('AI 오류: ' + (e as Error).message.slice(0, 80));
  } finally { inFlight = false; }
}

const aiLast = document.createElement('div');
aiLast.id = 'aiLast'; aiLast.className = 'hint';
$('bandTable').after(aiLast);

function bandRows(b: Record<string, BandStat>, deltas: Record<string, number> | null): BandRow[] {
  return BANDS.map(x => {
    const s = b[x.name];
    const d = deltas ? deltas[x.name] ?? null : null;
    return { name: x.name, avgDb: s.avgDb, crestDb: s.crestDb, deltaDb: d, character: s.character, over: d !== null && Math.abs(d) > tolDb };
  });
}
function showBands(rows: BandRow[]) {
  lastRows = rows;
  sender.update({ bands: rows });
  if (!mirroring) renderBandTable($('bandTable'), rows);
}
function setAiLast(text: string) {
  sender.update({ aiLog: { at: Date.now(), text } });
  if (!mirroring) $('aiLast').textContent = text;
}

// ───────── 레벨 미터: 화면이 보일 때만 rAF 로 그림 (계산은 50ms 분석 루프에서) ─────────
function meterLoop() {
  paintMeters(document, running ? localLevels : mirroring ? remoteLevels : null);
  requestAnimationFrame(meterLoop);
}
requestAnimationFrame(meterLoop);

// ───────── 미러링: 이 기기에서 분석을 안 할 때 크롬 분석기 결과를 그대로 표시 (Even 앱 안의 분석기 모드 등) ─────────
const mirror = new HudReceiver();
const mirrorBox = document.createElement('div');
mirrorBox.id = 'mirrorBox'; mirrorBox.className = 'badge mirror'; mirrorBox.hidden = true;
$('genreBadge').after(mirrorBox);

function mirrorLabel(i: ReceiverInfo) {
  const t = i.lastUpdate ? clock(i.lastUpdate) : '-';
  return i.phase === 'live' ? `📡 크롬 분석기 미러링 · 🟢 실시간 수신 중 (마지막 업데이트: ${t})`
    : `📡 크롬 분석기 미러링 · 🟡 신호 지연 (마지막 업데이트: ${t})`;
}
function applyMirror(st: MixState, i: ReceiverInfo) {
  if (running) return;
  if (i.phase !== 'live' && i.phase !== 'stale') { if (mirroring) { paintHud(st.lines); glasses.update(st.lines); endMirror(); } return; }
  mirroring = true;
  mirrorBox.hidden = false;
  mirrorBox.textContent = mirrorLabel(i);
  const lines = linesToShow(st, i);
  paintHud(lines);
  glasses.update(lines);
  renderBandTable($('bandTable'), st.bands);
  $('genreBadge').textContent = genreText(st.genre, st.genreAt);
  $('aiLast').textContent = st.aiLog ? `[${clock(st.aiLog.at)}] ${st.aiLog.text}` : '';
  remoteLevels = st.levels;
}
function endMirror() {
  if (!mirroring) return;
  mirroring = false;
  mirrorBox.hidden = true;
  remoteLevels = null;
  lastRendered = ''; render();
  renderBandTable($('bandTable'), lastRows);
  $('aiLast').textContent = sender.state.aiLog?.text ?? '';
  paintGenre();
}
mirror.onUpdate = applyMirror;
mirror.onLevels = lv => { if (mirroring) remoteLevels = lv; };
setInterval(() => { if (!running && mirroring && mirror.state) applyMirror(mirror.state, mirror.info()); }, 1000);
mirror.onInfo = i => {
  if (running) return;
  if (mirroring && (i.phase === 'live' || i.phase === 'stale')) mirrorBox.textContent = mirrorLabel(i);
  else if (mirroring && mirror.state) applyMirror(mirror.state, i);
};

// ───────── 초기 렌더 + G2 연결 ─────────
paintGenre(); render(); renderCooldown(); renderBandTable($('bandTable'), null);
setStatus('분석기 모드 · 시작을 누르세요');
mirror.start();
glasses.init().then(ok => {
  if (ok && !running && !starting) setStatus('G2 연결됨 · 시작을 누르세요');   // 실행 중 상태 문구를 덮어쓰지 않음
}).catch(e => setStatus('G2 초기화 실패: ' + (e as Error).message));
