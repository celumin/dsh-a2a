#!/usr/bin/env bash
# Round 2.5 端到端验收：NATS JetStream + a2a-way 网关 + pi-a2a be-daemon，
# 用本包的出站客户端走一遍「a2a_send → 网关 → v1.0 目标」。
#
# 前置：docker（nats 镜像）、go、node ≥ 22（需要 --experimental-transform-types）。
# 用法：bash scripts/e2e-round2.5.sh
# 环境变量：GATEWAY_PORT（默认 19090）、NATS_PORT（默认 14222）、A2A_WAY_DIR、PI_A2A_DIR。
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
A2A_WAY_DIR=${A2A_WAY_DIR:-$(cd "$ROOT/../a2a-way" && pwd)}
PI_A2A_DIR=${PI_A2A_DIR:-$(cd "$ROOT/../pi-a2a" && pwd)}
GATEWAY_PORT=${GATEWAY_PORT:-19090}
NATS_PORT=${NATS_PORT:-14222}
TOKEN=${E2E_TOKEN:-dev-token}
CALLER=${E2E_CALLER:-dsh-agent-lenovo}
PI_TOKEN=${E2E_PI_TOKEN:-"Bearer test"}

NATS_NAME=r25-e2e-nats
GW_LOG=/tmp/r25-e2e-gw.log
PI_LOG=/tmp/r25-e2e-pi.log

cleanup() {
  set +e
  pgrep -x a2a-way | xargs -r kill
  pkill -f "be-daemon.ts" 2>/dev/null
  docker rm -f "$NATS_NAME" >/dev/null 2>&1
}
trap cleanup EXIT

fail() { echo "e2e FAIL: $*" >&2; exit 1; }
wait_port() {
  local port=$1 tries=${2:-60}
  for _ in $(seq 1 "$tries"); do
    (ss -ltn 2>/dev/null | grep -q ":$port ") && return 0
    sleep 1
  done
  return 1
}

echo "== 1. NATS JetStream"
docker rm -f "$NATS_NAME" >/dev/null 2>&1 || true
docker run -d --rm --name "$NATS_NAME" -p "$NATS_PORT:4222" nats:2.11-alpine --jetstream >/dev/null
sleep 2
docker run --rm --network host natsio/nats-box:latest \
  nats --server "nats://127.0.0.1:$NATS_PORT" kv add a2a-agents --ttl=30m --storage=file >/dev/null 2>&1 || true

echo "== 2. pi-a2a be-daemon（v1.0 目标）"
(cd "$PI_A2A_DIR" && nohup node --experimental-transform-types scripts/be-daemon.ts >"$PI_LOG" 2>&1 &)
for _ in $(seq 1 20); do grep -q "HTTP    :" "$PI_LOG" 2>/dev/null && break; sleep 0.5; done
PI_PORT=$(grep "HTTP    :" "$PI_LOG" | head -1 | grep -oE '[0-9]+$')
[ -n "$PI_PORT" ] || fail "pi-a2a 未启动（见 $PI_LOG）"
echo "   pi-a2a on 127.0.0.1:$PI_PORT"

echo "== 3. 网关（带出站凭据注入）"
(cd "$A2A_WAY_DIR" && PI_TOKEN="$PI_TOKEN" \
  A2A_NATS_URL="nats://127.0.0.1:$NATS_PORT" \
  A2A_LISTEN_ADDR="127.0.0.1:$GATEWAY_PORT" \
  A2A_GATEWAY_BASE_URL="http://127.0.0.1:$GATEWAY_PORT" \
  A2A_AUTH_TOKENS="$CALLER:$TOKEN" \
  A2A_ADMIN_TOKEN=dev-admin-token \
  A2A_AGENT_TTL=30m \
  A2A_AGENT_OUTBOUND_AUTH="$CALLER:pi-gw-agent:Authorization:PI_TOKEN:http://127.0.0.1:$PI_PORT" \
  nohup go run ./cmd/a2a-way >"$GW_LOG" 2>&1 &)
wait_port "$GATEWAY_PORT" 60 || fail "网关未就绪（见 $GW_LOG）"

echo "== 4. 注册 pi-gw-agent"
node - "$GATEWAY_PORT" "$PI_PORT" "$TOKEN" <<'NODE'
const [port, piPort, token] = process.argv.slice(2)
const url = `http://127.0.0.1:${piPort}/rpc`
for (const agentId of ['pi-gw-agent', 'probe']) {
  const body = {
    agent_id: agentId, name: 'BE', description: 'BE daemon', version: '1.0.0', url,
    supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: false }, skills: [],
  }
  const res = await fetch(`http://127.0.0.1:${port}/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`register ${agentId} ${res.status}: ${await res.text()}`)
}
NODE

echo "== 5. a2a_send → 网关 → Pi"
cd "$ROOT"
node - "$GATEWAY_PORT" "$TOKEN" <<'NODE'
const [port, token] = process.argv.slice(2)
const { A2aClient } = await import(`file://${process.cwd()}/lib/client.js`)
const client = new A2aClient({
  baseUrl: `http://127.0.0.1:${port}/a2a/pi-gw-agent`,
  bearerToken: token,
  timeoutMs: 20000,
})
const card = await client.card()
const endpoint = await client.endpoint()
const out = await client.sendForText('round2.5 e2e ping', { kind: 'request', pollMs: 300 })
if (out.task.status.state !== 'completed') throw new Error(`state=${out.task.status.state}`)
if (out.text.trim() === '') throw new Error('empty reply')
console.log(JSON.stringify({ card: card.name, endpoint, state: out.task.status.state, reply: out.text.slice(0, 60) }))
NODE

echo "== 6. -32006（无匹配凭据规则）"
node - "$GATEWAY_PORT" "$TOKEN" <<'NODE'
const [port, token] = process.argv.slice(2)
const { A2aClient } = await import(`file://${process.cwd()}/lib/client.js`)
const { classifyError } = await import(`file://${process.cwd()}/lib/compat.js`)
const client = new A2aClient({ baseUrl: `http://127.0.0.1:${port}/a2a/probe`, bearerToken: token, timeoutMs: 5000 })
try {
  await client.sendForText('x')
  throw new Error('expected -32006')
} catch (e) {
  if (e.code !== -32006) throw e
  if (classifyError(e.code).retryable !== false) throw new Error('retryable should be false')
  console.log(JSON.stringify({ code: e.code, message: e.message }))
}
NODE

echo "== 7. -32005（深度闸，v0.3 方法名）"
RESP=$(curl -s -X POST "http://127.0.0.1:$GATEWAY_PORT/a2a/pi-gw-agent" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":9,"method":"message/send","params":{"metadata":{"_a2a_depth":99},"message":{"kind":"message","role":"user","parts":[{"kind":"text","text":"deep"}],"messageId":"m-deep"}}}')
echo "$RESP" | grep -q '"code":-32005' || fail "-32005 未触发: $RESP"
echo "   ok -32005"

echo
echo "e2e PASS"
