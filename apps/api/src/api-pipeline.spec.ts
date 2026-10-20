import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi, testConfig } from '../test/support/api-test-app.js';
import type { TestApi } from '../test/support/api-test-app.js';
import { Gate, PipelineTestController, slowGate } from '../test/support/test-controllers.js';

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toBe('application/problem+json; charset=utf-8');
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  expect(body.correlationId).toBe(response.headers['x-correlation-id']);
  return body;
}

describe('Feature: Esqueleto da API modular (US-080)', () => {
  let api: TestApi;
  const ana = () => api.bearer(FAKE_USERS.ana.subject);

  beforeAll(async () => {
    api = await createTestApi({ controllers: [PipelineTestController] });
  });
  afterAll(async () => {
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    vi.restoreAllMocks();
  });

  it('[Sucesso] requisição completa passa pelo pipeline padrão e recebe X-Correlation-Id gerado', async () => {
    const response = await request(api.server)
      .get('/api/v1/_internal/ping')
      .set('Authorization', ana())
      .set('X-Tenant-Id', A);

    expect(response.status).toBe(200);
    expect(response.headers['x-correlation-id']).toMatch(UUID);
    expect(response.headers['ratelimit-limit']).toBe('600');
    expect(response.body).toEqual({
      data: {
        status: 'ok',
        correlationId: response.headers['x-correlation-id'],
        tenantId: A,
        userId: FAKE_USERS.ana.id,
        membershipId: '0192a000-0000-7000-8000-0000000001a1',
      },
    });
  });

  it('[Sucesso] reaproveita um X-Correlation-Id válido e substitui um inválido', async () => {
    const kept = await request(api.server)
      .get('/api/v1/_internal/ping')
      .set('Authorization', ana())
      .set('X-Tenant-Id', A)
      .set('X-Correlation-Id', 'c-7f3a2b');
    expect(kept.headers['x-correlation-id']).toBe('c-7f3a2b');

    const replaced = await request(api.server)
      .get('/api/v1/_internal/ping')
      .set('Authorization', ana())
      .set('X-Tenant-Id', A)
      .set('X-Correlation-Id', 'quebra\tde linha');
    expect(replaced.headers['x-correlation-id']).toMatch(UUID);
  });

  it('[Validação] corpo fora do schema Zod → 422 VALIDATION_ERROR com errors[]', async () => {
    const response = await request(api.server)
      .post('/api/v1/_internal/echo')
      .set('Authorization', ana())
      .set('X-Tenant-Id', A)
      .send({ name: '   ', quantity: 0, extra: true });

    const body = expectProblem(response, 422, 'VALIDATION_ERROR');
    expect(body).toMatchObject({
      type: 'https://docs.contrataflow.com.br/errors/validation-error',
      title: 'Dados inválidos',
      detail: 'Revise os campos destacados.',
      instance: '/api/v1/_internal/echo',
      violations: [],
    });
    expect(body.errors).toEqual(
      expect.arrayContaining([
        { field: 'name', code: 'REQUIRED', message: 'Campo obrigatório.' },
        { field: 'quantity', code: 'OUT_OF_RANGE', message: 'Valor fora do intervalo permitido.' },
        { field: 'extra', code: 'NOT_ALLOWED', message: 'Campo não permitido.' },
      ]),
    );
  });

  it('[Validação] campo obrigatório ausente e tipo errado', async () => {
    const response = await request(api.server)
      .post('/api/v1/_internal/echo')
      .set('Authorization', ana())
      .set('X-Tenant-Id', A)
      .send({ quantity: 'dez' });

    const body = expectProblem(response, 422, 'VALIDATION_ERROR');
    expect(body.errors.map(({ field, code }) => ({ field, code }))).toEqual([
      { field: 'name', code: 'REQUIRED' },
      { field: 'quantity', code: 'INVALID_FORMAT' },
    ]);
  });

  it('[Permissão] requisição sem token → 401 UNAUTHENTICATED', async () => {
    const response = await request(api.server).get('/api/v1/_internal/ping').set('X-Tenant-Id', A);
    expectProblem(response, 401, 'UNAUTHENTICATED');
  });

  it('[Tenant incorreto] cabeçalho de tenant sem vínculo ativo → 403 sem revelar a existência', async () => {
    const otherTenant = await request(api.server)
      .get('/api/v1/_internal/ping')
      .set('Authorization', ana())
      .set('X-Tenant-Id', B);
    const missingTenant = await request(api.server)
      .get('/api/v1/_internal/ping')
      .set('Authorization', ana())
      .set('X-Tenant-Id', randomUUID());

    const a = expectProblem(otherTenant, 403, 'MEMBERSHIP_INACTIVE');
    const b = expectProblem(missingTenant, 403, 'MEMBERSHIP_INACTIVE');
    const strip = ({ correlationId: _c, ...rest }: typeof a) => rest;
    expect(strip(a)).toEqual(strip(b));
    expect(JSON.stringify(a)).not.toContain(B);
  });

  it('[Duplicidade] reenvio com a mesma Idempotency-Key e o mesmo corpo reproduz a resposta', async () => {
    const send = (body: object) =>
      request(api.server)
        .post('/api/v1/_internal/echo')
        .set('Authorization', ana())
        .set('X-Tenant-Id', A)
        .set('Idempotency-Key', '0192a000-0000-7000-8000-00000000c0a1')
        .send(body);

    const first = await send({ name: 'Caneta', quantity: 3 });
    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    const replay = await send({ quantity: 3, name: 'Caneta' });
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['idempotent-replayed']).toBe('true');

    const reused = await send({ name: 'Lápis', quantity: 3 });
    expectProblem(reused, 422, 'IDEMPOTENCY_KEY_REUSED');
  });

  it('[Duplicidade] a mesma chave em outro tenant/usuário não colide; chave inválida → 422', async () => {
    const key = '0192a000-0000-7000-8000-00000000c0a2';
    const first = await request(api.server)
      .post('/api/v1/_internal/echo')
      .set('Authorization', ana())
      .set('X-Tenant-Id', A)
      .set('Idempotency-Key', key)
      .send({ name: 'A' });
    const other = await request(api.server)
      .post('/api/v1/_internal/echo')
      .set('Authorization', ana())
      .set('X-Tenant-Id', A)
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'A' });
    expect(other.body).not.toEqual(first.body);

    const invalid = await request(api.server)
      .post('/api/v1/_internal/echo')
      .set('Authorization', ana())
      .set('X-Tenant-Id', A)
      .set('Idempotency-Key', 'nao-e-uuid')
      .send({ name: 'A' });
    const body = expectProblem(invalid, 422, 'VALIDATION_ERROR');
    expect(body.errors[0]).toMatchObject({ field: 'Idempotency-Key', code: 'INVALID_FORMAT' });
  });

  it('[Concorrência] duas requisições simultâneas com a mesma chave → uma processa, outra 409', async () => {
    slowGate.current = new Gate();
    const send = () =>
      request(api.server)
        .post('/api/v1/_test/slow')
        .set('Authorization', ana())
        .set('X-Tenant-Id', A)
        .set('Idempotency-Key', '0192a000-0000-7000-8000-00000000c0b2')
        .send({ value: 1 });

    const first = send().then((response) => response);
    await slowGate.current.entered;
    const second = await send();
    expectProblem(second, 409, 'IDEMPOTENCY_IN_PROGRESS');
    expect(second.headers['retry-after']).toBe('1');

    slowGate.current.open();
    expect((await first).status).toBe(201);
  });

  it('[Concorrência] o contexto de AsyncLocalStorage não vaza entre requisições concorrentes', async () => {
    const ids = Array.from({ length: 150 }, (_, index) => `load-${String(index).padStart(4, '0')}`);
    const responses = await Promise.all(
      ids.map((id) =>
        request(api.server)
          .get('/api/v1/_test/context')
          .set('Authorization', ana())
          .set('X-Tenant-Id', A)
          .set('X-Correlation-Id', id),
      ),
    );
    responses.forEach((response, index) => {
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        data: { correlationId: ids[index], userId: FAKE_USERS.ana.id },
      });
    });
  });

  it('[Falha de integração] limite de leitura atingido → 429 RATE_LIMITED com Retry-After', async () => {
    const limited = await createTestApi({ config: testConfig({ RATE_LIMIT_READ_PER_MIN: '2' }) });
    try {
      const read = () =>
        request(limited.server)
          .get('/api/v1/_internal/ping')
          .set('Authorization', limited.bearer(FAKE_USERS.ana.subject))
          .set('X-Tenant-Id', A);
      expect((await read()).status).toBe(200);
      const second = await read();
      expect(second.headers['ratelimit-remaining']).toBe('0');

      const third = await read();
      expectProblem(third, 429, 'RATE_LIMITED');
      expect(Number(third.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(third.headers['ratelimit-limit']).toBe('2');
      expect(third.headers['ratelimit-remaining']).toBe('0');
      expect(third.headers['ratelimit-reset']).toBe(third.headers['retry-after']);

      // Escrita é outra classe (120/min): segue liberada.
      const write = await request(limited.server)
        .post('/api/v1/_internal/echo')
        .set('Authorization', limited.bearer(FAKE_USERS.ana.subject))
        .set('X-Tenant-Id', A)
        .send({ name: 'ok' });
      expect(write.status).toBe(201);
    } finally {
      await limited.close();
    }
  });

  it('[Falha de banco] Redis indisponível: leitura segue sem 500 e o throttler degradado gera warn', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const degraded = await createTestApi({ stores: 'redis' });
    try {
      const response = await request(degraded.server)
        .get('/api/v1/_internal/ping')
        .set('Authorization', degraded.bearer(FAKE_USERS.ana.subject))
        .set('X-Tenant-Id', A);
      expect(response.status).toBe(200);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^throttler\.store_unavailable/));

      const write = await request(degraded.server)
        .post('/api/v1/_internal/echo')
        .set('Authorization', degraded.bearer(FAKE_USERS.ana.subject))
        .set('X-Tenant-Id', A)
        .set('Idempotency-Key', randomUUID())
        .send({ name: 'sem idempotência' });
      expect(write.status).toBe(201);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^idempotency\.store_unavailable/));
    } finally {
      await degraded.close();
    }
  });
});

