import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { ensureOoxmlValidator, ooxmlValidatorManifest } from './ooxml-validator.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-validator-cache-'));
  const names = ['MIXDOG_TEST_OOXML_CACHE_DIR', 'MIXDOG_OOXML_VALIDATOR_CLI', 'MIXDOG_OOXML_VALIDATOR_DISABLED'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.MIXDOG_TEST_OOXML_CACHE_DIR = join(root, 'shared');
  t.after(async () => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(root, { recursive: true, force: true });
  });
  const binary = join(
    root,
    'shared',
    'office',
    'tools',
    'ooxml-validator',
    ooxmlValidatorManifest().version,
    `${process.platform}-${process.arch}`,
    process.platform === 'win32' ? 'ooxml-validator.exe' : 'ooxml-validator'
  );
  return { root, binary, first: join(root, 'session-a'), second: join(root, 'session-b') };
}

test('isolated document sessions reuse the same cached validator without a network request', async (t) => {
  const { first, second, binary } = await fixture(t);
  const missing = await ensureOoxmlValidator({ dataDir: first, download: false });
  assert.equal(missing.downloadRequired, true);
  await mkdir(dirname(binary), { recursive: true });
  await writeFile(binary, Buffer.alloc(1024 * 1024 + 1));
  t.mock.method(globalThis, 'fetch', () => assert.fail('a cached tool must not be downloaded'));
  const results = await Promise.all(
    [first, second].map((dataDir) => ensureOoxmlValidator({ dataDir, download: false }))
  );
  for (const result of results) {
    assert.equal(result.available, true);
    assert.equal(result.cached, true);
    assert.equal(result.downloaded, false);
    assert.equal(result.path, binary);
  }
  delete process.env.MIXDOG_TEST_OOXML_CACHE_DIR;
  const isolated = await ensureOoxmlValidator({ dataDir: first, download: false });
  assert.equal(isolated.downloadRequired, true, 'the application cache is not redirected outside tests');
});

test('shared caches preserve disabled validation and explicit validator paths', async (t) => {
  const { root, first } = await fixture(t);
  process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';
  assert.equal((await ensureOoxmlValidator({ dataDir: first })).disabled, true);
  const override = join(root, 'custom-validator');
  await writeFile(override, '');
  process.env.MIXDOG_OOXML_VALIDATOR_CLI = override;
  const result = await ensureOoxmlValidator({ dataDir: first });
  assert.equal(result.path, override);
  assert.equal(result.version, 'override');
});

test('a corrupt download fails integrity validation and leaves no executable or install lock', async (t) => {
  const { first, binary } = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => new Response('not the pinned archive'));
  await assert.rejects(ensureOoxmlValidator({ dataDir: first }), /integrity check failed/);
  assert.deepEqual(await readdir(dirname(binary)), []);
  assert.equal((await ensureOoxmlValidator({ dataDir: first, download: false })).downloadRequired, true);
});
