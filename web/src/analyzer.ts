import { PipMonitor, pipSupported } from './pip';
import { AudioEngine, type BandStat, listInputs, listOutputs, realDevices, outputSelectSupported, requestMicPermission, DEFAULT_INPUT_ID, TRIM, GATE } from './audio';
import { AdviceManager, COOLDOWN_DEFAULT, type CooldownScope } from './advice';
import { callAI, parseReply, buildSystemPrompt, SENS_LABEL, SENS_MAX, type Sensitivity, isQuotaError, supportsAudio, listGeminiModels, type Genre, type RemoteModel, type ParsedReply } from './ai';
import { analyzeClip, encodeWavStereo, clipRmsDb, WAV_RATE, CLIP_LEN } from './clip';
import { evaluateBalance } from './balance';
import { fbParamsFor } from './config';
import { Glasses } from './glasses';
import { HudSender, HudReceiver, linkWatchdog, linesToShow, genCode, isCode, setLinkCode, linkCode, type BandRow, type LevelPkt, type MixState, type ReceiverInfo } from './link';
import { renderBandTable, paintMeters, paintHud, paintCdCount, genreText, clock } from './views';
import { setTicker, clearTicker } from './ticker';
import { BANDS, PROVIDERS, GEMINI_GROUPS, INTERVAL_RANGE, type ProviderId } from './config';

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
const GOOD_MIX_LINE = '[믹스양호] 현재 밸런스 유지';
let goodMix = false;     // 마지막 AI 판정이 '믹스 양호(조언 없음)' 인지
const QUOTA_MSG = '❌ 1~3순위 모델 API 한도 소진 · AI 정지';
const ALL_EXHAUSTED_MSG = '❌ 설정된 1~3순위 모델의 API 한도가 모두 소진되어 AI 호출을 일시 중지합니다.';
const SILENCE_FLOOR_DB = -55;   // 게이트 OFF 일 때 WAV 평균 RMS 차단 기준
const FB_HOLD_MS = 2000;

