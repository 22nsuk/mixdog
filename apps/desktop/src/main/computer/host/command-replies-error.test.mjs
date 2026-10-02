import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandReplies } from './command-replies.ts';

test('an unavailable recapture carries trusted error metadata separately from reply text', async () => {
  const replies = createCommandReplies({
    sessionIdFor: () => 'fixture',
    invalidateActionTargets() {},
    freshObservedWindowScope: () => undefined,
    resolveRecaptureWindowTarget: async () => ({ windowId: '', error: 'no exact target' }),
    captureAfterAction: async () => assert.fail('do not capture an invented target'),
  });
  const result = await replies.recaptureRequiredReply(
    { action: 'clipboard_read' },
    new Error('computer_foreground_available_recapture_required: desktop lane changed')
  );
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.text).ok, false);
  assert.equal(result.image, undefined);
});
