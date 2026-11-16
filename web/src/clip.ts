// 🎧 최근 3초 오디오 클립: AI 가 실제 소리를 듣고 판단하도록 Gemini 에 WAV 로 첨부한다.
//  · ClipRing     : 원음(L+R 모노 합산)을 항상 최근 3초만 유지하는 링 버퍼
//  · encodeWav16k : 16kHz · 모노 · 16-bit PCM WAV (약 96KB) + Base64 — 리샘플은 브라우저 내장(OfflineAudioContext, 안티에일리어싱 포함)
//  · analyzeClip  : WAV 와 정확히 같은 3초 구간의 단기 지표 (6밴드 평균·피크, 크레스트, 스펙트럼 중심, 음성대역 비율, 어택 수)
import { BANDS } from './config';

export const CLIP_SEC = 3;
export const WAV_RATE = 16000;

export class ClipRing {
  private buf = new Float32Array(0);
  private pos = 0;
  private filled = 0;
  sr = 0;

  /** 모노 샘플 추가 (샘플레이트가 바뀌면 비우고 새로 시작) */
  push(x: Float32Array, sr: number) {
    if (sr !== this.sr) { this.sr = sr; this.buf = new Float32Array(Math.round(sr * CLIP_SEC)); this.pos = 0; this.filled = 0; }
    const n = this.buf.length;
    for (let i = 0; i < x.length; i++) { this.buf[this.pos] = x[i]; this.pos = (this.pos + 1) % n; }
    this.filled = Math.min(n, this.filled + x.length);
  }
  clear() { this.pos = 0; this.filled = 0; }

  /** 시간 순서대로 정렬한 최근 샘플 (minSec 미만이면 null) */
  snapshot(minSec = 1): { data: Float32Array; sr: number } | null {
    if (!this.sr || this.filled < this.sr * minSec) return null;
    const n = this.buf.length, out = new Float32Array(this.filled);
    const start = (this.pos - this.filled + n) % n;
    for (let i = 0; i < this.filled; i++) out[i] = this.buf[(start + i) % n];
    return { data: out, sr: this.sr };
  }
}

const dB = (p: number) => (p > 1e-12 ? Math.round(10 * Math.log10(p) * 10) / 10 : -120);

/** 16kHz 모노 16-bit WAV. 콘솔 입력이 작아도 AI 가 잘 들을 수 있게 피크 -3dBFS 로 정규화 (최대 +30dB) */
export async function encodeWav16k(data: Float32Array, sr: number): Promise<{ base64: string; bytes: number; seconds: number; gainDb: number }> {
  let pcm: Float32Array;
  if (sr === WAV_RATE) pcm = data;
  else {
    const len = Math.max(1, Math.ceil(data.length * WAV_RATE / sr));
    const off = new OfflineAudioContext(1, len, WAV_RATE);
    const b = off.createBuffer(1, data.length, sr);
    b.getChannelData(0).set(data);
    const s = off.createBufferSource();
    s.buffer = b; s.connect(off.destination); s.start();
    pcm = (await off.startRendering()).getChannelData(0);
  }
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; }
  const gain = peak > 1e-6 ? Math.min(Math.pow(10, 30 / 20), Math.pow(10, -3 / 20) / peak) : 1;
  const n = pcm.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o: number, t: string) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, WAV_RATE, true); v.setUint32(28, WAV_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(pcm[i] * gain * 32767))), true);
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { base64: btoa(bin), bytes: bytes.length, seconds: Math.round(n / WAV_RATE * 10) / 10, gainDb: Math.round(20 * Math.log10(gain) * 10) / 10 };
}

// ───────── 단기(3초) 지표 ─────────
const N = 2048, HOP = 1024;
const hann = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
const W2 = hann.reduce((a, w) => a + w * w, 0);
const rev = (() => { const r = new Uint32Array(N), bits = Math.log2(N); for (let i = 0; i < N; i++) { let x = i, y = 0; for (let b = 0; b < bits; b++) { y = (y << 1) | (x & 1); x >>= 1; } r[i] = y; } return r; })();
function fftPower(frame: Float32Array, off: number, out: Float64Array) {
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[rev[i]] = frame[off + i] * hann[i];
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, step = -2 * Math.PI / size;
    for (let k = 0; k < half; k++) {
      const wr = Math.cos(step * k), wi = Math.sin(step * k);
      for (let s = k; s < N; s += size) {
        const t = s + half, xr = wr * re[t] - wi * im[t], xi = wr * im[t] + wi * re[t];
        re[t] = re[s] - xr; im[t] = im[s] - xi; re[s] += xr; im[s] += xi;
      }
    }
  }
  // 대역 신호의 평균 제곱(파워)이 되도록 정규화 (단측 스펙트럼 ×2)
  for (let k = 0; k < N / 2; k++) out[k] = 2 * (re[k] * re[k] + im[k] * im[k]) / (N * W2);
}

