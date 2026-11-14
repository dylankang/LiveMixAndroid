// 🛡️ 백그라운드 유지 엔진 — 크롬을 내리거나 Even 앱으로 전환해도 분석이 멈추지 않게 한다.
// 안드로이드 크롬의 AudioPowerMonitor 는 '무음(디지털 0/극소)' 재생을 가짜 재생으로 보고 백그라운드에서 오디오 서비스를 끊는다.
// 따라서 Keep-Alive <audio> 는 반드시 volume 1.0 · muted false 로, 실제 에너지가 있는 파일럿 톤(-43dBFS 19kHz + 저역 + 디더)을 재생한다.
//  A. WebRTC 루프백: AudioContext 가 만든 '파일럿 톤' 스트림(입력 신호 아님)을 pc1 → pc2 → <audio> 로 재생
//  B. 파일럿 WAV <audio loop> (+ audioSession 'playback' · MediaSession 알림 컨트롤러에 마지막 조언 표시)
//  C. Picture-in-Picture 미니 모니터: 캔버스(미터 + HUD 5줄)를 PiP 창으로 띄워 크롬을 화면 표시 상태로 유지
// 입력(USB) 스트림은 스피커로 직접 보내지 않고, -100dBFS(gain 0.00001)로만 파일럿 스트림에 섞어 WebRTC 루프백에 태운다
// (크롬이 입력 트랙을 '실시간 전송 중'으로 보게 해 백그라운드 캡처 음소거를 막음 · 출력은 들리지 않는 수준).
import type { LevelPkt } from './link';

export type KaState = 'off' | 'starting' | 'on' | 'failed' | 'unsupported';

// ───────── B. 파일럿 WAV (2초 · 48kHz · 19kHz -43dBFS + 40Hz -48dBFS + -60dBFS 디더, 합성 약 -44dBFS RMS) ─────────
function makePilotWav(sec = 2, rate = 48000): Blob {
  const n = sec * rate;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, t: string) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  const lin = (db: number) => Math.pow(10, db / 20) * 32767;
  const a19 = lin(-43), a40 = lin(-48), aNoise = lin(-60);
  let seed = 12345;                                     // 고정 시드 → 매번 같은 파일
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  for (let i = 0; i < n; i++) {
    // 2초에 19kHz 는 38000주기, 40Hz 는 80주기 → 루프 이음새 없음
    const x = a19 * Math.sin(2 * Math.PI * 19000 * i / rate) + a40 * Math.sin(2 * Math.PI * 40 * i / rate) + aNoise * rnd();
    v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(x))), true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** 보이지 않지만 '진짜 재생 중'인 <audio>: volume 1.0 · muted false (0/음소거는 무음 판정 대상) */
const audibleEl = (el: HTMLAudioElement): HTMLAudioElement => {
  el.setAttribute('playsinline', ''); el.setAttribute('aria-hidden', 'true');
  el.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-10px;top:-10px';
  el.volume = 1.0; el.muted = false;
  document.body.appendChild(el);
  return el;
};

export class KeepAlive {
  rtc: KaState = 'off';
  wav: KaState = 'off';
  private pc1: RTCPeerConnection | null = null;
  private pc2: RTCPeerConnection | null = null;
  private rtcEl: HTMLAudioElement | null = null;
  private wavEl: HTMLAudioElement | null = null;
  private wavUrl = '';
  private active = false;
  private onResume: () => void = () => {};
  private title = '';
  private artist = '';
  private shown = '';
  onChange: () => void = () => {};

  /** [시작] 클릭(사용자 동작) 안에서 호출. pilot = AudioContext 가 만든 파일럿 톤 스트림 (입력 신호 아님) */
  async start(pilot: MediaStream | undefined, onResume: () => void) {
    this.active = true; this.onResume = onResume;
    this.setSession();
    await Promise.all([this.startRtc(pilot), this.startWav()]);
    this.shown = ''; this.applyMeta();
  }

  stop() {
    this.active = false;
    this.stopRtc(); this.stopWav();
    try { const ms: any = (navigator as any).mediaSession; if (ms) { ms.metadata = null; ms.playbackState = 'none'; } } catch { /* ignore */ }
    this.shown = '';
  }

  /** 잠금화면/알림창 미디어 컨트롤러에 보일 문구 (마지막 조언 한 줄). 바뀔 때만 갱신 */
  setNowPlaying(title: string, artist: string) {
    this.title = title.slice(0, 80); this.artist = artist.slice(0, 80);
    if (this.active) this.applyMeta();
  }

  /** 100ms 틱마다 호출(가벼움): 시스템이 멈춘 재생을 즉시 재개하고 미디어 세션 상태를 '재생 중'으로 유지 */
  heal() {
    if (!this.active) return;
    if (this.wav === 'on' && this.wavEl?.paused) this.wavEl.play().catch(() => {});
    if (this.rtc === 'on' && this.rtcEl?.paused) this.rtcEl.play().catch(() => {});
    if (this.rtc === 'on' && this.pc1 && /failed|closed/.test(this.pc1.connectionState)) { this.rtc = 'failed'; this.onChange(); }
    try {
      const ms: any = (navigator as any).mediaSession;
      if (ms && ms.playbackState !== 'playing') ms.playbackState = 'playing';
      if (ms && !ms.metadata) { this.shown = ''; this.applyMeta(); }
    } catch { /* ignore */ }
  }

