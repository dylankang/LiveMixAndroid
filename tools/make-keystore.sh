#!/usr/bin/env bash
# Release 서명 키 생성 + GitHub Secrets 에 넣을 값 출력 (한 번만 실행, 키 파일은 안전한 곳에 백업!)
# 사용: bash tools/make-keystore.sh
set -euo pipefail
OUT="${1:-livemix-release.jks}"
ALIAS="livemix"
read -r -s -p "키스토어 비밀번호(6자 이상): " PASS; echo
keytool -genkeypair -v -keystore "$OUT" -alias "$ALIAS" -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$PASS" -keypass "$PASS" -dname "CN=Live Mix Assistant, O=Live Mix, C=KR"
echo
echo "=== GitHub → Settings → Secrets and variables → Actions → New repository secret ==="
echo "ANDROID_KEYSTORE_PASSWORD = (방금 입력한 비밀번호)"
echo "ANDROID_KEY_PASSWORD      = (같은 비밀번호)"
echo "ANDROID_KEY_ALIAS         = $ALIAS"
echo "ANDROID_KEYSTORE_BASE64   = 아래 한 줄 전체"
base64 -w0 "$OUT" 2>/dev/null || base64 "$OUT" | tr -d '\n'
echo
echo
echo "⚠ $OUT 파일은 분실하면 앱 업데이트(덮어 설치)가 불가능해집니다. 안전한 곳에 백업하고 저장소에는 올리지 마세요(.gitignore 처리됨)."
