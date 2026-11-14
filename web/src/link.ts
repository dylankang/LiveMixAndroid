// 분석기(크롬) ↔ G2 HUD 수신기(Even Hub 웹뷰) 무설정 자동 연결
//  1) MQTT over WebSocket — 1순위 브로커 하나로 고정 (크롬·Even 앱이 항상 같은 브로커에서 만나도록)
//  2) BroadcastChannel('g2-live-mix-hud-v1') — 같은 브라우저 안
//  3) localStorage storage 이벤트            — BroadcastChannel 차단 시 백업
// 전체 상태 패킷(state)은 retain:true 로 발행 → 수신기는 언제 열리든 브로커에 남은 마지막 상태를 즉시 받는다.
// 실행 중이 아닌 분석기 화면은 아무것도 발행하지 않는다 (빈 HUD로 덮어쓰기 방지).
import { setTicker, later } from './ticker';

declare const mqtt: any;

export const CHANNEL = 'g2-live-mix-hud-v1';
export const MQTT_TOPIC = 'g2-live-mix-onax/hud/stream';
export const MQTT_URL = 'wss://broker.emqx.io:8084/mqtt';
const LIVE_MS = 3500;          // 이 시간 안에 상태 패킷이 오면 "실시간"
export const STALE_CLEAR_MS = 8000;   // 신호가 이만큼 끊기면 수신기 HUD·G2 렌즈의 오래된 조언을 지움
export const NO_SIGNAL_LINES = ['⏸ 분석기 신호 없음', '', '', '', ''];
const MAX_AGE_MS = 6 * 3600_000; // 이보다 오래된 retained 상태는 버림 (지난 공연 데이터)

export interface LevelPkt { rmsDb: number; peakDb: number; clip: boolean }
export interface BandRow { name: string; avgDb: number; crestDb: number; deltaDb: number | null; character: string; over: boolean }
export interface AiLog { at: number; text: string }
export interface MixState {
  running: boolean;
  lines: string[];                       // HUD 5줄
  bands: BandRow[] | null;               // 6개 대역
  levels: [LevelPkt, LevelPkt] | null;   // L/R
  genre: string;                         // 장르/모드 배지 텍스트
  genreAt: number;
  aiLog: AiLog | null;                   // 마지막 AI 응답 시각 + 원문(로컬 필터 결과 포함)
  status: string;                        // 분석기 상태 줄
  frozen?: boolean;                      // 분석기가 백그라운드로 가며 멈추기 직전에 보낸 마지막 패킷
}
export type Via = 'MQTT' | 'BC' | 'LS';
export type MqttState = 'off' | 'connecting' | 'on';

const rand = () => Math.random().toString(36).slice(2, 10);
const PAGE_ID = rand();                  // 같은 페이지가 보낸 패킷(MQTT 에코 등)을 무시하기 위한 ID

export const emptyState = (): MixState => ({
  running: false, lines: ['', '', '', '', ''], bands: null, levels: null, genre: '', genreAt: 0, aiLog: null, status: '',
});

interface PostOpts { mqtt?: boolean; ls?: boolean; retain?: boolean }
type Handler = (m: any, via: Via) => void;

/** 페이지당 하나의 연결 (MQTT 접속 1개를 송신기·수신기가 같이 씀) */
class Bus {
  private handlers: Handler[] = [];
  private bc: BroadcastChannel | null = null;
  private client: any = null;
  private state: MqttState = 'off';
  private upFns: (() => void)[] = [];
  private stateFns: (() => void)[] = [];

