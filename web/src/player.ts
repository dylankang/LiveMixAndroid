// 🎵 내장 디지털 레퍼런스 플레이어 (볼륨 무관 원본 직결)
// 파일/URL/데모 루프를 재생하면서, 분석기는 미디어 요소의 디지털 원본(0dBFS 기준)을 그대로 받는다.
// - 분석 중: 요소 볼륨 1.0 고정, 귀로 듣는 볼륨은 AudioEngine 의 monitorGain(Post-Fader)으로만 조절
// - 분석 전/후: 요소가 직접 스피커로 재생 (청취 볼륨 = 요소 볼륨)
// createMediaElementSource 는 요소당 한 번만 가능하므로, 분석을 다시 시작/정지할 때마다 같은 소스·위치로 새 요소를 만든다.

const ls = {
  get: (k: string, d = '') => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const fmtTime = (s: number) => {
  if (!Number.isFinite(s) || s < 0) return '--:--';
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
};

/** 데모 루프: 스테레오 핑크 노이즈 8초 (RMS 약 -18 dBFS) — 타겟 커브의 기준음 */
function makePinkNoiseWav(sec = 8, rate = 44100): Blob {
  const n = sec * rate;
  const ch = [new Float32Array(n), new Float32Array(n)];
  for (const d of ch) {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;   // Paul Kellet 핑크 필터
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    }
    let sq = 0;
    for (let i = 0; i < n; i++) sq += d[i] * d[i];
    const g = Math.pow(10, -18 / 20) / Math.sqrt(sq / n);
    const fade = Math.floor(rate * 0.01);                            // 루프 이음새 클릭 방지
    for (let i = 0; i < n; i++) {
      const f = Math.min(1, i / fade, (n - 1 - i) / fade);
      d[i] = Math.max(-1, Math.min(1, d[i] * g * f));
    }
  }
  const buf = new ArrayBuffer(44 + n * 4);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 4, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (const d of ch) { v.setInt16(o, Math.round(d[i] * 32767), true); o += 2; }
  return new Blob([buf], { type: 'audio/wav' });
}

