import { BANDS, FB, fbParamsFor } from './config';
import type { AsioBridge } from './asio';

/** 드롭다운 기본값: deviceId 지정 없이 OS 기본 입력(연결된 USB 인터페이스 우선)을 연다 */
export const DEFAULT_INPUT_ID = 'default';

/** Auto-Trim(볼륨 무관 레벨 고정) 기준 */
export const TRIM = {
  targetDb: -18,      // 분석기 내부 기준 레벨
  gateDb: -55,        // 이보다 작은 구간(무음)은 추적에서 제외
  tauSec: 2.5,        // 단기 통합 RMS 시간상수 (볼륨을 바꾸면 약 5초 안에 다시 고정)
  minDb: -20, maxDb: 40,
} as const;

const NO_MIC_MSG = '이 페이지에서는 마이크를 사용할 수 없습니다 (HTTPS 주소가 아니거나 브라우저/웹뷰가 차단함)';
export const micAvailable = () => !!navigator.mediaDevices?.getUserMedia;
/** 노이즈 게이트: 기본 임계값(dBFS)과 무음 대기 진입 시간 */
export const GATE = { defaultDb: -50, minDb: -70, maxDb: -20, enterMs: 2500, exitTicks: 2 } as const;
/** 브라우저 입력에서 요청하는 최대 채널 수 (다채널 인터페이스의 모든 입력을 연다 · ASIO 는 드라이버가 알려 주는 채널 수를 제한 없이 사용) */
export const MAX_CHANNELS = 64;

/**
 * AudioWorklet 모듈 (한 번에 등록)
 *  · lm-clock : 100ms 마다 { type:'tick', rms, peak } 를 메인 스레드로 보내는 마스터 클럭 (입력 L/R 레벨도 직접 측정)
 *  · lm-asio  : ASIO 브릿지가 보낸 Float32 인터리브 스테레오 PCM 을 링버퍼에 쌓아 2채널로 출력 (지연 약 0.1초 유지)
 */
const WORKLET_SRC = `
class LmClock extends AudioWorkletProcessor {
  constructor() { super(); this.acc = 0; this.every = Math.round(sampleRate / 10); this.sq = [0, 0]; this.pk = [0, 0]; this.n = 0; }
  process(inputs) {
    const inp = inputs[0];
    if (inp && inp.length) {
      const L = inp[0], R = inp[1] || inp[0];
      for (let i = 0; i < L.length; i++) {
        const a = L[i], b = R[i];
        this.sq[0] += a * a; this.sq[1] += b * b;
        const pa = a < 0 ? -a : a, pb = b < 0 ? -b : b;
        if (pa > this.pk[0]) this.pk[0] = pa;
        if (pb > this.pk[1]) this.pk[1] = pb;
      }
      this.n += L.length;
    }
    this.acc += 128;
    if (this.acc >= this.every) {
      this.acc -= this.every;
      const db = x => (x > 1e-7 ? 20 * Math.log10(x) : -120), n = this.n || 1;
      this.port.postMessage({ type: 'tick',
        rms: [db(Math.sqrt(this.sq[0] / n)), db(Math.sqrt(this.sq[1] / n))],
        peak: [db(this.pk[0]), db(this.pk[1])] });
      this.sq[0] = this.sq[1] = 0; this.pk[0] = this.pk[1] = 0; this.n = 0;
    }
    return true;
  }
}
registerProcessor('lm-clock', LmClock);

class LmAsio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = Math.round(sampleRate * 2); this.buf = new Float32Array(this.cap * 2);
    this.w = 0; this.r = 0; this.n = 0; this.primed = false;
    this.target = Math.round(sampleRate * 0.1);
    this.port.onmessage = e => {
      const d = new Float32Array(e.data), frames = d.length >> 1;
      if (this.n + frames > this.cap) { const drop = this.n + frames - this.cap; this.r = (this.r + drop) % this.cap; this.n -= drop; }
      for (let i = 0; i < frames; i++) { const k = this.w * 2; this.buf[k] = d[2 * i]; this.buf[k + 1] = d[2 * i + 1]; this.w = (this.w + 1) % this.cap; }
      this.n += frames;
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0];
    if (!this.primed) { if (this.n < this.target) return true; this.primed = true; }
    if (this.n > this.target * 4) { const drop = this.n - this.target; this.r = (this.r + drop) % this.cap; this.n -= drop; }   // 지연이 쌓이면 따라잡기
    for (let i = 0; i < L.length; i++) {
      if (this.n > 0) { const k = this.r * 2; L[i] = this.buf[k]; R[i] = this.buf[k + 1]; this.r = (this.r + 1) % this.cap; this.n--; }
      else { L[i] = 0; R[i] = 0; this.primed = false; }
    }
    return true;
  }
}
registerProcessor('lm-asio', LmAsio);registerProcessor('lm-clock', LmClock);`;

/** 마이크 권한 팝업을 띄워 승인받는다 (승인 후에야 enumerateDevices 가 실제 장치 이름/ID를 돌려줌) */
export async function requestMicPermission(): Promise<void> {
  if (!micAvailable()) throw new Error(NO_MIC_MSG);
  const s = await navigator.mediaDevices.getUserMedia({ audio: true });
  s.getTracks().forEach(t => t.stop());
}

export interface OpenInfo { step: 1 | 2 | 3; label: string; settings: MediaTrackSettings; usb?: boolean }

/** USB 오디오 인터페이스로 보이는 입력 이름 (ZOOM AMS-24 등) */
const USB_RE = /usb|zoom|ams-?\d|interface|focusrite|scarlett|steinberg|\bur\d|behringer|umc|motu|presonus|roland|tascam|irig|rode|audient|ssl\s?\d|apogee|yamaha ag|mackie/i;
const BUILTIN_RE = /built-?in|내장|internal|headset|핸즈프리|bluetooth|블루투스|default|기본/i;

