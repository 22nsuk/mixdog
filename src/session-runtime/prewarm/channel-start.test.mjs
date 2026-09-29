import assert from 'node:assert/strict';
import test from 'node:test';
import { createChannelStart } from './channel-start.mjs';

test('rescheduling automation autostart cancels the pending timer instead of leaking it', async () => {
  let probes = 0;
  const timers = {};
  const { scheduleAutomationAutostart } = createChannelStart({
    timers,
    bootProfile() {},
    isCloseRequested: () => false,
    hasActiveAutomation: async () => {
      probes += 1;
      return false;
    },
    channels: { start: async () => {} },
    envFlag: () => false,
    delays: { channelStartDelayMs: 0, backgroundBusyRetryMs: 0 },
    state: { channelStartPromise: null },
  });
  scheduleAutomationAutostart(20);
  scheduleAutomationAutostart(20);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(probes, 1);
});
