# Live Mix Assistant G2

스마트폰(크롬) 오디오 분석기 + Even Hub 수신기(G2 HUD) 듀얼 모드 웹앱 (Vite + TypeScript)

## 빌드
```bash
npm install
npm run build        # dist/ 생성 → Netlify 등에 업로드 (타입 검사 없이 빌드)
npm run typecheck    # 선택: tsc --noEmit
npm run dev          # 개발 서버 (https, --host)
```

## 모드
- 분석기: `/`  — 입력 장치(USB/마이크 또는 시스템 오디오 캡처) 선택 후 [시작]
- 수신기: `/?mode=hud` — Even Hub 웹뷰에서 열면 자동 연결 (마이크 권한 요청 없음)

## 통신 (무설정)
MQTT(wss://broker.emqx.io:8084/mqtt, 예비 wss://broker.hivemq.com:8884/mqtt, 토픽 `g2-live-mix-onax/hud/stream`)
+ `BroadcastChannel('g2-live-mix-hud-v1')` + localStorage storage 이벤트를 동시에 사용하고, 수신 쪽에서 중복을 제거합니다.
공개 브로커이므로 토픽을 아는 사람은 HUD 텍스트를 읽거나 보낼 수 있습니다.

## 튜닝 위치
- `src/config.ts`  모델 목록, 피드백 판정 상수, 주기 범위
- `src/balance.ts` 타겟 커브(4.5dB/oct), Solo 판별 기준, Crest 범위
- `src/ai.ts`      시스템 프롬프트(장르 분류 · Level/EQ/Comp 조언)
- `src/link.ts`    MQTT 브로커 주소/토픽
- `public/app.json`, `public/manifest.json` Even Hub 권한 / PWA
