# CP-1 Local PTY qualification report

This is a sanitized historical report. Machine-specific usernames, home directories,
absolute local paths, host build identifiers and other operator-environment details
have intentionally been removed because they are not required to understand the
qualification result.

Date: 2026-09-16. Historical status: **PARTIAL / BLOCKED**.

## Scope

The original CP-1 work implemented persistent local PowerShell and WSL2 PTYs,
readiness checks, bounded output storage, session lifecycle handling and real-host
qualification gates. Cloud relay and remote MCP behavior were outside this initial
checkpoint.

## What passed

- Reproducible dependency install and TypeScript build.
- Contract/unit tests for startup parsing, UTF-8 output handling, identity checks,
  failure cleanup and session lifecycle.
- Real PowerShell and WSL2 startup/readiness.
- Basic I/O and persistent working-directory behavior.
- Explicit close/double-close behavior.
- Natural shell exit at the application state-machine level.
- Unsupported/invalid profile and session failure paths.

## Historical blocker

The stable `node-pty` 1.1.0 Windows ConPTY cleanup path could emit an
`AttachConsole failed` diagnostic during close or natural shell exit. Application
state assertions passed, but the qualification gate correctly treated unexpected
native stderr as a failure.

The issue was traced to the timing of asynchronous console enumeration relative to
ConPTY teardown. A bundled-ConPTY experiment and an older stable dependency were
also evaluated and rejected as qualification candidates.

The later implementation introduced a narrowly scoped, version/hash-checked
install-time patch and additional lifecycle tests. Current qualification status is
maintained in [REMOTE_IMPLEMENTATION.md](REMOTE_IMPLEMENTATION.md) and
[PTY_PATCH.md](PTY_PATCH.md).

## Security and privacy note

Operator profile files remain local and ignored by Git. This public report does not
record concrete local usernames, home directories, absolute paths, account names,
log locations or host-specific identifiers.
