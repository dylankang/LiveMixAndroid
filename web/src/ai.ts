import { PROVIDERS, type ProviderId, MAX_LINE_CHARS } from './config';
import type { Candidate } from './advice';
import { clampText, normalizeAdvice, CATEGORIES } from './advice';

/** 장르 판별 지침 (조언 프롬프트와 장르 전용 프롬프트가 같이 씀) */
const GENRE_GUIDE = `[장르/상태 판별 — 선택지 제한 없음]
고정 목록에서 고르지 말고 지표를 근거로 전 세계 음악 장르와 세부 스타일 중 가장 정확한 것을 짧은 한국어로 적어라.
예시일 뿐 제한이 아니다: 모던 워십, CCM 발라드, 팝 발라드, 록/얼터너티브, 메탈/하드록, K-Pop/댄스, R&B/소울, 펑크(Funk)/디스코, 어쿠스틱/포크, 재즈/스윙, 재즈 퓨전, 블루스, 레게, 라틴, 힙합/트랩, EDM/하우스, 시티팝, 트로트, 국악, 클래식/오케스트라, 합창, 앰비언트.
판단 순서 (하나의 지표만 보고 단정하지 마라):
1) 템포·리듬: features.tempo.bpm(최근 약 20초 자기상관 추정) 과 confidence. confidence 가 0.3 이상이면 신뢰. 하프타임·더블타임(절반·두 배 BPM)일 가능성도 고려.
   대략: 발라드·워십 발라드 60~85, R&B/힙합 70~100(하프타임 느낌), 팝·록·CCM 90~140, 하우스/EDM 118~130(저역 어택이 매우 규칙적), 댄스/K-Pop 100~130, 펑크·디스코 100~125, 메탈·펑크록 140~200, 레게 70~90 오프비트. confidence 가 낮으면(<0.15) 리듬이 약한 발라드·앰비언트·클래식·스피치 쪽.
2) 저역 구조: Sub/Low 비율, subVsMidDb, sub20to80SharePct, Low 대역 Crest·어택 밀도. 강한 Sub+낮은 Crest+촘촘한 저역 어택 → 힙합/트랩/EDM.
3) 타악 밀도: transientDensityPerMin(highMid 많으면 하이햇·스네어가 바쁜 록/댄스), transientFluxDb.
4) 음색: spectralCentroidHz, High-Mid/High 비율(밝고 공격적이면 록·메탈·댄스, 어둡고 둥글면 재즈·발라드·R&B), voiceBandSharePct.
5) 공간감: decayTail(잔향 많으면 워십·발라드·합창·앰비언트·클래식).
features.longTerm 은 최근 약 1분 평균이다. 이번 구간(features)과 다르면 곡이 바뀌었을 수 있으니 이번 구간을 우선하되, 한 구간만 튀는 경우에는 longTerm 을 더 믿어라.
특수 상태:
- 스피치/설교·강연: 반주 리듬 없이 음성 대역만 활성 → \`GENRE:스피치/설교\`, 대상 자리에 \`음성\`
- 단일 악기 Solo(PFL): 특정 대역만 활성, 나머지 -50dBFS 이하 → \`GENRE:Solo|<악기이름>\`. 비어 있는 대역 부스트·Level 조언 금지, 그 악기 자체의 처리만 조언`;

/** 장르만 판별하는 짧은 프롬프트 — 로컬 필터를 통과해 조언이 필요 없는 주기에도 장르는 AI 조언 주기마다 갱신 */
export function buildGenrePrompt(): string {
  return `너는 시니어 음향 엔지니어다. 2트랙(스테레오 믹스) 분석 JSON 을 보고 지금 연주 중인 음악의 장르/상태만 판별한다.
${GENRE_GUIDE}

출력 형식(엄수): 한 줄만 \`GENRE:<장르/세부 스타일>\` (Solo 는 \`GENRE:Solo|<악기이름>\`). 그 밖의 글, 조언, 설명은 출력하지 마라.`;
}

