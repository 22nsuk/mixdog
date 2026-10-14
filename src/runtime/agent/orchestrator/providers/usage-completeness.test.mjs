import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Only the transport is a fixture. Use production stream consumers, adapter
// result builders, loop accumulation and delegation projection end to end.
const root = mkdtempSync(join(tmpdir(), 'mixdog-adapter-usage-'));
process.env.MIXDOG_DATA_DIR = root;
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
process.on('exit', () => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
const { consumeCompatChatCompletionStream, consumeCompatResponsesStream } = await import(
  './openai-compat-stream.mjs'
);
const { normalizeCompatChatResponse, normalizeXaiResponsesHttp, responsesUsage } = await import(
  './openai-compat-response-normalization.mjs'
);
const { parseResponsesToolCalls, responseOutputText } = await import('./openai-compat-wire.mjs');
const { sendViaHttpSse } = await import('./openai-oauth-http-sse.mjs');
const { createWsResponseState } = await import('./openai-ws-response-state.mjs');
const { parseSSEStream } = await import('./anthropic-sse.mjs');
const { buildAnthropicTurnResult } = await import('./anthropic-turn-result.mjs');
const { normalizeAnthropicNonStreamingResponse } = await import('./lib/anthropic-request-utils.mjs');
const { toInclusiveOpenCodeGoUsage } = await import('./opencode-go.mjs');
const { consumeGeminiRestStreamResponse, consumeGeminiSdkStream } = await import('./gemini-stream.mjs');
const { parseGeminiCandidate, resolveGeminiUsage, geminiSendResult, geminiFailureUsage } = await import(
  './gemini-response.mjs'
);
const { createAntigravityStreamCollector } = await import('./antigravity-stream.mjs');
const { finalizeAntigravityTurn } = await import('./antigravity-response.mjs');
const { processServerMessage } = await import('./cursor-wire-stream-messages.mjs');
const { encodeMessage } = await import('./cursor-wire-protobuf.mjs');
const { createStreamSink, cursorUsage } = await import('./cursor-wire-stream-sink.mjs');
const { makeUsageRecord } = await import('../../../shared/llm/usage-ledger.mjs');
const { addUsage } = await import('../session/loop/usage.mjs');
const { beginDelegationObservation, finishDelegationObservation } = await import(
  '../../../../session-runtime/services/agent-tool/delegation-observation.mjs'
);
const stream = async function* (events) {
  yield* events;
};
const sse = (events) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
const anthropicEvents = (usage, revisions = []) => [
  { type: 'message_start', message: { model: 'fixture', usage } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'fixture answer' } },
  { type: 'content_block_stop', index: 0 },
  ...revisions.map((usage) => ({ type: 'message_delta', delta: {}, usage })),
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  { type: 'message_stop' },
];
const anthropic = async (usage, revisions) =>
  parseSSEStream(sse(anthropicEvents(usage, revisions)), null, null, null, null, {});
const anthropicResult = (parsed) =>
  buildAnthropicTurnResult(parsed, { provider: 'anthropic', useModel: 'fixture', opts: {} });
