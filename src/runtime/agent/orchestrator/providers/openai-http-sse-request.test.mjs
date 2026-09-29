import assert from 'node:assert/strict';
import { test } from 'node:test';
import zlib from 'node:zlib';

import { openHttpSseResponse } from './openai-http-sse-request.mjs';

test('a zstd 400 on the last attempt still replays uncompressed and surfaces a real response', {
  skip: typeof zlib.zstdCompressSync !== 'function',
}, async () => {
  const seen = [];
  const fetchFn = async (_url, init) => {
    const compressed = init.headers['Content-Encoding'] === 'zstd';
    seen.push(compressed);
    if (compressed && seen.length <= 4) return new Response('boom', { status: 503 });
    if (compressed) return new Response('bad encoding', { status: 400 });
    return new Response('data: {}\n\n', { status: 200 });
  };
  const response = await openHttpSseResponse({
    auth: { type: 'openai-oauth' },
    body: { input: 'x'.repeat(16 * 1024) },
    headers: {},
    poolKey: 'zstd-last-attempt',
    turnId: 'turn',
    useModel: 'test-model',
    fetchFn,
    totalTimeout: new (class {
      signal = new AbortController().signal;
      cleanup() {}
    })(),
    _sleepFn: async () => {},
  });
  assert.equal(response.status, 200);
  assert.deepEqual(seen, [true, true, true, true, true, false]);
});
