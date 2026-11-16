import { PipMonitor, pipSupported } from './pip';
import { AudioEngine, type BandStat, listInputs, listOutputs, realDevices, outputSelectSupported, requestMicPermission, DEFAULT_INPUT_ID, TRIM, GATE } from './audio';
import { AdviceManager, COOLDOWN_DEFAULT, type CooldownScope } from './advice';
import { callAI, parseReply, buildSystemPrompt, buildGenrePrompt, isQuotaError, supportsAudio, type Genre } from './ai';
import { analyzeClip, encodeWav16k } from './clip';
import { evaluateBalance, TOL_RANGE, ALWAYS_AI_TOL } from './balance';
import { fbParamsFor } from './config';
import { Glasses } from './glasses';
import { HudSender, HudReceiver, linkWatchdog, linesToShow, genCode, isCode, setLinkCode, linkCode, type BandRow, type LevelPkt, type MixState, type ReceiverInfo } from './link';
import { renderBandTable, paintMeters, paintHud, paintCdCount, genreText, clock } from './views';
import { setTicker, clearTicker } from './ticker';
import { BANDS, PROVIDERS, INTERVAL_RANGE, type ProviderId } from './config';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ls = {
  get: (k: string, d = '') => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* 저장 불가 환경 */ } },
};

// ───────── 🔑 연결 코드: 저장된 4자리 코드를 그대로 쓰고, 없으면 새로 발급 (송신기를 만들기 전에 정함) ─────────
{
  let code = ls.get('lm.pairCode');
  if (!isCode(code)) { code = genCode(); ls.set('lm.pairCode', code); }
  setLinkCode(code);
}

const engine = new AudioEngine();
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
/** 장르 안정화: 최근 판별 3개 중 2번 이상 나온 장르로만 바꾼다 (한 번 튄 판별로 배지가 흔들리지 않게) */
const genreHist: string[] = [];
function acceptGenre(g: Genre) {
  if (g.kind !== 'music') { genre = g; genreHist.length = 0; return; }   // Solo·스피치는 바로 반영
  genreHist.push(g.category);
  if (genreHist.length > 3) genreHist.shift();
  const count = (c: string) => genreHist.filter(x => x === c).length;
  const shown = genre?.kind === 'music' ? genre.category : '';
  const best = [...genreHist].reverse().find(c => count(c) >= 2);
  if (best) genre = { ...g, category: best };
  else if (!shown || !genreHist.includes(shown)) genre = g;            // 처음이거나 기존 장르가 최근 판별에 없으면 최신값
}
/** 장르 판별 정확도용: 최근 약 1분(분석 구간 기준 최대 3개) 지표 평균 */
interface FeatSnap { at: number; rel: Record<string, number>; centroid: number; density: { low: number; mid: number; highMid: number }; bpm: number | null; voice: number; decay: number }
const featHist: FeatSnap[] = [];
function longTermFeatures(cur: FeatSnap) {
  featHist.push(cur);
  while (featHist.length > 1 && cur.at - featHist[0].at > 65_000) featHist.shift();
  if (featHist.length > 6) featHist.shift();
  const n = featHist.length, avg = (f: (x: FeatSnap) => number) => Math.round(featHist.reduce((a, x) => a + f(x), 0) / n * 10) / 10;
  const bpms = featHist.map(x => x.bpm).filter((x): x is number => x !== null).sort((a, b) => a - b);
  return {
    windows: n,
    relativeSpectralBalanceDb: Object.fromEntries(Object.keys(cur.rel).map(k => [k, avg(x => x.rel[k] ?? 0)])),
    spectralCentroidHz: Math.round(avg(x => x.centroid)),
    transientDensityPerMin: { low: avg(x => x.density.low), mid: avg(x => x.density.mid), highMid: avg(x => x.density.highMid) },
    tempoBpmMedian: bpms.length ? bpms[Math.floor(bpms.length / 2)] : null,
    voiceBandSharePct: avg(x => x.voice),
    decayTailRatioPct: avg(x => x.decay),
  };
}
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

