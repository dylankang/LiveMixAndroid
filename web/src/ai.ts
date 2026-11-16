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
export function buildGenrePrompt(hasAudio = false): string {
  return `너는 시니어 음향 엔지니어다. ${hasAudio ? '첨부된 최근 3초 WAV 오디오를 직접 듣고, 2트랙 분석 JSON 은 확인용으로 써서' : '2트랙(스테레오 믹스) 분석 JSON 을 보고'} 지금 연주 중인 음악의 장르/상태만 판별한다.
${GENRE_GUIDE}${hasAudio ? '\n귀로 들은 악기 편성·리듬·보컬 스타일을 가장 중요하게 보고, 수치는 확인용으로 써라.' : ''}

출력 형식(엄수): 한 줄만 \`GENRE:<장르/세부 스타일>\` (Solo 는 \`GENRE:Solo|<악기이름>\`). 그 밖의 글, 조언, 설명은 출력하지 마라.`;
}

/** tolDb = 슬라이더로 정한 허용 편차. 로컬 필터와 AI가 같은 기준(±tolDb)을 쓴다. 0 = '항상 AI' 적극 조언 모드 */
/** 오디오 첨부(Gemini)일 때: 먼저 듣고 식별하는 규칙 */
const LISTEN_RULES = `[1단계 — 실제 오디오 청취로 소스 식별 (가장 중요)]
- 첨부된 3초 WAV 오디오를 직접 듣고, 지금 이 순간 실제로 연주되고 들리는 악기와 보컬만 식별하라.
- 첨부된 44.1kHz 스테레오 WAV 오디오의 좌우 정위(Panning)와 고역 배음을 주의 깊게 듣고, 악기의 음색을 명확히 구분하라. 중역대 화음이 들린다고 해서 습관적으로 [피아노]로 단정 짓지 마라.
- 믹스 전체에서 뒤로 빠져 작게 들리는 배경 악기 하나에만 계속 집착하지 말고, 현재 사운드에서 가장 에너지가 지배적인 주선율 악기(보컬, 브라스, 리드 기타 등)와 리듬 섹션(킥, 스네어, 베이스, 하이햇/오버헤드) 간의 마스킹 및 레벨 밸런스를 최우선으로 진단하라.
- 오디오에서 사람의 노래나 말소리가 실제로 들리지 않으면(연주곡·간주 구간 등), DSP 중역대 수치가 아무리 높아도 절대 [남성보컬], [여성보컬], [메인보컬], [코러스]를 출력하지 마라.
- 실제 오디오에서 들리지 않는 악기(어쿠스틱 기타, 첼로, 스트링, 브라스, 피아노 등)를 주파수 대역 수치만 보고 추측해서 지어내는 것을 엄격히 금지한다. 확신이 없으면 그 악기는 언급하지 마라.
- 보컬이 들리면 실제 목소리의 음색과 피치(포먼트)를 듣고 [남성보컬]과 [여성보컬]을 정확히 구분하라. 여러 명이 같이 부르면 [코러스].
- 첨부 오디오는 듣기 쉽게 음량이 정규화되어 있다(audio.gainDb). 레벨의 크고 작음은 소리 크기가 아니라 DSP 수치로 판단하라.`;

/** tolDb = 슬라이더로 정한 허용 편차. 로컬 필터와 AI가 같은 기준(±tolDb)을 쓴다. 0 = '항상 AI' 적극 조언 모드
 *  hasAudio = 최근 3초 WAV 를 함께 보낼 때(Gemini) → '선(先) 청취 · 후(後) 수치 처방' */
