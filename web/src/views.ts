// 분석기 화면과 수신기 화면이 같이 쓰는 표시 요소 (레벨 미터 · 밴드 표 · HUD 5줄 · 장르 배지)
import type { BandRow, LevelPkt } from './link';

export const BAND_NAMES = ['Sub', 'Low', 'Low-Mid', 'Mid', 'High-Mid', 'High'];

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmt = (v: number | null | undefined, sign = false) =>
  v === null || v === undefined || !Number.isFinite(v) ? '-' : (sign && v > 0 ? '+' : '') + v;

export const emptyBandRows = (): BandRow[] =>
  BAND_NAMES.map(name => ({ name, avgDb: -120, crestDb: 0, deltaDb: null, character: 'none', over: false }));

export function renderBandTable(el: HTMLElement, rows: BandRow[] | null) {
  const r = rows && rows.length ? rows : emptyBandRows();
  el.innerHTML = '<tr><th>대역</th><th>평균</th><th>Crest</th><th>Δ(타겟 보정)</th><th>성격</th></tr>' +
    r.map(x => `<tr><td>${esc(x.name)}</td><td>${fmt(x.avgDb <= -119 ? null : x.avgDb)}</td><td>${fmt(x.crestDb)}</td>` +
      `<td${x.over ? ' class="over"' : ''}>${fmt(x.deltaDb, true)}</td><td>${esc(x.character)}</td></tr>`).join('');
}

export const meterMarkup = () => ['L', 'R'].map(ch => `
  <div class="meter" data-ch="${ch}">
    <span class="ch">${ch}</span>
    <div class="bar"><div class="rms"></div><div class="peak"></div></div>
    <span class="clip">CLIP</span>
    <span class="val">-∞</span>
  </div>`).join('');

const dbToPct = (db: number) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));

/** root 안의 .meter[data-ch=L|R] 두 개를 칠한다 */
export function paintMeters(root: ParentNode, lv: [LevelPkt, LevelPkt] | null) {
  ['L', 'R'].forEach((ch, i) => {
    const el = root.querySelector<HTMLElement>(`.meter[data-ch="${ch}"]`);
    if (!el) return;
    const l = lv?.[i];
    const rms = el.querySelector<HTMLElement>('.rms')!, peak = el.querySelector<HTMLElement>('.peak')!;
    const rmsPct = l ? dbToPct(l.rmsDb) : 0;
    rms.style.width = rmsPct + '%';
    rms.style.setProperty('--w', rmsPct ? `${10000 / rmsPct}%` : '100%');
    peak.style.left = (l ? dbToPct(l.peakDb) : 0) + '%';
    el.querySelector('.clip')!.classList.toggle('on', !!l?.clip);
    el.querySelector('.val')!.textContent = l
      ? `${l.rmsDb <= -100 ? '-∞' : l.rmsDb.toFixed(1)} / ${l.peakDb <= -100 ? '-∞' : l.peakDb.toFixed(1)}` : '-∞';
  });
}

/** #hud0~#hud4 를 채운다 */
export function paintHud(lines: string[]) {
  for (let i = 0; i < 5; i++) {
    const el = document.getElementById(`hud${i}`);
    if (el) el.textContent = lines[i] ?? '';
  }
  document.getElementById('hud0')?.classList.toggle('alert', (lines[0] ?? '').startsWith('⚠'));
}

export function genreText(genre: string, genreAt: number): string {
  if (!genre) return '🎵 장르 판별 대기 중';
  if (!genreAt) return genre;          // 시각이 없는 상태 문구 (예: 무음 대기)
  return `${genre} · ${Math.max(0, Math.round((Date.now() - genreAt) / 1000))}초 전`;
}

export const clock = (t: number) => new Date(t).toLocaleTimeString('ko-KR', { hour12: false });
