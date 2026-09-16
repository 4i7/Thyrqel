# CP-2 through CP-5 local terminal core report

Subsequent Windows execution: see [CP-2 Windows framing escalation](CP2_WINDOWS_ESCALATION.md).
The historical NOT RUN statements below describe the original implementation run;
the subsequent run reproduced the first PowerShell failure and is BLOCKED pending
framing review. CP-2..CP-5 are not qualified.

Date: 2026-09-16 (Asia/Tokyo)

Design authority: `TerminalBridge_DESIGN_5505fab3.md`, SHA-256
`5505fab3930fcfc72c211b5358d4a4ac0ec1bb9d14644f740b11f9c55f041b82`.
The repository CP-0 local contract remains the narrower authority for already-shipped
CP-0/CP-1 behavior. This change fills its intentionally deferred CP-2 attachment seam
without changing the distributed CP-6+ design.

## Implemented scope

- Profile-specific `BashCommandFramer` and `PowerShellCommandFramer`.
- Encoded user-command payloads; the contiguous high-entropy completion token is not present in PTY input echo.
- Bash persistent reserved control descriptor. It remains open for the shell lifetime, so completion framing still works after a payload executes `exec >/dev/null`.
- Bash status and cwd capture; `exit`/shell replacement is resolved by PTY exit rather than fabricated completion.
- PowerShell transaction-local error observation and terminating-error catch.
- PowerShell native-exit provenance uses a transaction sentinel for `$LASTEXITCODE` and restores the previous value when no native command updates it. Stale values are not emitted as an exit code.
- PowerShell payload execution is dot-sourced from a generated ScriptBlock so cwd, environment, variables and functions remain in the persistent shell scope.
- Incremental `CompletionDetector` on the unmodified `node-pty` character stream, before `OutputRing`. It handles chunk splits, only buffers a possible marker-prefix, bounds a matching frame to 16 KiB, and fails closed on malformed matching frames.
- Session-owned `ActiveStep`, one tracked step maximum, `SESSION_BUSY`, synchronous wait timeout without cancellation, delayed completion retention, and PTY-exit/close races.
- `terminal_write`-equivalent structured modes: `raw`, `line`, and PTY key sequences for Ctrl+C, Ctrl+D, Enter, Tab, Esc, and arrows.
- Existing UTF-8-bounded `OutputRing` remains authoritative for output loss accounting. Existing `dropped_bytes` remains and `droppedBytes` is additionally exposed locally.
- CP-5 session isolation remains one `PtySession`/PTY/ring/detector/ActiveStep per session.

## Completion frame used by this local implementation

The CP-0 contract left completion grammar deferred. CP-2 concretizes the local frame as an ASCII control record on the node-pty character stream:

```text
RS "TB1:" token ":" base64(operation_id) ":" success ":" exit ":" base64(cwd) US
```

where `success` is `0|1` and `exit` is an integer or `N` for null. The detector is armed with the per-step token; marker-like ordinary output using another token is not consumed. This is a local CP-2 grammar only. No relay/delivery/mutation fields are implemented.

## Tests

### PASS — executed in the WebChatGPT execution sandbox

- TypeScript type-check of the changed/new CP-2..CP-5 source and tests, using the same strict compiler shape plus a local node-pty type stub because the sandbox is not the target Windows install.
- 12 fake-PTY/unit tests covering encoded framing, Bash reserved control descriptor, completion detection at every character split, marker-like normal output, malformed/oversized frame fail-closed behavior, running timeout, `SESSION_BUSY`, delayed success/failure, structured key encoding, independent sessions, Ctrl+C ordering, close ordering, PTY exit, and late-frame precedence.
- Direct Linux Bash execution of generated framing for heredoc plus two sequential steps across `exec >/dev/null`; all three completion frames were observed through the persistent reserved descriptor.

### NOT RUN — target Windows qualification

This WebChatGPT/GitHub session cannot execute the user's Windows 11 + ConPTY + WSL2 Kali host. Therefore the following are implemented as `tests/cp2-cp5-smoke.ts` but are not reported as executed:

- CP-2 real PowerShell success/error/native-exit matrix.
- CP-2 real WSL Bash simple, false, multiline, quotes, heredoc, pipeline, redirection, compound command, command substitution, marker-like output, `exec >/dev/null`.
- CP-3 Python REPL, `Ctrl+D`, and `SESSION_BUSY`.
- CP-4 long-running foreground process and PTY `Ctrl+C`.
- CP-5 simultaneous Kali A / Kali B / PowerShell C isolation.
- Real ConPTY lifecycle ordering and cleanup behavior.

Run on the operator Windows 11 host:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run smoke
npm.cmd run smoke:cp2-cp5
```

The last two commands remain capable of failing because stderr/native cleanup diagnostics are intentionally qualification failures.

## Known limitations

- No ANSI/plain-text projection was added; `read()` continues to expose raw terminal presentation text after completion frames are removed.
- No application delivery receipt, output cursor, replay protocol, mutation sequence, request hash, distributed dedup, connection generation, or Agent fencing exists.
- Completion-result retention is local in-memory state only; cloud acknowledgement and bounded-expiry semantics remain CP-6+ work.
- Same-shell code can intentionally damage reserved variables/descriptors or otherwise disrupt the protocol. Terminal Bridge is not a sandbox, per design authority.
- The exact behavior of generated PowerShell framing on the target pwsh 7.6.5/ConPTY stack remains NOT RUN until operator qualification.

## CP-1 blocker status

**CP-1 Local PTY: BLOCKED.** The existing `node-pty 1.1.0` / Windows ConPTY cleanup qualification reported `AttachConsole failed`. This change does not suppress stderr, force process success, weaken the qualification gate, patch dependency source, or reclassify CP-1 as PASS. The existing cleanup path remains in place so the blocker stays observable.

## Status

```text
CP-1 Local PTY: BLOCKED
CP-2 CommandFramer / Completion: PARTIAL
CP-3 Interactive: PARTIAL
CP-4 Long-running: PARTIAL
CP-5 Multiple Sessions: PARTIAL
CP-6 Relay: NOT STARTED
```

`PARTIAL` means implementation plus fake/unit coverage exists, but target Windows qualification is NOT RUN in this session.

## CP-6 readiness

The local API now has a usable attachment surface for future relay work, but CP-6 is not started. No Cloudflare Worker, Durable Object, WebSocket relay, MCP server, credential, delivery receipt, mutation sequencing, request hashing, dedup, or fencing was added.

## Design deviations

**NONE.** The local completion grammar concretizes a CP-0-deferred detail while preserving the design invariants. No change to `TerminalBridge_DESIGN_5505fab3.md` is required by this implementation. If target Windows qualification reveals semantics that cannot be satisfied without changing those invariants, record `DESIGN_CHANGE_REQUIRED` before altering the design authority.
