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

The contract fix is implemented on the PR branch. **Windows requalification has not yet been claimed.** Run:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run smoke
npm.cmd run smoke:cp2-cp5
node dist/tests/diagnose-completion.js
```

Expected CP-2 qualification requires the real PowerShell ConPTY path and real WSL2 Bash path to complete using the new printable frame. CP-1 remains a separate blocker while the existing `AttachConsole failed` cleanup diagnostic is present.

Do not proceed to CP-6 solely because the framing patch exists; first record the target-runtime results.
