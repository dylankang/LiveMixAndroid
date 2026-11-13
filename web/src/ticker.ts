// 백그라운드(화면 꺼짐) 타이머 안정화: Web Worker 안에서 setInterval을 돌려 메인 스레드 타이머 스로틀링을 피한다.
// Worker를 만들 수 없는 환경에서는 window.setInterval 로 자동 대체.
const WORKER_SRC = `
const t = new Map();
onmessage = e => {
  const d = e.data;
  if (d.cmd === 'set') { clearInterval(t.get(d.id)); t.set(d.id, setInterval(() => postMessage(d.id), d.ms)); }
  else if (d.cmd === 'clear') { clearInterval(t.get(d.id)); t.delete(d.id); }
};`;

let worker: Worker | null = null;
let workerFailed = false;
let nextId = 1;
const cbs = new Map<number, () => void>();
const fallback = new Map<number, number>();

function ensureWorker(): Worker | null {
  if (worker || workerFailed) return worker;
  try {
    worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' })));
    worker.onmessage = e => { try { cbs.get(e.data as number)?.(); } catch (err) { console.warn('ticker cb error', err); } };
  } catch { workerFailed = true; worker = null; }
  return worker;
}

export function setTicker(fn: () => void, ms: number): number {
  const id = nextId++;
  cbs.set(id, fn);
  const w = ensureWorker();
  if (w) w.postMessage({ cmd: 'set', id, ms });
  else fallback.set(id, window.setInterval(fn, ms));
  return id;
}

export function clearTicker(id: number) {
  if (!id) return;
  cbs.delete(id);
  worker?.postMessage({ cmd: 'clear', id });
  const f = fallback.get(id);
  if (f !== undefined) { clearInterval(f); fallback.delete(id); }
}

/** 한 번만 실행하는 Worker 타이머 (백그라운드에서도 setTimeout 처럼 크게 늦어지지 않음) */
export function later(fn: () => void, ms: number): number {
  const id = setTicker(() => { clearTicker(id); fn(); }, ms);
  return id;
}
