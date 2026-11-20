export type ProviderId = 'gemini' | 'openai' | 'claude';

// 모델 목록은 여기서만 수정하면 UI에 반영됩니다. (UI에는 "직접 입력"도 추가됨)
/** Google AI Studio 텍스트 출력(generateContent) Gemini 모델 — 설정 드롭다운의 <optgroup> 묶음 (API Key 가 있으면 models.list 로 실시간 병합) */
export const GEMINI_GROUPS: { label: string; models: string[] }[] = [
  { label: 'Gemini 3.5 / 3.1 / 3.0', models: [
    'gemini-3.5-pro', 'gemini-3.5-flash', 'gemini-3.5-flash-lite',
    'gemini-3.1-pro', 'gemini-3.1-pro-preview', 'gemini-3.1-flash', 'gemini-3.1-flash-lite', 'gemini-3.1-flash-lite-preview',
    'gemini-3.0-pro', 'gemini-3.0-flash', 'gemini-3.0-flash-lite'] },
  { label: 'Gemini 2.5', models: ['gemini-2.5-pro', 'gemini-2.5-pro-preview', 'gemini-2.5-flash', 'gemini-2.5-flash-preview', 'gemini-2.5-flash-lite', 'gemini-2.5-flash-lite-preview'] },
  { label: 'Gemini 2.0 · 기타 텍스트 출력', models: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-2.0-pro-exp', 'gemini-exp-1206', 'learnlm-2.0-flash-experimental'] },
];

/** OpenAI(ChatGPT) 텍스트 출력 모델 — OpenAI 모델 문서 기준 (API Key 가 있으면 /v1/models 로 실시간 병합) */
export const OPENAI_GROUPS: { label: string; models: string[] }[] = [
  { label: 'ChatGPT · GPT-6', models: ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna'] },
  { label: 'ChatGPT · GPT-5', models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-mini'] },
  { label: 'ChatGPT · 이전 (종료 예정)', models: ['gpt-5.1', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'] },
];
/** Anthropic Claude 텍스트 출력 모델 — Claude 모델 문서(Models overview) 기준 (API Key 가 있으면 /v1/models 로 실시간 병합) */
export const CLAUDE_GROUPS: { label: string; models: string[] }[] = [
  { label: 'Claude · 최신', models: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2'] },
  { label: 'Claude · 이전', models: ['claude-fable-5-1', 'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'] },
];
/** 공급자별 드롭다운 묶음 */
export const PROVIDER_GROUPS: Record<ProviderId, { label: string; models: string[] }[]> = {
  gemini: GEMINI_GROUPS, openai: OPENAI_GROUPS, claude: CLAUDE_GROUPS,
};

export const PROVIDERS: Record<ProviderId, { label: string; short: string; keyHint: string; models: string[] }> = {
  gemini: { label: 'Google Gemini', short: 'Gemini', keyHint: 'aistudio.google.com 에서 발급', models: GEMINI_GROUPS.flatMap(g => g.models) },
  openai: { label: 'OpenAI ChatGPT', short: 'ChatGPT', keyHint: 'platform.openai.com 에서 발급 (sk-…)', models: OPENAI_GROUPS.flatMap(g => g.models) },
  claude: { label: 'Anthropic Claude', short: 'Claude', keyHint: 'platform.claude.com 에서 발급 (sk-ant-…)', models: CLAUDE_GROUPS.flatMap(g => g.models) },
};
export const PROVIDER_IDS: ProviderId[] = ['gemini', 'openai', 'claude'];

export const BANDS = [
  { name: 'Sub', lo: 20, hi: 60 },
  { name: 'Low', lo: 60, hi: 250 },
  { name: 'Low-Mid', lo: 250, hi: 500 },
  { name: 'Mid', lo: 500, hi: 2000 },
  { name: 'High-Mid', lo: 2000, hi: 6000 },
  { name: 'High', lo: 6000, hi: 16000 },
] as const;

/** AI 조언 주기 슬라이더 (초) */
export const INTERVAL_RANGE = { min: 10, max: 60, step: 5, default: 20 } as const;   // 최소 10초

export const TIMING = {
  fbScanMs: 100,          // 피드백 FFT 스캔 주기
  analyzeMs: 20_000,      // (기본값 참고용 · 실제 주기는 슬라이더 INTERVAL_RANGE)
  tickMs: 1000,           // 자동 소멸 확인 주기
  expireMs: 30_000,       // 조언 자동 소멸 시간
  removeGapMs: 1500,      // 소멸 시 한 줄씩 사라지는 최소 간격
  cooldownMs: 5 * 60_000, // 무시 목록 유지 시간
  repeatWindowMs: 120_000, // "연속" 판정 허용 간격
  fbHoldMs: 2000,         // 피드백 경고 유지 시간
} as const;

export const FB = {
  fftSize: 4096,
  minHz: 300,           // 감지 하한 (베이스/킥 기본음 오탐 방지)
  prominenceDb: 20,     // 주변 대비 돌출 기준
  nbMinBins: 10,        // 주변 평균을 구하는 bin 거리 (양옆 10~15 bin)
  nbMaxBins: 15,
  minLevelDb: -35,      // 이보다 작은 피크는 무시 (dBFS)
  confirmScans: 15,     // 0.1초 주기 × 15회 = 1.5초 연속 유지
  binTolerance: 1,      // 같은 주파수로 인정하는 bin 오차
  levelDropDb: 2,       // 최대 레벨 대비 이만큼 떨어지면 "레벨 하락"으로 보고 리셋
} as const;

/** HUD 한 줄 폭: 한글·기호(↑ 등) = 2칸, 영문·숫자·공백·괄호 = 1칸으로 세어 최대 56칸 (한글만이면 약 28자) */
export const LINE_WIDTH_UNITS = 56;
export const MAX_LINE_CHARS = 28;   // 프롬프트에 전달되는 글자 수 규칙 (한글 기준 · G2 HUD 한 줄)
export const QUEUE_SIZE = 4;

/** 피드백 민감도 슬라이더 t(0=둔감 … 1=예민) → 판정 파라미터. t=0.5가 기본(돌출 20dB / 1.5초 / -35dBFS) */
export function fbParamsFor(t: number) {
  const x = Math.min(1, Math.max(0, t));
  return {
    prominenceDb: 26 - 12 * x,              // 26 ~ 14 dB
    minLevelDb: -30 - 10 * x,               // -30 ~ -40 dBFS
    confirmScans: Math.round(22 - 14 * x),  // 22 ~ 8회 (0.1초 단위: 2.2 ~ 0.8초)
  };
}