const geminiChunk = (usageMetadata) => ({
  candidates: [{ content: { parts: [{ text: 'fixture answer' }] }, finishReason: 'STOP' }],
  usageMetadata,
});
async function gemini(usageMetadata, sdk = false) {
  const chunk = geminiChunk(usageMetadata);
  const response = sdk
    ? await consumeGeminiSdkStream(
        { stream: stream([chunk]), response: Promise.resolve({}) },
        { label: 'fixture' }
      )
    : await consumeGeminiRestStreamResponse(sse([chunk]), { label: 'fixture' });
  return geminiSendResult(
    parseGeminiCandidate(response),
    'fixture',
    {},
    resolveGeminiUsage(response, {}, null, 'fixture')
  );
}
function observed(usages) {
  const job = { meta: {} };
  beginDelegationObservation(job);
  finishDelegationObservation(job, 'completed', {
    usage: usages.reduce((total, usage) => addUsage(total, usage || {}), null),
  });
  return [job.meta.delegation.inputTokens, job.meta.delegation.outputTokens];
}
const routes = [
  [
    'Chat Completions stream',
    async (usage) => {
      const assembled = await consumeCompatChatCompletionStream(
        stream([
          { choices: [{ delta: { content: 'fixture answer' }, finish_reason: 'stop' }] },
          { choices: [], usage },
        ]),
        { label: 'fixture', providerName: 'openrouter' }
      );
      return normalizeCompatChatResponse({
        providerName: 'openrouter',
        useModel: 'fixture',
        opts: {},
        params: {},
        tools: [],
        assembled,
      });
    },
    'prompt_tokens',
    'completion_tokens',
  ],
  [
    'Responses compat stream',
    async (usage) => {
      const assembled = await consumeCompatResponsesStream(
        stream([
          {
            type: 'response.completed',
            response: { id: 'fixture', status: 'completed', model: 'fixture', output: [], usage },
          },
        ]),
        { label: 'fixture', parseResponsesToolCalls, responseOutputText }
      );
      return normalizeXaiResponsesHttp({
        messages: [],
        useModel: 'fixture',
        tools: [],
        opts: {},
        params: {},
        response: assembled.response,
        streamed: assembled,
      });
    },
    'input_tokens',
    'output_tokens',
  ],
  [
    'Responses HTTP transport',
    (usage) =>
      sendViaHttpSse({
        auth: { type: 'openai-direct', apiKey: 'fixture' },
        body: { model: 'fixture' },
        useModel: 'fixture',
        fetchFn: async () =>
          sse([
            {
              type: 'response.completed',
              response: { id: 'fixture', status: 'completed', output: [], usage },
            },
          ]),
      }),
    'input_tokens',
    'output_tokens',
  ],
  [
    'Responses WebSocket state',
    async (usage) => {
      const state = createWsResponseState({ midState: {}, traceProvider: 'openai' });
      state.noteCompleted({ id: 'fixture', usage, output: [] }, () => ({}));
      return state.result();
    },
    'input_tokens',
    'output_tokens',
  ],
  ['Anthropic SSE OAuth result', anthropic, 'input_tokens', 'output_tokens'],
  [
    'Anthropic SSE API-key result',
    async (usage) => anthropicResult(await anthropic(usage)),
    'input_tokens',
    'output_tokens',
  ],
  [
    'Anthropic non-streaming fallback',
    async (usage) =>
      anthropicResult(
        normalizeAnthropicNonStreamingResponse(
          { content: [{ type: 'text', text: 'fixture answer' }], usage },
          'fixture'
        )
      ),
    'input_tokens',
    'output_tokens',
  ],
  ['Gemini REST', gemini, 'promptTokenCount', 'candidatesTokenCount', { thoughtsTokenCount: 0 }],
  [
    'Gemini SDK',
    (usage) => gemini(usage, true),
    'promptTokenCount',
    'candidatesTokenCount',
    { thoughtsTokenCount: 0 },
  ],
  [
    'Antigravity stream',
    async (usageMetadata) => {
      const collector = createAntigravityStreamCollector({ tools: [], useModel: 'fixture' });
      collector.beginAttempt();
      const response = await collector.consume(sse([{ response: geminiChunk(usageMetadata) }]));
      return finalizeAntigravityTurn({ response, collector, useModel: 'fixture', opts: {} });
    },
    'promptTokenCount',
    'candidatesTokenCount',
    { thoughtsTokenCount: 0 },
  ],
];
for (const [name, run, inputKey, outputKey, extras = {}] of routes) {
  test(`${name}: absent usage stays unmeasured`, async () => {
    assert.deepEqual(observed([(await run(undefined)).usage]), [null, null]);
  });
  test(`${name}: coerced numeric strings are not certified as wire measurements`, async () => {
    const result = await run({ ...extras, [inputKey]: '9', [outputKey]: 0 });
    assert.deepEqual(observed([result.usage]), [null, 0]);
  });
  for (const [scenario, raw, counts, expected] of [
    ['empty usage', {}, [0, 0], [null, null]],
    ['explicit zero', { ...extras, [inputKey]: 0, [outputKey]: 0 }, [0, 0], [0, 0]],
    ['output only', { ...extras, [outputKey]: 7 }, [0, 7], [null, 7]],
    ['input only', { [inputKey]: 9 }, [9, 0], [9, null]],
    ['known counts', { ...extras, [inputKey]: 9, [outputKey]: 7 }, [9, 7], [9, 7]],
  ]) {
    test(`${name}: ${scenario} survives adapter, accumulation and observation`, async () => {
      const result = await run(raw);
      assert.deepEqual(
        [result.usage.inputTokens, result.usage.outputTokens],
        counts,
        'numeric accounting unchanged'
      );
      assert.deepEqual(observed([result.usage]), expected);
      assert.deepEqual(
        observed([responsesUsage({ input_tokens: 10, output_tokens: 2 }), result.usage]),
        expected.map((n, i) => (n === null ? null : n + [10, 2][i]))
      );
    });
  }
}

