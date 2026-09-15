import type { TerminalKey } from '../types.js';

const KEYS: Record<TerminalKey, string> = {
  CTRL_C: '\x03', CTRL_D: '\x04', ENTER: '\r', TAB: '\t', ESC: '\x1b',
  UP: '\x1b[A', DOWN: '\x1b[B', RIGHT: '\x1b[C', LEFT: '\x1b[D'
};
export class KeyCodec {
  encode(key: TerminalKey): string { return KEYS[key]; }
}
