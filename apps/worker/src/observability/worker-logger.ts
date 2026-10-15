import { createLogger, currentJobLogFields } from '@contrataflow/observability';
import type { DestinationStream, Logger, TelemetryConfig } from '@contrataflow/observability';

/**
 * Logger pino do worker (RN-FND-71): `service=worker` e, dentro de um job, `correlationId`,
 * `tenantId`, `queue`, `jobName`, `jobId` e `attempt` do `JobMeta` (DEC-164) em toda linha.
 */
export function createWorkerLogger(
  config: Pick<TelemetryConfig, 'environment' | 'version' | 'logLevel'>,
  destination?: DestinationStream,
): Logger {
  return createLogger({
    service: 'worker',
    env: config.environment,
    version: config.version,
    level: config.logLevel,
    context: currentJobLogFields,
    ...(destination ? { destination } : {}),
  });
}
