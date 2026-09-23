# Remote terminal implementation status

This document records the current public qualification boundary without publishing
operator-specific usernames, home directories, absolute local paths, account IDs or
other machine-specific identifiers.

## Confirmed target

ChatGPT controls the operator's Windows PowerShell and WSL2 Kali terminal through a
Cloudflare-hosted MCP endpoint. Interactive programs retain their PTY across calls.
OS authorization remains authoritative. Thyrqel does not modify sudoers, passwords,
account privileges or host security settings.

## Implemented

- Local stdio MCP with six terminal lifecycle tools.
- Remote MCP exposing `device_status`, `terminal_submit` and `terminal_result`.
- Persistent PowerShell and WSL2 PTYs on the Windows device.
- Outbound authenticated device WebSocket; no inbound host listener.
- GitHub OAuth owner binding for the ChatGPT-facing MCP client.
- Separate random device credential; only its SHA-256 digest is stored by the Worker.
- Durable operation admission and replayable receipts with duplicate suppression.
- Per-process epochs so operations from a previous device process are rejected.
- Bounded relay/device journals and explicit `UNKNOWN_OUTCOME` handling.
- Explicit shell-environment allowlisting for remotely created shells.
- Local hidden secret input with exact terminal-echo redaction.
- Version/hash-checked `node-pty` ConPTY lifecycle patch.

## Qualification evidence

The implementation has passed bounded checks covering:

- clean install, TypeScript build and automated test suites;
- Worker type/build checks and local Worker/DO/OAuth/MCP/WebSocket integration;
- real PowerShell and WSL2 startup, persistent state and interactive follow-up I/O;
- foreground descendant cleanup and repeated exit/close races;
- public ChatGPT -> OAuth -> MCP -> Windows device round trips;
- owner-only OAuth authorization and rejection of unauthenticated MCP/device access;
- password-authenticated WSL `sudo` using local hidden input without putting the
  password in MCP arguments or returned terminal output;
- operation receipt replay and duplicate-operation suppression;
- controlled production WebSocket interruption followed by reconnect while retaining
  the device process epoch, an existing PTY session and an admitted receipt;
- GitHub-built Windows device packaging and production Worker deployment after the
  same qualification job succeeds.

The historical CP-1 report records an earlier ConPTY cleanup failure. The current
patch and lifecycle gate supersede that historical blocker; see [PTY_PATCH.md](PTY_PATCH.md).

## Reliability model

Every device process has a new epoch and every submitted terminal operation has a
caller-generated UUID.

- Admission is stored before dispatch.
- Execution is never automatically retried.
- Reusing an operation ID with the same payload returns the existing admission.
- Reusing it with a different payload is rejected.
- A device restart changes epoch and retires prior operation state.
- A transport failure can produce `UNKNOWN_OUTCOME`; the operator must reconcile
  state rather than resubmitting the effect under a fresh ID.

## Security boundary

The Windows device reads its credential and operator profiles from local
configuration outside the source checkout. Child shells receive an allowlisted
subset of the device process environment rather than provider/device credentials.

Passwords should not be sent through model tool arguments. The local device console
supports hidden one-line input into a selected PTY; exact echoes are redacted before
entering the remotely readable output ring. This does not protect against a program
that transforms or deliberately exfiltrates a secret, arbitrary code running as the
same OS user, memory inspection or other host compromise.

## Operational limits

The following remain outside the qualified boundary:

- automatic Windows logon startup;
- exhaustive recovery from arbitrary Cloudflare outages, OS sleep and network
  failures;
- every detached-process topology and PID-reuse schedule;
- automatic resolution of `UNKNOWN_OUTCOME` operations.

The direct device runs only while its visible interactive PowerShell process remains
alive. Current startup, deployment and local-secret procedures are documented in
[CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md).
