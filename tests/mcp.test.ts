import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IPty } from 'node-pty';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTerminalServer } from '../src/mcp/server.js';
import { SessionManager } from '../src/session/manager.js';
import { ProfileRegistry } from '../src/profiles.js';

test('MCP preserves interactive terminal input and exposes actual lifecycle without guessing completion', async () => {
  let emit = (_: string) => {};
  const writes: string[] = [];
  const pty = {
    onData(fn: typeof emit) { emit = fn; return { dispose() {} }; },
    onExit() { return { dispose() {} }; },
    write(text: string) {
      const halves = [...text.matchAll(/'([a-f0-9]{24})'/g)].map(match => match[1]);
      if (halves.length === 2) {
        const payload = Buffer.from(JSON.stringify({ shell: 'powershell', edition: 'Core', version: '7.6.5', cwd: 'C:\\' })).toString('base64');
        queueMicrotask(() => emit(`TBREADY:${halves.join('')}:${payload}:END`));
      } else writes.push(text);
    },
    kill() {},
  } as unknown as IPty;
  const manager = new SessionManager(new ProfileRegistry([
    { id: 'windows-pwsh', platform: 'windows', shellDialect: 'powershell', command: 'pwsh.exe' },
  ]), { spawn: () => pty, checkHost() {} });
  const server = createTerminalServer(manager);
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  async function call(name: string, args: Record<string, unknown> = {}) {
    const response = await client.callTool({ name, arguments: args });
    const content = response.content as { type: string; text: string }[];
    return { error: response.isError, value: JSON.parse(content[0]!.text) };
  }
  try {
    assert.equal((await client.listTools()).tools.length, 6);
    const opened = await call('terminal_open', { profile: 'windows-pwsh' });
    const sessionId: string = opened.value.sessionId;
    await call('terminal_read', { sessionId });
    const input = await call('terminal_input', { sessionId, text: 'Read-Host\r' });
    assert.equal(input.value.completion, 'UNDETERMINED');
    emit('Enter value: ');
    assert.equal((await call('terminal_read', { sessionId })).value.output, 'Enter value: ');
    assert.equal((await call('terminal_list')).value[0].state, 'READY');
    await call('terminal_input', { sessionId, text: 'answer\r' });
    await call('terminal_input', { sessionId, text: '\u0003' });
    assert.deepEqual(writes, ['Read-Host\r', 'answer\r', '\u0003']);
    assert.equal((await call('terminal_read', { sessionId })).value.output, '');
    assert.equal((await call('terminal_forget', { sessionId })).error, true);
    await call('terminal_close', { sessionId });
    assert.equal((await call('terminal_input', { sessionId, text: 'x' })).value.code, 'SESSION_NOT_READY');
    await call('terminal_forget', { sessionId });
    assert.deepEqual((await call('terminal_list')).value, []);
    assert.equal((await call('terminal_read', { sessionId })).value.code, 'INVALID_SESSION');
  } finally {
    manager.shutdown();
    await client.close();
    await server.close();
  }
});
