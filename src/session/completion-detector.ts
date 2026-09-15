import { TerminalError, type CompletionDetector as CompletionDetectorContract, type CompletionResult } from '../types.js';

const PREFIX = '\x1eTB1:';
const END = '\x1f';
const MAX_FRAME_CHARS = 16 * 1024;
const TOKEN_RE = /^[a-f0-9]{48}$/;
const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class CompletionDetector implements CompletionDetectorContract {
  private token?: string;
  private carry = '';
  arm(completionToken: string) {
    if (!TOKEN_RE.test(completionToken)) throw new RangeError('Invalid completion token');
    this.token = completionToken;
    this.carry = '';
  }
  reset() { this.token = undefined; this.carry = ''; }
  accept(raw: string): { output: string; completion?: CompletionResult } {
    if (!this.token) return { output: raw };
    this.carry += raw;
    const marker = `${PREFIX}${this.token}:`;
    const at = this.carry.indexOf(marker);
    if (at < 0) {
      let keep = Math.min(this.carry.length, marker.length - 1);
      while (keep > 0 && !marker.startsWith(this.carry.slice(-keep))) keep--;
      const output = this.carry.slice(0, this.carry.length - keep);
      this.carry = keep ? this.carry.slice(-keep) : '';
      return { output };
    }
    const output = this.carry.slice(0, at);
    this.carry = this.carry.slice(at);
    if (this.carry.length > MAX_FRAME_CHARS) {
      throw new TerminalError('SESSION_PROTOCOL_ERROR', 'Completion frame exceeds parser bound');
    }
    const end = this.carry.indexOf(END, marker.length);
    if (end < 0) return { output };
    const frame = this.carry.slice(0, end + END.length);
    const rest = this.carry.slice(end + END.length);
    this.carry = '';
    const body = frame.slice(marker.length, -END.length);
    const parts = body.split(':');
    if (parts.length !== 4) throw new TerminalError('SESSION_PROTOCOL_ERROR', 'Malformed completion frame');
    const [operationIdB64, successFlag, exitText, cwdB64] = parts;
    if (!operationIdB64 || !cwdB64 || !B64_RE.test(operationIdB64) || !B64_RE.test(cwdB64) ||
        !['0', '1'].includes(successFlag ?? '') || !/^(?:N|-?\d+)$/.test(exitText ?? '')) {
      throw new TerminalError('SESSION_PROTOCOL_ERROR', 'Malformed completion frame');
    }
    let operationId: string, cwd: string;
    try {
      operationId = Buffer.from(operationIdB64, 'base64').toString('utf8');
      cwd = Buffer.from(cwdB64, 'base64').toString('utf8');
    } catch (cause) {
      throw new TerminalError('SESSION_PROTOCOL_ERROR', 'Invalid completion payload', { cause });
    }
    const exitCode = exitText === 'N' ? null : Number(exitText);
    if (exitCode !== null && !Number.isSafeInteger(exitCode)) throw new TerminalError('SESSION_PROTOCOL_ERROR', 'Invalid completion exit code');
    this.token = undefined;
    return { output: output + rest, completion: { operationId, success: successFlag === '1', exitCode, cwd } };
  }
  flush(): string {
    const value = this.carry;
    this.carry = '';
    return value;
  }
}
