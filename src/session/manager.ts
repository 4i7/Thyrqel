import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { release } from 'node:os';
import * as nodePty from 'node-pty';
import { ProfileRegistry, launch } from '../profiles.js';
import { TerminalError } from '../types.js';
import { PtySession } from './pty-session.js';

export function assertStandardWindowsHost() {
  if (process.platform !== 'win32' || Number(release().split('.')[2]) < 22000) throw new TerminalError('UNSUPPORTED_HOST', 'Windows 11 required');
  // whoami reports the token integrity SID even when localized. Reject high/system integrity.
  const groups = execFileSync(`${process.env.SystemRoot}\\System32\\whoami.exe`, ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const levels = [...groups.matchAll(/S-1-16-(\d+)/g)].map(m => Number(m[1]));
  if (levels.length !== 1 || levels[0]! >= 12288) throw new TerminalError('UNSUPPORTED_HOST', 'A non-elevated Windows token is required');
}

export class SessionManager {
  private readonly epoch = randomUUID();
  private readonly sessions = new Map<string, PtySession>();
  private disposed = false;
  constructor(private readonly registry: ProfileRegistry,
    private readonly options: { ringBytes?: number; readinessTimeoutMs?: number; maxSessions?: number;
      spawn?: typeof nodePty.spawn; checkHost?: () => void } = {}) {
    for (const [value, minimum] of [[options.ringBytes ?? 1048576, 4], [options.readinessTimeoutMs ?? 15000, 1], [options.maxSessions ?? 4, 1]]) {
      if (!Number.isSafeInteger(value) || value! < minimum!) throw new RangeError('Invalid session limit');
    }
    (options.checkHost ?? assertStandardWindowsHost)();
  }
  async open(profileId: string) {
    if (this.disposed) throw new TerminalError('SESSION_NOT_READY', 'Manager has shut down');
    const profile = this.registry.get(profileId);
    // Bound retained entries as well as live PTYs. Explicit forget removes terminal records.
    if (this.sessions.size >= (this.options.maxSessions ?? 4)) throw new TerminalError('SESSION_LIMIT', 'Session registry full; forget closed/exited sessions');
    const spec = launch(profile);
    let pty: nodePty.IPty;
    try {
      pty = (this.options.spawn ?? nodePty.spawn)(spec.command, spec.args, {
        name: 'xterm-256color', cols: 240, rows: 40, cwd: process.cwd(),
        env: { ...process.env }, useConpty: true, handleFlowControl: false
      });
    } catch (cause) { throw new TerminalError('PROFILE_START_FAILED', 'PTY spawn failed', { cause }); }
    const id = `ts_${this.epoch}_${randomUUID()}`;
    const session = new PtySession(id, profile, pty, this.options.ringBytes ?? 1048576, this.options.readinessTimeoutMs ?? 15000);
    this.sessions.set(id, session);
    try { await session.ready; }
    catch (error) { this.sessions.delete(id); throw error; }
    if (session.state !== 'READY') {
      this.sessions.delete(id);
      throw new TerminalError('PROFILE_START_FAILED', 'Session ended before publication');
    }
    return { ...session.snapshot(), state: 'ready' as const };
  }
  private get(id: string) {
    const s = this.sessions.get(id);
    if (!s) throw new TerminalError('INVALID_SESSION', 'Unknown session');
    return s;
  }
  write(id: string, text: string) { this.get(id).write(text); }
  read(id: string) { return this.get(id).read(); }
  close(id: string) { return this.get(id).close(); }
  forget(id: string) {
    const s = this.get(id);
    if (!['CLOSED', 'EXITED', 'FAILED'].includes(s.state)) throw new TerminalError('SESSION_NOT_READY', 'Close session before forgetting');
    this.sessions.delete(id);
  }
  shutdown() {
    this.disposed = true;
    const failures: unknown[] = [];
    for (const s of this.sessions.values()) {
      try { s.close(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Failed to close PTYs');
  }
}
