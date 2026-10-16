import { describe, expect, it, vi } from 'vitest';

import {
  aggregateStatus,
  errorTypeOf,
  HEALTH_CHECK_FIELDS,
  HEALTH_OUTPUTS,
  HEALTH_RESPONSE_FIELDS,
  healthHttpResponse,
  healthRequestHandler,
  LivenessProbe,
  ReadinessProbe,
  splitVersion,
} from './health.js';
import type { HealthCheck, HealthResponse } from './health.js';

function check(overrides: Partial<HealthCheck> & Pick<HealthCheck, 'name'>): HealthCheck {
  return {
    measurement: 'responseTime',
    criticality: 'critical',
    timeoutMs: 1_000,
    probe: () => Promise.resolve(undefined),
    ...overrides,
  };
}

/** Erro com host, credencial e stack — nada disso pode chegar ao corpo (V-01). */
function leakyError(): Error {
  const error = new Error(
    'connect ECONNREFUSED db-prod-01.internal:5432 password=s3cr3t tenant 0192aaaa',
  );
  Object.assign(error, { code: 'ECONNREFUSED' });
  return error;
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** V-01: só campos da allowlist, em qualquer nível do corpo. */
function assertAllowlisted(response: HealthResponse): void {
  for (const key of Object.keys(response)) expect(HEALTH_RESPONSE_FIELDS).toContain(key);
  for (const results of Object.values(response.checks ?? {})) {
    for (const result of results) {
      for (const key of Object.keys(result)) expect(HEALTH_CHECK_FIELDS).toContain(key);
      if (result.output) expect(Object.values(HEALTH_OUTPUTS)).toContain(result.output);
    }
  }
  const body = JSON.stringify(response);
  for (const forbidden of ['internal', '5432', 's3cr3t', 'password', 'ECONNREFUSED', 'at ', '0192'])
    expect(body).not.toContain(forbidden);
}

describe('ReadinessProbe (HLT-02)', () => {
  it('[Sucesso] todas as dependências no ar → pass e HTTP 200', async () => {
    const probe = new ReadinessProbe({
      serviceId: 'api',
      appVersion: '1.4.2+g3f9c2ab',
      checks: [
        check({ name: 'postgresql' }),
        check({ name: 'redis-cache', criticality: 'degradable' }),
      ],
    });
    const health = await probe.check();
    expect(health).toMatchObject({
      status: 'pass',
      serviceId: 'api',
      version: '1.4.2',
      releaseId: '3f9c2ab',
    });
    expect(health.checks?.['postgresql:responseTime']?.[0]).toMatchObject({
      status: 'pass',
      observedUnit: 'ms',
    });
    expect(healthHttpResponse(health)).toMatchObject({
      statusCode: 200,
      headers: { 'content-type': 'application/health+json', 'cache-control': 'no-store' },
    });
  });

  it('[Validação] degradável fora → warn 200, sem host, stack nem credencial no corpo', async () => {
    const log = logger();
    const probe = new ReadinessProbe({
      serviceId: 'api',
      appVersion: '0.0.0+local',
      logger: log,
      checks: [
        check({ name: 'postgresql' }),
        check({
          name: 'redis-cache',
          criticality: 'degradable',
          probe: () => Promise.reject(leakyError()),
        }),
      ],
    });
    const health = await probe.check();
    expect(health.status).toBe('warn');
    expect(healthHttpResponse(health).statusCode).toBe(200);
    expect(health.checks?.['redis-cache:responseTime']?.[0]).toMatchObject({
      status: 'warn',
      output: HEALTH_OUTPUTS.unavailable,
    });
    assertAllowlisted(health);
    // Log de transição: só dependência, motivo e tipo do erro (nunca a mensagem).
    expect(log.warn).toHaveBeenCalledWith(
      {
        event: 'health.dependency_degraded',
        dependency: 'redis-cache',
        criticality: 'degradable',
        reason: 'unavailable',
        errorType: 'ECONNREFUSED',
      },
      'dependency degraded',
    );
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('s3cr3t');
  });

  it('[Falha de banco] crítica fora → fail 503 e o check aparece como fail', async () => {
    const log = logger();
    const probe = new ReadinessProbe({
      serviceId: 'api',
      appVersion: '0.0.0+local',
      logger: log,
      checks: [check({ name: 'postgresql', probe: () => Promise.reject(leakyError()) })],
    });
    const health = await probe.check();
    expect(health.status).toBe('fail');
    expect(healthHttpResponse(health).statusCode).toBe(503);
    expect(health.checks?.['postgresql:responseTime']?.[0]?.status).toBe('fail');
    assertAllowlisted(health);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'health.dependency_critical_down',
        dependency: 'postgresql',
      }),
      'dependency down',
    );
  });

  it('[Falha de integração] degradável que devolve fail é rebaixada para warn', async () => {
    const probe = new ReadinessProbe({
      serviceId: 'api',
      appVersion: '0.0.0+local',
      checks: [
        check({
          name: 'redis-cache',
          criticality: 'degradable',
          probe: () => Promise.resolve({ status: 'fail' as const }),
        }),
      ],
    });
    const health = await probe.check();
    expect(health.status).toBe('warn');
    expect(health.checks?.['redis-cache:responseTime']?.[0]?.status).toBe('warn');
  });

  it('timeout curto por check → output de tempo esgotado', async () => {
    const probe = new ReadinessProbe({
      serviceId: 'worker',
      appVersion: '0.0.0+local',
      checks: [
        check({
          name: 'postgresql',
          timeoutMs: 10,
          probe: () => new Promise<undefined>(() => undefined),
        }),
      ],
    });
    const health = await probe.check();
    expect(health.checks?.['postgresql:responseTime']?.[0]).toMatchObject({
      status: 'fail',
      output: HEALTH_OUTPUTS.timeout,
    });
  });

  it('[Duplicidade] resultado de 2 s atrás vem do cache de 5 s, sem nova verificação', async () => {
    let now = 1_000_000;
    const probeFn = vi.fn(() => Promise.resolve(undefined));
    const probe = new ReadinessProbe({
      serviceId: 'api',
      appVersion: '0.0.0+local',
      now: () => now,
      checks: [check({ name: 'postgresql', probe: probeFn })],
    });
    const first = await probe.check();
    now += 2_000;
    const second = await probe.check();
    expect(second).toBe(first);
    expect(probeFn).toHaveBeenCalledTimes(1);
    now += 3_000;
    await probe.check();
    expect(probeFn).toHaveBeenCalledTimes(2);
  });

  it('[Concorrência] chamadas simultâneas sem cache verificam uma única vez', async () => {
    let release: () => void = () => undefined;
    const probeFn = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => {
            resolve(undefined);
          };
        }),
    );
    const probe = new ReadinessProbe({
      serviceId: 'api',
      appVersion: '0.0.0+local',
      checks: [check({ name: 'postgresql', probe: probeFn })],
    });
    const [a, b] = [probe.check(), probe.check()];
    release();
    const [first, second] = await Promise.all([a, b]);
    expect(probeFn).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('registra transições só quando o estado muda, inclusive a recuperação', async () => {
    let now = 0;
    let up = false;
    const log = logger();
    const probe = new ReadinessProbe({
      serviceId: 'web',
      appVersion: '0.0.0+local',
      cacheTtlMs: 1,
      logger: log,
      now: () => now,
      checks: [
        check({
          name: 'redis-sessions',
          probe: () => (up ? Promise.resolve(undefined) : Promise.reject(new Error('down'))),
        }),
      ],
    });
    await probe.check();
    now += 10;
    await probe.check();
    expect(log.error).toHaveBeenCalledTimes(1);
    up = true;
    now += 10;
    await probe.check();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'health.dependency_recovered',
        dependency: 'redis-sessions',
      }),
      'dependency recovered',
    );
  });

  it('observedValue/unit e status próprios da dependência (cacheAge do JWKS — FA-04)', async () => {
    const probe = new ReadinessProbe({
      serviceId: 'api',
      appVersion: '0.0.0',
      checks: [
        check({
          name: 'authentik-jwks',
          measurement: 'cacheAge',
          criticality: 'degradable',
          probe: () =>
            Promise.resolve({
              status: 'warn' as const,
              observedValue: 3_600,
              observedUnit: 's' as const,
              output: 'stale_cache' as const,
            }),
        }),
      ],
    });
    const health = await probe.check();
    expect(health).not.toHaveProperty('releaseId');
    expect(health.checks?.['authentik-jwks:cacheAge']?.[0]).toMatchObject({
      status: 'warn',
      observedValue: 3_600,
      observedUnit: 's',
      output: HEALTH_OUTPUTS.stale_cache,
    });
  });

  it('recusa health check duplicado e lista os registrados', () => {
    const probe = new ReadinessProbe({ serviceId: 'api', appVersion: '0.0.0' });
    probe.register(check({ name: 'postgresql' }));
    expect(() => {
      probe.register(check({ name: 'postgresql' }));
    }).toThrow(/duplicado/);
    expect(probe.registered).toEqual(['postgresql']);
  });
});

