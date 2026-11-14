import { AudioEngine, type BandStat, type InputMode, listInputs, requestMicPermission, systemCaptureSupported, DEFAULT_INPUT_ID, TRIM } from './audio';
import { AdviceManager, COOLDOWN_DEFAULT, type CooldownScope } from './advice';
import { callAI, parseReply, buildSystemPrompt, isQuotaError, type Genre } from './ai';
import { evaluateBalance, TOL_RANGE } from './balance';
import { fbParamsFor } from './config';
import { Glasses } from './glasses';
import { HudSender, HudReceiver, linesToShow, type BandRow, type LevelPkt, type MixState, type ReceiverInfo } from './link';
import { renderBandTable, paintMeters, paintHud, genreText, clock } from './views';
import { setTicker, clearTicker } from './ticker';
import { KeepAlive, PipMonitor, type KaState } from './keepalive';
import { BANDS, PROVIDERS, INTERVAL_RANGE, type ProviderId } from './config';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ls = {
  get: (k: string, d = '') => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* 저장 불가 환경 */ } },
};

const engine = new AudioEngine();
const keep = new KeepAlive();
const pip = new PipMonitor();
const advice = new AdviceManager();
const glasses = new Glasses();
const sender = new HudSender();

let running = false;
let starting = false;
let mirroring = false;      // 로컬 분석이 꺼져 있고 다른 기기(크롬)의 분석 결과를 보여 주는 중
let localLevels: [LevelPkt, LevelPkt] | null = null;
let remoteLevels: [LevelPkt, LevelPkt] | null = null;
let lastRows: BandRow[] | null = null;
let fbText = '';
let fbUntil = 0;
let inFlight = false;
let lastRendered = '';
let lastCollectAt = Date.now();
let aiPaused = false;
let genre: Genre | null = null;
let genreAt = 0;
const QUOTA_MSG = '⚠️ API 할당량 소진: AI 조언 정지됨';
const FB_HOLD_MS = 2000;

// ───────── 배너 (할당량 / 안내) ─────────
const banner = document.createElement('div');
banner.id = 'quotaBanner'; banner.className = 'banner'; banner.hidden = true;
banner.innerHTML = `<div class="banner-row"><span>${QUOTA_MSG}</span><button id="resumeBtn" type="button">AI 분석 재개</button></div>
  <div class="hint">⚙️ 설정에서 API 키나 모델을 바꾼 뒤 재개하세요. 레벨 미터와 피드백 감지는 계속 작동 중입니다.</div>`;
document.getElementById('app')!.prepend(banner);

const notice = document.createElement('div');
notice.id = 'noticeBanner'; notice.className = 'banner info'; notice.hidden = true;
notice.innerHTML = `<div class="banner-row"><span id="noticeText"></span><button id="noticeClose" type="button">닫기</button></div>`;
document.getElementById('app')!.prepend(notice);
$('noticeClose').onclick = () => { notice.hidden = true; };
const showNotice = (msg: string) => { $('noticeText').textContent = msg; notice.hidden = false; };

const startBtn = $<HTMLButtonElement>('startBtn');
const errBox = document.createElement('div');
errBox.id = 'startError'; errBox.className = 'errbox'; errBox.hidden = true;
startBtn.parentElement!.after(errBox);
const showError = (msg: string) => { errBox.textContent = '⛔ ' + msg; errBox.hidden = false; };
const clearError = () => { errBox.hidden = true; errBox.textContent = ''; };

/** 안드로이드 앱(WebView)에서 실행될 때만: 분석 상태를 앱에 알림 (웹에서는 아무 일도 하지 않음) */
const tellNative = (b: boolean) => { try { (window as any).LiveMixNative?.setRunning?.(b); } catch { /* ignore */ } };

const setStatus = (s: string) => { $('status').textContent = s; sender.update({ status: s }); };

// ───────── 1) 헤더: 수신기 연결 상태 · URL 복사 · 설정 ─────────
const hudUrl = () => `${location.origin}${location.pathname}?mode=hud`;
sender.onState = i => {
  const mq = i.mqtt === 'on' ? 'MQTT 연결됨' : i.mqtt === 'connecting' ? 'MQTT 연결 중…' : 'MQTT 사용 불가';
  const el = $('linkState');
  el.textContent = i.receivers > 0 ? `🟢 수신기 ${i.receivers}개 연결됨` : `🔴 수신기 대기 · ${mq}`;
  el.className = `pill ${i.receivers > 0 ? 'live' : 'off'}`;
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
  b.textContent = ok ? '복사됨 ✓' : url;
  setTimeout(() => { b.textContent = old; }, ok ? 1800 : 6000);
};
const dlg = $<HTMLDialogElement>('settings');
$('settingsBtn').onclick = () => { if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', ''); };
dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });   // 바깥(배경) 터치로 닫기

