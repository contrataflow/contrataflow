import {
  createLogger,
  currentJobLogFields,
  isUuidV7,
  runInJobContext,
} from '@contrataflow/observability';
import { ExportResultCode, WarnOnFailureSpanExporter } from '@contrataflow/observability/telemetry';
import { captureLogs } from '@contrataflow/observability/testing';
import type { CapturedLogs, LogLine } from '@contrataflow/observability/testing';
import { SpanKind } from '@opentelemetry/api';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { DebugLogFlags, DEBUG_FLAG_MAX_TTL_MS } from '#shared/observability/debug-log-flags.js';
import { createApiLogger } from '#shared/observability/observability.module.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi, testConfig } from '../test/support/api-test-app.js';
import type { TestApi } from '../test/support/api-test-app.js';
import { PipelineTestController } from '../test/support/test-controllers.js';
import { installHttpTestTracing } from '../test/support/tracing.js';
import type { HttpTestTracing } from '../test/support/tracing.js';

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const PING = '/api/v1/_internal/ping';

type Span = ReturnType<HttpTestTracing['spans']>[number];

function completions(logs: CapturedLogs): LogLine[] {
  return logs.lines().filter((line) => line.event === 'http.request.completed');
}

function serverSpans(tracing: HttpTestTracing): Span[] {
  return tracing.spans().filter((span) => span.kind === SpanKind.SERVER);
}

async function startApi(
  logs: CapturedLogs,
  exporter?: Parameters<typeof installHttpTestTracing>[0],
) {
  const tracing = installHttpTestTracing(exporter);
  const config = testConfig({ APP_VERSION: '1.4.2+g3f9c2ab' });
  const api = await createTestApi({
    config,
    controllers: [PipelineTestController],
    logger: createApiLogger(config, logs.destination),
  });
  return { api, tracing };
}

