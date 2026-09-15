// Embedded local API only. No listener, remote transport, MCP, or arbitrary profile input.
export { SessionManager } from './session/manager.js';
export { ProfileRegistry } from './profiles.js';
export { TerminalError } from './types.js';
export type { Profile, Identity, SessionState, CommandFramer, CompletionDetector } from './types.js';
