// 📱 안드로이드 앱(WebView) 전용 네이티브 연동
//  · 휴대폰 미디어 출력 캡처: 앱(AudioPlaybackCapture)이 다른 앱에서 재생 중인 소리를 볼륨 전단(단위 이득)에서 받아
//    16-bit PCM(인터리브 L,R)을 Base64 로 window.__lmPcm(b64) 에 계속 넣어 준다 → 여기서 AudioWorklet 소스로 바꿔
//    기존 분석 엔진(마이크 입력과 똑같은 경로)에 연결한다.
//  · 일반 브라우저(PC·크롬)에서는 LiveMixNative 가 없으므로 아무 것도 하지 않는다.

/* eslint-disable @typescript-eslint/no-explicit-any */
export const nat = (): any => (window as any).LiveMixNative;
export const isApp = () => !!nat();
export const NATIVE_MEDIA_ID = 'native-media';
export const NATIVE_MEDIA_LABEL = '📱 휴대폰 미디어 출력 (재생 중인 소리 · 볼륨 무관)';
export const nativeMediaSupported = () => { try { return !!nat()?.mediaCaptureSupported?.(); } catch { return false; } };

export interface NativeEvent { type: string; state?: string; rate?: number; channels?: number; msg?: string }
const listeners = new Set<(e: NativeEvent) => void>();
(window as any).__lmNativeEvent = (j: string) => {
  let e: NativeEvent;
  try { e = typeof j === 'string' ? JSON.parse(j) : j; } catch { return; }
  listeners.forEach(f => { try { f(e); } catch (err) { console.warn(err); } });
};
export function onNativeEvent(f: (e: NativeEvent) => void) { listeners.add(f); return () => listeners.delete(f); }

/** 미디어 출력 캡처 시작 (화면 녹화 동의 창 → 승인되면 rate/channels 반환) */
export function startNativeMedia(): Promise<{ rate: number; channels: number }> {
  return new Promise((resolve, reject) => {
    const n = nat();
    if (!n?.startMediaCapture) { reject(new Error('이 기기에서는 미디어 출력 캡처를 쓸 수 없습니다 (안드로이드 10 이상 앱 전용)')); return; }
    const timer = setTimeout(() => { off(); reject(new Error('미디어 캡처 동의가 2분 안에 완료되지 않았습니다')); }, 120_000);
    const off = onNativeEvent(e => {
      if (e.type !== 'media') return;
      if (e.state === 'started') { clearTimeout(timer); off(); resolve({ rate: e.rate || 48000, channels: e.channels || 2 }); }
      else if (e.state === 'denied' || e.state === 'error') {
        clearTimeout(timer); off();
        reject(Object.assign(new Error(e.state === 'denied' ? '미디어 캡처(화면 녹화) 동의가 거부되었습니다' : `미디어 캡처 실패: ${e.msg ?? ''}`), { name: e.state === 'denied' ? 'NotAllowedError' : 'Error' }));
      }
    });
    try { n.startMediaCapture(); } catch (e) { clearTimeout(timer); off(); reject(e); }
  });
}
export function stopNativeMedia() { try { nat()?.stopMediaCapture?.(); } catch { /* ignore */ } }

// 네이티브 PCM → 오디오 그래프: 큐에 쌓아 두고 연속으로 출력 (0.25초 선버퍼 · 1.5초 넘게 밀리면 오래된 것부터 버림)
const PCM_SRC = `
class LmPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = []; this.off = 0; this.n = 0; this.started = false;
    this.pre = Math.round(sampleRate * 0.25); this.max = Math.round(sampleRate * 1.5);
    this.port.onmessage = e => {
      const d = e.data;
      if (!d || !d.l) return;
      this.q.push(d); this.n += d.l.length;
      while (this.n > this.max && this.q.length > 1) { const x = this.q.shift(); this.n -= x.l.length - this.off; this.off = 0; }
    };
  }
  process(inputs, outputs) {
    const o = outputs[0], L = o[0], R = o[1] || o[0];
    if (!this.started) {
      if (this.n < this.pre) { L.fill(0); R.fill(0); return true; }
      this.started = true;
    }
    let i = 0;
    while (i < L.length && this.q.length) {
      const h = this.q[0], k = Math.min(L.length - i, h.l.length - this.off);
      L.set(h.l.subarray(this.off, this.off + k), i); R.set(h.r.subarray(this.off, this.off + k), i);
      i += k; this.off += k; this.n -= k;
      if (this.off >= h.l.length) { this.q.shift(); this.off = 0; }
    }
    if (i < L.length) { L.fill(0, i); R.fill(0, i); this.started = false; }   // 모자라면 다시 선버퍼
    return true;
  }
}
registerProcessor('lm-pcm', LmPcm);`;

/** 네이티브 PCM 을 받는 소스 노드 (출력 2채널) */
export async function createNativePcmNode(ctx: AudioContext): Promise<AudioWorkletNode> {
  const url = URL.createObjectURL(new Blob([PCM_SRC], { type: 'text/javascript' }));
  try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
  const node = new AudioWorkletNode(ctx, 'lm-pcm', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  (window as any).__lmPcm = (b64: string) => {
    try {
      const bin = atob(b64), n = bin.length >> 2;
      const l = new Float32Array(n), r = new Float32Array(n);
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        let a = bin.charCodeAt(p) | (bin.charCodeAt(p + 1) << 8); if (a & 0x8000) a -= 0x10000;
        let b = bin.charCodeAt(p + 2) | (bin.charCodeAt(p + 3) << 8); if (b & 0x8000) b -= 0x10000;
        l[i] = a / 32768; r[i] = b / 32768;
      }
      node.port.postMessage({ l, r }, [l.buffer, r.buffer]);
    } catch { /* ignore */ }
  };
  return node;
}
export function detachNativePcm() { (window as any).__lmPcm = undefined; }
