#!/usr/bin/env python3
"""
Live Mix Assistant G2 — 로컬 ASIO 브릿지

브라우저는 Steinberg ASIO 드라이버에 직접 접근할 수 없으므로, 이 스크립트가 PC 에서
ASIO 장치를 열고 선택한 L/R 두 채널을 ws://localhost:9876 으로 웹앱에 실시간 전송한다.

프로토콜 (텍스트 = JSON 제어, 바이너리 = PCM)
  브릿지 → 웹:  {"type":"hello"|"devices", "devices":[{id,name,channels,sampleRate,hostapi}]}
               {"type":"opened", device, name, sampleRate, channels, l, r}
               {"type":"closed"}   {"type":"error", "message": "..."}
               <binary>  Float32 little-endian 인터리브 스테레오 [L0,R0,L1,R1,...]
  웹 → 브릿지:  {"type":"list"}  {"type":"open","device":N,"l":0,"r":1}  {"type":"route","l":2,"r":3}  {"type":"close"}

실행:  python bridge.py            (ASIO 장치만)
       python bridge.py --all      (WASAPI/MME 등 모든 입력 장치도 표시 · 테스트용)
       python bridge.py --list     (장치 목록만 출력하고 종료)
"""
import os

# sounddevice 의 Windows 용 PortAudio 중 ASIO 가 포함된 DLL 을 쓰도록 (import 전에 설정해야 함)
os.environ.setdefault("SD_ENABLE_ASIO", "1")

import argparse
import asyncio
import json
import re
import sys
import threading

import numpy as np
import sounddevice as sd
import websockets

VERSION = 1
DEFAULT_ORIGINS = ["https://dylankang.github.io"]
LOCAL_ORIGIN = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$")


def list_devices(include_all: bool):
    """입력 채널이 있는 장치 목록 (기본: ASIO 호스트 API 만)"""
    apis = sd.query_hostapis()
    out = []
    for idx, d in enumerate(sd.query_devices()):
        if int(d["max_input_channels"]) <= 0:
            continue
        api = apis[d["hostapi"]]["name"]
        if not include_all and "ASIO" not in api:
            continue
        out.append({
            "id": idx,
            "name": d["name"],
            "channels": int(d["max_input_channels"]),
            "sampleRate": int(round(d["default_samplerate"])),
            "hostapi": api,
        })
    return out


class Session:
    """웹소켓 연결 하나 = 열린 입력 스트림 하나"""

    def __init__(self, ws, loop, blocksize: int):
        self.ws = ws
        self.loop = loop
        self.blocksize = blocksize
        self.stream = None
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=100)   # 약 1초 (480 프레임 블록 기준)
        self.lock = threading.Lock()
        self.pick = (0, 1)        # 열린 스트림 안에서 L/R 로 쓸 열 번호
        self.info = None          # 마지막으로 연 장치 정보 (opened 메시지)
        self.device = None
        self.selectors = False    # True = ASIO channel_selectors 로 L/R 두 채널만 연 상태

    # ── 오디오 콜백 (PortAudio 스레드) ──
    def _callback(self, indata, frames, time_info, status):
        with self.lock:
            li, ri = self.pick
        cols = indata.shape[1]
        L = indata[:, min(li, cols - 1)]
        R = indata[:, min(ri, cols - 1)]
        block = np.empty(frames * 2, dtype=np.float32)
        block[0::2] = L
        block[1::2] = R
        self.loop.call_soon_threadsafe(self._enqueue, block.tobytes())

    def _enqueue(self, data: bytes):
        if self.queue.full():                 # 웹이 못 따라오면 오래된 블록부터 버려 지연이 쌓이지 않게
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        self.queue.put_nowait(data)

    async def pump(self):
        while True:
            data = await self.queue.get()
            await self.ws.send(data)

    # ── 장치 열기 / 채널 변경 / 닫기 ──
    def open(self, device: int, l: int, r: int):
        d = sd.query_devices(device)
        api = sd.query_hostapis(d["hostapi"])["name"]
        n = int(d["max_input_channels"])
        if n <= 0:
            raise ValueError(f"입력 채널이 없는 장치입니다: {d['name']}")
        if not (0 <= l < n and 0 <= r < n):
            raise ValueError(f"채널 범위를 벗어났습니다 (장치 입력 {n}채널, 요청 L={l + 1} R={r + 1})")
        self.close()                               # 검증을 통과한 뒤에만 기존 스트림을 닫는다
        sr = float(d["default_samplerate"])
        extra = None
        if "ASIO" in api and hasattr(sd, "AsioSettings"):
            # ASIO: 필요한 두 채널만 연다 (모노면 한 채널) — SoundGrid 처럼 48/64/128 채널 드라이버도 Ch 47·48 두 개만 연다
            sel = [l] if l == r else [l, r]
            extra = sd.AsioSettings(channel_selectors=sel)
            channels = len(sel)
            pick = (0, 0 if l == r else 1)
            self.selectors = True
        else:
            channels = max(l, r) + 1
            pick = (l, r)
            self.selectors = False
        with self.lock:
            self.pick = pick
        # 전송 블록: 지정이 없으면 샘플레이트에 맞춰 약 10ms (48kHz → 480, 96kHz → 960 · SoundGrid 96k 대응)
        bs = self.blocksize or max(64, int(round(sr / 100)))
        stream = sd.InputStream(
            device=device, channels=channels, samplerate=sr, dtype="float32",
            blocksize=bs, latency="low", extra_settings=extra, callback=self._callback,
        )
        stream.start()
        self.stream = stream
        self.device = device
        self.info = {
            "device": device, "name": d["name"], "sampleRate": int(round(stream.samplerate)),
            "channels": n, "l": l, "r": r, "hostapi": api,
        }
        return self.info

    def route(self, l: int, r: int):
        if self.stream is None or self.info is None:
            raise ValueError("열린 장치가 없습니다")
        n = self.info["channels"]
        if not (0 <= l < n and 0 <= r < n):
            raise ValueError(f"채널 범위를 벗어났습니다 (장치 입력 {n}채널)")
        if self.selectors or max(l, r) >= self.stream.channels:
            return self.open(self.device, l, r)      # ASIO 선택 채널이 바뀌면 다시 연다
        with self.lock:
            self.pick = (l, r)
        self.info = {**self.info, "l": l, "r": r}
        return self.info

    def close(self):
        s, self.stream = self.stream, None
        if s is not None:
            try:
                s.stop()
                s.close()
            except Exception:
                pass


