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
- `npm test`: PASS, 30 tests, including SDK client/server protocol integration,
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

## Remaining work before completion

1. Complete the actual ChatGPT callback qualification against the deployed Worker.
2. Qualify the implemented outbound relay and operation receipts on the actual
   deployed Worker and ChatGPT connector. Local simulations are not public proof.
3. Qualify the reported disconnect/reconnect pattern over a sustained run,
   including a session and result spanning a transport interruption.
4. Complete the actual ChatGPT connection and final release gates.

Wrangler 4.136.1 account verification: PASS after the operator completed browser
login. Account `4i7` is available with Workers/KV write permissions. The production Worker, KV binding, GitHub OAuth application configuration and Worker secrets are provisioned. The official OAuth provider, consent,
owner binding and device-credential verification are implemented and tested
locally. See [Cloudflare setup](CLOUDFLARE_SETUP.md) for contracts and limitations.

The production endpoint is deployed at `https://thyrqel.4i7.workers.dev`. End-to-end ChatGPT operation is still being qualified; deployment alone is not a production-ready claim.
