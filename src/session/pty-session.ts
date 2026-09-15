import type { IPty, IDisposable } from 'node-pty';
import { TerminalError, type Identity, type Profile, type SessionState, type CompletionDetector } from '../types.js';
import { OutputRing } from './output-ring.js';
import { Readiness } from './readiness.js';

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
  constructor(readonly sessionId: string, readonly profile: Profile, private readonly pty: IPty,
    capacity: number, timeout: number, detector?: CompletionDetector) {
    this.output = new OutputRing(capacity);
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
          } else {
            detector?.accept(raw);
          }
          this.output.append(raw);
        } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
      }));
      this.subscriptions.push(pty.onExit(event => {
        this.exitCode = event.exitCode;
        this.output.finish();
        this.touch();
        if (this.state === 'CLOSED' || this.state === 'FAILED') return;
        if (this.state === 'CREATING') {
          this.fail(new TerminalError('PROFILE_START_FAILED', 'Shell exited before readiness'));
        } else {
          this.state = 'EXITED';
          this.dispose();
          // node-pty retains native/worker resources after onExit until kill().
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
  private fail(error: Error) {
    if (this.state === 'CLOSED' || this.state === 'FAILED') return;
    this.state = 'FAILED';
    this.failure = { code: error instanceof TerminalError ? error.code : 'SESSION_IO_FAILED', message: error.message };
    this.rejectReady(error);
    this.dispose();
    try { this.pty.kill(); } catch (cause) {
      // Retain cleanup failure explicitly, without masking the initiating error.
      error.cause = new AggregateError([error.cause, cause], 'PTY cleanup failed');
    }
  }
  snapshot() {
    return { sessionId: this.sessionId, profile: this.profile.id, state: this.state,
      identity: this.identity ? { ...this.identity } : undefined, createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt, exitCode: this.exitCode, error: this.failure ? { ...this.failure } : undefined };
  }
  write(text: string) {
    if (this.state !== 'READY') throw new TerminalError('SESSION_NOT_READY', `Session is ${this.state}`);
    try { this.pty.write(text); this.touch(); }
    catch (cause) {
      const error = new TerminalError('SESSION_IO_FAILED', 'PTY write failed', { cause });
      this.fail(error);
      throw error;
    }
  }
  read() { this.touch(); return { ...this.snapshot(), ...this.output.read() }; }
  close() {
    if (this.state === 'CLOSED') return this.snapshot();
    const wasCreating = this.state === 'CREATING';
    const wasExited = this.state === 'EXITED';
    // Commit close before kill: native/fake exit callbacks may fire synchronously.
    this.state = 'CLOSED';
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
