import { BANDS, FB, fbParamsFor } from './config';

/** 입력 장치 드롭다운의 특수 값: 시스템/화면 오디오 캡처(내부 재생음) */
export const SYSTEM_AUDIO_ID = '__system_audio__';
/** 드롭다운 기본값: deviceId 지정 없이 OS 기본 입력(안드로이드는 꽂힌 USB 인터페이스)을 연다 */
export const DEFAULT_INPUT_ID = 'default';

/** 입력 모드: 콘솔 2-Track(USB 인터페이스 · 1순위 기본값) / 실시간 유튜브·재생음 모니터링(2순위) */
export type InputMode = 'console' | 'monitor';

/** Auto-Trim(볼륨 무관 레벨 고정) 기준 */
export const TRIM = {
  targetDb: -18,      // 분석기 내부 기준 레벨
  gateDb: -55,        // 이보다 작은 구간(무음)은 추적에서 제외
  tauSec: 2.5,        // 단기 통합 RMS 시간상수 (볼륨을 바꾸면 약 5초 안에 다시 고정)
  minDb: -20, maxDb: 40,
} as const;

const NO_MIC_MSG = '이 페이지에서는 마이크를 사용할 수 없습니다 (HTTPS 주소가 아니거나 브라우저/웹뷰가 차단함)';
export const micAvailable = () => !!navigator.mediaDevices?.getUserMedia;
/** 시스템/화면 오디오 캡처 지원 여부 (모바일 브라우저는 미지원) */
export const systemCaptureSupported = () =>
  !!(navigator.mediaDevices as any)?.getDisplayMedia && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

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
 *  1차: (실제 ID가 있을 때만 deviceId exact) + 스테레오 + EC/NS/AGC OFF
 *       ※ 크롬은 deviceId 를 ideal 로 주면 선택을 무시하고 기본 장치를 열기 때문에 exact 를 쓴다.
 *         ID가 더 이상 유효하지 않으면 여기서 실패하고 2차(ID 제외)로 넘어간다.
 *  2차: deviceId 없이 EC/NS/AGC OFF
 *  3차: { audio: true }
 */
