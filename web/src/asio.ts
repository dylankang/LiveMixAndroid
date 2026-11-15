// 🎛️ 로컬 ASIO 브릿지 클라이언트 (ws://localhost:9876)
// 브라우저는 ASIO 드라이버에 직접 접근할 수 없으므로, PC 에서 실행한 asio-bridge/bridge.py 가
// ASIO 장치 목록을 알려 주고, 선택한 장치의 L/R 두 채널을 실시간 PCM(Float32 인터리브 스테레오)으로 보내 준다.
//
// 프로토콜 (텍스트 = JSON 제어, 바이너리 = PCM)
//  브릿지 → 웹:  {type:'hello'|'devices', devices:[{id,name,channels,sampleRate,hostapi}]}
//               {type:'opened', device, name, sampleRate, channels, l, r}   {type:'closed'}   {type:'error', message}
//               <ArrayBuffer>  Float32 LE · [L0,R0,L1,R1,…]
//  웹 → 브릿지:  {type:'list'}  {type:'open', device, l, r}  {type:'route', l, r}  {type:'close'}
export const ASIO_URL = 'ws://localhost:9876';

export interface AsioDevice { id: number; name: string; channels: number; sampleRate: number; hostapi: string }
export interface AsioOpened { device: number; name: string; sampleRate: number; channels: number; l: number; r: number }
export type AsioState = 'off' | 'connecting' | 'on';

const RETRY_MS = 5000;

export class AsioBridge {
  state: AsioState = 'off';
  devices: AsioDevice[] = [];
  opened: AsioOpened | null = null;
  lastError = '';
  private ws: WebSocket | null = null;
  private timer = 0;
  private pending: { resolve: (o: AsioOpened) => void; reject: (e: Error) => void; to: number } | null = null;
  /** 연결 상태·장치 목록이 바뀔 때 */
  onChange: () => void = () => {};
  /** PCM 블록 수신 (Float32 인터리브 스테레오) */
  onPcm: (buf: ArrayBuffer) => void = () => {};
  /** 열려 있던 장치 스트림이 끊겼을 때 (브릿지 종료 등) */
  onLost: () => void = () => {};

  private url: string;
  constructor(url = ASIO_URL) { this.url = url; }

  /** 연결을 시도하고, 끊기면 5초마다 자동 재시도 (브릿지를 나중에 켜도 자동으로 잡힘) */
  start() { this.connect(); }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.connect(), RETRY_MS);
  }

  private set(s: AsioState) { if (this.state !== s) { this.state = s; this.onChange(); } }

  private connect() {
    if (this.ws) return;
    this.set('connecting');
    let ws: WebSocket;
    try { ws = new WebSocket(this.url); } catch { this.set('off'); this.schedule(); return; }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => { this.set('on'); this.send({ type: 'list' }); };
    ws.onmessage = e => {
      if (typeof e.data !== 'string') { this.onPcm(e.data as ArrayBuffer); return; }
      let m: any;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'hello' || m.type === 'devices') {
        this.devices = Array.isArray(m.devices) ? m.devices.map((d: any) => ({
          id: Number(d.id), name: String(d.name ?? ''), channels: Number(d.channels) || 2,
          sampleRate: Number(d.sampleRate) || 48000, hostapi: String(d.hostapi ?? 'ASIO'),
        })) : [];
        this.onChange();
      } else if (m.type === 'opened') {
        this.opened = { device: Number(m.device), name: String(m.name ?? ''), sampleRate: Number(m.sampleRate) || 48000, channels: Number(m.channels) || 2, l: Number(m.l) || 0, r: Number(m.r) || 0 };
        const p = this.pending; this.pending = null;
        if (p) { clearTimeout(p.to); p.resolve(this.opened); }
        this.onChange();
      } else if (m.type === 'error') {
        this.lastError = String(m.message ?? '알 수 없는 오류');
        const p = this.pending; this.pending = null;
        if (p) { clearTimeout(p.to); p.reject(new Error(`ASIO 브릿지: ${this.lastError}`)); }
        else console.warn('ASIO 브릿지 오류', this.lastError);
      } else if (m.type === 'closed') {
        const was = !!this.opened;
        this.opened = null;
        if (was) this.onLost();
        this.onChange();
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.devices = [];
      const was = !!this.opened;
      this.opened = null;
      const p = this.pending; this.pending = null;
      if (p) { clearTimeout(p.to); p.reject(new Error('ASIO 브릿지 연결이 끊겼습니다')); }
      this.set('off');
      this.onChange();
      if (was) this.onLost();
      this.schedule();
    };
    ws.onerror = () => { /* onclose 에서 처리 */ };
  }

  private send(m: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  /** 장치를 열고 L/R 채널(0부터) 스트리밍 시작. 브릿지가 실제 샘플레이트·채널 수를 알려 준다 */
  open(device: number, l: number, r: number): Promise<AsioOpened> {
    if (this.state !== 'on') return Promise.reject(new Error('ASIO 브릿지가 연결되어 있지 않습니다 (asio-bridge/bridge.py 를 실행하세요)'));
    if (this.pending) { clearTimeout(this.pending.to); this.pending.reject(new Error('다른 장치 열기 요청으로 취소됨')); }
    return new Promise((resolve, reject) => {
      const to = window.setTimeout(() => { this.pending = null; reject(new Error('ASIO 장치 열기 시간 초과 (8초)')); }, 8000);
      this.pending = { resolve, reject, to };
      this.send({ type: 'open', device, l, r });
    });
  }

  /** 스트리밍 중 L/R 채널 변경 */
  route(l: number, r: number) { this.send({ type: 'route', l, r }); }

  close() {
    this.send({ type: 'close' });
    this.opened = null;
  }
}
