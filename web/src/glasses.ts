import * as SDK from '@evenrealities/even_hub_sdk';
import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk';

const W = 576, H = 288, LINES = 5;
const LH = Math.floor(H / LINES); // 줄당 57px → 항상 정확히 5줄

export type GlassesState = 'waiting' | 'ready' | 'text-fallback' | 'failed';

/**
 * G2 HUD: 5개의 1줄짜리 텍스트 컨테이너. 바뀐 줄만 textContainerUpgrade 로 갱신(플리커 없음).
 * - 브리지가 늦게 준비돼도 포기하지 않고 기다렸다가, 그동안 받은 마지막 5줄을 바로 내보낸다.
 * - 같은 웹뷰에서 페이지를 다시 열어 createStartUpPageContainer 가 거부되면 rebuildPageContainer 로 다시 만든다.
 * - 컨테이너 방식이 모두 실패하고 브리지에 텍스트 전송 함수(sendText 등)가 있으면 lines.join('\n') 으로 보낸다.
 */
export class Glasses {
  private bridge: any = null;
  private shown: string[] = Array(LINES).fill('\u0000');
  private pending: string[] = Array(LINES).fill('');
  private chain: Promise<unknown> = Promise.resolve();
  private textFns: ((t: string) => unknown)[] = [];
  private lastText = '';
  state: GlassesState = 'waiting';
  onState: (s: GlassesState, detail?: string) => void = () => {};
  get connected() { return this.state === 'ready' || this.state === 'text-fallback'; }

  /** 브리지가 준비되면 true. 브리지가 없는 일반 브라우저에서는 끝나지 않을 수 있다 (화면 쪽은 기다리지 않음) */
  async init(): Promise<boolean> {
    let bridge: any;
    try { bridge = await waitForEvenAppBridge(); } catch (e) { this.set('failed', String(e)); return false; }
    if (!bridge) { this.set('failed', '브리지 없음'); return false; }
    this.bridge = bridge;

    const objs = () => Array.from({ length: LINES }, (_, i) => new TextContainerProperty({
      xPosition: 0, yPosition: i * LH, width: W, height: LH,
      borderWidth: 0, borderColor: 5, paddingLength: 2,
      containerID: i + 1, containerName: `line${i + 1}`,
      content: ' ',
      isEventCapture: i === 0 ? 1 : 0, // 이벤트 캡처 컨테이너는 정확히 1개
    }));

    let ok = false;
    try {
      const res = await bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer({ containerTotalNum: LINES, textObject: objs() }));
      ok = Number(res ?? 0) === 0;
      if (!ok) console.warn('createStartUpPageContainer 결과:', res);
    } catch (e) { console.warn('createStartUpPageContainer 실패', e); }

    if (!ok && typeof bridge.rebuildPageContainer === 'function') {   // 이미 시작 페이지가 있는 경우(모드 전환·새로고침)
      try {
        const Rebuild = (SDK as any).RebuildPageContainer;
        const arg = { containerTotalNum: LINES, textObject: objs() };
        const r = await bridge.rebuildPageContainer(Rebuild ? new Rebuild(arg) : arg);
        ok = r !== false;
      } catch (e) { console.warn('rebuildPageContainer 실패', e); }
    }

    // 문서화된 컨테이너 방식이 안 될 때만 쓰는 예비 경로: 브리지/전역 객체에 텍스트 전송 함수가 있으면 사용
    const w = window as any;
    for (const [obj, name] of [[bridge, 'sendText'], [w.EvenAppBridge, 'sendText'], [w.EvenAppBridge, 'showText']] as const) {
      if (obj && typeof obj[name] === 'function') this.textFns.push((t: string) => obj[name](t));
    }

    try {
      bridge.onEvenHubEvent?.((ev: any) => {   // 글래스 터치패드 더블탭 → 시스템 종료 확인 (루트 페이지 필수 규칙)
        const t = ev?.sysEvent?.eventType ?? ev?.textEvent?.eventType;
        if (t !== undefined && t === (OsEventTypeList as any).DOUBLE_CLICK_EVENT) bridge.shutDownPageContainer(1);
      });
    } catch { /* ignore */ }

    if (ok) this.set('ready');
    else if (this.textFns.length) this.set('text-fallback');
    else { this.set('failed', 'G2 화면 생성 실패'); return false; }
    this.flush();
    return true;
  }

  private set(s: GlassesState, d?: string) { this.state = s; this.onState(s, d); }

  /** 5줄 전체를 받는다. 브리지 준비 전이면 보관했다가 준비되는 즉시 전송 */
  update(lines: string[]) {
    this.pending = Array.from({ length: LINES }, (_, i) => String(lines[i] ?? ''));
    this.flush();
  }

  private flush() {
    if (this.state === 'ready') {
      this.pending.forEach((raw, i) => {
        const content = raw.length ? raw : ' ';
        if (content === this.shown[i]) return;
        this.shown[i] = content;
        this.chain = this.chain.then(() =>
          this.bridge.textContainerUpgrade(new TextContainerUpgrade({
            containerID: i + 1, containerName: `line${i + 1}`, content,
          })),
        ).catch((e: unknown) => { console.warn('glasses update failed', e); this.shown[i] = '\u0000'; });
      });
    } else if (this.state === 'text-fallback') {
      const text = this.pending.join('\n');
      if (text === this.lastText) return;
      this.lastText = text;
      for (const f of this.textFns) { try { void f(text); } catch (e) { console.warn('sendText 실패', e); } }
    }
  }
}
