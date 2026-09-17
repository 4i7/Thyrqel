import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BashCommandFramer, PowerShellCommandFramer } from '../src/session/command-framer.js';

const oldBashNames = ['__tb_fd', '__tb_token', '__tb_payload', '__tb_status', '__tb_cwd', '__tb_cwd_b64', '__tb_ok', '__tb_body', '__tb_len', '__tb_int_trap'];
const oldPowerShellNames = ['__tb_token', '__tb_payload', '__tb_before_error', '__tb_before_native', '__tb_native_sentinel', '__tb_terminating', '__tb_script', '__tb_after_native', '__tb_new_errors', '__tb_native_observed', '__tb_exit', '__tb_ok', '__tb_cwd_b64', '__tb_ok_text', '__tb_body', '__tb_len'];

function bashFdName(wire: string) {
  const match = wire.match(/exec \{(__tb_[a-f0-9]{32}_fd)\}>&1/);
  assert.ok(match);
  return match[1]!;
}

function privateStepPrefix(wire: string) {
  const match = wire.match(/(__tb_[a-f0-9]{32}_[a-f0-9]{16})_token/);
  assert.ok(match);
  return match[1]!;
}

test('bash framing keeps the control descriptor session-private and step bookkeeping collision-resistant', () => {
  const a = new BashCommandFramer();
  const first = a.frame('exec >/dev/null', 'op_first').wire;
  const second = a.frame('true', 'op_second').wire;
  const b = new BashCommandFramer().frame('true', 'op_other').wire;

  assert.equal(bashFdName(first), bashFdName(second));
  assert.notEqual(bashFdName(first), bashFdName(b));
  assert.notEqual(privateStepPrefix(first), privateStepPrefix(second));
  assert.match(first, new RegExp(`>&\\$${bashFdName(first)}\\b`));
  assert.equal(first.includes(`unset ${bashFdName(first)}`), false);
  for (const name of oldBashNames) assert.equal(new RegExp(`(^|[^a-f0-9_])${name}(?=$|[^a-f0-9_])`).test(first), false, name);
});

test('PowerShell framing uses per-step private bookkeeping and wrapper error reporting ignores persisted ErrorActionPreference', () => {
  const framer = new PowerShellCommandFramer();
  const first = framer.frame('throw "x"', 'op_first').wire;
  const second = framer.frame('Write-Output OK', 'op_second').wire;

  assert.notEqual(privateStepPrefix(first), privateStepPrefix(second));
  assert.match(first, /Write-Error -ErrorRecord \$_ -ErrorAction Continue/);
  for (const name of oldPowerShellNames) assert.equal(new RegExp(`(^|[^a-f0-9_])${name}(?=$|[^a-f0-9_])`, 'i').test(first), false, name);
});
