// PC 분석기 ↔ G2 HUD 수신기(Even Hub 웹뷰) 연결: 4자리 '연결 코드' 기반 클라우드 MQTT 하나로 통일
//  · 서로 다른 네트워크(FOH PC 유선 LAN ↔ 폰 5G/LTE)여도 같은 브로커·같은 코드면 연결된다.
//  · 토픽: livemix/g2/{CODE}/hud    — 전체 상태(state, retain:true) + L/R 레벨(lv)
//          livemix/g2/{CODE}/status — PC 하트비트(hb, 2초) · 수신기 hello/ack
// 전체 상태 패킷(state)은 retain 으로 발행 → 수신기는 언제 열리든 브로커에 남은 마지막 상태를 즉시 받는다.
import { setTicker, later } from './ticker';

declare const mqtt: any;

export const MQTT_URL = 'wss://broker.emqx.io:8084/mqtt';
export const topicsFor = (code: string) => ({ hud: `livemix/g2/${code}/hud`, status: `livemix/g2/${code}/status` });
const LIVE_MS = 3500;          // 이 시간 안에 상태 패킷이 오면 "실시간"
export const STALE_CLEAR_MS = 8000;   // 신호가 이만큼 끊기면 수신기 HUD·G2 렌즈의 오래된 조언을 지움
export const HB_MS = 2000;            // PC 하트비트 주기
export const HB_LOST_MS = 10000;      // 이 시간 넘게 하트비트가 없으면 'PC 신호 대기중'
export const NO_SIGNAL_LINES = ['⚠️ PC 신호 대기중', '', '', '', ''];
const MAX_AGE_MS = 6 * 3600_000; // 이보다 오래된 retained 상태는 버림 (지난 공연 데이터)

// ───────── 4자리 연결 코드 ─────────
export const isCode = (s: unknown): s is string => typeof s === 'string' && /^\d{4}$/.test(s);
export function genCode(): string {
  const a = new Uint32Array(1);
  try { crypto.getRandomValues(a); } catch { a[0] = Math.floor(Math.random() * 1e9); }
  return String(a[0] % 10000).padStart(4, '0');
}
let curCode = '';
/** 현재 연결 코드 */
export const linkCode = () => curCode;
/** 연결 코드 설정/변경 (처음 호출은 연결 전에, 이후 호출은 구독 토픽을 바로 바꿈) */
export function setLinkCode(code: string) {
  if (!isCode(code) || code === curCode) return;
  curCode = code;
  busSingleton?.changeCode();
}

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
export type Via = 'MQTT';
export type MqttState = 'off' | 'connecting' | 'on';

const rand = () => Math.random().toString(36).slice(2, 10);
const PAGE_ID = rand();                  // 같은 페이지가 보낸 패킷(MQTT 에코 등)을 무시하기 위한 ID

export const emptyState = (): MixState => ({
  running: false, lines: ['', '', '', '', ''], bands: null, levels: null, genre: '', genreAt: 0, aiLog: null, status: '',
});

interface PostOpts { topic?: 'hud' | 'status'; retain?: boolean }
type Handler = (m: any, via: Via) => void;

/** 페이지당 하나의 MQTT 연결 (송신기·수신기가 같이 씀) */
class Bus {
  private handlers: Handler[] = [];
  private client: any = null;
  private state: MqttState = 'off';
  private upFns: (() => void)[] = [];
  private stateFns: (() => void)[] = [];
  private codeFns: (() => void)[] = [];
  private subCode = '';

