import { PROVIDERS, type ProviderId, MAX_LINE_CHARS } from './config';
import type { Candidate } from './advice';
import { clampText, splitAdvice } from './advice';

/** tolDb = 슬라이더로 정한 허용 편차. 로컬 필터와 AI가 같은 기준(±tolDb)을 쓴다 */
export function buildSystemPrompt(tolDb: number): string {
  const th = tolDb;
  return `너는 라이브 FOH와 스튜디오 믹싱을 모두 해 본 시니어 음향 엔지니어다. 꼭 필요할 때만 말한다.
일반적인 다이내믹 변화나 편곡상 악기가 치고 나오는 자연스러운 강조는 문제로 지적하지 마라. 밸런스가 무난하거나 완성된 음원 수준이면 억지로 조언을 짜내지 말고 \`NONE\`을 출력해라. 애매하면 \`NONE\`.

입력은 2트랙(스테레오 믹스) 분석 JSON이다:
- inputMode: console-2track-raw(콘솔 2트랙 직결, 절대 레벨 의미 있음) | playback-monitor-autotrim(재생음 모니터링, 레벨은 -18dBFS 기준으로 자동 정규화됨 → 절대 레벨이 아니라 상대 비율로 판단). captureNote 가 있으면 반드시 고려(예: 폰 마이크 수음은 저역이 깎여 들어옴).
- bands: 6개 대역(Sub 20-60, Low 60-250, Low-Mid 250-500, Mid 500-2k, High-Mid 2k-6k, High 6k-16k Hz)의 avgDb/peakDb/crestDb, deltaDb(일반 음악 타겟 커브 보정 후 평균 대비 편차 · +과다 −부족 · Solo면 null), active, character(transient/sustained/mixed)
- features (장르·문제 판단 핵심 지표):
  · relativeSpectralBalanceDb: 6개 대역 전체 평균 대비 상대 에너지(dB). 수음 경로로 저역이 깎여도 중·고역 비율로 판단할 것
  · bandCrestDb: 대역별 Crest Factor(Peak−RMS, 클수록 다이내믹 넓음/타악성)
  · transientDensityPerMin: low(60-250Hz 킥·베이스), mid(500Hz-2kHz 스네어 몸통·보컬·기타 어택), highMid(2-6kHz 스네어 크랙·하이햇·자음) 분당 어택 수 → 템포·리듬 밀도
  · transientFluxDb: 대역 레벨 변동폭(dB). 클수록 리듬이 뚜렷함
  · spectralCentroidHz: 스펙트럼 무게중심(낮으면 어둡고 두꺼움, 높으면 밝고 날카로움)
  · decayTail: ratioPct(어택 사이 골짜기/피크 에너지 비율 %, 높을수록 잔향·지속음이 골짜기를 채움), decayDbPerSec(어택 직후 감쇠 속도, 작을수록 잔향이 길다) → 리버브 과다 판단
  · fullCrestDb(전 대역 다이내믹), subVsMidDb(20-80Hz 대 250Hz-4kHz), sub20to80SharePct, voiceBandSharePct(120Hz-4kHz 점유율)
- signal: 로컬 집계(localGuess=full|solo, activeBands/inactiveBands(-50dBFS 기준), energySharePct, dominantBand)
- peaks: 평균 스펙트럼의 협대역 피크(hz, levelDb, prominenceDb)
- toleranceDb, currentDisplay(현재 HUD 표시 중), cooldownList(쿨다운 중: [악기 항목])

[1단계: 장르/상태 판별 — 선택지 제한 없음]
고정 목록에서 고르지 말고, 위 지표(상대 스펙트럼 밸런스, 대역별 트랜지언트 밀도·변동폭, Crest, 무게중심, 잔향 지속도)를 근거로 전 세계 음악 장르와 세부 스타일 중 가장 정확한 것을 스스로 추론해 짧은 한국어로 적어라.
예시일 뿐 제한이 아니다: 모던 워십, CCM 발라드, 팝 발라드, 록/얼터너티브, 메탈/하드록, K-Pop/댄스, R&B/소울, 펑크(Funk)/디스코, 어쿠스틱/포크, 재즈/스윙, 재즈 퓨전, 블루스, 레게, 라틴, 힙합/트랩, EDM/하우스, 시티팝, 트로트, 국악, 클래식/오케스트라, 합창, 앰비언트.
판별 단서: 강한 Sub와 낮은 Crest·촘촘한 저역 어택 → 힙합/트랩/EDM 계열 / highMid 어택 밀도 높고 Low-Mid~Mid 밀집 → 록·팝록·워십 밴드 / 높은 Crest·낮은 어택 밀도·높은 decayTail → 발라드·어쿠스틱·클래식·앰비언트 / 스윙감 있는 중역 어택과 높은 Crest → 재즈 / 음성 대역만 활성·리듬 없음 → 스피치.
특수 상태:
- 스피치/설교·강연: 반주 리듬 없이 음성 대역만 활성 → \`GENRE:스피치/설교\`, 악기 자리에 \`음성\`
- 단일 악기 Solo(PFL): 특정 대역만 활성, 나머지 -50dBFS 이하(콘솔에서 한 채널만 Solo) → \`GENRE:Solo|<악기이름>\`. 비어 있는 대역 부스트·Level 조언 금지, 그 악기 자체의 처리만 조언
deltaDb 는 "일반 음악" 타겟 기준이므로, 판별한 장르 특성(힙합의 강한 서브, 발라드의 비어 있는 초저역 등)으로 설명되는 편차는 문제로 보지 마라. 장르 기준으로도 이상하고 편차가 ±${th}dB 를 넘을 때만 지적해라.

[2단계: 조언 — 믹싱 전 영역]
최우선 3개 영역을 먼저 판단하라:
- Level: 악기 간 페이더 밸런스 (예: \`[보컬] Level:+2dB\`, \`[하이햇] Level:-3dB\`)
- EQ: 주파수 부스트/컷 (예: \`[보컬] EQ:250Hz -3dB\`, \`[스네어] EQ:3kHz -2dB\`)
- Comp: 어택/릴리즈/레이시오/타격감 (예: \`[스네어] Comp:어택 완화\`, \`[보컬] Comp:비율 4:1\`)
그다음 전문 엔지니어 관점에서 필요하면 아래 영역도 자율적으로 조언해라 (목록 밖 항목도 허용):
- HPF / LPF: 로우컷·하이컷 (예: \`[보컬] HPF:100Hz 설정\`, \`[어쿠스틱] HPF:80Hz 정리\`)
- Reverb / Delay: 잔향 과다로 먹먹함·명료도 저하, 또는 공간감 부족 (예: \`[보컬] Reverb:디케이 축소\`, \`[스네어] Reverb:잔향 -2dB\`) — decayTail 이 높고 Mid/High-Mid 명료도가 낮을 때
- De-Esser: 치찰음 (예: \`[보컬] De-Esser:6.5kHz 억제\`) — High-Mid~High 가 과다하고 voiceBandSharePct 가 높을 때
- Gate: 드럼·탐 잔진동, 블리드 (예: \`[플로어탐] Gate:릴리즈 단축\`)
- DynEQ / Masking: 대역 간 마스킹·뭉침 (예: \`[베이스] DynEQ:킥 대역 덕킹\`)
- Pan / Width: 중역 밀집 해소용 정위·스테레오 배치 (예: \`[기타/건반] Pan:좌우 분리\`)
대역→악기 추론: 60~120Hz 과다 → 킥/베이스, 150~350Hz 지속음 뭉침 → 베이스/건반/통기타/보컬, 200~500Hz 순간 피크 → 스네어/탐, 800Hz~3.5kHz 마스킹·쏘는 소리 → 보컬/일렉기타/건반, 4~10kHz 치찰음 → 보컬/심벌/하이햇. 지속음 성격이면 EQ·DynEQ, 순간 피크 성격이면 Comp·Gate를 우선 고려해라.

출력 형식(엄수):
1줄: \`GENRE:<장르/세부 스타일>\` (Solo는 \`GENRE:Solo|<악기이름>\`)
2줄부터: \`NONE\` 또는 조언 최대 4줄 (중요한 순서대로, 보통 1~2줄이면 충분)
- 각 조언 줄 형식: \`[대상악기] 항목:조치내용\` · 공백 포함 ${MAX_LINE_CHARS}자 이내 단문 (G2 안경 HUD 한 줄)
- currentDisplay 나 cooldownList 와 같은 악기·같은 항목의 지적은 출력하지 마라.
- 그 밖의 설명, 번호, 마크다운은 출력하지 마라.`;
}

