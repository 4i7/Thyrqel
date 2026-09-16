# CP-2 Windows framing escalation

2026-09-16. **BLOCKED / ESCALATION_REQUIRED**. No runtime fix or MVP completion claimed.

## Authority and baseline

- Repository `4i7/Thyrqel`, GitHub repository ID `1372045807`, PR #1.
- Branch `cp2-cp5-local-terminal-core`, tested implementation HEAD
  `0973d6914777e47cab4def5c1fb5426fb6c6450d`, matching PR head; initially clean.
- Checkout: `C:/Users/4i7/Documents/Thyrqel`.
- Design read from `C:/Users/4i7/Downloads/TerminalBridge_DESIGN_5505fab3.md`;
  SHA-256 verified as `5505fab3930fcfc72c211b5358d4a4ac0ec1bb9d14644f740b11f9c55f041b82`.
- Observed Windows build `26200`, Node `24.15.0`, PowerShell **7.6.5**,
  pinned node-pty `1.1.0`. The objective's PowerShell 7.6.6 is not this runtime.
- The separate OneDrive checkout is on main and has an existing untracked
  `TerminalBridge_ARCHITECTURE_FALSIFICATION_REVIEW.md`; it was left untouched.

## Current root cause

**VERIFIED:** `npm.cmd run smoke:cp2-cp5` fails at its first `Write-Output OK`
transaction: expected `ready`, observed `running` after 5000 ms. The strict parent
reports child exit=1, stderr=true, timeout=false.

**VERIFIED:** In the real PTY path, payload output `OK` appears. The body
`TB1:<complete token>:<operation>:1:N:<cwd>` reaches unmodified node-pty `onData`,
but neither RS (`U+001E`) nor US (`U+001F`) appears. A split random marker appended
after the original wrapper cleanup executes, proving the wrapper reaches its end.
The active transaction remains RUNNING. The detector requires `RS + TB1 + token`;
it never recognizes a candidate frame, rather than rejecting a parsed frame.

**VERIFIED:** The same generated PowerShell wrapper executed via ordinary redirected
stdout (`pwsh -NoProfile -NonInteractive -EncodedCommand`) exits 0 with empty stderr,
preserves both delimiters, and produces success=true / exitCode=null through the
existing CompletionDetector. This control is not persistent-PTY qualification.

**INFERENCE:** The console presentation path removes the C0 delimiters. These
experiments locate the difference between pipe and PTY paths; they do not isolate
the exact native component or prove all ConPTY/runtime combinations behave alike.

## Reproducer and evidence

```powershell
npm.cmd run build
node dist/tests/diagnose-completion.js
```

Observed summary (diagnostic exits **1**, intentionally retaining the failure):

```json
{"exit":0,"stderr":false,"rs":true,"us":true,"completion":true}
{"version":"7.6.5","state":"running","outputOK":true,"postlude":true,"tokenBody":true,"rs":false,"us":false,"expectedPrefix":false}
```

The diagnostic uses the existing manager's spawn injection seam to observe raw
onData and append the postlude witness. It does not change production framing or
parsing. Raw output stays in a bounded in-memory buffer; no transcript/history is
written to disk. It uses only the controlled `Write-Output OK` payload. Cleanup
also emitted the existing `conpty_console_list_agent.js:13: AttachConsole failed`.

## Changes and attempted fixes

- Added `tests/diagnose-completion.ts` and this evidence handoff.
- No production fix attempted: changing completion grammar is an explicit
  escalation area in the objective. No dependency, timeout, gate, or parser changes.
- The diagnostic's initial TypeScript build exposed a string/Buffer overload
  mismatch; the diagnostic now forwards Buffer inputs unchanged. Subsequent build
  and all 21 existing unit/fake tests pass.

## Why local patching stops here

The violated implementation assumption is that literal RS/US delimiters survive
the target presentation transport. Design sections 15.2-15.4 require paired framing
and parsing over unmodified onData, and the repository CP-2 report fixes RS/US grammar.
Accepting delimiter-free output, stripping ANSI before parsing, or merely extending
timeouts would change that contract without proving boundaries and false-positive
resistance. It would also leave Bash, chunking, wrapping and long cwd cases unresolved.

**Recommended review target:** `gpt-5.6-sol / high` or higher, reviewing the frozen
framing contract and target ConPTY transport evidence. Relevant files:
`src/session/command-framer.ts`, `src/session/completion-detector.ts`,
`src/session/pty-session.ts`, `docs/CP2_CP5_REPORT.md`, and the diagnostic.

Minimal proposal for review, **not implemented or qualified**: define an ASCII
presentation-safe start/end or length-delimited record, pair both framers and parser,
retain split high-entropy token reconstruction and pre-projection parsing, and test
real PowerShell/Bash transport including wrapping, redraw, chunk splits, marker-like
output and persistent redirection. A supported transport setting that preserves the
existing grammar would avoid that revision, but none was qualified in this run.

## DESIGN_CHANGE_REQUIRED

NONE established for the design's semantic invariants. A local framing-contract
revision is proposed for review; whether the pinned design must also be revised is
unresolved. This stop is **ESCALATION_REQUIRED**, not an assertion that every safe
local correction is impossible. No authority document was changed.

## Tests and status

- PASS: `npm.cmd test`, build plus 21/21 unit/fake-PTY tests, after diagnostic correction.
- FAIL: `npm.cmd run smoke:cp2-cp5`, first real PowerShell completion assertion.
- FAIL: `node dist/tests/diagnose-completion.js`, verified missing PTY delimiters.
- FAIL: `npm.cmd run smoke`; PowerShell and Kali readiness/basic I/O/persistent cwd/
  close/double-close/shell-exit assertions passed, but strict qualification reports
  child exit=0, stderr=true, timeout=false due to `AttachConsole failed`.
- NOT RUN: `npm.cmd ci` (no dependency changes); Node 22 comparison; full later
  CP-2 cases and CP-3..CP-5 real qualification after the first failing assertion.
- CP-1 Local PTY: BLOCKED (cleanup diagnostic reproduced).
- CP-2 CommandFramer / Completion: BLOCKED.
- CP-3 Interactive / CP-4 Long-running / CP-5 Multiple Sessions: PARTIAL, existing
  implementation and fake tests only; not qualified by this run.
- CP-6 Relay / MCP / ChatGPT E2E: NOT STARTED.

PR #1 remains unqualified and is not READY_FOR_REVIEW as a completed CP-2..CP-5 unit.
Do not merge or proceed to CP-6 on this evidence. Resume with framing-contract review,
then the original real-PTY qualification loop; preserve the independent CP-1 gate.
