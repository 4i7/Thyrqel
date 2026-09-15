import { randomBytes } from 'node:crypto';
import { TerminalError, type Identity, type Profile } from '../types.js';

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
// Startup-only ASCII frame: TBREADY:<nonce>:<base64 UTF-8 payload>:END.
// Nonce is joined inside the shell, so echoed input cannot contain the frame.
export class Readiness {
  readonly nonce = randomBytes(24).toString('hex');
  readonly command: string;
  private carry = '';
  constructor(private readonly profile: Profile) {
    const a = this.nonce.slice(0, 24), b = this.nonce.slice(24);
    const initialPath = profile.platform === 'wsl2'
      ? (profile.initialDirectory === '~' ? '"$HOME"' : quote(profile.initialDirectory)) : '';
    this.command = profile.platform === 'windows'
      ? `& { $n='${a}'+'${b}'; $j=@{shell='powershell';version=$PSVersionTable.PSVersion.ToString();edition=$PSVersionTable.PSEdition;cwd=(Get-Location).Path}|ConvertTo-Json -Compress; [Console]::WriteLine(('TBREADY:'+ $n + ':' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j)) + ':END')) }\r`
      : `printf '\\nTBREADY:%s%s:%s:END\\n' '${a}' '${b}' "$(printf '%s\\n' "$(/usr/bin/id -u)" "$(/usr/bin/id -un)" "$(/usr/bin/readlink -f /proc/$$/exe)" "$0" "$-" "$(builtin pwd -P)" "$(/usr/bin/realpath -- ${initialPath})" | /usr/bin/base64 -w0)"\r`;
  }
  accept(raw: string): Identity | undefined {
    this.carry += raw;
    const prefix = `TBREADY:${this.nonce}:`;
    const start = this.carry.indexOf(prefix);
    if (start < 0) { this.carry = this.carry.slice(-prefix.length); return; }
    this.carry = this.carry.slice(start);
    if (this.carry.length > 16384) throw new TerminalError('PROFILE_START_FAILED', 'Readiness frame exceeds limit');
    const end = this.carry.indexOf(':END', prefix.length);
    if (end < 0) return;
    const encoded = this.carry.slice(prefix.length, end);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new TerminalError('PROFILE_START_FAILED', 'Malformed readiness frame');
    const value = Buffer.from(encoded, 'base64').toString('utf8');
    const mismatch = () => new TerminalError('PROFILE_IDENTITY_MISMATCH', 'Readiness identity does not match configured profile');
    if (this.profile.platform === 'windows') {
      let data;
      try { data = JSON.parse(value); } catch { throw mismatch(); }
      if (!data || data.shell !== 'powershell' || data.edition !== 'Core' || typeof data.version !== 'string' || !/^7\./.test(data.version) || typeof data.cwd !== 'string' || !data.cwd) throw mismatch();
      return { shell: data.shell, version: data.version, cwd: data.cwd };
    }
    const fields = (value.endsWith('\n') ? value.slice(0, -1) : value).split('\n');
    const [uid, user, shell, argv0, flags, cwd, expected] = fields;
    if (fields.length !== 7 || !uid || !/^\d+$/.test(uid) || !Number.isSafeInteger(Number(uid)) || Number(uid) === 0 || user !== this.profile.user ||
      shell !== '/usr/bin/bash' && shell !== '/bin/bash' || argv0 !== '/bin/bash' ||
      !flags?.includes('i') || !cwd?.startsWith('/') || cwd !== expected) throw mismatch();
    return { uid: Number(uid), user, shell, cwd, interactive: true };
  }
}
