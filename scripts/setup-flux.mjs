#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

export const MINIMUM_NPM_MAJOR = 10;
export const COMMAND_TIMEOUT_MS = 300000;
export const GLOBAL_COMMAND = 'flux';

export function parseVersionParts(value) {
  const match = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(value ?? ''));
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0)
  };
}

export function compareVersions(actual, minimum) {
  const current = parseVersionParts(actual);
  const required = parseVersionParts(minimum);
  if (!current || !required) return Number.NaN;
  for (const part of ['major', 'minor', 'patch']) {
    if (current[part] !== required[part]) return current[part] > required[part] ? 1 : -1;
  }
  return 0;
}

export function meetsMinimum(actual, minimum) {
  return compareVersions(actual, minimum) >= 0;
}

export function minimumNodeVersion(packageJson = {}) {
  const engines = packageJson.engines ?? {};
  const match = />=\s*v?(\d+(?:\.\d+){0,2})/.exec(String(engines.node ?? '>=20'));
  const version = match ? match[1] : '20';
  return version.includes('.') ? version : `${version}.0`;
}

export function hasFlag(argv, name) {
  return argv.includes(`--${name}`);
}

export function flagValue(argv, name, fallback = null) {
  const prefix = `--${name}=`;
  const direct = argv.find((item) => item.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < argv.length && !argv[index + 1].startsWith('--')) {
    return argv[index + 1];
  }
  return fallback;
}

export function parseArguments(argv = []) {
  return {
    check: hasFlag(argv, 'check'),
    dryRun: hasFlag(argv, 'dry-run'),
    help: hasFlag(argv, 'help'),
    installDependencies: !hasFlag(argv, 'no-install'),
    build: !hasFlag(argv, 'no-build'),
    checkExports: !hasFlag(argv, 'no-check-exports'),
    link: !hasFlag(argv, 'no-link'),
    configurePath: !hasFlag(argv, 'no-path'),
    installRuntime: hasFlag(argv, 'install-runtime'),
    allowSudo: hasFlag(argv, 'allow-sudo'),
    globalMode: flagValue(argv, 'global-mode', 'link')
  };
}