  constructor() {
    this.connectMqtt();
    // 절전·네트워크 전환에서 돌아오면 끊겼을 수 있는 연결을 바로 새로 연결
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
    // close 이벤트가 늦게 오는 경우 대비: 5초마다 상태 확인
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
  onCode(f: () => void) { this.codeFns.push(f); }
  mqttState(): MqttState { return this.state; }
  private setState(s: MqttState) { if (this.state !== s) { this.state = s; this.stateFns.forEach(f => f()); } }

  /** 코드가 바뀌면: 이전 코드 토픽 구독 해제 → 새 코드 토픽 구독 → 송신기 재발행/수신기 초기화 */
  changeCode() {
    this.codeFns.forEach(f => f());
    const c = this.client;
    if (!c?.connected) return;
    if (this.subCode) { const o = topicsFor(this.subCode); try { c.unsubscribe([o.hud, o.status]); } catch { /* ignore */ } }
    this.subscribe(c);
    this.upFns.forEach(f => f());
  }
  private subscribe(c: any) {
    if (!isCode(curCode)) return;
    const t = topicsFor(curCode);
    c.subscribe([t.hud, t.status], { qos: 0 });   // 구독 즉시 retained 상태가 도착
    this.subCode = curCode;
  }

  private connectMqtt() {
    if (typeof mqtt === 'undefined') { this.setState('off'); return; }   // CDN 로드 실패
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
      this.subscribe(c);
      this.setState('on');
      this.upFns.forEach(f => f());
    });
    c.on('message', (topic: string, payload: any) => {
      if (!isCode(curCode)) return;
      const t = topicsFor(curCode);
      if (topic !== t.hud && topic !== t.status) return;   // 코드를 바꾸기 전 토픽에서 늦게 온 패킷은 무시
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
      later(() => { if (!this.client) this.connectMqtt(); }, 1500);
    });
  }

  post(m: any, o: PostOpts = {}) {
    if (!isCode(curCode) || !this.client?.connected) return;
    const t = topicsFor(curCode);
    const json = JSON.stringify({ ...m, page: PAGE_ID });
    try { this.client.publish(o.topic === 'status' ? t.status : t.hud, json, { qos: 0, retain: !!o.retain }); } catch { /* ignore */ }
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

export interface SenderInfo { receivers: number; mqtt: MqttState; via: Via[]; code: string }

/**
 * 분석기 쪽 송신기.
 * - publish(): 전체 상태를 livemix/g2/{CODE}/hud 에 retain 발행 — 분석기가 1초마다, 그리고 HUD가 바뀌는 즉시 호출
 * - 분석 중에는 2초마다 livemix/g2/{CODE}/status 에 하트비트(입력 레벨 dB · 분석 활성) 발행
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
    b.onCode(() => { this.rx.clear(); this.emit(); });
    setTicker(() => this.emit(), 1000);
    setTicker(() => this.heartbeat(), HB_MS);
  }

  /** PC 하트비트: 분석 중일 때만 (입력 레벨 = L/R 중 큰 RMS) */
  private heartbeat() {
    if (!this.st.running) return;
    const lv = this.st.levels;
    const levelDb = lv ? Math.round(Math.max(lv[0].rmsDb, lv[1].rmsDb) * 10) / 10 : -120;
    bus().post({ t: 'hb', ts: Date.now(), running: true, levelDb }, { topic: 'status' });
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
      bus().post({ t: 'hb', ts: Date.now(), running: false, levelDb: -120 }, { topic: 'status' });
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
    bus().post({ t: 'lv', sid: this.sid, seq: ++this.seq, ts: Date.now(), l, r });
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
    this.onState({ receivers: this.rx.size, mqtt: bus().mqttState(), via: [...new Set([...this.rx.values()].map(v => v.via))], code: curCode });
  }
}

export type Phase = 'waiting' | 'live' | 'stale' | 'stopped';
export interface ReceiverInfo {
  phase: Phase; lastUpdate: number | null; via: Via | null; mqtt: MqttState; frozen: boolean;
  code: string;
  /** PC 하트비트: 마지막 수신 시각 · 그때 보고된 입력 레벨 · 10초 안에 받았는지 */
  lastHb: number | null; hbLevelDb: number | null; pcAlive: boolean;
}

