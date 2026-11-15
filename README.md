# Live Mix Assistant G2 — PC 분석기 + Even G2 HUD

- **분석기 (PC 브라우저)**: https://dylankang.github.io/LiveMixAndroid/
  - 오디오 입력: WDM(브라우저 표준) 입력 장치 · 최대 64채널 열기 · L/R 채널 선택(스테레오 페어 빠른 선택)
  - 콘솔 2트랙 매트릭스 출력을 받아 6밴드·트랜지언트·크레스트·음성비율을 분석하고 Gemini 로 믹싱 조언
- **수신기 (Even G2 / 폰)**: `https://dylankang.github.io/LiveMixAndroid/?mode=hud&code=XXXX`
  - PC 분석기 상단의 **4자리 연결 코드**로 연결 (클라우드 MQTT · PC 유선 LAN ↔ 폰 5G/LTE 처럼 네트워크가 달라도 됨)
  - 토픽 `livemix/g2/{CODE}/hud` (상태, retain) · `livemix/g2/{CODE}/status` (PC 하트비트 2초)
- **조언 민감도**: ±10dB(둔감) ~ ±0dB. ±0dB 는 로컬 필터 없이 분석 주기마다 무조건 AI 로 보내는 '항상 AI' 모드

---

## (보류) Android 단독 앱

웹앱(분석기 + G2 HUD 수신기)이 **APK 안에 통째로 포함**되어 있어서 Netlify·별도 웹 서버 없이 이 앱만으로 동작합니다.
인터넷은 AI API(Gemini 등)와 MQTT 연결에만 사용합니다.

- `web/` : 웹앱 소스 (Vite + TypeScript) — 빌드 결과가 `app/src/main/assets/www` 로 앱에 포함됨
- `app/` : 안드로이드 앱 (WebView 가 내부 파일을 https://appassets.androidplatform.net/ 가상 주소로 불러옴 → 마이크 사용 가능)
- 앱 메뉴(⋮) → **G2 수신기 주소** : Even 앱에서 열 주소(`http://127.0.0.1:8765/?mode=hud`). 폰 안에서만 열리는 내장 서버라 외부 서비스가 필요 없습니다. (앱이 실행 중이어야 함)

## 빌드
- **GitHub Actions**: Push 하면 자동으로 웹 빌드 → APK 빌드 (아래 설명).
- **로컬(Android Studio)**: 먼저 `bash tools/build-web.sh` (Node.js 18+) 로 웹앱을 앱에 포함시킨 뒤 빌드. 웹 코드를 고치면 이 스크립트를 다시 실행하세요.

---

## 버전 · APK 파일명 · Release 배포

### 버전 올리기 (한 곳만 수정)
`version.properties` 의 두 줄만 고치면 됩니다.
```
VERSION_NAME=1.0.1     # 화면에 보이는 버전
VERSION_CODE=2         # 업데이트마다 +1 (필수)
```
→ APK 파일명 `LiveMixAssistant-v1.0.1.apk`, 앱 정보의 버전에 자동 반영됩니다.
(Debug 는 `LiveMixAssistant-v1.0.1-debug.apk`)

### 빌드 종류
| 동작 | 결과 |
|---|---|
| 브랜치에 Push | Debug APK → Actions Artifact |
| Actions → Run workflow → debug / release / both | 선택한 APK |
| `v1.0.1` 태그 Push | 서명된 Release APK → Artifact + **GitHub Releases 페이지에 APK 첨부** |

### Release 서명 키 설정 (처음 한 번)
1. 내 PC 에서 `bash tools/make-keystore.sh` 실행 (JDK 필요). 키 파일 `livemix-release.jks` 가 만들어지고, Secrets 에 넣을 값이 출력됩니다.
2. GitHub 저장소 → **Settings → Secrets and variables → Actions → New repository secret** 에 4개 등록
   `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`
3. `.jks` 파일은 **백업 필수**(분실하면 기존 설치본에 업데이트 불가), 저장소에는 올리지 마세요(.gitignore 처리).
키는 빌드 중에만 임시 파일로 복원되고 끝나면 삭제됩니다. Secrets 값은 로그에 `***` 로 가려집니다.

### 새 버전 배포 순서
```
version.properties 수정 → git commit & push → git tag v1.0.1 → git push origin v1.0.1
```
태그 번호와 `VERSION_NAME` 이 다르면 빌드가 일부러 실패합니다(실수 방지).

### 다운로드 링크 찾기
- 빌드 실행 페이지 맨 위 **Summary** 에 Debug/Release APK 링크가 표로 나옵니다.
- 태그 빌드는 저장소 오른쪽 **Releases** 에 APK 가 올라가고, 폰 브라우저에서 바로 받을 수 있습니다.
