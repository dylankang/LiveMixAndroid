// 🧮 PCM 직결 경량 DSP — AnalyserNode 없이 원본 샘플(MediaStreamTrackProcessor / AudioWorklet)로 직접 측정한다.
// 화면이 꺼지면 크롬이 메인 스레드 AnalyserNode 계산을 건너뛸 수 있어, 같은 지표를 순수 JS 로도 만들 수 있게 한다.
//  · L/R RMS·Peak (100ms 창)
//  · 6밴드 에너지: AnalyserNode 경로와 같은 4차 밴드패스(HPF 2단 + LPF 2단, Web Audio 와 같은 RBJ 계수) — (L+R)/2 모노
//  · FFT 스펙트럼: FB.fftSize 점 Radix-2 FFT + Blackman 창, |X|/N → dB (AnalyserNode.getFloatFrequencyData 와 같은 척도)
//    → 스펙트럼 중심·음성대역 비율·서브 비율·협대역 피크·피드백 판정에 그대로 쓰인다.
import { BANDS, FB } from './config';

/** Web Audio 의 lowpass/highpass Q 는 dB 단위 → 기존 그래프(Q=√½)와 같은 응답이 되도록 선형값으로 환산 */
const Q_LIN = Math.pow(10, Math.SQRT1_2 / 20);

class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  private z1 = 0; private z2 = 0;
  constructor(type: 'lowpass' | 'highpass', f: number, sr: number) {
    const w0 = 2 * Math.PI * Math.min(f, sr / 2 - 100) / sr, c = Math.cos(w0), al = Math.sin(w0) / (2 * Q_LIN), a0 = 1 + al;
    if (type === 'lowpass') { this.b0 = (1 - c) / 2 / a0; this.b1 = (1 - c) / a0; this.b2 = (1 - c) / 2 / a0; }
    else { this.b0 = (1 + c) / 2 / a0; this.b1 = -(1 + c) / a0; this.b2 = (1 + c) / 2 / a0; }
    this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
  }
  /** Transposed Direct Form II */
  step(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** 100ms 창 하나의 측정값 (dB 가 아니라 제곱합 — 기존 누적기에 그대로 더할 수 있게) */
export interface PcmWindow {
  n: number;                                  // 샘플 수 (채널당)
  sq: [number, number]; pk: [number, number]; // L/R 제곱합 · 절대 피크
  band: { sq: number; pk: number }[];         // 6밴드 (모노) 제곱합 · 피크
  rawDb: number;                              // L/R 평균 파워 RMS (dBFS)
}

const N = FB.fftSize;

export class PcmDsp {
  private sr = 0;
  private filt: Biquad[][] = [];
  private win = this.empty();
  private ring = new Float32Array(N);
  private pos = 0;
  /** 마지막으로 샘플을 받은 시각 (performance.now) */
  lastFeedAt = 0;
  /** 받은 경로: MediaStreamTrackProcessor 또는 AudioWorklet */
  via: 'mstp' | 'worklet' | '' = '';
  // FFT 작업 버퍼
  private re = new Float64Array(N);
  private im = new Float64Array(N);
  private wnd = Float64Array.from({ length: N }, (_, i) => 0.42 - 0.5 * Math.cos(2 * Math.PI * i / N) + 0.08 * Math.cos(4 * Math.PI * i / N));
  private rev = (() => { const r = new Uint32Array(N), bits = Math.log2(N); for (let i = 0; i < N; i++) { let x = i, y = 0; for (let b = 0; b < bits; b++) { y = (y << 1) | (x & 1); x >>= 1; } r[i] = y; } return r; })();
  private spec = new Float32Array(N / 2);

  private empty(): PcmWindow {
    return { n: 0, sq: [0, 0], pk: [0, 0], band: BANDS.map(() => ({ sq: 0, pk: 0 })), rawDb: -120 };
  }
  private setup(sr: number) {
    this.sr = sr;
    this.filt = BANDS.map(b => [new Biquad('highpass', b.lo, sr), new Biquad('highpass', b.lo, sr), new Biquad('lowpass', b.hi, sr), new Biquad('lowpass', b.hi, sr)]);
  }

  /** 원본 PCM 공급 (L/R 각 n 샘플) */
  feed(L: Float32Array, R: Float32Array, n: number, sr: number, via: 'mstp' | 'worklet') {
    if (sr !== this.sr) this.setup(sr);
    const w = this.win, f = this.filt, nb = f.length;
    let sqL = 0, sqR = 0, pkL = w.pk[0], pkR = w.pk[1];
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      sqL += l * l; sqR += r * r;
      const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
      if (al > pkL) pkL = al;
      if (ar > pkR) pkR = ar;
      const m = (l + r) * 0.5;
      this.ring[this.pos] = m; this.pos = (this.pos + 1) % N;
      for (let b = 0; b < nb; b++) {
        const s = f[b];
        const y = s[3].step(s[2].step(s[1].step(s[0].step(m))));
        const bb = w.band[b];
        bb.sq += y * y;
        const ay = y < 0 ? -y : y;
        if (ay > bb.pk) bb.pk = ay;
      }
    }
    w.sq[0] += sqL; w.sq[1] += sqR; w.pk[0] = pkL; w.pk[1] = pkR; w.n += n;
    this.lastFeedAt = performance.now();
    this.via = via;
  }

  /** 지난 틱 이후의 창을 꺼내고 초기화 (샘플이 없었으면 null) */
  take(): PcmWindow | null {
    const w = this.win;
    this.win = this.empty();
    if (!w.n) return null;
    const p = (w.sq[0] + w.sq[1]) / (2 * w.n);
    w.rawDb = p > 1e-14 ? 10 * Math.log10(p) : -120;
    return w;
  }

  /** 최근 N 샘플(모노)의 스펙트럼 (dB, AnalyserNode 와 같은 척도). 길이 N/2 */
  spectrumDb(): Float32Array {
    const re = this.re, im = this.im, rev = this.rev;
    for (let i = 0; i < N; i++) { const j = rev[i]; re[j] = this.ring[(this.pos + i) % N] * this.wnd[i]; im[j] = 0; }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = -2 * Math.PI / size;
      for (let k = 0; k < half; k++) {
        const wr = Math.cos(step * k), wi = Math.sin(step * k);
        for (let s = k; s < N; s += size) {
          const t = s + half;
          const xr = wr * re[t] - wi * im[t], xi = wr * im[t] + wi * re[t];
          re[t] = re[s] - xr; im[t] = im[s] - xi;
          re[s] += xr; im[s] += xi;
        }
      }
    }
    for (let k = 0; k < N / 2; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / N;
      this.spec[k] = mag > 1e-10 ? 20 * Math.log10(mag) : -200;
    }
    return this.spec;
  }
}

