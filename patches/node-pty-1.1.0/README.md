# node-pty 1.1.0 Windows lifecycle correction

Upstream: [microsoft/node-pty v1.1.0](https://github.com/microsoft/node-pty/tree/1.1.0),
npm `node-pty@1.1.0`, MIT (license retained here). The npm tarball integrity is
pinned in package-lock.json. This is a repository-maintained patch, not an
upstream release or a claim of upstream support.

The four replacement files are exact distribution JS / native C++ sources.
`manifest.json` pins both original and replacement SHA-256 bytes; the installer
validates all inputs before replacing anything. `__` encodes `/` in filenames.
Git line-ending conversion is disabled for this directory. Do not compile the
upstream TypeScript over these distribution JS replacements. When changing the
patch, update its replacement hashes and test from a fresh `npm ci`.

## Lifecycle invariant

The native PTY registry is owned by the JS thread. The process-wait thread reports
exit without removing the baton; the JS callback can therefore close the retained
HPCON even on natural shell exit. Native close is idempotent. Registry removal
executes in release builds too, not inside an elidable assertion.

Close uses the owned pseudoconsole, not an asynchronous PID enumeration against
an already-destroyed console. [ClosePseudoConsole](https://learn.microsoft.com/en-us/windows/console/closepseudoconsole)
sends CTRL_CLOSE_EVENT to connected clients. Output continues draining until EOF;
EOF and process exit are both required before closing the output socket and
disposing the worker. The worker closes its server, clients, input socket and
parent port, and terminates naturally. No helper error is caught/suppressed and
no timer substitutes for EOF. The old console-list helper is no longer called
on the ConPTY path. Detached processes are outside this console-close guarantee.

## Reproducible build

`npm ci` runs `scripts/install-node-pty.mjs`: validate/apply sources, configure
with pinned node-gyp 12.2.0, build `conpty.node`, copy upstream bundled ConPTY DLLs,
then verify the native patch revision. Runtime also requires that revision; an
unpatched prebuilt fallback cannot silently qualify.

Requires Windows x64, PowerShell 7, Python 3, VS 2022 C++ Build Tools, Windows SDK,
and the matching Spectre libraries. On the qualified MSVC 14.44.35207 toolset,
missing Spectre libraries are supplied from a SHA-256 pinned official Microsoft
VSIX into `%LOCALAPPDATA%/Thyrqel/build-tools/msvc-14.44.35226-spectre`.
The build re-extracts verified bytes, searches these libraries first, and retains
Spectre mitigation. It does not change the global VS installation. Other toolsets
must have their matching Spectre component installed. Build errors fail install.
Install with development dependencies; `--ignore-scripts` is not supported.

Qualified runtime: Windows 11 build 26200, Node 24.15.0, PowerShell 7.6.5,
MSVC 14.44.35207, SDK 10.0.26100.0. Other Windows versions, Node versions, ARM64,
and legacy winpty are not qualified by this patch's evidence.

## Regression checks

`npm test` covers exit-before-EOF, EOF-before-exit, and duplicate close ordering.
`node dist/tests/diagnose-lifecycle.js` uses strict subprocesses for explicit
close, natural exit, cleanup after exit, output flood close, and 15 repeated
lifecycles per OS/DLL backend. It verifies tail output, exit code, attached child
termination, worker/pipe disappearance, bounded Windows handles, and natural Node
exit with no stderr/timeout. CP-1 and CP-2..CP-5 smoke gates remain unchanged.
