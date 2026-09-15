import type { IPty, IDisposable } from 'node-pty';
import { randomUUID } from 'node:crypto';
import { TerminalError, type CompletionResult, type Identity, type Profile, type SessionState,
  type StepResult, type TerminalWriteInput } from '../types.js';
import { ActiveStep } from './active-step.js';
import { framerFor } from './command-framer.js';
import { CompletionDetector } from './completion-detector.js';
import { KeyCodec } from './key-codec.js';
import { OutputRing } from './output-ring.js';
import { Readiness } from './readiness.js';

interface Waiter {
  resolve(value: StepResult): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

export class PtySession {
  state: SessionState = 'CREATING';
  readonly createdAt = new Date().toISOString();
  lastActivityAt = this.createdAt;
  identity?: Identity;
  exitCode?: number;
  private failure?: { code: string; message: string };
  readonly ready: Promise<void>;
  private readonly output: OutputRing;
  private readonly subscriptions: IDisposable[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private rejectReady!: (error: Error) => void;
  private readonly detector = new CompletionDetector();
  private readonly framer;
  private readonly keys = new KeyCodec();
  private activeStep?: ActiveStep;
  private waiter?: Waiter;
  private pendingCompletions: CompletionResult[] = [];

  constructor(readonly sessionId: string, readonly profile: Profile, private readonly pty: IPty,
    capacity: number, timeout: number) {
    this.output = new OutputRing(capacity);
    this.framer = framerFor(profile.shellDialect);
    const readiness = new Readiness(profile);
    this.ready = new Promise<void>((resolve, reject) => {
      this.rejectReady = reject;
      this.timer = setTimeout(() => this.fail(new TerminalError('PROFILE_START_FAILED', 'Readiness timed out')), timeout);
      this.subscriptions.push(pty.onData(raw => {
        if (this.state === 'CLOSED' || this.state === 'FAILED') return;
        this.touch();
        try {
          if (this.state === 'CREATING') {
            const identity = readiness.accept(raw);
            if (identity) {
              this.identity = identity;
              this.state = 'READY';
              clearTimeout(this.timer);
              resolve();
            }
            this.output.append(raw);
            return;
          }
          const parsed = this.activeStep ? this.detector.accept(raw) : { output: raw };
          if (parsed.output) this.output.append(parsed.output);
          if (parsed.completion) this.onCompletion(parsed.completion);
        } catch (error) {
          const wrapped = error instanceof TerminalError ? error : new TerminalError('SESSION_PROTOCOL_ERROR', String(error));
          this.fail(wrapped);
          this.rejectWaiter(wrapped);
        }
      }));
      this.subscriptions.push(pty.onExit(event => {
        this.exitCode = event.exitCode;
        const pending = this.detector.flush();
        if (pending) this.output.append(pending);
        this.output.finish();
        this.touch();
        if (this.state === 'CLOSED' || this.state === 'FAILED') return;
        if (this.state === 'CREATING') {
          this.fail(new TerminalError('PROFILE_START_FAILED', 'Shell exited before readiness'));
        } else {
          this.state = 'EXITED';
          if (this.activeStep) this.activeStep.state = 'EXITED';
          this.resolveTerminalWaiter('exited');
          this.activeStep = undefined;
          this.detector.reset();
          this.dispose();
          // Keep the CP-1 cleanup behavior visible; this remains the known qualification blocker.
          try { this.pty.kill(); }
          catch (cause) { this.fail(new TerminalError('SESSION_IO_FAILED', 'Exited PTY cleanup failed', { cause })); }
        }
      }));
    });
    try { pty.write(readiness.command); }
    catch (cause) { this.fail(new TerminalError('PROFILE_START_FAILED', 'Readiness write failed', { cause })); }
  }

  private touch() { this.lastActivityAt = new Date().toISOString(); }
  private dispose() {
    clearTimeout(this.timer);
    for (const s of this.subscriptions.splice(0)) s.dispose();
  }
  private rejectWaiter(error: unknown) {
    if (!this.waiter) return;
    clearTimeout(this.waiter.timer);
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter.reject(error);
  }
  private fail(error: Error) {
    if (this.state === 'CLOSED' || this.state === 'FAILED') return;
    this.state = 'FAILED';
    if (this.activeStep) this.activeStep.state = 'FAILED';
    this.failure = { code: error instanceof TerminalError ? error.code : 'SESSION_IO_FAILED', message: error.message };
    this.rejectReady(error);
    this.dispose();
    try { this.pty.kill(); } catch (cause) {
      error.cause = new AggregateError([error.cause, cause], 'PTY cleanup failed');
    }
  }
  private snapshotOutput() {
    const slice = this.output.read();
    return { output: slice.output, truncated: slice.truncated, droppedBytes: slice.dropped_bytes };
  }
  private onCompletion(result: CompletionResult) {
    const active = this.activeStep;
    if (!active || active.completionToken.length === 0) return;
    if (result.operationId !== active.operationId) throw new TerminalError('SESSION_PROTOCOL_ERROR', 'Completion operation mismatch');
    active.complete(result);
    if (this.identity) this.identity = { ...this.identity, cwd: result.cwd };
    this.activeStep = undefined;
    this.detector.reset();
    if (this.waiter && !active.timedOut) {
      clearTimeout(this.waiter.timer);
      const waiter = this.waiter;
      this.waiter = undefined;
      const out = this.snapshotOutput();
      waiter.resolve({ state: 'ready', success: result.success, exitCode: result.exitCode,
        operationId: result.operationId, ...out });
    } else {
      this.pendingCompletions.push(result);
    }
  }
  private resolveTerminalWaiter(state: 'exited' | 'closed') {
    if (!this.waiter) return;
    clearTimeout(this.waiter.timer);
    const waiter = this.waiter;
    this.waiter = undefined;
    const operationId = this.activeStep?.operationId ?? '';
    const out = this.snapshotOutput();
    waiter.resolve({ state, success: null, exitCode: null, operationId, ...out });
  }

  snapshot() {
    return { sessionId: this.sessionId, profile: this.profile.id, state: this.state,
      identity: this.identity ? { ...this.identity } : undefined, createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt, exitCode: this.exitCode, error: this.failure ? { ...this.failure } : undefined,
      activeStep: this.activeStep ? { operationId: this.activeStep.operationId,
        startedAt: this.activeStep.startedAt, state: this.activeStep.state,
        completionResult: this.activeStep.completionResult ? { ...this.activeStep.completionResult } : undefined } : undefined };
  }

  write(input: string | TerminalWriteInput) {
    if (this.state !== 'READY') throw new TerminalError('SESSION_NOT_READY', `Session is ${this.state}`);
    const text = typeof input === 'string' ? input : input.mode === 'raw' ? input.data :
      input.mode === 'line' ? input.data + '\r' : this.keys.encode(input.key);
    try { this.pty.write(text); this.touch(); return { accepted: true as const }; }
    catch (cause) {
      const error = new TerminalError('SESSION_IO_FAILED', 'PTY write failed', { cause });
      this.fail(error);
      this.rejectWaiter(error);
      throw error;
    }
  }

  step(command: string, timeoutMs: number): Promise<StepResult> {
    if (this.state !== 'READY') throw new TerminalError('SESSION_NOT_READY', `Session is ${this.state}`);
    if (this.activeStep) throw new TerminalError('SESSION_BUSY', 'A tracked command transaction is already active');
    if (typeof command !== 'string' || command.includes('\0')) throw new TypeError('command must be a string without NUL');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new RangeError('timeoutMs must be a non-negative safe integer');
    const operationId = `op_${randomUUID()}`;
    const framed = this.framer.frame(command, operationId);
    const active = new ActiveStep(operationId, framed.completionToken);
    active.state = 'DISPATCHED';
    this.activeStep = active;
    this.detector.arm(framed.completionToken);

    return new Promise<StepResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.activeStep || this.activeStep.operationId !== operationId) return;
        active.timedOut = true;
        active.state = 'RUNNING';
        this.waiter = undefined;
        const out = this.snapshotOutput();
        resolve({ state: 'running', success: null, exitCode: null, operationId, ...out });
      }, timeoutMs);
      this.waiter = { resolve, reject, timer };
      try {
        active.state = 'RUNNING';
        this.pty.write(framed.wire);
        this.touch();
      } catch (cause) {
        clearTimeout(timer);
        this.waiter = undefined;
        active.state = 'FAILED';
        this.activeStep = undefined;
        this.detector.reset();
        const error = new TerminalError('SESSION_IO_FAILED', 'PTY step write failed', { cause });
        this.fail(error);
        reject(error);
      }
    });
  }

  read() {
    this.touch();
    const slice = this.snapshotOutput();
    const completion = this.pendingCompletions.shift();
    return { ...this.snapshot(), output: slice.output, truncated: slice.truncated,
      dropped_bytes: slice.droppedBytes, droppedBytes: slice.droppedBytes,
      stepState: this.activeStep ? 'running' as const : 'ready' as const,
      completion: completion ? { operationId: completion.operationId, success: completion.success,
        exitCode: completion.exitCode, cwd: completion.cwd } : null };
  }

  close() {
    if (this.state === 'CLOSED') return this.snapshot();
    const wasCreating = this.state === 'CREATING';
    const wasExited = this.state === 'EXITED';
    this.state = 'CLOSED';
    if (this.activeStep) this.activeStep.state = 'CANCELLED';
    this.resolveTerminalWaiter('closed');
    this.activeStep = undefined;
    this.pendingCompletions = [];
    this.detector.reset();
    if (wasCreating) this.rejectReady(new TerminalError('PROFILE_START_FAILED', 'Closed before readiness'));
    this.dispose();
    if (!wasExited) {
      try { this.pty.kill(); }
      catch (cause) {
        this.state = 'FAILED';
        this.failure = { code: 'SESSION_IO_FAILED', message: 'PTY close failed' };
        throw new TerminalError('SESSION_IO_FAILED', 'PTY close failed', { cause });
      }
    }
    this.touch();
    this.output.read();
    return this.snapshot();
  }
}
