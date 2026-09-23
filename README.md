# Thyrqel

Persistent Windows and WSL2 terminal control for ChatGPT through MCP.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://thyrqel.4i7.workers.dev/health)
[![MCP](https://img.shields.io/badge/MCP-remote%20terminal-5A67D8)](https://modelcontextprotocol.io/)
[![Windows 11](https://img.shields.io/badge/Windows-11-0078D4?logo=windows11&logoColor=white)](https://www.microsoft.com/windows/)
[![WSL2 Kali](https://img.shields.io/badge/WSL2-Kali-557C94?logo=kalilinux&logoColor=white)](https://www.kali.org/docs/wsl/)

Thyrqel keeps PowerShell 7 and WSL2 Kali PTYs on the operator's Windows machine while ChatGPT controls them through an authenticated Cloudflare-hosted MCP relay. Sessions are persistent across tool calls, so working directories, shell state, environment variables, interactive programs and follow-up input can remain alive while the model reasons over incremental output.

Production endpoint: [`https://thyrqel.4i7.workers.dev`](https://thyrqel.4i7.workers.dev)

## What it does

- Persistent `windows-pwsh` and `wsl-kali` terminal sessions.
- Interactive raw PTY input and incremental reads instead of one-shot command execution.
- ChatGPT-facing MCP tools for device status, operation submission and result retrieval.
- GitHub OAuth owner binding for the MCP client.
- Separate device credential for the Windows-side outbound WebSocket.
- Durable operation admission and replayable receipts to avoid accidental duplicate execution.
- Per-process epochs so requests from a previous device process are rejected after restart.
- Local hidden secret input for password-backed `sudo` without placing passwords in model tool arguments.
- Explicit shell environment allowlisting on the remote device path.

There is no WSL-side agent, inbound listener, privileged broker or command-name denylist. OS authorization remains authoritative.

## Architecture

```text
ChatGPT
   |
   | MCP + OAuth
   v
https://thyrqel.4i7.workers.dev/mcp
   |
   v
Cloudflare Worker
   |-- GitHub OAuth + owner binding
   |-- OAUTH_KV
   `-- Durable Object: Broker
            |
            | authenticated outbound WebSocket
            v
       Windows Thyrqel device
            |
            |-- operation journal
            |-- SessionManager
            `-- node-pty / ConPTY
                   |-- PowerShell 7
                   `-- WSL2 Kali / bash
```

The Windows device owns all real PTYs. Cloudflare brokers authenticated control traffic and durable operation state; terminal execution remains local to the paired Windows machine.

## Current remote tools

The production MCP surface intentionally exposes three tools:

| Tool | Purpose |
| --- | --- |
| `device_status` | Report whether the paired device is online and return its current process epoch. |
| `terminal_submit` | Admit one terminal lifecycle/input/read operation under a fresh UUID. |
| `terminal_result` | Retrieve the receipt for that exact operation without rerunning it. |

`terminal_submit` supports `open`, `list`, `input`, `read`, `close` and `forget`.

Submission is not command completion. After sending shell input, read the same session until the expected output or prompt is observed.

## Start the paired Windows device

On the paired Windows machine, use a visible, non-Administrator PowerShell 7 window with Node.js 22 or newer. The operator configuration and profiles remain under %LOCALAPPDATA%\Thyrqel\.

    $launcher = Invoke-RestMethod 'https://raw.githubusercontent.com/4i7/Thyrqel/main/scripts/start-device.ps1'
    & ([scriptblock]::Create($launcher))

The launcher downloads the latest GitHub-built Windows release, checks its published SHA-256 digest and commit metadata, runs the device from a temporary directory, and removes that runtime after the process exits. Keep the window open for terminal access and local hidden password input. A local Git checkout, npm ci, TypeScript build, and Wrangler are not needed for normal device startup.

If device_status reports online: false, check whether this visible device window is still running. Start it with the command above if it has stopped, then call device_status again. An offline result does not authorize resending an uncertain terminal operation.

## Developer setup from a checkout

Requirements:

- Windows 11
- PowerShell 7
- Node.js 22+
- WSL2 with an already provisioned Kali Linux user

Create the operator-owned local profile file:

```powershell
npm.cmd ci
Copy-Item profiles.example.json profiles.local.json
# Edit local paths and the explicit non-root Kali username.
npm.cmd test
npm.cmd run smoke
```

`profiles.local.json` is ignored by Git. No machine setup, distro provisioning, sudoers changes or account privilege changes are performed by Thyrqel.

`npm ci` applies the version-checked [ConPTY lifecycle patch](docs/PTY_PATCH.md). Installing with `--ignore-scripts` does not produce the qualified runtime.

## Typical ChatGPT flow

```text
1. device_status
2. open wsl-kali or windows-pwsh
3. input command text + carriage return
4. terminal_result for the submitted operation
5. read the session output
6. reason over the output
7. send follow-up input to the same session
8. close and forget the test session when finished
```

This persistent loop is suitable for interactive shell work where state must survive between reasoning steps, including controlled lab environments such as local development, debugging and authorized training systems.

## Local password input

Do not send passwords through model tool calls.

When a trusted program in a managed PTY is waiting for a password, use the visible device console locally:

```text
sessions
secret <sessionId>
```

If exactly one ready session matches a profile, the profile shortcut is available:

```text
secret wsl-kali
secret windows-pwsh
```

The value is entered locally with hidden input and bypasses MCP arguments and operation journals. Exact matching terminal echoes are redacted before entering the remote output ring. See [Cloudflare setup: local password input](docs/CLOUDFLARE_SETUP.md#local-password-input) for the full security boundary.

## Local stdio MCP

After `npm.cmd ci` and `npm.cmd run build`, a local MCP client can run:

```text
node <absolute-path>/dist/src/mcp/stdio.js <absolute-path>/profiles.local.json
```

or from this checkout:

```powershell
npm.cmd run mcp
```

The local stdio MCP exposes `terminal_open`, `terminal_list`, `terminal_input`, `terminal_read`, `terminal_close` and `terminal_forget`.

## Library API

```typescript
import { ProfileRegistry, SessionManager } from './dist/src/main.js';

const manager = new SessionManager(new ProfileRegistry(operatorProfiles));
try {
  const session = await manager.open('windows-pwsh');
  manager.write(session.sessionId, "Write-Output 'hello'\r");
  console.log(manager.read(session.sessionId));
  manager.close(session.sessionId);
  manager.forget(session.sessionId);
} finally {
  manager.shutdown();
}
```

Applications must read asynchronously and provide their own shutdown handling. `READY` is a session state, not a command-completion fence.

## Cloudflare relay

Production origin:

```text
https://thyrqel.4i7.workers.dev
```

Important routes:

```text
/mcp       ChatGPT MCP endpoint
/device    authenticated Windows-device WebSocket
/authorize OAuth authorization
/token     OAuth token exchange
/register  dynamic MCP client registration
/callback  GitHub OAuth callback
/health    public service health
```

Local Cloudflare qualification commands:

```powershell
npm.cmd run cloud:check
npm.cmd run cloud:test
npm.cmd run cloud:live
```

`cloud:test` runs the real Worker/DO/OAuth/MCP implementation with mocked GitHub and terminal peers. `cloud:live` connects the local relay implementation to configured real Windows and WSL PTYs while GitHub authentication remains mocked. Neither command deploys.

## Reliability model

Every device process has an epoch. Every submitted terminal operation has a caller-generated UUID.

- Durable admission is recorded before dispatch.
- The relay never automatically retries execution.
- Reusing the same operation ID with the same payload returns the existing admission.
- Reusing it with a different payload returns a conflict.
- A device restart changes epoch and retires prior operation state.
- `UNKNOWN_OUTCOME` requires reconciliation; it is not permission to resend an effect under a new ID.

See [Cloudflare setup](docs/CLOUDFLARE_SETUP.md) for capacity limits and protocol details.

## Qualification status

The current implementation has passed bounded production checks for:

- real ChatGPT -> public MCP -> Windows device control;
- persistent PowerShell and WSL2 Kali sessions;
- GitHub OAuth owner binding;
- password-authenticated Kali `sudo` through local hidden input;
- operation receipt replay and duplicate-operation suppression;
- controlled production WebSocket interruption and reconnect with session/receipt preservation;
- Windows/WSL foreground descendant cleanup and repeated exit/close races.

Automatic Windows logon startup and exhaustive recovery from arbitrary Cloudflare outages, OS sleep, network failures, detached-process schedules and PID reuse remain outside the qualified boundary.

## Documentation

- [Current remote implementation status](docs/REMOTE_IMPLEMENTATION.md)
- [Cloudflare deployment and operation](docs/CLOUDFLARE_SETUP.md)
- [PTY lifecycle patch](docs/PTY_PATCH.md)
- [Local contract](docs/CP0_CONTRACT.md)
- [Historical CP1 qualification report](docs/CP1_REPORT.md)
