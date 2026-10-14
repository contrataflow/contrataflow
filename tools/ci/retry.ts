// tsx tools/ci/retry.ts --service <nome> [--attempts 3] [--delay 10] [--timeout 600] -- <comando…>
// Retry com backoff e tempo limite por tentativa para chamadas a serviços externos do CI (FA-04).
import { parseArgs } from 'node:util';

import { createReporter } from './lib/annotations.js';
import { spawnAttempt, withRetry } from './lib/retry.js';

const separator = process.argv.indexOf('--');
if (separator === -1 || separator === process.argv.length - 1) {
  console.error('Uso: retry.ts --service <nome> [--attempts N] [--delay s] [--timeout s] -- <cmd>');
  process.exit(2);
}

const { values } = parseArgs({
  args: process.argv.slice(2, separator),
  options: {
    service: { type: 'string' },
    attempts: { type: 'string', default: '3' },
    delay: { type: 'string', default: '10' },
    timeout: { type: 'string' },
  },
});

const [command = '', ...args] = process.argv.slice(separator + 1);
const service = values.service ?? command;
const timeoutSeconds = values.timeout === undefined ? undefined : Number(values.timeout);

const outcome = await withRetry(
  spawnAttempt(command, args),
  {
    service,
    attempts: Number(values.attempts),
    initialDelayMs: Number(values.delay) * 1000,
    maxDelayMs: 120_000,
    ...(timeoutSeconds === undefined ? {} : { attemptTimeoutMs: timeoutSeconds * 1000 }),
  },
  createReporter(),
);

process.exitCode = outcome.ok ? 0 : (outcome.status ?? 1) || 1;
