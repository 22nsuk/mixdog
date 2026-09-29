// Read-only, task-agnostic metrics from completed controlled runs.
// Usage: node contract-metrics.mjs <jobsDir> [<jobsDir> ...]
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const jsonl = (path) => readFileSync(path, 'utf8').split('\n').filter((line) => line.trim()).map(JSON.parse);
const sum = (values) => values.reduce((a, b) => a + b, 0);
const round = (value) => Math.round(value * 10) / 10;
const count = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

// Harbor's `n_input_tokens` means uncached input on the Anthropic side and the
// full prompt (cache included) on the OpenAI side, so one subtraction cannot
// serve both. Each response already records the runtime's normalized split, so
// the run's own trace — not a per-family assumption — supplies the totals.
function normalizedTokenSplit(usageRows) {
  const measuresInput = usageRows.some((event) => [
    event.uncached_input_tokens, event.input_tokens, event.cached_tokens,
  ].some((value) => Number.isFinite(Number(value))));
  if (!measuresInput) return null;
  const uncachedInput = sum(usageRows.map((event) => count(event.uncached_input_tokens ?? event.input_tokens)));
  const cached = sum(usageRows.map((event) => count(event.cached_tokens)));
  return {
    input: uncachedInput + cached,
    cached,
    cacheWrite: sum(usageRows.map((event) => count(event.cache_write_tokens))),
    output: sum(usageRows.map((event) => count(event.output_tokens))),
    uncachedInput,
  };
}

function reportedInputMeaning(reported, split) {
  const value = Number(reported?.input);
  if (!Number.isFinite(value)) return 'absent';
  if (value === split.input) return 'prompt-total';
  if (value === split.uncachedInput) return 'uncached-only';
  return 'mismatch';
}
const runs = process.argv.slice(2).map((path) => resolve(path));
if (!runs.length) throw new Error('Pass one or more completed jobs directories.');
let fingerprint;
for (const root of runs) {
  const report = json(join(root, 'report.json'));
  fingerprint ??= report.preset.fingerprint;
  if (report.preset.fingerprint !== fingerprint) throw new Error('Preset fingerprints differ.');
  const rows = [];
  const runUsage = [];
  for (const entry of readdirSync(report.paths.runDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.includes('__')) continue;
    const agent = join(report.paths.runDir, entry.name, 'agent');
    const trace = jsonl(join(agent, 'agent-trace.jsonl'));
    const events = jsonl(join(agent, 'mixdog.txt'));
    const usage = trace.filter((event) => event.kind === 'usage_raw');
    runUsage.push(...usage);
    let response = 0;
    let edited = false;
    const groups = new Map();
    const calls = [];
    let postEditRetrievals = 0;
    let arrayInputCalls = 0;
    for (const event of events) {
      if (event.type === 'model.request.started') response++;
      if (event.type !== 'item.completed' || event.item?.type !== 'tool_call') continue;
      const item = event.item;
      const args = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : (item.arguments ?? item.input ?? {});
      if (Object.values(args).some(Array.isArray)) arrayInputCalls++;
      if (edited && ['read', 'grep', 'glob', 'find', 'list', 'code_graph'].includes(item.name)) postEditRetrievals++;
      if (['apply_patch', 'edit'].includes(item.name)) edited = true;
      groups.set(response, (groups.get(response) ?? 0) + 1);
      calls.push({ name: item.name, status: item.status });
    }
    const task = entry.name.split('__')[0];
    const result = report.tasks.find((row) => row.task === task);
    const requests = Math.max(response, usage.length);
    const thinkingRows = usage.filter((event) => Number.isFinite(event.thinking_tokens));
    const missingThinkingRequests = Math.max(0, requests - thinkingRows.length);
    const completedUsage = events.filter((event) => event.type === 'model.request.completed'
      && Number.isFinite(event.usage?.output_tokens));
    const rawOutput = usage.filter((event) => Number.isFinite(event.output_tokens));
    const outputComplete = completedUsage.length === requests || rawOutput.length === requests;
    const output = completedUsage.length === requests
      ? sum(completedUsage.map((event) => event.usage.output_tokens))
      : sum(rawOutput.map((event) => event.output_tokens));
    rows.push({
      task, passed: result?.passed, agent: round(result?.agentSeconds ?? 0),
      requests, toolRounds: groups.size, calls: calls.length,
      multiCallResponses: [...groups.values()].filter((count) => count > 1).length,
      arrayInputCalls, postEditRetrievals,
      edits: calls.filter((call) => ['apply_patch', 'edit'].includes(call.name)).length,
      failedToolEnvelopes: calls.filter((call) => call.status === 'failed').length,
      thinking: sum(thinkingRows.map((event) => event.thinking_tokens)),
      thinkingComplete: missingThinkingRequests === 0,
      missingThinkingRequests,
      output, outputComplete,
      streamSeconds: round(sum(trace.filter((event) => event.kind === 'sse').map((event) => event.stream_total_ms ?? event.payload?.stream_total_ms ?? 0)) / 1000),
    });
  }
  const split = normalizedTokenSplit(runUsage);
  console.log(JSON.stringify({
    run: basename(root), fingerprint, result: report.result,
    rules: report.preset.contract.rulesHash,
    tools: report.preset.contract.toolContractHash,
    bundle: report.preset.runtime.bundleSha256,
    wall: report.timing.wallSeconds, agent: report.timing.agentTotalSeconds,
    cost: report.cost.usd, usdPerAgentMinute: Number((report.cost.usd / report.timing.agentTotalSeconds * 60).toFixed(3)),
    tokens: split
      ? {
        ...split,
        source: 'agent-trace',
        reported: report.tokens,
        reportedInput: reportedInputMeaning(report.tokens, split),
      }
      // No response in this run recorded an input split, so the report's own
      // totals stay the only measurement; they are not re-derived here.
      : { ...report.tokens, source: 'report' },
    totals: {
      ...Object.fromEntries(['requests', 'toolRounds', 'calls', 'multiCallResponses', 'arrayInputCalls', 'postEditRetrievals', 'edits', 'failedToolEnvelopes', 'thinking', 'missingThinkingRequests'].map((key) => [key, sum(rows.map((row) => row[key]))])),
      thinkingComplete: rows.every((row) => row.thinkingComplete),
    },
    tasks: rows.sort((a, b) => a.task.localeCompare(b.task)),
  }));
}
