import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { DeviceExecutor } from '../src/remote/device-executor.js';
import { runDeviceConnection, deviceUrl } from '../src/remote/device-connection.js';
import { OutputRing } from '../src/session/output-ring.js';
import { shellEnvironment } from '../src/remote/environment.js';

function device(openGate: Promise<void> = Promise.resolve()) {
  const input: string[] = [];
  const ring = new OutputRing();
  const snapshot = { sessionId: 'session-test', profile: 'windows-pwsh' as const, state: 'READY' as const,
    identity: undefined, createdAt: '', lastActivityAt: '', exitCode: undefined, error: undefined };
  const executor = new DeviceExecutor({
    open: async () => { await openGate; return { ...snapshot, state: 'ready' as const }; },
    list: () => [snapshot], write: (_id, text) => { input.push(text); },
    read: (_id, max) => ({ ...snapshot, ...ring.read(max) }),
    close: () => ({ ...snapshot, state: 'CLOSED' as const }), forget() {},
  });
  return { executor, input, ring };
}

test('remote shell environment retains runtime paths but excludes agent and provider credentials', () => {
  const env = shellEnvironment({ Path: 'C:\\tools', SystemRoot: 'C:\\Windows', TEMP: 'C:\\temp',
    GITHUB_CLIENT_SECRET: 'secret', DEVICE_TOKEN: 'device-secret', CLOUDFLARE_API_TOKEN: 'cloud-secret',
    NODE_OPTIONS: '--require attacker.js', WSLENV: 'DEVICE_TOKEN/u' });
  assert.deepEqual(env, { Path: 'C:\\tools', SystemRoot: 'C:\\Windows', TEMP: 'C:\\temp' });
});

test('device repeats stored read receipts without draining later output and rejects changed input', async () => {
  const { executor, input, ring } = device();
  ring.append('first');
  const request = { type: 'execute', epoch: executor.epoch, operationId: randomUUID(), call: { action: 'read', sessionId: 'session-test' } };
  const first = await executor.execute(request);
  ring.append('second');
  assert.deepEqual(await executor.execute(request), first);
  assert.equal(ring.read().output, 'second');
  const conflict = await executor.execute({ ...request, call: { action: 'input', sessionId: 'session-test', text: 'changed\r' } });
  assert.equal(JSON.parse(conflict.result).error.code, 'OPERATION_CONFLICT');
  assert.deepEqual(input, []);
  assert.throws(() => deviceUrl('http://untrusted.example'), /HTTPS/);
  assert.throws(() => deviceUrl('https://example.test/?token=x'), /bare/);
});

test('an operation finishing after reconnect publishes its result on the new connection', { timeout: 15000 }, async () => {
  let finishOpen!: () => void;
  const gate = new Promise<void>(resolve => { finishOpen = resolve; });
  const { executor } = device(gate);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const abort = new AbortController();
  let connections = 0;
  const operationId = randomUUID();
  let finish!: (result: unknown) => void;
  const delivered = new Promise(resolve => { finish = resolve; });
  server.on('connection', socket => {
    const connection = ++connections;
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'hello') {
        socket.send(JSON.stringify({ type: 'ready', epoch: executor.epoch }));
        if (connection === 1) {
          socket.send(JSON.stringify({ type: 'execute', epoch: executor.epoch, operationId,
            call: { action: 'open', profile: 'windows-pwsh' } }));
          socket.close(1000, 'Reconnect while open is pending');
        }
      } else if (message.type === 'result') finish(message);
    });
  });
  const running = runDeviceConnection(executor, `http://127.0.0.1:${address.port}`, randomBytes(32).toString('base64url'), abort.signal,
    state => { if (state === 'connected' && connections === 2) finishOpen(); });
  try {
    const result = await Promise.race([delivered, running.then(() => { throw new Error('Device stopped early'); })]);
    assert.equal((result as { operationId: string }).operationId, operationId);
    assert.equal(connections, 2);
  } finally {
    finishOpen(); abort.abort(); await running;
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('device reconnect resends unacknowledged results, never executes input again', { timeout: 15000 }, async () => {
  const { executor, input } = device();
  const token = randomBytes(32).toString('base64url');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const abort = new AbortController();
  let connections = 0;
  const operationId = randomUUID();
  const message = { type: 'execute', epoch: executor.epoch, operationId,
    call: { action: 'input', sessionId: 'session-test', text: 'interactive response\r' } };
  let finish!: () => void;
  let fail!: (error: unknown) => void;
  const delivered = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  server.on('connection', (socket, request) => {
    const connection = ++connections;
    try { assert.equal(request.headers.authorization, `Bearer ${token}`); assert.equal(request.url, '/device'); }
    catch (error) { fail(error); }
    socket.on('message', raw => {
      try {
        const response = JSON.parse(raw.toString());
        if (response.type === 'hello') {
          socket.send(JSON.stringify({ type: 'ready', epoch: executor.epoch }));
          if (connection === 1) socket.send(JSON.stringify(message));
          return;
        }
        assert.equal(response.type, 'result');
        assert.equal(response.operationId, operationId);
        assert.equal(JSON.parse(response.result).value.accepted, true);
        if (connection === 1) socket.terminate(); // Result acknowledgement lost.
        else {
          socket.send(JSON.stringify({ type: 'ack', epoch: executor.epoch, operationId }));
          finish();
        }
      } catch (error) { fail(error); }
    });
  });
  const running = runDeviceConnection(executor, `http://127.0.0.1:${address.port}`, token, abort.signal);
  try {
    await Promise.race([delivered, running.then(() => { throw new Error('Device stopped early'); })]);
    assert.deepEqual(input, ['interactive response\r']);
    assert.equal(connections, 2);
  } finally {
    abort.abort();
    await running;
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
