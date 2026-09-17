import { randomBytes } from 'node:crypto';
import type { CommandFramer, FramedCommand } from '../types.js';

const token = () => randomBytes(24).toString('hex');
const privateNamespace = () => `__tb_${randomBytes(16).toString('hex')}`;
const privateStep = (scope: string) => `${scope}_${randomBytes(8).toString('hex')}`;
const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');

export class BashCommandFramer implements CommandFramer {
  private readonly scope = privateNamespace();
  private readonly fd = `${this.scope}_fd`;

  frame(command: string, operationId: string): FramedCommand {
    const completionToken = token();
    const a = completionToken.slice(0, 24), b = completionToken.slice(24);
    const payload = b64(command);
    const op = b64(operationId);
    const step = privateStep(this.scope);
    const tokenVar = `${step}_token`;
    const payloadVar = `${step}_payload`;
    const statusVar = `${step}_status`;
    const cwdVar = `${step}_cwd`;
    const cwdB64Var = `${step}_cwd_b64`;
    const okVar = `${step}_ok`;
    const bodyVar = `${step}_body`;
    const lenVar = `${step}_len`;
    const intTrapVar = `${step}_int_trap`;
    const wire = [
      // The control descriptor persists for the shell lifetime so a payload such as
      // `exec >/dev/null` cannot cut off this or later completion records. Its shell
      // variable name is randomized per PtySession rather than occupying user namespace.
      `if [ -z "\${${this.fd}+x}" ]; then exec {${this.fd}}>&1; fi`,
      `${tokenVar}='${a}''${b}'`,
      `${payloadVar}='${payload}'`,
      // Interactive Bash otherwise abandons the entire input list on SIGINT,
      // skipping the completion postlude after an interrupted foreground command.
      `${intTrapVar}=$(trap -p INT)`,
      `trap ':' INT`,
      `eval "$(printf '%s' "$${payloadVar}" | /usr/bin/base64 -d)"`,
      `${statusVar}=$?`,
      `if [ -n "$${intTrapVar}" ]; then eval "$${intTrapVar}"; else trap - INT; fi`,
      `${cwdVar}=$(builtin pwd -P)`,
      `${cwdB64Var}=$(printf '%s' "$${cwdVar}" | /usr/bin/base64 -w0)`,
      `if [ "$${statusVar}" -eq 0 ]; then ${okVar}=1; else ${okVar}=0; fi`,
      `printf -v ${bodyVar} '%s:%s:%s:%s' '${op}' "$${okVar}" "$${statusVar}" "$${cwdB64Var}"`,
      `printf -v ${lenVar} '%08x' "\${#${bodyVar}}"`,
      `printf 'TB1:%s:%s:%s' "$${tokenVar}" "$${lenVar}" "$${bodyVar}" >&$${this.fd}`,
      `unset ${tokenVar} ${payloadVar} ${statusVar} ${cwdVar} ${cwdB64Var} ${okVar} ${bodyVar} ${lenVar} ${intTrapVar}`
    ].join('; ') + '\r';
    return { wire, completionToken };
  }
}

export class PowerShellCommandFramer implements CommandFramer {
  private readonly scope = privateNamespace();

  frame(command: string, operationId: string): FramedCommand {
    const completionToken = token();
    const a = completionToken.slice(0, 24), b = completionToken.slice(24);
    const payload = b64(command);
    const op = b64(operationId);
    const step = privateStep(this.scope);
    const names = {
      token: `${step}_token`, payload: `${step}_payload`, beforeError: `${step}_before_error`,
      beforeNative: `${step}_before_native`, nativeSentinel: `${step}_native_sentinel`,
      terminating: `${step}_terminating`, script: `${step}_script`, afterNative: `${step}_after_native`,
      newErrors: `${step}_new_errors`, nativeObserved: `${step}_native_observed`, exit: `${step}_exit`,
      ok: `${step}_ok`, cwdB64: `${step}_cwd_b64`, okText: `${step}_ok_text`, body: `${step}_body`,
      len: `${step}_len`
    };
    const v = (name: string) => `$${name}`;
    // Dot-source the ScriptBlock so cwd, variables, functions and environment changes persist.
    // LASTEXITCODE is set to a transaction sentinel and restored when no native command updates it;
    // this avoids returning a stale native exit code from an earlier command. Wrapper error
    // reporting explicitly overrides ErrorAction so user-persisted preference state cannot abort
    // completion emission.
    const wire = [
      `${v(names.token)}='${a}'+'${b}'`,
      `${v(names.payload)}=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))`,
      `${v(names.beforeError)}=$Error.Count`,
      `${v(names.beforeNative)}=$global:LASTEXITCODE`,
      `${v(names.nativeSentinel)}=2147483646`,
      `$global:LASTEXITCODE=${v(names.nativeSentinel)}`,
      `${v(names.terminating)}=$false`,
      `try { ${v(names.script)}=[ScriptBlock]::Create(${v(names.payload)}); . ${v(names.script)} } catch { ${v(names.terminating)}=$true; Write-Error -ErrorRecord $_ -ErrorAction Continue }`,
      `${v(names.afterNative)}=$global:LASTEXITCODE`,
      `${v(names.newErrors)}=($Error.Count -gt ${v(names.beforeError)})`,
      `${v(names.nativeObserved)}=(${v(names.afterNative)} -ne ${v(names.nativeSentinel)})`,
      `if(-not ${v(names.nativeObserved)}){$global:LASTEXITCODE=${v(names.beforeNative)}}`,
      `${v(names.exit)}=if(${v(names.nativeObserved)}){[string]${v(names.afterNative)}}else{'N'}`,
      `${v(names.ok)}=(-not ${v(names.terminating)} -and -not ${v(names.newErrors)} -and (-not ${v(names.nativeObserved)} -or ${v(names.afterNative)} -eq 0))`,
      `${v(names.cwdB64)}=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Location).Path))`,
      `${v(names.okText)}=if(${v(names.ok)}){'1'}else{'0'}`,
      `${v(names.body)}='${op}:'+${v(names.okText)}+':'+${v(names.exit)}+':'+${v(names.cwdB64)}`,
      `${v(names.len)}=${v(names.body)}.Length.ToString('x8')`,
      `[Console]::Out.Write('TB1:'+${v(names.token)}+':'+${v(names.len)}+':'+${v(names.body)})`,
      `Remove-Variable ${Object.values(names).join(',')} -ErrorAction SilentlyContinue`
    ].join('; ') + '\r';
    return { wire, completionToken };
  }
}

export function framerFor(dialect: 'bash' | 'powershell'): CommandFramer {
  return dialect === 'bash' ? new BashCommandFramer() : new PowerShellCommandFramer();
}
