// Bounded Windows diagnostic, not a replacement for either strict qualification gate.
// Print observations only; never persist raw PTY output or shell history.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import * as nodePty from 'node-pty';
import { SessionManager, ProfileRegistry, type Profile } from '../src/main.js';
import { PowerShellCommandFramer } from '../src/session/command-framer.js';
import { CompletionDetector } from '../src/session/completion-detector.js';

const profiles = JSON.parse(readFileSync(process.argv[2] ?? 'profiles.local.json', 'utf8')) as Profile[];
const profile = profiles.find(p => p.id === 'windows-pwsh');
if (!profile || profile.platform !== 'windows') throw new Error('windows-pwsh profile required');
const framed = new PowerShellCommandFramer().frame('Write-Output OK', 'op_diagnostic');
const pipe = spawnSync(profile.command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
  Buffer.from(framed.wire, 'utf16le').toString('base64')], {
  encoding: 'utf8', windowsHide: true, timeout: 10000
});
const detector = new CompletionDetector();
detector.arm(framed.completionToken);
const pipeResult = detector.accept(pipe.stdout ?? '');
console.log('PIPE', JSON.stringify({ exit: pipe.status, error: pipe.error?.message,
  stderr: Boolean(pipe.stderr), printablePrefix: pipe.stdout?.includes(`TB1:${framed.completionToken}:`),
  completion: pipeResult.completion?.success === true }));
if (pipe.error || pipe.status !== 0 || pipe.stderr || !pipeResult.completion?.success) {
  throw new Error('Pipe control failed; do not infer a PTY-only failure');
}

let raw = '';
let capturedToken = '';
const postlude = randomBytes(24).toString('hex');
const manager = new SessionManager(new ProfileRegistry(profiles), {
  spawn: (...args) => {
    const pty = nodePty.spawn(...args);
    pty.onData(chunk => { raw = (raw + chunk).slice(-1048576); });
    const write = pty.write.bind(pty);
    pty.write = data => {
      if (typeof data !== 'string') { write(data); return; }
      const match = /\$__tb_token='([a-f0-9]{24})'\+'([a-f0-9]{24})'/.exec(data);
      if (match) {
        capturedToken = match[1]! + match[2]!;
        data = data.slice(0, -1) + `; [Console]::Out.WriteLine('${postlude.slice(0, 24)}'+'${postlude.slice(24)}')\r`;
      }
      write(data);
    };
    return pty;
  }
});
try {
  const session = await manager.open('windows-pwsh');
  manager.read(session.sessionId);
  raw = '';
  const result = await manager.step(session.sessionId, 'Write-Output OK', 5000);
  // Completion may arrive before the instrumentation after wrapper cleanup.
  const deadline = Date.now() + 5000;
  while (!raw.includes(postlude) && Date.now() < deadline) await delay(10);
  console.log('PTY', JSON.stringify({ version: session.identity?.version, state: result.state,
    outputOK: /(?:\r?\n|\x1b\[m)OK\r?\n/.test(raw), postlude: raw.includes(postlude),
    printablePrefix: capturedToken.length === 48 && raw.includes(`TB1:${capturedToken}:`),
    completion: result.state === 'ready' && result.success === true }));
  if (result.state !== 'ready' || result.success !== true || !raw.includes(postlude)) process.exitCode = 1;
} finally {
  manager.shutdown();
}
