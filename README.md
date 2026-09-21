# Thyrqel — persistent terminal MCP (local milestone)

Windows-side TypeScript library for persistent PowerShell 7 and WSL2 Kali PTYs.
See [the local contract](docs/CP0_CONTRACT.md) and [qualification report](docs/CP1_REPORT.md)
before use. See [the current implementation status](docs/REMOTE_IMPLEMENTATION.md)
for the local MCP milestone and the remaining Cloudflare work.

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
The local stdio MCP server is implemented; Cloudflare, a network listener, GUI
terminal, WSL-side agent and privileged broker are not. Child shells inherit the local environment; do not add device
credentials until a separate credential/environment contract is implemented.

## Local MCP

After `npm.cmd ci` and `npm.cmd run build`, configure your local MCP client to run
`node` with absolute arguments `dist/src/mcp/stdio.js` and `profiles.local.json`
inside this checkout. Resolve both arguments to absolute paths before adding
them to client configuration. `npm.cmd run mcp` is also available from this folder.

Tools: `terminal_open`, `terminal_list`, `terminal_input`, `terminal_read`,
`terminal_close`, `terminal_forget`. Input is raw PTY input; append `\r` to submit
a line. Poll output separately and send follow-up input into the same session.
`READY` is a session state, not a command-completion result. There is no
command-name denylist; OS permissions remain in effect.

Do not send passwords through model tool calls, which may be retained in client
history. Secure human input for remote sessions is not implemented yet.

`npm ci` applies the [version-checked ConPTY lifecycle patch](docs/PTY_PATCH.md).
Installing with `--ignore-scripts` does not produce a qualified runtime.