export function npmCommandName(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function dependencyCommand({ lockfileExists, packageFilesClean }) {
  if (lockfileExists && packageFilesClean) return ['ci', '--no-audit', '--no-fund'];
  return ['install', '--no-audit', '--no-fund'];
}

export function spawnTarget(command, args = [], platform = process.platform) {
  if (platform === 'win32' && (command === 'npm.cmd' || command === 'where')) {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', command, ...args] };
  }
  return { command, args };
}

export function runCommand(command, args, { cwd, platform = process.platform, timeout = COMMAND_TIMEOUT_MS } = {}) {
  const target = spawnTarget(command, args, platform);
  const result = spawnSync(target.command, target.args, {
    cwd,
    shell: false,
    timeout,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return {
    status: typeof result.status === 'number' ? result.status : 1,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    error: result.error ? String(result.error?.message ?? result.error) : null
  };
}

export function runtimeInstallCommands(platform, osRelease = '') {
  if (platform === 'win32') {
    return [['winget', 'install', '--exact', '--id', 'OpenJS.NodeJS.LTS', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements']];
  }
  if (platform === 'darwin') {
    return [['brew', 'install', 'node']];
  }
  if (platform === 'linux') {
    const release = osRelease.toLowerCase();
    if (release.includes('ubuntu') || release.includes('debian')) {
      return [
        ['sudo', 'apt-get', 'update'],
        ['sudo', 'apt-get', 'install', '-y', 'apt-transport-https', 'ca-certificates', 'curl', 'gnupg'],
        ['sudo', 'mkdir', '-p', '/usr/share/keyrings'],
        ['bash', '-c', 'curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/nodesource.gpg && sudo chmod 644 /usr/share/keyrings/nodesource.gpg'],
        ['bash', '-c', 'echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null'],
        ['sudo', 'apt-get', 'update'],
        ['sudo', 'apt-get', 'install', '-y', 'nodejs']
      ];
    }
    if (release.includes('fedora')) return [['sudo', 'dnf', 'install', '-y', 'nodejs', 'npm', 'git']];
    if (release.includes('arch')) return [['sudo', 'pacman', '-S', '--needed', '--noconfirm', 'nodejs', 'npm', 'git']];
    return [];
  }
  return [];
}

export function pathDelimiter(platform = process.platform) {
  return platform === 'win32' ? ';' : ':';
}

export function globalBinDirectory(prefix, platform = process.platform) {
  const clean = String(prefix ?? '').trim().replace(/["'\s]+$/, '').replace(/[\\/]+$/, '');
  if (!clean) throw new Error('npm did not report a global prefix.');
  if (platform === 'win32') return clean;
  return `${clean}/bin`;
}

export function normalizePathEntry(value, platform = process.platform) {
  const text = String(value ?? '').replace(/[\\/]+$/, '');
  return platform === 'win32' ? text.toLowerCase() : text;
}

export function pathContains(pathValue, directory, platform = process.platform) {
  const target = normalizePathEntry(directory, platform);
  if (!target) return false;
  return String(pathValue ?? '')
    .split(pathDelimiter(platform))
    .map((entry) => normalizePathEntry(entry, platform))
    .some((entry) => entry === target);
}

export function powershellSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function windowsPathUpdateScript(binDirectory) {
  const target = powershellSingleQuoted(binDirectory);
  return [
    '$target = ' + target,
    '$current = [Environment]::GetEnvironmentVariable(\'Path\', \'User\')',
    '$entries = @($current -split \';\' | Where-Object { $_.Trim() -ne \'\' })',
    '$normalized = $entries | ForEach-Object { $_.TrimEnd(\'\\\').ToLowerInvariant() }',
    '$wanted = $target.TrimEnd(\'\\\').ToLowerInvariant()',
    '$changed = $false',
    'if ($normalized -notcontains $wanted) {',
    '  $entries += $target',
    '  [Environment]::SetEnvironmentVariable(\'Path\', ($entries -join \';\'), \'User\')',
    '  $changed = $true',
    '}',
    'Add-Type -TypeDefinition @\'',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class FluxPathBroadcast {',
    '  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]',
    '  private static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);',
    '  public static void Broadcast() {',
    '    UIntPtr result;',
    '    SendMessageTimeout(new IntPtr(0xffff), 0x001A, UIntPtr.Zero, "Environment", 0x0002, 5000, out result);',
    '  }',
    '}',
    '\'@',
    '[FluxPathBroadcast]::Broadcast()',
    'if ($changed) { Write-Output \'flux-path-changed\' } else { Write-Output \'flux-path-unchanged\' }'
  ].join('\r\n');
}

export function windowsPathUpdateCommand(binDirectory) {
  const encoded = Buffer.from(windowsPathUpdateScript(binDirectory), 'utf16le').toString('base64');
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]
  };
}

export function shellDiscoveryCommand(platform = process.platform) {
  if (platform === 'win32') return { command: 'where', args: [GLOBAL_COMMAND] };
  return { command: 'sh', args: ['-lc', `command -v ${GLOBAL_COMMAND}`] };
}

export function firstOutputLine(output) {
  const line = String(output ?? '').split(/\r?\n/).map((item) => item.trim()).find((item) => item.length > 0);
  return line ?? '';
}

export function unixPathExport(binDirectory) {
  return `export PATH="${String(binDirectory).replace(/"/g, '\\"')}:$PATH"`;
}

export function standardUnixBinDirectory(pathValue = process.env.PATH ?? '') {
  const candidate = '/usr/local/bin';
  return pathContains(pathValue, candidate, 'linux') ? candidate : null;
}

export function canWrite(path, { access = accessSync } = {}) {
  try {
    access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function createExecutableSymlink(target, linkPath, { unlink = unlinkSync, symlink = symlinkSync } = {}) {
  try {
    unlink(linkPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  symlink(target, linkPath);
  return linkPath;
}

function readPackageJson(root) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
}

function lockfileExists(root) {
  return existsSync(join(root, 'package-lock.json'));
}

function packageFilesClean(root, runner = runCommand) {
  try {
    const result = runner('git', ['status', '--porcelain', '--', 'package.json', 'package-lock.json'], { cwd: root });
    return result.status === 0 && result.stdout.trim() === '';
  } catch {
    return false;
  }
}

function fail(message) {
  const error = new Error(message);
  error.exitCode = 1;
  throw error;
}

function checkExecutable(command, args, runner = runCommand) {
  const result = runner(command, args, {});
  if (result.status !== 0) {
    const detail = firstOutputLine(result.stderr) || firstOutputLine(result.stdout) || result.error || 'command failed';
    fail(`${command} is unavailable: ${detail}`);
  }
  return firstOutputLine(result.stdout);
}

function printStep(title, detail = '') {
  process.stdout.write(`\n== ${title} ==\n`);
  if (detail) process.stdout.write(`${detail}\n`);
}

function printCommand(command, args) {
  process.stdout.write(`$ ${[command, ...args].join(' ')}\n`);
}

export function usage() {
  return [
    'Set up this checkout so the global flux command works.',
    '',
    'Usage:',
    '  npm run setup [-- --check] [-- --dry-run]',
    '',
    'Fresh-machine flow:',
    '  git clone <repository>',
    '  cd Nyx-Baileys',
    '  npm run setup -- --install-runtime',
    '  flux',
    '',
    'Options:',
    '  --check                 Report setup state without changing anything.',
    '  --dry-run               Show planned commands without running them.',
    '  --install-runtime       Allow supported OS package managers to install Node.js.',
    '  --allow-sudo            Allow a Unix fallback symlink requiring elevated access.',
    '  --global-mode=link|copy Select global installation behavior; link is the default.',
    '  --no-install            Skip npm dependency installation.',
    '  --no-build              Skip TypeScript compilation.',
    '  --no-check-exports      Skip post-build export verification.',
    '  --no-link               Skip global command linking.',
    '  --no-path               Skip shell PATH registration.'
  ].join('\n');
}

function ensureRuntime(options, context) {
  const minimum = minimumNodeVersion(context.packageJson);
  if (!meetsMinimum(process.versions.node, minimum)) {
    if (!options.installRuntime) {
      fail(`Node.js ${minimum} or newer is required; detected ${process.versions.node}. Install Node.js LTS, then run npm run setup again.`);
    }
    installRuntime(options, context);
    fail('Installed the JavaScript runtime. Close and reopen the terminal, then run npm run setup again.');
  }
  try {
    const version = checkExecutable(options.npmCommand, ['--version']);
    const major = Number((parseVersionParts(version) ?? {}).major ?? 0);
    if (Number.isFinite(major) && major < MINIMUM_NPM_MAJOR) {
      fail(`npm 10 or newer is required; detected ${version}. Upgrade Node.js LTS, then run npm run setup again.`);
    }
  } catch (error) {
    if (!options.installRuntime) throw error;
    installRuntime(options, context);
    fail('Installed the JavaScript runtime. Close and reopen the terminal, then run npm run setup again.');
  }
}

function installRuntime(options, context) {
  const commands = runtimeInstallCommands(context.platform, context.osRelease);
  if (commands.length === 0) {
    fail(`Automatic Node.js installation is unavailable on ${context.platform}. Install Node.js 20 LTS manually, then run npm run setup again.`);
  }
  for (const [command, ...args] of commands) {
    printCommand(command, args);
    if (options.dryRun) continue;
    const result = context.runner(command, args, { cwd: context.root });
    if (result.status !== 0) {
      if (result.error && /ENOENT|not found/i.test(result.error)) {
        fail(`${command} is unavailable. Install that package manager or install Node.js 20 LTS manually, then run npm run setup again.`);
      }
      const detail = firstOutputLine(result.stderr) || 'runtime installation failed';
      fail(detail);
    }
  }
}

function installDependencies(options, context) {
  if (!options.installDependencies) return;
  const command = dependencyCommand({
    lockfileExists: lockfileExists(context.root),
    packageFilesClean: packageFilesClean(context.root, context.runner)
  });
  printStep('Install project dependencies', 'Uses npm ci on a clean locked checkout; otherwise npm install.');
  printCommand(options.npmCommand, command);
  if (options.dryRun) return;
  const result = context.runner(options.npmCommand, command, { cwd: context.root });
  if (result.status !== 0) fail(firstOutputLine(result.stderr) || 'Dependency installation failed.');
}

function buildProject(options, context) {
  if (!options.build) return;
  printStep('Build the CLI', 'The global launcher executes compiled output in dist.');
  printCommand(options.npmCommand, ['run', 'build']);
  if (options.dryRun) return;
  const result = context.runner(options.npmCommand, ['run', 'build'], { cwd: context.root });
  if (result.status !== 0) fail(firstOutputLine(result.stderr) || 'TypeScript build failed.');
}

function verifyExports(options, context) {
  if (!options.checkExports) return;
  printStep('Verify published entry points');
  printCommand('node', ['scripts/check-exports.mjs']);
  if (options.dryRun) return;
  const result = context.runner('node', ['scripts/check-exports.mjs'], { cwd: context.root });
  if (result.status !== 0) fail(firstOutputLine(result.stderr) || 'Export verification failed.');
}

function installGlobalCommand(options, context) {
  if (!options.link) return null;
  const command = options.globalMode === 'copy' ? ['install', '-g', '.', '--no-audit', '--no-fund'] : ['link'];
  printStep(options.globalMode === 'copy' ? 'Install a global copy' : 'Link the global command', 'flux resolves from any working directory after this step.');
  printCommand(options.npmCommand, command);
  if (options.dryRun) return null;
  const result = context.runner(options.npmCommand, command, { cwd: context.root });
  if (result.status !== 0) {
    const detail = firstOutputLine(result.stderr) || 'Global installation failed.';
    fail(`${detail} On Windows, retry from an elevated shell if necessary.`);
  }
  const prefixResult = context.runner(options.npmCommand, ['prefix', '-g'], { cwd: context.root });
  if (prefixResult.status !== 0) fail('npm did not report a global prefix.');
  return firstOutputLine(prefixResult.stdout);
}

function updateWindowsPath(options, context, prefix) {
  const binDirectory = globalBinDirectory(prefix, 'win32');
  const update = windowsPathUpdateCommand(binDirectory);
  printStep('Register the global command directory', binDirectory);
  process.stdout.write(`$ powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <${update.args[5].length}-character payload>\n`);
  if (options.dryRun) return { binDirectory, changed: false, inspected: false };
  const result = context.runner(update.command, update.args, { cwd: context.root });
  if (result.status !== 0) fail(firstOutputLine(result.stderr) || 'Windows PATH registration failed.');
  const changed = result.stdout.includes('flux-path-changed');
  if (changed && !pathContains(process.env.PATH, binDirectory, 'win32')) {
    process.env.PATH = `${process.env.PATH};${binDirectory}`;
  }
  return { binDirectory, changed, inspected: true };
}

function updateUnixPath(options, context, prefix) {
  const binDirectory = globalBinDirectory(prefix, context.platform);
  printStep('Register the global command directory', binDirectory);
  if (options.dryRun) return { binDirectory };
  if (pathContains(process.env.PATH, binDirectory, context.platform)) return { binDirectory };
  const fallback = standardUnixBinDirectory(process.env.PATH ?? '');
  if (fallback && fallback !== binDirectory && canWrite(fallback)) {
    createExecutableSymlink(join(binDirectory, GLOBAL_COMMAND), join(fallback, GLOBAL_COMMAND));
    return { binDirectory };
  }
  if (fallback && fallback !== binDirectory && options.allowSudo) {
    const result = context.runner('sudo', ['ln', '-sf', join(binDirectory, GLOBAL_COMMAND), join(fallback, GLOBAL_COMMAND)], { cwd: context.root });
    if (result.status !== 0) fail('Could not create a fallback flux symlink with sudo.');
    return { binDirectory };
  }
  fail(`Add the global npm directory to PATH, then reopen the terminal:\n${unixPathExport(binDirectory)}`);
}

function configureCommandPath(options, context, prefix) {
  if (!options.configurePath) return null;
  if (!prefix) return null;
  if (context.platform === 'win32') return updateWindowsPath(options, context, prefix);
  return updateUnixPath(options, context, prefix);
}

function verifyCommand(options, context) {
  if (options.dryRun) return null;
  const probe = shellDiscoveryCommand(context.platform);
  printStep('Verify global command discovery');
  printCommand(probe.command, probe.args);
  const result = context.runner(probe.command, probe.args, { cwd: context.root });
  if (result.status !== 0) fail('flux was installed but the shell cannot resolve it. Open a new terminal and retry.');
  const location = firstOutputLine(result.stdout);
  process.stdout.write(`flux resolves to ${location || 'an installed command'}\n`);
  if (context.platform === 'win32' && !pathContains(process.env.PATH, dirname(location), 'win32') && location) {
    process.stdout.write('The running shell inherited an older PATH. A new terminal will use the registered value.\n');
  }
  return location;
}

function reportCheck(context) {
  const packageJson = readPackageJson(context.root);
  const minimum = minimumNodeVersion(packageJson);
  const nodeOk = meetsMinimum(process.versions.node, minimum);
  let npmVersion = null;
  try {
    npmVersion = checkExecutable(npmCommandName(context.platform), ['--version'], context.runner);
  } catch {
    npmVersion = null;
  }
  const built = existsSync(join(context.root, 'dist', 'index.js')) && existsSync(join(context.root, 'dist', 'cli', 'wizard.js'));
  let prefix = null;
  try {
    const result = context.runner(npmCommandName(context.platform), ['prefix', '-g'], { cwd: context.root });
    if (result.status === 0) prefix = firstOutputLine(result.stdout);
  } catch {
    prefix = null;
  }
  let discoverable = false;
  try {
    const probe = shellDiscoveryCommand(context.platform);
    discoverable = context.runner(probe.command, probe.args, { cwd: context.root }).status === 0;
  } catch {
    discoverable = false;
  }
  const binDirectory = prefix ? globalBinDirectory(prefix, context.platform) : null;
  const pathReady = Boolean(binDirectory && pathContains(process.env.PATH, binDirectory, context.platform));
  process.stdout.write([
    `Node ${process.versions.node} meets ${minimum}: ${nodeOk ? 'yes' : 'no'}`,
    `npm: ${npmVersion ?? 'unavailable'}`,
    `TypeScript output present: ${built ? 'yes' : 'no'}`,
    `Global npm directory: ${binDirectory ?? 'unknown'}`,
    `Global directory on PATH: ${pathReady ? 'yes' : 'no'}`,
    `flux discoverable: ${discoverable ? 'yes' : 'no'}`
  ].join('\n') + '\n');
  return nodeOk && npmVersion && built && pathReady && discoverable ? 0 : 1;
}

export async function setupFlux(argv = process.argv.slice(2), context = {}) {
  const options = { ...parseArguments(argv) };
  const root = context.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const runner = context.runner ?? runCommand;
  const fullContext = {
    root,
    runner,
    platform: context.platform ?? process.platform,
    osRelease: context.osRelease ?? '',
    packageJson: context.packageJson ?? readPackageJson(root),
    npmCommand: npmCommandName(context.platform ?? process.platform)
  };
  options.npmCommand = fullContext.npmCommand;
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (options.check) return reportCheck(fullContext);
  ensureRuntime(options, fullContext);
  installDependencies(options, fullContext);
  buildProject(options, fullContext);
  verifyExports(options, fullContext);
  const prefix = installGlobalCommand(options, fullContext);
  configureCommandPath(options, fullContext, prefix);
  verifyCommand(options, fullContext);
  if (!options.dryRun && fullContext.platform === 'win32') {
    process.stdout.write('\nWindows shells started before this setup keep the old PATH. Use a new terminal shell for flux.\n');
  }
  process.stdout.write('\nSetup complete. Run flux from any directory.\n');
  return 0;
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  setupFlux().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error?.message ?? error}\n`);
      process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
    }
  );
}