// ───────── ⚙️ 설정: AI 서비스 / 모델 / API Key ─────────
const providerSel = $<HTMLSelectElement>('provider');
const modelSel = $<HTMLSelectElement>('model');
const customModel = $<HTMLInputElement>('customModel');
const apiKeyInp = $<HTMLInputElement>('apiKey');
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
function onAiConfigChanged() { if (aiPaused) $('resumeBtn').textContent = 'AI 분석 재개 (설정 변경됨)'; }
providerSel.onchange = () => { ls.set('lm.provider', provider()); loadProviderUI(); onAiConfigChanged(); };
modelSel.onchange = () => { customModel.hidden = modelSel.value !== CUSTOM; ls.set(`lm.model2.${provider()}`, currentModel()); onAiConfigChanged(); };
customModel.oninput = () => { ls.set(`lm.model2.${provider()}`, currentModel()); onAiConfigChanged(); };
apiKeyInp.oninput = () => { ls.set(`lm.key.${provider()}`, apiKeyInp.value.trim()); onAiConfigChanged(); };
loadProviderUI();

// ───────── ⚙️ 설정: 슬라이더 (왼쪽 = 둔감 · 오른쪽 = 예민) ─────────
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : lo));
let tolDb = clamp(parseFloat(ls.get('lm.tol', String(TOL_RANGE.default))), TOL_RANGE.min, TOL_RANGE.max);
let fbSens = clamp(parseFloat(ls.get('lm.fb', '50')), 0, 100);
let intervalSec = clamp(Math.round(parseFloat(ls.get('lm.interval', String(INTERVAL_RANGE.default))) / INTERVAL_RANGE.step) * INTERVAL_RANGE.step, INTERVAL_RANGE.min, INTERVAL_RANGE.max);
{
  const tol = $<HTMLInputElement>('tolSlider'), fb = $<HTMLInputElement>('fbSlider'), it = $<HTMLInputElement>('intSlider');
  tol.min = '0'; tol.max = String(Math.round((TOL_RANGE.max - TOL_RANGE.min) / TOL_RANGE.step));
  $('tolLo').textContent = `둔감 ±${TOL_RANGE.max}dB`; $('tolMid').textContent = `보통 ±${(TOL_RANGE.max + TOL_RANGE.min) / 2}dB`; $('tolHi').textContent = `예민 ±${TOL_RANGE.min}dB`;
  it.min = String(INTERVAL_RANGE.min); it.max = String(INTERVAL_RANGE.max); it.step = String(INTERVAL_RANGE.step);
  $('intLo').textContent = `${INTERVAL_RANGE.min}초`; $('intHi').textContent = `${INTERVAL_RANGE.max}초`;
  const paintTol = () => { $('tolInfo').textContent = `허용 편차 ±${tolDb}dB`; };
  const paintFb = () => {
    const p = fbParamsFor(fbSens / 100);
    $('fbInfo').textContent = `돌출 ${p.prominenceDb.toFixed(0)}dB · ${(p.confirmScans / 10).toFixed(1)}초 · ${p.minLevelDb.toFixed(0)}dBFS`;
  };
  const paintInt = () => { $('intInfo').textContent = `${intervalSec}초마다`; };
  tol.value = String(Math.round((TOL_RANGE.max - tolDb) / TOL_RANGE.step));
  fb.value = String(fbSens);
  it.value = String(intervalSec);
  tol.oninput = () => { tolDb = TOL_RANGE.max - parseFloat(tol.value) * TOL_RANGE.step; ls.set('lm.tol', String(tolDb)); paintTol(); };
  fb.oninput = () => { fbSens = parseFloat(fb.value); ls.set('lm.fb', String(fbSens)); engine.setFbSensitivity(fbSens / 100); paintFb(); };
  it.oninput = () => { intervalSec = parseFloat(it.value); ls.set('lm.interval', String(intervalSec)); advice.setIntervalMs(intervalSec * 1000); paintInt(); };
  engine.setFbSensitivity(fbSens / 100);
  advice.setIntervalMs(intervalSec * 1000);
  paintTol(); paintFb(); paintInt();
}

// ───────── ⚙️ 설정: 쿨다운 상세 설정 ─────────
{
  const hold = $<HTMLInputElement>('cdHold'), trig = $<HTMLSelectElement>('cdTrigger'), scope = $<HTMLSelectElement>('cdScope');
  const holdSec = clamp(parseFloat(ls.get('lm.cdHold', String(COOLDOWN_DEFAULT.holdSec))), 0, 600);
  const trigger = (['1', '2', '3'].includes(ls.get('lm.cdTrig', '')) ? +ls.get('lm.cdTrig') : COOLDOWN_DEFAULT.trigger) as 1 | 2 | 3;
  const sc = (ls.get('lm.cdScope', COOLDOWN_DEFAULT.scope) === 'strict' ? 'strict' : 'standard') as CooldownScope;
  hold.value = String(holdSec); trig.value = String(trigger); scope.value = sc;
  const fmt = (v: number) => (v <= 0 ? '끄기 (쿨다운 미적용)' : v < 60 ? `${v}초` : `${Math.floor(v / 60)}분${v % 60 ? ` ${v % 60}초` : ''} (${v}초)`);
  const paint = () => { $('cdHoldInfo').textContent = fmt(+hold.value); };
  hold.oninput = () => { ls.set('lm.cdHold', hold.value); advice.setCooldown({ holdSec: +hold.value }); paint(); renderCooldown(); };
  trig.onchange = () => { ls.set('lm.cdTrig', trig.value); advice.setCooldown({ trigger: +trig.value as 1 | 2 | 3 }); };
  scope.onchange = () => { ls.set('lm.cdScope', scope.value); advice.setCooldown({ scope: scope.value as CooldownScope }); renderCooldown(); };
  advice.setCooldown({ holdSec, trigger, scope: sc });
  paint();
}

