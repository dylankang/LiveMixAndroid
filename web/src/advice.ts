import { BANDS, HARD_CAP_CHARS, QUEUE_SIZE, TIMING } from './config';

export interface Candidate { tag: string; text: string }
export interface AdviceItem extends Candidate { key: string; at: number }

/**
 * 조언 한 줄("[악기] EQ:350Hz 컷" / "[악기] Level:+2dB" / "[악기] Comp:…")을 "악기 + 종류(+대역)" 키로 변환.
 * 같은 악기·같은 종류·같은 주파수 대역이면 같은 항목으로 본다. (Comp는 대역 없이 악기+종류)
 */
export function keyOf(line: string): string {
  const m = line.trim().match(/^\[([^\]]+)\]\s*(EQ|COMP|LEVEL)\s*:\s*(.*)$/i);
  if (!m) return `raw:${line.trim().toUpperCase()}`;
  const inst = m[1].trim(), type = m[2].toUpperCase();
  if (type === 'COMP') return `${inst}|COMP`;
  if (type === 'LEVEL') return `${inst}|LEVEL`;
  const f = m[3].match(/(\d+(?:\.\d+)?)\s*(k)?/i);
  if (!f) return `${inst}|EQ|${m[3].trim()}`;
  let hz = parseFloat(f[1]);
  if (f[2]) hz *= 1000;
  const b = BANDS.find(b => hz >= b.lo && hz < b.hi) ?? (hz >= 16000 ? BANDS[5] : BANDS[0]);
  return `${inst}|EQ|${b.name}`;
}

export function clampText(s: string): string {
  const chars = Array.from(s.trim());
  return chars.length > HARD_CAP_CHARS ? chars.slice(0, HARD_CAP_CHARS).join('') : chars.join('');
}

export class AdviceManager {
  items: AdviceItem[] = [];
  cooldown = new Map<string, { tag: string; until: number }>();
  private history = new Map<string, { count: number; last: number }>();
  private lastRemoval = 0;
  /** AI 주기에 맞춰 조정되는 값 (기본 20초 주기에서는 30초 / 120초) */
  expireMs: number = TIMING.expireMs;
  repeatWindowMs: number = TIMING.repeatWindowMs;

  setIntervalMs(ms: number) {
    this.expireMs = Math.max(TIMING.expireMs, ms * 1.5);
    this.repeatWindowMs = Math.max(TIMING.repeatWindowMs, ms * 4);
  }

  displayList(): Candidate[] { return this.items.map(i => ({ tag: i.tag, text: i.text })); }

  cooldownTags(now: number): string[] {
    this.purge(now);
    return [...this.cooldown.values()].map(c => c.tag);
  }

  private purge(now: number) {
    for (const [k, v] of this.cooldown) if (v.until <= now) this.cooldown.delete(k);
  }

  /**
   * AI 결과를 큐에 반영. 반환: 실제로 화면에 추가된 항목.
   * - 화면/쿨다운과 같은 대역은 제외
   * - 같은 항목이 이미 2회 연속 출력됐는데 또 지적되면 5분 쿨다운 등록(표시 안 함)
   */
  ingest(cands: Candidate[], now: number): AdviceItem[] {
    this.purge(now);
    const accepted: AdviceItem[] = [];
    for (const c of cands) {
      if (accepted.length >= 2) break;
      const key = keyOf(c.tag);
      if (this.cooldown.has(key)) continue;
      if (this.items.some(i => i.key === key) || accepted.some(a => a.key === key)) continue;
      const h = this.history.get(key);
      const recent = h && now - h.last <= this.repeatWindowMs;
      if (recent && h!.count >= 2) {
        this.cooldown.set(key, { tag: c.tag, until: now + TIMING.cooldownMs });
        this.history.delete(key);
        continue;
      }
      this.history.set(key, { count: recent ? h!.count + 1 : 1, last: now });
      accepted.push({ ...c, text: clampText(c.text), key, at: now });
    }
    if (accepted.length) this.items = [...this.items, ...accepted].slice(-QUEUE_SIZE);
    return accepted;
  }

  /** 30초 지난 조언을 가장 오래된 것부터 한 줄씩 제거. 변경되면 true */
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

  resetCooldown() { this.cooldown.clear(); this.history.clear(); }
}