export interface ClipStats {
  seconds: number;
  rmsDb: number; peakDb: number; crestDb: number;
  /** 6밴드: 3초 평균 레벨 · 가장 센 순간(프레임) 레벨 · 전체 대비 상대 레벨 (dB) */
  bands: Record<string, { avgDb: number; peakDb: number; relDb: number }>;
  spectralCentroidHz: number;
  voiceBandSharePct: number;
  /** 초당 어택 수 (스펙트럼 플럭스 기준) */
  onsetsPerSec: number;
}

/** WAV 와 같은 3초 구간의 단기 지표 */
export function analyzeClip(data: Float32Array, sr: number): ClipStats {
  let sq = 0, pk = 0;
  for (let i = 0; i < data.length; i++) { const a = data[i]; sq += a * a; const b = a < 0 ? -a : a; if (b > pk) pk = b; }
  const rms = Math.sqrt(sq / Math.max(1, data.length));
  const binHz = sr / N, frames = Math.max(0, Math.floor((data.length - N) / HOP) + 1);
  const pw = new Float64Array(N / 2);
  const bandSum = BANDS.map(() => 0), bandMax = BANDS.map(() => 0);
  let total = 0, cNum = 0, voice = 0, all = 0, prevLog = -1, onsets = 0;
  const flux: number[] = [];
  for (let f = 0; f < frames; f++) {
    fftPower(data, f * HOP, pw);
    let fr = 0;
    BANDS.forEach((b, i) => {
      let s = 0;
      const k0 = Math.max(1, Math.floor(b.lo / binHz)), k1 = Math.min(N / 2 - 1, Math.ceil(b.hi / binHz));
      for (let k = k0; k < k1; k++) s += pw[k];
      bandSum[i] += s; if (s > bandMax[i]) bandMax[i] = s;
      fr += s;
    });
    total += fr;
    for (let k = 1; k < N / 2; k++) {
      const hz = k * binHz;
      if (hz < 20 || hz > 16000) continue;
      cNum += hz * pw[k]; all += pw[k];
      if (hz >= 120 && hz <= 4000) voice += pw[k];
    }
    const lg = 10 * Math.log10(fr + 1e-12);
    if (prevLog > -1e9 && f > 0) flux.push(Math.max(0, lg - prevLog));
    prevLog = lg;
  }
  // 어택: 플럭스가 평균+표준편차보다 크고 3dB 이상인 국소 최대
  if (flux.length > 2) {
    const m = flux.reduce((a, b) => a + b, 0) / flux.length;
    const sd = Math.sqrt(flux.reduce((a, b) => a + (b - m) * (b - m), 0) / flux.length);
    for (let i = 1; i < flux.length - 1; i++) if (flux[i] > Math.max(3, m + sd) && flux[i] >= flux[i - 1] && flux[i] >= flux[i + 1]) onsets++;
  }
  const totalAvg = total / Math.max(1, frames);
  const bands: ClipStats['bands'] = {};
  BANDS.forEach((b, i) => {
    const avg = bandSum[i] / Math.max(1, frames);
    bands[b.name] = { avgDb: dB(avg), peakDb: dB(bandMax[i]), relDb: Math.round((dB(avg) - dB(totalAvg)) * 10) / 10 };
  });
  const sec = data.length / sr;
  return {
    seconds: Math.round(sec * 10) / 10,
    rmsDb: dB(rms * rms), peakDb: dB(pk * pk), crestDb: Math.round((dB(pk * pk) - dB(rms * rms)) * 10) / 10,
    bands,
    spectralCentroidHz: all > 0 ? Math.round(cNum / all) : 0,
    voiceBandSharePct: all > 0 ? Math.round(voice / all * 1000) / 10 : 0,
    onsetsPerSec: Math.round(onsets / Math.max(0.1, sec) * 10) / 10,
  };
}