/** 지금 HUD·G2 렌즈에 내보낼 5줄: PC 하트비트가 10초 넘게 없거나 신호가 오래 끊기면 '⚠️ PC 신호 대기중' */
export function linesToShow(st: MixState, i: ReceiverInfo): string[] {
  if (i.phase === 'stopped') return ['', '', '', '', ''];
  if (i.phase === 'stale' && (i.frozen || (i.lastUpdate !== null && Date.now() - i.lastUpdate > STALE_CLEAR_MS))) return NO_SIGNAL_LINES;
  if (st.running && i.lastHb !== null && !i.pcAlive) return NO_SIGNAL_LINES;
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
  private lastHb: number | null = null;
  private hbLevelDb: number | null = null;
  private lastAlive = false;
  onUpdate: (st: MixState, info: ReceiverInfo) => void = () => {};
  onLevels: (lv: [LevelPkt, LevelPkt] | null) => void = () => {};
  onInfo: (info: ReceiverInfo) => void = () => {};

  constructor(opts: { announce?: boolean } = {}) { this.announce = !!opts.announce; }

  start() {
    const b = bus();
    b.on((m, via) => this.recv(m, via));
    b.onUp(() => this.hello());
    b.onMqttState(() => this.onInfo(this.info()));
    b.onCode(() => {                         // 코드 변경: 이전 코드의 상태는 모두 버리고 새로 기다림
      this.seqs.clear(); this.hosts.clear(); this.cur = null; this.via = null;
      this.lastHb = null; this.hbLevelDb = null; this.lastPhase = 'waiting';
      this.onUpdate({ ...emptyState() }, this.info());
      this.onInfo(this.info());
    });
    this.hello();
    if (this.announce) setTicker(() => b.post({ t: 'ack', ts: Date.now() }, { topic: 'status' }), 2000);
    setTicker(() => {                       // 실시간 → 지연 전환, PC 하트비트 끊김 감지
      const i = this.info();
      if (i.phase !== this.lastPhase || i.pcAlive !== this.lastAlive) { this.lastPhase = i.phase; this.lastAlive = i.pcAlive; this.onInfo(i); }
    }, 500);
    this.onInfo(this.info());
  }

  get state(): MixState | null { return this.cur?.st ?? null; }

  info(): ReceiverInfo {
    const c = this.cur;
    let phase: Phase = 'waiting';
    if (c) phase = !c.st.running ? 'stopped' : c.st.frozen ? 'stale' : Date.now() - c.ts <= LIVE_MS ? 'live' : 'stale';
    const pcAlive = this.lastHb !== null && Date.now() - this.lastHb <= HB_LOST_MS;
    return { phase, lastUpdate: c?.ts ?? null, via: this.via, mqtt: bus().mqttState(), frozen: !!c?.st.frozen,
      code: curCode, lastHb: this.lastHb, hbLevelDb: this.hbLevelDb, pcAlive };
  }

  private hello() { bus().post({ t: 'hello', ts: Date.now() }, { topic: 'status' }); }

  private recv(m: any, via: Via) {
    if (m.t === 'hb') {                              // PC 하트비트 (2초)
      if (m.running === false) { this.lastHb = null; this.hbLevelDb = null; }
      else { this.lastHb = Date.now(); this.hbLevelDb = typeof m.levelDb === 'number' ? m.levelDb : null; }
      const i = this.info();
      if (i.pcAlive !== this.lastAlive) { this.lastAlive = i.pcAlive; this.onInfo(i); }
      return;
    }
    if (typeof m.sid !== 'string' || typeof m.seq !== 'number') return;
    if (m.t !== 'state' && m.t !== 'lv') return;
    const prev = this.seqs.get(m.sid) ?? -1;
    if (m.seq <= prev) return;                       // 다른 경로로 이미 받은 패킷
    this.seqs.set(m.sid, m.seq);
    const ts = Number(m.ts) || Date.now();

    if (m.t === 'lv') {
      const c = this.cur;
      if (!c || c.sid !== m.sid) return;
      c.st.levels = [m.l, m.r];
      c.ts = Math.max(c.ts, ts);
      this.via = via;
      this.onLevels(c.st.levels);
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
