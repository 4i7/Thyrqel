// Standalone dependency probe: no Terminal Bridge lifecycle code participates.
// A clean Node exit is required in addition to the PTY exit event.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const version = (require('node-pty/package.json') as { version: string }).version;

for (const useConptyDll of [false, true]) {
  for (const mode of ['close', 'exit', 'exit-cleanup', 'flood-close']) {
    const code = `
      const p = require('node-pty').spawn(${mode === 'flood-close' ?
        `process.execPath, ['-e', "process.stdout.write('F'.repeat(2*1024*1024));setInterval(()=>{},1000)"]` :
        `'pwsh.exe', ['-NoLogo','-NoProfile','-NoExit']`},
        {cols:240,rows:40,useConpty:true,useConptyDll:${useConptyDll}});
      let started = false;
      p.onData(raw => {
        if (!started && ${mode === 'flood-close' ? 'raw.length > 0' : "raw.includes('PS ')"}) {
          started = true;
          ${mode === 'close' || mode === 'flood-close' ? 'p.kill();' : "p.write('exit\\r');"}
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
  const repeated = spawnSync(process.execPath, [fileURLToPath(new URL('./lifecycle-stress.js', import.meta.url)),
    ...(useConptyDll ? ['--dll'] : [])], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  const pass = repeated.status === 0 && !repeated.error && !repeated.stderr && repeated.stdout.includes('handleSamples');
  console.log(JSON.stringify({ useConptyDll, mode: 'repeated-lifecycle', status: pass ? 'PASS' : 'FAIL',
    childExit: repeated.status, error: repeated.error?.message, stderr: Boolean(repeated.stderr) }));
  process.stdout.write(repeated.stdout);
  if (repeated.stderr) process.stderr.write(repeated.stderr);
  if (!pass) process.exitCode = 1;
}
