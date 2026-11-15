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

/** 조언 '분류'(처리 종류) 표준 이름 — [대상] 분류:내용 의 가운데 자리 */
export const CATEGORIES = ['Level', 'EQ', 'Comp', 'HPF', 'LPF', 'Gate', 'De-Esser', 'DynEQ', 'Reverb', 'Delay', 'Pan', 'Width', 'Limiter', 'Saturation'] as const;

/** 분류 이름 정규화: 대소문자·한글 표기 흔들림을 하나로 (예: deesser → De-Esser, 컴프 → Comp) */
const ITEM_ALIASES: [RegExp, string][] = [
  [/^(eq|이큐|이퀄라이저|equali[sz]er)$/i, 'EQ'], [/^(comp(ressor|ression)?|컴프|컴프레서|압축)$/i, 'Comp'],
  [/^(level|fader|vol(ume)?|gain|레벨|볼륨|페이더|게인|음량)$/i, 'Level'],
  [/^(hpf|low[- ]?cut|high[- ]?pass|하이패스|로우컷)$/i, 'HPF'], [/^(lpf|high[- ]?cut|low[- ]?pass|로우패스|하이컷)$/i, 'LPF'],
  [/^(rev(erb)?|리버브|잔향)$/i, 'Reverb'], [/^(delay|딜레이)$/i, 'Delay'], [/^(de-?ess(er)?|디에서|치찰음)$/i, 'De-Esser'],
  [/^(gate|게이트|노이즈게이트)$/i, 'Gate'], [/^(dyn(amic)?-?eq|다이나믹eq|다이내믹eq|mask(ing)?|마스킹)$/i, 'DynEQ'],
  [/^(pan|팬|패닝|정위)$/i, 'Pan'], [/^(width|stereo|스테레오|폭)$/i, 'Width'],
  [/^(limiter|리미터)$/i, 'Limiter'], [/^(sat(uration)?|새츄레이션|포화)$/i, 'Saturation'],
];
export function normalizeItem(raw: string): string {
  const s = raw.trim().replace(/\s+/g, '');
  for (const [re, name] of ITEM_ALIASES) if (re.test(s)) return name;
  return raw.trim();
}

/** 분류 자리에 주파수 대역명이 온 경우 (예: low-mid, 저역) → 표시용 대역 이름 */
const BAND_ITEM: [RegExp, string][] = [
  [/^(sub|subs|서브|초저역|초저음)$/i, 'Sub'], [/^(low-?mids?|lo-?mid|로우-?미드|중저역|저중역)$/i, 'Low-Mid'],
  [/^(high-?mids?|hi-?mid|하이-?미드|중고역|고중역|presence|프레즌스)$/i, 'High-Mid'], [/^(lows?|bass|로우|저역|저음)$/i, 'Low'],
  [/^(mids?|middle|미드|중역|중음)$/i, 'Mid'], [/^(highs?|hi|treble|air|하이|고역|고음|에어)$/i, 'High'],
];
const bandItem = (raw: string) => { const t = raw.trim().replace(/\s+/g, ''); for (const [re, n] of BAND_ITEM) if (re.test(t)) return n; return null; };

/** 단위 표기 통일: 250hz → 250Hz, 2.5 khz → 2.5kHz, -3db → -3dB */
export function tidyUnits(s: string): string {
  return s.replace(/(\d(?:\.\d+)?)\s*k\s*hz\b/gi, '$1kHz').replace(/(\d(?:\.\d+)?)\s*hz\b/gi, '$1Hz').replace(/(\d(?:\.\d+)?)\s*db\b/gi, '$1dB').replace(/\s{2,}/g, ' ').trim();
}

const HAS_FREQ = /\d\s*(k\s*)?hz|\d\s*k\b/i;