  private setSession() {
    try {
      // 안드로이드 OS 의 영구 오디오 포커스/포그라운드 미디어 서비스를 점유 (지원 브라우저에서만 동작)
      const as: any = (navigator as any).audioSession;
      if (as && 'type' in as) as.type = 'playback';
    } catch { /* ignore */ }
    try {
      const ms: any = (navigator as any).mediaSession;
      if (!ms) return;
      const back = () => { this.replay(); };
      for (const act of ['play', 'pause', 'stop']) {
        try { ms.setActionHandler(act, back); } catch { /* 미지원 액션 */ }
      }
    } catch { /* ignore */ }
  }

  /** 외부(알림창/블루투스/다른 앱)에서 일시정지가 와도 즉시 다시 재생 + AudioContext 재개 */
  private replay() {
    this.wavEl?.play().catch(() => {});
    this.rtcEl?.play().catch(() => {});
    try { const ms: any = (navigator as any).mediaSession; if (ms) ms.playbackState = 'playing'; } catch { /* ignore */ }
    try { this.onResume(); } catch { /* ignore */ }
  }

  private applyMeta() {
    try {
      const ms: any = (navigator as any).mediaSession;
      if (!ms || typeof (window as any).MediaMetadata !== 'function') return;
      const title = this.title || 'Live Mix Assistant 분석 중';
      const artist = this.artist || 'G2 HUD';
      const sig = title + '\n' + artist;
      if (sig === this.shown) return;
      ms.metadata = new (window as any).MediaMetadata({ title, artist, album: 'Live Mix Assistant' });
      ms.playbackState = 'playing';
      this.shown = sig;
    } catch { /* ignore */ }
  }

  private guard(el: HTMLAudioElement) {
    el.addEventListener('pause', () => { if (this.active) { el.play().catch(() => {}); this.onResume(); } });
  }

  // ───────── A. WebRTC 루프백 (파일럿 톤 스트림) ─────────
  private async startRtc(pilot: MediaStream | undefined) {
    this.stopRtc();
    if (typeof RTCPeerConnection === 'undefined') { this.rtc = 'unsupported'; this.onChange(); return; }
    if (!pilot || !pilot.getAudioTracks().length) { this.rtc = 'failed'; this.onChange(); return; }
    this.rtc = 'starting'; this.onChange();
    try {
      const pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
      this.pc1 = pc1; this.pc2 = pc2;
      pc1.onicecandidate = e => { if (e.candidate) pc2.addIceCandidate(e.candidate).catch(() => {}); };
      pc2.onicecandidate = e => { if (e.candidate) pc1.addIceCandidate(e.candidate).catch(() => {}); };
      const el = audibleEl(document.createElement('audio'));
      el.autoplay = true;
      this.guard(el);
      this.rtcEl = el;
      pc2.ontrack = e => { el.srcObject = e.streams[0] ?? new MediaStream([e.track]); el.play().catch(() => {}); };
      for (const t of pilot.getAudioTracks()) pc1.addTrack(t, pilot);
      const connected = new Promise<void>((res, rej) => {
        const to = setTimeout(() => rej(new Error('연결 시간 초과')), 8000);
        pc1.onconnectionstatechange = () => {
          if (pc1.connectionState === 'connected') { clearTimeout(to); res(); }
          else if (pc1.connectionState === 'failed') { clearTimeout(to); rej(new Error('연결 실패')); }
        };
      });
      const offer = await pc1.createOffer();
      await pc1.setLocalDescription(offer);
      await pc2.setRemoteDescription(offer);
      const answer = await pc2.createAnswer();
      await pc2.setLocalDescription(answer);
      await pc1.setRemoteDescription(answer);
      await connected;
      this.rtc = 'on';
    } catch (e) {
      console.warn('WebRTC 루프백 실패', e);
      this.rtc = 'failed';
    }
    this.onChange();
  }
  private stopRtc() {
    try { this.pc1?.close(); this.pc2?.close(); } catch { /* ignore */ }
    this.pc1 = this.pc2 = null;
    if (this.rtcEl) { this.rtcEl.srcObject = null; this.rtcEl.remove(); this.rtcEl = null; }
    if (this.rtc !== 'unsupported') this.rtc = 'off';
  }

