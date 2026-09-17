// Embedded local API only. No listener, remote transport, MCP, or arbitrary profile input.
export { SessionManager } from './session/manager.js';
export { ProfileRegistry } from './profiles.js';
export { BashCommandFramer, PowerShellCommandFramer } from './session/command-framer.js';
export { CompletionDetector } from './session/completion-detector.js';
export { KeyCodec } from './session/key-codec.js';
export { TerminalError } from './types.js';
export type { Profile, Identity, SessionState, ActiveStepState, CommandFramer, CompletionResult,
  TerminalKey, TerminalWriteInput, StepResult } from './types.js';
