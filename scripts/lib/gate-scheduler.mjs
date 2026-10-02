import { availableParallelism } from 'node:os';
import { testConcurrencyArg } from './run-node-tests.mjs';

// A local gate has one budget, not a full machine's worth of workers per lane.
// Six is the interactive-desktop default; explicit and shell budgets still win.
export function gateTestBudget(env = process.env, parallelism = availableParallelism()) {
  const argument = testConcurrencyArg([], env, parallelism);
  return argument ? Number(argument.split('=')[1]) : Math.min(6, parallelism);
}

export async function runGateLegs(legs, budget, runLeg) {
  if (!Number.isInteger(budget) || budget < 1) throw new Error('gate test budget must be a positive integer');
  const slots = Math.min(legs.length, budget);
  let next = 0;
  await Promise.all(
    Array.from({ length: slots }, async (_, index) => {
      const concurrency = Math.floor(budget / slots) + (index < budget % slots ? 1 : 0);
      while (next < legs.length) {
        const leg = legs[next++];
        await runLeg(leg, concurrency);
      }
    })
  );
}
