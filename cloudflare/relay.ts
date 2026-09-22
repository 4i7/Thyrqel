import { z } from 'zod';
import { executeSchema, MAX_WIRE_BYTES, type ExecuteRequest } from '../src/remote/protocol.js';

export interface Attachment { epoch?: string; connectionId: string; seen: number }
export interface OperationRecord {
  digest: string; createdAt: number; result?: string; resultDigest?: string;
}
const inbound = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), epoch: z.string().uuid() }).strict(),
  z.object({ type: z.literal('heartbeat'), epoch: z.string().uuid() }).strict(),
  z.object({ type: z.literal('result'), epoch: z.string().uuid(), operationId: z.string().uuid(), result: z.string() }).strict(),
]);
export async function digest(value: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
const failure = (code: string) => ({ ok: false as const, code });

/** Durable admission is recorded before send. No dispatch retry exists. */
export class Relay {
  constructor(private readonly ctx: DurableObjectState) {}
  private currentSocket() {
    return this.ctx.getWebSockets('device').find(socket => {
      const attachment: Attachment = socket.deserializeAttachment();
      return socket.readyState === WebSocket.OPEN && attachment.epoch && attachment.seen + 45000 > Date.now();
    });
  }
  connect() {
    if (this.ctx.getWebSockets('device').filter(socket => socket.readyState === WebSocket.OPEN).length >= 2) {
      return new Response('Device connection limit', { status: 409 });
    }
    const pair = new WebSocketPair();
    const socket = pair[1];
    this.ctx.acceptWebSocket(socket, ['device']);
    socket.serializeAttachment({ connectionId: crypto.randomUUID(), seen: Date.now() } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async status() {
    const epoch = await this.ctx.storage.get<string>('device:epoch');
    const socket = this.currentSocket();
    return { epoch: epoch ?? null, online: !!socket && socket.deserializeAttachment().epoch === epoch };
  }
  submit(raw: ExecuteRequest) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const request = executeSchema.parse(raw);
      const epoch = await this.ctx.storage.get<string>('device:epoch');
      if (request.epoch !== epoch) return failure('STALE_EPOCH');
      const key = `op:${request.operationId}`;
      const requestDigest = await digest(JSON.stringify(request.call));
      const previous = await this.ctx.storage.get<OperationRecord>(key);
      if (previous) return previous.digest === requestDigest
        ? { ok: true as const, epoch, operationId: request.operationId, alreadyAdmitted: true }
        : failure('OPERATION_CONFLICT');
      const socket = this.currentSocket();
      if (!socket || socket.deserializeAttachment().epoch !== epoch) return failure('DEVICE_OFFLINE');
      const count = await this.ctx.storage.get<number>('device:count') ?? 0;
      const outstanding = await this.ctx.storage.get<number>('device:outstanding') ?? 0;
      if (count >= 4096) return failure('JOURNAL_FULL');
      if (outstanding >= 16) return failure('DEVICE_BUSY');
      await this.ctx.storage.put({ [key]: { digest: requestDigest, createdAt: Date.now() } satisfies OperationRecord,
        'device:count': count + 1, 'device:outstanding': outstanding + 1 });
      try { socket.send(JSON.stringify(request)); }
      catch { return failure('UNKNOWN_OUTCOME'); }
      return { ok: true as const, epoch, operationId: request.operationId, alreadyAdmitted: false };
    });
  }
  async result(epoch: string, operationId: string) {
    if (epoch !== await this.ctx.storage.get('device:epoch')) return failure('STALE_EPOCH');
    const record = await this.ctx.storage.get<OperationRecord>(`op:${operationId}`);
    if (!record) return failure('NOT_ADMITTED');
    if (record.result !== undefined) return { ok: true as const, status: 'COMPLETE', result: JSON.parse(record.result) };
    if (record.resultDigest) return failure('RESULT_EXPIRED');
    return { ok: true as const, status: record.createdAt + 30000 < Date.now() || !this.currentSocket() ? 'UNKNOWN_OUTCOME' : 'PENDING' };
  }
  message(socket: WebSocket, frame: string | ArrayBuffer) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (typeof frame !== 'string' || new TextEncoder().encode(frame).length > MAX_WIRE_BYTES) throw new Error('Invalid frame');
      const message = inbound.parse(JSON.parse(frame));
      const attachment: Attachment = socket.deserializeAttachment();
      if (message.type === 'hello') {
        if (attachment.epoch) throw new Error('Repeated hello');
        const old = this.currentSocket();
        if (old && old !== socket && old.deserializeAttachment().epoch !== message.epoch) {
          socket.close(1013, 'Another device process is active'); return;
        }
        const priorEpoch = await this.ctx.storage.get<string>('device:epoch');
        await this.ctx.storage.transaction(async tx => {
          if (priorEpoch !== message.epoch) {
            const records = await tx.list({ prefix: 'op:' });
            await tx.delete([...records.keys()]);
            await tx.put({ 'device:count': 0, 'device:outstanding': 0, 'device:completed': [] });
          }
          await tx.put({ 'device:epoch': message.epoch, 'device:connection': attachment.connectionId });
        });
        for (const other of this.ctx.getWebSockets('device')) if (other !== socket) other.close(1000, 'Connection replaced');
        socket.serializeAttachment({ ...attachment, epoch: message.epoch, seen: Date.now() });
        socket.send(JSON.stringify({ type: 'ready', epoch: message.epoch }));
        return;
      }
      if (attachment.epoch !== message.epoch ||
          attachment.connectionId !== await this.ctx.storage.get('device:connection')) throw new Error('Stale device connection');
      socket.serializeAttachment({ ...attachment, seen: Date.now() });
      if (message.type === 'heartbeat') { socket.send(JSON.stringify(message)); return; }
      const key = `op:${message.operationId}`;
      const record = await this.ctx.storage.get<OperationRecord>(key);
      if (!record) throw new Error('Result without admission');
      const resultDigest = await digest(message.result);
      if (record.resultDigest && record.resultDigest !== resultDigest) throw new Error('Conflicting result');
      JSON.parse(message.result);
      if (!record.resultDigest) {
        const completed = await this.ctx.storage.get<string[]>('device:completed') ?? [];
        completed.push(key);
        const outstanding = await this.ctx.storage.get<number>('device:outstanding') ?? 1;
        await this.ctx.storage.transaction(async tx => {
          await tx.put(key, { ...record, result: message.result, resultDigest });
          while (completed.length > 32) {
            const expiredKey = completed.shift()!;
            const expired = await tx.get<OperationRecord>(expiredKey);
            if (expired) { delete expired.result; await tx.put(expiredKey, expired); }
          }
          await tx.put({ 'device:completed': completed, 'device:outstanding': Math.max(0, outstanding - 1) });
        });
      }
      socket.send(JSON.stringify({ type: 'ack', epoch: message.epoch, operationId: message.operationId }));
    });
  }
}
