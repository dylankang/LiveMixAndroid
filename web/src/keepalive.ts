// 🛡️ 3중 백그라운드 유지 엔진 — 크롬을 내리거나 Even 앱/유튜브로 전환해도 분석이 멈추지 않게 한다.
//  A. 로컬 WebRTC 루프백(pc1 → pc2): 활성 RTCPeerConnection 이 있는 탭은 '실시간 통화 중'으로 취급되어 백그라운드 정지 대상에서 빠진다.
//  B. 실제 PCM WAV <audio loop> + MediaSession: OS 가 '미디어 재생 중' 앱으로 인식 (알림 표시)
//  C. Picture-in-Picture 미니 모니터: 캔버스(미터 + HUD 5줄)를 PiP 창으로 띄워 크롬을 화면 표시 상태로 유지
import type { LevelPkt } from './link';

export type KaState = 'off' | 'starting' | 'on' | 'failed' | 'unsupported';

// ───────── B. 초미세 신호 WAV (2초 · -65 dBFS · 40Hz 사인, 0 이 아닌 실제 PCM) ─────────
function makeKeepWav(sec = 2, rate = 22050): Blob {
  const n = sec * rate, amp = Math.pow(10, -65 / 20) * 32767;   // -65 dBFS ≈ 18 LSB
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, t: string) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(amp * Math.sin(2 * Math.PI * 40 * i / rate)) || 1, true);   // 2초에 정확히 80주기 → 이음새 없음
  return new Blob([buf], { type: 'audio/wav' });
}

const hiddenMedia = <T extends HTMLMediaElement>(el: T): T => {
  el.setAttribute('playsinline', ''); el.setAttribute('aria-hidden', 'true');
  el.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-10px;top:-10px';
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
  onChange: () => void = () => {};

  /** [시작] 클릭(사용자 동작) 안에서 호출 */
  async start(stream: MediaStream, useWav: boolean) {
    await Promise.all([this.startRtc(stream), useWav ? this.startWav() : Promise.resolve(this.stopWav())]);
  }

  stop() { this.stopRtc(); this.stopWav(); }

  /** 백그라운드에서 시스템이 멈춘 재생을 다시 시도 (1초마다 호출) */
  heal() {
    if (this.wav === 'on' && this.wavEl?.paused) this.wavEl.play().catch(() => {});
    if (this.rtc === 'on' && this.rtcEl?.paused) this.rtcEl.play().catch(() => {});
    if (this.rtc === 'on' && this.pc1 && /failed|closed/.test(this.pc1.connectionState)) { this.rtc = 'failed'; this.onChange(); }
    try { const ms: any = (navigator as any).mediaSession; if (ms && this.wav === 'on') ms.playbackState = 'playing'; } catch { /* ignore */ }
  }

  // ───────── A. 로컬 WebRTC 루프백 ─────────
  private async startRtc(stream: MediaStream) {
    this.stopRtc();
    if (typeof RTCPeerConnection === 'undefined') { this.rtc = 'unsupported'; this.onChange(); return; }
    this.rtc = 'starting'; this.onChange();
    try {
      const pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
      this.pc1 = pc1; this.pc2 = pc2;
      pc1.onicecandidate = e => { if (e.candidate) pc2.addIceCandidate(e.candidate).catch(() => {}); };
      pc2.onicecandidate = e => { if (e.candidate) pc1.addIceCandidate(e.candidate).catch(() => {}); };
      const el = hiddenMedia(document.createElement('audio'));
      el.autoplay = true;
      // 받은 스트림은 재생만 하고 소리는 내지 않는다 (입력 신호가 스피커로 나가면 하울링)
      el.muted = true; el.volume = 0;
      this.rtcEl = el;
      pc2.ontrack = e => { el.srcObject = e.streams[0] ?? new MediaStream([e.track]); el.play().catch(() => {}); };
      for (const t of stream.getAudioTracks()) pc1.addTrack(t, stream);
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

  // ───────── B. WAV <audio loop> + MediaSession ─────────
  private async startWav() {
    if (!this.wavEl) {
      this.wavUrl = URL.createObjectURL(makeKeepWav());
      const a = hiddenMedia(document.createElement('audio'));
      a.loop = true; a.autoplay = true; a.src = this.wavUrl; a.volume = 1;
      this.wavEl = a;
    }
    try {
      // 지원 브라우저에서는 다른 앱 소리와 섞이도록 (현재는 주로 Safari 계열에서 동작)
      const as: any = (navigator as any).audioSession;
      if (as && 'type' in as) as.type = 'ambient';
    } catch { /* ignore */ }
    try {
      await this.wavEl.play();
      this.wav = 'on';
      const ms: any = (navigator as any).mediaSession;
      if (ms) {
        if (typeof (window as any).MediaMetadata === 'function')
          ms.metadata = new (window as any).MediaMetadata({ title: 'Live Mix Assistant 분석 중', artist: '백그라운드 분석 유지', album: 'G2 HUD' });
        ms.playbackState = 'playing';
        for (const act of ['pause', 'stop']) {
          try { ms.setActionHandler(act, () => { void this.wavEl?.play(); ms.playbackState = 'playing'; }); } catch { /* ignore */ }
        }
      }
    } catch (e) { console.warn('WAV 유지 재생 실패', e); this.wav = 'failed'; }
    this.onChange();
  }
  private stopWav() {
    if (this.wavEl) { this.wavEl.pause(); this.wavEl.currentTime = 0; }
    try { const ms: any = (navigator as any).mediaSession; if (ms) { ms.metadata = null; ms.playbackState = 'none'; } } catch { /* ignore */ }
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
    // HUD 5줄
    c.font = '18px "Noto Sans KR", monospace';
    for (let i = 0; i < 5; i++) {
      const t = lines[i] ?? '';
      c.fillStyle = i === 0 && t.startsWith('⚠') ? '#ff5a4d' : '#39ff7a';
      c.fillText(t, 10, 104 + i * 30);
    }
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
