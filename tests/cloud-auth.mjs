import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions, Response as MockResponse } from 'miniflare';

const origin = 'https://terminal.example.test';
let githubCalls = 0;
const deviceToken = randomBytes(32).toString('base64url');
const live = process.argv.includes('--live');
let liveDevice;
const mf = new Miniflare(convertV4MiniflareOptions({
  name: 'thyrqel-test', modules: true, scriptPath: 'dist/cloudflare/index.js',
  compatibilityDate: '2026-09-21', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
  kvNamespaces: ['OAUTH_KV'],
  ratelimits: { AUTH_LIMIT: { namespace_id: '1001', simple: { limit: 60, period: 60 } } },
  durableObjects: { BROKER: { className: 'Broker', useSQLite: true } },
  bindings: { PUBLIC_ORIGIN: origin, OWNER_GITHUB_ID: '3959289', GITHUB_CLIENT_ID: 'test-app', GITHUB_CLIENT_SECRET: 'test-secret',
    DEVICE_TOKEN_SHA256: createHash('sha256').update(deviceToken).digest('hex') },
  outboundService: async request => {
    githubCalls++;
    if (request.url === 'https://github.com/login/oauth/access_token') return MockResponse.json({ access_token: 'test-upstream-token' });
    if (request.url === 'https://api.github.com/user') return MockResponse.json({ id: 3959289 });
    throw new Error('Unexpected outbound request');
  },
}));
try {
  const dispatch = (path, init) => mf.dispatchFetch(`${origin}${path}`, { ...init, redirect: 'manual' });
  assert.equal((await dispatch('/mcp', { method: 'POST', body: '{}' })).status, 401);
  const registration = await dispatch('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Thyrqel integration test', redirect_uris: ['https://client.example.test/callback'],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
  assert.equal(registration.status, 201, await registration.clone().text());
  const client = await registration.json();
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id,
    redirect_uri: 'https://client.example.test/callback', scope: 'terminal', state: 'client-state',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    resource: `${origin}/mcp` });
  const page = await dispatch(`/authorize?${query}`);
  assert.equal(page.status, 200, await page.clone().text());
  const cookie = page.headers.get('Set-Cookie').split(';')[0];
  const state = cookie.split('=')[1];
  // Exercise the deployed browser boundary: embedded/privacy-focused clients can
  // serialize an opaque form-post origin as "null"; cookie + state still bind consent.
  const consent = await dispatch('/authorize', { method: 'POST', headers: { Cookie: cookie,
    Origin: 'null', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ state }).toString() });
  assert.equal(consent.status, 302);
  const callback = `/callback?state=${state}&code=test-github-code`;
  const approved = await dispatch(callback, { headers: { Cookie: cookie } });
  assert.equal(approved.status, 302, `${await approved.clone().text()} (upstream calls: ${githubCalls})`);
  assert.equal((await dispatch(callback, { headers: { Cookie: cookie } })).status, 403);
  assert.equal(githubCalls, 2);
  const code = new URL(approved.headers.get('Location')).searchParams.get('code');
  const tokenRequest = () => dispatch('/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id,
      redirect_uri: 'https://client.example.test/callback', code, code_verifier: verifier, resource: `${origin}/mcp` }).toString() });
  const exchanged = await tokenRequest();
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  const token = await exchanged.json();
  let rpcId = 0;
  async function rpc(method, params) {
    const response = await dispatch('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    return body.result;
  }
  const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'integration', version: '1' } });
  assert.equal(initialized.serverInfo.name, 'thyrqel-remote');
  assert.equal((await rpc('tools/list', {})).tools.length, 3);
  const tool = async (name, args = {}) => JSON.parse((await rpc('tools/call', { name, arguments: args })).content[0].text);
  assert.equal((await tool('device_status')).online, false);
  assert.equal((await dispatch('/device', { headers: { Upgrade: 'websocket' } })).status, 401);
  const upgrade = await dispatch('/device', { headers: { Upgrade: 'websocket', Authorization: `Bearer ${deviceToken}` } });
  assert.equal(upgrade.status, 101);
  const socket = upgrade.webSocket;
  socket.accept();
  const messages = [];
  const waiters = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (liveDevice && message.type === 'execute') {
      void liveDevice.execute(message).then(result => socket.send(JSON.stringify(result)))
        .catch(() => socket.close(1002, 'Live device failed'));
      return;
    }
    if (liveDevice && message.type === 'ack') return;
    const waiter = waiters.shift();
    if (waiter) waiter(message); else messages.push(message);
  });
  const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Device frame timeout')), 5000);
    waiters.push(message => { clearTimeout(timer); resolve(message); });
  });
  if (live) liveDevice = await (await import('./cloud-live-operations.mjs')).createLiveDevice();
  const epoch = liveDevice?.epoch ?? randomUUID();
  socket.send(JSON.stringify({ type: 'hello', epoch }));
  assert.deepEqual(await next(), { type: 'ready', epoch });
  assert.deepEqual(await tool('device_status'), { epoch, online: true });
  if (liveDevice) {
    await liveDevice.smoke(tool, process.argv.includes('--sudo'));
  } else {
  const operationId = randomUUID();
  const args = { epoch, operationId, call: { action: 'input', sessionId: 'test-session', text: 'hello\r' } };
  const receipt = await tool('terminal_submit', args);
  assert.equal(receipt.ok, true);
  assert.deepEqual(await next(), { type: 'execute', ...args });
  assert.equal((await tool('terminal_submit', args)).alreadyAdmitted, true);
  assert.equal((await tool('terminal_submit', { ...args, call: { ...args.call, text: 'different\r' } })).code, 'OPERATION_CONFLICT');
  assert.equal((await tool('terminal_result', { epoch, operationId })).status, 'PENDING');
  socket.send(JSON.stringify({ type: 'result', epoch, operationId, result: JSON.stringify({ ok: true, value: { accepted: true } }) }));
  assert.deepEqual(await next(), { type: 'ack', epoch, operationId });
  const completed = await tool('terminal_result', { epoch, operationId });
  assert.deepEqual(completed, { ok: true, status: 'COMPLETE', result: { ok: true, value: { accepted: true } } });
  assert.deepEqual(await tool('terminal_result', { epoch, operationId }), completed);
  await mf.unsafeEvictDurableObject('thyrqel-test', 'Broker', { name: 'operator', webSockets: 'hibernate' });
  assert.deepEqual(await tool('terminal_result', { epoch, operationId }), completed);
  assert.equal((await tool('terminal_submit', args)).alreadyAdmitted, true);
  // An admitted request with a lost result must also survive a DO restart.
  const uncertainId = randomUUID();
  const uncertain = { ...args, operationId: uncertainId };
  assert.equal((await tool('terminal_submit', uncertain)).ok, true);
  assert.deepEqual(await next(), { type: 'execute', ...uncertain });
  await mf.unsafeEvictDurableObject('thyrqel-test', 'Broker', { name: 'operator', webSockets: 'hibernate' });
  assert.equal((await tool('terminal_submit', uncertain)).alreadyAdmitted, true);
  assert.equal((await tool('terminal_result', { epoch, operationId: uncertainId })).status, 'PENDING');
  assert.equal(messages.length, 0, 'Duplicate submission must not produce another execute frame');
  }
  socket.close(1000, 'test complete');
  if (!live) {
  assert.equal((await tokenRequest()).status, 400);
  // The provider revokes the issued token when its authorization code is replayed.
  assert.equal((await dispatch('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token.access_token}` }, body: '{}' })).status, 401);
  }
  assert.ok(!JSON.stringify(token).includes('test-upstream-token'));
  console.log(live ? 'PASS local Workers/MCP/WebSocket to real PTYs (GitHub authentication mocked)' :
    'PASS Workers OAuth/DO/MCP/WebSocket: consent, PKCE, owner binding, callback/code replay rejection, device authentication, single dispatch, conflict rejection, replayable result (GitHub and terminal mocked)');
} finally {
  try { liveDevice?.shutdown(); } finally { await mf.dispose(); }
}
