# CP-2 through CP-5 local terminal core report

Date: 2026-09-16 (Asia/Tokyo)

Design authority: `TerminalBridge_DESIGN_5505fab3.md`, SHA-256
`5505fab3930fcfc72c211b5358d4a4ac0ec1bb9d14644f740b11f9c55f041b82`.

The Windows qualification discovered that literal RS (`U+001E`) / US (`U+001F`) delimiters are not observable through the tested Windows 11 + node-pty 1.1.0 + ConPTY + PowerShell 7 presentation path even though the printable frame body is observable. See [CP-2 Windows framing escalation](CP2_WINDOWS_ESCALATION.md).

Review verdict: **LOCAL_CONTRACT_FIX**. The semantic design invariants remain unchanged; the CP-2-local completion grammar is corrected to use printable ASCII only.

## Implemented scope

- Profile-specific `BashCommandFramer` and `PowerShellCommandFramer`.
- Encoded user-command payloads; the contiguous high-entropy completion token is not present in PTY input echo.
- Bash persistent reserved control descriptor. It remains open for the shell lifetime, so completion framing still works after a payload executes `exec >/dev/null`.
- Bash status and cwd capture; `exit`/shell replacement is resolved by PTY exit rather than fabricated completion.
- Bash saves/restores its SIGINT trap around payload evaluation so foreground Ctrl+C
  returns status 130 through the normal postlude instead of abandoning ActiveStep.
- PowerShell transaction-local error observation and terminating-error catch.
- PowerShell native-exit provenance uses a transaction sentinel for `$LASTEXITCODE` and restores the previous value when no native command updates it.
- PowerShell payload execution is dot-sourced from a generated ScriptBlock so cwd, environment, variables and functions remain in the persistent shell scope.
- Incremental `CompletionDetector` on the unmodified `node-pty` character stream before `OutputRing`.
- Session-owned `ActiveStep`, one tracked step maximum, `SESSION_BUSY`, timeout without cancellation, delayed completion retention, and PTY-exit/close races.
- Existing `OutputRing` and session isolation behavior are unchanged.

## Completion frame

The CP-2 local grammar is:

```text
"TB1:" token ":" body_length_hex8 ":" body

body := base64(operation_id) ":" success ":" exit ":" base64(cwd)
success := "0" | "1"
exit := "N" | signed decimal integer
```

Properties:

- all framing bytes are printable ASCII;
- `token` is 48 lowercase hex characters generated from 24 random bytes;
- `body_length_hex8` is exactly eight hexadecimal digits and counts ASCII characters in `body`;
- there is no newline or terminal control-character delimiter;
- Bash and PowerShell emit the same wire grammar;
- the full `TB1:<token>:` marker is never present contiguously in input because the token literal is split in the generated wrapper;
- parser state is incremental across arbitrary chunk boundaries;
- matching malformed frames fail closed;
- parser retention is bounded to a 256 KiB body, with operation ID and cwd sub-bounds;
- candidate detection occurs before output projection or `OutputRing`.

The parser does not strip ANSI/VT sequences globally. Presentation data before or after a valid frame remains ordinary terminal output. A valid frame itself is emitted as a single printable-ASCII record and is not line-delimited.

## Tests

Unit/fake-PTY coverage includes:

- encoded framing and non-contiguous input token;
- Bash reserved descriptor;
- every character chunk split;
- printable marker-like ordinary output;
- malformed matching length and oversized body fail-closed behavior;
- long cwd within the parser bound;
- ANSI output surrounding a completion frame;
- incomplete matching-frame flush on PTY exit;
- timeout / `SESSION_BUSY` / delayed completion;
- interactive writes;
- multiple-session isolation;
- close / exit / late-completion ordering.

Target Windows smoke includes:

- real PowerShell success/error/native-exit matrix and persistent state;
- PowerShell ANSI output;
- real WSL Bash simple/false/multiline/quotes/heredoc/pipeline/redirection/compound/substitution;
- printable marker-like output;
- Bash ANSI output;
- `exec >/dev/null` followed by another tracked command;
- Python REPL / Ctrl+D / `SESSION_BUSY`;
- long-running foreground process / Ctrl+C;
- simultaneous Kali/Kali/PowerShell sessions.

## Qualification status

Windows requalification was executed on 2026-09-16 from the authorized starting
HEAD `f92f2547b7d504c173a2cc9bf652e9f5c7a8e679`, with the bounded fixes in this
checkpoint. Runtime: Windows 11 build 26200, Node 24.15.0, PowerShell 7.6.5,
node-pty 1.1.0, WSL2 Kali user aizel (uid 1000), interactive `/bin/bash`.

Commands executed:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run smoke
npm.cmd run smoke:cp2-cp5
node dist/tests/diagnose-completion.js
```

| Check | Actual result |
| --- | --- |
| `npm.cmd ci` | PASS, exact 1.1.0 dependency graph restored |
| `npm.cmd test` | PASS, 23/23 unit/fake tests and TypeScript build |
| `npm.cmd run smoke` | FAIL, all functional assertions pass, but cleanup stderr fails the strict parent |
| `npm.cmd run smoke:cp2-cp5` | FAIL, all CP-2..CP-5 functional assertions pass, child exit=0, stderr=true, timeout=false |
| `node dist/tests/diagnose-completion.js` | Completion control/PTY observations pass; command exits 0 but cleanup emits stderr, so not clean qualification |

The original CP-4 smoke lost output already returned by step; its polling helper
now includes that initial output. The actual Bash interrupt bug was then fixed:
SIGINT used to abort the whole evaluated input list, skipping completion. Real PTY
regressions now require exitCode=130, a successful following transaction, restoration
of the default trap and of an existing trap. The diagnostic now waits for its
post-cleanup witness rather than sampling immediately when completion arrives.

CP-1's external cleanup blocker was actively re-investigated using a standalone
dependency probe on Node 22 and 24 and an updated node-pty candidate. See
[the lifecycle evidence and escalation](CP2_WINDOWS_ESCALATION.md#current-status).
No failing qualification has been waived. The experimental dependency/DLL changes
were reverted; package.json, lockfile, and production launch options retain 1.1.0.

```text
CP-1 Local PTY: BLOCKED
CP-2 CommandFramer / Completion: PARTIAL (functional PASS; cleanup gate FAIL)
CP-3 Interactive: PARTIAL (functional PASS; cleanup gate FAIL)
CP-4 Long-running: PARTIAL (functional PASS; cleanup gate FAIL)
CP-5 Multiple Sessions: PARTIAL (functional PASS; cleanup gate FAIL)
CP-6 Relay: NOT STARTED
```

No Cloudflare Worker, MCP server, relay, credentials, delivery receipt, mutation sequencing, request hashing, distributed dedup, fencing, admin broker, GUI, or CP-6+ implementation is included.

PR #1 is not qualified for completion/merge. DESIGN_CHANGE_REQUIRED: NONE.
