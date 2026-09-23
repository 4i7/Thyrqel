# Cloudflare deployment and operation

Status: deployed at `https://thyrqel.4i7.workers.dev`. The checked-in Worker configuration contains the production public origin, GitHub OAuth client ID and OAUTH_KV binding. Secrets remain provisioned only in Cloudflare and are not committed. The ChatGPT client flow passed a public MCP status and Kali command test. A controlled WebSocket interruption through a loopback proxy to the production Worker preserved the device epoch, receipt and PowerShell session after reconnect.

The authenticated account lookup on 2026-09-22 returned account `4i7`
(`<cloudflare-account-id>`) and Workers subdomain `4i7`.
The production origin is `https://thyrqel.4i7.workers.dev`, with GitHub OAuth callback `https://thyrqel.4i7.workers.dev/callback`. The `thyrqel` Worker, `OAUTH_KV` binding, public vars and required Worker secrets have been provisioned. Re-deploying from the repository does not require re-registering the GitHub OAuth App or recreating Cloudflare resources.

## Architecture

ChatGPT uses `/mcp` with an OAuth token issued by Thyrqel. Authorization includes
an explicit client/redirect consent screen, S256 PKCE and a fixed numeric GitHub
account ID. GitHub access tokens are used only to read identity, then discarded;
they are not embedded in MCP tokens. OAuth grant/token state lives in the
provider's KV binding. One-time consent state is consumed atomically in the
Durable Object. Authentication routes have request-size and per-IP rate limits.

The Windows device opens `/device` with a separate random bearer credential.
The Worker stores only that credential's SHA-256. The device reads its credential
from local configuration, never from tool arguments, and passes an allowlisted
environment to child shells. This is not isolation from arbitrary code running
as the same operating-system user, which may access that user's files.

The Durable Object persists an operation digest before sending its frame. It
never retries execution. Repeated IDs return the existing admission; different
payloads conflict. The device maintains a second no-resend journal and can
retransmit unacknowledged results. Results from late-finishing operations follow
the current connection. A restarted process changes epoch, so old requests
cannot be admitted as new work. An epoch transition and old-record retirement
are committed in one storage transaction.

Each epoch retains at most 4,096 operation records, 16 outstanding operations
and the last 32 completed relay results. Expired results retain a tombstone.
The device result cache is separately bounded. Reads return up to 8 KiB without
discarding unread bytes; the underlying ring still reports overflow explicitly.
`UNKNOWN_OUTCOME` does not imply failure and never authorizes automatic resend.
An epoch change, capacity exhaustion or expired receipt requires operator
reconciliation. Automated retirement of uncertain work is not implemented.

## Existing production configuration

The production Worker already has its origin, `OAUTH_KV` namespace, GitHub OAuth App client ID, owner GitHub ID, GitHub client secret, and device-token digest configured. Preserve these resources and secrets across deployments; do not recreate them as part of ordinary code updates. Complete the remaining runtime/secret-input and ChatGPT end-to-end checks against the existing deployment.

The local device command is `npm.cmd run device`. By default it reads
`%LOCALAPPDATA%/Thyrqel/device.json`, outside this OneDrive checkout. A different
configuration path can be passed as the command's argument. Configuration shape:

```json
{
  "endpoint": "https://<actual-worker-origin>",
  "token": "<random-device-credential>",
  "profilesFile": "<absolute-path-to-operator-profiles>"
}
```

The device starts no inbound listener. Ctrl+C shuts down its sessions. It retries
transport connections only; credential rejection and protocol mismatch stop it.
Keep the interactive PowerShell window open for local password entry. If it
returns to `PS ...>`, the device has stopped; read its
`Thyrqel device stopping:` line before restarting.

If startup reports HTTP 401, the local token and the Worker digest may differ.
From the repository directory, an authenticated Cloudflare account owner can
recompute and upload the digest without printing the token:

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

Restart the device after a successful update. Do not paste its token into a
chat, issue, or shell argument. A Worker secret change may interrupt a live
device connection; reconcile uncertain operation results before submitting
another action.

The MCP tools are `device_status`, `terminal_submit`, and `terminal_result`.
Submit accepts `open`, `list`, `input`, `read`, `close`, and `forget`. Its receipt
is not shell-command completion. Supply a unique UUID and current device epoch,
then retrieve the result using that same identity. Do not generate a new ID to
retry an uncertain action.

## Qualification boundaries

- Local Workers + actual OAuth library, DO storage, MCP and WebSockets: PASS.
- Consent/callback replay, code replay/token invalidation, wrong identity,
  request conflict, stored result replay and DO eviction/recovery: PASS in tests.
- Node WebSocket reconnect with result replay and late result completion: PASS.
- Local relay to real PowerShell/WSL PTYs, interactive follow-up and cleanup:
  PASS with child exit 0, no stderr and no timeout; GitHub is mocked.
- The noninteractive `--sudo` check observed exit 1 with `sudo: a password is
  required`. Password-authenticated sudo through the public MCP WSL session and
  local hidden-input console returned UID 0 and exit status 0. No sudo policy or
  password was changed.
- Local hidden input and exact echo redaction: unit tests PASS; synthetic local
  secrets through real PowerShell/WSL PTYs and remote result retrieval PASS.
  Native console password input and result retrieval were also verified.
- Real GitHub OAuth and public Cloudflare MCP transport: PASS. ChatGPT called
  `device_status`, then opened a Kali session, read `pwd` as `/home/<local-user>`,
  closed and forgot that test session through the owner-only OAuth connection.
- Foreground-descendant and concurrent-exit PTY lifecycle gate: PASS on real
  PowerShell and WSL profiles. Detached-process and PID-reuse schedules remain
  outside this finite test.
- Controlled production relay reconnect: PASS with a temporary loopback
  WebSocket proxy. The device disconnected and reconnected without changing
  process epoch; the existing PowerShell session and receipt remained usable.
  This does not prove every arbitrary network or platform failure.

The OAuth flow follows the official Cloudflare GitHub OAuth example, with
owner binding, atomic consent consumption and no upstream-token retention:
https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-github-oauth

## Local password input

Run the device in an interactive local terminal. Use `sessions` to identify the
session, then `secret <sessionId>`. If only one ready session has a profile,
`secret wsl-kali` or `secret windows-pwsh` selects it without copying its long
ID. If several sessions share a profile, use the exact ID shown by `sessions`.
After restarting the device, old session IDs no longer exist. Verify that the
intended trusted program is waiting for its password before typing. Input is
hidden, Enter sends one line, and Ctrl+C stops the device without submitting
the unfinished value. The console
has no command history. Redirected stdin does not enable this console.

This path bypasses MCP arguments and operation journals. Exact matches are
redacted before entering the PTY output ring, including matches split across
chunks. A possible incomplete match is withheld until it can be resolved; at
session termination it is replaced with `[REDACTED]`. Each session retains up to
eight distinct values of 1–1024 characters without control characters. Redaction
can also hide ordinary output matching those values and delay a matching suffix.

The receiving program still obtains the secret. Transformed or deliberately
exfiltrated output, arbitrary code running as the same OS user, and memory dumps
are outside this protection. JavaScript strings cannot be reliably zeroed from
memory. Do not enter a password into an untrusted program or a shell command
prompt, and do not paste multiline content. No OS privilege or sudo policy is
changed by this feature.