// ───────── ⚙️ 설정: 노이즈 게이트 (실시간 재생음 모드) ─────────
let gateDb = clamp(parseFloat(ls.get('lm.gate', '-38')), -55, -20);
{
  const g = $<HTMLInputElement>('gateSlider');
  g.value = String(gateDb);
  const paint = () => { $('gateInfo').textContent = `${gateDb} dBFS`; };
  g.oninput = () => { gateDb = +g.value; ls.set('lm.gate', String(gateDb)); applyGate(); paint(); };
  paint();
}
function applyGate() { engine.setGate(mode === 'monitor', gateDb); }

// ───────── 2) 오디오 입력 모드: 🎛️ 콘솔 2-Track (1순위·기본) / ▶️ 실시간 유튜브·재생음 (2순위) ─────────
let mode: InputMode = ls.get('lm.inmode', 'console') === 'monitor' ? 'monitor' : 'console';
/** Auto-Trim 은 모드별로 따로 기억: 콘솔 기본 OFF(Raw dBFS) · 모니터링 기본 ON */
const trimFor = (m: InputMode) => ls.get(`lm.trim.${m}`, m === 'monitor' ? '1' : '0') === '1';
let thruOn = false;   // 하울링 위험 → 항상 OFF 로 시작

const deviceSel = $<HTMLSelectElement>('device');
const findBtn = $<HTMLButtonElement>('findBtn');

function monitorHintText(): string {
  return systemCaptureSupported()
    ? '🖥️ 시작을 누르면 공유 창이 열립니다. 유튜브 탭(또는 전체 화면)을 고르고 "오디오 공유"를 켜 주세요. 재생 중인 소리를 디지털로 직접 분석합니다.'
    : '📱 USB 인터페이스(ZOOM AMS-24 등)가 연결돼 있으면 그 입력(루프백)을 먼저 열고, 없으면 폰 마이크로 들리는 소리를 수음합니다. Auto-Trim이 볼륨 차이를 보정하고, 노이즈 게이트가 무음일 때 방 소음 분석을 막습니다.';
}

