export type SessionState = 'CREATING' | 'READY' | 'EXITED' | 'CLOSED' | 'FAILED';
export type Profile = Readonly<
  { id: 'windows-pwsh'; platform: 'windows'; shellDialect: 'powershell'; command: string } |
  { id: 'wsl-kali'; platform: 'wsl2'; shellDialect: 'bash'; distro: string; user: string;
    shell: '/bin/bash'; initialDirectory: string }
>;
export type ErrorCode = 'INVALID_PROFILE' | 'INVALID_SESSION' | 'SESSION_NOT_READY' |
  'PROFILE_START_FAILED' | 'PROFILE_IDENTITY_MISMATCH' | 'SESSION_IO_FAILED' |
  'SESSION_LIMIT' | 'UNSUPPORTED_HOST';
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
// CP-2 connects at the raw onData boundary, before output storage/projection.
export interface CompletionDetector { accept(raw: string): void; }
export interface CommandFramer { frame(command: string): string; }