  // ───────── B. 파일럿 WAV <audio loop> ─────────
  private async startWav() {
    if (!this.wavEl) {
      this.wavUrl = URL.createObjectURL(makePilotWav());
      const a = audibleEl(document.createElement('audio'));
      a.loop = true; a.autoplay = true; a.src = this.wavUrl;
      this.guard(a);
      this.wavEl = a;
    }
    this.wavEl.volume = 1.0; this.wavEl.muted = false;
    try {
      await this.wavEl.play();
      this.wav = 'on';
    } catch (e) { console.warn('파일럿 WAV 재생 실패', e); this.wav = 'failed'; }
    this.onChange();
  }
  private stopWav() {
    if (this.wavEl) { this.wavEl.pause(); this.wavEl.currentTime = 0; this.wavEl.remove(); this.wavEl = null; }
    if (this.wavUrl) { URL.revokeObjectURL(this.wavUrl); this.wavUrl = ''; }
    if (this.wav !== 'off') { this.wav = 'off'; this.onChange(); }
  }
}

// ───────── C. Picture-in-Picture 미니 모니터 ─────────
export const pipSupported = () =>
  !!(document as any).pictureInPictureEnabled && typeof HTMLVideoElement !== 'undefined' &&
  'requestPictureInPicture' in HTMLVideoElement.prototype && typeof HTMLCanvasElement.prototype.captureStream === 'function';

export class PipMonitor {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private video: HTMLVideoElement | null = null;
  state: KaState = pipSupported() ? 'off' : 'unsupported';
  onChange: () => void = () => {};

  constructor() { this.canvas.width = 480; this.canvas.height = 270; }
  get active() { return this.state === 'on'; }

  /** 100ms 틱마다 호출 (PiP 가 켜져 있을 때만 그림) */
  draw(levels: [LevelPkt, LevelPkt] | null, lines: string[], badge: string, status: string) {
    if (!this.active && this.state !== 'starting') return;
    const c = this.ctx, W = this.canvas.width, H = this.canvas.height;
    c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
    c.font = 'bold 15px system-ui, sans-serif'; c.fillStyle = '#9fd8ff';
    c.fillText(badge.slice(0, 34), 10, 22);
    // L/R 미터
    ['L', 'R'].forEach((ch, i) => {
      const y = 34 + i * 22, x = 28, w = W - 110;
      const l = levels?.[i];
      const pct = (db: number) => Math.max(0, Math.min(1, (db + 60) / 60));
      c.fillStyle = '#39ff7a'; c.font = 'bold 14px system-ui'; c.fillText(ch, 10, y + 14);
      c.fillStyle = '#0a1a0f'; c.fillRect(x, y, w, 16);
      const r = l ? pct(l.rmsDb) : 0;
      c.fillStyle = r > 0.9 ? '#ff5a4d' : r > 0.75 ? '#ffd23d' : '#39ff7a'; c.fillRect(x, y, w * r, 16);
      if (l) { c.fillStyle = '#fff'; c.fillRect(x + w * pct(l.peakDb) - 1, y, 2, 16); }
      c.fillStyle = '#7b8f80'; c.font = '12px system-ui';
      c.fillText(l && l.rmsDb > -100 ? `${l.rmsDb.toFixed(1)} dB` : '-∞', x + w + 8, y + 13);
    });
    // 피드백 경고 1줄 + 최신 AI 조언 2줄
    const advice = lines.slice(1).filter(t => t.trim()).slice(-2);
    const rows = [lines[0] ?? '', ...advice, ...Array(Math.max(0, 2 - advice.length)).fill('')];
    c.font = 'bold 22px "Noto Sans KR", system-ui, sans-serif';
    rows.slice(0, 3).forEach((t, i) => {
      c.fillStyle = i === 0 && t.startsWith('⚠') ? '#ff5a4d' : '#39ff7a';
      c.fillText(t.slice(0, 22), 10, 120 + i * 44);
    });
    c.fillStyle = '#7b8f80'; c.font = '11px system-ui';
    c.fillText(status.slice(0, 60), 10, H - 6);
  }

  /** 버튼 클릭(사용자 동작) 안에서 호출 */
  async toggle(draw: () => void) {
    if (this.state === 'unsupported') return;
    if ((document as any).pictureInPictureElement) { await (document as any).exitPictureInPicture().catch(() => {}); return; }
    this.state = 'starting'; this.onChange();
    try {
      if (!this.video) {
        const v = document.createElement('video');
        v.muted = true; v.playsInline = true; v.autoplay = true;
        v.setAttribute('playsinline', '');
        v.style.cssText = 'position:fixed;width:2px;height:2px;opacity:0;pointer-events:none;left:-10px;top:-10px';
        document.body.appendChild(v);
        v.srcObject = this.canvas.captureStream(10);
        v.addEventListener('leavepictureinpicture', () => { this.state = 'off'; this.onChange(); });
        this.video = v;
      }
      draw();
      await this.video.play();
      if (this.video.readyState < 1) await new Promise(r => this.video!.addEventListener('loadedmetadata', r, { once: true }));
      await this.video.requestPictureInPicture();
      this.state = 'on';
    } catch (e) {
      console.warn('PiP 실패', e);
      this.state = 'failed';
    }
    this.onChange();
  }

  async close() {
    if ((document as any).pictureInPictureElement) await (document as any).exitPictureInPicture().catch(() => {});
    if (this.state !== 'unsupported') this.state = 'off';
    this.onChange();
  }
}
