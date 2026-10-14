// tsx tools/ci/verify-traces.ts --target <url de staging> --query <url do backend de traces>
// Estágio 8 (Pós-deploy): prova que a requisição a staging gerou trace consultável (RN-FND-28).
import { parseArgs } from 'node:util';

import { createReporter } from './lib/annotations.js';
import { newTraceContext, traceQueryUrl, waitForTrace } from './lib/traces.js';

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    query: { type: 'string' },
    timeout: { type: 'string', default: '120' },
  },
});
const reporter = createReporter();
if (!values.target || !values.query) {
  reporter.annotate(
    'error',
    'verify-traces exige --target e --query (variáveis do ambiente staging).',
  );
  process.exit(1);
}

const context = newTraceContext();
const response = await fetch(values.target, { headers: { traceparent: context.traceparent } });
if (!response.ok) {
  reporter.annotate('error', `${values.target} respondeu ${response.status}.`, {
    title: 'Pós-deploy · traces',
  });
  process.exit(1);
}

const authorization = process.env.TRACES_QUERY_TOKEN;
const found = await waitForTrace(traceQueryUrl(values.query, context.traceId), {
  timeoutMs: Number(values.timeout) * 1000,
  intervalMs: 5000,
  fetchJson: async (url) => {
    const result = await fetch(url, {
      headers: {
        accept: 'application/json',
        ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
      },
    });
    return { status: result.status, body: result.ok ? await result.json() : undefined };
  },
});

if (!found) {
  reporter.annotate(
    'error',
    `Trace ${context.traceId} não apareceu no backend de traces em ${values.timeout}s.`,
    { title: 'Pós-deploy · traces' },
  );
}
reporter.log(found ? 'info' : 'error', 'ci.traces', `trace ${context.traceId}`, { found });
process.exitCode = found ? 0 : 1;
