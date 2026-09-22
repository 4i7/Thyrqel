import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import { SessionManager, ProfileRegistry } from '../dist/src/main.js';
import { DeviceExecutor } from '../dist/src/remote/device-executor.js';
import { shellEnvironment } from '../dist/src/remote/environment.js';

export async function createLiveDevice() {
  const profiles = JSON.parse(await readFile('profiles.local.json', 'utf8'));
  const manager = new SessionManager(new ProfileRegistry(profiles), { environment: shellEnvironment(process.env) });
  const executor = new DeviceExecutor(manager);
  return {
    epoch: executor.epoch,
    execute: raw => executor.execute(raw),
    shutdown: () => manager.shutdown(),
    async smoke(tool, requireSudo) {
      async function call(action) {
        const operationId = randomUUID();
        const receipt = await tool('terminal_submit', { epoch: executor.epoch, operationId, call: action });
        assert.equal(receipt.ok, true, JSON.stringify(receipt));
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          const response = await tool('terminal_result', { epoch: executor.epoch, operationId });
          assert.equal(response.ok, true, JSON.stringify(response));
          if (response.status === 'COMPLETE') {
            assert.equal(response.result.ok, true, JSON.stringify(response.result));
            return response.result.value;
          }
          assert.equal(response.status, 'PENDING');
          await delay(30);
        }
        throw new Error('Remote operation receipt timed out; not resubmitted');
      }
      async function output(sessionId, marker) {
        let raw = '';
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          const result = await call({ action: 'read', sessionId });
          assert.equal(result.truncated, false);
          raw += result.output;
          assert.ok(Buffer.byteLength(raw) <= 262144, 'Live output exceeded test budget');
          const text = stripVTControlCharacters(raw);
          if (text.includes(marker)) return text;
          await delay(30);
        }
        throw new Error(`Remote terminal output did not contain ${marker}`);
      }
      for (const profile of profiles) {
        const session = await call({ action: 'open', profile: profile.id });
        const sessionId = session.sessionId;
        const ps = profile.platform === 'windows';
        await call({ action: 'read', sessionId });
        await call({ action: 'input', sessionId, text: ps
          ? "Set-Location $env:TEMP; Write-Output ('TB_REMOTE_'+'CD')\r"
          : "cd /tmp; printf '%s%s\\n' 'TB_REMOTE_' 'CD'\r" });
        await output(sessionId, 'TB_REMOTE_CD');
        await call({ action: 'input', sessionId, text: ps
          ? "Write-Output ('TB_REMOTE_PERSIST_'+((Get-Location).Path -eq $env:TEMP))\r"
          : "printf 'TB_REMOTE_PERSIST_%s\\n' \"$PWD\"\r" });
        await output(sessionId, ps ? 'TB_REMOTE_PERSIST_True' : 'TB_REMOTE_PERSIST_/tmp');
        await call({ action: 'input', sessionId, text: ps
          ? "$answer = Read-Host -Prompt ('TB_REMOTE_'+'PROMPT'); Write-Output ('TB_REMOTE_ANSWER_'+$answer)\r"
          : "printf '%s%s' 'TB_REMOTE_' 'PROMPT'; read -r answer; printf 'TB_REMOTE_ANSWER_%s\\n' \"$answer\"\r" });
        await output(sessionId, 'TB_REMOTE_PROMPT');
        await call({ action: 'input', sessionId, text: 'follow-up-ok\r' });
        await output(sessionId, 'TB_REMOTE_ANSWER_follow-up-ok');
        // Synthetic secret enters locally, never as a remote tool argument.
        await call({ action: 'input', sessionId, text: ps
          ? "$answer = Read-Host -Prompt ('TB_LOCAL_'+'SECRET'); Write-Output ('TB_SECRET_ECHO_'+$answer); Write-Output ('TB_SECRET_'+'DONE')\r"
          : "printf '%s%s' 'TB_LOCAL_' 'SECRET'; read -r answer; printf 'TB_SECRET_ECHO_%s\\n' \"$answer\"; printf '%s%s\\n' 'TB_SECRET_' 'DONE'\r" });
        await output(sessionId, 'TB_LOCAL_SECRET');
        const syntheticSecret = `synthetic-${randomUUID()}`;
        manager.writeSecret(sessionId, syntheticSecret);
        const observedSecretOutput = await output(sessionId, 'TB_SECRET_DONE');
        assert.ok(!observedSecretOutput.includes(syntheticSecret), 'Local secret must not appear in remote output');
        assert.ok(observedSecretOutput.includes('TB_SECRET_ECHO_[REDACTED]'), 'Explicit echo must be redacted');
        if (!ps && requireSudo) {
          await call({ action: 'input', sessionId, text:
            "tb_uid=$(/usr/bin/sudo -n -- /usr/bin/id -u); tb_status=$?; printf '%s%s%s:%s\\n' 'TB_SU' 'DO_' \"$tb_status\" \"$tb_uid\"\r" });
          const observed = await output(sessionId, 'TB_SUDO_');
          const status = /TB_SUDO_(\d+):(\d*)/.exec(observed);
          assert.ok(status, 'Missing sudo exit/uid observation');
          assert.equal(status[1], '0', `sudo -n exit=${status[1]}; password-required diagnostic=${observed.includes('a password is required')}`);
          assert.equal(status[2], '0', 'sudo did not report uid 0');
          console.log('PASS remote WSL sudo -n id -u returned uid 0 (existing OS policy; no policy change)');
        }
        await call({ action: 'close', sessionId });
        await call({ action: 'forget', sessionId });
        console.log(`PASS remote ${profile.id}: persistent cwd, interactive follow-up, local secret echo redaction, close/forget`);
      }
    },
  };
}
