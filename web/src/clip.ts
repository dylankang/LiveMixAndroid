// 🎧 최근 N초(설정 5~10초) 오디오 클립: AI 가 실제 소리를 듣고 판단하도록 Gemini 에 WAV 로 첨부한다.
//  · ClipRing       : 원음 L/R 을 합치지 않고 각각 최근 10초(최대)를 유지하는 스테레오 링 버퍼
//                     오디오 스레드 콜백(AudioWorklet process / ScriptProcessor onaudioprocess)이 받은 모든 프레임을
//                     순번(seq)과 함께 이어 붙이고, 누락·겹침이 생기면 그 앞 구간을 버려 항상 끊김 없는 파형만 보낸다
//                     (L+R 합산은 고역이 잘리고 스테레오 악기가 위상 상쇄로 사라져 AI 가 악기를 잘못 알아듣는 원인)
//  · encodeWavStereo: 44.1kHz · 2채널 · 16-bit PCM WAV (5초 약 882KB · 10초 약 1.76MB, 인터리브 L,R,L,R…) + Base64 — 리샘플은 브라우저 내장(OfflineAudioContext)
//                     인코딩 직전 피크 정규화: 가장 큰 샘플이 0.89(-1dBFS)가 되게 전체 파형을 증폭 (게이트·DSP 수치는 원본 기준)
//  · analyzeClip    : WAV 와 정확히 같은 3초 구간의 단기 지표 (6밴드 평균·피크, 크레스트, 스펙트럼 중심, 음성대역 비율, 어택 수, 스테레오)
import { BANDS } from './config';

export const CLIP_SEC = 10;                                   // 링 버퍼 용량 (최대 전송 길이)
export const CLIP_LEN = { min: 5, max: 10, step: 1, default: 5 } as const;   // API 로 보내는 WAV 길이 (설정)
export const PEAK_TARGET = 0.89;   // -1dBFS
export const WAV_RATE = 44100;

export interface StereoClip { l: Float32Array; r: Float32Array; sr: number }

export class ClipRing {
  private bl = new Float32Array(0);
  private br = new Float32Array(0);
  private pos = 0;
  private filled = 0;
  private next = -1;          // 다음에 와야 할 샘플 순번
  sr = 0;
  /** 연속성 검사 결과 (누락·겹침 발생 횟수, 받은 총 샘플) */
  gaps = 0; overlaps = 0; received = 0;

  /** L/R 샘플 추가 (seq = 첫 샘플의 누적 순번. 샘플레이트가 바뀌면 비우고 새로 시작) */
  push(l: Float32Array, r: Float32Array, sr: number, seq?: number) {
    if (sr !== this.sr) {
      this.sr = sr; const n = Math.round(sr * CLIP_SEC);
      this.bl = new Float32Array(n); this.br = new Float32Array(n); this.pos = 0; this.filled = 0; this.next = -1;
    }
    if (seq !== undefined) {
      if (this.next >= 0 && seq !== this.next) {          // 끊김: 이어 붙이면 파형이 단절되므로 앞 구간을 버리고 새로 시작
        if (seq > this.next) this.gaps++; else this.overlaps++;
        this.filled = 0;
      }
      this.next = seq + Math.min(l.length, r.length);
    }
    this.received += Math.min(l.length, r.length);
    const n = this.bl.length, m = Math.min(l.length, r.length);
    for (let i = 0; i < m; i++) { this.bl[this.pos] = l[i]; this.br[this.pos] = r[i]; this.pos = (this.pos + 1) % n; }
    this.filled = Math.min(n, this.filled + m);
  }
  clear() { this.pos = 0; this.filled = 0; this.next = -1; this.gaps = 0; this.overlaps = 0; this.received = 0; }

  /** 시간 순서대로 정렬한 최근 L/R 최대 maxSec 초 (minSec 미만이면 null) */
  snapshot(minSec = 1, maxSec = CLIP_SEC): StereoClip | null {
    if (!this.sr || this.filled < this.sr * minSec) return null;
    const len = Math.min(this.filled, Math.round(this.sr * maxSec));
    const n = this.bl.length, l = new Float32Array(len), r = new Float32Array(len);
    const start = (this.pos - len + n) % n;
    for (let i = 0; i < len; i++) { const k = (start + i) % n; l[i] = this.bl[k]; r[i] = this.br[k]; }
    return { l, r, sr: this.sr };
  }
}