export function buildSystemPrompt(tolDb: number, hasAudio = false): string {
  const th = tolDb;
  const eager = th <= 0;
  const cats = CATEGORIES.join(', ');
  const heard = hasAudio ? '오디오에서 실제로 들리는' : '지표로 분명히 드러나는';
  return `너는 라이브 FOH와 스튜디오 믹싱을 모두 해 본 시니어 음향 엔지니어다. ${hasAudio ? '귀로 먼저 듣고, 눈(수치)으로 처방한다. ' : ''}${eager
    ? 'FOH 옆에서 귀 역할을 하며, 개선할 여지를 적극적으로 찾아 구체적으로 말한다.'
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
- \`[]\` 안에는 ${heard} 소스 중에서 실제로 콘솔에서 조절해야 할 대상(채널·그룹·버스)을 적어라.
  · 개별 악기: 예) [킥], [스네어], [하이햇], [탐], [오버헤드], [베이스], [일렉기타], [어쿠스틱기타], [피아노], [건반], [신스], [브라스], [스트링]
  · 보컬: 남/여를 구분해라. 예) [남성보컬], [여성보컬], [메인보컬], [코러스]
  · 그룹/버스/마스터: 특정 악기가 아니라 묶음이나 전체 출력을 만져야 할 때. 예) [드럼버스], [보컬그룹], [마스터]
  · 위 예시는 참고일 뿐 목록 밖 대상도 허용한다. 단, ${hasAudio ? '오디오에서 들리지 않는 소스는 절대 쓰지 마라.' : '근거 없이 악기를 지어내지 마라.'}
- \`[]\` 안에 [서브], [로우], [로우-미드], [미드], [하이-미드], [하이], [저역], [중역], [고역] 같은 주파수 대역명을 넣지 마라. 대역은 조치 내용(예: EQ:250Hz -3dB)에 적는다.
${hasAudio ? '' : '- 남/여 보컬 구분 참고: voiceBandSharePct 가 높게 활성화돼 있을 때 spectralCentroidHz 와 Low-Mid(150~350Hz) 대비 Mid·High-Mid 비율을 본다. Low-Mid 우세·무게중심이 낮으면 남성, Mid·High-Mid 우세·무게중심이 높으면 여성 쪽이다. 가를 수 없으면 [메인보컬].\n'}
입력 JSON:
- inputMode: console-2track-raw(FOH 콘솔 2트랙 직결, 절대 레벨 의미 있음). levelReference 가 auto-trim 이면 레벨은 -18dBFS 기준 정규화값이므로 상대 비율로 판단. captureNote 가 있으면 고려.
- bands / features / peaks: 전체 분석 구간(windowSec) 평균. 6개 대역(Sub 20-60, Low 60-250, Low-Mid 250-500, Mid 500-2k, High-Mid 2k-6k, High 6k-16k Hz)의 avgDb/peakDb/crestDb, deltaDb(일반 음악 타겟 대비 편차 · +과다 −부족), 스펙트럼 상대 에너지(relativeSpectralBalanceDb), bandCrestDb, transientDensityPerMin(low/mid/highMid 분당 어택), transientFluxDb, spectralCentroidHz, decayTail(ratioPct 잔향이 골짜기를 채우는 정도 · decayDbPerSec 감쇠 속도), fullCrestDb, subVsMidDb, voiceBandSharePct, tempo(BPM·신뢰도), longTerm(최근 약 1분 평균)
${hasAudio ? '- last3s: 첨부 WAV 와 정확히 같은 최근 3초의 단기 지표. bands 의 avgDb(3초 평균)·peakDb(가장 센 순간)·relDb(전체 대비), crestDb, spectralCentroidHz, voiceBandSharePct, onsetsPerSec. 순간적인 스네어 타격·치찰음·베이스 어택은 여기서 확인하라.\n- last3s.stereo: correlation(L/R 상관, 1=모노·낮을수록 넓음·음수=역위상), sideToMidDb(스테레오 폭), balanceDb(+ = 왼쪽이 큼)\n- audio: 첨부 오디오 정보(seconds, sampleRate 44100, channels 2, gainDb 정규화 게인 — L/R 동일 게인이라 좌우 밸런스는 그대로)\n' : ''}- signal(활성 대역 등), peaks(협대역 피크 hz/levelDb/prominenceDb), toleranceDb, currentDisplay(현재 HUD 표시 중), cooldownList(쿨다운 중)

${hasAudio ? LISTEN_RULES + '\n\n' : ''}[${hasAudio ? '2' : '1'}단계 — 장르/상태 판별]
${GENRE_GUIDE}${hasAudio ? '\n장르도 먼저 귀로 판단하고, 수치는 확인용으로 써라.' : ''}

[${hasAudio ? '3' : '2'}단계 — ${hasAudio ? '들리는 문제 + DSP 수치로 정밀 처방' : '조언'}]
${hasAudio ? `- 오디오를 들어 보고 실제로 마스킹(묻힘), 부밍(먹먹함), 하쉬니스(쏘는 소리), 치찰음, 다이내믹 불안정, 레벨 불균형이 느껴지는 악기/보컬만 골라라.
- 문제가 들리는 소스를 찾았다면, 함께 온 6밴드 dB(전체 구간·last3s 평균/피크), 스펙트럼·트랜지언트·크레스트 수치를 근거로 주파수(Hz)와 조절량(dB, 레시오 등)을 계산해 처방하라.
` : ''}deltaDb 는 "일반 음악" 타겟 기준이므로, 판별한 장르 특성으로 설명되는 편차는 문제로 보지 마라.
${eager
    ? `지금은 "항상 AI" 적극 조언 모드(허용 편차 ±0dB)다. ${heard} 소스들 중에서 라이브 믹스가 더 좋아질 수 있는 점(명료도, 악기 분리, 저역 정리, 다이내믹, 공간감, 보컬 존재감 등)을 찾아 매번 우선순위대로 2~4줄 조언해라. 작은 것(±1~2dB 수준)도 좋다. NONE 은 신호가 거의 없거나 Solo 에서 손댈 곳이 정말 없을 때만. 이미 화면에 있는 조언과 다른 관점(다른 악기나 다른 분류)을 골라라.`
    : `장르 기준으로도 이상하고 편차가 ±${th}dB 를 넘는 것만 지적해라. 일반적인 다이내믹 변화나 편곡상 악기가 치고 나오는 자연스러운 강조는 문제가 아니다. 현재 밸런스가 자연스럽고 뚜렷한 문제가 ${hasAudio ? '들리지' : '보이지'} 않으면 억지로 4줄을 채우지 말고 꼭 필요한 1~2줄만, 없으면 \`NONE\`.`}
