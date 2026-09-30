import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTIVITY_RAIL_PINS_EVENT } from '../shared/activity-rail-pins.ts';
import { createRemoteApi } from './remote-shim-api.ts';
import { publishedCeilings, withShim } from './remote-shim-test-harness.mjs';

test('paired web pins use the real encrypted request and notification paths', async () => {
  await withShim({}, async ({ ctx, dial }) => {
    const api = createRemoteApi(ctx);
    const leg = await dial({ ready: publishedCeilings(4096, 4096) });
    const received = [];
    const unsubscribe = api.subscribeActivityRailPins((state) => received.push(state));
    const initial = { pins: ['projects', 'sessions'], revision: 1 };
    const reading = api.readActivityRailPins();
    const read = await leg.nextPayload();
    assert.equal(read.method, 'readActivityRailPins');
    await leg.deliver({ id: read.id, ok: true, value: initial });
    assert.deepEqual(await reading, initial);
    const saving = api.updateActivityRailPins(['search', 'projects']);
    const update = await leg.nextPayload();
    assert.equal(update.method, 'updateActivityRailPins');
    assert.deepEqual(update.params, [['search', 'projects']]);
    const saved = { pins: ['search', 'projects'], revision: 2 };
    await leg.deliver({ id: update.id, ok: true, value: saved });
    assert.deepEqual(await saving, saved);
    ctx.handleMessage({ event: ACTIVITY_RAIL_PINS_EVENT, payload: saved }, false);
    assert.deepEqual(received, [], 'clear relay hints cannot change pin preferences');
    await leg.deliver({ event: ACTIVITY_RAIL_PINS_EVENT, payload: saved });
    assert.deepEqual(received, [saved]);
    await leg.deliver({ event: ACTIVITY_RAIL_PINS_EVENT, payload: { pins: ['unknown'], revision: 3 } });
    assert.deepEqual(received, [saved]);
    unsubscribe();
    await leg.deliver({ event: ACTIVITY_RAIL_PINS_EVENT, payload: { pins: [], revision: 3 } });
    assert.deepEqual(received, [saved]);
  });
});
