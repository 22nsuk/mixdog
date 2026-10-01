import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const DEV_DEBUG_PORT = 9342;
const desktopDir = fileURLToPath(new URL('..', import.meta.url));

export async function assertDebugPortAvailable(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Debug port must be an integer from 1 to 65535.');
  }
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      reject(new Error(
        `Cannot use test debug port ${port}: ${error.code}. ` +
        'Use the existing test app, or choose another port (--port for dev, -Port for E2E).',
        { cause: error },
      ));
    });
    server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export async function createIsolatedDevEnv(parent = process.env, profileParent = tmpdir()) {
  const profile = await mkdtemp(join(profileParent, 'mixdog-desktop-test-'));
  const env = { ...parent };
  // A shell launched by the installed daemon inherits its live data, bridge
  // and runtime paths. Overriding userData alone does not isolate that shell.
  for (const key of Object.keys(env)) {
    if (/^(MIXDOG_|ELECTRON_)/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    MIXDOG_DESKTOP_USER_DATA: profile,
    MIXDOG_HOME: join(profile, 'home'),
    MIXDOG_DATA_DIR: join(profile, 'data'),
    MIXDOG_RUNTIME_ROOT: join(profile, 'runtime'),
    MIXDOG_BRIDGE_DISCOVERY_DIR: join(profile, 'bridges'),
    MIXDOG_PROJECTS_FILE: join(profile, 'projects.json'),
    MIXDOG_DISABLE_PROJECT_MARKERS: '1',
  });
  await Promise.all(['home', 'data', 'runtime', 'bridges'].map(
    (directory) => mkdir(join(profile, directory)),
  ));
  return env;
}

async function main() {
  const { values } = parseArgs({
    options: {
      'env-json': { type: 'boolean', default: false },
      port: { type: 'string', default: String(DEV_DEBUG_PORT) },
    },
  });
  const port = Number(values.port);
  await assertDebugPortAvailable(port);
  const env = await createIsolatedDevEnv();
  if (values['env-json']) {
    console.log(JSON.stringify(env));
    return;
  }
  console.log(`Test profile: ${env.MIXDOG_DESKTOP_USER_DATA}`);
  console.log(`Test debug port: ${port}`);
  // Retain the profile for diagnosis. Do not remove files out from under
  // Electron or an isolated daemon that is still shutting down.
  const child = spawn(process.execPath, [
    join(desktopDir, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
    'dev', '--remoteDebuggingPort', String(port),
  ], { cwd: desktopDir, env, stdio: 'inherit' });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
