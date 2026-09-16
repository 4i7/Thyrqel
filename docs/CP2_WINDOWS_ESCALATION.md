# CP-2 Windows framing escalation

2026-09-16. Review resolution: **LOCAL_CONTRACT_FIX**.

## Authority

- Repository: `4i7/Thyrqel`, PR #1.
- Design authority: `TerminalBridge_DESIGN_5505fab3.md`.
- SHA-256: `5505fab3930fcfc72c211b5358d4a4ac0ec1bb9d14644f740b11f9c55f041b82`.
- Runtime evidence was captured on Windows 11 build 26200, Node 24.15.0, PowerShell 7.6.5, node-pty 1.1.0, ConPTY.

## Root cause

### VERIFIED

- `Write-Output OK` executes in the real PowerShell PTY path.
- `OK` reaches node-pty `onData`.
- the printable completion body `TB1:<token>:<operation>:1:N:<cwd>` reaches the unmodified `onData` stream;
- wrapper execution reaches its postlude;
- literal RS (`U+001E`) and US (`U+001F`) do not appear in that PTY stream;
- because the old detector required `RS + TB1 + token`, the ActiveStep remains RUNNING;
- the same old wrapper through ordinary redirected stdout preserves RS/US and is accepted by the old detector.

The original reproducer was:

```powershell
npm.cmd run build
node dist/tests/diagnose-completion.js
```

Observed before the fix:

```json
{"exit":0,"stderr":false,"rs":true,"us":true,"completion":true}
{"version":"7.6.5","state":"running","outputOK":true,"postlude":true,"tokenBody":true,"rs":false,"us":false,"expectedPrefix":false}
```

### INFERENCE

The violated implementation assumption was that C0 record separators survive the target terminal presentation path. The evidence localizes the mismatch to the presentation path versus ordinary pipe transport; it does not claim that every ConPTY/runtime combination strips the same characters or identify a single native component as the cause.

## Review decision

RS/US are removed from the completion protocol. No replacement C0 delimiter is introduced.

The corrected CP-2-local grammar is printable ASCII and length-delimited:

```text
"TB1:" token ":" body_length_hex8 ":" body

body := base64(operation_id) ":" success ":" exit ":" base64(cwd)
```

This is a local contract correction, not a semantic redesign. The following invariants are preserved:

- encoded payload;
- persistent shell state;
- one ActiveStep per session;
- complete high-entropy completion token never appears contiguously in PTY input echo;
- token remains the first candidate-authentication gate;
- detector runs on raw node-pty `onData` before `OutputRing`;
- incremental parsing and arbitrary chunk boundaries;
- bounded parser retention;
- malformed matching frames fail closed;
- Bash reserved control descriptor;
- completion after `exec >/dev/null`;
- existing PowerShell success / exit-code semantics;
- hostile same-shell-authority protocol sabotage remains outside the sandbox guarantee.

## Parser contract

The detector uses three states:

```text
SEARCH_MARKER -> READ_LENGTH -> READ_BODY -> VALIDATE/COMPLETE
```

- marker: exact `TB1:<48-lowercase-hex-token>:`;
- length: exactly eight hexadecimal digits followed by `:`;
- body maximum: 256 KiB;
- operation ID decoded maximum: 256 bytes;
- cwd decoded maximum: 192 KiB;
- operation ID and cwd Base64 must be canonical;
- decoded text must be valid UTF-8;
- exact-token candidates with malformed length/body fail with `SESSION_PROTOCOL_ERROR`;
- ordinary marker-like output using another token is passed through;
- parser does not globally strip ANSI/VT sequences;
- an incomplete matching candidate is reconstructed by `flush()` if the PTY exits before completion.

## Emission

### PowerShell

The existing transaction semantics are unchanged. Only final record assembly changed. The record is emitted via `[Console]::Out.Write(...)` using printable ASCII. `$LASTEXITCODE` sentinel handling, error observation, dot-sourced payload execution, cwd persistence, and cleanup remain unchanged.

### Bash

The existing persistent reserved descriptor is unchanged. The same printable grammar is emitted through that descriptor, so a payload may still execute `exec >/dev/null` without removing the completion channel.

## Regression coverage added

- every chunk split;
- printable marker-like output;
- malformed matching length;
- over-bound declared body;
- 32 KiB-class cwd;
- ANSI data surrounding a valid frame;
- incomplete candidate flush;
- real PowerShell ANSI output in target smoke;
- real WSL Bash printable marker-like and ANSI output;
- existing multiline, heredoc, `exec >/dev/null`, delayed completion and multi-session cases remain.

## Current status

**PARTIAL / ESCALATION_REQUIRED (external lifecycle dependency)**, 2026-09-16.
Framing requalification was run; the earlier framing escalation is resolved.
Starting checkout and PR head both matched
`f92f2547b7d504c173a2cc9bf652e9f5c7a8e679`, branch
`cp2-cp5-local-terminal-core`, clean checkout at `C:/Users/4i7/Documents/Thyrqel`.
The design hash was reverified. No unrelated OneDrive checkout changes were touched.

