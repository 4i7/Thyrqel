import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

// Maintained patch for MIT-licensed node-pty 1.1.0. See docs/PTY_PATCH.md.
// Patch the installed dependency, never the application's private PTY fields.
const file = new URL('../node_modules/node-pty/lib/windowsPtyAgent.js', import.meta.url);
const original = readFileSync(file, 'utf8');
const marker = '// Thyrqel: enumerate before ConPTY teardown (node-pty 1.1.0).';
if (original.includes(marker) && ![
  '395467eb3f5040e9faa33dc2b3d55fa1be8ac950b9cae963bd6c942fc3b12bc7',
  'fd97e9342e69fc88dd20477212b242fa103dd029a638eb89f0c4fddf28b50d81',
].includes(createHash('sha256').update(original).digest('hex'))) {
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

const current = readFileSync(file, 'utf8');
const raceMarker = '// Thyrqel: structured enumeration outcome.';
const helperFile = new URL('../node_modules/node-pty/lib/conpty_console_list_agent.js', import.meta.url);
const helper = readFileSync(helperFile, 'utf8');
const helperHash = createHash('sha256').update(helper).digest('hex');
if (!['0d010879bb6680a0253d44363183d53e631f42972594eb6dcb1fb842c8c85e52',
  'a935c9272084bbb61750cfc4dabd074b4538f9d07d09e77f1de5a3f9e1d736e4'].includes(helperHash)) {
  throw new Error('Unrecognized ConPTY enumeration helper; restore with npm ci');
}
if (!current.includes(raceMarker)) {
  const start = current.indexOf('    WindowsPtyAgent.prototype._getConsoleProcessList = function () {');
  const end = current.indexOf('    Object.defineProperty(WindowsPtyAgent.prototype, "exitCode"', start);
  const enumeration = `    WindowsPtyAgent.prototype._getConsoleProcessList = function () {
        ${raceMarker}
        var _this = this;
        return new Promise(function (resolve, reject) {
            var settled = false;
            var finish = function (error, pids) {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                if (error) reject(error); else resolve(pids);
            };
            var agent = child_process_1.fork(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()]);
            var timeout = setTimeout(function () {
                agent.kill();
                finish(new Error('ConPTY process enumeration timed out'));
            }, 5000);
            agent.on('message', function (message) {
                if (Array.isArray(message.consoleProcessList)) return finish(undefined, message.consoleProcessList);
                // Native exit notification is authoritative. A failed attach alone is not.
                if (message.enumerationError === 'AttachConsole failed' && _this._exitCode !== undefined) return finish(undefined, []);
                finish(new Error('ConPTY process enumeration failed: ' + String(message.enumerationError)));
            });
            agent.on('error', function (error) { finish(error); });
            agent.on('exit', function (code) {
                if (!settled) finish(new Error('ConPTY enumeration helper exited without a result: ' + code));
            });
        });
    };
`;
  if (start < 0 || end < start) throw new Error('Enumeration patch boundary missing');
  writeFileSync(file, current.slice(0, start) + enumeration + current.slice(end));
}
if (helperHash === '0d010879bb6680a0253d44363183d53e631f42972594eb6dcb1fb842c8c85e52') {
  const start = helper.indexOf('var consoleProcessList = getConsoleProcessList(shellPid);');
  const end = helper.indexOf('//# sourceMappingURL', start);
  if (start < 0 || end < start) throw new Error('Helper patch boundary missing');
  writeFileSync(helperFile, helper.slice(0, start) + `// Thyrqel: report native failure through IPC; the parent classifies it.
try {
    var consoleProcessList = getConsoleProcessList(shellPid);
    process.send({ consoleProcessList: consoleProcessList }, function () { process.exit(0); });
} catch (error) {
    process.send({ enumerationError: error.message }, function () { process.exit(1); });
}
` + helper.slice(end));
}
