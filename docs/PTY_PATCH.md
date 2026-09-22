# node-pty lifecycle patch

The stable upstream node-pty 1.1.0 calls its asynchronous console enumeration
helper and tears down ConPTY before that helper can attach. Natural shell exit
also calls the helper after the console is gone. The real smoke gate reproduced
`AttachConsole failed` on Windows 11 / Node 24.15.0.

`scripts/patch-node-pty.mjs` applies a narrowly scoped install-time patch to the
exact SHA-256 of the published 1.1.0 JavaScript file. It keeps the upstream MIT
copyright/license in the installed dependency. No native binary is modified.

For OS ConPTY, enumerate while the console is alive, terminate the enumerated
members, then close ConPTY and its worker/sockets. After natural exit, only
release resources; do not enumerate the dead console. Duplicate teardown is
ignored. Enumeration timeout fails with a warning instead of killing a stale
fallback PID. Unexpected cleanup errors remain visible to the qualification
gate. Bundled ConPTY DLL and winpty paths are unchanged and unqualified.

This patch does not turn numeric process IDs into durable process handles.
Concurrent independent process exit can still race enumeration. Tree cleanup,
including descendant-process and concurrent-exit tests, must be qualified before
claiming full lifecycle completion. Do not suppress stderr or force a zero exit.

Reference: https://github.com/microsoft/node-pty/issues/952

Remove the patch only when an upstream replacement passes the same real gates.