describe('Matriz dos guards (base da suíte "tenant leak")', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await createTestApi({ controllers: [PipelineTestController] });
  });
  afterAll(async () => {
    await api.close();
  });

  const nowSeconds = () => Math.floor(Date.now() / 1000);

  it.each([
    ['sem token', () => ({ tenant: A }), 401, 'UNAUTHENTICATED'],
    [
      'esquema diferente de Bearer',
      () => ({ auth: 'Basic YTpi', tenant: A }),
      401,
      'UNAUTHENTICATED',
    ],
    [
      'assinatura inválida',
      () => ({ auth: `${api.bearer('sub-ana')}x`, tenant: A }),
      401,
      'UNAUTHENTICATED',
    ],
    [
      'token expirado',
      () => ({ auth: api.bearer('sub-ana', { exp: nowSeconds() - 120 }), tenant: A }),
      401,
      'SESSION_EXPIRED',
    ],
    [
      'audiência errada',
      () => ({ auth: api.bearer('sub-ana', { aud: 'outra-api' }), tenant: A }),
      401,
      'UNAUTHENTICATED',
    ],
    [
      'usuário desconhecido',
      () => ({ auth: api.bearer('sub-ninguem'), tenant: A }),
      401,
      'UNAUTHENTICATED',
    ],
    [
      'usuário bloqueado',
      () => ({ auth: api.bearer('sub-eva'), tenant: A }),
      401,
      'UNAUTHENTICATED',
    ],
    ['sem X-Tenant-Id', () => ({ auth: api.bearer('sub-ana') }), 400, 'MALFORMED_REQUEST'],
    [
      'X-Tenant-Id inválido',
      () => ({ auth: api.bearer('sub-ana'), tenant: 'abc' }),
      400,
      'MALFORMED_REQUEST',
    ],
    [
      'tenant suspenso',
      () => ({ auth: api.bearer('sub-davi'), tenant: FAKE_TENANTS.prefeituraSuspensa.id }),
      403,
      'TENANT_SUSPENDED',
    ],
    [
      'vínculo suspenso',
      () => ({ auth: api.bearer('sub-bruno'), tenant: A }),
      403,
      'MEMBERSHIP_INACTIVE',
    ],
    [
      'vínculo expirado',
      () => ({ auth: api.bearer('sub-carla'), tenant: A }),
      403,
      'MEMBERSHIP_INACTIVE',
    ],
    [
      'vínculo de outro tenant',
      () => ({ auth: api.bearer('sub-ana'), tenant: B }),
      403,
      'MEMBERSHIP_INACTIVE',
    ],
    [
      'tenant suspenso sem vínculo nele',
      () => ({ auth: api.bearer('sub-ana'), tenant: FAKE_TENANTS.prefeituraSuspensa.id }),
      403,
      'MEMBERSHIP_INACTIVE',
    ],
  ] as const)('%s → %i %s', async (_name, build, status, code) => {
    const { auth, tenant } = build() as { auth?: string; tenant?: string };
    let call = request(api.server).get('/api/v1/_internal/ping');
    if (auth) call = call.set('Authorization', auth);
    if (tenant) call = call.set('X-Tenant-Id', tenant);
    expectProblem(await call, status, code);
  });

  it('rota sem tenant (@TenantScope PLATFORM) exige operador com MFA, mas não X-Tenant-Id', async () => {
    const ok = await request(api.server)
      .get('/api/v1/_test/without-tenant')
      .set('Authorization', api.bearer('sub-operadora', { amr: ['pwd', 'otp'] }));
    expect(ok.body).toEqual({ data: { tenantId: null, userId: FAKE_USERS.operadora.id } });
    // US-099: quem não é operador da plataforma → 403, antes do MFA.
    expectProblem(
      await request(api.server)
        .get('/api/v1/_test/without-tenant')
        .set('Authorization', api.bearer('sub-ana', { amr: ['pwd', 'otp'] })),
      403,
      'PERMISSION_DENIED',
    );
    expectProblem(
      await request(api.server)
        .get('/api/v1/_test/without-tenant')
        .set('Authorization', api.bearer('sub-operadora', { amr: ['pwd'] })),
      403,
      'MFA_REQUIRED',
    );
    expectProblem(
      await request(api.server).get('/api/v1/_test/without-tenant'),
      401,
      'UNAUTHENTICATED',
    );
  });
});