/** tolDb = 슬라이더로 정한 허용 편차. 로컬 필터와 AI가 같은 기준(±tolDb)을 쓴다. 0 = '항상 AI' 적극 조언 모드 */
export function buildSystemPrompt(tolDb: number): string {
  const th = tolDb;
  const eager = th <= 0;
  const cats = CATEGORIES.join(', ');
  return `너는 라이브 FOH와 스튜디오 믹싱을 모두 해 본 시니어 음향 엔지니어다. ${eager
    ? 'FOH 옆에서 귀 역할을 하며, 지표에서 개선할 여지를 적극적으로 찾아 구체적으로 말한다.'
    : '분명한 문제를 우선해서 짧고 구체적으로 말한다.'}

[최우선 규칙 1 — 조언 한 줄의 형식]
\`[조절 대상] 분류:내용\`
- 분류는 반드시 다음 중 하나만: ${cats}
- 분류 자리에 주파수 대역명(low-mid, 미드 등)이나 숫자(250Hz)를 쓰지 마라. 대역·주파수는 내용에 쓴다.
  잘못: \`[음성]low-mid:250hz -3db\`  →  올바름: \`[음성] EQ:250Hz -3dB\`
  잘못: \`[보컬] 컴프레서 비율 3:1\`  →  올바름: \`[메인보컬] Comp:레시오 3:1 ↓\`
  잘못: \`[보컬] HPF:100Hz 설정\`  →  올바름: \`[메인보컬] HPF:100Hz ↑\`
- 내용 쓰는 법 (직관적이고 짧게):
  · EQ: 주파수 + 지금보다 몇 dB 올리고 내릴지: \`[남성보컬] EQ:250Hz -3dB\`
  · Level 과 dB 로 말할 수 있는 파라미터(센드, 스레숄드, 메이크업 게인, 레인지): 절대값이 아니라 지금 상태에서 몇 dB 올리고 내릴지 ± 부호와 함께
    예) \`[메인보컬] Level:+2dB\` · \`[하이햇] Level:-3dB\` · \`[메인보컬] Reverb:센드 -3dB\` · \`[스네어] Comp:스레숄드 -4dB\`
  · 그 밖(주파수·레시오·시간)은 네가 생각하는 대략적인 목표 수치를 쓰고 그 뒤에 방향 화살표를 붙인다. ↑ = 지금보다 올려라/늘려라, ↓ = 낮춰라/줄여라, 크게 바꿀 때 ↑↑ / ↓↓, Pan 은 ← →
    예) \`[메인보컬] HPF:120Hz ↑\`(HPF를 120Hz 쯤으로 올려라) · \`[스네어] Comp:레시오 3:1 ↓\`(레시오를 3:1 쯤으로 낮춰라)
        \`[킥] Comp:어택 30ms ↑\` · \`[메인보컬] Reverb:디케이 1.5s ↓\` · \`[탐] Gate:릴리즈 150ms ↓\` · \`[여성보컬] De-Esser:6kHz ↑\` · \`[일렉기타] Pan:L30 ←\`
- 한 줄 길이: 한글 기준 ${MAX_LINE_CHARS}자 이내 (영문·숫자·공백은 2개가 한글 1자 폭) — G2 안경 HUD 한 줄에 들어가야 한다

[최우선 규칙 2 — [조절 대상] 표기]
- \`[]\` 안에는 실제로 콘솔에서 조절해야 할 대상(채널·그룹·버스)을 적어라. 무엇을 적을지는 분석 지표를 근거로 네가 판단해라.
  · 개별 악기: 예) [킥], [스네어], [하이햇], [탐], [오버헤드], [베이스], [일렉기타], [어쿠스틱기타], [피아노], [건반], [신스], [브라스], [스트링]
  · 보컬: 가능하면 남/여를 구분해라. 예) [남성보컬], [여성보컬], [메인보컬], [코러스]
  · 그룹/버스/마스터: 특정 악기가 아니라 묶음이나 전체 출력을 만져야 할 때. 예) [드럼버스], [보컬그룹], [마스터]
  · 위 예시는 참고일 뿐 목록 밖 대상도 허용한다.
- \`[]\` 안에 \`[서브]\`, \`[로우]\`, \`[로우-미드]\`, \`[미드]\`, \`[하이-미드]\`, \`[하이]\`, \`[저역]\`, \`[중역]\`, \`[고역]\` 같은 주파수 대역명을 넣지 마라. 대역은 조절 대상이 아니라 조치 내용(예: EQ:250Hz -3dB)에 적는다.
- 남/여 보컬 구분 참고: voiceBandSharePct 가 높게 활성화돼 있을 때 spectralCentroidHz 와 relativeSpectralBalanceDb 의 Low-Mid(150~350Hz) 대비 Mid·High-Mid 비율을 본다. Low-Mid 우세·무게중심이 낮으면 남성, Mid·High-Mid 우세·무게중심이 높으면 여성 쪽이다. 가를 수 없으면 [메인보컬].

${eager
    ? '지금은 "항상 AI" 적극 조언 모드다. 완성된 음원 수준이라도 라이브 믹스에서 더 좋아질 수 있는 점(명료도, 악기 분리, 저역 정리, 다이내믹, 공간감, 보컬 존재감 등)을 찾아 매번 우선순위대로 2~4줄 조언해라. NONE 은 신호가 거의 없거나 Solo 에서 손댈 곳이 정말 없을 때만 쓴다. 이번에 이미 화면에 있는 조언과 다른 관점(다른 악기나 다른 분류)을 골라라.'
    : '일반적인 다이내믹 변화나 편곡상 악기가 치고 나오는 자연스러운 강조는 문제로 지적하지 마라. 밸런스가 무난하면 억지로 조언을 짜내지 말고 \`NONE\`을 출력해라.'}

입력은 2트랙(스테레오 믹스) 분석 JSON이다:
- inputMode: console-2track-raw(FOH 콘솔 → USB 인터페이스 2트랙 직결, 절대 레벨 의미 있음). levelReference 가 auto-trim 이면 레벨은 -18dBFS 기준으로 정규화된 것이므로 상대 비율로 판단. captureNote 가 있으면 고려.
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

[1단계]
${GENRE_GUIDE}
deltaDb 는 "일반 음악" 타겟 기준이므로, 판별한 장르 특성(힙합의 강한 서브, 발라드의 비어 있는 초저역 등)으로 설명되는 편차는 문제로 보지 마라. ${th <= 0
    ? '지금은 "항상 분석" 모드(허용 편차 ±0dB)라 로컬 필터 없이 매번 데이터가 온다. 편차 크기 기준은 두지 말고, 장르 기준으로 개선할 점이면 작은 것(±1~2dB 수준)이라도 지적해라.'
    : `장르 기준으로도 이상하고 편차가 ±${th}dB 를 넘을 때만 지적해라.`}

[2단계: 조언 — 믹싱 전 영역]
최우선 3개 영역을 먼저 판단하라:
- Level: 악기 간 페이더 밸런스 (예: \`[메인보컬] Level:+2dB\`, \`[하이햇] Level:-3dB\`)
- EQ: 주파수 부스트/컷 (예: \`[남성보컬] EQ:250Hz -3dB\`, \`[스네어] EQ:3kHz -2dB\`)
- Comp: 어택/릴리즈/레이시오/타격감 (예: \`[스네어] Comp:어택 20ms ↑\`, \`[여성보컬] Comp:레시오 4:1 ↑\`)
그다음 전문 엔지니어 관점에서 필요하면 아래 영역도 자율적으로 조언해라 (목록 밖 항목도 허용):
- HPF / LPF: 로우컷·하이컷 (예: \`[메인보컬] HPF:120Hz ↑\`, \`[어쿠스틱기타] HPF:90Hz ↑\`)
- Reverb / Delay: 잔향 과다로 먹먹함·명료도 저하, 또는 공간감 부족 (예: \`[메인보컬] Reverb:디케이 1.5s ↓\`, \`[스네어] Reverb:센드 -3dB\`) — decayTail 이 높고 Mid/High-Mid 명료도가 낮을 때
- De-Esser: 치찰음 (예: \`[여성보컬] De-Esser:6kHz ↑\`) — High-Mid~High 가 과다하고 voiceBandSharePct 가 높을 때
- Gate: 드럼·탐 잔진동, 블리드 (예: \`[플로어탐] Gate:릴리즈 150ms ↓\`)
- DynEQ / Masking: 대역 간 마스킹·뭉침 (예: \`[베이스] DynEQ:60Hz 덕킹\`)
- Pan / Width: 중역 밀집 해소용 정위·스테레오 배치 (예: \`[일렉기타] Pan:L30 ←\`, \`[건반] Pan:R30 →\`)
대역→악기 추론: 60~120Hz 과다 → 킥/베이스, 150~350Hz 지속음 뭉침 → 베이스/건반/통기타/보컬, 200~500Hz 순간 피크 → 스네어/탐, 800Hz~3.5kHz 마스킹·쏘는 소리 → 보컬/일렉기타/건반, 4~10kHz 치찰음 → 보컬/심벌/하이햇. 지속음 성격이면 EQ·DynEQ, 순간 피크 성격이면 Comp·Gate를 우선 고려해라.

출력 형식(엄수):
1줄: \`GENRE:<장르/세부 스타일>\` (Solo는 \`GENRE:Solo|<악기이름>\`)
2줄부터: ${eager ? '조언 2~4줄 (중요한 순서대로 · NONE 은 예외적인 경우만)' : '\`NONE\` 또는 조언 최대 4줄 (중요한 순서대로, 보통 1~3줄)'}
- 각 조언 줄 형식: \`[조절 대상] 분류:내용\` (분류 = ${cats} 중 하나 · 대상에 대역명 금지) · 한글 기준 ${MAX_LINE_CHARS}자 이내
- currentDisplay 나 cooldownList 와 같은 악기·같은 항목의 지적은 출력하지 마라.
- 그 밖의 설명, 번호, 마크다운은 출력하지 마라.`;
}