// ───────── 1) 헤더: 연결 코드 · 새 코드 발급 · 수신기 URL 복사 · 수신기 연결 상태 · 설정 ─────────
const hudUrl = () => `${location.origin}${location.pathname}?mode=hud&code=${linkCode()}`;
function paintCode() { $('pairCode').textContent = linkCode(); }
sender.onState = i => {
  const mq = i.mqtt === 'on' ? 'MQTT 연결됨' : i.mqtt === 'connecting' ? 'MQTT 연결 중…' : 'MQTT 사용 불가';
  const el = $('linkState');
  el.textContent = i.receivers > 0 ? `🟢 수신기 ${i.receivers}개 연결됨` : `🔴 수신기 대기 · ${mq}`;
  el.className = `pill ${i.receivers > 0 ? 'live' : 'off'}`;
};
$('newCode').onclick = () => {
  let code = genCode();
  while (code === linkCode()) code = genCode();
  ls.set('lm.pairCode', code);
  setLinkCode(code);
  paintCode();
  if (running) sender.publish();
  setStatus(`새 연결 코드 ${code} 발급 · 수신기에서 [코드 변경]으로 새 코드를 입력하세요`);
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
paintCode();
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
  $('tolLo').textContent = `둔감 ±${TOL_RANGE.max}dB`; $('tolMid').textContent = `보통 ±${(TOL_RANGE.max + TOL_RANGE.min) / 2}dB`; $('tolHi').textContent = `±${TOL_RANGE.min}dB 항상 AI`;
  it.min = String(INTERVAL_RANGE.min); it.max = String(INTERVAL_RANGE.max); it.step = String(INTERVAL_RANGE.step);
  $('intLo').textContent = `${INTERVAL_RANGE.min}초`; $('intHi').textContent = `${INTERVAL_RANGE.max}초`;
  const paintTol = () => {
    const always = tolDb <= ALWAYS_AI_TOL;
    $('tolInfo').textContent = always ? '±0dB · 항상 AI 전송 (로컬 필터 없음)' : `허용 편차 ±${tolDb}dB`;
    $('tolInfo').classList.toggle('always', always);
  };
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

// ───────── ⚙️ 설정: 노이즈 게이트 (무음 대기) ─────────
let gateDb = clamp(parseFloat(ls.get('lm.gate4', String(GATE.defaultDb))), GATE.minDb, GATE.maxDb);
let gateOn = ls.get('lm.gateOn2', '0') === '1';   // 기본 OFF: 낮은 레벨에서도 계속 분석·AI 호출
{
  const g = $<HTMLInputElement>('gateSlider');
  g.min = String(GATE.minDb); g.max = String(GATE.maxDb);
  g.value = String(gateDb);
  const paint = () => {
    $('gateInfo').textContent = `${gateDb} dBFS`;
    const b = $('gateBtn');
    b.textContent = `🚪 무음 시 신호 대기(게이트) 사용 : ${gateOn ? 'ON' : 'OFF'}`;
    b.classList.toggle('active', gateOn);
    g.disabled = !gateOn;
  };
  g.oninput = () => { gateDb = +g.value; ls.set('lm.gate4', String(gateDb)); applyGate(); paint(); };
  $('gateBtn').onclick = () => { gateOn = !gateOn; ls.set('lm.gateOn2', gateOn ? '1' : '0'); applyGate(); paint(); };
  paint();
}
function applyGate() { engine.setGate(gateOn, gateDb); }

// ───────── 2) 오디오 입력/출력: Windows 가 인식한 활성 장치 중에서 선택 · 🎧 모니터링 ─────────
/** Auto-Trim 기본 OFF (Raw dBFS). 설정에서 켜면 기억 */
const trimSaved = () => ls.get('lm.trim.console', '0') === '1';

const deviceSel = $<HTMLSelectElement>('device');
const outputSel = $<HTMLSelectElement>('outputDev');
const findBtn = $<HTMLButtonElement>('findBtn');
const monBtn = $<HTMLButtonElement>('monBtn');
const monVol = $<HTMLInputElement>('monVol');

/** 저장된 선택: 장치 ID + 이름 (ID 가 바뀌어도 이름으로 복원) */
interface SavedDev { device: string; name: string }
const loadDev = (key: string): SavedDev => {
  try { const o = JSON.parse(ls.get(key, '')); if (o && typeof o.device === 'string') return { device: o.device, name: String(o.name ?? '') }; } catch { /* ignore */ }
  return { device: '', name: '' };
};
let savedIn = loadDev('lm.input');
let savedOut = loadDev('lm.output');
const saveSel = (sel: HTMLSelectElement, key: string): SavedDev => {
  const v = { device: sel.value, name: sel.selectedOptions[0]?.dataset.name ?? '' };
  if (v.device) ls.set(key, JSON.stringify(v));
  return v;
};

// 출력 장치 특수 값: 없음(소리 안 냄 · 기본값) / 시스템 기본 출력(휴대폰처럼 개별 출력 장치 목록을 주지 않는 환경)
const OUT_NONE = 'none';
const OUT_SYSTEM = 'system';
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const SYSTEM_OUT_LABEL = isMobile ? '📱 휴대폰 기본 출력 (스피커 · 이어폰 · USB/블루투스)' : '🔊 시스템 기본 출력';
const SYSTEM_IN_LABEL = '📱 휴대폰 기본 입력 (꽂힌 USB 인터페이스 자동)';
/** 엔진에 넘길 출력 장치 ID ('' = 시스템 기본) */
const outputId = () => (outputSel.value === OUT_NONE || outputSel.value === OUT_SYSTEM ? '' : outputSel.value);
const outputNone = () => !outputSel.value || outputSel.value === OUT_NONE;

// 🎧 모니터링 모드: 선택한 입력을 분석하면서 선택한 출력 장치로 내보냄 (기본 OFF · 출력 '없음'이면 내보내지 않음)
let monitorOn = ls.get('lm.monitor', '0') === '1';
let monitorPct = Math.min(100, Math.max(0, Number(ls.get('lm.monVol', '80')) || 0));
/** 실제로 소리를 내보내는지: 모니터링 ON + 출력 장치가 '없음'이 아님 */
const monitorActive = () => monitorOn && !outputNone();
function paintMonitor() {
  const none = outputNone();
  monBtn.disabled = none;
  monBtn.textContent = none ? '🎧 모니터링 모드 : 출력 장치를 먼저 고르세요'
    : `🎧 모니터링 모드 : ${monitorOn ? 'ON (입력 → 출력)' : 'OFF'}`;
  monBtn.classList.toggle('active', monitorActive());
  monVol.value = String(monitorPct);
  monVol.disabled = none;
  $('monVolInfo').textContent = `${monitorPct}%`;
  const out = engine.outputInfo;
  let t = none ? '출력 없음: 분석만 하고 소리는 내보내지 않습니다.'
    : monitorOn ? `선택한 입력을 분석하면서 「${outputSel.selectedOptions[0]?.textContent ?? '출력 장치'}」로 내보냅니다. 출력 소리가 다시 입력으로 들어가지 않게(하울링) 연결을 확인하세요.`
    : '모니터링 OFF: 분석만 하고 소리는 내보내지 않습니다.';
  if (running && monitorActive() && out.via !== 'none' && !out.ok) t += `\n⚠ 출력 장치를 바꾸지 못했습니다: ${out.error ?? ''}`;
  if (isMobile && !none) t += '\n📱 휴대폰은 개별 출력 장치를 고를 수 없어, 지금 휴대폰에 연결된 출력(스피커/이어폰/USB/블루투스)으로 나갑니다.';
  $('monInfo').textContent = t;
}
monBtn.onclick = () => {
  if (outputNone()) return;
  monitorOn = !monitorOn;
  ls.set('lm.monitor', monitorOn ? '1' : '0');
  engine.setMonitor(monitorActive(), monitorPct / 100);
  paintMonitor();
  if (running) setStatus(`🎧 모니터링 ${monitorOn ? 'ON' : 'OFF'}`);
};
monVol.oninput = () => {
  monitorPct = Number(monVol.value) || 0;
  ls.set('lm.monVol', String(monitorPct));
  engine.setMonitor(monitorActive(), monitorPct / 100);
  $('monVolInfo').textContent = `${monitorPct}%`;
};
outputSel.onchange = async () => {
  savedOut = saveSel(outputSel, 'lm.output');
  if (running) {
    await engine.setOutput(outputId());
    engine.setMonitor(monitorActive(), monitorPct / 100);
    setStatus(`출력 장치: ${outputSel.selectedOptions[0]?.textContent ?? ''}`);
  }
  paintMonitor();
};

/** 오류를 사람이 읽을 수 있는 원인으로 변환 */
function describeError(e: unknown): string {
  const name = (e as { name?: string } | null)?.name ?? '';
  const msg = e instanceof Error ? e.message : String(e);
  const detail = name && name !== 'Error' ? ` (${name}: ${msg})` : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError')
    return `마이크(오디오 입력) 권한이 거부되었습니다. 주소창 왼쪽 아이콘 → 사이트 설정 → 마이크를 '허용'으로 바꾸고, Windows 설정 → 개인 정보 → 마이크에서 브라우저 접근도 확인한 뒤 다시 시도하세요.${detail}`;
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError')
    return `오디오 입력 장치를 찾지 못했습니다. 인터페이스 연결·드라이버를 확인하고 [🔄 장치 찾기]를 눌러 주세요.${detail}`;
  if (name === 'NotReadableError' || name === 'TrackStartError')
    return `입력 장치를 열 수 없습니다. 다른 프로그램(DAW 등)이 인터페이스를 독점 모드로 쓰고 있지 않은지 확인하세요.${detail}`;
  if (name === 'OverconstrainedError') return `장치가 요청한 설정을 지원하지 않습니다.${detail}`;
  return (msg || '알 수 없는 오류') + (name && name !== 'Error' ? ` (${name})` : '');
}

const addOpt = (sel: HTMLSelectElement, value: string, label: string, name = '') => {
  const o = document.createElement('option');
  o.value = value; o.textContent = label; o.dataset.name = name;
  sel.appendChild(o);
};
/** 저장값(ID → 이름 순)으로 찾아 선택. 없으면 fallback */
function pick(sel: HTMLSelectElement, want: SavedDev, fallback: string) {
  const opts = [...sel.options];
  const hit = opts.find(o => o.value === want.device) ?? (want.name ? opts.find(o => o.dataset.name === want.name) : undefined);
  sel.value = hit ? hit.value : fallback;
}
/**
 * 입력 목록: Windows/휴대폰이 인식한 실제 장치. 휴대폰은 맨 위에 '휴대폰 기본 입력'도 둔다
 * (안드로이드는 꽂은 USB 인터페이스가 기본 입력으로만 잡히는 경우가 있음). 권한 전이라 목록이 없으면 안내 항목.
 */
function fillInputs(devs: MediaDeviceInfo[]) {
  const real = realDevices(devs);
  const granted = haveLabels || devs.some(d => d.deviceId === 'default' && !!d.label);
  deviceSel.innerHTML = '';
  if (isMobile && (granted || real.length)) addOpt(deviceSel, DEFAULT_INPUT_ID, SYSTEM_IN_LABEL);
  real.forEach((d, i) => addOpt(deviceSel, d.deviceId, d.label || `입력 ${i + 1}`, d.label || ''));
  if (!deviceSel.options.length && devs.some(d => d.deviceId === 'default')) addOpt(deviceSel, DEFAULT_INPUT_ID, isMobile ? SYSTEM_IN_LABEL : '🎙️ 시스템 기본 입력');
  if (!deviceSel.options.length) { addOpt(deviceSel, '', '🔄 [장치 찾기]를 눌러 입력 장치 목록을 불러오세요'); deviceSel.value = ''; return; }
  pick(deviceSel, savedIn, deviceSel.options[0].value);
}
/**
 * 출력 목록: [없음(기본)] + 실제 출력 장치.
 * 휴대폰처럼 개별 출력 장치를 알려 주지 않거나 출력 지정을 지원하지 않으면 '기본 출력' 항목을 대신 둔다.
 */
function fillOutputs(devs: MediaDeviceInfo[]) {
  const real = realDevices(devs);
  outputSel.innerHTML = '';
  addOpt(outputSel, OUT_NONE, '🔇 없음 (소리 내보내지 않음)');
  if (isMobile || !real.length || !outputSelectSupported()) addOpt(outputSel, OUT_SYSTEM, SYSTEM_OUT_LABEL);
  if (outputSelectSupported()) real.forEach((d, i) => addOpt(outputSel, d.deviceId, d.label || `출력 ${i + 1}`, d.label || ''));
  pick(outputSel, savedOut, OUT_NONE);   // 고르기 전 기본값 = 없음
}
let haveLabels = false;
async function refreshDevices(askPermission = false) {
  if (askPermission && !running) await requestMicPermission();
  const [ins, outs] = await Promise.all([listInputs(), listOutputs()]);
  haveLabels = ins.some(d => !!d.label);
  fillInputs(ins);
  fillOutputs(outs);
  paintMonitor();
}
findBtn.onclick = async () => {
  const old = findBtn.textContent;
  findBtn.disabled = true; findBtn.textContent = '찾는 중…';
  try {
    await refreshDevices(true);
    clearError();
    setStatus(`입력 장치 ${deviceSel.options.length}개 · 출력 장치 ${Math.max(0, outputSel.options.length - 1)}개 찾음`);
  } catch (e) {
    showError(describeError(e));
    try { await refreshDevices(); } catch { /* ignore */ }
  } finally { findBtn.disabled = false; findBtn.textContent = old; }
};
deviceSel.onchange = async () => {
  savedIn = saveSel(deviceSel, 'lm.input');
  if (!running || !deviceSel.value) return;
  try { await startAudio(); clearError(); }
  catch (e) { showError(describeError(e)); await stop(); }
};
try { navigator.mediaDevices?.addEventListener?.('devicechange', () => { refreshDevices().catch(() => {}); }); } catch { /* ignore */ }
paintMonitor();
refreshDevices().catch(() => {});

// ───────── ⚙️ 설정: Auto-Trim 수동 토글 ─────────
function paintToggles() {
  const trimBtn = $('trimBtn');
  const on = engine.autoTrim;
  trimBtn.textContent = `🎚️ 볼륨 무관 레벨 고정 (Auto-Trim ${on ? 'ON' : 'OFF'})`;
  trimBtn.classList.toggle('active', on);
  $('trimHint').textContent = `무음(${TRIM.gateDb}dBFS 미만)을 뺀 최근 약 ${TRIM.tauSec}초 평균 레벨을 ${TRIM.targetDb}dBFS 기준으로 자동 보정합니다. `
    + '콘솔 입력은 실제 물리 레벨(Raw dBFS)을 봐야 하므로 기본 OFF입니다.';
  $('meterInfo').textContent = on ? `-60 ~ 0 dBFS · Auto-Trim ${engine.trimDb >= 0 ? '+' : ''}${engine.trimDb.toFixed(1)}dB 보정됨` : '-60 ~ 0 dBFS · Raw';
}
$('trimBtn').onclick = () => {
  const on = !engine.autoTrim;
  ls.set('lm.trim.console', on ? '1' : '0');
  engine.setAutoTrim(on);
  paintToggles();
};
engine.setAutoTrim(trimSaved());
applyGate();
paintToggles();

// ───────── 📜 조언 히스토리 (분석기 화면 전용 · 최신이 위 · 브라우저에 최근 500개 보관) ─────────
interface HistItem { at: number; text: string; genre: string }
const HIST_MAX = 500;
let history: HistItem[] = (() => {
  try { const a = JSON.parse(ls.get('lm.history', '[]')); return Array.isArray(a) ? a.filter(x => x && typeof x.text === 'string').slice(-HIST_MAX) : []; } catch { return []; }
})();
const hhmmss = (t: number) => { const d = new Date(t), p = (n: number) => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const escH = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
function renderHistory() {
  const box = $('history');
  $('histCount').textContent = `(${history.length}건)`;
  if (!history.length) { box.innerHTML = '<div class="hempty">아직 조언이 없습니다. 분석을 시작하면 표시된 조언이 여기에 쌓입니다.</div>'; return; }
  const atTop = box.scrollTop < 8;
  box.innerHTML = history.slice().reverse().map(h =>
    `<div class="hrow"><span class="ht">${hhmmss(h.at)}</span>${escH(h.text)}${h.genre ? `<span class="hg">${escH(h.genre)}</span>` : ''}</div>`).join('');
  if (atTop) box.scrollTop = 0;                 // 맨 위를 보고 있을 때만 새 조언으로 따라감 (아래로 스크롤해 읽는 중이면 그대로)
}
function addHistory(texts: string[]) {
  if (!texts.length) return;
  const g = genre?.kind === 'music' ? genre.category : genre?.kind === 'solo' ? `Solo ${genre.instrument ?? ''}`.trim() : genre?.kind === 'speech' ? '스피치' : '';
  const now = Date.now();
  texts.forEach(text => history.push({ at: now, text, genre: g }));
  if (history.length > HIST_MAX) history = history.slice(-HIST_MAX);
  ls.set('lm.history', JSON.stringify(history));
  renderHistory();
}
$('histClear').onclick = () => { history = []; ls.set('lm.history', '[]'); renderHistory(); };
renderHistory();

/** 쿨다운 전체 초기화 (버튼 · 안경 다리 터치 공통) */
function resetAllCooldown(from: 'button' | 'glasses') {
  advice.resetCooldown(); renderCooldown();
  setStatus(from === 'glasses' ? '👓 안경 터치 → 쿨다운 전체 초기화됨' : '쿨다운 전체 초기화됨');
  sender.publish();
}
$('resetBtn').onclick = () => resetAllCooldown('button');
// 수신기(Even G2 · ?mode=hud)에서 안경 다리를 한 번 터치하면 명령이 온다
sender.onCommand = cmd => { if (cmd === 'resetCooldown') resetAllCooldown('glasses'); };
// 분석기 페이지 자체가 Even Hub 안에서 열려 안경에 직접 연결된 경우
glasses.onTap = () => resetAllCooldown('glasses');

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

/** HUD 시스템 안내 (22자 이내) — 신호 대기 중: 맨 윗줄 / 분석 중인데 조언이 아직 없을 때: 첫 조언 줄 */
let sysLine = '';
function updateSysLine() {
  if (!running) { sysLine = ''; return; }
  if (engine.idle) {
    const db = engine.lastRawDb;
    sysLine = `[시스템] 신호 대기중 (${db <= -100 ? '<-100' : Math.round(db)}dB)`;
  } else sysLine = '[시스템] AI 분석 대기중...';
}
function hudLines(): string[] {
  const lines = [fbText, ...advice.lines()];
  if (running && engine.idle && sysLine && !fbText) lines[0] = sysLine;          // 신호 대기: 맨 윗줄에 항상 표시 (조언은 그대로 시간에 맞춰 사라짐)
  else if (running && !advice.items.length && sysLine) lines[1] = sysLine;       // 빈 화면 방지: 조언이 생기면 자동으로 사라짐
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
/** ⏳ 현재 쿨다운 목록 (분석기 본체 화면 전용 · HUD 수신기에는 보내지 않음) */
const esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
let cdSig = '\u0000';
let lastCdCount = -1;
function renderCooldown() {
  const now = Date.now();
  const list = advice.cooldownList(now);
  $('cdCount').textContent = `(${list.length}개)`;
  // HUD 오른쪽 위 쿨다운 개수: 화면 · G2 렌즈 · 수신기
  if (list.length !== lastCdCount) {
    lastCdCount = list.length;
    if (!mirroring) { paintCdCount(list.length); glasses.setCooldownCount(list.length); }
    sender.update({ cooldownCount: list.length }, true);
  }
  const box = $('cdList');
  const sig = list.map(e => e.key).join('\n');
  const label = (e: (typeof list)[number]) =>
    `[${e.inst}] ${e.item}${e.detail ? ' ' + (e.detail === '-' ? '↓' : e.detail === '+' ? '↑' : e.detail) : ''} · ${Math.max(0, Math.ceil((e.until - now) / 1000))}초 남음 (${Math.min(e.count, e.trigger)}/${e.trigger}회)`;
  if (sig === cdSig) {                       // 목록이 같으면 남은 시간 글자만 갱신 (누르는 도중 버튼이 바뀌지 않게)
    box.querySelectorAll<HTMLElement>('.cdt').forEach((el, i) => { if (list[i]) el.textContent = label(list[i]); });
    return;
  }
  cdSig = sig;
  box.innerHTML = list.length
    ? list.map(e => `<span class="cdtag"><span class="cdt">${esc(label(e))}</span><button type="button" data-key="${esc(e.key)}" aria-label="쿨다운 해제">✕</button></span>`).join('')
    : '<div class="hint">쿨다운 중인 조언이 없습니다</div>';
}
$('cdList').addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest('button[data-key]') as HTMLElement | null;
  if (!b) return;
  advice.removeCooldown(b.dataset.key!);
  renderCooldown();
  setStatus('쿨다운 항목 해제됨');
});

// ───────── 오디오 시작/정지 ─────────
const modeName = () => `🎛️ 콘솔 2-Track${monitorActive() ? ' · 🎧 모니터링' : ''}`;

async function startAudio() {
  engine.setAutoTrim(trimSaved());
  applyGate();
  // 목록이 아직 없으면(권한 전) 권한을 받아 Windows 장치 목록을 먼저 불러온다
  if (!deviceSel.value || !haveLabels) await refreshDevices(true);
  if (!deviceSel.value) throw Object.assign(new Error('Windows 에 인식된 오디오 입력 장치가 없습니다'), { name: 'NotFoundError' });
  savedIn = saveSel(deviceSel, 'lm.input');
  if (outputSel.value) savedOut = saveSel(outputSel, 'lm.output');
  await engine.start({ deviceId: deviceSel.value, outputId: outputId(), monitor: monitorActive(), monitorGain: monitorPct / 100 });
  await refreshDevices().catch(() => {});   // 권한 승인 직후: 실제 장치 이름으로 목록 갱신
  paintMonitor();

  const info = engine.openInfo, st = info?.settings;
  const parts: string[] = [];
  parts.push(`입력: ${info?.label || deviceSel.selectedOptions[0]?.textContent || '?'} · ${engine.deviceChannels >= 2 ? 'Ch 1-2 스테레오' : '모노'} · ${st?.sampleRate ?? '?'}Hz${info?.step && info.step > 1 ? ` · ${info.step}차 방식으로 열림` : ''}`);
  parts.push(outputNone() ? '출력: 없음 (소리 내보내지 않음)' : `출력: ${outputSel.selectedOptions[0]?.textContent ?? ''} · 🎧 모니터링 ${monitorOn ? `ON (${monitorPct}%)` : 'OFF'}`
    + (engine.outputInfo.ok || engine.outputInfo.via === 'none' ? '' : ` · ⚠ 출력 전환 실패: ${engine.outputInfo.error ?? ''}`));
  parts.push(gateOn ? `🚪 노이즈 게이트 ${gateDb} dBFS · ${GATE.enterMs / 1000}초 이상 무음이면 대기` : '🚪 노이즈 게이트 OFF (무음에도 계속 분석)');
  if (info?.step === 3) parts.push('⚠ 기본 모드로 열림: OS 음성 보정(에코 제거/노이즈 억제/AGC)이 켜져 있을 수 있습니다');
  else if (st && (st.echoCancellation || st.noiseSuppression || st.autoGainControl)) parts.push('⚠ 브라우저가 음성 보정을 끄지 못했습니다 (EC/NS/AGC 일부 ON)');
  if (engine.state !== 'running') parts.push('⚠ 오디오 엔진이 대기 상태입니다. 화면을 한 번 클릭해 주세요');
  $('inputInfo').textContent = parts.join('\n');
  paintToggles();
}

document.addEventListener('pointerdown', () => {
  if (!running) return;
  engine.resumeCtx();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !running) return;
  engine.resumeCtx();
  void ensureWake();
  sender.publish();
});
document.addEventListener('freeze', () => { if (running) sender.publishFrozen(); });
window.addEventListener('pagehide', () => { if (running) sender.publishFrozen(); });
document.addEventListener('resume', () => { if (running) { engine.resumeCtx(); sender.publish(); } });