export class ReferencePlayer {
  el: HTMLAudioElement;
  vol: number;
  attached = false;                    // 분석기(AudioContext)에 연결된 상태
  private used = false;                // 이 요소로 이미 createMediaElementSource 를 했는지
  private objUrl: string | null = null;
  private demoUrl: string | null = null;
  private name = '';
  private seeking = false;
  onVolume: (v: number) => void = () => {};
  private q: <T extends HTMLElement>(id: string) => T;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="hint">🎵 <b>내장 디지털 레퍼런스 플레이어</b> — 파일의 디지털 원본 레벨(0dBFS 기준)을 그대로 분석합니다.
        폰 볼륨 버튼·무음 모드·아래 청취 볼륨과 상관없이 미터와 밴드 수치는 같습니다.</div>
      <div id="plMsg" class="plmsg" hidden></div>
      <div class="row">
        <button id="plFile" type="button">📂 파일 불러오기</button>
        <button id="plDemo" type="button">🎧 데모 루프</button>
      </div>
      <input id="plInput" type="file" accept="audio/*,video/*,.mp3,.wav,.flac,.m4a,.aac,.ogg,.mp4,.mov,.webm" hidden />
      <div class="devrow">
        <input id="plUrl" type="url" inputmode="url" placeholder="오디오/스트림 URL (CORS 허용 주소)" />
        <button id="plUrlBtn" type="button">URL 재생</button>
      </div>
      <div id="plName" class="plname">불러온 소스 없음</div>
      <div class="plctl">
        <button id="plPlay" type="button" disabled>▶</button>
        <input id="plSeek" type="range" min="0" max="0" step="0.1" value="0" disabled />
        <span id="plTime" class="pltime">--:-- / --:--</span>
      </div>
      <label>청취 볼륨 (Post-Fader · 귀로 듣는 소리만, 분석에는 영향 없음) <small id="plVolTxt"></small>
        <input id="plVol" type="range" min="0" max="1" step="0.01" />
      </label>
      <label class="chk"><input id="plLoop" type="checkbox" checked /> 반복 재생</label>`;
    this.q = <T extends HTMLElement>(id: string) => root.querySelector('#' + id) as T;
    this.vol = Math.min(1, Math.max(0, parseFloat(ls.get('lm.plvol', '0.8')) || 0));
    this.el = this.makeEl();

    const vol = this.q<HTMLInputElement>('plVol');
    vol.value = String(this.vol);
    const paintVol = () => { this.q('plVolTxt').textContent = `${Math.round(this.vol * 100)}%`; };
    vol.oninput = () => {
      this.vol = parseFloat(vol.value); ls.set('lm.plvol', String(this.vol)); paintVol();
      if (this.attached) this.onVolume(this.vol); else this.el.volume = this.vol;
    };
    paintVol();

    const input = this.q<HTMLInputElement>('plInput');
    this.q('plFile').onclick = () => input.click();
    input.onchange = () => { const f = input.files?.[0]; if (f) { this.loadFile(f); void this.play(); } input.value = ''; };
    this.q('plDemo').onclick = () => { this.loadDemo(); void this.play(); };
    this.q('plUrlBtn').onclick = () => {
      const u = this.q<HTMLInputElement>('plUrl').value.trim();
      if (!/^https?:\/\//i.test(u)) { this.msg('http(s):// 로 시작하는 주소를 입력하세요'); return; }
      this.loadUrl(u); void this.play();
    };
    this.q('plPlay').onclick = () => { if (this.el.paused) void this.play(); else this.el.pause(); };
    const seek = this.q<HTMLInputElement>('plSeek');
    seek.oninput = () => { this.seeking = true; this.q('plTime').textContent = `${fmtTime(+seek.value)} / ${fmtTime(this.el.duration)}`; };
    seek.onchange = () => { this.el.currentTime = +seek.value; this.seeking = false; };
    this.q<HTMLInputElement>('plLoop').onchange = () => { this.el.loop = this.q<HTMLInputElement>('plLoop').checked; };
  }

  get hasSource() { return !!this.el.getAttribute('src'); }

  msg(text: string) { const m = this.q('plMsg'); m.textContent = text; m.hidden = !text; }

  private makeEl(): HTMLAudioElement {
    const a = document.createElement('audio');
    a.preload = 'auto';
    a.setAttribute('playsinline', '');
    a.loop = this.q ? this.q<HTMLInputElement>('plLoop').checked : true;
    a.volume = this.attached ? 1 : this.vol;
    const paint = () => this.paint();
    ['play', 'pause', 'ended', 'loadedmetadata', 'durationchange', 'timeupdate', 'emptied'].forEach(e => a.addEventListener(e, paint));
    a.addEventListener('error', () => {
      if (!a.getAttribute('src')) return;
      this.msg(a.crossOrigin
        ? '이 주소는 재생·분석할 수 없습니다 (서버가 CORS를 허용하지 않거나 지원하지 않는 형식). 파일로 받아서 [📂 파일 불러오기]를 사용하세요.'
        : '이 파일 형식은 이 브라우저에서 재생할 수 없습니다.');
      this.paint();
    });
    return a;
  }

  private paint() {
    const a = this.el;
    const has = this.hasSource;
    const play = this.q<HTMLButtonElement>('plPlay'), seek = this.q<HTMLInputElement>('plSeek');
    play.disabled = !has; seek.disabled = !has || !Number.isFinite(a.duration);
    play.textContent = a.paused ? '▶' : '❚❚';
    if (Number.isFinite(a.duration)) seek.max = String(a.duration);
    if (!this.seeking) seek.value = String(a.currentTime || 0);
    this.q('plTime').textContent = `${fmtTime(a.currentTime)} / ${Number.isFinite(a.duration) ? fmtTime(a.duration) : (has ? 'LIVE' : '--:--')}`;
    this.q('plName').textContent = has ? `${a.paused ? '⏸' : '▶'} ${this.name}` : '불러온 소스 없음';
  }

  private setSrc(url: string, name: string, cors: boolean) {
    this.msg('');
    this.name = name;
    if (cors) this.el.crossOrigin = 'anonymous'; else this.el.removeAttribute('crossorigin');
    this.el.src = url;
    this.el.load();
    this.paint();
  }

  loadFile(f: File) {
    if (this.objUrl) URL.revokeObjectURL(this.objUrl);
    this.objUrl = URL.createObjectURL(f);
    this.setSrc(this.objUrl, f.name, false);
  }

  loadDemo() {
    this.demoUrl ??= URL.createObjectURL(makePinkNoiseWav());
    this.q<HTMLInputElement>('plLoop').checked = true;
    this.el.loop = true;
    this.setSrc(this.demoUrl, '데모 루프 · 스테레오 핑크 노이즈 (RMS -18 dBFS)', false);
  }

  loadUrl(u: string) { this.setSrc(u, u.replace(/^https?:\/\//, ''), true); }

  async play() {
    try { await this.el.play(); }
    catch (e) { if ((e as Error).name !== 'AbortError') this.msg('재생을 시작하지 못했습니다: ' + (e as Error).message); }
  }

  /** 분석 시작 직전: AudioContext 에 연결할 (아직 쓰지 않은) 요소를 돌려준다 */
  takeForAnalysis(): HTMLAudioElement {
    this.attached = true;
    if (this.used) this.replace();
    this.used = true;
    this.el.volume = 1;                // 분석 경로 원본 유지 · 청취 볼륨은 monitorGain 이 담당
    return this.el;
  }

  /** 분석 정지/다른 입력으로 전환: 같은 소스·위치로 새 요소를 만들어 스피커로 직접 재생되게 한다 */
  release() {
    if (!this.attached) return;
    this.attached = false;
    this.replace();
  }

  private replace() {
    const old = this.el;
    const src = old.getAttribute('src');
    const t = old.currentTime || 0;
    const wasPlaying = !old.paused;
    old.pause();
    const n = this.makeEl();
    if (old.crossOrigin) n.crossOrigin = old.crossOrigin;
    this.el = n;
    this.used = false;
    old.removeAttribute('src'); old.load();
    if (src) {
      n.src = src;
      n.addEventListener('loadedmetadata', () => { try { if (t && Number.isFinite(n.duration)) n.currentTime = Math.min(t, n.duration); } catch { /* ignore */ } }, { once: true });
      n.load();
      if (wasPlaying) void this.play();
    }
    this.paint();
  }
}
