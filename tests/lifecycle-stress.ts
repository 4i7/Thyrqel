// Invoked by diagnose-lifecycle's strict parent, never as a unit-test substitute.
import assert from 'node:assert/strict';
import { spawn as spawnPty } from 'node-pty';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const useConptyDll = process.argv.includes('--dll');
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
};
async function settled(predicate: () => boolean, message: string) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(25); }
  assert.ok(predicate(), message);
}
function handles() {
  const result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command',
    `(Get-Process -Id ${process.pid}).HandleCount`], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const count = Number(result.stdout.trim());
  assert.ok(Number.isSafeInteger(count) && count > 0);
  return count;
}
const resources = () => process.getActiveResourcesInfo().filter(name => name === 'MessagePort' || name === 'PipeWrap').sort();
process.stdout.write('LIFECYCLE_STRESS_START\n');
void process.stderr.writable;
const baselineResources = resources();
let baselineHandles = 0;
const samples: number[] = [];
for (let cycle = 0; cycle < 15; cycle++) {
  const mode = cycle % 3;
  const childCode = "console.log('CHILD_PID:'+process.pid);setInterval(()=>{},1000)";
  const tailCode = "for(let i=0;i<3000;i++)console.log('TAIL_'+i.toString().padStart(4,'0')+'_END');process.exitCode=7";
  const pty = spawnPty(mode === 0 ? process.execPath : 'pwsh.exe', mode === 0 ? ['-e', tailCode] :
    ['-NoLogo', '-NoProfile', '-NoExit'], { cols: 240, rows: 40, useConpty: true, useConptyDll });
  let output = '';
  let started = false;
  let killed = false;
  let childPid: number | undefined;
  const shellPid = pty.pid;
  await new Promise<void>(resolve => {
    pty.onData(raw => {
      output += raw;
      if (mode !== 0 && !started && output.includes('PS ')) {
        started = true;
        if (mode === 1) pty.write('exit\r');
        else pty.write(`& '${process.execPath.replaceAll("'", "''")}' -e '${childCode.replaceAll("'", "''")}'\r`);
      }
      const match = output.match(/CHILD_PID:(\d+)/);
      if (mode === 2 && match && !killed) {
        childPid = Number(match[1]);
        killed = true;
        pty.kill();
        pty.kill();
      }
    });
    pty.onExit(event => {
      if (mode === 0) {
        assert.equal(event.exitCode, 7);
        for (let i = 0; i < 3000; i++) assert.ok(output.includes(`TAIL_${i.toString().padStart(4, '0')}_END`), `missing tail ${i}`);
      } else if (mode === 1) assert.equal(event.exitCode, 0);
      else assert.ok(childPid, 'attached process must start before close');
      // Cleanup after exit and duplicate close remain safe through the public API.
      pty.kill();
      resolve();
    });
  });
  await settled(() => !alive(shellPid) && (!childPid || !alive(childPid)), 'PTY shell/attached child still alive');
  await settled(() => JSON.stringify(resources()) === JSON.stringify(baselineResources), `worker/pipe resource retained: baseline=${baselineResources}, actual=${resources()}`);
  if (cycle === 2) baselineHandles = handles(); // warm native module, sockets, workers, and probe spawn
  if (cycle >= 5 && cycle % 3 === 2) samples.push(handles());
  console.log(JSON.stringify({ cycle, mode: ['tail-exit', 'shell-exit', 'attached-child-close'][mode], shellPid, childPid, status: 'PASS' }));
}
// No accumulating native handles. A small bounded fluctuation allows libuv's process-handle teardown.
assert.ok(samples.every(count => count <= baselineHandles + 4), `handle growth: baseline=${baselineHandles}, samples=${samples}`);
console.log(JSON.stringify({ status: 'PASS', baselineHandles, handleSamples: samples, resources: resources() }));