/**
 * AI 가 쓴 조언 한 줄을 표준 형식 \`[대상] 분류:내용\` 으로 정리한다.
 *  · 분류 자리에 대역명이나 주파수가 오면 EQ 로 (예: \`[음성]low-mid:250hz -3db\` → \`[음성] EQ:250Hz -3dB\`)
 *  · 한글/약어 분류는 표준 이름으로 (컴프 → Comp, 볼륨 → Level …)
 *  · 콜론이 없어도 주파수/dB 가 있으면 EQ 로 본다
 */
export function normalizeAdvice(line: string): { inst: string; item: string; action: string } | null {
  const m = line.trim().match(/^\[([^\[\]]{1,16})\]\s*(.+)$/);
  if (!m) return null;
  const inst = m[1].trim();
  const rest = m[2].trim();
  const ci = rest.search(/[:：]/);
  let item = ci >= 0 ? rest.slice(0, ci).trim() : '';
  let action = tidyUnits(ci >= 0 ? rest.slice(ci + 1).trim() : rest);
  if (!action) return null;
  const band = item ? bandItem(item) : null;
  if (band) { item = 'EQ'; if (!HAS_FREQ.test(action)) action = `${band} ${action}`; }
  else if (!item || HAS_FREQ.test(item) || /^[+\-−]?\d/.test(item)) {
    // 분류가 없거나 숫자/주파수로 시작 → 주파수가 있으면 EQ
    const all = tidyUnits(rest.replace(/[:：]/, ' '));
    if (!HAS_FREQ.test(all) && !/dB/i.test(all)) return null;
    item = 'EQ'; action = all;
  } else item = normalizeItem(item);
  if (item !== 'EQ') action = toArrows(item, action);
  return { inst, item, action };
}

/**
 * EQ 를 뺀 분류는 정확한 숫자 대신 방향만: ↑ = 올림/늘림, ↓ = 낮춤/줄임 (Pan 은 ← →)
 *  예) HPF:100Hz 올림 → HPF:↑ · Comp:레시오 낮춤 → Comp:레시오 ↓ · Level:+2dB → Level:↑ · Reverb:디케이 축소 → Reverb:디케이 ↓
 */
export function toArrows(item: string, action: string): string {
  let a = action;
  if (item === 'Level' && !/[↑↓]/.test(a)) {
    const m = a.match(/([+\-−])\s*\d+(?:\.\d+)?\s*dB/i);
    if (m) a = a.replace(m[0], m[1] === '+' ? '↑' : '↓');
  }
  a = a
    .replace(/(올리|올려|올림|높이|높여|높임|늘리|늘려|늘림|키우|키워|키움|증가|강화|더\s*세게|up)\S*/gi, '↑')
    .replace(/(내리|내려|내림|낮추|낮춰|낮춤|줄이|줄여|줄임|감소|축소|약하게|down)\S*/gi, '↓');
  if (/[↑↓←→]/.test(a)) {
    // 방향이 있으면 부정확한 수치(100Hz, 3:1, -3dB, 30ms …)는 지운다
    const P = '(?:으로|로|까지|정도|쯤|가량|에서|에)?';
    a = a.replace(new RegExp(`[+\\-−]?\\d+(?:\\.\\d+)?\\s*:\\s*\\d+${P}`, 'g'), '')
      .replace(new RegExp(`[+\\-−]?\\d+(?:\\.\\d+)?\\s*(?:kHz|Hz|dB|ms|%|초)${P}`, 'gi'), '')
      .replace(/(^|\s)(설정|조정|변경|정도)(?=\s|$)/g, ' ');
    a = a.replace(/\s*([↑↓←→])\s*/g, ' $1').replace(/\s{2,}/g, ' ').trim();
    a = a.replace(/([↑↓←→])(?:\s*\1)+/g, '$1$1').replace(/(↑↑|↓↓)\1+/g, '$1');
  }
  return a.trim();
}

/** "[악기] 항목:조치" 를 나눈다 */
export function splitAdvice(line: string): { inst: string; item: string; action: string } | null {
  return normalizeAdvice(line);
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
  if (a.item === 'Level') return `${base}|${/^-|−|줄|낮|다운|down|↓/i.test(a.action) ? '-' : '+'}`;
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
