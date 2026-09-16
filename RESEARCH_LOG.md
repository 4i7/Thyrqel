# Primary-source research

Date: 2026-09-16. No reference implementation code was copied.

| Source | Version / license | Scope |
| --- | --- | --- |
| [microsoft/node-pty](https://github.com/microsoft/node-pty/tree/v1.1.0) | v1.1.0; MIT | Public IPty spawn/onData/onExit/write/kill API; local installed Windows cleanup implementation inspected to diagnose smoke failures |
| [ConPTY lifecycle](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session) | Live Microsoft documentation | Windows pseudoconsole lifecycle and UTF-8 terminal channel |
| [WSL commands](https://learn.microsoft.com/en-us/windows/wsl/basic-commands) | Live Microsoft documentation | Explicit distribution/user/initial-directory/executable selection |

The npm registry was checked for stable versions: 1.1.0 is the current stable
candidate; 1.2.0 builds are prereleases and were not selected.
PowerShell about_pwsh retrieval failed; local PowerShell 7.6.5 behavior was
validated directly. node-pty v1.1.0 types mark useConptyDll experimental.

## Windows qualification follow-up, 2026-09-16

- Inspected the installed MIT node-pty 1.1.0 Windows agent, terminal and conout
  worker code, and the published 1.2.0-beta.15 JavaScript implementation. Public
  kill/exit behavior was reproduced independently of Terminal Bridge.
- [Upstream issue #952](https://github.com/microsoft/node-pty/issues/952) describes
  the console-list/teardown race. Used as corroboration, not as test evidence.
- npm registry dist-tags observed: stable 1.1.0, beta 1.2.0-beta.15. The beta was
  installed and tested, then rejected and reverted: its OS helper catches the
  AttachConsole error, and its DLL natural-exit path still retains a worker.
- Node 22.23.2 (npm-exec portable runtime) reproduced the 1.1.0 failures seen on
  host Node 24.15.0. No dependency reference implementation was copied or patched.
