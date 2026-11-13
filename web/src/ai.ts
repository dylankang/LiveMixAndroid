import { PROVIDERS, type ProviderId, MAX_LINE_CHARS } from './config';
import type { Candidate } from './advice';
import { clampText } from './advice';

export const GENRES = ['밴드/워십/팝록', '발라드/어쿠스틱', '힙합/EDM/댄스', '재즈/연주곡', '스피치/설교', '단일 악기 Solo(PFL)'] as const;

/** tolDb = 슬라이더로 정한 허용 편차. 로컬 필터와 AI가 같은 기준(±tolDb)을 쓴다 */
export function buildSystemPrompt(tolDb: number): string {
  const th = tolDb;
  return `너는 꼭 필요할 때만 입을 여는 시니어 FOH 엔지니어다. 일반적인 음악의 다이내믹 변화나 편곡상 악기가 솔로로 치고 나오는 자연스러운 대역 강조는 절대 문제로 지적하지 마라.
기준 타겟 대비 특정 대역이 +${th}dB 이상 심각하게 뭉치거나 쏘는 경우, 또는 마스킹이 매우 심해 관객이 듣기에 불편한 수준일 때만 최대 2줄로 조언해라.
밸런스가 무난하거나 완성된 음원 수준이라면 억지로 조언을 짜내지 말고 무조건 \`NONE\`이라고만 출력해라. 애매하면 무조건 \`NONE\`을 출력해라.

입력은 2트랙(스테레오 믹스) 분석 JSON이다:
- bands: 6개 대역의 avgDb/peakDb/crestDb, deltaDb(일반 음악 타겟 커브로 보정한 뒤 전체 평균 대비 편차, +는 과다, -는 부족. Solo 추정 시 null), active, character(transient=순간 피크 성격, sustained=지속음 성격, mixed)
- signal: 로컬 집계 (localGuess=full|solo 추정, activeBands/inactiveBands(-50dBFS 기준), energySharePct, dominantBand)
- metrics: fullCrestDb(전 대역 Peak-RMS, 클수록 다이내믹이 넓음), fullRmsDb, subVsMidDb(20~80Hz 대 250Hz~4kHz 에너지비, dB), sub20to80SharePct, voiceBandSharePct(120Hz~4kHz 점유율), lowFluxDb(저역 레벨 변동폭), lowOnsetsPerSec(저역 타격 횟수/초)
- peaks: 평균 스펙트럼에서 솟은 협대역 피크 (hz, levelDb, prominenceDb)
- toleranceDb, currentDisplay(현재 화면 표시 목록), cooldown5min(5분 쿨다운 목록)

[1단계: 현재 소리 분류] 조언 전에 반드시 아래 6개 중 하나로 분류해라.
- 밴드/워십/팝록: 전 대역 활성화, 드럼 타격감과 중역대 악기 밀집. 보컬이 반주에 묻히지 않는 레벨 확보, 중저역(200~400Hz) 마스킹 정리, 드럼/보컬 펀치감 위주로 조언.
- 발라드/어쿠스틱: 넓은 다이내믹 레인지(높은 Crest Factor), 절제된 초저역. 자연스러운 다이내믹 유지(과도한 Comp 지적 금지), 보컬/어쿠스틱 악기 명료도와 따뜻한 밸런스 위주로 조언. 초저역이 비어 있어도 정상으로 간주.
- 힙합/EDM/댄스: 강한 Sub-Bass(30~80Hz)와 낮은 Crest Factor(높은 음압). 강한 초저역을 부밍 오류로 오판하지 말 것. 킥-베이스 분리도와 보컬/하이햇 밸런스 위주로 조언.
- 재즈/연주곡: 높은 Crest Factor와 어쿠스틱 다이내믹. 인위적인 컴프레션 조언을 자제하고 악기 간 자연스러운 레벨 밸런스와 공명음 정리만 조언.
- 스피치/설교: 반주 리듬 없이 120Hz~4kHz 음성 대역만 활성화. 악기 조언 대신 목소리의 로우컷(100Hz 이하 팝 노이즈), 중저역 먹먹함, 치찰음(6~8kHz) 및 음성 컴프레션만 조언. 악기이름 자리에는 \`음성\`을 써라.
- 단일 악기 Solo(PFL): 특정 악기 대역만 활성화되고 나머지 대역이 -50dBFS 이하로 비어 있음(엔지니어가 콘솔에서 한 채널만 Solo로 듣는 중). 비어 있는 대역 부스트나 \`Level:\` 조언을 금지하고, 소리 나는 단일 악기(킥, 스네어, 베이스, 보컬, 기타, 건반 등)를 추론해 그 악기 자체의 \`EQ:\`와 \`Comp:\`만 조언해라. 톤과 다이내믹이 충분히 좋다면 억지로 지적하지 말고 \`NONE\`.
deltaDb는 "일반 음악" 타겟 기준이므로 분류된 장르의 특성(힙합의 강한 서브, 발라드의 비어 있는 초저역, Solo 등)으로 설명되는 편차는 문제로 보지 마라. 장르 기준으로도 이상할 때만 지적하며, 그 편차가 ±${th}dB 이내면 지적하지 마라.

[2단계: 조언] 조언은 아래 3가지 카테고리 중 하나로 출력해라. 악기 채널: 보컬, 코러스, 킥, 스네어, 탐, 하이햇, 심벌, 베이스, 일렉기타, 통기타, 건반, 음성
- \`[악기이름] Level:볼륨조정\` (예: \`[보컬] Level:+2dB\`, \`[하이햇] Level:-3dB\`, \`[베이스] Level:-2dB\`)
- \`[악기이름] EQ:주파수조정\` (예: \`[보컬] EQ:250Hz -3dB\`, \`[스네어] EQ:3kHz -2dB\`)
- \`[악기이름] Comp:조정내용\` (예: \`[스네어] Comp:어택 완화\`, \`[보컬] Comp:비율 4:1\`)
Full Mix(Solo가 아닌 상태)에서는 장르 기준에 비추어 특정 악기가 묻히거나 튈 때 \`Level:\` 조언을 최우선으로 제시하고, 주파수 마스킹이나 다이내믹 문제가 있을 때 \`EQ:\`와 \`Comp:\`를 함께 제시해라. 대역→악기 추론 가이드: 60~120Hz 과다 → 킥/베이스, 150~350Hz 지속음 뭉침 → 베이스/건반/통기타/보컬, 200~500Hz 순간 피크·먹먹함 → 스네어/탐, 800Hz~3.5kHz 마스킹·쏘는 소리 → 보컬/일렉기타/건반, 4~10kHz 치찰음·자극적인 고음 → 보컬/심벌/하이햇. 지속음 성격이면 EQ, 순간 피크 성격이면 Comp를 우선 고려해라.

출력 형식(엄수):
1줄: \`GENRE:<카테고리>\` (6개 중 하나. Solo는 \`GENRE:단일 악기 Solo(PFL)|<악기이름>\`)
2줄부터: \`NONE\` 또는 조언 최대 2줄.
- 각 조언 줄은 공백 포함 ${MAX_LINE_CHARS}자 이내의 명확한 단문이다. G2 안경 HUD에 출력된다.
- currentDisplay나 cooldown5min에 있는 항목과 같은 악기·같은 종류·같은 대역의 지적은 절대 출력하지 마라.
- 장르 기준에 비추어 밸런스와 톤이 양호하면 \`GENRE:\` 줄 다음에 \`NONE\`만 출력해라.
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
          generationConfig: { temperature: 0.3, maxOutputTokens: 512 },   // 생각(thinking) 토큰 여유 포함
        });
      return (j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
    }
    case 'openai': {
      const j = await post('https://api.openai.com/v1/chat/completions', { Authorization: `Bearer ${apiKey}` }, {
        model, temperature: 0.3, max_tokens: 160,
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
        model, max_tokens: 160, temperature: 0.3, system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      });
      return (j.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    }
  }
}

export interface Genre { category: string; instrument?: string }
export interface ParsedReply { genre: Genre | null; advice: Candidate[]; none: boolean }

function normalizeCategory(raw: string): string {
  const s = raw.trim();
  if (/solo|솔로|단일/i.test(s)) return '단일 악기 Solo(PFL)';
  for (const g of GENRES) if (s.startsWith(g.split('/')[0])) return g;
  return s;
}

/**
 * 응답 파싱: 첫 줄 `GENRE:카테고리[|악기]`, 이어서 `NONE` 또는 조언 최대 2줄
 * 조언 형식: `[악기] EQ:…` / `[악기] Comp:…` / `[악기] Level:…`
 */
export function parseReply(raw: string): ParsedReply {
  let genre: Genre | null = null;
  const advice: Candidate[] = [];
  let sawNone = false;
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim().replace(/^[`*\-•\d.)\s]+/, '').replace(/`+$/g, '').trim();
    if (!s) continue;
    const g = s.match(/^GENRE\s*[:：]\s*([^|]+?)\s*(?:\|\s*(.+))?$/i);
    if (g) { genre = { category: normalizeCategory(g[1]), instrument: g[2]?.trim() }; continue; }
    if (/^NONE$/i.test(s)) { sawNone = true; continue; }
    const m = s.match(/^\[([^\[\]]{1,10})\]\s*(EQ|Comp|Level)\s*[:：]\s*(.+)$/i);
    if (m && advice.length < 2) {
      const t = m[2].toUpperCase();
      const type = t === 'EQ' ? 'EQ' : t === 'LEVEL' ? 'Level' : 'Comp';
      const text = clampText(`[${m[1].trim()}] ${type}:${m[3].trim()}`);
      advice.push({ tag: text, text });
    }
  }
  return { genre, advice, none: advice.length === 0 && (sawNone || genre !== null) };
}

export function modelsFor(p: ProviderId) { return PROVIDERS[p].models; }
