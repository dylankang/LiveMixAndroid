# Live Mix Assistant — 안드로이드 앱

Netlify에 올린 웹앱(분석기)을 앱 안에서 띄우는 얇은 껍데기 앱입니다.
웹 코드를 고쳐서 Netlify에 다시 배포하면 앱은 다시 빌드하지 않아도 새 버전이 열립니다.

## 크롬 대신 이 앱을 쓰는 이유
- 분석 중에는 알림이 뜨는 포그라운드 서비스가 켜져, 화면이 꺼지거나 Even 앱을 앞에 띄워도 분석·MQTT 전송이 멈추지 않습니다.
- CPU(wake lock)와 Wi-Fi 절전 해제를 분석 중에만 잡고, [정지]하면 바로 풉니다.
- 뒤로 가기를 눌러도 앱이 종료되지 않고 뒤로 숨습니다. 완전히 끄려면 메뉴 → [완전히 종료].

## APK 만들기

### 방법 1 — Android Studio (PC)
1. Android Studio 설치 → **Open** → 이 폴더(`LiveMixAndroid`) 선택
2. Gradle 동기화가 끝나면 메뉴 **Build → Build App Bundle(s) / APK(s) → Build APK(s)**
3. `app/build/outputs/apk/debug/app-debug.apk` 를 폰에 옮겨 설치
   (터미널: `./gradlew assembleDebug` — Windows 는 `gradlew.bat assembleDebug`) (출처를 알 수 없는 앱 설치 허용 필요)

### 방법 2 — GitHub Actions 자동 빌드 (PC 설치 없이)
`.github/workflows/android-build.yml` 이 들어 있습니다.
- 실행 조건: GitHub에 Push 할 때마다 자동 / Actions 탭 → **Android Build** → **Run workflow** 로 수동 실행
- 실행 내용: JDK 17 · Android SDK(platform 35, build-tools 35.0.0) 설치 → `./gradlew assembleDebug`
- 결과: 실행 화면 아래 **Artifacts → LiveMixAssistant-debug-apk** (zip 안에 `app-debug.apk`) — 30일 보관

1. GitHub에서 새 저장소(Private 권장) 생성
2. 이 폴더 내용을 그대로 올리기 (`gradlew`, `gradle/wrapper/gradle-wrapper.jar`, `.github/` 포함)
   - 웹에서 올릴 때: 저장소 → **Add file → Upload files** 에 폴더 안 파일을 모두 끌어다 놓기
     (`.github` 처럼 점으로 시작하는 폴더가 탐색기에서 안 보이면 숨김 파일 표시를 켜세요)
3. **Actions** 탭에서 빌드가 초록색 ✓ 로 끝나면 Artifacts 의 APK를 받아 폰에 설치

## 처음 실행
1. 웹앱 주소 입력: Netlify 기본 주소 (예: `https://내사이트.netlify.app/`) — 수신기 주소(`?mode=hud`)가 아님
2. [시작]을 누르면 마이크 권한 → 허용
3. "배터리 최적화에서 제외" 안내가 나오면 **제외하기** (화면 꺼짐 중 유지에 중요)
4. Even 앱의 수신기(`/?mode=hud`)는 그대로 사용

메뉴(오른쪽 위 ⋮): 새로고침 · 주소 변경 · 배터리 최적화 제외 · 완전히 종료

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