test('Anthropic revisions preserve previous evidence on null/omission and replace with explicit zero', async () => {
  const parsed = await anthropic(
    { input_tokens: 9, output_tokens: 1, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 },
    [{ input_tokens: null, cache_read_input_tokens: null, output_tokens: 0 }]
  );
  const usage = anthropicResult(parsed).usage;
  assert.deepEqual(observed([usage]), [9, 0]);
  assert.deepEqual(observed([toInclusiveOpenCodeGoUsage(usage)]), [13, 0]);
  assert.equal(usage.promptTokens, 13);
});

test('OpenCode Go inclusive input requires all additive components without changing numbers', async () => {
  for (const [raw, expected, input] of [
    [{ output_tokens: 7 }, [null, 7], 0],
    [{ input_tokens: 9, output_tokens: 7 }, [null, 7], 9],
    [
      { input_tokens: 9, output_tokens: 7, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 },
      [15, 7],
      15,
    ],
  ]) {
    const converted = toInclusiveOpenCodeGoUsage(anthropicResult(await anthropic(raw)).usage);
    assert.equal(converted.inputTokens, input);
    assert.equal(toInclusiveOpenCodeGoUsage(converted), converted, 'conversion remains idempotent');
    assert.deepEqual(observed([converted]), expected);
  }
});

for (const [scenario, raw, expected] of [
  ['missing thoughts', { promptTokenCount: 9, candidatesTokenCount: 7 }, [9, null]],
  [
    'reconciled omitted thoughts',
    { promptTokenCount: 9, candidatesTokenCount: 7, totalTokenCount: 16 },
    [9, 7],
  ],
  ['unaccounted total', { promptTokenCount: 9, candidatesTokenCount: 7, totalTokenCount: 20 }, [9, null]],
  [
    'separate tool prompt',
    { promptTokenCount: 9, candidatesTokenCount: 7, toolUsePromptTokenCount: 4, totalTokenCount: 20 },
    [9, 7],
  ],
  ['all output omitted but reconciled zero', { promptTokenCount: 9, totalTokenCount: 9 }, [9, 0]],
  [
    'derived input proven',
    { candidatesTokenCount: 7, thoughtsTokenCount: 2, toolUsePromptTokenCount: 0, totalTokenCount: 18 },
    [9, 9],
  ],
  [
    'derived input with tool input',
    { candidatesTokenCount: 7, thoughtsTokenCount: 2, toolUsePromptTokenCount: 4, totalTokenCount: 22 },
    [null, 9],
  ],
  ['snake case', { prompt_token_count: 9, candidates_token_count: 7, thoughts_token_count: 0 }, [9, 7]],
  [
    'invalid thoughts cannot reconcile',
    { promptTokenCount: 9, candidatesTokenCount: 7, thoughtsTokenCount: -1, totalTokenCount: 15 },
    [9, null],
  ],
])
  test(`Gemini metadata: ${scenario}`, async () =>
    assert.deepEqual(observed([(await gemini(raw)).usage]), expected));

