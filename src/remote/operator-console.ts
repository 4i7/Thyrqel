import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import type { SessionManager } from '../session/manager.js';

/** Local TTY only. No secret argument is accepted by the remote tool surface. */
export async function runOperatorConsole(manager: Pick<SessionManager, 'list' | 'writeSecret'>, abort: AbortController,
  input = process.stdin, display = process.stdout) {
  if (!input.isTTY || !display.isTTY) return;
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      // Decide suppression synchronously. Queued writes must not cross a later
      // mute/unmute boundary and accidentally display secret keystrokes.
      if (!muted) display.write(chunk, encoding);
      callback();
    },
  });
  const terminal = createInterface({ input, output, terminal: true, historySize: 0 });
  terminal.on('SIGINT', () => abort.abort('local Ctrl+C'));
  terminal.on('close', () => abort.abort('local console closed'));
  display.write('Local controls: sessions | secret <profile-or-sessionId> | quit\n');
  try {
    while (!abort.signal.aborted) {
      const command = (await terminal.question('device> ', { signal: abort.signal })).trim();
      if (command === 'quit') { abort.abort('local quit'); break; }
      if (command === 'sessions') {
        for (const session of manager.list()) display.write(`${session.sessionId} ${session.profile} ${session.state}\n`);
        continue;
      }
      const match = /^secret (\S+)$/.exec(command);
      if (!match) { display.write('Use sessions, secret <profile-or-sessionId>, or quit.\n'); continue; }
      const target = match[1]!;
      const ready = manager.list().filter(session => session.state === 'READY' &&
        (session.sessionId === target || session.profile === target));
      if (ready.length !== 1) {
        display.write(ready.length > 1 ? 'Multiple sessions match; run sessions and use an exact session ID.\n'
          : 'No ready session matches; run sessions to see current IDs after a device restart.\n');
        continue;
      }
      const sessionId = ready[0]!.sessionId;
      display.write('Confirm the trusted program is waiting for a password in this session. Input is hidden; Enter sends it, Ctrl+C stops the device.\nSecret: ');
      muted = true;
      let secret = '';
      try {
        secret = await terminal.question('', { signal: abort.signal });
        manager.writeSecret(sessionId, secret);
      } catch (error) {
        if (abort.signal.aborted) throw error;
        // Never stringify errors from an input operation: native errors may contain data.
        display.write('\nSecret input failed; inspect the session before trying again.\n');
      } finally {
        secret = '';
        muted = false;
        display.write('\n');
      }
    }
  } catch (error) {
    if (!abort.signal.aborted) throw error;
  } finally {
    muted = false;
    terminal.close();
    output.end();
  }
}