function paintMode() {
  document.querySelectorAll<HTMLButtonElement>('#modeSeg button').forEach(b => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  $('consolePane').hidden = mode !== 'console';
  const h = $('monitorHint');
  h.hidden = mode !== 'monitor';
  h.textContent = monitorHintText();
  paintToggles();
}

document.querySelectorAll<HTMLButtonElement>('#modeSeg button').forEach(b => {
  b.onclick = async () => {
    const m = b.dataset.mode as InputMode;
    if (m === mode || starting) return;
    mode = m; ls.set('lm.inmode', m);
    engine.setAutoTrim(trimFor(m));
    applyGate();
    paintMode();
    if (!running) return;
    // 분석 중 모드 전환: 이 클릭(사용자 동작) 안에서 바로 새 입력을 연다 (공유 창/권한 팝업 허용)
    try { await startAudio(); clearError(); }
    catch (e) { showError(describeError(e)); await stop(); }
  };
});

/** 오류를 사람이 읽을 수 있는 원인으로 변환 */
function describeError(e: unknown): string {
  const name = (e as { name?: string } | null)?.name ?? '';
  const msg = e instanceof Error ? e.message : String(e);
  const detail = name && name !== 'Error' ? ` (${name}: ${msg})` : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError')
    return mode === 'monitor' && systemCaptureSupported()
      ? `화면/오디오 공유가 취소되었거나 거부되었습니다. 다시 시작하고 공유 창에서 유튜브 탭과 "오디오 공유"를 선택하세요.${detail}`
      : `마이크 권한이 거부되었습니다. 주소창 왼쪽 아이콘 → 권한 → 마이크를 '허용'으로 바꾸고, 안드로이드 설정에서 크롬 앱의 마이크 권한도 확인한 뒤 다시 시도하세요.${detail}`;
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError')
    return `오디오 입력 장치를 찾지 못했습니다. USB 인터페이스 연결(전원·케이블·OTG)을 확인하고 [🔄 장치 찾기]를 눌러 주세요.${detail}`;
  if (name === 'NotReadableError' || name === 'TrackStartError')
    return `입력 장치를 열 수 없습니다. 다른 앱이 마이크/인터페이스를 사용 중이거나 USB 연결이 불안정합니다.${detail}`;
  if (name === 'OverconstrainedError') return `장치가 요청한 설정을 지원하지 않습니다.${detail}`;
  return (msg || '알 수 없는 오류') + (name && name !== 'Error' ? ` (${name})` : '');
}

const DEFAULT_LABEL = '🔌 기본 오디오 입력 (연결된 USB 인터페이스 자동)';
function fillDevices(devs: MediaDeviceInfo[]) {
  const real = devs.filter(d => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const keep = deviceSel.value || ls.get('lm.device', DEFAULT_INPUT_ID);
  deviceSel.innerHTML = '';
  const add = (value: string, label: string) => {
    const o = document.createElement('option');
    o.value = value; o.textContent = label;
    deviceSel.appendChild(o);
  };
  add(DEFAULT_INPUT_ID, DEFAULT_LABEL);
  real.forEach((d, i) => add(d.deviceId, d.label || `입력 ${i + 1}`));
  deviceSel.value = real.some(d => d.deviceId === keep) ? keep : DEFAULT_INPUT_ID;
}
async function refreshDevices(askPermission = false) {
  if (askPermission && !running) await requestMicPermission();
  fillDevices(await listInputs());
}
findBtn.onclick = async () => {
  const old = findBtn.textContent;
  findBtn.disabled = true; findBtn.textContent = '찾는 중…';
  try {
    await refreshDevices(true);
    clearError();
    const n = deviceSel.options.length - 1;
    setStatus(n > 0 ? `입력 장치 ${n}개 찾음` : '개별 장치 없음 · 기본 오디오 입력을 사용하세요');
  } catch (e) {
    showError(describeError(e));
    try { fillDevices(await listInputs()); } catch { /* ignore */ }
  } finally { findBtn.disabled = false; findBtn.textContent = old; }
};
deviceSel.onchange = async () => {
  ls.set('lm.device', deviceSel.value);
  if (!running || mode !== 'console') return;
  try { await startAudio(); clearError(); }
  catch (e) { showError(describeError(e)); await stop(); }
};
try { navigator.mediaDevices?.addEventListener?.('devicechange', () => { refreshDevices().catch(() => {}); }); } catch { /* ignore */ }
fillDevices([]);
refreshDevices().catch(() => {});

// ───────── ⚙️ 설정: Thru 모니터링 / Auto-Trim 수동 토글 ─────────
function paintToggles() {
  const thruBtn = $('thruBtn'), trimBtn = $('trimBtn');
  thruBtn.textContent = `🎧 입력 신호 출력 모니터링 (Thru ${thruOn ? 'ON' : 'OFF'})`;
  thruBtn.classList.toggle('active', thruOn);
  $('thruHint').textContent = thruOn
    ? '⚠ 하울링 주의: 입력이 스피커로 나가 마이크로 되돌아오면 피드백이 생깁니다. 이어폰/헤드폰을 사용하세요.'
    : '입력 신호를 이 기기 스피커/이어폰으로 그대로 들려줍니다 (보정 전 원본).';
  const on = engine.autoTrim;
  trimBtn.textContent = `🎚️ 볼륨 무관 레벨 고정 (Auto-Trim ${on ? 'ON' : 'OFF'}) · ${mode === 'console' ? '콘솔 모드' : '모니터링 모드'}`;
  trimBtn.classList.toggle('active', on);
  $('trimHint').textContent = `무음(${TRIM.gateDb}dBFS 미만)을 뺀 최근 약 ${TRIM.tauSec}초 평균 레벨을 ${TRIM.targetDb}dBFS 기준으로 자동 보정해, 기기 볼륨과 상관없이 같은 기준에서 분석합니다. `
    + (mode === 'console' ? '콘솔 모드는 실제 물리 레벨(Raw dBFS)을 봐야 하므로 기본 OFF입니다.' : '모니터링 모드는 기본 ON입니다.')
    + ' 모드별로 따로 기억됩니다.';
  $('meterInfo').textContent = on ? `-60 ~ 0 dBFS · Auto-Trim ${engine.trimDb >= 0 ? '+' : ''}${engine.trimDb.toFixed(1)}dB 보정됨` : '-60 ~ 0 dBFS · Raw';
}
$('thruBtn').onclick = () => { thruOn = !thruOn; engine.setThru(thruOn); paintToggles(); };
$('trimBtn').onclick = () => {
  const on = !engine.autoTrim;
  ls.set(`lm.trim.${mode}`, on ? '1' : '0');
  engine.setAutoTrim(on);
  paintToggles();
};
engine.setAutoTrim(trimFor(mode));
engine.setThru(false);
applyGate();
paintMode();

$('resetBtn').onclick = () => { advice.resetCooldown(); renderCooldown(); setStatus('쿨다운 초기화됨'); };

// ───────── 🛡️ 백그라운드 유지 상태 · 📌 PiP 버튼 · WAV 유지 설정 ─────────
const KA_ICON: Record<KaState, string> = { off: '–', starting: '…', on: '✔', failed: '✖', unsupported: '미지원' };
/** 모니터링 모드에서 WAV 유지 사용 여부 (유튜브가 멈추면 끔). 콘솔 모드는 항상 사용 */
let wavInMonitor = ls.get('lm.wavMon', '1') !== '0';
const useWav = () => mode === 'console' || wavInMonitor;
function paintKeep() {
  $('keepState').textContent = running
    ? `🛡️ 백그라운드 유지  WebRTC ${KA_ICON[keep.rtc]} · WAV ${useWav() ? KA_ICON[keep.wav] : '끔'} · PiP ${KA_ICON[pip.state]}`
    : '🛡️ 시작하면 백그라운드 유지 장치(WebRTC·WAV)가 함께 켜집니다';
  const b = $<HTMLButtonElement>('pipBtn');
  b.disabled = pip.state === 'unsupported' || pip.state === 'starting';
  b.classList.toggle('active', pip.active);
  b.textContent = pip.state === 'unsupported' ? '📌 PiP 팝업 (이 브라우저 미지원)'
    : pip.active ? '📌 PiP 팝업 켜짐 · 누르면 닫기' : '📌 앱 전환 시 멈춤 방지 (PiP 팝업)';
  const w = $('wavBtn');
  w.textContent = `🔈 모니터링 모드에서 WAV 유지 재생 : ${wavInMonitor ? 'ON' : 'OFF'}`;
  w.classList.toggle('active', wavInMonitor);
}
keep.onChange = paintKeep;
pip.onChange = paintKeep;
$('pipBtn').onclick = () => {
  void pip.toggle(() => pip.draw(localLevels, hudLines(), genreText(genreLabel(), genreAt), $('status').textContent || ''));
};
$('wavBtn').onclick = async () => {
  wavInMonitor = !wavInMonitor; ls.set('lm.wavMon', wavInMonitor ? '1' : '0');
  if (running && mode === 'monitor' && engine.inputStream) await keep.start(engine.inputStream, useWav());
  paintKeep();
};
paintKeep();

// ───────── 렌더링 (폰 + 글래스 5줄 동기화) ─────────
function genreLabel(): string {
  if (!genre) return '';
  return genre.kind === 'solo' ? `🎧 감지된 상태: ${genre.instrument || '단일 악기'} Solo`
    : genre.kind === 'speech' ? '🎤 감지된 상태: 스피치/설교'
    : `🎵 감지된 장르: ${genre.category}`;
}
const IDLE_TEXT = '⏸️ 신호 대기 중 (음악이 재생되면 자동 분석)';
function paintGenre() {
  if (mirroring) return;
  const b = $('genreBadge');
  b.classList.toggle('idle', running && engine.idle);
  b.textContent = running && engine.idle ? IDLE_TEXT : genreText(genreLabel(), genreAt);
}
/** 수신기에 보내는 배지 문구 (무음 대기 중이면 대기 표시) */
const badgeForSend = () => (engine.idle ? IDLE_TEXT : genreLabel());

function hudLines(): string[] {
  const lines = [fbText, ...advice.lines()];
  if (aiPaused) lines[4] = QUOTA_MSG;
  return lines;
}
function render() {
  const lines = hudLines();
  const sig = lines.join('\n');
  if (sig === lastRendered) return;
  lastRendered = sig;
  sender.update({ lines }, true);
  if (mirroring) return;
  paintHud(lines);
  glasses.update(lines);
}
/** 쿨다운은 화면에 표시하지 않음 (내부 목록만 유지 · AI 에 전달) */
function renderCooldown() { /* 표시 없음 */ }

// ───────── 오디오 시작/정지 ─────────
const modeName = () => (mode === 'console' ? '🎛️ 콘솔 2-Track' : '▶️ 유튜브/재생음 모니터링');

async function startAudio() {
  engine.setAutoTrim(trimFor(mode));
  await engine.start(mode, deviceSel.value || DEFAULT_INPUT_ID);
  if (mode === 'console') refreshDevices().catch(() => {});   // 권한 승인 직후: 실제 장치 이름으로 목록 갱신

  // 🛡️ 3중 백그라운드 유지: A. WebRTC 루프백 + B. WAV 루프·미디어 세션 (+ C. PiP 는 버튼으로)
  const stream = engine.inputStream;
  if (stream) await keep.start(stream, useWav());
  if (keep.rtc === 'failed' && keep.wav !== 'on') showNotice('백그라운드 유지 장치를 시작하지 못했습니다. 앱을 전환하기 전에 [📌 PiP 팝업]을 켜 주세요.');

  const info = engine.openInfo, st = info?.settings, ch = engine.channels;
  const parts: string[] = [];
  if (mode === 'monitor' && systemCaptureSupported()) parts.push('🖥️ 시스템/탭 오디오 캡처 중 (공유를 끝내면 분석이 정지됩니다)');
  else parts.push(`${modeName()} · ${info?.label || '기본 장치'} · ${ch || '?'}ch · ${info?.step ?? 1}차 방식으로 열림`);
  if (info?.usb) parts.push('🔌 USB 오디오 인터페이스를 내장 마이크보다 우선 연결했습니다');
  if (mode === 'monitor') parts.push(`🚪 노이즈 게이트 ${gateDb} dBFS · 1.5초 이상 무음이면 대기`);
  if (ch === 1) parts.push('⚠ 모노로 열렸습니다 (R = L 복제)');
  if (info?.step === 3) parts.push('⚠ 기본 모드로 열림: OS 음성 보정(에코 제거/노이즈 억제/AGC)이 켜져 있을 수 있습니다');
  else if (st && (st.echoCancellation || st.noiseSuppression || st.autoGainControl)) parts.push('⚠ 브라우저가 음성 보정을 끄지 못했습니다 (EC/NS/AGC 일부 ON)');
  if (engine.state !== 'running') parts.push('⚠ 오디오 엔진이 대기 상태입니다. 화면을 한 번 터치해 주세요');
  $('inputInfo').textContent = parts.join('\n');
  paintToggles();
}

document.addEventListener('pointerdown', () => {
  if (!running) return;
  engine.resumeCtx();
  keep.heal();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !running) return;
  engine.resumeCtx();
  sender.publish();
});
document.addEventListener('freeze', () => { if (running) sender.publishFrozen(); });
window.addEventListener('pagehide', () => { if (running) sender.publishFrozen(); });
document.addEventListener('resume', () => { if (running) { engine.resumeCtx(); sender.publish(); } });

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
    keep.stop();
    startBtn.disabled = false; startBtn.textContent = '시작';
    starting = false;
    return;
  }
  running = true;
  endMirror();
  lastCollectAt = Date.now(); lastAnalyzeAt = Date.now(); lastSecondAt = 0;
  startBtn.disabled = false; startBtn.textContent = '정지'; startBtn.classList.add('on');
  startTicker();
  tellNative(true);
  try { sender.setRunning(true); } catch (e) { console.warn('수신기 전송 시작 실패 (분석은 계속)', e); }
  setStatus(`실행 중 · ${modeName()}${glasses.connected ? ' · G2 연결됨' : ''}`);
  starting = false;
};