영역 우선순위: Level · EQ · Comp 를 먼저, 그다음 필요하면 HPF/LPF, Reverb/Delay(잔향 과다·명료도 저하: decayTail 높고 Mid/High-Mid 낮을 때), De-Esser(치찰음), Gate(탐 잔진동·블리드), DynEQ(대역 간 마스킹), Pan/Width(중역 밀집).
지속음 성격의 문제는 EQ·DynEQ, 순간 피크 성격은 Comp·Gate 를 우선 고려해라.

출력 형식(엄수):
1줄: \`GENRE:<장르/세부 스타일>\` (Solo는 \`GENRE:Solo|<악기이름>\`)
2줄부터: ${eager ? '조언 2~4줄 (중요한 순서대로 · NONE 은 예외적인 경우만)' : '\`NONE\` 또는 조언 최대 4줄 (중요한 순서대로, 보통 1~2줄)'}
- 각 조언 줄 형식: \`[조절 대상] 분류:내용\` (분류 = ${cats} 중 하나 · 대상에 대역명 금지) · 한글 기준 ${MAX_LINE_CHARS}자 이내
- currentDisplay 나 cooldownList 와 같은 악기·같은 항목의 지적은 출력하지 마라.
- 그 밖의 설명, 번호, 마크다운은 출력하지 마라.`;
}

const TIMEOUT_MS = 7_000;     // 백그라운드/느린 망에서 분석 루프(inFlight)가 영구 잠기지 않도록 짧게

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

/** 오디오 첨부를 지원하는 공급자 (Gemini 멀티모달 inlineData) */
export const supportsAudio = (p: ProviderId) => p === 'gemini';
/** 없는 악기를 지어내지 않도록 낮춘 생성 파라미터 */
const GEN = { temperature: 0.25, topP: 0.8, topK: 20 } as const;   // 0.25: 한 악기(피아노 등)로 쏠리는 편향 완화

export async function callAI(provider: ProviderId, model: string, apiKey: string, systemPrompt: string, userContent: string, audioWavBase64?: string): Promise<string> {
  if (!apiKey) throw new Error('API Key가 없습니다');
  switch (provider) {
    case 'gemini': {
      const j = await post(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { 'x-goog-api-key': apiKey },
        {
          systemInstruction: { parts: [{ text: systemPrompt }] },
          // 최근 3초 WAV(44.1kHz 스테레오 16-bit) + DSP 수치·지시문을 함께 보냄
          contents: [{ role: 'user', parts: audioWavBase64
            ? [{ inlineData: { mimeType: 'audio/wav', data: audioWavBase64 } }, { text: userContent }]
            : [{ text: userContent }] }],
          generationConfig: { ...GEN, maxOutputTokens: 768 },   // 생각(thinking) 토큰 여유 포함
        });
      return (j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
    }
    case 'openai': {
      const j = await post('https://api.openai.com/v1/chat/completions', { Authorization: `Bearer ${apiKey}` }, {
        model, temperature: GEN.temperature, top_p: GEN.topP, max_tokens: 300,
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
        model, max_tokens: 300, temperature: GEN.temperature, system: systemPrompt,
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
