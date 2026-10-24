import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const root = process.argv[2];
for (const [name, percent, apply] of [['before-saved', 30, false], ['after-saved', 75, false], ['before-edit', 100, false], ['after-edit', 100, true]]) {
  const result = JSON.parse(await readFile(`${root}/${name}.json`, 'utf8'));
  assert.equal(result.sliderPercent, percent);
  assert.equal(result.applyPresent, apply);
  if (apply) assert.equal(result.applyDisabled, false);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.blockedNetworkRequests, []);
  const png = await readFile(`${root}/${name}.png`);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  console.log(`${name}: ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}, percent=${percent}, apply=${apply}`);
}