const TIMEOUT_MS = 8_000;     // 백그라운드/느린 망에서 분석 루프(inFlight)가 영구 잠기지 않도록 짧게

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
    const payload = JSON.stringify(body);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: payload,
      signal: ctl.signal,
      keepalive: payload.length < 60000,     // 백그라운드 전환 중에도 요청 유지 (keepalive 본문 한도 64KB 이내일 때만)
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
          generationConfig: { temperature: 0.45, maxOutputTokens: 768 },   // 생각(thinking) 토큰 여유 포함
        });
      return (j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
    }
    case 'openai': {
      const j = await post('https://api.openai.com/v1/chat/completions', { Authorization: `Bearer ${apiKey}` }, {
        model, temperature: 0.45, max_tokens: 300,
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
        model, max_tokens: 300, temperature: 0.45, system: systemPrompt,
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
    const a = normalizeAdvice(s);      // [대상] 분류:내용 으로 정리 (분류 자리의 대역명 → EQ, 단위 표기 통일)
    if (a && advice.length < 4) {
      const text = clampText(`[${a.inst}] ${a.item}:${a.action}`);
      if (!advice.some(x => x.tag === text)) advice.push({ tag: text, text });
    }
  }
  return { genre, advice, none: advice.length === 0 && (sawNone || genre !== null) };
}

export function modelsFor(p: ProviderId) { return PROVIDERS[p].models; }