  constructor() {
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        this.bc = new BroadcastChannel(CHANNEL);
        this.bc.onmessage = e => this.recv(e.data, 'BC');
      }
    } catch { this.bc = null; }
    window.addEventListener('storage', e => {
      if (e.key === CHANNEL && e.newValue) { try { this.recv(JSON.parse(e.newValue), 'LS'); } catch { /* ignore */ } }
    });
    this.connectMqtt();

    // 앱 전환·화면 꺼짐에서 돌아오면, 끊겼을 수 있는 연결을 기다리지 않고 바로 새로 연결
    // (안드로이드는 백그라운드에서 웹소켓을 조용히 끊는 경우가 많고, 끊긴 걸 알아채는 데 수십 초가 걸린다)
    const wake = (why: string) => {
      const away = this.hiddenAt ? Date.now() - this.hiddenAt : 0;
      if (why === 'visible' && away < 3000 && this.client?.connected) return;
      this.reconnectNow();
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.hiddenAt = Date.now();
      else wake('visible');
    });
    window.addEventListener('pageshow', e => { if ((e as PageTransitionEvent).persisted) wake('pageshow'); });
    window.addEventListener('online', () => wake('online'));
    // 백그라운드에서 끊겼는데 close 이벤트가 늦게 오는 경우 대비: 5초마다 상태 확인 (Worker 타이머)
    setTicker(() => { if (this.state === 'on' && !this.client?.connected) this.reconnectNow(); }, 5000);
  }

  private hiddenAt = 0;
  private connecting = false;
  private downSince = 0;

  /** 오디오 틱(1초)에서 호출하는 워치독: 끊겼거나 접속 시도가 7초 넘게 멈춰 있으면 즉시 새로 연결 */
  watchdog() {
    if (typeof mqtt === 'undefined') return;
    if (this.client?.connected) { this.downSince = 0; return; }
    const now = Date.now();
    if (!this.downSince) this.downSince = now;
    if (!this.client || now - this.downSince > 7000) { this.downSince = now; this.reconnectNow(); }
  }

  /** 지금 연결을 버리고 즉시 새로 연결 */
  reconnectNow() {
    const old = this.client;
    this.client = null;
    if (old) { try { old.end(true); } catch { /* ignore */ } }
    this.connecting = false;
    this.connectMqtt();
  }

  on(h: Handler) { this.handlers.push(h); }
  onUp(f: () => void) { this.upFns.push(f); }
  onMqttState(f: () => void) { this.stateFns.push(f); }
  mqttState(): MqttState { return this.state; }
  private setState(s: MqttState) { if (this.state !== s) { this.state = s; this.stateFns.forEach(f => f()); } }

  private connectMqtt() {
    if (typeof mqtt === 'undefined') { this.setState('off'); return; }   // CDN 로드 실패 → BC/LS만 사용
    if (this.connecting) return;
    this.connecting = true;
    this.setState('connecting');
    let c: any;
    try {
      c = mqtt.connect(MQTT_URL, { clientId: `g2mix-${rand()}`, clean: true, keepalive: 15, connectTimeout: 6000, reconnectPeriod: 0 });
    } catch { this.connecting = false; later(() => this.connectMqtt(), 2000); return; }
    this.client = c;
    c.on('connect', () => {
      if (this.client !== c) { try { c.end(true); } catch { /* ignore */ } return; }
      this.connecting = false;
      c.subscribe(MQTT_TOPIC, { qos: 0 });   // 구독 즉시 retained 상태가 도착
      this.setState('on');
      this.upFns.forEach(f => f());
    });
    c.on('message', (_t: string, payload: any) => {
      const s = payload?.toString?.() ?? '';
      if (!s) return;
      try { this.recv(JSON.parse(s), 'MQTT'); } catch { /* ignore */ }
    });
    c.on('error', () => { /* close 에서 처리 */ });
    c.on('close', () => {
      if (this.client !== c) return;
      this.client = null;
      this.connecting = false;
      this.setState('connecting');
      try { c.end(true); } catch { /* ignore */ }
      later(() => { if (!this.client) this.connectMqtt(); }, 1500);   // 같은 1순위 브로커로만 재접속 (Worker 타이머)
    });
  }

  post(m: any, o: PostOpts = {}) {
    const pkt = { ...m, page: PAGE_ID };
    const json = JSON.stringify(pkt);
    try { this.bc?.postMessage(pkt); } catch { /* ignore */ }
    if (o.ls !== false) { try { localStorage.setItem(CHANNEL, json); } catch { /* ignore */ } }
    if (o.mqtt !== false && this.client?.connected) {
      try { this.client.publish(MQTT_TOPIC, json, { qos: 0, retain: !!o.retain }); } catch { /* ignore */ }
    }
  }

  private recv(m: any, via: Via) {
    if (!m || m.page === PAGE_ID) return;
    this.handlers.forEach(h => { try { h(m, via); } catch (e) { console.warn('link handler error', e); } });
  }
}