/** 클립 전체의 평균 RMS (L/R 평균 파워, dBFS) — API 호출 직전 무음 검사용 */
export function clipRmsDb(c: StereoClip): number {
  let s = 0;
  for (let i = 0; i < c.l.length; i++) s += c.l[i] * c.l[i] + c.r[i] * c.r[i];
  const p = s / Math.max(1, 2 * c.l.length);
  return p > 1e-12 ? Math.round(10 * Math.log10(p) * 10) / 10 : -120;
}

const dB = (p: number) => (p > 1e-12 ? Math.round(10 * Math.log10(p) * 10) / 10 : -120);

/** 44.1kHz 스테레오 16-bit WAV (인터리브 L,R). 콘솔 입력이 -20~-30dBFS 로 작아도 AI 가 배음을 읽을 수 있게
 *  L/R 공통 게인으로 가장 큰 피크를 0.89(-1dBFS)에 맞춘다 (좌우 밸런스 유지 · 원본 데이터는 그대로) */
export async function encodeWavStereo(c: StereoClip): Promise<{ base64: string; bytes: number; seconds: number; gainDb: number }> {
  let L = c.l, R = c.r;
  if (c.sr !== WAV_RATE) {
    const len = Math.max(1, Math.ceil(c.l.length * WAV_RATE / c.sr));
    const off = new OfflineAudioContext(2, len, WAV_RATE);
    const b = off.createBuffer(2, c.l.length, c.sr);
    b.getChannelData(0).set(c.l); b.getChannelData(1).set(c.r);
    const s = off.createBufferSource();
    s.buffer = b; s.connect(off.destination); s.start();
    const out = await off.startRendering();
    L = out.getChannelData(0); R = out.getChannelData(1);
  }
  let peak = 0;
  for (let i = 0; i < L.length; i++) { const a = Math.abs(L[i]), b = Math.abs(R[i]); if (a > peak) peak = a; if (b > peak) peak = b; }
  const gain = peak > 1e-6 ? PEAK_TARGET / peak : 1;
  const n = L.length, ch = 2, buf = new ArrayBuffer(44 + n * ch * 2), v = new DataView(buf);
  const str = (o: number, t: string) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, WAV_RATE, true); v.setUint32(28, WAV_RATE * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * ch * 2, true);
  const q = (x: number) => Math.max(-32767, Math.min(32767, Math.round(x * gain * 32767)));
  for (let i = 0, o = 44; i < n; i++, o += 4) { v.setInt16(o, q(L[i]), true); v.setInt16(o + 2, q(R[i]), true); }
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
  /** 스테레오: L/R 상관(1 = 모노, 0 = 무관, 음수 = 역위상) · 사이드/미드 비율 · 좌우 밸런스(+ = L 이 큼) */
  stereo: { correlation: number; sideToMidDb: number; balanceDb: number };
}

/** WAV 와 같은 3초 구간의 단기 지표 (스펙트럼은 (L+R)/2, 스테레오 지표는 L/R 그대로) */
export function analyzeClip(c: StereoClip): ClipStats {
  const sr = c.sr, n0 = c.l.length, data = new Float32Array(n0);
  let ll = 0, rr = 0, lr = 0, side = 0, mid = 0;
  for (let i = 0; i < n0; i++) {
    const l = c.l[i], r = c.r[i];
    data[i] = (l + r) * 0.5;
    ll += l * l; rr += r * r; lr += l * r;
    const sd = l - r, md = l + r; side += sd * sd; mid += md * md;
  }
  const stereo = {
    correlation: ll > 0 && rr > 0 ? Math.round(lr / Math.sqrt(ll * rr) * 100) / 100 : 1,
    sideToMidDb: mid > 0 ? Math.round(10 * Math.log10((side + 1e-12) / mid) * 10) / 10 : -120,
    balanceDb: ll > 0 && rr > 0 ? Math.round(10 * Math.log10(ll / rr) * 10) / 10 : 0,
  };
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
    stereo,
  };
}