// ───────── 💡 Screen WakeLock: 풀리면 (가시 상태에서) 자동 재획득 ─────────
let wake: any = null;
let wakePending = false;
async function ensureWake() {
  if ((!running && !keepOn) || wakePending || document.visibilityState !== 'visible') return;
  if (wake && !wake.released) return;
  const wl: any = (navigator as any).wakeLock;
  if (!wl?.request) return;
  wakePending = true;
  try {
    wake = await wl.request('screen');
    wake.addEventListener?.('release', () => paintKeep());
  } catch { wake = null; } finally { wakePending = false; paintKeep(); }
}
function releaseWake() { try { wake?.release?.(); } catch { /* ignore */ } wake = null; paintKeep(); }

// ───────── 🔒 휴대폰 꺼짐 방지: 화면 켜짐 유지(WakeLock) + PiP 미니 모니터 ─────────
// 휴대폰 크롬은 다른 앱(Even 앱 등)으로 전환하거나 화면이 꺼지면 페이지를 멈춘다.
// 버튼을 누르면 ① 화면이 꺼지지 않게 하고 ② PiP 창을 띄워 앱을 전환해도 크롬이 화면에 떠 있는 상태로 분석을 이어 간다.
const pip = new PipMonitor();
let keepOn = false;
const keepBtn = $<HTMLButtonElement>('keepBtn');
const drawPip = () => pip.draw(localLevels, hudLines(), $('genreBadge').textContent || '', running ? `분석 중 · ${$('status').textContent || ''}` : '분석 대기 (시작을 누르세요)');
function paintKeep() {
  if (!isMobile) return;
  const wakeOk = !!wake && !wake.released;
  keepBtn.textContent = keepOn ? '🔒 꺼짐 방지 : ON' : '🔒 꺼짐 방지 : OFF';
  keepBtn.classList.toggle('active', keepOn);
  const pipTxt = pip.state === 'unsupported' ? 'PiP 미지원' : pip.active ? 'PiP 미니 모니터 ✔' : pip.state === 'starting' ? 'PiP 여는 중…' : pip.state === 'failed' ? 'PiP 실패' : 'PiP 닫힘';
  $('keepInfo').textContent = keepOn
    ? `화면 꺼짐 방지 ${wakeOk ? '✔' : '…'} · ${pipTxt}\n`
      + (pip.active ? 'Even 앱 등으로 전환해도 PiP 창이 떠 있는 동안 분석이 계속됩니다. PiP 창을 닫지 마세요.'
        : pip.state === 'unsupported' ? '이 브라우저는 PiP 를 지원하지 않아 화면 켜짐만 유지합니다. 분석 중에는 이 화면을 띄워 두세요.'
        : 'PiP 창이 닫혀 있습니다. 다른 앱으로 전환하기 전에 버튼을 두 번 눌러(OFF → ON) PiP 를 다시 여세요.')
      + '\n※ 전원 버튼으로 화면을 끄면 안드로이드가 크롬을 멈출 수 있으니 화면은 켜 둔 채 사용하세요.'
    : '휴대폰에서는 다른 앱으로 전환하거나 화면이 꺼지면 분석이 멈춥니다. 분석 중에는 꺼짐 방지를 켜 두세요.';
}
keepBtn.hidden = !isMobile;
$('keepInfo').hidden = !isMobile;
pip.onChange = paintKeep;
keepBtn.onclick = async () => {
  if (!keepOn) {
    keepOn = true; paintKeep();
    // PiP 는 버튼을 누른 순간(사용자 동작)에만 열 수 있으므로 기다리지 않고 바로 요청
    const p1 = pipSupported() && !pip.active ? pip.toggle(drawPip) : Promise.resolve();
    await Promise.all([p1, ensureWake()]);
    if (running) setStatus('🔒 꺼짐 방지 ON');
  } else {
    keepOn = false;
    await pip.close();
    if (!running) releaseWake();
    if (running) setStatus('🔒 꺼짐 방지 OFF');
  }
  paintKeep();
};
document.addEventListener('visibilitychange', () => { if (keepOn && document.visibilityState === 'visible') void ensureWake(); });
// 분석 전에도 PiP 창이 멈춘 화면으로 남지 않게 1초마다 그림 (분석 중에는 100ms 틱에서 그림)
setInterval(() => { if (pip.active && !running) drawPip(); }, 1000);
paintKeep();

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
  running = true;
  endMirror();
  lastCollectAt = Date.now(); lastAnalyzeAt = Date.now(); lastSecondAt = 0;
  genreHist.length = 0; featHist.length = 0;     // 새 분석: 장르 안정화 기록·1분 평균 지표 초기화
  startBtn.disabled = false; startBtn.textContent = '정지'; startBtn.classList.add('on');
  startTicker();
  void ensureWake();
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
  if (!keepOn) releaseWake();
  await engine.stop();
  localLevels = null;
  paintMonitor();
  startBtn.textContent = '시작'; startBtn.classList.remove('on');
  setStatus('정지');
}
engine.onIdleChange = idle => {
  const now = Date.now();
  if (idle) {
    localLevels = [{ rmsDb: -120, peakDb: -120, clip: false }, { rmsDb: -120, peakDb: -120, clip: false }];
    showBands(null);
    setStatus('⏸️ 신호 대기 중 · 게이트 아래 무음' + (engine.autoTrim ? ' (Auto-Trim 0dB 동결)' : ''));
  } else {
    lastCollectAt = now; lastAnalyzeAt = now;        // 음악이 다시 나오면 새 구간부터 분석
    setStatus(`실행 중 · ${modeName()} · 신호 감지 → 분석 재개`);
  }
  paintGenre(); paintToggles();
  updateSysLine(); lastRendered = ''; render();      // 신호 대기 안내 표시/해제
  sender.update({ genre: badgeForSend(), genreAt: idle ? 0 : genreAt, levels: localLevels }, true);
};
engine.onEnded = () => { if (running) { setStatus('입력이 종료되었습니다 (오디오 공유 종료/장치 분리)'); void stop(); } };

