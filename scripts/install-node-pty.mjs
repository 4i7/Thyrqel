import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const dependency = join(root, 'node_modules/node-pty');
const patch = join(root, 'patches/node-pty-1.1.0');
const manifest = JSON.parse(readFileSync(join(patch, 'manifest.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (require('node-pty/package.json').version !== manifest.version) throw Error('Unexpected node-pty version');
// Validate the complete input before changing any file. Reapplication is idempotent.
const files = manifest.files.map(entry => {
  const bytes = readFileSync(join(patch, entry.file.replaceAll('/', '__')));
  if (hash(bytes) !== entry.afterSha256) throw Error(`Corrupt patch: ${entry.file}`);
  const target = join(dependency, entry.file);
  if (![entry.beforeSha256, entry.afterSha256].includes(hash(readFileSync(target)))) {
    throw Error(`Unexpected node-pty source: ${entry.file}`);
  }
  return { target, bytes };
});
for (const { target, bytes } of files) writeFileSync(target, bytes);
if (process.platform === 'win32') {
  if (process.arch !== 'x64') throw Error('Patched Windows build is qualified only on x64');
  const run = (executable, args) => {
    const result = spawnSync(executable, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error(`Dependency build failed (${result.status}): ${executable}`);
  };
  run(process.execPath, [require.resolve('node-gyp/bin/node-gyp.js'), 'configure', '--directory', dependency]);
  run('pwsh.exe', ['-NoLogo', '-NoProfile', '-File', join(root, 'scripts/build-node-pty.ps1'), '-Dependency', dependency]);
  const versions = readdirSync(join(dependency, 'third_party/conpty'));
  if (versions.length !== 1) throw Error('Ambiguous bundled ConPTY version');
  const dest = join(dependency, 'build/Release/conpty');
  mkdirSync(dest, { recursive: true });
  for (const file of ['conpty.dll', 'OpenConsole.exe']) {
    copyFileSync(join(dependency, 'third_party/conpty', versions[0], 'win10-x64', file), join(dest, file));
  }
  const native = require(join(dependency, 'build/Release/conpty.node'));
  if (native.thyrqelLifecyclePatch !== 1) throw Error('Unpatched native module');
  console.log('node-pty 1.1.0 lifecycle patch 1 built and verified');
}