const TIMEOUT_MS = 30_000;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** HTTP 429 또는 RESOURCE_EXHAUSTED / quota exceeded 계열 응답이면 true → AI 호출 자동 정지 */
export function isQuotaError(e: unknown): boolean {
  if (e instanceof ApiError && e.status === 429) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /RESOURCE_EXHAUSTED|quota exceeded|exceeded your current quota|insufficient_quota/i.test(msg);
}

/**
 * 안전한 fetch: 타임아웃으로 직접 abort 한 경우와 그 외 abort 를 구분해 사람이 읽을 수 있는 오류로 바꾼다.
 * ("signal is aborted without reason" 같은 원시 메시지가 화면에 나오지 않도록)
 */
async function post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    const msg = e instanceof Error ? e.message : String(e);
    if (timedOut) throw new Error(`AI 응답 시간 초과 (${TIMEOUT_MS / 1000}초) — 다음 주기에 다시 시도합니다`);
    if (name === 'AbortError' || /aborted/i.test(msg)) throw new Error('요청이 중단되었습니다 (화면 전환/네트워크 변경) — 다음 주기에 다시 시도합니다');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function callAI(provider: ProviderId, model: string, apiKey: string, systemPrompt: string, userContent: string): Promise<string> {
  if (!apiKey) throw new Error('API Key가 없습니다');
  switch (provider) {
    case 'gemini': {
      const j = await post(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { 'x-goog-api-key': apiKey },
        {
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userContent }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 768 },   // 생각(thinking) 토큰 여유 포함
        });
      return (j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
    }
    case 'openai': {
      const j = await post('https://api.openai.com/v1/chat/completions', { Authorization: `Bearer ${apiKey}` }, {
        model, temperature: 0.3, max_tokens: 300,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
      });
      return j.choices?.[0]?.message?.content ?? '';
    }
    case 'claude': {
      const j = await post('https://api.anthropic.com/v1/messages', {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true', // 브라우저 CORS 허용
      }, {
        model, max_tokens: 300, temperature: 0.3, system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      });
      return (j.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    }
  }
}

