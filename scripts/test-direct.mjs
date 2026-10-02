#!/usr/bin/env node
// Explicit Node test options and file paths, without discovery or lane filters.
import { runNodeTests } from './lib/run-node-tests.mjs';

// Preserve parent Node flags such as heap limits and preload modules.
await runNodeTests([...process.execArgv, '--test'], process.argv.slice(2));