async function stop() {
  running = false;
  try { sender.setRunning(false); } catch { /* ignore */ }
  clearTicker(ticker); ticker = 0;
  tellNative(false);
  await engine.stop();
  keep.stop();
  void pip.close();
  localLevels = null;
  startBtn.textContent = '시작'; startBtn.classList.remove('on');
  setStatus('정지');
}
engine.onIdleChange = idle => {
  const now = Date.now();
  if (idle) {
    localLevels = [{ rmsDb: -120, peakDb: -120, clip: false }, { rmsDb: -120, peakDb: -120, clip: false }];
    showBands(null);
    setStatus('⏸️ 신호 대기 중 · 게이트 아래 무음 (Auto-Trim 0dB 동결)');
  } else {
    lastCollectAt = now; lastAnalyzeAt = now;        // 음악이 다시 나오면 새 구간부터 분석
    setStatus(`실행 중 · ${modeName()} · 신호 감지 → 분석 재개`);
  }
  paintGenre(); paintToggles();
  sender.update({ genre: badgeForSend(), genreAt: idle ? 0 : genreAt, levels: localLevels }, true);
};
engine.onEnded = () => { if (running) { setStatus('입력이 종료되었습니다 (오디오 공유 종료/장치 분리)'); void stop(); } };

// ───────── 4) 백그라운드에서도 멈추지 않는 단일 100ms 틱 ─────────
// 인라인 Blob Web Worker(ticker.ts)가 100ms 마다 postMessage → 여기서 FFT 수집·피드백·6밴드 누적·1초 MQTT·AI 타이머를 모두 구동.
// rAF/일반 setInterval 은 쓰지 않는다. Worker 가 늦어지면 오디오 스레드(ScriptProcessor) 하트비트가 대신 깨운다.
let ticker = 0;
let tickN = 0;
let lastTickAt = 0;
let lastSecondAt = 0;
let lastAnalyzeAt = 0;
let recoverCount = 0;

