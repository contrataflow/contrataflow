import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_LOG_EVENT,
  assertLogLevelAllowed,
  createLogger,
  normalizeLogArguments,
  parseLegacyMessage,
} from './logger.js';
import type { LogContextFields } from './logger.js';
import { captureLogs, installTestTracing } from './testing.js';
import type { TestTracing } from './testing.js';
import { withSpan } from './tracing.js';

function setup(context?: () => LogContextFields | undefined, level: 'info' | 'debug' = 'info') {
  const logs = captureLogs();
  const logger = createLogger({
    service: 'api',
    env: 'test',
    version: '1.0.0+gabc1234',
    level,
    destination: logs.destination,
    ...(context ? { context } : {}),
  });
  return { logs, logger };
}

describe('createLogger (RN-FND-71)', () => {
  it('emite JSON com os campos obrigatórios de observability.md §2.2', () => {
    const { logs, logger } = setup(() => ({ correlationId: 'corr-0001', tenantId: null }));
    logger.info({ event: 'http.request.completed', statusCode: 200 }, 'request completed');
    const [line] = logs.lines();
    expect(line).toMatchObject({
      level: 'info',
      msg: 'request completed',
      event: 'http.request.completed',
      service: 'api',
      env: 'test',
      version: '1.0.0+gabc1234',
      correlationId: 'corr-0001',
      statusCode: 200,
    });
    expect(line?.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(line).not.toHaveProperty('tenantId');
    expect(line).not.toHaveProperty('pid');
    expect(line).not.toHaveProperty('hostname');
  });

  it('usa o event como msg quando não há texto e um event padrão quando falta', () => {
    const { logs, logger } = setup();
    logger.info({ event: 'api.started', port: 4000 });
    logger.info('Mapped route');
    logger.info({ msg: 'texto no objeto' });
    expect(logs.lines().map((line) => [line.event, line.msg])).toEqual([
      ['api.started', 'api.started'],
      [DEFAULT_LOG_EVENT, 'Mapped route'],
      [DEFAULT_LOG_EVENT, 'texto no objeto'],
    ]);
  });

  it('redige campos proibidos, inclusive em bindings de child e em msg', () => {
    const { logs, logger } = setup();
    logger
      .child({ token: 'segredo-1' })
      .warn(
        { event: 'auth.failed', body: { password: 'segredo-2' }, email: 'ana@orgao.gov.br' },
        'falha para ana@orgao.gov.br com Bearer segredo-3',
      );
    const [raw] = logs.raw();
    expect(raw).not.toMatch(/segredo-[123]|ana@orgao/);
    expect(logs.lines()[0]).toMatchObject({ email: 'a***@orgao.gov.br', body: '[REDACTED]' });
  });

  it('mantém stack só em error/fatal', () => {
    const { logs, logger } = setup();
    const error = new Error('quebrou');
    logger.warn({ event: 'job.retry', err: error });
    logger.error({ event: 'job.failed', err: error });
    logger.error(error);
    logger.info(error, 'texto explícito');
    const lines = logs.lines() as { err: { stack?: string; type: string }; msg: string }[];
    expect(lines[0]?.err.stack).toBeUndefined();
    expect(lines[1]?.err.stack).toContain('quebrou');
    expect(lines[2]).toMatchObject({ msg: 'quebrou', err: { type: 'Error' } });
    expect(lines[2]?.err.stack).toBeDefined();
    expect(lines[3]?.msg).toBe('texto explícito');
    expect(lines[3]?.err.stack).toBeUndefined();
  });

  it('respeita o nível configurado', () => {
    const { logs, logger } = setup(undefined, 'info');
    logger.debug({ event: 'cache.hit' });
    expect(logs.lines()).toHaveLength(0);
    const debug = setup(undefined, 'debug');
    debug.logger.debug({ event: 'cache.hit' });
    expect(debug.logs.lines()).toHaveLength(1);
  });

  it('repassa argumentos que não são objeto sem alteração', () => {
    expect(normalizeLogArguments([undefined], 30)).toEqual([undefined]);
    expect(normalizeLogArguments([{ event: 'a' }, 'b', 'extra'], 30)).toEqual([
      { event: 'a' },
      'b',
      'extra',
    ]);
  });
});

describe('correlação com traces (RN-FND-75 · FA-02)', () => {
  let tracing: TestTracing;

  beforeEach(() => {
    tracing = installTestTracing();
  });

  afterEach(async () => {
    await tracing.shutdown();
  });

  it('injeta traceId/spanId do span ativo', async () => {
    const { logs, logger } = setup();
    await withSpan('demo.op', {}, (span) => {
      logger.info({ event: 'demo.inside' });
      return span.spanContext();
    }).then((spanContext) => {
      expect(logs.lines()[0]).toMatchObject({
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
      });
    });
  });

  it('sem span ativo, sai sem traceId/spanId e sem erro', () => {
    const { logs, logger } = setup();
    logger.info({ event: 'bootstrap.step' });
    expect(logs.lines()[0]).not.toHaveProperty('traceId');
    expect(logs.lines()[0]).not.toHaveProperty('spanId');
  });
});

describe('assertLogLevelAllowed (V-03)', () => {
  it.each(['debug', 'trace'] as const)('rejeita %s em produção', (level) => {
    expect(() => assertLogLevelAllowed(level, true)).toThrow(/não é permitido/);
    expect(assertLogLevelAllowed(level, false)).toBe(level);
  });

  it('aceita info em produção', () => {
    expect(assertLogLevelAllowed('info', true)).toBe('info');
  });
});

describe('formato legado "evento chave=valor" (US-080/US-081)', () => {
  it('converte em event e campos estruturados', () => {
    expect(
      parseLegacyMessage(
        'db.lock_wait lockType=FOR UPDATE tableName=processes durationMs=230.5 correlationId=-',
      ),
    ).toEqual({
      event: 'db.lock_wait',
      lockType: 'FOR UPDATE',
      tableName: 'processes',
      durationMs: 230.5,
      correlationId: null,
    });
    expect(parseLegacyMessage('worker.started')).toEqual({ event: 'worker.started' });
  });

  it('ignora textos que não seguem o formato', () => {
    expect(parseLegacyMessage('Mapped {/api/v1, GET} route')).toBeNull();
    expect(parseLegacyMessage('api.started na porta 4000')).toBeNull();
    expect(parseLegacyMessage('Nest')).toBeNull();
  });

  it('é aplicado às chamadas do Logger do NestJS (contexto + texto) e redige os campos', () => {
    const { logs, logger } = setup();
    logger.warn(
      { context: 'Guards' },
      'guard.rejected guard=TenantContextGuard reason=MISSING email=ana@orgao.gov.br',
    );
    logger.info('api.started port=4000');
    expect(logs.lines()).toEqual([
      expect.objectContaining({
        event: 'guard.rejected',
        msg: 'guard.rejected',
        context: 'Guards',
        guard: 'TenantContextGuard',
        reason: 'MISSING',
        email: 'a***@orgao.gov.br',
      }),
      expect.objectContaining({ event: 'api.started', msg: 'api.started', port: 4000 }),
    ]);
  });
});
