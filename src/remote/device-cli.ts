import { readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { ProfileRegistry } from '../profiles.js';
import { SessionManager } from '../session/manager.js';
import { DeviceExecutor } from './device-executor.js';
import { runDeviceConnection } from './device-connection.js';
import { shellEnvironment } from './environment.js';
import { runOperatorConsole } from './operator-console.js';

const configPath = resolve(process.argv[2] ?? join(process.env.LOCALAPPDATA ?? homedir(), 'Thyrqel', 'device.json'));
const config = await (async () => {
  try {
    const contents = await readFile(configPath, 'utf8');
    if (Buffer.byteLength(contents) > 16384) throw new Error('Configuration size limit');
    return z.object({ endpoint: z.string().url(), token: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/), profilesFile: z.string().min(1) }).strict().parse(JSON.parse(contents));
  } catch { throw new Error('Device configuration could not be read or validated; values withheld'); }
})();
const profiles = JSON.parse(await readFile(resolve(dirname(configPath), config.profilesFile), 'utf8'));
if (!Array.isArray(profiles)) throw new Error('Expected an operator profile array');
const manager = new SessionManager(new ProfileRegistry(profiles), { environment: shellEnvironment(process.env) });
const executor = new DeviceExecutor(manager);
const abort = new AbortController();
process.once('SIGINT', () => abort.abort('process SIGINT'));
process.once('SIGTERM', () => abort.abort('process SIGTERM'));
console.error(`Thyrqel device epoch: ${executor.epoch}`);
const operator = runOperatorConsole(manager, abort).catch(() => {
  console.error('Local operator console failed; stopping device');
  abort.abort('local operator console failed');
});
try {
  await runDeviceConnection(executor, config.endpoint, config.token, abort.signal,
    state => console.error(`Thyrqel device ${state}`));
} finally {
  if (!abort.signal.aborted) abort.abort('device connection ended');
  const reason = abort.signal.reason;
  console.error(Thyrqel device stopping: );
  await operator;
  manager.shutdown();
}