describe('Feature: Logs estruturados, correlationId e tracing (US-084)', () => {
  const logs = captureLogs();
  let api: TestApi;
  let tracing: HttpTestTracing;
  const ana = () => api.bearer(FAKE_USERS.ana.subject);

  beforeAll(async () => {
    ({ api, tracing } = await startApi(logs));
  });
  afterAll(async () => {
    await api.close();
    await tracing.uninstall();
  });
  afterEach(() => {
    logs.clear();
    tracing.reset();
    api.rateLimitStore.reset();
  });

  it('[Sucesso] requisição completa gera log e trace correlacionados', async () => {
    const response = await request(api.server)
      .get(PING)
      .set('Authorization', ana())
      .set('X-Tenant-Id', A);

    expect(response.status).toBe(200);
    const correlationId = String(response.headers['x-correlation-id']);
    expect(isUuidV7(correlationId)).toBe(true);

    const [server] = serverSpans(tracing);
    const [line] = completions(logs);
    expect(line).toMatchObject({
      level: 'info',
      msg: 'request completed',
      event: 'http.request.completed',
      service: 'api',
      env: 'test',
      version: '1.4.2+g3f9c2ab',
      correlationId,
      traceId: server?.spanContext().traceId,
      spanId: server?.spanContext().spanId,
      tenantId: A,
      userId: FAKE_USERS.ana.id,
      membershipId: '0192a000-0000-7000-8000-0000000001a1',
      method: 'GET',
      route: '/api/v1/_internal/ping',
      statusCode: 200,
    });
    expect(typeof line?.durationMs).toBe('number');
    expect(isUuidV7(String(line?.requestId))).toBe(true);
    expect(line?.time).toMatch(/Z$/);

    // Span do servidor marcado com o correlationId; span manual de referência como filho.
    expect(server?.attributes['cf.correlation_id']).toBe(correlationId);
    const manual = tracing.spans().find((span) => span.name === 'platform.example.ping');
    expect(manual?.spanContext().traceId).toBe(server?.spanContext().traceId);
    expect(manual?.attributes).toEqual({
      'cf.tenant.id': A,
      'enduser.id': FAKE_USERS.ana.id,
    });
  });

  it('[Validação] correlationId do cliente fora do padrão é descartado', async () => {
    const response = await request(api.server)
      .get(PING)
      .set('Authorization', ana())
      .set('X-Tenant-Id', A)
      .set('X-Correlation-Id', 'a b c');

    const correlationId = String(response.headers['x-correlation-id']);
    expect(isUuidV7(correlationId)).toBe(true);
    expect(completions(logs)[0]?.correlationId).toBe(correlationId);
    expect(logs.raw().join('\n')).not.toContain('a b c');
  });

  it('[Permissão] ativação de debug temporário é restrita a operador da plataforma', async () => {
    let now = Date.UTC(2026, 9, 14, 12);
    const flags = new DebugLogFlags(() => now);

    expect(
      flags.activate({
        actor: { userId: FAKE_USERS.ana.id, platformOperator: false },
        scope: { correlationId: 'corr-0000001' },
        ttlMs: 60_000,
      }),
    ).toEqual({ granted: false, reason: 'NOT_PLATFORM_OPERATOR' });
    expect(logs.lines()).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        event: 'observability.debug_flag_denied',
        reason: 'NOT_PLATFORM_OPERATOR',
      }),
    );
    expect(flags.isActive({ correlationId: 'corr-0000001' })).toBe(false);

    const operator = { userId: null, platformOperator: true };
    expect(
      flags.activate({ actor: operator, scope: { tenantId: A }, ttlMs: DEBUG_FLAG_MAX_TTL_MS + 1 }),
    ).toEqual({ granted: false, reason: 'TTL_OUT_OF_RANGE' });
    expect(flags.activate({ actor: operator, scope: {}, ttlMs: 60_000 })).toEqual({
      granted: false,
      reason: 'SCOPE_MISSING',
    });
    expect(flags.activate({ actor: operator, scope: { tenantId: A }, ttlMs: 60_000 })).toEqual({
      granted: true,
      expiresAt: new Date(now + 60_000),
    });
    expect(flags.isActive({ tenantId: A })).toBe(true);
    now += 60_000;
    expect(flags.isActive({ tenantId: A })).toBe(false);

    // Nenhuma rota de negócio é afetada.
    const response = await request(api.server)
      .get(PING)
      .set('Authorization', ana())
      .set('X-Tenant-Id', A);
    expect(response.status).toBe(200);
  });

  it('[Tenant incorreto] contexto não vaza entre requisições concorrentes', async () => {
    const send = (tenant: string, index: number) =>
      request(api.server)
        .get('/api/v1/_test/context')
        .set('Authorization', ana())
        .set('X-Tenant-Id', tenant)
        .set(
          'X-Correlation-Id',
          `corr-${tenant === A ? 'a' : 'b'}-${String(index).padStart(4, '0')}`,
        );
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) => [send(A, index), send(B, index)]).flat(),
    );
    expect(responses.filter((response) => response.status === 200)).toHaveLength(10);

    const lines = logs.lines().filter((line) => typeof line.correlationId === 'string');
    expect(completions(logs)).toHaveLength(20);
    for (const line of lines) {
      const fromA = String(line.correlationId).startsWith('corr-a-');
      if (fromA) expect(line.tenantId).toBe(A);
      else expect(line.tenantId).not.toBe(A);
    }
  });

  it('[Duplicidade] retentativa da mesma ação reaproveita o correlationId', async () => {
    const attempt = () =>
      request(api.server)
        .get(PING)
        .set('Authorization', ana())
        .set('X-Tenant-Id', A)
        .set('X-Correlation-Id', 'c-001-acao-usuario');
    const first = await attempt();
    const retry = await attempt();

    expect(first.headers['x-correlation-id']).toBe('c-001-acao-usuario');
    expect(retry.headers['x-correlation-id']).toBe('c-001-acao-usuario');
    const found = logs.lines().filter((line) => line.correlationId === 'c-001-acao-usuario');
    expect(found.filter((line) => line.event === 'http.request.completed')).toHaveLength(2);
  });

  it('[Concorrência] traceIds distintos não se cruzam', async () => {
    const send = (index: number) =>
      request(api.server)
        .get(PING)
        .set('Authorization', ana())
        .set('X-Tenant-Id', A)
        .set('X-Correlation-Id', `corr-conc-${index}`);
    await Promise.all([send(1), send(2)]);

    const servers = serverSpans(tracing);
    expect(servers).toHaveLength(2);
    const [first, second] = servers.map((span) => span.spanContext().traceId);
    expect(first).not.toBe(second);
    for (const child of tracing.spans().filter((span) => span.name === 'platform.example.ping')) {
      const parent = servers.find(
        (span) => span.spanContext().spanId === child.parentSpanContext?.spanId,
      );
      expect(parent?.spanContext().traceId).toBe(child.spanContext().traceId);
    }
    for (const line of completions(logs)) {
      const server = servers.find((span) => span.spanContext().traceId === line.traceId);
      expect(server?.attributes['cf.correlation_id']).toBe(line.correlationId);
    }
  });

  it('[Falha de integração] traceparent se propaga até o job assíncrono', async () => {
    const response = await request(api.server)
      .post('/api/v1/_internal/jobs/trace-demo')
      .set('Authorization', ana())
      .set('X-Tenant-Id', A);

    expect(response.status).toBe(202);
    const correlationId = String(response.headers['x-correlation-id']);
    const job = (
      response.body as { data: { jobName: string; jobId: string; queue: string; meta: never } }
    ).data;
    expect(job.meta).toMatchObject({ correlationId, tenantId: A, causationId: null });
    const [server] = serverSpans(tracing);
    const requestTraceId = server?.spanContext().traceId;

    // Worker: o JobMeta chega pela fila (JSON) e o job roda fora do contexto da requisição.
    const workerLogs = captureLogs();
    const workerLogger = createLogger({
      service: 'worker',
      env: 'test',
      version: 'test',
      level: 'info',
      destination: workerLogs.destination,
      context: currentJobLogFields,
    });
    await runInJobContext(
      { queue: job.queue, jobName: job.jobName, jobId: job.jobId, attempt: 1 },
      JSON.parse(JSON.stringify(job.meta)) as never,
      () => {
        workerLogger.info({ event: 'job.completed' }, 'job completed');
      },
    );

    expect(workerLogs.lines()[0]).toMatchObject({
      event: 'job.completed',
      service: 'worker',
      correlationId,
      tenantId: A,
      jobName: 'trace-demo',
      traceId: requestTraceId,
    });
    const producer = tracing.spans().find((span) => span.name === 'platform-demo publish');
    const consumer = tracing.spans().find((span) => span.name === 'platform-demo process');
    expect(producer?.spanContext().traceId).toBe(requestTraceId);
    expect(consumer?.spanContext().traceId).toBe(requestTraceId);
    expect(consumer?.parentSpanContext?.spanId).toBe(producer?.spanContext().spanId);
  });

  it('[API] sucesso e erro sempre devolvem X-Correlation-Id; 4xx em info com reason, 5xx em error', async () => {
    const unauthenticated = await request(api.server).get(PING);
    expect(unauthenticated.status).toBe(401);
    const unauthenticatedId = String(unauthenticated.headers['x-correlation-id']);
    expect((unauthenticated.body as { correlationId: string }).correlationId).toBe(
      unauthenticatedId,
    );

    const failed = await request(api.server)
      .post('/api/v1/_test/fail')
      .set('Authorization', ana())
      .set('X-Tenant-Id', A)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({});
    expect(failed.status).toBe(500);
    const failedId = String(failed.headers['x-correlation-id']);

    const missing = await request(api.server).get('/api/v1/nao-existe').set('Authorization', ana());
    expect(missing.headers['x-correlation-id']).toBeDefined();

    const byCorrelation = new Map(completions(logs).map((line) => [line.correlationId, line]));
    expect(byCorrelation.get(unauthenticatedId)).toMatchObject({
      level: 'info',
      statusCode: 401,
      reason: 'UNAUTHENTICATED',
    });
    expect(byCorrelation.get(failedId)).toMatchObject({
      level: 'error',
      msg: 'request failed',
      statusCode: 500,
      reason: 'INTERNAL_ERROR',
    });
    expect(byCorrelation.get(missing.headers['x-correlation-id'])).toMatchObject({
      route: '(unmatched)',
      statusCode: 404,
    });

    const unhandled = logs.lines().find((line) => line.event === 'http.unhandled_exception');
    const [server] = serverSpans(tracing).filter(
      (span) => span.attributes['cf.correlation_id'] === failedId,
    );
    expect(unhandled).toMatchObject({
      level: 'error',
      correlationId: failedId,
      errorCode: 'INTERNAL_ERROR',
      traceId: server?.spanContext().traceId,
      err: { type: 'Error' },
    });
    expect((unhandled?.err as { stack?: string }).stack).toContain('Error');
  });

  it('[Redação] token, cookie e corpo nunca aparecem nos logs', async () => {
    const authorization = ana();
    await request(api.server)
      .post('/api/v1/_internal/echo')
      .set('Authorization', authorization)
      .set('Cookie', '__Host-cf_session=segredo-de-sessao')
      .set('X-Tenant-Id', A)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ name: 'nome-no-corpo-123', quantity: 2 });

    const raw = logs.raw().join('\n');
    expect(completions(logs)).toHaveLength(1);
    expect(raw).not.toContain(authorization.slice('Bearer '.length));
    expect(raw).not.toContain('segredo-de-sessao');
    expect(raw).not.toContain('nome-no-corpo-123');
    // Atributos do span HTTP: sem cabeçalhos além do correlationId.
    const [server] = serverSpans(tracing);
    expect(JSON.stringify(server?.attributes)).not.toMatch(/authorization|cookie|segredo/i);
  });

  it('[FA-05] /health/* e /metrics não são logados nem instrumentados', async () => {
    await request(api.server).get('/health/live');
    await request(api.server).get('/metrics');
    expect(completions(logs)).toHaveLength(0);
    expect(serverSpans(tracing)).toHaveLength(0);
  });
});

describe('[Falha de banco] indisponibilidade do Collector não afeta a resposta (FA-04)', () => {
  it('responde normalmente e registra warn tracing.export_failed', async () => {
    const logs = captureLogs();
    const config = testConfig();
    const logger = createApiLogger(config, logs.destination);
    const unavailable = new WarnOnFailureSpanExporter(
      {
        export: (_spans, callback) => {
          callback({
            code: ExportResultCode.FAILED,
            error: new Error('connect ECONNREFUSED 127.0.0.1:4318'),
          });
        },
        shutdown: () => Promise.resolve(),
      },
      logger,
    );
    const tracing = installHttpTestTracing(unavailable);
    const api = await createTestApi({ config, logger });
    try {
      const response = await request(api.server)
        .get(PING)
        .set('Authorization', api.bearer(FAKE_USERS.ana.subject))
        .set('X-Tenant-Id', A);
      expect(response.status).toBe(200);
      expect(logs.lines()).toContainEqual(
        expect.objectContaining({ level: 'warn', event: 'tracing.export_failed' }),
      );
    } finally {
      await api.close();
      await tracing.uninstall();
    }
  });
});
