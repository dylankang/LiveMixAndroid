# Live Mix Assistant — 로컬 ASIO 브릿지

브라우저는 Steinberg **ASIO 드라이버에 직접 접근할 수 없습니다.**
이 브릿지는 PC에서 ASIO 장치를 열고, 웹앱에서 고른 **L/R 두 채널**을 `ws://localhost:9876`으로 실시간 전송합니다.
브릿지를 실행해 두면 웹앱의 장치 목록 맨 위에 **`[ASIO] 장치명`**이 자동으로 나타납니다.

> ASIO가 필요 없다면 브릿지 없이도 됩니다. 웹앱은 브라우저 표준 입력(WASAPI/CoreAudio)으로도 다채널을 열고 L/R 채널을 고를 수 있습니다.
> 단, 브라우저·드라이버에 따라 2채널까지만 열리는 경우가 있으니 3번 이후 채널이 필요하면 브릿지를 쓰세요.

## 준비 (Windows · 처음 한 번)

1. [Python 3.10 이상](https://www.python.org/downloads/) 설치 — 설치 화면에서 **Add python.exe to PATH** 체크
2. 오디오 인터페이스의 ASIO 드라이버 설치 (예: Yamaha Steinberg USB Driver, Focusrite USB ASIO, RME 등)
3. 명령 프롬프트(cmd)에서 이 폴더로 이동한 뒤 패키지 설치

```bat
cd asio-bridge
pip install -r requirements.txt
```

`sounddevice` 0.4.6 이상의 Windows용 패키지에는 ASIO가 포함된 PortAudio가 들어 있습니다.
브릿지는 실행할 때 `SD_ENABLE_ASIO=1`을 자동으로 설정해 그 버전을 사용합니다.

## 실행

```bat
python bridge.py
```

```
ASIO 브릿지 실행 중: ws://localhost:9876  (종료: Ctrl+C)
  [12] Yamaha Steinberg USB ASIO · 16ch · 48000Hz · ASIO
```

그다음 웹앱(https://dylankang.github.io/LiveMixAndroid/)에서:

1. **오디오 입력** 카드의 배지가 `🟢 ASIO 브릿지 연결됨`으로 바뀌는지 확인
2. 장치 목록 맨 위의 `[ASIO] 장치명` 선택
3. **L 채널 / R 채널**(또는 `Ch 1-2`, `Ch 3-4` … 프리셋)을 콘솔 2트랙 매트릭스 출력이 들어오는 채널로 지정
4. **시작** — 분석 중에도 채널을 바꾸면 바로 적용됩니다

선택한 장치와 채널은 브라우저에 저장되어 다음에 열 때 자동으로 복원됩니다.

## 옵션

| 옵션 | 설명 |
|---|---|
| `--list` | 장치 목록만 출력하고 종료 |
| `--all` | ASIO 외 모든 입력 장치(WASAPI/MME/macOS CoreAudio)도 목록에 표시 (테스트용) |
| `--port 9876` | 포트 변경 (웹앱은 9876을 기다리므로 보통 그대로 두세요) |
| `--blocksize 480` | 전송 블록 크기(프레임). 48kHz 기준 480 = 10ms |
| `--allow-origin URL` | 연결을 허용할 웹앱 주소 추가 |
| `--any-origin` | 모든 웹페이지의 연결 허용 (권장하지 않음) |

## 보안

브릿지는 믹서 오디오를 그대로 내보내므로, **허용된 웹앱만 연결할 수 있습니다.**
기본 허용: `https://dylankang.github.io`, `http://localhost:*`, `http://127.0.0.1:*`.
다른 주소에서 웹앱을 연다면 `--allow-origin https://주소`를 붙여 실행하세요.
브릿지는 `localhost`에서만 열리므로 같은 PC 밖에서는 접속할 수 없습니다.

## 문제 해결

- **크롬에 "이 기기의 다른 앱 및 서비스에 액세스" 권한 창이 뜸** → **허용**을 누르세요. 웹페이지가 PC의 로컬 브릿지(localhost)에 접속하려면 필요합니다.
- **장치 목록에 ASIO 장치가 없음** → `python bridge.py --list --all`로 확인. ASIO 항목이 없다면 드라이버 설치와 `pip install -U sounddevice`를 확인하세요.
- **"Error opening InputStream" / 장치를 열 수 없음** → ASIO 드라이버는 보통 한 프로그램만 쓸 수 있습니다. DAW·다른 오디오 프로그램을 닫고 다시 시도하세요.
- **소리가 끊기거나 지연이 큼** → `--blocksize 960`으로 늘려 보세요. 웹앱은 지연을 약 0.1초로 유지하고, 밀리면 자동으로 따라잡습니다.
- **포트를 열 수 없음** → 브릿지가 이미 실행 중인지 확인하세요 (창 하나만 띄우면 됩니다).

## 프로토콜 (참고)

텍스트 = JSON 제어, 바이너리 = PCM (Float32 little-endian 인터리브 스테레오 `[L0,R0,L1,R1,…]`)

- 브릿지 → 웹: `hello`/`devices` (장치 목록), `opened` (장치·샘플레이트·채널), `closed`, `error`
- 웹 → 브릿지: `list`, `open {device,l,r}`, `route {l,r}`, `close` (채널 번호는 0부터)
