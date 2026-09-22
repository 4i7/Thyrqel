import type { SessionManager } from '../session/manager.js';
import { OperationJournal, OperationError } from '../session/operation-journal.js';
import { TerminalError } from '../types.js';
import { executeSchema, MAX_WIRE_BYTES, REMOTE_READ_BYTES, type DeviceResult, type TerminalCall } from './protocol.js';

/** Local credential-free execution boundary, shared by all device connections. */
export class DeviceExecutor {
  constructor(private readonly manager: Pick<SessionManager, 'open' | 'list' | 'write' | 'read' | 'close' | 'forget'>,
    readonly journal = new OperationJournal()) {}
  get epoch() { return this.journal.epoch; }
  async execute(raw: unknown): Promise<DeviceResult> {
    const request = executeSchema.parse(raw);
    let result: string;
    try {
      result = await this.journal.execute(request.epoch, request.operationId, JSON.stringify(request.call), async () => {
        try {
          const serialized = JSON.stringify({ ok: true, value: await this.perform(request.call) });
          if (Buffer.byteLength(JSON.stringify({ type: 'result', epoch: request.epoch, operationId: request.operationId, result: serialized })) > MAX_WIRE_BYTES) {
            return JSON.stringify({ ok: false, error: { code: 'RESULT_TOO_LARGE', message: 'Operation executed but its result exceeded the wire limit; do not repeat effects' } });
          }
          return serialized;
        } catch (error) {
          return JSON.stringify({ ok: false, error: { code: error instanceof TerminalError ? error.code : 'UNKNOWN_OUTCOME',
            message: error instanceof TerminalError ? error.message : 'Operation failed; inspect state before further action' } });
        }
      });
    } catch (error) {
      result = JSON.stringify({ ok: false, error: { code: error instanceof OperationError ? error.code : 'UNKNOWN_OUTCOME',
        message: error instanceof OperationError ? error.message : 'Execution outcome is unknown; do not resend input' } });
    }
    return { type: 'result', epoch: request.epoch, operationId: request.operationId, result };
  }
  private async perform(call: TerminalCall): Promise<unknown> {
    switch (call.action) {
      case 'open': return this.manager.open(call.profile);
      case 'list': return this.manager.list();
      case 'input':
        this.manager.write(call.sessionId, call.text);
        return { accepted: true, completion: 'UNDETERMINED' };
      case 'read': return this.manager.read(call.sessionId, REMOTE_READ_BYTES);
      case 'close': return this.manager.close(call.sessionId);
      case 'forget': this.manager.forget(call.sessionId); return { forgotten: true };
    }
  }
}
