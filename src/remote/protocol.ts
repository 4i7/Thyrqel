import { z } from 'zod';

const sessionId = z.string().min(1).max(200);
export const terminalCallSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('open'), profile: z.enum(['windows-pwsh', 'wsl-kali']) }).strict(),
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('input'), sessionId, text: z.string().min(1).max(4096) }).strict(),
  z.object({ action: z.literal('read'), sessionId }).strict(),
  z.object({ action: z.literal('close'), sessionId }).strict(),
  z.object({ action: z.literal('forget'), sessionId }).strict(),
]);
export const executeSchema = z.object({
  type: z.literal('execute'), epoch: z.string().uuid(), operationId: z.string().uuid(), call: terminalCallSchema,
}).strict();
export type TerminalCall = z.infer<typeof terminalCallSchema>;
export type ExecuteRequest = z.infer<typeof executeSchema>;
export const MAX_WIRE_BYTES = 96 * 1024;
export const REMOTE_READ_BYTES = 8192;

export interface DeviceResult {
  type: 'result'; epoch: string; operationId: string; result: string;
}