/** 연결된 USB 인터페이스를 찾는다 (이름을 읽으려면 마이크 권한이 필요하므로 없으면 한 번 요청) */
export async function findUsbInput(): Promise<MediaDeviceInfo | null> {
  let devs = await listInputs();
  if (devs.length && devs.every(d => !d.label)) {
    try { await requestMicPermission(); devs = await listInputs(); } catch { return null; }
  }
  const real = devs.filter(d => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  return real.find(d => USB_RE.test(d.label) && !BUILTIN_RE.test(d.label)) ?? null;
}

/**
 * 3단계 Fallback 으로 입력을 연다.
 *  1차: (실제 ID가 있을 때만 deviceId exact) + 최대 64채널 + EC/NS/AGC OFF
 *       ※ 크롬은 deviceId 를 ideal 로 주면 선택을 무시하고 기본 장치를 열기 때문에 exact 를 쓴다.
 *         ID가 더 이상 유효하지 않으면 여기서 실패하고 2차(ID 제외)로 넘어간다.
 *  2차: deviceId 없이 EC/NS/AGC OFF
 *  3차: { audio: true }
 */
export async function openInput(deviceId?: string): Promise<{ stream: MediaStream; step: 1 | 2 | 3 }> {
  if (!micAvailable()) throw new Error(NO_MIC_MSG);
  const realId = !!deviceId && deviceId !== DEFAULT_INPUT_ID;
  // 다채널 인터페이스의 모든 입력을 연다 (브라우저/드라이버가 허용하는 만큼)
  const raw: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: MAX_CHANNELS } };
  const first: MediaTrackConstraints = { ...raw };
  if (realId) first.deviceId = { exact: deviceId };
  const attempts: (MediaTrackConstraints | true)[] = [first, raw, true];
  let firstErr: unknown = null;
  for (let i = 0; i < attempts.length; i++) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: attempts[i] });
      if (!stream.getAudioTracks().length) { stream.getTracks().forEach(t => t.stop()); throw new Error('오디오 트랙이 없습니다'); }
      return { stream, step: (i + 1) as 1 | 2 | 3 };
    } catch (e) {
      console.warn(`입력 열기 ${i + 1}차 실패`, e);
      if (firstErr === null) firstErr = e;
    }
  }
  throw firstErr;   // 3단계 모두 실패 (권한 거부·장치 없음 등) → 첫 원인을 그대로 전달
}

export interface ChannelLevel { rmsDb: number; peakDb: number; clip: boolean }
export interface BandStat { avgDb: number; peakDb: number; crestDb: number; relDb: number; character: 'transient' | 'sustained' | 'mixed' | 'none' }
export interface SpecPeak { hz: number; levelDb: number; prominenceDb: number }
export interface FbHit { hz: number; db: number }
export interface SpecStats { peaks: SpecPeak[]; subVsMidDb: number; sub20to80SharePct: number; voiceBandSharePct: number; spectralCentroidHz: number }
export interface DynStats {
  fullRmsDb: number; fullPeakDb: number; fullCrestDb: number;
  /** 분당 어택 수 (low 60-250Hz · mid 500Hz-2kHz · highMid 2-6kHz) */
  transientDensityPerMin: { low: number; mid: number; highMid: number };
  /** 대역 단기 레벨 변동폭 (dB 표준편차) */
  transientFluxDb: { low: number; mid: number; highMid: number };
  /** 잔향 지속도: 골짜기/피크 에너지 비율(%) · 어택 직후 감쇠 속도(dB/s, 작을수록 잔향 김) */
  decayTail: { ratioPct: number; decayDbPerSec: number | null };
  activeSec: number;
}

const toDb = (x: number) => (x > 1e-7 ? 20 * Math.log10(x) : -120);
const r1 = (x: number) => Math.round(x * 10) / 10;

export async function listInputs(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter(d => d.kind === 'audioinput');
}

