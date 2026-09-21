import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SessionManager } from '../session/manager.js';
import { TerminalError } from '../types.js';

export function createTerminalServer(manager: SessionManager) {
  const server = new McpServer({ name: 'thyrqel', version: '0.2.0' });
  const sessionId = z.string().min(1).max(200);
  const result = async (action: () => unknown | Promise<unknown>) => {
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(await action()) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({
        code: error instanceof TerminalError ? error.code : 'INTERNAL_ERROR',
        message: error instanceof TerminalError ? error.message : 'Terminal operation failed',
      }) }] };
    }
  };
  server.registerTool('terminal_open', {
    description: 'Open a persistent local PowerShell or WSL Bash terminal using an operator-configured profile. A lost reply has unknown outcome: do not automatically repeat open.',
    inputSchema: { profile: z.enum(['windows-pwsh', 'wsl-kali']) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, ({ profile }) => result(() => manager.open(profile)));
  server.registerTool('terminal_list', {
    description: 'List terminal identities and lifecycle states without consuming output. READY means input can be sent, not that a command has completed.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => result(() => manager.list()));
  server.registerTool('terminal_input', {
    description: 'Send exact text to an existing PTY. Append carriage return to submit a line; use U+0003 for Ctrl+C. Supports interactive prompts. No command-name blocklist. Input is not logged by this server, but client tool history can retain it: do not send passwords through the model. Accepted input is not command completion; after a lost response inspect output instead of automatically repeating input.',
    inputSchema: { sessionId, text: z.string().min(1).max(4096) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, ({ sessionId, text }) => result(() => {
    manager.write(sessionId, text);
    return { sessionId, accepted: true, completion: 'UNDETERMINED' };
  }));
  server.registerTool('terminal_read', {
    description: 'Drain currently available raw terminal output. Poll again if empty. Output includes ANSI escapes and explicit loss accounting. This does not detect command completion and does not interrupt long-running commands. Reading consumes output; a lost response cannot be recovered through this local interface.',
    inputSchema: { sessionId },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, ({ sessionId }) => result(() => manager.read(sessionId)));
  server.registerTool('terminal_close', {
    description: 'Close a terminal. This can terminate its running work. Retains the terminal record until terminal_forget.',
    inputSchema: { sessionId },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, ({ sessionId }) => result(() => manager.close(sessionId)));
  server.registerTool('terminal_forget', {
    description: 'Remove an already closed, exited or failed terminal record to release a session slot.',
    inputSchema: { sessionId },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, ({ sessionId }) => result(() => {
    manager.forget(sessionId);
    return { forgotten: true };
  }));
  return server;
}
