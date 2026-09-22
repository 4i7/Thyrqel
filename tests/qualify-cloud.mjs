import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['tests/cloud-auth.mjs', '--live', ...process.argv.slice(2)], {
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let diagnostics = false;
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60000);
child.stdout.on('data', data => process.stdout.write(data));
child.stderr.on('data', data => { diagnostics = true; process.stderr.write(data); });
child.on('error', () => { clearTimeout(timer); diagnostics = true; process.exitCode = 1; });
child.on('close', code => {
  clearTimeout(timer);
  const pass = code === 0 && !diagnostics && !timedOut;
  console.log(`${pass ? 'PASS' : 'FAIL'} remote qualification: exit=${code}, stderr=${diagnostics}, timeout=${timedOut}`);
  process.exitCode = pass ? 0 : 1;
});
