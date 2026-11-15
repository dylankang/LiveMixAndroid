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
/** 1번째 줄 오른쪽 위의 쿨다운 개수 칸 */
const BADGE_W = 120;
const BADGE_ID = LINES + 1;
const TAP_GAP_MS = 1200;   // 탭 이벤트가 겹쳐 와도 한 번만 처리

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
  /** 안경 다리(터치패드) 한 번 터치 */
  onTap: () => void = () => {};
  private lastTap = 0;
  /** 오른쪽 위 쿨다운 개수 칸: 'box' = 별도 컨테이너 · 'inline' = 1번째 줄 끝에 붙여 표시 */
  private badgeMode: 'box' | 'inline' = 'box';
  private badge = '';
  private shownBadge = '\u0000';
  get connected() { return this.state === 'ready' || this.state === 'text-fallback'; }

  /** 브리지가 준비되면 true. 브리지가 없는 일반 브라우저에서는 끝나지 않을 수 있다 (화면 쪽은 기다리지 않음) */
  async init(): Promise<boolean> {
    let bridge: any;
    try { bridge = await waitForEvenAppBridge(); } catch (e) { this.set('failed', String(e)); return false; }
    if (!bridge) { this.set('failed', '브리지 없음'); return false; }
    this.bridge = bridge;

    // 5줄 + (가능하면) 1번째 줄 오른쪽 위의 쿨다운 개수 칸
    const objs = (withBadge: boolean) => {
      const list = Array.from({ length: LINES }, (_, i) => new TextContainerProperty({
        xPosition: 0, yPosition: i * LH, width: i === 0 && withBadge ? W - BADGE_W : W, height: LH,
        borderWidth: 0, borderColor: 5, paddingLength: 2,
        containerID: i + 1, containerName: `line${i + 1}`,
        content: ' ',
        isEventCapture: i === 0 ? 1 : 0, // 이벤트 캡처 컨테이너는 정확히 1개 (더블탭 수신)
      }));
      if (withBadge) list.push(new TextContainerProperty({
        xPosition: W - BADGE_W, yPosition: 0, width: BADGE_W, height: LH,
        borderWidth: 0, borderColor: 5, paddingLength: 2,
        containerID: BADGE_ID, containerName: 'cdcount', content: ' ', isEventCapture: 0,
      }));
      return list;
    };
    const build = async (withBadge: boolean) => {
      const n = withBadge ? LINES + 1 : LINES;
      try {
        const res = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({ containerTotalNum: n, textObject: objs(withBadge) }));
        if (Number(res ?? 0) === 0) return true;
        console.warn('createStartUpPageContainer 결과:', res);
      } catch (e) { console.warn('createStartUpPageContainer 실패', e); }
      if (typeof bridge.rebuildPageContainer === 'function') {   // 이미 시작 페이지가 있는 경우(모드 전환·새로고침)
        try {
          const Rebuild = (SDK as any).RebuildPageContainer;
          const arg = { containerTotalNum: n, textObject: objs(withBadge) };
          const r = await bridge.rebuildPageContainer(Rebuild ? new Rebuild(arg) : arg);
          if (r !== false) return true;
        } catch (e) { console.warn('rebuildPageContainer 실패', e); }
      }
      return false;
    };
    let ok = await build(true);
    if (ok) this.badgeMode = 'box';
    else { ok = await build(false); this.badgeMode = 'inline'; }   // 6칸이 안 되면 기존 5줄 + 1번째 줄 끝에 개수 표시

    // 문서화된 컨테이너 방식이 안 될 때만 쓰는 예비 경로: 브리지/전역 객체에 텍스트 전송 함수가 있으면 사용
    const w = window as any;
    for (const [obj, name] of [[bridge, 'sendText'], [w.EvenAppBridge, 'sendText'], [w.EvenAppBridge, 'showText']] as const) {
      if (obj && typeof obj[name] === 'function') this.textFns.push((t: string) => obj[name](t));
    }

    try {
      const L = OsEventTypeList as any;
      const CLICK = L?.CLICK_EVENT ?? 0, LONG = L?.LONG_PRESS_EVENT ?? 9;
      bridge.onEvenHubEvent?.((ev: any) => {
        const e = ev?.textEvent ?? ev?.listEvent ?? ev?.sysEvent;
        if (!e) return;
        // 한 번 터치(CLICK_EVENT = 0)는 eventType 이 비어서(undefined) 오는 경우도 있다 (SDK 문서)
        const t = e.eventType ?? CLICK;
        if (t === CLICK) {                      // 안경 다리 한 번 터치 → 쿨다운 목록 초기화
          const now = Date.now();
          if (now - this.lastTap < TAP_GAP_MS) return;
          this.lastTap = now;
          try { this.onTap(); } catch (err) { console.warn('터치 처리 실패', err); }
        } else if (t === LONG) {                // 길게 누르기 → 시스템 종료 확인 창 (루트 페이지는 shutDownPageContainer(1) 로 종료)
          bridge.shutDownPageContainer(1);
        }
      });
    } catch { /* ignore */ }

    if (ok) this.set('ready');
    else if (this.textFns.length) this.set('text-fallback');
    else { this.set('failed', 'G2 화면 생성 실패'); return false; }
    this.flush();
    return true;
  }

  private set(s: GlassesState, d?: string) { this.state = s; this.onState(s, d); }

  /** 오른쪽 위 쿨다운 개수 (0 이면 비움) */
  setCooldownCount(n: number) {
    this.badge = n > 0 ? `쿨다운 ${n}` : '';
    this.flush();
  }

  /** 5줄 전체를 받는다. 브리지 준비 전이면 보관했다가 준비되는 즉시 전송 */
  update(lines: string[]) {
    this.pending = Array.from({ length: LINES }, (_, i) => String(lines[i] ?? ''));
    this.flush();
  }

  private flush() {
    if (this.state === 'ready') {
      if (this.badgeMode === 'box') {
        const content = this.badge || ' ';
        if (content !== this.shownBadge) {
          this.shownBadge = content;
          this.chain = this.chain.then(() =>
            this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: BADGE_ID, containerName: 'cdcount', content })),
          ).catch((e: unknown) => { console.warn('glasses badge failed', e); this.shownBadge = '\u0000'; });
        }
      }
      this.pending.forEach((raw0, i) => {
        const raw = i === 0 && this.badgeMode === 'inline' && this.badge ? `${raw0}${raw0 ? '  ' : ''}[${this.badge}]` : raw0;
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
      const text = (this.badge ? [`${this.pending[0]}${this.pending[0] ? '  ' : ''}[${this.badge}]`, ...this.pending.slice(1)] : this.pending).join('\n');
      if (text === this.lastText) return;
      this.lastText = text;
      for (const f of this.textFns) { try { void f(text); } catch (e) { console.warn('sendText 실패', e); } }
    }
  }
}