// ───────── 4) 백그라운드에서도 멈추지 않는 단일 100ms 틱 ─────────
// 1순위: AudioWorklet(오디오 렌더 스레드)이 100ms 마다 메인 스레드로 박동 → 여기서 FFT 수집·피드백·6밴드 누적·1초 MQTT·AI 타이머를 구동.
// 2순위: 인라인 Blob Web Worker(ticker.ts) 100ms 타이머. 두 박동 중 먼저 온 쪽이 틱을 돌리고 70ms 안에 겹쳐 온 것은 건너뛴다.
// rAF/일반 setInterval 은 쓰지 않는다.
let ticker = 0;
let tickN = 0;
let lastTickAt = 0;
let lastSecondAt = 0;
let lastAnalyzeAt = 0;
let recoverCount = 0;

function startTicker() {
  clearTicker(ticker);
  tickN = 0; lastTickAt = performance.now();
  ticker = setTicker(workerBackupTick, 100);
}
/** 2차 백업 워치독: AudioWorklet 박동이 정상이면 건너뛰고, 300ms 넘게 끊겼거나 워클릿이 없을 때만 틱을 돌린다 */
function workerBackupTick() {
  if (engine.clockKind === 'worklet' && performance.now() - lastTickAt < 300) return;
  masterTick();
}
engine.onAudioBeat = () => { if (running) masterTick(); };