export class AudioEngine {
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private anL?: AnalyserNode;
  private anR?: AnalyserNode;
  private anFb?: AnalyserNode;
  private bandAn: AnalyserNode[] = [];
  private bandAcc = BANDS.map(() => ({ sumSq: 0, n: 0, peak: 0 }));
  private buf = new Float32Array(4096);
  private rawBuf = new Float32Array(2048);
  private fbBuf = new Float32Array(FB.fftSize / 2);
  private clipUntil = [0, 0];
  private peakHold = [-120, -120];
  private peakHoldAt = [0, 0];
  private fbTrack = { bin: -1, n: 0, maxDb: -200 };
  private specAcc = new Float64Array(FB.fftSize / 2);
  private specN = 0;
  private fbCfg = fbParamsFor(0.5);
  private src?: AudioNode;               // 원본 입력 (Thru 는 여기서 → 귀로 듣는 소리는 보정 없음)
  private trim?: GainNode;               // Auto-Trim 게인 (분석 경로 전용)
  private anRaw: AnalyserNode[] = [];    // 보정 전 원본 L/R 레벨 (Auto-Trim 추적용)
  private sp?: ScriptProcessorNode;      // AudioWorklet 을 쓸 수 없을 때만 쓰는 오디오 스레드 하트비트
  private clockNode?: AudioWorkletNode;  // 마스터 클럭 (오디오 스레드 100ms 박동)
  /** 입력 라우팅: 장치의 N 채널 중 L/R 로 쓸 채널 (0부터) */
  private split?: ChannelSplitterNode;
  private merge?: ChannelMergerNode;
  private asio?: AsioBridge;
  private asioNode?: AudioWorkletNode;
  route = { l: 0, r: 1 };
  /** 입력 종류: 브라우저 장치 / ASIO 브릿지 */
  kind: 'browser' | 'asio' = 'browser';
  /** 장치가 실제로 연 입력 채널 수 */
  deviceChannels = 0;
  private srcCount = { analyser: 0, cached: 0 };
  /** 무음 버퍼(-80dBFS 이하) 대체용: 직전 유효 틱(최대 3초 = 30틱) 이동평균 캐시 */
  private cache: { band: { ms: number; pk: number }[]; full: { ms: number; pk: number } }[] = [];
  private specCache: Float64Array | null = null;
  private tickQuiet = false;
  private tickCached = false;
  /** AudioWorklet 이 직접 측정한 입력 레벨 (dBFS) · 100ms 마다 갱신 */
  private wk: { rms: [number, number]; peak: [number, number]; at: number } | null = null;
  /** 마스터 클럭 종류 */
  clockKind: 'worklet' | 'scriptprocessor' | 'none' = 'none';
  private trimOn = false;
  private trimIntDb = -120;              // 단기 통합 레벨 (활성 구간만 · dB 영역 평균)
  private trimInit = false;
  private trimLastAt = 0;
  private startedAt = 0;
  trimDb = 0;                            // 현재 적용 중인 오프셋 게인 (dB)
  usbPicked = false;
  /** 최근 측정한 원본(보정 전) RMS dBFS — 신호 대기 중 HUD 안내용 */
  lastRawDb = -120;
  /** 오디오 스레드 박동 (AudioWorklet 100ms) — 분석기의 마스터 틱 */
  onAudioBeat: () => void = () => {};
  private fullAcc = { sumSq: 0, n: 0, peak: 0 };
  /** 100ms 마다 쌓는 대역별 단기 레벨(dB) 시리즈: [low, mid, highMid] */
  private series: number[][] = [[], [], []];
  /** 노이즈 게이트: 원본 RMS 가 임계값 아래로 GATE.enterMs 이상이면 무음 대기 */
  private gateOn = false;   // 기본 OFF: 레벨이 낮아도 신호 대기로 넘어가지 않고 계속 분석
  gateDb: number = GATE.defaultDb;
  idle = false;
  private belowSince = 0;
  private aboveCount = 0;
  onIdleChange: (idle: boolean) => void = () => {};
  onEnded: () => void = () => {};     // 입력 장치가 분리되는 등 트랙이 끝났을 때
  channels = 0;
  running = false;
  openInfo: OpenInfo | null = null;
  ctxState = '';

  /**
   * 입력 시작.
   *  · browser: getUserMedia(EC/NS/AGC OFF · 최대 32채널 · 3단계 Fallback) → ChannelSplitter(N) → 선택한 L/R → ChannelMerger(2)
   *  · asio   : 로컬 ASIO 브릿지가 보내는 L/R PCM → AudioWorklet(lm-asio) 2채널 출력
   * 이후 분석 경로(Auto-Trim · L/R 미터 · 6밴드 · FFT · 지표)는 두 경로가 같다.
   */
  async start(opt: { kind: 'browser'; deviceId?: string; l: number; r: number } | { kind: 'asio'; bridge: AsioBridge; device: number; l: number; r: number }) {
    await this.stop();
    this.kind = opt.kind;
    this.route = { l: Math.max(0, opt.l | 0), r: Math.max(0, opt.r | 0) };
    let ctx: AudioContext;
    let input: AudioNode;
    if (opt.kind === 'browser') {
      let id = opt.deviceId, usb = false;
      if (!id || id === DEFAULT_INPUT_ID) {
        const u = await findUsbInput().catch(() => null);
        if (u) { id = u.deviceId; usb = true; }
      }
      const o = await openInput(id);
      this.stream = o.stream;
      const step = o.step;
      this.usbPicked = usb && step === 1;
      const track = this.stream!.getAudioTracks()[0];
      track.addEventListener('ended', () => { if (this.running) this.onEnded(); });
      const settings = track.getSettings();
      this.openInfo = { step, label: track.label || '', settings, usb: this.usbPicked };
      ctx = new AudioContext({ latencyHint: 'interactive' });
      const src = ctx.createMediaStreamSource(this.stream!);
      this.src = src;
      const n = Math.max(1, settings.channelCount ?? src.channelCount ?? 2);
      this.deviceChannels = n;
      // 장치 채널 수보다 큰 번호를 고르면 1번(·2번) 채널로
      if (this.route.l >= n) this.route.l = 0;
      if (this.route.r >= n) this.route.r = Math.min(1, n - 1);
      const split = ctx.createChannelSplitter(n);
      const merge = ctx.createChannelMerger(2);
      src.connect(split);
      this.split = split; this.merge = merge;
      this.applyRoute();
      input = merge;
    } else {
      const bridge = opt.bridge;
      const o = await bridge.open(opt.device, this.route.l, this.route.r);
      this.asio = bridge;
      this.deviceChannels = o.channels;
      this.route = { l: o.l, r: o.r };
      this.openInfo = { step: 1, label: `[ASIO] ${o.name}`, settings: { sampleRate: o.sampleRate, channelCount: o.channels }, usb: false };
      this.usbPicked = false;
      try { ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: o.sampleRate }); }
      catch { ctx = new AudioContext({ latencyHint: 'interactive' }); }   // 샘플레이트 지정 불가 → 기본값 (브라우저가 재샘플링하지 않으므로 피치 오차 가능)
      if (!ctx.audioWorklet) { bridge.close(); throw new Error('이 브라우저는 AudioWorklet 을 지원하지 않아 ASIO 입력을 쓸 수 없습니다'); }
      await this.loadWorklets(ctx);
      const node = new AudioWorkletNode(ctx, 'lm-asio', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      bridge.onPcm = buf => { try { node.port.postMessage(buf, [buf]); } catch { /* ignore */ } };
      bridge.onLost = () => { if (this.running) this.onEnded(); };
      this.asioNode = node;
      this.src = node;
      input = node;
    }
    this.channels = 2;   // 분석 경로는 항상 L/R 2채널 (모노 선택 시 L=R)

