import { ExportResultCode } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import { describe, expect, it, vi } from 'vitest';

import {
  EXPORT_FAILURE_LOG_INTERVAL_MS,
  WarnOnFailureSpanExporter,
  createSampler,
  createTelemetrySdk,
  isIgnoredHttpPath,
} from './telemetry.js';

class FakeExporter implements SpanExporter {
  result: ExportResult = { code: ExportResultCode.SUCCESS };
  throws = false;
  readonly shutdown = vi.fn(() => Promise.resolve());

  export(_spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
    if (this.throws) throw new Error('socket hang up');
    callback(this.result);
  }
}

function exportOnce(exporter: SpanExporter): Promise<ExportResult> {
  return new Promise((resolve) => {
    exporter.export([] as ReadableSpan[], resolve);
  });
}

describe('WarnOnFailureSpanExporter (FA-04)', () => {
  it('repassa o sucesso sem logar', async () => {
    const warn = vi.fn();
    const exporter = new WarnOnFailureSpanExporter(new FakeExporter(), { warn });
    await expect(exportOnce(exporter)).resolves.toEqual({ code: ExportResultCode.SUCCESS });
    expect(warn).not.toHaveBeenCalled();
  });

  it('loga warn tracing.export_failed quando o Collector está fora, no máximo 1/min', async () => {
    let now = 1_000;
    const warn = vi.fn();
    const inner = new FakeExporter();
    inner.result = { code: ExportResultCode.FAILED, error: new Error('ECONNREFUSED') };
    const exporter = new WarnOnFailureSpanExporter(inner, { warn }, () => now);

    await exportOnce(exporter);
    await exportOnce(exporter);
    now += EXPORT_FAILURE_LOG_INTERVAL_MS;
    await exportOnce(exporter);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, {
      event: 'tracing.export_failed',
      spanCount: 0,
      suppressed: 0,
      errorType: 'Error',
    });
    expect(warn).toHaveBeenNthCalledWith(2, expect.objectContaining({ suppressed: 1 }));
  });

  it('nunca lança: exceção do exportador vira FAILED', async () => {
    const warn = vi.fn();
    const inner = new FakeExporter();
    inner.throws = true;
    const exporter = new WarnOnFailureSpanExporter(inner, { warn });
    await expect(exportOnce(exporter)).resolves.toMatchObject({ code: ExportResultCode.FAILED });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ errorType: 'Error' }));
  });

  it('registra tipo desconhecido quando a falha não traz erro', async () => {
    const warn = vi.fn();
    const inner = new FakeExporter();
    inner.result = { code: ExportResultCode.FAILED };
    await exportOnce(new WarnOnFailureSpanExporter(inner, { warn }));
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ errorType: 'unknown' }));
  });

  it('delega shutdown e forceFlush', async () => {
    const inner = new FakeExporter();
    const exporter = new WarnOnFailureSpanExporter(inner, { warn: vi.fn() });
    await exporter.shutdown();
    await exporter.forceFlush();
    expect(inner.shutdown).toHaveBeenCalledOnce();
  });
});

describe('isIgnoredHttpPath (FA-05)', () => {
  it.each(['/health', '/health/live', '/health/ready?x=1', '/metrics'])('ignora %s', (path) => {
    expect(isIgnoredHttpPath(path)).toBe(true);
  });

  it.each(['/api/v1/_internal/ping', '/healthy', '/metrics/x', undefined])(
    'instrumenta %s',
    (path) => {
      expect(isIgnoredHttpPath(path)).toBe(false);
    },
  );
});

describe('createSampler (RN-FND-77)', () => {
  it('usa ParentBased(AlwaysOn) com razão 1 e TraceIdRatio abaixo disso', () => {
    expect(createSampler(1).toString()).toContain('AlwaysOnSampler');
    expect(createSampler(0.1).toString()).toContain('TraceIdRatioBased{0.1}');
  });
});

describe('createTelemetrySdk', () => {
  it('monta o SDK com recurso, propagador W3C e exportador protegido, sem iniciá-lo', async () => {
    const sdk = createTelemetrySdk({
      serviceName: 'contrataflow-api',
      serviceVersion: '1.0.0+gabc',
      environment: 'test',
      endpoint: 'http://127.0.0.1:1/',
      samplerRatio: 1,
      instrumentations: [],
      logger: { warn: vi.fn() },
      region: 'sa-east-1',
    });
    expect(sdk).toBeDefined();
    await sdk.shutdown();
  });
});
