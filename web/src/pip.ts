// 📌 Picture-in-Picture 미니 모니터 (휴대폰 '꺼짐 방지'용)
// 캔버스(L/R 미터 + 피드백 경고 + 최신 조언 2줄)를 PiP 창으로 띄워, Even 앱 등으로 전환해도 크롬이 화면에 떠 있는 상태로 분석을 계속하게 한다.
import type { LevelPkt } from './link';

export type PipState = 'off' | 'starting' | 'on' | 'failed' | 'unsupported';

export const pipSupported = () =>
  !!(document as any).pictureInPictureEnabled && typeof HTMLVideoElement !== 'undefined' &&
  'requestPictureInPicture' in HTMLVideoElement.prototype && typeof HTMLCanvasElement.prototype.captureStream === 'function';

export class PipMonitor {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private video: HTMLVideoElement | null = null;
  state: PipState = pipSupported() ? 'off' : 'unsupported';
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
    c.font = 'bold 16px "Noto Sans KR", system-ui, sans-serif';   // 한 줄 최대(한글 약 28자)가 480px 폭에 들어가는 크기
    rows.slice(0, 3).forEach((t, i) => {
      c.fillStyle = i === 0 && t.startsWith('⚠') ? '#ff5a4d' : '#39ff7a';
      c.fillText(t, 10, 120 + i * 44);
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
