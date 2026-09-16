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

The printable framing correction is implemented on PR #1 but **target Windows requalification is still required**. Do not infer PASS from the code change alone.

Run on the operator Windows 11 host:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run smoke
npm.cmd run smoke:cp2-cp5
node dist/tests/diagnose-completion.js
```

CP-1 remains independently blocked by the existing node-pty/ConPTY cleanup diagnostic `AttachConsole failed`; the framing change does not suppress or reclassify it.

```text
CP-1 Local PTY: BLOCKED
CP-2 CommandFramer / Completion: FIX_IMPLEMENTED_REQUALIFICATION_PENDING
CP-3 Interactive: PARTIAL
CP-4 Long-running: PARTIAL
CP-5 Multiple Sessions: PARTIAL
CP-6 Relay: NOT STARTED
```

No Cloudflare Worker, MCP server, relay, credentials, delivery receipt, mutation sequencing, request hashing, distributed dedup, fencing, admin broker, GUI, or CP-6+ implementation is included.
