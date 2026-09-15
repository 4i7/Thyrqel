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