// ───────── 배너 (할당량 / 안내) ─────────
const banner = document.createElement('div');
banner.id = 'quotaBanner'; banner.className = 'banner'; banner.hidden = true;
banner.innerHTML = `<div class="banner-row"><span>${ALL_EXHAUSTED_MSG}</span><button id="resumeBtn" type="button">모델 순위 초기화</button></div>
  <div class="hint">⚙️ 설정에서 모델을 바꾸거나 [모델 순위 초기화]를 누르면 1순위부터 다시 시작합니다. 레벨 미터와 피드백 감지는 계속 작동 중입니다.</div>`;
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
const apiKeyInp = $<HTMLInputElement>('apiKey');
const CUSTOM = '__custom__', NONE = '__none__';
const RANKS = [1, 2, 3] as const;
const rankSel = RANKS.map(i => $<HTMLSelectElement>(`model${i}`));
const rankCustom = RANKS.map(i => $<HTMLInputElement>(`custom${i}`));
providerSel.innerHTML = (Object.keys(PROVIDERS) as ProviderId[]).map(p => `<option value="${p}">${PROVIDERS[p].label}</option>`).join('');
providerSel.value = ls.get('lm.provider', 'gemini');
const provider = () => providerSel.value as ProviderId;
/** 공급자별 1·2·3순위 기본값 (Gemini: 3.5-flash-lite → 3.1-flash-lite → 2.5-flash-lite) */
function defaultRanks(p: ProviderId): string[] {
  if (p === 'gemini') return ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'];
  const m = PROVIDERS[p].models;
  return [m[0], m[1] ?? NONE, NONE];
}
const rankValue = (i: number) => (rankSel[i].value === CUSTOM ? rankCustom[i].value.trim() : rankSel[i].value === NONE ? '' : rankSel[i].value);
/** 실제 호출 순서 (사용 안 함·빈 칸·중복 제외) */
function modelChain(): { rank: number; model: string }[] {
  const out: { rank: number; model: string }[] = [];
  RANKS.forEach((r, i) => { const m = rankValue(i); if (m && !out.some(x => x.model === m)) out.push({ rank: r, model: m }); });
  return out;
}
let activeIdx = 0;                        // modelChain() 안에서 지금 쓰는 위치
// Google AI Studio 실시간 모델 목록 (models.list 결과 캐시)
let remoteModels: RemoteModel[] = (() => { try { const v = JSON.parse(ls.get('lm.gemModels', '[]')); return Array.isArray(v) ? v : []; } catch { return []; } })();
const escAttr = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
/** 드롭다운에 넣을 모델 목록 (Gemini: 내장 그룹 + AI Studio 에서 받은 추가 모델, 중복 제거) */
function modelOptions(p: ProviderId): { html: string; ids: string[] } {
  if (p !== 'gemini') { const m = PROVIDERS[p].models; return { html: m.map(x => `<option>${escAttr(x)}</option>`).join(''), ids: [...m] }; }
  const names = new Map(remoteModels.map(r => [r.id, r.displayName]));
  const opt = (id: string) => `<option value="${escAttr(id)}">${escAttr(id)}${names.get(id) ? ` — ${escAttr(names.get(id)!)}` : ''}</option>`;
  const ids: string[] = [];
  let html = GEMINI_GROUPS.map(g => { ids.push(...g.models); return `<optgroup label="${escAttr(g.label)}">${g.models.map(opt).join('')}</optgroup>`; }).join('');
  const extra = remoteModels.map(r => r.id).filter(id => !ids.includes(id)).sort((a, b) => b.localeCompare(a));
  if (extra.length) { ids.push(...extra); html += `<optgroup label="AI Studio 실시간 목록 (추가 ${extra.length}개)">${extra.map(opt).join('')}</optgroup>`; }
  return { html, ids };
}
/** 1·2·3순위 드롭다운 채우기 (저장된 선택 유지) */
function fillRankSelects() {
  const p = provider(), { html, ids } = modelOptions(p), defs = defaultRanks(p);
  rankSel.forEach((sel, i) => {
    sel.innerHTML = html + `<option value="${CUSTOM}">직접 입력…</option>`
      + (i > 0 ? `<option value="${NONE}">사용 안 함 (None)</option>` : '');
    const saved = ls.get(`lm.rank${i + 1}.${p}`, defs[i]);
    const c = rankCustom[i];
    if (saved === NONE && i > 0) { sel.value = NONE; c.hidden = true; }
    else if (ids.includes(saved)) { sel.value = saved; c.hidden = true; }
    else { sel.value = CUSTOM; c.hidden = false; c.value = saved === NONE ? '' : saved; }
  });
  $('syncRow').hidden = p !== 'gemini';
  paintModelState();
}
function loadProviderUI() {
  fillRankSelects();
  apiKeyInp.value = ls.get(`lm.key.${provider()}`);
  activeIdx = 0; paintModelState();
  if (provider() === 'gemini' && apiKeyInp.value.trim()) void syncModels(true);
}
/** [🔄 AI Studio 모델 목록 불러오기] — GET v1beta/models → generateContent 지원 텍스트 모델만 병합 */
let syncing = false;
async function syncModels(silent = false) {
  const key = apiKeyInp.value.trim(), info = $('syncInfo');
  if (provider() !== 'gemini') return;
  if (!key) { if (!silent) info.textContent = '⚠️ API Key 를 먼저 입력하세요'; return; }
  if (syncing) return;
  syncing = true; info.textContent = '🔄 AI Studio 모델 목록 불러오는 중…';
  try {
    const list = await listGeminiModels(key);
    remoteModels = list; ls.set('lm.gemModels', JSON.stringify(list)); ls.set('lm.gemModelsAt', String(Date.now()));
    const known = PROVIDERS.gemini.models, extra = list.filter(r => !known.includes(r.id)).length;
    fillRankSelects();
    info.textContent = `✅ ${new Date().toLocaleTimeString()} · 텍스트 출력 모델 ${list.length}개 수신 (내장 목록에 없던 ${extra}개 추가)`;
  } catch (e) {
    info.textContent = `⛔ 모델 목록 불러오기 실패: ${(e as Error).message.slice(0, 90)}`;
  } finally { syncing = false; }
}
let syncTimer = 0;
const saveRank = (i: number) => ls.set(`lm.rank${i + 1}.${provider()}`, rankSel[i].value === CUSTOM ? rankCustom[i].value.trim() : rankSel[i].value);
const currentModel = () => modelChain()[activeIdx]?.model ?? '';
/** 메인 화면 상단: 지금 쓰는 모델 */
function paintModelState() {
  const el = $('modelState'), chain = modelChain(), cur = chain[activeIdx];
  el.classList.toggle('fallback', !aiPaused && activeIdx > 0);
  el.classList.toggle('dead', aiPaused || !cur);
  el.textContent = aiPaused ? '❌ 1~3순위 한도 소진 · AI 정지' : cur ? `${activeIdx === 0 ? '🟢' : '🟡'} ${cur.rank}순위: ${cur.model}` : '⚠️ 모델 미설정';
  el.title = chain.map(c => `${c.rank}순위: ${c.model}`).join(' → ');
}
/** 모델 설정 변경·[모델 순위 초기화] → 1순위부터 다시 */
function resetModelRank(msg?: string) {
  activeIdx = 0;
  if (aiPaused) resumeAi(); else paintModelState();
  if (msg) setStatus(msg);
}
providerSel.onchange = () => { ls.set('lm.provider', provider()); loadProviderUI(); resetModelRank(); };
rankSel.forEach((sel, i) => {
  sel.onchange = () => { rankCustom[i].hidden = sel.value !== CUSTOM; saveRank(i); resetModelRank('모델 순위 변경 → 1순위부터 사용'); };
  rankCustom[i].oninput = () => { saveRank(i); resetModelRank(); };
});
$('prioReset').onclick = () => { resetModelRank(`🔄 모델 순위 초기화 → 1순위(${modelChain()[0]?.model ?? '-'})부터 사용`); };
apiKeyInp.oninput = () => {
  ls.set(`lm.key.${provider()}`, apiKeyInp.value.trim()); if (aiPaused) resetModelRank();
  clearTimeout(syncTimer); syncTimer = window.setTimeout(() => void syncModels(true), 1200);   // 키 입력이 끝나면 자동 동기화
};
$('syncModels').onclick = () => void syncModels();
loadProviderUI();