def origin_of(ws):
    req = getattr(ws, "request", None)              # websockets >= 13
    headers = getattr(req, "headers", None) if req is not None else None
    if headers is None:
        headers = getattr(ws, "request_headers", None)   # websockets < 13
    try:
        return headers.get("Origin") if headers is not None else None
    except Exception:
        return None


def origin_allowed(origin, allowed):
    if origin is None:
        return True                                # 브라우저가 아닌 로컬 도구
    return origin in allowed or bool(LOCAL_ORIGIN.match(origin))


def make_handler(args):
    allowed = set(DEFAULT_ORIGINS + (args.allow_origin or []))

    async def handler(ws, path=None):
        origin = origin_of(ws)
        if not args.any_origin and not origin_allowed(origin, allowed):
            print(f"[거부] 허용되지 않은 웹페이지의 연결: {origin}  (허용하려면 --allow-origin {origin})")
            await ws.close(code=4003, reason="origin not allowed")
            return
        print(f"[연결] {origin or '(origin 없음)'}")
        session = Session(ws, asyncio.get_running_loop(), args.blocksize)
        await ws.send(json.dumps({"type": "hello", "version": VERSION, "devices": list_devices(args.all)}, ensure_ascii=False))
        pump = asyncio.create_task(session.pump())
        try:
            async for msg in ws:
                if isinstance(msg, (bytes, bytearray)):
                    continue
                try:
                    m = json.loads(msg)
                except ValueError:
                    continue
                t = m.get("type")
                try:
                    if t == "list":
                        await ws.send(json.dumps({"type": "devices", "devices": list_devices(args.all)}, ensure_ascii=False))
                    elif t == "open":
                        info = session.open(int(m["device"]), int(m.get("l", 0)), int(m.get("r", 1)))
                        print(f"[열기] {info['name']} · {info['sampleRate']}Hz · L=Ch{info['l'] + 1} R=Ch{info['r'] + 1}")
                        await ws.send(json.dumps({"type": "opened", **info}, ensure_ascii=False))
                    elif t == "route":
                        info = session.route(int(m.get("l", 0)), int(m.get("r", 1)))
                        print(f"[채널] L=Ch{info['l'] + 1} R=Ch{info['r'] + 1}")
                        await ws.send(json.dumps({"type": "opened", **info}, ensure_ascii=False))
                    elif t == "close":
                        session.close()
                        await ws.send(json.dumps({"type": "closed"}))
                except Exception as e:                       # 장치 오류는 웹앱에 그대로 알림
                    print(f"[오류] {e}")
                    await ws.send(json.dumps({"type": "error", "message": str(e)}, ensure_ascii=False))
        except websockets.ConnectionClosed:
            pass
        finally:
            pump.cancel()
            session.close()
            print("[해제] 연결 종료")

    return handler


async def serve(args):
    async with websockets.serve(make_handler(args), args.host, args.port, max_size=2 ** 20, compression=None):
        print(f"ASIO 브릿지 실행 중: ws://{args.host}:{args.port}  (종료: Ctrl+C)")
        devs = list_devices(args.all)
        if devs:
            for d in devs:
                print(f"  [{d['id']}] {d['name']} · {d['channels']}ch · {d['sampleRate']}Hz · {d['hostapi']}")
        else:
            print("  ※ ASIO 입력 장치를 찾지 못했습니다. 드라이버 설치를 확인하거나 --all 로 다른 장치를 확인하세요.")
        await asyncio.Future()


def main():
    p = argparse.ArgumentParser(description="Live Mix Assistant 로컬 ASIO 브릿지 (ws://localhost:9876)")
    p.add_argument("--host", default="localhost")
    p.add_argument("--port", type=int, default=9876)
    p.add_argument("--all", action="store_true", help="ASIO 외 모든 입력 장치(WASAPI/MME/CoreAudio)도 표시")
    p.add_argument("--list", action="store_true", help="장치 목록만 출력하고 종료")
    p.add_argument("--blocksize", type=int, default=0, help="전송 블록 크기(프레임) · 기본 0 = 자동(약 10ms: 48kHz 480 / 96kHz 960)")
    p.add_argument("--allow-origin", action="append", help="연결을 허용할 웹앱 주소 추가 (예: https://example.com)")
    p.add_argument("--any-origin", action="store_true", help="모든 웹페이지의 연결 허용 (권장하지 않음)")
    args = p.parse_args()
    if args.list:
        for d in list_devices(args.all):
            print(f"[{d['id']}] {d['name']} · {d['channels']}ch · {d['sampleRate']}Hz · {d['hostapi']}")
        return
    try:
        asyncio.run(serve(args))
    except KeyboardInterrupt:
        print("\n종료")
    except OSError as e:
        print(f"포트 {args.port} 를 열 수 없습니다: {e}  (이미 브릿지가 실행 중인지 확인하세요)")
        sys.exit(1)


if __name__ == "__main__":
    main()
