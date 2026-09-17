# CP-1 Local PTY qualification report

## Current qualification — 2026-09-17

**CP-1: PASS.** The repository-maintained node-pty 1.1.0 lifecycle correction
passes the original strict smoke parent: child exit=0, stderr=false, timeout=false.
PowerShell 7 and WSL2 Kali readiness, persistent cwd, basic I/O, explicit/double
close, and natural shell exit all pass on the actual Windows host.

**VERIFIED root cause:** upstream close races its console-list helper against
ClosePseudoConsole; natural exit removes the native baton before JS can release
HPCON and leaves worker resources alive. This is independent of Terminal Bridge.
The correction retains native ownership until close, waits for process exit plus
output EOF, and closes every worker-owned resource. See the [patch contract and
provenance](../patches/node-pty-1.1.0/README.md).

Verification: npm ci PASS; npm test 26/26 PASS; both smoke parents PASS;
completion diagnostic PASS; lifecycle diagnostic OS/DLL close, natural exit,
post-exit cleanup and 15 repeated cycles per backend PASS. Each repeated run
checks 3,000 tail lines before onExit, actual shell/attached child termination,
worker/pipe cleanup, and Windows handle count after warmup. Observed handle
baseline=220, subsequent samples=[220,220,220,220] for both backends.
No stderr suppression, forced successful exit, or gate relaxation is used.

Runtime: Windows 11 build 26200, Node 24.15.0, PowerShell **7.6.5** (observed),
WSL2 Kali aizel/uid 1000, interactive /bin/bash. Build: Python 3.12.10,
VS 2022 17.14.37314.3, MSVC 14.44.35207, SDK 10.0.26100.0.
Patched Node 22 and other hosts are NOT RUN, not implied by the engine range.

Git: existing PR #1 / cp2-cp5-local-terminal-core, based on
14fca69bf24e98dc2bc1853bfd0d723e46241b4f. CP-6/MCP/ChatGPT E2E are NOT STARTED;
this is qualified local core, not MVP COMPLETE. DESIGN_CHANGE_REQUIRED: NONE.
Ignored profiles.local.json remains operator configuration; node_modules/dist
are generated. The external build-tools cache above contains the verified VSIX
and extracted libraries needed for reproducible native builds, not hidden source.
The separate OneDrive checkout is unchanged.

## Historical failed baseline (superseded)

The following is the original CP-1 record. Its blocker, scope and Git statements
describe that earlier checkpoint, not the current qualification above.

Date: 2026-09-16 (Asia/Tokyo). Overall implementation status: **PARTIAL**.

**CP-1 Local PTY: BLOCKED** — stable node-pty cleanup qualification did not pass.
This is an observed runtime/dependency blocker, not BLOCKED_BY_DESIGN.

## Authority and scope

User request: implement only CP-0 local contracts and CP-1 persistent PTY.
Design file SHA-256:
`5505fab3930fcfc72c211b5358d4a4ac0ec1bb9d14644f740b11f9c55f041b82`.
Source: `C:/Users/4i7/Downloads/TerminalBridge_DESIGN_5505fab3.md`.
No Cloudflare/MCP/relay/privileged broker or command completion was implemented.

## Material implementation

| File | Responsibility |
| --- | --- |
| src/main.ts, src/types.ts | Embedded local API, state/error/identity types, CP-2 interface seams |
| src/profiles.ts | Frozen operator registry, explicit pwsh and WSL argv |
| src/session/manager.ts | Non-elevated host check, session IDs, admission, open/read/write/close/shutdown |
| src/session/pty-session.ts | Readiness gate, PTY ownership, lifecycle, timestamps, exit cleanup |
| src/session/readiness.ts | Echo-resistant startup probe and incremental identity parser |
| src/session/output-ring.ts | 1 MiB bounded UTF-8 ring, loss accounting, split-surrogate handling |
| tests/core.test.ts | Contract, failure and lifecycle regression tests |
| tests/smoke.ts, tests/qualify.ts | Real Windows PTY tests and parent process termination/stderr gate |
| package.json, package-lock.json, tsconfig.json | Exact dependency pins and reproducible build |
| profiles.example.json, README.md, docs/CP0_CONTRACT.md | Operator setup and frozen local contract |

## Observed environment

| Item | Value |
| --- | --- |
| OS | Microsoft Windows 11 Pro, build 26200; WSL reports 10.0.26200.9457 |
| Node.js | 24.15.0, Windows x64 |
| npm | 11.14.1 |
| node-pty | 1.1.0, exact candidate pin, **not qualified** |
| TypeScript | 5.9.3 |
| PowerShell | 7.6.5, Core |
| PowerShell executable | C:/Users/4i7/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe |
| WSL | 2.7.14.0 |
| Distribution | kali-linux, registered WSL version 2 |
| Configured user | aizel; observed uid 1000 |
| Observed Linux shell | /usr/bin/bash, argv0 /bin/bash, interactive flag present |
| Initial Linux cwd | /home/aizel |
| Windows privilege | Non-elevated token; Administrator role check false |

## Verification