function masterTick() {
  if (!running) return;
  const t0 = performance.now();
  if (t0 - lastTickAt < 70) return;           // 워클릿/Worker 박동이 겹치면 한 번만 실행
  lastTickAt = t0;
  tickN++;
  void ensureWake();                          // 화면 WakeLock 이 풀려 있고 화면이 보이면 재요청
  if (pip.active) drawPip();                  // 📌 PiP 미니 모니터 갱신
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
  if (tickN % 2 === 0 && localLevels) sender.sendLevels(localLevels[0], localLevels[1]);   // 0.2초: 레벨
  if (now - lastSecondAt >= 1000) { lastSecondAt = now; secondTick(); }
  if (engine.idle) lastAnalyzeAt = now;           // 무음 대기: AI 호출 일시 중지
  else if (!aiPaused && now - lastAnalyzeAt >= intervalSec * 1000) { lastAnalyzeAt = now; void analyze(); }
}

function secondTick() {
  updateSysLine();
  if (advice.tick(Date.now())) render();      // 조언은 신호 대기 중에도 지정된 시간이 지나면 사라짐
  renderCooldown();
  paintGenre();
  updateLiveBands();
  linkWatchdog();                             // MQTT 가 끊겼으면 즉시 재연결 (재연결 시 마지막 상태 자동 재발행)
  paintToggles();
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
  const srcStat = engine.takeSourceStats();
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
  const alwaysAi = tol <= ALWAYS_AI_TOL;            // ±0dB: 로컬 필터를 건너뛰고 매 주기 AI 로 보냄
  // 로컬 필터를 통과한 주기: 조언은 생략하되 장르는 AI 조언 주기마다 판별 (장르 전용 짧은 요청)
  const genreOnly = ev.pass && !alwaysAi;
  if (inFlight) return;
  const key = apiKeyInp.value.trim();
  if (!key) { setStatus('⚙️ 설정에서 API Key를 입력하면 AI 조언이 시작됩니다'); setAiLast(`${modeInfo}\nAPI Key 없음 → AI 호출 안 함`); return; }
  const over = solo
    ? [ev.crestOk ? '협대역 피크' : 'Crest 범위 밖']
    : Object.entries(ev.deltas).filter(([, d]) => Math.abs(d) > tol).map(([n, d]) => `${n} ${d > 0 ? '+' : ''}${d}`);
  const tempoTxt = dyn.tempo.bpm ? `템포 약 ${dyn.tempo.bpm} BPM (신뢰도 ${dyn.tempo.confidence})` : '템포 불분명';
  const gateInfo = `${modeInfo}\n측정: ${srcStat.analyser}틱${srcStat.cached ? ` (무음 캐시 대체 ${srcStat.cached}틱)` : ''} · ${tempoTxt}\n`
    + (alwaysAi ? '항상 AI 전송 모드 (조언 민감도 ±0dB · 로컬 필터 생략)'
      : genreOnly ? `로컬 필터 통과 → 조언 생략 · 장르만 판별`
      : '필터 초과: ' + (over.length ? over.join(', ') : 'Crest 범위 밖'));

  inFlight = true;
  const bandData = Object.fromEntries(Object.entries(bands).map(([n, b]) => [n, {
    avgDb: b.avgDb, peakDb: b.peakDb, crestDb: b.crestDb,
    deltaDb: solo ? null : ev.deltas[n],
    active: ev.signal.activeBands.includes(n),
    character: b.character,
  }]));
  const rel = Object.fromEntries(Object.entries(bands).map(([n, b]) => [n, b.relDb]));
  const longTerm = longTermFeatures({ at: nowMs, rel, centroid: spec.spectralCentroidHz, density: dyn.transientDensityPerMin, bpm: dyn.tempo.bpm, voice: spec.voiceBandSharePct, decay: dyn.decayTail.ratioPct });
  const payload = {
    windowSec,
    toleranceDb: tol,
    alwaysSend: alwaysAi,
    inputMode: 'console-2track-raw',
    levelReference: engine.autoTrim ? `auto-trim normalized to ${TRIM.targetDb} dBFS (absolute level not meaningful)` : 'raw dBFS from console',
    captureNote: captureNote(),
    signal: ev.signal,
    features: {
      relativeSpectralBalanceDb: rel,
      tempo: dyn.tempo,
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
      longTerm,
    },
    bands: bandData,
    peaks,
    currentDisplay: advice.displayList().map(i => i.text),
    cooldownList: advice.cooldownTags(nowMs),
  };
  try {
    // 🎧 최근 3초 실제 오디오: 같은 구간의 단기 지표(last3s)는 항상, WAV 는 오디오를 받는 공급자(Gemini)일 때 첨부
    const clip = engine.clipSnapshot();
    let wav: Awaited<ReturnType<typeof encodeWav16k>> | null = null;
    const extra: Record<string, unknown> = {};
    if (clip) {
      extra.last3s = analyzeClip(clip.data, clip.sr);
      if (supportsAudio(provider())) {
        try { wav = await encodeWav16k(clip.data, clip.sr); extra.audio = { seconds: wav.seconds, sampleRate: 16000, channels: 1, gainDb: wav.gainDb }; }
        catch (e) { console.warn('WAV 인코딩 실패 (수치만 전송)', e); }
      }
    }
    const hasAudio = !!wav;
    const raw = await callAI(provider(), currentModel(), key, genreOnly ? buildGenrePrompt(hasAudio) : buildSystemPrompt(tol, hasAudio),
      `${hasAudio ? `첨부 오디오: 최근 ${wav!.seconds}초 실제 소리 (16kHz 모노 WAV · 듣기 쉽게 ${wav!.gainDb >= 0 ? '+' : ''}${wav!.gainDb}dB 정규화).\n` : ''}최근 ${windowSec}초 분석 데이터(JSON):\n${JSON.stringify({ ...payload, ...extra })}`,
      wav?.base64);
    const res = parseReply(raw);
    if (res.genre) { acceptGenre(res.genre); genreAt = Date.now(); paintGenre(); sender.update({ genre: badgeForSend(), genreAt }); }
    const added = genreOnly ? [] : advice.ingest(res.advice, Date.now());
    addHistory(added.map(a => a.text));
    const text = raw.trim().replace(/\s+/g, ' ');
    const audioInfo = hasAudio ? `🎧 최근 ${wav!.seconds}초 오디오 첨부 (16kHz 모노 WAV · ${Math.round(wav!.bytes / 1024)}KB)` : clip ? '🎧 오디오 첨부 없음 (이 AI 공급자는 수치만 전송)' : '🎧 오디오 첨부 없음 (수집된 소리 1초 미만)';
    setAiLast(`${gateInfo}\n${audioInfo}\nAI 응답(${new Date().toLocaleTimeString()}): ${text || '(빈 응답)'}`);
    setStatus(genreOnly ? `${solo ? 'Solo' : '밸런스'} 양호 · 조언 생략 (장르만 갱신)`
      : !text ? 'AI 빈 응답' : res.none ? 'AI: NONE (지적 없음)' : !res.advice.length ? 'AI 응답 형식 불일치'
      : `AI: ${added.length}건 표시` + (res.advice.length > added.length ? ` · ${res.advice.length - added.length}건 제외(중복/쿨다운)` : ''));
    render(); renderCooldown();
  } catch (e) {
    if (isQuotaError(e)) pauseForQuota();
    else setStatus('AI 오류: ' + (e as Error).message.slice(0, 80));
  } finally { inFlight = false; }
}

/** AI 에 알려 줄 수음 경로 특성 */
function captureNote(): string {
  return `콘솔 2트랙 출력 직결 (오디오 입력 장치 Ch 1-2 · Raw)`;
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
  if (!running && (i.phase === 'live' || i.phase === 'stale')) { paintCdCount(st.cooldownCount ?? 0); glasses.setCooldownCount(st.cooldownCount ?? 0); }
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
  lastCdCount = -1; renderCooldown();          // 로컬 쿨다운 개수로 되돌림
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
