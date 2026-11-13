import { BANDS } from './config';
import type { BandStat } from './audio';

/** 일반 음악의 장기 평균 스펙트럼: PSD 기울기(dB/oct). 3.0 = 핑크노이즈, 4.5 = 일반 음원/라이브 기준(SPAN 기본값과 동일) */
export const TARGET_SLOPE_DB_PER_OCT = 4.5;
/** 이 주파수 아래는 음악에도 에너지가 줄어드는 영역(HPF·악기 대역폭) → 6dB/oct로 감쇠시켜 Sub 과대 목표 방지 */
export const LF_CORNER_HZ = 80;
/** Crest Factor 정상 범주(dB) */
export const CREST_RANGE = { min: 6, max: 18 } as const;

/** 조언 민감도 슬라이더: 허용 편차(±dB). 작을수록 예민 */
export const TOL_RANGE = { min: 2, max: 10, step: 0.5, default: 8 } as const;

/** 타겟 PSD(f) ∝ f^-β (β = slope/3.0103), LF_CORNER 아래는 f^2로 감쇠. 밴드별 에너지(dB)를 수치적분 후 평균 0으로 정규화 */
function targetBandDb(slope: number): number[] {
  const beta = slope / 3.0103;
  const psd = (f: number) => (f >= LF_CORNER_HZ ? Math.pow(f, -beta) : Math.pow(LF_CORNER_HZ, -beta) * Math.pow(f / LF_CORNER_HZ, 2));
  const raw = BANDS.map(b => {
    const steps = 400, lnLo = Math.log(b.lo), dln = (Math.log(b.hi) - lnLo) / steps;
    let p = 0;
    for (let i = 0; i < steps; i++) { const f = Math.exp(lnLo + (i + 0.5) * dln); p += psd(f) * f * dln; }
    return 10 * Math.log10(p);
  });
  const mean = raw.reduce((a, b) => a + b, 0) / raw.length;
  return raw.map(x => x - mean);
}
export const TARGET_DB = targetBandDb(TARGET_SLOPE_DB_PER_OCT);

const r1 = (x: number) => Math.round(x * 10) / 10;

/** 콘솔 Solo(PFL) 판별 기준 */
export const SOLO = {
  floorDb: -50,            // 이 아래 대역은 "비어 있음(inactive)"
  maxActiveBands: 4,       // 활성 대역이 이 개수 이하이고
  minPeakDb: -40,          // 가장 큰 대역이 이 이상이면 Solo 추정 (작은 풀 믹스 오판 방지)
  peakProminenceDb: 12,    // Solo일 때 이 이상 솟은 협대역 피크가 있으면 AI에 문의
} as const;

export interface SignalInfo {
  localGuess: 'full' | 'solo';
  floorDb: number;
  activeBands: string[];
  inactiveBands: string[];
  energySharePct: Record<string, number>;
  dominantBand: string;
  dominantSharePct: number;
}

export interface BalanceResult {
  mode: 'full' | 'solo';
  signal: SignalInfo;
  deltas: Record<string, number>;  // Full Mix에서만 의미 있음 (+ = 타겟보다 과다). Solo면 빈 객체
  crestOk: boolean;
  pass: boolean;                   // true면 AI 호출 없이 NONE 처리
}

/** 활성 대역/에너지 집중도 집계 + Full Mix vs Solo 판별 */
export function analyzeSignal(bands: Record<string, BandStat>): SignalInfo {
  const names = BANDS.map(b => b.name);
  const active = names.filter(n => bands[n].avgDb >= SOLO.floorDb);
  const maxAvg = Math.max(...names.map(n => bands[n].avgDb));
  const pows = names.map(n => Math.pow(10, bands[n].avgDb / 10));
  const sum = pows.reduce((a, b) => a + b, 0) || 1;
  const share: Record<string, number> = {};
  names.forEach((n, i) => { share[n] = r1((pows[i] / sum) * 100); });
  const dom = names.reduce((a, n) => (share[n] > share[a] ? n : a), names[0]);
  const solo = active.length <= SOLO.maxActiveBands && maxAvg >= SOLO.minPeakDb;
  return {
    localGuess: solo ? 'solo' : 'full',
    floorDb: SOLO.floorDb,
    activeBands: active,
    inactiveBands: names.filter(n => !active.includes(n)),
    energySharePct: share,
    dominantBand: dom,
    dominantSharePct: share[dom],
  };
}

/**
 * 로컬 사전 통과 필터(Tolerance Gate).
 * - Full Mix: 타겟 커브 보정 → 전체 평균 대비 Delta dB 허용 범위 + Crest 범위
 * - Solo(PFL): 풀 믹스 타겟 커브는 적용하지 않음. 활성 대역의 Crest 범위 + 협대역 피크(공명)만 확인
 */
export function evaluateBalance(bands: Record<string, BandStat>, tolDb: number, peaks: { prominenceDb: number }[] = []): BalanceResult {
  const signal = analyzeSignal(bands);
  const crestIn = (n: string) => {
    const s = bands[n];
    return s.avgDb < -80 || (s.crestDb >= CREST_RANGE.min && s.crestDb <= CREST_RANGE.max);
  };

  if (signal.localGuess === 'solo') {
    const crestOk = signal.activeBands.every(crestIn);
    const peaksOk = !peaks.some(p => p.prominenceDb >= SOLO.peakProminenceDb);
    return { mode: 'solo', signal, deltas: {}, crestOk, pass: crestOk && peaksOk };
  }

  const adj = BANDS.map((b, i) => bands[b.name].avgDb - TARGET_DB[i]);
  const mean = adj.reduce((a, b) => a + b, 0) / adj.length;
  const deltas: Record<string, number> = {};
  BANDS.forEach((b, i) => { deltas[b.name] = r1(adj[i] - mean); });
  const deltaOk = BANDS.every(b => Math.abs(deltas[b.name]) <= tolDb);
  const crestOk = BANDS.every(b => crestIn(b.name));
  return { mode: 'full', signal, deltas, crestOk, pass: deltaOk && crestOk };
}
