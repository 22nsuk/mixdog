#!/usr/bin/env node
// Builds the pptx skill's helper index (references/kit-index.md) from the code the runtime runs before every deck
// script: kit.md, charts.md, and pictures.md. The model reads the index — each helper's signature and the guidance
// written above it — instead of every helper's body; the bodies stay where they are, and run.
//   node scripts/pptx-kit-index.mjs          rewrite the index
//   node scripts/pptx-kit-index.mjs --check  exit 1 when the index is stale
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'acorn';

const REFERENCES = resolve(dirname(fileURLToPath(import.meta.url)), '../src/defaults/skills/pptx/references');
export const KIT_INDEX_PATH = join(REFERENCES, 'kit-index.md');
// Which prose of a source travels with its helpers: kit.md and charts.md are read only through the index, so their
// rules come along whole; pictures.md is still read on its own trigger, so only its headings mark where helpers sit.
const SOURCES = [
  { file: 'kit.md', prose: 'all' },
  { file: 'charts.md', prose: 'all' },
  { file: 'pictures.md', prose: 'headings' },
];
// A statement this short says its whole meaning (a constant, a one-line arrow); a longer one gives its first line.
const WHOLE_STATEMENT = 240;

function declarationSummary(source, node) {
  const text = source.slice(node.start, node.end);
  if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
    return `${source.slice(node.start, node.body.start).trimEnd()} { … }`;
  }
  if (text.length <= WHOLE_STATEMENT) return text;
  if (node.type === 'VariableDeclaration') {
    return node.declarations
      .map((declarator) => {
        const init = declarator.init;
        const head = `${node.kind} ${source.slice(declarator.id.start, declarator.id.end)}`;
        if (init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) {
          return `${head} = ${source.slice(init.start, init.body.start).trimEnd()} …;`;
        }
        return `${head} = ${source.slice(init?.start ?? declarator.end, declarator.end).split('\n')[0]} …;`;
      })
      .join('\n');
  }
  return `${text.split('\n')[0]} …`;
}

function summarizeCode(code) {
  const comments = [];
  const program = parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    onComment: comments,
  });
  const lines = [];
  let cursor = 0;
  const pushComments = (until) => {
    for (const comment of comments) {
      if (comment.start < cursor || comment.end > until) continue;
      lines.push(code.slice(comment.start, comment.end));
    }
  };
  for (const node of program.body) {
    pushComments(node.start);
    lines.push(declarationSummary(code, node));
    cursor = node.end;
  }
  pushComments(code.length);
  return lines.join('\n');
}

function summarizeFile({ file, prose }) {
  const text = readFileSync(join(REFERENCES, file), 'utf8');
  const parts = text.split(/^```[^\n]*\n?/m);
  const output = [];
  parts.forEach((part, index) => {
    if (index % 2) {
      output.push('```js', summarizeCode(part).trimEnd(), '```');
      return;
    }
    const kept = prose === 'all' ? part.trim() : part.split('\n').filter((line) => /^#{1,3} /.test(line)).join('\n');
    if (kept) output.push(kept.replace(/^# /m, '## '));
  });
  return [`# ${file}`, ...output].join('\n\n');
}

export function buildKitIndex() {
  return [
    '# Kit index',
    '',
    'Generated from `kit.md`, `charts.md`, and `pictures.md` by `scripts/pptx-kit-index.mjs`; do not edit it by hand.',
    'The runtime runs every code block of those three files before the script. Here each helper keeps its signature,',
    'its defaults, and the guidance written above it; a body reads as `{ … }`. Open the helper in its own file only to',
    'redefine it or when a default this index does not state decides the page.',
    '',
    ...SOURCES.map((source) => summarizeFile(source)),
    '',
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const next = buildKitIndex();
  if (process.argv.includes('--check')) {
    const current = (() => {
      try {
        return readFileSync(KIT_INDEX_PATH, 'utf8');
      } catch {
        return '';
      }
    })();
    if (current !== next) {
      console.error('references/kit-index.md is stale: run node scripts/pptx-kit-index.mjs');
      process.exit(1);
    }
  } else {
    writeFileSync(KIT_INDEX_PATH, next);
    console.log(`wrote ${KIT_INDEX_PATH} (${next.length} chars)`);
  }
}
