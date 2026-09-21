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
- `npm test`: PASS, 14 tests, including SDK client/server protocol integration,
  teardown-order regression tests, and an isolated operation journal.
- Device-local operation journal implemented and unit-tested: duplicate pending
  calls share execution, changed payloads conflict, result eviction leaves
  no-resend tombstones, old process epochs are rejected. It is not yet wired
  into a network transport. Input is hashed rather than retained by the journal.
- `npm run smoke`: PASS after clean install, Windows PowerShell and WSL Kali,
  persistent cwd, interactive prompt/follow-up input, close, natural shell exit;
  child exit 0, no stderr, no timeout.
- Actual sudo authentication / password entry: NOT RUN.
- Concurrent external exit and descendant-process lifecycle matrix: NOT RUN.

The historical CP1 report remains unchanged as evidence of the earlier failed
baseline. The new basic smoke PASS does not qualify the unrun lifecycle matrix.

## Remaining work before completion

1. Cloudflare OAuth endpoint with explicit operator consent and account binding.
2. An outbound-only Windows device connection to a Durable Object relay, with
   device credentials separated from child-shell environments.
3. Operation IDs, connection epochs, bounded replay records, output receipts,
   and unknown-outcome handling. Never resend uncertain input automatically.
   The current local drain-read interface is insufficient for reliable remote
   delivery and must not be exposed unchanged across an unreliable network.
4. Secure local human input for credentials without putting passwords in MCP
   arguments, relay storage, or diagnostic logs.
5. Real lifecycle negatives and authenticated end-to-end ChatGPT verification.
6. Concrete deployment configuration, account verification and release gates.

Wrangler 4.136.1 account verification: PASS after the operator completed browser
login. Account `4i7` is available with Workers/KV write permissions. No Cloudflare
resources or secrets have been created. Use the official OAuth provider library;
authentication, consent, and device pairing still need implementation and tests.

No cloud endpoint is deployed and no production-ready claim is made.
