import { TextDecoder } from 'node:util';
import { TerminalError, type CompletionDetector as CompletionDetectorContract, type CompletionResult } from '../types.js';

const PREFIX = 'TB1:';
const LENGTH_HEX_CHARS = 8;
const MAX_BODY_CHARS = 256 * 1024;
const MAX_OPERATION_ID_BYTES = 256;
const MAX_CWD_BYTES = 192 * 1024;
const TOKEN_RE = /^[a-f0-9]{48}$/;
const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const utf8 = new TextDecoder('utf-8', { fatal: true });

type Phase = 'search' | 'length' | 'body';

function decodeBase64(value: string, field: string, maxBytes: number): string {
  if (!value || !B64_RE.test(value)) throw new TerminalError('SESSION_PROTOCOL_ERROR', `Malformed completion ${field}`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== value) {
    throw new TerminalError('SESSION_PROTOCOL_ERROR', `Malformed completion ${field}`);
  }
  try {
    return utf8.decode(bytes);
  } catch (cause) {
    throw new TerminalError('SESSION_PROTOCOL_ERROR', `Invalid completion ${field}`, { cause });
  }
}

export class CompletionDetector implements CompletionDetectorContract {
  private token?: string;
  private phase: Phase = 'search';
  private carry = '';
  private expectedBodyChars = 0;
  private lengthHeader = '';

  arm(completionToken: string) {
    if (!TOKEN_RE.test(completionToken)) throw new RangeError('Invalid completion token');
    this.token = completionToken;
    this.phase = 'search';
    this.carry = '';
    this.expectedBodyChars = 0;
    this.lengthHeader = '';
  }

  reset() {
    this.token = undefined;
    this.phase = 'search';
    this.carry = '';
    this.expectedBodyChars = 0;
    this.lengthHeader = '';
  }

  accept(raw: string): { output: string; completion?: CompletionResult } {
    if (!this.token) return { output: raw };
    const marker = `${PREFIX}${this.token}:`;
    let input = this.carry + raw;
    let output = '';
    this.carry = '';

    if (this.phase === 'search') {
      const at = input.indexOf(marker);
      if (at < 0) {
        let keep = Math.min(input.length, marker.length - 1);
        while (keep > 0 && !marker.startsWith(input.slice(-keep))) keep--;
        output = input.slice(0, input.length - keep);
        this.carry = keep ? input.slice(-keep) : '';
        return { output };
      }
      output = input.slice(0, at);
      input = input.slice(at + marker.length);
      this.phase = 'length';
    }

    if (this.phase === 'length') {
      const needed = LENGTH_HEX_CHARS + 1;
      if (input.length < needed) {
        this.carry = input;
        return { output };
      }
      const header = input.slice(0, needed);
      if (!/^[0-9A-Fa-f]{8}:$/.test(header)) {
        throw new TerminalError('SESSION_PROTOCOL_ERROR', 'Malformed completion frame length');
      }
      const bodyChars = Number.parseInt(header.slice(0, LENGTH_HEX_CHARS), 16);
      if (!Number.isSafeInteger(bodyChars) || bodyChars <= 0 || bodyChars > MAX_BODY_CHARS) {
        throw new TerminalError('SESSION_PROTOCOL_ERROR', 'Completion frame exceeds parser bound');
      }
      this.lengthHeader = header;
      this.expectedBodyChars = bodyChars;
      input = input.slice(needed);
      this.phase = 'body';
    }

    if (input.length < this.expectedBodyChars) {
      this.carry = input;
      return { output };
    }

    const body = input.slice(0, this.expectedBodyChars);
    const rest = input.slice(this.expectedBodyChars);
    const parts = body.split(':');
    if (parts.length !== 4) throw new TerminalError('SESSION_PROTOCOL_ERROR', 'Malformed completion frame');
    const [operationIdB64, successFlag, exitText, cwdB64] = parts;
    if (!['0', '1'].includes(successFlag ?? '') || !/^(?:N|-?\d+)$/.test(exitText ?? '')) {
      throw new TerminalError('SESSION_PROTOCOL_ERROR', 'Malformed completion frame');
    }
    const operationId = decodeBase64(operationIdB64!, 'operation id', MAX_OPERATION_ID_BYTES);
    const cwd = decodeBase64(cwdB64!, 'cwd', MAX_CWD_BYTES);
    const exitCode = exitText === 'N' ? null : Number(exitText);
    if (exitCode !== null && !Number.isSafeInteger(exitCode)) {
      throw new TerminalError('SESSION_PROTOCOL_ERROR', 'Invalid completion exit code');
    }

    this.reset();
    return { output: output + rest, completion: { operationId, success: successFlag === '1', exitCode, cwd } };
  }

  flush(): string {
    if (!this.token) return '';
    const marker = `${PREFIX}${this.token}:`;
    const value = this.phase === 'search' ? this.carry :
      this.phase === 'length' ? marker + this.carry : marker + this.lengthHeader + this.carry;
    this.reset();
    return value;
  }
}
