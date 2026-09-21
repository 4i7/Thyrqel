import { readFile } from 'node:fs/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ProfileRegistry } from '../profiles.js';
import { SessionManager } from '../session/manager.js';
import { createTerminalServer } from './server.js';

// stdout belongs exclusively to MCP. Configuration stays operator-owned.
const profiles: unknown = JSON.parse(await readFile(process.argv[2] ?? 'profiles.local.json', 'utf8'));
if (!Array.isArray(profiles)) throw new Error('Expected a JSON array of operator profiles');
const manager = new SessionManager(new ProfileRegistry(profiles));
const server = createTerminalServer(manager);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { manager.shutdown(); }
  catch { console.error('Thyrqel PTY shutdown failed'); process.exitCode = 1; }
  await server.close();
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
process.stdin.once('end', () => { void stop(); });
await server.connect(new StdioServerTransport());