    // resume() 이 자동재생 정책 때문에 끝나지 않는 경우에도 시작이 멈추지 않도록 1.5초만 기다림
    await Promise.race([ctx.resume().catch(() => {}), new Promise(r => setTimeout(r, 1500))]);
    this.ctx = ctx;
    this.ctxState = ctx.state;
    ctx.onstatechange = () => { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); };   // suspended → 자동 resume
    const src = input;
    // Auto-Trim: 원본 → trim(게인) → 모든 분석 노드.  원본 레벨은 anRaw 로 따로 측정
    const trim = ctx.createGain();
    trim.gain.value = 1;
    src.connect(trim);
    this.trim = trim;
    this.trimDb = 0; this.trimIntDb = -120; this.trimInit = false; this.trimLastAt = 0; this.startedAt = performance.now();
    const an = trim;   // 이하 분석 노드는 모두 trim 출력에 연결
    // 무음 싱크: 분석 노드들을 destination 에 연결해 그래프가 계속 처리되게 함 (소리는 나가지 않음 · 입력은 스피커로 보내지 않음)
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    this.cache = []; this.specCache = null; this.srcCount = { analyser: 0, cached: 0 };

    // 원본 L/R 을 따로 측정 (Analyser 는 스테레오를 모노로 평균내 레벨이 낮게 나오므로 Splitter 로 분리)
    const rawSplit = ctx.createChannelSplitter(2);
    src.connect(rawSplit);
    this.anRaw = [0, this.channels === 1 ? 0 : 1].map(ch => {
      const a = ctx.createAnalyser();
      a.fftSize = 2048; a.smoothingTimeConstant = 0;
      rawSplit.connect(a, ch); a.connect(sink);
      return a;
    });

    const mk = (size: number) => {
      const a = ctx.createAnalyser();
      a.fftSize = size;
      a.smoothingTimeConstant = 0;
      a.minDecibels = -120;
      a.maxDecibels = 0;
      a.connect(sink);
      return a;
    };

    // L/R 분리
    const splitter = ctx.createChannelSplitter(2);
    // 100ms 틱에 맞춰 4096 샘플(약 85ms) 창으로 측정 → 틱 사이 공백 최소화
    this.anL = mk(4096);
    this.anR = mk(4096);
    an.connect(splitter);
    splitter.connect(this.anL, 0);
    splitter.connect(this.anR, this.channels === 1 ? 0 : 1); // 모노 장치면 R도 같은 신호
    // 피드백 FFT (L+R 믹스다운)
    this.anFb = mk(FB.fftSize);
    an.connect(this.anFb);

    // 6밴드 시간영역 측정 (4차 밴드패스)
    this.bandAn = BANDS.map(b => {
      const nodes: BiquadFilterNode[] = [];
      for (const [type, f] of [['highpass', b.lo], ['highpass', b.lo], ['lowpass', Math.min(b.hi, ctx.sampleRate / 2 - 100)], ['lowpass', Math.min(b.hi, ctx.sampleRate / 2 - 100)]] as const) {
        const n = ctx.createBiquadFilter();
        n.type = type; n.frequency.value = f; n.Q.value = Math.SQRT1_2;
        nodes.push(n);
      }
      an.connect(nodes[0]);
      nodes.reduce((a, c) => (a.connect(c), c));
      const bandAn = mk(4096);
      nodes[3].connect(bandAn);
      return bandAn;
    });
    this.bandAcc = BANDS.map(() => ({ sumSq: 0, n: 0, peak: 0 }));
    this.fullAcc = { sumSq: 0, n: 0, peak: 0 }; this.series = [[], [], []];
    this.idle = false; this.belowSince = 0; this.aboveCount = 0;
    // AudioWorklet 마스터 클럭 (100ms 박동 · L/R 레벨)
    await this.startClock(src, sink);
    this.specAcc.fill(0); this.specN = 0;
    this.fbTrack = { bin: -1, n: 0, maxDb: -200 };
    this.running = true;
  }

  async stop() {
    this.running = false;
    if (this.sp) { this.sp.onaudioprocess = null; try { this.sp.disconnect(); } catch { /* ignore */ } }
    if (this.clockNode) { this.clockNode.port.onmessage = null; try { this.clockNode.disconnect(); } catch { /* ignore */ } }
    if (this.asio) { this.asio.onPcm = () => {}; this.asio.onLost = () => {}; if (this.asio.opened) this.asio.close(); }
    this.asio = undefined; this.asioNode = undefined; this.split = undefined; this.merge = undefined;
    this.stream?.getTracks().forEach(t => t.stop());
    await this.ctx?.close().catch(() => {});
    this.ctx = undefined; this.stream = undefined; this.src = undefined; this.bandAn = [];
    this.trim = undefined; this.anRaw = []; this.sp = undefined;
    this.anL = undefined; this.anR = undefined; this.anFb = undefined;
    this.clockNode = undefined; this.clockKind = 'none';
  }

  /** 피드백 민감도 슬라이더 (0=둔감 … 1=예민). 반환: 적용된 판정 기준 */
  setFbSensitivity(t: number) {
    this.fbCfg = fbParamsFor(t);
    this.fbTrack = { bin: -1, n: 0, maxDb: -200 };
    return this.fbCfg;
  }

  /** 화면 터치 등 사용자 동작 시 호출: 대기 상태의 오디오 엔진 재개 */
  resumeCtx() {
    const c = this.ctx;
    if (c && c.state !== 'running') c.resume().then(() => { this.ctxState = c.state; }).catch(() => {});
  }

  /** 워치독: Worker 틱마다 호출. suspended(백그라운드 전환 등)면 즉시 resume. 복구를 시도했으면 true */
  watchdog(): boolean {
    const c = this.ctx;
    if (!c || c.state === 'running' || c.state === 'closed') return false;
    c.resume().then(() => { this.ctxState = c.state; }).catch(() => {});
    return true;
  }
  get state() { return this.ctx?.state ?? 'closed'; }
  /** L/R 채널 변경 (분석 중에도 즉시 적용). r === l 이면 모노 */
  setRoute(l: number, r: number) {
    const n = this.deviceChannels || MAX_CHANNELS;
    this.route = { l: Math.min(Math.max(0, l | 0), n - 1), r: Math.min(Math.max(0, r | 0), n - 1) };
    if (!this.running) return;
    if (this.kind === 'asio') this.asio?.route(this.route.l, this.route.r);
    else this.applyRoute();
    this.resetAccum();
  }
  private applyRoute() {
    if (!this.split || !this.merge) return;
    try { this.split.disconnect(); } catch { /* ignore */ }
    this.split.connect(this.merge, this.route.l, 0);
    this.split.connect(this.merge, this.route.r, 1);
  }
  /** 지난 AI 구간 동안 무음 캐시로 대체한 틱 수 (확인용). 호출하면 초기화 */
  takeSourceStats() { const s = this.srcCount; this.srcCount = { analyser: 0, cached: 0 }; return s; }

  /** 노이즈 게이트 설정. 끄면 즉시 무음 대기 해제 */
  setGate(on: boolean, db: number) {
    this.gateOn = on; this.gateDb = db;
    this.belowSince = 0; this.aboveCount = 0;
    if (!on && this.idle) this.exitIdle();
  }
  private resetAccum() {
    this.bandAcc = BANDS.map(() => ({ sumSq: 0, n: 0, peak: 0 }));
    this.fullAcc = { sumSq: 0, n: 0, peak: 0 };
    this.series = [[], [], []];
    this.specAcc.fill(0); this.specN = 0;
    this.fbTrack = { bin: -1, n: 0, maxDb: -200 };
  }
  private enterIdle() {
    this.idle = true;
    // Auto-Trim 동결: 게인을 즉시 0.0dB 로 (방 소음을 키우지 않음), 다음 음악에서 처음부터 다시 학습
    this.trimDb = 0; this.trimInit = false; this.trimIntDb = -120;
    if (this.trim && this.ctx) { this.trim.gain.cancelScheduledValues(this.ctx.currentTime); this.trim.gain.setValueAtTime(1, this.ctx.currentTime); }
    this.resetAccum();                 // 게이트 닫히기 전 대기 시간 동안 쌓인 소음도 버림
    this.onIdleChange(true);
  }
  private exitIdle() {
    this.idle = false;
    this.resetAccum();
    this.onIdleChange(false);
  }

  /** 🎚️ Auto-Trim ON/OFF. OFF 면 게인 1.0 (콘솔의 실제 Raw dBFS 그대로) */
  setAutoTrim(on: boolean) {
    this.trimOn = on;
    this.trimInit = false; this.trimIntDb = -120;
    if (!on) {
      this.trimDb = 0;
      if (this.trim && this.ctx) { this.trim.gain.cancelScheduledValues(this.ctx.currentTime); this.trim.gain.setValueAtTime(1, this.ctx.currentTime); }
    }
  }
  get autoTrim() { return this.trimOn; }

  /**
   * Auto-Level Normalization (100ms 틱마다):
   *  원본 RMS 가 -55 dBFS 이상인 활성 구간만 단기(약 3초) 통합 → 기준 -18 dBFS 와의 차이를 오프셋 게인으로 적용.
   *  무음 구간에서는 게인을 그대로 유지(무음 때 게인이 치솟지 않음). 반환: 원본 순간 RMS(dBFS)
   */
  updateTrim(): number {
    if (!this.anRaw.length || !this.ctx || !this.trim) return -120;
    let pw = 0;
    for (const a of this.anRaw) {                    // L/R 평균 파워 (미터의 채널별 RMS 와 같은 기준)
      a.getFloatTimeDomainData(this.rawBuf);
      let sq = 0;
      for (let k = 0; k < this.rawBuf.length; k++) sq += this.rawBuf[k] * this.rawBuf[k];
      pw += sq / this.rawBuf.length / this.anRaw.length;
    }
    let rawDb = toDb(Math.sqrt(pw));
    this.srcCount.analyser++;
    const now = performance.now();
    // 백그라운드에서 AnalyserNode 가 갱신되지 않아도 AudioWorklet 이 잰 값이 있으면 더 큰(유효한) 값을 기준으로 삼는다
    if (this.wk && now - this.wk.at < 600) {
      const wkDb = 10 * Math.log10((Math.pow(10, this.wk.rms[0] / 10) + Math.pow(10, this.wk.rms[1] / 10)) / 2 + 1e-20);
      if (wkDb > rawDb) rawDb = wkDb;
    }
    this.lastRawDb = rawDb;
    if (this.gateOn) {
      if (rawDb < this.gateDb) {
        this.aboveCount = 0;
        if (!this.belowSince) this.belowSince = now;
        if (!this.idle && now - this.belowSince >= GATE.enterMs) this.enterIdle();
      } else {
        this.belowSince = 0;
        if (this.idle && ++this.aboveCount >= GATE.exitTicks) this.exitIdle();   // 0.2초 연속 신호 → 자동 분석 재개
      }
      if (this.idle) return rawDb;                                  // 무음 대기: 보정 게인 동결(0dB)
    }
    if (!this.trimOn) return rawDb;
    const dt = this.trimLastAt ? Math.min(1, (now - this.trimLastAt) / 1000) : 0.1;
    this.trimLastAt = now;
    if (rawDb < TRIM.gateDb || (this.gateOn && rawDb < this.gateDb) || now - this.startedAt < 600) return rawDb;   // 무음·입력 시작 직후(램프) 제외 → 게인 유지
    // dB 영역 지수 평균: 볼륨을 올릴 때와 내릴 때 같은 속도로 따라감 (파워 평균은 큰 소리 이력이 오래 남음)
    if (!this.trimInit) { this.trimIntDb = rawDb; this.trimInit = true; }
    else this.trimIntDb += (1 - Math.exp(-dt / TRIM.tauSec)) * (rawDb - this.trimIntDb);
    const want = Math.min(TRIM.maxDb, Math.max(TRIM.minDb, TRIM.targetDb - this.trimIntDb));
    this.trimDb = Math.round(want * 10) / 10;
    this.trim.gain.setTargetAtTime(Math.pow(10, want / 20), this.ctx.currentTime, 0.15);   // 부드럽게 (클릭 없음)
    return rawDb;
  }

  private workletCtx?: AudioContext;
  private async loadWorklets(ctx: AudioContext) {
    if (this.workletCtx === ctx) return;
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }));
    try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    this.workletCtx = ctx;
  }

  /**
   * 마스터 클럭: 입력 → AudioWorkletNode(lm-clock) → 무음 싱크 → destination.
   * 워클릿이 100ms 마다 메인 스레드로 박동(+L/R 레벨)을 보낸다. (AudioWorklet 을 쓸 수 없을 때만 ScriptProcessor 로 대체)
   */
  private async startClock(src: AudioNode, sink: AudioNode) {
    const ctx = this.ctx!;
    try {
      if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') throw new Error('AudioWorklet 미지원');
      await this.loadWorklets(ctx);
      const node = new AudioWorkletNode(ctx, 'lm-clock', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      node.port.onmessage = ev => {
        const d = ev.data;
        if (d?.type !== 'tick') return;
        if (Array.isArray(d.rms) && Array.isArray(d.peak)) this.wk = { rms: [d.rms[0], d.rms[1]], peak: [d.peak[0], d.peak[1]], at: performance.now() };
        try { this.onAudioBeat(); } catch { /* ignore */ }
      };
      src.connect(node); node.connect(sink);
      this.clockNode = node; this.clockKind = 'worklet';
    } catch (e) {
      console.warn('AudioWorklet 마스터 클럭 실패 → ScriptProcessor 대체', e);
      try {
        const sp = ctx.createScriptProcessor(4096, 1, 1);
        src.connect(sp); sp.connect(sink);
        sp.onaudioprocess = () => { try { this.onAudioBeat(); } catch { /* ignore */ } };
        this.sp = sp; this.clockKind = 'scriptprocessor';
      } catch (e2) { console.warn('오디오 스레드 박동 없음 (Worker 틱만 사용)', e2); this.clockKind = 'none'; }
    }
  }

  /** L/R 입력 레벨 (rAF/타이머에서 호출) */
  readLevels(): [ChannelLevel, ChannelLevel] | null {
    if (!this.anL || !this.anR) return null;
    if (this.idle) return [{ rmsDb: -120, peakDb: -120, clip: false }, { rmsDb: -120, peakDb: -120, clip: false }];   // 무음 대기: 미터 -∞
    const now = performance.now();
    const out = [this.anL, this.anR].map((an, i) => {
      let sum = 0, peak = 0;
      const len = this.buf.length;
      an.getFloatTimeDomainData(this.buf);
      for (let k = 0; k < this.buf.length; k++) {
        const v = Math.abs(this.buf[k]);
        sum += v * v; if (v > peak) peak = v;
      }
      let rmsDb = toDb(Math.sqrt(sum / len));
      let peakDb = toDb(peak);
      // AnalyserNode 가 죽어 있는데(-100 미만) AudioWorklet 은 신호를 보면 워클릿 값으로 대체
      if (rmsDb < -100 && this.wk && now - this.wk.at < 600 && this.wk.rms[i] > -100) { rmsDb = this.wk.rms[i]; peakDb = this.wk.peak[i]; }
      if (peak >= 0.99 && !this.trimOn) this.clipUntil[i] = now + 2000;   // Auto-Trim 중에는 보정 후 값이라 CLIP 판정 안 함
      if (peakDb >= this.peakHold[i] || now - this.peakHoldAt[i] > 1200) {
        this.peakHold[i] = peakDb; this.peakHoldAt[i] = now;
      }
      return { rmsDb, peakDb: this.peakHold[i], clip: now < this.clipUntil[i] };
    });
    return [out[0], out[1]];
  }

  /**
   * 100ms 틱마다 호출: 6밴드·전대역 누적.
   * 게이트 OFF 에서 이번 틱이 -80dBFS 이하(완전 무음 버퍼)면 직전 3초 이동평균 캐시로 대체해 분석이 끊기지 않게 한다.
   */
  pollBands() {
    if (this.idle) return;                       // 무음 대기 중에는 누적하지 않음
    type T = { band: { ms: number; pk: number }[]; full: { ms: number; pk: number } };
    let t: T;
    const n = this.buf.length;
    {
      const meas = (an: AnalyserNode | undefined) => {
        if (!an) return { ms: 0, pk: 0 };
        an.getFloatTimeDomainData(this.buf);
        let sq = 0, pk = 0;
        for (let k = 0; k < this.buf.length; k++) { const v = this.buf[k]; sq += v * v; const a = v < 0 ? -v : v; if (a > pk) pk = a; }
        return { ms: sq / this.buf.length, pk };
      };
      const l = meas(this.anL), r = meas(this.anR);
      t = { band: this.bandAn.map(meas), full: { ms: (l.ms + r.ms) / 2, pk: Math.max(l.pk, r.pk) } };
    }
    // 무음 버퍼 보정
    this.tickQuiet = toDb(Math.sqrt(t.full.ms)) <= -80;
    this.tickCached = false;
    if (this.tickQuiet) {
      if (!this.gateOn && this.cache.length) {
        const c = this.cache, k = c.length;
        t = {
          band: BANDS.map((_, i) => ({ ms: c.reduce((s, x) => s + x.band[i].ms, 0) / k, pk: c.reduce((s, x) => s + x.band[i].pk, 0) / k })),
          full: { ms: c.reduce((s, x) => s + x.full.ms, 0) / k, pk: c.reduce((s, x) => s + x.full.pk, 0) / k },
        };
        this.tickCached = true;
        this.srcCount.cached++;
      }
    } else {
      this.cache.push(t);
      if (this.cache.length > 30) this.cache.shift();
    }
    t.band.forEach((b, i) => {
      const acc = this.bandAcc[i];
      acc.sumSq += b.ms * n; acc.n += n;
      if (b.pk > acc.peak) acc.peak = b.pk;
      const si = i === 1 ? 0 : i === 3 ? 1 : i === 4 ? 2 : -1;   // Low / Mid / High-Mid 단시간 레벨 → 트랜지언트·잔향 분석
      if (si >= 0) {
        const ser = this.series[si];
        ser.push(toDb(Math.sqrt(b.ms)));
        if (ser.length > 1200) ser.splice(0, 200);
      }
    });
    // 전 대역 Crest Factor (L+R 합산, Peak 대비 RMS)
    const f = this.fullAcc;
    f.sumSq += t.full.ms * 2 * n; f.n += 2 * n;
    if (t.full.pk > f.peak) f.peak = t.full.pk;
  }

  /** 전 대역 Crest Factor + 저역 트랜지언트 변화량을 집계하고 초기화 */
  collectDynamics(): DynStats {
    const f = this.fullAcc;
    const rms = toDb(f.n ? Math.sqrt(f.sumSq / f.n) : 0);
    const peak = toDb(f.peak);
    const STEP = 0.1;   // 시리즈 간격(초) = 100ms 틱
    const onsetIdx = (s: number[]) => {
      const out: number[] = []; let last = -100;
      for (let i = 1; i < s.length; i++) if (s[i] > -55 && s[i] - s[i - 1] >= 6 && i - last >= 3) { out.push(i); last = i; }   // 0.1초 사이 6dB↑, 0.3초 불응기
      return out;
    };
    const std = (s: number[]) => {
      const v = s.filter(x => x > -80);
      if (!v.length) return 0;
      const m = v.reduce((p, c) => p + c, 0) / v.length;
      return Math.sqrt(v.reduce((p, c) => p + (c - m) * (c - m), 0) / v.length);
    };
    const [low, mid, hm] = this.series;
    const sec = Math.max(low.length, mid.length, hm.length) * STEP;
    const perMin = (s: number[]) => (sec > 0 ? Math.round((onsetIdx(s).length / sec) * 60) : 0);

    // 잔향 지속도 (Mid 500Hz-2kHz 기준)
    const act = mid.filter(x => x > -70).slice().sort((a, b) => a - b);
    const pct = (q: number) => act[Math.min(act.length - 1, Math.floor(q * act.length))];
    const ratioPct = act.length >= 10 ? r1(Math.pow(10, (pct(0.2) - pct(0.9)) / 10) * 100) : 0;
    const rates: number[] = [];
    const on = onsetIdx(mid);
    on.forEach((i, k) => {
      const next = on[k + 1] ?? Infinity;
      const pk = Math.max(mid[i], mid[i + 1] ?? -120);
      if (i + 4 < mid.length && next > i + 4) rates.push((pk - mid[i + 4]) / (3 * STEP));   // 피크 후 0.3초 감쇠량
    });
    rates.sort((a, b) => a - b);
    const decay = rates.length >= 3 ? r1(rates[Math.floor(rates.length / 2)]) : null;

    this.fullAcc = { sumSq: 0, n: 0, peak: 0 };
    this.series = [[], [], []];
    return {
      fullRmsDb: r1(rms), fullPeakDb: r1(peak), fullCrestDb: r1(Math.max(0, peak - rms)),
      transientDensityPerMin: { low: perMin(low), mid: perMin(mid), highMid: perMin(hm) },
      transientFluxDb: { low: r1(std(low)), mid: r1(std(mid)), highMid: r1(std(hm)) },
      decayTail: { ratioPct, decayDbPerSec: decay },
      activeSec: r1(sec),
    };
  }

  /** 지난 구간의 6밴드 통계를 반환하고 누적값 초기화 */
  /** 현재 구간의 6밴드 통계를 누적값을 지우지 않고 계산 (1초마다 화면/수신기 갱신용) */
  peekBands(): Record<string, BandStat> { return this.collectBands(false); }

  collectBands(reset = true): Record<string, BandStat> {
    const avgs = BANDS.map((_, i) => {
      const a = this.bandAcc[i];
      return toDb(a.n ? Math.sqrt(a.sumSq / a.n) : 0);
    });
    const meanPow = avgs.reduce((s, d) => s + Math.pow(10, d / 10), 0) / avgs.length;
    const refDb = 10 * Math.log10(meanPow + 1e-20);
    const res: Record<string, BandStat> = {};
    BANDS.forEach((b, i) => {
      const a = this.bandAcc[i];
      const avg = avgs[i];
      const peak = toDb(a.peak);
      const crest = Math.max(0, peak - avg);
      res[b.name] = {
        avgDb: r1(avg), peakDb: r1(peak), crestDb: r1(crest), relDb: r1(avg - refDb),
        // 휴리스틱: crest ≥18dB → 순간 피크(타악/어택) 성격, ≤12dB → 지속음 성격
        character: avg < -80 ? 'none' : crest >= 18 ? 'transient' : crest <= 12 ? 'sustained' : 'mixed',
      };
      if (reset) this.bandAcc[i] = { sumSq: 0, n: 0, peak: 0 };
    });
    return res;
  }

  /** 평균 스펙트럼: 협대역 피크 상위 4개 + 서브베이스 비율(20~80Hz vs 중역) + 음성 대역 점유율. 집계 후 초기화 */
  collectSpectrum(): SpecStats {
    const n = this.specN;
    const empty: SpecStats = { peaks: [], subVsMidDb: 0, sub20to80SharePct: 0, voiceBandSharePct: 0, spectralCentroidHz: 0 };
    if (!this.ctx || !n) return empty;
    const N = this.specAcc.length;
    const binHz = this.ctx.sampleRate / FB.fftSize;
    const pw = new Float64Array(N);
    const db = new Float32Array(N);
    for (let k = 0; k < N; k++) { pw[k] = this.specAcc[k] / n; db[k] = 10 * Math.log10(pw[k] + 1e-20); }
    const energy = (lo: number, hi: number) => {
      let s = 0;
      for (let k = Math.max(1, Math.floor(lo / binHz)); k <= Math.min(N - 1, Math.ceil(hi / binHz)); k++) s += pw[k];
      return s;
    };
    const sub = energy(20, 80), mid = energy(250, 4000), voice = energy(120, 4000), all = energy(20, 16000);
    let cw = 0, cs = 0;   // 스펙트럼 무게중심 (20Hz~16kHz)
    for (let k = Math.max(1, Math.floor(20 / binHz)); k <= Math.min(N - 1, Math.ceil(16000 / binHz)); k++) { cw += k * binHz * pw[k]; cs += pw[k]; }

    const lo = Math.ceil(60 / binHz), hi = Math.min(N - 16, Math.floor(12000 / binHz));
    const found: SpecPeak[] = [];
    for (let k = lo; k <= hi; k++) {
      const v = db[k];
      if (v < -70 || !(v >= db[k - 1] && v > db[k + 1])) continue;
      let nb = 0, c = 0;
      for (let o = 8; o <= 14; o++) for (const s of [-1, 1]) { nb += Math.pow(10, db[k + s * o] / 10); c++; }
      const prom = v - 10 * Math.log10(nb / c + 1e-20);
      if (prom >= 6) {
        const hz = k * binHz;
        found.push({ hz: Math.round(hz / (hz < 1000 ? 5 : 10)) * (hz < 1000 ? 5 : 10), levelDb: r1(v), prominenceDb: r1(prom) });
      }
    }
    this.specAcc.fill(0); this.specN = 0;
    return {
      peaks: found.sort((x, y) => y.prominenceDb - x.prominenceDb).slice(0, 4),
      subVsMidDb: r1(10 * Math.log10((sub + 1e-20) / (mid + 1e-20))),
      sub20to80SharePct: r1((sub / (all || 1)) * 100),
      voiceBandSharePct: r1((voice / (all || 1)) * 100),
      spectralCentroidHz: cs > 0 ? Math.round(cw / cs) : 0,
    };
  }

  /**
   * 0.1초마다 호출. 진짜 하울링만 잡도록 엄격하게 판정:
   *  300Hz↑ · -35dBFS↑ · 주변(±10~15bin) 대비 20dB↑ 초협대역 피크가
   *  같은 주파수(±1bin)에서 레벨 하락 없이 15회(1.5초) 연속 유지될 때
   */
  scanFeedback(): FbHit | null {
    if (!this.ctx || !this.anFb || this.idle) return null;
    // 무음 버퍼를 캐시로 대체한 틱: 스펙트럼도 직전 이동평균으로 (피드백 판정은 건너뜀)
    if (this.tickCached && this.specCache) {
      for (let k = 0; k < this.specAcc.length; k++) this.specAcc[k] += this.specCache[k];
      this.specN++;
      return null;
    }
    const d = this.fbBuf;
    this.anFb.getFloatFrequencyData(d);
    if (!this.specCache) this.specCache = new Float64Array(d.length);
    const first = !this.cache.length || this.cache.length === 1;
    for (let k = 0; k < d.length; k++) {
      const p = Math.pow(10, d[k] / 10);
      this.specAcc[k] += p;                        // 평균 스펙트럼 누적
      if (!this.tickQuiet) this.specCache[k] = first ? p : this.specCache[k] * 0.9667 + p * 0.0333;   // 약 3초 이동평균
    }
    this.specN++;

    const binHz = this.ctx.sampleRate / FB.fftSize;
    const lo = Math.ceil(FB.minHz / binHz);
    const hi = d.length - FB.nbMaxBins - 1;
    const cands: { bin: number; db: number; prom: number }[] = [];
    for (let k = lo; k <= hi; k++) {
      const v = d[k];
      if (v < this.fbCfg.minLevelDb || !(v >= d[k - 1] && v > d[k + 1])) continue;
      let nb = 0, c = 0;
      for (let o = FB.nbMinBins; o <= FB.nbMaxBins; o++) {
        nb += Math.pow(10, d[k - o] / 10) + Math.pow(10, d[k + o] / 10); c += 2;
      }
      const prom = v - 10 * Math.log10(nb / c + 1e-20);
      if (prom >= this.fbCfg.prominenceDb) cands.push({ bin: k, db: v, prom });
    }

    const t = this.fbTrack;
    const best = (list: typeof cands) => list.reduce((a, b) => (b.prom > a.prom ? b : a));
    const near = t.bin >= 0 ? cands.filter(c => Math.abs(c.bin - t.bin) <= FB.binTolerance) : [];
    if (near.length) {
      const m = best(near);
      if (m.db < t.maxDb - FB.levelDropDb) this.fbTrack = { bin: m.bin, n: 1, maxDb: m.db }; // 레벨 하락 → 재시작
      else { t.n++; t.maxDb = Math.max(t.maxDb, m.db); }
    } else if (cands.length) {
      const m = best(cands);
      this.fbTrack = { bin: m.bin, n: 1, maxDb: m.db };
    } else {
      this.fbTrack = { bin: -1, n: 0, maxDb: -200 };
    }
    if (this.fbTrack.n < this.fbCfg.confirmScans) return null;
    return { hz: Math.round((this.fbTrack.bin * binHz) / 5) * 5, db: this.fbTrack.maxDb };
  }
}
