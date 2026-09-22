import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import * as nodePty from 'node-pty';
import { SessionManager, ProfileRegistry } from '../dist/src/main.js';
const profiles = JSON.parse(readFileSync(process.argv[2] ?? 'profiles.local.json', 'utf8'));
let latestPid = 0;
const manager = new SessionManager(new ProfileRegistry(profiles), {
    spawn(file, args, options) {
        const pty = nodePty.spawn(file, args, options);
        latestPid = pty.pid;
        return pty;
    },
});
async function until(predicate, message, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (predicate())
            return;
        await delay(40);
    }
    assert.fail(message);
}
function windowsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        if (error.code === 'ESRCH')
            return false;
        throw error;
    }
}
function descendantAlive(profile, pid) {
    if (profile.platform === 'windows')
        return windowsAlive(pid);
    try {
        execFileSync(`${process.env.SystemRoot}\\System32\\wsl.exe`, ['-d', profile.distro, '--user', profile.user,
            '--exec', '/bin/kill', '-0', String(pid)], { stdio: 'ignore', windowsHide: true, timeout: 3000 });
        return true;
    }
    catch (error) {
        // Only the OS probe's explicit not-alive exit is accepted, never a launch failure.
        if (error.status === 1)
            return false;
        throw error;
    }
}
try {
    for (const profile of profiles) {
        const session = await manager.open(profile.id);
        manager.read(session.sessionId);
        const quotedNode = process.execPath.replaceAll("'", "''");
        // Children expire themselves even if the qualification detects failed cleanup.
        manager.write(session.sessionId, profile.platform === 'windows'
            ? `& '${quotedNode}' -e "console.log('TB_CHILD_'+'PID:'+process.pid);setTimeout(()=>{},15000)"\r`
            : `/bin/bash -c 'printf "%s%s:%s\\n" "TB_CHILD_" "PID" "$$"; exec /bin/sleep 15'\r`);
        let observed = '';
        let childPid = 0;
        await until(() => {
            const result = manager.read(session.sessionId);
            assert.equal(result.truncated, false);
            observed += stripVTControlCharacters(result.output);
            childPid = Number(/TB_CHILD_PID:(\d+)/.exec(observed)?.[1] ?? 0);
            return childPid > 0;
        }, `${profile.id}: missing child identity`);
        assert.equal(descendantAlive(profile, childPid), true);
        manager.close(session.sessionId);
        manager.close(session.sessionId);
        await until(() => !descendantAlive(profile, childPid), `${profile.id}: descendant survived close`);
        manager.forget(session.sessionId);
        console.log(`PASS ${profile.id}: foreground descendant terminated after double close`);
        for (let cycle = 0; cycle < 3; cycle++) {
            const racing = await manager.open(profile.id);
            manager.write(racing.sessionId, 'exit\r');
            manager.close(racing.sessionId);
            manager.forget(racing.sessionId);
            await delay(150);
        }
        console.log(`PASS ${profile.id}: 3 immediate exit/close races`);
        const external = await manager.open(profile.id);
        const ownedPid = latestPid;
        assert.ok(ownedPid > 0 && windowsAlive(ownedPid));
        process.kill(ownedPid); // exact process returned by this test's own spawn
        await until(() => manager.read(external.sessionId).state === 'EXITED', `${profile.id}: external exit not observed`);
        manager.close(external.sessionId);
        manager.forget(external.sessionId);
        console.log(`PASS ${profile.id}: externally terminated owned host process`);
    }
}
finally {
    manager.shutdown();
}