Executed:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run smoke
npm.cmd run smoke:cp2-cp5
node dist/tests/diagnose-completion.js
```

The real PowerShell result/persistence matrix, Bash framing/redirection matrix,
Python REPL, long-running Ctrl+C and simultaneous Kali/Kali/PowerShell assertions
all pass after the implementation correction below. Both strict parents still
report **FAIL: child exit=0, stderr=true, timeout=false** on the final 1.1.0 stack.
Build/unit tests: **23/23 PASS**. See [the full command status](CP2_CP5_REPORT.md).

### Ordinary defects corrected

1. CP-4 smoke discarded output returned by `step`, then waited for the same bytes
   again in `read`. It now searches the combined initial and subsequent output.
2. Interactive Bash's default SIGINT disposition abandoned the wrapper input list
   after Python's KeyboardInterrupt, so no postlude ran and ActiveStep remained
   RUNNING. The wrapper now saves the previous INT trap, installs a temporary
   handler, captures payload status, and restores the trap before completion.
   Real PTY regression coverage proves status 130, control recovery, the next
   transaction, and default/pre-existing trap restoration. No Windows signal API
   is used. A payload deliberately replacing the control trap can still disrupt
   framing under the same-shell-authority limitation.
3. Completion diagnostic sampled its appended postlude witness before it arrived;
   it now waits for that witness with a bounded deadline and fails if absent.
4. The redirection test now creates/removes its own temporary file. The old
   `/tmp/tb_cp2_redir` test artifact was removed after verifying its expected content.

### Cleanup root cause and supported-path investigation

**VERIFIED from installed source and standalone runtime:** node-pty 1.1.0's OS
ConPTY `kill()` forks `_getConsoleProcessList()` and synchronously closes ConPTY
without waiting for that helper. A single `spawn`/`kill`, with no Terminal Bridge
code, reproduces `AttachConsole failed`. Duplicate application cleanup is therefore
not necessary to reproduce the failure. Upstream has the same reported race in
[microsoft/node-pty#952](https://github.com/microsoft/node-pty/issues/952).

Removing the application's exit cleanup is not a safe fix: `onExit` fires, but the
dependency's conout worker/server remains alive. Installed `windowsPtyAgent` closes
the output socket on ordinary process exit without disposing that worker. In DLL
mode its `kill()` schedules disposal only on a future data event; natural exit can
already have closed that stream. There is no public IPty worker-disposal API.

`tests/diagnose-lifecycle.ts` directly exercises the public node-pty API in bounded
child processes. Each child must report PTY exit **and naturally terminate**, with
zero stderr. Timeout/stderr/nonzero exit are failures, not suppressed outcomes.

| node-pty / Node | OS close | OS exit without cleanup | OS exit + kill | DLL close | DLL exit | DLL exit + kill |
| --- | --- | --- | --- | --- | --- | --- |
| 1.1.0 / 24.15.0 | stderr FAIL | timeout FAIL | stderr FAIL | timeout FAIL | timeout FAIL | timeout FAIL |
| 1.1.0 / 22.23.2 | stderr FAIL | timeout FAIL | stderr FAIL | timeout FAIL | timeout FAIL | timeout FAIL |
| 1.2.0-beta.15 / 24.15.0 | clean observation | timeout FAIL | clean observation | clean observation | timeout FAIL | timeout FAIL |

The beta OS-path observations are **not an accepted fix**: inspection of its
`conpty_console_list_agent.js` shows that it catches AttachConsole failures and
returns an empty list. That would hide this failure rather than prove cleanup.
Its DLL path avoids that helper, and CP-2..CP-5 passed once with it, but the CP-1
strict parent timed out after all functional assertions passed. No beta/DLL
change remains in the branch. No dependency source was patched.

The Node 22 comparison used an npm-exec cached runtime, without replacing host
Node or changing project dependencies. Its cache is ordinary npm-managed state
under `C:/Users/4i7/AppData/Local/npm-cache/_npx/`. Build outputs remain ignored in
`dist/`; no raw terminal transcript or temporary source experiment is retained.

Reproduce the final dependency failure:

```powershell
npm.cmd run build
node dist/tests/diagnose-lifecycle.js
npm.cmd exec --yes --package=node@22.23.2 -- node dist/tests/diagnose-lifecycle.js
```

### Remaining boundary

The failure is localized to node-pty lifecycle implementation with a minimal
reproducer, and the available supported public-API/runtime/version corrections
tested here do not satisfy both clean close and natural exit. Continuing would
require a dependency lifecycle correction, not a parser/ActiveStep workaround.
Recommended upstream review targets are `WindowsPtyAgent.kill`,
`_getConsoleProcessList`, `_cleanUpProcess`, and `ConoutConnection.dispose`:
enumerate while the console is still valid, and close worker/input/output resources
deterministically on both close and natural exit. Qualification must also prove
owned-process termination, not merely absence of a diagnostic.

This meets the objective's external-component escalation condition. No semantic
design change is established (**DESIGN_CHANGE_REQUIRED: NONE**). CP-1 is BLOCKED;
CP-2..CP-5 have functional PASS evidence but remain PARTIAL under the strict gate.
No merge, CP-6, MCP or Cloudflare work was performed. The requested fully qualified
PR outcome is **not achieved**.
