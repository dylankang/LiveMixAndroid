import { BANDS, HARD_CAP_CHARS, QUEUE_SIZE, TIMING } from './config';

export interface Candidate { tag: string; text: string }
export interface AdviceItem extends Candidate { key: string; at: number }

/** 쿨다운 상세 설정 (⚙️ 설정에서 조절) */
export type CooldownScope = 'strict' | 'standard';
export interface CooldownCfg {
  holdSec: number;          // 0 = 끄기 · 10~600초
  trigger: 1 | 2 | 3;       // 같은 항목이 몇 번(연속) 나오면 쿨다운 등록
  scope: CooldownScope;     // strict = 같은 악기+같은 항목 전체 / standard = 같은 악기+비슷한 주파수·조치만
}
export const COOLDOWN_DEFAULT: CooldownCfg = { holdSec: 120, trigger: 2, scope: 'standard' };
export const COOLDOWN_RANGE = { min: 0, max: 600, step: 10 } as const;

/** 항목 이름 정규화: 대소문자·표기 흔들림을 하나로 (예: deesser → De-Esser) */
const ITEM_ALIASES: [RegExp, string][] = [
  [/^eq$/i, 'EQ'], [/^comp(ressor)?$/i, 'Comp'], [/^level|^fader|^vol(ume)?$/i, 'Level'],
  [/^hpf|^low[- ]?cut$/i, 'HPF'], [/^lpf|^high[- ]?cut$/i, 'LPF'],
  [/^rev(erb)?$/i, 'Reverb'], [/^delay$/i, 'Delay'], [/^de-?ess(er)?$/i, 'De-Esser'],
  [/^gate$/i, 'Gate'], [/^dyn-?eq$/i, 'DynEQ'], [/^mask(ing)?$/i, 'Masking'],
  [/^pan$/i, 'Pan'], [/^width$/i, 'Width'], [/^limiter$/i, 'Limiter'], [/^sat(uration)?$/i, 'Saturation'],
];
export function normalizeItem(raw: string): string {
  const s = raw.trim();
  for (const [re, name] of ITEM_ALIASES) if (re.test(s)) return name;
  return s;
}

/** "[악기] 항목:조치" 를 나눈다 */
export function splitAdvice(line: string): { inst: string; item: string; action: string } | null {
  const m = line.trim().match(/^\[([^\[\]]{1,12})\]\s*([A-Za-z가-힣][A-Za-z가-힣\-/]{0,11})\s*[:：]\s*(.+)$/);
  if (!m) return null;
  return { inst: m[1].trim(), item: normalizeItem(m[2]), action: m[3].trim() };
}

/** 조치 문구에서 주파수(Hz)를 찾아 6밴드 이름으로 */
function bandOfAction(action: string): string | null {
  const f = action.match(/(\d+(?:\.\d+)?)\s*(k)?\s*hz/i) ?? action.match(/(\d+(?:\.\d+)?)\s*(k)\b/i);
  if (!f) return null;
  let hz = parseFloat(f[1]);
  if (f[2]) hz *= 1000;
  if (!Number.isFinite(hz) || hz <= 0) return null;
  const b = BANDS.find(b => hz >= b.lo && hz < b.hi) ?? (hz >= 16000 ? BANDS[5] : BANDS[0]);
  return b.name;
}

/**
 * 쿨다운/중복 판정 키
 *  - strict   : 악기 + 항목            (예: 건반|EQ → 건반 EQ 는 주파수와 상관없이 모두 묶음)
 *  - standard : 악기 + 항목 + 세부      (주파수가 있으면 같은 대역, Level 은 +/− 방향, 그 밖에는 조치의 첫 단어)
 */
export function keyOf(line: string, scope: CooldownScope = 'standard'): string {
  const a = splitAdvice(line);
  if (!a) return `raw:${line.trim().toUpperCase()}`;
  const base = `${a.inst}|${a.item.toUpperCase()}`;
  if (scope === 'strict') return base;
  const band = bandOfAction(a.action);
  if (band) return `${base}|${band}`;
  if (a.item === 'Level') return `${base}|${/^-|−|줄|낮|다운|down/i.test(a.action) ? '-' : '+'}`;
  const word = a.action.replace(/[+\-−]?\d+(\.\d+)?\s*(dB|ms|s|%|:1)?/gi, '').trim().split(/\s+/)[0] ?? '';
  return word ? `${base}|${word}` : base;
}

/** 태그 표시용 이름: [건반 EQ] */
export function labelOf(line: string): string {
  const a = splitAdvice(line);
  return a ? `[${a.inst} ${a.item}]` : line.slice(0, 12);
}

export function clampText(s: string): string {
  const chars = Array.from(s.trim());
  return chars.length > HARD_CAP_CHARS ? chars.slice(0, HARD_CAP_CHARS).join('') : chars.join('');
}

