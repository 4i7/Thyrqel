import { TerminalError, type Profile } from './types.js';

// Constructed by the local operator. open() accepts only a registry ID.
export class ProfileRegistry {
  private readonly profiles = new Map<string, Profile>();
  constructor(profiles: readonly Profile[]) {
    for (const p of profiles) {
      const valid = p && (
        (p.id === 'windows-pwsh' && p.platform === 'windows' && p.shellDialect === 'powershell' &&
          typeof p.command === 'string' && p.command.length > 0 && !p.command.includes('\0')) ||
        (p.id === 'wsl-kali' && p.platform === 'wsl2' && p.shellDialect === 'bash' &&
          p.shell === '/bin/bash' && typeof p.user === 'string' && /^[a-z_][a-z0-9_-]*[$]?$/i.test(p.user) && p.user !== 'root' &&
          typeof p.distro === 'string' && p.distro.length > 0 && !p.distro.includes('\0') &&
          typeof p.initialDirectory === 'string' &&
          (p.initialDirectory === '~' || p.initialDirectory.startsWith('/')) &&
          !/[\0\r\n]/.test(p.initialDirectory)));
      if (!valid || this.profiles.has(p.id)) throw new TerminalError('INVALID_PROFILE', 'Invalid or duplicate operator profile');
      this.profiles.set(p.id, Object.freeze({ ...p }));
    }
  }
  get(id: string): Profile {
    const p = this.profiles.get(id);
    if (!p) throw new TerminalError('INVALID_PROFILE', `Unknown profile: ${id}`);
    return p;
  }
}

export function launch(p: Profile): { command: string; args: string[] } {
  return p.platform === 'windows'
    ? { command: p.command, args: ['-NoLogo', '-NoProfile', '-NoExit'] }
    : { command: `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\wsl.exe`,
        args: ['-d', p.distro, '--user', p.user, '--cd', p.initialDirectory, '--exec', p.shell, '-i'] };
}
