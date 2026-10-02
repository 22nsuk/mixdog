import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { notificationSoundPath } from './notification-sound.ts';

test('Windows sound paths resolve to unpacked WAV assets, never inside an ASAR', () => {
  const root = resolve('notification-sound-fixture');
  assert.equal(
    notificationSoundPath({ packaged: true, resourcesPath: root, appPath: 'unused' }),
    resolve(root, 'app.asar.unpacked/out/renderer/notification-sounds/soft-rise.wav')
  );
  assert.equal(
    notificationSoundPath({ packaged: false, resourcesPath: 'unused', appPath: root }),
    resolve(root, 'src/renderer/public/notification-sounds/soft-rise.wav')
  );
});

for (const [name, duration] of [
  ['soft-rise', 0.68],
  ['warm-fall', 0.56],
  ['wood-tap', 0.45],
  ['air-chime', 0.8],
  ['round-pop', 0.48],
  ['tiny-pluck', 0.36],
  ['soft-bloom', 0.94],
  ['felt-pulse', 0.5],
  ['soft-rise-low', 0.68],
  ['soft-rise-light', 0.6],
  ['soft-rise-close', 0.66],
  ['soft-rise-relaxed', 0.82],
]) {
  test(`${name} is a short, nonclipping PCM WAV with silent boundaries`, async () => {
    const wav = await readFile(new URL(`../renderer/public/notification-sounds/${name}.wav`, import.meta.url));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt16LE(20), 1);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), 44100);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), Math.round(duration * 44100) * 2);
    assert.equal(wav.length, 44 + Math.round(duration * 44100) * 2);
    const samples = [];
    for (let i = 44; i < wav.length; i += 2) samples.push(wav.readInt16LE(i));
    assert.equal(samples[0], 0);
    assert.equal(samples.at(-1), 0);
    assert.ok(Math.max(...samples.map(Math.abs)) <= 0.24 * 32767);
    const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length) / 32767;
    assert.ok(rms > 0.01 && rms < 0.15);
    assert.ok(Math.abs(samples.reduce((sum, value) => sum + value, 0) / samples.length) < 30);
  });
}
