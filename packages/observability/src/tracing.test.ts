import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { captureJobTraceMeta, currentJobLogFields, runInJobContext } from './job-context.js';
import { createLogger } from './logger.js';
import { captureLogs, installTestTracing } from './testing.js';
import type { TestTracing } from './testing.js';
import {
  extractTraceContext,
  injectTraceCarrier,
  sanitizeSpanAttributes,
  tracer,
  withSpan,
} from './tracing.js';

describe('sanitizeSpanAttributes (RN-FND-78 · V-04)', () => {
  it('mantém UUIDs, códigos, enums, contagens e booleanos do prefixo cf.', () => {
    const input = {
      'cf.process.id': '0193a1b2-7c00-7abc-8def-0123456789ab',
      'cf.stage.from': 'DFD_ELABORATION',
      'cf.rules.evaluated': 7,
      'cf.critical': true,
      'cf.file.bytes': 2048,
      'enduser.id': '0193a1b2-7c00-7abc-8def-0123456789ac',
      'messaging.message.id': 'evt-1',
    };
    expect(sanitizeSpanAttributes(input)).toEqual({ attributes: input, dropped: [] });
  });

  it.each([
    ['nome fora do prefixo', 'process.id', 'x'],
    ['nome de pessoa', 'cf.user.name', 'Maria'],
    ['e-mail', 'cf.user.email', 'maria@orgao.gov.br'],
    ['e-mail em atributo neutro', 'cf.actor.ref', 'maria@orgao.gov.br'],
    ['CPF', 'cf.supplier.document', '123.456.789-09'],
    ['CPF sem pontuação', 'cf.supplier.document', '12345678909'],
    ['IP', 'cf.client.addr', '10.0.0.1'],
    ['IP no nome', 'cf.client.ip', 'x'],
    ['conteúdo', 'cf.document.content', 'texto'],
    ['valor monetário', 'cf.item.value', 1234.5],
    ['nome de arquivo', 'cf.attachment.file_name', 'contrato.pdf'],
    ['URL pré-assinada', 'cf.storage.url', 'https://s3/x?X-Amz-Signature=1'],
    ['token', 'cf.session.token', 'abc'],
    ['parâmetro SQL', 'cf.db.query', 'select'],
    ['texto livre com espaços', 'cf.reason', 'motivo livre'],
    ['número não finito', 'cf.items.count', Number.NaN],
  ])('descarta %s', (_label, key, value) => {
    expect(sanitizeSpanAttributes({ [key]: value })).toEqual({ attributes: {}, dropped: [key] });
  });

  it('ignora valores ausentes', () => {
    expect(sanitizeSpanAttributes({ 'cf.tenant.id': null, 'cf.x': undefined })).toEqual({
      attributes: {},
      dropped: [],
    });
  });
});

