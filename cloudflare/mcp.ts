import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { terminalCallSchema } from '../src/remote/protocol.js';

const offlineOperatorAction = {
  kind: 'START_WINDOWS_DEVICE',
  message: 'The paired Windows device is offline. On the paired Windows machine, open a visible PowerShell 7 window in the Thyrqel checkout, run `npm.cmd run device`, keep that window open, then call device_status again before submitting terminal operations.',
  command: 'npm.cmd run device',
} as const;

export async function handleMcp(request: Request, broker: DurableObjectStub<import('./index.js').Broker>) {
  const server = new McpServer({ name: 'thyrqel-remote', version: '0.2.0' });
  const reply = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  server.registerTool('device_status', {
    description: 'Check device connectivity and its current process epoch. When the paired device is offline, the result includes an operatorAction telling the user to open a visible PowerShell 7 window on Windows, run `npm.cmd run device`, keep it open, and call device_status again. An epoch change means prior outcomes cannot be recovered; never resubmit old actions automatically.',
    inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const status = await broker.deviceStatus();
    return reply(status.online ? status : { ...status, operatorAction: offlineOperatorAction });
  });
  server.registerTool('terminal_submit', {
    description: 'Submit one terminal operation. First obtain device_status and do not submit while it reports offline. Supply a fresh UUID operationId and its epoch; retain both. Submission does not mean execution or command completion. Retrieve terminal_result for the same ID. Do not repeat uncertain actions with a new ID. Input is exact PTY text; append carriage return to submit a line, U+0003 for Ctrl+C. No command-name filter. Do not put passwords into tool arguments.',
    inputSchema: { epoch: z.string().uuid(), operationId: z.string().uuid(), call: terminalCallSchema },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async args => reply(await broker.submit({ type: 'execute', ...args })));
  server.registerTool('terminal_result', {
    description: 'Retrieve the receipt for a submitted terminal operation without rerunning it. PENDING means wait and poll. UNKNOWN_OUTCOME means do not resend; a late receipt may still arrive. COMPLETE confirms the operation result, not shell-command completion. Read-operation output is retained for replay while the receipt remains available.',
    inputSchema: { epoch: z.string().uuid(), operationId: z.string().uuid() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ epoch, operationId }) => reply(await broker.operationResult(epoch, operationId)));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try { return await transport.handleRequest(request); }
  finally { await server.close(); }
}
