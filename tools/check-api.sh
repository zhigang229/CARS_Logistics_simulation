#!/usr/bin/env bash
# 在 Linux 上用 Mono 检查 api/scenarios.ashx：
#   1. 以 C# 5 语法编译（与 IIS 运行时编译器一致）
#   2. 用测试宿主运行真实处理程序，逐个验证接口
# 依赖：mono-devel（mcs）、curl
set -euo pipefail
cd "$(dirname "$0")/.."
WORK=$(mktemp -d)
DATA=/tmp/logisim-test-data
PORT=${PORT:-8099}
trap 'kill $HOST_PID 2>/dev/null || true; rm -rf "$WORK"' EXIT

tail -n +2 src/wwwroot/api/scenarios.ashx > "$WORK/api.cs"
mcs -langversion:5 -warnaserror+ -nowarn:0618 -target:library -r:System.Web -r:System.Data -r:System.Configuration -out:"$WORK/api.dll" "$WORK/api.cs"
echo "✓ C# 5 编译通过"

mcs -langversion:5 -r:System.Web -r:System.Data -r:System.Configuration -out:"$WORK/TestHost.exe" "$WORK/api.cs" tools/testhost/TestHost.cs
sed "s#/tmp/logisim-test-data#$DATA#" tools/testhost/TestHost.exe.config > "$WORK/TestHost.exe.config"
rm -rf "$DATA"
mono "$WORK/TestHost.exe" src/wwwroot "http://127.0.0.1:$PORT/" > "$WORK/host.log" 2>&1 &
HOST_PID=$!
sleep 3

B="http://127.0.0.1:$PORT/api/scenarios.ashx"; H="X-LogiSim-Client: test"; fail=0
expect() { # 名称 期望状态码 期望包含 curl参数...
  local name=$1 code=$2 want=$3; shift 3
  local out; out=$(curl -s -w '\n%{http_code}' "$@")
  local got=${out##*$'\n'} body=${out%$'\n'*}
  if [[ "$got" == "$code" && "$body" == *"$want"* ]]; then echo "✓ $name"; else echo "✗ $name：HTTP $got $body"; fail=1; fi
}
expect "健康检查"           200 '"storage":"File"' "$B?action=health"
expect "新建方案"           200 '"rev":1'          -X POST -H "$H" --data '{"name":"t"}' "$B?action=save&id=t1&rev=-1&name=t"
expect "过期版本被拒绝"      409 '"conflict":true'  -X POST -H "$H" --data '{"a":1}' "$B?action=save&id=t1&rev=0&name=t"
expect "按版本更新"          200 '"rev":2'          -X POST -H "$H" --data '{"a":2}' "$B?action=save&id=t1&rev=1&name=%E6%96%B0"
expect "重复新建被拒绝"      409 '"conflict":true'  -X POST -H "$H" --data '{"a":3}' "$B?action=save&id=t1&rev=-1&name=t"
expect "保存仿真结果"        200 '"ok":true'        -X POST -H "$H" --data '{"util":0.8}' "$B?action=result&id=t1"
expect "列表含结果与中文名"  200 '"name":"新"'      "$B?action=list"
expect "读取方案"            200 '"data":{"a":2}'   "$B?action=get&id=t1"
expect "缺少请求头被拒绝"    403 '"ok":false'       -X POST --data '{}' "$B?action=delete&id=t1"
expect "GET 写操作被拒绝"    405 '"ok":false'       "$B?action=delete&id=t1"
expect "非法编号被拒绝"      400 '"ok":false'       "$B?action=get&id=..%2Fweb.config"
expect "非 JSON 内容被拒绝"  400 '"ok":false'       -X POST -H "$H" --data 'hello' "$B?action=save&id=t2&rev=-1"
expect "不存在返回 404"      404 '"ok":false'       "$B?action=get&id=nope"
expect "删除方案"            200 '"ok":true'        -X POST -H "$H" --data '{}' "$B?action=delete&id=t1&rev=2"
expect "删除后列表为空"      200 '"items":[]'       "$B?action=list"
exit $fail
