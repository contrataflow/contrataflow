import { describe, expect, it } from 'vitest';

import { otelQueueMetrics } from './queue-metrics.js';

describe('métricas das filas (RN-FND-70)', () => {
  it('registra os instrumentos uma vez e aceita as leituras sem provedor (no-op)', () => {
    const metrics = otelQueueMetrics();
    expect(otelQueueMetrics()).toBe(metrics);
    expect(() => {
      metrics.jobProcessed('email', 'send', 'completed', 12);
      metrics.jobWaited('email', -5);
      metrics.jobRetried('email', 'TRANSIENT');
      metrics.scheduledJobSkipped('maintenance-daily');
      metrics.schedulerSucceeded('maintenance-daily', new Date(0));
      metrics.deadLetterJobs(new Map([['email', 2]]));
      metrics.circuitState('gotenberg', 2);
    }).not.toThrow();
  });
});
