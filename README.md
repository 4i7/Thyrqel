# Terminal Bridge — local terminal core

Windows-side TypeScript library for persistent PowerShell 7 and WSL2 Kali PTYs.
The local core now contains the CP-2 through CP-5 implementation surface:
tracked command steps, completion framing/detection, interactive writes, long-running
foreground commands, and multiple independent sessions.

Read [the CP-0 local contract](docs/CP0_CONTRACT.md),
[the CP-1 qualification report](docs/CP1_REPORT.md), and
[the CP-2..CP-5 report](docs/CP2_CP5_REPORT.md) before use.
CP-1 remains **BLOCKED** by the known node-pty/ConPTY cleanup `AttachConsole failed`
diagnostic; CP-2..CP-5 Windows qualification is therefore not claimed as PASS.

## Run

Use a non-Administrator PowerShell 7 on Windows 11, with Node.js 22+ and an
already provisioned WSL2 Kali user. No machine setup or distro changes are made.

```powershell
npm.cmd ci
Copy-Item profiles.example.json profiles.local.json
# Edit local paths and the explicit non-root Kali username.
npm.cmd test
npm.cmd run smoke
npm.cmd run smoke:cp2-cp5
```

`npm run smoke` retains the original CP-1 cleanup gate. `npm run smoke:cp2-cp5`
runs the CP-2..CP-5 functional qualification in a child process and also fails on
stderr, timeout, or nonzero child exit. Neither command suppresses native cleanup
diagnostics or forces a successful process exit.

## Embed

```typescript
import { ProfileRegistry, SessionManager } from './dist/src/main.js';

const manager = new SessionManager(new ProfileRegistry(operatorProfiles));
try {
  const session = await manager.open('wsl-kali');

  const result = await manager.step(session.sessionId, 'sleep 3; false', 100);
  // result.state === 'running': timeout ended the tool wait, not the command.

  console.log(manager.read(session.sessionId));
  manager.write(session.sessionId, { mode: 'key', key: 'CTRL_C' });

  manager.close(session.sessionId);
  manager.forget(session.sessionId);
} finally {
  manager.shutdown();
}
```

`step()` permits only one tracked command transaction per session. A second step
while one is active throws `SESSION_BUSY`. `write()` accepts legacy raw strings or
structured `{mode:'raw'|'line'|'key'}` input. Control keys are written to the PTY;
no Windows process-signal API is used.

`read()` preserves the CP-0 uppercase session lifecycle state and additionally
returns `stepState`, delayed `completion`, `truncated`, `dropped_bytes`, and the
camel-case `droppedBytes` alias. No AI-visible byte cursor or cloud delivery receipt
is implemented at this stage.

No Cloudflare, MCP, relay, listener, GUI terminal, WSL-side agent, privileged broker,
mutation sequencing, request hashing, or distributed dedup/fencing is implemented.