/** 오디오 틱 워치독용: MQTT 가 끊겨 있으면 바로 재연결 (재연결되면 마지막 분석 상태를 자동 재발행) */
export const linkWatchdog = () => bus().watchdog();

let busSingleton: Bus | null = null;
const bus = () => (busSingleton ??= new Bus());

export interface SenderInfo { receivers: number; mqtt: MqttState; via: Via[] }

/**
 * 분석기 쪽 송신기.
 * - publish(): 전체 상태를 MQTT(retain:true, qos:0) + BC + LS 로 발행 — 분석기가 1초마다, 그리고 HUD가 바뀌는 즉시 호출
 * - sendLevels(): L/R 레벨만 가볍게 (retain 없음)
 * - 실행 중이 아니면 아무것도 발행하지 않음 (정지 순간에 '정지됨' 상태를 한 번만 발행)
 */
export class HudSender {
  private sid = rand();
  private seq = 0;
  private st: MixState = emptyState();
  private rx = new Map<string, { t: number; via: Via }>();
  onState: (i: SenderInfo) => void = () => {};

  constructor() {
    const b = bus();
    b.on((m, via) => this.onRx(m, via));
    b.onUp(() => this.publish());
    b.onMqttState(() => this.emit());
    setTicker(() => this.emit(), 1000);
  }

  get state(): MixState { return this.st; }

  /** 상태 일부를 바꾸고, immediate=true 면 바로 발행 */
  update(p: Partial<MixState>, immediate = false) {
    this.st = { ...this.st, ...p };
    if (immediate) this.publish();
  }

  setRunning(b: boolean) {
    const was = this.st.running;
    this.st.running = b;
    if (b) { this.publish(); return; }
    if (was) {   // 정지: 수신기 HUD와 G2 렌즈를 비우도록 마지막 상태 한 번 발행
      this.st = { ...this.st, lines: ['', '', '', '', ''], levels: null };
      this.publish(true);
    }
  }

  publish(force = false) {
    if (!this.st.running && !force) return;
    bus().post({ t: 'state', sid: this.sid, seq: ++this.seq, ts: Date.now(), ...this.st }, { retain: true });
  }

  /** 크롬이 페이지를 멈추기 직전(freeze/pagehide): 수신기가 바로 오래된 조언을 지우도록 알림 */
  publishFrozen() {
    if (!this.st.running) return;
    bus().post({ t: 'state', sid: this.sid, seq: ++this.seq, ts: Date.now(), ...this.st,
      frozen: true, lines: ['', '', '', '', ''], levels: null, status: '분석기가 백그라운드로 전환되어 멈춤' }, { retain: true });
  }

  sendLevels(l: LevelPkt, r: LevelPkt) {
    this.st.levels = [l, r];
    if (!this.st.running) return;
    bus().post({ t: 'lv', sid: this.sid, seq: ++this.seq, ts: Date.now(), l, r }, { ls: false });
  }

  private onRx(m: any, via: Via) {
    if (m.t === 'hello') { this.publish(); return; }               // 새 수신기 → 즉시 현재 상태
    if (m.t !== 'ack' || typeof m.page !== 'string') return;
    const isNew = !this.rx.has(m.page);
    this.rx.set(m.page, { t: Date.now(), via });
    if (isNew) { this.publish(); this.emit(); }
  }

  private emit() {
    const now = Date.now();
    for (const [k, v] of this.rx) if (now - v.t > 6000) this.rx.delete(k);
    this.onState({ receivers: this.rx.size, mqtt: bus().mqttState(), via: [...new Set([...this.rx.values()].map(v => v.via))] });
  }
}

export type Phase = 'waiting' | 'live' | 'stale' | 'stopped';
export interface ReceiverInfo { phase: Phase; lastUpdate: number | null; via: Via | null; mqtt: MqttState; frozen: boolean }