// ───────── ⚙️ 설정: 슬라이더 (왼쪽 = 둔감 · 오른쪽 = 예민) ─────────
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : lo));
// 조언 민감도 3단계 (1 필수만 · 2 중간 · 3 세밀함). 로컬 dB 필터는 없고 AI 프롬프트에만 전달한다
let sens: Sensitivity = (() => { const v = parseInt(ls.get('lm.sens', '2'), 10); return (v === 1 || v === 3 ? v : 2) as Sensitivity; })();
/** 밴드 표의 편차 강조 기준(표시 전용 · API 호출 여부와 무관) */
const SENS_TOL: Record<Sensitivity, number> = { 1: 8, 2: 5, 3: 2 };
let tolDb = SENS_TOL[sens];
let fbSens = clamp(parseFloat(ls.get('lm.fb', '50')), 0, 100);
let clipSec = clamp(Math.round(parseFloat(ls.get('lm.clipSec', String(CLIP_LEN.default)))), CLIP_LEN.min, CLIP_LEN.max);
let intervalSec = clamp(Math.round(parseFloat(ls.get('lm.interval', String(INTERVAL_RANGE.default))) / INTERVAL_RANGE.step) * INTERVAL_RANGE.step, INTERVAL_RANGE.min, INTERVAL_RANGE.max);
{
  const fb = $<HTMLInputElement>('fbSlider'), it = $<HTMLInputElement>('intSlider');
  it.min = String(INTERVAL_RANGE.min); it.max = String(INTERVAL_RANGE.max); it.step = String(INTERVAL_RANGE.step);
  $('intLo').textContent = `${INTERVAL_RANGE.min}초`; $('intHi').textContent = `${INTERVAL_RANGE.max}초`;
  const SENS_HINT: Record<Sensitivity, string> = {
    1: '명백한 문제나 큰 밸런스 붕괴만 조언 (0~2줄)',
    2: '라이브 믹스에서 개선이 필요한 주요 마스킹/톤/레벨 조언 (0~3줄)',
    3: '사소한 디테일과 미세한 톤/공간감 보정까지 조언 (0~4줄)',
  };
  const paintTol = () => {
    $('tolInfo').textContent = `${sens}단계 · ${SENS_LABEL[sens]}`;
    document.querySelectorAll<HTMLButtonElement>('.sens3 .sens').forEach(b => { const on = b.dataset.lv === String(sens); b.classList.toggle('active', on); b.setAttribute('aria-checked', String(on)); });
    $('sensHint').textContent = `${SENS_HINT[sens]} · 소리가 나는 동안 매 주기 AI 로 보내고, 믹스가 이미 좋으면 AI 가 조언 없이 '믹스 양호'로 답합니다.`;
  };
  const paintFb = () => {
    const p = fbParamsFor(fbSens / 100);
    $('fbInfo').textContent = `돌출 ${p.prominenceDb.toFixed(0)}dB · ${(p.confirmScans / 10).toFixed(1)}초 · ${p.minLevelDb.toFixed(0)}dBFS`;
  };
  const paintInt = () => { $('intInfo').textContent = `${intervalSec}초마다`; };
  fb.value = String(fbSens);
  it.value = String(intervalSec);
  document.querySelectorAll<HTMLButtonElement>('.sens3 .sens').forEach(b => {
    b.onclick = () => { sens = parseInt(b.dataset.lv!, 10) as Sensitivity; tolDb = SENS_TOL[sens]; ls.set('lm.sens', String(sens)); paintTol(); };
  });
  fb.oninput = () => { fbSens = parseFloat(fb.value); ls.set('lm.fb', String(fbSens)); engine.setFbSensitivity(fbSens / 100); paintFb(); };
  it.oninput = () => { intervalSec = parseFloat(it.value); ls.set('lm.interval', String(intervalSec)); advice.setIntervalMs(intervalSec * 1000); paintInt(); };
  engine.setFbSensitivity(fbSens / 100);
  advice.setIntervalMs(intervalSec * 1000);
  // 🎧 API 로 보내는 WAV 길이 (5~10초 · 1초 단위)
  const cs = $<HTMLInputElement>('clipSlider');
  cs.min = String(CLIP_LEN.min); cs.max = String(CLIP_LEN.max); cs.step = String(CLIP_LEN.step); cs.value = String(clipSec);
  $('clipLo').textContent = `${CLIP_LEN.min}초`; $('clipHi').textContent = `${CLIP_LEN.max}초`;
  const paintClip = () => { $('clipInfo').textContent = `최근 ${clipSec}초 · 약 ${(clipSec * WAV_RATE * 4 / 1024 / 1024).toFixed(2)}MB`; };
  cs.oninput = () => { clipSec = parseInt(cs.value, 10); ls.set('lm.clipSec', String(clipSec)); paintClip(); };
  paintTol(); paintFb(); paintInt(); paintClip();
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
let gateDb = clamp(parseFloat(ls.get('lm.gate5', String(GATE.defaultDb))), GATE.minDb, GATE.maxDb);
let gateOn = ls.get('lm.gateOn3', '1') === '1';   // 기본 ON(-50dBFS): 무음일 때는 API 를 절대 호출하지 않음 (한도 보호)
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
  g.oninput = () => { gateDb = +g.value; ls.set('lm.gate5', String(gateDb)); applyGate(); paint(); };
  $('gateBtn').onclick = () => { gateOn = !gateOn; ls.set('lm.gateOn3', gateOn ? '1' : '0'); applyGate(); paint(); };
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
  if (running && goodMix && !engine.idle && !fbText && !advice.items.length) lines[0] = GOOD_MIX_LINE;   // ✅ AI 가 믹스 양호로 판단
  if (running && engine.idle && sysLine && !fbText) lines[0] = sysLine;          // 신호 대기: 맨 윗줄에 항상 표시 (조언은 그대로 시간에 맞춰 사라짐)
  else if (running && !advice.items.length && sysLine && !goodMix) lines[1] = sysLine;       // 빈 화면 방지: 조언이 생기면 자동으로 사라짐
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
  running = false; goodMix = false;
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
  if (engine.idle) { lastAnalyzeAt = now; goodMix = false; }   // 무음 대기: AI 호출 일시 중지
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
  setStatus(ALL_EXHAUSTED_MSG);
  paintModelState();
  lastRendered = ''; render();
}
function resumeAi() {
  aiPaused = false;
  activeIdx = 0;
  banner.hidden = true;
  paintModelState();
  engine.collectBands(); engine.collectSpectrum(); engine.collectDynamics();
  lastCollectAt = Date.now(); lastAnalyzeAt = Date.now();
  setStatus('AI 분석 재개');
  lastRendered = ''; render();
}
$('resumeBtn').onclick = () => resetModelRank(`🔄 모델 순위 초기화 → 1순위(${modelChain()[0]?.model ?? '-'})부터 사용`);

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
  // 로컬 dB 변화량/편차 필터 없음: 무음(게이트)이 아니면 매 주기 WAV + DSP 를 AI 로 보내고, 조언 기준은 민감도 단계로 AI 가 판단
  const level = sens;
  if (inFlight) return;
  const key = apiKeyInp.value.trim();
  if (!key) { setStatus('⚙️ 설정에서 API Key를 입력하면 AI 조언이 시작됩니다'); setAiLast(`${modeInfo}\nAPI Key 없음 → AI 호출 안 함`); return; }
  const tempoTxt = dyn.tempo.bpm ? `템포 약 ${dyn.tempo.bpm} BPM (신뢰도 ${dyn.tempo.confidence})` : '템포 불분명';
  const gateInfo = `${modeInfo}\n측정: ${srcStat.analyser}틱${srcStat.cached ? ` (무음 캐시 대체 ${srcStat.cached}틱)` : ''} · ${tempoTxt}\n`
    + `조언 민감도 ${level}단계 · ${SENS_LABEL[level]} (최대 ${SENS_MAX[level]}줄) · 매 주기 AI 전송`;

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
    sensitivityLevel: level,
    sensitivityName: SENS_LABEL[level],
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
    // 🎧 최근 N초(설정) 실제 오디오 (L/R 독립 스테레오)
    const clip = engine.clipSnapshot(clipSec);
    // 🔇 2차 차단: 보낼 WAV 전체의 평균 RMS 가 기준 미만이면 API 호출 취소 (게이트를 껐거나 순간 노이즈로 열렸을 때 한도 보호)
    const floorDb = gateOn ? gateDb : SILENCE_FLOOR_DB;
    const clipDb = clip ? clipRmsDb(clip) : -120;
    if (!clip || clipDb < floorDb) {
      setStatus(`⏸️ 신호 대기 · 최근 ${clip ? Math.round(clip.l.length / clip.sr * 10) / 10 : clipSec}초 평균 ${clipDb <= -120 ? '무음' : clipDb + ' dBFS'} < ${floorDb} dBFS → AI 호출 안 함`);
      setAiLast(`${gateInfo}\n🔇 무음 차단: 최근 WAV 평균 RMS ${clipDb <= -120 ? '무음' : clipDb + ' dBFS'} (기준 ${floorDb} dBFS) → API 호출 취소`);
      return;
    }
    let wav: Awaited<ReturnType<typeof encodeWavStereo>> | null = null;
    const extra: Record<string, unknown> = { lastClip: { ...analyzeClip(clip), rmsDbStereo: clipDb } };   // 정규화 전 원본 수치
    if (supportsAudio(provider())) {
      try { wav = await encodeWavStereo(clip); extra.audio = { seconds: wav.seconds, sampleRate: WAV_RATE, channels: 2, bitDepth: 16, gainDb: wav.gainDb }; }
      catch (e) { console.warn('WAV 인코딩 실패 (수치만 전송)', e); }
    }
    const hasAudio = !!wav;
    const sys = buildSystemPrompt(level, hasAudio);
    const user = `${hasAudio ? `첨부 오디오: 최근 ${wav!.seconds}초 실제 소리 (44.1kHz 스테레오 16-bit WAV · L/R 독립 · 피크 -1dBFS 정규화 ${wav!.gainDb >= 0 ? '+' : ''}${wav!.gainDb}dB · 텍스트 dB 수치는 원본).\n` : ''}최근 ${windowSec}초 분석 데이터(JSON):\n${JSON.stringify({ ...payload, ...extra })}`;
    // 1·2·3순위 자동 폴백: 한도 소진이면 다음 순위로 바꿔 같은 데이터로 즉시 재요청
    let raw = '';
    for (;;) {
      const chain = modelChain(), cur = chain[activeIdx];
      if (!cur) throw new Error('설정에서 1순위 모델을 입력하세요');
      try { raw = await callAI(provider(), cur.model, key, sys, user, wav?.base64, hasAudio); break; }   // 오디오 첨부 시 2단계 JSON 응답
      catch (e) {
        if (!isQuotaError(e)) throw e;
        const next = chain[activeIdx + 1];
        if (!next) { pauseForQuota(); return; }
        showNotice(`⚠️ ${cur.model} API 한도가 소진되어 ${next.rank}순위 모델(${next.model})로 자동 전환합니다.`);
        activeIdx++; paintModelState();
        setStatus(`${next.rank}순위 모델(${next.model})로 재요청 중…`);
        if (!running) return;
      }
    }
    const res = parseReply(raw);
    paintHeard(res, hasAudio);
    if (res.genre) { acceptGenre(res.genre); genreAt = Date.now(); paintGenre(); sender.update({ genre: badgeForSend(), genreAt }); }
    // ✅ 믹스 양호(조언 없음): 남아 있던 조언을 지우고 HUD 첫 줄에 [믹스양호] 표시
    const good = res.mixStatus === 'GOOD_BALANCE' && !res.advice.length && !res.rejected.length;
    const wasGood = goodMix;
    if (good) { advice.clearDisplay(); goodMix = true; }
    const added = advice.ingest(res.advice, Date.now());
    if (added.length || res.advice.length) goodMix = false;
    addHistory(good ? (wasGood ? [] : [GOOD_MIX_LINE]) : added.map(a => a.text));   // 믹스 양호는 바뀔 때 한 번만 기록
    paintDetails(res, [...added.map(a => a.text), ...advice.displayList().map(i => i.text)], hasAudio);   // 지금 HUD 에 떠 있는 것은 표시 중
    const text = raw.trim().replace(/\s+/g, ' ');
    const audioInfo = `🤖 ${modelChain()[activeIdx]?.rank ?? '-'}순위: ${currentModel()}\n`
      + (hasAudio ? `🎧 최근 ${wav!.seconds}초 오디오 첨부 (44.1kHz 스테레오 16-bit WAV · ${Math.round(wav!.bytes / 1024)}KB · 원본 평균 ${clipDb} dBFS · 피크 -1dBFS 정규화 ${wav!.gainDb >= 0 ? '+' : ''}${wav!.gainDb}dB · ${clipHealthText()})` : '🎧 오디오 첨부 없음 (이 AI 공급자는 수치만 전송)')
      + (res.heard ? `\n👂 AI 청취: [${res.heard.sources.join(', ')}] · 장르 근거: ${res.heard.reasoning}` : '')
      + (res.mixStatus ? `\n🎚️ 믹스 상태: ${res.mixStatus}` : '')
      + (res.rejected.length ? `\n🚫 교차 검증 제외(들리지 않은 대상): ${res.rejected.join(' / ')}` : '');
    setAiLast(`${gateInfo}\n${audioInfo}\nAI 응답(${new Date().toLocaleTimeString()}): ${text || '(빈 응답)'}`);
    setStatus(!text ? 'AI 빈 응답' : good || res.none ? '✅ AI: 믹스 밸런스 양호 (조언 없음)'
      : !res.advice.length ? (res.rejected.length ? `AI 조언 ${res.rejected.length}건 모두 제외 (들린 소스 목록에 없는 대상)` : 'AI 응답 형식 불일치')
      : `AI: ${added.length}건 표시` + (res.advice.length > added.length ? ` · ${res.advice.length - added.length}건 제외(중복/쿨다운)` : '')
        + (res.rejected.length ? ` · ${res.rejected.length}건 제외(들리지 않은 대상)` : ''));
    render(); renderCooldown();
  } catch (e) {
    setStatus('AI 오류: ' + (e as Error).message.slice(0, 80));
  } finally { inFlight = false; }
}

