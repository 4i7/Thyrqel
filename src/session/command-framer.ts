import { randomBytes } from 'node:crypto';
import type { CommandFramer, FramedCommand } from '../types.js';

const token = () => randomBytes(24).toString('hex');
const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');

export class BashCommandFramer implements CommandFramer {
  frame(command: string, operationId: string): FramedCommand {
    const completionToken = token();
    const a = completionToken.slice(0, 24), b = completionToken.slice(24);
    const payload = b64(command);
    const op = b64(operationId);
    const wire = [
      `if [ -z "\${__tb_fd+x}" ]; then exec {__tb_fd}>&1; fi`,
      `__tb_token='${a}''${b}'`,
      `__tb_payload='${payload}'`,
      `eval "$(printf '%s' "$__tb_payload" | /usr/bin/base64 -d)"`,
      `__tb_status=$?`,
      `__tb_cwd=$(builtin pwd -P)`,
      `__tb_cwd_b64=$(printf '%s' "$__tb_cwd" | /usr/bin/base64 -w0)`,
      `if [ "$__tb_status" -eq 0 ]; then __tb_ok=1; else __tb_ok=0; fi`,
      `printf -v __tb_body '%s:%s:%s:%s' '${op}' "$__tb_ok" "$__tb_status" "$__tb_cwd_b64"`,
      `printf -v __tb_len '%08x' "\${#__tb_body}"`,
      `printf 'TB1:%s:%s:%s' "$__tb_token" "$__tb_len" "$__tb_body" >&$__tb_fd`,
      `unset __tb_token __tb_payload __tb_status __tb_cwd __tb_cwd_b64 __tb_ok __tb_body __tb_len`
    ].join('; ') + '\r';
    return { wire, completionToken };
  }
}

export class PowerShellCommandFramer implements CommandFramer {
  frame(command: string, operationId: string): FramedCommand {
    const completionToken = token();
    const a = completionToken.slice(0, 24), b = completionToken.slice(24);
    const payload = b64(command);
    const op = b64(operationId);
    // Dot-source the ScriptBlock so cwd, variables, functions and environment changes persist.
    // LASTEXITCODE is set to a transaction sentinel and restored when no native command updates it;
    // this avoids returning a stale native exit code from an earlier command.
    const wire = [
      `$__tb_token='${a}'+'${b}'`,
      `$__tb_payload=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))`,
      `$__tb_before_error=$Error.Count`,
      `$__tb_before_native=$global:LASTEXITCODE`,
      `$__tb_native_sentinel=2147483646`,
      `$global:LASTEXITCODE=$__tb_native_sentinel`,
      `$__tb_terminating=$false`,
      `try { $__tb_script=[ScriptBlock]::Create($__tb_payload); . $__tb_script } catch { $__tb_terminating=$true; Write-Error -ErrorRecord $_ }`,
      `$__tb_after_native=$global:LASTEXITCODE`,
      `$__tb_new_errors=($Error.Count -gt $__tb_before_error)`,
      `$__tb_native_observed=($__tb_after_native -ne $__tb_native_sentinel)`,
      `if(-not $__tb_native_observed){$global:LASTEXITCODE=$__tb_before_native}`,
      `$__tb_exit=if($__tb_native_observed){[string]$__tb_after_native}else{'N'}`,
      `$__tb_ok=(-not $__tb_terminating -and -not $__tb_new_errors -and (-not $__tb_native_observed -or $__tb_after_native -eq 0))`,
      `$__tb_cwd_b64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Location).Path))`,
      `$__tb_ok_text=if($__tb_ok){'1'}else{'0'}`,
      `$__tb_body='${op}:'+$__tb_ok_text+':'+$__tb_exit+':'+$__tb_cwd_b64`,
      `$__tb_len=$__tb_body.Length.ToString('x8')`,
      `[Console]::Out.Write('TB1:'+$__tb_token+':'+$__tb_len+':'+$__tb_body)`,
      `Remove-Variable __tb_token,__tb_payload,__tb_before_error,__tb_before_native,__tb_native_sentinel,__tb_terminating,__tb_script,__tb_after_native,__tb_new_errors,__tb_native_observed,__tb_exit,__tb_ok,__tb_cwd_b64,__tb_ok_text,__tb_body,__tb_len -ErrorAction SilentlyContinue`
    ].join('; ') + '\r';
    return { wire, completionToken };
  }
}

export function framerFor(dialect: 'bash' | 'powershell'): CommandFramer {
  return dialect === 'bash' ? new BashCommandFramer() : new PowerShellCommandFramer();
}