/** AudioData 한 프레임에서 L/R Float32 샘플을 꺼낸다 (f32 / s16, planar / interleaved 모두 처리) */
export function readAudioData(ad: any, L: Float32Array, R: Float32Array): number {
  const n: number = ad.numberOfFrames, ch: number = ad.numberOfChannels;
  try {
    ad.copyTo(L.subarray(0, n), { planeIndex: 0, format: 'f32-planar' });
    if (ch > 1) ad.copyTo(R.subarray(0, n), { planeIndex: 1, format: 'f32-planar' });
    else R.set(L.subarray(0, n));
    return n;
  } catch { /* 형식 변환 미지원 → 원래 형식 그대로 읽어 직접 변환 */ }
  const fmt: string = ad.format || '';
  const planar = fmt.endsWith('-planar');
  const isF32 = fmt.startsWith('f32');
  const get = (plane: number, len: number) => {
    const buf = isF32 ? new Float32Array(len) : new Int16Array(len);
    ad.copyTo(buf, { planeIndex: plane });
    return buf;
  };
  const scale = isF32 ? 1 : 1 / 32768;
  if (planar) {
    const a = get(0, n), b = ch > 1 ? get(1, n) : a;
    for (let i = 0; i < n; i++) { L[i] = a[i] * scale; R[i] = b[i] * scale; }
  } else {
    const a = get(0, n * ch);
    for (let i = 0; i < n; i++) { L[i] = a[i * ch] * scale; R[i] = a[i * ch + (ch > 1 ? 1 : 0)] * scale; }
  }
  return n;
}