export interface CooldownEntry {
  key: string; label: string; until: number;
  inst: string; item: string; detail: string;   // 화면 표시용: [악기] 항목 · 세부(대역/방향)
  count: number; trigger: number;                 // 등록 시점의 연속 횟수 / 설정된 발동 조건
}

export class AdviceManager {
  items: AdviceItem[] = [];
  private cool = new Map<string, CooldownEntry>();
  private history = new Map<string, { count: number; last: number }>();
  private lastRemoval = 0;
  cfg: CooldownCfg = { ...COOLDOWN_DEFAULT };
  /** AI 주기에 맞춰 조정되는 값 */
  expireMs: number = TIMING.expireMs;
  repeatWindowMs: number = TIMING.repeatWindowMs;

  setIntervalMs(ms: number) {
    this.expireMs = Math.max(TIMING.expireMs, ms * 1.5);
    this.repeatWindowMs = Math.max(TIMING.repeatWindowMs, ms * 4);
  }

  /** 쿨다운 설정 변경. 판정 범위가 바뀌면 기존 목록·연속 기록은 새 기준으로 다시 시작 */
  setCooldown(c: Partial<CooldownCfg>) {
    const prevScope = this.cfg.scope;
    this.cfg = { ...this.cfg, ...c };
    if (this.cfg.holdSec <= 0) this.cool.clear();
    if (prevScope !== this.cfg.scope) { this.cool.clear(); this.history.clear(); }
    // 유지 시간을 줄이면 남은 시간도 새 한도로 줄임
    const cap = Date.now() + this.cfg.holdSec * 1000;
    for (const e of this.cool.values()) if (e.until > cap) e.until = cap;
  }

  displayList(): Candidate[] { return this.items.map(i => ({ tag: i.tag, text: i.text })); }

  /** 현재 쿨다운 목록 (남은 시간 짧은 순) */
  cooldownList(now: number): CooldownEntry[] {
    this.purge(now);
    return [...this.cool.values()].sort((a, b) => a.until - b.until);
  }
  /** AI 에 넘기는 쿨다운 목록 (라벨) */
  cooldownTags(now: number): string[] { return this.cooldownList(now).map(c => c.label); }

  removeCooldown(key: string) { this.cool.delete(key); this.history.delete(key); }
  resetCooldown() { this.cool.clear(); this.history.clear(); }

  private purge(now: number) {
    for (const [k, v] of this.cool) if (v.until <= now) this.cool.delete(k);
  }

  /**
   * AI 결과를 큐에 반영. 반환: 실제로 화면에 추가된 항목.
   * - 화면에 이미 있는 것과 같은 키, 쿨다운 중인 키는 제외
   * - 같은 키가 (연속 판정 시간 안에) trigger 번째로 나오면 이번 것은 표시하고 동시에 쿨다운 등록
   */
  ingest(cands: Candidate[], now: number): AdviceItem[] {
    this.purge(now);
    const accepted: AdviceItem[] = [];
    const scope = this.cfg.scope;
    for (const c of cands) {
      if (accepted.length >= QUEUE_SIZE) break;
      const key = keyOf(c.tag, scope);
      if (this.cool.has(key)) continue;
      if (this.items.some(i => keyOf(i.tag, scope) === key) || accepted.some(a => a.key === key)) continue;
      const h = this.history.get(key);
      const recent = !!h && now - h.last <= this.repeatWindowMs;
      const count = recent ? h!.count + 1 : 1;
      this.history.set(key, { count, last: now });
      accepted.push({ ...c, text: clampText(c.text), key, at: now });
      if (this.cfg.holdSec > 0 && count >= this.cfg.trigger) {
        const a = splitAdvice(c.tag);
        this.cool.set(key, {
          key, label: labelOf(c.tag), until: now + this.cfg.holdSec * 1000,
          inst: a?.inst ?? '', item: a?.item ?? c.tag.slice(0, 12), detail: key.split('|')[2] ?? '',
          count, trigger: this.cfg.trigger,
        });
        this.history.delete(key);
      }
    }
    if (accepted.length) this.items = [...this.items, ...accepted].slice(-QUEUE_SIZE);
    return accepted;
  }

  /** 오래된 조언을 가장 오래된 것부터 한 줄씩 제거. 변경되면 true */
  tick(now: number): boolean {
    this.purge(now);
    const oldest = this.items[0];
    if (oldest && now - oldest.at >= this.expireMs && now - this.lastRemoval >= TIMING.removeGapMs) {
      this.items.shift();
      this.lastRemoval = now;
      return true;
    }
    return false;
  }

  /** 2~5번 줄(4줄). 최신이 맨 아래, 위쪽은 빈 줄 */
  lines(): string[] {
    const out = Array(QUEUE_SIZE).fill('');
    this.items.forEach((it, i) => { out[QUEUE_SIZE - this.items.length + i] = it.text; });
    return out;
  }
}