function startTicker() {
  clearTicker(ticker);
  tickN = 0; lastTickAt = performance.now();
  ticker = setTicker(masterTick, 100);
}
engine.onAudioBeat = () => {
  if (running && performance.now() - lastTickAt > 350) masterTick();   // Worker 틱이 끊기면 오디오 스레드가 대신 구동
};

function masterTick() {
  if (!running) return;
  lastTickAt = performance.now();
  tickN++;
  // 워치독: suspended 면 즉시 resume
  if (engine.watchdog()) recoverCount++;
  engine.updateTrim();                        // Auto-Trim (OFF 면 측정만)
  engine.pollBands();                         // 6밴드 + 전대역 누적
  const lv = engine.readLevels();
  if (lv) localLevels = lv;
  // 피드백 스캔 (0.1초마다 · AI 미경유)
  const hit = engine.scanFeedback();
  const now = Date.now();
  if (hit) { fbText = `⚠️ 피드백: ${hit.hz}Hz`; fbUntil = now + FB_HOLD_MS; }
  else if (fbText && now > fbUntil) fbText = '';
  render();
  if (pip.active) pip.draw(localLevels, hudLines(), engine.idle ? IDLE_TEXT : genreText(genreLabel(), genreAt), $('status').textContent || '');
  if (tickN % 2 === 0 && localLevels) sender.sendLevels(localLevels[0], localLevels[1]);   // 0.2초: 레벨
  if (now - lastSecondAt >= 1000) { lastSecondAt = now; secondTick(); }
  if (engine.idle) lastAnalyzeAt = now;           // 무음 대기: AI 호출 일시 중지
  else if (!aiPaused && now - lastAnalyzeAt >= intervalSec * 1000) { lastAnalyzeAt = now; void analyze(); }
}