/** 📝 상세 조언 (웹 화면 전용): HUD 한 줄 + 근거·조작 방법·확인할 점 */
function paintDetails(res: ParsedReply, shown: string[], hasAudio: boolean) {
  const box = $('details'), info = $('detailInfo');
  const t = new Date().toLocaleTimeString();
  const pill = (st?: string) => { if (!st) return; const p = document.createElement('span'); p.className = `mixpill ${st}`; p.textContent = st; info.appendChild(p); };
  if (!res.details.length) {
    const good = res.none || res.mixStatus === 'GOOD_BALANCE';
    info.textContent = `${t} · ${good ? '조언 없음' : hasAudio ? '상세 설명 없음' : '이 AI 공급자는 한 줄 조언만 제공'}`;
    pill(res.mixStatus);
    if (good) box.replaceChildren(Object.assign(document.createElement('div'), { className: 'mixgood', textContent: '✅ 현재 믹스 밸런스가 양호합니다 (추가 조정 불필요)' }));
    return;
  }
  info.textContent = `${t} · ${res.details.filter(d => !d.rejected && d.text).length}건`;
  pill(res.mixStatus);
  box.replaceChildren(...res.details.map(d => {
    const el = document.createElement('div');
    const dup = !d.rejected && !!d.text && !shown.includes(d.text);
    el.className = 'detail' + (d.rejected ? ' rej' : dup ? ' dup' : '');
    const line = document.createElement('div'); line.className = 'line'; line.textContent = d.text || '📝 상세 설명';
    if (d.rejected || dup) { const tg = document.createElement('span'); tg.className = 'tag'; tg.textContent = d.rejected ? '🚫 들린 소스 아님 → HUD 제외' : '⏳ 쿨다운 중 → HUD 미표시'; line.appendChild(tg); }
    const why = document.createElement('div'); why.className = 'why'; why.textContent = d.detail || '(상세 설명 없음)';
    el.append(line, why);
    return el;
  }));
  box.scrollTop = 0;
}

