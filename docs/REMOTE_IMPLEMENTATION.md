# Remote terminal implementation status

## Confirmed target

ChatGPT controls the operator's Windows PowerShell and WSL Kali terminal through
a Cloudflare-hosted MCP endpoint. Interactive programs retain their terminal
across calls; command-name restrictions must not prevent legitimate local
administration. OS authorization remains authoritative. No changes to sudoers,
passwords, account privileges, or host security settings are included.

## Reference and reuse boundary

Examined DesktopCommanderMCP commit
`d217d490afb11e655c02b52146d443b1bcf1dcb1`: the local process tools and remote-device
README/channel implementation. Its MIT-licensed local implementation separates
process creation, later interaction, output reads, and local execution from
remote transport. Thyrqel adopts that separation with its existing PTY core.
No Desktop Commander implementation code or documentation text was copied.

The remote-desktop-commander repository contains restricted reference material;
the hosted service source is proprietary and is not available for reuse.

- https://github.com/wonderwhy-er/DesktopCommanderMCP/tree/d217d490afb11e655c02b52146d443b1bcf1dcb1
- https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/d217d490afb11e655c02b52146d443b1bcf1dcb1/LICENSE
- https://github.com/desktop-commander/remote-desktop-commander/blob/main/LICENSE
- https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/

The connected Remote Desktop Commander device was offline during inspection.
Its actual blocked-command configuration and the cause of the user's historical
sudo failures were therefore not verified.

## Implemented and observed

- Local stdio MCP using the official SDK, six terminal lifecycle tools.
- Existing operator-owned profiles and non-elevated Windows host checks retained.
- No terminal input or password logging added. MCP client history is outside
  this guarantee; do not pass passwords through model tools.
- Raw input, subsequent reads, and terminal state kept distinct from completion.
- Exact-version/hash node-pty lifecycle patch; diagnostics remain visible.
- `npm ci`: PASS, including patch application; npm audit reported zero findings.
- `npm test`: PASS, 31 tests, including SDK client/server protocol integration,
  teardown order, OAuth handlers, bounded reads, environment separation and
  reconnect/result recovery using real local WebSockets.
- Device-local operation journal connected to the device executor: duplicate pending
  calls share execution, changed payloads conflict, result eviction leaves
  no-resend tombstones, old process epochs are rejected. It is wired
  to an outbound WebSocket transport. Input is hashed rather than retained by the journal.
- `npm run smoke`: PASS after clean install, Windows PowerShell and WSL Kali,
  persistent cwd, interactive prompt/follow-up input, close, natural shell exit;
  child exit 0, no stderr, no timeout.
- `cloud:check` and `cloud:test`: PASS for Worker types/build and local
  OAuth/DO/MCP/WebSocket integration. GitHub and terminal peers are mocked.
- `cloud:live`: PASS through local Workers to both real PTYs, including
  interactive follow-up and clean natural host termination. GitHub is mocked.
- `cloud:live -- --sudo`: the earlier noninteractive check failed because a
  password was required. On 2026-09-23, the operator entered the Kali password
  in the device's local hidden-input console while the public MCP WSL session
  waited in `sudo -- id -u`; the terminal returned UID `0` and exit status `0`.
  No sudo policy changed, and the password was absent from tool arguments and
  terminal output.
- `npm run lifecycle -- path/to/profiles.json`: PASS on Windows PowerShell and
  WSL Kali for foreground descendant cleanup, three immediate exit/close races
  per profile, and external termination of each test-owned host process. The
  child exited 0 with no stderr or timeout. The first run on the older patch
  failed with `AttachConsole failed`; see [the PTY patch](PTY_PATCH.md).

The historical CP1 report remains unchanged as evidence of the earlier failed
baseline. This finite lifecycle test cannot prove every detached-process or
PID-reuse schedule.

On 2026-09-23, the attached Thyrqel MCP connection to the public Worker reported
an online device. Real PowerShell and WSL sessions accepted interactive input,
retained their working directories and variables, returned follow-up output,
and replayed completed receipts without a second effect. A device restart
changed the epoch and retired that old session,
as designed. The browser's reported disconnect/reconnect cycle has not yet
been classified as a sustained-connection PASS; a 50-second Worker tail showed
no exceptions, which is insufficient to diagnose that cycle.

On 2026-09-23, the operator's ChatGPT account connected its private Thyrqel MCP
app using GitHub OAuth. ChatGPT invoked `device_status` against the public Worker,
opened a new `wsl-kali` session, ran `pwd`, read `/home/aizel`, then closed and
forgot only that test session. The device epoch stayed constant for this flow.

After PR #3 merged to GitHub `main` at `4c25a9c`, a clean install applied the
revised native patch. The 31 tests passed, and the real PowerShell/WSL
lifecycle gate exited 0 with no stderr or timeout. The operator restarted the
device; the public relay reported a new online epoch, and ChatGPT retrieved it
through the existing OAuth connection. Unauthenticated `/mcp` and `/device`
requests both returned HTTP 401.

On 2026-09-23, a later local launch failed with HTTP 401. Recomputing the
SHA-256 digest from the existing local device token and updating the Worker
secret restored the connection; the prior cause of the mismatch is unknown.
The recovered device stayed online for a bounded multi-minute check. A
PowerShell session retained a variable, and resubmitting an existing operation
ID returned `alreadyAdmitted: true`. Re-registering the same Worker secret
did not interrupt the existing WebSocket, so this check does not qualify
recovery from an actual transport break. Unauthenticated GETs to both
`/device` and `/mcp` returned HTTP 401.

PR #4 added secret-free local stop reasons. Its GitHub-branch build and 32
tests passed; after merging to `main`, a real `quit` displayed
`Thyrqel device stopping: local quit`. The device then reconnected from
the merged build. The earlier silent exit remains unclassified.

The device was then launched in a separate visible PowerShell window from the
merged `main` build. Its PowerShell and Node processes remained alive, and
the public relay reported the same online epoch on a later check. This
independent interactive window supports local hidden password entry while it
stays open; automatic start at Windows logon is not configured.

A redeploy of that same `main` Worker produced version
`9d63852b-f42f-4d69-98e6-df61577b9262`. The device retained the same
process, epoch and TCP connection; a pre-existing PowerShell session retained
its variable, the earlier input receipt was still complete, and reusing its
operation ID returned `alreadyAdmitted: true`. The test session was closed.
The redeploy did not force a transport interruption, so it cannot prove the
production reconnect path.

## Remaining work before completion

1. Observe an actual production transport interruption with the device
   process and epoch retained; verify that an existing session and receipt
   remain usable after reconnect. Local WebSocket reconnect and result-replay
   tests already pass.

Wrangler 4.136.1 account verification: PASS after the operator completed browser
login. Account `4i7` is available with Workers/KV write permissions. The production Worker, KV binding, GitHub OAuth application configuration and Worker secrets are provisioned. The official OAuth provider, consent,
owner binding and device-credential verification are implemented and tested
locally. See [Cloudflare setup](CLOUDFLARE_SETUP.md) for contracts and limitations.

The production endpoint is deployed at `https://thyrqel.4i7.workers.dev`.
ChatGPT end-to-end operation and the revised native patch passed bounded
production checks; sustained connection reliability remains under qualification.
