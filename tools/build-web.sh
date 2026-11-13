#!/usr/bin/env bash
# 웹앱(web/)을 빌드해서 앱 안에 포함(app/src/main/assets/www)시킵니다. (Node.js 18+ 필요)
# GitHub Actions 는 이 스크립트를 자동으로 실행합니다. 로컬(Android Studio) 빌드 전에는 한 번 실행하세요.
set -euo pipefail
cd "$(dirname "$0")/../web"
npm install --no-audit --no-fund
npx vite build --mode app
OUT=../app/src/main/assets/www
rm -rf "$OUT"; mkdir -p "$OUT"
cp -r dist/. "$OUT"/
cp node_modules/mqtt/dist/mqtt.min.js "$OUT"/mqtt.min.js
rm -f "$OUT"/sw.js "$OUT"/_headers
test -s "$OUT/index.html" && test -s "$OUT/mqtt.min.js" || { echo "웹 빌드 결과가 비어 있습니다" >&2; exit 1; }
echo "OK: $(find "$OUT" -type f | wc -l)개 파일 → $OUT"