describe('LivenessProbe (HLT-01)', () => {
  it('pass enquanto o event loop responde, sem verificar dependências', () => {
    const now = 0;
    const probe = new LivenessProbe({ serviceId: 'api', appVersion: '0.0.0', now: () => now });
    probe.tick();
    const health = probe.check();
    expect(health.status).toBe('pass');
    expect(Object.keys(health.checks ?? {})).toEqual(['eventloop:delay']);
  });

  it('fail com atraso ≥ 2 s (medido também durante o bloqueio em curso)', () => {
    let now = 0;
    const probe = new LivenessProbe({
      serviceId: 'api',
      appVersion: '0.0.0',
      sampleIntervalMs: 500,
      now: () => now,
    }).start();
    try {
      now += 3_000;
      const health = probe.check();
      expect(health.status).toBe('fail');
      expect(health.checks?.['eventloop:delay']?.[0]).toMatchObject({
        observedValue: 2_500,
        output: HEALTH_OUTPUTS.event_loop_blocked,
      });
      expect(healthHttpResponse(health).statusCode).toBe(503);
      probe.tick();
      now += 500;
      probe.tick();
      expect(probe.check().status).toBe('pass');
    } finally {
      probe.stop();
    }
  });

  it('start real é idempotente e o stop desliga o temporizador', () => {
    const probe = new LivenessProbe({ serviceId: 'api', appVersion: '0.0.0' });
    expect(probe.start().start()).toBe(probe);
    expect(probe.check().status).toBe('pass');
    probe.stop();
    expect(probe.delayMs()).toBe(0);
  });
});

