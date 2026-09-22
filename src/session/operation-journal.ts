import { createHash, randomUUID } from 'node:crypto';

export class OperationError extends Error {
  constructor(readonly code: 'STALE_EPOCH' | 'INVALID_OPERATION' | 'OPERATION_CONFLICT' |
    'JOURNAL_FULL' | 'RESULT_EXPIRED', message: string) {
    super(message);
    this.name = 'OperationError';
  }
}

interface Entry {
  digest: string;
  promise?: Promise<string>;
  result?: string;
  bytes: number;
}

/**
 * Device-local no-resend boundary. Caller must authenticate and validate input
 * before admission. A restarted device gets a different epoch, never replays
 * requests from the old process, and cannot recover an old unknown outcome.
 */
export class OperationJournal {
  readonly epoch = randomUUID();
  private readonly entries = new Map<string, Entry>();
  private readonly completed = new Set<string>();
  private bytes = 0;
  constructor(private readonly maxOperations = 4096, private readonly maxResultBytes = 16 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxOperations) || maxOperations < 1 ||
        !Number.isSafeInteger(maxResultBytes) || maxResultBytes < 1) throw new RangeError('Invalid journal bounds');
  }

  execute(epoch: string, operationId: string, canonicalRequest: string,
    action: () => Promise<string>): Promise<string> {
    if (epoch !== this.epoch) return Promise.reject(new OperationError('STALE_EPOCH', 'Device restarted; inspect current state, do not resend old input'));
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(operationId)) return Promise.reject(new OperationError('INVALID_OPERATION', 'Expected a unique operation ID'));
    const digest = createHash('sha256').update(canonicalRequest).digest('hex');
    const previous = this.entries.get(operationId);
    if (previous) {
      if (previous.digest !== digest) return Promise.reject(new OperationError('OPERATION_CONFLICT', 'Operation ID reused with different input'));
      if (previous.promise) return previous.promise;
      if (previous.result !== undefined) return Promise.resolve(previous.result);
      return Promise.reject(new OperationError('RESULT_EXPIRED', 'Operation was already admitted; its result is unavailable. Do not repeat its effects'));
    }
    if (this.entries.size >= this.maxOperations) return Promise.reject(new OperationError('JOURNAL_FULL', 'Operation journal full; no action admitted'));
    const entry: Entry = { digest, bytes: 0 };
    // Record admission before any asynchronous execution. Never erase a record,
    // including when action throws after it may already have affected the PTY.
    this.entries.set(operationId, entry);
    entry.promise = Promise.resolve().then(action).then(result => {
      entry.result = result;
      entry.bytes = Buffer.byteLength(result);
      this.bytes += entry.bytes;
      this.completed.add(operationId);
      while (this.bytes > this.maxResultBytes) {
        const oldest = this.completed.values().next().value!;
        this.completed.delete(oldest);
        const oldEntry = this.entries.get(oldest)!;
        this.bytes -= oldEntry.bytes;
        oldEntry.bytes = 0;
        oldEntry.result = undefined;
      }
      return result;
    }).finally(() => { entry.promise = undefined; });
    return entry.promise;
  }
}