/** 지금 HUD·G2 렌즈에 내보낼 5줄: 신호가 끊긴 지 오래면(또는 분석기가 멈췄다고 알려 오면) 오래된 조언 대신 안내 한 줄 */
export function linesToShow(st: MixState, i: ReceiverInfo): string[] {
  if (i.phase === 'stopped') return ['', '', '', '', ''];
  if (i.phase === 'stale' && (i.frozen || (i.lastUpdate !== null && Date.now() - i.lastUpdate > STALE_CLEAR_MS))) return NO_SIGNAL_LINES;
  return st.lines;
}

/**
 * 수신기: 열리자마자 접속 → 브로커의 retained 상태 + 실시간 패킷 수신.
 * announce=true(HUD 수신기 모드)면 2초마다 ack 를 보내 분석기 화면에 '수신기 연결됨'으로 표시되게 한다.
 */
export class HudReceiver {
  private announce: boolean;
  private seqs = new Map<string, number>();
  private hosts = new Map<string, { st: MixState; ts: number }>();
  private cur: { sid: string; st: MixState; ts: number } | null = null;
  private via: Via | null = null;
  private lastPhase: Phase = 'waiting';
  onUpdate: (st: MixState, info: ReceiverInfo) => void = () => {};
  onLevels: (lv: [LevelPkt, LevelPkt] | null) => void = () => {};
  onInfo: (info: ReceiverInfo) => void = () => {};

  constructor(opts: { announce?: boolean } = {}) { this.announce = !!opts.announce; }

  start() {
    const b = bus();
    b.on((m, via) => this.recv(m, via));
    b.onUp(() => this.hello());
    b.onMqttState(() => this.onInfo(this.info()));
    this.hello();
    if (this.announce) setTicker(() => b.post({ t: 'ack', ts: Date.now() }, { ls: false }), 2000);
    setTicker(() => {                       // 실시간 → 지연 전환 감지
      const i = this.info();
      if (i.phase !== this.lastPhase) { this.lastPhase = i.phase; this.onInfo(i); }
    }, 500);
    this.onInfo(this.info());
  }

  get state(): MixState | null { return this.cur?.st ?? null; }

  info(): ReceiverInfo {
    const c = this.cur;
    let phase: Phase = 'waiting';
    if (c) phase = !c.st.running ? 'stopped' : c.st.frozen ? 'stale' : Date.now() - c.ts <= LIVE_MS ? 'live' : 'stale';
    return { phase, lastUpdate: c?.ts ?? null, via: this.via, mqtt: bus().mqttState(), frozen: !!c?.st.frozen };
  }

  private hello() { bus().post({ t: 'hello', ts: Date.now() }, { ls: false }); }

  private recv(m: any, via: Via) {
    if (typeof m.sid !== 'string' || typeof m.seq !== 'number') return;
    if (m.t !== 'state' && m.t !== 'lv') return;
    const prev = this.seqs.get(m.sid) ?? -1;
    if (m.seq <= prev) return;                       // 다른 경로로 이미 받은 패킷
    this.seqs.set(m.sid, m.seq);
    const ts = Number(m.ts) || Date.now();

    if (m.t === 'lv') {
      if (this.cur?.sid !== m.sid) return;
      this.cur.st.levels = [m.l, m.r];
      this.cur.ts = Math.max(this.cur.ts, ts);
      this.via = via;
      this.onLevels(this.cur.st.levels);
      return;
    }
    if (Date.now() - ts > MAX_AGE_MS) return;
    const st: MixState = { ...emptyState(), ...m, lines: Array.from({ length: 5 }, (_, i) => String(m.lines?.[i] ?? '')) };
    this.hosts.set(m.sid, { st, ts });
    // 여러 분석기가 있으면: 최근 5초 안에 실행 중인 것 중 가장 최신 → 없으면 전체 중 가장 최신
    const now = Date.now();
    const all = [...this.hosts.entries()];
    const live = all.filter(([, h]) => h.st.running && now - h.ts <= 5000);
    const pick = (live.length ? live : all).reduce((a, b) => (b[1].ts > a[1].ts ? b : a));
    this.cur = { sid: pick[0], st: pick[1].st, ts: pick[1].ts };
    if (pick[0] !== m.sid) return;                   // 덜 중요한 분석기의 패킷이면 화면 유지
    this.via = via;
    const i = this.info();
    this.lastPhase = i.phase;
    this.onUpdate(st, i);
  }
}
