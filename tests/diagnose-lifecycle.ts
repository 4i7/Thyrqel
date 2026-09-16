// Standalone dependency probe: no Terminal Bridge lifecycle code participates.
// A clean Node exit is required in addition to the PTY exit event.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const version = (require('node-pty/package.json') as { version: string }).version;

for (const useConptyDll of [false, true]) {
  for (const mode of ['close', 'exit', 'exit-cleanup']) {
    const code = `
      const p = require('node-pty').spawn('pwsh.exe', ['-NoLogo','-NoProfile','-NoExit'],
        {cols:240,rows:40,useConpty:true,useConptyDll:${useConptyDll}});
      let started = false;
      p.onData(raw => {
        if (!started && raw.includes('PS ')) {
          started = true;
          ${mode === 'close' ? 'p.kill();' : "p.write('exit\\r');"}
        }
      });
      p.onExit(event => {
        console.log('PTY_EXIT', event.exitCode);
        ${mode === 'exit-cleanup' ? 'p.kill();' : ''}
      });
    `;
    const result = spawnSync(process.execPath, ['-e', code], {
      encoding: 'utf8', windowsHide: true, timeout: 12000
    });
    const pass = result.status === 0 && !result.error && !result.stderr && result.stdout.includes('PTY_EXIT');
    console.log(JSON.stringify({ node: process.version, nodePty: version, useConptyDll, mode,
      status: pass ? 'PASS' : 'FAIL', childExit: result.status, error: result.error?.message,
      stdout: result.stdout.trim(), stderr: Boolean(result.stderr) }));
    if (result.stderr) process.stderr.write(result.stderr);
    if (!pass) process.exitCode = 1;
  }
}