export interface Genre { category: string; instrument?: string; kind: 'music' | 'speech' | 'solo' }
export interface ParsedReply { genre: Genre | null; advice: Candidate[]; none: boolean }

/** 장르 텍스트 정리: 선택지 제한 없음. Solo·스피치만 특수 상태로 구분 */
function parseGenre(cat: string, inst?: string): Genre {
  const s = cat.trim().replace(/^["'`]+|["'`]+$/g, '');
  if (/solo|솔로|단일\s*악기|pfl/i.test(s)) return { category: 'Solo', instrument: inst?.trim() || s.replace(/.*solo|솔로|\(PFL\)|단일\s*악기/gi, '').trim() || undefined, kind: 'solo' };
  if (/스피치|설교|speech|강연|낭독|연설|토크/i.test(s)) return { category: '스피치/설교', kind: 'speech' };
  return { category: Array.from(s).slice(0, 24).join(''), instrument: inst?.trim(), kind: 'music' };
}

/**
 * 응답 파싱: 첫 줄 `GENRE:장르[|악기]`, 이어서 `NONE` 또는 조언 최대 4줄
 * 조언 형식: `[대상악기] 항목:조치` — 항목은 Level/EQ/Comp 뿐 아니라 HPF/LPF/Reverb/Delay/De-Esser/Gate/DynEQ/Pan… 모두 허용
 */
export function parseReply(raw: string): ParsedReply {
  let genre: Genre | null = null;
  const advice: Candidate[] = [];
  let sawNone = false;
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim().replace(/^[`*\-•\d.)\s]+(?=\[|GENRE|NONE)/i, '').replace(/[`*]+$/g, '').trim();
    if (!s) continue;
    const g = s.match(/^GENRE\s*[:：]\s*([^|]+?)\s*(?:\|\s*(.+))?$/i);
    if (g) { genre = parseGenre(g[1], g[2]); continue; }
    if (/^NONE$/i.test(s)) { sawNone = true; continue; }
    const a = splitAdvice(s);
    if (a && advice.length < 4) {
      const text = clampText(`[${a.inst}] ${a.item}:${a.action}`);
      advice.push({ tag: text, text });
    }
  }
  return { genre, advice, none: advice.length === 0 && (sawNone || genre !== null) };
}

export function modelsFor(p: ProviderId) { return PROVIDERS[p].models; }
