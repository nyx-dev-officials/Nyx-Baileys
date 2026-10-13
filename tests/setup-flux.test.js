import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVersions,
  dependencyCommand,
  flagValue,
  globalBinDirectory,
  meetsMinimum,
  minimumNodeVersion,
  npmCommandName,
  parseArguments,
  parseVersionParts,
  pathContains,
  powershellSingleQuoted,
  runtimeInstallCommands,
  shellDiscoveryCommand,
  spawnTarget,
  standardUnixBinDirectory,
  unixPathExport,
  usage,
  windowsPathUpdateCommand,
  windowsPathUpdateScript
} from '../scripts/setup-flux.mjs';

test('version comparison understands partial and prefixed versions', () => {
  assert.deepEqual(parseVersionParts('v20.17.0'), { major: 20, minor: 17, patch: 0 });
  assert.deepEqual(parseVersionParts('22'), { major: 22, minor: 0, patch: 0 });
  assert.equal(parseVersionParts('not-a-version'), null);
  assert.equal(compareVersions('20.17.0', '20.0'), 1);
  assert.equal(compareVersions('20.0.0', '20.0'), 0);
  assert.equal(compareVersions('18.20.8', '20.0'), -1);
  assert.equal(meetsMinimum('24.19.0', '20.0'), true);
});

test('setup reads the repository Node requirement instead of assuming one', () => {
  assert.equal(minimumNodeVersion({ engines: { node: '>=22.13' } }), '22.13');
  assert.equal(minimumNodeVersion({}), '20.0');
});

test('fresh locked checkouts use reproducible installs while edited trees do not', () => {
  assert.deepEqual(
    dependencyCommand({ lockfileExists: true, packageFilesClean: true }),
    ['ci', '--no-audit', '--no-fund']
  );
  assert.deepEqual(
    dependencyCommand({ lockfileExists: true, packageFilesClean: false }),
    ['install', '--no-audit', '--no-fund']
  );
  assert.deepEqual(
    dependencyCommand({ lockfileExists: false, packageFilesClean: true }),
    ['install', '--no-audit', '--no-fund']
  );
});

test('setup flags preserve safe defaults and accept explicit overrides', () => {
  const defaults = parseArguments([]);
  assert.equal(defaults.installDependencies, true);
  assert.equal(defaults.link, true);
  assert.equal(defaults.configurePath, true);
  assert.equal(defaults.globalMode, 'link');
  const overrides = parseArguments(['--no-link', '--global-mode=copy', '--dry-run']);
  assert.equal(overrides.link, false);
  assert.equal(overrides.globalMode, 'copy');
  assert.equal(overrides.dryRun, true);
  assert.equal(flagValue(['--global-mode', 'copy'], 'global-mode'), 'copy');
});

test('npm executable and global directory match each operating system', () => {
  assert.equal(npmCommandName('win32'), 'npm.cmd');
  assert.equal(npmCommandName('linux'), 'npm');
  assert.equal(globalBinDirectory('C:\\Users\\example\\AppData\\Roaming\\npm', 'win32'), 'C:\\Users\\example\\AppData\\Roaming\\npm');
  assert.equal(globalBinDirectory('/usr/local', 'linux'), '/usr/local/bin');
  assert.throws(() => globalBinDirectory('', 'linux'), /global prefix/);
});

test('PATH matching ignores case and separators on Windows', () => {
  assert.equal(pathContains('C:\\A;C:\\Users\\Example\\AppData\\Roaming\\npm\\', 'c:\\users\\example\\appdata\\roaming\\npm', 'win32'), true);
  assert.equal(pathContains('/usr/local/bin:/usr/bin', '/opt/bin', 'linux'), false);
});

test('Windows PATH registration is idempotent and notifies the shell', () => {
  const script = windowsPathUpdateScript('C:\\Users\\example\\AppData\\Roaming\\npm');
  assert.match(script, /\$normalized -notcontains \$wanted/);
  assert.match(script, /SetEnvironmentVariable\('Path', \(\$\w+ -join ';'\), 'User'\)/);
  assert.match(script, /SendMessageTimeout/);
  assert.match(script, /flux-path-changed/);
  assert.match(script, /flux-path-unchanged/);
  assert.equal(powershellSingleQuoted("O'Brien"), "'O''Brien'");
  const update = windowsPathUpdateCommand('C:\\Users\\example\\AppData\\Roaming\\npm');
  assert.equal(update.command, 'powershell.exe');
  assert.equal(update.args[0], '-NoProfile');
  assert.equal(update.args[4], '-EncodedCommand');
  assert.equal(update.args[5].length > 100, true);
});

test('runtime installers use supported package managers and do not claim Linux generically', () => {
  assert.equal(runtimeInstallCommands('win32').length, 1);
  assert.equal(runtimeInstallCommands('darwin')[0][0], 'brew');
  assert.equal(runtimeInstallCommands('linux', 'ID=ubuntu')[0][0], 'sudo');
  assert.deepEqual(runtimeInstallCommands('linux', 'ID=mystery-os'), []);
  assert.deepEqual(runtimeInstallCommands('sunos', ''), []);
});

test('command discovery and fallback PATH output are platform aware', () => {
  assert.deepEqual(shellDiscoveryCommand('win32'), { command: 'where', args: ['flux'] });
  assert.deepEqual(shellDiscoveryCommand('linux'), { command: 'sh', args: ['-lc', 'command -v flux'] });
  assert.equal(standardUnixBinDirectory('/usr/local/bin:/usr/bin'), '/usr/local/bin');
  assert.deepEqual(spawnTarget('npm.cmd', ['--version'], 'win32'), {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'npm.cmd', '--version']
  });
  assert.deepEqual(spawnTarget('where', ['flux'], 'win32'), {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'where', 'flux']
  });
  assert.deepEqual(spawnTarget('npm', ['--version'], 'linux'), { command: 'npm', args: ['--version'] });
  assert.equal(standardUnixBinDirectory('/opt/bin'), null);
  assert.equal(unixPathExport('/opt/flux/bin'), 'export PATH="/opt/flux/bin:$PATH"');
});

test('setup help gives the complete clone-to-command path', () => {
  assert.match(usage(), /npm run setup/);
  assert.match(usage(), /--install-runtime/);
  assert.match(usage(), /\bflux\b/);
});
