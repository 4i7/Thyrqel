# Terminal Bridge — CP-0 / CP-1 local core

Windows-side TypeScript library for persistent PowerShell 7 and WSL2 Kali PTYs.
See [the local contract](docs/CP0_CONTRACT.md) and [qualification report](docs/CP1_REPORT.md)
before use. CP-1 qualification is not yet complete.

## Run

Use a non-Administrator PowerShell 7 on Windows 11, with Node.js 22+ and an
already provisioned WSL2 Kali user. No machine setup or distro changes are made.

```powershell
npm.cmd ci
Copy-Item profiles.example.json profiles.local.json
# Edit local paths and the explicit non-root Kali username.
npm.cmd test
npm.cmd run smoke
```

`profiles.local.json` is ignored, operator-owned configuration. It is not a remote
API. `npm run smoke -- path/to/profiles.json` selects another local configuration.
The smoke gate fails on child stderr, failed assertions, or failure to terminate
within 60 seconds. It never forces successful exit to hide retained handles.

## Embed

```typescript
import { ProfileRegistry, SessionManager } from './dist/src/main.js';
const manager = new SessionManager(new ProfileRegistry(operatorProfiles));
try {
  const session = await manager.open('windows-pwsh');
  manager.write(session.sessionId, "Write-Output 'hello'\r");
  // Read later as output arrives. A read is not a command-completion fence.
  console.log(manager.read(session.sessionId));
  manager.close(session.sessionId);
  manager.forget(session.sessionId);
} finally {
  manager.shutdown();
}
```

The example is an API shape, not a complete interactive client. Applications
must poll/read asynchronously and install their own shutdown handlers.
No Cloudflare, MCP, listener, GUI terminal, WSL-side agent or privileged broker
is implemented. Child shells inherit the local environment; do not add device
credentials until a separate credential/environment contract is implemented.