| Test | Result | Evidence / qualification |
| --- | --- | --- |
| npm ci | PASS | Lockfile installs five packages, audit reports zero vulnerabilities |
| TypeScript build | PASS | npm test compiles the project |
| Contract/unit suite | PASS | 9 tests; startup chunk boundaries/echo, UTF-8 eviction/surrogates, identities, failure cleanup, lifecycle, registry limits |
| PowerShell open/readiness | PASS | powershell/Core/7.6.5 and initial cwd observed through PTY |
| PowerShell basic I/O | PASS | TB_PS_OK generated from split literals, not matched from input echo |
| PowerShell persistent cwd | PASS | Set-Location TEMP then separate write verifies Get-Location |
| PowerShell close/double close | PASS | API state CLOSED and subsequent write rejected; clean native cleanup is separately FAIL |
| PowerShell shell exit | PASS | EXITED observed; native cleanup diagnostics remain |
| Kali open/readiness | PASS | Configured user, nonzero uid, shell, interactive flag and initial cwd verified |
| Kali basic I/O | PASS | TB_KALI_OK generated from split literals |
| Kali persistent cwd | PASS | cd /tmp then separate write observes /tmp |
| Kali close/double close | PASS | API state CLOSED; clean native cleanup is separately FAIL |
| Kali shell exit | PASS | EXITED observed; native cleanup diagnostics remain |
| Invalid profile/session | PASS | Explicit INVALID_PROFILE / INVALID_SESSION |
| Startup timeout/early exit/identity mismatch | PASS | Injected PTY regression tests; not live negative-user qualification |
| Clean Agent termination, OS ConPTY | PASS | Final child exits naturally with code 0; no process.exit workaround |
| Clean native lifecycle qualification | FAIL | Child stderr contains node-pty AttachConsole failed; parent gate exits 1 |
| Real nonexistent WSL user / default-root distro | NOT RUN | No distro default/user configuration was changed; wrong identity and uid 0 tested in parser |
| CP-2 and later test matrices | NOT RUN | Explicitly outside this request |

Final reproducible gate output:

```text
FAIL qualification: child exit=0, stderr=true, timeout=false
```

Relevant diagnostic:

```text
node_modules/node-pty/lib/conpty_console_list_agent.js:13
var consoleProcessList = getConsoleProcessList(shellPid);
Error: AttachConsole failed
Node.js v24.15.0
```

The node-pty Windows implementation forks a console-list helper during kill.
The helper fails to attach on this machine during close/exit cleanup. The exact
native cause is not proven; attributing it solely to this application's state
machine would be unsupported. State assertions alone do not qualify this path.

## Dependency experiments and remaining blocker

- **1.1.0 / OS ConPTY:** readiness and I/O pass. Initially natural-exit worker
  resources were retained; explicit release on onExit fixed Agent termination.
  AttachConsole failure remains and is not suppressed or reclassified as success.
- **1.1.0 / bundled DLL:** public but upstream-experimental `useConptyDll` option
  was tested. I/O assertions passed but Agent processes remained alive. It was
  rejected and is absent from final code. Three identified lingering smoke
  processes from the experiments were stopped explicitly.
- **1.0.0:** stable fallback install failed in node-gyp configure, before smoke,
  with FileNotFoundError for `build/deps/winpty/src/winpty-debugserver.vcxproj.filters`.
  This is an environment/build failure, not proof that 1.0.0 cannot work generally.
  `npm ci` restored the exact 1.1.0 candidate and original five-package graph.
- **Prereleases:** not installed. No dependency source patch, private native API,
  forced-success exit, or stderr suppression was introduced.

To resume CP-1, qualify a supported stable node-pty/runtime combination with
clean close and natural shell-exit cleanup, using the existing smoke gate.
The final dependency choice remains pending that result. CP-2 is not authorized
by this failed qualification and no CP-2 advancement checklist is presented.

## Deliberate scope differences

- The user's narrowed CP-0 takes precedence over the design's full distributed
  CP-0 checklist. Completion/framing semantics remain unimplemented.
- The requested flat local `src/` layout is used instead of the future monorepo.
- Local reads drain raw strings; ANSI projection and delivery receipts are deferred.
- Local configuration uses JSON and TypeScript types rather than introducing YAML.
- Bounded session records add explicit operator `forget`; close is idempotent until
  that record is deliberately removed. No idle eviction or network behavior is added.
- No fully qualified node-pty version can yet be claimed. This is the substantive
  unmet requirement preventing CP-1 PASS.

## Git and local artifacts

Repository had no commits, tracked files or configured remote at start, on unborn
`master`. No branch, commit, push or PR was created. New implementation files remain
untracked for review. Existing `TerminalBridge_ARCHITECTURE_FALSIFICATION_REVIEW.md`
was read and left unchanged.

Ignored `profiles.local.json` holds the actual operator executable/user settings.
Ignored `node_modules/` and `dist/` are dependency/build outputs, not project source.
The npm fallback-install diagnostic remains in the normal external npm cache log:
`C:/Users/4i7/AppData/Local/npm-cache/_logs/2026-09-15T21_31_28_394Z-debug-0.log`.
No temporary source experiment or vendored dependency patch is retained.