function secondTick() {
  if (advice.tick(Date.now())) render();
  renderCooldown();
  paintGenre();
  updateLiveBands();
  paintToggles();
  keep.heal();                                // 시스템이 멈춘 유지 재생 재개
  paintKeep();
  sender.update({ genre: badgeForSend(), genreAt: engine.idle ? 0 : genreAt, levels: localLevels });
  sender.publish();                           // 1초마다 전체 상태 retain 발행
  $('bandInfo').textContent = `${engine.autoTrim ? 'Auto-Trim 기준' : 'Raw'} · 엔진 ${engine.state}${recoverCount ? ` · 자동 복구 ${recoverCount}회` : ''}`;
}

function updateLiveBands() {
  if (engine.idle) { showBands(null); return; }
  const b = engine.peekBands();
  if (Object.values(b).every(x => x.avgDb < -70)) { showBands(bandRows(b, null)); return; }
  const ev = evaluateBalance(b, tolDb);
  showBands(bandRows(b, ev.mode === 'solo' ? null : ev.deltas));
}

// ───────── API 할당량 소진 → AI만 정지 ─────────
function pauseForQuota() {
  aiPaused = true;
  banner.hidden = false;
  $('resumeBtn').textContent = 'AI 분석 재개';
  setStatus('API 할당량 소진 · AI 정지 (미터/피드백은 계속)');
  lastRendered = ''; render();
}
function resumeAi() {
  aiPaused = false;
  banner.hidden = true;
  engine.collectBands(); engine.collectSpectrum(); engine.collectDynamics();
  lastCollectAt = Date.now(); lastAnalyzeAt = Date.now();
  setStatus('AI 분석 재개');
  lastRendered = ''; render();
}
$('resumeBtn').onclick = resumeAi;

async function analyze() {
  const bands = engine.collectBands();
  const spec = engine.collectSpectrum();
  const dyn = engine.collectDynamics();
  const peaks = spec.peaks;
  const nowMs = Date.now();
  const windowSec = Math.max(1, Math.round((nowMs - lastCollectAt) / 1000));
  lastCollectAt = nowMs;
  if (!running || aiPaused || engine.idle) return;
  const silent = Object.values(bands).every(b => b.avgDb < -70);
  if (silent) { showBands(bandRows(bands, null)); return; }

  const tol = tolDb;
  const ev = evaluateBalance(bands, tol, peaks);
  const solo = ev.mode === 'solo';
  showBands(bandRows(bands, solo ? null : ev.deltas));
  const modeInfo = `입력: ${modeName()}${engine.autoTrim ? ` (Auto-Trim ${engine.trimDb >= 0 ? '+' : ''}${engine.trimDb}dB)` : ' (Raw)'}`
    + ` · 신호: ${solo ? 'Solo(PFL) 추정' : 'Full Mix'} · 활성 ${ev.signal.activeBands.length}/6 (${ev.signal.activeBands.join(', ') || '없음'})`;
  if (ev.pass) {
    setStatus(`${solo ? 'Solo' : '밸런스'} 양호 · AI 호출 생략 (NONE)`);
    setAiLast(`${modeInfo}\n로컬 필터 통과 → AI 호출 안 함`);
    return;
  }
  if (inFlight) return;
  const key = apiKeyInp.value.trim();
  if (!key) { setStatus('⚙️ 설정에서 API Key를 입력하면 AI 조언이 시작됩니다'); setAiLast(`${modeInfo}\nAPI Key 없음 → AI 호출 안 함`); return; }
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
    inputMode: mode === 'console' ? 'console-2track-raw' : 'playback-monitor-autotrim',
    levelReference: engine.autoTrim ? `auto-trim normalized to ${TRIM.targetDb} dBFS (absolute level not meaningful)` : 'raw dBFS from console',
    captureNote: captureNote(),
    signal: ev.signal,
    features: {
      relativeSpectralBalanceDb: Object.fromEntries(Object.entries(bands).map(([n, b]) => [n, b.relDb])),
      bandCrestDb: Object.fromEntries(Object.entries(bands).map(([n, b]) => [n, b.crestDb])),
      transientDensityPerMin: dyn.transientDensityPerMin,
      transientFluxDb: dyn.transientFluxDb,
      spectralCentroidHz: spec.spectralCentroidHz,
      decayTail: dyn.decayTail,
      fullCrestDb: dyn.fullCrestDb,
      fullRmsDb: dyn.fullRmsDb,
      subVsMidDb: spec.subVsMidDb,
      sub20to80SharePct: spec.sub20to80SharePct,
      voiceBandSharePct: spec.voiceBandSharePct,
      measuredSec: dyn.activeSec,
    },
    bands: bandData,
    peaks,
    currentDisplay: advice.displayList().map(i => i.text),
    cooldownList: advice.cooldownTags(nowMs),
  };
  try {
    const raw = await callAI(provider(), currentModel(), key, buildSystemPrompt(tol),
      `최근 ${windowSec}초 분석 데이터(JSON):\n${JSON.stringify(payload)}`);
    const res = parseReply(raw);
    if (res.genre) { genre = res.genre; genreAt = Date.now(); paintGenre(); sender.update({ genre: badgeForSend(), genreAt }); }
    const added = advice.ingest(res.advice, Date.now());
    const text = raw.trim().replace(/\s+/g, ' ');
    setAiLast(`${gateInfo}\nAI 응답(${new Date().toLocaleTimeString()}): ${text || '(빈 응답)'}`);
    setStatus(!text ? 'AI 빈 응답' : res.none ? 'AI: NONE (지적 없음)' : !res.advice.length ? 'AI 응답 형식 불일치'
      : `AI: ${added.length}건 표시` + (res.advice.length > added.length ? ` · ${res.advice.length - added.length}건 제외(중복/쿨다운)` : ''));
    render(); renderCooldown();
  } catch (e) {
    if (isQuotaError(e)) pauseForQuota();
    else setStatus('AI 오류: ' + (e as Error).message.slice(0, 80));
  } finally { inFlight = false; }
}

