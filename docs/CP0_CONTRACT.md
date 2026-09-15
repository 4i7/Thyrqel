# CP-0: local PTY contract

Authority: user request accompanying `TerminalBridge_DESIGN_5505fab3.md`.
The request narrows the design's CP-0/CP-1 explicitly. Completion grammar,
transactions, delivery acknowledgements, cloud and fencing remain deferred.
The existing architecture review discusses an older design and is not modified.

## Operator configuration

`ProfileRegistry` copies and freezes trusted local configuration. `open(profileId)`
accepts only a registered ID, never executable/argv/user/directory overrides.
PowerShell runs `-NoLogo -NoProfile -NoExit`; WSL runs the explicitly configured
distribution, non-root user, directory and `/bin/bash -i`. No distro defaults
are used to choose user or shell. WSL startup files still run.
The host must be non-elevated Windows 11. This library is not a sandbox.
Only Windows 11 with an operator-provisioned WSL2 Kali distribution is qualified.

## Startup readiness

Before publication, a one-time shell-specific probe produces
`TBREADY:<48 lowercase hex nonce>:<base64 UTF-8 payload>:END`.
The random nonce is sent as two separate literals and assembled by the shell;
the contiguous expected frame is absent from input echo.
The incremental parser receives raw node-pty strings, retains at most 16 KiB of
frame data, and times out after 15 seconds. This is startup identification,
not a command-completion protocol or a defense against hostile shell startup code.

PowerShell payload is JSON: shell=powershell, edition=Core, version=7.x, cwd.
WSL payload is newline-separated uid, username, executable resolved through
`/proc/$$/exe`, argv0, shell flags, cwd, and resolved configured initial directory.
Check configured username, numeric nonzero uid, Bash executable, `/bin/bash`
argv0, interactive flag, and matching cwd. `~` resolves using that user's HOME.
Paths containing newlines are unsupported by this startup grammar.
The probe needs Kali's `/usr/bin/{id,readlink,realpath,base64}`.

No readiness frame, spawn failure, timeout or early exit:
`PROFILE_START_FAILED`. Wrong identity: `PROFILE_IDENTITY_MISMATCH`.
Failed opens reject, attempt owned PTY cleanup and remove their private entry.

## State and API

`CREATING -> READY | FAILED | CLOSED`; `READY -> EXITED | CLOSED | FAILED`;
`EXITED -> CLOSED`; repeated close returns CLOSED. Close commits its state before
native cleanup so synchronous exit cannot override it. A cleanup exception is
explicitly FAILED. JavaScript callbacks are synchronous state transitions;
there is no asynchronous mutation within one event callback.

Sessions retain ID (manager epoch + random UUID), profile, PTY, state, identity,
output ring, creation/activity timestamps and exit code when observed.
`open` resolves with state `ready`; read/close expose internal uppercase states.
`write` requires READY and guarantees only input submission, not execution success.
`read` drains raw terminal text, including ANSI, startup output and input echo.
It returns `truncated` and UTF-8 `dropped_bytes`. No completion or receipt guarantee.
Explicit close discards remaining output; read first if it is needed.

The default output capacity is 1 MiB, with eviction at UTF-8 code point boundaries.
Default registry capacity is four entries, including terminal records. After
reading/closing, the embedding operator can `forget` a terminal record to reclaim
its slot. Double-close remains idempotent until forget; subsequent access is
INVALID_SESSION. `shutdown` closes all sessions and prevents new opens, including
pending opens. Embedders must invoke it in their own shutdown/finally handler.

Other errors: INVALID_PROFILE, INVALID_SESSION, SESSION_NOT_READY,
SESSION_LIMIT, SESSION_IO_FAILED, UNSUPPORTED_HOST.
Close does not terminate the WSL distro or promise cleanup of detached processes.

## CP-2 attachment boundary

CommandFramer and CompletionDetector are interfaces only. The detector attachment
point receives unmodified onData before output storage. No terminal_step,
ActiveStep implementation, key codec, plain-text projection, native exit status
provenance, busy handling or command replay logic is claimed.
