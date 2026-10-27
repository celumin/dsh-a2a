// 矩阵 18 联调驱动：0.6.0 客户端 → 真实对端（Pi be-daemon / Hermes）
// 用法: node tests/live-r8.mjs <targetBase> [text]
// 抓出站字节：monkey-patch 全局 fetch，记录 POST body 与 method。
const target = process.argv[2];
const text = process.argv[3] || 'R8 联调：0.6.0 v1.0 出站形状验证';

const wire = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (init?.method === 'POST') {
    wire.push({ url: String(url), headers: init.headers, body: init.body });
  }
  return realFetch(url, init);
};

const { A2aClient } = await import('../lib/client.js');

const client = new A2aClient({
  baseUrl: target,
  allowPatterns: ['*'],
  peerName: 'dsh-agent',
  bearerToken: process.env.R8_BEARER || 'test',
  timeoutMs: Number(process.env.R8_TIMEOUT_MS) || 60000,
});

const card = await client.card();
console.log('== CARD ==');
console.log(JSON.stringify({
  protocolVersion: card.protocolVersion,
  protocolVersions: card.protocolVersions,
  supportedInterfaces: card.supportedInterfaces,
  capabilities: card.capabilities,
}, null, 1));

const decision = await client.endpoint();
console.log('== ENDPOINT ==');
console.log(JSON.stringify(decision));

const { task, text: reply } = await client.sendForText(text, { kind: 'request' });
console.log('== TASK ==');
console.log(JSON.stringify(task, null, 1));
console.log('== REPLY TEXT ==');
console.log(reply);

console.log('== OUTBOUND WIRE ==');
for (const w of wire) {
  console.log('POST', w.url);
  console.log('headers:', JSON.stringify(w.headers));
  console.log('body:', w.body);
}
