import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const child = spawn(process.execPath, [fileURLToPath(new URL('./cp2-cp5-smoke.js', import.meta.url)), ...process.argv.slice(2)], {
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
});
let diagnostics = false;
let timedOut = false;
const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 90000);
child.stdout.on('data', data => process.stdout.write(data));
child.stderr.on('data', data => { diagnostics = true; process.stderr.write(data); });
child.on('error', error => { clearTimeout(timeout); console.error('FAIL CP-2..CP-5 smoke launch', error); process.exitCode = 1; });
child.on('close', code => {
  clearTimeout(timeout);
  const pass = code === 0 && !diagnostics && !timedOut;
  console.log(`${pass ? 'PASS' : 'FAIL'} CP-2..CP-5 qualification: child exit=${code}, stderr=${diagnostics}, timeout=${timedOut}`);
  process.exitCode = pass ? 0 : 1;
});
