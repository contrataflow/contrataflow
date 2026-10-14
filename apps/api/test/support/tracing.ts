import { createRequire } from 'node:module';

import { isIgnoredHttpPath } from '@contrataflow/observability/telemetry';
import { installTestTracing } from '@contrataflow/observability/testing';
import type { TestTracing } from '@contrataflow/observability/testing';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';

export interface HttpTestTracing extends TestTracing {
  /** Desfaz a instrumentação HTTP e o provedor global. */
  uninstall(): Promise<void>;
}

/**
 * Traces em memória com a instrumentação HTTP real (a mesma do `otel.ts`): o Vitest carrega
 * `node:http` como ESM, então o `require` abaixo dispara o patch do `require-in-the-middle`.
 */
export function installHttpTestTracing(
  exporter?: Parameters<typeof installTestTracing>[0],
): HttpTestTracing {
  const tracing = installTestTracing(exporter);
  const http = new HttpInstrumentation({
    ignoreIncomingRequestHook: (request) => isIgnoredHttpPath(request.url),
    headersToSpanAttributes: { server: { requestHeaders: ['x-correlation-id'] } },
  });
  http.enable();
  createRequire(import.meta.url)('node:http');
  return {
    ...tracing,
    uninstall: async () => {
      http.disable();
      await tracing.shutdown();
    },
  };
}