describe('healthRequestHandler', () => {
  function response() {
    const sent: { status?: number; headers?: Record<string, string>; body?: string | undefined } =
      {};
    let done: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    return {
      sent,
      finished,
      writeHead: (status: number, headers: Record<string, string>) => {
        sent.status = status;
        sent.headers = headers;
      },
      end: (body?: string) => {
        sent.body = body;
        done();
      },
    };
  }

  const live = { check: () => ({ status: 'pass' as const, serviceId: 'w', version: '1' }) };

  it('responde live e ready; ignora outros caminhos e métodos', async () => {
    const handler = healthRequestHandler({
      live,
      ready: { check: () => Promise.resolve({ status: 'fail', serviceId: 'w', version: '1' }) },
    });
    const liveRes = response();
    expect(handler({ url: '/health/live?x=1', method: 'GET' }, liveRes)).toBe(true);
    expect(liveRes.sent.status).toBe(200);

    const readyRes = response();
    expect(handler({ url: '/health/ready', method: 'GET' }, readyRes)).toBe(true);
    await readyRes.finished;
    expect(readyRes.sent.status).toBe(503);
    expect(readyRes.sent.headers?.['content-type']).toBe('application/health+json');

    expect(handler({ url: '/health/other', method: 'GET' }, response())).toBe(false);
    expect(handler({ url: '/health/live', method: 'POST' }, response())).toBe(false);
  });

  it('erro inesperado na readiness vira fail 503', async () => {
    const handler = healthRequestHandler({
      live,
      ready: { check: () => Promise.reject(new Error('boom')) },
    });
    const res = response();
    handler({ url: '/health/ready', method: 'HEAD' }, res);
    await res.finished;
    expect(res.sent.status).toBe(503);
  });
});

describe('utilitários', () => {
  it('aggregateStatus: fail > warn > pass', () => {
    expect(aggregateStatus([])).toBe('pass');
    expect(aggregateStatus(['pass', 'warn'])).toBe('warn');
    expect(aggregateStatus(['warn', 'fail', 'pass'])).toBe('fail');
  });

  it('splitVersion separa versão e commit', () => {
    expect(splitVersion('1.2.3+gabc')).toEqual({ version: '1.2.3', releaseId: 'abc' });
    expect(splitVersion('0.0.0+local')).toEqual({ version: '0.0.0', releaseId: 'local' });
    expect(splitVersion('2.0.0')).toEqual({ version: '2.0.0' });
  });

  it('errorTypeOf usa o código do Node ou o nome da classe, nunca a mensagem', () => {
    expect(errorTypeOf(leakyError())).toBe('ECONNREFUSED');
    expect(errorTypeOf(new TypeError('x'))).toBe('TypeError');
    expect(errorTypeOf(Object.assign(new Error('x'), { code: 'lower case host' }))).toBe('Error');
    expect(errorTypeOf('texto')).toBe('unknown');
  });
});
