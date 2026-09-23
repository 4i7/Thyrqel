import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { terminalCallSchema } from '../src/remote/protocol.js';

const offlineOperatorAction = {
  kind: 'START_WINDOWS_DEVICE',
  message: 'The paired Windows device is offline. On the paired Windows machine, open a visible PowerShell 7 window, run the GitHub-built device launcher shown in command, keep that window open, then call device_status again before submitting terminal operations.',
  command: "$launcher = Invoke-RestMethod 'https://raw.githubusercontent.com/4i7/Thyrqel/main/scripts/start-device.ps1'; & ([scriptblock]::Create($launcher))",
} as const;

export async function handleMcp(request: Request, broker: DurableObjectStub<import('./index.js').Broker>) {
  const server = new McpServer({ name: 'thyrqel-remote', version: '0.2.0' });
  const reply = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  server.registerTool('device_status', {
    description: 'Check device connectivity and its current process epoch. When the paired device is offline, the result includes an operatorAction with the GitHub-built device launch command for a visible PowerShell 7 window. An epoch change means prior outcomes cannot be recovered; never resubmit old actions automatically.',
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
