# Cloudflare deployment and operation

Status: deployed at `https://thyrqel.4i7.workers.dev`.

This public document intentionally omits operator-specific account identifiers,
local usernames, home directories and absolute machine paths that are not required
for deployment or operation. Secrets remain provisioned only in Cloudflare and local
operator configuration; they are not committed.

## Architecture

ChatGPT uses `/mcp` with an OAuth token issued by Thyrqel. Authorization includes an
explicit client/redirect consent screen, S256 PKCE and binding to the configured
GitHub owner identity. GitHub access tokens are used only for identity lookup and are
discarded; they are not embedded in MCP tokens. OAuth grant/token state lives in the
provider KV binding. One-time consent state is consumed atomically in the Durable
Object. Authentication routes have request-size and per-IP rate limits.

The Windows device opens `/device` with a separate random bearer credential. The
Worker stores only that credential's SHA-256 digest. The device reads the credential
from local configuration and never receives it through MCP tool arguments.

The Durable Object records an operation digest before sending its frame and never
automatically retries execution. Repeated IDs return the existing admission;
different payloads conflict. The device keeps a second no-resend journal and can
retransmit unacknowledged results. A restarted device process receives a new epoch,
so old requests cannot be admitted as new work.

Each epoch retains bounded operation state. Expired results retain a tombstone.
`UNKNOWN_OUTCOME` does not imply failure and never authorizes automatic resend.

## Production configuration

The checked-in Worker configuration contains only values that are required to bind
the deployment, such as the public origin, OAuth client identifier, configured owner
identifier and Cloudflare resource bindings. The following sensitive values must
remain outside Git:

- `GITHUB_CLIENT_SECRET`
- `DEVICE_TOKEN_SHA256`
- the original local device credential
- local operator profile/configuration files

Do not recreate production OAuth/KV/Durable Object resources during ordinary source
updates unless intentionally migrating them.

## Start the local device

The normal launcher downloads the latest qualified GitHub-built Windows runtime,
verifies its published SHA-256 digest and commit metadata, starts it outside the
source checkout, then removes the temporary runtime when it exits:

```powershell
$launcher = Invoke-RestMethod 'https://raw.githubusercontent.com/4i7/Thyrqel/main/scripts/start-device.ps1'
& ([scriptblock]::Create($launcher))
```

The local device configuration is stored under `%LOCALAPPDATA%\Thyrqel\` and is not
part of the repository. Its logical shape is:

```json
{
  "endpoint": "https://<worker-origin>",
  "token": "<random-device-credential>",
  "profilesFile": "<operator-profile-file>"
}
```

The device starts no inbound listener. Ctrl+C shuts down its sessions. It retries
transport connections only; credential rejection and protocol mismatch stop it.
Keep the visible interactive PowerShell window open when local hidden password input
is needed.

## Recover from device HTTP 401

An HTTP 401 at device startup can mean the local device credential and Worker digest
no longer match. An authenticated Cloudflare account owner can recompute the digest
without printing the token:

```powershell
$deviceConfig = Get-Content (Join-Path $env:LOCALAPPDATA 'Thyrqel/device.json') -Raw | ConvertFrom-Json
if ($deviceConfig.endpoint -ne 'https://thyrqel.4i7.workers.dev') { throw 'Unexpected endpoint' }
$deviceDigest = [Convert]::ToHexString(
  [Security.Cryptography.SHA256]::HashData(
    [Text.Encoding]::UTF8.GetBytes($deviceConfig.token)
  )
).ToLowerInvariant()
$deviceDigest | npx.cmd wrangler@4.136.1 secret put DEVICE_TOKEN_SHA256 --config cloudflare/wrangler.jsonc
```

Restart the device after a successful update. Never paste the original device token
into chat, an issue, a commit, a command argument or documentation. Reconcile any
uncertain operation result before submitting another effect.

## MCP operation model

The production tools are `device_status`, `terminal_submit` and `terminal_result`.
`terminal_submit` supports `open`, `list`, `input`, `read`, `close` and `forget`.

Obtain the current epoch first, generate a unique operation UUID, submit once, then
retrieve the result using the same epoch and UUID. A submission receipt is not shell
command completion. Do not create a fresh operation ID to retry an uncertain effect.

## Qualification boundary

Bounded qualification has passed for:

- local Worker/DO/OAuth/MCP/WebSocket integration;
- OAuth consent/callback replay and wrong-identity rejection;
- real PowerShell and WSL2 PTY operation;
- local hidden secret input and exact echo redaction;
- public GitHub OAuth and ChatGPT MCP transport;
- foreground process-tree lifecycle checks;
- controlled production relay disconnect/reconnect with session and receipt
  preservation;
- GitHub-built Windows runtime packaging and qualified production deployment.

These checks do not prove recovery from every network/platform failure, OS sleep,
detached-process topology or PID-reuse schedule.

## Local password input

Run the device in an interactive local terminal. Use `sessions` to identify the
session, then `secret <sessionId>`. If exactly one ready session matches a profile,
the profile name may be used as a shortcut.

Verify that the intended trusted program is waiting for a password before typing.
Input is hidden, Enter sends one line and Ctrl+C stops the device without submitting
unfinished input. The local console has no command history.

This path bypasses MCP arguments and operation journals. Exact matches are redacted
before entering the PTY output ring, including matches split across chunks. This
cannot protect against transformed/deliberately exfiltrated output, arbitrary code
running as the same OS user, memory inspection or other host compromise.
