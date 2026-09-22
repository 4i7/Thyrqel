// The remote agent needs device credentials; its child shells do not.
// This is environment separation, not a sandbox against the same OS user.
const shellKeys = new Set([
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'PSMODULEPATH',
  'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'PROGRAMW6432', 'PROGRAMDATA', 'PUBLIC', 'OS', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'LANG', 'LC_ALL', 'TZ',
]);
export function shellEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && shellKeys.has(key.toUpperCase())));
}
