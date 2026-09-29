// Shared bounded child-process runner behind the dependency probes and guided
// installs (git, gh, LibreOffice): a hard timeout, the daemon's child
// environment, and ENOENT flattened to code -1 so callers can tell a missing
// binary apart from a failing one.
import { execFile } from 'node:child_process';

import { childEnvironment } from './child-environment';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Guided install of one dependency: winget on Windows, brew on macOS; every
 *  other platform throws `unsupported`. Rejects with the manager's last output
 *  line when it fails, and says so when the manager itself is missing. */
export async function installWithPackageManager(spec: {
  label: string;
  homepage: string;
  wingetId: string;
  brewArgs: string[];
  timeoutMs: number;
  unsupported: string;
}): Promise<void> {
  let manager: 'winget' | 'brew';
  let managerName: string;
  let result: RunResult;
  if (process.platform === 'win32') {
    manager = 'winget';
    managerName = 'winget';
    result = await run(
      'winget',
      [
        'install',
        '--id',
        spec.wingetId,
        '--exact',
        '--source',
        'winget',
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--disable-interactivity',
      ],
      spec.timeoutMs
    );
  } else if (process.platform === 'darwin') {
    manager = 'brew';
    managerName = 'Homebrew';
    result = await run('brew', spec.brewArgs, spec.timeoutMs);
  } else {
    throw new Error(spec.unsupported);
  }
  if (result.code === -1) {
    throw new Error(`${managerName} is unavailable. Install ${spec.label} from ${spec.homepage} and try again.`);
  }
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split('\n').filter(Boolean).pop();
    throw new Error(`${manager} could not install ${spec.label}: ${detail || `exit code ${result.code}`}`);
  }
}

export function run(file: string, args: string[], timeout = 15_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout,
        windowsHide: true,
        env: childEnvironment(),
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
          return;
        }
        const failure = error as NodeJS.ErrnoException;
        if (failure.code === 'ENOENT') {
          resolve({ code: -1, stdout: '', stderr: 'ENOENT' });
          return;
        }
        resolve({
          code: typeof failure.code === 'number' ? failure.code : 1,
          stdout: String(stdout || ''),
          stderr: String(stderr || '') || failure.message,
        });
      }
    );
  });
}