/** 🎧 AI 청취 배지: AI 가 오디오를 듣고 판단한 소스 + 음향 특성 한 줄 */
function paintHeard(res: ParsedReply, hasAudio: boolean) {
  const el = $('aiHeard');
  if (!res.heard) { el.textContent = hasAudio ? '🎧 AI 청취: (JSON 응답 아님)' : '🎧 AI 청취: 오디오 미첨부 공급자 (수치만 전송)'; el.title = ''; return; }
  const src = res.heard.sources.length ? res.heard.sources.join(', ') : '들리는 소스 없음';
  el.textContent = `🎧 AI 청취: [${src}]${res.heard.reasoning ? ` - ${res.heard.reasoning}` : ''}`;
  const why = $('genreWhy');
  why.hidden = !res.heard.reasoning;
  why.textContent = res.heard.reasoning ? `🎼 장르 근거: ${res.heard.reasoning}` : '';
  if (res.rejected.length) {
    const r = document.createElement('span'); r.className = 'rej';
    r.textContent = ` · 🚫 ${res.rejected.length}건 제외`; el.appendChild(r);
  }
  el.title = `${new Date().toLocaleTimeString()} · ${el.textContent}${res.rejected.length ? `\n제외: ${res.rejected.join(' / ')}` : ''}`;
}
/** 오디오 클립 연속성 (워클릿 순번으로 검사) */
function clipHealthText(): string {
  const h = engine.clipHealth();
  return h.gaps || h.overlaps ? `⚠️ 끊김 ${h.gaps} · 겹침 ${h.overlaps} (끊긴 앞부분은 버림)` : '연속 캡처 ✓ 누락 0';
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
