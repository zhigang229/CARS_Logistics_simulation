#!/usr/bin/env bash
# 生成 IIS 发布包：dist/LogiSim-IIS-v<版本>.zip
set -euo pipefail
cd "$(dirname "$0")/.."

VER=$(sed -n "s/^const APP_VERSION='\([^']*\)'.*/\1/p" src/wwwroot/assets/js/app.js)
[[ -n "$VER" ]] || { echo "未能从 app.js 读取版本号"; exit 1; }
for f in "assets/js/app.js?v=$VER" "assets/js/sim-core.js?v=$VER" "assets/css/app.css?v=$VER"; do
  grep -q "$f" src/wwwroot/index.html || { echo "index.html 中缺少 $f（版本号不一致）"; exit 1; }
done
grep -q "ApiVersion = \"$VER\"" src/wwwroot/api/scenarios.ashx || { echo "scenarios.ashx 版本号与 $VER 不一致"; exit 1; }

NAME="LogiSim-IIS-v$VER"
OUT="dist/$NAME"
rm -rf "$OUT" "dist/$NAME.zip"
mkdir -p "$OUT"
cp -r src/wwwroot "$OUT/wwwroot"
rm -rf "$OUT/wwwroot/App_Data/scenarios"
cp -r deploy "$OUT/deploy"
cp DEPLOY.md README.md CHANGELOG.md "$OUT/"
(cd dist && zip -qr -X "$NAME.zip" "$NAME")
(cd dist && sha256sum "$NAME.zip" > "$NAME.zip.sha256")
echo "已生成 dist/$NAME.zip（$(du -h "dist/$NAME.zip" | cut -f1)）"
cat "dist/$NAME.zip.sha256"
