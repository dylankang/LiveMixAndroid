export type ProviderId = 'gemini' | 'openai' | 'claude';

// 모델 목록은 여기서만 수정하면 UI에 반영됩니다. (UI에는 "직접 입력"도 추가됨)
export const PROVIDERS: Record<ProviderId, { label: string; models: string[] }> = {
  gemini: { label: 'Google Gemini', models: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'] },
  openai: { label: 'OpenAI', models: ['gpt-4o-mini', 'gpt-4o'] },
  claude: { label: 'Anthropic Claude', models: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'] },
};

export const BANDS = [
  { name: 'Sub', lo: 20, hi: 60 },
  { name: 'Low', lo: 60, hi: 250 },
  { name: 'Low-Mid', lo: 250, hi: 500 },
  { name: 'Mid', lo: 500, hi: 2000 },
  { name: 'High-Mid', lo: 2000, hi: 6000 },
  { name: 'High', lo: 6000, hi: 16000 },
] as const;

/** AI 조언 주기 슬라이더 (초) */
export const INTERVAL_RANGE = { min: 5, max: 60, step: 5, default: 20 } as const;

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

export const MAX_LINE_CHARS = 20;   // 프롬프트에 전달되는 글자 수 규칙
export const HARD_CAP_CHARS = 22;   // 모델이 규칙을 어길 때 HUD 폭 보호용 절단선
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