describe('Erros genéricos do filtro RFC 9457', () => {
  let api: TestApi;
  const auth = () => ({ Authorization: api.bearer('sub-ana'), 'X-Tenant-Id': A });

  beforeAll(async () => {
    api = await createTestApi({ controllers: [PipelineTestController] });
  });
  afterAll(async () => {
    await api.close();
  });

  it('V-03: JSON malformado → 400 MALFORMED_REQUEST', async () => {
    const response = await request(api.server)
      .post('/api/v1/_internal/echo')
      .set(auth())
      .set('Content-Type', 'application/json')
      .send('{"name": ');
    expectProblem(response, 400, 'MALFORMED_REQUEST');
  });

  it('tipo de conteúdo não JSON → 415 e corpo acima de 2 MB → 413', async () => {
    expectProblem(
      await request(api.server)
        .post('/api/v1/_internal/echo')
        .set(auth())
        .set('Content-Type', 'text/plain')
        .send('oi'),
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    );
    expectProblem(
      await request(api.server)
        .post('/api/v1/_internal/echo')
        .set(auth())
        .send({ name: 'x'.repeat(2 * 1024 * 1024) }),
      413,
      'PAYLOAD_TOO_LARGE',
    );
  });

  it('V-11: exceção não mapeada → 500 INTERNAL_ERROR sem detalhe interno e libera a chave', async () => {
    const error = vi.spyOn(Logger.prototype, 'error');
    const key = randomUUID();
    const send = () =>
      request(api.server)
        .post('/api/v1/_test/fail')
        .set(auth())
        .set('Idempotency-Key', key)
        .send({});

    const response = await send();
    const body = expectProblem(response, 500, 'INTERNAL_ERROR');
    expect(body.detail).toBe(`Ocorreu um erro inesperado. Código: ${body.correlationId}.`);
    expect(JSON.stringify(body)).not.toContain('segredo');
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'http.unhandled_exception',
        correlationId: body.correlationId,
        errorCode: 'INTERNAL_ERROR',
      }),
      'unhandled exception',
    );
    // Erro 5xx libera a chave: a nova tentativa é processada (e falha de novo), não reproduzida.
    expectProblem(await send(), 500, 'INTERNAL_ERROR');
  });

  it('ZodError lançado fora do pipe e rota inexistente', async () => {
    const zod = expectProblem(
      await request(api.server).get('/api/v1/_test/zod').set(auth()),
      422,
      'VALIDATION_ERROR',
    );
    expect(zod.errors[0]).toMatchObject({ field: 'code', code: 'REQUIRED' });
    expectProblem(
      await request(api.server).get('/api/v1/nao-existe').set(auth()),
      404,
      'NOT_FOUND',
    );
  });

  it('V-10: If-Match ausente → 428 PRECONDITION_REQUIRED; presente → versão interpretada', async () => {
    expectProblem(
      await request(api.server).patch('/api/v1/_test/versioned').set(auth()),
      428,
      'PRECONDITION_REQUIRED',
    );
    const ok = await request(api.server)
      .patch('/api/v1/_test/versioned')
      .set(auth())
      .set('If-Match', '"7"');
    expect(ok.body).toEqual({ data: { kind: 'version', value: 7 } });
  });

  it('rota com classe de limite própria e resposta sem corpo (204)', async () => {
    const response = await request(api.server).post('/api/v1/_test/export').set(auth());
    expect(response.status).toBe(204);
    expect(response.headers['ratelimit-limit']).toBe('20');
  });
});