/** AI 에 알려 줄 수음 경로 특성 */
function captureNote(): string {
  const o = engine.openInfo;
  if (mode === 'console') return o?.usb ? 'USB 오디오 인터페이스 2트랙 직결 (Raw)' : '콘솔 2트랙 입력 (Raw)';
  if (systemCaptureSupported()) return '데스크탑 시스템/탭 오디오 디지털 캡처 (레벨 정규화됨)';
  return o?.usb ? 'USB 인터페이스 루프백 입력 (레벨 정규화됨)'
    : '스마트폰 내장 마이크로 스피커 재생음을 수음 — 저역(특히 Sub/Low)이 실제보다 크게 깎이고 방 울림이 섞임. 상대 비율·리듬 어택 위주로 판단';
}

function bandRows(b: Record<string, BandStat>, deltas: Record<string, number> | null): BandRow[] {
  return BANDS.map(x => {
    const s = b[x.name];
    const d = deltas ? deltas[x.name] ?? null : null;
    return { name: x.name, avgDb: s.avgDb, crestDb: s.crestDb, deltaDb: d, character: s.character, over: d !== null && Math.abs(d) > tolDb };
  });
}
function showBands(rows: BandRow[] | null) {
  lastRows = rows;
  sender.update({ bands: rows });
  if (!mirroring) renderBandTable($('bandTable'), rows);
}
function setAiLast(text: string) {
  sender.update({ aiLog: { at: Date.now(), text } });
  if (!mirroring) $('aiLast').textContent = text;
}

// 레벨 미터 그리기만 rAF (화면이 보일 때만 · 값 계산은 100ms Worker 틱)
function meterLoop() {
  paintMeters(document, running ? localLevels : mirroring ? remoteLevels : null);
  requestAnimationFrame(meterLoop);
}
requestAnimationFrame(meterLoop);

// ───────── 미러링: 이 기기에서 분석을 안 할 때 다른 기기의 분석 결과를 그대로 표시 ─────────
const mirror = new HudReceiver();
const mirrorBox = document.createElement('div');
mirrorBox.id = 'mirrorBox'; mirrorBox.className = 'badge mirror'; mirrorBox.hidden = true;
$('genreBadge').after(mirrorBox);
function mirrorLabel(i: ReceiverInfo) {
  const t = i.lastUpdate ? clock(i.lastUpdate) : '-';
  return i.phase === 'live' ? `📡 다른 기기 분석기 미러링 · 🟢 실시간 (마지막 업데이트: ${t})`
    : `📡 다른 기기 분석기 미러링 · 🟡 신호 지연 (마지막 업데이트: ${t})`;
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
setTicker(() => { if (!running && mirroring && mirror.state) applyMirror(mirror.state, mirror.info()); }, 1000);
mirror.onInfo = i => {
  if (running) return;
  if (mirroring && (i.phase === 'live' || i.phase === 'stale')) mirrorBox.textContent = mirrorLabel(i);
  else if (mirroring && mirror.state) applyMirror(mirror.state, i);
};

// ───────── 초기 렌더 + G2 연결 ─────────
paintGenre(); render(); renderCooldown(); renderBandTable($('bandTable'), null);
setStatus(apiKeyInp.value.trim() ? '시작을 누르세요' : '⚙️ 설정에서 API Key를 입력한 뒤 시작을 누르세요');
mirror.start();
glasses.init().then(ok => {
  if (ok && !running && !starting) setStatus('G2 연결됨 · 시작을 누르세요');
}).catch(e => setStatus('G2 초기화 실패: ' + (e as Error).message));