export async function openInput(deviceId?: string): Promise<{ stream: MediaStream; step: 1 | 2 | 3 }> {
  if (!micAvailable()) throw new Error(NO_MIC_MSG);
  const realId = !!deviceId && deviceId !== DEFAULT_INPUT_ID && deviceId !== SYSTEM_AUDIO_ID;
  const raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  const first: MediaTrackConstraints = { channelCount: { ideal: 2 }, ...raw };
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
  private sp?: ScriptProcessorNode;      // 오디오 스레드 하트비트 (Worker 가 멈춰도 분석 구동)
  private thruOn = false;
  private keepOsc?: OscillatorNode;
  private keepGain?: GainNode;
  private trimOn = false;
  private trimIntDb = -120;              // 단기 통합 레벨 (활성 구간만 · dB 영역 평균)
  private trimInit = false;
  private trimLastAt = 0;
  private startedAt = 0;
  trimDb = 0;                            // 현재 적용 중인 오프셋 게인 (dB)
  mode: InputMode = 'console';
  usbPicked = false;
  /** 오디오 스레드 콜백 (ScriptProcessor) — 분석기에서 Worker 틱 대체용으로 연결 */
  onAudioBeat: () => void = () => {};
  private fullAcc = { sumSq: 0, n: 0, peak: 0 };
  /** 100ms 마다 쌓는 대역별 단기 레벨(dB) 시리즈: [low, mid, highMid] */
  private series: number[][] = [[], [], []];
  /** 노이즈 게이트 (실시간 재생음 모드): Raw RMS 가 임계값 아래로 1.5초 이상이면 무음 대기 */
  private gateOn = false;
  gateDb = -38;
  idle = false;
  private belowSince = 0;
  private aboveCount = 0;
  onIdleChange: (idle: boolean) => void = () => {};
  onEnded: () => void = () => {};     // 시스템 오디오 공유가 사용자에 의해 종료될 때
  channels = 0;
  running = false;
  openInfo: OpenInfo | null = null;
  ctxState = '';

  /**
   * console : getUserMedia 무보정 스테레오(EC/NS/AGC OFF) · 3단계 Fallback · Auto-Trim 기본 OFF(Raw dBFS)
   * monitor : 데스크탑 = getDisplayMedia 시스템 오디오 / 모바일 = 기기 마이크 수음 스트림 · Auto-Trim 기본 ON
   */
  async start(mode: InputMode, deviceId?: string) {
    await this.stop();
    let step: 1 | 2 | 3 = 1;
    this.mode = mode;
    let label = '';
    if (mode === 'monitor' && systemCaptureSupported()) {
      // 🖥️ 데스크탑: 탭/시스템 오디오 캡처 (유튜브 재생음 그대로)
      const md: any = navigator.mediaDevices;
      const ds: MediaStream = await md.getDisplayMedia({
        video: true,
        audio: { channelCount: 2, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include',
      });
      if (!ds.getAudioTracks().length) {
        ds.getTracks().forEach(t => t.stop());
        throw new Error('공유한 소스에 오디오가 없습니다 (공유 창에서 "오디오 공유"를 체크하세요)');
      }
      // 비디오 트랙은 분석에 쓰지 않음: stop() 하면 일부 브라우저가 공유 전체를 끝내므로 비활성화 + 최소 사양
      ds.getVideoTracks().forEach(t => {
        t.enabled = false;
        t.applyConstraints({ frameRate: 1, width: 2, height: 2 }).catch(() => {});
        ds.removeTrack(t);
      });
      this.stream = ds;
      label = '🖥️ 시스템/탭 오디오 캡처';
    } else {
      // 콘솔: 선택한 장치 / 기본값이거나 모바일 모니터링이면 연결된 USB 인터페이스(루프백 포함)를 내장 마이크보다 먼저 연다
      let id = mode === 'console' ? deviceId : undefined;
      let usb = false;
      if (!id || id === DEFAULT_INPUT_ID) {
        const u = await findUsbInput().catch(() => null);
        if (u) { id = u.deviceId; usb = true; }
      }
      const o = await openInput(id);
      this.stream = o.stream; step = o.step;
      if (usb && step === 1) label = '';
      this.usbPicked = usb && step === 1;
    }
    const track = this.stream!.getAudioTracks()[0];
    track.addEventListener('ended', () => { if (this.running) this.onEnded(); });
    const settings = track.getSettings();
    this.channels = settings.channelCount ?? 0;
    this.openInfo = { step, label: label || track.label || '', settings, usb: this.usbPicked };

    const ctx = new AudioContext({ latencyHint: 'interactive' });
    // resume() 이 자동재생 정책 때문에 끝나지 않는 경우에도 시작이 멈추지 않도록 1.5초만 기다림
    await Promise.race([ctx.resume().catch(() => {}), new Promise(r => setTimeout(r, 1500))]);
    this.ctx = ctx;
    this.ctxState = ctx.state;
    ctx.onstatechange = () => { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); };   // 백그라운드 전환 시 자동 복구
    const src = ctx.createMediaStreamSource(this.stream!);
    if (this.thruOn) src.connect(ctx.destination);   // 🎧 Thru ON 상태 유지 (원본 그대로 · 보정 전)
    this.src = src;
    // Auto-Trim: 원본 → trim(게인) → 모든 분석 노드.  원본 레벨은 anRaw 로 따로 측정
    const trim = ctx.createGain();
    trim.gain.value = 1;
    src.connect(trim);
    this.trim = trim;
    this.trimDb = 0; this.trimIntDb = -120; this.trimInit = false; this.trimLastAt = 0; this.startedAt = performance.now();
    const an = trim;   // 이하 분석 노드는 모두 trim 출력에 연결
    // 무음 싱크: 분석기를 destination에 연결해 Safari 등에서도 처리가 멈추지 않게 함 (소리는 나가지 않음)
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);

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
    // AudioContext 내부 무음 노드(15Hz -50dBFS) + ScriptProcessor 하트비트: <audio> 태그 없이 백그라운드 오디오 처리 유지
    try { this.startKeepNodes(src); } catch (e) { console.warn('백그라운드 유지 노드 실패 (분석은 계속)', e); }
    this.specAcc.fill(0); this.specN = 0;
    this.fbTrack = { bin: -1, n: 0, maxDb: -200 };
    this.running = true;
  }

  async stop() {
    this.running = false;
    if (this.sp) { this.sp.onaudioprocess = null; try { this.sp.disconnect(); } catch { /* ignore */ } }
    this.stream?.getTracks().forEach(t => t.stop());
    await this.ctx?.close().catch(() => {});
    this.ctx = undefined; this.stream = undefined; this.src = undefined; this.bandAn = [];
    this.trim = undefined; this.anRaw = []; this.sp = undefined;
    this.anL = undefined; this.anR = undefined; this.anFb = undefined;
    this.keepOsc = undefined; this.keepGain = undefined;
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
  /** 열려 있는 입력 스트림 (WebRTC 루프백 유지용) */
  get inputStream(): MediaStream | undefined { return this.stream; }

  /** 🎧 입력 신호 출력 모니터링: 원본 입력을 audioContext.destination 으로 직접 연결/해제 (하울링 주의) */
  setThru(on: boolean) {
    this.thruOn = on;
    if (!this.ctx || !this.src) return;
    try { if (on) this.src.connect(this.ctx.destination); else this.src.disconnect(this.ctx.destination); } catch { /* ignore */ }
  }

  /** 노이즈 게이트 설정 (실시간 재생음 모드에서만 켬). 끄면 즉시 무음 대기 해제 */
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
    this.resetAccum();                 // 게이트 닫히기 전 1.5초 동안 쌓인 소음도 버림
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
    const rawDb = toDb(Math.sqrt(pw));
    const now = performance.now();
    if (this.gateOn) {
      if (rawDb < this.gateDb) {
        this.aboveCount = 0;
        if (!this.belowSince) this.belowSince = now;
        if (!this.idle && now - this.belowSince >= 1500) this.enterIdle();
      } else {
        this.belowSince = 0;
        if (this.idle && ++this.aboveCount >= 2) this.exitIdle();   // 0.2초 연속 신호 → 자동 분석 재개
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

  /** AudioContext 내부 무음 노드 + ScriptProcessor 하트비트 (유튜브 오디오 포커스를 뺏지 않음) */
  private startKeepNodes(src: AudioNode) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    // 크롬은 출력이 약 -72 dBFS 미만이면 '무음 탭'으로 보고 백그라운드에서 멈출 수 있어 들리지 않는 15Hz 를 -50 dBFS 로 낸다
    g.gain.value = 0.00316;
    o.frequency.value = 15;
    o.connect(g); g.connect(ctx.destination);
    o.start();
    this.keepOsc = o; this.keepGain = g;
    // ScriptProcessor: 오디오 스레드가 4096 샘플마다 호출 → 메인 스레드 타이머가 늦어져도 분석 루프를 깨움
    const sp = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain(); mute.gain.value = 0;
    src.connect(sp); sp.connect(mute); mute.connect(ctx.destination);
    sp.onaudioprocess = () => { try { this.onAudioBeat(); } catch { /* ignore */ } };
    this.sp = sp;
  }

  /** L/R 입력 레벨 (rAF/타이머에서 호출) */
  readLevels(): [ChannelLevel, ChannelLevel] | null {
    if (!this.anL || !this.anR) return null;
    if (this.idle) return [{ rmsDb: -120, peakDb: -120, clip: false }, { rmsDb: -120, peakDb: -120, clip: false }];   // 무음 대기: 미터 -∞
    const now = performance.now();
    const out = [this.anL, this.anR].map((an, i) => {
      an.getFloatTimeDomainData(this.buf);
      let sum = 0, peak = 0;
      for (let k = 0; k < this.buf.length; k++) {
        const v = Math.abs(this.buf[k]);
        sum += v * v; if (v > peak) peak = v;
      }
      const rmsDb = toDb(Math.sqrt(sum / this.buf.length));
      const peakDb = toDb(peak);
      if (peak >= 0.99 && !this.trimOn) this.clipUntil[i] = now + 2000;   // Auto-Trim 중에는 보정 후 값이라 CLIP 판정 안 함
      if (peakDb >= this.peakHold[i] || now - this.peakHoldAt[i] > 1200) {
        this.peakHold[i] = peakDb; this.peakHoldAt[i] = now;
      }
      return { rmsDb, peakDb: this.peakHold[i], clip: now < this.clipUntil[i] };
    });
    return [out[0], out[1]];
  }

  /** 100ms 틱마다 호출: 6밴드·전대역 누적 */
  pollBands() {
    if (this.idle) return;                       // 무음 대기 중에는 누적하지 않음
    this.bandAn.forEach((an, i) => {
      an.getFloatTimeDomainData(this.buf);
      const acc = this.bandAcc[i];
      let sq = 0;
      for (let k = 0; k < this.buf.length; k++) {
        const v = this.buf[k];
        sq += v * v;
        const a = Math.abs(v);
        if (a > acc.peak) acc.peak = a;
      }
      acc.sumSq += sq;
      acc.n += this.buf.length;
      const si = i === 1 ? 0 : i === 3 ? 1 : i === 4 ? 2 : -1;   // Low / Mid / High-Mid 단시간 레벨 → 트랜지언트·잔향 분석
      if (si >= 0) {
        const ser = this.series[si];
        ser.push(toDb(Math.sqrt(sq / this.buf.length)));
        if (ser.length > 1200) ser.splice(0, 200);
      }
    });
    // 전 대역 Crest Factor (L+R 합산, Peak 대비 RMS)
    for (const an of [this.anL, this.anR]) {
      if (!an) continue;
      an.getFloatTimeDomainData(this.buf);
      const f = this.fullAcc;
      for (let k = 0; k < this.buf.length; k++) {
        const v = this.buf[k];
        f.sumSq += v * v;
        const a = Math.abs(v);
        if (a > f.peak) f.peak = a;
      }
      f.n += this.buf.length;
    }
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
    const d = this.fbBuf;
    this.anFb.getFloatFrequencyData(d);
    for (let k = 0; k < d.length; k++) this.specAcc[k] += Math.pow(10, d[k] / 10); // 평균 스펙트럼 누적
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
