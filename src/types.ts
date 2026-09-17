export type SessionState = 'CREATING' | 'READY' | 'EXITED' | 'CLOSED' | 'FAILED';
export type ActiveStepState = 'FRAMING' | 'DISPATCHED' | 'RUNNING' | 'COMPLETED' | 'EXITED' | 'FAILED' | 'CANCELLED';
export type Profile = Readonly<
  { id: 'windows-pwsh'; platform: 'windows'; shellDialect: 'powershell'; command: string } |
  { id: 'wsl-kali'; platform: 'wsl2'; shellDialect: 'bash'; distro: string; user: string;
    shell: '/bin/bash'; initialDirectory: string }
>;
export type ErrorCode = 'INVALID_PROFILE' | 'INVALID_SESSION' | 'SESSION_NOT_READY' |
  'PROFILE_START_FAILED' | 'PROFILE_IDENTITY_MISMATCH' | 'SESSION_IO_FAILED' |
  'SESSION_LIMIT' | 'UNSUPPORTED_HOST' | 'SESSION_BUSY' | 'SESSION_PROTOCOL_ERROR';
export class TerminalError extends Error {
  constructor(public readonly code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TerminalError';
  }
}
export interface Identity {
  shell: string;
  version?: string;
  user?: string;
  uid?: number;
  cwd: string;
  interactive?: boolean;
}
export interface CompletionResult {
  operationId: string;
  success: boolean;
  exitCode: number | null;
  cwd: string;
}
export interface CompletionDetector {
  arm(completionToken: string): void;
  accept(raw: string): { output: string; completion?: CompletionResult };
  flush(): string;
  reset(): void;
}
export interface FramedCommand {
  wire: string;
  completionToken: string;
}
export interface CommandFramer { frame(command: string, operationId: string): FramedCommand; }
export type TerminalKey = 'CTRL_C' | 'CTRL_D' | 'ENTER' | 'TAB' | 'ESC' | 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';
export type TerminalWriteInput =
  | { mode: 'raw'; data: string }
  | { mode: 'line'; data: string }
  | { mode: 'key'; key: TerminalKey };
export interface StepResult {
  state: 'ready' | 'running' | 'exited' | 'closed';
  success: boolean | null;
  exitCode: number | null;
  output: string;
  truncated: boolean;
  droppedBytes: number;
  operationId: string;
}