describe('Paginação da rota de exemplo (RN-FND-37)', () => {
  let api: TestApi;
  const auth = () => ({ Authorization: api.bearer('sub-ana'), 'X-Tenant-Id': A });

  beforeAll(async () => {
    api = await createTestApi({ config: testConfig({ PAGINATION_MAX_PAGE_SIZE: '10' }) });
  });
  afterAll(async () => {
    await api.close();
  });

  it('página: meta { page, pageSize, totalItems, totalPages } e teto de PAGINATION_MAX_PAGE_SIZE', async () => {
    const response = await request(api.server)
      .get('/api/v1/_internal/items?page=2&pageSize=50')
      .set(auth());
    expect(response.status).toBe(200);
    const page = response.body as { data: unknown[]; meta: unknown };
    expect(page.meta).toEqual({ page: 2, pageSize: 10, totalItems: 45, totalPages: 5 });
    expect(page.data[0]).toEqual({ id: 'item-11', position: 11 });

    const invalid = await request(api.server)
      .get('/api/v1/_internal/items?pageSize=101')
      .set(auth());
    const body = expectProblem(invalid, 422, 'VALIDATION_ERROR');
    expect(body.errors[0]).toMatchObject({ field: 'pageSize', code: 'OUT_OF_RANGE' });
  });

  it('cursor: percorre o feed até hasMore = false', async () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=20&cursor=${cursor}` : '?limit=20';
      const response = await request(api.server).get(`/api/v1/_internal/feed${query}`).set(auth());
      expect(response.status).toBe(200);
      const page = response.body as {
        data: { position: number }[];
        meta: { nextCursor: string | null; hasMore: boolean };
      };
      seen.push(...page.data.map((item) => item.position));
      expect(page.meta.hasMore).toBe(page.meta.nextCursor !== null);
      cursor = page.meta.nextCursor;
    } while (cursor);
    expect(seen).toEqual(Array.from({ length: 45 }, (_, index) => index + 1));

    const invalid = await request(api.server)
      .get('/api/v1/_internal/feed?cursor=bm90LWpzb24')
      .set(auth());
    expect(expectProblem(invalid, 422, 'VALIDATION_ERROR').errors[0]).toMatchObject({
      field: 'cursor',
    });
  });
});
