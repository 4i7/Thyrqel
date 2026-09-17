import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const children = ['./cp2-cp5-smoke.js', './cp2-framing-regression-smoke.js'];
let diagnostics = false;
let timedOut = false;
let failed = false;

for (const relative of children) {
  const target = fileURLToPath(new URL(relative, import.meta.url));
  const child = spawn(process.execPath, [target, ...process.argv.slice(2)], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 90000);
  child.stdout.on('data', data => process.stdout.write(data));
  child.stderr.on('data', data => { diagnostics = true; process.stderr.write(data); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  }).catch(error => {
    console.error('FAIL CP-2..CP-5 smoke launch', error);
    diagnostics = true;
    return -1;
  });
  clearTimeout(timeout);
  if (code !== 0 || timedOut) {
    failed = true;
    break;
  }
}

const pass = !failed && !diagnostics && !timedOut;
console.log(`${pass ? 'PASS' : 'FAIL'} CP-2..CP-5 qualification: child exit=${failed ? 'nonzero' : 0}, stderr=${diagnostics}, timeout=${timedOut}`);
process.exitCode = pass ? 0 : 1;
