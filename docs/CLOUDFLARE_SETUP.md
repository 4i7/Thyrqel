# Cloudflare deployment and operation

Status: deployed at `https://thyrqel.4i7.workers.dev`. The checked-in Worker configuration contains the production public origin, GitHub OAuth client ID and OAUTH_KV binding. Secrets remain provisioned only in Cloudflare and are not committed. The final ChatGPT callback/device end-to-end path is still under qualification.

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
- Real sudo authentication: NOT QUALIFIED. The `--sudo` check observed exit 1
  with `sudo: a password is required`; no sudo policy or password was changed.
- Local hidden input and exact echo redaction: unit tests PASS; synthetic local
  secrets through real PowerShell/WSL PTYs and remote result retrieval PASS.
  Actual password-authenticated sudo and native console manual use remain unverified.
- Real GitHub OAuth App, public Cloudflare endpoint, ChatGPT connection, and
  descendant/concurrent-exit PTY qualification: not complete.

The OAuth flow follows the official Cloudflare GitHub OAuth example, with
owner binding, atomic consent consumption and no upstream-token retention:
https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-github-oauth

## Local password input

Run the device in an interactive local terminal. Use `sessions` to identify the
session, then `secret <sessionId>`. Verify that the intended trusted program is
waiting for its password before typing. Input is hidden, Enter sends one line,
and Ctrl+C stops the device without submitting the unfinished value. The console
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