describe('withSpan e propagação', () => {
  let tracing: TestTracing;

  beforeEach(() => {
    tracing = installTestTracing();
  });

  afterEach(async () => {
    await tracing.shutdown();
  });

  it('abre span com atributos permitidos e conta os descartados', async () => {
    const result = await withSpan(
      'process.forward',
      { 'cf.process.id': 'p-0001', 'cf.user.email': 'x@y.z' },
      () => 42,
    );
    expect(result).toBe(42);
    const [span] = tracing.spans();
    expect(span?.name).toBe('process.forward');
    expect(span?.kind).toBe(SpanKind.INTERNAL);
    expect(span?.attributes).toEqual({ 'cf.process.id': 'p-0001', 'cf.attributes.dropped': 1 });
  });

  it('marca erro com o tipo da exceção, sem a mensagem, e relança', async () => {
    await expect(
      withSpan('numbering.next', {}, () => {
        throw new RangeError('dado sensível');
      }),
    ).rejects.toThrow(RangeError);
    const [span] = tracing.spans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.status.message).toBeUndefined();
    expect(span?.attributes['exception.type']).toBe('RangeError');
    expect(JSON.stringify(span?.attributes)).not.toContain('dado sensível');
  });

  it('registra o tipo de exceções que não são Error', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- cobre rejeição com valor que não é Error
    await expect(withSpan('x', {}, () => Promise.reject('falha'))).rejects.toBe('falha');
    expect(tracing.spans()[0]?.attributes['exception.type']).toBe('string');
  });

  it('serializa e restaura o contexto W3C sem baggage', async () => {
    const carrier = await withSpan('parent', {}, () => injectTraceCarrier());
    const [parent] = tracing.spans();
    expect(carrier.traceparent).toBe(
      `00-${parent?.spanContext().traceId}-${parent?.spanContext().spanId}-01`,
    );
    expect(Object.keys(carrier)).toEqual(['traceparent']);
    const restored = trace.getSpanContext(
      extractTraceContext(JSON.parse(JSON.stringify(carrier)) as never),
    );
    expect(restored?.traceId).toBe(parent?.spanContext().traceId);
  });

  it('carrier ausente ou inválido vira raiz nova', async () => {
    expect(trace.getSpanContext(extractTraceContext(undefined))).toBeUndefined();
    expect(trace.getSpanContext(extractTraceContext({ traceparent: 'lixo' }))).toBeUndefined();
    expect(injectTraceCarrier()).toEqual({});
    await withSpan('root', {}, () => undefined, { parent: extractTraceContext(null) });
    expect(tracing.spans()[0]?.parentSpanContext).toBeUndefined();
  });

  it('[Concorrência] chamadas simultâneas têm traceIds distintos e filhos não se cruzam', async () => {
    const run = (label: string) =>
      withSpan(`request ${label}`, {}, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await withSpan(
          `child ${label}`,
          {},
          () => new Promise((resolve) => setTimeout(resolve, 1)),
        );
      });
    await Promise.all([run('a'), run('b')]);
    const byName = new Map(tracing.spans().map((span) => [span.name, span]));
    const traceA = byName.get('request a')?.spanContext().traceId;
    const traceB = byName.get('request b')?.spanContext().traceId;
    expect(traceA).toBeDefined();
    expect(traceA).not.toBe(traceB);
    expect(byName.get('child a')?.spanContext().traceId).toBe(traceA);
    expect(byName.get('child b')?.spanContext().traceId).toBe(traceB);
  });
});

describe('propagação até o job (DEC-164 · cenário "Falha de integração")', () => {
  let tracing: TestTracing;

  beforeEach(() => {
    tracing = installTestTracing();
  });

  afterEach(async () => {
    await tracing.shutdown();
  });

  it('o job herda correlationId e é filho do trace da requisição', async () => {
    const logs = captureLogs();
    const logger = createLogger({
      service: 'worker',
      env: 'test',
      version: 'test',
      level: 'info',
      destination: logs.destination,
      context: currentJobLogFields,
    });

    // API: requisição dispara o job (span PRODUCER filho do span da requisição).
    const { meta, requestTraceId } = await tracer().startActiveSpan(
      'GET /api/v1/_internal/jobs',
      async (request) => {
        const captured = await captureJobTraceMeta('platform-demo', {
          correlationId: 'corr-req-0001',
          tenantId: 't-0001',
        });
        request.end();
        return { meta: captured, requestTraceId: request.spanContext().traceId };
      },
    );

    // Fila: o JobMeta atravessa como JSON.
    const received = JSON.parse(JSON.stringify(meta)) as typeof meta;

    // Worker: processa fora do contexto da requisição.
    const outcome = await runInJobContext(
      { queue: 'platform-demo', jobName: 'trace-demo', jobId: 'job-1', attempt: 1 },
      received,
      () => {
        logger.info({ event: 'job.completed' });
        return 'ok';
      },
    );

    expect(outcome).toBe('ok');
    const spans = new Map(tracing.spans().map((span) => [span.name, span]));
    const producer = spans.get('platform-demo publish');
    const consumer = spans.get('platform-demo process');
    expect(producer?.kind).toBe(SpanKind.PRODUCER);
    expect(consumer?.kind).toBe(SpanKind.CONSUMER);
    expect(producer?.spanContext().traceId).toBe(requestTraceId);
    expect(consumer?.spanContext().traceId).toBe(requestTraceId);
    expect(consumer?.parentSpanContext?.spanId).toBe(producer?.spanContext().spanId);
    expect(consumer?.attributes).toMatchObject({
      'messaging.message.id': 'job-1',
      'cf.job.attempt': 1,
      'cf.tenant.id': 't-0001',
    });

    const [line] = logs.lines();
    expect(line).toMatchObject({
      event: 'job.completed',
      correlationId: 'corr-req-0001',
      tenantId: 't-0001',
      queue: 'platform-demo',
      jobName: 'trace-demo',
      jobId: 'job-1',
      attempt: 1,
      traceId: requestTraceId,
      spanId: consumer?.spanContext().spanId,
    });
    expect(currentJobLogFields()).toBeUndefined();
  });
});
