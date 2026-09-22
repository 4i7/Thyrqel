import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Qualification includes clean Agent termination, not just assertions inside it.
// Timeout/stderr fail the gate; never use process.exit() inside smoke to hide handles.
const lifecycle = process.argv.includes('--lifecycle');
const child = spawn(process.execPath, [fileURLToPath(new URL(lifecycle ? '../../tests/lifecycle.mjs' : './smoke.js', import.meta.url)),
  ...process.argv.slice(2).filter(argument => argument !== '--lifecycle')], {
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
});
let diagnostics = false;
let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  child.kill();
}, 60000);
child.stdout.on('data', data => process.stdout.write(data));
child.stderr.on('data', data => { diagnostics = true; process.stderr.write(data); });
child.on('error', error => {
  clearTimeout(timeout);
  console.error('FAIL smoke launch', error);
  process.exitCode = 1;
});
child.on('close', code => {
  clearTimeout(timeout);
  const pass = code === 0 && !diagnostics && !timedOut;
  console.log(`${pass ? 'PASS' : 'FAIL'} qualification: child exit=${code}, stderr=${diagnostics}, timeout=${timedOut}`);
  process.exitCode = pass ? 0 : 1;
});