function cursorRun(updates, fail = false) {
  const state = { closed: false, outputTokens: 0, contextTokens: null };
  const frames = [];
  let error;
  const sink = createStreamSink({
    state,
    id: 'fixture',
    model: 'fixture',
    controller: {
      enqueue: (bytes) => frames.push(new TextDecoder().decode(bytes)),
      close() {},
      error: (e) => {
        error = e;
      },
    },
    filter: { flush: () => ({}) },
    watchdog: { stop() {} },
  });
  for (const update of updates)
    processServerMessage(encodeMessage('AgentServerMessage', { interactionUpdate: update }), {
      state,
      filter: {},
      emit() {},
    });
  if (fail) {
    sink.fail(new Error('fixture failure'));
    return error.partialUsage;
  }
  sink.finish();
  const frame = frames
    .filter((x) => x.startsWith('data: {'))
    .map((x) => JSON.parse(x.slice(6)))
    .find((x) => x.usage);
  return cursorUsage(frame.usage);
}
for (const [name, updates, value, expected] of [
  ['no deltas', [{ turnEnded: {} }], 0, null],
  ['reported zero', [{ tokenDelta: { tokens: 0 } }], 0, 0],
  ['positive deltas', [{ tokenDelta: { tokens: 2 } }, { tokenDelta: { tokens: 3 } }], 5, 5],
  ['malformed delta before valid', [{ tokenDelta: {} }, { tokenDelta: { tokens: 3 } }], 3, null],
])
  test(`Cursor native messages to terminal SSE: ${name}`, () => {
    const usage = cursorRun(updates);
    assert.equal(usage.outputTokens, value);
    assert.deepEqual(observed([usage]), [null, expected]);
  });

test('partial and failed adapter paths retain completeness', async () => {
  const cursor = cursorRun([{ tokenDelta: { tokens: 2 } }], true);
  assert.deepEqual(observed([cursor]), [null, 2]);
  await assert.rejects(
    consumeGeminiRestStreamResponse(
      sse([
        {
          candidates: [{ content: { parts: [{ text: 'partial' }] } }],
          usageMetadata: { candidatesTokenCount: 7, thoughtsTokenCount: 0 },
        },
      ]),
      { label: 'fixture', failureUsage: geminiFailureUsage({}, null, 'fixture') }
    ),
    (error) => {
      assert.deepEqual(observed([error.partialUsage]), [null, 7]);
      return true;
    }
  );
  await assert.rejects(
    parseSSEStream(sse(anthropicEvents({ output_tokens: 7 }).slice(0, 3)), null, null, null, null, {}),
    (error) => {
      assert.deepEqual(observed([error.partialUsage]), [null, 7]);
      return true;
    }
  );
});

test('compat aliases, invalid fields and reported cost retain their numeric contract', () => {
  for (const invalid of [null, -1, 0.5, '7', false, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const usage = responsesUsage({ input_tokens: invalid, output_tokens: 0, cost: 0.25 });
    assert.equal(usage.inputTokens, invalid ?? 0);
    assert.equal(usage.costUsd, 0.25);
    assert.deepEqual(observed([usage]), [null, 0]);
  }
  const usage = responsesUsage({ prompt_tokens: 4, completion_tokens: 0, cost: 0 });
  assert.deepEqual(observed([usage]), [4, 0]);
  assert.equal(usage.costUsd, 0);
});

test('completeness metadata never changes numeric ledger rows or provider-reported cost', () => {
  for (const costUsd of [0, 0.25]) {
    const args = {
      id: 'fixture',
      ts: 1,
      provider: 'openrouter',
      model: 'fixture',
      inputTokens: 0,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      costUsd,
    };
    const before = makeUsageRecord(args);
    for (const complete of [true, false]) {
      assert.deepEqual(
        makeUsageRecord({
          ...args,
          inputTokensComplete: complete,
          outputTokensComplete: complete,
          promptTokensComplete: complete,
        }),
        before
      );
    }
    assert.equal(before.costUsd, costUsd);
  }
});
