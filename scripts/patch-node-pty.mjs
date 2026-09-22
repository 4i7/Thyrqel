import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

// Maintained patch for MIT-licensed node-pty 1.1.0. See docs/PTY_PATCH.md.
// Patch the installed dependency, never the application's private PTY fields.
const file = new URL('../node_modules/node-pty/lib/windowsPtyAgent.js', import.meta.url);
const original = readFileSync(file, 'utf8');
const marker = '// Thyrqel: enumerate before ConPTY teardown (node-pty 1.1.0).';
if (original.includes(marker) && createHash('sha256').update(original).digest('hex') !==
  '395467eb3f5040e9faa33dc2b3d55fa1be8ac950b9cae963bd6c942fc3b12bc7') {
  throw new Error('Modified node-pty patch detected; restore with npm ci');
}
if (!original.includes(marker)) {
  const digest = createHash('sha256').update(original).digest('hex');
  if (digest !== '8636d16b38266112204061a22b135734177c242837982fd3a4055be726efa64a') {
    throw new Error('Unrecognized node-pty source; review the patch before installing');
  }
  const start = original.indexOf('    WindowsPtyAgent.prototype.kill = function () {');
  const end = original.indexOf('    WindowsPtyAgent.prototype._getConsoleProcessList', start);
  const oldKill = original.slice(start, end);
  const branchStart = oldKill.indexOf('            if (!this._useConptyDll) {');
  const branchEnd = oldKill.indexOf('            else {', branchStart);
  const branch = `            if (!this._useConptyDll) {
                ${marker}
                if (this._thyrqelClosing) return;
                this._thyrqelClosing = true;
                var release = function () {
                    try { _this._ptyNative.kill(_this._pty, false); }
                    finally {
                        _this._conoutSocketWorker.dispose();
                        _this._inSocket.destroy();
                        _this._outSocket.destroy();
                    }
                };
                // Natural exit has no live console to enumerate.
                if (this._exitCode !== undefined) {
                    release();
                    return;
                }
                this._getConsoleProcessList().then(function (pids) {
                    try {
                        // Keep ConPTY alive until the helper has captured its members.
                        pids.forEach(function (pid) {
                            try { process.kill(pid); }
                            catch (error) { if (error.code !== 'ESRCH') throw error; }
                        });
                    } finally { release(); }
                }, function (error) {
                    try { release(); }
                    finally { process.emitWarning(error); }
                }).catch(function (error) { process.emitWarning(error); });
            }
`;
  const updatedKill = oldKill.slice(0, branchStart) + branch + oldKill.slice(branchEnd);
  let updated = original.slice(0, start) + updatedKill + original.slice(end);
  // Never kill a PID five seconds after enumeration failed: it may be reused.
  updated = updated.replace('return new Promise(function (resolve) {\n            var agent = child_process_1.fork',
    'return new Promise(function (resolve, reject) {\n            var agent = child_process_1.fork');
  updated = updated.replace('                resolve([_this._innerPid]);',
    "                reject(new Error('ConPTY process enumeration timed out')); ");
  writeFileSync(file, updated);
}
