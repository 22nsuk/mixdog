#!/usr/bin/env node
// Local pre-push check. Mirrors the test legs of .github/workflows/release-gate.yml
// (jobs: runtime, runtime-slow, desktop, desktop-tests fast/slow). It MUST be
// updated together with that workflow whenever those commands change.
// Not covered locally: runtime-macos, computer-backend (cargo + Linux X11),
// desktop-tests `computer` lane (windows-latest, src/main/computer/ only),
// relay (apps/relay tests), graph (cargo test). The gate's path filtering is
// not applied: every leg always runs. Run `npm ci` (root and apps/desktop) first.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const started = Date.now();

const build = spawnSync('npm run build:spawn:test', { cwd: root, stdio: 'inherit', shell: true });
if (build.status !== 0) {
  console.error('[gate:local] build:spawn:test failed');
  process.exit(1);
}

const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixdog-gate-local-'));
const legs = [
  { name: 'runtime', cmds: ['npm test', 'npm run smoke:patch'] },
  { name: 'runtime-slow', cmds: ['npm run test:slow'] },
  { name: 'desktop-tests-fast', cmds: ['npm test --prefix apps/desktop'] },
  { name: 'desktop-tests-slow', cmds: ['npm run test:slow --prefix apps/desktop'] },
  { name: 'desktop', cmds: ['npm run build --prefix apps/desktop', 'npm run test:daemon:e2e --prefix apps/desktop'] },
];

function runCmd(cmd, logFd) {
  return new Promise((resolve) => {
    fs.writeSync(logFd, `\n$ ${cmd}\n`);
    const child = spawn(cmd, { cwd: root, shell: true, stdio: ['ignore', logFd, logFd] });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function runLeg(leg) {
  const t0 = Date.now();
  leg.log = path.join(logDir, `${leg.name}.log`);
  const fd = fs.openSync(leg.log, 'w');
  leg.ok = true;
  for (const cmd of leg.cmds) {
    if ((await runCmd(cmd, fd)) !== 0) {
      leg.ok = false;
      break;
    }
  }
  fs.closeSync(fd);
  leg.ms = Date.now() - t0;
}

console.log(`[gate:local] running ${legs.length} legs in parallel; logs: ${logDir}`);
await Promise.all(legs.map(runLeg));

console.log('\n=== gate:local summary ===');
for (const leg of legs) {
  console.log(`${leg.ok ? 'PASS' : 'FAIL'}  ${leg.name}  ${(leg.ms / 1000).toFixed(1)}s  ${leg.log}`);
  if (!leg.ok) {
    const lines = fs.readFileSync(leg.log, 'utf8').split(/\r?\n/).filter((l) => l.includes('[failure-summary]'));
    for (const l of lines) console.log(`    ${l}`);
  }
}
console.log('Not covered locally: runtime-macos, computer-backend, desktop-tests computer lane (Windows-only), relay, graph');
console.log(`Total: ${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exit(legs.every((l) => l.ok) ? 0 : 1);
